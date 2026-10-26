// SPDX-License-Identifier: GPL-3.0-or-later
//! Rust-session-only Network1. Never enable `--network` in the daily TS session:
//! the TS shell already owns a secret agent for that user's NetworkManager.
mod agent;
mod ip;
mod keyring;
mod nm;
use nm::{Nm, owned, text};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::Mutex;
use zbus::{
    Connection,
    message::Header,
    zvariant::{OwnedObjectPath as Path, OwnedValue, Value},
};
const NAME: &str = "org.nidara.Network";
const PATH: &str = "/org/nidara/Network";
const IFACE: &str = "org.nidara.Network1";
type Settings = HashMap<String, HashMap<String, OwnedValue>>;
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.Network1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    Unavailable(String),
    Invalid(String),
    NeedsProfile(String),
    Denied(String),
    Cancelled(String),
    Failed(String),
}
impl From<zbus::fdo::Error> for Error {
    fn from(e: zbus::fdo::Error) -> Self {
        Self::Failed(e.to_string())
    }
}
struct Announced {
    epoch: u64,
    revision: u64,
    json: String,
    owner: String,
}
#[derive(Clone)]
struct Network {
    system: Connection,
    session: Connection,
    state: Arc<Mutex<Announced>>,
    agent: agent::Agent,
    read_only: bool,
    operations: Arc<Mutex<()>>,
}
impl Network {
    async fn nm(&self, write: bool) -> Result<Nm, Error> {
        if write && self.read_only {
            return Err(Error::Denied("read-only network service".into()));
        }
        Nm::current(&self.system).await
    }
    async fn refresh(&self) -> Result<(), Error> {
        let nm = self.nm(false).await.ok();
        let owner = nm.as_ref().map(|n| n.owner.clone()).unwrap_or_default();
        let mut state = self.state.lock().await;
        if state.owner != owner {
            self.agent.withdraw("nm-restarted").await;
            state.owner = owner.clone();
            // Clear old objects before publishing the replacement owner's snapshot.
            let empty = empty();
            if state.json != empty {
                state.revision += 1;
                state.json = empty;
                self.session
                    .emit_signal(
                        None::<&str>,
                        PATH,
                        IFACE,
                        "Updated",
                        &(state.epoch, state.revision, &state.json),
                    )
                    .await?;
            }
        }
        drop(state);
        let json = match nm {
            Some(ref nm) => nm.snapshot().await?.to_string(),
            None => empty(),
        };
        // Do not publish a snapshot assembled across a NetworkManager restart.
        let current = self
            .nm(false)
            .await
            .ok()
            .map(|n| n.owner)
            .unwrap_or_default();
        if owner != current {
            return Ok(());
        }
        let mut state = self.state.lock().await;
        if state.json != json {
            state.revision += 1;
            state.json = json;
            self.session
                .emit_signal(
                    None::<&str>,
                    PATH,
                    IFACE,
                    "Updated",
                    &(state.epoch, state.revision, &state.json),
                )
                .await?;
        }
        Ok(())
    }
    async fn activation_result(&self, result: Result<(), Error>, uuid: &str) -> Result<(), Error> {
        if result.is_err() && self.agent.take_cancel(uuid).await {
            return Err(Error::Cancelled("cancelled by the user".into()));
        }
        result
    }
    async fn activate_inner(&self, nm: &Nm, uuid: &str, device: &Path) -> Result<Path, Error> {
        let (p, _) = nm.profile(uuid).await?;
        let a = nm.activate(&p, device, &nm::root_path()).await?;
        self.activation_result(nm.wait_active(&a).await, uuid)
            .await?;
        Ok(a)
    }
}
fn empty() -> String {
    serde_json::json!({"schemaVersion":1,"available":false,"devices":[],"profiles":[],"active":[],"wirelessEnabled":false,"wirelessHardwareEnabled":false,"state":0,"connectivity":0}).to_string()
}
#[zbus::interface(name = "org.nidara.Network1")]
impl Network {
    async fn snapshot(&self) -> (u64, u64, String) {
        let s = self.state.lock().await;
        (s.epoch, s.revision, s.json.clone())
    }
    async fn set_wifi_enabled(&self, enabled: bool) -> Result<(), Error> {
        let _op = self.operations.lock().await;
        self.nm(true)
            .await?
            .set(nm::ROOT, nm::NAME, "WirelessEnabled", Value::from(enabled))
            .await
    }
    async fn scan(&self, device: Path) -> Result<(), Error> {
        let options = nm::Props::new();
        self.nm(true)
            .await?
            .call(&device, nm::WIFI, "RequestScan", &(options,))
            .await
    }
    async fn connect(&self, device: Path, ap: Path, uuid: String) -> Result<Path, Error> {
        let nm = self.nm(true).await?;
        if !uuid.is_empty() {
            return self.activate_inner(&nm, &uuid, &device).await;
        }
        if ap.as_str() == "/" {
            return Err(Error::NeedsProfile(
                "a hidden network needs a saved profile".into(),
            ));
        }
        let aps: Vec<Path> = nm
            .call(&device, nm::WIFI, "GetAllAccessPoints", &())
            .await?;
        if !aps.contains(&ap) {
            return Err(Error::Invalid("AP does not belong to this device".into()));
        }
        let p = nm
            .props(&ap, "org.freedesktop.NetworkManager.AccessPoint")
            .await?;
        let ssid = nm::bytes(Some(&p), "Ssid");
        let flags = nm::number(Some(&p), "WpaFlags") | nm::number(Some(&p), "RsnFlags");
        let enterprise = flags & 0x200 != 0;
        let mut profiles = nm.profiles().await?;
        profiles
            .sort_by_key(|(_, s)| std::cmp::Reverse(nm::number(s.get("connection"), "timestamp")));
        // Keep security domains separate: an open/enterprise BSS with the same SSID
        // must not steal the saved personal profile.
        let secured = nm::number(Some(&p), "Flags") & 1 != 0 || flags != 0;
        if let Some((path, _)) = profiles.iter().find(|(_, s)| {
            text(s.get("connection"), "type") == "802-11-wireless"
                && nm::bytes(s.get("802-11-wireless"), "ssid") == ssid
                && s.contains_key("802-11-wireless-security") == secured
                && s.contains_key("802-1x") == enterprise
        }) {
            let a = nm.activate(path, &device, &ap).await?;
            self.activation_result(
                nm.wait_active(&a).await,
                &text(
                    profiles
                        .iter()
                        .find(|(p, _)| p == path)
                        .unwrap()
                        .1
                        .get("connection"),
                    "uuid",
                ),
            )
            .await?;
            return Ok(a);
        }
        if enterprise {
            return Err(Error::NeedsProfile(
                "enterprise Wi-Fi needs a configured profile".into(),
            ));
        }
        let mut settings = Settings::new();
        if secured {
            let key_mgmt = if flags & 0x400 != 0 {
                "sae"
            } else if flags & 0x800 != 0 {
                "owe"
            } else if flags != 0 {
                "wpa-psk"
            } else {
                "none"
            };
            let mut sec = nm::Props::from([("key-mgmt".into(), owned(key_mgmt))]);
            if key_mgmt == "none" {
                for i in 0..4 {
                    sec.insert(format!("wep-key{i}-flags"), 1u32.into());
                }
            } else if key_mgmt != "owe" {
                sec.insert("psk-flags".into(), 1u32.into());
            }
            settings.insert("802-11-wireless-security".into(), sec);
        }
        let (profile, active): (Path, Path) = nm
            .call(
                nm::ROOT,
                nm::NAME,
                "AddAndActivateConnection",
                &(settings, &device, &ap),
            )
            .await?;
        let uuid = nm
            .call::<Settings>(&profile, nm::PROFILE, "GetSettings", &())
            .await
            .ok()
            .map(|s| text(s.get("connection"), "uuid"))
            .unwrap_or_default();
        let result = self
            .activation_result(nm.wait_active(&active).await, &uuid)
            .await;
        if result.is_err() {
            let _ = nm.call::<()>(&profile, nm::PROFILE, "Delete", &()).await;
        }
        result?;
        Ok(active)
    }
    /// The renderer can supply a configured enterprise profile, as libnma does in TS.
    /// A missing enterprise/hidden profile is never guessed from an SSID.
    async fn connect_profile(
        &self,
        device: Path,
        ap: Path,
        settings: Settings,
    ) -> Result<Path, Error> {
        let nm = self.nm(true).await?;
        if text(settings.get("connection"), "type") != "802-11-wireless" {
            return Err(Error::Invalid("expected a Wi-Fi profile".into()));
        }
        if nm::bytes(settings.get("802-11-wireless"), "ssid").is_empty() {
            return Err(Error::Invalid("missing SSID".into()));
        }
        if ap.as_str() != "/" {
            let aps: Vec<Path> = nm
                .call(&device, nm::WIFI, "GetAllAccessPoints", &())
                .await?;
            if !aps.contains(&ap) {
                return Err(Error::Invalid("AP does not belong to device".into()));
            }
        }
        let (profile, active): (Path, Path) = nm
            .call(
                nm::ROOT,
                nm::NAME,
                "AddAndActivateConnection",
                &(&settings, &device, &ap),
            )
            .await?;
        let mut merged: Settings = nm.call(&profile, nm::PROFILE, "GetSettings", &()).await?;
        let uuid = text(merged.get("connection"), "uuid");
        let result = self
            .activation_result(nm.wait_active(&active).await, &uuid)
            .await;
        if result.is_err() {
            let _ = nm.call::<()>(&profile, nm::PROFILE, "Delete", &()).await;
        } else {
            let canonical = merged.get("connection").cloned();
            for (name, keys) in settings {
                merged.entry(name).or_default().extend(keys);
            }
            if let Some(canonical) = canonical {
                merged.insert("connection".into(), canonical);
            }
            let bus = self.session.clone();
            tokio::spawn(async move {
                if keyring::save(&bus, &merged).await.is_err() {
                    eprintln!("[network] could not store profile's agent-owned secrets");
                }
            });
        }
        result?;
        Ok(active)
    }
    async fn disconnect(&self, device: Path) -> Result<(), Error> {
        self.nm(true)
            .await?
            .call(&device, nm::DEVICE, "Disconnect", &())
            .await
    }
    async fn activate(&self, uuid: String, device: Path) -> Result<Path, Error> {
        let nm = self.nm(true).await?;
        self.activate_inner(&nm, &uuid, &device).await
    }
    async fn deactivate(&self, active: Path) -> Result<(), Error> {
        self.nm(true)
            .await?
            .call(nm::ROOT, nm::NAME, "DeactivateConnection", &(active,))
            .await
    }
    async fn forget(&self, uuid: String) -> Result<(), Error> {
        let _op = self.operations.lock().await;
        let nm = self.nm(true).await?;
        let (p, _) = nm.profile(&uuid).await?;
        nm.call(&p, nm::PROFILE, "Delete", &()).await
    }
    async fn set_wired_enabled(&self, device: Path, enabled: bool) -> Result<(), Error> {
        let op = self.operations.lock().await;
        let nm = self.nm(true).await?;
        let active = nm.wired_switch(&device, enabled).await?;
        drop(op); // A later off/disconnect must not wait for activation or a password.
        if let Some(active) = active {
            nm.wait_active(&active).await?;
        }
        Ok(())
    }
    async fn get_ip(&self, uuid: String) -> Result<String, Error> {
        let nm = self.nm(false).await?;
        let s = if uuid.is_empty() {
            Settings::new()
        } else {
            nm.profile(&uuid).await?.1
        };
        serde_json::to_string(&ip::read(&s))
            .map_err(|_| Error::Failed("IP serialization failed".into()))
    }
    async fn apply_ip(&self, uuid: String, device: Path, form: String) -> Result<(), Error> {
        let _op = self.operations.lock().await;
        let form =
            serde_json::from_str(&form).map_err(|_| Error::Invalid("invalid IP form".into()))?;
        let nm = self.nm(true).await?;
        let active = ip::apply(&nm, &uuid, &device, form).await?;
        drop(_op);
        if let Some(active) = active {
            self.activation_result(nm.wait_active(&active).await, &uuid)
                .await?;
        }
        Ok(())
    }
    async fn renew(&self, device: Path) -> Result<(), Error> {
        let nm = self.nm(true).await?;
        let p = nm.props(&device, nm::DEVICE).await?;
        let active = text(Some(&p), "ActiveConnection");
        if active.is_empty() || active == "/" {
            return Ok(());
        }
        let p = nm.props(&active, nm::ACTIVE).await?;
        self.activate_inner(&nm, &text(Some(&p), "Uuid"), &device)
            .await?;
        Ok(())
    }
    async fn register_secrets_ui(&self, #[zbus(header)] header: Header<'_>) -> Result<(), Error> {
        self.nm(true).await?;
        self.agent.register_ui(&header).await
    }
    async fn submit_secrets(
        &self,
        id: u64,
        values: Settings,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), Error> {
        self.nm(true).await?;
        self.agent.submit(&header, id, Some(values)).await
    }
    async fn cancel_secrets(
        &self,
        id: u64,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), Error> {
        self.nm(true).await?;
        self.agent.submit(&header, id, None).await
    }
    async fn take_user_cancel(&self, uuid: String) -> bool {
        self.agent.take_cancel(&uuid).await
    }
    #[zbus(signal)]
    async fn updated(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        epoch: u64,
        revision: u64,
        json: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn secrets_requested(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        id: u64,
        metadata: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn secrets_closed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        id: u64,
        reason: &str,
    ) -> zbus::Result<()>;
}
pub async fn serve(
    session: &Connection,
    read_only: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    // Do not queue or replace another network service. Only an explicit Rust-session flag
    // reaches this function; normal TS sessiond invocations never register an NM agent.
    session
        .request_name_with_flags(NAME, zbus::fdo::RequestNameFlags::DoNotQueue.into())
        .await?;
    let system = Connection::system().await?;
    let agent = agent::Agent::new(system.clone(), session.clone());
    let network = Network {
        system: system.clone(),
        session: session.clone(),
        state: Arc::new(Mutex::new(Announced {
            epoch: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)?
                .as_micros() as u64,
            revision: 0,
            json: empty(),
            owner: String::new(),
        })),
        agent: agent.clone(),
        read_only,
        operations: Arc::new(Mutex::new(())),
    };
    session.object_server().at(PATH, network.clone()).await?;
    if !read_only {
        system
            .object_server()
            .at(agent::PATH_NM, agent.clone())
            .await?;
    }
    // Subscribe before the initial snapshot. Periodic reconciliation also covers a lost
    // signal and retries agent registration after NM/polkit startup ordering failures.
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .path_namespace(nm::ROOT)?
        .build();
    let mut stream = zbus::MessageStream::for_match_rule(rule, &system, Some(256)).await?;
    tokio::spawn(async move {
        use futures_util::StreamExt;
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        let mut registered = String::new();
        loop {
            tokio::select! {_ = tick.tick()=>{},msg=stream.next()=>{if msg.is_none(){let _=network.refresh().await;agent.withdraw("bus-disconnected").await;break;}tokio::time::sleep(Duration::from_millis(30)).await;}}
            agent.check_ui().await;
            if let Ok(nm) = Nm::current(&system).await {
                if !read_only && registered != nm.owner {
                    let result = nm
                        .call::<()>(
                            &format!("{}/AgentManager", nm::ROOT),
                            "org.freedesktop.NetworkManager.AgentManager",
                            "RegisterWithCapabilities",
                            &(agent::ID, 0u32),
                        )
                        .await;
                    if result.is_ok() {
                        registered = nm.owner;
                    }
                }
            } else {
                registered.clear();
            }
            if network.refresh().await.is_err() {
                eprintln!("[network] snapshot unavailable; retrying");
            }
        }
    });
    Ok(())
}
