// SPDX-License-Identifier: LGPL-3.0-or-later
//! `nidara-lock`: the lock screen (#1195), a client of ext-session-lock-v1 built from the kit.
//!
//! Hyalo owns locking (`hyalo/compositor/src/lock.rs`): what is hidden, when "locked" is
//! said, relaunching this client if it dies and locking anyway if it never asks. This
//! process asks for the lock, puts one surface on every output and unlocks once PAM says
//! yes. A fault here never opens the session: the compositor keeps it hidden and starts the
//! client again.
//!
//! Every output gets a lock surface on its own thread (`surface.rs`). The avatar, the name
//! and the field are on the one the pointer is on, and the clock alone on the others (D6).
//! This thread holds the lock, the attempt and the shared state they read.
mod auth;
mod login;
mod media;
mod surface;
mod user;

use nk_wayland::{LockStatus, OutputEvent, OutputId, Waker};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// What every surface reads to build its view, and the revision it was built from.
#[derive(Default)]
pub struct Shared {
    pub revision: u64,
    /// The output that shows the field (D6): the pointer's, the first one until it moves.
    pub active: Option<OutputId>,
    /// An attempt is running: the field and its button wait.
    pub checking: bool,
    /// What the last attempt said, in order (PAM's lines, then our verdict), for the screen
    /// and for readers (#1195: every faillock line is shown).
    pub lines: Vec<String>,
    /// A new attempt starts with an empty field.
    pub clear: u64,
    pub user: user::User,
    /// What is playing, when the user lets the lock screen show it (D5).
    pub media: Option<media::Now>,
    /// Unlocked: every surface closes.
    pub done: bool,
}

/// To this thread, from the surfaces, the attempt and the output watch.
pub enum Msg {
    Submit(nk::Secret),
    /// The field changed: what the last attempt said goes (the TS lock screen's rule).
    Typed,
    Suspend,
    /// What the session's media service now says is playing.
    Media(Option<media::Now>),
    /// A transport button: Media1's `SelectedPrevious`, `SelectedPlayPause`, `SelectedNext`.
    Press(&'static str),
    /// The pointer moved onto this output.
    Pointer(OutputId),
    Said(auth::Said),
    Surface(OutputId, Waker),
    Gone(OutputId),
    Failed(String),
}

pub struct World {
    pub shared: Mutex<Shared>,
    pub tx: Sender<Msg>,
    wakers: Mutex<Vec<(OutputId, Waker)>>,
    threads: Mutex<Vec<std::thread::JoinHandle<()>>>,
}
impl World {
    /// Change the shared state and tell every surface.
    pub fn update(&self, f: impl FnOnce(&mut Shared)) {
        {
            let mut s = self.shared.lock().unwrap();
            f(&mut s);
            s.revision += 1;
        }
        for (_, w) in self.wakers.lock().unwrap().iter() {
            let _ = w.wake();
        }
    }
}

fn main() {
    // The clock's words are the session's regional format (LC_TIME), as the bar's are.
    unsafe {
        unsafe extern "C" {
            fn setlocale(
                category: std::ffi::c_int,
                locale: *const std::ffi::c_char,
            ) -> *mut std::ffi::c_char;
        }
        setlocale(2, c"".as_ptr());
    }
    match run() {
        Ok(()) => {}
        Err(e) => {
            eprintln!("nidara-lock: {e}");
            // Non-zero: Hyalo keeps the session locked and starts the client again.
            std::process::exit(1);
        }
    }
}

fn run() -> Result<(), String> {
    // The login screen (#1195): Hyalo in login mode runs this same screen for nidara-login.
    let login = login::socket().is_some();
    let user = if login {
        user::User::for_login()
    } else {
        user::User::current()
    };
    let look = Arc::new(surface::Kit::load(&user)?);
    let watch = nk_wayland::outputs(Duration::from_secs(5))?;
    let mut lock = nk_wayland::lock_session(Duration::from_secs(5))?;
    let (tx, rx) = channel();
    let world = Arc::new(World {
        shared: Mutex::new(Shared {
            user,
            ..Default::default()
        }),
        tx: tx.clone(),
        wakers: Mutex::new(Vec::new()),
        threads: Mutex::new(Vec::new()),
    });
    // The login user has no session of anybody's to play from.
    if !login {
        media::watch(tx.clone());
    }
    let first = watch.current().first().map(|o| o.id);
    world.update(|s| s.active = first);
    // The outputs' thread: one surface per output, now and as screens come and go.
    {
        let binder = lock.binder();
        let world = world.clone();
        let look = look.clone();
        std::thread::Builder::new()
            .name("lock-outputs".into())
            .spawn(move || outputs(watch, binder, world, look))
            .map_err(|e| e.to_string())?;
    }
    // The compositor confirms once every output shows a lock surface; until then nothing
    // here may unlock. What else arrives meanwhile (the surfaces' wakers, what is playing)
    // is kept for after, never dropped: a surface whose waker is lost is never told again.
    let mut early = Vec::new();
    loop {
        match lock.wait(Some(Duration::from_secs(1)))? {
            LockStatus::Locked => break,
            LockStatus::Finished => return Err("the compositor refused the lock".into()),
            LockStatus::Pending => {}
        }
        while let Ok(msg) = rx.try_recv() {
            match msg {
                Msg::Failed(e) => return Err(e),
                msg => early.push(msg),
            }
        }
    }
    eprintln!("nidara-lock: locked");
    let expired = converse(&world, early, &rx, &mut lock, look.measures.error_seconds)?;
    if login {
        // The manager starts the session once this screen's Hyalo has let go of the screens,
        // which it does when the lock goes (login mode).
        login::start()?;
    }
    lock.unlock()?;
    eprintln!("nidara-lock: unlocked");
    // The surfaces close; the compositor already shows the session.
    world.update(|s| s.done = true);
    let threads: Vec<_> = world.threads.lock().unwrap().drain(..).collect();
    for t in threads {
        let _ = t.join();
    }
    if expired {
        tell_expired();
    }
    Ok(())
}

/// Attempts until one succeeds. Returns whether the password has expired.
fn converse(
    world: &Arc<World>,
    early: Vec<Msg>,
    rx: &Receiver<Msg>,
    lock: &mut nk_wayland::SessionLock,
    error_seconds: f64,
) -> Result<bool, String> {
    // When a refusal was shown: it goes after `error_seconds` on a screen nobody touches.
    let mut refused: Option<std::time::Instant> = None;
    let mut early = early.into_iter();
    loop {
        if refused.is_some_and(|t| t.elapsed().as_secs_f64() >= error_seconds) {
            refused = None;
            world.update(|s| s.lines.clear());
        }
        let next = match early.next() {
            Some(m) => Ok(m),
            None => rx.recv_timeout(Duration::from_secs(1)),
        };
        let msg = match next {
            Ok(m) => m,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // The compositor may take the lock back (another client took it over).
                if lock.status()? == LockStatus::Finished {
                    return Err("the compositor ended the lock".into());
                }
                continue;
            }
            Err(e) => return Err(e.to_string()),
        };
        match msg {
            Msg::Submit(secret) => {
                if world.shared.lock().unwrap().checking {
                    continue;
                }
                let login = world.shared.lock().unwrap().user.login.clone();
                refused = None;
                world.update(|s| {
                    s.checking = true;
                    s.lines.clear();
                });
                let (said_tx, said_rx) = channel();
                // The attempt's messages come back on this thread's one channel, in order.
                let relay = world.tx.clone();
                std::thread::spawn(move || {
                    for said in said_rx {
                        if relay.send(Msg::Said(said)).is_err() {
                            return;
                        }
                    }
                });
                if login::socket().is_some() {
                    login::attempt(&login, secret, said_tx);
                } else {
                    auth::attempt(&login, secret, said_tx);
                }
            }
            Msg::Typed => {
                let shown = {
                    let s = world.shared.lock().unwrap();
                    !s.checking && !s.lines.is_empty()
                };
                if shown {
                    refused = None;
                    world.update(|s| s.lines.clear());
                }
            }
            Msg::Said(auth::Said::Info(line)) | Msg::Said(auth::Said::Error(line)) => {
                if !line.trim().is_empty() {
                    world.update(|s| s.lines.push(line));
                }
            }
            Msg::Said(auth::Said::Success { expired }) => return Ok(expired),
            Msg::Said(auth::Said::Fail { denied }) => {
                let key = if denied {
                    "lock.account-unavailable"
                } else {
                    "lock.wrong-password"
                };
                let verdict = surface::text(key);
                refused = Some(std::time::Instant::now());
                world.update(|s| {
                    s.checking = false;
                    s.lines.push(verdict);
                    s.clear += 1;
                });
            }
            Msg::Suspend => suspend(),
            Msg::Media(now) => {
                if world.shared.lock().unwrap().media != now {
                    world.update(|s| s.media = now);
                }
            }
            Msg::Press(method) => media::press(method),
            Msg::Pointer(id) => {
                if world.shared.lock().unwrap().active != Some(id) {
                    world.update(|s| s.active = Some(id));
                }
            }
            Msg::Surface(id, waker) => {
                world.wakers.lock().unwrap().push((id, waker));
                let missing = world.shared.lock().unwrap().active.is_none();
                if missing {
                    world.update(|s| s.active = Some(id));
                }
            }
            Msg::Gone(id) => {
                world.wakers.lock().unwrap().retain(|(o, _)| *o != id);
                let next = world.wakers.lock().unwrap().first().map(|(o, _)| *o);
                if world.shared.lock().unwrap().active == Some(id) {
                    world.update(|s| s.active = next);
                }
            }
            Msg::Failed(e) => eprintln!("nidara-lock: {e}"),
        }
    }
}

/// The outputs' thread: a surface for each output there is, and for each one plugged in.
fn outputs(
    mut watch: nk_wayland::OutputWatch,
    binder: nk_wayland::LockBinder,
    world: Arc<World>,
    kit: Arc<surface::Kit>,
) {
    let start = |watch: &mut nk_wayland::OutputWatch, id: OutputId| match binder.bind_output(
        watch,
        id,
        Duration::from_secs(3),
    ) {
        Ok(output) => {
            if let Some(t) = surface::spawn(output, world.clone(), kit.clone()) {
                world.threads.lock().unwrap().push(t);
            }
        }
        Err(e) => eprintln!(
            "nidara-lock: output {} has no lock surface: {e:?}",
            id.global()
        ),
    };
    let mut pending: Vec<OutputEvent> = watch
        .current()
        .into_iter()
        .map(OutputEvent::Added)
        .collect();
    // The outputs that have a surface. The watch may report again an output it already
    // listed, and a second lock surface for one output is a protocol error.
    let mut started: Vec<OutputId> = Vec::new();
    loop {
        for event in std::mem::take(&mut pending) {
            match event {
                OutputEvent::Added(info) if started.contains(&info.id) => {}
                OutputEvent::Added(info) => {
                    started.push(info.id);
                    start(&mut watch, info.id);
                }
                OutputEvent::Removed(id) => {
                    started.retain(|o| *o != id);
                    let _ = world.tx.send(Msg::Gone(id));
                }
                OutputEvent::Changed(_) => {}
                OutputEvent::Lost(e) => {
                    let _ = world
                        .tx
                        .send(Msg::Failed(format!("the output watch was lost: {e}")));
                    return;
                }
            }
        }
        match watch.next(None) {
            Ok(events) => pending = events,
            Err(e) => {
                let _ = world.tx.send(Msg::Failed(e));
                return;
            }
        }
    }
}

/// Suspend only (D3): logind lets the active local session power off without a password, so
/// what the lock screen offers, anyone at the keyboard can do. Suspending loses nothing.
fn suspend() {
    let call = || -> zbus::Result<()> {
        let bus = zbus::blocking::Connection::system()?;
        bus.call_method(
            Some("org.freedesktop.login1"),
            "/org/freedesktop/login1",
            Some("org.freedesktop.login1.Manager"),
            "Suspend",
            &(false,),
        )?;
        Ok(())
    };
    std::thread::spawn(move || {
        if let Err(e) = call() {
            eprintln!("nidara-lock: could not suspend: {e}");
        }
    });
}

/// An expired password still unlocks (`nidara-auth.h`); the user is told by a notification
/// that outlives the lock screen, at critical urgency so Do Not Disturb does not swallow it.
fn tell_expired() {
    let title = surface::text("lock.password-expired");
    let body = surface::text("lock.password-expired-how");
    let result = std::process::Command::new("notify-send")
        .args([
            "-u",
            "critical",
            "-a",
            "Nidara",
            "-i",
            "dialog-password",
            &title,
            &body,
        ])
        .spawn();
    if let Err(e) = result {
        eprintln!("nidara-lock: could not say the password has expired: {e}");
    }
}
