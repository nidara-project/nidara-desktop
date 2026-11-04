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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};

/// What one dock needs to draw and act; the same view for every dock.
#[derive(Clone, Debug)]
pub struct Frame {
    pub view: View,
    pub prefs: Prefs,
    /// The provisional top reservation a side dock stays below (BAR_RESERVATION).
    pub reserved_top: f64,
    pub icons: HashMap<String, Arc<Raster>>,
    /// The same art at the largest magnified size, for icons drawn bigger than `icons`.
    pub large_icons: HashMap<String, Arc<Raster>>,
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
    pub can_open_file: bool,
    /// The Dock page of Settings can be asked for.
    pub can_settings: bool,
    /// Locked, or a fullscreen window on this dock's output: no dock.
    pub hidden: bool,
    /// The minimized windows whose target this dock publishes.
    pub targets: HashSet<u64>,
    /// Minimized windows Hyalo is still drawing on their way into the dock: their slot
    /// stays empty until they land, so the window that travels is the picture that stays.
    pub flying: HashSet<u64>,
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
            large_icons: HashMap::new(),
            trash: None,
            focused: None,
            hyalo_epoch: 0,
            can_launch: false,
            catalogue: Default::default(),
            titles: Default::default(),
            can_edit_layout: false,
            can_autostart: false,
            can_open_directory: false,
            can_open_file: false,
            can_settings: false,
            hidden: false,
            targets: HashSet::new(),
            flying: HashSet::new(),
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
    OpenFile {
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
    /// The icon size a separator's drag, a key or a reader asked for (resize.rs).
    IconSize(u32),
    /// Open Apps, or close it when it is open (Shell1 `surface:app-grid`).
    ToggleApps,
    /// A tray item's left click, at a global logical point: its owner's window comes
    /// forward, or the app is asked (tray.rs).
    TrayActivate {
        item: crate::tray::TrayItem,
        at: (i32, i32),
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
    /// A bar is up on an output (bar.rs); it takes its frames from `frames`.
    BarUp {
        id: OutputId,
        name: String,
        frames: Sender<Arc<crate::bar::BarFrame>>,
        waker: Waker,
    },
    BarDown(OutputId),
    Region(crate::barmodel::Region),
    /// What the bar's widgets show (status.rs).
    Widgets(crate::status::Update),
    /// The Control Center's grid as stored (cclayout.rs).
    CcLayout(crate::cclayout::Stored),
    Tray(Arc<Vec<crate::tray::TrayItem>>),
    Request(Request),
    /// The icon-size Apply in flight answered, taken or refused.
    IconSizeDone,
    /// Apps' layer number `n` ended.
    AppsClosed(u64),
}

/// The Apps layer while it is up: its number, and what closes it.
struct OpenApps {
    n: u64,
    close: Arc<AtomicBool>,
    waker: Waker,
}

struct DockHandle {
    name: String,
    size: (u32, u32),
    scale: f64,
    frames: Sender<Arc<Frame>>,
    waker: Waker,
}

struct BarHandle {
    name: String,
    frames: Sender<Arc<crate::bar::BarFrame>>,
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
    large_icons: HashMap<String, Cached>,
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
    /// The hub's own inbox, for a worker to say its Apply answered; and the icon-size
    /// Applies, one in flight and the latest waiting (resize.rs).
    inbox: Option<Sender<HubEvent>>,
    resize: crate::resize::Coalesce,
    launcher: Option<OpenApps>,
    launchers: u64,
    workspaces: Arc<Vec<crate::hyalo::Workspace>>,
    bars: HashMap<OutputId, BarHandle>,
    region: crate::barmodel::Region,
    widgets: crate::status::Status,
    cc_layout: Arc<crate::cclayout::Stored>,
    tray: Arc<Vec<crate::tray::TrayItem>>,
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
            large_icons: HashMap::new(),
            trash: None,
            pending_icons: HashSet::new(),
            icon_jobs,
            apps_conn,
            tokens,
            keyboard: (0, String::new()),
            status,
            shell1,
            can_settings: false,
            inbox: None,
            resize: Default::default(),
            launcher: None,
            launchers: 0,
            workspaces: Arc::default(),
            bars: HashMap::new(),
            region: Default::default(),
            widgets: Default::default(),
            cc_layout: Default::default(),
            tray: Arc::default(),
        }
    }

    /// Whether `org.nidara.Settings` answers: owned now, or activatable.
    pub fn with_settings(mut self, reachable: bool) -> Self {
        self.can_settings = reachable;
        self
    }

    pub fn with_inbox(mut self, inbox: Sender<HubEvent>) -> Self {
        self.inbox = Some(inbox);
        self
    }

    /// One Config1 Apply of the icon size; the next waits until it answers. What the docks
    /// show comes back through the GSettings watcher: only what Config1 committed.
    fn icon_size(&mut self, size: u32) {
        let Some(size) = self.resize.want(size) else {
            return;
        };
        self.send_icon_size(size);
    }

    fn send_icon_size(&mut self, size: u32) {
        let (Some(conn), Some(inbox)) = (self.apps_conn.clone(), self.inbox.clone()) else {
            // Nowhere to send it: nothing in flight, nothing waiting.
            self.resize = Default::default();
            return;
        };
        let _ = std::thread::Builder::new()
            .name("dock-icon-size".into())
            .spawn(move || {
                let value = crate::menu::PrefValue::Number(size as f64);
                if let Err(e) = crate::prefs::apply(&conn, "dock.iconSize", &value) {
                    eprintln!("nidara-shell: request failed: {e}");
                }
                let _ = inbox.send(HubEvent::IconSizeDone);
            });
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
                    .retain(|p| !(p.0 == job.id && p.1 == job.generation && p.3 == job.logical));
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
                let cache = if Some(job.logical) == self.large_logical() {
                    &mut self.large_icons
                } else {
                    &mut self.icons
                };
                cache.insert(
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
            HubEvent::Hyalo(HyaloUpdate::Windows {
                epoch,
                windows,
                workspaces,
            }) => {
                self.hyalo_epoch = epoch;
                self.windows = windows;
                self.workspaces = Arc::new(workspaces);
                // A window of an app that is not pinned brings that app into the dock: its
                // art is fetched now, not at the next unrelated catalogue or settings change.
                self.request_icons();
            }
            HubEvent::Hyalo(HyaloUpdate::Lock(locked)) => {
                if locked != self.locked {
                    self.status.locked.store(locked, Ordering::Release);
                    self.locked = locked;
                    if locked {
                        // Nothing of the shell stays over the lock screen.
                        self.close_apps();
                    }
                    self.state_changed();
                }
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
            HubEvent::BarUp {
                id,
                name,
                frames,
                waker,
            } => {
                self.bars.insert(
                    id,
                    BarHandle {
                        name,
                        frames,
                        waker,
                    },
                );
            }
            HubEvent::BarDown(id) => {
                self.bars.remove(&id);
            }
            HubEvent::Region(r) => self.region = r,
            HubEvent::Widgets(u) => self.widgets.apply(u),
            HubEvent::CcLayout(l) => self.cc_layout = Arc::new(l),
            HubEvent::Tray(items) => self.tray = items,
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
            HubEvent::Request(Request::IconSize(size)) => {
                self.icon_size(size);
                return false;
            }
            HubEvent::IconSizeDone => {
                // The waiting value takes the slot the answer freed.
                if let Some(next) = self.resize.done() {
                    self.send_icon_size(next);
                }
                return false;
            }
            // The bars show whether Apps is open.
            HubEvent::Request(Request::ToggleApps) => self.toggle_apps(),
            HubEvent::Request(Request::TrayActivate { item, at }) => {
                self.tray_activate(item, at);
                return false;
            }
            HubEvent::AppsClosed(n) => {
                if self.launcher.as_ref().is_some_and(|l| l.n == n) {
                    self.launcher = None;
                    self.status.apps.store(false, Ordering::Release);
                    self.state_changed();
                }
            }
            HubEvent::Request(r) => {
                self.act(r);
                return false;
            }
        }
        true
    }

    fn state_changed(&self) {
        if let Some(conn) = &self.shell1 {
            shell1::changed(conn, self.locked, self.launcher.is_some());
        }
    }

    fn close_apps(&mut self) {
        if let Some(l) = &self.launcher {
            l.close.store(true, Ordering::SeqCst);
            let _ = l.waker.wake();
        }
    }

    /// Apps opens on its own thread and connection, from the catalogue as it is now;
    /// asked again while it is up, it closes.
    fn toggle_apps(&mut self) {
        if self
            .launcher
            .as_ref()
            .is_some_and(|l| !l.close.load(Ordering::SeqCst))
        {
            self.close_apps();
            return;
        }
        if self.locked {
            return;
        }
        let (Some(apps), Some(inbox)) = (&self.apps, &self.inbox) else {
            eprintln!("nidara-shell: Apps not opened: no catalogue yet");
            return;
        };
        let wake = match nk_wayland::wake_channel() {
            Ok(w) => w,
            Err(e) => {
                eprintln!("nidara-shell: Apps not opened: {e}");
                return;
            }
        };
        self.launchers += 1;
        let n = self.launchers;
        let close = Arc::new(AtomicBool::new(false));
        let (epoch, list) = (apps.epoch, apps.apps.clone());
        let (hub, bus, c, done) = (
            inbox.clone(),
            self.apps_conn.clone(),
            close.clone(),
            inbox.clone(),
        );
        self.launcher = Some(OpenApps {
            n,
            close,
            waker: wake.0.clone(),
        });
        let started = std::thread::Builder::new()
            .name("apps-layer".into())
            .spawn(move || {
                let l = crate::launcher::Launcher::new(hub, epoch, &list, bus, c);
                if let Err(e) = crate::launcher::run(l, wake) {
                    eprintln!("nidara-shell: Apps ended: {e}");
                }
                let _ = done.send(HubEvent::AppsClosed(n));
            });
        if let Err(e) = started {
            eprintln!("nidara-shell: Apps not opened: {e}");
            self.launcher = None;
            return;
        }
        self.status.apps.store(true, Ordering::Release);
        self.state_changed();
    }

    fn can(&self, capability: &str) -> bool {
        self.apps.as_ref().is_some_and(|a| a.can(capability))
    }

    /// The size magnification draws icons up to, when it is bigger than the resting one.
    fn large_logical(&self) -> Option<u32> {
        let p = &self.prefs;
        (p.magnification && p.max_icon_size > p.icon_size).then_some(p.max_icon_size)
    }

    /// Icons at the preferred size and the largest dock scale, and again at the magnified
    /// size: a magnified icon drawn from the resting art came out blurred and pixelated.
    /// Docks scale down from there.
    fn request_icons(&mut self) {
        if self.large_logical().is_none() {
            self.large_icons.clear();
        }
        self.request_icons_at(self.prefs.icon_size, false);
        if let Some(large) = self.large_logical() {
            self.request_icons_at(large, true);
        }
    }

    fn request_icons_at(&mut self, logical: u32, large: bool) {
        let (Some(apps), Some(jobs)) = (self.apps.as_ref(), self.icon_jobs.as_ref()) else {
            return;
        };
        let scale = self.docks.values().map(|d| d.scale).fold(1., f64::max);
        let cache = if large {
            &self.large_icons
        } else {
            &self.icons
        };
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
        // Pinned folders and files, by their layout key.
        if apps.can("layout-icon") {
            wanted.extend(apps.pins.iter().filter_map(|p| match p {
                crate::model::Pin::Folder { key, .. } | crate::model::Pin::File { key, .. } => {
                    Some((key.as_str(), 0))
                }
                _ => None,
            }));
        }
        for (id, generation) in wanted {
            let fresh = cache.get(id).is_some_and(|c| {
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

    /// A pinned folder or file, opened by Applications1 (`OpenDirectory`, `OpenFile`) with
    /// the default app for it.
    fn open_place(&self, method: &'static str, uri: String, token: Option<String>) {
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
                method,
                &(epoch, uri.as_str(), context),
            )
            .map(|_| ())
            .map_err(|e| e.to_string())
        });
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
        let rasters = |cache: &HashMap<String, Cached>| -> HashMap<String, Arc<Raster>> {
            cache
                .iter()
                .map(|(k, c)| (k.clone(), c.raster.clone()))
                .collect()
        };
        let (icons, large_icons) = (rasters(&self.icons), rasters(&self.large_icons));
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
                large_icons: large_icons.clone(),
                trash: self.trash,
                focused,
                hyalo_epoch: self.hyalo_epoch,
                can_launch: self.can("launch"),
                catalogue: catalogue.clone(),
                titles: titles.clone(),
                can_edit_layout: self.can("layout-apps"),
                can_autostart: self.can("autostart"),
                can_open_directory: self.can("open-directory"),
                can_open_file: self.can("open-file"),
                can_settings: self.can_settings,
                hidden: self.locked || fullscreen,
                targets: owners
                    .iter()
                    .filter(|(_, o)| **o == dock.name)
                    .map(|(w, _)| *w)
                    .collect(),
                flying: self
                    .windows
                    .iter()
                    .filter(|w| w.window.minimized && w.moving)
                    .map(|w| w.window.id)
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
        for bar in self.bars.values() {
            let mine = |w: &&HyaloWindow| w.output == bar.name;
            // The app of the window that holds the focus, when it is on this output.
            let app = self
                .windows
                .iter()
                .filter(mine)
                .find(|w| w.window.focused && !w.window.minimized)
                .map(|w| match crate::model::match_window(apps, &w.window) {
                    Some(i) if !apps[i].name.is_empty() => apps[i].name.clone(),
                    _ => w.window.app_id.clone(),
                });
            let fullscreen = self
                .windows
                .iter()
                .filter(mine)
                .any(|w| w.fullscreen && !w.window.minimized);
            let frame = Arc::new(crate::bar::BarFrame {
                app,
                workspaces: self.workspaces.clone(),
                tokens: self.tokens.clone(),
                reduce_transparency: self.prefs.reduce_transparency,
                hidden: self.locked || fullscreen,
                can_settings: self.can_settings,
                region: self.region.clone(),
                status: self.widgets.clone(),
                cc_layout: self.cc_layout.clone(),
                tray: self.tray.clone(),
            });
            if bar.frames.send(frame).is_ok() {
                let _ = bar.waker.wake();
            }
        }
    }

    fn tray_activate(&self, item: crate::tray::TrayItem, at: (i32, i32)) {
        let windows: Vec<(u64, i32)> = self
            .windows
            .iter()
            .filter_map(|w| Some((w.window.id, w.pid?)))
            .collect();
        let raise = item
            .pid
            .and_then(|pid| crate::tray::window_for(pid, &windows, crate::tray::parent_of));
        match raise {
            Some(id) => self.act(Request::Window {
                verb: "focus-window",
                id,
                epoch: self.hyalo_epoch,
            }),
            None => {
                let Some(conn) = self.apps_conn.clone() else {
                    return;
                };
                worker(move || crate::tray::point(&conn, "Activate", &item, at));
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
                send_targets(output, targets);
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
                self.open_place("OpenDirectory", uri, token)
            }
            Request::OpenFile { uri, token } if self.can("open-file") => {
                self.open_place("OpenFile", uri, token)
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
            Command::OpenFile(uri) => self.act(Request::OpenFile { uri, token }),
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
            Command::PinPlaces { places, before } => self.pin_places(places, before),
            Command::OpenWith {
                id,
                generation,
                uris,
            } if self.can("launch") => {
                let Some((conn, epoch)) = self.service() else {
                    return;
                };
                worker(move || {
                    let uris: Vec<&str> = uris.iter().map(String::as_str).collect();
                    launch(&conn, epoch, &id, generation, "open", None, &uris, token)
                });
            }
            Command::PinAt { id, before } => {
                let mut edit = vec![("Operation", "insert-app"), ("DesktopId", id.as_str())];
                if let Some(before) = before.as_deref() {
                    edit.push(("BeforeKey", before));
                }
                self.edit_layout(&edit)
            }
            Command::Unpin { key } => self.edit_layout(&[("Operation", "remove"), ("Key", &key)]),
            Command::Move { key, before } => {
                let mut edit = vec![("Operation", "move"), ("Key", key.as_str())];
                if let Some(before) = before.as_deref() {
                    edit.push(("BeforeKey", before));
                }
                self.edit_layout(&edit)
            }
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
            Command::System {
                action,
                confirmed: true,
            } => self.system(action, token),
            other => eprintln!("nidara-shell: {other:?} is not available now"),
        }
    }

    /// A system-menu action, as the TS bar runs it: Settings over its bus name, the rest
    /// the session's own commands.
    fn system(&self, action: crate::menu::System, token: Option<String>) {
        use crate::menu::System;
        let argv: &[&str] = match action {
            System::About => return,
            System::Settings => {
                let Some(conn) = self.apps_conn.clone() else {
                    return;
                };
                worker(move || {
                    let mut args: Vec<String> = vec![];
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
                return;
            }
            System::Lock => &["nidara-lock"],
            System::Suspend => &["systemctl", "suspend"],
            System::Logout => &["uwsm", "stop"],
            System::Restart => &["systemctl", "reboot"],
            System::Shutdown => &["systemctl", "poweroff"],
        };
        eprintln!("nidara-shell: system menu: {action:?}");
        let argv: Vec<String> = argv.iter().map(|s| s.to_string()).collect();
        worker(move || {
            std::process::Command::new(&argv[0])
                .args(&argv[1..])
                // Waited for on this worker, so it never lingers as a zombie.
                .status()
                .map(drop)
                .map_err(|e| format!("{}: {e}", argv[0]))
        });
    }

    /// One EditLayout against the revision this hub last read: a concurrent edit is a
    /// Conflict the service reports, never a silent overwrite.
    /// Dropped folders and files, one EditLayout after another: each is checked against
    /// the revision the one before it made, so sent together all but the first would be
    /// refused as stale.
    fn pin_places(&self, places: Vec<(String, bool)>, before: Option<String>) {
        let (Some((conn, epoch)), Some(apps)) = (self.service(), self.apps.as_ref()) else {
            return;
        };
        if !apps.can("layout-folders") {
            return;
        }
        let mut revision = apps.layout_revision;
        worker(move || {
            for (uri, folder) in places {
                let op = if folder {
                    "insert-folder"
                } else {
                    "insert-file"
                };
                let mut edit: HashMap<&str, zbus::zvariant::Value> = HashMap::new();
                edit.insert("Operation", op.into());
                edit.insert("Uri", uri.as_str().into());
                if let Some(before) = before.as_deref() {
                    edit.insert("BeforeKey", before.into());
                }
                let reply = conn
                    .call_method(
                        Some(crate::apps::DEST),
                        crate::apps::PATH,
                        Some(crate::apps::IFACE),
                        "EditLayout",
                        &(epoch, revision, edit),
                    )
                    .map_err(|e| format!("EditLayout: {e}"))?;
                let (next, _): (u64, Vec<HashMap<String, zbus::zvariant::OwnedValue>>) = reply
                    .body()
                    .deserialize()
                    .map_err(|e| format!("EditLayout reply: {e}"))?;
                revision = next;
            }
            Ok(())
        });
    }

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

/// The places of the minimized windows, to Hyalo, in order: they change with every frame
/// magnification moves the strip, and a window on its way follows them, so an older list
/// must never land after a newer one (a `worker` each could). One thread sends them, only
/// the newest of each output when several are waiting.
fn send_targets(output: String, targets: serde_json::Map<String, Value>) {
    use std::sync::{Mutex, OnceLock, mpsc};
    type Targets = (String, serde_json::Map<String, Value>);
    static QUEUE: OnceLock<Mutex<mpsc::Sender<Targets>>> = OnceLock::new();
    let queue = QUEUE.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Targets>();
        let _ = std::thread::Builder::new()
            .name("dock-targets".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let mut newest = BTreeMap::from([first]);
                    newest.extend(rx.try_iter());
                    for (output, targets) in newest {
                        let sent = crate::hyalo::request(json!({"request": "minimize_targets", "output": output, "namespace": crate::dock::NAMESPACE, "targets": targets}));
                        if let Err(e) = sent {
                            eprintln!("nidara-shell: request failed: {e}");
                        }
                    }
                }
            });
        Mutex::new(tx)
    });
    if let Ok(tx) = queue.lock() {
        let _ = tx.send((output, targets));
    }
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
            pid: None,
            moving: false,
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
            workspaces: vec![],
        }));
        let job = requested
            .try_recv()
            .expect("its window opened: the icon is asked for");
        assert_eq!(job.id, "org.gnome.Terminal.desktop");
    }
    #[test]
    fn a_magnifying_dock_fetches_its_art_at_both_sizes() {
        for magnification in [true, false] {
            let (jobs, requested) = std::sync::mpsc::channel();
            let prefs = Prefs {
                icon_size: 64,
                max_icon_size: 128,
                magnification,
                ..Prefs::default()
            };
            let mut hub = Hub::new(
                prefs,
                Some(jobs),
                None,
                None,
                Arc::new(Status::default()),
                None,
            );
            let kitty = crate::model::App {
                id: "kitty.desktop".into(),
                generation: 1,
                name: "kitty".into(),
                launchable: true,
                ..Default::default()
            };
            hub.handle(HubEvent::Apps(AppsUpdate::State(AppsState {
                epoch: 1,
                revision: 1,
                apps: vec![kitty],
                pins: vec![crate::model::Pin::App {
                    id: "kitty.desktop".into(),
                    key: "app:kitty.desktop".into(),
                }],
                default_directory: None,
                capabilities: vec![],
                icon_revision: 1,
                layout_revision: 0,
            })));
            let asked: Vec<IconJob> = requested.try_iter().collect();
            let sizes: Vec<u32> = asked.iter().map(|j| j.logical).collect();
            if !magnification {
                assert_eq!(sizes, [64]);
                continue;
            }
            assert_eq!(sizes, [64, 128]);
            for job in asked {
                let side = job.logical;
                hub.handle(HubEvent::Icon(
                    job,
                    Some(crate::apps::Icon {
                        width: side,
                        height: side,
                        rgba: vec![0; (side * side * 4) as usize],
                    }),
                ));
            }
            assert_eq!(hub.icons["kitty.desktop"].logical, 64);
            assert_eq!(hub.large_icons["kitty.desktop"].logical, 128);
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
