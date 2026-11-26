// SPDX-License-Identifier: LGPL-3.0-or-later
//! Authentication agent for the local Hyalo session. Only polkitd can request UI.
mod conversation;
mod view;

use super::{Slot, SlotKind};
use crate::shell1::Status;
use futures_lite::{StreamExt, future};
use std::{
    collections::HashMap,
    ffi::CString,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    time::Duration,
};
use zbus::{
    Connection, Proxy,
    fdo::DBusProxy,
    message::Header,
    names::BusName,
    zvariant::{OwnedObjectPath, OwnedValue, Value},
};

const NAME: &str = "org.freedesktop.PolicyKit1";
const AUTHORITY: &str = "/org/freedesktop/PolicyKit1/Authority";
const AUTHORITY_INTERFACE: &str = "org.freedesktop.PolicyKit1.Authority";
const AGENT: &str = "/org/nidara/PolicyKit1/AuthenticationAgent";
const RETRY: Duration = Duration::from_secs(15);

type Subject<'a> = (&'static str, HashMap<&'static str, Value<'a>>);
type Identities = Vec<(String, HashMap<String, OwnedValue>)>;

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.freedesktop.PolicyKit1.Error")]
enum Error {
    Failed(String),
    Cancelled(String),
    NotAuthorized(String),
}

fn cancelled() -> Error {
    Error::Cancelled("Authentication was cancelled".into())
}

struct Request {
    action: String,
    message: String,
    icon: String,
    details: Vec<(String, String)>,
    identities: Vec<u32>,
    ticket: Arc<Ticket>,
    generation: usize,
}

struct Ticket {
    cookie: CString,
    cancelled: AtomicBool,
}

impl Drop for Ticket {
    fn drop(&mut self) {
        for byte in &mut std::mem::take(&mut self.cookie).into_bytes_with_nul() {
            // SAFETY: byte is an exclusive reference into the owned cookie buffer.
            unsafe { std::ptr::write_volatile(byte, 0) };
        }
    }
}

impl Ticket {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
    }

    fn valid(&self, status: &Status, generation: usize) -> bool {
        !self.cancelled.load(Ordering::Acquire) && status.unlocked_generation() == Some(generation)
    }
}

fn plain(text: &str, limit: usize) -> String {
    text.chars()
        .filter(|c| {
            !c.is_control() && !matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .take(limit)
        .collect()
}

fn users(identities: Identities) -> Vec<u32> {
    let mut users = Vec::new();
    for (kind, values) in identities.into_iter().take(128) {
        if kind == "unix-user"
            && let Some(uid) = values.get("uid").and_then(|uid| u32::try_from(uid).ok())
            && !users.contains(&uid)
        {
            users.push(uid);
        }
    }
    users
}

struct Job(Request, async_channel::Sender<Result<(), Error>>);

#[derive(Default)]
struct State {
    owner: Option<String>,
    pending: Option<Arc<Ticket>>,
}

#[derive(Clone)]
struct Agent {
    state: Arc<Mutex<State>>,
    status: Arc<Status>,
    uid: u32,
    jobs: mpsc::Sender<Job>,
}

// Reset even on transport failure during registration or name-owner subscription.
struct Registered(Arc<Mutex<State>>);

impl Drop for Registered {
    fn drop(&mut self) {
        let mut state = self.0.lock().unwrap();
        state.owner = None;
        if let Some(ticket) = &state.pending {
            ticket.cancel();
        }
    }
}

impl Agent {
    async fn checked_sender(
        &self,
        header: Header<'_>,
        connection: &Connection,
    ) -> Result<String, Error> {
        let denied = || Error::NotAuthorized("The caller is not the polkit authority".into());
        let sender = header.sender().ok_or_else(denied)?;
        let bus = DBusProxy::new(connection).await.map_err(|_| denied())?;
        let owner = bus
            .get_name_owner(BusName::try_from(NAME).unwrap())
            .await
            .map_err(|_| denied())?;
        if owner.as_str() != sender.as_str() {
            return Err(denied());
        }
        let credentials = bus
            .get_connection_credentials(BusName::from(owner.clone()))
            .await
            .map_err(|_| denied())?;
        if credentials.unix_user_id() != Some(self.uid) {
            return Err(denied());
        }
        Ok(owner.to_string())
    }
}

#[zbus::interface(name = "org.freedesktop.PolicyKit1.AuthenticationAgent")]
impl Agent {
    #[allow(clippy::too_many_arguments)] // The polkit D-Bus signature.
    async fn begin_authentication(
        &self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        action_id: String,
        message: String,
        icon_name: String,
        details: HashMap<String, String>,
        cookie: String,
        identities: Identities,
    ) -> Result<(), Error> {
        let generation = self.status.unlocked_generation();
        let sender = self.checked_sender(header, connection).await?;
        let identities = users(identities);
        if identities.is_empty()
            || cookie.is_empty()
            || cookie.len() > 4096
            || cookie.chars().any(char::is_control)
        {
            return Err(Error::Failed("Invalid authentication request".into()));
        }
        let mut details: Vec<_> = details
            .iter()
            .filter(|(key, _)| !key.starts_with("polkit.") && !key.eq_ignore_ascii_case("cookie"))
            .take(12)
            .map(|(key, value)| (plain(key, 120), plain(value, 240)))
            .collect();
        details.sort_unstable();
        let ticket = Arc::new(Ticket {
            cookie: CString::new(cookie).map_err(|_| Error::Failed("Invalid cookie".into()))?,
            cancelled: AtomicBool::new(false),
        });
        let (send, receive) = async_channel::bounded(1);
        {
            let mut state = self.state.lock().unwrap();
            if state.owner.as_deref() != Some(sender.as_str()) {
                return Err(cancelled());
            }
            if state.pending.is_some() {
                return Err(Error::Failed(
                    "Another polkit authentication is in progress".into(),
                ));
            }
            let generation = generation.ok_or_else(cancelled)?;
            if self.status.unlocked_generation() != Some(generation) {
                return Err(cancelled());
            }
            let request = Request {
                action: plain(&action_id, 240),
                message: plain(&message, 640),
                icon: icon_name,
                details,
                identities,
                ticket: ticket.clone(),
                generation,
            };
            state.pending = Some(ticket.clone());
            if self.jobs.send(Job(request, send)).is_err() {
                state.pending = None;
                return Err(cancelled());
            }
        }
        receive.recv().await.unwrap_or_else(|_| Err(cancelled()))
    }

    async fn cancel_authentication(
        &self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] connection: &Connection,
        cookie: String,
    ) -> Result<(), Error> {
        let sender = self.checked_sender(header, connection).await?;
        let state = self.state.lock().unwrap();
        if state.owner.as_deref() == Some(sender.as_str())
            && let Some(ticket) = &state.pending
            && ticket.cookie.as_bytes() == cookie.as_bytes()
        {
            ticket.cancel();
        }
        Ok(())
    }
}

pub struct Handle {
    stop: async_channel::Sender<()>,
    worker: Option<std::thread::JoinHandle<()>>,
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.stop.close();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn start(bus: zbus::blocking::Connection, status: Arc<Status>) -> std::io::Result<Handle> {
    let (stop, stopped) = async_channel::bounded(1);
    let shutdown = stop.clone();
    let worker = std::thread::Builder::new()
        .name("polkit-agent".into())
        .spawn(move || {
            if let Err(error) = run(bus, status, stopped, shutdown) {
                eprintln!("nidara-shell: polkit agent unavailable: {error}");
            }
        })?;
    Ok(Handle {
        stop,
        worker: Some(worker),
    })
}

fn run(
    bus: zbus::blocking::Connection,
    status: Arc<Status>,
    stop: async_channel::Receiver<()>,
    shutdown: async_channel::Sender<()>,
) -> Result<(), Box<dyn std::error::Error>> {
    let polkit_uid =
        conversation::account_uid(c"polkitd").ok_or("polkitd service account missing")?;
    let pam = conversation::Library::load()?;
    let mut signals = async_signal::Signals::new([async_signal::Signal::Term])?;
    let (jobs, pending) = mpsc::channel();
    let agent = Agent {
        state: Arc::default(),
        status,
        uid: polkit_uid,
        jobs,
    };
    let ui_state = agent.state.clone();
    let ui_status = agent.status.clone();
    let ui = std::thread::Builder::new()
        .name("polkit-dialog".into())
        .spawn(move || {
            let context = glib::MainContext::new();
            let _ = context.with_thread_default(|| {
                while let Ok(Job(request, reply)) = pending.recv() {
                    let ticket = request.ticket.clone();
                    let generation = request.generation;
                    let result = show_when_ready(&ui_status, &bus, &context, &pam, request);
                    let mut state = ui_state.lock().unwrap();
                    let result = if ticket.valid(&ui_status, generation) {
                        result
                    } else {
                        Err(cancelled())
                    };
                    state.pending = None;
                    let _ = reply.try_send(result);
                }
            });
        })?;
    let drive = async {
        let mut unavailable = false;
        while !stop.is_closed() {
            if register(agent.clone(), &stop).await.is_err() && !unavailable {
                eprintln!("nidara-shell: could not register the session polkit agent");
                unavailable = true;
            }
            future::race(
                async {
                    let _ = stop.recv().await;
                },
                async {
                    async_io::Timer::after(RETRY).await;
                },
            )
            .await;
        }
    };
    let termination = async {
        future::race(
            async {
                let _ = stop.recv().await;
                false
            },
            async {
                if matches!(signals.next().await, Some(Ok(async_signal::Signal::Term))) {
                    shutdown.close();
                    true
                } else {
                    false
                }
            },
        )
        .await
    };
    let (_, terminating) = future::block_on(future::zip(drive, termination));
    drop(agent);
    let _ = ui.join();
    if terminating {
        std::process::exit(0);
    }
    Ok(())
}

fn show_when_ready(
    status: &Arc<Status>,
    bus: &zbus::blocking::Connection,
    context: &glib::MainContext,
    pam: &conversation::Library,
    request: Request,
) -> Result<(), Error> {
    while request.ticket.valid(status, request.generation) {
        if let Some(_slot) = Slot::take(status, SlotKind::Polkit) {
            return view::run(status, bus, context, pam, request).map_err(|_| {
                Error::Failed("The authentication dialog could not be shown".into())
            })?;
        }
        // Only while a request is waiting. Its lifetime remains owned by polkitd.
        std::thread::sleep(Duration::from_millis(30));
    }
    Err(cancelled())
}

async fn session(connection: &Connection) -> zbus::Result<String> {
    let manager = Proxy::new(
        connection,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )
    .await?;
    // As in Hyalo's logind watcher: 'auto' finds this process's session or the
    // launching user's display session when the shell runs in the user manager.
    let path: OwnedObjectPath = manager.call("GetSession", &("auto",)).await?;
    let session = Proxy::new(
        connection,
        "org.freedesktop.login1",
        path,
        "org.freedesktop.login1.Session",
    )
    .await?;
    let (uid, _): (u32, OwnedObjectPath) = session.get_property("User").await?;
    let kind: String = session.get_property("Type").await?;
    let class: String = session.get_property("Class").await?;
    let remote: bool = session.get_property("Remote").await?;
    // SAFETY: getuid has no arguments or preconditions.
    if uid != unsafe { libc::getuid() } || kind != "wayland" || class != "user" || remote {
        return Err(zbus::Error::Failure("No local Hyalo login session".into()));
    }
    session.get_property("Id").await
}

async fn register(agent: Agent, stop: &async_channel::Receiver<()>) -> zbus::Result<()> {
    let connection = zbus::connection::Builder::address("unix:path=/run/dbus/system_bus_socket")?
        .method_timeout(Duration::from_secs(2))
        .serve_at(AGENT, agent.clone())?
        .build()
        .await?;
    let result = registration(&agent, &connection, stop).await;
    let _ = connection.close().await;
    result
}

async fn registration(
    agent: &Agent,
    connection: &Connection,
    stop: &async_channel::Receiver<()>,
) -> zbus::Result<()> {
    let dbus = DBusProxy::new(connection).await?;
    let mut changes = dbus
        .receive_name_owner_changed_with_args(&[(0, NAME)])
        .await?;
    let session = session(connection).await?;
    let subject: Subject<'_> = (
        "unix-session",
        HashMap::from([("session-id", Value::from(session.as_str()))]),
    );
    // Use the unique owner for the lifetime of the registration.
    let name = BusName::try_from(NAME)?;
    let owner = match dbus.get_name_owner(name.clone()).await {
        Ok(owner) => owner,
        Err(zbus::fdo::Error::NameHasNoOwner(_)) => {
            dbus.start_service_by_name(NAME.try_into()?, 0).await?;
            dbus.get_name_owner(name).await?
        }
        Err(error) => return Err(error.into()),
    };
    let credentials = dbus
        .get_connection_credentials(BusName::from(owner.clone()))
        .await?;
    if credentials.unix_user_id() != Some(agent.uid) {
        return Err(zbus::Error::Failure(
            "Unexpected polkit authority credentials".into(),
        ));
    }
    let proxy = Proxy::new(connection, owner.clone(), AUTHORITY, AUTHORITY_INTERFACE).await?;
    let registered = Registered(agent.state.clone());
    agent.state.lock().unwrap().owner = Some(owner.to_string());
    proxy
        .call::<_, _, ()>("RegisterAuthenticationAgent", &(&subject, locale(), AGENT))
        .await?;

    // Wait for shutdown, disconnection, or loss of this exact owner. An acquisition
    // already queued when GetNameOwner ran does not invalidate the registration.
    future::race(
        async {
            while let Some(change) = changes.next().await {
                if let Ok(args) = change.args()
                    && args
                        .old_owner()
                        .as_ref()
                        .is_some_and(|old| old.as_str() == owner.as_str())
                {
                    break;
                }
            }
        },
        async {
            let _ = stop.recv().await;
        },
    )
    .await;
    drop(registered);
    if stop.is_closed() {
        let _ = proxy
            .call::<_, _, ()>("UnregisterAuthenticationAgent", &(&subject, AGENT))
            .await;
    }
    Ok(())
}

fn locale() -> String {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|key| std::env::var(key).ok().filter(|value| !value.is_empty()))
        .unwrap_or_else(|| "C".into())
}

#[cfg(test)]
mod tests;
