// SPDX-License-Identifier: GPL-3.0-or-later
//! Opt-in Applications1 A1–A3. Coherent H1 consumption, no WM, renderer or TS bridge.
mod autostart;
mod catalogue;
mod desktop;
mod icons;
mod launch;
mod layout;
mod observation;
mod search;
mod store;
mod theme;
mod unity;
mod usage;
use nidara_access::{Operation, Peer};
use serde_json::{Value as Json, json};
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Mutex, Semaphore};
use zbus::{
    Connection,
    message::Header,
    object_server::SignalEmitter,
    zvariant::{OwnedValue, Value as Variant},
};
const NAME: &str = "org.nidara.Applications";
const PATH: &str = "/org/nidara/Applications";
type Dict = HashMap<String, OwnedValue>;
type Records = Vec<Dict>;
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.Applications1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    Unavailable(String),
    Invalid(String),
    NotFound(String),
    Stale(String),
    Conflict(String),
    AccessDenied(String),
    Busy(String),
    Timeout(String),
    Unsupported(String),
    Failed(String),
}
fn unique() -> u64 {
    static N: AtomicU64 = AtomicU64::new(0);
    let time = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64;
    time.wrapping_add(N.fetch_add(1, Ordering::Relaxed))
}
fn variant(v: &Json, key: &str) -> OwnedValue {
    let value: Variant = match v {
        Json::Bool(b) => (*b).into(),
        Json::Number(n) if key == "Count" => n.as_i64().unwrap_or_default().into(),
        Json::Number(n) if n.is_u64() => n.as_u64().unwrap().into(),
        Json::Number(n) => n.as_f64().unwrap_or_default().into(),
        Json::String(s) => s.as_str().into(),
        Json::Null => "".into(),
        Json::Object(_) => dict(v).into(),
        Json::Array(a)
            if [
                "Apps",
                "Layout",
                "Actions",
                "WindowMatches",
                "ActiveLaunches",
            ]
            .contains(&key) =>
        {
            a.iter().map(dict).collect::<Records>().into()
        }
        Json::Array(a) => a
            .iter()
            .filter_map(|v| v.as_str().map(str::to_string))
            .collect::<Vec<_>>()
            .into(),
    };
    OwnedValue::try_from(value).expect("JSON model contains owned serializable variants")
}
fn dict(v: &Json) -> Dict {
    v.as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), variant(v, k))).collect())
        .unwrap_or_default()
}
fn unvariant(v: &OwnedValue) -> Result<Json, Error> {
    if let Ok(s) = <&str>::try_from(v) {
        if s.len() > 8192 {
            return Err(Error::Invalid("request string budget".into()));
        }
        Ok(json!(s))
    } else {
        Err(Error::Invalid("request values must be strings".into()))
    }
}
fn request(v: Dict) -> Result<Json, Error> {
    if v.len() > 8 {
        return Err(Error::Invalid("request key budget".into()));
    }
    let m = v
        .iter()
        .map(|(k, v)| unvariant(v).map(|v| (k.clone(), v)))
        .collect::<Result<serde_json::Map<_, _>, _>>()?;
    Ok(Json::Object(m))
}
fn sender(h: &Header<'_>) -> Result<String, Error> {
    h.sender()
        .map(|s| s.to_string())
        .ok_or_else(|| Error::AccessDenied("missing unique sender".into()))
}
struct Snapshot {
    owner: String,
    epoch: u64,
    expires: Instant,
    apps: Vec<Json>,
    windows: Vec<Json>,
    apps_anchor: bool,
    bytes: usize,
}
#[derive(Default)]
struct Pages {
    sessions: HashMap<String, Snapshot>,
}
fn page(apps: &[Json], at: usize) -> (Vec<Json>, usize) {
    let mut size = 0;
    let mut end = at;
    while end < apps.len() && end - at < 256 {
        let n = apps[end].to_string().len() * 2;
        if size + n > 512 * 1024 && end > at {
            break;
        }
        size += n;
        end += 1;
    }
    (apps[at..end].to_vec(), end)
}
impl Pages {
    fn cleanup(&mut self) {
        self.sessions.retain(|_, s| s.expires > Instant::now());
    }
    fn start(
        &mut self,
        owner: String,
        epoch: u64,
        apps: Vec<Json>,
        windows: Vec<Json>,
    ) -> Result<(Vec<Json>, String, Vec<Json>, String), Error> {
        self.cleanup();
        let (first, a) = page(&apps, 0);
        let (first_windows, w) = page(&windows, 0);
        if a == apps.len() && w == windows.len() {
            return Ok((first, String::new(), first_windows, String::new()));
        }
        let bytes = apps
            .iter()
            .chain(&windows)
            .map(|a| a.to_string().len() * 4)
            .sum::<usize>();
        if self.sessions.values().filter(|s| s.owner == owner).count() >= 16
            || self.sessions.len() >= 256
            || self.sessions.values().map(|s| s.bytes).sum::<usize>() + bytes > 32 * 1024 * 1024
        {
            return Err(Error::Busy("snapshot retention budget".into()));
        }
        let id = format!("{:x}", unique());
        // Legacy consumers close AppsNext only. Give them one empty terminal
        // app page when only WindowMatches needs retention, so they can free
        // the shared session without knowing this additive result collection.
        let apps_anchor = a == apps.len() && w < windows.len();
        let next = if a < apps.len() || apps_anchor {
            format!("{id}:a:{a}")
        } else {
            String::new()
        };
        let next_windows = if w < windows.len() {
            format!("{id}:w:{w}")
        } else {
            String::new()
        };
        self.sessions.insert(
            id,
            Snapshot {
                owner,
                epoch,
                expires: Instant::now() + Duration::from_secs(10),
                apps,
                windows,
                apps_anchor,
                bytes,
            },
        );
        Ok((first, next, first_windows, next_windows))
    }
    fn read(&mut self, owner: &str, epoch: u64, token: &str) -> Result<(Records, String), Error> {
        self.cleanup();
        let parts = token.split(':').collect::<Vec<_>>();
        if parts.len() != 3 {
            return Err(Error::Stale("invalid page token".into()));
        }
        let id = parts[0];
        let at = parts[2]
            .parse::<usize>()
            .map_err(|_| Error::Stale("invalid cursor".into()))?;
        let s = self
            .sessions
            .get(id)
            .filter(|s| s.owner == owner && s.epoch == epoch)
            .ok_or_else(|| Error::Stale("expired/foreign snapshot".into()))?;
        let records = match parts[1] {
            "a" => &s.apps,
            "w" => &s.windows,
            _ => return Err(Error::Stale("invalid snapshot domain".into())),
        };
        if parts[1] == "a" && s.apps_anchor && at == records.len() {
            return Ok((vec![], String::new()));
        }
        if at >= records.len() {
            return Err(Error::Stale("snapshot cursor out of range".into()));
        }
        let (rows, end) = page(records, at);
        let next = if end == records.len() {
            String::new()
        } else {
            format!("{id}:{}:{end}", parts[1])
        };
        Ok((rows.iter().map(dict).collect(), next))
    }
    fn close(&mut self, owner: &str, epoch: u64, token: &str) {
        let id = token.split(':').next().unwrap_or_default();
        if self
            .sessions
            .get(id)
            .is_some_and(|s| s.owner == owner && s.epoch == epoch)
        {
            self.sessions.remove(id);
        }
    }
}
#[derive(Default)]
struct Admission {
    active: usize,
    clients: HashMap<String, usize>,
}
struct Admitted {
    state: Arc<std::sync::Mutex<Admission>>,
    owner: String,
}
impl Drop for Admitted {
    fn drop(&mut self) {
        let mut s = self.state.lock().unwrap();
        s.active -= 1;
        if let Some(n) = s.clients.get_mut(&self.owner) {
            *n -= 1;
            if *n == 0 {
                s.clients.remove(&self.owner);
            }
        }
    }
}
struct Applications {
    admission: Arc<std::sync::Mutex<Admission>>,
    store: store::Handle,
    pages: Arc<Mutex<Pages>>,
    peers: Arc<Mutex<HashMap<String, Arc<Peer>>>>,
    decode: Arc<Semaphore>,
    launch_workers: Arc<Semaphore>,
}
enum LaunchTarget {
    App(String, u64),
    Directory(String),
}
impl Applications {
    async fn submit(
        &self,
        epoch: u64,
        target: LaunchTarget,
        mut request: desktop::Request,
        peer: Arc<Peer>,
        owner: String,
        conn: &Connection,
    ) -> Result<String, Error> {
        let check = peer.clone();
        let (id, plan) = self
            .store
            .call(move |s| {
                s.epoch(epoch)?;
                s.authorize(&check, Operation::AppLaunch)?;
                let fingerprint = match &target {
                    LaunchTarget::App(id, generation) => request.fingerprint(id, *generation),
                    LaunchTarget::Directory(uri) => {
                        request.fingerprint(&format!("directory:{uri}"), 0)
                    }
                };
                if let Some(id) = s.launches.existing(&owner, &request.nonce, &fingerprint)? {
                    return Ok((id, None));
                }
                let app = match target {
                    LaunchTarget::App(id, g) => s.app(&id, g)?.clone(),
                    LaunchTarget::Directory(uri) => {
                        let path = desktop::local_file(&uri)?;
                        if !path.is_dir() {
                            return Err(Error::NotFound("directory is unavailable".into()));
                        }
                        request.mode = "open".into();
                        request.uris = vec![
                            glib::filename_to_uri(path, None)
                                .map_err(|_| Error::Invalid("directory URI".into()))?
                                .to_string(),
                        ];
                        s.apps.get(&s.default).cloned().ok_or_else(|| {
                            Error::Unavailable(
                                "default directory handler is absent from catalogue".into(),
                            )
                        })?
                    }
                };
                let nonce = request.nonce.clone();
                let mode = request.mode.clone();
                let plan = launch::prepare(&app, request, &s.apps, &s.default)?;
                let id =
                    s.launches
                        .insert(owner, nonce, fingerprint, &app, &mode, plan.token_hash())?;
                if s.observation.live {
                    s.launches.baseline(
                        &id,
                        s.observation.epoch.clone(),
                        s.observation.windows.keys().copied().collect(),
                    );
                }
                s.mark("launches");
                Ok((id, Some(plan)))
            })
            .await?;
        if let Some(plan) = plan {
            launch::run(
                self.store.clone(),
                conn.clone(),
                self.launch_workers.clone(),
                id.clone(),
                peer,
                plan,
            );
        }
        Ok(id)
    }
    fn admit(&self, header: &Header<'_>) -> Result<Admitted, Error> {
        let owner = sender(header)?;
        let mut s = self.admission.lock().unwrap();
        if s.active >= 256 || s.clients.get(&owner).copied().unwrap_or(0) >= 64 {
            return Err(Error::Busy(
                "per-client/global application admission budget".into(),
            ));
        }
        s.active += 1;
        *s.clients.entry(owner.clone()).or_default() += 1;
        Ok(Admitted {
            state: self.admission.clone(),
            owner,
        })
    }
    async fn peer(&self, header: &Header<'_>, conn: &Connection) -> Result<Arc<Peer>, Error> {
        let sender = sender(header)?;
        if let Some(p) = self.peers.lock().await.get(&sender).cloned() {
            return Ok(p);
        }
        let dbus = zbus::fdo::DBusProxy::new(conn)
            .await
            .map_err(|e| Error::AccessDenied(e.to_string()))?;
        let creds = dbus
            .get_connection_credentials(
                sender
                    .as_str()
                    .try_into()
                    .map_err(|_| Error::AccessDenied("invalid sender".into()))?,
            )
            .await
            .map_err(|e| Error::AccessDenied(e.to_string()))?;
        let peer = Arc::new(
            Peer::from_credentials(
                creds
                    .process_id()
                    .ok_or_else(|| Error::AccessDenied("PID unavailable".into()))?,
                creds
                    .unix_user_id()
                    .ok_or_else(|| Error::AccessDenied("UID unavailable".into()))?,
            )
            .map_err(|e| Error::AccessDenied(e.to_string()))?,
        );
        let mut peers = self.peers.lock().await;
        if peers.len() >= 256 {
            peers.clear();
        }
        peers.insert(sender, peer.clone());
        Ok(peer)
    }
}
#[zbus::interface(name = "org.nidara.Applications1")]
impl Applications {
    #[zbus(property)]
    async fn available(&self) -> bool {
        self.store.call(|s| Ok(s.healthy)).await.unwrap_or(false)
    }
    #[zbus(property)]
    async fn unavailable_reason(&self) -> String {
        self.store
            .call(|s| {
                Ok(if s.healthy {
                    String::new()
                } else {
                    s.diagnostics.join("; ")
                })
            })
            .await
            .unwrap_or_else(|e| e.to_string())
    }
    #[zbus(property)]
    async fn capabilities(&self) -> Vec<String> {
        let mut result = vec![
            "catalogue",
            "search",
            "icons",
            "trash-icon",
            "icon-overrides",
            "launch",
            "open-directory",
            "autostart",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
        if self
            .store
            .call(|s| Ok(s.layout_available()))
            .await
            .unwrap_or(false)
        {
            result.extend(["layout-apps".into(), "layout-folders".into()]);
        }
        if let Ok(extra) = self
            .store
            .call(|s| {
                let mut v = vec![];
                if s.observation.live {
                    v.push("window-matching".to_string());
                    v.push("launch-correlation".into());
                    if s.usage.available() {
                        v.push("foreground-usage".into());
                    }
                }
                if s.usage.baseline_available() {
                    v.push("new-apps".into());
                }
                if s.unity.available {
                    v.push("launcher-badges".into());
                }
                Ok(v)
            })
            .await
        {
            result.extend(extra);
        }
        result
    }
    #[zbus(property)]
    async fn epoch(&self) -> u64 {
        self.store.call(|s| Ok(s.epoch)).await.unwrap_or(0)
    }
    #[zbus(property)]
    async fn revision(&self) -> u64 {
        self.store.call(|s| Ok(s.revision)).await.unwrap_or(0)
    }
    #[zbus(property)]
    async fn catalogue_revision(&self) -> u64 {
        self.store
            .call(|s| Ok(s.catalogue_revision))
            .await
            .unwrap_or(0)
    }
    #[zbus(property)]
    async fn layout_revision(&self) -> u64 {
        self.store
            .call(|s| Ok(s.layout_revision))
            .await
            .unwrap_or(0)
    }
    #[zbus(property)]
    async fn usage_revision(&self) -> u64 {
        self.store.call(|s| Ok(s.usage_revision)).await.unwrap_or(0)
    }
    #[zbus(property)]
    async fn launcher_revision(&self) -> u64 {
        self.store
            .call(|s| Ok(s.launcher_revision))
            .await
            .unwrap_or(0)
    }
    async fn get_snapshot(
        &self,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(u64, u64, Dict), Error> {
        let _admission = self.admit(&header)?;
        let owner = sender(&header)?;
        let (e, r, mut state) = self
            .store
            .call(|s| Ok((s.epoch, s.revision, s.metadata())))
            .await?;
        let apps = state["Apps"]
            .as_array_mut()
            .map(std::mem::take)
            .unwrap_or_default();
        let windows = state["WindowMatches"]
            .as_array_mut()
            .map(std::mem::take)
            .unwrap_or_default();
        let (first, next, first_windows, next_windows) =
            self.pages
                .lock()
                .await
                .start(owner.clone(), e, apps, windows)?;
        state["Apps"] = json!(first);
        state["AppsNext"] = json!(next);
        state["WindowMatches"] = json!(first_windows);
        state["WindowMatchesNext"] = json!(next_windows);
        if state.to_string().len() * 2 > 2 * 1024 * 1024 {
            let mut pages = self.pages.lock().await;
            pages.close(&owner, e, &next);
            pages.close(&owner, e, &next_windows);
            return Err(Error::Busy("root snapshot budget".into()));
        }
        Ok((e, r, dict(&state)))
    }
    async fn read_snapshot_page(
        &self,
        epoch: u64,
        token: String,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(Records, String), Error> {
        let _admission = self.admit(&header)?;
        self.pages
            .lock()
            .await
            .read(&sender(&header)?, epoch, &token)
    }
    async fn close_snapshot(&self, epoch: u64, token: String, #[zbus(header)] header: Header<'_>) {
        if let Ok(owner) = sender(&header) {
            self.pages.lock().await.close(&owner, epoch, &token);
        }
    }
    async fn search(
        &self,
        epoch: u64,
        catalogue_revision: u64,
        query: String,
        limit: u32,
        include_hidden: bool,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(u64, Records), Error> {
        let _admission = self.admit(&header)?;
        if !(1..=100).contains(&limit) || query.len() > 4096 {
            return Err(Error::Invalid("search bounds".into()));
        }
        self.store
            .call(move |s| {
                s.epoch(epoch)?;
                if s.catalogue_revision != catalogue_revision {
                    return Err(Error::Stale("catalogue changed".into()));
                }
                Ok((
                    s.usage_revision,
                    search::rank(&query, s.apps.values(), include_hidden, limit as usize)
                        .iter()
                        .map(|a| dict(&a.record))
                        .collect(),
                ))
            })
            .await
    }
    async fn edit_layout(
        &self,
        epoch: u64,
        expected_layout_revision: u64,
        edit: Dict,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<(u64, Records), Error> {
        let _admission = self.admit(&header)?;
        let peer = self.peer(&header, conn).await?;
        let edit = request(edit)?;
        self.store
            .call(move |s| {
                s.epoch(epoch)?;
                s.authorize(&peer, Operation::EditPins)?;
                if s.layout_revision != expected_layout_revision {
                    return Err(Error::Conflict("layout revision changed".into()));
                }
                let next = layout::edit(&s.layout, edit, &s.apps)?;
                s.save_layout(next)?;
                Ok((
                    s.layout_revision,
                    layout::records(&s.layout, &s.apps, &s.default)
                        .iter()
                        .map(dict)
                        .collect(),
                ))
            })
            .await
    }
    async fn get_icon(
        &self,
        epoch: u64,
        desktop_id: String,
        generation: u64,
        logical_size: u32,
        scale: f64,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(String, u32, u32, Vec<u8>), Error> {
        let _admission = self.admit(&header)?;
        if !(16..=512).contains(&logical_size)
            || !scale.is_finite()
            || !(1.0..=4.0).contains(&scale)
        {
            return Err(Error::Invalid("icon size/scale bounds".into()));
        }
        let side = (logical_size as f64 * scale).ceil().min(1024.0) as u32;
        let _permit = self
            .decode
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy("icon workers occupied".into()))?;
        let id = desktop_id.clone();
        let (a, revision, theme) = self
            .store
            .call(move |s| {
                s.epoch(epoch)?;
                Ok((
                    s.app(&id, generation)?.clone(),
                    s.icon_revision,
                    s.theme.clone(),
                ))
            })
            .await?;
        let (token, w, h, rgba) = tokio::task::spawn_blocking(move || {
            let path = icons::resolve(&a, &theme, side);
            let image = path.as_ref().map(|p| icons::read(p, side));
            let (reason, (w, h, rgba)) = match image {
                Some(Ok(p)) => ("asset", p),
                Some(Err(_)) => ("fallback-v1:decode", icons::fallback(side)),
                None => ("fallback-v1:missing", icons::fallback(side)),
            };
            let pixels_hash = catalogue::hash(&rgba);
            let token = catalogue::hash(
                format!(
                    "{}:{generation}:{revision}:{logical_size}:{scale}:{reason}:{pixels_hash}:{}",
                    a.id,
                    path.map(|p| p.to_string_lossy().into_owned())
                        .unwrap_or_default()
                )
                .as_bytes(),
            );
            (format!("{reason}:{token}"), w, h, rgba)
        })
        .await
        .map_err(|e| Error::Failed(e.to_string()))?;
        self.store
            .call(move |s| {
                s.epoch(epoch)?;
                s.app(&desktop_id, generation)?;
                if revision != s.icon_revision {
                    return Err(Error::Stale("icon changed during decode".into()));
                }
                Ok(())
            })
            .await?;
        Ok((token, w, h, rgba))
    }
    /// The Trash's art from the user's icon theme (§8 Trash), the one dock slot with no
    /// desktop entry. Fixed freedesktop names only, never a generic named-icon lookup, and
    /// Unavailable when the theme has none: the dock then keeps its own symbol.
    async fn get_trash_icon(
        &self,
        epoch: u64,
        full: bool,
        logical_size: u32,
        scale: f64,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(String, u32, u32, Vec<u8>), Error> {
        let _admission = self.admit(&header)?;
        if !(16..=512).contains(&logical_size)
            || !scale.is_finite()
            || !(1.0..=4.0).contains(&scale)
        {
            return Err(Error::Invalid("icon size/scale bounds".into()));
        }
        let side = (logical_size as f64 * scale).ceil().min(1024.0) as u32;
        let _permit = self
            .decode
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy("icon workers occupied".into()))?;
        let (revision, theme) = self
            .store
            .call(move |s| {
                s.epoch(epoch)?;
                Ok((s.icon_revision, s.theme.clone()))
            })
            .await?;
        let found = tokio::task::spawn_blocking(move || {
            let path = icons::trash_names(full)
                .iter()
                .find_map(|n| icons::resolve_name(n, &theme, side))?;
            let pixels = icons::read(&path, side).ok()?;
            Some((path, pixels))
        })
        .await
        .map_err(|e| Error::Failed(e.to_string()))?;
        let Some((path, (w, h, rgba))) = found else {
            return Err(Error::Unavailable("the icon theme has no Trash".into()));
        };
        let token = catalogue::hash(
            format!(
                "trash:{full}:{revision}:{logical_size}:{scale}:{}:{}",
                path.to_string_lossy(),
                catalogue::hash(&rgba)
            )
            .as_bytes(),
        );
        self.store
            .call(move |s| {
                s.epoch(epoch)?;
                if revision != s.icon_revision {
                    return Err(Error::Stale("icon changed during decode".into()));
                }
                Ok(())
            })
            .await?;
        Ok((format!("asset:{token}"), w, h, rgba))
    }
    async fn set_icon_override(
        &self,
        epoch: u64,
        desktop_id: String,
        generation: u64,
        source: Dict,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<u64, Error> {
        let _admission = self.admit(&header)?;
        let peer = self.peer(&header, conn).await?;
        let p = peer.clone();
        let id = desktop_id.clone();
        let source = request(source)?;
        let theme = self
            .store
            .call(move |s| {
                s.epoch(epoch)?;
                s.authorize(&p, Operation::AppIcon)?;
                s.app(&id, generation)?;
                Ok(s.theme.clone())
            })
            .await?;
        let obj = source.as_object().unwrap();
        if obj.len() != 2 || obj.keys().any(|k| k != "Kind" && k != "Value") {
            return Err(Error::Invalid("icon source keys are Kind and Value".into()));
        }
        let kind = source["Kind"]
            .as_str()
            .ok_or_else(|| Error::Invalid("missing Kind".into()))?;
        let value = source["Value"]
            .as_str()
            .ok_or_else(|| Error::Invalid("missing Value".into()))?;
        let path = match kind {
            "theme" if !value.contains('/') => icons::resolve_name(value, &theme, 512)
                .ok_or_else(|| Error::NotFound("theme icon not found".into()))?,
            "file" => {
                let (p, h) =
                    glib::filename_from_uri(value).map_err(|e| Error::Invalid(e.to_string()))?;
                if h.is_some() || !p.is_absolute() {
                    return Err(Error::Invalid("icon must be local file URI".into()));
                }
                p
            }
            _ => return Err(Error::Invalid("unsupported icon source".into())),
        };
        let _permit = self
            .decode
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy("icon workers occupied".into()))?;
        let bytes = tokio::task::spawn_blocking(move || {
            let (w, h, rgba) = icons::read(&path, 512)?;
            let mut bytes = vec![];
            {
                let mut e = png::Encoder::new(&mut bytes, w, h);
                e.set_color(png::ColorType::Rgba);
                e.set_depth(png::BitDepth::Eight);
                e.write_header()
                    .map_err(|e| Error::Failed(e.to_string()))?
                    .write_image_data(&rgba)
                    .map_err(|e| Error::Failed(e.to_string()))?;
            }
            Ok::<_, Error>(bytes)
        })
        .await
        .map_err(|e| Error::Failed(e.to_string()))??;
        self.store
            .call(move |s| {
                s.epoch(epoch)?;
                s.app(&desktop_id, generation)?;
                s.authorize(&peer, Operation::AppIcon)?;
                icons::write_override(&desktop_id, &bytes)?;
                s.icons_changed();
                Ok(s.icon_revision)
            })
            .await
    }
    async fn reset_icon_override(
        &self,
        epoch: u64,
        desktop_id: String,
        generation: u64,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<u64, Error> {
        let _admission = self.admit(&header)?;
        let peer = self.peer(&header, conn).await?;
        self.store
            .call(move |s| {
                s.epoch(epoch)?;
                s.app(&desktop_id, generation)?;
                s.authorize(&peer, Operation::AppIcon)?;
                icons::check_override_parent()?;
                match std::fs::remove_file(icons::app_override(&desktop_id)) {
                    Ok(()) => {
                        s.icons_changed();
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => return Err(Error::Failed(e.to_string())),
                }
                Ok(s.icon_revision)
            })
            .await
    }
    async fn resolve_window(
        &self,
        epoch: u64,
        hyalo_epoch: String,
        window_id: u64,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<Dict, Error> {
        let _admission = self.admit(&header)?;
        self.store
            .call(move |s| {
                s.epoch(epoch)?;
                if !s.observation.live {
                    return Err(Error::Unavailable("H1 observation unavailable".into()));
                }
                if s.observation.epoch != hyalo_epoch {
                    return Err(Error::Stale("Hyalo connection changed".into()));
                }
                let w = s
                    .observation
                    .windows
                    .get(&window_id)
                    .ok_or_else(|| Error::NotFound("window unavailable".into()))?;
                Ok(dict(&s.index.resolve(w, &hyalo_epoch)))
            })
            .await
    }
    async fn launch(
        &self,
        epoch: u64,
        desktop_id: String,
        generation: u64,
        request: Dict,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<String, Error> {
        let _admission = self.admit(&header)?;
        let peer = self.peer(&header, conn).await?;
        self.submit(
            epoch,
            LaunchTarget::App(desktop_id, generation),
            desktop::Request::parse(request, false)?,
            peer,
            sender(&header)?,
            conn,
        )
        .await
    }
    async fn open_directory(
        &self,
        epoch: u64,
        uri: String,
        context: Dict,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<String, Error> {
        let _admission = self.admit(&header)?;
        if uri.len() > 8192 {
            return Err(Error::Invalid("directory URI budget".into()));
        }
        let peer = self.peer(&header, conn).await?;
        self.submit(
            epoch,
            LaunchTarget::Directory(uri),
            desktop::Request::parse(context, true)?,
            peer,
            sender(&header)?,
            conn,
        )
        .await
    }
    async fn get_launch(
        &self,
        epoch: u64,
        launch_id: String,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<Dict, Error> {
        let _admission = self.admit(&header)?;
        self.store
            .call(move |s| {
                s.epoch(epoch)?;
                Ok(dict(&s.launches.state(&launch_id)?))
            })
            .await
    }
    async fn set_autostart(
        &self,
        epoch: u64,
        desktop_id: String,
        generation: u64,
        enabled: bool,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<Dict, Error> {
        let _admission = self.admit(&header)?;
        let peer = self.peer(&header, conn).await?;
        self.store
            .call(move |s| {
                s.epoch(epoch)?;
                s.authorize(&peer, Operation::AppAutostart)?;
                let app = s.app(&desktop_id, generation)?.clone();
                let state = autostart::set(&app, enabled)?;
                s.mark("autostart");
                s.invalidate();
                Ok(dict(&state))
            })
            .await
    }
    async fn acknowledge_new(
        &self,
        epoch: u64,
        ids: Vec<String>,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<u64, Error> {
        let _admission = self.admit(&header)?;
        if ids.len() > 256 || ids.iter().map(String::len).sum::<usize>() > 128 * 1024 {
            return Err(Error::Invalid("acknowledgement budget".into()));
        }
        let peer = self.peer(&header, conn).await?;
        self.store
            .call(move |s| {
                s.epoch(epoch)?;
                for id in &ids {
                    if !s.apps.contains_key(id) {
                        return Err(Error::NotFound("app unavailable".into()));
                    }
                }
                s.authorize(&peer, Operation::AppAcknowledge)?;
                s.usage.acknowledge(&ids)?;
                s.project_usage();
                Ok(s.usage_revision)
            })
            .await
    }
    #[zbus(signal)]
    async fn changed(
        emitter: &SignalEmitter<'_>,
        epoch: u64,
        revision: u64,
        domains: Vec<String>,
    ) -> zbus::Result<()>;
}
pub async fn serve(conn: &Connection) -> Result<bool, Box<dyn std::error::Error>> {
    // Avoid even constructing/migrating a store for an already competing owner.
    // Register the ready object before publishing the well-known name: clients
    // hydrate on NameOwnerChanged and must never race UnknownObject.
    if zbus::fdo::DBusProxy::new(conn)
        .await?
        .name_has_owner(NAME.try_into()?)
        .await?
    {
        eprintln!("[applications] competing name owner; not serving");
        return Ok(false);
    }
    let (store, notify) = store::spawn().await?;
    let pages = Arc::new(Mutex::new(Pages::default()));
    let peers = Arc::new(Mutex::new(HashMap::new()));
    conn.object_server()
        .at(
            PATH,
            Applications {
                admission: Arc::new(std::sync::Mutex::new(Admission::default())),
                store: store.clone(),
                pages: pages.clone(),
                peers: peers.clone(),
                decode: Arc::new(Semaphore::new(8)),
                launch_workers: Arc::new(Semaphore::new(8)),
            },
        )
        .await?;
    let mut owners = zbus::fdo::DBusProxy::new(conn)
        .await?
        .receive_name_owner_changed()
        .await?;
    let owned = matches!(
        conn.request_name_with_flags(NAME, zbus::fdo::RequestNameFlags::DoNotQueue.into())
            .await,
        Ok(zbus::fdo::RequestNameReply::PrimaryOwner)
    );
    if !owned {
        conn.object_server().remove::<Applications, _>(PATH).await?;
        eprintln!("[applications] competing name owner; not serving");
        return Ok(false);
    }
    let owner_store = store.clone();
    tokio::spawn(async move {
        use futures_util::StreamExt;
        while let Some(signal) = owners.next().await {
            if let Ok(a) = signal.args()
                && a.name().as_str().starts_with(':')
                && a.new_owner().is_none()
            {
                let lost = a.name().to_string();
                let _ = owner_store
                    .call(move |s| {
                        s.launches.sender_lost(&lost);
                        Ok(())
                    })
                    .await;
                peers.lock().await.remove(a.name().as_str());
                pages
                    .lock()
                    .await
                    .sessions
                    .retain(|_, s| s.owner != a.name().as_str());
            }
        }
    });
    let signal_store = store.clone();
    let emitter = SignalEmitter::new(conn, PATH)?.into_owned();
    let signal_connection = conn.clone();
    tokio::spawn(async move {
        loop {
            notify.notified().await;
            let result = signal_store
                .call(|s| Ok((s.epoch, s.revision, s.take_domains())))
                .await;
            if let Ok((e, r, d)) = result
                && !d.is_empty()
            {
                let _ = Applications::changed(&emitter, e, r, d).await;
                let _ = signal_connection
                    .emit_signal(
                        None::<&str>,
                        PATH,
                        "org.freedesktop.DBus.Properties",
                        "PropertiesChanged",
                        &(
                            "org.nidara.Applications1",
                            Dict::new(),
                            vec![
                                "Available",
                                "UnavailableReason",
                                "Capabilities",
                                "Epoch",
                                "Revision",
                                "CatalogueRevision",
                                "LayoutRevision",
                                "UsageRevision",
                                "LauncherRevision",
                            ],
                        ),
                    )
                    .await;
            }
        }
    });
    observation::spawn(store.clone());
    unity::spawn(store.clone());
    theme::watch(conn, store).await?;
    eprintln!("[applications] serving {NAME} (A1/A2/A3, no renderer)");
    Ok(true)
}

#[cfg(test)]
mod page_tests {
    use super::*;
    #[test]
    fn app_only_clients_can_close_a_window_only_paged_snapshot() {
        let mut p = Pages::default();
        let apps = vec![json!({"DesktopId":"A.desktop"})];
        let windows = (0..300).map(|id| json!({"WindowId":id})).collect();
        let (_, a, _, w) = p.start(":1".into(), 1, apps, windows).unwrap();
        assert!(!a.is_empty() && !w.is_empty());
        let (rows, next) = p.read(":1", 1, &a).unwrap();
        assert!(rows.is_empty() && next.is_empty());
        assert!(!p.read(":1", 1, &w).unwrap().0.is_empty());
        assert!(p.read(":2", 1, &w).is_err());
        p.close(":1", 1, &a);
        assert!(p.read(":1", 1, &w).is_err());
        assert!(p.sessions.is_empty());
    }
}
