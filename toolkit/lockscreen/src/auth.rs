// SPDX-License-Identifier: LGPL-3.0-or-later
//! One unlock attempt through `lib/nidara-auth` (PAM service `nidara-lock`), the library the
//! TS lock screen used and the login screen will share: it runs `pam_authenticate` and
//! `pam_acct_mgmt` on its own worker and relays PAM's conversation as GObject signals on the
//! DEFAULT main context. So an attempt owns that context on a thread of its own while it runs.
//!
//! The conversation contract (`nidara-auth.h`) holds here: only PROMPTS are answered, each
//! exactly once; info and error messages are shown, never answered (#200). Every message of
//! the attempt reaches the screen in order, faillock's "account locked" and its minutes left
//! included (#1195, owner): there is no attempt limit or countdown of our own.
use std::ffi::{CString, c_char, c_void};
use std::sync::mpsc::Sender;

/// What one attempt says, in the order PAM said it.
#[derive(Debug, Clone, PartialEq)]
pub enum Said {
    /// `PAM_TEXT_INFO`: shown, not answered ("place your finger").
    Info(String),
    /// `PAM_ERROR_MSG`: shown, not answered (faillock's "account locked").
    Error(String),
    /// The password was right and the account may be used. `expired`: it must be changed;
    /// the session still unlocks (see the header) and the user is told after.
    Success { expired: bool },
    /// Refused. `denied`: the ACCOUNT stack refused a correct password (expired account,
    /// `usermod -L`, a `pam_time` window) — not a wrong password.
    Fail { denied: bool },
}

type New = unsafe extern "C" fn() -> *mut c_void;
type SetText = unsafe extern "C" fn(*mut c_void, *const c_char);
type Start = unsafe extern "C" fn(*mut c_void);

/// The library's four entry points, loaded once. Loaded, not linked, so a build machine
/// needs no C library and a missing one is a message on screen, not a dead lock client.
struct Library {
    _lib: libloading::Library,
    new: New,
    set_username: SetText,
    supply: SetText,
    start: Start,
}
fn library() -> Result<&'static Library, String> {
    static LIB: std::sync::OnceLock<Result<Library, String>> = std::sync::OnceLock::new();
    LIB.get_or_init(|| unsafe {
        let lib = libloading::Library::new("libnidara-auth.so.0").map_err(|e| e.to_string())?;
        let new = *lib
            .get::<New>(b"nidara_auth_pam_new\0")
            .map_err(|e| e.to_string())?;
        let set_username = *lib
            .get::<SetText>(b"nidara_auth_pam_set_username\0")
            .map_err(|e| e.to_string())?;
        let supply = *lib
            .get::<SetText>(b"nidara_auth_pam_supply_secret\0")
            .map_err(|e| e.to_string())?;
        let start = *lib
            .get::<Start>(b"nidara_auth_pam_start_authenticate\0")
            .map_err(|e| e.to_string())?;
        Ok(Library {
            _lib: lib,
            new,
            set_username,
            supply,
            start,
        })
    })
    .as_ref()
    .map_err(Clone::clone)
}

/// Run one attempt for `user` with `secret` on a thread of its own; each message and the
/// verdict go to `said`, in order. The C copy of the secret is wiped once PAM has had it.
pub fn attempt(user: &str, secret: nk::Secret, said: Sender<Said>) {
    let user = user.to_owned();
    let spawned = std::thread::Builder::new()
        .name("lock-pam".into())
        .spawn(move || {
            if let Err(e) = run(&user, secret, &said) {
                eprintln!("nidara-lock: authentication could not run: {e}");
                let _ = said.send(Said::Fail { denied: false });
            }
        });
    if let Err(e) = spawned {
        eprintln!("nidara-lock: no thread for authentication: {e}");
    }
}

fn run(user: &str, secret: nk::Secret, said: &Sender<Said>) -> Result<(), String> {
    use glib::prelude::*;
    use glib::translate::FromGlibPtrFull;
    let lib = library()?;
    let context = glib::MainContext::default();
    let _owner = context
        .acquire()
        .map_err(|_| "the main context is held elsewhere".to_string())?;
    let name = CString::new(user).map_err(|e| e.to_string())?;
    // SAFETY: a new GObject, ours (transfer full); the library's own type.
    let pam: glib::Object = unsafe {
        let raw = (lib.new)();
        if raw.is_null() {
            return Err("nidara_auth_pam_new returned nothing".into());
        }
        (lib.set_username)(raw, name.as_ptr());
        glib::Object::from_glib_full(raw as *mut glib::gobject_ffi::GObject)
    };
    let raw = pam.as_ptr() as *mut c_void;
    let text = |values: &[glib::Value]| {
        values
            .get(1)
            .and_then(|v| v.get::<String>().ok())
            .unwrap_or_default()
    };
    let finished = std::rc::Rc::new(std::cell::Cell::new(false));
    let expired = std::rc::Rc::new(std::cell::Cell::new(false));
    let denied = std::rc::Rc::new(std::cell::Cell::new(false));
    let secret = std::rc::Rc::new(std::cell::RefCell::new(Some(secret)));
    // Every handler is disconnected on this thread before `pam` goes (see the end).
    let mut handlers = Vec::new();
    {
        let secret = secret.clone();
        handlers.push(pam.connect_local("auth-prompt-hidden", false, move |_| {
            // Every hidden prompt gets the password the user typed, as the TS lock did.
            let s = secret.borrow();
            let answer = s.as_ref().map(|s| s.as_str()).unwrap_or("");
            // A NUL inside is impossible from the field (control characters are refused).
            if let Ok(c) = CString::new(answer) {
                unsafe { (lib.supply)(raw, c.as_ptr()) };
                wipe(c);
            }
            None
        }));
    }
    handlers.push(pam.connect_local("auth-prompt-visible", false, move |v| {
        // A username prompt cannot happen (pam_start has it) and the lock screen has no
        // second field: answer so the attempt cannot hang, and say so in the log.
        eprintln!(
            "nidara-lock: unexpected visible prompt, answering empty: {}",
            text(v)
        );
        unsafe { (lib.supply)(raw, c"".as_ptr()) };
        None
    }));
    {
        let said = said.clone();
        handlers.push(pam.connect_local("auth-info", false, move |v| {
            let _ = said.send(Said::Info(text(v)));
            None
        }));
    }
    {
        let said = said.clone();
        handlers.push(pam.connect_local("auth-error", false, move |v| {
            let _ = said.send(Said::Error(text(v)));
            None
        }));
    }
    {
        let expired = expired.clone();
        handlers.push(pam.connect_local("password-expired", false, move |_| {
            expired.set(true);
            None
        }));
    }
    {
        let denied = denied.clone();
        handlers.push(pam.connect_local("account-denied", false, move |v| {
            eprintln!("nidara-lock: the account stack refused: {}", text(v));
            denied.set(true);
            None
        }));
    }
    {
        let (said, finished, expired) = (said.clone(), finished.clone(), expired.clone());
        handlers.push(pam.connect_local("success", false, move |_| {
            let _ = said.send(Said::Success {
                expired: expired.get(),
            });
            finished.set(true);
            None
        }));
    }
    {
        let (said, finished, denied) = (said.clone(), finished.clone(), denied.clone());
        handlers.push(pam.connect_local("fail", false, move |v| {
            eprintln!("nidara-lock: authentication failed: {}", text(v));
            let _ = said.send(Said::Fail {
                denied: denied.get(),
            });
            finished.set(true);
            None
        }));
    }
    unsafe { (lib.start)(raw) };
    while !finished.get() {
        context.iteration(true);
    }
    secret.borrow_mut().take();
    // The library's worker thread holds a reference of its own and lets go of it there
    // (nidara-auth.c, at the end of `auth_worker_func`). If that is the last one, the object
    // is finalized on the worker, and with it these closures, which glib only allows on the
    // thread that made them: a panic on a C thread, so the lock client aborted. Disconnected
    // here, they are dropped here, whoever finalizes the object.
    for id in handlers {
        pam.disconnect(id);
    }
    Ok(())
}

/// Overwrite a C copy of the password before it is freed.
fn wipe(c: CString) {
    let mut bytes = c.into_bytes_with_nul();
    for b in bytes.iter_mut() {
        // SAFETY: a plain byte of our own buffer; volatile so the store is not elided.
        unsafe { std::ptr::write_volatile(b, 0) };
    }
}
