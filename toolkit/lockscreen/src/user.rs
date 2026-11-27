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
        // SAFETY: getpwuid's static entry, copied out at once on this thread before any
        // other passwd call.
        let (login, gecos, home) = unsafe {
            let pw = libc::getpwuid(libc::getuid());
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
