//! IPC: a Unix socket speaking one JSON object per line, both ways.
//!
//! The socket is `$XDG_RUNTIME_DIR/nidara-hyalo.<WAYLAND_DISPLAY>.sock`, and every child of
//! Hyalo finds it in `$HYALO_SOCKET`. A client sends a `Request`, gets one `Reply` back; the
//! `event_stream` request turns the connection into a stream of `Event`s instead, one per
//! line, for as long as the client keeps it open.
//!
//! This is what the shell talks to instead of `hyprctl`, and `nidara-hyalo msg` is the same
//! thing for scripts. Runtime changes go through here, never by rewriting a file.

pub mod client;
pub mod server;

use serde::{Deserialize, Serialize};

use crate::{
    config::OutputConfig,
    outputs::OutputInfo,
    wm::{Fullscreen, WindowId, WorkspaceMode},
};

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub id: WindowId,
    pub app_id: String,
    pub title: String,
    pub pid: Option<i32>,
    /// The window it is a dialog of.
    pub parent: Option<WindowId>,
    pub workspace: i32,
    pub output: String,
    pub floating: bool,
    pub fullscreen: Fullscreen,
    pub pinned: bool,
    pub pseudo: bool,
    pub focused: bool,
    /// Whether it is on screen now (its workspace is shown).
    pub visible: bool,
    /// Higher = focused more recently; 0 = never focused.
    pub focus_order: u64,
    /// The window's own box (no border), global logical pixels.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct WorkspaceInfo {
    pub id: i32,
    pub name: String,
    pub output: String,
    pub special: bool,
    pub mode: WorkspaceMode,
    pub windows: usize,
    /// Shown on its output (a special one: shown over it).
    pub active: bool,
    /// On the output the user is on.
    pub focused: bool,
    pub last_window: Option<WindowId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "request", rename_all = "snake_case")]
pub enum Request {
    Version,
    Outputs,
    /// Fields left out keep their current value.
    SetOutput {
        name: String,
        #[serde(default)]
        enabled: Option<bool>,
        #[serde(default)]
        mode: Option<String>,
        #[serde(default)]
        scale: Option<f64>,
        #[serde(default)]
        transform: Option<String>,
        #[serde(default)]
        position: Option<(i32, i32)>,
        #[serde(default)]
        vrr: Option<bool>,
    },
    /// DPMS. No name = every output.
    OutputPower {
        #[serde(default)]
        name: Option<String>,
        on: bool,
    },
    /// A PNG of one output (no name = the first) at `path`.
    Screenshot {
        path: String,
        #[serde(default)]
        output: Option<String>,
    },
    /// Every window the window manager knows, shown or not.
    Windows,
    Workspaces,
    /// A window-manager command, written as in a binding: `workspace 3`, `focus-window 12`
    /// (wm/actions.rs).
    Do { command: String },
    ReloadConfig,
    Quit,
    EventStream,
}

// Replies and events are only written by Hyalo; the CLI prints them as they come.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Reply {
    Ok(Response),
    Error(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Response {
    Handled,
    Version { version: String },
    Outputs { outputs: Vec<OutputInfo> },
    Windows { windows: Vec<WindowInfo> },
    Workspaces { workspaces: Vec<WorkspaceInfo> },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    OutputsChanged { outputs: Vec<OutputInfo> },
    /// A window opened, closed, moved to another workspace, or changed state or app id. Not
    /// sent for a title alone (`WindowTitleChanged`): a terminal's spinner renames its window
    /// many times a second, and a list consumer repaints on this one.
    WindowsChanged { windows: Vec<WindowInfo> },
    WorkspacesChanged { workspaces: Vec<WorkspaceInfo> },
    /// The keyboard went to another window, or to none.
    FocusChanged { id: Option<WindowId> },
    WindowTitleChanged { id: WindowId, title: String },
    ConfigReloaded,
    ConfigError { message: String },
}

pub fn socket_path(wayland_display: &str) -> std::path::PathBuf {
    let runtime = std::env::var_os("XDG_RUNTIME_DIR").unwrap_or_else(|| "/tmp".into());
    std::path::PathBuf::from(runtime).join(format!("nidara-hyalo.{wayland_display}.sock"))
}

/// A `SetOutput` request merged onto an output's current configuration.
pub fn merged_output_config(base: &OutputConfig, req: &Request) -> OutputConfig {
    let mut c = base.clone();
    if let Request::SetOutput { enabled, mode, scale, transform, position, vrr, .. } = req {
        if let Some(v) = enabled {
            c.enabled = *v;
        }
        if let Some(v) = mode {
            c.mode = v.clone();
        }
        if let Some(v) = scale {
            c.scale = *v;
        }
        if let Some(v) = transform {
            c.transform = v.clone();
        }
        if let Some(v) = position {
            c.position = Some(*v);
        }
        if let Some(v) = vrr {
            c.vrr = *v;
        }
    }
    c
}
