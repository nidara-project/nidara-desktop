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
    /// What it was called when it was first shown.
    pub initial_app_id: String,
    pub initial_title: String,
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
pub struct LayerInfo {
    pub output: String,
    /// background, bottom, top or overlay.
    pub layer: &'static str,
    pub namespace: String,
    /// Global logical pixels.
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
    /// The glass this layer declared (nidara-material-v1), if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub glass: Option<GlassInfo>,
}

/// What a surface asked of its glass: how many shapes, and whether the compositor paints the
/// glass itself (true) or only blurs behind the client's own paint (false).
#[derive(Debug, Clone, Serialize)]
pub struct GlassInfo {
    pub shapes: usize,
    pub compositor_paints: bool,
    /// Each shape's edge displacement, logical px (`set_lensing`): empty when blur only.
    pub refraction: Vec<f64>,
    /// The shadows under the glass: one per region holding a shape, or per lone shape.
    pub scrims: Vec<ScrimInfo>,
}

/// One shadow under the glass: what it lies under, and the strength it is easing to.
#[derive(Debug, Clone, Serialize)]
pub struct ScrimInfo {
    /// "region" (shared, add_scrim_region) or "shape" (a lone shape's own).
    pub kind: &'static str,
    pub shapes: usize,
    pub strength: f64,
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
    /// The layer surfaces (the shell's bar, dock, panels), per output and level, bottom first.
    Layers,
    /// Where the pointer is, global logical pixels.
    CursorPosition,
    /// Whether the session is locked, and the outputs a lock surface covers (lock.rs).
    Lock,
    /// Seconds since the last input, whether something holds idle off, the steps (idle.rs).
    Idle,
    /// Night light: the screens warmed to `temperature` kelvin, or neutral with none.
    NightLight {
        #[serde(default)]
        temperature: Option<u32>,
    },
    /// A window-manager command, written as in a binding: `workspace 3`, `focus-window 12`
    /// (wm/actions.rs).
    Do { command: String },
    ReloadConfig,
    /// The configuration in force: the three layers merged.
    Config,
    /// Settings' choices, persisted and applied: a JSON merge patch (a `null` removes a key)
    /// in the configuration's own shape — `{"input": {"keyboard": {"layout": "es"}}}` — that
    /// Hyalo writes into the settings layer, `hyalo-settings.toml`, and reloads once
    /// (config::apply_settings). Answers whether anything changed.
    Settings { patch: serde_json::Value },
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
    Layers { layers: Vec<LayerInfo> },
    CursorPosition { x: f64, y: f64 },
    Lock { locked: bool, surfaces: Vec<String> },
    Idle { idle_secs: u64, inhibited: bool, config: crate::config::IdleConfig },
    Config { config: Box<crate::config::Config> },
    Settings { changed: bool },
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
    /// The session was locked (the lock client was told so) or unlocked.
    LockChanged { locked: bool },
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
