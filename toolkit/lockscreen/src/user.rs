// SPDX-License-Identifier: LGPL-3.0-or-later
//! Whose session this is: the login PAM is asked about, the name shown and the picture.
//!
//! The lock screen runs AS the user, in the session it locks, so it reads only that user's
//! own entry and files: the real name from GECOS (up to the first comma, as #1192's
//! authentication dialog shows it), the picture AccountsService keeps for them, else their
//! `~/.face`, else the kit's default avatar glyph (the TS lock screen's order).
use std::ffi::CStr;
use std::path::PathBuf;

#[derive(Clone, Debug, Default)]
pub struct User {
    pub login: String,
    /// GECOS's first field; the login when it is empty.
    pub name: String,
    pub picture: Option<PathBuf>,
}

impl User {
    pub fn current() -> Self {
        // SAFETY: getpwuid's static entry, read at once on this thread.
        Self::from_entry(unsafe { libc::getpwuid(libc::getuid()) })
    }

    /// The people the login screen offers (#1195 L1), in the order of their accounts, and
    /// which of them is chosen: whoever logged in last on this machine (`nidara-login` keeps
    /// the name, world-readable), else the first.
    pub fn for_login() -> (Vec<Self>, usize) {
        let mut people = Vec::new();
        // SAFETY: the passwd walk, on this thread only, each entry copied before the next.
        unsafe {
            libc::setpwent();
            loop {
                let pw = libc::getpwent();
                if pw.is_null() {
                    break;
                }
                if is_person(&*pw) {
                    people.push(((*pw).pw_uid, Self::from_entry(pw)));
                }
            }
            libc::endpwent();
        }
        people.sort_by_key(|(uid, _)| *uid);
        let mut people: Vec<Self> = people.into_iter().map(|(_, u)| u).collect();
        let last = std::fs::read_to_string(LAST_USER)
            .ok()
            .map(|s| s.trim().to_owned())
            .filter(|n| !n.is_empty());
        let chosen = last
            .as_ref()
            .and_then(|name| people.iter().position(|u| &u.login == name));
        if people.is_empty() {
            people.push(Self::default());
        }
        (people, chosen.unwrap_or(0))
    }

    fn from_entry(pw: *mut libc::passwd) -> Self {
        // SAFETY: a passwd entry from libc, copied out at once.
        let (login, gecos, home) = unsafe {
            if pw.is_null() {
                let login = std::env::var("USER").unwrap_or_default();
                (
                    login,
                    String::new(),
                    std::env::var("HOME").unwrap_or_default(),
                )
            } else {
                let text = |p: *const libc::c_char| {
                    if p.is_null() {
                        String::new()
                    } else {
                        CStr::from_ptr(p).to_string_lossy().into_owned()
                    }
                };
                (
                    text((*pw).pw_name),
                    text((*pw).pw_gecos),
                    text((*pw).pw_dir),
                )
            }
        };
        let real = gecos.split(',').next().unwrap_or("").trim().to_owned();
        let name = if real.is_empty() { login.clone() } else { real };
        let picture = [
            PathBuf::from("/var/lib/AccountsService/icons").join(&login),
            PathBuf::from(&home).join(".face"),
        ]
        .into_iter()
        .find(|p| !login.is_empty() && p.is_file());
        Self {
            login,
            name,
            picture,
        }
    }
}

/// Where `nidara-login` keeps who logged in last.
pub const LAST_USER: &str = "/var/lib/nidara-login/last-user";

/// A person's account, not a system one: the uid range `useradd` gives people
/// (/etc/login.defs's UID_MIN..UID_MAX on Arch) and a shell one can log in with.
fn is_person(pw: &libc::passwd) -> bool {
    if !(1000..60000).contains(&pw.pw_uid) || pw.pw_shell.is_null() {
        return false;
    }
    // SAFETY: a NUL-terminated string of the entry.
    let shell = unsafe { CStr::from_ptr(pw.pw_shell) }.to_string_lossy();
    !(shell.ends_with("/nologin") || shell.ends_with("/false"))
}
