//! What a session hears over D-Bus — only in a real session (`--session`): a development Hyalo
//! must not take the live session's sleep inhibitor or its ScreenSaver name.
//!
//! - **The lock before sleep.** Hyalo holds a logind *delay* inhibitor on sleep. When logind
//!   announces sleep (`PrepareForSleep(true)`) the session locks, and the inhibitor is let go
//!   once the lock is CONFIRMED on screen (lock.rs) — or after SLEEP_GRACE, so a lock client
//!   that does not start never keeps the machine awake. On the way back (`false`) the inhibitor
//!   is taken again and the screens come on. (On Hyprland this was hypridle's
//!   `before_sleep_cmd`.)
//! - **`loginctl lock-session`** (the session's `Lock` signal) locks.
//! - **`org.freedesktop.ScreenSaver`** on the session bus: apps that ask it not to blank the
//!   screen (`Inhibit`/`UnInhibit`, cookies dropped when the app leaves the bus) hold the idle
//!   steps off (idle.rs).
//!
//! The buses are blocking zbus connections on threads of their own; what they hear reaches the
//! event loop through a calloop channel.

use std::{
    collections::HashMap,
    os::fd::OwnedFd,
    sync::{Arc, Mutex},
    time::Duration,
};

use smithay::reexports::calloop::{
    channel::{self, Event as ChannelEvent, Sender},
    timer::{TimeoutAction, Timer},
};

use crate::state::Hyalo;

/// How long the lock may take before sleep goes ahead anyway (logind's own cap is 5 s).
const SLEEP_GRACE: Duration = Duration::from_secs(3);

pub enum LoginEvent {
    PrepareForSleep(bool),
    LockSession,
    Inhibitors(usize),
}

pub struct Login {
    /// The sleep delay inhibitor; dropping the fd lets the machine sleep.
    delay: Arc<Mutex<Option<OwnedFd>>>,
    /// Sleep is waiting for the lock.
    sleep_pending: bool,
}

pub fn start(state: &mut Hyalo) {
    let (tx, rx) = channel::channel::<LoginEvent>();
    let delay = Arc::new(Mutex::new(None));
    let inserted = state.loop_handle.insert_source(rx, |event, _, state| {
        if let ChannelEvent::Msg(e) = event {
            state.on_login_event(e);
        }
    });
    if inserted.is_err() {
        tracing::warn!("logind: no channel into the event loop");
        return;
    }
    state.login = Some(Login { delay: delay.clone(), sleep_pending: false });

    let system_tx = tx.clone();
    std::thread::Builder::new()
        .name("hyalo-logind".into())
        .spawn(move || {
            if let Err(err) = system_bus(system_tx, delay) {
                tracing::warn!(%err, "logind: not reachable; no lock before sleep");
            }
        })
        .ok();
    std::thread::Builder::new()
        .name("hyalo-screensaver".into())
        .spawn(move || {
            if let Err(err) = screensaver(tx) {
                tracing::warn!(%err, "org.freedesktop.ScreenSaver not served; apps cannot hold the screen on over D-Bus");
            }
        })
        .ok();
}

fn take_delay(manager: &zbus::blocking::Proxy<'_>, delay: &Mutex<Option<OwnedFd>>) {
    let fd: zbus::Result<zbus::zvariant::OwnedFd> =
        manager.call("Inhibit", &("sleep", "Hyalo", "Locks the screen before the computer sleeps", "delay"));
    match fd {
        Ok(fd) => *delay.lock().unwrap() = Some(fd.into()),
        Err(err) => tracing::warn!(%err, "logind: no sleep delay inhibitor; the lock may come after the sleep"),
    }
}

fn system_bus(tx: Sender<LoginEvent>, delay: Arc<Mutex<Option<OwnedFd>>>) -> zbus::Result<()> {
    let conn = zbus::blocking::Connection::system()?;
    let manager = zbus::blocking::Proxy::new(
        &conn,
        "org.freedesktop.login1",
        "/org/freedesktop/login1",
        "org.freedesktop.login1.Manager",
    )?;
    take_delay(&manager, &delay);

    // `auto`: this process's session, or the user's display session when Hyalo runs in a unit
    // of the user's manager (uwsm), outside the session's scope.
    let session: zbus::zvariant::OwnedObjectPath = manager.call("GetSession", &("auto",))?;
    let lock_tx = tx.clone();
    let lock_conn = conn.clone();
    std::thread::Builder::new()
        .name("hyalo-logind-lock".into())
        .spawn(move || {
            let run = || -> zbus::Result<()> {
                let proxy = zbus::blocking::Proxy::new(&lock_conn, "org.freedesktop.login1", session, "org.freedesktop.login1.Session")?;
                for _ in proxy.receive_signal("Lock")? {
                    if lock_tx.send(LoginEvent::LockSession).is_err() {
                        break;
                    }
                }
                Ok(())
            };
            if let Err(err) = run() {
                tracing::warn!(%err, "logind: `loginctl lock-session` will not lock");
            }
        })
        .ok();

    for msg in manager.receive_signal("PrepareForSleep")? {
        let Ok(sleeping) = msg.body().deserialize::<bool>() else { continue };
        if !sleeping {
            take_delay(&manager, &delay);
        }
        if tx.send(LoginEvent::PrepareForSleep(sleeping)).is_err() {
            break;
        }
    }
    Ok(())
}

#[derive(Default)]
struct Inhibitions {
    next: u32,
    /// Cookie → the unique bus name that holds it.
    held: HashMap<u32, String>,
}

#[derive(Clone)]
struct ScreenSaver {
    inner: Arc<Mutex<Inhibitions>>,
    tx: Sender<LoginEvent>,
}

impl ScreenSaver {
    fn report(&self, n: usize) {
        if let Err(err) = self.tx.send(LoginEvent::Inhibitors(n)) {
            tracing::warn!(%err, "ScreenSaver: the event loop did not take the change");
        }
    }
}

#[zbus::interface(name = "org.freedesktop.ScreenSaver")]
impl ScreenSaver {
    fn inhibit(&self, #[zbus(header)] header: zbus::message::Header<'_>, application_name: String, reason_for_inhibit: String) -> u32 {
        let sender = header.sender().map(|s| s.to_string()).unwrap_or_default();
        let (cookie, n) = {
            let mut i = self.inner.lock().unwrap();
            i.next = i.next.wrapping_add(1).max(1);
            let cookie = i.next;
            i.held.insert(cookie, sender);
            (cookie, i.held.len())
        };
        tracing::info!(app = %application_name, reason = %reason_for_inhibit, cookie, "the screen is held on");
        self.report(n);
        cookie
    }

    fn un_inhibit(&self, cookie: u32) {
        let n = {
            let mut i = self.inner.lock().unwrap();
            i.held.remove(&cookie);
            i.held.len()
        };
        self.report(n);
    }
}

fn screensaver(tx: Sender<LoginEvent>) -> zbus::Result<()> {
    let service = ScreenSaver { inner: Arc::default(), tx };
    let conn = zbus::blocking::connection::Builder::session()?
        .name("org.freedesktop.ScreenSaver")?
        .serve_at("/org/freedesktop/ScreenSaver", service.clone())?
        .serve_at("/ScreenSaver", service.clone())?
        .build()?;
    // An app that leaves the bus without saying UnInhibit lets go of the screen too.
    let dbus = zbus::blocking::fdo::DBusProxy::new(&conn)?;
    for change in dbus.receive_name_owner_changed()? {
        let Ok(args) = change.args() else { continue };
        if args.new_owner().is_some() {
            continue;
        }
        let gone = args.name().to_string();
        let n = {
            let mut i = service.inner.lock().unwrap();
            let before = i.held.len();
            i.held.retain(|_, s| s != &gone);
            (i.held.len() != before).then_some(i.held.len())
        };
        if let Some(n) = n {
            service.report(n);
        }
    }
    Ok(())
}

impl Hyalo {
    fn on_login_event(&mut self, event: LoginEvent) {
        match event {
            LoginEvent::PrepareForSleep(true) => {
                tracing::info!("the computer is going to sleep: locking first");
                if self.lock.is_locked() {
                    self.release_sleep_delay();
                    return;
                }
                if let Some(l) = &mut self.login {
                    l.sleep_pending = true;
                }
                crate::spawn(&crate::lock::lock_command());
                let _ = self.loop_handle.insert_source(Timer::from_duration(SLEEP_GRACE), |_, _, state| {
                    if state.login.as_ref().is_some_and(|l| l.sleep_pending) {
                        tracing::warn!("the lock did not confirm in time; the computer sleeps anyway");
                        state.release_sleep_delay();
                    }
                    TimeoutAction::Drop
                });
            }
            LoginEvent::PrepareForSleep(false) => {
                tracing::info!("back from sleep");
                if let Some(l) = &mut self.login {
                    l.sleep_pending = false;
                }
                self.note_activity();
                let _ = crate::outputs::set_power(self, None, true);
            }
            LoginEvent::LockSession => {
                if !self.lock.is_locked() {
                    tracing::info!("logind asked for the lock");
                    crate::spawn(&crate::lock::lock_command());
                }
            }
            LoginEvent::Inhibitors(n) => {
                tracing::debug!(n, "ScreenSaver inhibitors");
                self.idle.dbus_inhibitors = n;
                self.idle_inhibition_changed();
            }
        }
    }

    /// The session is locked: if sleep was waiting for it, it may go now.
    pub fn lock_confirmed_for_sleep(&mut self) {
        if self.login.as_ref().is_some_and(|l| l.sleep_pending) {
            self.release_sleep_delay();
        }
    }

    fn release_sleep_delay(&mut self) {
        if let Some(l) = &mut self.login {
            l.sleep_pending = false;
            l.delay.lock().unwrap().take();
        }
    }
}
