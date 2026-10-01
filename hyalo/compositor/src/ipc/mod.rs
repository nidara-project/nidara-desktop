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

use crate::{config::OutputConfig, outputs::OutputInfo};

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
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum Event {
    OutputsChanged { outputs: Vec<OutputInfo> },
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
