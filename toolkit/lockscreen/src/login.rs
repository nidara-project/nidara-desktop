// SPDX-License-Identifier: LGPL-3.0-or-later
//! The login screen's attempt (#1195, step 1): the same screen as the lock, run by Hyalo in
//! login mode, authenticating through `nidara-login` instead of PAM in this process.
//!
//! The manager runs PAM in a worker of its own and passes its conversation here over the
//! socket in `NIDARA_LOGIN_SOCKET` (session/login/src/proto.rs). The contract is the lock's:
//! the one prompt is answered with the field, info and error messages are shown in order,
//! never answered. A second prompt (a new password for an expired one) needs the login
//! screen's own field for it, so it is cancelled here.
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;
use std::sync::mpsc::Sender;

use crate::auth::Said;

static LINK: Mutex<Option<UnixStream>> = Mutex::new(None);

/// Is this the login screen? Then `nidara-login` named its socket.
pub fn socket() -> Option<String> {
    std::env::var("NIDARA_LOGIN_SOCKET")
        .ok()
        .filter(|s| !s.is_empty())
}

fn link() -> Result<UnixStream, String> {
    let mut held = LINK.lock().unwrap();
    if held.is_none() {
        let path = socket().ok_or("no NIDARA_LOGIN_SOCKET")?;
        *held = Some(UnixStream::connect(&path).map_err(|e| format!("{path}: {e}"))?);
    }
    held.as_ref()
        .unwrap()
        .try_clone()
        .map_err(|e| e.to_string())
}

fn send(stream: &mut UnixStream, value: serde_json::Value) -> std::io::Result<()> {
    let mut text = value.to_string();
    text.push('\n');
    let r = stream.write_all(text.as_bytes());
    // Safety: zero bytes are valid UTF-8.
    unsafe { text.as_bytes_mut() }
        .iter_mut()
        .for_each(|b| *b = 0);
    r
}

/// One attempt for `user` with `secret`, on a thread of its own, as `auth::attempt`.
pub fn attempt(user: &str, secret: nk::Secret, said: Sender<Said>) {
    let user = user.to_owned();
    std::thread::spawn(move || {
        if let Err(e) = run(&user, secret, &said) {
            eprintln!("nidara-lock: the login could not run: {e}");
            *LINK.lock().unwrap() = None;
            let _ = said.send(Said::Fail { denied: false });
        }
    });
}

fn run(user: &str, secret: nk::Secret, said: &Sender<Said>) -> Result<(), String> {
    let mut stream = link()?;
    let mut read = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    send(
        &mut stream,
        serde_json::json!({"type": "begin", "user": user}),
    )
    .map_err(|e| e.to_string())?;
    let mut answered = false;
    let mut line = String::new();
    loop {
        line.clear();
        if read.read_line(&mut line).map_err(|e| e.to_string())? == 0 {
            return Err("nidara-login closed the connection".into());
        }
        let msg: serde_json::Value =
            serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
        let text = msg["text"].as_str().unwrap_or_default().to_owned();
        match msg["type"].as_str() {
            Some("prompt") if !answered => {
                answered = true;
                // Written out by hand so no copy of the secret outlives this line but the one
                // wiped below (a serde_json Value would keep its own).
                let mut text = String::from("{\"type\":\"answer\",\"text\":");
                text.push_str(&serde_json::to_string(secret.as_str()).unwrap_or_default());
                text.push_str("}\n");
                let r = stream.write_all(text.as_bytes());
                // Safety: zero bytes are valid UTF-8.
                unsafe { text.as_bytes_mut() }
                    .iter_mut()
                    .for_each(|b| *b = 0);
                r.map_err(|e| e.to_string())?;
            }
            Some("prompt") => {
                let _ = send(&mut stream, serde_json::json!({"type": "cancel"}));
                let _ = said.send(Said::Fail { denied: true });
                return Ok(());
            }
            Some("info") => {
                let _ = said.send(Said::Info(text));
            }
            Some("error") => {
                let _ = said.send(Said::Error(text));
            }
            Some("success") => {
                let _ = said.send(Said::Success { expired: false });
                return Ok(());
            }
            Some("failed") => {
                let denied = msg["reason"].as_str() == Some("account");
                let _ = said.send(Said::Fail { denied });
                return Ok(());
            }
            _ => {}
        }
    }
}

/// After success: the manager may start the session once this screen ends, in `language`
/// when one was chosen on this screen (L4: it becomes the person's).
pub fn start(language: Option<&str>) -> Result<(), String> {
    let mut stream = link()?;
    let mut start = serde_json::json!({"type": "start"});
    if let Some(l) = language {
        start["language"] = l.into();
    }
    send(&mut stream, start).map_err(|e| e.to_string())
}
