// SPDX-License-Identifier: LGPL-3.0-or-later
//! Apps (D4, #959): the app grid, a LAYER of the shell that opens like an app (owner,
//! 2026-11-02). It has its own desktop entry (`org.nidara.Apps.desktop`), so it is listed
//! in its own grid, found by search and pinned or unpinned in the dock like any app; it
//! opens from that entry (D-Bus activation, `activation.rs`), from the dock or from the
//! launcher shortcut (Shell1 `ToggleSurface("app-grid")`). Opening it again closes it.
//!
//! What it is (#1168): a glass panel of the kit's icon items (`nk::IconItem` on `nk::Grid`,
//! measures in `toolkit/tokens/icon-grid.json`), at most 7 × 5 in view and the same panel on
//! any larger output, centred on the output, on an overlay layer that takes the keyboard. A
//! glass search (`nk::SearchEntry`) floats over the grid on a layer of its own: the rows
//! scroll under it and leave through the panel's top edge, blurred more the higher they go
//! (Hyalo's graded blur on a layer between them); they come in from the panel's bottom edge,
//! and the kit's scroll bar starts below the search. With an empty search it lists every
//! visible app A–Z, the newly observed ones marked; typing asks Applications1's Search, whose
//! tiers decide the order. A click or Enter launches (with a token from that input, so the
//! app comes to the front) and closes it; Escape clears the search, then closes; a click
//! outside the panel closes. A tile held and dragged becomes a drag of that app
//! (`nidara_shell_ipc::drag`): the panel steps aside so the dock can be reached, and it
//! closes when the drag ends.
//!
//! Layout, hover, press, focus, Tab, scrolling, the search's editing and input methods and
//! the reader are the kit's (`nk::ViewState`); Apps says what the view is, paints the app
//! icons in their slots, and acts on what is activated.
use crate::apps::Icon;
use crate::hub::{HubEvent, Request};
use crate::menu::Label;
use crate::model::App;
use crate::popup::Look;
use nidara_shell_ipc::drag;
use nk::{
    Activated, Align, Cell, Corner, Key, Node, Padding, PanelLayout, Space, ViewState, Widget,
};
use nk_render::{Canvas, ImageFit};
use nk_text::{Rect, TextStyle};
use nk_wayland::{
    Application, DragIcon, Edges, Event, KeyboardMode, LayerEvent, LayerId, LayerLevel,
    LayerPlacement, LayerSpec, Material, Options, TokenRequest, WakeSource, Waker, Window,
};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const NAMESPACE: &str = "nidara-apps";
/// Apps' own desktop entry: what the dock pins and Applications1 launches.
pub const DESKTOP_ID: &str = "org.nidara.Apps.desktop";

/// How far a held tile must move to become a drag.
const DRAG_SLOP: f64 = 6.;
const SEARCH_LIMIT: u32 = 100;
/// How long Apps holds its first frame for the visible icons. Super must open something at
/// once: a cold batch is ready in ~190 ms (release, #1047), and past this Apps shows what it
/// has, the rest in the neutral art until each arrives. The dock keeps `STARTUP_WAIT`.
const ICON_WAIT: Duration = Duration::from_millis(250);
/// Region ids of Apps' controls.
const REGIONS: u32 = 1;

const LEFT_BUTTON: u32 = 0x110;
const ESCAPE: u32 = 0xff1b;
const LEFT: u32 = 0xff51;
const UP: u32 = 0xff52;
const RIGHT: u32 = 0xff53;
const DOWN: u32 = 0xff54;

/// The view's keys and actions.
const PANEL: &str = "apps";
const SEARCH_PANE: &str = "apps/search";
const SEARCH: &str = "search";
const LIST: &str = "list";
const QUERY: &str = "query";
const SUBMIT: &str = "submit";
const LAUNCH: &str = "launch:";

/// An app's tile: its place in the whole list, stable while the layer lives.
fn item_key(index: usize) -> String {
    format!("a:{index}")
}
fn item_index(key: &str) -> Option<usize> {
    key.strip_prefix("a:")?.split('/').next()?.parse().ok()
}

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

fn inside(r: [f64; 4], (x, y): (f64, f64)) -> bool {
    x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]
}

/// What the workers hand the layer: search answers.
#[derive(Default)]
struct Inbox {
    /// (the query asked, its ids best first); Err: Search failed.
    results: Vec<(String, Result<Vec<String>, String>)>,
}

/// What the kit needs to lay Apps out and paint it, loaded once with the look.
struct Kit {
    tokens: nk::Tokens,
    types: nk::TypeScale,
    blur: nk_wayland::Blur,
    icons: Option<nk_icons::Icons>,
}

/// The layers over the panel: the graded blur, then the search's glass over it.
#[derive(Clone, Copy)]
struct Layers {
    blur: LayerId,
    search: LayerId,
}

/// One Apps layer: opened by the hub, closed by itself or by the hub.
pub struct Launcher {
    locale_generation: u64,
    metrics_id: i64,
    hub: Sender<HubEvent>,
    epoch: u64,
    all: Vec<Entry>,
    /// Indices into `all`, in the order shown.
    shown: Vec<usize>,
    query: String,
    /// The query whose answer is shown (None: the A–Z list).
    answered: Option<String>,
    state: ViewState,
    kit: Option<Kit>,
    layout: Option<PanelLayout>,
    layers: Option<Layers>,
    /// The frame painted last, its search taken out onto its layer: the panel's glass.
    last: nk::Frame,
    /// A press on a tile: which (its place in `all`), where, its serial; a drag once it
    /// moves far enough.
    pressed: Option<(usize, (f64, f64), u32)>,
    /// The serial of the last key or button, for an activation token.
    serial: Option<u32>,
    outside_press: bool,
    dragging: bool,
    pointer: (f64, f64),
    size: (u32, u32),
    scale: f64,
    memory: Option<Arc<crate::icon_memory::Memory>>,
    icon_subscription: Option<crate::icon_memory::Subscription>,
    icon_start: Instant,
    icons_presented: bool,
    /// The panel showed its first frame: the layers over it follow on the next turn.
    refresh_pending: bool,
    metrics_commit: u64,
    searches: Option<Sender<String>>,
    inbox: Arc<Mutex<Inbox>>,
    look: Option<Look>,
    tried_look: bool,
    bus: Option<zbus::blocking::Connection>,
    pending: HashMap<TokenRequest, (String, u64)>,
    close: Arc<AtomicBool>,
    closing: bool,
    waker: Option<Waker>,
    a11y: Option<nk_a11y::bridge::Bridge>,
    a11y_requests: Option<Receiver<(u64, nk_a11y::Request)>>,
    revision: u64,
    shape: Vec<(nk_a11y::NodeId, nk_a11y::Role, Vec<nk_a11y::Action>)>,
    ids: HashMap<nk_a11y::NodeId, Key>,
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
        let metrics_id = glib::monotonic_time();
        crate::icon_metrics::emit("apps-open", serde_json::json!({"instance":metrics_id}));
        let all = {
            let _span = crate::icon_metrics::span(
                "apps-stage",
                serde_json::json!({"instance":metrics_id,"stage":"catalogue-sort","count":apps.len()}),
            );
            entries(apps)
        };
        let shown = (0..all.len()).collect();
        Self {
            locale_generation: crate::i18n::generation(),
            metrics_id,
            hub,
            epoch,
            all,
            shown,
            query: String::new(),
            answered: None,
            state: ViewState::new(REGIONS),
            kit: None,
            layout: None,
            layers: None,
            last: nk::Frame::default(),
            pressed: None,
            serial: None,
            outside_press: false,
            dragging: false,
            pointer: (-1., -1.),
            size: (0, 0),
            scale: 1.,
            memory: crate::icon_memory::global(),
            icon_subscription: None,
            icon_start: Instant::now(),
            icons_presented: false,
            refresh_pending: false,
            metrics_commit: 0,
            searches: None,
            inbox: Arc::new(Mutex::new(Inbox::default())),
            look: None,
            tried_look: false,
            bus,
            pending: HashMap::new(),
            close,
            closing: false,
            waker: None,
            a11y: None,
            a11y_requests: None,
            revision: 0,
            shape: vec![],
            ids: HashMap::new(),
        }
    }

    /// The workers: icons and Search, each on its own connection's thread, waking the
    /// layer with what they bring.
    fn start_workers(&mut self, waker: Waker) {
        self.waker = Some(waker.clone());
        let Some(conn) = self.bus.clone() else {
            return;
        };
        if let Some(memory) = &self.memory {
            let w = waker.clone();
            self.icon_subscription = Some(memory.subscribe(move || {
                let _ = w.wake();
            }));
        }
        let (search_tx, search_rx) = channel::<String>();
        let (inbox, epoch) = (self.inbox.clone(), self.epoch);
        let _ = std::thread::Builder::new()
            .name("apps-layer-search".into())
            .spawn(move || search_worker(conn, epoch, search_rx, inbox, waker));
        self.searches = Some(search_tx);
    }

    /// The look and the kit's tokens, type scale, blur and glyphs for the shell's skin
    /// (always dark).
    fn load_look(&mut self) {
        if self.tried_look {
            return;
        }
        self.tried_look = true;
        let Some(bus) = &self.bus else {
            return;
        };
        let _span = crate::icon_metrics::span(
            "apps-stage",
            serde_json::json!({"instance":self.metrics_id,"stage":"look"}),
        );
        let look = match Look::load(bus) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("nidara-shell: Apps has no look: {e}");
                return;
            }
        };
        let skin = nk_platform::portal::Appearance {
            dark: true,
            ..look.appearance.clone()
        };
        let kit = (|| -> Result<Kit, String> {
            Ok(Kit {
                tokens: nk::Tokens::load(&look.exports, &skin)?,
                types: nk::TypeScale::load(&look.exports, &skin)?,
                blur: nk::FrameStyle::load(&look.exports, &skin)?.blur,
                icons: nk_icons::Icons::new("", &[], &crate::paths::icon_reference())
                    .map_err(|e| eprintln!("nidara-shell: Apps has no glyphs: {e}"))
                    .ok(),
            })
        })();
        match kit {
            Ok(k) => {
                self.state.set_reduced_motion(skin.reduced_motion);
                self.kit = Some(k);
            }
            Err(e) => eprintln!("nidara-shell: Apps has no kit tokens: {e}"),
        }
        self.look = Some(look);
    }

    fn style(&self) -> Option<&nk::IconGridStyle> {
        Some(&self.kit.as_ref()?.tokens.icon_grid)
    }

    /// The view: the panel's glass, the grid scrolling to its edges, and the search
    /// floating over its top.
    fn view(&self, l: &PanelLayout, base: &TextStyle) -> Option<Node> {
        let s = self.style()?;
        let look = self.look.as_ref()?;
        let text = |k: &'static str| look.text_of(&Label::Key(k));
        let strut = |k: &str, px: f64| -> Node { nk::Slot::new(k, px).into() };
        let (top, side, bottom) = l.pad;
        let body: Node = if self.shown.is_empty() && self.answered.is_some() {
            nk::Column::new(
                "empty",
                vec![
                    nk::Label::new("empty/text", text("app-grid.no-results"), base.clone())
                        .ink(nk::Ink::Secondary)
                        .into(),
                ],
            )
            .justify(nk::Justify::Center)
            .align(Align::Center)
            .width(l.grid[2])
            .height(l.grid[3])
            .into()
        } else {
            let cells = self
                .shown
                .iter()
                .enumerate()
                .map(|(n, &i)| {
                    let e = &self.all[i];
                    let mut item = nk::IconItem::new(
                        item_key(i),
                        e.name.clone(),
                        format!("{LAUNCH}{i}"),
                        s,
                        base,
                    );
                    if e.is_new {
                        item = item.new_mark("new");
                    }
                    Cell {
                        at: (n % l.columns, n / l.columns),
                        span: (1, 1),
                        child: item.into(),
                    }
                })
                .collect();
            nk::Grid::new("grid", l.columns, s.cell, s.gap, cells)
                .width(l.grid[2])
                .into()
        };
        let content = nk::Column::new(
            "content",
            vec![
                strut("content/top", top),
                nk::Row::new(
                    "content/row",
                    vec![
                        strut("content/left", side),
                        body,
                        strut("content/right", side),
                    ],
                )
                .into(),
                strut("content/bottom", bottom),
            ],
        );
        let list = nk::Scroll::new(LIST, content).floating_top(top);
        let entry: Node = nk::SearchEntry::new(
            SEARCH,
            crate::i18n::text("bar.tooltip.search"),
            QUERY,
            self.query.clone(),
            crate::i18n::text("shell.search.clear"),
        )
        .placeholder(text("app-grid.search.placeholder"))
        .submit(SUBMIT)
        .into();
        let search = nk::Pane::new(
            SEARCH_PANE,
            Corner::Pill,
            nk::Row::new("search/row", vec![entry.grow()])
                .align(Align::Center)
                .padding(Padding::symmetric(Space::S1, Space::S3)),
        )
        .width(l.search[2])
        .height(s.search);
        let over = nk::Column::new(
            "apps/top",
            vec![
                strut("apps/top/inset", s.inset_top),
                nk::Row::new(
                    "apps/top/row",
                    vec![strut("apps/top/left", s.inset_side), search.into()],
                )
                .into(),
            ],
        );
        Some(
            nk::Pane::new(
                PANEL,
                Corner::Fixed(s.panel_corner.round() as u32),
                nk::Overlay::new("apps/over", list).layer(
                    Align::Start,
                    Align::Start,
                    Padding::default(),
                    over,
                ),
            )
            .into(),
        )
    }

    /// Builds the view from the model and lays it out in the panel.
    fn relayout(&mut self) {
        let Some(s) = self.style().cloned() else {
            return;
        };
        if self.size.0 == 0 {
            return;
        }
        let l = nk::panel_layout(&s, (f64::from(self.size.0), f64::from(self.size.1)));
        self.layout = Some(l);
        let Some(base) = self.look.as_ref().map(|look| look.styles.text.clone()) else {
            return;
        };
        let Some(view) = self.view(&l, &base) else {
            return;
        };
        let (Some(kit), Some(look)) = (self.kit.as_ref(), self.look.as_mut()) else {
            return;
        };
        self.state.layout_in(
            &view,
            l.panel,
            self.scale,
            kit.tokens.with_types(&kit.types),
            &mut look.text,
            Instant::now(),
        );
    }

    /// Back to the top of the list: a new list starts at its first row.
    fn scroll_home(&mut self) {
        self.state
            .scroll_region(&LIST.into(), nk::ScrollBy::Pixels(-1e9));
    }

    /// The query changed: the A–Z list for an empty one, else ask Search (the shown list
    /// keeps the last answer until the new one comes).
    fn requery(&mut self) {
        let q = self.query.trim().to_string();
        if q.is_empty() {
            self.answered = None;
            self.shown = (0..self.all.len()).collect();
        } else if let Some(s) = &self.searches {
            let _ = s.send(q);
            return self.relayout();
        } else {
            // No service to rank with: a plain substring filter, A–Z.
            self.shown = self.filtered(&q);
            self.answered = Some(q);
        }
        self.relayout();
        self.scroll_home();
    }

    fn filtered(&self, q: &str) -> Vec<usize> {
        let lower = q.to_lowercase();
        (0..self.all.len())
            .filter(|&i| self.all[i].name.to_lowercase().contains(&lower))
            .collect()
    }

    fn drain(&mut self) -> bool {
        let inbox = std::mem::take(&mut *self.inbox.lock().unwrap());
        // Only the answer to the query typed now counts.
        let now = self.query.trim().to_string();
        let mut changed = false;
        for (q, result) in inbox.results {
            if q != now {
                continue;
            }
            self.shown = match result {
                Ok(ids) => {
                    let index: HashMap<&str, usize> = self
                        .all
                        .iter()
                        .enumerate()
                        .map(|(i, e)| (e.id.as_str(), i))
                        .collect();
                    ids.iter()
                        .filter_map(|id| index.get(id.as_str()).copied())
                        .collect()
                }
                Err(e) => {
                    eprintln!("nidara-shell: Apps search failed: {e}");
                    self.filtered(&q)
                }
            };
            self.answered = Some(q);
            changed = true;
        }
        if changed {
            self.relayout();
            self.scroll_home();
        }
        changed
    }

    /// The icon slots laid out: each with its app (its place in `all`).
    fn slots(&self) -> Vec<(&nk::Placed, usize)> {
        self.state
            .placed()
            .iter()
            .filter(|p| p.key.0.ends_with("/icon"))
            .filter_map(|p| Some((p, item_index(&p.key.0)?)))
            .collect()
    }

    /// Ask for the icons of the tiles in view (and a row either side).
    fn want_icons(&mut self) {
        let (Some(memory), Some(l), Some(s)) = (&self.memory, self.layout, self.style()) else {
            return;
        };
        let reach = s.cell + s.gap;
        let (top, bottom) = (l.panel[1] - reach, l.panel[1] + l.panel[3] + reach);
        for (p, i) in self.slots() {
            if p.rect[1] + p.rect[3] < top || p.rect[1] > bottom {
                continue;
            }
            if let Some(key) = memory.current_app(&self.all[i].id, s.icon as u32, self.scale) {
                memory.request(key);
            }
        }
    }

    fn icon_side(&self) -> f64 {
        self.style().map_or(64., |s| s.icon)
    }

    fn asset(&self, e: &Entry) -> Option<Arc<crate::icon_memory::Asset>> {
        let memory = self.memory.as_ref()?;
        let key = memory.current_app(&e.id, self.icon_side() as u32, self.scale)?;
        memory.get(&key)
    }

    fn waiting_for_icons(&self) -> bool {
        if !holds(self.icons_presented, self.icon_start.elapsed()) {
            return false;
        }
        let Some(memory) = &self.memory else {
            return false;
        };
        let side = self.icon_side() as u32;
        let keys: Vec<_> = self
            .slots()
            .into_iter()
            .filter(|(p, _)| p.visible().is_some())
            .filter_map(|(_, i)| memory.current_app(&self.all[i].id, side, self.scale))
            .collect();
        !memory.readiness(&keys).complete()
    }

    fn finish(&mut self, w: &mut Window) {
        if !self.closing {
            self.closing = true;
            self.close.store(true, Ordering::SeqCst);
            w.close();
        }
    }

    /// Launch app `i` (its place in the whole list) with a token from `serial`'s input,
    /// then close.
    fn launch(&mut self, i: usize, serial: Option<u32>, w: &mut Window) {
        let Some(e) = self.all.get(i).cloned() else {
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
    fn start_drag(&mut self, i: usize, serial: u32, w: &mut Window) {
        let Some(e) = self.all.get(i).cloned() else {
            return;
        };
        let data = drag::encode(&drag::App {
            id: e.id.clone(),
            generation: e.generation,
        });
        let side = self.icon_side() as u32;
        let icon = self.asset(&e).map(|asset| drag_icon(&asset.raw, side));
        match w.start_drag(serial, vec![(drag::APP_MIME.to_string(), data)], icon) {
            Ok(()) => {
                self.dragging = true;
                self.pressed = None;
                self.state.pointer_leave();
                // Nothing of the panel takes input while the drag lasts.
                let _ = w.set_input_region(Some(&[]));
                self.refresh(w);
            }
            Err(e) => eprintln!("nidara-shell: Apps could not start a drag: {e:?}"),
        }
    }

    /// What an activation of the view asks for.
    fn route(&mut self, a: Activated, w: &mut Window) {
        match a.action.as_str() {
            QUERY => {
                if let Some(nk::Value::Text(t)) = a.value {
                    self.query = t;
                    self.requery();
                }
            }
            SUBMIT => {
                if !self.query.trim().is_empty()
                    && let Some(&i) = self.shown.first()
                {
                    self.launch(i, self.serial, w);
                }
            }
            action => {
                if let Some(i) = action.strip_prefix(LAUNCH).and_then(|i| i.parse().ok()) {
                    self.launch(i, self.serial, w);
                }
            }
        }
    }

    /// The shown position of the focused tile, if a tile has the focus.
    fn focused_tile(&self) -> Option<usize> {
        let i = item_index(&self.state.focus()?.0)?;
        self.shown.iter().position(|&s| s == i)
    }

    /// Moves the keyboard to shown tile `n` (clamped), and brings it into view.
    fn focus_tile(&mut self, n: usize) {
        if let Some(&i) = self.shown.get(n.min(self.shown.len().saturating_sub(1))) {
            self.state.request(&item_key(i).into(), false);
        }
    }

    fn key(&mut self, key: nk_wayland::Key, w: &mut Window) {
        if key.serial.is_some() {
            self.serial = key.serial;
        }
        let columns = self.layout.map_or(1, |l| l.columns);
        let on_search = self.state.focus().is_some_and(|k| k.0 == SEARCH);
        let tile = self.focused_tile();
        match (key.sym, tile) {
            // The grid's arrows: across and down its rows; Down leaves the search for the
            // first tile and Up from the first row comes back to it.
            (DOWN, None) if on_search && !self.shown.is_empty() => self.focus_tile(0),
            (LEFT, Some(n)) => self.focus_tile(n.saturating_sub(1)),
            (RIGHT, Some(n)) => self.focus_tile(n + 1),
            (UP, Some(n)) if n < columns => {
                self.state.request(&SEARCH.into(), false);
            }
            (UP, Some(n)) => self.focus_tile(n - columns),
            (DOWN, Some(n)) => self.focus_tile(n + columns),
            (ESCAPE, _) if self.query.is_empty() => {
                self.finish(w);
                return;
            }
            // Escape on a tile: back to the search, where Escape then clears it.
            (ESCAPE, Some(_)) => {
                self.state.request(&SEARCH.into(), false);
            }
            _ => {
                // Typing on a tile goes to the search.
                if !on_search && !key.ctrl && !key.alt && !key.text.is_empty() {
                    self.state.request(&SEARCH.into(), false);
                }
                let (_, activated) = self.state.key_event(&key);
                if let Some(a) = activated {
                    self.route(a, w);
                }
            }
        }
        if !self.closing {
            w.set_text_input(self.state.text_input());
            self.refresh(w);
        }
    }

    /// A pointer event on the search's layer, in the panel's coordinates.
    fn search_event(&mut self, event: LayerEvent, w: &mut Window) {
        let Some(r) = self.state.lifted_rect() else {
            return;
        };
        match event {
            LayerEvent::Motion(x, y) => {
                self.pointer = (x + r[0], y + r[1]);
                self.state.pointer_motion(x + r[0], y + r[1]);
            }
            LayerEvent::Leave => {
                self.state.pointer_leave();
            }
            LayerEvent::Button {
                button: LEFT_BUTTON,
                pressed,
                serial,
                ..
            } => {
                self.serial = Some(serial);
                if let Some(a) = self.state.button(pressed, Instant::now()) {
                    self.route(a, w);
                }
                if self.closing {
                    return;
                }
                w.set_text_input(self.state.text_input());
            }
            // The rows scroll under the search, so the wheel over it scrolls them.
            LayerEvent::Scroll(amount) => {
                self.state.scroll(amount.into());
                self.want_icons();
            }
            _ => return,
        }
        self.refresh(w);
    }

    /// The frame for this turn, its search taken out onto its layer and the blur placed
    /// under it; then a paint.
    fn refresh(&mut self, w: &mut Window) {
        if self.closing {
            return;
        }
        if let Some(kit) = &self.kit {
            self.last = self.state.frame(&kit.tokens, Instant::now());
        }
        if let Err(e) = self.sync_layers(w) {
            eprintln!("nidara-shell: Apps cannot place its search: {e}");
        }
        w.redraw();
    }

    fn sync_layers(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        let (Some(layers), Some(l), Some(kit)) = (self.layers, self.layout, self.kit.as_mut())
        else {
            return Ok(());
        };
        let s = &kit.tokens.icon_grid;
        let hidden = self.dragging || !self.icons_presented;
        // The blur: across the panel inside its corners (the grid never reaches them), from
        // its top edge to the search's bottom, strongest at the top.
        let blur = [
            l.panel[0] + s.panel_corner,
            l.panel[1],
            (l.panel[2] - 2. * s.panel_corner).max(1.),
            l.search[1] + l.search[3] - l.panel[1],
        ];
        let size = if hidden {
            (1, 1)
        } else {
            (blur[2].ceil() as u32, blur[3].ceil() as u32)
        };
        w.set_position(layers.blur, blur[0], blur[1])?;
        w.set_layer_size(layers.blur, size)?;
        w.set_layer_blur(
            layers.blur,
            kit.blur,
            &nk::graded_panes(
                &s.blur_curve,
                f64::from(size.0),
                f64::from(size.1),
                self.scale,
            ),
        )?;
        w.paint_layer(layers.blur, |frame| {
            Ok(Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale).finish())
        })?;
        let lifted = self.state.lift_out(&mut self.last);
        let (Some(r), Some(f), false) = (self.state.lifted_rect(), lifted, hidden) else {
            w.set_layer_material(layers.search, None)?;
            w.set_layer_input_region(layers.search, Some(&[]))?;
            w.set_layer_size(layers.search, (1, 1))?;
            w.paint_layer(layers.search, |frame| {
                Ok(Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale).finish())
            })?;
            return Ok(());
        };
        w.set_position(layers.search, r[0], r[1])?;
        w.set_layer_size(layers.search, (r[2].max(1.) as u32, r[3].max(1.) as u32))?;
        w.set_layer_input_region(layers.search, None)?;
        w.set_layer_material(layers.search, glass(self.look.as_ref(), &f).as_ref())?;
        let (state, look, icons) = (
            &self.state,
            kit.tokens.with_types(&kit.types),
            &mut kit.icons,
        );
        w.paint_layer(layers.search, |frame| {
            let mut c = Canvas::at(
                frame.pixel_width,
                frame.pixel_height,
                frame.scale,
                (r[0], r[1]),
            );
            state.paint_lifted(&mut c, look, &mut |n, size| glyph(icons, n, size))?;
            Ok(c.finish())
        })?;
        Ok(())
    }

    /// Advances the kit's motion (scrolling, the bar's fade): another frame while it moves.
    fn tick(&mut self, w: &mut Window) {
        if !self.state.animating() {
            return;
        }
        let (Some(kit), Some(look)) = (self.kit.as_ref(), self.look.as_mut()) else {
            return;
        };
        let t = self.state.tick(
            kit.tokens.with_types(&kit.types),
            &mut look.text,
            Instant::now(),
        );
        for a in t.activated {
            self.route(a, w);
        }
        self.want_icons();
        self.refresh(w);
    }

    fn publish_semantics(&mut self) {
        let mut root = nk_a11y::Node::new(
            ROOT,
            nk_a11y::Role::Window,
            crate::i18n::text("settings.apps.section"),
        );
        root.states.active = true;
        let tree = self.state.semantics(root, ROOT + 1);
        self.ids = self.state.semantic_keys();
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
            let activated = match request {
                nk_a11y::Request::SetText(id, text) => self.ids.get(&id).cloned().and_then(|k| {
                    self.state
                        .respond(&k, nk::components::Request::SetText(text))
                }),
                nk_a11y::Request::Activate(id) => {
                    let k = self.ids.get(&id).cloned();
                    k.and_then(|k| self.state.request(&k, true))
                }
                nk_a11y::Request::Focus(id) => {
                    let k = self.ids.get(&id).cloned();
                    k.and_then(|k| self.state.request(&k, false))
                }
                _ => None,
            };
            if let Some(a) = activated {
                // No input event behind it, so no activation token.
                self.serial = None;
                self.route(a, w);
                if self.closing {
                    return;
                }
            }
            w.set_text_input(self.state.text_input());
            self.refresh(w);
        }
    }
}

const ROOT: nk_a11y::NodeId = 1;

/// A themed glyph for the kit (the search's), by name and logical size.
fn glyph(
    icons: &mut Option<nk_icons::Icons>,
    name: &str,
    size: f64,
) -> Option<Arc<nk_icons::Icon>> {
    if name.is_empty() {
        return None;
    }
    icons.as_mut()?.get(name, size.round() as u32).ok()
}

/// The panel glass for a frame's panes, each pane's tone and shadow for its size.
fn glass(look: Option<&Look>, frame: &nk::Frame) -> Option<Material> {
    let panel = look?.panel.as_ref()?;
    let base = panel.at(0.).ok()?;
    let groups = frame
        .groups(base.tone, base.shadow)
        .into_iter()
        .map(|mut g| {
            let side = g
                .shapes
                .iter()
                .map(|s| s.width.min(s.height))
                .fold(f64::INFINITY, f64::min);
            if let Ok(m) = panel.at(side) {
                g.tone = m.tone;
                g.shadow = m.shadow;
            }
            g
        })
        .collect();
    Some(Material {
        groups,
        states: frame.states.clone(),
        ..base
    })
}

/// Whether the first frame may still wait for icons, `elapsed` after Apps was asked for.
fn holds(presented: bool, elapsed: Duration) -> bool {
    !presented && elapsed < ICON_WAIT
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
/// `side` logical with the pointer at its centre.
fn drag_icon(icon: &Icon, side: u32) -> DragIcon {
    let mut pixels = Vec::with_capacity(icon.rgba.len());
    for p in icon.rgba.as_chunks::<4>().0 {
        let a = u16::from(p[3]);
        let pm = |c: u8| ((u16::from(c) * a + 127) / 255) as u8;
        pixels.extend_from_slice(&[pm(p[2]), pm(p[1]), pm(p[0]), p[3]]);
    }
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
    fn poll_interval_ms(&self) -> u32 {
        if !self.icons_presented {
            return ICON_WAIT
                .saturating_sub(self.icon_start.elapsed())
                .as_millis()
                .clamp(1, 1000) as u32;
        }
        if self.state.animating() {
            return 16;
        }
        1000
    }
    fn idle(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        if !self.icons_presented && !self.waiting_for_icons() {
            w.redraw();
        }
        let generation = crate::i18n::generation();
        if std::mem::take(&mut self.refresh_pending) || self.locale_generation != generation {
            self.locale_generation = generation;
            self.refresh(w);
        }
        self.tick(w);
        Ok(())
    }
    fn event(&mut self, event: Event, w: &mut Window) -> nk_wayland::Result<()> {
        if matches!(event, Event::FrameDone) {
            let commit = self.metrics_commit;
            crate::icon_metrics::emit(
                "frame-done",
                serde_json::json!({"surface":"apps","instance":self.metrics_id,"commit":commit}),
            );
            self.tick(w);
        }
        if std::mem::take(&mut self.refresh_pending) {
            self.refresh(w);
        }
        if self.close.load(Ordering::SeqCst) && !self.closing {
            self.finish(w);
            return Ok(());
        }
        // The pointer alone changes nothing a reader is told.
        let quiet = matches!(
            event,
            Event::Motion(..) | Event::PointerLeave | Event::FrameDone
        );
        match event {
            Event::Configure => {
                let _span = crate::icon_metrics::span(
                    "apps-stage",
                    serde_json::json!({"instance":self.metrics_id,"stage":"configure"}),
                );
                self.size = w.size();
                self.scale = w.scale();
                self.load_look();
                if self.layers.is_none() && w.supports_layers() {
                    // The blur first, so the search's glass lies over it. It takes no pointer.
                    let blur = w.create_layer((1, 1))?;
                    w.set_layer_input_region(blur, Some(&[]))?;
                    let search = w.create_layer((1, 1))?;
                    w.set_layer_input_region(search, Some(&[]))?;
                    self.layers = Some(Layers { blur, search });
                    // Only with a layer to draw it on: without (D5) the panel paints it.
                    self.state.lift(Some(SEARCH_PANE.into()));
                }
                let first = self.layout.is_none();
                self.relayout();
                if first && self.layout.is_some() {
                    // Typing goes to the search from the start; no ring until the keys move.
                    self.state.request(&SEARCH.into(), false);
                    self.state.hide_ring();
                }
                w.set_text_input(self.state.text_input());
                self.want_icons();
                self.refresh(w);
            }
            Event::Wake => {
                let _span = crate::icon_metrics::span(
                    "apps-stage",
                    serde_json::json!({"instance":self.metrics_id,"stage":"wake"}),
                );
                self.a11y(w);
                if self.closing {
                    return Ok(());
                }
                self.drain();
                self.want_icons();
                self.refresh(w);
            }
            Event::Closed => self.finish(w),
            Event::Layer { id, event } if self.layers.is_some_and(|l| l.search == id) => {
                if !self.dragging {
                    self.search_event(event, w);
                }
            }
            Event::Motion(x, y) => {
                self.pointer = (x, y);
                if let Some((i, at, serial)) = self.pressed
                    && !self.dragging
                    && ((x - at.0).powi(2) + (y - at.1).powi(2)).sqrt() > DRAG_SLOP
                {
                    self.start_drag(i, serial, w);
                    return Ok(());
                }
                if !self.dragging && self.state.pointer_motion(x, y) {
                    self.refresh(w);
                }
            }
            Event::PointerLeave => {
                if self.state.pointer_leave() {
                    self.refresh(w);
                }
            }
            Event::Button {
                button: LEFT_BUTTON,
                pressed: true,
                serial,
                ..
            } if !self.dragging => {
                self.serial = Some(serial);
                let panel = self.layout.map_or([0.; 4], |l| l.panel);
                self.outside_press = !inside(panel, self.pointer);
                self.pressed = self
                    .state
                    .hover()
                    .and_then(|k| item_index(&k.0))
                    .map(|i| (i, self.pointer, serial));
                if let Some(a) = self.state.button(true, Instant::now()) {
                    self.route(a, w);
                }
                if !self.closing {
                    w.set_text_input(self.state.text_input());
                    self.refresh(w);
                }
            }
            Event::Button {
                button: LEFT_BUTTON,
                pressed: false,
                serial,
                ..
            } if !self.dragging => {
                self.serial = Some(serial);
                self.pressed = None;
                let panel = self.layout.map_or([0.; 4], |l| l.panel);
                if self.outside_press && !inside(panel, self.pointer) {
                    self.finish(w);
                    return Ok(());
                }
                self.outside_press = false;
                if let Some(a) = self.state.button(false, Instant::now()) {
                    self.route(a, w);
                }
                if !self.closing {
                    w.set_text_input(self.state.text_input());
                    self.refresh(w);
                }
            }
            Event::Scroll(amount) if !self.dragging => {
                self.state.scroll(amount.into());
                self.want_icons();
                self.refresh(w);
            }
            Event::Key(key) if !self.dragging => self.key(key, w),
            Event::Ime(batch) if !self.dragging => {
                if let Some(a) = self.state.ime(&batch) {
                    self.route(a, w);
                }
                if !self.closing {
                    w.set_text_input(self.state.text_input());
                    self.refresh(w);
                }
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
        let _span = crate::icon_metrics::span(
            "apps-stage",
            serde_json::json!({"instance":self.metrics_id,"stage":"paint","held":self.waiting_for_icons()}),
        );
        let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
        if self.dragging
            || self.closing
            || self.look.is_none()
            || self.kit.is_none()
            || self.waiting_for_icons()
        {
            return Ok(c.finish());
        }
        let first = !self.icons_presented;
        self.icons_presented = true;
        let accent = self.look.as_ref().map(|l| l.style.row.accent);
        let Some(kit) = self.kit.as_mut() else {
            return Ok(c.finish());
        };
        let look = kit.tokens.with_types(&kit.types);
        // Without the compositor's glass (another compositor), the kit paints the panel's
        // washes and an opaque base from the same frame (D5).
        let fallback = (!f.material).then_some(&self.last);
        let icons = &mut kit.icons;
        self.state
            .paint(&mut c, look, &mut |n, size| glyph(icons, n, size), fallback)?;
        // The app icons and the "new" dots, in their slots, faded and cut as their tiles.
        let rect = |r: [f64; 4]| Rect {
            x: r[0] as f32,
            y: r[1] as f32,
            width: r[2] as f32,
            height: r[3] as f32,
        };
        for p in self.state.placed() {
            let Some(visible) = p.visible() else {
                continue;
            };
            let Some(i) = item_index(&p.key.0) else {
                continue;
            };
            let slot = p.key.0.rsplit('/').next().unwrap_or("");
            if !matches!(slot, "icon" | "new") || p.alpha <= 0. {
                continue;
            }
            let fading = p.alpha < 1.;
            if fading {
                c.push_opacity(p.alpha);
            }
            c.clip(rect(visible));
            if slot == "icon" {
                let asset = self
                    .asset(&self.all[i])
                    .unwrap_or_else(crate::icon_memory::generic);
                c.image(&asset.raster, rect(p.rect), ImageFit::Contain);
            } else if let Some(accent) = accent {
                c.rounded_rect(rect(p.rect), p.rect[2] / 2., accent);
            }
            c.pop_clip();
            if fading {
                c.pop_opacity();
            }
        }
        if first {
            // The search's layer waited for the panel's first frame, so both show together.
            self.refresh_pending = true;
        }
        Ok(c.finish())
    }

    fn committed(&mut self, commit: u64) {
        self.metrics_commit = commit;
        if !crate::icon_metrics::enabled() || self.look.is_none() || self.closing {
            return;
        }
        let mut ready = 0;
        let mut wanted = 0;
        let mut rectangles = Vec::new();
        for (p, i) in self.slots() {
            if p.visible().is_none() {
                continue;
            }
            rectangles.push(p.rect);
            wanted += 1;
            ready += usize::from(self.asset(&self.all[i]).is_some());
        }
        crate::icon_metrics::emit(
            "frame",
            serde_json::json!({"surface":"apps","visible":self.icons_presented,"instance":self.metrics_id,"commit":commit,"ready":ready,"wanted":wanted,"rectangles":rectangles,"size":self.size}),
        );
    }

    fn material(&self) -> Option<Material> {
        // Match the buffer we painted, even if a worker completes meanwhile.
        if !self.icons_presented || self.dragging || self.closing || self.size.0 == 0 {
            return None;
        }
        glass(self.look.as_ref(), &self.last)
    }
}

/// One Apps layer's whole life on its own thread: on the output the compositor chooses
/// (the one in use), over everything, with the keyboard.
pub fn run(mut launcher: Launcher, wake: (Waker, WakeSource)) -> nk_wayland::Result<()> {
    {
        let _span = crate::icon_metrics::span(
            "apps-stage",
            serde_json::json!({"instance":launcher.metrics_id,"stage":"workers"}),
        );
        launcher.start_workers(wake.0);
    }
    crate::icon_metrics::emit(
        "apps-layer-start",
        serde_json::json!({"instance":launcher.metrics_id}),
    );
    nk_wayland::run_layer(
        launcher,
        Options {
            material: true,
            map: true,
            app_id: NAMESPACE,
            title: &crate::i18n::text("settings.apps.section"),
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
    fn the_first_frame_waits_for_icons_only_briefly() {
        assert!(holds(false, Duration::from_millis(100)));
        assert!(!holds(false, Duration::from_millis(300)));
        assert!(!holds(true, Duration::ZERO));
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
    fn a_tile_key_names_its_app_and_its_parts() {
        assert_eq!(item_index(&item_key(12)), Some(12));
        assert_eq!(item_index("a:12/icon"), Some(12));
        assert_eq!(item_index(SEARCH), None);
    }

    #[test]
    fn a_dragged_icon_is_premultiplied_bgra() {
        let i = drag_icon(
            &Icon {
                width: 1,
                height: 1,
                rgba: vec![255, 0, 0, 128],
            },
            64,
        );
        assert_eq!(i.pixels, [0, 0, 128, 128]);
        assert_eq!(i.hotspot, (32, 32));
    }
}
