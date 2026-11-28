//! The few calls of libpam the worker makes, and its conversation (#1195).
//!
//! Only the worker (worker.rs) uses this: one process per session, so a module that crashes or
//! hangs takes down that session's worker and never the manager. The conversation is the
//! contract the lock screen and the polkit agent already follow (#200): a prompt is answered, an
//! info or error message is passed on as written, in order, and never answered.

use std::ffi::{CStr, CString, c_char, c_int, c_void};

pub const SUCCESS: c_int = 0;
const BUF_ERR: c_int = 5;
pub const PERM_DENIED: c_int = 6;
pub const AUTH_ERR: c_int = 7;
pub const USER_UNKNOWN: c_int = 10;
pub const MAXTRIES: c_int = 11;
pub const NEW_AUTHTOK_REQD: c_int = 12;
pub const ACCT_EXPIRED: c_int = 13;
const CONV_ERR: c_int = 19;
pub const AUTHTOK_EXPIRED: c_int = 27;

const PROMPT_ECHO_OFF: c_int = 1;
const PROMPT_ECHO_ON: c_int = 2;
const ERROR_MSG: c_int = 3;
const TEXT_INFO: c_int = 4;

const ITEM_TTY: c_int = 3;
const ESTABLISH_CRED: c_int = 0x0002;
const DELETE_CRED: c_int = 0x0004;
const CHANGE_EXPIRED_AUTHTOK: c_int = 0x0020;

#[repr(C)]
struct Message {
    style: c_int,
    msg: *const c_char,
}

#[repr(C)]
struct Response {
    resp: *mut c_char,
    retcode: c_int,
}

#[repr(C)]
struct Conv {
    conv: extern "C" fn(c_int, *mut *const Message, *mut *mut Response, *mut c_void) -> c_int,
    appdata: *mut c_void,
}

#[repr(C)]
struct Handle {
    _private: [u8; 0],
}

#[link(name = "pam")]
unsafe extern "C" {
    fn pam_start(
        service: *const c_char,
        user: *const c_char,
        conv: *const Conv,
        pamh: *mut *mut Handle,
    ) -> c_int;
    fn pam_end(pamh: *mut Handle, status: c_int) -> c_int;
    fn pam_set_item(pamh: *mut Handle, item: c_int, value: *const c_void) -> c_int;
    fn pam_authenticate(pamh: *mut Handle, flags: c_int) -> c_int;
    fn pam_acct_mgmt(pamh: *mut Handle, flags: c_int) -> c_int;
    fn pam_chauthtok(pamh: *mut Handle, flags: c_int) -> c_int;
    fn pam_setcred(pamh: *mut Handle, flags: c_int) -> c_int;
    fn pam_open_session(pamh: *mut Handle, flags: c_int) -> c_int;
    fn pam_close_session(pamh: *mut Handle, flags: c_int) -> c_int;
    fn pam_putenv(pamh: *mut Handle, name_value: *const c_char) -> c_int;
    fn pam_getenvlist(pamh: *mut Handle) -> *mut *mut c_char;
    fn pam_strerror(pamh: *mut Handle, errnum: c_int) -> *const c_char;
}

/// What a conversation hears and says: the worker passes it to the manager, which passes it to
/// the login screen.
pub trait Conversation {
    /// A prompt: `None` ends the conversation (the person cancelled, or the screen is gone).
    fn prompt(&mut self, echo: bool, text: &str) -> Option<String>;
    fn info(&mut self, text: &str);
    fn error(&mut self, text: &str);
}

/// A PAM transaction, ended (`pam_end`) when dropped.
pub struct Pam {
    handle: *mut Handle,
    /// Boxed so its address, given to libpam as `appdata`, never moves.
    _conv: Box<Conv>,
    _talk: Box<Box<dyn Conversation>>,
    last: c_int,
}

impl Pam {
    pub fn start(service: &str, user: &str, talk: Box<dyn Conversation>) -> Result<Self, String> {
        let service = CString::new(service).map_err(|_| "service name with a NUL")?;
        let user = CString::new(user).map_err(|_| "user name with a NUL")?;
        let mut talk = Box::new(talk);
        let conv = Box::new(Conv {
            conv: converse,
            appdata: (&mut *talk) as *mut Box<dyn Conversation> as *mut c_void,
        });
        let mut handle = std::ptr::null_mut();
        // Safety: the strings outlive the call; `conv` and `talk` live as long as the handle.
        let rc = unsafe { pam_start(service.as_ptr(), user.as_ptr(), &*conv, &mut handle) };
        if rc != SUCCESS || handle.is_null() {
            return Err(format!("pam_start failed ({rc})"));
        }
        Ok(Self {
            handle,
            _conv: conv,
            _talk: talk,
            last: SUCCESS,
        })
    }

    fn check(&mut self, rc: c_int) -> Result<(), c_int> {
        self.last = rc;
        if rc == SUCCESS { Ok(()) } else { Err(rc) }
    }

    pub fn strerror(&self, rc: c_int) -> String {
        // Safety: libpam returns a static string.
        let s = unsafe { pam_strerror(self.handle, rc) };
        if s.is_null() {
            format!("PAM error {rc}")
        } else {
            unsafe { CStr::from_ptr(s) }.to_string_lossy().into_owned()
        }
    }

    pub fn set_tty(&mut self, tty: &str) -> Result<(), c_int> {
        let tty = CString::new(tty).map_err(|_| BUF_ERR)?;
        let rc = unsafe { pam_set_item(self.handle, ITEM_TTY, tty.as_ptr() as *const c_void) };
        self.check(rc)
    }

    pub fn authenticate(&mut self) -> Result<(), c_int> {
        let rc = unsafe { pam_authenticate(self.handle, 0) };
        self.check(rc)
    }

    /// `pam_acct_mgmt`; an expired password is changed there and then, through the same
    /// conversation, as on any other login (`pam_chauthtok`).
    pub fn account(&mut self) -> Result<(), c_int> {
        let rc = unsafe { pam_acct_mgmt(self.handle, 0) };
        if rc == NEW_AUTHTOK_REQD {
            let rc = unsafe { pam_chauthtok(self.handle, CHANGE_EXPIRED_AUTHTOK) };
            return self.check(rc);
        }
        self.check(rc)
    }

    pub fn putenv(&mut self, name: &str, value: &str) -> Result<(), c_int> {
        let nv = CString::new(format!("{name}={value}")).map_err(|_| BUF_ERR)?;
        let rc = unsafe { pam_putenv(self.handle, nv.as_ptr()) };
        self.check(rc)
    }

    pub fn open_session(&mut self) -> Result<(), c_int> {
        let rc = unsafe { pam_setcred(self.handle, ESTABLISH_CRED) };
        self.check(rc)?;
        let rc = unsafe { pam_open_session(self.handle, 0) };
        self.check(rc)
    }

    pub fn close_session(&mut self) {
        unsafe {
            pam_close_session(self.handle, 0);
            pam_setcred(self.handle, DELETE_CRED);
        }
    }

    /// The environment the modules set (pam_systemd's XDG_RUNTIME_DIR, pam_env's), as
    /// `NAME=value` pairs.
    pub fn env(&self) -> Vec<(String, String)> {
        let mut out = Vec::new();
        let list = unsafe { pam_getenvlist(self.handle) };
        if list.is_null() {
            return out;
        }
        let mut i = 0;
        loop {
            // Safety: a NULL-terminated array of malloc'd strings, each freed here, then the array.
            let item = unsafe { *list.add(i) };
            if item.is_null() {
                break;
            }
            let s = unsafe { CStr::from_ptr(item) }
                .to_string_lossy()
                .into_owned();
            if let Some((k, v)) = s.split_once('=') {
                out.push((k.to_string(), v.to_string()));
            }
            unsafe { libc::free(item as *mut c_void) };
            i += 1;
        }
        unsafe { libc::free(list as *mut c_void) };
        out
    }
}

impl Drop for Pam {
    fn drop(&mut self) {
        unsafe { pam_end(self.handle, self.last) };
    }
}

/// libpam's conversation callback: each message to the `Conversation`, the answers back in
/// malloc'd memory libpam frees.
extern "C" fn converse(
    n: c_int,
    msgs: *mut *const Message,
    out: *mut *mut Response,
    appdata: *mut c_void,
) -> c_int {
    if n <= 0 || msgs.is_null() || out.is_null() || appdata.is_null() {
        return CONV_ERR;
    }
    // Safety: `appdata` is the boxed conversation `Pam::start` gave libpam.
    let talk = unsafe { &mut *(appdata as *mut Box<dyn Conversation>) };
    let n = n as usize;
    let responses = unsafe { libc::calloc(n, std::mem::size_of::<Response>()) } as *mut Response;
    if responses.is_null() {
        return BUF_ERR;
    }
    for i in 0..n {
        // Linux-PAM passes an array of pointers (`msgs[i]`), the layout every module uses.
        let m = unsafe { &**msgs.add(i) };
        let text = if m.msg.is_null() {
            String::new()
        } else {
            unsafe { CStr::from_ptr(m.msg) }
                .to_string_lossy()
                .into_owned()
        };
        match m.style {
            PROMPT_ECHO_OFF | PROMPT_ECHO_ON => {
                let Some(mut answer) = talk.prompt(m.style == PROMPT_ECHO_ON, &text) else {
                    free_responses(responses, n);
                    return CONV_ERR;
                };
                let c = CString::new(answer.as_bytes()).unwrap_or_default();
                wipe(&mut answer);
                let dup = unsafe { libc::strdup(c.as_ptr()) };
                let mut bytes = c.into_bytes();
                bytes.iter_mut().for_each(|b| *b = 0);
                if dup.is_null() {
                    free_responses(responses, n);
                    return BUF_ERR;
                }
                unsafe { (*responses.add(i)).resp = dup };
            }
            ERROR_MSG => talk.error(&text),
            TEXT_INFO => talk.info(&text),
            _ => {
                free_responses(responses, n);
                return CONV_ERR;
            }
        }
    }
    unsafe { *out = responses };
    SUCCESS
}

fn free_responses(responses: *mut Response, n: usize) {
    for i in 0..n {
        let r = unsafe { &mut *responses.add(i) };
        if !r.resp.is_null() {
            let len = unsafe { libc::strlen(r.resp) };
            unsafe { std::ptr::write_bytes(r.resp, 0, len) };
            unsafe { libc::free(r.resp as *mut c_void) };
        }
    }
    unsafe { libc::free(responses as *mut c_void) };
}

/// Overwrites a secret before it is dropped.
pub fn wipe(s: &mut String) {
    // Safety: zero bytes are valid UTF-8.
    unsafe { s.as_bytes_mut() }.iter_mut().for_each(|b| *b = 0);
    s.clear();
}
