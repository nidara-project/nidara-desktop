// SPDX-License-Identifier: LGPL-3.0-or-later
//! An application window on nk-view (VIEW.md §13.2): the kit's, so that no app builds it again.
//! It holds the frame (`FrameStyle`): the sidebar on a layer of its own over the page, with
//! Settings' panel glass; the content scrolling under the header band; the band's blur and its
//! glass buttons on two layers over the content; Hyalo's window controls; the sidebar's slide
//! and its narrow mode; a press on the band moving the window; Escape; the reader; the paint.
//!
//! An app gives it a `Page` (its sidebar, its content, its title, whether back and forward
//! lead anywhere) each time its model changes, and acts on the activations it gives back. It
//! calls `commit` at the end of each turn, after acting on them.
//!
//! A dropdown in the page is the window's to open (VIEW.md §13.9): its list is a popup over the
//! window, and the app hears only the choice.
use crate::frame::{BACK, Band, FORWARD, FrameStyle, SIDEBAR, Sidebar};
use crate::host::{Glyphs, Type, TypeScale, Weight};
use crate::state::{Activated, Frame as ViewFrame, KeyInput, ScrollBy, ViewState};
use crate::tokens::Tokens;
use crate::view::{Key, Node};
use nk_a11y::{Request, bridge::Bridge};
use nk_platform::{exports::Exports, material::panel::PanelMaterial, portal::Appearance};
use nk_text::TextBackend;
use nk_wayland::{
    ControlsLayout, Event, Frame, LayerEvent, LayerId, Material, MenuPopupPlacement, Pane,
    PopupEvent, PopupId, PopupPlacement, PopupSide, Result, Window, WindowAction, WindowBackground,
};
use std::time::Instant;

/// The content's scroll region.
pub const CONTENT: &str = "frame/content";
/// The sidebar's pane, drawn on its own layer.
const SIDE: &str = "frame/side";
/// The window's node in the reader's tree; the view's ids follow it.
const ROOT: u64 = 1;
/// Where the band's semantic ids start, clear of the view's.
const BAND_ROOT: u64 = 1_000_000;
/// Where a dropdown's list's region ids start (it declares none, but its view needs a base).
const MENU_ROOT: u32 = 2_000_000;
/// The list's scroll region and the key of its row `n`.
const MENU_SCROLL: &str = "menu/scroll";
fn menu_row(n: usize) -> Key {
    Key(format!("menu/row/{n}"))
}

/// A dropdown's list, open in a popup over the window (VIEW.md §13.9).
struct Menu {
    id: PopupId,
    /// The dropdown it is the list of, its options and the one chosen when it opened.
    owner: Key,
    options: Vec<String>,
    chosen: usize,
    /// Its rows, laid out in the popup's own coordinates.
    view: ViewState,
    /// The size its rows were last laid out in.
    size: (f64, f64),
    material: Option<Material>,
    dirty: bool,
    /// Opened from the keyboard or by a reader: the chosen row is lit from the start.
    keys: bool,
}

/// What `commit` does about the list, which needs the window: open one, or close it.
enum MenuRequest {
    Open { owner: Key, keys: bool },
    Close,
}

/// What the window paints with in one appearance: the kit's tokens and type, Settings' panel
/// glass, the frame's measures and the window's background.
pub struct WindowLook {
    pub tokens: Tokens,
    pub types: TypeScale,
    pub panel: PanelMaterial,
    pub frame: FrameStyle,
    pub background: [f64; 3],
    pub dark: bool,
}
impl WindowLook {
    pub fn load(e: &Exports, a: &Appearance) -> std::result::Result<Self, String> {
        let set = e.tokens(a)?;
        let bg = nk_platform::styles::colour(&set, "--nidara-bg")?.components;
        Ok(Self {
            tokens: Tokens::load(e, a)?,
            types: TypeScale::load(e, a)?,
            panel: PanelMaterial::load(e.glass.clone(), a.dark, a.reduce_transparency)?,
            frame: FrameStyle::load(e, a)?,
            background: [bg[0] as f64, bg[1] as f64, bg[2] as f64],
            dark: a.dark,
        })
    }
    /// What a frame declares to Hyalo: each pane's glass in its own step of the panel
    /// material, by its short side, and the frame's washes.
    pub fn glass(&self, frame: &ViewFrame) -> Option<Material> {
        let base = self.panel.at(0.).ok()?;
        let groups = frame
            .groups(base.tone, base.shadow)
            .into_iter()
            .map(|mut g| {
                let side = g
                    .shapes
                    .iter()
                    .map(|s| s.width.min(s.height))
                    .fold(f64::INFINITY, f64::min);
                if let Ok(m) = self.panel.at(side) {
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
}

/// What the app shows, rebuilt from its model. The window keeps it to lay it out again as
/// the sidebar slides or the window resizes.
#[derive(Clone)]
pub struct Page {
    pub sidebar: Node,
    pub content: Node,
    pub title: String,
    pub can_back: bool,
    pub can_forward: bool,
}

/// The band's buttons' names for readers, in the app's language.
pub struct Labels {
    pub show_sidebar: String,
    pub hide_sidebar: String,
    pub back: String,
    pub forward: String,
}

pub struct AppWindow {
    look: WindowLook,
    labels: Labels,
    name: String,
    text: Box<dyn TextBackend>,
    glyphs: Glyphs,
    page: Option<Page>,
    /// The page and its sidebar, one view: what the reader, focus and Tab go through.
    state: ViewState,
    /// The header band (the sidebar's toggle, back and forward, the title), laid out on its
    /// own: it is drawn in a layer over the content and the band's blur.
    band: ViewState,
    sidebar: Sidebar,
    /// Whether the last turn laid the sidebar out mid-slide: the turn after its end lays it
    /// out once more, at rest.
    sliding: bool,
    /// The size the view was last laid out in: a resize moves the frame, it does not slide.
    laid_size: (f64, f64),
    /// The band's blur (no pointer), the band's buttons over it, and the sidebar over both,
    /// created in that order so they stack so.
    blur_layer: Option<LayerId>,
    band_layer: Option<LayerId>,
    side_layer: Option<LayerId>,
    band_dirty: bool,
    /// The view changed what it shows: the frame is taken again, the sidebar's layer painted
    /// and the window redrawn.
    paint_dirty: bool,
    /// Something the reader sees changed: the tree is published again.
    changed: bool,
    /// The pointer over the band, and the last press on it where nothing else is (a second
    /// one within the double-click time toggles maximised).
    band_pointer: Option<(f64, f64)>,
    last_press: Option<u32>,
    last: ViewFrame,
    band_last: ViewFrame,
    size: (f64, f64),
    scale: f64,
    reduced: bool,
    controls: Option<ControlsLayout>,
    a11y: Option<Bridge>,
    revision: u64,
    /// Activations of a tick taken in `commit`, given to the app on the next turn.
    pending: Vec<Activated>,
    menu: Option<Menu>,
    /// What the turn asked of the list, done in `commit`.
    menu_request: Option<MenuRequest>,
    /// The serial of the last press or key, which a list opened by it grabs with; None when
    /// a reader opened it.
    grab: Option<u32>,
    /// The last activation came from the keyboard or a reader, not the pointer.
    keys: bool,
}

/// A dropdown's list: its rows, in a scroll region for a list taller than the window.
fn menu_node(
    options: &[String],
    chosen: usize,
    style: &crate::tokens::MenuStyle,
    types: &crate::host::TypeScale,
) -> Node {
    let rows = options
        .iter()
        .enumerate()
        .map(|(n, o)| Node::menu_row(menu_row(n), o.clone(), "choose", n == chosen, style, types))
        .collect();
    Node::scroll(MENU_SCROLL, Node::column("menu/rows", rows))
}

/// Which row of the list a key is.
fn row_of(key: &Key) -> Option<usize> {
    key.0.strip_prefix("menu/row/")?.parse().ok()
}

impl AppWindow {
    /// `name` is the window's for readers.
    pub fn new(
        look: WindowLook,
        labels: Labels,
        name: impl Into<String>,
        text: Box<dyn TextBackend>,
        glyphs: Glyphs,
        reduced: bool,
    ) -> Self {
        let mut state = ViewState::new(ROOT as u32 + 1);
        state.set_reduced_motion(reduced);
        let mut band = ViewState::new(BAND_ROOT as u32 + 1);
        band.set_reduced_motion(reduced);
        // The band's buttons are placed by the frame, step by step as the sidebar slides:
        // they never ease on their own (VIEW.md §13.2).
        band.set_slides(false);
        Self {
            look,
            labels,
            name: name.into(),
            text,
            glyphs,
            page: None,
            state,
            band,
            sidebar: Sidebar::default(),
            sliding: false,
            laid_size: (0., 0.),
            blur_layer: None,
            band_layer: None,
            side_layer: None,
            band_dirty: false,
            paint_dirty: false,
            changed: false,
            band_pointer: None,
            last_press: None,
            last: ViewFrame::default(),
            band_last: ViewFrame::default(),
            size: (0., 0.),
            scale: 1.,
            reduced,
            controls: None,
            a11y: None,
            revision: 0,
            pending: vec![],
            menu: None,
            menu_request: None,
            grab: None,
            keys: false,
        }
    }

    pub fn look(&self) -> &WindowLook {
        &self.look
    }
    /// A new appearance from the portal.
    pub fn set_look(&mut self, look: WindowLook, reduced: bool) {
        self.look = look;
        self.reduced = reduced;
        self.state.set_reduced_motion(reduced);
        self.band.set_reduced_motion(reduced);
        self.lay(Instant::now());
    }
    /// The app's model changed: the page it shows now.
    pub fn show(&mut self, page: Page) {
        self.page = Some(page);
        self.lay(Instant::now());
    }
    /// Scrolls the content to its top, as a new page opens.
    pub fn to_top(&mut self) {
        self.state
            .scroll_region(&CONTENT.into(), ScrollBy::Pixels(-1e9));
    }
    /// A control's value (a slider's), as the view holds it.
    pub fn value(&self, key: &crate::view::Key) -> Option<f64> {
        self.state.value(key)
    }
    pub fn sidebar_open(&self) -> bool {
        self.sidebar.open()
    }

    /// Lays the page out in the frame at `now`, and the band over it.
    fn lay(&mut self, now: Instant) {
        let Some(page) = self.page.clone() else {
            return;
        };
        let f = &self.look.frame;
        let shown = self.sidebar.shown(now, &self.look.tokens.motion);
        let narrow = self.sidebar.narrow();
        let main = f.view(self.size, shown, narrow, page.sidebar, page.content);
        // The frame moves the sidebar's glass and the content's panes itself as the sidebar
        // slides or the window resizes. An ease of nk-view's own over each step would trail
        // behind the content's edge and start again every frame (VIEW.md §13.2). A change of
        // the model, a reveal opening, still slides what it moved.
        let framed = self.sliding
            || self.sidebar.animating(now, &self.look.tokens.motion)
            || self.size != self.laid_size;
        self.state.set_slides(!framed);
        self.laid_size = self.size;
        let band = f.band(
            self.size,
            f.slid(shown),
            self.controls,
            Band {
                title: Node::text(
                    "band/title/text",
                    page.title,
                    self.look.types.style(Type::Subtitle, Weight::Semibold),
                )
                .lines(1),
                sidebar: if self.sidebar.open() {
                    &self.labels.hide_sidebar
                } else {
                    &self.labels.show_sidebar
                },
                back: &self.labels.back,
                forward: &self.labels.forward,
                can_back: page.can_back,
                can_forward: page.can_forward,
            },
        );
        self.state.layout(
            &main,
            self.size,
            self.scale,
            &self.look.tokens,
            self.text.as_mut(),
            now,
        );
        self.band.layout(
            &band,
            (self.size.0, f.band),
            self.scale,
            &self.look.tokens,
            self.text.as_mut(),
            now,
        );
        self.band_dirty = true;
        self.changed = true;
        // A list whose dropdown is gone, or holds other options now, is closed.
        if let Some(m) = &self.menu
            && self
                .state
                .choice(&m.owner)
                .is_none_or(|(options, _)| options != m.options)
        {
            self.menu_request = Some(MenuRequest::Close);
        }
    }

    fn toggle_sidebar(&mut self, open: bool) {
        let now = Instant::now();
        self.sidebar
            .set(open, now, &self.look.tokens.motion, self.reduced);
        self.sliding = true;
        self.lay(now);
    }

    /// The frame's own actions are the window's; the rest go to the app. A choice in a
    /// sidebar open over the page closes it.
    fn route(&mut self, a: Activated, out: &mut Vec<Activated>) {
        if a.action == SIDEBAR {
            return self.toggle_sidebar(!self.sidebar.open());
        }
        if self.state.choice(&a.key).is_some() {
            // A dropdown: its list opens, or closes when it is the one open. The app hears
            // only the choice.
            self.menu_request = Some(match &self.menu {
                Some(m) if m.owner == a.key => MenuRequest::Close,
                _ => MenuRequest::Open {
                    owner: a.key,
                    keys: self.keys,
                },
            });
            return;
        }
        if self.sidebar.over_content() && self.state.lifts(&a.key) {
            self.toggle_sidebar(false);
        }
        out.push(a);
    }

    pub fn poll_interval_ms(&self) -> u32 {
        let sliding = self
            .sidebar
            .animating(Instant::now(), &self.look.tokens.motion);
        let menu = self.menu.as_ref().is_some_and(|m| m.view.animating());
        if self.state.animating() || self.band.animating() || sliding || menu {
            16
        } else {
            100
        }
    }

    /// A turn without an event: the reader's requests, the slide's next step, the fades.
    pub fn idle(&mut self) -> Result<Vec<Activated>> {
        let mut out = vec![];
        for a in std::mem::take(&mut self.pending) {
            self.route(a, &mut out);
        }
        let now = Instant::now();
        if let Some(a) = &self.a11y {
            a.check()?;
        }
        while let Some((_, request)) = self.a11y.as_ref().and_then(|a| a.requests.try_recv().ok()) {
            let (id, activate, value) = match request {
                Request::Focus(id) => (id, false, None),
                Request::Activate(id) => (id, true, None),
                Request::SetValue(id, v) => (id, false, Some(v)),
                _ => continue,
            };
            self.grab = None;
            self.keys = true;
            if let Some((owner, n)) = self.state.option(id) {
                // An option: chosen when activated, closed or open; focused in the open list.
                match (activate, &mut self.menu) {
                    (true, _) => self.choose(&owner, n, &mut out),
                    (false, Some(m)) if m.owner == owner => {
                        m.view.request(&menu_row(n), false);
                        m.dirty = true;
                    }
                    _ => {}
                }
                self.changed = true;
                continue;
            }
            let band = self.band.semantic_keys();
            let activated = if let Some(k) = band.get(&id) {
                self.band.request(k, activate)
            } else {
                let keys = self.state.semantic_keys();
                keys.get(&id).and_then(|k| match value {
                    Some(v) => self.state.request_value(k, v),
                    None => self.state.request(k, activate),
                })
            };
            if let Some(a) = activated {
                self.route(a, &mut out);
            }
            self.changed = true;
        }
        let sliding = self.sidebar.animating(now, &self.look.tokens.motion);
        if sliding || self.sliding {
            // The slide: the frame laid out again at each step, and once more at its end.
            self.lay(now);
        }
        self.sliding = sliding;
        if self.band.animating() {
            // A hover or press fading on the band's glass.
            let ticked = self
                .band
                .tick(&self.look.tokens, self.text.as_mut(), Instant::now());
            for a in ticked.activated {
                self.route(a, &mut out);
            }
            self.band_dirty = true;
        }
        if let Some(m) = &mut self.menu
            && m.view.animating()
        {
            // The list's scroll bar fading.
            m.view
                .tick(&self.look.tokens, self.text.as_mut(), Instant::now());
            m.dirty = true;
        }
        if self.state.animating() {
            let ticked = self
                .state
                .tick(&self.look.tokens, self.text.as_mut(), Instant::now());
            for a in ticked.activated {
                self.route(a, &mut out);
            }
            self.paint_dirty = true;
            // At an animation's end what the reader sees may have changed with it: a reveal
            // that opened now holds what it shows.
            self.changed |= !self.state.animating();
        }
        Ok(out)
    }

    /// An event for the window. What it does not take (a key no control wants) comes back as
    /// `false`, for the app's own shortcuts; activations come back for the app to act on.
    pub fn event(&mut self, event: Event, window: &mut Window) -> Result<(bool, Vec<Activated>)> {
        let now = Instant::now();
        let mut out = vec![];
        match &event {
            Event::Button {
                pressed: true,
                serial,
                ..
            } => {
                self.grab = Some(*serial);
                self.keys = false;
            }
            Event::Key(key) => {
                self.grab = key.serial;
                self.keys = true;
            }
            _ => {}
        }
        if let Some(m) = &self.menu {
            match event {
                Event::PopupOverlay { id, event } if id == m.id => {
                    self.menu_event(event, &mut out);
                    return Ok((true, out));
                }
                // Without a grab (a reader opened it) the keys still come here: they are the
                // list's while it is open.
                Event::Key(key) => {
                    self.menu_key(key.sym, &mut out);
                    return Ok((true, out));
                }
                // A press anywhere else closes it, and does nothing more.
                Event::Button { pressed: true, .. } => {
                    self.menu_request = Some(MenuRequest::Close);
                    return Ok((true, out));
                }
                _ => {}
            }
        }
        let taken = match event {
            Event::Error(e) => return Err(e),
            Event::Configure | Event::PreferredScale(_) => {
                let (w, h) = window.size();
                self.size = (w as f64, h as f64);
                self.scale = window.scale();
                if self.band_layer.is_none() && window.supports_layers() {
                    // The blur first, so the band's buttons lie over it, and the sidebar
                    // last, over both. The blur takes no pointer.
                    let blur = window.create_layer((1, 1))?;
                    window.set_layer_input_region(blur, Some(&[]))?;
                    self.blur_layer = Some(blur);
                    self.band_layer = Some(window.create_layer((1, 1))?);
                    self.side_layer = Some(window.create_layer((1, 1))?);
                    // Only with a layer to draw it on: without (D5) the window paints it.
                    self.state.lift(Some(SIDE.into()));
                }
                self.sidebar.adapt(self.size.0, &self.look.frame);
                self.lay(now);
                true
            }
            Event::ControlsLayout(layout) => {
                self.controls = Some(layout);
                self.lay(now);
                true
            }
            Event::Layer { id, event } if Some(id) == self.band_layer => {
                self.band_event(event, window, &mut out)?;
                true
            }
            Event::Layer { id, event } if Some(id) == self.side_layer => {
                self.side_event(event, &mut out);
                true
            }
            Event::Motion(x, y) => {
                self.paint_dirty |= self.state.pointer_motion(x, y);
                true
            }
            Event::PointerLeave => {
                self.paint_dirty |= self.state.pointer_leave();
                true
            }
            Event::Button { pressed, .. } => {
                if let Some(a) = self.state.button(pressed, now) {
                    self.route(a, &mut out);
                }
                self.paint_dirty = true;
                true
            }
            Event::Scroll(amount) => {
                self.paint_dirty |= self.state.scroll(amount.into());
                true
            }
            // Escape closes a sidebar open over the page.
            Event::Key(key) if key.sym == 0xff1b && self.sidebar.over_content() => {
                self.toggle_sidebar(false);
                true
            }
            // Alt+Left and Right: back and forward.
            Event::Key(key) if key.alt && matches!(key.sym, 0xff51 | 0xff53) => {
                let action = if key.sym == 0xff51 { BACK } else { FORWARD };
                out.push(Activated {
                    key: "band".into(),
                    action: action.into(),
                });
                true
            }
            Event::Key(key) => match KeyInput::from_key(&key) {
                Some(k) => {
                    if let Some(a) = self.state.key(k) {
                        self.route(a, &mut out);
                    }
                    self.changed = true;
                    true
                }
                None => false,
            },
            Event::Focus(false) => {
                self.state.blur();
                self.changed = true;
                true
            }
            _ => false,
        };
        Ok((taken, out))
    }

    /// The end of a turn, after the app acted on what it was given: the window controls
    /// placed, the reader's tree published, the layers painted and the window redrawn as far
    /// as anything changed.
    pub fn commit(&mut self, window: &mut Window) -> Result<()> {
        match self.menu_request.take() {
            Some(MenuRequest::Open { owner, keys }) => self.open_menu(owner, keys, window)?,
            Some(MenuRequest::Close) => self.close_menu(window),
            None => {}
        }
        self.sync_menu(window)?;
        if self.changed {
            self.changed = false;
            if self.state.animating() {
                // What the app just laid out starts moving now, so the reader is told what
                // it shows as it starts (a reveal opening), not at its first instant, when
                // nothing of it shows yet. What that activates waits for the next turn.
                let ticked = self
                    .state
                    .tick(&self.look.tokens, self.text.as_mut(), Instant::now());
                self.pending.extend(ticked.activated);
            }
            if let Some(c) = self.controls {
                let (x, y) = self.look.frame.controls_at(self.size, c);
                window.place_window_controls(x, y, !self.look.dark)?;
            }
            self.publish(window)?;
            self.paint_dirty = true;
        }
        if self.paint_dirty {
            self.paint_dirty = false;
            self.take_frame(window)?;
            window.redraw();
        }
        if self.band_dirty {
            if self.band_layer.is_some() {
                self.sync_band(window)?;
            } else {
                window.redraw();
                self.band_dirty = false;
            }
        }
        Ok(())
    }

    fn publish(&mut self, window: &Window) -> Result<()> {
        let mut root = nk_a11y::Node::new(ROOT, nk_a11y::Role::Window, self.name.clone());
        root.bounds = nk_a11y::Bounds {
            x: 0.,
            y: 0.,
            width: self.size.0,
            height: self.size.1,
        };
        let mut tree = self.state.semantics(root, ROOT + 1);
        // The band's buttons, children of the window as the rest is.
        let band = self.band.semantics(
            nk_a11y::Node::new(BAND_ROOT, nk_a11y::Role::Panel, ""),
            BAND_ROOT + 1,
        );
        let children = band.nodes[&band.root].children.clone();
        for (id, node) in band.nodes {
            if id != band.root {
                tree.nodes.insert(id, node);
            }
        }
        if let Some(r) = tree.nodes.get_mut(&tree.root) {
            r.children.extend(children);
        }
        self.place_options(&mut tree, window);
        self.revision += 1;
        match &self.a11y {
            Some(a) => a.update(self.revision, tree)?,
            None => self.a11y = Some(Bridge::new(self.revision, tree)),
        }
        Ok(())
    }

    /// The view's frame for this turn: the window's glass and washes, and the sidebar's,
    /// taken out of them onto its layer, which is placed, given Settings' panel glass and
    /// painted. A closed sidebar leaves its layer empty and out of the pointer's way.
    fn take_frame(&mut self, window: &mut Window) -> Result<()> {
        let Some(side) = self.side_layer else {
            return Ok(());
        };
        self.last = self.state.frame(&self.look.tokens, Instant::now());
        let lifted = self.state.lift_out(&mut self.last);
        let (Some(r), Some(f)) = (self.state.lifted_rect(), lifted) else {
            window.set_layer_material(side, None)?;
            window.set_layer_input_region(side, Some(&[]))?;
            window.set_layer_size(side, (1, 1))?;
            window.paint_layer(side, |frame| {
                Ok(
                    nk_render::Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale)
                        .finish(),
                )
            })?;
            return Ok(());
        };
        let size = (r[2].max(1.) as u32, r[3].max(1.) as u32);
        window.set_position(side, r[0], r[1])?;
        window.set_layer_size(side, size)?;
        window.set_layer_input_region(side, None)?;
        window.set_layer_material(side, self.look.glass(&f).as_ref())?;
        let (state, tokens, glyphs) = (&self.state, &self.look.tokens, &mut self.glyphs);
        let painted = window.paint_layer(side, |frame| {
            let mut c = nk_render::Canvas::at(
                frame.pixel_width,
                frame.pixel_height,
                frame.scale,
                (r[0], r[1]),
            );
            state.paint_lifted(&mut c, tokens, &mut |n, s| glyphs.get(n, s))?;
            Ok(c.finish())
        })?;
        // A layer with both buffers busy: tried again on the next turn.
        self.paint_dirty |= !painted;
        Ok(())
    }

    /// The two layers over the content: the blur with the window's background faded on it,
    /// and the band's buttons on their glass with the title. Painted again after a layout
    /// or a change of the band's hover and press.
    fn sync_band(&mut self, window: &mut Window) -> Result<()> {
        let (Some(blur), Some(band)) = (self.blur_layer, self.band_layer) else {
            return Ok(());
        };
        let now = Instant::now();
        let f = &self.look.frame;
        let room = f.room(
            self.sidebar.shown(now, &self.look.tokens.motion),
            self.sidebar.narrow(),
        );
        let r = f.header_rect(self.size, room);
        let size = (r[2].ceil() as u32, r[3].ceil() as u32);
        window.set_position(blur, r[0], r[1])?;
        window.set_layer_size(blur, size)?;
        window.set_layer_blur(
            blur,
            f.blur,
            &f.graded(size.0 as f64, size.1 as f64, window.scale()),
        )?;
        let background = self.look.background;
        let a = window.paint_layer(blur, |frame| {
            let mut c = nk_render::Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
            f.paint_fade(
                &mut c,
                [0., 0., frame.width as f64, frame.height as f64],
                background,
            );
            Ok(c.finish())
        })?;
        self.band_last = self.band.frame(&self.look.tokens, now);
        let band_size = (self.size.0.ceil().max(1.) as u32, f.band.ceil() as u32);
        window.set_position(band, 0., 0.)?;
        window.set_layer_size(band, band_size)?;
        window.set_layer_material(band, self.look.glass(&self.band_last).as_ref())?;
        let (state, tokens, glyphs) = (&self.band, &self.look.tokens, &mut self.glyphs);
        let b = window.paint_layer(band, |frame| {
            let mut c = nk_render::Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
            state.paint(&mut c, tokens, &mut |n, s| glyphs.get(n, s), None)?;
            Ok(c.finish())
        })?;
        // A layer with both buffers busy: tried again on the next turn.
        self.band_dirty = !(a && b);
        Ok(())
    }

    /// The dropdown `owner`'s list, opened below it in a popup as wide as it and as tall as
    /// its rows (never past the window), each option a row, the chosen one ticked and, opened
    /// from the keyboard, lit.
    fn open_menu(&mut self, owner: Key, keys: bool, window: &mut Window) -> Result<()> {
        if let Some(m) = self.menu.take() {
            window.close_menu_popup(m.id);
        }
        let (Some((options, chosen)), Some(r)) =
            (self.state.choice(&owner), self.state.rect(&owner))
        else {
            return Ok(());
        };
        let menu = &self.look.tokens.dropdown.menu;
        let edge = menu.edge();
        let width = r[2].max(2. * edge + 1.);
        let node = menu_node(&options, chosen, menu, &self.look.types);
        let mut view = ViewState::new(MENU_ROOT);
        view.set_reduced_motion(self.reduced);
        // Laid out first as tall as the window, to learn how tall its rows are.
        view.layout_in(
            &node,
            [edge, edge, width - 2. * edge, self.size.1.max(1.)],
            self.scale,
            &self.look.tokens,
            self.text.as_mut(),
            Instant::now(),
        );
        let rows = view
            .placed()
            .iter()
            .find_map(|p| match p.what {
                crate::layout::What::Scroll { content, .. } if p.key.0 == MENU_SCROLL => {
                    Some(content)
                }
                _ => None,
            })
            .unwrap_or(0.);
        let height = (rows + 2. * edge).min(self.size.1).max(1.);
        let id = window.open_menu_popup(MenuPopupPlacement {
            placement: PopupPlacement {
                anchor: [
                    r[0].floor() as i32,
                    r[1].floor() as i32,
                    r[2].ceil().max(1.) as i32,
                    r[3].ceil().max(1.) as i32,
                ],
                size: (width.ceil() as u32, height.ceil() as u32),
            },
            workarea: None,
            side: PopupSide::Below,
            parent: None,
            grab_serial: self.grab,
        })?;
        let row = menu_row(chosen);
        view.request(&row, false);
        if !keys {
            view.hide_ring();
        }
        self.state.set_expanded(Some(owner.clone()));
        self.menu = Some(Menu {
            id,
            owner,
            options,
            chosen,
            view,
            size: (0., 0.),
            material: None,
            dirty: true,
            keys,
        });
        self.changed = true;
        Ok(())
    }

    /// Closes the list, the focus back on its dropdown, its ring shown when the list was
    /// worked from the keyboard.
    fn close_menu(&mut self, window: &mut Window) {
        let Some(m) = self.menu.take() else {
            return;
        };
        window.close_menu_popup(m.id);
        self.state.set_expanded(None);
        self.state.request(&m.owner, false);
        if !self.keys {
            self.state.hide_ring();
        }
        self.changed = true;
    }

    /// Option `n` of the dropdown `owner` was chosen: the app hears it when it is another
    /// option, and the list closes.
    fn choose(&mut self, owner: &Key, n: usize, out: &mut Vec<Activated>) {
        if let Some(a) = self.state.choose(owner, n) {
            out.push(a);
        }
        if self.menu.as_ref().is_some_and(|m| &m.owner == owner) {
            self.menu_request = Some(MenuRequest::Close);
        }
        self.changed = true;
    }

    /// The list's popup: configured, done, a key or the pointer.
    fn menu_event(&mut self, event: PopupEvent, out: &mut Vec<Activated>) {
        let Some(m) = &mut self.menu else {
            return;
        };
        match event {
            PopupEvent::Configure => m.dirty = true,
            PopupEvent::Done => self.menu_request = Some(MenuRequest::Close),
            PopupEvent::Key(key) => {
                self.keys = true;
                self.menu_key(key.sym, out);
            }
            PopupEvent::Input(LayerEvent::Motion(x, y)) => {
                m.dirty |= m.view.pointer_motion(x, y);
            }
            PopupEvent::Input(LayerEvent::Leave) => m.dirty |= m.view.pointer_leave(),
            PopupEvent::Input(LayerEvent::Button { pressed, .. }) => {
                self.keys = false;
                let a = m.view.button(pressed, Instant::now());
                m.dirty = true;
                if let Some(n) = a.and_then(|a| row_of(&a.key)) {
                    let owner = m.owner.clone();
                    self.choose(&owner, n, out);
                }
            }
            PopupEvent::Input(LayerEvent::Scroll(amount)) => {
                m.dirty |= m.view.scroll(amount.into());
            }
            _ => {}
        }
    }

    /// A key while the list is open: the arrows, Home and End move along it, Enter and Space
    /// choose, Escape closes; Tab closes it and moves on.
    fn menu_key(&mut self, sym: u32, out: &mut Vec<Activated>) {
        let Some(m) = &mut self.menu else {
            return;
        };
        let n = m.options.len();
        let at = m
            .view
            .focus()
            .and_then(row_of)
            .unwrap_or(m.chosen)
            .min(n.saturating_sub(1));
        let to = match sym {
            0xff52 => Some((at + n - 1) % n),
            0xff54 => Some((at + 1) % n),
            0xff50 => Some(0),
            0xff57 => Some(n - 1),
            _ => None,
        };
        if let Some(to) = to {
            // The keyboard takes over from the pointer: only its row is lit.
            m.view.pointer_leave();
            m.view.request(&menu_row(to), false);
            m.dirty = true;
            self.changed = true;
            return;
        }
        match sym {
            0xff0d | 0xff8d | 0x20 => {
                let owner = m.owner.clone();
                self.choose(&owner, at, out);
            }
            0xff1b => self.menu_request = Some(MenuRequest::Close),
            0xff09 | 0xfe20 => {
                self.menu_request = Some(MenuRequest::Close);
                if let Some(a) = self.state.key(if sym == 0xff09 {
                    KeyInput::Tab
                } else {
                    KeyInput::ShiftTab
                }) {
                    self.route(a, out);
                }
            }
            _ => {}
        }
    }

    /// The list's popup painted when anything of it changed: its rows laid out in its size,
    /// on Settings' panel glass by its short side, its border drawn, and without the
    /// compositor's glass (D5) its own opaque ground.
    fn sync_menu(&mut self, window: &mut Window) -> Result<()> {
        let Some(m) = &mut self.menu else {
            return Ok(());
        };
        let Some([_, _, w, h]) = window.popup_overlay_geometry(m.id) else {
            return Ok(());
        };
        let size = (f64::from(w.max(1)), f64::from(h.max(1)));
        let style = &self.look.tokens.dropdown.menu;
        if size != m.size {
            m.size = size;
            let node = menu_node(&m.options, m.chosen, style, &self.look.types);
            let edge = style.edge();
            m.view.layout_in(
                &node,
                [
                    edge,
                    edge,
                    (size.0 - 2. * edge).max(0.),
                    (size.1 - 2. * edge).max(0.),
                ],
                self.scale,
                &self.look.tokens,
                self.text.as_mut(),
                Instant::now(),
            );
            if let Some(f) = m.view.focus().cloned() {
                // The chosen row in view, as the list opens.
                m.view.request(&f, false);
                if !m.keys {
                    m.view.hide_ring();
                }
            }
            m.material = self.look.panel.at(size.0.min(size.1)).ok().map(|mut g| {
                g.shapes = vec![Pane {
                    x: 0.,
                    y: 0.,
                    width: size.0,
                    height: size.1,
                    radius: style.radius,
                    exponent: 2.,
                    pointer: None,
                }];
                g
            });
            m.dirty = true;
            self.changed = true;
        }
        if !m.dirty {
            return Ok(());
        }
        let Some(frame) = window.popup_overlay_frame(m.id)? else {
            return Ok(());
        };
        let mut c = nk_render::Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
        let whole = nk_text::Rect {
            x: 0.,
            y: 0.,
            width: frame.width as f32,
            height: frame.height as f32,
        };
        if !frame.material || m.material.is_none() {
            let mut ground = style.background;
            ground.components[3] = 1.;
            c.rounded_rect(whole, style.radius, ground);
        }
        let glyphs = &mut self.glyphs;
        m.view.paint(
            &mut c,
            &self.look.tokens,
            &mut |n, s| glyphs.get(n, s),
            None,
        )?;
        c.rounded_ring(whole, style.radius, style.border, style.border_color);
        let bytes = c.finish();
        if window.paint_popup_overlay(m.id, frame, &bytes, m.material.as_ref())? {
            m.dirty = false;
        }
        Ok(())
    }

    /// The open list's options where a reader finds them: at their rows in the popup, in
    /// window coordinates, the row the keyboard is on focused in place of the dropdown.
    fn place_options(&self, tree: &mut nk_a11y::Tree, window: &Window) {
        let Some(m) = &self.menu else {
            return;
        };
        let Some((ox, oy)) = window.menu_popup_origin(m.id) else {
            return;
        };
        let focus = m.view.focus().and_then(row_of);
        let viewport = m.view.rect(&MENU_SCROLL.into());
        for n in 0..m.options.len() {
            let (Some(id), Some(r)) =
                (self.state.option_id(&m.owner, n), m.view.rect(&menu_row(n)))
            else {
                continue;
            };
            let Some(o) = tree.nodes.get_mut(&id) else {
                continue;
            };
            o.bounds = nk_a11y::Bounds {
                x: f64::from(ox) + r[0],
                y: f64::from(oy) + r[1],
                width: r[2],
                height: r[3],
            };
            o.states.offscreen =
                viewport.is_none_or(|v| r[1] + r[3] <= v[1] || r[1] >= v[1] + v[3]);
            o.states.focused = focus == Some(n);
            if !o.states.disabled {
                o.actions = vec![nk_a11y::Action::Focus, nk_a11y::Action::Activate];
            }
        }
        if focus.is_some()
            && let Some(combo) = self
                .state
                .semantic_keys()
                .into_iter()
                .find(|(_, k)| k == &m.owner)
                .and_then(|(id, _)| tree.nodes.get_mut(&id))
        {
            combo.states.focused = false;
        }
    }

    /// A press on the band where nothing else is: the window moves, or a second press
    /// within the double-click time toggles it maximised.
    fn band_press(&mut self, serial: u32, time: u32, window: &mut Window) -> Result<()> {
        let double = self.look.frame.double_click_ms;
        if self
            .last_press
            .is_some_and(|t| time.wrapping_sub(t) <= double)
        {
            self.last_press = None;
            window.window_action(WindowAction::ToggleMaximize);
            Ok(())
        } else {
            self.last_press = Some(time);
            window.move_from_pointer_press(serial)
        }
    }

    fn band_event(
        &mut self,
        event: LayerEvent,
        window: &mut Window,
        out: &mut Vec<Activated>,
    ) -> Result<()> {
        let now = Instant::now();
        match event {
            LayerEvent::Motion(x, y) => {
                self.band_pointer = Some((x, y));
                self.paint_dirty |= self.state.pointer_leave();
                self.band_dirty |= self.band.pointer_motion(x, y);
            }
            LayerEvent::Leave => {
                self.band_pointer = None;
                self.band_dirty |= self.band.pointer_leave();
            }
            LayerEvent::Button {
                pressed: true,
                serial,
                time,
                ..
            } if self.band.hover().is_none() => self.band_press(serial, time, window)?,
            LayerEvent::Button { pressed, .. } => {
                if let Some(a) = self.band.button(pressed, now) {
                    self.route(a, out);
                    self.changed = true;
                }
                self.band_dirty = true;
            }
            // The content scrolls under the band, so the wheel over it scrolls it.
            LayerEvent::Scroll(amount) => {
                if let Some((x, y)) = self.band_pointer {
                    self.state.pointer_motion(x, y);
                    self.paint_dirty |= self.state.scroll(amount.into());
                    self.state.pointer_leave();
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// The pointer over the sidebar's layer, passed on to the view in window coordinates.
    fn side_event(&mut self, event: LayerEvent, out: &mut Vec<Activated>) {
        let Some(r) = self.state.lifted_rect() else {
            return;
        };
        match event {
            LayerEvent::Motion(x, y) => {
                self.paint_dirty |= self.state.pointer_motion(x + r[0], y + r[1]);
            }
            LayerEvent::Leave => self.paint_dirty |= self.state.pointer_leave(),
            LayerEvent::Button { pressed, .. } => {
                if let Some(a) = self.state.button(pressed, Instant::now()) {
                    self.route(a, out);
                }
                self.paint_dirty = true;
            }
            LayerEvent::Scroll(amount) => self.paint_dirty |= self.state.scroll(amount.into()),
            _ => {}
        }
    }

    /// The window's own surface: the page (the sidebar is on its layer), or, without a
    /// compositor's glass and layers (D5), all of it on an opaque base of our own.
    pub fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        let mut c = nk_render::Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
        if !frame.material {
            let [r, g, b] = self.look.background;
            c.rect(
                nk_text::Rect {
                    x: 0.,
                    y: 0.,
                    width: frame.width as f32,
                    height: frame.height as f32,
                },
                nk_render::Color::new([r as f32, g as f32, b as f32, 1.]),
            );
        }
        let now = Instant::now();
        if self.side_layer.is_none() {
            // No layers (D5): the sidebar is painted with the rest, its washes ours.
            self.last = self.state.frame(&self.look.tokens, now);
        }
        let glyphs = &mut self.glyphs;
        self.state.paint(
            &mut c,
            &self.look.tokens,
            &mut |name, size| glyphs.get(name, size),
            (!frame.material).then_some(&self.last),
        )?;
        if self.band_layer.is_none() {
            // No layers (D5): the band in the window itself, opaque, over the content.
            let f = &self.look.frame;
            let opaque = FrameStyle {
                opaque: true,
                ..f.clone()
            };
            opaque.paint_fade(&mut c, [0., 0., self.size.0, f.band], self.look.background);
            self.band_last = self.band.frame(&self.look.tokens, now);
            self.band.paint(
                &mut c,
                &self.look.tokens,
                &mut |name, size| glyphs.get(name, size),
                Some(&self.band_last),
            )?;
        }
        Ok(c.finish())
    }
    pub fn material(&self) -> Option<Material> {
        self.look.glass(&self.last)
    }
    pub fn window_background(&self) -> Option<WindowBackground> {
        Some(WindowBackground {
            color: self.look.background,
            level: None,
        })
    }
}
