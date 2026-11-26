// SPDX-License-Identifier: LGPL-3.0-or-later
//! A narrow binding to Arch's libpolkit-agent-1. The library owns the helper protocol.
use glib::{prelude::*, translate::*};
use std::{
    cell::RefCell,
    collections::VecDeque,
    ffi::{CStr, c_char},
    rc::Rc,
};

type Object = *mut glib::gobject_ffi::GObject;
type UserNew = unsafe extern "C" fn(i32) -> Object;
type SessionNew = unsafe extern "C" fn(Object, *const c_char) -> Object;
type Control = unsafe extern "C" fn(Object);
type Response = unsafe extern "C" fn(Object, *const c_char);

pub(super) struct Library {
    _handle: libloading::Library,
    user_new: UserNew,
    session_new: SessionNew,
    initiate: Control,
    cancel: Control,
    response: Response,
}

impl Library {
    pub(super) fn load() -> Result<Self, libloading::Error> {
        // SAFETY: load the system library on Arch. The versioned ABI defines each
        // signature below; the handle outlives all sessions and their signals.
        unsafe {
            let handle = libloading::Library::new("/usr/lib/libpolkit-agent-1.so.0")?;
            Ok(Self {
                user_new: *handle.get(b"polkit_unix_user_new")?,
                session_new: *handle.get(b"polkit_agent_session_new")?,
                initiate: *handle.get(b"polkit_agent_session_initiate")?,
                cancel: *handle.get(b"polkit_agent_session_cancel")?,
                response: *handle.get(b"polkit_agent_session_response")?,
                _handle: handle,
            })
        }
    }
}

pub(super) enum Event {
    Request(String, bool),
    Info(String),
    Error(String),
    Completed(bool),
}

pub(super) struct Session<'a> {
    library: &'a Library,
    object: glib::Object,
    events: Rc<RefCell<VecDeque<Event>>>,
    complete: bool,
}

impl<'a> Session<'a> {
    pub(super) fn start(library: &'a Library, uid: u32, cookie: &CStr) -> Option<Self> {
        // SAFETY: both constructors transfer one GObject ref. The session takes
        // its own identity ref and copies the cookie. All calls stay on this thread
        // with its GLib main context as the thread-default context.
        let object: glib::Object = unsafe {
            let user: glib::Object = from_glib_full((library.user_new)(i32::try_from(uid).ok()?));
            let object = (library.session_new)(user.to_glib_none().0, cookie.as_ptr());
            if object.is_null() {
                return None;
            }
            from_glib_full(object)
        };
        let mut session = Self {
            library,
            object,
            events: Rc::default(),
            complete: false,
        };
        session.connect("request", |values| {
            Event::Request(
                values[1].get().unwrap_or_default(),
                values[2].get().unwrap_or(false),
            )
        });
        session.connect("show-info", |values| {
            Event::Info(values[1].get().unwrap_or_default())
        });
        session.connect("show-error", |values| {
            Event::Error(values[1].get().unwrap_or_default())
        });
        session.connect("completed", |values| {
            Event::Completed(values[1].get().unwrap_or(false))
        });
        // SAFETY: the GObject above is a live PolkitAgentSession.
        unsafe { (library.initiate)(session.object.to_glib_none().0) };
        Some(session)
    }

    fn connect(&mut self, signal: &str, decode: fn(&[glib::Value]) -> Event) {
        let events = self.events.clone();
        self.object.connect_local(signal, false, move |values| {
            events.borrow_mut().push_back(decode(values));
            None
        });
    }

    pub(super) fn pop(&mut self) -> Option<Event> {
        let event = self.events.borrow_mut().pop_front()?;
        self.complete |= matches!(event, Event::Completed(_));
        Some(event)
    }

    pub(super) fn respond(&self, secret: Option<nk::Secret>) {
        if let Some(secret) = secret {
            secret.with_c_str(|text| self.send(text));
        } else {
            self.send(c"");
        }
    }

    fn send(&self, response: &CStr) {
        // SAFETY: the response is valid for this synchronous call to libpolkit.
        unsafe { (self.library.response)(self.object.to_glib_none().0, response.as_ptr()) }
    }
}

impl Drop for Session<'_> {
    fn drop(&mut self) {
        if !self.complete {
            // SAFETY: this is a live session on its owning GLib context. Calling
            // cancel stops the active helper; late signals stay with this object.
            unsafe { (self.library.cancel)(self.object.to_glib_none().0) };
        }
    }
}

fn account<T>(
    read: impl FnOnce(*mut libc::passwd, &mut [u8], *mut *mut libc::passwd) -> i32,
    extract: impl FnOnce(libc::passwd) -> T,
) -> Option<T> {
    let mut buffer = vec![0; 64 * 1024];
    let mut entry = std::mem::MaybeUninit::<libc::passwd>::uninit();
    let mut result = std::ptr::null_mut();
    if read(entry.as_mut_ptr(), &mut buffer, &mut result) != 0 || result.is_null() {
        return None;
    }
    // SAFETY: a successful NSS lookup with a non-null result initializes entry.
    // Any pointers into buffer are used by extract before the buffer is dropped.
    Some(extract(unsafe { entry.assume_init() }))
}

pub(super) fn account_uid(name: &CStr) -> Option<u32> {
    account(
        |entry, buf, result| {
            // SAFETY: the pointers and the length describe the available storage.
            unsafe {
                libc::getpwnam_r(
                    name.as_ptr(),
                    entry,
                    buf.as_mut_ptr().cast(),
                    buf.len(),
                    result,
                )
            }
        },
        |entry| entry.pw_uid,
    )
}

pub(super) fn account_name(uid: u32) -> Option<(String, String)> {
    account(
        |entry, buf, result| {
            // SAFETY: the pointers and the length describe the available storage.
            unsafe { libc::getpwuid_r(uid, entry, buf.as_mut_ptr().cast(), buf.len(), result) }
        },
        |entry| {
            // SAFETY: NSS supplies NUL-terminated fields and account keeps the buffer alive.
            let login = unsafe { CStr::from_ptr(entry.pw_name) }.to_string_lossy();
            let gecos = if entry.pw_gecos.is_null() {
                std::borrow::Cow::Borrowed("")
            } else {
                unsafe { CStr::from_ptr(entry.pw_gecos) }.to_string_lossy()
            };
            let real_name = gecos
                .split(',')
                .next()
                .unwrap_or_default()
                .trim()
                .to_owned();
            (login.into_owned(), real_name)
        },
    )
}
