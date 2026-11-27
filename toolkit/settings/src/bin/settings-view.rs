// SPDX-License-Identifier: LGPL-3.0-or-later
//! Uninstalled AppWindow entry, alongside the old nk-settings window (#1103 7a).
use nk::{AppWindow, Glyphs, Labels, WindowLook};
use nk_settings::{client::Client, exports::Exports, portal::Portal, view_settings::Model};
use nk_text::{FontSet, ParleyBackend};
use nk_wayland::{Application, Event, Frame, Material, Options, Result, Window, WindowBackground};
use std::{collections::HashMap, path::PathBuf, sync::Arc, time::Instant};
struct Settings {
    exports: Exports,
    portal: Portal,
    client: Client,
    model: Model,
    host: AppWindow,
    pointer_down: bool,
    display_tokens: HashMap<nk_wayland::TokenRequest, nk::Activated>,
    network_tokens: HashMap<nk_wayland::TokenRequest, nk::Activated>,
    ready: bool,
    dirty: bool,
    /// The page shown last: arriving on a page is what asks its slow facts again.
    shown: Option<String>,
    bus: zbus::blocking::Connection,
    /// The system menu's icon being chosen in the portal's file chooser.
    chooser: nk_settings::file_chooser::Chooser,
    choosing: u64,
}
impl Settings {
    fn commit(&mut self, window: &mut Window) -> Result<()> {
        self.model.reconcile(&self.exports, self.client.session());
        let selected = self.model.selected().map(str::to_owned);
        if selected != self.shown {
            if self.shown.as_deref() == Some("display") {
                // Closing this dedicated Display1 connection also releases any preview.
                self.model.display = Default::default();
            }
            if self.shown.as_deref() == Some(nk_settings::audio::PAGE) {
                self.model.audio = Default::default();
            }
            if self.shown.as_deref() == Some("display") {
                for (request, _) in self.display_tokens.drain() {
                    window.cancel_activation_token(request);
                }
            }
            if self.shown.as_deref() == Some(nk_settings::network::PAGE) {
                for (request, _) in self.network_tokens.drain() {
                    window.cancel_activation_token(request);
                }
                self.model.network = Default::default();
            }
            match selected.as_deref() {
                Some(nk_settings::network::PAGE) => self.model.network.visit(),
                Some(nk_settings::audio::PAGE) => self.model.audio.visit(),
                Some("display") => self.model.display.visit(),
                Some("about") => self.model.about.visit(),
                _ => {}
            }
            self.shown = selected;
            self.dirty = true;
        }
        if self.dirty {
            let s = self.client.session();
            if let Some(theme) = s.shown("appearance.iconTheme").and_then(|v| v.as_text()) {
                self.host.set_app_icon_theme(theme);
            }
            if self.model.selected() == Some(nk_settings::bar::PAGE) {
                self.host.set_pictures(self.model.bar_pictures.current(s));
            }
        }
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
    fn actions(
        &mut self,
        actions: Vec<nk::Activated>,
        window: &mut Window,
        serial: Option<u32>,
    ) -> Result<()> {
        self.dirty |= !actions.is_empty();
        for a in actions {
            let launcher = a.key.clone();
            let dragging = self.pointer_down && self.host.captured() == Some(&a.key);
            if self.model.selected() == Some("display") && a.action == "display:apply" {
                let target = Some(nk_platform::SESSION_PROMPT_APP_ID);
                let token = match serial {
                    Some(serial) => window.request_activation_token(serial, target),
                    None => window.request_focused_activation_token(target),
                };
                if let Ok(request) = token {
                    self.display_tokens.insert(request, a);
                    continue;
                }
            }
            if self.model.display_action(&a, dragging, &self.host, None)
                || self.model.selected() == Some(nk_settings::audio::PAGE)
                    && self.model.audio.activate(&a, dragging)
            {
                continue;
            }
            if self.model.selected() == Some(nk_settings::network::PAGE) {
                if nk_settings::network::Network::may_prompt(&a)
                    && let Some(serial) = serial
                    && let Ok(request) = window
                        .request_activation_token(serial, Some(nk_platform::SESSION_PROMPT_APP_ID))
                {
                    self.network_tokens.insert(request, a);
                    continue;
                }
                if self.model.network.activate(&a, &self.exports, None) {
                    continue;
                }
            }
            if self
                .model
                .activate(a, dragging, &mut self.client, &self.exports, Instant::now())?
            {
                self.host.to_top();
            }
            if let Some((key, initial)) = self.model.take_font_request() {
                self.choose_font(window, &launcher, &key, initial)?;
            }
            if self.model.take_icon_request() {
                self.choose_icon()?;
            }
        }
        Ok(())
    }
    /// The system menu's icon, from the portal's file chooser; the model writes the answer.
    fn choose_icon(&mut self) -> Result<()> {
        use nk_settings::file_chooser::{Open, Operation, StartError};
        let e = &self.exports;
        self.choosing += 1;
        let open = Open {
            parent: String::new(),
            title: e.text("settings.bar.change-icon")?.to_owned(),
            images_label: e.text("settings.bar.icon-custom")?.to_owned(),
            mimes: nk_settings::bar::ICON_IMAGES,
            current_folder: None,
        };
        match self.chooser.start(
            &self.bus,
            Operation {
                mount: 1,
                request: self.choosing,
            },
            open,
        ) {
            // One chooser at a time: a second press while it is open does nothing.
            Ok(()) | Err(StartError::Busy) => Ok(()),
            Err(StartError::Failed(e)) => Err(e),
        }
    }
    fn chosen_icon(&mut self) -> Result<()> {
        let current = nk_settings::file_chooser::Operation {
            mount: 1,
            request: self.choosing,
        };
        match self.chooser.poll(current) {
            Some(Ok(Some(path))) => {
                self.model
                    .icon_chosen(&path, &mut self.client, &self.exports)?;
                self.dirty = true;
            }
            Some(Ok(None)) | None => {}
            Some(Err(e)) => eprintln!("nidara-settings-view: the icon chooser failed: {e}"),
        }
        Ok(())
    }
    /// A font row's dialog, modal over the window; its answer is written by the model.
    fn choose_font(
        &mut self,
        window: &mut Window,
        launcher: &nk::Key,
        key: &str,
        initial: nk::FontChoice,
    ) -> Result<()> {
        let e = &self.exports;
        let t = |k: &str| e.text(k).map(str::to_owned);
        let title = if key == "appearance.monoFont" {
            "settings.appearance.mono-font"
        } else {
            "settings.appearance.interface-font"
        };
        let labels = nk::FontDialogLabels {
            title: t(title)?,
            close: t("settings.window.close")?,
            cancel: t("settings.native.cancel")?,
            choose: t("settings.native.select")?,
            search: t("settings.native.font.search")?,
            clear_search: t("settings.native.font.clear")?,
            family: t("settings.native.font.families")?,
            style: t("settings.native.font.styles")?,
            size: t("settings.native.font.points")?,
            no_matches: t("settings.native.font.none")?,
            sample: t("settings.native.font.preview")?,
        };
        let (portal, model, client) = (&self.portal, &self.model, &self.client);
        let chosen = nk::FontDialog::new(initial)
            .labels(labels)
            .monospace_only(key == "appearance.monoFont")
            .choose(
                &mut self.host,
                window,
                launcher,
                || {
                    Ok(if portal.changed() {
                        let a = portal.read()?;
                        nk::DialogUpdate {
                            appearance: Some((WindowLook::load(e, &a)?, a.reduced_motion)),
                            ..Default::default()
                        }
                    } else {
                        nk::DialogUpdate::default()
                    })
                },
                |host| {
                    model
                        .page(host, client.session(), e)
                        .expect("validated manifest page")
                },
            )?;
        if let Some(choice) = chosen {
            self.model
                .font_chosen(key, &choice, &mut self.client, &self.exports)?;
        }
        self.dirty = true;
        Ok(())
    }
}
impl Application for Settings {
    fn window_controls(&self) -> bool {
        true
    }
    fn poll_interval_ms(&self) -> u32 {
        let ms = self
            .model
            .poll_interval_ms(Instant::now(), self.host.poll_interval_ms());
        if self.chooser.pending()
            || matches!(
                self.shown.as_deref(),
                Some("display" | nk_settings::audio::PAGE | nk_settings::network::PAGE)
            )
        {
            ms.min(200)
        } else {
            ms
        }
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
        self.dirty |= self.model.about.poll();
        self.dirty |= self.model.poll_region(&mut self.client, &self.exports)?;
        self.dirty |= self.model.audio.poll();
        self.dirty |= self.model.network.poll();
        if self.model.display.poll() {
            self.host.cancel_menu();
            self.dirty = true;
        }
        self.dirty |= self.model.tick(self.client.session());
        self.chosen_icon()?;
        let actions = self.host.idle()?;
        self.actions(actions, window, None)?;
        self.dirty |= self
            .model
            .flush(&mut self.client, &self.exports, Instant::now())?;
        self.commit(window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        if matches!(event, Event::PointerLeave | Event::Focus(false)) {
            self.dirty |= self.model.display.cancel_drag();
        }
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
        if self.model.audio.poll() | self.model.network.poll() {
            self.dirty = true;
            self.commit(window)?;
        }
        let serial = match &event {
            Event::Button { serial, .. } => Some(*serial),
            Event::Key(key) => key.serial,
            _ => None,
        };
        let outcome = match &event {
            Event::ActivationToken { request, token } => Some((request, Some(token.clone()))),
            Event::ActivationTokenFailed { request, .. } => Some((request, None)),
            _ => None,
        };
        if let Some((request, token)) = outcome
            && let Some(action) = self.network_tokens.remove(request)
            && self.model.selected() == Some(nk_settings::network::PAGE)
        {
            self.dirty |= self.model.network.activate(&action, &self.exports, token);
        }
        let display_token = match &event {
            Event::ActivationToken { request, token } => {
                Some((request, Some(token.clone().into_string())))
            }
            Event::ActivationTokenFailed { request, .. } => Some((request, None)),
            _ => None,
        };
        if let Some((request, token)) = display_token
            && let Some(action) = self.display_tokens.remove(request)
        {
            self.dirty |= self.model.display_action(&action, false, &self.host, token);
        }
        let (_, actions) = self.host.event(event, window)?;
        self.actions(actions, window, serial)?;
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
    let client = Client::start(bus.clone())?;
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
        {
            let mut glyphs = Glyphs::new(nk_icons::Icons::new("", &[], &reference)?);
            let mark = nk_settings::bar::mark_path();
            match std::fs::read(&mark) {
                Ok(svg) => glyphs.add(nk_settings::bar::MARK, &svg)?,
                Err(e) => eprintln!(
                    "nidara-settings-view: no Nidara mark at {}: {e}",
                    mark.display()
                ),
            }
            glyphs
        },
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
        network_tokens: HashMap::new(),
        display_tokens: HashMap::new(),
        ready: false,
        dirty: true,
        shown: None,
        bus,
        chooser: Default::default(),
        choosing: 0,
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
