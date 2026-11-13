// SPDX-License-Identifier: LGPL-3.0-or-later
//! nk-gallery: the kit's gallery (VIEW.md §13.3, #1079), as gtk4-widget-factory is GTK's. A
//! component exists in the kit once it has a page here, in each of its states, built with the
//! kit alone. It is also the reference for an application on nk-view (§13.2): the window is
//! the kit's (`AppWindow`); the app keeps its model, builds its page from it, and acts on what
//! the window gives back.
mod pages;

use nk_platform::{exports::Exports, portal::Portal};
use nk_text::{FontSet, ParleyBackend};
use nk_view::{Activated, AppWindow, BACK, FORWARD, Glyphs, Labels, Page, WindowLook};
use nk_wayland::{Application, Event, Frame, Material, Options, Result, Window, WindowBackground};
use pages::{Catalogue, Model, PAGES};
use std::{path::PathBuf, sync::Arc, time::Instant};

struct Gallery {
    exports: Exports,
    portal: Portal,
    window: AppWindow,
    catalogue: Catalogue,
    model: Model,
    /// The pages visited, and where in them back and forward stand.
    history: Vec<usize>,
    at: usize,
    ready: bool,
    /// A page change waiting for its first commit, which the check screenshots.
    announce: Option<&'static str>,
    inert: bool,
}

impl Gallery {
    /// The page the model shows, for the window.
    fn rebuild(&mut self) {
        let look = self.window.look();
        let v = pages::view(
            &self.model,
            &self.catalogue,
            &look.types,
            &pages::Measures {
                slider: &look.tokens.slider,
                dropdown: &look.tokens.dropdown,
                segmented: &look.tokens.segmented,
                glyph: look.frame.icon,
            },
        );
        self.window.show(Page {
            sidebar: v.sidebar,
            content: v.content,
            title: v.title.into(),
            can_back: self.at > 0,
            can_forward: self.at + 1 < self.history.len(),
        });
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
        match action {
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
        if let Some(i) = action.strip_prefix("size:").and_then(|i| i.parse().ok()) {
            self.model.size = i;
            return self.rebuild();
        }
        if let Some(i) = action.strip_prefix("choice:").and_then(|i| i.parse().ok()) {
            self.model.choice = i;
            return self.rebuild();
        }
        match action {
            "press" => self.model.presses += 1,
            "check" => self.model.check = !self.model.check,
            "row-open" => self.model.opened += 1,
            "row-flip" => self.model.row_on = !self.model.row_on,
            "toggle" => self.model.toggle = !self.model.toggle,
            "switch" => self.model.switch = !self.model.switch,
            "reveal" => self.model.open = !self.model.open,
            "slider" => {
                if let Some(v) = self.window.value(&a.key) {
                    self.model.slider = v;
                }
            }
            "speed" => {
                if let Some(v) = self.window.value(&a.key) {
                    self.model.speed = v as usize;
                }
            }
            "bright" => {
                if let Some(v) = self.window.value(&a.key) {
                    self.model.bright = v;
                }
            }
            "tile" => {
                if let Some(v) = self.window.value(&a.key) {
                    self.model.tile = v;
                }
            }
            _ => return,
        }
        self.rebuild();
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
        self.rebuild();
        // A new page opens at its top.
        self.window.to_top();
        self.announce = Some(PAGES[page].0);
    }
}

impl Application for Gallery {
    fn window_controls(&self) -> bool {
        true
    }
    fn poll_interval_ms(&self) -> u32 {
        self.window.poll_interval_ms()
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        if self.portal.changed() {
            let a = self.portal.read()?;
            self.window
                .set_look(WindowLook::load(&self.exports, &a)?, a.reduced_motion);
            self.rebuild();
        }
        for a in self.window.idle()? {
            self.activated(a);
        }
        self.window.commit(window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        // Ctrl+Page Down and Up: the pages in turn, as a notebook's tabs go.
        if let Event::Key(key) = &event
            && key.ctrl
            && matches!(key.sym, 0xff55 | 0xff56)
        {
            let n = PAGES.len();
            let step = if key.sym == 0xff56 { 1 } else { n - 1 };
            self.go((self.model.page + step) % n);
            return self.window.commit(window);
        }
        let (_, activated) = self.window.event(event, window)?;
        for a in activated {
            self.activated(a);
        }
        self.window.commit(window)
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        self.window.paint(frame)
    }
    fn material(&self) -> Option<Material> {
        self.window.material()
    }
    fn window_background(&self) -> Option<WindowBackground> {
        self.window.window_background()
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
    let look = WindowLook::load(&exports, &appearance)?;
    let fonts = Arc::new(FontSet::discover_required()?);
    let window = AppWindow::new(
        look,
        Labels {
            show_sidebar: "Show sidebar".into(),
            hide_sidebar: "Hide sidebar".into(),
            back: "Back".into(),
            forward: "Forward".into(),
        },
        "Nidara Kit Gallery",
        Box::new(ParleyBackend::with_system_fonts(fonts)?),
        Glyphs::new(icons()?),
        appearance.reduced_motion,
    );
    let mut gallery = Gallery {
        exports,
        portal,
        window,
        catalogue: Catalogue::load()?,
        model: Model {
            page,
            ..Default::default()
        },
        history: vec![page],
        at: 0,
        ready: false,
        announce: Some(PAGES[page].0),
        inert: std::env::var("NK_GALLERY_FAULT").as_deref() == Ok("inert"),
    };
    gallery.rebuild();
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
