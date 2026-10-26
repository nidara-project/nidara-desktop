// SPDX-License-Identifier: GPL-3.0-or-later
//! Wi-Fi-only NM secret agent. Opt-in ONLY: never start alongside the TS agent.
use super::{
    Error, IFACE, PATH, Settings, keyring,
    nm::{self, Nm, text},
};
use serde_json::json;
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::sync::{Mutex, Semaphore, oneshot};
use zbus::{Connection, message::Header, zvariant::OwnedObjectPath as Path};
pub const PATH_NM: &str = "/org/freedesktop/NetworkManager/SecretAgent";
pub const ID: &str = "org.nidara.Session.NetworkAgent";
#[derive(zbus::DBusError, Debug)]
#[zbus(prefix = "org.freedesktop.NetworkManager.SecretAgent")]
pub enum AgentError {
    #[zbus(error)]
    ZBus(zbus::Error),
    NoSecrets(String),
    UserCanceled(String),
    PermissionDenied(String),
    Failed(String),
}
pub fn supported(setting: &str) -> bool {
    matches!(setting, "802-11-wireless-security" | "802-1x")
}
pub fn secret_key(setting: &str, key: &str) -> bool {
    match setting {
        "802-11-wireless-security" => matches!(
            key,
            "psk" | "wep-key0" | "wep-key1" | "wep-key2" | "wep-key3" | "leap-password"
        ),
        "802-1x" => matches!(
            key,
            "password"
                | "password-raw"
                | "private-key-password"
                | "phase2-private-key-password"
                | "pin"
        ),
        _ => false,
    }
}
struct Pending {
    id: u64,
    path: Path,
    setting: String,
    uuid: String,
    asked: bool,
    reply: oneshot::Sender<Result<Settings, String>>,
}
#[derive(Default)]
struct State {
    ui: Option<String>,
    next: u64,
    pending: Option<Pending>,
    cancels: HashMap<String, tokio::time::Instant>,
}
#[derive(Clone)]
pub struct Agent {
    system: Connection,
    session: Connection,
    state: Arc<Mutex<State>>,
    gate: Arc<Semaphore>,
    keyring: keyring::Queue,
}
impl Agent {
    pub fn new(system: Connection, session: Connection) -> Self {
        Self {
            system,
            keyring: keyring::Queue::new(session.clone()),
            session,
            state: Arc::new(Mutex::new(State::default())),
            gate: Arc::new(Semaphore::new(1)),
        }
    }
    pub fn save_profile_secrets(&self, settings: Settings) {
        self.keyring.save_later(settings);
    }
    pub async fn delete_profile_secrets(&self, uuid: &str) -> Result<(), Error> {
        self.keyring.delete(uuid).await
    }
    async fn auth(&self, h: &Header<'_>) -> Result<(), AgentError> {
        let owner = Nm::current(&self.system)
            .await
            .map_err(|_| AgentError::PermissionDenied("NetworkManager unavailable".into()))?
            .owner;
        if h.sender().map(|s| s.as_str()) != Some(owner.as_str()) {
            return Err(AgentError::PermissionDenied(
                "only NetworkManager may call the secret agent".into(),
            ));
        }
        Ok(())
    }
    pub async fn register_ui(&self, h: &Header<'_>) -> Result<(), Error> {
        let sender = h
            .sender()
            .ok_or_else(|| Error::Denied("missing sender".into()))?
            .to_string();
        let mut state = self.state.lock().await;
        if let Some(old) = &state.ui {
            // A redundant registration by the same UI is harmless. Never replace a living UI.
            if old == &sender {
                return Ok(());
            }
            let dbus = zbus::fdo::DBusProxy::new(&self.session).await?;
            if dbus
                .name_has_owner(old.as_str().try_into().unwrap())
                .await?
            {
                let pid = dbus
                    .get_connection_unix_process_id(sender.as_str().try_into().unwrap())
                    .await
                    .unwrap_or(0);
                eprintln!("[network] refused second secrets UI registration from pid {pid}");
                return Err(Error::Denied("a secrets UI is already registered".into()));
            }
        }
        if let Some(p) = state.pending.take() {
            let _ = p.reply.send(Err("ui-disconnected".into()));
        }
        state.ui = Some(sender);
        Ok(())
    }
    async fn closed(&self, ui: Option<&str>, id: u64, why: &str) {
        if let Some(ui) = ui {
            let _ = self
                .session
                .emit_signal(Some(ui), PATH, IFACE, "SecretsClosed", &(id, why))
                .await;
        }
    }
    pub async fn withdraw(&self, why: &str) {
        let mut s = self.state.lock().await;
        let ui = s.ui.clone();
        if let Some(p) = s.pending.take() {
            let _ = p.reply.send(Err(why.into()));
            drop(s);
            self.closed(ui.as_deref(), p.id, why).await;
        }
    }
    pub async fn check_ui(&self) {
        let ui = self.state.lock().await.ui.clone();
        if let Some(ui) = ui {
            let alive = if let Ok(d) = zbus::fdo::DBusProxy::new(&self.session).await {
                d.name_has_owner(ui.as_str().try_into().unwrap())
                    .await
                    .unwrap_or(false)
            } else {
                false
            };
            if !alive {
                let mut s = self.state.lock().await;
                if s.ui.as_ref() == Some(&ui) {
                    s.ui = None;
                }
                drop(s);
                self.withdraw("ui-disconnected").await;
            }
        }
    }
    pub async fn submit(
        &self,
        h: &Header<'_>,
        id: u64,
        values: Option<Settings>,
    ) -> Result<(), Error> {
        let mut s = self.state.lock().await;
        if h.sender().map(|s| s.as_str()) != s.ui.as_deref() {
            return Err(Error::Denied("not the registered secrets UI".into()));
        }
        let p = s
            .pending
            .as_ref()
            .filter(|p| p.id == id && p.asked)
            .ok_or_else(|| Error::Invalid("stale secrets request".into()))?;
        if let Some(values) = &values {
            if values.len() != 1
                || !values.contains_key(&p.setting)
                || values[&p.setting].is_empty()
            {
                return Err(Error::Invalid(
                    "reply must contain only the requested setting".into(),
                ));
            }
            for (key, v) in &values[&p.setting] {
                if !secret_key(&p.setting, key)
                    || !(<&str>::try_from(v).is_ok()
                        || p.setting == "802-1x"
                            && key == "password-raw"
                            && Vec::<u8>::try_from(v.try_clone().unwrap()).is_ok())
                {
                    return Err(Error::Invalid("invalid secret key or type".into()));
                }
            }
        }
        let p = s.pending.take().unwrap();
        let ui = s.ui.clone();
        let why = if values.is_some() {
            "answered"
        } else {
            "cancelled"
        };
        if values.is_none() {
            s.cancels
                .retain(|_, t| t.elapsed() < Duration::from_secs(30));
            s.cancels
                .insert(p.uuid.clone(), tokio::time::Instant::now());
        }
        let _ = p.reply.send(values.ok_or_else(|| "cancelled".into()));
        drop(s);
        self.closed(ui.as_deref(), id, why).await;
        Ok(())
    }
    pub async fn take_cancel(&self, uuid: &str) -> bool {
        let mut s = self.state.lock().await;
        s.cancels
            .retain(|_, t| t.elapsed() < Duration::from_secs(30));
        s.cancels.remove(uuid).is_some()
    }
}
#[zbus::interface(name = "org.freedesktop.NetworkManager.SecretAgent")]
impl Agent {
    #[allow(clippy::too_many_arguments)] // NetworkManager's fixed wire signature.
    async fn get_secrets(
        &self,
        connection: Settings,
        connection_path: Path,
        setting_name: String,
        hints: Vec<String>,
        flags: u32,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<Settings, AgentError> {
        self.auth(&header).await?;
        if text(connection.get("connection"), "type") != "802-11-wireless"
            || !supported(&setting_name)
        {
            return Err(AgentError::NoSecrets("not a Wi-Fi secret".into()));
        }
        let _permit = self
            .gate
            .try_acquire()
            .map_err(|_| AgentError::UserCanceled("another request is pending".into()))?;
        let uuid = text(connection.get("connection"), "uuid");
        if uuid.is_empty() {
            return Err(AgentError::NoSecrets("missing UUID".into()));
        }
        let (tx, mut rx) = oneshot::channel();
        let id = {
            let mut s = self.state.lock().await;
            s.next = s
                .next
                .checked_add(1)
                .ok_or_else(|| AgentError::Failed("request ids exhausted".into()))?;
            let id = s.next;
            s.pending = Some(Pending {
                id,
                path: connection_path,
                setting: setting_name.clone(),
                uuid: uuid.clone(),
                asked: false,
                reply: tx,
            });
            id
        };
        let work = async {
            if flags & 2 == 0 {
                // A keyring error is not evidence that no password exists: ask the UI if allowed.
                let found = tokio::select! { found = self.keyring.lookup(&uuid, &setting_name) => found, _ = &mut rx => return Err(AgentError::UserCanceled("withdrawn".into())) };
                if let Ok(mut found) = found {
                    found.retain(|k, _| secret_key(&setting_name, k));
                    if !found.is_empty() {
                        return Ok(Settings::from([(setting_name.clone(), found)]));
                    }
                }
            }
            if flags & 1 == 0 {
                return Err(AgentError::NoSecrets("interaction not allowed".into()));
            }
            let mut s = self.state.lock().await;
            if s.pending.as_ref().is_none_or(|p| p.id != id) {
                return Err(AgentError::UserCanceled("withdrawn".into()));
            }
            let ui =
                s.ui.clone()
                    .ok_or_else(|| AgentError::NoSecrets("no secrets UI registered".into()))?;
            s.pending.as_mut().unwrap().asked = true;
            let meta=json!({"uuid":uuid,"name":text(connection.get("connection"),"id"),"setting":setting_name,"hints":hints,"retry":flags&2!=0,"ssid":nm::bytes(connection.get("802-11-wireless"),"ssid"),"profile":prompt_profile(&connection)}).to_string();
            self.session
                .emit_signal(
                    Some(ui.as_str()),
                    PATH,
                    IFACE,
                    "SecretsRequested",
                    &(id, meta),
                )
                .await?;
            drop(s);
            let reply = rx
                .await
                .map_err(|_| AgentError::UserCanceled("withdrawn".into()))?
                .map_err(AgentError::UserCanceled)?;
            // Save only flags marked agent-owned, preserving original request metadata.
            let mut merged = Settings::new();
            if let Some(meta) = connection.get("connection") {
                merged.insert("connection".into(), meta.clone());
            }
            for (setting, keys) in &reply {
                let mut values = keys.clone();
                // NM may include other stored secrets in its request. Persist only the
                // keys the UI actually answered, with their original storage flags.
                for key in keys.keys() {
                    let flag = if key.starts_with("wep-key") {
                        "wep-key-flags".to_string()
                    } else {
                        format!("{key}-flags")
                    };
                    if let Some(v) = connection.get(setting).and_then(|s| s.get(&flag)) {
                        values.insert(flag, v.clone());
                    }
                }
                merged.insert(setting.clone(), values);
            }
            self.keyring.save_later(merged);
            Ok(reply)
        };
        let result = tokio::time::timeout(Duration::from_secs(120), work)
            .await
            .unwrap_or_else(|_| Err(AgentError::UserCanceled("timed out".into())));
        let mut s = self.state.lock().await;
        let ui = s.ui.clone();
        if s.pending.as_ref().is_some_and(|p| p.id == id) {
            s.pending = None;
            drop(s);
            self.closed(
                ui.as_deref(),
                id,
                if result.is_ok() {
                    "answered"
                } else {
                    "withdrawn"
                },
            )
            .await;
        }
        result
    }
    async fn cancel_get_secrets(
        &self,
        connection_path: Path,
        setting_name: String,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), AgentError> {
        self.auth(&header).await?;
        let matches = self
            .state
            .lock()
            .await
            .pending
            .as_ref()
            .is_some_and(|p| p.path == connection_path && p.setting == setting_name);
        if matches {
            self.withdraw("nm-cancelled").await;
        }
        Ok(())
    }
    async fn save_secrets(
        &self,
        connection: Settings,
        _connection_path: Path,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), AgentError> {
        self.auth(&header).await?;
        self.keyring
            .save(connection)
            .await
            .map_err(|_| AgentError::Failed("keyring store failed".into()))
    }
    async fn delete_secrets(
        &self,
        connection: Settings,
        _connection_path: Path,
        #[zbus(header)] header: Header<'_>,
    ) -> Result<(), AgentError> {
        self.auth(&header).await?;
        let uuid = text(connection.get("connection"), "uuid");
        if uuid.is_empty() {
            return Err(AgentError::NoSecrets("missing UUID".into()));
        }
        self.keyring
            .delete(&uuid)
            .await
            .map_err(|_| AgentError::Failed("keyring deletion failed".into()))
    }
}

/// Only non-secret fields needed to select a personal/WEP/EAP prompt. Never serialize
/// NetworkManager's full GetSecrets input: it may already contain system-owned secrets.
fn prompt_profile(s: &Settings) -> serde_json::Value {
    let fields = [
        ("connection", &["id", "uuid", "type"][..]),
        ("802-11-wireless", &["ssid", "hidden"][..]),
        (
            "802-11-wireless-security",
            &[
                "key-mgmt",
                "auth-alg",
                "wep-tx-keyidx",
                "wep-key-type",
                "psk-flags",
                "wep-key-flags",
                "leap-username",
                "leap-password-flags",
            ][..],
        ),
        (
            "802-1x",
            &[
                "eap",
                "identity",
                "anonymous-identity",
                "phase2-auth",
                "phase2-autheap",
                "ca-cert",
                "client-cert",
                "phase2-ca-cert",
                "phase2-client-cert",
                "password-flags",
                "private-key-password-flags",
                "phase2-private-key-password-flags",
                "pin-flags",
            ][..],
        ),
    ];
    let mut out = serde_json::Map::new();
    for (setting, keys) in fields {
        if let Some(p) = s.get(setting) {
            out.insert(
                setting.into(),
                serde_json::Value::Object(
                    keys.iter()
                        .filter(|k| p.contains_key(**k))
                        .map(|k| (k.to_string(), nm::json_prop(p, k)))
                        .collect(),
                ),
            );
        }
    }
    serde_json::Value::Object(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_never_serializes_system_secrets() {
        let s = Settings::from([
            (
                "802-1x".into(),
                nm::Props::from([
                    ("identity".into(), nm::owned("person")),
                    ("password".into(), nm::owned("never-expose")),
                ]),
            ),
            (
                "802-11-wireless-security".into(),
                nm::Props::from([("psk".into(), nm::owned("never-expose"))]),
            ),
        ]);
        let json = prompt_profile(&s).to_string();
        assert!(json.contains("person"));
        assert!(!json.contains("never-expose"));
    }
}
