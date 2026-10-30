// SPDX-License-Identifier: GPL-3.0-or-later
//! Opt-in Applications1 A1. No launch, WM, usage tracker or TS bridge.
mod catalogue;
mod icons;
mod layout;
mod search;
mod store;
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
    ) -> Result<(Vec<Json>, String), Error> {
        self.cleanup();
        let (first, end) = page(&apps, 0);
        if end == apps.len() {
            return Ok((first, String::new()));
        }
        let bytes = apps.iter().map(|a| a.to_string().len() * 4).sum::<usize>();
        if self.sessions.values().filter(|s| s.owner == owner).count() >= 16
            || self.sessions.len() >= 256
            || self.sessions.values().map(|s| s.bytes).sum::<usize>() + bytes > 32 * 1024 * 1024
        {
            return Err(Error::Busy("snapshot retention budget".into()));
        }
        let id = format!("{:x}", unique());
        self.sessions.insert(
            id.clone(),
            Snapshot {
                owner,
                epoch,
                expires: Instant::now() + Duration::from_secs(10),
                apps,
                bytes,
            },
        );
        Ok((first, format!("{id}:{end}")))
    }
    fn read(&mut self, owner: &str, epoch: u64, token: &str) -> Result<(Records, String), Error> {
        self.cleanup();
        let (id, cursor) = token
            .split_once(':')
            .ok_or_else(|| Error::Stale("invalid page token".into()))?;
        let at = cursor
            .parse::<usize>()
            .map_err(|_| Error::Stale("invalid page cursor".into()))?;
        let s = self
            .sessions
            .get(id)
            .filter(|s| s.owner == owner && s.epoch == epoch)
            .ok_or_else(|| Error::Stale("expired or foreign snapshot".into()))?;
        if at >= s.apps.len() {
            return Err(Error::Stale("snapshot cursor out of range".into()));
        }
        let (rows, end) = page(&s.apps, at);
        Ok((
            rows.iter().map(dict).collect(),
            if end == s.apps.len() {
                String::new()
            } else {
                format!("{id}:{end}")
            },
        ))
    }
    fn close(&mut self, owner: &str, epoch: u64, token: &str) {
        let id = token.split(':').next().unwrap_or("");
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
}
impl Applications {
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
        let mut result = vec!["catalogue", "search", "icons", "icon-overrides"]
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
    fn usage_revision(&self) -> u64 {
        0
    }
    #[zbus(property)]
    fn launcher_revision(&self) -> u64 {
        0
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
        let (first, next) = self.pages.lock().await.start(owner, e, apps)?;
        state["Apps"] = json!(first);
        state["AppsNext"] = json!(next);
        state["WindowMatchesNext"] = json!("");
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
                    0,
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
        _epoch: u64,
        _hyalo_epoch: String,
        _window_id: u64,
    ) -> Result<Dict, Error> {
        Err(Error::Unavailable(
            "coherent window observation is H1/A3".into(),
        ))
    }
    async fn launch(
        &self,
        _epoch: u64,
        _desktop_id: String,
        _generation: u64,
        _request: Dict,
    ) -> Result<String, Error> {
        Err(Error::Unavailable("application launching is A2".into()))
    }
    async fn open_directory(
        &self,
        _epoch: u64,
        _uri: String,
        _context: Dict,
    ) -> Result<String, Error> {
        Err(Error::Unavailable("directory launching is A2".into()))
    }
    async fn get_launch(&self, _epoch: u64, _launch_id: String) -> Result<Dict, Error> {
        Err(Error::Unavailable("launch observation is A2/H1/A3".into()))
    }
    async fn set_autostart(
        &self,
        _epoch: u64,
        _desktop_id: String,
        _generation: u64,
        _enabled: bool,
    ) -> Result<Dict, Error> {
        Err(Error::Unavailable("app autostart is A2".into()))
    }
    async fn acknowledge_new(&self, _epoch: u64, _ids: Vec<String>) -> Result<u64, Error> {
        Err(Error::Unavailable("new app markers are A3".into()))
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
    let owned = matches!(
        conn.request_name_with_flags(NAME, zbus::fdo::RequestNameFlags::DoNotQueue.into())
            .await,
        Ok(zbus::fdo::RequestNameReply::PrimaryOwner)
    );
    if !owned {
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
            },
        )
        .await?;
    let mut owners = zbus::fdo::DBusProxy::new(conn)
        .await?
        .receive_name_owner_changed()
        .await?;
    tokio::spawn(async move {
        use futures_util::StreamExt;
        while let Some(signal) = owners.next().await {
            if let Ok(a) = signal.args()
                && a.name().as_str().starts_with(':')
                && a.new_owner().is_none()
            {
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
                            ],
                        ),
                    )
                    .await;
            }
        }
    });
    let portal = conn.clone();
    tokio::spawn(async move {
        loop {
            let result = tokio::time::timeout(Duration::from_secs(1), async {
                let dbus = zbus::fdo::DBusProxy::new(&portal).await?;
                let owner = dbus
                    .get_name_owner("org.freedesktop.portal.Desktop".try_into().unwrap())
                    .await?;
                let p = zbus::Proxy::new(
                    &portal,
                    owner,
                    "/org/freedesktop/portal/desktop",
                    "org.freedesktop.portal.Settings",
                )
                .await?;
                p.call::<_, _, OwnedValue>("Read", &("org.gnome.desktop.interface", "icon-theme"))
                    .await
            })
            .await;
            if let Ok(Ok(value)) = result
                && let Ok(theme) = <&str>::try_from(&value)
            {
                let theme = theme.to_string();
                let _ = store
                    .call(move |s| {
                        if s.theme != theme {
                            s.theme = theme;
                            s.icons_changed();
                        }
                        Ok(())
                    })
                    .await;
            }
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    eprintln!("[applications] serving {NAME} (A1, no launches)");
    Ok(true)
}
