// SPDX-License-Identifier: GPL-3.0-or-later
//! Opt-in SNI watcher and bounded model. The Rust host owns presentation/focus.
mod bus;
mod menu;
mod model;
use futures_util::StreamExt;
use model::{FIELDS, Item};
use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::sync::{Mutex, Semaphore};
use zbus::{
    Connection, Proxy,
    message::Header,
    zvariant::{OwnedObjectPath as Path, OwnedValue, Value},
};
const ROOT: &str = "/org/nidara/Tray";
const WATCH_PATH: &str = "/StatusNotifierWatcher";
const WATCH_NAMES: [&str; 2] = [
    "org.kde.StatusNotifierWatcher",
    "org.freedesktop.StatusNotifierWatcher",
];
const ITEM_IFACES: [&str; 2] = [
    "org.kde.StatusNotifierItem",
    "org.freedesktop.StatusNotifierItem",
];
type Props = HashMap<String, OwnedValue>;
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.Tray1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    Unavailable(String),
    InvalidArgument(String),
    NotFound(String),
    Stale(String),
    Busy(String),
    Timeout(String),
    Failed(String),
    Denied(String),
}
impl From<zbus::fdo::Error> for Error {
    fn from(e: zbus::fdo::Error) -> Self {
        Self::Failed(e.to_string())
    }
}
fn val<T: Into<Value<'static>>>(v: T) -> OwnedValue {
    v.into().try_into().expect("D-Bus value")
}
fn text(p: &Props, k: &str) -> String {
    p.get(k)
        .and_then(|v| {
            <&str>::try_from(v).ok().map(str::to_owned).or_else(|| {
                v.try_clone()
                    .ok()
                    .and_then(|v| Path::try_from(v).ok())
                    .map(|p| p.to_string())
            })
        })
        .unwrap_or_default()
}
fn sender(h: &Header<'_>) -> Result<String, Error> {
    h.sender()
        .map(|s| s.to_string())
        .ok_or_else(|| Error::Denied("missing unique sender".into()))
}
async fn deadline<T>(f: impl std::future::Future<Output = zbus::Result<T>>) -> Result<T, Error> {
    tokio::time::timeout(Duration::from_secs(2), f)
        .await
        .map_err(|_| Error::Timeout("tray application did not answer within 2s".into()))?
        .map_err(Error::from)
}
struct State {
    available: bool,
    reason: String,
    revision: u64,
    serial: u64,
    items: BTreeMap<String, Item>,
    hosts: BTreeSet<String>,
    pending: BTreeMap<String, BTreeSet<String>>,
    busy: BTreeSet<String>,
    menus: BTreeMap<String, menu::Session>,
}
impl Default for State {
    fn default() -> Self {
        Self {
            available: false,
            reason: "watcher not acquired".into(),
            revision: 0,
            serial: 0,
            items: Default::default(),
            hosts: Default::default(),
            pending: Default::default(),
            busy: Default::default(),
            menus: Default::default(),
        }
    }
}
impl State {
    fn next(&mut self) -> u64 {
        self.serial = self.serial.checked_add(1).expect("tray serial exhausted");
        self.serial
    }
}
#[derive(Clone)]
struct Tray {
    conn: Connection,
    state: Arc<RwLock<State>>,
    publish: Arc<Mutex<()>>,
    calls: Arc<Semaphore>,
    registrations: Arc<Mutex<()>>,
    registration_workers: Arc<Semaphore>,
    registration_queue: Arc<Semaphore>,
}
impl Tray {
    fn item(&self, handle: &str, generation: u64) -> Result<Item, Error> {
        let s = self.state.read().unwrap();
        if !s.available {
            return Err(Error::Unavailable(s.reason.clone()));
        }
        s.items
            .get(handle)
            .filter(|i| i.generation == generation && i.ready)
            .cloned()
            .ok_or_else(|| Error::Stale("item generation is no longer current".into()))
    }
    fn slot(&self) -> Result<tokio::sync::OwnedSemaphorePermit, Error> {
        self.calls
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy("tray call limit".into()))
    }
    async fn changed(&self) {
        let _order = self.publish.lock().await;
        let (revision, retired) = {
            let mut s = self.state.write().unwrap();
            let retired = s
                .menus
                .iter()
                .filter(|(_, m)| {
                    !s.items.get(&m.handle).is_some_and(|i| {
                        i.generation == m.generation
                            && i.menu_path().as_deref() == Some(m.path.as_str())
                    })
                })
                .map(|(t, m)| (t.clone(), m.caller.clone()))
                .collect::<Vec<_>>();
            for (t, _) in &retired {
                s.menus.remove(t);
            }
            s.revision += 1;
            (s.revision, retired)
        };
        for (token, caller) in retired {
            self.menu_signal(&caller, "MenuClosed", &(token,)).await;
        }
        let _ = self
            .conn
            .emit_signal(
                None::<&str>,
                ROOT,
                "org.nidara.Tray1",
                "Changed",
                &(revision,),
            )
            .await;
        // Invalidate cached properties as well as the revisioned snapshot.
        let _ = self
            .conn
            .emit_signal(
                None::<&str>,
                ROOT,
                "org.freedesktop.DBus.Properties",
                "PropertiesChanged",
                &(
                    "org.nidara.Tray1",
                    Props::new(),
                    vec!["Revision", "Items", "Available", "UnavailableReason"],
                ),
            )
            .await;
    }
    async fn watcher_signal(&self, name: &str, service: Option<&str>) {
        let e =
            zbus::object_server::SignalEmitter::new(&self.conn, WATCH_PATH).expect("watcher path");
        macro_rules! emit {
            ($trait:ident) => {
                match (name, service) {
                    ("StatusNotifierItemRegistered", Some(s)) => {
                        let _ = bus::$trait::status_notifier_item_registered(&e, s).await;
                    }
                    ("StatusNotifierItemUnregistered", Some(s)) => {
                        let _ = bus::$trait::status_notifier_item_unregistered(&e, s).await;
                    }
                    ("StatusNotifierHostRegistered", _) => {
                        let _ = bus::$trait::status_notifier_host_registered(&e).await;
                    }
                    ("StatusNotifierHostUnregistered", _) => {
                        let _ = bus::$trait::status_notifier_host_unregistered(&e).await;
                    }
                    _ => unreachable!("internal watcher signal"),
                }
            };
        }
        emit!(KdeWatcherSignals);
        emit!(FreedesktopWatcherSignals);
        for iface in WATCH_NAMES {
            let invalidated = if name.starts_with("StatusNotifierItem") {
                "RegisteredStatusNotifierItems"
            } else {
                "IsStatusNotifierHostRegistered"
            };
            let _ = self
                .conn
                .emit_signal(
                    None::<&str>,
                    WATCH_PATH,
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                    &(iface, Props::new(), vec![invalidated]),
                )
                .await;
        }
    }
    async fn resolve(
        &self,
        service: &str,
        caller: &str,
    ) -> Result<(String, String, String), Error> {
        let (name, path) = if service.starts_with('/') {
            (caller, "/StatusNotifierItem")
        } else {
            (service, "/StatusNotifierItem")
        };
        let path = if service.starts_with('/') {
            service
        } else {
            path
        };
        Path::try_from(path).map_err(|_| Error::InvalidArgument("item object path".into()))?;
        let dbus = zbus::fdo::DBusProxy::new(&self.conn).await?;
        let name = zbus::names::BusName::try_from(name)
            .map_err(|_| Error::InvalidArgument("bus name".into()))?;
        let owner = dbus.get_name_owner(name.clone()).await?;
        if owner.as_str() != caller {
            return Err(Error::Denied(
                "registration must belong to its sender".into(),
            ));
        }
        Ok((owner.to_string(), path.into(), name.to_string()))
    }
    async fn register_item(&self, service: &str, caller: &str) -> Result<(), Error> {
        // Registration bursts must wait, not lose icons until the next watcher
        // restart. Separate admission/hydration from interactive action slots.
        let _queued = self
            .registration_queue
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Busy("registration admission quota".into()))?;
        let _worker = self
            .registration_workers
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| Error::Failed("registration workers stopped".into()))?;
        let lock = self.registrations.lock().await;
        let (owner, path, name) = self.resolve(service, caller).await?;
        let key = format!("{owner}{path}");
        {
            let mut s = self.state.write().unwrap();
            if !s.available {
                return Err(Error::Unavailable(s.reason.clone()));
            }
            if s.items.contains_key(&key) {
                return Ok(());
            }
            if s.items.len() >= model::MAX_ITEMS
                || s.items.values().filter(|i| i.owner == owner).count() >= model::MAX_PER_OWNER
            {
                return Err(Error::Busy("item quota".into()));
            }
            let generation = s.next();
            s.items.insert(
                key.clone(),
                Item {
                    handle: key.clone(),
                    generation,
                    owner: owner.clone(),
                    path: path.clone(),
                    interface: String::new(),
                    registration: format!("{owner}{path}"),
                    watched_name: name.clone(),
                    pid: 0,
                    ready: false,
                    version: 0,
                    field_versions: Default::default(),
                    props: Default::default(),
                    icons: Default::default(),
                },
            );
        }
        drop(lock); // The ready=false reservation protects hydration outside the mutex.
        let result = async {
            let dbus = zbus::fdo::DBusProxy::new(&self.conn).await?;
            let pid = dbus
                .get_connection_unix_process_id(
                    zbus::names::BusName::try_from(owner.as_str()).unwrap(),
                )
                .await?;
            let mut last = None;
            for iface in ITEM_IFACES {
                let props = Proxy::new(
                    &self.conn,
                    owner.as_str(),
                    path.as_str(),
                    "org.freedesktop.DBus.Properties",
                )
                .await?;
                match deadline(props.call::<_, _, Props>("GetAll", &(iface,))).await {
                    Ok(p) if !p.is_empty() => return Ok((pid, iface.to_string(), p)),
                    Ok(_) => {}
                    Err(e) => last = Some(e),
                }
            }
            Err(last.unwrap_or_else(|| Error::Failed("SNI properties absent".into())))
        }
        .await;
        match result {
            Ok((pid, interface, props)) => {
                // Registration resolves only to this connection; if it vanished while
                // reading, owner-loss processing has already retired the reservation.
                let registered = {
                    let mut s = self.state.write().unwrap();
                    let other = s
                        .items
                        .iter()
                        .filter(|(k, _)| *k != &key)
                        .map(|(_, i)| i.bytes())
                        .sum();
                    if let Some(i) = s.items.get_mut(&key) {
                        i.pid = pid;
                        i.interface = interface;
                        let signals = std::mem::take(&mut i.props);
                        let icons = std::mem::take(&mut i.icons);
                        i.apply(props, other);
                        i.props.extend(signals);
                        i.apply(icons.into_iter().map(|(k, v)| (k, val(v))).collect(), other);
                        i.ready = true;
                        Some(i.registration.clone())
                    } else {
                        None
                    }
                };
                if let Some(r) = registered {
                    self.watcher_signal("StatusNotifierItemRegistered", Some(&r))
                        .await;
                    self.changed().await;
                }
                Ok(())
            }
            Err(e) => {
                self.state.write().unwrap().items.remove(&key);
                Err(e)
            }
        }
    }
    async fn host(&self, caller: &str, add: bool) -> Result<(), Error> {
        let changed = {
            let mut s = self.state.write().unwrap();
            if !s.available {
                return Err(Error::Unavailable(s.reason.clone()));
            }
            if add {
                if s.hosts.len() >= 64 && !s.hosts.contains(caller) {
                    return Err(Error::Busy("host quota".into()));
                }
                s.hosts.insert(caller.to_string())
            } else {
                s.menus.retain(|_, m| m.caller != caller);
                s.hosts.remove(caller)
            }
        };
        if changed {
            self.watcher_signal(
                if add {
                    "StatusNotifierHostRegistered"
                } else {
                    "StatusNotifierHostUnregistered"
                },
                None,
            )
            .await;
            self.changed().await;
        }
        Ok(())
    }
    async fn departed(&self, name: &str, owner: &str) {
        let (items, menus, host) = {
            let mut s = self.state.write().unwrap();
            let keys = s
                .items
                .iter()
                .filter(|(_, i)| i.owner == owner && (name == owner || i.watched_name == name))
                .map(|(k, _)| k.clone())
                .collect::<Vec<_>>();
            let mut items = vec![];
            for k in &keys {
                if let Some(i) = s.items.remove(k)
                    && i.ready
                {
                    items.push(i.registration);
                }
                s.pending.remove(k);
                s.busy.remove(k);
            }
            let tokens = s
                .menus
                .iter()
                .filter(|(_, m)| keys.contains(&m.handle) || (name == owner && m.caller == owner))
                .map(|(k, m)| (k.clone(), m.caller.clone()))
                .collect::<Vec<_>>();
            for (k, _) in &tokens {
                s.menus.remove(k);
            }
            let host = name == owner && s.hosts.remove(owner);
            (items, tokens, host)
        };
        for (token, caller) in menus {
            self.menu_signal(&caller, "MenuClosed", &(token,)).await;
        }
        for i in &items {
            self.watcher_signal("StatusNotifierItemUnregistered", Some(i))
                .await;
        }
        if host {
            self.watcher_signal("StatusNotifierHostUnregistered", None)
                .await;
        }
        if host || !items.is_empty() {
            self.changed().await;
        }
    }
    async fn action(
        &self,
        handle: &str,
        generation: u64,
        method: &str,
        x: i32,
        y: i32,
    ) -> Result<(), Error> {
        let _slot = self.slot()?;
        let i = self.item(handle, generation)?;
        let p = Proxy::new(
            &self.conn,
            i.owner.as_str(),
            i.path.as_str(),
            i.interface.as_str(),
        )
        .await?;
        deadline(p.call::<_, _, ()>(method, &(x, y))).await?;
        self.item(handle, generation)?;
        Ok(())
    }
    async fn refresh(&self, handle: String, fields: BTreeSet<String>) {
        let item = self.state.read().unwrap().items.get(&handle).cloned();
        if let Some(i) = item {
            let result = tokio::time::timeout(Duration::from_secs(2), async {
                let p = Proxy::new(
                    &self.conn,
                    i.owner.as_str(),
                    i.path.as_str(),
                    "org.freedesktop.DBus.Properties",
                )
                .await?;
                // Electron variants may implement GetAll but reject individual
                // Get. A failed RPC preserves the old values; only an absent
                // field in a successful snapshot returns to its typed default.
                let mut all = p
                    .call::<_, _, Props>("GetAll", &(i.interface.as_str(),))
                    .await?;
                let data = fields
                    .iter()
                    .map(|field| {
                        (
                            field.clone(),
                            all.remove(field)
                                .unwrap_or_else(|| model::property_default(field)),
                        )
                    })
                    .collect::<Props>();
                Ok::<_, zbus::Error>(data)
            })
            .await;
            if let Ok(Ok(props)) = result {
                let updated = {
                    let mut s = self.state.write().unwrap();
                    let other = s
                        .items
                        .iter()
                        .filter(|(k, _)| *k != &handle)
                        .map(|(_, i)| i.bytes())
                        .sum();
                    if let Some(live) = s
                        .items
                        .get_mut(&handle)
                        .filter(|l| l.generation == i.generation)
                    {
                        let props = props
                            .into_iter()
                            .filter(|(key, _)| {
                                live.field_versions.get(key) == i.field_versions.get(key)
                            })
                            .collect::<Props>();
                        let updated = !props.is_empty();
                        live.apply(props, other);
                        updated
                    } else {
                        false
                    }
                };
                if updated {
                    self.changed().await;
                }
            }
        }
        self.state.write().unwrap().busy.remove(&handle);
    }
}
fn signal_rules() -> zbus::Result<Vec<zbus::MatchRule<'static>>> {
    let mut rules = Vec::new();
    for iface in ITEM_IFACES {
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface(iface)?
            .build();
        rules.push(rule);
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.DBus.Properties")?
            .member("PropertiesChanged")?
            .arg(0, iface)?
            .build();
        rules.push(rule);
    }
    for member in ["LayoutUpdated", "ItemsPropertiesUpdated"] {
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("com.canonical.dbusmenu")?
            .member(member)?
            .build();
        rules.push(rule);
    }
    Ok(rules)
}
pub async fn serve(conn: &Connection) -> zbus::Result<()> {
    let tray = Tray {
        conn: conn.clone(),
        state: Default::default(),
        publish: Default::default(),
        calls: Arc::new(Semaphore::new(8)),
        registrations: Default::default(),
        registration_workers: Arc::new(Semaphore::new(8)),
        registration_queue: Arc::new(Semaphore::new(model::MAX_ITEMS)),
    };
    conn.object_server()
        .at(ROOT, bus::Root(tray.clone()))
        .await?;
    let dbus = zbus::fdo::DBusProxy::new(conn).await?;
    let mut owners = dbus.receive_name_owner_changed().await?;
    // Match at the bus, before any registration/snapshot. Unrelated apps'
    // signals must not wake this service or cause a refresh storm on overflow.
    let mut events = futures_util::stream::SelectAll::new();
    for rule in signal_rules()? {
        events.push(zbus::MessageStream::for_match_rule(rule, conn, Some(256)).await?);
    }
    // Applications react to NameOwnerChanged immediately. Export first and
    // hold registration calls until both names and subscriptions are ready.
    let startup = tray.registrations.lock().await;
    conn.object_server()
        .at(WATCH_PATH, bus::KdeWatcher(tray.clone()))
        .await?;
    conn.object_server()
        .at(WATCH_PATH, bus::FreedesktopWatcher(tray.clone()))
        .await?;
    let mut acquired = Vec::new();
    for name in WATCH_NAMES {
        match conn
            .request_name_with_flags(name, zbus::fdo::RequestNameFlags::DoNotQueue.into())
            .await
        {
            Ok(zbus::fdo::RequestNameReply::PrimaryOwner) => acquired.push(name),
            result => {
                for n in acquired {
                    let _ = conn.release_name(n).await;
                }
                tray.state.write().unwrap().reason =
                    format!("watcher name {name} unavailable: {result:?}");
                tray.changed().await;
                return Ok(());
            }
        }
    }
    {
        let mut s = tray.state.write().unwrap();
        s.available = true;
        s.reason.clear();
    }
    drop(startup);
    let observed = tray.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(event)=owners.next()=> {
                    if let Ok(a)=event.args() && let Some(old)=a.old_owner().as_ref() {
                        observed.departed(a.name().as_str(),old.as_str()).await;
                    }
                }
                Some(message)=events.next()=> {
                    let Ok(msg)=message else {
                        let mut s=observed.state.write().unwrap();
                        let keys=s.items.keys().cloned().collect::<Vec<_>>();
                        for k in keys {s.pending.entry(k).or_default().extend(FIELDS.iter().map(|f|f.to_string()));}
                        continue;
                    };
                    let h=msg.header();
                    let (Some(owner),Some(path),Some(iface),Some(member))=(h.sender(),h.path(),h.interface(),h.member()) else {continue};
                    let iface=iface.as_str();let member=member.as_str();
                    if iface=="com.canonical.dbusmenu" {
                        if matches!(member,"LayoutUpdated"|"ItemsPropertiesUpdated") {
                            observed.invalidate_menus(owner.as_str(),path.as_str()).await;
                        }
                        continue;
                    }
                    let mut fields=BTreeSet::new();
                    let mut inline=Props::new();
                    if ITEM_IFACES.contains(&iface) {
                        fields.extend(model::fields(member).iter().map(|s|s.to_string()));
                        if member=="NewStatus" && let Ok((status,))=msg.body().deserialize::<(String,)>() {
                            fields.remove("Status");inline.insert("Status".into(),val(status));
                        }
                        if member=="XAyatanaNewLabel" && let Ok((label,guide))=msg.body().deserialize::<(String,String)>() {
                            fields.clear();inline.insert("XAyatanaLabel".into(),val(label));inline.insert("XAyatanaLabelGuide".into(),val(guide));
                        }
                    }
                    if iface=="org.freedesktop.DBus.Properties" && member=="PropertiesChanged"
                        && let Ok((item_iface,changed,invalidated))=msg.body().deserialize::<(String,Props,Vec<String>)>()
                        && ITEM_IFACES.contains(&item_iface.as_str()) {
                        inline.extend(changed.into_iter().filter(|(k,_)|FIELDS.contains(&k.as_str())));
                        fields.extend(invalidated.into_iter().filter(|s|FIELDS.contains(&s.as_str())));
                    }
                    if fields.is_empty() && inline.is_empty() {continue;}
                    let updated={
                        let mut s=observed.state.write().unwrap();
                        let keys=s.items.iter().filter(|(_,i)|i.owner==owner.as_str() && i.path==path.as_str())
                            .map(|(k,_)|k.clone()).collect::<Vec<_>>();
                        let mut updated=false;
                        for k in keys {
                            let other=s.items.iter().filter(|(key,_)|**key!=k).map(|(_,i)|i.bytes()).sum();
                            if let Some(i)=s.items.get_mut(&k) {
                                i.version+=1;
                                for field in inline.keys().chain(fields.iter()) {i.field_versions.insert(field.clone(),i.version);}
                                i.apply(inline.clone(),other);updated|=i.ready && !inline.is_empty();
                            }
                            if let Some(pending)=s.pending.get_mut(&k) {for field in inline.keys() {pending.remove(field);}}
                            if !fields.is_empty() {s.pending.entry(k).or_default().extend(fields.clone());}
                        }
                        updated
                    };
                    if updated {observed.changed().await;}

                }
                else=>break,
            }
        }
    });
    let worker = tray.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(25));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            loop {
                let Ok(slot) = worker.slot() else { break };
                let job = {
                    let mut s = worker.state.write().unwrap();
                    let k = s
                        .pending
                        .keys()
                        .find(|k| !s.busy.contains(*k) && s.items.get(*k).is_some_and(|i| i.ready))
                        .cloned();
                    k.map(|k| {
                        let fields = s.pending.remove(&k).unwrap();
                        s.busy.insert(k.clone());
                        (k, fields)
                    })
                };
                let Some((k, fields)) = job else { break };
                let t = worker.clone();
                tokio::spawn(async move {
                    let _slot = slot;
                    t.refresh(k, fields).await;
                });
            }
        }
    });
    tray.changed().await;
    Ok(())
}
#[cfg(test)]
mod tests;
