//! The IPC socket's server side, on the compositor's event loop.

use std::{
    io::{Read, Write},
    os::unix::net::{UnixListener, UnixStream},
    path::PathBuf,
};

use smithay::reexports::calloop::{Interest, Mode, PostAction, generic::Generic};

use super::{Event, Reply, Request, Response};
use crate::{config, outputs, state::Hyalo};

#[derive(Default)]
pub struct IpcState {
    path: Option<PathBuf>,
    subscribers: Vec<UnixStream>,
}

impl Drop for IpcState {
    fn drop(&mut self) {
        if let Some(p) = &self.path {
            let _ = std::fs::remove_file(p);
        }
    }
}

pub fn start(state: &mut Hyalo) {
    let path = super::socket_path(&state.socket_name.to_string_lossy());
    let _ = std::fs::remove_file(&path);
    let listener = match UnixListener::bind(&path) {
        Ok(l) => l,
        Err(err) => {
            tracing::error!(?path, ?err, "IPC socket not available");
            return;
        }
    };
    let _ = listener.set_nonblocking(true);
    // Safety: still single-threaded at startup.
    unsafe { std::env::set_var("HYALO_SOCKET", &path) };
    state.ipc.path = Some(path);
    let source = Generic::new(listener, Interest::READ, Mode::Level);
    let inserted = state.loop_handle.insert_source(source, |_, listener, state| {
        while let Ok((stream, _)) = listener.accept() {
            accept(state, stream);
        }
        Ok(PostAction::Continue)
    });
    if let Err(err) = inserted {
        tracing::error!(?err, "IPC socket not listened to");
    }
}

fn accept(state: &mut Hyalo, stream: UnixStream) {
    let _ = stream.set_nonblocking(true);
    let mut buffer = Vec::new();
    let source = Generic::new(stream, Interest::READ, Mode::Level);
    let _ = state.loop_handle.insert_source(source, move |_, stream, state| {
        let mut chunk = [0u8; 4096];
        // Safety: the stream is only ever read and written here, never closed under us.
        let s = unsafe { stream.get_mut() };
        loop {
            match s.read(&mut chunk) {
                Ok(0) => return Ok(PostAction::Remove),
                Ok(n) => buffer.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(_) => return Ok(PostAction::Remove),
            }
        }
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let line = String::from_utf8_lossy(&line);
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let reply = match serde_json::from_str::<Request>(line) {
                Ok(Request::EventStream) => {
                    match s.try_clone() {
                        Ok(clone) => {
                            let _ = write_line(s, &Reply::Ok(Response::Handled));
                            state.ipc.subscribers.push(clone);
                        }
                        Err(_) => return Ok(PostAction::Remove),
                    }
                    // The connection is a stream from now on; nothing more is read from it.
                    return Ok(PostAction::Remove);
                }
                Ok(req) => handle(state, req),
                Err(err) => Reply::Error(format!("cannot read the request: {err}")),
            };
            if write_line(s, &reply).is_err() {
                return Ok(PostAction::Remove);
            }
        }
        Ok(PostAction::Continue)
    });
}

fn write_line<T: serde::Serialize>(s: &mut UnixStream, value: &T) -> std::io::Result<()> {
    let mut text = serde_json::to_string(value).map_err(std::io::Error::other)?;
    text.push('\n');
    let _ = s.set_nonblocking(false);
    let r = s.write_all(text.as_bytes());
    let _ = s.set_nonblocking(true);
    r
}

fn handle(state: &mut Hyalo, req: Request) -> Reply {
    match req {
        Request::Version => Reply::Ok(Response::Version { version: env!("CARGO_PKG_VERSION").into() }),
        Request::Outputs => Reply::Ok(Response::Outputs { outputs: outputs::info(state) }),
        Request::SetOutput { ref name, .. } => {
            let name = name.clone();
            let base = state.config.outputs.get(&name).cloned().unwrap_or_default();
            let cfg = super::merged_output_config(&base, &req);
            // Runtime only: the shell persists what the user chose in its own settings.
            let previous = state.config.outputs.insert(name.clone(), cfg.clone());
            match outputs::apply(state, &name, &cfg) {
                Ok(()) => {
                    outputs_changed(state);
                    Reply::Ok(Response::Handled)
                }
                Err(e) => {
                    match previous {
                        Some(p) => state.config.outputs.insert(name, p),
                        None => state.config.outputs.remove(&name),
                    };
                    Reply::Error(e)
                }
            }
        }
        Request::OutputPower { name, on } => match outputs::set_power(state, name.as_deref(), on) {
            Ok(()) => {
                outputs_changed(state);
                Reply::Ok(Response::Handled)
            }
            Err(e) => Reply::Error(e),
        },
        Request::Screenshot { path, output } => {
            match crate::backend::screenshot(state, output.as_deref(), std::path::Path::new(&path)) {
                Ok(()) => Reply::Ok(Response::Handled),
                Err(e) => Reply::Error(e),
            }
        }
        Request::ReloadConfig => match config::reload(state) {
            Ok(()) => Reply::Ok(Response::Handled),
            Err(e) => Reply::Error(e),
        },
        Request::Quit => {
            state.loop_signal.stop();
            Reply::Ok(Response::Handled)
        }
        Request::EventStream => unreachable!("handled by the connection"),
    }
}

/// Sends an event to every subscriber. Never blocks: a subscriber that does not keep up
/// (its socket buffer full) is dropped rather than allowed to stall the compositor.
pub fn broadcast(state: &mut Hyalo, event: &Event) {
    let Ok(mut text) = serde_json::to_string(event) else { return };
    text.push('\n');
    state.ipc.subscribers.retain_mut(|s| {
        let _ = s.set_nonblocking(true);
        s.write_all(text.as_bytes()).is_ok()
    });
}

pub fn outputs_changed(state: &mut Hyalo) {
    if state.ipc.subscribers.is_empty() {
        return;
    }
    let event = Event::OutputsChanged { outputs: outputs::info(state) };
    broadcast(state, &event);
}
