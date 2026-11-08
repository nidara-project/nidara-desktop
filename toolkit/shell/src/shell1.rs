// SPDX-License-Identifier: LGPL-3.0-or-later
//! Shell1 (`crates/nidara-shell-ipc`), served by the process that paints the Rust shell.
//! Implemented surfaces are the dock, Apps and the Notification Center. Other
//! members answer Unavailable (or Invalid outside
//! the vocabulary) and is never a no-op. The state is the hub's: locked, Apps open or
//! not, no island.
//!
//! Policy: FocusSurface is the common OpenSurface rule and GetState is Read, both open to
//! any caller on the session bus (`nidara-access`), so no caller is identified here.
use crate::hub::{HubEvent, Request};
use nidara_shell_ipc::{Error, INTERFACE, NAME, PATH, State, SurfaceState};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::Sender;
use zbus::blocking::Connection;

pub const CAPABILITIES: &[&str] = &[
    "focus:dock",
    "surface:app-grid",
    "notifications:banners",
    "surface:nc",
];
const SURFACES: &[&str] = &[
    "cc",
    "nc",
    "prism",
    "app-grid",
    "overview",
    "player",
    "agent",
    "about",
    "bar-overlay",
];

/// What the hub knows and the service answers from.
#[derive(Default)]
pub struct Status {
    pub nc: AtomicBool,
    pub bars: AtomicUsize,
    pub notifications: std::sync::Mutex<String>,
    pub locked: AtomicBool,
    pub docks: AtomicUsize,
    /// Apps is open.
    pub apps: AtomicBool,
}

pub fn state(locked: bool, apps: bool, nc: bool) -> State {
    State {
        locked,
        surfaces: vec![
            SurfaceState {
                name: "app-grid".into(),
                visible: apps,
            },
            SurfaceState {
                name: "nc".into(),
                visible: nc,
            },
        ],
        island: String::new(),
    }
}

/// Whether a toggle request can be carried out now.
pub fn toggle(surface: &str, locked: bool) -> Result<(), Error> {
    match surface {
        "app-grid" | "nc" if locked => Err(Error::Unavailable("the session is locked".into())),
        "app-grid" | "nc" => Ok(()),
        s if SURFACES.contains(&s) => Err(Error::Unavailable(format!("this shell has no {s} yet"))),
        other => Err(Error::Invalid(format!("unknown surface {other:?}"))),
    }
}

/// Whether a focus request can be carried out now.
pub fn focus(surface: &str, locked: bool, docks: usize) -> Result<(), Error> {
    match surface {
        "dock" if locked => Err(Error::Unavailable("the session is locked".into())),
        "dock" if docks == 0 => Err(Error::Unavailable("no dock is shown".into())),
        "dock" => Ok(()),
        "bar" => Err(Error::Unavailable("this shell has no bar yet".into())),
        other => Err(Error::Invalid(format!("unknown focus target {other:?}"))),
    }
}

struct Shell1 {
    status: Arc<Status>,
    hub: Sender<HubEvent>,
}

#[zbus::interface(name = "org.nidara.Shell1")]
impl Shell1 {
    #[zbus(property)]
    fn available(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<&str> {
        CAPABILITIES.to_vec()
    }
    fn get_notification_state(&self) -> String {
        {
            let s = self.status.notifications.lock().unwrap();
            if s.is_empty() {
                "{\"available\":false,\"banners\":[]}".into()
            } else {
                s.clone()
            }
        }
    }
    fn get_state(&self) -> State {
        state(
            self.status.locked.load(Ordering::Acquire),
            self.status.apps.load(Ordering::Acquire),
            self.status.nc.load(Ordering::Acquire),
        )
    }
    fn focus_surface(&self, surface: &str) -> Result<(), Error> {
        focus(
            surface,
            self.status.locked.load(Ordering::Acquire),
            self.status.docks.load(Ordering::Acquire),
        )?;
        self.hub
            .send(HubEvent::Request(Request::FocusDock))
            .map_err(|_| Error::Failed("the shell is shutting down".into()))
    }
    fn toggle_surface(&self, surface: &str, _keyboard: bool) -> Result<(), Error> {
        toggle(surface, self.status.locked.load(Ordering::Acquire))?;
        self.hub
            .send(HubEvent::Request(if surface == "nc" {
                if self.status.bars.load(Ordering::Acquire) == 0 {
                    return Err(Error::Unavailable("no bar is shown".into()));
                }
                Request::ToggleNc { output: None }
            } else {
                Request::ToggleApps
            }))
            .map_err(|_| Error::Failed("the shell is shutting down".into()))
    }
    fn set_island(&self, _mode: &str) -> Result<(), Error> {
        Err(Error::Unavailable("this shell has no island yet".into()))
    }
    fn open_settings(&self, _page: &str, _app: &str) -> Result<(), Error> {
        Err(Error::Unavailable(
            "this shell does not open Settings yet".into(),
        ))
    }
    fn show_osd(&self, kind: &str, _value: f64, _muted: bool, _label: &str) -> Result<(), Error> {
        match kind {
            "volume" | "brightness" => Err(Error::Unavailable("this shell has no OSD yet".into())),
            other => Err(Error::Invalid(format!("unknown OSD kind {other:?}"))),
        }
    }
}

/// Owns `org.nidara.Shell` on a connection of its own. Fails, and the dock carries on
/// without it, when the name is already owned (the TS shell owns it in its session). It
/// yields the name to the TS shell even when it got there first: both start together in
/// the preview, and the TS shell answers for everything but the dock.
pub fn serve(status: Arc<Status>, hub: Sender<HubEvent>) -> Result<Connection, String> {
    zbus::blocking::connection::Builder::session()
        .and_then(|b| b.serve_at(PATH, Shell1 { status, hub }))
        .and_then(|b| b.allow_name_replacements(true).name(NAME))
        .and_then(|b| b.build())
        .map_err(|e| e.to_string())
}

pub fn changed(conn: &Connection, locked: bool, apps: bool, nc: bool) {
    if let Err(e) = conn.emit_signal(
        None::<&str>,
        PATH,
        INTERFACE,
        "StateChanged",
        &(state(locked, apps, nc),),
    ) {
        eprintln!("nidara-shell: StateChanged not sent: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn focus_follows_the_vocabulary_lock_and_docks() {
        assert!(focus("dock", false, 1).is_ok());
        assert!(matches!(focus("dock", true, 1), Err(Error::Unavailable(_))));
        assert!(matches!(
            focus("dock", false, 0),
            Err(Error::Unavailable(_))
        ));
        assert!(matches!(focus("bar", false, 1), Err(Error::Unavailable(_))));
        assert!(matches!(focus("Dock", false, 1), Err(Error::Invalid(_))));
    }

    #[test]
    fn apps_toggles_unless_locked() {
        assert!(toggle("app-grid", false).is_ok());
        assert!(matches!(
            toggle("app-grid", true),
            Err(Error::Unavailable(_))
        ));
        assert!(toggle("nc", false).is_ok());
        assert!(matches!(toggle("nc", true), Err(Error::Unavailable(_))));
        assert!(matches!(toggle("cc", false), Err(Error::Unavailable(_))));
        assert!(matches!(toggle("grid", false), Err(Error::Invalid(_))));
    }
}
