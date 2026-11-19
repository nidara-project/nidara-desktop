// SPDX-License-Identifier: LGPL-3.0-or-later
mod browser;
mod pictures;
mod request;

use browser::Browser;
use nk::{Activated, AppWindow, Glyphs, Host, HostRequest, Labels, WindowLook};
use nk_platform::{exports::Exports, portal::Portal};
use nk_text::{FontSet, ParleyBackend};
use nk_wayland::{Application, Event, Frame, Material, Options, Result, Window, WindowBackground};
use request::{Request, Response};
use std::{
    cell::RefCell,
    io::{self, Read},
    path::PathBuf,
    rc::Rc,
    sync::Arc,
};

struct Dialog {
    host: AppWindow,
    browser: Browser,
    portal: Portal,
    exports: Exports,
    answer: Rc<RefCell<Option<Response>>>,
    dirty: bool,
}

impl Dialog {
    fn commit(&mut self, window: &mut Window) -> Result<()> {
        if window.is_closed() {
            return Ok(());
        }
        if self.browser.update_pictures(&mut self.host) {
            self.dirty = true;
        }
        if std::mem::take(&mut self.dirty) {
            self.host.show(self.browser.page(&self.host));
        }
        self.host.commit(window, |host| self.browser.page(host))
    }
    fn activate(&mut self, action: Activated, window: &mut Window) -> Result<()> {
        if action.action == "cancel" {
            window.close();
        } else if let Some(result) = self.browser.activate(action)? {
            *self.answer.borrow_mut() = Some(result);
            window.close();
        } else {
            self.dirty = true;
        }
        Ok(())
    }
}

impl Application for Dialog {
    fn window_controls(&self) -> bool {
        true
    }
    fn poll_interval_ms(&self) -> u32 {
        let interval = self.host.poll_interval_ms();
        if self.browser.pending() {
            interval.min(16)
        } else {
            interval
        }
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        if self.portal.changed() {
            let appearance = self.portal.read()?;
            self.host.set_look(
                WindowLook::load(&self.exports, &appearance)?,
                appearance.reduced_motion,
            );
            self.dirty = true;
        }
        for action in self.host.idle()? {
            self.activate(action, window)?;
            if window.is_closed() {
                return Ok(());
            }
        }
        self.dirty |= self.browser.poll()?;
        self.commit(window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        if matches!(event, Event::Configure) {
            self.browser.resize(window.size().0);
            self.dirty = true;
            window.set_title(&self.browser.title)?;
            window.set_size_limits((580, 410), (0, 0))?;
        }
        if let Event::Key(key) = &event {
            if key.sym == 0xff1b {
                window.close();
                return Ok(());
            }
            let shortcut = key.ctrl && !key.alt && matches!(key.sym, 0x6c | 0x4c);
            let typed = !self.browser.location_open()
                && !key.ctrl
                && !key.alt
                && matches!(key.text.as_str(), "/" | "~");
            if shortcut || typed {
                self.browser.show_location(typed.then_some(&key.text));
                self.dirty = true;
                self.commit(window)?;
                self.host.request(HostRequest::Focus {
                    owner: "chooser/location".into(),
                });
                return self.commit(window);
            }
        }
        let enter = match &event {
            Event::Key(key) if matches!(key.sym, 0xff0d | 0xff8d) && !key.ctrl && !key.alt => {
                self.host.dialog_enter(key)
            }
            _ => None,
        };
        let default_response = enter.as_ref().is_some_and(|(handled, _)| !handled);
        let (_, actions) = match enter {
            Some(result) => result,
            None => self.host.event(event, window)?,
        };
        for action in actions {
            self.activate(action, window)?;
            if window.is_closed() {
                return Ok(());
            }
        }
        if default_response && let Some(result) = self.browser.accept()? {
            *self.answer.borrow_mut() = Some(result);
            window.close();
        }
        self.commit(window)
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        self.host.paint(frame)
    }
    fn material(&self) -> Option<Material> {
        self.host.material()
    }
    fn window_background(&self) -> Option<WindowBackground> {
        self.host.window_background()
    }
}

fn themes() -> (String, String) {
    use gio::prelude::*;
    fn setting(schema: &str, key: &str) -> Option<String> {
        let schema = gio::SettingsSchemaSource::default()?.lookup(schema, true)?;
        schema.has_key(key).then(|| {
            gio::Settings::new_full(&schema, gio::SettingsBackend::NONE, None)
                .string(key)
                .to_string()
        })
    }
    (
        setting("org.nidara.appearance", "interface-icon-theme").unwrap_or_default(),
        setting("org.gnome.desktop.interface", "icon-theme").unwrap_or_else(|| "hicolor".into()),
    )
}

fn run() -> Result<()> {
    const MAX_REQUEST: u64 = 2 * 1024 * 1024;
    let mut input = Vec::new();
    io::stdin()
        .take(MAX_REQUEST + 1)
        .read_to_end(&mut input)
        .map_err(|error| error.to_string())?;
    if input.len() as u64 > MAX_REQUEST {
        return Err("file chooser request is too large".into());
    }
    let mut spec: Request = serde_json::from_slice(&input).map_err(|error| error.to_string())?;
    let parent = std::mem::take(&mut spec.parent_window);
    let modal = spec.modal;
    let sources = nk::files::Sources::user().map_err(|error| error.to_string())?;
    let browser = Browser::new(spec, sources)?;
    let bus = zbus::blocking::Connection::session().map_err(|error| error.to_string())?;
    let portal = Portal::watch(&bus)?;
    let appearance = portal.read()?;
    let exports = Exports::load(&Exports::root())?;
    let look = WindowLook::load(&exports, &appearance)?;
    let (interface, apps) = themes();
    let reference = std::env::var_os("NK_ICON_REFERENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| "/usr/share/nidara/ui/shell/assets/icons/nidara".into());
    let mut glyphs = Glyphs::new(nk_icons::Icons::new(
        &interface,
        &nk_icons::search_path(),
        &reference,
    )?);
    glyphs.set_app_icon_theme(&apps);
    let mut host = AppWindow::new(
        look,
        Labels {
            show_sidebar: "Show places".into(),
            hide_sidebar: "Hide places".into(),
            back: "Back".into(),
            forward: "Forward".into(),
        },
        &browser.title,
        Box::new(ParleyBackend::with_system_fonts(Arc::new(
            FontSet::discover_required()?,
        ))?),
        glyphs,
        appearance.reduced_motion,
    );
    host.show(browser.page(&host));
    let answer = Rc::new(RefCell::new(None));
    let dialog = Dialog {
        host,
        browser,
        portal,
        exports,
        answer: answer.clone(),
        dirty: false,
    };
    nk_wayland::run_foreign_dialog(
        dialog,
        Options {
            material: true,
            map: true,
            app_id: "nidara-file-chooser",
            title: "Open",
            size: (940, 580),
            require_material: None,
        },
        &parent,
        modal,
    )?;
    println!(
        "{}",
        serde_json::to_string(&*answer.borrow()).map_err(|error| error.to_string())?
    );
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("nidara-file-chooser: {error}");
        std::process::exit(1);
    }
}
