// SPDX-License-Identifier: LGPL-3.0-or-later
//! One bounded worker owns the lease connection. UI, bus subscriptions and workers
//! never mutate each other's widgets. Closing/unmounting closes this connection,
//! including a Preview whose reply arrives after the page has gone.
use super::model::*;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
    mpsc,
};
use std::time::Duration;
use zbus::blocking::{Connection, Proxy};
pub const NAME: &str = "org.nidara.Display";
pub const PATH: &str = "/org/nidara/Display";
pub const IFACE: &str = "org.nidara.Display1";
const BRIGHT: &str = "org.nidara.DisplayBrightness1";
const BRIGHT_PATH: &str = "/org/nidara/DisplayBrightness";
#[derive(Clone, Debug, Default)]
pub struct State {
    pub owner: String,
    pub snapshot: Option<Snapshot>,
    pub brightness: Option<Brightness>,
    pub owned: Option<Pending>,
    pub error: Option<String>,
}
#[derive(Clone, Debug)]
pub enum Command {
    Refresh,
    Preview {
        owner: String,
        epoch: u64,
        revision: u64,
        layout: Layout,
    },
    Confirm(String),
    Cancel,
    Identify {
        owner: String,
        epoch: u64,
        revision: u64,
    },
    Brightness {
        generation: u64,
        id: String,
        epoch: u64,
        value: u32,
    },
}
pub struct Client {
    connection: Option<Connection>,
    brightness: Arc<std::sync::Mutex<std::collections::BTreeMap<(u64, String), Command>>>,
    tx: mpsc::SyncSender<Command>,
    rx: mpsc::Receiver<State>,
    closed: Arc<AtomicBool>,
    pub notified: Arc<AtomicBool>,
}
fn proxy<'a>(
    conn: &Connection,
    name: &'a str,
    path: &'a str,
    iface: &'a str,
) -> Result<Proxy<'a>, String> {
    Proxy::new(conn, name, path, iface).map_err(|e| e.to_string())
}
fn owner(conn: &Connection, name: &str) -> Result<String, String> {
    zbus::blocking::fdo::DBusProxy::new(conn)
        .and_then(|p| Ok(p.get_name_owner(name.try_into().unwrap())?))
        .map(|s| s.to_string())
        .map_err(|e| e.to_string())
}
fn read(conn: &Connection, state: &mut State) -> Result<(), String> {
    let name = owner(conn, NAME)?;
    let snapshot: Snapshot = proxy(conn, &name, PATH, IFACE)?
        .call("GetState", &())
        .map_err(|e| e.to_string())?;
    if snapshot.outputs.len() > 64 || owner(conn, NAME)? != name {
        return Err("display owner/inventory changed".into());
    }
    if state.owner != name {
        state.owned = None;
    }
    if let Some(owned) = &state.owned {
        if owned.token != snapshot.pending.token {
            state.owned = None;
        } else {
            state.owned = Some(snapshot.pending.clone());
        }
    }
    state.owner = name;
    state.snapshot = Some(snapshot);
    // Optional brightness observation must not consume an active confirmation
    // lease's response budget. The compact view has no brightness controls.
    if state.owned.is_none()
        && state
            .snapshot
            .as_ref()
            .is_some_and(|s| s.pending.token.is_empty())
    {
        state.brightness = owner(conn, "org.nidara.Session").ok().and_then(|name| {
            proxy(conn, &name, BRIGHT_PATH, BRIGHT)
                .ok()?
                .call("GetState", &())
                .ok()
        });
    }
    Ok(())
}
struct Startup(Option<Connection>);
impl Drop for Startup {
    fn drop(&mut self) {
        if let Some(conn) = self.0.take() {
            let _ = conn.close();
        }
    }
}
impl Client {
    pub fn connect() -> Result<Self, String> {
        let conn = zbus::blocking::connection::Builder::session()
            .and_then(|b| b.method_timeout(Duration::from_secs(10)).build())
            .map_err(|e| e.to_string())?;
        Self::start(conn)
    }
    /// Takes a dedicated connection; closing this client must not close Config1's.
    pub fn start(conn: Connection) -> Result<Self, String> {
        let mut startup = Startup(Some(conn.clone()));
        let (tx, commands) = mpsc::sync_channel(16);
        let (updates, rx) = mpsc::channel();
        let brightness = Arc::new(std::sync::Mutex::new(std::collections::BTreeMap::new()));
        let latest = brightness.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let notified = Arc::new(AtomicBool::new(false));
        // Subscribe before GetState. Each iterator is ended by closing this dedicated
        // connection on worker exit, so page lifetimes do not leak subscription threads.
        for (name, path, iface) in [
            (NAME, PATH, IFACE),
            ("org.nidara.Session", BRIGHT_PATH, BRIGHT),
        ] {
            let p = proxy(&conn, name, path, iface)?;
            let changed = p.receive_signal("Changed").map_err(|e| e.to_string())?;
            let owners = p.receive_owner_changed().map_err(|e| e.to_string())?;
            let wake = tx.clone();
            std::thread::spawn(move || {
                for _ in changed {
                    if wake.try_send(Command::Refresh).is_err()
                        && wake.send(Command::Refresh).is_err()
                    {
                        break;
                    }
                }
            });
            let wake = tx.clone();
            std::thread::spawn(move || {
                for _ in owners {
                    if wake.send(Command::Refresh).is_err() {
                        break;
                    }
                }
            });
        }
        let dedicated = conn.clone();
        let stop = closed.clone();
        let notice = notified.clone();
        std::thread::Builder::new()
            .name("settings-display".into())
            .spawn(move || {
                let mut state = State::default();
                let mut logged = None;
                let mut action_error = None;
                let mut command = Some(Command::Refresh);
                while !stop.load(Ordering::Acquire) {
                    let pending = {
                        latest
                            .lock()
                            .unwrap()
                            .pop_first()
                            .map(|(_, command)| command)
                    };
                    let cmd = pending
                        .or_else(|| command.take())
                        .or_else(|| commands.recv_timeout(Duration::from_millis(100)).ok());
                    let Some(cmd) = cmd else {
                        continue;
                    };
                    let is_refresh = matches!(&cmd, Command::Refresh);
                    let mut uncertain_preview = false;
                    let result = (|| -> Result<(), String> {
                        match cmd {
                            Command::Refresh => {}
                            Command::Preview {
                                owner: expected,
                                epoch,
                                revision,
                                layout,
                            } => {
                                if owner(&conn, NAME)? != expected || state.owned.is_some() {
                                    return Err("stale/busy display draft".into());
                                }
                                let p = proxy(&conn, &expected, PATH, IFACE)?;
                                let validated: Layout = p
                                    .call("Validate", &(epoch, revision, layout))
                                    .map_err(|e| e.to_string())?;
                                uncertain_preview = true;
                                let pending: Pending = p
                                    .call("Preview", &(epoch, revision, validated))
                                    .map_err(|e| e.to_string())?;
                                uncertain_preview = false;
                                state.owned = Some(pending);
                            }
                            Command::Confirm(token) => {
                                let pending = state
                                    .owned
                                    .as_ref()
                                    .filter(|p| {
                                        p.token == token
                                            && p.phase == "confirming"
                                            && seconds(p.deadline_us, now_us()) > 0
                                    })
                                    .ok_or("stale confirmation")?;
                                if owner(&conn, NAME)? != state.owner {
                                    return Err("display owner changed".into());
                                }
                                proxy(&conn, &state.owner, PATH, IFACE)?
                                    .call::<_, _, ()>("Confirm", &(pending.token.clone(),))
                                    .map_err(|e| e.to_string())?;
                                state.owned = None;
                            }
                            Command::Cancel => {
                                if let Some(pending) = state.owned.clone() {
                                    proxy(&conn, &state.owner, PATH, IFACE)?
                                        .call::<_, _, ()>("Cancel", &(pending.token,))
                                        .map_err(|e| e.to_string())?;
                                    state.owned = None;
                                }
                            }
                            Command::Identify {
                                owner: expected,
                                epoch,
                                revision,
                            } => {
                                if owner(&conn, NAME)? != expected {
                                    return Err("display owner changed".into());
                                }
                                proxy(&conn, &expected, PATH, IFACE)?
                                    .call::<_, _, ()>("Identify", &(epoch, revision))
                                    .map_err(|e| e.to_string())?;
                            }
                            Command::Brightness {
                                generation,
                                id,
                                epoch,
                                value,
                            } => {
                                let name = owner(&conn, "org.nidara.Session")?;
                                let p = proxy(&conn, &name, BRIGHT_PATH, BRIGHT)?;
                                let current: Brightness =
                                    p.call("GetState", &()).map_err(|e| e.to_string())?;
                                if current.generation != generation
                                    || !current.devices.iter().any(|d| {
                                        d.id == id && d.epoch == epoch && d.available && d.writable
                                    })
                                {
                                    return Err("stale brightness channel".into());
                                }
                                p.call::<_, _, Device>("SetBrightness", &(id, epoch, value))
                                    .map_err(|e| e.to_string())?;
                            }
                        }
                        Ok(())
                    })();
                    if !is_refresh {
                        action_error = result.err();
                    }
                    state.error = action_error.clone();
                    if uncertain_preview {
                        state.snapshot = None;
                        state.owner.clear();
                    } else if let Err(error) = read(&conn, &mut state) {
                        state.snapshot = None;
                        state.owner.clear();
                        state.owned = None;
                        state.error = Some(error);
                    }
                    if state.error != logged {
                        if let Some(error) = &state.error {
                            eprintln!("DISPLAY_ERROR {error}");
                        }
                        logged = state.error.clone();
                    }
                    notice.store(true, Ordering::Release);
                    if updates.send(state.clone()).is_err() || uncertain_preview {
                        break;
                    }
                }
                if let Some(pending) = state.owned {
                    let _ = proxy(&conn, &state.owner, PATH, IFACE).and_then(|p| {
                        p.call::<_, _, ()>("Cancel", &(pending.token,))
                            .map_err(|e| e.to_string())
                    });
                }
                let _ = conn.close();
            })
            .map_err(|e| e.to_string())?;
        startup.0 = None;
        Ok(Self {
            connection: Some(dedicated),
            brightness,
            tx,
            rx,
            closed,
            notified,
        })
    }
    pub fn send(&self, command: Command) -> Result<(), String> {
        if let Command::Brightness {
            generation, ref id, ..
        } = command
        {
            let key = (generation, id.clone());
            let mut latest = self.brightness.lock().unwrap();
            if latest.len() >= 64 && !latest.contains_key(&key) {
                return Err("too many pending brightness channels".into());
            }
            latest.insert(key, command);
            drop(latest);
            match self.tx.try_send(Command::Refresh) {
                Ok(()) | Err(mpsc::TrySendError::Full(_)) => Ok(()),
                Err(error) => Err(error.to_string()),
            }
        } else {
            self.tx.try_send(command).map_err(|e| e.to_string())
        }
    }
    pub fn poll(&self) -> Option<State> {
        self.notified.store(false, Ordering::Release);
        self.rx.try_iter().last()
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Release);
        if let Some(conn) = self.connection.take() {
            let _ = conn.close();
        }
    }
}
