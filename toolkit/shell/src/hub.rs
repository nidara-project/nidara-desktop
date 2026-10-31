// SPDX-License-Identifier: LGPL-3.0-or-later
//! The hub (DOCK.md §2): it owns every source and the model, builds one immutable frame per
//! change and hands it to every dock, and carries out what the docks ask for. Service calls
//! run on short-lived workers so a slow one never holds the frames back.
use crate::apps::{AppsState, AppsUpdate, Icon, IconJob, TRASH_EMPTY, TRASH_FULL};
use crate::geometry::BAR_RESERVATION;
use crate::hyalo::{HyaloUpdate, HyaloWindow};
use crate::menu::{Command, Launch};
use crate::model::{App, Inputs, Model, View, Window};
use crate::prefs::Prefs;
use crate::shell1::{self, Status};
use nk_render::Raster;
use nk_wayland::{OutputId, Waker};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{Receiver, Sender};

/// What one dock needs to draw and act; the same view for every dock.
#[derive(Debug)]
pub struct Frame {
    pub view: View,
    pub prefs: Prefs,
    /// The provisional top reservation a side dock stays below (BAR_RESERVATION).
    pub reserved_top: f64,
    pub icons: HashMap<String, Arc<Raster>>,
    pub trash: Option<crate::trash::TrashState>,
    pub focused: Option<u64>,
    pub hyalo_epoch: u64,
    pub can_launch: bool,
    /// What the menus may offer: the catalogue's records, window titles, and the services.
    pub catalogue: Arc<HashMap<String, App>>,
    pub titles: Arc<HashMap<u64, String>>,
    pub can_edit_layout: bool,
    pub can_autostart: bool,
    pub can_open_directory: bool,
    /// The Dock page of Settings can be asked for.
    pub can_settings: bool,
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
            trash: None,
            focused: None,
            hyalo_epoch: 0,
            can_launch: false,
            catalogue: Default::default(),
            titles: Default::default(),
            can_edit_layout: false,
            can_autostart: false,
            can_open_directory: false,
            can_settings: false,
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
    /// A menu row (menu.rs); `token` from the click or key that chose it, when it starts
    /// something.
    Menu {
        command: Command,
        token: Option<String>,
    },
}

pub enum HubEvent {
    Apps(AppsUpdate),
    Icon(IconJob, Option<Icon>),
    /// None: the Trash's fill cannot be told.
    Trash(Option<crate::trash::TrashState>),
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
    trash: Option<crate::trash::TrashState>,
    pending_icons: HashSet<(String, u64, u64, u32, u64)>,
    icon_jobs: Option<Sender<IconJob>>,
    apps_conn: Option<zbus::blocking::Connection>,
    tokens: Option<Arc<Value>>,
    /// The latest keyboard-focus request: its number and the dock it went to.
    keyboard: (u64, String),
    /// What Shell1 answers from, and its connection for StateChanged.
    status: Arc<Status>,
    shell1: Option<zbus::blocking::Connection>,
    /// Settings can be reached on the bus (owned or activatable), checked at start.
    can_settings: bool,
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
        status: Arc<Status>,
        shell1: Option<zbus::blocking::Connection>,
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
            trash: None,
            pending_icons: HashSet::new(),
            icon_jobs,
            apps_conn,
            tokens,
            keyboard: (0, String::new()),
            status,
            shell1,
            can_settings: false,
        }
    }

    /// Whether `org.nidara.Settings` answers: owned now, or activatable.
    pub fn with_settings(mut self, reachable: bool) -> Self {
        self.can_settings = reachable;
        self
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
            HubEvent::Trash(trash) => self.trash = trash,
            HubEvent::Hyalo(HyaloUpdate::Windows { epoch, windows }) => {
                self.hyalo_epoch = epoch;
                self.windows = windows;
                // A window of an app that is not pinned brings that app into the dock: its
                // art is fetched now, not at the next unrelated catalogue or settings change.
                self.request_icons();
            }
            HubEvent::Hyalo(HyaloUpdate::Lock(locked)) => {
                if locked != self.locked {
                    self.status.locked.store(locked, Ordering::Release);
                    if let Some(conn) = &self.shell1 {
                        shell1::changed(conn, locked);
                    }
                }
                self.locked = locked;
            }
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
                self.status.docks.store(self.docks.len(), Ordering::Release);
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
                self.status.docks.store(self.docks.len(), Ordering::Release);
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
        // The shown apps, and the Trash's two looks: both are fetched, so filling or
        // emptying the Trash swaps art the dock already has.
        let mut wanted: Vec<(&str, u64)> = apps
            .apps
            .iter()
            .filter(|app| self.shown(&app.id))
            .map(|app| (app.id.as_str(), app.generation))
            .collect();
        if apps.can("trash-icon") {
            wanted.extend([(TRASH_EMPTY, 0), (TRASH_FULL, 0)]);
        }
        for (id, generation) in wanted {
            let fresh = self.icons.get(id).is_some_and(|c| {
                c.generation == generation
                    && c.revision == apps.icon_revision
                    && c.logical == logical
                    && c.scale == scale
            });
            let key = (
                id.to_string(),
                generation,
                apps.icon_revision,
                logical,
                scale.to_bits(),
            );
            if fresh || self.pending_icons.contains(&key) {
                continue;
            }
            self.pending_icons.insert(key);
            let _ = jobs.send(IconJob {
                epoch: apps.epoch,
                id: id.to_string(),
                generation,
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
        let catalogue: Arc<HashMap<String, App>> =
            Arc::new(apps.iter().map(|a| (a.id.clone(), a.clone())).collect());
        let titles: Arc<HashMap<u64, String>> = Arc::new(
            self.windows
                .iter()
                .map(|w| (w.window.id, w.window.title.clone()))
                .collect(),
        );
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
                trash: self.trash,
                focused,
                hyalo_epoch: self.hyalo_epoch,
                can_launch: self.can("launch"),
                catalogue: catalogue.clone(),
                titles: titles.clone(),
                can_edit_layout: self.can("layout-apps"),
                can_autostart: self.can("autostart"),
                can_open_directory: self.can("open-directory"),
                can_settings: self.can_settings,
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
                    eprintln!(
                        "nidara-shell: {verb} {id:x} not sent: the window is gone or from an older Hyalo"
                    );
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
                worker(move || launch(&conn, epoch, &id, generation, "activate", None, &[], token));
            }
            Request::Menu { command, token } => self.menu(command, token),
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
                        None,
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

    /// A menu row's command. Window verbs go through the same epoch and liveness check
    /// as a click; everything else names its target by id and generation, which the
    /// service checks again.
    fn menu(&self, command: Command, token: Option<String>) {
        let epoch = self.hyalo_epoch;
        let window = |verb, id| Request::Window { verb, id, epoch };
        match command {
            Command::None => {}
            Command::Window { verb, id } => self.act(window(verb, id)),
            Command::CloseAll(ids) => {
                for id in ids {
                    self.act(window("close-window", id));
                }
            }
            Command::OpenFolder(uri) => self.act(Request::OpenFolder { uri, token }),
            Command::OpenTrash => self.act(Request::OpenTrash { token }),
            Command::Launch {
                id,
                generation,
                mode,
            } if self.can("launch") => {
                let Some((conn, epoch)) = self.service() else {
                    return;
                };
                worker(move || {
                    let (mode, action) = match &mode {
                        Launch::Activate => ("activate", None),
                        Launch::NewWindow => ("new-window", None),
                        Launch::Action(a) => ("action", Some(a.as_str())),
                    };
                    launch(&conn, epoch, &id, generation, mode, action, &[], token)
                });
            }
            Command::Pin { id } => {
                self.edit_layout(&[("Operation", "insert-app"), ("DesktopId", &id)])
            }
            Command::Unpin { key } => self.edit_layout(&[("Operation", "remove"), ("Key", &key)]),
            Command::Autostart {
                id,
                generation,
                enabled,
            } if self.can("autostart") => {
                let Some((conn, epoch)) = self.service() else {
                    return;
                };
                worker(move || {
                    conn.call_method(
                        Some(crate::apps::DEST),
                        crate::apps::PATH,
                        Some(crate::apps::IFACE),
                        "SetAutostart",
                        &(epoch, id.as_str(), generation, enabled),
                    )
                    .map(|_| ())
                    .map_err(|e| e.to_string())
                });
            }
            Command::EmptyTrash => worker(crate::trash::empty),
            Command::Pref { key, value } => {
                let Some(conn) = self.apps_conn.clone() else {
                    return;
                };
                worker(move || crate::prefs::apply(&conn, key, &value));
            }
            Command::DockSettings => {
                let Some(conn) = self.apps_conn.clone() else {
                    return;
                };
                worker(move || {
                    let mut args = vec!["page".to_string(), "dock".to_string()];
                    if let Some(t) = token {
                        args.extend(["--xdg-activation-token".to_string(), t]);
                    }
                    conn.call_method(
                        Some("org.nidara.Settings"),
                        "/org/nidara/Settings",
                        Some("org.nidara.Settings"),
                        "Request",
                        &(args,),
                    )
                    .map(|_| ())
                    .map_err(|e| format!("Settings: {e}"))
                });
            }
            other => eprintln!("nidara-shell: {other:?} is not available now"),
        }
    }

    /// One EditLayout against the revision this hub last read: a concurrent edit is a
    /// Conflict the service reports, never a silent overwrite.
    fn edit_layout(&self, edit: &[(&str, &str)]) {
        let (Some((conn, epoch)), Some(apps)) = (self.service(), self.apps.as_ref()) else {
            return;
        };
        if !apps.can("layout-apps") {
            return;
        }
        let revision = apps.layout_revision;
        let edit: HashMap<String, zbus::zvariant::OwnedValue> = edit
            .iter()
            .filter_map(|(k, v)| {
                zbus::zvariant::OwnedValue::try_from(zbus::zvariant::Value::from(*v))
                    .ok()
                    .map(|v| (k.to_string(), v))
            })
            .collect();
        worker(move || {
            conn.call_method(
                Some(crate::apps::DEST),
                crate::apps::PATH,
                Some(crate::apps::IFACE),
                "EditLayout",
                &(epoch, revision, edit),
            )
            .map(|_| ())
            .map_err(|e| format!("EditLayout: {e}"))
        });
    }
}

#[allow(clippy::too_many_arguments)]
fn launch(
    conn: &zbus::blocking::Connection,
    epoch: u64,
    id: &str,
    generation: u64,
    mode: &str,
    action: Option<&str>,
    uris: &[&str],
    token: Option<String>,
) -> Result<(), String> {
    use zbus::zvariant::Value as V;
    let mut request: HashMap<&str, V> = HashMap::new();
    request.insert("Mode", mode.into());
    if let Some(a) = action {
        request.insert("Action", a.into());
    }
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
    fn a_new_window_of_an_unpinned_app_fetches_its_icon() {
        let (jobs, requested) = std::sync::mpsc::channel();
        let mut hub = Hub::new(
            Prefs::default(),
            Some(jobs),
            None,
            None,
            Arc::new(Status::default()),
            None,
        );
        let terminal = crate::model::App {
            id: "org.gnome.Terminal.desktop".into(),
            generation: 1,
            name: "Terminal".into(),
            startup_wm_class: String::new(),
            flatpak_id: String::new(),
            launchable: true,
            ..Default::default()
        };
        hub.handle(HubEvent::Apps(AppsUpdate::State(AppsState {
            epoch: 1,
            revision: 1,
            apps: vec![terminal],
            pins: vec![],
            default_directory: None,
            capabilities: vec![],
            icon_revision: 1,
            layout_revision: 0,
        })));
        assert!(requested.try_recv().is_err(), "not shown yet: no art");
        let mut w = hw(6, "DP-1", false);
        w.window.app_id = "org.gnome.Terminal".into();
        hub.handle(HubEvent::Hyalo(HyaloUpdate::Windows {
            epoch: 1,
            windows: vec![w],
        }));
        let job = requested
            .try_recv()
            .expect("its window opened: the icon is asked for");
        assert_eq!(job.id, "org.gnome.Terminal.desktop");
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
