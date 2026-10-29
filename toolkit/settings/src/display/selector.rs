// SPDX-License-Identifier: LGPL-3.0-or-later
//! Accessible Super+P toplevel for the isolated Rust session. Hyalo handles raising
//! an existing instance from the shortcut; this client never forges activation.
use super::page::Page;
use crate::{exports::Exports, material::panel::PanelMaterial, portal::Portal, styles::Styles};
use nk_a11y::{Request, bridge::Bridge};
use nk_text::{FontSet, ParleyBackend};
use nk_wayland::{Application, Event, Frame, Options, Window};
use nk_widgets::{
    Command, Effect, Kind, PopupSnapshot, Result, Surface, Tree, window::Composition,
};
use std::{sync::Arc, time::Instant};
struct Selector {
    tree: Tree,
    page: Page,
    exports: Exports,
    styles: Styles,
    portal: Portal,
    panel: PanelMaterial,
    text: ParleyBackend,
    input: Composition,
    bridge: Option<Bridge>,
    publication: Option<(u64, u64)>,
    configured: bool,
    buttons: [u64; 3],
    confirmation_commits: std::collections::BTreeMap<u64, u64>,
}
impl Selector {
    fn sync(&mut self, window: &mut Window) -> Result<()> {
        if !self.configured {
            return Ok(());
        }
        if self.portal.changed() {
            let appearance = self.portal.read()?;
            self.styles = Styles::new(&self.exports, &appearance)?;
            self.styles.apply(&mut self.tree)?;
            self.panel = PanelMaterial::load(
                self.exports.glass.clone(),
                appearance.dark,
                appearance.reduce_transparency,
            )?;
            self.page
                .restyle(&mut self.tree, &self.exports, &self.styles, &mut self.text)?;
        }
        self.page
            .poll(&mut self.tree, &self.exports, &self.styles, &mut self.text)?;
        self.input.sync(
            &mut self.tree,
            window,
            &mut self.text,
            self.styles.palette,
            |side| self.panel.at(side),
            false,
        )?;
        if self.tree.invalidation().semantics || self.publication.is_none() {
            let snapshot = PopupSnapshot::new(self.tree.semantics())?;
            self.publication = Some((snapshot.revision, self.tree.generation()));
            if let Some(bridge) = &self.bridge {
                bridge.update(snapshot.revision, snapshot.tree)?;
            } else {
                self.bridge = Some(Bridge::new(snapshot.revision, snapshot.tree));
            }
            self.tree.acknowledge_semantics();
        }
        if self.tree.invalidation().paint {
            window.redraw();
        }
        Ok(())
    }
    fn effect(&mut self, effect: Effect, window: &mut Window) -> Result<()> {
        if let Effect::Activated(id) = effect
            && let Some(index) = self.buttons.iter().position(|button| *button == id)
        {
            window.window_action(
                [
                    nk_wayland::WindowAction::Minimize,
                    nk_wayland::WindowAction::ToggleMaximize,
                    nk_wayland::WindowAction::Close,
                ][index],
            );
            return Ok(());
        }
        self.page.effect(
            &mut self.tree,
            &self.exports,
            &self.styles,
            &mut self.text,
            effect,
        )?;
        Ok(())
    }
}
impl Application for Selector {
    fn material(&self) -> Option<nk_wayland::Material> {
        None
    }
    fn window_controls(&self) -> bool {
        true
    }
    fn poll_interval_ms(&self) -> u32 {
        50
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        self.sync(w)?;
        if let Some(bridge) = &self.bridge {
            bridge.check()?;
            while bridge.published.try_recv().is_ok() {}
        }
        loop {
            let queued = self
                .bridge
                .as_ref()
                .and_then(|b| b.requests.try_recv().ok());
            let Some((revision, request)) = queued else {
                break;
            };
            self.sync(w)?;
            if self.publication != Some((revision, self.tree.generation())) {
                continue;
            }
            let effect = match request {
                Request::Focus(id) => self.tree.dispatch(self.tree.target(id), Command::Focus),
                Request::Activate(id) => {
                    self.tree.dispatch(self.tree.target(id), Command::Activate)
                }
                _ => Err("unsupported selector action".into()),
            };
            if let Ok(effect) = effect {
                self.effect(effect, w)?;
            }
            self.sync(w)?;
        }
        Ok(())
    }
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        if matches!(event, Event::FrameDone) {
            let commit = w.commits();
            if let Some(deadline) = self.confirmation_commits.remove(&commit)
                && std::env::var_os("NK_DISPLAY_TEST_FRAMES").is_some()
            {
                eprintln!("DISPLAY_CONFIRMATION_FRAME commit={commit} deadline={deadline}");
            }
        }
        if let Event::Error(error) = &event {
            return Err(error.clone());
        }
        if matches!(event, Event::Configure) {
            w.set_title(self.exports.text("settings.display.title")?)?;
            self.configured = true;
        }
        if let Event::Focus(active) = event {
            self.tree.set_active(active);
        }
        if matches!(&event,Event::Key(key) if key.sym==0xff1b) {
            w.close();
            return Ok(());
        }
        self.sync(w)?;
        let effect = self.input.event_with_window(&mut self.tree, &event, w)?;
        self.effect(effect, w)?;
        self.sync(w)
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        self.tree
            .paint(frame, Surface::Content, self.styles.palette)
    }
    fn committed(&mut self, commit: u64) {
        self.tree.acknowledge();
        if let Some(pending) = &self.page.state.owned {
            if pending.phase == "confirming" {
                self.confirmation_commits
                    .insert(commit, pending.deadline_us);
            }
        } else {
            self.confirmation_commits.clear();
        }
    }
}
pub fn run() -> Result<()> {
    let exports = Exports::load(&Exports::root())?;
    let bus = zbus::blocking::Connection::session().map_err(|e| e.to_string())?;
    // Only one selector, independently of the native Settings instance. No remote
    // methods: compositor-owned activation raises the mapped app-id on repeat.
    bus.request_name_with_flags(
        "org.nidara.DisplaySelector",
        zbus::fdo::RequestNameFlags::DoNotQueue.into(),
    )
    .map_err(|e| e.to_string())?;
    let portal = Portal::watch(&bus)?;
    let appearance = portal.read()?;
    let styles = Styles::new(&exports, &appearance)?;
    let panel = PanelMaterial::load(
        exports.glass.clone(),
        appearance.dark,
        appearance.reduce_transparency,
    )?;
    let mut tree = Tree::new(
        exports.text("settings.display.title")?,
        styles.metrics,
        styles.text.clone(),
    )?;
    styles.apply(&mut tree)?;
    let title = tree.append(
        tree.root(),
        Kind::TitleBar,
        exports.text("settings.display.title")?,
    )?;
    let buttons = tree.window_controls(
        title,
        [
            exports.text("settings.native.minimize")?,
            exports.text("settings.native.maximize")?,
            exports.text("settings.window.close")?,
        ],
    )?;
    let content = tree.append(
        tree.root(),
        Kind::Scroll,
        exports.text("settings.display.title")?,
    )?;
    let page = Page::mount(&mut tree, content, &exports, &styles, true)?;
    let size = (
        styles.metrics.form_width.ceil() as u32 + 2 * styles.metrics.padding.ceil() as u32,
        (styles.metrics.row * 12.).ceil() as u32,
    );
    let text = ParleyBackend::with_system_fonts(Arc::new(FontSet::discover_required()?))?;
    let selector = Selector {
        tree,
        page,
        exports,
        styles,
        portal,
        panel,
        text,
        input: Composition::default(),
        bridge: None,
        publication: None,
        configured: false,
        buttons,
        confirmation_commits: Default::default(),
    };
    nk_wayland::run(
        selector,
        Options {
            app_id: "nidara-display-selector",
            title: "Nidara",
            size,
            map: true,
            material: false,
            require_material: None,
        },
        Instant::now(),
    )
}
