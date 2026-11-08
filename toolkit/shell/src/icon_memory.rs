// SPDX-License-Identifier: LGPL-3.0-or-later
//! The shell process's one app/place/tray image memory and bounded fetch pool.
use crate::apps::{AppsState, Icon};
use nk_render::Raster;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    sync::{Arc, Condvar, Mutex, OnceLock, Weak},
    time::{Duration, Instant},
};
const LIMIT: usize = 64 * 1024 * 1024;
const ENTRIES: usize = 4096;
const QUEUED: usize = 256;
const WORKERS: usize = 8;
const INTEREST: Duration = Duration::from_secs(30);
pub const STARTUP_WAIT: Duration = Duration::from_secs(2);
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Key {
    /// Versioned file art (notification replacements can overwrite the same path).
    Image {
        namespace: String,
        generation: u64,
        path: String,
        side: u32,
    },
    App {
        owner: String,
        epoch: u64,
        revision: u64,
        id: String,
        generation: u64,
        logical: u32,
        scale: u64,
    },
    Named {
        revision: u64,
        theme: String,
        name: String,
        extra: Vec<PathBuf>,
        side: u32,
        symbolic: bool,
    },
    Tray {
        owner: String,
        handle: String,
        generation: u64,
        revision: u64,
        attention: bool,
        side: u32,
        symbolic: bool,
    },
}
#[derive(Debug)]
pub struct Asset {
    pub raw: Icon,
    pub raster: Arc<Raster>,
}
impl Asset {
    fn new(raw: Icon) -> Result<Arc<Self>, FetchError> {
        if raw.width == 0
            || raw.height == 0
            || raw.width > 1024
            || raw.height > 1024
            || raw.rgba.len() != raw.width as usize * raw.height as usize * 4
        {
            return Err(FetchError::Unavailable);
        }
        let raster = Raster::from_rgba(raw.width as u16, raw.height as u16, raw.rgba.clone())
            .map_err(|_| FetchError::Unavailable)?;
        Ok(Arc::new(Self {
            raw,
            raster: Arc::new(raster),
        }))
    }
    fn bytes(&self) -> usize {
        self.raw.rgba.len() * 2
    }
}
impl PartialEq for Asset {
    fn eq(&self, other: &Self) -> bool {
        self.raw == other.raw
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum FetchError {
    Busy,
    Retry,
    Unavailable,
}
#[derive(Clone)]
enum Value {
    Pending,
    Paused,
    Ready(Arc<Asset>),
    Unavailable,
}
struct Entry {
    value: Value,
    tick: u64,
    wanted: Instant,
    attempt: u32,
}
#[derive(Default)]
struct State {
    source: Option<(String, u64, u64)>,
    generations: HashMap<String, u64>,
    places: HashSet<String>,
    named_revision: u64,
    names: HashMap<String, Option<(String, u64)>>,
    entries: HashMap<Key, Entry>,
    queue: VecDeque<(Key, Instant)>,
    running: HashSet<Key>,
    clock: u64,
    bytes: usize,
    closed: bool,
    listeners: HashMap<u64, Arc<dyn Fn() + Send + Sync>>,
    next_listener: u64,
}
type Fetcher = dyn Fn(&Key) -> Result<Icon, FetchError> + Send + Sync;
struct Inner {
    state: Mutex<State>,
    changed: Condvar,
    fetch: Arc<Fetcher>,
}
pub struct Memory {
    inner: Arc<Inner>,
}
pub struct Subscription {
    inner: Weak<Inner>,
    id: u64,
}
impl Drop for Subscription {
    fn drop(&mut self) {
        if let Some(i) = self.inner.upgrade() {
            i.state
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .listeners
                .remove(&self.id);
        }
    }
}
impl Drop for Memory {
    fn drop(&mut self) {
        self.inner
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .closed = true;
        self.inner.changed.notify_all();
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Readiness {
    pub ready: usize,
    pub pending: usize,
    pub unavailable: usize,
    pub retired: usize,
}
impl Readiness {
    pub fn complete(self) -> bool {
        self.pending == 0 && self.retired == 0
    }
}
static GLOBAL: OnceLock<Arc<Memory>> = OnceLock::new();
pub fn global() -> Option<Arc<Memory>> {
    GLOBAL.get().cloned()
}
pub fn install(conn: zbus::blocking::Connection) -> Arc<Memory> {
    GLOBAL
        .get_or_init(|| Memory::new(move |key| fetch(&conn, key)))
        .clone()
}
impl Memory {
    pub fn new(
        fetch: impl Fn(&Key) -> Result<Icon, FetchError> + Send + Sync + 'static,
    ) -> Arc<Self> {
        let _ = generic();
        let inner = Arc::new(Inner {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            fetch: Arc::new(fetch),
        });
        for n in 0..WORKERS {
            let i = inner.clone();
            std::thread::Builder::new()
                .name(format!("icon-{n}"))
                .spawn(move || worker(i))
                .expect("icon worker thread");
        }
        Arc::new(Self { inner })
    }
    pub fn subscribe(&self, callback: impl Fn() + Send + Sync + 'static) -> Subscription {
        let mut s = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        s.next_listener += 1;
        let id = s.next_listener;
        s.listeners.insert(id, Arc::new(callback));
        Subscription {
            inner: Arc::downgrade(&self.inner),
            id,
        }
    }
    pub fn update(&self, source: Option<&AppsState>) {
        let mut s = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        let next = source.map(|a| (a.owner.clone(), a.epoch, a.icon_revision));
        let changed = s.source != next;
        if changed {
            s.named_revision += 1;
        }
        s.source = next;
        s.generations = source
            .map(|a| {
                a.apps
                    .iter()
                    .map(|app| (app.id.clone(), app.generation))
                    .collect()
            })
            .unwrap_or_default();
        s.places = source
            .map(|a| {
                a.pins
                    .iter()
                    .filter_map(|p| match p {
                        crate::model::Pin::Folder { key, .. }
                        | crate::model::Pin::File { key, .. } => Some(key.clone()),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        s.names.clear();
        if let Some(source) = source {
            for app in &source.apps {
                if !app.raw_icon.is_empty() {
                    let value = (app.id.clone(), app.generation);
                    s.names
                        .entry(app.raw_icon.clone())
                        .and_modify(|old| {
                            if old.as_ref() != Some(&value) {
                                *old = None;
                            }
                        })
                        .or_insert(Some(value));
                }
            }
        }
        let stale: Vec<_> = s
            .entries
            .keys()
            .filter(|k| !valid(&s, k))
            .cloned()
            .collect();
        let retired = !stale.is_empty();
        for k in stale {
            remove(&mut s, &k);
        }
        let retained: HashSet<_> = s.entries.keys().cloned().collect();
        s.queue.retain(|(k, _)| retained.contains(k));
        let callbacks = if changed || retired {
            s.listeners.values().cloned().collect::<Vec<_>>()
        } else {
            Vec::new()
        };
        drop(s);
        self.inner.changed.notify_all();
        for cb in callbacks {
            cb();
        }
    }
    pub fn app(&self, id: &str, generation: u64, logical: u32, scale: f64) -> Option<Key> {
        let s = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        let a = s.source.as_ref()?;
        let (logical, scale) = crate::apps::icon_request(logical as f64, scale);
        let k = Key::App {
            owner: a.0.clone(),
            epoch: a.1,
            revision: a.2,
            id: id.into(),
            generation,
            logical,
            scale: scale.to_bits(),
        };
        valid(&s, &k).then_some(k)
    }
    /// A long-lived view may retain old action metadata; art follows the latest
    /// published catalogue generation, without making stale actions valid.
    pub fn current_app(&self, id: &str, logical: u32, scale: f64) -> Option<Key> {
        let generation = *self
            .inner
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .generations
            .get(id)?;
        self.app(id, generation, logical, scale)
    }
    pub fn app_for_name(&self, name: &str, logical: u32, scale: f64) -> Option<Key> {
        let found = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .names
            .get(name)
            .cloned()
            .flatten()?;
        self.app(&found.0, found.1, logical, scale)
    }
    pub fn named(
        &self,
        theme: &str,
        name: &str,
        extra: Vec<PathBuf>,
        side: u32,
        symbolic: bool,
    ) -> Key {
        let revision = self
            .inner
            .state
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .named_revision;
        Key::Named {
            revision,
            theme: theme.into(),
            name: name.into(),
            extra,
            side,
            symbolic,
        }
    }
    pub fn request(&self, key: Key) {
        let mut s = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        if !valid(&s, &key) {
            return;
        }
        if reusable(&s, &key).is_some() {
            return;
        }
        s.clock += 1;
        let tick = s.clock;
        let now = Instant::now();
        if let Some(e) = s.entries.get_mut(&key) {
            e.tick = tick;
            e.wanted = now;
            let paused = matches!(e.value, Value::Paused | Value::Pending)
                && !s.running.contains(&key)
                && !s.queue.iter().any(|(k, _)| k == &key);
            if paused && s.queue.len() + s.running.len() < QUEUED {
                s.entries.get_mut(&key).unwrap().value = Value::Pending;
                s.queue.push_back((key, now));
                self.inner.changed.notify_one();
            }
            return;
        }
        if s.queue.len() + s.running.len() >= QUEUED {
            return;
        }
        evict(&mut s, 0);
        s.entries.insert(
            key.clone(),
            Entry {
                value: Value::Pending,
                tick,
                wanted: now,
                attempt: 0,
            },
        );
        s.queue.push_back((key, now));
        self.inner.changed.notify_one();
    }
    pub fn get(&self, key: &Key) -> Option<Arc<Asset>> {
        let mut s = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        if !valid(&s, key) {
            return None;
        }
        s.clock += 1;
        let tick = s.clock;
        if let Some((target, asset)) = reusable(&s, key) {
            if let Some(entry) = s.entries.get_mut(&target) {
                entry.tick = tick;
            }
            return Some(asset);
        }
        match s.entries.get_mut(key) {
            Some(e) => {
                e.tick = tick;
                if let Value::Ready(v) = &e.value {
                    Some(v.clone())
                } else {
                    None
                }
            }
            None => None,
        }
    }
    pub fn readiness(&self, keys: &[Key]) -> Readiness {
        let s = self.inner.state.lock().unwrap_or_else(|p| p.into_inner());
        let mut r = Readiness::default();
        for k in keys {
            if !valid(&s, k) {
                r.retired += 1;
                continue;
            }
            if valid(&s, k) && reusable(&s, k).is_some() {
                r.ready += 1;
                continue;
            }
            match s.entries.get(k).filter(|_| valid(&s, k)).map(|e| &e.value) {
                Some(Value::Ready(_)) => r.ready += 1,
                Some(Value::Unavailable) => r.unavailable += 1,
                _ => r.pending += 1,
            }
        }
        r
    }
    pub fn unavailable(&self, key: &Key) -> bool {
        self.readiness(std::slice::from_ref(key)).unavailable == 1
    }
}
fn valid(s: &State, k: &Key) -> bool {
    match k {
        Key::App {
            owner,
            epoch,
            revision,
            id,
            generation,
            ..
        } => s.source.as_ref().is_some_and(|a| {
            a.0 == *owner
                && a.1 == *epoch
                && a.2 == *revision
                && (if id == crate::apps::TRASH_EMPTY || id == crate::apps::TRASH_FULL {
                    *generation == 0
                } else if crate::apps::is_place(id) {
                    s.places.contains(id)
                } else {
                    s.generations.get(id) == Some(generation)
                })
        }),
        Key::Named { revision, .. } => *revision == s.named_revision,
        Key::Tray { .. } | Key::Image { .. } => true,
    }
}
fn reusable(s: &State, key: &Key) -> Option<(Key, Arc<Asset>)> {
    if let Some(Entry {
        value: Value::Ready(asset),
        ..
    }) = s.entries.get(key)
    {
        return Some((key.clone(), asset.clone()));
    }
    let Key::App {
        owner,
        epoch,
        revision,
        id,
        generation,
        logical,
        scale,
    } = key
    else {
        return None;
    };
    let need = *logical as f64 * f64::from_bits(*scale);
    s.entries
        .iter()
        .filter_map(|(k, e)| {
            let Key::App {
                owner: o,
                epoch: eph,
                revision: r,
                id: i,
                generation: g,
                logical: l,
                scale: sc,
            } = k
            else {
                return None;
            };
            let side = *l as f64 * f64::from_bits(*sc);
            if owner != o
                || epoch != eph
                || revision != r
                || id != i
                || generation != g
                || side < need
            {
                return None;
            }
            if let Value::Ready(asset) = &e.value {
                Some((side, k.clone(), asset.clone()))
            } else {
                None
            }
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|(_, k, v)| (k, v))
}
fn remove(s: &mut State, k: &Key) {
    if let Some(Entry {
        value: Value::Ready(v),
        ..
    }) = s.entries.remove(k)
    {
        s.bytes -= v.bytes();
    }
}
fn evict(s: &mut State, bytes: usize) {
    while s.bytes + bytes > LIMIT || s.entries.len() >= ENTRIES {
        let old = s
            .entries
            .iter()
            .filter(|(_, e)| !matches!(e.value, Value::Pending))
            .min_by_key(|(_, e)| e.tick)
            .map(|(k, _)| k.clone());
        let Some(k) = old else {
            break;
        };
        remove(s, &k);
    }
}
fn worker(inner: Arc<Inner>) {
    loop {
        let key = {
            let mut s = inner.state.lock().unwrap_or_else(|p| p.into_inner());
            loop {
                if s.closed {
                    return;
                }
                let now = Instant::now();
                let next = s.queue.iter().position(|(_, due)| *due <= now);
                if let Some(index) = next {
                    let (k, _) = s.queue.remove(index).unwrap();
                    if !valid(&s, &k) {
                        continue;
                    }
                    if s.entries
                        .get(&k)
                        .is_none_or(|e| now.duration_since(e.wanted) > INTEREST)
                    {
                        if let Some(e) = s.entries.get_mut(&k) {
                            e.value = Value::Paused;
                        }
                        continue;
                    }
                    s.running.insert(k.clone());
                    break k;
                }
                let wait = s
                    .queue
                    .iter()
                    .map(|(_, at)| at.saturating_duration_since(now))
                    .min();
                s = if let Some(wait) = wait {
                    inner
                        .changed
                        .wait_timeout(s, wait)
                        .unwrap_or_else(|p| p.into_inner())
                        .0
                } else {
                    inner.changed.wait(s).unwrap_or_else(|p| p.into_inner())
                };
            }
        };
        let result = {
            let tags = match &key {
                Key::App {
                    id, logical, scale, ..
                } => serde_json::json!({"id":id,"logical":logical,"scale":f64::from_bits(*scale)}),
                Key::Named { name, side, .. } => serde_json::json!({"id":name,"side":side}),
                Key::Image {
                    namespace, side, ..
                } => serde_json::json!({"id":namespace,"side":side}),
                Key::Tray { handle, side, .. } => serde_json::json!({"id":handle,"side":side}),
            };
            let fetched = {
                let _span = crate::icon_metrics::span("icon-fetch", tags.clone());
                (inner.fetch)(&key)
            };
            if let Err(error) = &fetched {
                let mut data = tags.clone();
                data["error"] = format!("{error:?}").into();
                crate::icon_metrics::emit("icon-fetch-error", data);
            }
            let _span = crate::icon_metrics::span("icon-convert", tags);
            fetched.and_then(Asset::new)
        };
        let callbacks = {
            let mut s = inner.state.lock().unwrap_or_else(|p| p.into_inner());
            s.running.remove(&key);
            if !valid(&s, &key) || !s.entries.contains_key(&key) {
                continue;
            }
            match result {
                Err(FetchError::Busy | FetchError::Retry) => {
                    let e = s.entries.get_mut(&key).unwrap();
                    e.attempt = e.attempt.saturating_add(1);
                    let wait = Duration::from_millis((20u64 << e.attempt.min(6)).min(1000));
                    s.queue.push_back((key, Instant::now() + wait));
                    inner.changed.notify_one();
                    continue;
                }
                Ok(asset) => {
                    evict(&mut s, asset.bytes());
                    if let Some(e) = s.entries.get_mut(&key) {
                        e.value = Value::Ready(asset.clone());
                        s.bytes += asset.bytes();
                    }
                }
                Err(FetchError::Unavailable) => {
                    s.entries.get_mut(&key).unwrap().value = Value::Unavailable
                }
            }
            s.listeners.values().cloned().collect::<Vec<_>>()
        };
        inner.changed.notify_all();
        for cb in callbacks {
            cb();
        }
    }
}
fn remote_error(e: zbus::Error) -> FetchError {
    if let zbus::Error::MethodError(name, _, _) = &e {
        if name.as_str().ends_with(".Busy") {
            return FetchError::Busy;
        }
        if [
            ".NotFound",
            ".Unavailable",
            ".Stale",
            ".Invalid",
            ".Unsupported",
            ".AccessDenied",
        ]
        .iter()
        .any(|s| name.as_str().ends_with(s))
        {
            return FetchError::Unavailable;
        }
    }
    FetchError::Retry
}
fn fetch(conn: &zbus::blocking::Connection, key: &Key) -> Result<Icon, FetchError> {
    let (w, h, mut rgba) = match key {
        Key::App {
            owner,
            epoch,
            id,
            generation,
            logical,
            scale,
            ..
        } => {
            crate::icon_metrics::emit(
                "request",
                serde_json::json!({"id":id,"size":logical,"epoch":epoch}),
            );
            let dest = if owner.is_empty() {
                crate::apps::DEST
            } else {
                owner
            };
            let scale = f64::from_bits(*scale);
            let reply = match id.as_str() {
                crate::apps::TRASH_EMPTY | crate::apps::TRASH_FULL => conn.call_method(
                    Some(dest),
                    crate::apps::PATH,
                    Some(crate::apps::IFACE),
                    "GetTrashIcon",
                    &(*epoch, id == crate::apps::TRASH_FULL, *logical, scale),
                ),
                id if crate::apps::is_place(id) => conn.call_method(
                    Some(dest),
                    crate::apps::PATH,
                    Some(crate::apps::IFACE),
                    "GetLayoutIcon",
                    &(*epoch, id, *logical, scale),
                ),
                _ => conn.call_method(
                    Some(dest),
                    crate::apps::PATH,
                    Some(crate::apps::IFACE),
                    "GetIcon",
                    &(*epoch, id, *generation, *logical, scale),
                ),
            }
            .map_err(remote_error)?;
            let (_, w, h, rgba): (String, u32, u32, Vec<u8>) = reply
                .body()
                .deserialize()
                .map_err(|_| FetchError::Unavailable)?;
            (w, h, rgba)
        }
        Key::Image { path, side, .. } => {
            if path.len() > 4096 || *side == 0 || *side > 1024 {
                return Err(FetchError::Unavailable);
            }
            return load_named(std::path::Path::new(path), *side, key);
        }
        Key::Named {
            theme,
            name,
            extra,
            side,
            ..
        } => {
            let path = nk_icons::find_app_icon(theme, name, *side, &nk_icons::search_path(), extra)
                .ok_or(FetchError::Unavailable)?;
            return load_named(&path, *side, key);
        }
        Key::Tray {
            owner,
            handle,
            generation,
            attention,
            side,
            ..
        } => {
            conn.call_method(
                Some(owner.as_str()),
                crate::tray::ROOT,
                Some(crate::tray::IFACE),
                "RegisterHost",
                &(),
            )
            .map_err(remote_error)?;
            let kind = if *attention { "attention" } else { "normal" };
            let reply = conn
                .call_method(
                    Some(owner.as_str()),
                    crate::tray::ROOT,
                    Some(crate::tray::IFACE),
                    "GetIcon",
                    &(handle, *generation, kind, *side),
                )
                .map_err(remote_error)?;
            reply
                .body()
                .deserialize::<(u32, u32, Vec<u8>)>()
                .map_err(|_| FetchError::Unavailable)?
        }
    };
    if matches!(key, Key::Tray { symbolic: true, .. }) {
        for px in rgba.as_chunks_mut::<4>().0 {
            px[..3].fill(255);
        }
    }
    Ok(Icon {
        width: w,
        height: h,
        rgba,
    })
}
/// Applications1's existing neutral fallback artwork, one shared allocation.
pub fn generic() -> Arc<Asset> {
    static GENERIC: OnceLock<Arc<Asset>> = OnceLock::new();
    GENERIC
        .get_or_init(|| {
            let tree = resvg::usvg::Tree::from_data(
                include_bytes!("../../../session/daemon/src/applications/fallback.svg"),
                &resvg::usvg::Options::default(),
            )
            .expect("bundled fallback SVG");
            let mut pix = resvg::tiny_skia::Pixmap::new(64, 64).expect("fallback allocation");
            let size = tree.size();
            let scale = 64. / size.width().max(size.height());
            resvg::render(
                &tree,
                resvg::tiny_skia::Transform::from_scale(scale, scale),
                &mut pix.as_mut(),
            );
            let rgba = pix
                .pixels()
                .iter()
                .flat_map(|p| {
                    let c = p.demultiply();
                    [c.red(), c.green(), c.blue(), c.alpha()]
                })
                .collect();
            Asset::new(Icon {
                width: 64,
                height: 64,
                rgba,
            })
            .expect("bundled fallback pixels")
        })
        .clone()
}
fn load_named(path: &std::path::Path, side: u32, key: &Key) -> Result<Icon, FetchError> {
    if path.metadata().map_err(|_| FetchError::Unavailable)?.len() > 16 * 1024 * 1024
        || side == 0
        || side > 1024
    {
        return Err(FetchError::Unavailable);
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .map_err(|_| FetchError::Unavailable)?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| FetchError::Unavailable)?;
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(FetchError::Unavailable);
    }
    let (w, h, mut rgba) = if path.extension().is_some_and(|e| e == "svg") {
        // Theme art is untrusted input too. SVG images cannot escape the source
        // or allocate an unbounded raster before our output-size check.
        use std::sync::atomic::{AtomicUsize, Ordering};
        let used = Arc::new(AtomicUsize::new(0));
        let rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (data_rejected, path_rejected) = (rejected.clone(), rejected.clone());
        let decode = resvg::usvg::ImageHrefResolver::default_data_resolver();
        let options = resvg::usvg::Options {
            image_href_resolver: resvg::usvg::ImageHrefResolver {
                resolve_string: Box::new(move |_, _| {
                    path_rejected.store(true, Ordering::Relaxed);
                    None
                }),
                resolve_data: Box::new(move |mime, data, options| {
                    let dimensions = image::ImageReader::new(std::io::Cursor::new(data.as_slice()))
                        .with_guessed_format()
                        .ok()
                        .and_then(|r| r.into_dimensions().ok());
                    let cost = dimensions
                        .filter(|(w, h)| {
                            *w <= 4096 && *h <= 4096 && u64::from(*w) * u64::from(*h) <= 16_000_000
                        })
                        .map(|(w, h)| w as usize * h as usize * 4);
                    if data.len() <= 16 * 1024 * 1024
                        && let Some(cost) = cost
                        && used.fetch_add(cost, Ordering::Relaxed).saturating_add(cost) <= LIMIT
                    {
                        return decode(mime, data, options);
                    }
                    data_rejected.store(true, Ordering::Relaxed);
                    None
                }),
            },
            ..Default::default()
        };
        let tree =
            resvg::usvg::Tree::from_data(&bytes, &options).map_err(|_| FetchError::Unavailable)?;
        if rejected.load(Ordering::Relaxed) {
            return Err(FetchError::Unavailable);
        }
        let size = tree.size();
        if size.width() * size.height() > 16_000_000. {
            return Err(FetchError::Unavailable);
        }
        let mut pix = resvg::tiny_skia::Pixmap::new(side, side).ok_or(FetchError::Unavailable)?;
        let scale = side as f32 / size.width().max(size.height());
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::from_scale(scale, scale).post_translate(
                (side as f32 - size.width() * scale) / 2.,
                (side as f32 - size.height() * scale) / 2.,
            ),
            &mut pix.as_mut(),
        );
        (
            side,
            side,
            pix.pixels()
                .iter()
                .flat_map(|p| {
                    let c = p.demultiply();
                    [c.red(), c.green(), c.blue(), c.alpha()]
                })
                .collect(),
        )
    } else {
        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .map_err(|_| FetchError::Unavailable)?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let img = reader.decode().map_err(|_| FetchError::Unavailable)?;
        if u64::from(img.width()) * u64::from(img.height()) > 16_000_000 {
            return Err(FetchError::Unavailable);
        }
        let img = img.thumbnail(side, side).to_rgba8();
        (img.width(), img.height(), img.into_raw())
    };
    if matches!(key, Key::Named { symbolic: true, .. }) {
        for px in rgba.as_chunks_mut::<4>().0 {
            px[..3].fill(255);
        }
    }
    Ok(Icon {
        width: w,
        height: h,
        rgba,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc,
        },
    };
    struct Bus {
        child: Child,
        dir: PathBuf,
        address: String,
    }
    impl Bus {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "nidara-icon-wire-{}-{}",
                std::process::id(),
                glib::monotonic_time()
            ));
            std::fs::create_dir(&dir).unwrap();
            let mut child = Command::new("dbus-daemon")
                .args([
                    "--session",
                    "--nofork",
                    "--print-address=1",
                    &format!("--address=unix:path={}/bus", dir.display()),
                ])
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let mut address = String::new();
            BufReader::new(child.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap();
            assert!(address.starts_with("unix:"));
            Self {
                child,
                dir,
                address: address.trim().into(),
            }
        }
        fn client(&self) -> zbus::blocking::Connection {
            zbus::blocking::connection::Builder::address(self.address.as_str())
                .unwrap()
                .method_timeout(Duration::from_secs(2))
                .build()
                .unwrap()
        }
    }
    impl Drop for Bus {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }
    #[derive(zbus::DBusError, Debug)]
    #[zbus(prefix = "org.nidara.Applications1.Error")]
    enum Error {
        Busy(String),
    }
    struct Icons {
        calls: Arc<AtomicUsize>,
        busy: usize,
    }
    #[zbus::interface(name = "org.nidara.Applications1")]
    impl Icons {
        fn get_icon(
            &self,
            _epoch: u64,
            _id: &str,
            _generation: u64,
            logical: u32,
            scale: f64,
        ) -> Result<(String, u32, u32, Vec<u8>), Error> {
            let n = self.calls.fetch_add(1, Ordering::SeqCst);
            if n < self.busy {
                return Err(Error::Busy("forced".into()));
            }
            let side = (logical as f64 * scale).ceil() as u32;
            Ok((
                "asset:fixture".into(),
                side,
                side,
                vec![255; (side * side * 4) as usize],
            ))
        }
    }
    fn state(owner: &str, n: usize) -> AppsState {
        AppsState {
            owner: owner.into(),
            epoch: 1,
            icon_revision: 1,
            apps: (0..n)
                .map(|i| crate::model::App {
                    id: format!("app{i}.desktop"),
                    raw_icon: format!("app{i}"),
                    generation: 1,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        }
    }
    fn wait(memory: &Memory, keys: &[Key]) {
        let end = Instant::now() + Duration::from_secs(4);
        while !memory.readiness(keys).complete() {
            assert!(
                Instant::now() < end,
                "icons still pending: {:?}",
                memory.readiness(keys)
            );
            std::thread::sleep(Duration::from_millis(2));
        }
        assert_eq!(
            memory.readiness(keys).unavailable,
            0,
            "transient error became missing art"
        );
    }
    #[test]
    fn two_surfaces_share_pixels_and_a_larger_texture_without_another_wire_call() {
        let bus = Bus::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let server = bus.client();
        server
            .object_server()
            .at(
                crate::apps::PATH,
                Icons {
                    calls: calls.clone(),
                    busy: 0,
                },
            )
            .unwrap();
        let conn = bus.client();
        let memory = Memory::new(move |key| fetch(&conn, key));
        memory.update(Some(&state(server.unique_name().unwrap().as_str(), 1)));
        let dock = memory.app("app0.desktop", 1, 128, 1.).unwrap();
        memory.request(dock.clone());
        wait(&memory, std::slice::from_ref(&dock));
        let first = memory.get(&dock).unwrap();
        let apps = memory.app("app0.desktop", 1, 72, 1.).unwrap();
        memory.request(apps.clone());
        assert!(memory.readiness(std::slice::from_ref(&apps)).complete());
        let second = memory.get(&apps).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert!(Arc::ptr_eq(&first.raster, &second.raster));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // The same unambiguous app art is also available to the tray.
        let tray = memory.app_for_name("app0", 36, 1.).unwrap();
        memory.request(tray.clone());
        assert!(Arc::ptr_eq(&first, &memory.get(&tray).unwrap()));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
    #[test]
    fn forced_busy_is_pending_then_retried_on_the_real_wire() {
        let bus = Bus::new();
        let calls = Arc::new(AtomicUsize::new(0));
        let server = bus.client();
        server
            .object_server()
            .at(
                crate::apps::PATH,
                Icons {
                    calls: calls.clone(),
                    busy: 2,
                },
            )
            .unwrap();
        let conn = bus.client();
        let memory = Memory::new(move |key| fetch(&conn, key));
        memory.update(Some(&state(server.unique_name().unwrap().as_str(), 1)));
        let key = memory.app("app0.desktop", 1, 32, 1.).unwrap();
        memory.request(key.clone());
        let end = Instant::now() + Duration::from_secs(2);
        while calls.load(Ordering::SeqCst) == 0 {
            assert!(Instant::now() < end);
            std::thread::yield_now();
        }
        assert_eq!(memory.readiness(std::slice::from_ref(&key)).pending, 1);
        assert!(!memory.unavailable(&key));
        wait(&memory, std::slice::from_ref(&key));
        assert_eq!(calls.load(Ordering::SeqCst), 3);
        assert!(memory.get(&key).is_some());
    }
    #[test]
    fn requests_coalesce_and_the_process_uses_all_eight_but_no_more_workers() {
        let (entered, rx) = mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let (g, a, p) = (gate.clone(), active.clone(), peak.clone());
        let memory = Memory::new(move |_| {
            let n = a.fetch_add(1, Ordering::SeqCst) + 1;
            p.fetch_max(n, Ordering::SeqCst);
            let _ = entered.send(());
            let mut open = g.0.lock().unwrap();
            while !*open {
                open = g.1.wait(open).unwrap();
            }
            a.fetch_sub(1, Ordering::SeqCst);
            Ok(Icon {
                width: 1,
                height: 1,
                rgba: vec![255; 4],
            })
        });
        memory.update(Some(&state(":test", 24)));
        let keys: Vec<_> = (0..24)
            .map(|i| memory.app(&format!("app{i}.desktop"), 1, 16, 1.).unwrap())
            .collect();
        for key in &keys {
            for _ in 0..4 {
                memory.request(key.clone());
            }
        }
        for _ in 0..8 {
            rx.recv_timeout(Duration::from_secs(2))
                .expect("eight parallel requests, not a serial loader");
        }
        assert_eq!(active.load(Ordering::SeqCst), 8);
        assert!(rx.try_recv().is_err());
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        wait(&memory, &keys);
        assert!(peak.load(Ordering::SeqCst) <= 8);
        assert_eq!(
            rx.try_iter().count(),
            16,
            "deduplicated each of the 24 resources"
        );
    }
    #[test]
    fn a_retired_owner_or_generation_cannot_populate_the_replacement_cache() {
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let (entered, rx) = mpsc::channel();
        let g = gate.clone();
        let memory = Memory::new(move |key| {
            let Key::App { owner, .. } = key else {
                unreachable!()
            };
            let red = owner == ":old";
            if red {
                let _ = entered.send(());
                let mut open = g.0.lock().unwrap();
                while !*open {
                    open = g.1.wait(open).unwrap();
                }
            }
            Ok(Icon {
                width: 1,
                height: 1,
                rgba: if red {
                    vec![255, 0, 0, 255]
                } else {
                    vec![0, 0, 255, 255]
                },
            })
        });
        memory.update(Some(&state(":old", 1)));
        let old = memory.app("app0.desktop", 1, 16, 1.).unwrap();
        memory.request(old.clone());
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        memory.update(Some(&state(":new", 1)));
        let new = memory.app("app0.desktop", 1, 16, 1.).unwrap();
        memory.request(new.clone());
        wait(&memory, std::slice::from_ref(&new));
        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        let end = Instant::now() + Duration::from_secs(2);
        while memory.inner.state.lock().unwrap().running.contains(&old) {
            assert!(Instant::now() < end);
            std::thread::yield_now();
        }
        assert!(memory.get(&old).is_none());
        assert_eq!(memory.get(&new).unwrap().raw.rgba, [0, 0, 255, 255]);
        let mut changed = state(":new", 1);
        changed.apps[0].generation = 2;
        memory.update(Some(&changed));
        assert!(memory.get(&new).is_none());
        assert!(memory.app("app0.desktop", 1, 16, 1.).is_none());
        changed.icon_revision = 2;
        memory.update(Some(&changed));
        let current = memory.current_app("app0.desktop", 16, 1.).unwrap();
        assert_eq!(Some(current.clone()), memory.app("app0.desktop", 2, 16, 1.));
        memory.request(current.clone());
        wait(&memory, std::slice::from_ref(&current));
        assert_ne!(new, current);
    }
    #[test]
    fn eviction_is_weighted_lru_and_invalidates_named_art_with_the_theme_revision() {
        let memory = Memory::new(|_| {
            Ok(Icon {
                width: 1,
                height: 1,
                rgba: vec![255; 4],
            })
        });
        memory.update(Some(&state(":test", 3)));
        let keys: Vec<_> = (0..3)
            .map(|i| memory.app(&format!("app{i}.desktop"), 1, 16, 1.).unwrap())
            .collect();
        for k in &keys {
            memory.request(k.clone());
            wait(&memory, std::slice::from_ref(k));
        }
        memory.get(&keys[0]);
        {
            let mut s = memory.inner.state.lock().unwrap();
            evict(&mut s, LIMIT - 8);
            assert_eq!(s.entries.len(), 1);
            assert!(s.entries.contains_key(&keys[0]));
            assert!(s.bytes <= LIMIT);
        }
        let named = memory.named("Papirus", "app0", vec![], 32, false);
        memory.request(named.clone());
        wait(&memory, std::slice::from_ref(&named));
        let mut next = state(":test", 3);
        next.icon_revision = 2;
        memory.update(Some(&next));
        assert!(memory.get(&named).is_none());
    }
    #[test]
    fn ambiguous_tray_names_do_not_guess_an_application() {
        let memory = Memory::new(|_| Err(FetchError::Unavailable));
        let mut apps = state(":test", 2);
        apps.apps[1].raw_icon = apps.apps[0].raw_icon.clone();
        memory.update(Some(&apps));
        assert!(memory.app_for_name("app0", 36, 1.).is_none());
    }
    #[test]
    fn a_paused_request_stays_evictable_when_the_queue_is_full() {
        let memory = Memory::new(|_| Err(FetchError::Unavailable));
        memory.update(Some(&state(":test", 1)));
        let key = memory.app("app0.desktop", 1, 16, 1.).unwrap();
        {
            let mut s = memory.inner.state.lock().unwrap();
            s.entries.insert(
                key.clone(),
                Entry {
                    value: Value::Paused,
                    tick: 0,
                    wanted: Instant::now(),
                    attempt: 0,
                },
            );
            // A far-future queue cannot race the workers during the assertion.
            for _ in 0..QUEUED {
                s.queue
                    .push_back((key.clone(), Instant::now() + Duration::from_secs(60)));
            }
        }
        memory.request(key.clone());
        let s = memory.inner.state.lock().unwrap();
        assert!(matches!(s.entries[&key].value, Value::Paused));
        assert_eq!(s.queue.len(), QUEUED);
    }
    #[test]
    fn named_svg_preserves_color_and_alpha_and_rejects_external_or_oversized_art() {
        let path = std::env::temp_dir().join(format!(
            "nidara-named-{}-{}.svg",
            std::process::id(),
            glib::monotonic_time()
        ));
        let key = Key::Named {
            revision: 0,
            theme: String::new(),
            name: String::new(),
            extra: vec![],
            side: 32,
            symbolic: false,
        };
        std::fs::write(&path, r##"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="8"><path fill="#ff0000" d="M0 0h16v8H0z"/></svg>"##).unwrap();
        let icon = load_named(&path, 32, &key).unwrap();
        assert_eq!((icon.width, icon.height), (32, 32));
        assert_eq!(
            &icon.rgba[(16 * 32 + 16) * 4..(16 * 32 + 16) * 4 + 4],
            &[255, 0, 0, 255]
        );
        assert_eq!(icon.rgba[3], 0);
        std::fs::write(&path, r#"<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><image href="/tmp/never-read.png" width="16" height="16"/></svg>"#).unwrap();
        assert_eq!(load_named(&path, 32, &key), Err(FetchError::Unavailable));
        std::fs::write(
            &path,
            r#"<svg xmlns="http://www.w3.org/2000/svg" width="10000" height="10000"/>"#,
        )
        .unwrap();
        assert_eq!(load_named(&path, 32, &key), Err(FetchError::Unavailable));
        std::fs::remove_file(path).unwrap();
    }
}
