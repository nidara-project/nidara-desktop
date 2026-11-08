// SPDX-License-Identifier: GPL-3.0-or-later
//! Shell1 belongs to the process which paints the Rust shell. This crate starts no
//! service and supplies no renderer registry, TS bridge or sessiond state cache.
use serde::{Deserialize, Serialize};
use zbus::zvariant::Type;

pub const NAME: &str = "org.nidara.Shell";
pub const PATH: &str = "/org/nidara/Shell";
pub const INTERFACE: &str = "org.nidara.Shell1";

#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.Shell1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    Unavailable(String),
    AccessDenied(String),
    Invalid(String),
    Failed(String),
}

/// Only authoritative state: missing surfaces are unavailable, never 'closed'.
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct SurfaceState {
    pub name: String,
    pub visible: bool,
}
#[derive(Debug, Clone, Serialize, Deserialize, Type, PartialEq, Eq)]
pub struct State {
    pub locked: bool,
    pub surfaces: Vec<SurfaceState>,
    pub island: String,
}

/// Capabilities are method-specific: `surface:cc`, `surface:nc`, `surface:prism`,
/// `surface:app-grid`, `surface:overview`, `surface:player`, `surface:agent`,
/// `surface:about`, `surface:bar-overlay`, `focus:bar`, `focus:dock`, `island`,
/// `settings`, `osd:volume`, `osd:brightness`. Available means at least one usable
/// capability, not that the full shell exists. The OSD-only process in C may
/// advertise ONLY the two OSD capabilities. It must refuse OSD while locked;
/// ext-session-lock is never bypassed by an ordinary shell surface.
///
/// All methods enforce their own availability and policy at the effect, even if
/// callers omit the properties. Reads and opening/closing own surfaces use the
/// common Read/OpenSurface policy. ShowOSD is a visual report of confirmed values,
/// never an audio/brightness command. No input injection or launch API lives here.
#[zbus::proxy(
    interface = "org.nidara.Shell1",
    default_service = "org.nidara.Shell",
    default_path = "/org/nidara/Shell",
    gen_blocking = true
)]
pub trait Shell {
    #[zbus(property)]
    fn available(&self) -> zbus::Result<bool>;
    #[zbus(property)]
    fn capabilities(&self) -> zbus::Result<Vec<String>>;
    fn get_state(&self) -> Result<State, Error>;
    /// Additive capability `notifications:banners`; do not call on older renderers.
    fn get_notification_state(&self) -> Result<String, Error>;
    fn toggle_surface(&self, surface: &str, keyboard: bool) -> Result<(), Error>;
    fn set_island(&self, mode: &str) -> Result<(), Error>;
    fn focus_surface(&self, surface: &str) -> Result<(), Error>;
    fn open_settings(&self, page: &str, app: &str) -> Result<(), Error>;
    /// `kind`: volume or brightness; finite `value` in 0..=1; `muted` applies to
    /// volume; label is plain display text. Actual state must already be confirmed.
    fn show_osd(&self, kind: &str, value: f64, muted: bool, label: &str) -> Result<(), Error>;
    #[zbus(signal)]
    fn state_changed(&self, state: State) -> zbus::Result<()>;
}

/// An app dragged from Apps to the dock (APPLICATIONS1-DOCK.md §8, "Drag sources"): the
/// intra-session drag type and its data. It names an app, nothing more: the dock checks
/// the id against its own Applications1 view and pins it at the drop, so the data grants
/// no launch and no write by itself, whoever offers it.
pub mod drag {
    /// The type Apps offers and the dock takes.
    pub const APP_MIME: &str = "application/x-nidara-app";
    const HEADER: &str = "nidara-app-v1";
    /// The longest data taken: a DesktopId is far shorter.
    pub const MAX: usize = 1024;

    /// An app's DesktopId and the catalogue generation it was dragged from.
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct App {
        pub id: String,
        pub generation: u64,
    }

    pub fn encode(app: &App) -> Vec<u8> {
        format!("{HEADER}\n{}\n{}\n", app.id, app.generation).into_bytes()
    }

    /// None for anything that is not exactly one well-formed record of this version.
    pub fn decode(data: &[u8]) -> Option<App> {
        if data.len() > MAX {
            return None;
        }
        let text = std::str::from_utf8(data).ok()?;
        let mut lines = text.strip_suffix('\n')?.split('\n');
        if lines.next()? != HEADER {
            return None;
        }
        let id = lines.next()?;
        let generation = lines.next()?.parse().ok()?;
        let valid =
            id.ends_with(".desktop") && !id.contains(['/', '\0']) && id.len() > ".desktop".len();
        (valid && lines.next().is_none()).then(|| App {
            id: id.to_owned(),
            generation,
        })
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn round_trip_and_refusals() {
            let app = App {
                id: "org.gnome.Nautilus.desktop".into(),
                generation: 7,
            };
            assert_eq!(decode(&encode(&app)), Some(app));
            for bad in [
                &b"nidara-app-v2\na.desktop\n1\n"[..],
                b"nidara-app-v1\na.desktop\n1",
                b"nidara-app-v1\n../a.desktop\n1\n",
                b"nidara-app-v1\na\n1\n",
                b"nidara-app-v1\na.desktop\nx\n",
                b"nidara-app-v1\na.desktop\n1\nmore\n",
                b"",
            ] {
                assert_eq!(decode(bad), None, "{:?}", String::from_utf8_lossy(bad));
            }
        }
    }
}
