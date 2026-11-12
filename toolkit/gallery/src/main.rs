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
    Activated, FrameStyle, Glyphs, KeyInput, Node, ScrollBy, Space, Tokens, Type, TypeScale,
    ViewState, Weight,
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
    /// The header band's title, laid out on its own: it is painted into the band's layer,
    /// over the content and under Hyalo's graded blur.
    header: ViewState,
    header_layer: Option<LayerId>,
    header_dirty: bool,
    /// The pointer over the band, in the window, and the last press there (a second one
    /// within the double-click time toggles maximised).
    header_pointer: Option<(f64, f64)>,
    last_press: Option<u32>,
    last: nk_view::Frame,
    size: (f64, f64),
    scale: f64,
    controls: Option<nk_wayland::ControlsLayout>,
    a11y: Option<nk_a11y::bridge::Bridge>,
    revision: u64,
    ready: bool,
    /// A page change waiting for its first commit, which the check screenshots.
    announce: Option<&'static str>,
    pointer: Option<(f64, f64)>,
    inert: bool,
}

impl Gallery {
    fn view(&self) -> (Node, Node) {
        let v = pages::view(&self.model, &self.catalogue, &self.look.types);
        let f = &self.look.frame;
        let lead = self.look.tokens.spacing.px(Space::S6);
        // Laid out in the band's layer, or in the window when there is no layer (D5).
        let (width, origin) = if self.header_layer.is_some() {
            (f.header_rect(self.size)[2], 0.)
        } else {
            (self.size.0, f.sidebar)
        };
        let title = Node::text(
            "header/title",
            v.title,
            self.look.types.style(Type::Subtitle, Weight::Semibold),
        )
        .lines(1);
        (
            f.view(self.size, v.sidebar, v.content),
            f.header((width, f.band), origin, lead, self.controls, title),
        )
    }

    fn rebuild(&mut self) {
        let (view, header) = self.view();
        let now = Instant::now();
        self.state.layout(
            &view,
            self.size,
            self.scale,
            &self.look.tokens,
            &mut self.text,
            now,
        );
        // The band's height: the layer below it is the blur's fade, with nothing in it.
        let f = &self.look.frame;
        let size = if self.header_layer.is_some() {
            (f.header_rect(self.size)[2], f.band)
        } else {
            (self.size.0, f.band)
        };
        self.header.layout(
            &header,
            size,
            self.scale,
            &self.look.tokens,
            &mut self.text,
            now,
        );
        self.header_dirty = true;
    }

    /// The band's layer: where it lies, its graded blur, and the faded background with the
    /// title over it. Painted again only after a rebuild.
    fn sync_header(&mut self, window: &mut Window) -> Result<()> {
        let Some(id) = self.header_layer else {
            return Ok(());
        };
        if !self.header_dirty {
            return Ok(());
        }
        let f = &self.look.frame;
        let r = f.header_rect(self.size);
        let size = (r[2].ceil() as u32, r[3].ceil() as u32);
        window.set_position(id, r[0], r[1])?;
        window.set_layer_size(id, size)?;
        window.set_layer_blur(
            id,
            f.blur,
            &f.graded(size.0 as f64, size.1 as f64, window.scale()),
        )?;
        let (header, tokens, glyphs, background) = (
            &self.header,
            &self.look.tokens,
            &mut self.glyphs,
            self.look.background,
        );
        let painted = window.paint_layer(id, |frame| {
            let mut c = nk_render::Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
            f.paint_fade(
                &mut c,
                [0., 0., frame.width as f64, frame.height as f64],
                background,
            );
            header.paint(&mut c, tokens, &mut |n, s| glyphs.get(n, s), None)?;
            Ok(c.finish())
        })?;
        // Both buffers busy: tried again on the next turn.
        self.header_dirty = !painted;
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
        let tree = self.state.semantics(root, ROOT + 1);
        self.revision += 1;
        match &self.a11y {
            Some(a) => a.update(self.revision, tree)?,
            None => self.a11y = Some(nk_a11y::bridge::Bridge::new(self.revision, tree)),
        }
        Ok(())
    }

    /// What an activation asks of the model.
    fn activated(&mut self, a: Activated) {
        let action = a.action.as_str();
        if let Some(id) = action.strip_prefix("page:") {
            if let Some(i) = PAGES.iter().position(|(p, _, _)| *p == id) {
                self.go(i);
            }
            return;
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
        self.rebuild();
    }

    fn go(&mut self, page: usize) {
        if page == self.model.page {
            return;
        }
        self.model.page = page;
        self.rebuild();
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
            window.redraw();
        }
        if self.header_dirty {
            self.sync_header(window)?;
        }
        Ok(())
    }
}

impl Application for Gallery {
    fn window_controls(&self) -> bool {
        true
    }
    fn poll_interval_ms(&self) -> u32 {
        if self.state.animating() { 16 } else { 100 }
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        let mut changed = false;
        if self.portal.changed() {
            let a = self.portal.read()?;
            self.look = Look::load(&self.exports, &a)?;
            self.state.set_reduced_motion(a.reduced_motion);
            self.rebuild();
            changed = true;
        }
        if let Some(a) = &self.a11y {
            a.check()?;
        }
        while let Some((_, request)) = self.a11y.as_ref().and_then(|a| a.requests.try_recv().ok()) {
            let keys = self.state.semantic_keys();
            let activated = match request {
                Request::Focus(id) => keys.get(&id).and_then(|k| self.state.request(k, false)),
                Request::Activate(id) => keys.get(&id).and_then(|k| self.state.request(k, true)),
                Request::SetValue(id, v) => {
                    keys.get(&id).and_then(|k| self.state.request_value(k, v))
                }
                _ => None,
            };
            if let Some(a) = activated {
                self.activated(a);
            }
            changed = true;
        }
        if self.state.animating() {
            let ticked = self
                .state
                .tick(&self.look.tokens, &mut self.text, Instant::now());
            for a in ticked.activated {
                self.activated(a);
            }
            window.redraw();
        }
        self.after(changed, window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        let changed = match event {
            Event::Error(e) => return Err(e),
            Event::Configure | Event::PreferredScale(_) => {
                let (w, h) = window.size();
                self.size = (w as f64, h as f64);
                self.scale = window.scale();
                if self.header_layer.is_none() && window.supports_layers() {
                    let r = self.look.frame.header_rect(self.size);
                    self.header_layer =
                        Some(window.create_layer((r[2].ceil() as u32, r[3].ceil() as u32))?);
                }
                self.rebuild();
                true
            }
            Event::ControlsLayout(layout) => {
                self.controls = Some(layout);
                self.rebuild();
                true
            }
            Event::Motion(x, y) => {
                self.pointer = Some((x, y));
                self.state.pointer_motion(x, y)
            }
            Event::PointerLeave => {
                self.pointer = None;
                self.state.pointer_leave()
            }
            Event::Layer { id, event } if Some(id) == self.header_layer => {
                let r = self.look.frame.header_rect(self.size);
                match event {
                    LayerEvent::Motion(x, y) => {
                        self.header_pointer = Some((x + r[0], y + r[1]));
                        self.state.pointer_leave()
                    }
                    LayerEvent::Leave => {
                        self.header_pointer = None;
                        false
                    }
                    LayerEvent::Button {
                        pressed: true,
                        serial,
                        time,
                        ..
                    } => {
                        self.band_press(serial, time, window)?;
                        false
                    }
                    // The content scrolls under the band, so the wheel over it scrolls it.
                    LayerEvent::Scroll(amount) => match self.header_pointer {
                        Some((x, y)) => {
                            self.state.pointer_motion(x, y);
                            let moved = self.state.scroll(amount.into());
                            self.state.pointer_leave();
                            moved
                        }
                        None => false,
                    },
                    _ => false,
                }
            }
            Event::Button {
                pressed,
                serial,
                time,
                ..
            } => {
                // A press on the band over the sidebar, off any control, is the band's.
                let on_band = self.state.hover().is_none()
                    && self
                        .pointer
                        .is_some_and(|(x, y)| self.look.frame.on_band(x, y));
                if pressed && on_band {
                    self.band_press(serial, time, window)?;
                    false
                } else {
                    if let Some(a) = self.state.button(pressed, Instant::now()) {
                        self.activated(a);
                    }
                    true
                }
            }
            Event::Scroll(amount) => self.state.scroll(amount.into()),
            // Ctrl+Page Down and Up: the pages in turn, as a notebook's tabs go.
            Event::Key(key) if key.ctrl && matches!(key.sym, 0xff55 | 0xff56) => {
                let n = PAGES.len();
                let step = if key.sym == 0xff56 { 1 } else { n - 1 };
                self.go((self.model.page + step) % n);
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
        self.last = self.state.frame(&self.look.tokens, Instant::now());
        let glyphs = &mut self.glyphs;
        self.state.paint(
            &mut c,
            &self.look.tokens,
            &mut |name, size| glyphs.get(name, size),
            (!frame.material).then_some(&self.last),
        )?;
        if self.header_layer.is_none() {
            // No layers (D5): the band in the window itself, over the content.
            let f = &self.look.frame;
            let r = f.header_rect(self.size);
            let opaque = FrameStyle {
                opaque: true,
                ..f.clone()
            };
            opaque.paint_fade(&mut c, [r[0], 0., r[2], f.band], self.look.background);
            self.header.paint(
                &mut c,
                &self.look.tokens,
                &mut |name, size| glyphs.get(name, size),
                None,
            )?;
        }
        Ok(c.finish())
    }
    fn material(&self) -> Option<Material> {
        let base = self.look.panel.at(0.).ok()?;
        // Each card's glass in its own step of the panel material, by its short side.
        let groups = self
            .last
            .groups(base.tone, base.shadow)
            .into_iter()
            .map(|mut g| {
                let side = g
                    .shapes
                    .iter()
                    .map(|s| s.width.min(s.height))
                    .fold(f64::INFINITY, f64::min);
                if let Ok(m) = self.look.panel.at(side) {
                    g.tone = m.tone;
                    g.shadow = m.shadow;
                }
                g
            })
            .collect();
        Some(Material {
            groups,
            states: self.last.states.clone(),
            ..base
        })
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
        header: ViewState::new(1_000_000),
        header_layer: None,
        header_dirty: false,
        header_pointer: None,
        last_press: None,
        last: Default::default(),
        size: (0., 0.),
        scale: 1.,
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
