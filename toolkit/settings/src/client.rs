// SPDX-License-Identifier: LGPL-3.0-or-later
//! The transport of `org.nidara.Config1`: reports what arrives as [`Raw`] and carries out the
//! [`Command`]s of the [`Session`], which holds every rule (`session.rs`).
//!
//! One bus connection for everything (PHASE1.md [A1]: the trusted check is "the sender owns
//! `org.nidara.SettingsNative`", per call, so the calls must leave from the connection that
//! owns it). Subscriptions are installed before the first `Snapshot`; each signal stream has a
//! thread that only forwards, so a slow call never holds an announcement back, and each
//! `Apply` runs on a thread of its own, so a slow key never holds another.

use crate::session::{ApplyError, Command, Notice, Raw, Session};
use crate::value::Value;
use std::collections::HashMap;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::time::{Duration, Instant};
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::OwnedValue;

pub const NAME: &str = "org.nidara.Config";
pub const PATH: &str = "/org/nidara/Config";
pub const INTERFACE: &str = "org.nidara.Config1";
const ERROR: &str = "org.nidara.Config1.Error.";

/// A D-Bus call has a deadline and an error state (PHASE1.md, start-up): past it the write is
/// reported failed, and a snapshot is an error shown.
pub const CALL_DEADLINE: Duration = Duration::from_secs(3);

pub struct Client {
    connection: Connection,
    session: Session,
    raw: Receiver<Raw>,
    raw_tx: Sender<Raw>,
}

impl Client {
    /// On the session bus, with the call deadline.
    pub fn connect() -> Result<Self, String> {
        let connection = zbus::blocking::connection::Builder::session()
            .and_then(|b| b.method_timeout(CALL_DEADLINE).build())
            .map_err(|e| format!("session bus: {e}"))?;
        Self::start(connection)
    }

    /// On a connection the app already holds — the one that owns its bus names.
    pub fn start(connection: Connection) -> Result<Self, String> {
        let config = proxy(&connection)?;
        let (raw_tx, raw) = mpsc::channel();
        let updated = config
            .receive_signal("Updated")
            .map_err(|e| format!("Config1 Updated: {e}"))?;
        let owner = config
            .receive_owner_changed()
            .map_err(|e| format!("Config1 owner: {e}"))?;
        let tx = raw_tx.clone();
        std::thread::Builder::new()
            .name("config1-updated".into())
            .spawn(move || {
                for message in updated {
                    let Ok((epoch, revision, values)) =
                        message
                            .body()
                            .deserialize::<(u64, u64, HashMap<String, OwnedValue>)>()
                    else {
                        continue;
                    };
                    let values = values
                        .into_iter()
                        .filter_map(|(k, v)| Some((k, Value::from_variant(&v)?)))
                        .collect();
                    let raw = Raw::Updated {
                        epoch,
                        revision,
                        values,
                    };
                    if tx.send(raw).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let tx = raw_tx.clone();
        std::thread::Builder::new()
            .name("config1-owner".into())
            .spawn(move || {
                for owner in owner {
                    if tx.send(Raw::Owner(owner.is_some())).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        let (session, first) = Session::start();
        let client = Self {
            connection,
            session,
            raw,
            raw_tx,
        };
        client.run(first);
        Ok(client)
    }

    pub fn connection(&self) -> &Connection {
        &self.connection
    }

    pub fn session(&self) -> &Session {
        &self.session
    }

    /// Everything that arrived since the last call, applied; never blocks.
    pub fn poll(&mut self) -> Vec<Notice> {
        let mut notices = Vec::new();
        while let Ok(raw) = self.raw.try_recv() {
            self.feed(raw, &mut notices);
        }
        notices
    }

    /// Blocks until something arrives or `deadline` passes, then as `poll`. For start-up, which
    /// waits for the first snapshot, and for tests.
    pub fn wait(&mut self, deadline: Instant) -> Vec<Notice> {
        let mut notices = Vec::new();
        match self
            .raw
            .recv_timeout(deadline.saturating_duration_since(Instant::now()))
        {
            Ok(raw) => self.feed(raw, &mut notices),
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => {}
        }
        notices.extend(self.poll());
        notices
    }

    /// Change a key through the service (the control's own path; `Session::apply` says when it
    /// is sent).
    pub fn apply(&mut self, key: &str, value: Value) -> Result<(), ApplyError> {
        if let Some(command) = self.session.apply(key, value)? {
            self.run(command);
        }
        Ok(())
    }

    fn feed(&mut self, raw: Raw, notices: &mut Vec<Notice>) {
        let (n, commands) = self.session.handle(raw);
        notices.extend(n);
        for c in commands {
            self.run(c);
        }
    }

    fn run(&self, command: Command) {
        let connection = self.connection.clone();
        let tx = self.raw_tx.clone();
        // No thread, no call: said as the call's own failure, never swallowed.
        match command {
            Command::Snapshot => {
                let spawned = std::thread::Builder::new()
                    .name("config1-snapshot".into())
                    .spawn(move || {
                        let result = proxy(&connection).and_then(|p| {
                            p.call::<_, _, (u64, u64, String)>("Snapshot", &())
                                .map_err(|e| format!("Config1 Snapshot: {e}"))
                        });
                        let _ = tx.send(Raw::Snapshot(result));
                    });
                if let Err(e) = spawned {
                    let _ = self
                        .raw_tx
                        .send(Raw::Snapshot(Err(format!("no thread for Snapshot: {e}"))));
                }
            }
            Command::Apply { key, value, epoch } => {
                let k = key.clone();
                let spawned = std::thread::Builder::new()
                    .name("config1-apply".into())
                    .spawn(move || {
                        let result = apply(&connection, &key, &value);
                        let _ = tx.send(Raw::Reply { key, epoch, result });
                    });
                if let Err(e) = spawned {
                    let _ = self.raw_tx.send(Raw::Reply {
                        key: k,
                        epoch,
                        result: Err(ApplyError::Failed(format!("no thread for Apply: {e}"))),
                    });
                }
            }
        }
    }
}

fn apply(connection: &Connection, key: &str, value: &Value) -> Result<(u64, Value), ApplyError> {
    let (revision, canonical) = proxy(connection)
        .map_err(ApplyError::Failed)?
        .call::<_, _, (u64, OwnedValue)>("Apply", &(key, value.to_variant()))
        .map_err(apply_error)?;
    let canonical = Value::from_variant(&canonical)
        .ok_or_else(|| ApplyError::Failed("Apply answered no value".into()))?;
    Ok((revision, canonical))
}

fn proxy(connection: &Connection) -> Result<Proxy<'static>, String> {
    Proxy::new(connection, NAME, PATH, INTERFACE).map_err(|e| format!("Config1 proxy: {e}"))
}

fn apply_error(e: zbus::Error) -> ApplyError {
    if let zbus::Error::MethodError(name, message, _) = &e {
        let message = message.clone().unwrap_or_default();
        match name.as_str().strip_prefix(ERROR) {
            Some("Invalid") => return ApplyError::Invalid(message),
            Some("Denied") => return ApplyError::Denied(message),
            Some("Failed") => return ApplyError::Failed(message),
            _ => {}
        }
        match name.as_str() {
            // No owner, or it left mid-call, or the deadline: the reply never came.
            "org.freedesktop.DBus.Error.NoReply"
            | "org.freedesktop.DBus.Error.ServiceUnknown"
            | "org.freedesktop.DBus.Error.NameHasNoOwner"
            | "org.freedesktop.DBus.Error.Timeout" => return ApplyError::NoReply,
            _ => {}
        }
    }
    match e {
        zbus::Error::InputOutput(_) => ApplyError::NoReply,
        e => ApplyError::Failed(e.to_string()),
    }
}
