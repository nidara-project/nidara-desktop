// SPDX-License-Identifier: GPL-3.0-or-later
//! `org.nidara.Config1`, the settings on the session bus (toolkit/PHASE1.md D1, revision 3:
//! the first service of the Rust session). The same interface, members and rules as the
//! TypeScript shell's (`ui/shell/core/ConfigService.ts`), so a client does not tell them
//! apart:
//!
//! - `Snapshot() → (t epoch, t revision, s schema)`, `Apply(s, v) → (t revision, v canonical)`,
//!   `Updated(t, t, a{sv})`; `Describe`/`Get`/`Set`/`Changed` kept for older clients.
//! - `epoch` is this process's start (wall-clock µs); `revision` grows by one per announced
//!   batch. Only real changes are announced, coalesced per scheduler turn.
//! - Writes authenticate the unique sender's Linux process using nidara-access.
//!   Authorized installed Settings writes freely; external callers require computer
//!   control AND allowConfigWrite. Owning SettingsNative grants no privilege.
//!
//! Served only on request (`nidara-sessiond --config`): in a session where the TypeScript
//! shell serves the name, this does not compete for it.

mod followers;
pub mod registry;
mod store;

use nidara_access::{Operation, Peer};
use registry::{Refusal, Value};
use std::collections::HashMap;
use std::sync::Arc;
use store::{Changes, Handle};
use tokio::sync::Mutex;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::{OwnedValue, Value as Variant};
use zbus::{Connection, message::Header};

pub const NAME: &str = "org.nidara.Config";
pub const PATH: &str = "/org/nidara/Config";
const SCHEMA_VERSION: u64 = 1;

#[derive(zbus::DBusError, Debug)]
#[zbus(prefix = "org.nidara.Config1.Error")]
pub enum ConfigError {
    #[zbus(error)]
    ZBus(zbus::Error),
    AccessDenied(String),
    Invalid(String),
    Failed(String),
}

struct Announced {
    epoch: u64,
    revision: u64,
    sent: HashMap<String, Value>,
}

pub struct Config1 {
    store: Handle,
    changes: Arc<Changes>,
    announced: Arc<Mutex<Announced>>,
    peers: Arc<Mutex<HashMap<String, Arc<Peer>>>>,
}

fn variant(v: &Value) -> OwnedValue {
    match v {
        Value::Bool(b) => OwnedValue::from(*b),
        Value::Number(n) => OwnedValue::from(*n),
        Value::Text(s) => {
            OwnedValue::try_from(Variant::from(s.as_str())).expect("a string is a value")
        }
    }
}
/// The text the registry parses (`setConfigValue(key, String(value))`).
fn raw(v: &Variant<'_>) -> String {
    match v {
        Variant::Bool(b) => b.to_string(),
        Variant::F64(n) => n.to_string(),
        Variant::I32(n) => n.to_string(),
        Variant::U32(n) => n.to_string(),
        Variant::I64(n) => n.to_string(),
        Variant::U64(n) => n.to_string(),
        Variant::I16(n) => n.to_string(),
        Variant::U16(n) => n.to_string(),
        Variant::U8(n) => n.to_string(),
        Variant::Str(s) => s.to_string(),
        Variant::Value(inner) => raw(inner),
        other => other.to_string(),
    }
}

/// The batch heard since the last one, announced if anything really changed.
async fn flush(
    changes: &Changes,
    announced: &Mutex<Announced>,
    emitter: &SignalEmitter<'_>,
) -> zbus::Result<()> {
    let mut a = announced.lock().await;
    let mut values: HashMap<String, OwnedValue> = HashMap::new();
    for (key, value) in changes.take() {
        if a.sent.get(&key) == Some(&value) {
            continue;
        }
        values.insert(key.clone(), variant(&value));
        a.sent.insert(key, value);
    }
    if values.is_empty() {
        return Ok(());
    }
    a.revision += 1;
    let (epoch, revision) = (a.epoch, a.revision);
    drop(a);
    Config1::changed(emitter, values.clone()).await?;
    Config1::updated(emitter, epoch, revision, values).await
}

impl Config1 {
    async fn write(
        &self,
        header: &Header<'_>,
        connection: &Connection,
        key: String,
        value: &Variant<'_>,
    ) -> Result<Value, ConfigError> {
        let sender = header
            .sender()
            .ok_or_else(|| ConfigError::AccessDenied("missing unique sender".into()))?;
        let cached = self.peers.lock().await.get(sender.as_str()).cloned();
        let peer = if let Some(peer) = cached {
            peer
        } else {
            let dbus = zbus::fdo::DBusProxy::new(connection).await.map_err(|e| {
                ConfigError::AccessDenied(format!("credential service unavailable: {e}"))
            })?;
            let credentials = dbus
                .get_connection_credentials(sender.clone().into())
                .await
                .map_err(|e| {
                    ConfigError::AccessDenied(format!("caller credentials unavailable: {e}"))
                })?;
            let pid = credentials
                .process_id()
                .ok_or_else(|| ConfigError::AccessDenied("caller PID unavailable".into()))?;
            let uid = credentials
                .unix_user_id()
                .ok_or_else(|| ConfigError::AccessDenied("caller UID unavailable".into()))?;
            let peer = Peer::from_credentials(pid, uid).map_err(|e| {
                ConfigError::AccessDenied(format!("caller identity unavailable: {e}"))
            })?;
            let peer = Arc::new(peer);
            let mut peers = self.peers.lock().await;
            if peers.len() >= 256 {
                peers.clear();
            }
            peers.insert(sender.to_string(), peer.clone());
            peer
        };
        let raw = raw(value);
        let changes = self.changes.clone();
        self.store
            .call(move |st| {
                let consent = registry::consent(st);
                // The shell may write the dock's own keys (its dock menu), never the rest.
                peer.authorize(Operation::Configure, consent)
                    .or_else(|e| {
                        if key.starts_with("dock.") {
                            peer.authorize(Operation::ConfigureDock, consent)
                        } else {
                            Err(e)
                        }
                    })
                    .map_err(ConfigError::AccessDenied)?;
                let before = registry::find(&key)
                    .filter(|k| registry::available(st, k))
                    .map(|k| registry::get(st, k));
                let result = registry::set(st, &key, &raw);
                if registry::idle_field(&key).is_some()
                    && let Some(k) = registry::find(&key)
                    && registry::available(st, k)
                {
                    let after = registry::get(st, k);
                    if before.as_ref() != Some(&after) {
                        changes.push(&key, after);
                    }
                }
                result.map_err(|r| match r {
                    Refusal::Invalid(e) => ConfigError::Invalid(e),
                    Refusal::Failed(e) => ConfigError::Failed(e),
                })
            })
            .await
    }
}

#[zbus::interface(name = "org.nidara.Config1")]
impl Config1 {
    async fn describe(&self) -> String {
        self.store
            .call(|st| registry::describe(st).to_string())
            .await
    }
    async fn get(&self, keys: Vec<String>) -> zbus::fdo::Result<HashMap<String, OwnedValue>> {
        let values = self
            .store
            .call(move |st| -> Result<Vec<(String, Value)>, String> {
                let names: Vec<String> = if keys.is_empty() {
                    registry::keys()
                        .iter()
                        .filter(|k| registry::available(st, k))
                        .map(|k| k.name.to_owned())
                        .collect()
                } else {
                    keys
                };
                names
                    .into_iter()
                    .map(|name| {
                        let key = registry::find(&name)
                            .filter(|k| registry::available(st, k))
                            .ok_or_else(|| format!("unknown key: {name} — try `describeConfig`"))?;
                        Ok((name, registry::get(st, key)))
                    })
                    .collect()
            })
            .await
            .map_err(zbus::fdo::Error::Failed)?;
        Ok(values
            .iter()
            .map(|(k, v)| (k.clone(), variant(v)))
            .collect())
    }
    async fn set(
        &self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
        key: String,
        value: OwnedValue,
    ) -> Result<(), ConfigError> {
        self.write(&header, connection, key, &value).await?;
        flush(&self.changes, &self.announced, &emitter).await?;
        Ok(())
    }
    /// The schema with values at exactly the revision it answers: the changes heard so far
    /// are announced first.
    async fn snapshot(
        &self,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<(u64, u64, String)> {
        flush(&self.changes, &self.announced, &emitter)
            .await
            .map_err(|e| zbus::fdo::Error::Failed(e.to_string()))?;
        let a = self.announced.lock().await;
        let keys = self.store.call(registry::describe).await;
        let schema = serde_json::json!({"schemaVersion": SCHEMA_VERSION, "keys": keys});
        Ok((a.epoch, a.revision, schema.to_string()))
    }
    /// `Set`, answering the revision that includes the change and the value in force after
    /// it (canonical: rounded, a URI made a path). A no-op answers the current revision.
    async fn apply(
        &self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
        key: String,
        value: OwnedValue,
    ) -> Result<(u64, OwnedValue), ConfigError> {
        let canonical = self.write(&header, connection, key, &value).await?;
        flush(&self.changes, &self.announced, &emitter).await?;
        let revision = self.announced.lock().await.revision;
        Ok((revision, variant(&canonical)))
    }
    #[zbus(signal)]
    async fn changed(
        emitter: &SignalEmitter<'_>,
        values: HashMap<String, OwnedValue>,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn updated(
        emitter: &SignalEmitter<'_>,
        epoch: u64,
        revision: u64,
        values: HashMap<String, OwnedValue>,
    ) -> zbus::Result<()>;
}

/// Serve `Config1` on `conn`; false if somebody else already owns the name (the TypeScript
/// shell, in its session), which is not an error of the daemon's.
pub async fn serve(conn: &Connection) -> zbus::Result<bool> {
    let changes = Arc::new(Changes::default());
    let store = store::spawn(changes.clone());
    let epoch = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_micros() as u64);
    // What is in force now is not a change.
    let sent = store
        .call(|st| {
            registry::keys()
                .iter()
                .filter(|k| registry::available(st, k))
                .map(|k| (k.name.to_owned(), registry::get(st, k)))
                .collect::<HashMap<_, _>>()
        })
        .await;
    changes.take();
    let announced = Arc::new(Mutex::new(Announced {
        epoch,
        revision: 0,
        sent,
    }));
    let peers = Arc::new(Mutex::new(HashMap::new()));
    conn.object_server()
        .at(
            PATH,
            Config1 {
                store: store.clone(),
                changes: changes.clone(),
                announced: announced.clone(),
                peers: peers.clone(),
            },
        )
        .await?;
    let owned = matches!(
        conn.request_name_with_flags(NAME, zbus::fdo::RequestNameFlags::DoNotQueue.into())
            .await,
        Ok(zbus::fdo::RequestNameReply::PrimaryOwner)
    );
    if !owned {
        eprintln!("[config] {NAME} is served by somebody else — not serving it");
        conn.object_server().remove::<Config1, _>(PATH).await?;
        return Ok(false);
    }
    followers::start(store.clone(), changes.clone());
    // Only kernel-pinned process credentials are cached, never executable privilege.
    // Drop entries as unique names disappear. authorize() rechecks local identity per write.
    let dbus = zbus::fdo::DBusProxy::new(conn).await?;
    let mut owners = dbus.receive_name_owner_changed().await?;
    tokio::spawn(async move {
        use futures_util::StreamExt;
        while let Some(signal) = owners.next().await {
            if let Ok(args) = signal.args()
                && args.name().as_str().starts_with(':')
                && args.new_owner().is_none()
            {
                peers.lock().await.remove(args.name().as_str());
            }
        }
    });
    // Announce what the homes heard, once per scheduler turn: one write to dconf can touch
    // several keys at once.
    let emitter = SignalEmitter::new(conn, PATH)?.into_owned();
    tokio::spawn(async move {
        loop {
            changes.notify.notified().await;
            tokio::task::yield_now().await;
            if let Err(e) = flush(&changes, &announced, &emitter).await {
                eprintln!("[config] announcing: {e}");
            }
        }
    });
    eprintln!("[config] serving {NAME}");
    Ok(true)
}
