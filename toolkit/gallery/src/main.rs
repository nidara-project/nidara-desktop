// SPDX-License-Identifier: LGPL-3.0-or-later
//! nk-gallery: the kit's gallery (VIEW.md §13.3, #1079), as gtk4-widget-factory is GTK's. A
//! component exists in the kit once it has a page here, in each of its states, built with the
//! kit alone. It is also the reference for an application on nk-view (§13.2): the window is
//! the kit's (`AppWindow`); the app keeps its model, builds its page from it, and acts on what
//! the window gives back.
mod dialogs;
mod files;
mod pages;

use nk::{Activated, AppWindow, BACK, FORWARD, Glyphs, Labels, Page, WindowLook};
use nk_platform::{exports::Exports, portal::Portal};
use nk_text::{FontSet, ParleyBackend};
use nk_wayland::{Application, Event, Frame, Material, Options, Result, Window, WindowBackground};
use pages::{Catalogue, Model, PAGES};
use std::{path::PathBuf, sync::Arc, time::Instant};

struct Gallery {
    exports: Exports,
    portal: Portal,
    window: AppWindow,
    catalogue: Catalogue,
    colors: Vec<(String, nk_render::Color)>,
    model: Model,
    /// The pages visited, and where in them back and forward stand.
    history: Vec<usize>,
    at: usize,
    ready: bool,
    /// A page change waiting for its first commit, which the check screenshots.
    announce: Option<&'static str>,
    inert: bool,
    fault: Option<String>,
    paste_replies: usize,
    dialog_request: Option<(nk::Key, String)>,
}

impl Gallery {
    /// The app supplies data; AppWindow owns rebuild scheduling and convergence.
    fn page(
        host: &AppWindow,
        model: &Model,
        catalogue: &Catalogue,
        colors: &[(String, nk_render::Color)],
        at: usize,
        history_len: usize,
    ) -> Page {
        let look = host.look();
        let v = pages::view(
            model,
            catalogue,
            &look.types,
            &pages::Measures {
                dropdown: &look.tokens.dropdown,
                colors,
                glyph: look.frame.icon,
                files_window: host.scroll_window(&nk::FileList::scroll_key(&model.files.key())),
                row_height: look.tokens.row_height,
                list_window: host.scroll_window(&nk::ListView::scroll_key(&"ll/live".into())),
                disabled_list_window: host
                    .scroll_window(&nk::ListView::scroll_key(&"ll/disabled".into())),
            },
        );
        Page {
            sidebar: v.sidebar,
            content: v.content,
            title: v.title.into(),
            can_back: at > 0,
            can_forward: at + 1 < history_len,
        }
    }
    fn rebuild(&mut self) {
        let page = Self::page(
            &self.window,
            &self.model,
            &self.catalogue,
            &self.colors,
            self.at,
            self.history.len(),
        );
        self.window.show(page);
    }
    fn commit(&mut self, window: &mut Window) -> Result<()> {
        let (model, catalogue, colors, at, history_len) = (
            &self.model,
            &self.catalogue,
            &self.colors,
            self.at,
            self.history.len(),
        );
        self.window.commit(window, |host| {
            Self::page(host, model, catalogue, colors, at, history_len)
        })?;
        if let Some((key, kind)) = self.dialog_request.take() {
            self.open_modal(window, key, &kind)?;
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
        if let Some(nk::Value::Index(i)) = &a.value {
            if a.key.0 == format!("sw/live/g/{i}") {
                self.model.accent = *i;
                return self.rebuild();
            }
            if a.key.0 == format!("sg/live/g/{i}") {
                self.model.size = *i;
                return self.rebuild();
            }
            if a.key.0 == format!("ck/live/r{i}/mark") {
                self.model.choice = *i;
                return self.rebuild();
            }
        }
        if let Some(id) = action.strip_prefix("win-side:") {
            self.model.window_side = id.into();
            return self.rebuild();
        }
        if action.starts_with("files-") {
            self.model.files.activate(a);
            self.rebuild();
            return;
        }
        match action {
            "dialog-open" | "alert-open" | "alert-delete" | "dialog-invalid" | "font-open" => {
                self.dialog_request = Some((a.key, action.to_owned()));
                return;
            }
            "list-select" => {
                if let Some(nk::Value::Index(index)) = a.value {
                    self.model.selected_row = index;
                }
            }
            "list-open" => {
                self.model.list_opened += 1;
            }
            "entry-edit" => {
                if let Some(nk::Value::Text(text)) = a.value {
                    self.model.entry = text;
                }
            }
            "search-edit" => {
                if let Some(nk::Value::Text(text)) = a.value {
                    self.model.search = text;
                }
            }
            "entry-submit" | "search-submit" => self.model.submitted += 1,
            "press" => self.model.presses += 1,
            "check" => self.model.check = !self.model.check,
            "row-open" => self.model.opened += 1,
            "row-flip" => self.model.row_on = !self.model.row_on,
            "profile-select" => {
                if let Some(nk::Value::Index(index)) = a.value {
                    self.model.profile = index;
                }
            }
            "toggle" => self.model.toggle = !self.model.toggle,
            "switch" => self.model.switch = !self.model.switch,
            "reveal" => self.model.open = !self.model.open,
            "disclosure" => {
                if let Some(nk::Value::Bool(expanded)) = a.value {
                    self.model.expanded = expanded;
                }
            }
            "slider" => {
                if let Some(v) = a.value.as_ref().and_then(nk::Value::number) {
                    self.model.slider = v;
                }
            }
            "speed" => {
                if let Some(v) = a.value.as_ref().and_then(nk::Value::number) {
                    self.model.speed = v as usize;
                }
            }
            "bright" => {
                if let Some(v) = a.value.as_ref().and_then(nk::Value::number) {
                    self.model.bright = v;
                }
            }
            "tile" => {
                if let Some(v) = a.value.as_ref().and_then(nk::Value::number) {
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
        if PAGES[page].0 == "files" {
            self.window.set_app_icon_theme(&app_icon_theme());
            self.model.files.start();
        }
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
        let interval = self.window.poll_interval_ms();
        if PAGES[self.model.page].0 == "files" && self.model.files.loading() {
            interval.min(16)
        } else {
            interval
        }
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
        if PAGES[self.model.page].0 == "files" && self.model.files.poll() {
            self.rebuild();
        }
        self.commit(window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        if pages::PAGES[self.model.page].0 == "entry" {
            if matches!(&event, Event::PasteReply { .. }) {
                self.paste_replies += 1;
            }
            let drop = match (&event, self.fault.as_deref()) {
                (Event::Key(k), Some("editor-no-keyboard")) => !k.ctrl && !k.text.is_empty(),
                (Event::Ime(_), Some("editor-no-ime")) => true,
                (Event::Ime(b), Some("editor-no-replace")) => {
                    b.preedit.as_ref().is_some_and(|p| p.0 == "日本語")
                }
                (Event::Ime(b), Some("editor-no-cancel")) => {
                    b.commit.is_none()
                        && b.delete.is_none()
                        && b.preedit.as_ref().is_none_or(|p| p.0.is_empty())
                }
                (Event::Ime(b), Some("editor-no-commit")) => b.commit.is_some(),
                (Event::Key(k), Some("editor-no-select")) => k.ctrl && matches!(k.sym, 0x61 | 0x41),
                (Event::Key(k), Some("editor-no-copy")) => k.ctrl && matches!(k.sym, 0x63 | 0x43),
                (Event::Key(k), Some("editor-no-cut")) => k.ctrl && matches!(k.sym, 0x78 | 0x58),
                (Event::PasteReply { .. }, Some("editor-no-paste")) => self.paste_replies > 1,
                (Event::Key(k), Some("editor-no-undo")) => {
                    k.ctrl && !k.shift && matches!(k.sym, 0x7a | 0x5a)
                }
                (Event::Key(k), Some("editor-no-redo")) => {
                    k.ctrl && k.shift && matches!(k.sym, 0x7a | 0x5a)
                }
                _ => false,
            };
            if drop {
                eprintln!("CONTROL_APPLIED {}", self.fault.as_deref().unwrap_or(""));
                return self.commit(window);
            }
        }
        // Ctrl+Page Down and Up: the pages in turn, as a notebook's tabs go.
        if let Event::Key(key) = &event
            && key.ctrl
            && matches!(key.sym, 0xff55 | 0xff56)
        {
            let n = PAGES.len();
            let step = if key.sym == 0xff56 { 1 } else { n - 1 };
            self.go((self.model.page + step) % n);
            return self.commit(window);
        }
        let (_, activated) = self.window.event(event, window)?;
        for a in activated {
            self.activated(a);
        }
        self.commit(window)
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

fn app_icon_theme() -> String {
    use gio::prelude::*;
    gio::SettingsSchemaSource::default()
        .and_then(|src| src.lookup("org.gnome.desktop.interface", true))
        .filter(|schema| schema.has_key("icon-theme"))
        .map_or_else(
            || "hicolor".into(),
            |_| {
                gio::Settings::new("org.gnome.desktop.interface")
                    .string("icon-theme")
                    .to_string()
            },
        )
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
    let colors = pages::colors_from(&exports.colors)?;
    let mut gallery = Gallery {
        colors,
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
        fault: std::env::var("NK_GALLERY_FAULT").ok(),
        paste_replies: 0,
        dialog_request: None,
    };
    if PAGES[page].0 == "files" {
        gallery.window.set_app_icon_theme(&app_icon_theme());
        gallery.model.files.start();
    }
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
