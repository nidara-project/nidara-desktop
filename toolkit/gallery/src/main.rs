// SPDX-License-Identifier: LGPL-3.0-or-later
//! nk-gallery: the kit's gallery (VIEW.md §13.3, #1079), as gtk4-widget-factory is GTK's. A
//! component exists in the kit once it has a page here, in each of its states, built with the
//! kit alone. It is also the reference for an application window on nk-view (§13.2): the
//! tokens from the portal's appearance, the view rebuilt from the model, Hyalo's glass and
//! window controls, the keys and the readers.
mod pages;

use nk_a11y::Request;
use nk_platform::{
    exports::Exports,
    material::panel::PanelMaterial,
    portal::{Appearance, Portal},
};
use nk_text::{FontSet, ParleyBackend};
use nk_view::{
    Activated, BACK, Band, FORWARD, FrameStyle, Glyphs, KeyInput, Node, SIDEBAR, ScrollBy, Sidebar,
    Tokens, Type, TypeScale, ViewState, Weight,
};
use nk_wayland::{
    Application, Event, Frame, LayerEvent, LayerId, Material, Options, Result, Window,
    WindowAction, WindowBackground,
};
use pages::{Catalogue, Model, PAGES};
use std::{path::PathBuf, sync::Arc, time::Instant};

/// Where the window's own semantic ids start; 1 is the window.
const ROOT: u64 = 1;
/// The content's scroll region, the window frame's.
const CONTENT: &str = "frame/content";
/// Where the band's semantic ids start, clear of the window's.
const BAND_ROOT: u64 = 1_000_000;
/// The window frame's sidebar pane, drawn on its own layer (`ViewState::lift`).
const SIDE: &str = "frame/side";

/// What the window paints with in one appearance.
struct Look {
    tokens: Tokens,
    types: TypeScale,
    panel: PanelMaterial,
    frame: FrameStyle,
    background: [f64; 3],
    dark: bool,
}
impl Look {
    fn load(e: &Exports, a: &Appearance) -> std::result::Result<Self, String> {
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
}

struct Gallery {
    exports: Exports,
    portal: Portal,
    look: Look,
    glyphs: Glyphs,
    text: ParleyBackend,
    catalogue: Catalogue,
    model: Model,
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
    /// The pages visited, and where in them back and forward stand.
    history: Vec<usize>,
    at: usize,
    /// The band's blur (no pointer) and the band's buttons over it.
    blur_layer: Option<LayerId>,
    band_layer: Option<LayerId>,
    band_dirty: bool,
    /// The sidebar's layer, over the content, the blur and the band: its glass shows the page
    /// under it, as Settings' sidebar does. Created last, so it stacks on top.
    side_layer: Option<LayerId>,
    side_last: Option<nk_view::Frame>,
    /// The view changed what it shows: the frame is taken again, the sidebar's layer painted
    /// and the window redrawn.
    paint_dirty: bool,
    /// The pointer over the band, and the last press on it where nothing else is (a second
    /// one within the double-click time toggles maximised).
    band_pointer: Option<(f64, f64)>,
    last_press: Option<u32>,
    last: nk_view::Frame,
    band_last: nk_view::Frame,
    size: (f64, f64),
    scale: f64,
    reduced: bool,
    controls: Option<nk_wayland::ControlsLayout>,
    a11y: Option<nk_a11y::bridge::Bridge>,
    revision: u64,
    ready: bool,
    /// A page change waiting for its first commit, which the check screenshots.
    announce: Option<&'static str>,
    pointer: Option<(f64, f64)>,
    inert: bool,
}

/// What a frame declares to Hyalo: each pane's glass in its own step of the panel
/// material, by its short side, and the frame's washes.
fn glass(look: &Look, frame: &nk_view::Frame) -> Option<Material> {
    let base = look.panel.at(0.).ok()?;
    let groups = frame
        .groups(base.tone, base.shadow)
        .into_iter()
        .map(|mut g| {
            let side = g
                .shapes
                .iter()
                .map(|s| s.width.min(s.height))
                .fold(f64::INFINITY, f64::min);
            if let Ok(m) = look.panel.at(side) {
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

impl Gallery {
    fn rebuild(&mut self, now: Instant) {
        let v = pages::view(&self.model, &self.catalogue, &self.look.types);
        let f = &self.look.frame;
        let shown = self.sidebar.shown(now, &self.look.tokens.motion);
        let narrow = self.sidebar.narrow();
        let main = f.view(self.size, shown, narrow, v.sidebar, v.content);
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
                    v.title,
                    self.look.types.style(Type::Subtitle, Weight::Semibold),
                )
                .lines(1),
                sidebar: if self.sidebar.open() {
                    "Hide sidebar"
                } else {
                    "Show sidebar"
                },
                back: "Back",
                forward: "Forward",
                can_back: self.at > 0,
                can_forward: self.at + 1 < self.history.len(),
            },
        );
        self.state.layout(
            &main,
            self.size,
            self.scale,
            &self.look.tokens,
            &mut self.text,
            now,
        );
        self.band.layout(
            &band,
            (self.size.0, f.band),
            self.scale,
            &self.look.tokens,
            &mut self.text,
            now,
        );
        self.band_dirty = true;
    }

    /// The two layers over the content: the blur with the window's background faded on it,
    /// and the band's buttons on their glass with the title. Painted again after a rebuild
    /// or a change of the band's hover and press.
    fn sync_layers(&mut self, window: &mut Window) -> Result<()> {
        let (Some(blur), Some(band)) = (self.blur_layer, self.band_layer) else {
            return Ok(());
        };
        if !self.band_dirty {
            return Ok(());
        }
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
        window.set_layer_material(band, glass(&self.look, &self.band_last).as_ref())?;
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

    fn publish(&mut self) -> Result<()> {
        let mut root = nk_a11y::Node::new(ROOT, nk_a11y::Role::Window, "Nidara Kit Gallery");
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
        self.revision += 1;
        match &self.a11y {
            Some(a) => a.update(self.revision, tree)?,
            None => self.a11y = Some(nk_a11y::bridge::Bridge::new(self.revision, tree)),
        }
        Ok(())
    }

    /// What an activation asks of the window or the model.
    fn activated(&mut self, a: Activated) {
        let now = Instant::now();
        let action = a.action.as_str();
        if let Some(id) = action.strip_prefix("page:") {
            if let Some(i) = PAGES.iter().position(|(p, _, _)| *p == id) {
                self.go(i);
                // Over the page, a choice closes it.
                if self.sidebar.over_content() {
                    self.toggle_sidebar(false);
                }
            }
            return;
        }
        match action {
            SIDEBAR => return self.toggle_sidebar(!self.sidebar.open()),
            BACK if self.at > 0 => {
                self.at -= 1;
                return self.show(self.history[self.at]);
            }
            FORWARD if self.at + 1 < self.history.len() => {
                self.at += 1;
                return self.show(self.history[self.at]);
            }
            BACK | FORWARD => return,
            _ => {}
        }
        // The check's control (scripts/ci/nk-gallery-check.py): the samples stop answering.
        if self.inert {
            eprintln!("CONTROL_APPLIED inert");
            return;
        }
        match action {
            "press" => self.model.presses += 1,
            "toggle" => self.model.toggle = !self.model.toggle,
            "switch" => self.model.switch = !self.model.switch,
            "reveal" => self.model.open = !self.model.open,
            "slider" => {
                if let Some(v) = self.state.value(&a.key) {
                    self.model.slider = v;
                }
            }
            "tile" => {
                if let Some(v) = self.state.value(&a.key) {
                    self.model.tile = v;
                }
            }
            _ => return,
        }
        self.rebuild(now);
    }

    fn toggle_sidebar(&mut self, open: bool) {
        let now = Instant::now();
        self.sidebar
            .set(open, now, &self.look.tokens.motion, self.reduced);
        self.sliding = true;
        self.rebuild(now);
    }

    /// A page chosen from the sidebar: a step in the history.
    fn go(&mut self, page: usize) {
        if page == self.model.page {
            return;
        }
        self.history.truncate(self.at + 1);
        self.history.push(page);
        self.at = self.history.len() - 1;
        self.show(page);
    }

    fn show(&mut self, page: usize) {
        self.model.page = page;
        self.rebuild(Instant::now());
        // A new page opens at its top.
        self.state
            .scroll_region(&CONTENT.into(), ScrollBy::Pixels(-1e9));
        self.announce = Some(PAGES[page].0);
    }

    fn place_controls(&self, window: &mut Window) -> Result<()> {
        let Some(c) = self.controls else {
            return Ok(());
        };
        let (x, y) = self.look.frame.controls_at(self.size, c);
        window.place_window_controls(x, y, !self.look.dark)
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

    fn after(&mut self, changed: bool, window: &mut Window) -> Result<()> {
        if changed {
            self.place_controls(window)?;
            self.publish()?;
        }
        if changed || self.paint_dirty {
            self.paint_dirty = false;
            self.take_frame(window)?;
            window.redraw();
        }
        if self.band_dirty {
            if self.band_layer.is_some() {
                self.sync_layers(window)?;
            } else {
                window.redraw();
                self.band_dirty = false;
            }
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
        self.side_last = self.state.lift_out(&mut self.last);
        let (Some(r), Some(f)) = (self.state.lifted_rect(), &self.side_last) else {
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
        window.set_layer_material(side, glass(&self.look, f).as_ref())?;
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

    /// The pointer over the sidebar's layer, passed on to the view in window coordinates.
    fn side_event(&mut self, event: LayerEvent) -> bool {
        let Some(r) = self.state.lifted_rect() else {
            return false;
        };
        match event {
            LayerEvent::Motion(x, y) => {
                self.pointer = Some((x + r[0], y + r[1]));
                self.state.pointer_motion(x + r[0], y + r[1])
            }
            LayerEvent::Leave => {
                self.pointer = None;
                self.state.pointer_leave()
            }
            LayerEvent::Button { pressed, .. } => {
                if let Some(a) = self.state.button(pressed, Instant::now()) {
                    self.activated(a);
                }
                true
            }
            LayerEvent::Scroll(amount) => self.state.scroll(amount.into()),
            _ => false,
        }
    }

    fn band_event(&mut self, event: LayerEvent, window: &mut Window) -> Result<bool> {
        let now = Instant::now();
        Ok(match event {
            LayerEvent::Motion(x, y) => {
                self.band_pointer = Some((x, y));
                self.state.pointer_leave();
                self.band_dirty |= self.band.pointer_motion(x, y);
                false
            }
            LayerEvent::Leave => {
                self.band_pointer = None;
                self.band_dirty |= self.band.pointer_leave();
                false
            }
            LayerEvent::Button {
                pressed: true,
                serial,
                time,
                ..
            } if self.band.hover().is_none() => {
                self.band_press(serial, time, window)?;
                false
            }
            LayerEvent::Button { pressed, .. } => {
                if let Some(a) = self.band.button(pressed, now) {
                    self.activated(a);
                    return Ok(true);
                }
                self.band_dirty = true;
                false
            }
            // The content scrolls under the band, so the wheel over it scrolls it.
            LayerEvent::Scroll(amount) => match self.band_pointer {
                Some((x, y)) => {
                    self.state.pointer_motion(x, y);
                    let moved = self.state.scroll(amount.into());
                    self.state.pointer_leave();
                    moved
                }
                None => false,
            },
            _ => false,
        })
    }
}

impl Application for Gallery {
    fn window_controls(&self) -> bool {
        true
    }
    fn poll_interval_ms(&self) -> u32 {
        let sliding = self
            .sidebar
            .animating(Instant::now(), &self.look.tokens.motion);
        if self.state.animating() || self.band.animating() || sliding {
            16
        } else {
            100
        }
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        let mut changed = false;
        let now = Instant::now();
        if self.portal.changed() {
            let a = self.portal.read()?;
            self.look = Look::load(&self.exports, &a)?;
            self.reduced = a.reduced_motion;
            self.state.set_reduced_motion(a.reduced_motion);
            self.band.set_reduced_motion(a.reduced_motion);
            self.rebuild(now);
            changed = true;
        }
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
                self.activated(a);
            }
            changed = true;
        }
        let sliding = self.sidebar.animating(now, &self.look.tokens.motion);
        if sliding || self.sliding {
            // The slide: the frame laid out again at each step, and once more at its end.
            self.rebuild(now);
            changed = true;
        }
        self.sliding = sliding;
        if self.band.animating() {
            // A hover or press fading on the band's glass.
            let ticked = self
                .band
                .tick(&self.look.tokens, &mut self.text, Instant::now());
            for a in ticked.activated {
                self.activated(a);
            }
            self.band_dirty = true;
        }
        if self.state.animating() {
            let ticked = self
                .state
                .tick(&self.look.tokens, &mut self.text, Instant::now());
            for a in ticked.activated {
                self.activated(a);
            }
            self.paint_dirty = true;
        }
        self.after(changed, window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        let now = Instant::now();
        let changed = match event {
            Event::Error(e) => return Err(e),
            Event::Configure | Event::PreferredScale(_) => {
                let (w, h) = window.size();
                self.size = (w as f64, h as f64);
                self.scale = window.scale();
                if self.band_layer.is_none() && window.supports_layers() {
                    // The blur first, so the band's buttons lie over it; the blur takes no
                    // pointer, the band takes all of its own.
                    let blur = window.create_layer((1, 1))?;
                    window.set_layer_input_region(blur, Some(&[]))?;
                    self.blur_layer = Some(blur);
                    self.band_layer = Some(window.create_layer((1, 1))?);
                    self.side_layer = Some(window.create_layer((1, 1))?);
                    // Only with a layer to draw it on: without (D5) the window paints it.
                    self.state.lift(Some(SIDE.into()));
                }
                self.sidebar.adapt(self.size.0, &self.look.frame);
                self.rebuild(now);
                true
            }
            Event::ControlsLayout(layout) => {
                self.controls = Some(layout);
                self.rebuild(now);
                true
            }
            Event::Layer { id, event } if Some(id) == self.band_layer => {
                self.band_event(event, window)?
            }
            Event::Layer { id, event } if Some(id) == self.side_layer => self.side_event(event),
            Event::Motion(x, y) => {
                self.pointer = Some((x, y));
                self.state.pointer_motion(x, y)
            }
            Event::PointerLeave => {
                self.pointer = None;
                self.state.pointer_leave()
            }
            Event::Button { pressed, .. } => {
                if let Some(a) = self.state.button(pressed, now) {
                    self.activated(a);
                }
                true
            }
            Event::Scroll(amount) => self.state.scroll(amount.into()),
            // Escape closes a sidebar open over the page.
            Event::Key(key) if key.sym == 0xff1b && self.sidebar.over_content() => {
                self.toggle_sidebar(false);
                true
            }
            // Ctrl+Page Down and Up: the pages in turn, as a notebook's tabs go.
            Event::Key(key) if key.ctrl && matches!(key.sym, 0xff55 | 0xff56) => {
                let n = PAGES.len();
                let step = if key.sym == 0xff56 { 1 } else { n - 1 };
                self.go((self.model.page + step) % n);
                true
            }
            // Alt+Left and Right: back and forward.
            Event::Key(key) if key.alt && matches!(key.sym, 0xff51 | 0xff53) => {
                let action = if key.sym == 0xff51 { BACK } else { FORWARD };
                self.activated(Activated {
                    key: "band".into(),
                    action: action.into(),
                });
                true
            }
            Event::Key(key) => match KeyInput::from_key(&key) {
                Some(k) => {
                    if let Some(a) = self.state.key(k) {
                        self.activated(a);
                    }
                    true
                }
                None => false,
            },
            Event::Focus(false) => {
                self.state.blur();
                true
            }
            _ => false,
        };
        self.after(changed, window)
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        let mut c = nk_render::Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
        if !frame.material {
            // No compositor: an opaque base of our own (D5).
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
    fn material(&self) -> Option<Material> {
        glass(&self.look, &self.last)
    }
    fn window_background(&self) -> Option<WindowBackground> {
        Some(WindowBackground {
            color: self.look.background,
            level: None,
        })
    }
    fn committed(&mut self, commit: u64) {
        if !self.ready {
            eprintln!("CONTENT_READY commit={commit}");
            self.ready = true;
        }
        if let Some(page) = self.announce.take() {
            eprintln!("PAGE {page} commit={commit}");
        }
    }
}

fn icons() -> std::result::Result<nk_icons::Icons, String> {
    let reference = std::env::var_os("NK_ICON_REFERENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let installed = PathBuf::from("/usr/share/nidara/ui/shell/assets/icons/nidara");
            if installed.is_dir() {
                installed
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara")
            }
        });
    nk_icons::Icons::new("", &[], &reference)
}

fn run() -> Result<()> {
    let start = Instant::now();
    let page = std::env::args()
        .find_map(|a| a.strip_prefix("--page=").map(str::to_owned))
        .map(|p| {
            PAGES
                .iter()
                .position(|(id, _, _)| *id == p)
                .ok_or_else(|| format!("no page {p}"))
        })
        .transpose()?
        .unwrap_or(0);
    let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    let portal = Portal::watch(&bus)?;
    let appearance = portal.read()?;
    let exports = Exports::load(&Exports::root())?;
    let look = Look::load(&exports, &appearance)?;
    let mut state = ViewState::new(ROOT as u32 + 1);
    state.set_reduced_motion(appearance.reduced_motion);
    let fonts = Arc::new(FontSet::discover_required()?);
    let gallery = Gallery {
        exports,
        portal,
        look,
        glyphs: Glyphs::new(icons()?),
        text: ParleyBackend::with_system_fonts(fonts)?,
        catalogue: Catalogue::load()?,
        model: Model {
            page,
            ..Default::default()
        },
        state,
        band: {
            let mut band = ViewState::new(BAND_ROOT as u32 + 1);
            band.set_reduced_motion(appearance.reduced_motion);
            // The band's buttons are placed by the frame, step by step as the sidebar
            // slides: they never ease on their own (VIEW.md §13.2).
            band.set_slides(false);
            band
        },
        sidebar: Sidebar::default(),
        sliding: false,
        laid_size: (0., 0.),
        history: vec![page],
        at: 0,
        blur_layer: None,
        band_layer: None,
        band_dirty: false,
        side_layer: None,
        side_last: None,
        paint_dirty: false,
        band_pointer: None,
        last_press: None,
        last: Default::default(),
        band_last: Default::default(),
        size: (0., 0.),
        scale: 1.,
        reduced: appearance.reduced_motion,
        controls: None,
        a11y: None,
        revision: 0,
        ready: false,
        announce: Some(PAGES[page].0),
        pointer: None,
        inert: std::env::var("NK_GALLERY_FAULT").as_deref() == Ok("inert"),
    };
    nk_wayland::run(
        gallery,
        Options {
            material: true,
            map: true,
            app_id: "nidara-kit-gallery",
            title: "Nidara Kit Gallery",
            size: (1100, 760),
            require_material: None,
        },
        start,
    )
}

fn main() {
    if let Err(e) = run() {
        eprintln!("nidara-kit-gallery: {e}");
        std::process::exit(1);
    }
}
