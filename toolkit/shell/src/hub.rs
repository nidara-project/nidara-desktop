// SPDX-License-Identifier: LGPL-3.0-or-later
//! The hub (DOCK.md §2): it owns every source and the model, builds one immutable frame per
//! change and hands it to every dock, and carries out what the docks ask for. Service calls
//! run on short-lived workers so a slow one never holds the frames back.
use crate::apps::{AppsState, AppsUpdate, Icon, IconJob};
use crate::geometry::BAR_RESERVATION;
use crate::hyalo::{HyaloUpdate, HyaloWindow};
use crate::model::{Inputs, Model, View, Window};
use crate::prefs::Prefs;
use nk_render::Raster;
use nk_wayland::{OutputId, Waker};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender};

/// What one dock needs to draw and act; the same view for every dock.
#[derive(Debug)]
pub struct Frame {
    pub view: View,
    pub prefs: Prefs,
    /// The provisional top reservation a side dock stays below (BAR_RESERVATION).
    pub reserved_top: f64,
    pub icons: HashMap<String, Arc<Raster>>,
    pub focused: Option<u64>,
    pub hyalo_epoch: u64,
    pub can_launch: bool,
    /// Locked, or a fullscreen window on this dock's output: no dock.
    pub hidden: bool,
    /// The minimized windows whose target this dock publishes.
    pub targets: HashSet<u64>,
    pub output_sizes: HashMap<String, (u32, u32)>,
    pub tokens: Option<Arc<Value>>,
    /// Always true: the shell wears the dark skin whatever the system mode (owner's
    /// decision); kept as a field so the paint code says which skin it draws.
    pub dark: bool,
    /// Raised by each keyboard-focus request aimed at THIS dock (0: never); the dock takes
    /// the keyboard when it sees a number it has not seen.
    pub keyboard: u64,
}
impl Frame {
    pub fn empty(prefs: Prefs, tokens: Option<Arc<Value>>) -> Self {
        Frame {
            view: Model::default().view(&Inputs::default()),
            prefs,
            reserved_top: BAR_RESERVATION,
            icons: HashMap::new(),
            focused: None,
            hyalo_epoch: 0,
            can_launch: false,
            hidden: false,
            targets: HashSet::new(),
            output_sizes: HashMap::new(),
            tokens,
            dark: true,
            keyboard: 0,
        }
    }
}

/// What a dock asks for.
#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    /// A Hyalo window command, valid only under the connection epoch it was made in.
    Window {
        verb: &'static str,
        id: u64,
        epoch: u64,
    },
    Launch {
        id: String,
        generation: u64,
        token: Option<String>,
    },
    OpenFolder {
        uri: String,
        token: Option<String>,
    },
    OpenTrash {
        token: Option<String>,
    },
    Targets {
        output: String,
        targets: BTreeMap<u64, [f64; 4]>,
    },
    /// Keyboard focus to the dock (Shell1 `focus:dock`).
    FocusDock,
}

pub enum HubEvent {
    Apps(AppsUpdate),
    Icon(IconJob, Option<Icon>),
    Hyalo(HyaloUpdate),
    Prefs(Prefs),
    DockUp {
        id: OutputId,
        name: String,
        size: (u32, u32),
        scale: f64,
        frames: Sender<Arc<Frame>>,
        waker: Waker,
    },
    DockChanged {
        id: OutputId,
        name: String,
        size: (u32, u32),
        scale: f64,
    },
    DockDown(OutputId),
    Request(Request),
}

struct DockHandle {
    name: String,
    size: (u32, u32),
    scale: f64,
    frames: Sender<Arc<Frame>>,
    waker: Waker,
}

struct Cached {
    generation: u64,
    revision: u64,
    logical: u32,
    scale: f64,
    raster: Arc<Raster>,
}

pub struct Hub {
    model: Model,
    apps: Option<AppsState>,
    windows: Vec<HyaloWindow>,
    hyalo_epoch: u64,
    locked: bool,
    prefs: Prefs,
    docks: HashMap<OutputId, DockHandle>,
    icons: HashMap<String, Cached>,
    pending_icons: HashSet<(String, u64, u64, u32, u64)>,
    icon_jobs: Option<Sender<IconJob>>,
    apps_conn: Option<zbus::blocking::Connection>,
    tokens: Option<Arc<Value>>,
    /// The latest keyboard-focus request: its number and the dock it went to.
    keyboard: (u64, String),
}

/// Which dock a keyboard-focus request goes to: the focused window's output's, else the
/// first by name.
pub fn focus_output<'a>(windows: &[HyaloWindow], outputs: &'a [String]) -> Option<&'a str> {
    let focused = windows
        .iter()
        .find(|w| w.window.focused)
        .map(|w| w.output.as_str());
    outputs
        .iter()
        .find(|o| Some(o.as_str()) == focused)
        .or_else(|| outputs.iter().min())
        .map(String::as_str)
}

/// Every window gets ONE publishing dock: its own output's, else the first remaining one.
pub fn target_owners<'a>(windows: &[HyaloWindow], outputs: &'a [String]) -> HashMap<u64, &'a str> {
    let mut sorted: Vec<&String> = outputs.iter().collect();
    sorted.sort();
    windows
        .iter()
        .filter(|w| w.window.minimized)
        .filter_map(|w| {
            let own = sorted
                .iter()
                .find(|o| **o == &w.output)
                .or(sorted.first())?;
            Some((w.window.id, own.as_str()))
        })
        .collect()
}

impl Hub {
    pub fn new(
        prefs: Prefs,
        icon_jobs: Option<Sender<IconJob>>,
        apps_conn: Option<zbus::blocking::Connection>,
        tokens: Option<Arc<Value>>,
    ) -> Self {
        Hub {
            model: Model::default(),
            apps: None,
            windows: vec![],
            hyalo_epoch: 0,
            locked: false,
            prefs,
            docks: HashMap::new(),
            icons: HashMap::new(),
            pending_icons: HashSet::new(),
            icon_jobs,
            apps_conn,
            tokens,
            keyboard: (0, String::new()),
        }
    }

    pub fn run(mut self, rx: Receiver<HubEvent>) {
        for event in rx {
            let refresh = self.handle(event);
            if refresh {
                self.publish();
            }
        }
    }

    fn handle(&mut self, event: HubEvent) -> bool {
        match event {
            HubEvent::Apps(AppsUpdate::State(s)) => {
                self.apps = Some(s);
                self.request_icons();
            }
            HubEvent::Apps(AppsUpdate::Unavailable(why)) => {
                eprintln!("nidara-shell: Applications1 unavailable: {why}");
                self.apps = None;
            }
            HubEvent::Icon(job, icon) => {
                self.pending_icons
                    .retain(|p| !(p.0 == job.id && p.1 == job.generation));
                let current = self.apps.as_ref().is_some_and(|a| a.epoch == job.epoch);
                let Some(icon) = icon.filter(|_| current) else {
                    return false;
                };
                let Ok(raster) =
                    Raster::from_rgba(icon.width as u16, icon.height as u16, icon.rgba)
                else {
                    return false;
                };
                let revision = self.apps.as_ref().map_or(0, |a| a.icon_revision);
                self.icons.insert(
                    job.id,
                    Cached {
                        generation: job.generation,
                        revision,
                        logical: job.logical,
                        scale: job.scale,
                        raster: Arc::new(raster),
                    },
                );
            }
            HubEvent::Hyalo(HyaloUpdate::Windows { epoch, windows }) => {
                self.hyalo_epoch = epoch;
                self.windows = windows;
            }
            HubEvent::Hyalo(HyaloUpdate::Lock(locked)) => self.locked = locked,
            HubEvent::Hyalo(HyaloUpdate::Unavailable(why)) => {
                eprintln!("nidara-shell: Hyalo unavailable: {why}");
                self.windows.clear();
            }
            HubEvent::Prefs(p) => {
                self.prefs = p;
                self.request_icons();
            }
            HubEvent::DockUp {
                id,
                name,
                size,
                scale,
                frames,
                waker,
            } => {
                self.docks.insert(
                    id,
                    DockHandle {
                        name,
                        size,
                        scale,
                        frames,
                        waker,
                    },
                );
                self.request_icons();
            }
            HubEvent::DockChanged {
                id,
                name,
                size,
                scale,
            } => {
                if let Some(d) = self.docks.get_mut(&id) {
                    (d.name, d.size, d.scale) = (name, size, scale);
                }
                self.request_icons();
            }
            HubEvent::DockDown(id) => {
                self.docks.remove(&id);
            }
            HubEvent::Request(Request::FocusDock) => {
                let names: Vec<String> = self.docks.values().map(|d| d.name.clone()).collect();
                let Some(output) = focus_output(&self.windows, &names) else {
                    return false;
                };
                self.keyboard = (self.keyboard.0 + 1, output.to_string());
            }
            HubEvent::Request(r) => {
                self.act(r);
                return false;
            }
        }
        true
    }

    fn can(&self, capability: &str) -> bool {
        self.apps.as_ref().is_some_and(|a| a.can(capability))
    }

    /// Icons at the preferred size and the largest dock scale; docks scale down from there.
    fn request_icons(&mut self) {
        let (Some(apps), Some(jobs)) = (self.apps.as_ref(), self.icon_jobs.as_ref()) else {
            return;
        };
        let scale = self.docks.values().map(|d| d.scale).fold(1., f64::max);
        let logical = self.prefs.icon_size;
        for app in &apps.apps {
            let fresh = self.icons.get(&app.id).is_some_and(|c| {
                c.generation == app.generation
                    && c.revision == apps.icon_revision
                    && c.logical == logical
                    && c.scale == scale
            });
            let key = (
                app.id.clone(),
                app.generation,
                apps.icon_revision,
                logical,
                scale.to_bits(),
            );
            if fresh || self.pending_icons.contains(&key) || !self.shown(&app.id) {
                continue;
            }
            self.pending_icons.insert(key);
            let _ = jobs.send(IconJob {
                epoch: apps.epoch,
                id: app.id.clone(),
                generation: app.generation,
                logical,
                scale,
            });
        }
    }

    /// Only the apps the dock shows get their art fetched.
    fn shown(&self, id: &str) -> bool {
        let pinned = self.apps.as_ref().is_some_and(|a| {
            a.pins
                .iter()
                .any(|p| matches!(p, crate::model::Pin::App { id: i, .. } if i == id))
                || (a.default_directory.as_deref() == Some(id))
        });
        pinned || {
            let apps = self
                .apps
                .as_ref()
                .map(|a| a.apps.as_slice())
                .unwrap_or_default();
            self.windows.iter().any(|w| {
                crate::model::match_window(apps, &w.window).is_some_and(|n| apps[n].id == id)
            })
        }
    }

    fn publish(&mut self) {
        let (apps, pins, default) = match &self.apps {
            Some(a) => (
                a.apps.as_slice(),
                a.pins.as_slice(),
                a.default_directory.as_deref(),
            ),
            None => (&[][..], &[][..], None),
        };
        let windows: Vec<Window> = self.windows.iter().map(|w| w.window.clone()).collect();
        let view = self.model.view(&Inputs {
            apps,
            pins,
            default_directory: default,
            windows: &windows,
            hyalo_epoch: self.hyalo_epoch,
        });
        let icons: HashMap<String, Arc<Raster>> = self
            .icons
            .iter()
            .map(|(k, c)| (k.clone(), c.raster.clone()))
            .collect();
        let names: Vec<String> = self.docks.values().map(|d| d.name.clone()).collect();
        let owners = target_owners(&self.windows, &names);
        let sizes: HashMap<String, (u32, u32)> = self
            .docks
            .values()
            .map(|d| (d.name.clone(), d.size))
            .collect();
        let focused = self
            .windows
            .iter()
            .find(|w| w.window.focused)
            .map(|w| w.window.id);
        for dock in self.docks.values() {
            let fullscreen = self
                .windows
                .iter()
                .any(|w| w.fullscreen && !w.window.minimized && w.output == dock.name);
            let frame = Arc::new(Frame {
                view: view.clone(),
                prefs: self.prefs,
                reserved_top: BAR_RESERVATION,
                icons: icons.clone(),
                focused,
                hyalo_epoch: self.hyalo_epoch,
                can_launch: self.can("launch"),
                hidden: self.locked || fullscreen,
                targets: owners
                    .iter()
                    .filter(|(_, o)| **o == dock.name)
                    .map(|(w, _)| *w)
                    .collect(),
                output_sizes: sizes.clone(),
                tokens: self.tokens.clone(),
                dark: true,
                keyboard: if self.keyboard.1 == dock.name {
                    self.keyboard.0
                } else {
                    0
                },
            });
            if dock.frames.send(frame).is_ok() {
                let _ = dock.waker.wake();
            }
        }
    }

    fn act(&self, request: Request) {
        match request {
            Request::Window { verb, id, epoch } => {
                // A window from an older connection, or gone since: never act on its number.
                if epoch != self.hyalo_epoch || !self.windows.iter().any(|w| w.window.id == id) {
                    return;
                }
                worker(move || crate::hyalo::act(verb, id));
            }
            Request::Targets { output, targets } => {
                let targets: serde_json::Map<String, Value> = targets
                    .into_iter()
                    .map(|(id, r)| (id.to_string(), json!(r)))
                    .collect();
                worker(move || {
                    crate::hyalo::request(json!({"request": "minimize_targets", "output": output, "namespace": crate::dock::NAMESPACE, "targets": targets}))
                        .map(|_| ())
                });
            }
            Request::Launch {
                id,
                generation,
                token,
            } if self.can("launch") => {
                let Some((conn, epoch)) = self.service() else {
                    return;
                };
                worker(move || launch(&conn, epoch, &id, generation, "activate", &[], token));
            }
            Request::OpenFolder { uri, token } if self.can("open-directory") => {
                let Some((conn, epoch)) = self.service() else {
                    return;
                };
                worker(move || {
                    let mut context: HashMap<&str, zbus::zvariant::Value> = HashMap::new();
                    if let Some(t) = &token {
                        context.insert("ActivationToken", t.as_str().into());
                    }
                    conn.call_method(
                        Some(crate::apps::DEST),
                        crate::apps::PATH,
                        Some(crate::apps::IFACE),
                        "OpenDirectory",
                        &(epoch, uri.as_str(), context),
                    )
                    .map(|_| ())
                    .map_err(|e| e.to_string())
                });
            }
            Request::OpenTrash { token } if self.can("launch") => {
                let Some((conn, epoch)) = self.service() else {
                    return;
                };
                let Some(apps) = &self.apps else { return };
                let Some(handler) = apps.default_directory.clone() else {
                    eprintln!("nidara-shell: no default directory handler to open the Trash");
                    return;
                };
                let generation = apps
                    .apps
                    .iter()
                    .find(|a| a.id == handler)
                    .map_or(0, |a| a.generation);
                worker(move || {
                    launch(
                        &conn,
                        epoch,
                        &handler,
                        generation,
                        "open",
                        &["trash:///"],
                        token,
                    )
                });
            }
            other => eprintln!("nidara-shell: {other:?} is not available yet (no launch service)"),
        }
    }

    fn service(&self) -> Option<(zbus::blocking::Connection, u64)> {
        Some((self.apps_conn.clone()?, self.apps.as_ref()?.epoch))
    }
}

fn launch(
    conn: &zbus::blocking::Connection,
    epoch: u64,
    id: &str,
    generation: u64,
    mode: &str,
    uris: &[&str],
    token: Option<String>,
) -> Result<(), String> {
    use zbus::zvariant::Value as V;
    let mut request: HashMap<&str, V> = HashMap::new();
    request.insert("Mode", mode.into());
    if !uris.is_empty() {
        request.insert("Uris", uris.to_vec().into());
    }
    if let Some(t) = &token {
        request.insert("ActivationToken", t.as_str().into());
    }
    conn.call_method(
        Some(crate::apps::DEST),
        crate::apps::PATH,
        Some(crate::apps::IFACE),
        "Launch",
        &(epoch, id, generation, request),
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

fn worker(f: impl FnOnce() -> Result<(), String> + Send + 'static) {
    let _ = std::thread::Builder::new()
        .name("dock-request".into())
        .spawn(move || {
            if let Err(e) = f() {
                eprintln!("nidara-shell: request failed: {e}");
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn hw(id: u64, output: &str, minimized: bool) -> HyaloWindow {
        HyaloWindow {
            window: Window {
                id,
                minimized,
                ..Default::default()
            },
            output: output.into(),
            fullscreen: false,
        }
    }
    #[test]
    fn keyboard_focus_goes_to_the_focused_windows_dock() {
        let mut windows = [hw(1, "DP-1", false), hw(2, "HDMI-A-1", false)];
        let outputs = ["HDMI-A-1".to_string(), "DP-1".to_string()];
        assert_eq!(
            focus_output(&windows, &outputs),
            Some("DP-1"),
            "none focused: first by name"
        );
        windows[1].window.focused = true;
        assert_eq!(focus_output(&windows, &outputs), Some("HDMI-A-1"));
        assert_eq!(focus_output(&windows, &[]), None);
    }
    #[test]
    fn one_dock_publishes_each_minimized_window() {
        let windows = [
            hw(1, "DP-1", true),
            hw(2, "HDMI-A-1", true),
            hw(3, "gone", true),
            hw(4, "DP-1", false),
        ];
        let outputs = ["HDMI-A-1".to_string(), "DP-1".to_string()];
        let owners = target_owners(&windows, &outputs);
        assert_eq!(owners.get(&1), Some(&"DP-1"));
        assert_eq!(owners.get(&2), Some(&"HDMI-A-1"));
        // Its output went away: the first remaining one, whatever order docks came up in.
        assert_eq!(owners.get(&3), Some(&"DP-1"));
        assert_eq!(owners.get(&4), None);
        assert!(target_owners(&windows, &[]).is_empty());
    }
}
