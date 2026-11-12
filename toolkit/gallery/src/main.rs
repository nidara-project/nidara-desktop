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
use nk_view::{Activated, Glyphs, Key, KeyInput, Node, ScrollBy, Tokens, TypeScale, ViewState};
use nk_wayland::{
    Application, ControlsSide, Event, Frame, Material, Options, Result, Window, WindowBackground,
};
use pages::{Catalogue, Model, PAGES};
use std::{path::PathBuf, sync::Arc, time::Instant};

/// Where the window's own semantic ids start; 1 is the window.
const ROOT: u64 = 1;
/// The key whose place the window controls take, at the sidebar's top.
const CONTROLS: &str = "side/controls";

/// What the window paints with in one appearance.
struct Look {
    tokens: Tokens,
    types: TypeScale,
    panel: PanelMaterial,
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
    fn view(&self) -> Node {
        let mut v = pages::view(&self.model, &self.catalogue, &self.look.types);
        // The window controls' room: as tall as Hyalo says they are, at the sidebar's top.
        if let (Some(c), nk_view::Kind::Stack(root)) = (self.controls, &mut v.kind)
            && let Some(side) = root.children.first_mut()
            && let nk_view::Kind::Pane(p) = &mut side.kind
            && let nk_view::Kind::Stack(list) = &mut p.child.kind
        {
            list.children.insert(
                0,
                Node::row(CONTROLS, vec![Node::slot("side/controls/room", c.height)]),
            );
        }
        v
    }

    fn rebuild(&mut self) {
        let view = self.view();
        self.state.layout(
            &view,
            self.size,
            self.scale,
            &self.look.tokens,
            &mut self.text,
            Instant::now(),
        );
    }

    fn publish(&mut self) -> Result<()> {
        let mut root = nk_a11y::Node::new(ROOT, nk_a11y::Role::Window, "Nidara kit gallery");
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
            .scroll_region(&Key::from("content"), ScrollBy::Pixels(-1e9));
        self.announce = Some(PAGES[page].0);
    }

    fn place_controls(&self, window: &mut Window) -> Result<()> {
        let (Some(c), Some(r)) = (self.controls, self.state.rect(&Key::from(CONTROLS))) else {
            return Ok(());
        };
        let pad = self.look.tokens.spacing.px(nk_view::Space::S2);
        let x = match c.side {
            ControlsSide::Left => r[0] + pad,
            ControlsSide::Right => r[0] + r[2] - c.width - pad,
        };
        window.place_window_controls(x, r[1], !self.look.dark)
    }

    fn after(&mut self, changed: bool, window: &mut Window) -> Result<()> {
        if changed {
            self.place_controls(window)?;
            self.publish()?;
            window.redraw();
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
            Event::Button {
                pressed, serial, ..
            } => {
                // A press on the controls' row, off any control, moves the window.
                let on_bar = self.state.hover().is_none()
                    && self.state.rect(&Key::from(CONTROLS)).is_some_and(|r| {
                        self.pointer.is_some_and(|(x, y)| {
                            x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]
                        })
                    });
                if pressed && on_bar {
                    window.move_from_pointer_press(serial)?;
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
            app_id: "nk-gallery",
            title: "Nidara kit gallery",
            size: (1100, 760),
            require_material: None,
        },
        start,
    )
}

fn main() {
    if let Err(e) = run() {
        eprintln!("nk-gallery: {e}");
        std::process::exit(1);
    }
}
