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
        Request::Windows => Reply::Ok(Response::Windows { windows: state.window_infos() }),
        Request::Workspaces => Reply::Ok(Response::Workspaces { workspaces: state.workspace_infos() }),
        Request::Layers => Reply::Ok(Response::Layers { layers: state.layer_infos() }),
        Request::NightLight { temperature } => match state.set_night_light(temperature) {
            Ok(()) => Reply::Ok(Response::Handled),
            Err(e) => Reply::Error(e),
        },
        Request::Idle => {
            let (idle_secs, inhibited) = state.idle_info();
            Reply::Ok(Response::Idle { idle_secs, inhibited, config: state.config.idle.clone() })
        }
        Request::Lock => Reply::Ok(Response::Lock {
            locked: state.lock.is_locked(),
            surfaces: state.space.outputs().filter(|o| state.lock.surface_for(o).is_some()).map(|o| o.name()).collect(),
        }),
        Request::CursorPosition => {
            let p = state.seat.get_pointer().unwrap().current_location();
            Reply::Ok(Response::CursorPosition { x: p.x, y: p.y })
        }
        Request::MinimizeTargets { output, namespace, targets } => {
            let mut rects = std::collections::HashMap::new();
            for (id, [x, y, w, h]) in targets {
                let Ok(id) = id.parse::<crate::wm::WindowId>() else {
                    return Reply::Error(format!("{id:?} is not a window id"));
                };
                rects.insert(id, smithay::utils::Rectangle::new((x, y).into(), (w, h).into()));
            }
            state.set_minimize_targets(output, namespace, rects);
            Reply::Ok(Response::Handled)
        }
        Request::Do { command } => match command.parse::<crate::wm::actions::Action>() {
            Ok(action) => match state.run_action(action) {
                Ok(()) => Reply::Ok(Response::Handled),
                Err(e) => Reply::Error(e),
            },
            Err(e) => Reply::Error(e),
        },
        Request::ReloadConfig => match config::reload(state) {
            Ok(()) => Reply::Ok(Response::Handled),
            Err(e) => Reply::Error(e),
        },
        Request::Config => {
            // What is in force: an unset layout is the system's (localectl), as applied.
            let mut config = state.config.clone();
            config.input.keyboard = config.input.keyboard.with_system_defaults();
            Reply::Ok(Response::Config { config: Box::new(config) })
        }
        Request::Settings { patch } => match config::apply_settings(state, patch) {
            Ok(changed) => Reply::Ok(Response::Settings { changed }),
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

impl Hyalo {
    pub fn window_infos(&self) -> Vec<super::WindowInfo> {
        let dh = &self.display_handle;
        self.wm
            .windows
            .iter()
            .filter(|m| m.mapped)
            .map(|m| {
                let surface = m.window.toplevel().map(|t| t.wl_surface().clone());
                let pid = surface
                    .as_ref()
                    .and_then(|s| dh.get_client(smithay::reexports::wayland_server::Resource::id(s)).ok())
                    .and_then(|c| c.get_credentials(dh).ok())
                    .map(|c| c.pid);
                let parent = m.window.toplevel().and_then(|t| t.parent()).and_then(|p| self.wm.by_surface(&p)).map(|p| p.id);
                super::WindowInfo {
                    id: m.id,
                    app_id: crate::wm::app_id(&m.window),
                    title: crate::wm::title(&m.window),
                    initial_app_id: m.initial_app_id.clone(),
                    initial_title: m.initial_title.clone(),
                    pid,
                    parent,
                    workspace: m.workspace,
                    output: self.wm.workspaces.get(&m.workspace).map(|w| w.output.clone()).unwrap_or_default(),
                    floating: m.floating,
                    fullscreen: m.fullscreen,
                    pinned: m.pinned,
                    pseudo: m.pseudo,
                    focused: self.wm.focused == Some(m.id),
                    visible: self.wm.is_visible(m.workspace) && !self.wm.is_hidden(m),
                    minimized: self.wm.is_hidden(m),
                    minimized_order: m.minimized.unwrap_or(0),
                    minimize_target: self.minimize_target(m.id).map(|r| [r.loc.x, r.loc.y, r.size.w, r.size.h]),
                    drawn: self.wm.placement(m, std::time::Instant::now()).map(|p| {
                        let frame = m.frame().to_f64();
                        [p.origin.x, p.origin.y, frame.size.w * p.scale, frame.size.h * p.scale]
                    }),
                    focus_order: m.focus_serial,
                    x: m.rect.loc.x,
                    y: m.rect.loc.y,
                    width: m.rect.size.w,
                    height: m.rect.size.h,
                    look: crate::render::window::look(
                        &m.window,
                        m.fullscreen == crate::wm::Fullscreen::Fullscreen,
                        m.rounded,
                        m.backdrop,
                        &self.config.windows,
                    ),
                    title_bar: m.bar(),
                    controls: crate::protocols::window_controls::managed_rect(m, &self.config.windows.controls).map(|(r, _)| {
                        let origin = m.rect.loc.to_f64() - m.window.geometry().loc.to_f64();
                        [origin.x + r.loc.x, origin.y + r.loc.y, r.size.w, r.size.h]
                    }),
                }
            })
            .collect()
    }

    pub fn layer_infos(&self) -> Vec<super::LayerInfo> {
        use smithay::wayland::shell::wlr_layer::Layer;
        let mut out = Vec::new();
        for output in self.space.outputs() {
            let Some(og) = self.space.output_geometry(output) else { continue };
            let map = smithay::desktop::layer_map_for_output(output);
            for (level, name) in [(Layer::Background, "background"), (Layer::Bottom, "bottom"), (Layer::Top, "top"), (Layer::Overlay, "overlay")] {
                // `layers_on` is bottom first: the order they are drawn in.
                for l in map.layers_on(level) {
                    let g = crate::shell::layer::layer_geometry(&map, l).unwrap_or_default();
                    out.push(super::LayerInfo {
                        output: output.name(),
                        layer: name,
                        namespace: l.namespace().to_string(),
                        x: og.loc.x + g.loc.x,
                        y: og.loc.y + g.loc.y,
                        width: g.size.w,
                        height: g.size.h,
                        glass: crate::protocols::material::current(l.wl_surface()).map(|m| super::GlassInfo {
                            shapes: m.state.shapes.len(),
                            compositor_paints: m.state.glass.is_some(),
                            fusion: {
                                let mut groups: std::collections::BTreeMap<u32, usize> = Default::default();
                                for f in m.state.shapes.iter().filter_map(|s| s.fusion) {
                                    *groups.entry(f.group).or_default() += 1;
                                }
                                groups.into_values().collect()
                            },
                            refraction: if m.state.glass.is_some() {
                                m.state.shapes.iter().map(|s| (m.state.refraction_of(s) * 10.0).round() / 10.0).collect()
                            } else {
                                Vec::new()
                            },
                            scrims: m
                                .state
                                .scrim_units()
                                .into_iter()
                                .map(|u| {
                                    let anim = m.scrims.get(&u.key);
                                    super::ScrimInfo {
                                        kind: if u.key >= crate::protocols::material::LONE_SCRIM { "shape" } else { "region" },
                                        shapes: u.members.len(),
                                        strength: anim.map_or(0.0, |a| (a.to * 1000.0).round() / 1000.0),
                                    }
                                })
                                .collect(),
                        }),
                    });
                }
            }
        }
        out
    }

    pub fn workspace_infos(&self) -> Vec<super::WorkspaceInfo> {
        let focused_output = self.focused_output().map(|o| o.name());
        self.wm
            .workspaces
            .values()
            .map(|w| super::WorkspaceInfo {
                id: w.id,
                name: w.name.clone(),
                output: w.output.clone(),
                special: w.is_special(),
                mode: self.workspace_mode(w.id),
                // Minimized windows count: they are still on it.
                windows: self.wm.windows.iter().filter(|m| m.workspace == w.id && m.mapped).count(),
                active: self.wm.is_visible(w.id),
                focused: focused_output.as_deref() == Some(&w.output) && self.wm.active.get(&w.output) == Some(&w.id),
                last_window: self.wm.last_focused_on(w.id),
            })
            .collect()
    }

    /// What changed in the window manager since the last round, to the event stream: once per
    /// round of the event loop, however many changes it made.
    pub fn broadcast_wm_changes(&mut self) {
        let focus = self.wm.focused;
        let focus_changed = self.wm.announced_focus != Some(focus);
        if !(self.wm.dirty_windows || self.wm.dirty_workspaces || focus_changed) {
            return;
        }
        if self.ipc.has_subscribers() {
            if self.wm.dirty_windows {
                let event = Event::WindowsChanged { windows: self.window_infos() };
                broadcast(self, &event);
            }
            if self.wm.dirty_workspaces || focus_changed {
                let event = Event::WorkspacesChanged { workspaces: self.workspace_infos() };
                broadcast(self, &event);
            }
            if focus_changed {
                broadcast(self, &Event::FocusChanged { id: focus });
            }
        }
        self.wm.dirty_windows = false;
        self.wm.dirty_workspaces = false;
        self.wm.announced_focus = Some(focus);
    }
}

impl IpcState {
    pub fn has_subscribers(&self) -> bool {
        !self.subscribers.is_empty()
    }
}

impl Hyalo {
    /// `lock_changed` to every subscriber.
    pub fn ipc_broadcast_lock(&mut self, locked: bool) {
        broadcast(self, &Event::LockChanged { locked });
    }
}
