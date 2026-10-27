// SPDX-License-Identifier: GPL-3.0-or-later
//! Native energy service. Mutations are opt-in; providers and object identities are independent.
mod bus;
mod model;
mod prefs;
mod provider;
use futures_util::StreamExt;
use model::{Battery, Effect, Policy, Preferences};
use serde_json::{Value as Json, json};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{
        Arc, RwLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex, oneshot};
use zbus::{
    Connection, Proxy,
    zvariant::{OwnedObjectPath as Path, OwnedValue, Value},
};
const ROOT: &str = "/org/nidara/Power";
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.Power1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    Unavailable(String),
    NotSupported(String),
    NotFound(String),
    InvalidArgument(String),
    PermissionDenied(String),
    AuthenticationRequired(String),
    Busy(String),
    Timeout(String),
    Superseded(String),
    Failed(String),
}
impl From<zbus::fdo::Error> for Error {
    fn from(e: zbus::fdo::Error) -> Self {
        Self::Failed(e.to_string())
    }
}
fn path(s: &str) -> Path {
    Path::try_from(s).expect("internal object path")
}
fn now() -> u64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1000
}
#[derive(Clone, Default)]
struct Provider {
    owner: String,
    epoch: u64,
    error: String,
}
#[derive(Clone)]
struct Object {
    path: String,
    kind: &'static str,
    provider: &'static str,
    raw: String,
    epoch: u64,
    props: Json,
}
#[derive(Clone)]
struct Hold {
    provider_connection: Connection,
    provider_owner: String,
    path: String,
    owner: String,
    epoch: u64,
    cookie: u32,
    automatic: bool,
    profile: String,
    reason: String,
    app: String,
}
#[derive(Clone)]
struct Menu {
    path: String,
    owner: String,
    consumer: Path,
}
#[derive(Clone, Default)]
struct State {
    providers: BTreeMap<&'static str, Provider>,
    objects: BTreeMap<String, Object>,
    root: Json,
    policy: Policy,
    battery: Battery,
    holds: BTreeMap<String, Hold>,
    menu: Option<Menu>,
    hyalo: Json,
    last_lid: Option<bool>,
    last_docked: Option<bool>,
    lid_sequence: u64,
    peripheral: BTreeMap<String, Policy>,
    notifications: BTreeMap<String, u32>,
    retired: std::collections::BTreeSet<String>,
    released: std::collections::BTreeSet<(u64, u32)>,
    releasing: std::collections::BTreeSet<(u64, u32)>,
}
type PendingMenus = BTreeMap<u64, (String, oneshot::Sender<()>)>;
#[derive(Clone)]
struct Power {
    conn: Connection,
    system: Arc<RwLock<Option<Connection>>>,
    state: Arc<RwLock<State>>,
    prefs: Arc<RwLock<Preferences>>,
    updates: Arc<Mutex<()>>,
    announced: Arc<Mutex<BTreeMap<String, bus::Props>>>,
    read_only: bool,
    epoch: u64,
    serial: Arc<AtomicU64>,
    key_fd: Arc<Mutex<Option<zbus::zvariant::OwnedFd>>>,
    lid_fd: Arc<Mutex<Option<zbus::zvariant::OwnedFd>>>,
    policy_write: Arc<Mutex<()>>,
    keyboard_write: Arc<Mutex<()>>,
    keyboard_serial: Arc<AtomicU64>,
    menu_wait: Arc<Mutex<PendingMenus>>,
}
impl Power {
    fn object(&self, p: &str) -> Result<Object, Error> {
        let state = self.state.read().unwrap();
        state
            .objects
            .get(p)
            .filter(|_| !state.retired.contains(p))
            .cloned()
            .ok_or_else(|| {
                Error::NotFound("object withdrawn or from an older provider epoch".into())
            })
    }

    fn property<T: serde::de::DeserializeOwned + Default>(&self, p: &str, k: &str) -> T {
        let state = self.state.read().unwrap();
        let value = if p == ROOT {
            state.root.get(k)
        } else {
            state.objects.get(p).and_then(|o| o.props.get(k))
        };
        value
            .and_then(|v| serde_json::from_value(v.clone()).ok())
            .unwrap_or_default()
    }
    fn mutable(&self) -> Result<(), Error> {
        if self.read_only {
            Err(Error::PermissionDenied("read-only Power1".into()))
        } else {
            Ok(())
        }
    }
    fn active(&self) -> bool {
        self.property::<bool>(ROOT, "SessionActive")
    }
    async fn backend(
        &self,
        name: &'static str,
        raw: &str,
        iface: &str,
    ) -> Result<Proxy<'static>, Error> {
        let p = self
            .state
            .read()
            .unwrap()
            .providers
            .get(name)
            .cloned()
            .unwrap_or_default();
        if p.owner.is_empty() {
            return Err(Error::Unavailable(format!("{name} unavailable")));
        }
        let connection = self
            .system
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| Error::Unavailable("system bus unavailable".into()))?;
        Proxy::new_owned(connection, p.owner, raw.to_string(), iface.to_string())
            .await
            .map_err(Error::from)
    }
    async fn check_object(&self, o: &Object) -> Result<(), Error> {
        let current = self.object(&o.path)?;
        if current.epoch != o.epoch || current.raw != o.raw {
            return Err(Error::NotFound("provider identity changed".into()));
        }
        provider::check_owner(self, o.provider).await?;
        let current = self.object(&o.path)?;
        if current.epoch != o.epoch || current.raw != o.raw {
            return Err(Error::NotFound("provider identity changed".into()));
        }
        Ok(())
    }
    async fn observed(&self, o: &Object, key: &str, expected: Json) -> Result<(), Error> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            self.refresh().await?;
            self.check_object(o).await?;
            if self.object(&o.path)?.props[key] == expected {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(Error::Timeout(
                    "provider state not confirmed; result uncertain".into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
    }
    async fn profile(&self, name: String) -> Result<(), Error> {
        self.mutable()?;
        if !self.active() {
            return Err(Error::PermissionDenied(
                "session is not active/local".into(),
            ));
        }
        let exists = self
            .state
            .read()
            .unwrap()
            .objects
            .values()
            .any(|o| o.kind == "profile" && o.props["Name"] == name);
        if !exists {
            return Err(Error::NotSupported("profile not advertised".into()));
        }
        provider::check_owner(self, "ppd").await?;
        let epoch = self.state.read().unwrap().providers["ppd"].epoch;
        {
            self.state.write().unwrap().policy.manual_override();
        }
        self.persist().await;
        let proxy = self
            .backend("ppd", provider::PPD_PATH, provider::PPD)
            .await?;
        provider::bounded(proxy.set_property("ActiveProfile", name.clone())).await?;
        self.refresh().await?;
        if self.state.read().unwrap().providers["ppd"].epoch != epoch {
            return Err(Error::NotFound("profile provider changed".into()));
        }
        if self.property::<String>(ROOT, "ActiveProfile") != name {
            return Err(Error::Timeout("profile selection not observed".into()));
        }
        Ok(())
    }
    async fn hold(
        &self,
        owner: String,
        profile: String,
        reason: String,
        app: String,
        automatic: bool,
    ) -> Result<Path, Error> {
        self.mutable()?;
        if !self.active() {
            return Err(Error::PermissionDenied("inactive session".into()));
        }
        if !["power-saver", "performance"].contains(&profile.as_str())
            || reason.len() > 1024
            || app.len() > 256
        {
            return Err(Error::InvalidArgument("invalid hold arguments".into()));
        }
        if self
            .state
            .read()
            .unwrap()
            .holds
            .values()
            .filter(|h| h.owner == owner)
            .count()
            >= 8
        {
            return Err(Error::Busy("hold limit".into()));
        }
        if !self
            .state
            .read()
            .unwrap()
            .objects
            .values()
            .any(|o| o.kind == "profile" && o.props["Name"] == profile)
        {
            return Err(Error::NotSupported("profile not advertised".into()));
        }
        let episode = self.state.read().unwrap().policy.episode;
        let epoch = self
            .state
            .read()
            .unwrap()
            .providers
            .get("ppd")
            .map(|p| p.epoch)
            .ok_or_else(|| Error::Unavailable("PPD absent".into()))?;
        let proxy = self
            .backend("ppd", provider::PPD_PATH, provider::PPD)
            .await?;
        let cookie: u32 = provider::bounded(proxy.call(
            "HoldProfile",
            &(profile.clone(), reason.clone(), app.clone()),
        ))
        .await?;
        provider::check_owner(self, "ppd").await?;
        let owner_alive = zbus::fdo::DBusProxy::new(&self.conn)
            .await?
            .name_has_owner(
                owner
                    .as_str()
                    .try_into()
                    .map_err(|_| Error::InvalidArgument("invalid owner".into()))?,
            )
            .await
            .unwrap_or(false);
        let superseded = {
            let state = self.state.read().unwrap();
            !owner_alive
                || state.released.contains(&(epoch, cookie))
                || !state.root["SessionActive"].as_bool().unwrap_or(false)
                || state.providers.get("ppd").is_none_or(|p| p.epoch != epoch)
                || (automatic
                    && (!state.policy.low
                        || state.policy.overridden
                        || state.policy.episode != episode
                        || state.battery.on_battery != Some(true)
                        || !self.prefs.read().unwrap().automatic_saver))
        };
        if superseded {
            if automatic
                && self
                    .state
                    .read()
                    .unwrap()
                    .released
                    .contains(&(epoch, cookie))
            {
                self.state.write().unwrap().policy.manual_override();
                self.persist().await;
            }
            let _ = provider::bounded(proxy.call::<_, _, ()>("ReleaseProfile", &(cookie,))).await;
            return Err(Error::Superseded("hold request superseded".into()));
        }
        let key = format!(
            "{ROOT}/holds/s{}/h{}",
            self.epoch,
            self.serial.fetch_add(1, Ordering::Relaxed)
        );
        self.state.write().unwrap().holds.insert(
            key.clone(),
            Hold {
                provider_connection: proxy.connection().clone(),
                provider_owner: proxy.destination().to_string(),
                path: key.clone(),
                owner,
                epoch,
                cookie,
                automatic,
                profile,
                reason,
                app,
            },
        );
        self.refresh().await?;
        Ok(path(&key))
    }
    async fn release(&self, key: &str, owner: Option<&str>) -> Result<(), Error> {
        self.mutable()?;
        let hold = self
            .state
            .read()
            .unwrap()
            .holds
            .get(key)
            .cloned()
            .ok_or_else(|| Error::NotFound("hold ended".into()))?;
        if owner.is_some_and(|o| o != hold.owner) {
            return Err(Error::PermissionDenied(
                "hold belongs to another sender".into(),
            ));
        }
        let current = self
            .state
            .read()
            .unwrap()
            .providers
            .get("ppd")
            .cloned()
            .unwrap_or_default();
        if current.epoch == hold.epoch && !current.owner.is_empty() {
            let proxy = self
                .backend("ppd", provider::PPD_PATH, provider::PPD)
                .await?;
            self.state
                .write()
                .unwrap()
                .releasing
                .insert((hold.epoch, hold.cookie));
            provider::bounded(proxy.call::<_, _, ()>("ReleaseProfile", &(hold.cookie,))).await?;
        }
        self.state.write().unwrap().holds.remove(key);
        self.refresh().await?;
        Ok(())
    }
    async fn charge(&self, key: Path, enabled: bool) -> Result<(), Error> {
        self.mutable()?;
        if !self.active() {
            return Err(Error::PermissionDenied("inactive session".into()));
        }
        let o = self.object(key.as_str())?;
        if o.kind != "device"
            || !o.props["ChargeProtectionSupported"]
                .as_bool()
                .unwrap_or(false)
            || o.props["Role"] != "system"
        {
            return Err(Error::NotSupported("charge protection unsupported".into()));
        }
        self.check_object(&o).await?;
        let proxy = self.backend("upower", &o.raw, provider::DEVICE).await?;
        provider::bounded(proxy.call::<_, _, ()>("EnableChargeThreshold", &(enabled,))).await?;
        self.observed(&o, "ChargeProtectionEnabled", json!(enabled))
            .await
    }
    async fn keyboard(&self, key: Path, value: i32) -> Result<(), Error> {
        let ticket = self.keyboard_serial.fetch_add(1, Ordering::SeqCst) + 1;
        let _guard = self.keyboard_write.lock().await;
        if self.keyboard_serial.load(Ordering::SeqCst) != ticket {
            return Err(Error::Superseded("newer brightness requested".into()));
        }
        self.keyboard_write(key, value).await
    }
    async fn keyboard_write(&self, key: Path, value: i32) -> Result<(), Error> {
        self.mutable()?;
        if !self.active() {
            return Err(Error::PermissionDenied("inactive session".into()));
        }
        let o = self.object(key.as_str())?;
        let max = o.props["MaxBrightness"].as_i64().unwrap_or(0);
        if o.kind != "keyboard" || max <= 0 {
            return Err(Error::NotSupported("keyboard backlight absent".into()));
        }
        if value < 0 || value as i64 > max {
            return Err(Error::InvalidArgument(
                "brightness outside hardware range".into(),
            ));
        }
        self.check_object(&o).await?;
        let proxy = self.backend("upower", &o.raw, provider::KBD).await?;
        provider::bounded(proxy.call::<_, _, ()>("SetBrightness", &(value,))).await?;
        self.observed(&o, "Brightness", json!(value)).await
    }
    async fn keyboard_step(&self, direction: i32) -> Result<(), Error> {
        if ![-1, 1].contains(&direction) {
            return Err(Error::InvalidArgument("direction must be -1 or 1".into()));
        }
        let _guard = self.keyboard_write.lock().await;
        self.refresh().await?;
        let primary = self.property::<String>(ROOT, "PrimaryKeyboardBacklight");
        let o = self.object(&primary)?;
        let old = o.props["Brightness"].as_i64().unwrap_or(0) as i32;
        let max = o.props["MaxBrightness"].as_i64().unwrap_or(0) as i32;
        self.keyboard_write(
            path(&primary),
            (old + direction * (max / 10).max(1)).clamp(0, max),
        )
        .await
    }
    async fn action(&self, action: &str, interactive: bool) -> Result<(), Error> {
        self.mutable()?;
        if !self.active() {
            return Err(Error::PermissionDenied("session is inactive/remote".into()));
        }
        if action == "nothing" {
            return Ok(());
        }
        if ["lock", "wake"].contains(&action) {
            let value = if action == "lock" {
                json!({"request":"power_lock"})
            } else {
                json!({"request":"power_wake"})
            };
            return tokio::task::spawn_blocking(move || crate::hyalo::request(value))
                .await
                .map_err(|e| Error::Failed(e.to_string()))?
                .map(|_| ())
                .map_err(Error::Unavailable);
        }
        let method = match action {
            "suspend" => "Suspend",
            "poweroff" => "PowerOff",
            _ => return Err(Error::InvalidArgument("unknown power action".into())),
        };
        let proxy = self
            .backend("logind", provider::LOGIN_PATH, provider::LOGIN)
            .await?;
        provider::check_owner(self, "logind").await?;
        provider::bounded(proxy.call::<_, _, ()>(method, &(interactive,))).await?;
        provider::check_owner(self, "logind").await
    }
    async fn power_button(&self) -> Result<(), Error> {
        self.mutable()?;
        if self.key_fd.lock().await.is_none() {
            return Err(Error::Unavailable(
                "power key forwarding is not armed".into(),
            ));
        }
        let locked = self.state.read().unwrap().hyalo["locked"]
            .as_bool()
            .unwrap_or(true);
        let menu = self.state.read().unwrap().menu.clone();
        let preference = self.prefs.read().unwrap().power_button.clone();
        let effective = model::effective_button(&preference, menu.is_some(), locked).to_string();
        if effective != "menu" {
            return self.action(&effective, false).await;
        }
        let menu = menu.ok_or_else(|| Error::Unavailable("menu lease disappeared".into()))?;
        let id = self.serial.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.menu_wait
            .lock()
            .await
            .insert(id, (menu.path.clone(), tx));
        let _ = self
            .conn
            .emit_signal(
                None::<&str>,
                ROOT,
                "org.nidara.Power1",
                "MenuRequested",
                &(id,),
            )
            .await;
        let result = async {
            let proxy = Proxy::new(
                &self.conn,
                menu.owner.as_str(),
                menu.consumer.as_str(),
                "org.nidara.PowerMenuConsumer1",
            )
            .await?;
            provider::bounded(proxy.call::<_, _, ()>("Show", &(id,))).await?;
            tokio::time::timeout(Duration::from_secs(2), rx)
                .await
                .map_err(|_| Error::Timeout("menu presentation not confirmed".into()))?
                .map_err(|_| Error::Unavailable("menu consumer departed".into()))?;
            Ok::<_, Error>(())
        }
        .await;
        self.menu_wait.lock().await.remove(&id);
        if let Err(e) = &result {
            self.failure("menu", ROOT, e).await;
        }
        result
    }
    async fn register_menu(&self, owner: String, consumer: Path) -> Result<Path, Error> {
        self.mutable()?;
        let _g = self.updates.lock().await;
        if self.state.read().unwrap().menu.is_some() {
            return Err(Error::Busy("menu consumer already registered".into()));
        }
        let key = format!(
            "{ROOT}/menus/s{}/m{}",
            self.epoch,
            self.serial.fetch_add(1, Ordering::Relaxed)
        );
        self.state.write().unwrap().menu = Some(Menu {
            path: key.clone(),
            owner,
            consumer,
        });
        drop(_g);
        self.refresh().await?;
        Ok(path(&key))
    }
    async fn menu_shown(&self, key: &str, id: u64, owner: &str) -> Result<(), Error> {
        let menu = self
            .state
            .read()
            .unwrap()
            .menu
            .clone()
            .ok_or_else(|| Error::NotFound("lease ended".into()))?;
        if menu.path != key {
            return Err(Error::NotFound("lease ended".into()));
        }
        if menu.owner != owner {
            return Err(Error::PermissionDenied("not menu owner".into()));
        }
        let (_, tx) = self
            .menu_wait
            .lock()
            .await
            .remove(&id)
            .filter(|(lease, _)| lease == key)
            .ok_or_else(|| Error::NotFound("request expired or obsolete".into()))?;
        let _ = tx.send(());
        Ok(())
    }
    async fn menu_release(&self, key: &str, owner: &str) -> Result<(), Error> {
        let menu = self
            .state
            .read()
            .unwrap()
            .menu
            .clone()
            .ok_or_else(|| Error::NotFound("lease ended".into()))?;
        if menu.path != key {
            return Err(Error::NotFound("lease ended".into()));
        }
        if menu.owner != owner {
            return Err(Error::PermissionDenied("not menu owner".into()));
        }
        self.state.write().unwrap().menu = None;
        self.menu_wait
            .lock()
            .await
            .retain(|_, (lease, _)| lease != key);
        self.refresh().await?;
        Ok(())
    }
    async fn failure(&self, action: &str, target: &str, error: &Error) {
        eprintln!("[power] {action}: {error}");
        {
            let _guard = self.updates.lock().await;
            let state = self.state.read().unwrap().clone();
            let mut root = state.root;
            root["LastError"] = json!(format!("{action}: {error}"));
            root["State"] = json!("Degraded");
            let _ = bus::publish(self, state.objects, root).await;
        }
        if action == "menu"
            && !self.read_only
            && let Ok(proxy) = Proxy::new(
                &self.conn,
                self.conn.unique_name().unwrap().as_str(),
                "/org/freedesktop/Notifications",
                "org.freedesktop.Notifications",
            )
            .await
        {
            let _: Result<u32, _> = proxy
                .call(
                    "Notify",
                    &(
                        "Nidara Power",
                        0u32,
                        "dialog-error-symbolic",
                        "Power menu unavailable",
                        "The registered power menu did not confirm presentation.",
                        Vec::<String>::new(),
                        HashMap::<String, OwnedValue>::new(),
                        10000i32,
                    ),
                )
                .await;
        }
        let _ = self
            .conn
            .emit_signal(
                None::<&str>,
                ROOT,
                "org.nidara.Power1",
                "ActionFailed",
                &(
                    action,
                    path(target),
                    zbus::DBusError::name(error).to_string(),
                    error.to_string(),
                ),
            )
            .await;
    }
    async fn persist(&self) {
        if self.read_only {
            return;
        }
        let _write = self.policy_write.lock().await;
        let policy = self.state.read().unwrap().policy.clone();
        let _ = tokio::task::spawn_blocking(move || {
            let file = policy_file();
            if let Some(parent) = file.parent() {
                std::fs::create_dir_all(parent)?;
            }
            use std::io::Write;
            use std::os::unix::fs::OpenOptionsExt;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .truncate(true)
                .write(true)
                .mode(0o600)
                .open(file.with_extension("next"))?;
            f.write_all(serde_json::to_string(&policy).unwrap().as_bytes())?;
            f.sync_all()?;
            std::fs::rename(file.with_extension("next"), file)
        })
        .await;
    }
    async fn notify(&self, device: &str, critical: bool, pct: Option<f64>) {
        if self.read_only {
            return;
        }
        let candidate = self
            .state
            .read()
            .unwrap()
            .notifications
            .get(device)
            .copied()
            .unwrap_or(0);
        // A dismissed ID may have been reused. Check the current server record and our
        // private correlation key before asking it to replace anything.
        let key = format!("{}:{}", self.epoch, device);
        let mut replaces = 0;
        if candidate > 0
            && let Ok(proxy) = Proxy::new(
                &self.conn,
                self.conn.unique_name().unwrap().as_str(),
                "/org/nidara/Notifications",
                "org.nidara.Notifications1",
            )
            .await
            && let Ok(records) = proxy.call::<_, _, String>("List", &()).await
            && let Ok(records) = serde_json::from_str::<Vec<Json>>(&records)
            && records.iter().any(|n| {
                n["id"] == candidate
                    && n["app_name"] == "Nidara Power"
                    && n["hints"]["x-nidara-power-key"] == key
            })
        {
            replaces = candidate;
        }
        let urgency = if critical { 2u8 } else { 1u8 };
        let title = if critical {
            "Battery critically low"
        } else {
            "Battery low"
        };
        let body = pct
            .map(|p| format!("{p:.0}% remaining"))
            .unwrap_or_else(|| "Low battery warning reported by the device".into());
        let hints = HashMap::<&str, OwnedValue>::from([
            ("urgency", urgency.into()),
            ("x-nidara-power-key", Value::from(key).try_into().unwrap()),
            ("desktop-entry", Value::from("nidara").try_into().unwrap()),
            (
                "x-nidara-power-device",
                Value::from(device.to_string()).try_into().unwrap(),
            ),
        ]);
        if let Ok(proxy) = Proxy::new(
            &self.conn,
            self.conn.unique_name().unwrap().as_str(),
            "/org/freedesktop/Notifications",
            "org.freedesktop.Notifications",
        )
        .await
        {
            let result: Result<u32, _> = proxy
                .call(
                    "Notify",
                    &(
                        "Nidara Power",
                        replaces,
                        "battery-low-symbolic",
                        title,
                        body,
                        Vec::<String>::new(),
                        hints,
                        if critical { 0i32 } else { 10000 },
                    ),
                )
                .await;
            if let Ok(id) = result {
                self.state
                    .write()
                    .unwrap()
                    .notifications
                    .insert(device.into(), id);
            }
        }
    }
    async fn effects(&self, effects: Vec<Effect>) {
        if self.read_only {
            return;
        }
        for effect in effects {
            match effect {
                Effect::HoldSaver => {
                    if let Err(e) = self
                        .hold(
                            self.conn.unique_name().unwrap().to_string(),
                            "power-saver".into(),
                            "Low battery".into(),
                            "org.nidara.Session".into(),
                            true,
                        )
                        .await
                    {
                        self.state.write().unwrap().policy.hold_failed();
                        self.failure("automatic-saver", ROOT, &e).await;
                    }
                }
                Effect::ReleaseSaver => {
                    let keys = self
                        .state
                        .read()
                        .unwrap()
                        .holds
                        .values()
                        .filter(|h| h.automatic)
                        .map(|h| h.path.clone())
                        .collect::<Vec<_>>();
                    for k in keys {
                        let _ = self.release(&k, None).await;
                    }
                }
                Effect::Hook(p) => {
                    let _ = tokio::process::Command::new("nidara-hook")
                        .args(["battery-low", &p.to_string()])
                        .kill_on_drop(false)
                        .spawn();
                }
                Effect::Low | Effect::Critical => {
                    let critical = matches!(effect, Effect::Critical);
                    let state = self.state.read().unwrap().clone();
                    let device = state.root["DisplayDevice"].as_str().unwrap_or("/");
                    self.notify(device, critical, state.battery.percentage)
                        .await;
                    let _ = self
                        .conn
                        .emit_signal(
                            None::<&str>,
                            ROOT,
                            "org.nidara.Power1",
                            "BatteryAlert",
                            &(
                                path(device),
                                if critical { "critical" } else { "low" },
                                state.battery.percentage.unwrap_or(-1.0),
                                state.policy.episode,
                            ),
                        )
                        .await;
                }
            }
        }
        self.persist().await;
    }
    fn refresh(
        &self,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), Error>> + Send + '_>> {
        Box::pin(provider::refresh(self))
    }
}
fn policy_file() -> std::path::PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .map(std::path::PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| glib::home_dir().join(".local/state"))
        .join("nidara/power-policy.json")
}
pub async fn serve(conn: &Connection, read_only: bool) -> zbus::Result<()> {
    let system = Arc::new(RwLock::new(None));
    let policy = std::fs::read_to_string(policy_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Policy>(&s).ok())
        .unwrap_or_default();
    let power = Power {
        conn: conn.clone(),
        system,
        state: Arc::new(RwLock::new(State {
            policy,
            ..Default::default()
        })),
        prefs: Arc::new(RwLock::new(Preferences::default())),
        updates: Default::default(),
        announced: Default::default(),
        read_only,
        epoch: now(),
        serial: Arc::new(AtomicU64::new(1)),
        key_fd: Default::default(),
        lid_fd: Default::default(),
        policy_write: Default::default(),
        keyboard_write: Default::default(),
        keyboard_serial: Arc::new(AtomicU64::new(0)),
        menu_wait: Default::default(),
    };
    power.state.write().unwrap().root =
        json!({"State":"Unavailable","Generation":power.epoch,"LastError":"","Capabilities":[]});
    conn.object_server()
        .at(ROOT, zbus::fdo::ObjectManager)
        .await?;
    conn.object_server()
        .at(ROOT, bus::Root(power.clone()))
        .await?;
    prefs::watch(power.clone());
    provider::watch(power).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
