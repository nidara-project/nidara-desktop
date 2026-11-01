// SPDX-License-Identifier: LGPL-3.0-or-later
//! One output's dock (DOCK.md §2): a layer root on that output's own connection. It reads
//! the hub's latest frame on `Event::Wake`, lays out, paints icons/dots/separators (the
//! glass is Hyalo's), and sends what a click asks for back to the hub. It never calls a
//! service from its own loop.
use crate::actions::{Action, primary};
use crate::apps::{TRASH_EMPTY, TRASH_FULL};
use crate::chooser::{Candidate, Chooser};
use crate::geometry::{CAPSULE_EXPONENT, DOT, Layout, PAD_RATIO, Position, Slot, layout};
use crate::hub::{Frame, Request};
use crate::menu::Command;
use crate::model::{Item, Kind, View};
use crate::popup::{Look, Outcome, Overlay, Popup};
use nk_render::{Canvas, ImageFit, Raster, rgba};
use nk_text::{Rect, TextBackend};
use nk_wayland::{
    Application, Edges, Event, KeyboardMode, LayerLevel, LayerOutput, LayerPlacement, LayerSpec,
    Material, Options, Pane, PopupSide, TokenRequest, WakeSource, Waker, Window,
};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, TryRecvError};
use std::time::Instant;

pub const NAMESPACE: &str = "nidara-dock";
const LEFT_BUTTON: u32 = 0x110;
/// Between the capsule and a popup it opens, logical pixels.
const POPUP_GAP: i32 = 6;
const RIGHT_BUTTON: u32 = 0x111;
const MIDDLE_BUTTON: u32 = 0x112;

pub struct Dock {
    frames: Receiver<Arc<Frame>>,
    hub: Sender<Request>,
    output_name: String,
    /// The output's logical size, as the supervisor last saw it.
    output_size: (u32, u32),
    frame: Arc<Frame>,
    layout: Layout,
    pointer: (f64, f64),
    pressed: Option<usize>,
    /// The middle button's press, released on the same slot to act.
    middle: Option<usize>,
    /// The wheel's walk through an app's windows (cycle.rs).
    cycle: crate::cycle::Cycle,
    /// Token requests in flight, and what each will start once it has its token.
    pending: HashMap<TokenRequest, Request>,
    trash_icon: Option<Arc<nk_icons::Icon>>,
    /// The minimized windows' pictures this dock shows (thumbs.rs).
    thumbs: crate::thumbs::Thumbs,
    published: BTreeMap<u64, [f64; 4]>,
    /// The last keyboard-focus request taken, and the item holding the focus while the dock
    /// has the keyboard (by key: items move between frames).
    keyboard_seen: u64,
    focus: Option<String>,
    /// The focused window when the dock took the keyboard: once another window is focused
    /// (a click on it), the dock lets go, since an exclusive layer keeps the keys otherwise.
    focus_window: Option<u64>,
    /// The screen reader's view (DOCK.md §7), published after every change it can see.
    a11y: Option<nk_a11y::bridge::Bridge>,
    a11y_requests: Option<Receiver<(u64, nk_a11y::Request)>>,
    ids: crate::semantics::Ids,
    revision: u64,
    /// What a request is checked against: every node with its role and actions. The
    /// revision moves only when this does (a popup opened or closed, items came or went),
    /// not on every repaint, so an action a reader took is not lost to a frame drawn after.
    shape: Vec<(nk_a11y::NodeId, nk_a11y::Role, Vec<nk_a11y::Action>)>,
    waker: Waker,
    /// The one popup (a menu), and what draws it: loaded with the first one.
    popup: Option<Overlay>,
    look: Option<Look>,
    /// Popups opened so far: each takes its own semantic ID range.
    popups: u64,
    /// A press that closed the popup is consumed, its release too: never replayed.
    swallow: bool,
    /// The attention bounce of each slot (attention.rs).
    attention: crate::attention::Attention,
    /// The look was asked for once for a count's text, whether or not it came.
    look_tried: bool,
}

/// A window picture's longest side, in pixels: sharp in a 128 px slot (64 px icons at
/// scale 2), and 256 KiB at most each.
pub const THUMB_SIDE: u32 = 256;
/// The app's icon on a minimized window's picture, as a share of the slot (DockIcon.ts).
const BADGE: f64 = 0.45;
/// How far attention lifts an icon, as a share of the capsule's padding: the icon and its
/// count stay inside the capsule, so the surface never grows for it.
const LIFT: f64 = 0.5;
/// A count's pill, as a share of the icon: its height, and how far it sits out of the
/// icon's top-right corner.
const COUNT: f64 = 0.36;
const COUNT_OUT: f64 = 0.25;

fn slots(view: &View) -> Vec<Slot> {
    view.items
        .iter()
        .map(|i| {
            if i.kind == Kind::Separator {
                Slot::Separator
            } else {
                Slot::Icon
            }
        })
        .collect()
}

/// The keyboard is the dock's only while it holds the roving focus (Shell1 `focus:dock`);
/// a click never takes it from the app.
pub fn placement(l: &Layout, keyboard: bool) -> LayerPlacement {
    let gap = crate::geometry::SCREEN_GAP as i32;
    let (anchor, margin) = match l.position {
        Position::Bottom => (Edges::BOTTOM, [0, 0, gap, 0]),
        Position::Left => (Edges::LEFT, [0, 0, 0, gap]),
        Position::Right => (Edges::RIGHT, [0, gap, 0, 0]),
    };
    LayerPlacement {
        anchor,
        size: l.size,
        exclusive_zone: l.exclusive_zone,
        margin,
        keyboard: if keyboard {
            KeyboardMode::Exclusive
        } else {
            KeyboardMode::None
        },
    }
}

impl Dock {
    pub fn new(
        frames: Receiver<Arc<Frame>>,
        hub: Sender<Request>,
        output_name: String,
        output_size: (u32, u32),
        frame: Arc<Frame>,
        trash_icon: Option<Arc<nk_icons::Icon>>,
        waker: Waker,
    ) -> Self {
        let layout = Self::lay(&frame, output_size);
        Self {
            frames,
            hub,
            output_name,
            output_size,
            frame,
            layout,
            pointer: (0., 0.),
            pressed: None,
            middle: None,
            cycle: Default::default(),
            pending: HashMap::new(),
            trash_icon,
            thumbs: Default::default(),
            published: BTreeMap::new(),
            keyboard_seen: 0,
            focus: None,
            focus_window: None,
            a11y: None,
            a11y_requests: None,
            ids: Default::default(),
            revision: 0,
            shape: vec![],
            waker,
            popup: None,
            look: None,
            popups: 0,
            swallow: false,
            attention: Default::default(),
            look_tried: false,
        }
    }

    fn lay(frame: &Frame, output: (u32, u32)) -> Layout {
        let reserved = if frame.prefs.position.horizontal() {
            0.
        } else {
            frame.reserved_top
        };
        layout(
            &slots(&frame.view),
            frame.prefs.icon_size,
            frame.prefs.position,
            output,
            reserved,
        )
    }

    /// The latest frame wins; a closed channel ends the dock.
    fn drain(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        let mut latest = None;
        loop {
            match self.frames.try_recv() {
                Ok(f) => latest = Some(f),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    w.close();
                    return Ok(());
                }
            }
        }
        let Some(frame) = latest else { return Ok(()) };
        if let Some(size) = frame.output_sizes.get(&self.output_name) {
            self.output_size = *size;
        }
        let had_keyboard = self.focus.is_some();
        if frame.keyboard > self.keyboard_seen {
            self.keyboard_seen = frame.keyboard;
            self.focus_window = frame.focused;
            self.focus =
                crate::keys::first(&frame.view.items).map(|n| frame.view.items[n].key.clone());
            eprintln!(
                "nidara-shell: the dock on {} takes the keyboard",
                self.output_name
            );
        }
        self.frame = frame;
        self.attention
            .update(&self.frame.view.items, Instant::now());
        if !self.look_tried
            && self.look.is_none()
            && self
                .frame
                .view
                .items
                .iter()
                .any(|i| i.signal.count.is_some())
        {
            // A count's figure is text: the menus' look carries the fonts.
            self.look_tried = true;
            match zbus::blocking::Connection::session()
                .map_err(|e| e.to_string())
                .and_then(|bus| Look::load(&bus))
            {
                Ok(look) => self.look = Some(look),
                Err(e) => eprintln!("nidara-shell: counts without figures: {e}"),
            }
        }
        if self.focus.is_some()
            && (self.frame.hidden
                || self.focused_slot().is_none()
                || self.frame.focused != self.focus_window)
        {
            eprintln!(
                "nidara-shell: the dock on {} lets the keyboard go",
                self.output_name
            );
            self.focus = None;
        }
        let next = Self::lay(&self.frame, self.output_size);
        let keyboard = self.focus.is_some();
        if placement(&next, keyboard) != placement(&self.layout, had_keyboard) {
            w.set_layer_placement(placement(&next, keyboard))?;
        }
        self.layout = next;
        self.follow_popup(w);
        self.capture(w);
        self.apply(w)
    }

    /// The popup follows its item to wherever it is now, or closes with it (gone, hidden).
    fn follow_popup(&mut self, w: &mut Window) {
        let Some(popup) = &self.popup else { return };
        let at = match popup.anchor() {
            Some(key) => self.frame.view.items.iter().position(|i| &i.key == key),
            None => None,
        };
        if self.frame.hidden || (popup.anchor().is_some() && at.is_none()) {
            self.close_popup(w);
            return;
        }
        // The chooser keeps only windows still there; under two, it has nothing to choose.
        if let (Some(Overlay::Chooser(c)), Some(n)) = (self.popup.as_mut(), at)
            && !c.retain(&self.frame.view.items[n].windows)
        {
            self.close_popup(w);
            return;
        }
        if let Some(n) = at {
            let (rect, side) = (self.anchor_rect(n), self.side());
            let popup = self.popup.as_mut().unwrap();
            if let Err(e) = popup.follow(w, rect, side) {
                eprintln!("nidara-shell: the menu cannot follow its item ({e}); closing it");
                self.close_popup(w);
            }
        }
    }

    fn side(&self) -> PopupSide {
        match self.layout.position {
            Position::Bottom => PopupSide::AboveCentered,
            Position::Left => PopupSide::RightCentered,
            Position::Right => PopupSide::LeftCentered,
        }
    }

    /// Slot `n`'s place along the dock, across the whole capsule and a gap beyond it, so a
    /// popup opens clear of the capsule rather than over its edge.
    fn anchor_rect(&self, n: usize) -> [i32; 4] {
        let [x, y, w, h] = self.layout.rects[n];
        let (sw, sh) = (self.layout.size.0 as i32, self.layout.size.1 as i32);
        let g = POPUP_GAP;
        match self.layout.position {
            Position::Bottom => [x.floor() as i32, -g, (w.ceil() as i32).max(1), sh + 2 * g],
            Position::Left | Position::Right => {
                [-g, y.floor() as i32, sw + 2 * g, (h.ceil() as i32).max(1)]
            }
        }
    }

    fn close_popup(&mut self, w: &mut Window) {
        if let Some(p) = self.popup.take() {
            p.close(w);
            self.publish_semantics(w);
        }
    }

    /// The menu of slot `n`, or the dock's own (None: the separator or empty space).
    fn open_menu(
        &mut self,
        w: &mut Window,
        slot: Option<usize>,
        serial: Option<u32>,
        keyboard: bool,
    ) {
        self.close_popup(w);
        if self.look.is_none() {
            let look = zbus::blocking::Connection::session()
                .map_err(|e| e.to_string())
                .and_then(|bus| Look::load(&bus));
            match look {
                Ok(l) => self.look = Some(l),
                Err(e) => {
                    eprintln!("nidara-shell: no menus: {e}");
                    return;
                }
            }
        }
        let item = slot
            .map(|n| &self.frame.view.items[n])
            .filter(|i| i.kind != Kind::Separator);
        let rows = match item {
            Some(item) => {
                let app = match &item.kind {
                    Kind::App { id, .. } => self.frame.catalogue.get(id),
                    _ => None,
                };
                crate::menu::item_menu(
                    item,
                    &crate::menu::Context {
                        app,
                        titles: &self.frame.titles,
                        can_launch: self.frame.can_launch,
                        can_edit_layout: self.frame.can_edit_layout,
                        can_autostart: self.frame.can_autostart,
                        can_open_directory: self.frame.can_open_directory,
                        can_empty_trash: self.frame.trash.is_some_and(|t| !t.partial),
                        trash_full: self.frame.trash.is_some_and(|t| t.full),
                    },
                )
            }
            None => crate::menu::dock_menu(&self.frame.prefs, self.frame.can_settings),
        };
        if rows.is_empty() {
            return;
        }
        let rect = match (item, slot) {
            (Some(_), Some(n)) => self.anchor_rect(n),
            // The dock's own menu opens where it was asked for, along the dock.
            _ => {
                let (x, y) = (self.pointer.0 as i32, self.pointer.1 as i32);
                let (width, height) = (self.layout.size.0 as i32, self.layout.size.1 as i32);
                let g = POPUP_GAP;
                if self.layout.position.horizontal() {
                    [x.clamp(0, width - 1), -g, 1, height + 2 * g]
                } else {
                    [-g, y.clamp(0, height - 1), width + 2 * g, 1]
                }
            }
        };
        let title = item.map_or("Dock", |i| i.label.as_str()).to_string();
        let anchor = item.map(|i| i.key.clone());
        let side = self.side();
        self.popups += 1;
        let look = self.look.as_mut().unwrap();
        look.refresh();
        let opened = Popup::open(
            w,
            look,
            crate::popup::Request {
                rows: &rows,
                title: &title,
                anchor,
                rect,
                side,
                serial,
                keyboard,
                ordinal: self.popups,
            },
        );
        match opened {
            Ok(p) => self.popup = Some(Overlay::Menu(Box::new(p))),
            Err(e) => eprintln!("nidara-shell: the menu did not open: {e}"),
        }
    }

    /// The window chooser over slot `n`: its visible windows, each by its picture and title.
    fn open_chooser(
        &mut self,
        w: &mut Window,
        slot: usize,
        windows: Vec<u64>,
        serial: Option<u32>,
        keyboard: bool,
    ) {
        self.close_popup(w);
        if self.look.is_none() {
            match zbus::blocking::Connection::session()
                .map_err(|e| e.to_string())
                .and_then(|bus| Look::load(&bus))
            {
                Ok(look) => self.look = Some(look),
                Err(e) => {
                    eprintln!("nidara-shell: no look for the chooser: {e}");
                    return;
                }
            }
        }
        let item = &self.frame.view.items[slot];
        let icon = match &item.kind {
            Kind::App { id, .. } => self.frame.icons.get(id).cloned(),
            _ => None,
        };
        let candidates = windows
            .into_iter()
            .map(|window| Candidate {
                window,
                title: self.frame.titles.get(&window).cloned().unwrap_or_default(),
            })
            .collect();
        let request = crate::chooser::Request {
            app: item.label.clone(),
            icon,
            candidates,
            anchor: item.key.clone(),
            rect: self.anchor_rect(slot),
            side: self.side(),
            serial,
            keyboard,
            first_id: {
                self.popups += 1;
                crate::popup::first_id(self.popups)
            },
        };
        self.look.as_mut().unwrap().refresh();
        match Chooser::open(w, request) {
            Ok(c) => self.popup = Some(Overlay::Chooser(Box::new(c))),
            Err(e) => eprintln!("nidara-shell: the chooser did not open: {e}"),
        }
    }

    fn popup_event(
        &mut self,
        w: &mut Window,
        outcome: Result<Outcome, String>,
    ) -> nk_wayland::Result<()> {
        match outcome {
            Ok(Outcome::None) => {}
            Ok(Outcome::Closed) => self.close_popup(w),
            Ok(Outcome::Chosen(command, serial)) => {
                self.close_popup(w);
                self.choose(command, serial, w)?;
            }
            Err(e) => {
                eprintln!("nidara-shell: the menu failed: {e}");
                self.close_popup(w);
            }
        }
        Ok(())
    }

    /// A chosen row goes to the hub; what starts something gets a token from the input
    /// that chose it, and ends the dock's keyboard focus first, as a click does.
    fn choose(
        &mut self,
        command: Command,
        serial: Option<u32>,
        w: &mut Window,
    ) -> nk_wayland::Result<()> {
        let starts = matches!(
            command,
            Command::Launch { .. }
                | Command::OpenFolder(_)
                | Command::OpenTrash
                | Command::DockSettings
        );
        if starts || matches!(command, Command::Window { .. } | Command::CloseAll(_)) {
            self.leave_keyboard(w)?;
        }
        let request = Request::Menu {
            command: command.clone(),
            token: None,
        };
        if starts && let Some(serial) = serial {
            let target = match &command {
                Command::Launch { id, .. } => Some(id.trim_end_matches(".desktop").to_string()),
                _ => None,
            };
            match w.request_activation_token(serial, target.as_deref()) {
                Ok(t) => {
                    self.pending.insert(t, request);
                    return Ok(());
                }
                Err(e) => {
                    eprintln!("nidara-shell: no activation token ({e:?}); opening without one")
                }
            }
        }
        let _ = self.hub.send(request);
        Ok(())
    }

    /// Pictures for the minimized slots shown; each answer is one `Event::Capture`. Hyalo
    /// lists a window under its id in hex, and a minimized window still has its last frame.
    fn capture(&mut self, w: &mut Window) {
        let shown: Vec<u64> = self
            .frame
            .view
            .items
            .iter()
            .filter_map(|i| match i.kind {
                Kind::Minimized { window, .. } => Some(window),
                _ => None,
            })
            .collect();
        for window in self.thumbs.sync(&shown, self.frame.hidden) {
            match w.capture_window(&format!("{window:x}"), (THUMB_SIDE, THUMB_SIDE)) {
                Ok(id) => self.thumbs.started(id, window),
                Err(e) => {
                    eprintln!("nidara-shell: no picture of window {window:x}: {e:?}");
                    self.thumbs.refused(window);
                }
            }
        }
    }

    fn focused_slot(&self) -> Option<usize> {
        let key = self.focus.as_ref()?;
        self.frame.view.items.iter().position(|i| &i.key == key)
    }

    fn leave_keyboard(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        if self.focus.take().is_some() {
            eprintln!(
                "nidara-shell: the dock on {} lets the keyboard go",
                self.output_name
            );
            w.set_layer_placement(placement(&self.layout, false))?;
            w.redraw();
            self.publish_semantics(w);
        }
        Ok(())
    }

    fn key(&mut self, key: nk_wayland::Key, w: &mut Window) -> nk_wayland::Result<()> {
        let Some(slot) = self.focused_slot() else {
            return Ok(());
        };
        let Some(nav) = crate::keys::nav(key.sym, key.shift, self.layout.position) else {
            return Ok(());
        };
        match nav {
            crate::keys::Nav::Leave => self.leave_keyboard(w)?,
            // A repeat has no serial: only a real press opens it, with its grab.
            crate::keys::Nav::Menu => {
                if let Some(serial) = key.serial {
                    self.open_menu(w, Some(slot), Some(serial), true);
                }
            }
            crate::keys::Nav::Act => {
                // A repeat has no serial, so no token: only a real press acts.
                if let Some(serial) = key.serial {
                    self.click(slot, Some(serial), w);
                    self.leave_keyboard(w)?;
                }
            }
            nav => {
                if let Some(to) = crate::keys::moved(&self.frame.view.items, slot, nav) {
                    self.focus = Some(self.frame.view.items[to].key.clone());
                    w.redraw();
                    self.publish_semantics(w);
                }
            }
        }
        Ok(())
    }

    /// Input region, targets and a repaint for the current layout, once the surface has
    /// the size the layout asked for (a new size arrives with the configure).
    fn apply(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        if w.size() != self.layout.size {
            return Ok(());
        }
        let (width, height) = self.layout.size;
        if self.frame.hidden {
            w.set_input_region(Some(&[]))?;
        } else {
            w.set_input_region(Some(&[[0, 0, width as i32, height as i32]]))?;
        }
        self.publish_targets();
        w.redraw();
        self.publish_semantics(w);
        Ok(())
    }

    fn publish_semantics(&mut self, w: &Window) {
        let focus = self.focused_slot();
        let mut tree = crate::semantics::tree(
            &mut self.ids,
            &crate::semantics::Input {
                items: &self.frame.view.items,
                rects: &self.layout.rects,
                size: self.layout.size,
                focus,
                focused_window: self.frame.focused,
                can_launch: self.frame.can_launch,
                hidden: self.frame.hidden,
                trash: self.frame.trash,
            },
        );
        // An open popup's rows join the dock's tree, under its root: the dock's own items
        // keep their place but lose the focus and their actions while it is open (#971).
        if let Some(menu) = self.popup.as_mut().and_then(|p| p.semantics(w)) {
            for node in tree.nodes.values_mut() {
                node.actions.clear();
                node.states.focused = false;
            }
            let children = menu.nodes[&menu.root].children.clone();
            tree.nodes
                .get_mut(&tree.root)
                .unwrap()
                .children
                .extend(children);
            for (id, node) in menu.nodes {
                if id != menu.root {
                    tree.nodes.insert(id, node);
                }
            }
        }
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
                // Publication receipts are only for checks that wait on them.
                while bridge.published.try_recv().is_ok() {}
                if let Err(e) = bridge.update(self.revision, tree) {
                    eprintln!("nidara-shell: accessibility stopped: {e}");
                }
            }
            None => {
                let mut bridge = nk_a11y::bridge::Bridge::new(self.revision, tree);
                // The bridge queues requests on a channel nobody wakes for: forward them
                // with this dock's waker, so a request is handled at once without polling.
                let (requests, rx) = std::sync::mpsc::channel();
                let from = std::mem::replace(&mut bridge.requests, std::sync::mpsc::channel().1);
                let waker = self.waker.clone();
                let _ = std::thread::Builder::new()
                    .name("dock-a11y".into())
                    .spawn(move || {
                        for r in from {
                            if requests.send(r).is_err() {
                                return;
                            }
                            let _ = waker.wake();
                        }
                    });
                self.a11y = Some(bridge);
                self.a11y_requests = Some(rx);
            }
        }
    }

    /// Requests made against an older tree are dropped: the item may be another by now.
    fn a11y(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        let Some(rx) = &self.a11y_requests else {
            return Ok(());
        };
        let requests: Vec<_> = rx.try_iter().collect();
        for (revision, request) in requests {
            if revision != self.revision {
                continue;
            }
            let (nk_a11y::Request::Activate(id) | nk_a11y::Request::Focus(id)) = request else {
                continue;
            };
            let activate = matches!(request, nk_a11y::Request::Activate(_));
            if let Some(popup) = self.popup.as_mut().filter(|p| p.owns(id)) {
                let outcome = popup.request(id, activate);
                self.popup_event(w, outcome)?;
                self.sync_popup(w);
                continue;
            }
            let Some(key) = self.ids.key(id).map(str::to_string) else {
                continue;
            };
            let Some(slot) = self.frame.view.items.iter().position(|i| i.key == key) else {
                continue;
            };
            if matches!(request, nk_a11y::Request::Activate(_)) {
                // No input event behind it, so no activation token.
                self.click(slot, None, w);
            } else if self.focus.is_some() {
                self.focus = Some(key);
                w.redraw();
                self.publish_semantics(w);
            }
        }
        Ok(())
    }

    fn sync_popup(&mut self, w: &mut Window) {
        let (Some(popup), Some(look)) = (self.popup.as_mut(), self.look.as_mut()) else {
            return;
        };
        match popup.sync(w, look) {
            Ok(true) => self.publish_semantics(w),
            Ok(false) => {}
            Err(e) => {
                eprintln!("nidara-shell: the menu cannot be drawn: {e}");
                self.close_popup(w);
            }
        }
    }

    /// Where each minimized window this dock owns goes: its slot, in surface coordinates.
    fn publish_targets(&mut self) {
        let mut targets = BTreeMap::new();
        for (n, item) in self.frame.view.items.iter().enumerate() {
            if let Kind::Minimized { window, .. } = item.kind
                && self.frame.targets.contains(&window)
            {
                targets.insert(window, self.layout.rects[n]);
            }
        }
        if targets != self.published {
            self.published = targets.clone();
            let _ = self.hub.send(Request::Targets {
                output: self.output_name.clone(),
                targets,
            });
        }
    }

    fn click(&mut self, slot: usize, serial: Option<u32>, w: &mut Window) {
        let item = &self.frame.view.items[slot];
        let Some(action) = primary(item, self.frame.focused, self.frame.can_launch) else {
            return;
        };
        let epoch = self.frame.hyalo_epoch;
        let request = match action {
            Action::Focus(id) => Request::Window {
                verb: "focus-window",
                id,
                epoch,
            },
            Action::Minimize(id) => Request::Window {
                verb: "minimize",
                id,
                epoch,
            },
            Action::Restore(id) => Request::Window {
                verb: "unminimize",
                id,
                epoch,
            },
            Action::Launch { id, generation } => Request::Launch {
                id,
                generation,
                token: None,
            },
            Action::Choose(windows) => {
                let keyboard = self.focus.is_some();
                self.open_chooser(w, slot, windows, serial, keyboard);
                return;
            }
            Action::OpenFolder(uri) => Request::OpenFolder { uri, token: None },
            Action::OpenTrash => Request::OpenTrash { token: None },
            Action::Unavailable => {
                eprintln!("nidara-shell: {} cannot be opened now", item.label);
                return;
            }
        };
        // What starts something gets a token from this very click; focus and minimize do not.
        if matches!(
            request,
            Request::Launch { .. } | Request::OpenFolder { .. } | Request::OpenTrash { .. }
        ) {
            let target = match &item.kind {
                Kind::App { id, .. } => Some(id.trim_end_matches(".desktop").to_string()),
                _ => None,
            };
            if let Some(serial) = serial {
                match w.request_activation_token(serial, target.as_deref()) {
                    Ok(t) => {
                        self.pending.insert(t, request);
                        return;
                    }
                    Err(e) => {
                        eprintln!("nidara-shell: no activation token ({e:?}); opening without one")
                    }
                }
            }
        }
        let _ = self.hub.send(request);
    }

    /// Middle-click: a new window where the app has one (the menu's own row), else what a
    /// primary click does.
    fn middle_click(&mut self, slot: usize, serial: u32, w: &mut Window) -> nk_wayland::Result<()> {
        let item = &self.frame.view.items[slot];
        if let Kind::App {
            id,
            generation,
            launchable: true,
            ..
        } = &item.kind
            && self.frame.can_launch
            && self.frame.catalogue.get(id).is_some_and(|a| a.new_window)
        {
            let command = Command::Launch {
                id: id.clone(),
                generation: *generation,
                mode: crate::menu::Launch::NewWindow,
            };
            return self.choose(command, Some(serial), w);
        }
        self.click(slot, Some(serial), w);
        Ok(())
    }

    /// The wheel over an app focuses its windows one by one; elsewhere it does nothing.
    fn wheel(&mut self, delta: f64) {
        let Some(slot) = self.layout.hit(self.pointer.0, self.pointer.1) else {
            self.cycle.reset();
            return;
        };
        let item = &self.frame.view.items[slot];
        if let Some(id) = self
            .cycle
            .scroll(item, self.frame.focused, delta, Instant::now())
        {
            let _ = self.hub.send(Request::Window {
                verb: "focus-window",
                id,
                epoch: self.frame.hyalo_epoch,
            });
        }
    }

    fn with_token(request: Request, token: Option<String>) -> Request {
        match request {
            Request::Launch { id, generation, .. } => Request::Launch {
                id,
                generation,
                token,
            },
            Request::OpenFolder { uri, .. } => Request::OpenFolder { uri, token },
            Request::OpenTrash { .. } => Request::OpenTrash { token },
            Request::Menu { command, .. } => Request::Menu { command, token },
            other => other,
        }
    }

    /// Where attention has lifted a slot now, away from the screen edge.
    fn lift(&self, item: &Item, now: Instant) -> (f64, f64) {
        let share = self
            .attention
            .lift(&item.key, now, self.frame.prefs.reduce_motion);
        let d = share * LIFT * PAD_RATIO * self.layout.icon;
        match self.layout.position {
            Position::Bottom => (0., -d),
            Position::Left => (d, 0.),
            Position::Right => (-d, 0.),
        }
    }

    fn paint_item(&self, c: &mut Canvas, n: usize, item: &Item, now: Instant) {
        let [x, y, w, h] = self.layout.rects[n];
        let (dx, dy) = self.lift(item, now);
        let (x, y) = (x + dx, y + dy);
        let r = Rect {
            x: x as f32,
            y: y as f32,
            width: w as f32,
            height: h as f32,
        };
        let ink = if self.frame.dark {
            rgba(255, 255, 255, 255)
        } else {
            rgba(0, 0, 0, 255)
        };
        let faint = if self.frame.dark {
            rgba(255, 255, 255, 64)
        } else {
            rgba(0, 0, 0, 56)
        };
        match &item.kind {
            // One physical pixel, on the grid: a hairline between pixels reads as a thick
            // blurred one. Its ink is the TS dock's `--nidara-text-disabled` (white at 0.3).
            Kind::Separator => {
                let line = if self.frame.dark {
                    rgba(255, 255, 255, 77)
                } else {
                    rgba(0, 0, 0, 77)
                };
                if self.layout.position.horizontal() {
                    c.vertical_rule(r, 1., line)
                } else {
                    c.horizontal_rule(r, 1., line)
                }
            }
            Kind::Trash => {
                // The theme's Trash, full or empty as it is; Nidara's own symbol on a faint
                // tile only when the theme has none (or Applications1 cannot say).
                let full = self.frame.trash.is_some_and(|t| t.full);
                let key = if full { TRASH_FULL } else { TRASH_EMPTY };
                if let Some(art) = self.frame.icons.get(key) {
                    c.image(art, r, ImageFit::Contain);
                } else {
                    c.rounded_rect(r, w * 0.22, faint);
                    if let Some(icon) = &self.trash_icon {
                        let inset = w * 0.22;
                        let i = Rect {
                            x: (x + inset) as f32,
                            y: (y + inset) as f32,
                            width: (w - 2. * inset) as f32,
                            height: (h - 2. * inset) as f32,
                        };
                        c.icon(icon, i, ink);
                    }
                }
            }
            // A minimized window: its picture, proportions kept, with the app's icon small at
            // the bottom-right corner (the TS dock's BADGE share), so two windows of one app
            // tell which app and which window. The app's icon alone until the picture comes.
            Kind::Minimized { window, app } if self.thumbs.get(*window).is_some() => {
                if let Some(picture) = self.thumbs.get(*window) {
                    c.image(picture, r, ImageFit::Contain);
                }
                if let Some(icon) = app.as_deref().and_then(|a| self.frame.icons.get(a)) {
                    let b = (w.min(h) * BADGE) as f32;
                    let badge = Rect {
                        x: r.x + r.width - b,
                        y: r.y + r.height - b,
                        width: b,
                        height: b,
                    };
                    c.image(icon, badge, ImageFit::Contain);
                }
            }
            kind => {
                let id = match kind {
                    Kind::App { id, .. } => Some(id.as_str()),
                    Kind::Minimized { app, .. } => app.as_deref(),
                    _ => None,
                };
                match id.and_then(|id| self.frame.icons.get(id)) {
                    Some(icon) => c.image(icon, r, ImageFit::Contain),
                    None => c.rounded_rect(r, w * 0.22, faint),
                }
            }
        }
        if self.focused_slot() == Some(n) {
            // The roving focus: an ink ring just outside the icon.
            let grow = (3. * self.layout.scale.max(0.5)) as f32;
            let ring = Rect {
                x: r.x - grow,
                y: r.y - grow,
                width: r.width + 2. * grow,
                height: r.height + 2. * grow,
            };
            c.rounded_ring(ring, w * 0.22 + grow as f64, 2., ink);
        }
        if let Some(p) = item.signal.progress {
            // Along the icon's foot: a dark rim, so it reads over light art, around a faint
            // ink track, so it reads over dark art; an ink fill.
            let bar = (h * 0.09).max(2.);
            let track = Rect {
                x: (x + w * 0.12) as f32,
                y: (y + h * 0.88 - bar) as f32,
                width: (w * 0.76) as f32,
                height: bar as f32,
            };
            let rim = (bar * 0.3) as f32;
            let outer = Rect {
                x: track.x - rim,
                y: track.y - rim,
                width: track.width + 2. * rim,
                height: track.height + 2. * rim,
            };
            c.rounded_rect(outer, bar / 2. + rim as f64, rgba(0, 0, 0, 150));
            c.rounded_rect(track, bar / 2., rgba(255, 255, 255, 70));
            if p > 0. {
                let fill = Rect {
                    width: (track.width as f64 * p).max(bar) as f32,
                    ..track
                };
                c.rounded_rect(fill, bar / 2., ink);
            }
        }
        // The kit's `INK.solid` (0.9), as the TS dock's running dot.
        let mark = if self.frame.dark {
            rgba(255, 255, 255, 230)
        } else {
            rgba(0, 0, 0, 230)
        };
        let d = DOT * self.layout.scale.max(0.4);
        if item.signal.attention {
            // Attention's still mark, with or without motion: the dot drawn out to a dash
            // along the dock, whatever the indicators preference (it is not a running dot).
            let (cx, cy) = self.layout.dot(n);
            let (lw, lh) = if self.layout.position.horizontal() {
                (3. * d, d)
            } else {
                (d, 3. * d)
            };
            let dash = Rect {
                x: (cx - lw / 2.) as f32,
                y: (cy - lh / 2.) as f32,
                width: lw as f32,
                height: lh as f32,
            };
            c.rounded_rect(dash, d / 2., mark);
        } else if self.frame.prefs.indicators
            && item.running()
            && !matches!(item.kind, Kind::Minimized { .. })
        {
            c.dot(self.layout.dot(n), d, mark);
        }
    }

    /// A count: a pill out of the icon's top-right corner, the danger colour with a white
    /// figure (ink with a dark one when the tokens lack it). Drawn over every icon, since
    /// it reaches into the next slot's gap.
    fn paint_count(&mut self, c: &mut Canvas, n: usize, item: &Item, count: u64, now: Instant) {
        let [x, y, w, _] = self.layout.rects[n];
        let (dx, dy) = self.lift(item, now);
        let (x, y) = (x + dx, y + dy);
        let pill = w * COUNT;
        let (back, figure) = match self.frame.tokens.as_ref().and_then(|t| {
            let c = t["danger"].as_array()?;
            let b = |n: usize| c.get(n)?.as_u64().map(|v| v as u8);
            Some([b(0)?, b(1)?, b(2)?])
        }) {
            Some([r, g, b]) => (rgba(r, g, b, 255), rgba(255, 255, 255, 255)),
            None => (rgba(255, 255, 255, 235), rgba(0, 0, 0, 255)),
        };
        let text = if count > 999 {
            "999+".to_string()
        } else {
            count.to_string()
        };
        let layout = self.look.as_mut().and_then(|look| {
            let mut style = look.styles.text.clone();
            style.size = (pill * 0.62) as f32;
            // The menus' weight: the fonts have no bold of their own to reach for, and the
            // text engine refuses to fake one.
            style.weight = look.style.row.weight;
            look.text
                .layout(&text, &style, 4096.)
                .map_err(|e| eprintln!("nidara-shell: a count's figure: {e}"))
                .ok()
        });
        let size = layout.as_ref().map(|l| l.measured_size());
        let width = size.map_or(pill, |s| (s.width as f64 + pill * 0.6).max(pill));
        let bx = x + w - width + pill * COUNT_OUT;
        let by = y - pill * COUNT_OUT;
        let r = Rect {
            x: bx as f32,
            y: by as f32,
            width: width as f32,
            height: pill as f32,
        };
        c.rounded_rect(r, pill / 2., back);
        if let (Some(layout), Some(size)) = (layout, size) {
            let origin = (
                (bx + (width - size.width as f64) / 2.) as f32,
                (by + (pill - size.height as f64) / 2.) as f32,
            );
            if let Err(e) = c.layout(&layout, origin, figure) {
                eprintln!("nidara-shell: a count's figure: {e}");
            }
        }
    }
}

impl Application for Dock {
    fn poll_interval_ms(&self) -> u32 {
        // Everything arrives by Wake; an open chooser refreshes its pictures, and a bounce
        // wants its frames.
        if self
            .attention
            .wants_frames(Instant::now(), self.frame.prefs.reduce_motion)
        {
            return crate::attention::FRAME.as_millis() as u32;
        }
        match self.popup {
            Some(Overlay::Chooser(_)) => crate::chooser::REFRESH.as_millis() as u32,
            _ => 60_000,
        }
    }
    fn idle(&mut self, w: &mut Window) -> nk_wayland::Result<()> {
        if let Some(Overlay::Chooser(c)) = self.popup.as_mut() {
            c.refresh(w);
        }
        if self
            .attention
            .tick(Instant::now(), self.frame.prefs.reduce_motion)
        {
            w.redraw();
        }
        Ok(())
    }
    fn event(&mut self, event: Event, w: &mut Window) -> nk_wayland::Result<()> {
        match event {
            Event::Error(e) => return Err(e),
            Event::Wake => {
                self.drain(w)?;
                self.a11y(w)?;
            }
            Event::Configure => self.apply(w)?,
            Event::Motion(x, y) => self.pointer = (x, y),
            Event::Key(key) => self.key(key, w)?,
            // The compositor gave the keyboard elsewhere: the roving focus ends with it. Not
            // to the dock's own popup, which holds it for as long as it is open.
            Event::Focus(false) if self.popup.is_none() => self.leave_keyboard(w)?,
            Event::PointerLeave => {
                self.pressed = None;
                self.middle = None;
                self.cycle.reset();
            }
            Event::Scroll(delta) if !self.frame.hidden && self.popup.is_none() => self.wheel(delta),
            Event::PopupOverlay { id, event } => {
                if let Some(popup) = self.popup.as_mut().filter(|p| p.id() == id) {
                    let outcome = popup.event(w, event);
                    self.popup_event(w, outcome)?;
                }
            }
            // A press while the popup is open only closes it.
            Event::Button { pressed: true, .. } if self.popup.is_some() => {
                self.close_popup(w);
                self.swallow = true;
            }
            Event::Button { pressed: false, .. } if self.swallow => self.swallow = false,
            Event::Button {
                button: RIGHT_BUTTON,
                pressed: true,
                serial,
                ..
            } if !self.frame.hidden => {
                let slot = self.layout.hit(self.pointer.0, self.pointer.1);
                self.open_menu(w, slot, Some(serial), false);
            }
            Event::Button {
                button: MIDDLE_BUTTON,
                pressed: true,
                ..
            } if !self.frame.hidden => {
                self.middle = self.layout.hit(self.pointer.0, self.pointer.1);
            }
            Event::Button {
                button: MIDDLE_BUTTON,
                pressed: false,
                serial,
                ..
            } => {
                let here = self.layout.hit(self.pointer.0, self.pointer.1);
                if let Some(slot) = self.middle.take().filter(|s| Some(*s) == here) {
                    self.middle_click(slot, serial, w)?;
                }
            }
            Event::Button {
                button: LEFT_BUTTON,
                pressed: true,
                ..
            } if !self.frame.hidden => {
                self.pressed = self.layout.hit(self.pointer.0, self.pointer.1);
            }
            Event::Button {
                button: LEFT_BUTTON,
                pressed: false,
                serial,
                ..
            } => {
                let here = self.layout.hit(self.pointer.0, self.pointer.1);
                if let Some(slot) = self.pressed.take().filter(|s| Some(*s) == here) {
                    self.click(slot, Some(serial), w);
                }
            }
            Event::ActivationToken { request, token } => {
                if let Some(r) = self.pending.remove(&request) {
                    let _ = self
                        .hub
                        .send(Self::with_token(r, Some(token.into_string())));
                }
            }
            Event::ActivationTokenFailed { request, reason } => {
                if let Some(r) = self.pending.remove(&request) {
                    eprintln!(
                        "nidara-shell: activation token failed ({reason:?}); opening without one"
                    );
                    let _ = self.hub.send(Self::with_token(r, None));
                }
            }
            Event::Capture { id, result } => {
                let picture = match result {
                    Ok(i) => Raster::from_rgba(i.width as u16, i.height as u16, i.rgba).ok(),
                    Err(e) => {
                        eprintln!("nidara-shell: a window picture failed: {e:?}");
                        None
                    }
                };
                let picture = match self.popup.as_mut() {
                    Some(Overlay::Chooser(c)) if c.captures.contains_key(&id) => {
                        if c.captured(id, picture) {
                            self.sync_popup(w);
                        }
                        return Ok(());
                    }
                    _ => picture,
                };
                if self.thumbs.finished(id, picture) {
                    w.redraw();
                }
            }
            Event::Closed => {}
            _ => {}
        }
        self.sync_popup(w);
        Ok(())
    }
    fn paint(&mut self, f: nk_wayland::Frame) -> nk_wayland::Result<Vec<u8>> {
        let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
        if !self.frame.hidden && f.width == self.layout.size.0 && f.height == self.layout.size.1 {
            if !f.material {
                // No compositor glass (another compositor): an opaque base of our own (D5).
                let (w, h) = (f.width as f32, f.height as f32);
                let base = if self.frame.dark {
                    rgba(40, 40, 44, 235)
                } else {
                    rgba(236, 236, 240, 235)
                };
                c.rounded_rect(
                    Rect {
                        x: 0.,
                        y: 0.,
                        width: w,
                        height: h,
                    },
                    (w.min(h) / 2.) as f64,
                    base,
                );
            }
            let now = Instant::now();
            let frame = self.frame.clone();
            for (n, item) in frame.view.items.iter().enumerate() {
                self.paint_item(&mut c, n, item, now);
            }
            for (n, item) in frame.view.items.iter().enumerate() {
                if let Some(count) = item.signal.count {
                    self.paint_count(&mut c, n, item, count, now);
                }
            }
        }
        Ok(c.finish())
    }
    fn material(&self) -> Option<Material> {
        if self.frame.hidden {
            return None;
        }
        let (w, h) = (self.layout.size.0 as f64, self.layout.size.1 as f64);
        let pane = Pane {
            x: 0.,
            y: 0.,
            width: w,
            height: h,
            radius: w.min(h) / 2.,
            exponent: CAPSULE_EXPONENT,
        };
        self.frame.tokens.as_ref().and_then(|t| {
            crate::material::dock(
                t,
                self.frame.dark,
                self.frame.prefs.reduce_transparency,
                pane,
            )
        })
    }
}

/// One dock's whole life on its own thread; returns when its surface closes or the hub
/// drops it.
pub fn run(dock: Dock, output: LayerOutput, wake: WakeSource) -> nk_wayland::Result<()> {
    let p = placement(&dock.layout, false);
    nk_wayland::run_layer(
        dock,
        Options {
            material: true,
            map: true,
            app_id: NAMESPACE,
            title: "",
            size: p.size,
            require_material: None,
        },
        LayerSpec {
            namespace: NAMESPACE,
            output: Some(output),
            layer: LayerLevel::Top,
            placement: p,
        },
        Some(wake),
        Instant::now(),
    )
}
