// SPDX-License-Identifier: LGPL-3.0-or-later
//! Uninstalled AppWindow entry, alongside the old nk-settings window (#1103 7a).
use nk_settings::{client::Client, exports::Exports, portal::Portal, view_settings::Model};
use nk_text::{FontSet, ParleyBackend};
use nk_view::{AppWindow, Glyphs, Labels, WindowLook};
use nk_wayland::{Application, Event, Frame, Material, Options, Result, Window, WindowBackground};
use std::{path::PathBuf, sync::Arc, time::Instant};
struct Settings {
    exports: Exports,
    portal: Portal,
    client: Client,
    model: Model,
    host: AppWindow,
    pointer_down: bool,
    ready: bool,
    dirty: bool,
}
impl Settings {
    fn commit(&mut self, window: &mut Window) -> Result<()> {
        self.model.reconcile(&self.exports, self.client.session());
        let (m, e, s) = (&self.model, &self.exports, self.client.session());
        if self.dirty {
            self.host.show(m.page(&self.host, s, e)?);
            self.dirty = false;
        }
        // Build errors are checked above; the same immutable input is used for host retries.
        self.host.commit(window, |host| {
            m.page(host, s, e).expect("validated manifest page")
        })?;
        Ok(())
    }
    fn actions(&mut self, actions: Vec<nk_view::Activated>) -> Result<()> {
        self.dirty |= !actions.is_empty();
        for a in actions {
            let dragging = self.pointer_down && self.host.captured() == Some(&a.key);
            if self
                .model
                .activate(a, dragging, &mut self.client, &self.exports, Instant::now())?
            {
                self.host.to_top();
            }
        }
        Ok(())
    }
}
impl Application for Settings {
    fn window_controls(&self) -> bool {
        true
    }
    fn poll_interval_ms(&self) -> u32 {
        self.model
            .poll_interval_ms(Instant::now(), self.host.poll_interval_ms())
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        let notices = self.client.poll();
        self.model.notices(&notices, &self.exports)?;
        if !notices.is_empty() {
            self.dirty = true;
            self.host.cancel_menu();
            self.commit(window)?;
        }
        if self.portal.changed() {
            self.dirty = true;
            let appearance = self.portal.read()?;
            self.host.set_look(
                WindowLook::load(&self.exports, &appearance)?,
                appearance.reduced_motion,
            );
        }
        let actions = self.host.idle()?;
        self.actions(actions)?;
        self.dirty |= self
            .model
            .flush(&mut self.client, &self.exports, Instant::now())?;
        self.commit(window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        if let Event::Button {
            button: 0x110,
            pressed,
            ..
        } = &event
        {
            self.pointer_down = *pressed;
        }
        let notices = self.client.poll();
        self.model.notices(&notices, &self.exports)?;
        if !notices.is_empty() {
            self.dirty = true;
            self.host.cancel_menu();
            self.commit(window)?;
        }
        let (_, actions) = self.host.event(event, window)?;
        self.actions(actions)?;
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
    fn committed(&mut self, commit: u64) {
        if !self.ready {
            eprintln!("SETTINGS_VIEW_READY commit={commit}");
            self.ready = true;
        }
    }
}
fn run() -> Result<()> {
    let start = Instant::now();
    let exports = Exports::load(&Exports::root())?;
    let catalogue = Exports::load(&Exports::root())?;
    nk_settings::session::set_translator(Box::new(move |key| {
        catalogue.text(key).ok().map(str::to_owned)
    }));
    let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    bus.request_name_with_flags(
        nk_settings::routing::NATIVE,
        zbus::fdo::RequestNameFlags::DoNotQueue.into(),
    )
    .map_err(|e| e.to_string())?;
    let portal = Portal::watch(&bus)?;
    let appearance = portal.read()?;
    let client = Client::start(bus)?;
    let look = WindowLook::load(&exports, &appearance)?;
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
    let title = exports.text("settings.native.application")?.to_owned();
    let labels = Labels {
        show_sidebar: exports.text("settings.window.sidebar-toggle")?.to_owned(),
        hide_sidebar: exports.text("settings.window.sidebar-toggle")?.to_owned(),
        back: exports.text("settings.nav.back")?.to_owned(),
        forward: exports.text("settings.nav.forward")?.to_owned(),
    };
    let host = AppWindow::new(
        look,
        labels,
        title.as_str(),
        Box::new(ParleyBackend::with_system_fonts(Arc::new(
            FontSet::discover_required()?,
        ))?),
        Glyphs::new(nk_icons::Icons::new("", &[], &reference)?),
        appearance.reduced_motion,
    );
    let size = nk_settings::exports::open_size(&exports)?;
    let mut settings = Settings {
        exports,
        portal,
        client,
        model: Model::default(),
        host,
        pointer_down: false,
        ready: false,
        dirty: true,
    };
    settings.host.show(settings.model.page(
        &settings.host,
        settings.client.session(),
        &settings.exports,
    )?);
    nk_wayland::run(
        settings,
        Options {
            material: true,
            map: true,
            app_id: "nidara-settings-view",
            title: Box::leak(title.to_owned().into_boxed_str()),
            size,
            require_material: None,
        },
        start,
    )
}
fn main() {
    if let Err(error) = run() {
        eprintln!("SETTINGS_VIEW_ERROR {error}");
        std::process::exit(1);
    }
}
