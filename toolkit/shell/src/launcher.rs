// SPDX-License-Identifier: LGPL-3.0-or-later
//! Apps (D4, #959): the app grid, a LAYER of the shell that opens like an app (owner,
//! 2026-11-02). It has its own desktop entry (`org.nidara.Apps.desktop`), so it is listed
//! in its own grid, found by search and pinned or unpinned in the dock like any app; it
//! opens from that entry (D-Bus activation, `activation.rs`), from the dock or from the
//! launcher shortcut (Shell1 `ToggleSurface("app-grid")`). Opening it again closes it.
//!
//! What it is: the TypeScript grid's panel without its workspace strip — a search pill
//! over a grid of `COLUMNS` × `ROWS` visible tiles that scrolls, centred on the output, on
//! an overlay layer that takes the keyboard. With an empty search it lists every visible
//! app A–Z, the newly observed ones marked "New"; typing asks Applications1's Search,
//! whose tiers decide the order. A click or Enter launches (with a token from that input,
//! so the app comes to the front) and closes it; Escape clears the search, then closes;
//! a click outside the panel closes. A tile held and dragged becomes a drag of that app
//! (`nidara_shell_ipc::drag`): the panel steps aside so the dock can be reached, and it
//! closes when the drag ends.
//!
//! The panel's glass is Hyalo's (the panel material of `nk-settings`' exports, as the
//! dock's menus); its content is ours, in the shell's dark skin.
use crate::apps::{Icon, IconJob};
use crate::hub::{HubEvent, Request};
use crate::menu::Label;
use crate::model::App;
use crate::popup::Look;
use nidara_shell_ipc::drag;
use nk_render::{Canvas, Color, ImageFit, Raster};
use nk_text::{Rect, TextBackend, TextStyle};
use nk_wayland::{
    Application, DragIcon, Edges, Event, KeyboardMode, LayerLevel, LayerPlacement, LayerSpec,
    Material, Options, Pane, TokenRequest, WakeSource, Waker, Window,
};
use std::collections::HashMap;
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use unicode_segmentation::UnicodeSegmentation;

pub const NAMESPACE: &str = "nidara-apps";
/// Apps' own desktop entry: what the dock pins and Applications1 launches.
pub const DESKTOP_ID: &str = "org.nidara.Apps.desktop";

/// The TypeScript grid's measures (AppGrid.tsx, `_app-grid.scss`).
pub const COLUMNS: usize = 6;
pub const ROWS: usize = 3;
/// A tile: 110 of content in the scss's 16 px padding, and the TS row height.
pub const TILE: (f64, f64) = (150., 163.);
pub const GAP: f64 = 8.;
pub const ICON: f64 = 72.;
/// The icon plate the icon is centred in, and the gap to the label.
const PLATE: f64 = 96.;
const LABEL_GAP: f64 = 12.;
const TILE_PAD_Y: f64 = 12.;
/// From the glass to the content: 26 above, 30 at the sides, 26 below.
const INSET: (f64, f64) = (26., 30.);
const SEARCH_HEIGHT: f64 = 36.;
const SEARCH_PAD_X: f64 = 16.;
/// From the search pill to the first row.
const SEARCH_GAP: f64 = 16.;
/// The panel's corners, and the tiles'.
const RADIUS: f64 = 34.;
const TILE_RADIUS: f64 = 14.;
/// How far a held tile must move to become a drag.
const DRAG_SLOP: f64 = 6.;
const SEARCH_LIMIT: u32 = 100;

const LEFT_BUTTON: u32 = 0x110;
const ESCAPE: u32 = 0xff1b;
const RETURN: u32 = 0xff0d;
const KP_ENTER: u32 = 0xff8d;
const BACKSPACE: u32 = 0xff08;
const LEFT: u32 = 0xff51;
const UP: u32 = 0xff52;
const RIGHT: u32 = 0xff53;
const DOWN: u32 = 0xff54;
const HOME: u32 = 0xff50;
const END: u32 = 0xff57;
const PAGE_UP: u32 = 0xff55;
const PAGE_DOWN: u32 = 0xff56;

/// One app as Apps lists it.
#[derive(Clone, Debug, PartialEq)]
pub struct Entry {
    pub id: String,
    pub generation: u64,
    pub name: String,
    pub is_new: bool,
}

/// The visible launchable apps of a catalogue, A–Z by their name (case and accents
/// folded the simple way), ties by DesktopId.
pub fn entries(apps: &[App]) -> Vec<Entry> {
    let mut list: Vec<Entry> = apps
        .iter()
        .filter(|a| a.visible && a.launchable)
        .map(|a| Entry {
            id: a.id.clone(),
            generation: a.generation,
            name: if a.name.is_empty() {
                a.id.trim_end_matches(".desktop").to_string()
            } else {
                a.name.clone()
            },
            is_new: a.is_new,
        })
        .collect();
    list.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.id.cmp(&b.id))
    });
    list
}

/// The panel and its parts, in the layer's logical coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Geometry {
    pub panel: [f64; 4],
    pub search: [f64; 4],
    /// The scrolling grid's viewport.
    pub grid: [f64; 4],
}

/// The panel centred on an output of `size`; smaller outputs get fewer columns and rows,
/// never a panel past the edges.
pub fn geometry(size: (u32, u32)) -> (Geometry, usize, usize) {
    let (w, h) = (size.0 as f64, size.1 as f64);
    let fit = |room: f64, tile: f64| ((room + GAP) / (tile + GAP)).floor().max(1.) as usize;
    let columns = COLUMNS.min(fit(w - 2. * INSET.1 - 32., TILE.0));
    let chrome = INSET.0 * 2. + SEARCH_HEIGHT + SEARCH_GAP;
    let rows = ROWS.min(fit(h - chrome - 32., TILE.1));
    let grid_w = columns as f64 * TILE.0 + (columns as f64 - 1.) * GAP;
    let grid_h = rows as f64 * TILE.1 + (rows as f64 - 1.) * GAP;
    let pw = grid_w + 2. * INSET.1;
    let ph = chrome + grid_h;
    let (px, py) = (((w - pw) / 2.).round(), ((h - ph) / 2.).round());
    let search = [px + INSET.1, py + INSET.0, grid_w, SEARCH_HEIGHT];
    let grid = [
        px + INSET.1,
        py + INSET.0 + SEARCH_HEIGHT + SEARCH_GAP,
        grid_w,
        grid_h,
    ];
    (
        Geometry {
            panel: [px, py, pw, ph],
            search,
            grid,
        },
        columns,
        rows,
    )
}

fn inside(r: [f64; 4], (x, y): (f64, f64)) -> bool {
    x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]
}

/// What the workers hand the layer: icons, and search answers.
#[derive(Default)]
struct Inbox {
    icons: Vec<(IconJob, Option<Icon>)>,
    /// (the query asked, its ids best first); Err: Search failed.
    results: Vec<(String, Result<Vec<String>, String>)>,
}

/// One Apps layer: opened by the hub, closed by itself or by the hub.
pub struct Launcher {
    hub: Sender<HubEvent>,
    epoch: u64,
    all: Vec<Entry>,
    /// Indices into `all`, in the order shown.
    shown: Vec<usize>,
    query: String,
    preedit: String,
    /// The query whose answer is shown (None: the A–Z list).
    answered: Option<String>,
    scroll: f64,
    hover: Option<usize>,
    /// The tile the keyboard is on (a position in `shown`).
    focus: Option<usize>,
    pressed: Option<(usize, (f64, f64), u32)>,
    outside_press: bool,
    dragging: bool,
    pointer: (f64, f64),
    size: (u32, u32),
    scale: f64,
    icons: HashMap<String, Arc<Raster>>,
    art: HashMap<String, Icon>,
    asked: std::collections::HashSet<String>,
    icon_jobs: Option<Sender<IconJob>>,
    searches: Option<Sender<String>>,
    inbox: Arc<Mutex<Inbox>>,
    look: Option<Look>,
    tried_look: bool,
    bus: Option<zbus::blocking::Connection>,
    labels: HashMap<String, Rc<nk_text::Layout>>,
    pending: HashMap<TokenRequest, (String, u64)>,
    close: Arc<AtomicBool>,
    closing: bool,
    waker: Option<Waker>,
    a11y: Option<nk_a11y::bridge::Bridge>,
    a11y_requests: Option<Receiver<(u64, nk_a11y::Request)>>,
    revision: u64,
    shape: Vec<(nk_a11y::NodeId, nk_a11y::Role, Vec<nk_a11y::Action>)>,
}

impl Launcher {
    /// `close` is shared with the hub: set by either side, the layer goes.
    pub fn new(
        hub: Sender<HubEvent>,
        epoch: u64,
        apps: &[App],
        bus: Option<zbus::blocking::Connection>,
        close: Arc<AtomicBool>,
    ) -> Self {
        let all = entries(apps);
        let shown = (0..all.len()).collect();
        Self {
            hub,
            epoch,
            all,
            shown,
            query: String::new(),
            preedit: String::new(),
            answered: None,
            scroll: 0.,
            hover: None,
            focus: None,
            pressed: None,
            outside_press: false,
            dragging: false,
            pointer: (-1., -1.),
            size: (0, 0),
            scale: 1.,
            icons: HashMap::new(),
            art: HashMap::new(),
            asked: Default::default(),
            icon_jobs: None,
            searches: None,
            inbox: Arc::new(Mutex::new(Inbox::default())),
            look: None,
            tried_look: false,
            bus,
            labels: HashMap::new(),
            pending: HashMap::new(),
            close,
            closing: false,
            waker: None,
            a11y: None,
            a11y_requests: None,
            revision: 0,
            shape: vec![],
        }
    }

    /// The workers: icons and Search, each on its own connection's thread, waking the
    /// layer with what they bring.
    fn start_workers(&mut self, waker: Waker) {
        self.waker = Some(waker.clone());
        let Some(conn) = self.bus.clone() else {
            return;
        };
        let (jobs_tx, jobs_rx) = channel::<IconJob>();
        let (inbox, w) = (self.inbox.clone(), waker.clone());
        let c = conn.clone();
        let _ = std::thread::Builder::new()
            .name("apps-layer-icons".into())
            .spawn(move || {
                crate::apps::icons(c, jobs_rx, move |job, icon| {
                    inbox.lock().unwrap().icons.push((job, icon));
                    let _ = w.wake();
                })
            });
        self.icon_jobs = Some(jobs_tx);
        let (search_tx, search_rx) = channel::<String>();
        let (inbox, epoch) = (self.inbox.clone(), self.epoch);
        let _ = std::thread::Builder::new()
            .name("apps-layer-search".into())
            .spawn(move || search_worker(conn, epoch, search_rx, inbox, waker));
        self.searches = Some(search_tx);
    }

    fn geometry(&self) -> (Geometry, usize, usize) {
        geometry(self.size)
    }

    /// Tile `n` of the shown list, scrolled, in layer coordinates.
    fn tile(&self, n: usize) -> [f64; 4] {
        let (g, columns, _) = self.geometry();
        let (row, col) = (n / columns, n % columns);
        [
            g.grid[0] + col as f64 * (TILE.0 + GAP),
            g.grid[1] + row as f64 * (TILE.1 + GAP) - self.scroll,
            TILE.0,
            TILE.1,
        ]
    }

    fn content_height(&self) -> f64 {
        let (_, columns, _) = self.geometry();
        let rows = self.shown.len().div_ceil(columns);
        (rows as f64 * (TILE.1 + GAP) - GAP).max(0.)
    }

    fn max_scroll(&self) -> f64 {
        let (g, ..) = self.geometry();
        (self.content_height() - g.grid[3]).max(0.)
    }

    fn tile_at(&self, at: (f64, f64)) -> Option<usize> {
        let (g, ..) = self.geometry();
        if !inside(g.grid, at) {
            return None;
        }
        (0..self.shown.len()).find(|&n| inside(self.tile(n), at))
    }

    /// Scroll so tile `n` is whole in the viewport.
    fn reveal(&mut self, n: usize) {
        let (g, ..) = self.geometry();
        let [_, y, _, h] = self.tile(n);
        let top = y + self.scroll - g.grid[1];
        if top < self.scroll {
            self.scroll = top;
        } else if top + h > self.scroll + g.grid[3] {
            self.scroll = top + h - g.grid[3];
        }
        self.scroll = self.scroll.clamp(0., self.max_scroll());
    }

    /// The query changed: the A–Z list for an empty one, else ask Search (the shown list
    /// keeps the last answer until the new one comes).
    fn requery(&mut self) {
        let q = self.query.trim().to_string();
        self.scroll = 0.;
        if q.is_empty() {
            self.answered = None;
            self.shown = (0..self.all.len()).collect();
            self.focus = None;
        } else if let Some(s) = &self.searches {
            let _ = s.send(q);
        } else {
            // No service to rank with: a plain substring filter, A–Z.
            let lower = q.to_lowercase();
            self.shown = (0..self.all.len())
                .filter(|&i| self.all[i].name.to_lowercase().contains(&lower))
                .collect();
            self.answered = Some(q);
            self.focus = (!self.shown.is_empty()).then_some(0);
        }
    }

    fn drain(&mut self) {
        let inbox = std::mem::take(&mut *self.inbox.lock().unwrap());
        for (job, icon) in inbox.icons {
            if let Some(icon) = icon
                && let Ok(r) =
                    Raster::from_rgba(icon.width as u16, icon.height as u16, icon.rgba.clone())
            {
                self.icons.insert(job.id.clone(), Arc::new(r));
                self.art.insert(job.id, icon);
            }
        }
        // Only the answer to the query typed now counts.
        let now = self.query.trim().to_string();
        for (q, result) in inbox.results {
            if q != now {
                continue;
            }
            match result {
                Ok(ids) => {
                    let index: HashMap<&str, usize> = self
                        .all
                        .iter()
                        .enumerate()
                        .map(|(i, e)| (e.id.as_str(), i))
                        .collect();
                    self.shown = ids
                        .iter()
                        .filter_map(|id| index.get(id.as_str()).copied())
                        .collect();
                }
                Err(e) => {
                    eprintln!("nidara-shell: Apps search failed: {e}");
                    let lower = q.to_lowercase();
                    self.shown = (0..self.all.len())
                        .filter(|&i| self.all[i].name.to_lowercase().contains(&lower))
                        .collect();
                }
            }
            self.answered = Some(q);
            self.scroll = 0.;
            self.focus = (!self.shown.is_empty()).then_some(0);
        }
    }

    /// Ask for the icons of the tiles in view (and a row either side).
    fn want_icons(&mut self) {
        let Some(jobs) = &self.icon_jobs else {
            return;
        };
        let (g, columns, rows) = self.geometry();
        let first_row = (self.scroll / (TILE.1 + GAP)).floor().max(0.) as usize;
        let from = first_row.saturating_sub(1) * columns;
        let to = ((first_row + rows + 2) * columns).min(self.shown.len());
        let _ = g;
        for &i in self.shown.get(from..to).unwrap_or(&[]) {
            let e = &self.all[i];
            if self.asked.insert(e.id.clone()) {
                let _ = jobs.send(IconJob {
                    epoch: self.epoch,
                    id: e.id.clone(),
                    generation: e.generation,
                    logical: ICON as u32,
                    scale: self.scale,
                });
            }
        }
    }

    fn finish(&mut self, w: &mut Window) {
        if !self.closing {
            self.closing = true;
            self.close.store(true, Ordering::SeqCst);
            w.close();
        }
    }

    /// Launch shown tile `n` with a token from `serial`'s input, then close.
    fn launch(&mut self, n: usize, serial: Option<u32>, w: &mut Window) {
        let Some(e) = self.shown.get(n).map(|&i| self.all[i].clone()) else {
            return;
        };
        // Apps itself: already open, nothing to start.
        if e.id == DESKTOP_ID {
            self.finish(w);
            return;
        }
        if let Some(serial) = serial {
            let target = e.id.trim_end_matches(".desktop").to_string();
            match w.request_activation_token(serial, Some(&target)) {
                Ok(t) => {
                    self.pending.insert(t, (e.id, e.generation));
                    // It closes once the token is in hand (or refused).
                    return;
                }
                Err(err) => {
                    eprintln!("nidara-shell: no activation token ({err:?}); launching without one")
                }
            }
        }
        self.send_launch(e.id, e.generation, None);
        self.finish(w);
    }

    fn send_launch(&self, id: String, generation: u64, token: Option<String>) {
        eprintln!("nidara-shell: Apps launches {id}");
        let _ = self.hub.send(HubEvent::Request(Request::Launch {
            id,
            generation,
            token,
        }));
    }

    /// A held tile moved far enough: it becomes a drag of that app, its icon under the
    /// pointer, and the panel steps aside.
    fn start_drag(&mut self, n: usize, serial: u32, w: &mut Window) {
        let Some(e) = self.shown.get(n).map(|&i| self.all[i].clone()) else {
            return;
        };
        let data = drag::encode(&drag::App {
            id: e.id.clone(),
            generation: e.generation,
        });
        let icon = self.art.get(&e.id).map(drag_icon);
        match w.start_drag(serial, vec![(drag::APP_MIME.to_string(), data)], icon) {
            Ok(()) => {
                self.dragging = true;
                self.pressed = None;
                // Nothing of the panel takes input while the drag lasts.
                let _ = w.set_input_region(Some(&[]));
                w.redraw();
            }
            Err(e) => eprintln!("nidara-shell: Apps could not start a drag: {e:?}"),
        }
    }

    fn key(&mut self, key: nk_wayland::Key, w: &mut Window) {
        let (_, columns, rows) = self.geometry();
        let count = self.shown.len();
        let mv = |s: &mut Self, to: usize| {
            if count > 0 {
                let to = to.min(count - 1);
                s.focus = Some(to);
                s.reveal(to);
            }
        };
        match key.sym {
            ESCAPE if !self.query.is_empty() => {
                self.query.clear();
                self.requery();
            }
            ESCAPE => self.finish(w),
            RETURN | KP_ENTER => {
                if let Some(n) = self
                    .focus
                    .or((count > 0 && !self.query.is_empty()).then_some(0))
                {
                    self.launch(n, key.serial, w);
                }
            }
            BACKSPACE if key.ctrl => {
                self.query.clear();
                self.requery();
            }
            BACKSPACE => {
                if let Some((at, _)) = self.query.grapheme_indices(true).next_back() {
                    self.query.truncate(at);
                    self.requery();
                }
            }
            LEFT => mv(self, self.focus.map_or(0, |f| f.saturating_sub(1))),
            RIGHT => mv(self, self.focus.map_or(0, |f| f + 1)),
            UP => mv(self, self.focus.map_or(0, |f| f.saturating_sub(columns))),
            DOWN => mv(self, self.focus.map_or(0, |f| f + columns)),
            HOME => mv(self, 0),
            END => mv(self, count.saturating_sub(1)),
            PAGE_UP => mv(
                self,
                self.focus.map_or(0, |f| f.saturating_sub(columns * rows)),
            ),
            PAGE_DOWN => mv(self, self.focus.map_or(0, |f| f + columns * rows)),
            _ if !key.ctrl && !key.alt && !key.text.is_empty() => {
                let text: String = key.text.chars().filter(|c| !c.is_control()).collect();
                if !text.is_empty() {
                    self.query.push_str(&text);
                    self.requery();
                }
            }
            _ => return,
        }
        self.sync_text_input(w);
        w.redraw();
    }

    fn sync_text_input(&self, w: &mut Window) {
        let (g, ..) = self.geometry();
        let cursor = self.query.len();
        w.set_text_input(nk_wayland::TextInput {
            focused: true,
            password: false,
            text: self.query.clone(),
            cursor,
            anchor: cursor,
            rect: [
                (g.search[0] + SEARCH_PAD_X + 26.) as i32,
                g.search[1] as i32,
                1,
                g.search[3] as i32,
            ],
        });
    }

    /// The label of `e`, at most two lines in a tile, an ellipsis where it is cut.
    fn label(&mut self, e: &Entry, style: &TextStyle, width: f32) -> Option<Rc<nk_text::Layout>> {
        if let Some(l) = self.labels.get(&e.id) {
            return Some(l.clone());
        }
        let look = self.look.as_mut()?;
        let mut text = e.name.clone();
        let mut layout = look.text.layout(&text, style, width).ok()?;
        while layout.lines().len() > 2 {
            let end = layout.lines()[1].range.end.min(text.len());
            let mut cut: String = text[..end].trim_end().to_string();
            // One grapheme fewer each time until it fits with its ellipsis.
            if let Some((at, _)) = cut.grapheme_indices(true).next_back() {
                cut.truncate(at);
            }
            if cut.is_empty() {
                break;
            }
            text = format!("{}…", cut.trim_end());
            layout = look.text.layout(&text, style, width).ok()?;
        }
        let layout = Rc::new(layout);
        self.labels.insert(e.id.clone(), layout.clone());
        Some(layout)
    }
}

impl Launcher {
    fn publish_semantics(&mut self) {
        let (g, ..) = self.geometry();
        let tiles: Vec<[f64; 4]> = (0..self.shown.len()).map(|n| self.tile(n)).collect();
        let tree = tree(&Semantics {
            all: &self.all,
            shown: &self.shown,
            tiles: &tiles,
            grid: g.grid,
            search: g.search,
            size: self.size,
            query: &self.query,
            focus: self.focus,
        });
        let shape: Vec<_> = tree
            .nodes
            .values()
            .map(|n| (n.id, n.role, n.actions.clone()))
            .collect();
        if shape != self.shape || self.revision == 0 {
            self.shape = shape;
            self.revision += 1;
        }
        match &self.a11y {
            Some(bridge) => {
                while bridge.published.try_recv().is_ok() {}
                if let Err(e) = bridge.update(self.revision, tree) {
                    eprintln!("nidara-shell: Apps accessibility stopped: {e}");
                }
            }
            None => {
                let mut bridge = nk_a11y::bridge::Bridge::new(self.revision, tree);
                // Forwarded with this layer's waker, so a request is handled at once.
                let (requests, rx) = channel();
                let from = std::mem::replace(&mut bridge.requests, channel().1);
                let waker = self.waker.clone();
                let _ = std::thread::Builder::new()
                    .name("apps-a11y".into())
                    .spawn(move || {
                        for r in from {
                            if requests.send(r).is_err() {
                                return;
                            }
                            if let Some(w) = &waker {
                                let _ = w.wake();
                            }
                        }
                    });
                self.a11y = Some(bridge);
                self.a11y_requests = Some(rx);
            }
        }
    }

    /// A screen reader's requests; ones made against an older tree are dropped.
    fn a11y(&mut self, w: &mut Window) {
        let Some(rx) = &self.a11y_requests else {
            return;
        };
        let requests: Vec<_> = rx.try_iter().collect();
        for (revision, request) in requests {
            if revision != self.revision {
                continue;
            }
            match request {
                nk_a11y::Request::SetText(SEARCH, text) => {
                    self.query = text;
                    self.requery();
                    self.sync_text_input(w);
                    w.redraw();
                }
                nk_a11y::Request::Activate(id) | nk_a11y::Request::Focus(id) => {
                    let Some(n) = self.shown.iter().position(|&i| tile_id(i) == id) else {
                        continue;
                    };
                    if matches!(request, nk_a11y::Request::Activate(_)) {
                        // No input event behind it, so no activation token.
                        self.launch(n, None, w);
                        return;
                    }
                    self.focus = Some(n);
                    self.reveal(n);
                    w.redraw();
                }
                _ => {}
            }
        }
    }
}

const ROOT: nk_a11y::NodeId = 1;
const SEARCH: nk_a11y::NodeId = 2;
const LIST: nk_a11y::NodeId = 3;

/// An app's node: its place in the whole list, stable while the layer lives.
fn tile_id(index: usize) -> nk_a11y::NodeId {
    16 + index as nk_a11y::NodeId
}

struct Semantics<'a> {
    all: &'a [Entry],
    shown: &'a [usize],
    tiles: &'a [[f64; 4]],
    grid: [f64; 4],
    search: [f64; 4],
    size: (u32, u32),
    query: &'a str,
    focus: Option<usize>,
}

/// What a screen reader is told: a window named Apps holding the search field and the
/// list of the apps shown, in order, the keyboard's tile focused; the field holds the
/// focus otherwise, as typing goes there.
fn tree(s: &Semantics) -> nk_a11y::Tree {
    use nk_a11y::{Action, Bounds, Node, Role};
    let bounds = |r: [f64; 4]| Bounds {
        x: r[0],
        y: r[1],
        width: r[2],
        height: r[3],
    };
    let mut nodes = std::collections::BTreeMap::new();
    let mut root = Node::new(ROOT, Role::Window, "Apps");
    root.states.active = true;
    root.bounds = bounds([0., 0., s.size.0 as f64, s.size.1 as f64]);
    root.children = vec![SEARCH, LIST];
    let mut search = Node::new(SEARCH, Role::TextInput, "Search");
    search.states.focused = s.focus.is_none();
    search.actions = vec![Action::Focus, Action::SetText];
    search.bounds = bounds(s.search);
    search.text = Some(nk_a11y::TextInfo {
        text: s.query.to_string(),
        caret: s.query.len(),
        anchor: s.query.len(),
        words: vec![],
        lines: std::iter::once(0..s.query.len()).collect(),
        geometry: None,
    });
    let mut list = Node::new(LIST, Role::List, "Applications");
    list.bounds = bounds(s.grid);
    for (n, &i) in s.shown.iter().enumerate() {
        let e = &s.all[i];
        let id = tile_id(i);
        let mut node = Node::new(id, Role::Button, e.name.as_str());
        if e.is_new {
            node.description = "new".into();
        }
        node.states.focused = s.focus == Some(n);
        let t = s.tiles[n];
        node.states.offscreen = t[1] + t[3] <= s.grid[1] || t[1] >= s.grid[1] + s.grid[3];
        node.actions = vec![Action::Focus, Action::Activate];
        node.bounds = bounds(t);
        list.children.push(id);
        nodes.insert(id, node);
    }
    nodes.insert(ROOT, root);
    nodes.insert(SEARCH, search);
    nodes.insert(LIST, list);
    nk_a11y::Tree { root: ROOT, nodes }
}

fn search_worker(
    conn: zbus::blocking::Connection,
    epoch: u64,
    queries: Receiver<String>,
    inbox: Arc<Mutex<Inbox>>,
    waker: Waker,
) {
    while let Ok(mut q) = queries.recv() {
        // Only the newest of the queries typed meanwhile is asked.
        while let Ok(newer) = queries.try_recv() {
            q = newer;
        }
        let result = crate::apps::search(&conn, epoch, &q, SEARCH_LIMIT);
        inbox.lock().unwrap().results.push((q, result));
        if waker.wake().is_err() {
            return;
        }
    }
}

/// The dragged app's picture: its icon, premultiplied in the compositor's byte order, at
/// `ICON` logical with the pointer at its centre.
fn drag_icon(icon: &Icon) -> DragIcon {
    let mut pixels = Vec::with_capacity(icon.rgba.len());
    for p in icon.rgba.as_chunks::<4>().0 {
        let a = u16::from(p[3]);
        let pm = |c: u8| ((u16::from(c) * a + 127) / 255) as u8;
        pixels.extend_from_slice(&[pm(p[2]), pm(p[1]), pm(p[0]), p[3]]);
    }
    let side = ICON as u32;
    DragIcon {
        pixel_width: icon.width as u16,
        pixel_height: icon.height as u16,
        width: side,
        height: side,
        hotspot: (side as i32 / 2, side as i32 / 2),
        pixels,
    }
}

impl Application for Launcher {
    fn event(&mut self, event: Event, w: &mut Window) -> nk_wayland::Result<()> {
        if self.close.load(Ordering::SeqCst) && !self.closing {
            self.finish(w);
            return Ok(());
        }
        // The pointer alone changes nothing a reader is told.
        let quiet = matches!(event, Event::Motion(..) | Event::PointerLeave);
        match event {
            Event::Configure => {
                let size = w.size();
                if size != self.size {
                    self.size = size;
                    self.labels.clear();
                }
                self.scale = w.scale();
                if !self.tried_look {
                    self.tried_look = true;
                    if let Some(bus) = &self.bus {
                        self.look = Look::load(bus)
                            .map_err(|e| eprintln!("nidara-shell: Apps has no look: {e}"))
                            .ok();
                    }
                }
                self.sync_text_input(w);
                self.want_icons();
                w.redraw();
            }
            Event::Wake => {
                self.a11y(w);
                if self.closing {
                    return Ok(());
                }
                self.drain();
                self.want_icons();
                w.redraw();
            }
            Event::Closed => self.finish(w),
            Event::Motion(x, y) => {
                self.pointer = (x, y);
                if let Some((n, at, serial)) = self.pressed
                    && !self.dragging
                    && ((x - at.0).powi(2) + (y - at.1).powi(2)).sqrt() > DRAG_SLOP
                {
                    self.start_drag(n, serial, w);
                    return Ok(());
                }
                let hover = self.tile_at((x, y));
                if hover != self.hover {
                    self.hover = hover;
                    w.redraw();
                }
            }
            Event::PointerLeave => {
                if self.hover.take().is_some() {
                    w.redraw();
                }
            }
            Event::Button {
                button: LEFT_BUTTON,
                pressed: true,
                serial,
                ..
            } if !self.dragging => {
                let (g, ..) = self.geometry();
                self.outside_press = !inside(g.panel, self.pointer);
                self.pressed = self
                    .tile_at(self.pointer)
                    .map(|n| (n, self.pointer, serial));
            }
            Event::Button {
                button: LEFT_BUTTON,
                pressed: false,
                serial,
                ..
            } if !self.dragging => {
                let (g, ..) = self.geometry();
                if self.outside_press && !inside(g.panel, self.pointer) {
                    self.finish(w);
                } else if let Some((n, ..)) = self.pressed.take()
                    && self.tile_at(self.pointer) == Some(n)
                {
                    self.launch(n, Some(serial), w);
                }
                self.outside_press = false;
            }
            Event::Scroll(delta) if !self.dragging => {
                self.scroll = (self.scroll + delta).clamp(0., self.max_scroll());
                self.hover = self.tile_at(self.pointer);
                self.want_icons();
                w.redraw();
            }
            Event::Key(key) if !self.dragging => self.key(key, w),
            Event::Ime(batch) if !self.dragging => {
                self.preedit = batch.preedit.map(|(t, ..)| t).unwrap_or_default();
                if let Some(commit) = batch.commit {
                    self.query.push_str(&commit);
                    self.requery();
                }
                self.sync_text_input(w);
                w.redraw();
            }
            Event::DragEnded { dropped } => {
                eprintln!("nidara-shell: Apps drag ended (dropped: {dropped})");
                self.finish(w);
            }
            Event::ActivationToken { request, token } => {
                if let Some((id, generation)) = self.pending.remove(&request) {
                    self.send_launch(id, generation, Some(token.into_string()));
                    self.finish(w);
                }
            }
            Event::ActivationTokenFailed { request, reason } => {
                if let Some((id, generation)) = self.pending.remove(&request) {
                    eprintln!(
                        "nidara-shell: activation token failed ({reason:?}); launching without one"
                    );
                    self.send_launch(id, generation, None);
                    self.finish(w);
                }
            }
            _ => {}
        }
        if !self.closing && !quiet {
            self.publish_semantics();
        }
        Ok(())
    }

    fn paint(&mut self, f: nk_wayland::Frame) -> nk_wayland::Result<Vec<u8>> {
        let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
        if self.dragging || self.closing || self.look.is_none() {
            return Ok(c.finish());
        }
        let (g, ..) = self.geometry();
        let rect = |r: [f64; 4]| Rect {
            x: r[0] as f32,
            y: r[1] as f32,
            width: r[2] as f32,
            height: r[3] as f32,
        };
        let (menu, base_text) = {
            let look = self.look.as_ref().unwrap();
            (look.style.row.clone(), look.styles.text.clone())
        };
        if !f.material {
            // No compositor glass (another compositor): the panel's own opaque base (D5).
            c.rounded_rect(rect(g.panel), RADIUS, menu.background);
        }
        // The search pill: a raised fill inside a hairline border.
        let pill = rect(g.search);
        c.rounded_rect(pill, g.search[3] / 2., menu.border_color);
        let inner = Rect {
            x: pill.x + 1.,
            y: pill.y + 1.,
            width: pill.width - 2.,
            height: pill.height - 2.,
        };
        c.rounded_rect(inner, g.search[3] / 2. - 1., ink(0.08));
        let mut style = base_text.clone();
        style.size *= menu.text_scale;
        style.weight = menu.weight;
        let shown_query = format!("{}{}", self.query, self.preedit);
        let (text, color) = if shown_query.is_empty() {
            (
                self.look
                    .as_ref()
                    .unwrap()
                    .text_of(&Label::Key("app-grid.search.placeholder")),
                menu.text.multiply_alpha(0.5),
            )
        } else {
            (shown_query, menu.text)
        };
        let tx = (g.search[0] + SEARCH_PAD_X) as f32;
        let width = (g.search[2] - 2. * SEARCH_PAD_X) as f32;
        if let Some(look) = self.look.as_mut()
            && let Ok(layout) = look.text.layout(&text, &style, 4096.)
        {
            let h = layout.measured_size().height;
            let ty = (g.search[1] + (g.search[3] - f64::from(h)) / 2.) as f32;
            c.clip(Rect {
                x: tx,
                y: pill.y,
                width,
                height: pill.height,
            });
            c.layout(&layout, (tx, ty), color)?;
            if !self.query.is_empty() || !self.preedit.is_empty() {
                // The caret, after the text.
                let cx = tx + layout.measured_size().width + 1.;
                c.rect(
                    Rect {
                        x: cx,
                        y: ty + 2.,
                        width: 1.5,
                        height: h - 4.,
                    },
                    menu.text,
                );
            }
            c.pop_clip();
        }

        // The grid.
        let mut label_style = base_text;
        label_style.size *= menu.text_scale * 0.92;
        label_style.weight = 500.;
        label_style.alignment = nk_text::Alignment::Center;
        c.clip(rect(g.grid));
        if self.shown.is_empty()
            && self.answered.is_some()
            && let Some(look) = self.look.as_mut()
            && let Ok(layout) = look.text.layout(
                &look.text_of(&Label::Key("app-grid.no-results")),
                &style,
                4096.,
            )
        {
            let s = layout.measured_size();
            let x = (g.grid[0] + (g.grid[2] - f64::from(s.width)) / 2.) as f32;
            let y = (g.grid[1] + (g.grid[3] - f64::from(s.height)) / 2.) as f32;
            c.layout(&layout, (x, y), menu.text.multiply_alpha(0.6))?;
        }
        for n in 0..self.shown.len() {
            let t = self.tile(n);
            if t[1] + t[3] < g.grid[1] || t[1] > g.grid[1] + g.grid[3] {
                continue;
            }
            let e = self.all[self.shown[n]].clone();
            let lit = self.hover == Some(n) || self.focus == Some(n);
            if lit {
                // The kit's tile states: a quiet wash on hover, the ring for the keyboard.
                c.rounded_rect(rect(t), TILE_RADIUS, ink(0.08));
            }
            if self.focus == Some(n) {
                let ring = rect(t);
                c.rounded_rect(ring, TILE_RADIUS, menu.accent.multiply_alpha(0.35));
                c.rounded_rect(
                    Rect {
                        x: ring.x + 2.,
                        y: ring.y + 2.,
                        width: ring.width - 4.,
                        height: ring.height - 4.,
                    },
                    TILE_RADIUS - 2.,
                    ink(0.10),
                );
            }
            let plate_x = t[0] + (t[2] - PLATE) / 2.;
            let plate_y = t[1] + TILE_PAD_Y;
            let icon = Rect {
                x: (plate_x + (PLATE - ICON) / 2.) as f32,
                y: (plate_y + (PLATE - ICON) / 2.) as f32,
                width: ICON as f32,
                height: ICON as f32,
            };
            match self.icons.get(&e.id) {
                Some(art) => c.image(art, icon, ImageFit::Contain),
                None => c.rounded_rect(icon, 16., ink(0.10)),
            }
            if e.is_new {
                // "New": a small accent dot by the icon's corner (the badge is the dot;
                // its word is for the screen reader).
                let d = 10.;
                c.rounded_rect(
                    Rect {
                        x: icon.x + icon.width - d as f32 / 2.,
                        y: icon.y - d as f32 / 2. + 4.,
                        width: d as f32,
                        height: d as f32,
                    },
                    d / 2.,
                    menu.accent,
                );
            }
            let lw = (t[2] - 16.) as f32;
            if let Some(layout) = self.label(&e, &label_style, lw) {
                let ly = (plate_y + PLATE + LABEL_GAP - 8.) as f32;
                c.layout(&layout, ((t[0] + 8.) as f32, ly), menu.text)?;
            }
        }
        c.pop_clip();
        Ok(c.finish())
    }

    fn material(&self) -> Option<Material> {
        if self.dragging || self.closing || self.size.0 == 0 {
            return None;
        }
        let (g, ..) = self.geometry();
        let pane = Pane {
            x: g.panel[0],
            y: g.panel[1],
            width: g.panel[2],
            height: g.panel[3],
            radius: RADIUS,
            exponent: 2.,
            pointer: None,
        };
        self.look
            .as_ref()?
            .panel
            .as_ref()?
            .at(pane.width.min(pane.height))
            .ok()
            .map(|mut m| {
                m.shapes = vec![pane];
                m
            })
    }
}

/// The dark skin's ink at `alpha`: white.
fn ink(alpha: f32) -> Color {
    Color::new([1., 1., 1., alpha])
}

/// One Apps layer's whole life on its own thread: on the output the compositor chooses
/// (the one in use), over everything, with the keyboard.
pub fn run(mut launcher: Launcher, wake: (Waker, WakeSource)) -> nk_wayland::Result<()> {
    launcher.start_workers(wake.0);
    nk_wayland::run_layer(
        launcher,
        Options {
            material: true,
            map: true,
            app_id: NAMESPACE,
            title: "Apps",
            size: (0, 0),
            require_material: None,
        },
        LayerSpec {
            namespace: NAMESPACE,
            output: None,
            layer: LayerLevel::Overlay,
            placement: LayerPlacement {
                anchor: Edges::TOP | Edges::BOTTOM | Edges::LEFT | Edges::RIGHT,
                size: (0, 0),
                exclusive_zone: -1,
                margin: [0; 4],
                keyboard: KeyboardMode::Exclusive,
            },
        },
        Some(wake.1),
        Instant::now(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str, name: &str, visible: bool) -> App {
        App {
            id: id.into(),
            generation: 1,
            name: name.into(),
            launchable: true,
            visible,
            ..Default::default()
        }
    }

    #[test]
    fn lists_visible_apps_a_to_z() {
        let list = entries(&[
            app("b.desktop", "beta", true),
            app("a.desktop", "Alpha", true),
            app("h.desktop", "Hidden", false),
            app("apps.desktop", "", true),
        ]);
        let names: Vec<&str> = list.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, ["Alpha", "apps", "beta"]);
    }

    #[test]
    fn the_panel_is_centred_and_fits_small_outputs() {
        let (g, columns, rows) = geometry((2560, 1440));
        assert_eq!((columns, rows), (COLUMNS, ROWS));
        assert_eq!(g.panel[0] * 2. + g.panel[2], 2560.);
        let (g, columns, rows) = geometry((800, 600));
        assert!(columns < COLUMNS && rows < ROWS);
        assert!(g.panel[0] >= 0. && g.panel[1] >= 0.);
        assert!(g.panel[0] + g.panel[2] <= 800. && g.panel[1] + g.panel[3] <= 600.);
    }

    #[test]
    fn a_reader_sees_the_search_and_the_shown_apps_in_order() {
        let all = entries(&[
            app("a.desktop", "Alpha", true),
            app("b.desktop", "Beta", true),
        ]);
        let t = tree(&Semantics {
            all: &all,
            shown: &[1, 0],
            tiles: &[[0., 0., 10., 10.], [0., 100., 10., 10.]],
            grid: [0., 0., 100., 50.],
            search: [0., -40., 100., 36.],
            size: (100, 100),
            query: "a",
            focus: Some(0),
        });
        let list = &t.nodes[&LIST];
        let names: Vec<&str> = list
            .children
            .iter()
            .map(|c| t.nodes[c].name.as_str())
            .collect();
        assert_eq!(names, ["Beta", "Alpha"]);
        assert!(t.nodes[&list.children[0]].states.focused);
        assert!(!t.nodes[&SEARCH].states.focused);
        assert!(t.nodes[&list.children[1]].states.offscreen);
        assert_eq!(t.nodes[&SEARCH].text.as_ref().unwrap().text, "a");
    }

    #[test]
    fn a_dragged_icon_is_premultiplied_bgra() {
        let i = drag_icon(&Icon {
            width: 1,
            height: 1,
            rgba: vec![255, 0, 0, 128],
        });
        assert_eq!(i.pixels, [0, 0, 128, 128]);
        assert_eq!(i.hotspot, (36, 36));
    }
}
