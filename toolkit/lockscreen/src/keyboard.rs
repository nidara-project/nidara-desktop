// SPDX-License-Identifier: LGPL-3.0-or-later
//! The login screen's keyboard menu (#1195 L4): which of the system's layouts the field types
//! with.
//!
//! The layouts are the keymap's, as Hyalo has it: the system's (`localectl set-x11-keymap`,
//! which the installer sets; `XkbLayout "es,us"` is two), each by its xkb name, the same
//! names Settings → Keyboard shows. With one there is nothing to choose, and the menu is not
//! offered. Choosing one is Hyalo's `keyboard_layout` request, which saves nothing: the next
//! login screen starts from the system's first layout again, and the person's session types
//! with what they chose in Settings. Hyalo grants it to the client holding the session lock.
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::time::Duration;

use crate::Msg;

/// The layouts and the one in use, asked on a thread of its own; with `set`, layout `set`
/// is made the one in use first. The answer comes to the main thread as `Msg::Layouts`.
pub fn ask(tx: Sender<Msg>, set: Option<usize>) {
    std::thread::spawn(move || match request(set) {
        Ok(answer) => {
            let _ = tx.send(Msg::Layouts(answer));
        }
        Err(e) => eprintln!("nidara-lock: the keyboard's layouts: {e}"),
    });
}

fn request(set: Option<usize>) -> Result<(Vec<String>, usize), String> {
    let path = socket().ok_or("no Hyalo socket")?;
    let mut stream = UnixStream::connect(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    let deadline = Some(Duration::from_secs(2));
    stream
        .set_read_timeout(deadline)
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(deadline)
        .map_err(|e| e.to_string())?;
    let mut line = serde_json::json!({ "request": "keyboard_layout", "set": set }).to_string();
    line.push('\n');
    stream
        .write_all(line.as_bytes())
        .map_err(|e| e.to_string())?;
    let mut reply = String::new();
    BufReader::new(stream)
        .take(64 << 10)
        .read_line(&mut reply)
        .map_err(|e| e.to_string())?;
    parse(&reply)
}

fn parse(reply: &str) -> Result<(Vec<String>, usize), String> {
    let reply: serde_json::Value = serde_json::from_str(reply).map_err(|e| e.to_string())?;
    let ok = &reply["ok"];
    let (Some(layouts), Some(active)) = (ok["layouts"].as_array(), ok["active"].as_u64()) else {
        return Err(reply["error"].as_str().unwrap_or("no answer").to_owned());
    };
    let layouts = layouts
        .iter()
        .filter_map(|l| l.as_str().map(str::to_owned))
        .collect();
    Ok((layouts, active as usize))
}

/// Hyalo's socket: `$HYALO_SOCKET`, which Hyalo sets for what it starts.
fn socket() -> Option<PathBuf> {
    std::env::var_os("HYALO_SOCKET")
        .map(PathBuf::from)
        .or_else(|| {
            let rt = std::env::var_os("XDG_RUNTIME_DIR")?;
            let display = std::env::var("WAYLAND_DISPLAY").ok()?;
            let name = std::path::Path::new(&display)
                .file_name()?
                .to_str()?
                .to_owned();
            Some(PathBuf::from(rt).join(format!("nidara-hyalo.{name}.sock")))
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_hyalo_answer_and_refusal() {
        assert_eq!(
            parse(
                r#"{"ok":{"kind":"keyboard_layout","layouts":["Spanish","English (US)"],"active":1}}"#
            ),
            Ok((vec!["Spanish".into(), "English (US)".into()], 1))
        );
        assert_eq!(
            parse(r#"{"error":"AccessDenied: no","code":"AccessDenied"}"#),
            Err("AccessDenied: no".into())
        );
    }
}
