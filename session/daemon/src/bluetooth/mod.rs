// SPDX-License-Identifier: GPL-3.0-or-later
//! Bluetooth1 is opt-in, independent of the TS shell and never enabled beside it.
mod agent;
mod bus;
mod files;
use agent::Broker;
use bus::{Objects, Peer, Props, flag, number, text};
use serde_json::{Value as Json, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use zbus::{
    Connection,
    message::Header,
    zvariant::{OwnedObjectPath as Path, Value},
};
const NAME: &str = "org.nidara.Bluetooth";
const PATH: &str = "/org/nidara/Bluetooth";
const IFACE: &str = "org.nidara.Bluetooth1";
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.Bluetooth1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    Unavailable(String),
    Denied(String),
    Invalid(String),
    NotFound(String),
    Busy(String),
    Conflict(String),
    Cancelled(String),
    TimedOut(String),
    Incomplete(String),
    NoSpace(String),
    Failed(String),
}
impl From<zbus::fdo::Error> for Error {
    fn from(_: zbus::fdo::Error) -> Self {
        Self::Failed("bus operation failed".into())
    }
}
#[derive(Default)]
struct Registration {
    bluez: String,
    default: String,
    obex: String,
}
struct Published {
    owners: (String, String),
    revision: u64,
    json: String,
    last: tokio::time::Instant,
}
struct Hold {
    client: String,
    adapter: String,
    visible: bool,
}
struct Visibility {
    owned: bool,
    renewed: tokio::time::Instant,
}
#[derive(Default)]
struct Leases {
    holds: BTreeMap<u64, Hold>,
    visibility: BTreeMap<String, Visibility>,
    discovery: BTreeSet<String>,
}
struct Transfer {
    id: u64,
    epoch: u64,
    peer: Peer,
    path: Path,
    session: Path,
    device: String,
    address: String,
    name: String,
    size: Option<u64>,
    transferred: Option<u64>,
    status: String,
    error: Option<String>,
    published: Option<String>,
    incoming: Option<Arc<files::Incoming>>,
    creator: String,
    session_removed: bool,
}
impl Transfer {
    fn active(&self) -> bool {
        matches!(
            self.status.as_str(),
            "queued" | "active" | "suspended" | "finalizing" | "cancel-pending"
        )
    }
    fn snapshot(&self) -> Json {
        json!({"id":self.id,"epoch":self.epoch,"direction":if self.creator.is_empty(){"incoming"}else{"outgoing"},"device":self.device,"address":self.address,"name":self.name,"size":self.size,"transferred":self.transferred,"status":self.status,"error":self.error,"publishedName":self.published})
    }
}
#[derive(Clone)]
pub struct Bluetooth {
    system: Connection,
    session: Connection,
    read_only: bool,
    epoch: Arc<AtomicU64>,
    next: Arc<AtomicU64>,
    broker: Broker,
    state: Arc<Mutex<Published>>,
    refreshing: Arc<Mutex<()>>,
    registration: Arc<Mutex<Registration>>,
    leases: Arc<Mutex<Leases>>,
    transfers: Arc<Mutex<BTreeMap<u64, Transfer>>>,
    operations: Arc<std::sync::Mutex<BTreeSet<String>>>,
    space: Arc<dyn files::Space>,
    obex_cache: Arc<Mutex<BTreeMap<String, Props>>>,
}
struct DeviceGuard {
    operations: Arc<std::sync::Mutex<BTreeSet<String>>>,
    device: String,
}
impl Drop for DeviceGuard {
    fn drop(&mut self) {
        self.operations.lock().unwrap().remove(&self.device);
    }
}
fn sender(h: &Header<'_>) -> Result<String, Error> {
    h.sender()
        .map(|s| s.to_string())
        .ok_or_else(|| Error::Denied("missing sender".into()))
}
impl Bluetooth {
    fn new(
        system: Connection,
        session: Connection,
        read_only: bool,
        space: Arc<dyn files::Space>,
    ) -> Self {
        let epoch = Arc::new(AtomicU64::new(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos() as u64,
        ));
        Self {
            system: system.clone(),
            session: session.clone(),
            read_only,
            broker: Broker::new(session.clone(), epoch.clone()),
            epoch: epoch.clone(),
            next: Arc::new(AtomicU64::new(epoch.load(Ordering::SeqCst))),
            state: Arc::new(Mutex::new(Published {
                owners: (String::new(), String::new()),
                revision: 0,
                json: "{}".into(),
                last: tokio::time::Instant::now() - Duration::from_secs(1),
            })),
            refreshing: Arc::new(Mutex::new(())),
            registration: Arc::new(Mutex::new(Registration::default())),
            leases: Arc::new(Mutex::new(Leases::default())),
            transfers: Arc::new(Mutex::new(BTreeMap::new())),
            operations: Arc::new(std::sync::Mutex::new(BTreeSet::new())),
            space,
            obex_cache: Arc::new(Mutex::new(BTreeMap::new())),
        }
    }
    fn writable(&self) -> Result<(), Error> {
        if self.read_only {
            Err(Error::Denied("read-only Bluetooth service".into()))
        } else {
            Ok(())
        }
    }
    fn operation(&self, device: &str) -> Result<DeviceGuard, Error> {
        let mut ops = self.operations.lock().unwrap();
        if !ops.insert(device.into()) {
            return Err(Error::Busy("device operation in progress".into()));
        }
        Ok(DeviceGuard {
            operations: self.operations.clone(),
            device: device.into(),
        })
    }
    async fn bluez(&self, write: bool) -> Result<Peer, Error> {
        if write {
            self.writable()?;
        }
        let peer = Peer::current(&self.system, bus::BLUEZ).await?;
        if write && self.state.lock().await.owners.0 != peer.owner {
            return Err(Error::Conflict(
                "provider changed; rehydrate before retrying".into(),
            ));
        }
        Ok(peer)
    }
    async fn device(&self, write: bool, path: &str) -> Result<(Peer, Props), Error> {
        let p = self.bluez(write).await?;
        let objects = p.objects("/").await?;
        let props = bus::object(&objects, path, bus::DEVICE)?.clone();
        Ok((p, props))
    }
    async fn adapter(&self, write: bool, path: &str) -> Result<(Peer, Props), Error> {
        let p = self.bluez(write).await?;
        let objects = p.objects("/").await?;
        let props = bus::object(&objects, path, bus::ADAPTER)?.clone();
        Ok((p, props))
    }
    async fn refresh(&self, immediate: bool) -> Result<(), Error> {
        let _serial = self.refreshing.lock().await;
        let bluez = self.bluez(false).await.ok();
        let obex = Peer::current(&self.session, bus::OBEX).await.ok();
        let owners = (
            bluez.as_ref().map(|p| p.owner.clone()).unwrap_or_default(),
            obex.as_ref().map(|p| p.owner.clone()).unwrap_or_default(),
        );
        let previous = self.state.lock().await.owners.clone();
        let changed = previous != owners;
        if changed {
            let epoch = self.epoch.fetch_add(1, Ordering::SeqCst) + 1;
            self.broker.withdraw(None, "provider-restarted").await;
            if previous.0 != owners.0 {
                let mut leases = self.leases.lock().await;
                leases.holds.clear();
                leases.visibility.clear();
                leases.discovery.clear();
            }
            if previous.1 != owners.1 {
                self.obex_cache.lock().await.clear();
            }
            for transfer in self.transfers.lock().await.values_mut() {
                if transfer.active() {
                    if previous.1 != owners.1 && transfer.status != "finalizing" {
                        transfer.status = "error".into();
                        transfer.error = Some("provider-restarted".into());
                        transfer.incoming.take();
                    } else {
                        transfer.epoch = epoch;
                    }
                }
            }
            let mut s = self.state.lock().await;
            s.owners = owners.clone();
            s.revision += 1;
            s.json=json!({"schemaVersion":1,"available":false,"obexAvailable":false,"pairAgentRegistered":false,"defaultAgent":false,"receiveAgentRegistered":false,"fileReceptionPolicy":{"scope":"opp-only","deploymentStatus":"unverified","advertisedUnsupportedServers":[]},"adapters":[],"devices":[],"transfers":[]}).to_string();
            self.emit(&s).await?;
        }
        let objects = if let Some(p) = &bluez {
            p.objects("/").await?
        } else {
            Objects::new()
        };
        // Reject assemblies spanning a unique-owner replacement.
        let current = self
            .bluez(false)
            .await
            .ok()
            .map(|p| p.owner)
            .unwrap_or_default();
        if current != owners.0 {
            return Ok(());
        }
        self.broker.check_devices(&objects).await;
        let registration = self.registration.lock().await;
        let mut adapters = Vec::new();
        let mut advertised_file_servers = Vec::new();
        let mut devices = Vec::new();
        for (path, interfaces) in &objects {
            if let Some(p) = interfaces.get(bus::ADAPTER) {
                for uuid in bus::strings(p, "UUIDs") {
                    if let Some(profile) = bus::advertised_file_service(&uuid) {
                        advertised_file_servers
                            .push(json!({"adapter":path,"uuid":uuid,"profile":profile}));
                    }
                }

                adapters.push(json!({"path":path.as_str(),"address":text(p,"Address"),"name":text(p,"Name"),"alias":text(p,"Alias"),"powered":flag(p,"Powered"),"discovering":flag(p,"Discovering"),"discoverable":flag(p,"Discoverable"),"discoverableTimeout":number(p,"DiscoverableTimeout"),"pairable":flag(p,"Pairable"),"uuids":bus::strings(p,"UUIDs")}));
            }
            if let Some(p) = interfaces.get(bus::DEVICE) {
                let battery = interfaces
                    .get(bus::BATTERY)
                    .and_then(|p| number(p, "Percentage"))
                    .filter(|v| *v <= 100);
                let rssi = p.get("RSSI").and_then(|v| i16::try_from(v).ok());
                devices.push(json!({"path":path.as_str(),"adapter":text(p,"Adapter"),"address":text(p,"Address"),"addressType":text(p,"AddressType"),"name":text(p,"Name"),"alias":text(p,"Alias"),"icon":text(p,"Icon"),"paired":flag(p,"Paired"),"trusted":flag(p,"Trusted"),"blocked":flag(p,"Blocked"),"connected":flag(p,"Connected"),"servicesResolved":flag(p,"ServicesResolved"),"uuids":bus::strings(p,"UUIDs"),"rssi":rssi,"batteryPercent":battery}));
            }
        }
        let transfers: Vec<_> = self
            .transfers
            .lock()
            .await
            .values()
            .map(Transfer::snapshot)
            .collect();
        let doc=json!({"schemaVersion":1,"available":bluez.is_some(),"obexAvailable":obex.is_some(),"pairAgentRegistered":!owners.0.is_empty()&&registration.bluez==owners.0,"defaultAgent":!owners.0.is_empty()&&registration.default==owners.0,"receiveAgentRegistered":!owners.1.is_empty()&&registration.obex==owners.1,"fileReceptionPolicy":{"scope":"opp-only","deploymentStatus":if advertised_file_servers.is_empty(){"unverified"}else{"unsupported-server-advertised"},"advertisedUnsupportedServers":advertised_file_servers},"adapters":adapters,"devices":devices,"transfers":transfers}).to_string();
        drop(registration);
        let mut s = self.state.lock().await;
        if s.json != doc && (immediate || changed || s.last.elapsed() >= Duration::from_millis(250))
        {
            s.json = doc;
            s.revision += 1;
            s.last = tokio::time::Instant::now();
            self.emit(&s).await?;
        }
        Ok(())
    }
    async fn publish_transfers(&self) -> Result<(), Error> {
        let transfers: Vec<_> = self
            .transfers
            .lock()
            .await
            .values()
            .map(Transfer::snapshot)
            .collect();
        let mut state = self.state.lock().await;
        let mut doc: Json = serde_json::from_str(&state.json)
            .map_err(|_| Error::Failed("snapshot unavailable".into()))?;
        doc["transfers"] = json!(transfers);
        let doc = doc.to_string();
        if doc != state.json {
            state.json = doc;
            state.revision += 1;
            state.last = tokio::time::Instant::now();
            self.emit(&state).await?;
        }
        Ok(())
    }
    async fn emit(&self, state: &Published) -> Result<(), Error> {
        self.session
            .emit_signal(
                None::<&str>,
                PATH,
                IFACE,
                "Updated",
                &(
                    self.epoch.load(Ordering::SeqCst),
                    state.revision,
                    &state.json,
                ),
            )
            .await?;
        Ok(())
    }
    async fn register_agents(&self) {
        if self.read_only {
            return;
        }
        if let Ok(p) = self.bluez(false).await {
            if self.registration.lock().await.bluez != p.owner {
                let path = Path::try_from(agent::BLUEZ_PATH).unwrap();
                if p.call::<()>(
                    "/org/bluez",
                    "org.bluez.AgentManager1",
                    "RegisterAgent",
                    &(path, "KeyboardDisplay"),
                )
                .await
                .is_ok()
                {
                    self.registration.lock().await.bluez = p.owner.clone();
                }
            }
            let (registered, default) = {
                let r = self.registration.lock().await;
                (r.bluez.clone(), r.default.clone())
            };
            if registered == p.owner && default != p.owner {
                let path = Path::try_from(agent::BLUEZ_PATH).unwrap();
                if p.call::<()>(
                    "/org/bluez",
                    "org.bluez.AgentManager1",
                    "RequestDefaultAgent",
                    &(path,),
                )
                .await
                .is_ok()
                {
                    self.registration.lock().await.default = p.owner;
                }
            }
        }
        if let Ok(p) = Peer::current(&self.session, bus::OBEX).await
            && self.registration.lock().await.obex != p.owner
        {
            let path = Path::try_from(agent::OBEX_PATH).unwrap();
            if p.call::<()>(
                bus::OBEX_ROOT,
                "org.bluez.obex.AgentManager1",
                "RegisterAgent",
                &(path,),
            )
            .await
            .is_ok()
            {
                self.registration.lock().await.obex = p.owner;
            }
        }
    }
    async fn activate_obex(&self) {
        if self.read_only {
            return;
        }
        if Peer::current(&self.session, bus::OBEX).await.is_err()
            && let Ok(p) = zbus::fdo::DBusProxy::new(&self.session).await
        {
            let _ = p
                .start_service_by_name(bus::OBEX.try_into().unwrap(), 0)
                .await;
        }
        self.register_agents().await;
    }
    async fn hold(&self, adapter: &Path, visible: bool, client: String) -> Result<u64, Error> {
        let (peer, p) = self.adapter(true, adapter).await?;
        let mut leases = self.leases.lock().await;
        if visible {
            if !leases.visibility.contains_key(adapter.as_str()) {
                let owned = !flag(&p, "Discoverable");
                if owned {
                    peer.set(adapter, bus::ADAPTER, "DiscoverableTimeout", 180u32.into())
                        .await?;
                    peer.set(adapter, bus::ADAPTER, "Discoverable", true.into())
                        .await?;
                }
                leases.visibility.insert(
                    adapter.to_string(),
                    Visibility {
                        owned,
                        renewed: tokio::time::Instant::now(),
                    },
                );
            }
        } else if !leases.discovery.contains(adapter.as_str()) {
            peer.call::<()>(adapter, bus::ADAPTER, "StartDiscovery", &())
                .await?;
            leases.discovery.insert(adapter.to_string());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        leases.holds.insert(
            id,
            Hold {
                client,
                adapter: adapter.to_string(),
                visible,
            },
        );
        drop(leases);
        self.refresh(true).await?;
        Ok(id)
    }
    async fn release(&self, id: u64, visible: bool, client: &str) -> Result<(), Error> {
        self.writable()?;
        let mut l = self.leases.lock().await;
        let Some(h) = l.holds.get(&id) else {
            return Err(Error::NotFound("lease no longer exists".into()));
        };
        if h.client != client || h.visible != visible {
            return Err(Error::Denied(
                "lease belongs to another client or kind".into(),
            ));
        }
        let adapter = h.adapter.clone();
        l.holds.remove(&id);
        drop(l);
        self.maintain_leases().await;
        self.refresh(true).await?;
        let l = self.leases.lock().await;
        let pending = if visible {
            l.visibility.get(&adapter).is_some_and(|v| v.owned)
                && !l.holds.values().any(|h| h.visible && h.adapter == adapter)
        } else {
            l.discovery.contains(&adapter)
                && !l.holds.values().any(|h| !h.visible && h.adapter == adapter)
        };
        if pending {
            Err(Error::Incomplete(
                "lease released; provider cleanup will be retried".into(),
            ))
        } else {
            Ok(())
        }
    }
    async fn maintain_leases(&self) {
        if self.read_only {
            return;
        }
        let clients: BTreeSet<_> = self
            .leases
            .lock()
            .await
            .holds
            .values()
            .map(|h| h.client.clone())
            .collect();
        for client in clients {
            if !bus::alive(&self.session, &client).await {
                self.leases
                    .lock()
                    .await
                    .holds
                    .retain(|_, h| h.client != client);
            }
        }
        let Ok(peer) = self.bluez(false).await else {
            return;
        };
        if self.state.lock().await.owners.0 != peer.owner {
            return;
        }
        let mut l = self.leases.lock().await;
        let mut remove = Vec::new();
        let visible_holds: BTreeSet<_> = l
            .holds
            .values()
            .filter(|h| h.visible)
            .map(|h| h.adapter.clone())
            .collect();
        for (path, v) in &mut l.visibility {
            let held = visible_holds.contains(path);
            if !held {
                if !v.owned
                    || peer
                        .set(path, bus::ADAPTER, "Discoverable", false.into())
                        .await
                        .is_ok()
                {
                    remove.push(path.clone());
                }
            } else if v.owned
                && v.renewed.elapsed() >= Duration::from_secs(60)
                && peer
                    .set(path, bus::ADAPTER, "DiscoverableTimeout", 180u32.into())
                    .await
                    .is_ok()
            {
                v.renewed = tokio::time::Instant::now();
            }
        }
        for path in remove {
            l.visibility.remove(&path);
        }
        let stop: Vec<_> = l
            .discovery
            .iter()
            .filter(|path| !l.holds.values().any(|h| !h.visible && h.adapter == **path))
            .cloned()
            .collect();
        for path in stop {
            if peer
                .call::<()>(&path, bus::ADAPTER, "StopDiscovery", &())
                .await
                .is_ok()
            {
                l.discovery.remove(&path);
            }
        }
    }
    async fn authorize_push(&self, peer: &Peer, path: &Path) -> Result<String, Error> {
        self.writable()?;
        if self.registration.lock().await.obex != peer.owner
            || self.state.lock().await.owners.1 != peer.owner
        {
            return Err(Error::Denied("receive agent is not registered".into()));
        }
        let props = peer.props(path, bus::TRANSFER).await?;
        let session_path = Path::try_from(text(&props, "Session"))
            .map_err(|_| Error::Invalid("transfer lacks session".into()))?;
        let session = peer.props(&session_path, bus::SESSION).await?;
        let address = text(&session, "Destination");
        if address.is_empty() {
            return Err(Error::Invalid("missing remote address".into()));
        }
        let name = files::safe_name(&text(&props, "Name"));
        let size = number(&props, "Size");
        let mut device = String::new();
        let mut label = address.clone();
        if let Ok(b) = self.bluez(false).await
            && let Ok(objects) = b.objects("/").await
        {
            for (path, interfaces) in objects {
                if let Some(p) = interfaces.get(bus::DEVICE)
                    && text(p, "Address").eq_ignore_ascii_case(&address)
                {
                    device = path.to_string();
                    let alias = text(p, "Alias");
                    let alias = if alias.is_empty() {
                        text(p, "Name")
                    } else {
                        alias
                    };
                    if !alias.is_empty() {
                        label = alias;
                    }
                    break;
                }
            }
        }
        let preflight = if let Some(size) = size {
            let transfers = self.transfers.lock().await;
            let reserved = transfers
                .values()
                .filter(|t| t.active() && t.incoming.is_some())
                .try_fold(0u64, |sum, t| sum.checked_add(t.size.unwrap_or(0)))
                .ok_or_else(|| Error::NoSpace("incoming reservations exceed capacity".into()))?;
            files::preflight(
                self.space.as_ref(),
                &PathBuf::from(text(&session, "Root")),
                &files::downloads(),
                size,
                reserved,
            )
        } else {
            Ok(())
        };
        let epoch = self.epoch.load(Ordering::SeqCst);
        if preflight.is_ok() {
            self.broker.ask(bus::OBEX,path,"incoming-file",json!({"kind":"incoming-file","device":device,"deviceName":files::safe_name(&label),"address":address,"name":name,"size":size}),Duration::from_secs(45)).await?;
            if self.epoch.load(Ordering::SeqCst) != epoch {
                return Err(Error::Conflict("provider changed during consent".into()));
            }
            let now = peer.props(path, bus::TRANSFER).await?;
            if text(&now, "Session") != session_path.as_str()
                || files::safe_name(&text(&now, "Name")) != name
                || number(&now, "Size") != size
            {
                return Err(Error::Conflict(
                    "transfer metadata changed during consent".into(),
                ));
            }
        }
        let mut transfers = self.transfers.lock().await;
        let reserved = transfers
            .values()
            .filter(|t| t.active() && t.incoming.is_some())
            .try_fold(0u64, |sum, t| sum.checked_add(t.size.unwrap_or(0)))
            .ok_or_else(|| Error::NoSpace("incoming reservations exceed capacity".into()))?;
        let prepared = preflight.and_then(|_| {
            files::Incoming::prepare(
                &PathBuf::from(text(&session, "Root")),
                &files::downloads(),
                &name,
                size,
                self.space.as_ref(),
                reserved,
            )
        });
        let incoming = match prepared {
            Ok(file) => Arc::new(file),
            Err(error) => {
                let id = self.next.fetch_add(1, Ordering::SeqCst);
                transfers.insert(
                    id,
                    Transfer {
                        id,
                        epoch,
                        peer: peer.clone(),
                        path: path.clone(),
                        session: session_path,
                        device,
                        address,
                        name,
                        size,
                        transferred: None,
                        status: "error".into(),
                        error: Some(
                            match &error {
                                Error::NoSpace(_) => "no-space",
                                Error::Unavailable(_) => "persistent-root-required",
                                _ => "staging-failed",
                            }
                            .into(),
                        ),
                        published: None,
                        incoming: None,
                        creator: String::new(),
                        session_removed: true,
                    },
                );
                drop(transfers);
                self.publish_transfers().await?;
                return Err(error);
            }
        };
        let stage = incoming.path.to_string_lossy().into_owned();
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        transfers.insert(
            id,
            Transfer {
                id,
                epoch,
                peer: peer.clone(),
                path: path.clone(),
                session: session_path,
                device,
                address,
                name,
                size,
                transferred: None,
                status: "queued".into(),
                error: None,
                published: None,
                incoming: Some(incoming),
                creator: String::new(),
                session_removed: true,
            },
        );
        drop(transfers);
        self.publish_transfers().await?;
        Ok(stage)
    }
    async fn cleanup_terminal(&self, id: u64) {
        let cleanup = {
            let mut ts = self.transfers.lock().await;
            let Some(t) = ts.get_mut(&id) else {
                return;
            };
            if t.active() {
                return;
            }
            t.incoming.take();
            if t.session_removed {
                None
            } else {
                Some((t.peer.clone(), t.session.clone()))
            }
        };
        if let Some((peer, session)) = cleanup
            && peer
                .call::<()>(
                    bus::OBEX_ROOT,
                    "org.bluez.obex.Client1",
                    "RemoveSession",
                    &(session,),
                )
                .await
                .is_ok()
            && let Some(t) = self.transfers.lock().await.get_mut(&id)
        {
            t.session_removed = true;
        }
    }
    async fn monitor_transfers(&self) {
        let ids: Vec<_> = self
            .transfers
            .lock()
            .await
            .iter()
            .filter(|(_, t)| t.active() || !t.session_removed)
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            if self
                .transfers
                .lock()
                .await
                .get(&id)
                .is_some_and(|t| !t.active())
            {
                self.cleanup_terminal(id).await;
                continue;
            }
            let (peer, path, incoming, previous_status) = {
                let ts = self.transfers.lock().await;
                let Some(t) = ts.get(&id) else {
                    continue;
                };
                (
                    t.peer.clone(),
                    t.path.clone(),
                    t.incoming.clone(),
                    t.status.clone(),
                )
            };
            let cached = self.obex_cache.lock().await.get(path.as_str()).cloned();
            let props = if cached
                .as_ref()
                .is_some_and(|p| matches!(text(p, "Status").as_str(), "complete" | "error"))
            {
                Ok(cached.unwrap())
            } else {
                peer.props(&path, bus::TRANSFER).await
            };
            let (mut status, mut error, transferred) = match props {
                Ok(ref p) => (text(p, "Status"), None, number(p, "Transferred")),
                Err(_) => ("error".into(), Some("transfer-unavailable".into()), None),
            };
            let low_space = incoming
                .as_ref()
                .is_some_and(|f| f.check_space(self.space.as_ref()).is_err());
            if low_space || previous_status == "cancel-pending" {
                match peer.call::<()>(&path, bus::TRANSFER, "Cancel", &()).await {
                    Ok(()) => {
                        status = "error".into();
                        error = Some("no-space-or-cancelled".into());
                    }
                    Err(_) => {
                        status = "cancel-pending".into();
                        error = Some("incomplete: could not stop transfer".into());
                    }
                }
            }
            if status == "complete" {
                if let Some(file) = incoming {
                    {
                        let mut ts = self.transfers.lock().await;
                        let Some(t) = ts
                            .get_mut(&id)
                            .filter(|t| t.active() && t.status != "cancel-pending")
                        else {
                            continue;
                        };
                        t.status = "finalizing".into();
                    }
                    let space = self.space.clone();
                    let result =
                        tokio::task::spawn_blocking(move || file.publish(space.as_ref())).await;
                    let mut ts = self.transfers.lock().await;
                    if let Some(t) = ts.get_mut(&id) {
                        match result {
                            Ok(Ok(name)) => {
                                t.status = "received".into();
                                t.published = Some(name);
                            }
                            _ => {
                                t.status = "error".into();
                                t.error = Some("publication-failed".into());
                            }
                        }
                    }
                } else {
                    if let Some(t) = self
                        .transfers
                        .lock()
                        .await
                        .get_mut(&id)
                        .filter(|t| t.active())
                    {
                        t.status = "sent".into();
                    }
                }
            } else {
                if let Some(t) = self
                    .transfers
                    .lock()
                    .await
                    .get_mut(&id)
                    .filter(|t| t.active() && t.status != "finalizing")
                {
                    t.status = if status.is_empty() {
                        "error".into()
                    } else {
                        status
                    };
                    t.error = error;
                    t.transferred = transferred;
                }
            }
            self.cleanup_terminal(id).await;
        }
        let mut ts = self.transfers.lock().await;
        while ts.len() > 128 {
            let Some(id) = ts
                .iter()
                .find(|(_, t)| !t.active() && t.session_removed)
                .map(|(id, _)| *id)
            else {
                break;
            };
            ts.remove(&id);
        }
    }
}
#[zbus::interface(name = "org.nidara.Bluetooth1")]
impl Bluetooth {
    async fn snapshot(&self) -> (u64, u64, String) {
        let s = self.state.lock().await;
        (
            self.epoch.load(Ordering::SeqCst),
            s.revision,
            s.json.clone(),
        )
    }
    async fn register_ui(&self, #[zbus(header)] h: Header<'_>) -> Result<(), Error> {
        self.writable()?;
        self.broker.register(&sender(&h)?).await?;
        self.activate_obex().await;
        self.refresh(true).await
    }
    async fn unregister_ui(&self, #[zbus(header)] h: Header<'_>) -> Result<(), Error> {
        self.broker.unregister(&sender(&h)?).await
    }
    async fn reply_request(
        &self,
        epoch: u64,
        id: u64,
        accept: bool,
        value: String,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(), Error> {
        self.writable()?;
        self.broker
            .reply(&sender(&h)?, epoch, id, accept, &value)
            .await
    }
    async fn cancel_request(
        &self,
        epoch: u64,
        id: u64,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(), Error> {
        self.writable()?;
        if let Some(device) = self.broker.cancel(&sender(&h)?, epoch, id).await? {
            let p = self.bluez(true).await?;
            p.call::<()>(&device, bus::DEVICE, "CancelPairing", &())
                .await
                .map_err(|_| {
                    Error::Incomplete("dialog closed, but pairing cancellation failed".into())
                })?;
        }
        Ok(())
    }
    async fn set_powered(&self, adapter: Path, powered: bool) -> Result<(), Error> {
        let (p, _) = self.adapter(true, &adapter).await?;
        p.set(&adapter, bus::ADAPTER, "Powered", powered.into())
            .await?;
        self.refresh(true).await
    }
    async fn set_adapter_alias(&self, adapter: Path, alias: String) -> Result<(), Error> {
        if alias.len() > 248 || alias.chars().any(char::is_control) {
            return Err(Error::Invalid("invalid Bluetooth alias".into()));
        }
        let (p, _) = self.adapter(true, &adapter).await?;
        p.set(&adapter, bus::ADAPTER, "Alias", alias.as_str().into())
            .await?;
        self.refresh(true).await
    }
    async fn set_blocked(&self, device: Path, blocked: bool) -> Result<(), Error> {
        let (p, _) = self.device(true, &device).await?;
        p.set(&device, bus::DEVICE, "Blocked", blocked.into())
            .await?;
        self.refresh(true).await
    }
    async fn pair(&self, device: Path) -> Result<(), Error> {
        let (p, _) = self.device(true, &device).await?;
        let _guard = self.operation(&device)?;
        let result = p
            .call_for::<()>(&device, bus::DEVICE, "Pair", &(), Duration::from_secs(120))
            .await;
        self.broker.close_device(&device).await;
        let result = match result {
            Ok(()) => p
                .set(&device, bus::DEVICE, "Trusted", true.into())
                .await
                .map_err(|_| Error::Incomplete("paired, but setting trusted failed".into())),
            Err(e) => Err(e),
        };
        self.refresh(true).await?;
        result
    }
    async fn cancel_pairing(&self, device: Path) -> Result<(), Error> {
        let (p, _) = self.device(true, &device).await?;
        self.broker.close_device(&device).await;
        p.call::<()>(&device, bus::DEVICE, "CancelPairing", &())
            .await?;
        self.refresh(true).await
    }
    async fn connect(&self, device: Path) -> Result<(), Error> {
        let (p, _) = self.device(true, &device).await?;
        let _guard = self.operation(&device)?;
        let result = p
            .call_for::<()>(
                &device,
                bus::DEVICE,
                "Connect",
                &(),
                Duration::from_secs(120),
            )
            .await;
        self.refresh(true).await?;
        result
    }
    async fn disconnect(&self, device: Path) -> Result<(), Error> {
        let (p, _) = self.device(true, &device).await?;
        p.call::<()>(&device, bus::DEVICE, "Disconnect", &())
            .await?;
        self.refresh(true).await
    }
    async fn forget(&self, device: Path) -> Result<(), Error> {
        let (p, props) = self.device(true, &device).await?;
        let _guard = self.operation(&device)?;
        self.broker.close_device(&device).await;
        let adapter = text(&props, "Adapter");
        p.call::<()>(&adapter, bus::ADAPTER, "RemoveDevice", &(device,))
            .await?;
        self.refresh(true).await
    }
    async fn hold_discovery(
        &self,
        adapter: Path,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<u64, Error> {
        self.hold(&adapter, false, sender(&h)?).await
    }
    async fn release_discovery(&self, id: u64, #[zbus(header)] h: Header<'_>) -> Result<(), Error> {
        self.release(id, false, &sender(&h)?).await
    }
    async fn hold_discoverable(
        &self,
        adapter: Path,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<u64, Error> {
        self.hold(&adapter, true, sender(&h)?).await
    }
    async fn release_discoverable(
        &self,
        id: u64,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<(), Error> {
        self.release(id, true, &sender(&h)?).await
    }
    async fn send_file(
        &self,
        device: Path,
        file: String,
        #[zbus(header)] h: Header<'_>,
    ) -> Result<u64, Error> {
        let (_, props) = self.device(true, &device).await?;
        let file = files::outgoing(&PathBuf::from(file))?;
        self.activate_obex().await;
        self.refresh(true).await?;
        let p = Peer::current(&self.session, bus::OBEX).await?;
        let adapter = text(&props, "Adapter");
        let (_, a) = self.adapter(false, &adapter).await?;
        let args = Props::from([
            ("Target".into(), Value::from("opp").try_to_owned().unwrap()),
            (
                "Source".into(),
                Value::from(text(&a, "Address")).try_to_owned().unwrap(),
            ),
        ]);
        let address = text(&props, "Address");
        let session: Path = p
            .call(
                bus::OBEX_ROOT,
                "org.bluez.obex.Client1",
                "CreateSession",
                &(&address, args),
            )
            .await?;
        let result = p
            .call::<(Path, Props)>(
                &session,
                "org.bluez.obex.ObjectPush1",
                "SendFile",
                &(file.to_string_lossy().as_ref(),),
            )
            .await;
        let (path, transfer) = match result {
            Ok(v) => v,
            Err(e) => {
                let _ = p
                    .call::<()>(
                        bus::OBEX_ROOT,
                        "org.bluez.obex.Client1",
                        "RemoveSession",
                        &(session,),
                    )
                    .await;
                return Err(e);
            }
        };
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let epoch = self.epoch.load(Ordering::SeqCst);
        self.transfers.lock().await.insert(
            id,
            Transfer {
                id,
                epoch,
                peer: p,
                path,
                session,
                device: device.to_string(),
                address,
                name: files::safe_name(
                    file.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .as_ref(),
                ),
                size: number(&transfer, "Size"),
                transferred: number(&transfer, "Transferred"),
                status: "queued".into(),
                error: None,
                published: None,
                incoming: None,
                creator: sender(&h)?,
                session_removed: false,
            },
        );
        self.publish_transfers().await?;
        Ok(id)
    }
    async fn cancel_transfer(&self, epoch: u64, id: u64) -> Result<(), Error> {
        self.writable()?;
        let (peer, path) = {
            let ts = self.transfers.lock().await;
            let t = ts
                .get(&id)
                .filter(|t| t.epoch == epoch && epoch == self.epoch.load(Ordering::SeqCst))
                .ok_or_else(|| Error::NotFound("stale transfer".into()))?;
            if t.status == "finalizing" {
                return Err(Error::Busy("file publication in progress".into()));
            }
            if !t.active() {
                return Err(Error::Conflict("transfer already finished".into()));
            }
            (t.peer.clone(), t.path.clone())
        };
        peer.call::<()>(&path, bus::TRANSFER, "Cancel", &()).await?;
        {
            let mut ts = self.transfers.lock().await;
            let t = ts
                .get_mut(&id)
                .ok_or_else(|| Error::NotFound("transfer removed".into()))?;
            if t.status == "finalizing" {
                return Err(Error::Busy("publication already started".into()));
            }
            if !t.active() {
                return Err(Error::Conflict("transfer already finished".into()));
            }
            t.status = "cancelled".into();
            t.incoming.take();
        }
        self.publish_transfers().await
    }
    #[zbus(signal)]
    async fn updated(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        epoch: u64,
        revision: u64,
        json: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn request(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        epoch: u64,
        id: u64,
        metadata: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn request_updated(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        epoch: u64,
        id: u64,
        metadata: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn request_closed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        epoch: u64,
        id: u64,
        reason: &str,
    ) -> zbus::Result<()>;
}
pub async fn serve(session: &Connection, read_only: bool) -> Result<(), Error> {
    let system = Connection::system().await?;
    let service = Bluetooth::new(
        system.clone(),
        session.clone(),
        read_only,
        Arc::new(files::RealSpace),
    );
    session.object_server().at(PATH, service.clone()).await?;
    if !read_only {
        system
            .object_server()
            .at(agent::BLUEZ_PATH, agent::PairAgent(service.clone()))
            .await?;
        session
            .object_server()
            .at(agent::OBEX_PATH, agent::PushAgent(service.clone()))
            .await?;
    }
    // Subscribe before agent registration: a completed server transfer can be
    // removed before the next 250 ms snapshot. Preserve its terminal event.
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .path_namespace(bus::OBEX_ROOT)?
        .build();
    let mut events = zbus::MessageStream::for_match_rule(rule, session, Some(256)).await?;
    let observer = service.clone();
    tokio::spawn(async move {
        use futures_util::StreamExt;
        while let Some(Ok(message)) = events.next().await {
            let header = message.header();
            let Ok(peer) = Peer::current(&observer.session, bus::OBEX).await else {
                continue;
            };
            if peer.authenticate(&header).is_err() {
                continue;
            }
            if header
                .member()
                .is_some_and(|m| m.as_str() == "InterfacesRemoved")
                && let Ok((path, interfaces)) = message.body().deserialize::<(Path, Vec<String>)>()
                && interfaces.iter().any(|i| i == bus::TRANSFER)
            {
                observer.broker.removed_transfer(&path).await;
            }
            if header
                .member()
                .is_some_and(|m| m.as_str() == "PropertiesChanged")
                && let Ok((iface, changed, invalidated)) =
                    message.body().deserialize::<(String, Props, Vec<String>)>()
                && iface == bus::TRANSFER
                && let Some(path) = header.path()
            {
                let mut cache = observer.obex_cache.lock().await;
                if cache.len() >= 1024
                    && !cache.contains_key(path.as_str())
                    && let Some(first) = cache.keys().next().cloned()
                {
                    cache.remove(&first);
                }
                let p = cache.entry(path.to_string()).or_default();
                for k in invalidated {
                    p.remove(&k);
                }
                p.extend(changed);
            }
        }
    });
    service.refresh(true).await?;
    session
        .request_name_with_flags(NAME, zbus::fdo::RequestNameFlags::DoNotQueue.into())
        .await?;
    let inventory = service.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            let _ = inventory.refresh(false).await;
            inventory.broker.check_ui().await;
        }
    });
    let controls = service.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut registration = tokio::time::Instant::now() - Duration::from_secs(3);
        loop {
            tick.tick().await;
            if registration.elapsed() >= Duration::from_secs(2) {
                controls.register_agents().await;
                registration = tokio::time::Instant::now();
            }
            controls.maintain_leases().await;
        }
    });
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(250));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tick.tick().await;
            service.monitor_transfers().await;
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct FakeSpace(AtomicU64);
    impl files::Space for FakeSpace {
        fn available(&self, _: &std::path::Path) -> Result<u64, Error> {
            Ok(self.0.load(Ordering::SeqCst))
        }
    }
    struct FakeTransfer(Arc<AtomicU64>);
    #[zbus::interface(name = "org.bluez.obex.Transfer1")]
    impl FakeTransfer {
        async fn cancel(&self) {
            self.0.fetch_add(1, Ordering::SeqCst);
        }
        #[zbus(property)]
        fn status(&self) -> &str {
            "active"
        }
        #[zbus(property)]
        fn transferred(&self) -> u64 {
            0
        }
    }
    struct FakeAdapter {
        visible: bool,
        timeout: u32,
        renewals: Arc<AtomicU64>,
    }
    #[zbus::interface(name = "org.bluez.Adapter1")]
    impl FakeAdapter {
        #[zbus(property)]
        fn discoverable(&self) -> bool {
            self.visible
        }
        #[zbus(property)]
        fn set_discoverable(&mut self, value: bool) {
            self.visible = value;
        }
        #[zbus(property)]
        fn discoverable_timeout(&self) -> u32 {
            self.timeout
        }
        #[zbus(property)]
        fn set_discoverable_timeout(&mut self, value: u32) {
            self.timeout = value;
            self.renewals.fetch_add(1, Ordering::SeqCst);
        }
    }
    #[test]
    fn low_space_monitor_cancels_obex_and_removes_only_own_partial() {
        if std::env::var_os("NIDARA_BT_PRIVATE_SPACE_CHILD").is_none() {
            let status = std::process::Command::new("dbus-run-session")
                .arg("--")
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "bluetooth::tests::low_space_monitor_cancels_obex_and_removes_only_own_partial",
                    "--nocapture",
                ])
                .env("NIDARA_BT_PRIVATE_SPACE_CHILD", "1")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let cancelled = Arc::new(AtomicU64::new(0));
            let fake = zbus::connection::Builder::session()
                .unwrap()
                .serve_at("/transfer", FakeTransfer(cancelled.clone()))
                .unwrap()
                .build()
                .await
                .unwrap();
            let client = Connection::session().await.unwrap();
            let space = Arc::new(FakeSpace(AtomicU64::new(files::FREE_FLOOR + 4096)));
            let bt = Bluetooth::new(client.clone(), client, false, space.clone());
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(format!(
                "../../target/bluetooth-space-{}",
                std::process::id()
            ));
            std::fs::create_dir_all(&root).unwrap();
            let download = root.join("downloads");
            std::fs::create_dir_all(&download).unwrap();
            let untouched = download.join("unrelated.txt");
            std::fs::write(&untouched, b"keep").unwrap();
            for size in [Some(4), None] {
                space.0.store(files::FREE_FLOOR + 4096, Ordering::SeqCst);
                let incoming = Arc::new(
                    files::Incoming::prepare(&root, &download, "test.txt", size, space.as_ref(), 0)
                        .unwrap(),
                );
                let partial = incoming.path.clone();
                bt.transfers.lock().await.insert(
                    1,
                    Transfer {
                        id: 1,
                        epoch: bt.epoch.load(Ordering::SeqCst),
                        peer: Peer {
                            bus: bt.session.clone(),
                            owner: fake.unique_name().unwrap().to_string(),
                        },
                        path: Path::try_from("/transfer").unwrap(),
                        session: Path::try_from("/session").unwrap(),
                        device: String::new(),
                        address: String::new(),
                        name: "test.txt".into(),
                        size,
                        transferred: None,
                        status: "active".into(),
                        error: None,
                        published: None,
                        incoming: Some(incoming),
                        creator: String::new(),
                        session_removed: true,
                    },
                );
                let before = cancelled.load(Ordering::SeqCst);
                bt.monitor_transfers().await;
                assert_eq!(cancelled.load(Ordering::SeqCst), before);
                assert!(partial.exists());
                space.0.store(files::FREE_FLOOR - 1, Ordering::SeqCst);
                bt.monitor_transfers().await;
                assert_eq!(cancelled.load(Ordering::SeqCst), before + 1);
                assert!(!partial.exists());
                assert_eq!(std::fs::read(&untouched).unwrap(), b"keep");
                let ts = bt.transfers.lock().await;
                assert_eq!(ts[&1].status, "error");
                assert!(ts[&1].published.is_none());
            }
            // Advance the lease's own monotonic deadline without sleeping or
            // racing CI speed. Even setting the same180 value must renew BlueZ.
            let renewals = Arc::new(AtomicU64::new(0));
            fake.object_server()
                .at(
                    "/adapter",
                    FakeAdapter {
                        visible: true,
                        timeout: 180,
                        renewals: renewals.clone(),
                    },
                )
                .await
                .unwrap();
            fake.request_name(bus::BLUEZ).await.unwrap();
            bt.state.lock().await.owners.0 = fake.unique_name().unwrap().to_string();
            {
                let mut leases = bt.leases.lock().await;
                leases.holds.insert(
                    99,
                    Hold {
                        client: bt.session.unique_name().unwrap().to_string(),
                        adapter: "/adapter".into(),
                        visible: true,
                    },
                );
                leases.visibility.insert(
                    "/adapter".into(),
                    Visibility {
                        owned: true,
                        renewed: tokio::time::Instant::now() - Duration::from_secs(61),
                    },
                );
            }
            let before_renewal = tokio::time::Instant::now();
            bt.maintain_leases().await;
            assert_eq!(renewals.load(Ordering::SeqCst), 1);
            assert!(bt.leases.lock().await.visibility["/adapter"].renewed >= before_renewal);
            bt.leases.lock().await.holds.clear();
            bt.maintain_leases().await;
            let peer = Peer::current(&bt.system, bus::BLUEZ).await.unwrap();
            let properties = peer.props("/adapter", bus::ADAPTER).await.unwrap();
            assert!(!flag(&properties, "Discoverable"));
            std::fs::remove_file(untouched).unwrap();
            std::fs::remove_dir(download).unwrap();
            std::fs::remove_dir(root).unwrap();
        });
    }
}
