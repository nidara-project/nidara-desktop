// SPDX-License-Identifier: LGPL-3.0-or-later
//! Hyalo's window truth for the dock (DOCK.md §3, APPLICATIONS1-DOCK.md §2 "Before H1"):
//! subscribe to the event stream, wait for its acknowledgement, then read the windows.
//! Every event is an invalidation: the list is read again after a short coalescing
//! pause, so an event that crossed the first reply can never leave an older list behind.
//! Requests (focus, minimize, targets) use the same socket protocol with a deadline.
use crate::model::Window;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

pub const DEADLINE: Duration = Duration::from_secs(2);
/// Events closer together than this are one invalidation.
const COALESCE: Duration = Duration::from_millis(30);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct HyaloWindow {
    pub window: Window,
    pub output: String,
    /// Over the whole output (not Maximized): that output's dock hides.
    pub fullscreen: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub enum HyaloUpdate {
    /// `epoch` changes with every new connection: window IDs never carry across it.
    Windows {
        epoch: u64,
        windows: Vec<HyaloWindow>,
    },
    Lock(bool),
    Unavailable(String),
}

pub fn socket() -> Option<PathBuf> {
    std::env::var_os("HYALO_SOCKET")
        .map(PathBuf::from)
        .or_else(|| {
            let rt = std::env::var_os("XDG_RUNTIME_DIR")?;
            let display = std::env::var("WAYLAND_DISPLAY").ok()?;
            let name = std::path::Path::new(&display).file_name()?.to_str()?;
            Some(PathBuf::from(rt).join(format!("nidara-hyalo.{name}.sock")))
        })
}

fn connect() -> Result<UnixStream, String> {
    let stream =
        UnixStream::connect(socket().ok_or("Hyalo socket unknown")?).map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(DEADLINE))
        .map_err(|e| e.to_string())?;
    stream
        .set_write_timeout(Some(DEADLINE))
        .map_err(|e| e.to_string())?;
    Ok(stream)
}

fn send(stream: &mut UnixStream, value: &Value) -> Result<(), String> {
    let mut line = value.to_string();
    line.push('\n');
    stream.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

fn reply(reader: &mut impl BufRead) -> Result<Value, String> {
    let mut bytes = vec![];
    let n = reader
        .take(4 << 20)
        .read_until(b'\n', &mut bytes)
        .map_err(|e| e.to_string())?;
    if n == 0 || bytes.last() != Some(&b'\n') {
        return Err("incomplete compositor reply".into());
    }
    let reply: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if let Some(error) = reply.get("error") {
        return Err(error.as_str().unwrap_or("compositor refused").to_string());
    }
    reply
        .get("ok")
        .cloned()
        .ok_or_else(|| "missing compositor result".to_string())
}

/// One request, one reply, within the deadline.
pub fn request(value: Value) -> Result<Value, String> {
    let mut stream = connect()?;
    send(&mut stream, &value)?;
    reply(&mut BufReader::new(stream))
}

pub fn parse_windows(ok: &Value) -> Vec<HyaloWindow> {
    let s = |w: &Value, k: &str| w[k].as_str().unwrap_or_default().to_string();
    let n = |w: &Value, k: &str| w[k].as_u64().unwrap_or_default();
    let b = |w: &Value, k: &str| w[k].as_bool().unwrap_or_default();
    ok["windows"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|w| {
            Some(HyaloWindow {
                window: Window {
                    id: w["id"].as_u64()?,
                    app_id: s(w, "app_id"),
                    initial_app_id: s(w, "initial_app_id"),
                    title: s(w, "title"),
                    parent: w["parent"].as_u64(),
                    minimized: b(w, "minimized"),
                    minimized_order: n(w, "minimized_order"),
                    focus_order: n(w, "focus_order"),
                    focused: b(w, "focused"),
                },
                output: s(w, "output"),
                fullscreen: w["fullscreen"].as_str() == Some("fullscreen"),
            })
        })
        .collect()
}

/// Runs forever on its own thread. A lost connection is reported and retried with
/// backoff, under a new epoch.
pub fn watch(emit: impl Fn(HyaloUpdate)) {
    let mut epoch = 0;
    let mut backoff = Duration::from_millis(250);
    loop {
        epoch += 1;
        let started = std::time::Instant::now();
        let e = stream(epoch, &emit).unwrap_err();
        emit(HyaloUpdate::Unavailable(e));
        if started.elapsed() > Duration::from_secs(10) {
            backoff = Duration::from_millis(250);
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(10));
    }
}

fn stream(epoch: u64, emit: &impl Fn(HyaloUpdate)) -> Result<(), String> {
    let mut events = connect()?;
    send(&mut events, &json!({"request": "event_stream"}))?;
    let mut reader = BufReader::new(events.try_clone().map_err(|e| e.to_string())?);
    reply(&mut reader)?;
    // Subscribed and acknowledged: only now the first reads.
    let locked = request(json!({"request": "lock"}))?["locked"]
        .as_bool()
        .unwrap_or(false);
    emit(HyaloUpdate::Lock(locked));
    emit(HyaloUpdate::Windows {
        epoch,
        windows: parse_windows(&request(json!({"request": "windows"}))?),
    });
    loop {
        events.set_read_timeout(None).map_err(|e| e.to_string())?;
        let mut stale = false;
        let mut line = String::new();
        // Block for the next event, then gather whatever follows it closely.
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => return Err("compositor event stream closed".into()),
                Ok(_) => {}
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    break;
                }
                Err(e) => return Err(e.to_string()),
            }
            let event: Value = serde_json::from_str(&line).unwrap_or_default();
            match event["event"].as_str() {
                Some("lock_changed") => emit(HyaloUpdate::Lock(
                    event["locked"].as_bool().unwrap_or(false),
                )),
                Some(
                    "windows_changed" | "focus_changed" | "outputs_changed" | "workspaces_changed",
                ) => stale = true,
                _ => {}
            }
            events
                .set_read_timeout(Some(COALESCE))
                .map_err(|e| e.to_string())?;
        }
        if stale {
            emit(HyaloUpdate::Windows {
                epoch,
                windows: parse_windows(&request(json!({"request": "windows"}))?),
            });
        }
    }
}

/// Window commands the dock sends, by stable ID; Hyalo answers each.
pub fn act(verb: &str, id: u64) -> Result<(), String> {
    request(json!({"request": "do", "command": format!("{verb} {id}")})).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_parse_from_the_reply_shape() {
        let ok = json!({"kind": "windows", "windows": [
            {"id": 7, "app_id": "foot", "initial_app_id": "foot", "title": "~", "parent": null,
             "minimized": true, "minimized_order": 3, "focus_order": 9, "focused": false,
             "output": "HDMI-A-1", "fullscreen": "none"},
            {"id": 8, "app_id": "mpv", "parent": 7, "fullscreen": "fullscreen", "output": "DP-1"},
            {"app_id": "no id"}
        ]});
        let w = parse_windows(&ok);
        assert_eq!(w.len(), 2);
        assert_eq!(
            (
                w[0].window.id,
                w[0].window.minimized,
                w[0].window.minimized_order
            ),
            (7, true, 3)
        );
        assert_eq!((w[0].output.as_str(), w[0].fullscreen), ("HDMI-A-1", false));
        assert_eq!((w[1].window.parent, w[1].fullscreen), (Some(7), true));
    }

    #[test]
    fn events_invalidate_and_a_closed_stream_is_an_error() {
        // A private fake Hyalo: acknowledges the stream, answers lock/windows, sends
        // three close events (one read of the list), then closes.
        let dir = std::env::temp_dir().join(format!("nk-shell-hyalo-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("h.sock");
        let _ = std::fs::remove_file(&path);
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        // SAFETY: tests in this module run this one place that sets the variable.
        unsafe { std::env::set_var("HYALO_SOCKET", &path) };
        let server = std::thread::spawn(move || {
            let mut reads = 0;
            let mut stream_conn = None;
            for conn in listener.incoming() {
                let mut conn = conn.unwrap();
                let mut line = String::new();
                BufReader::new(conn.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                let req: Value = serde_json::from_str(&line).unwrap();
                let answer = match req["request"].as_str().unwrap() {
                    "event_stream" => json!({"ok": {"kind": "handled"}}),
                    "lock" => json!({"ok": {"kind": "lock", "locked": false}}),
                    "windows" => {
                        reads += 1;
                        json!({"ok": {"kind": "windows", "windows": [{"id": reads}]}})
                    }
                    _ => unreachable!(),
                };
                writeln!(conn, "{answer}").unwrap();
                match req["request"].as_str().unwrap() {
                    "event_stream" => stream_conn = Some(conn),
                    "windows" if reads == 1 => {
                        let s = stream_conn.as_mut().unwrap();
                        for _ in 0..3 {
                            writeln!(s, "{}", json!({"event": "windows_changed", "windows": []}))
                                .unwrap();
                        }
                    }
                    "windows" => {
                        drop(stream_conn.take());
                        return reads;
                    }
                    _ => {}
                }
            }
            0
        });
        let seen = std::cell::RefCell::new(vec![]);
        let e = stream(1, &|u| seen.borrow_mut().push(u)).unwrap_err();
        assert_eq!(e, "compositor event stream closed");
        assert_eq!(server.join().unwrap(), 2);
        let ids: Vec<Vec<u64>> = seen
            .borrow()
            .iter()
            .filter_map(|u| match u {
                HyaloUpdate::Windows { windows, .. } => {
                    Some(windows.iter().map(|w| w.window.id).collect())
                }
                _ => None,
            })
            .collect();
        // The first list, then ONE reread for the three events.
        assert_eq!(ids, [vec![1], vec![2]]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
