// SPDX-License-Identifier: LGPL-3.0-or-later
//! Native family-picker view of the FontChooser, on the parent's single Bridge.
use crate::{
    font_catalog::{Catalogue, Load, Operation},
    material::panel::PanelMaterial,
    styles::Styles,
};
use nk_a11y::bridge::Bridge;
use nk_text::{FontSet, ParleyBackend, Size};
use nk_wayland::{Application, Event, Frame, Material, Options, Pane, Window};
use nk_widgets::{
    DialogTree, Effect, Kind, NodeId, PopupSnapshot, Result, Surface, Tree, window::Composition,
};
use std::sync::Arc;

pub struct Labels<'a> {
    pub title: &'a str,
    pub search: &'a str,
    pub placeholder: &'a str,
    pub families: &'a str,
    pub loading: &'a str,
    pub cancel: &'a str,
    pub select: &'a str,
}
pub struct Host<'a> {
    pub tree: &'a mut Tree,
    pub window: &'a mut Window,
    pub fonts: Arc<FontSet>,
    pub styles: &'a Styles,
    pub bridge: &'a Bridge,
    pub revision: &'a mut u64,
    pub panel: Option<&'a PanelMaterial>,
    pub operation: Operation,
    pub poll_interval_ms: u32,
    pub size: (u32, u32),
    pub list_height: f32,
    pub labels: Labels<'a>,
    /// Supply the actual interface icon theme to the transient tree.
    pub prepare: &'a mut dyn FnMut(&mut Tree) -> Result<()>,
    /// Stage Config1/appearance/routing/mount notices; false invalidates before input.
    pub keep_open: &'a mut dyn FnMut() -> Result<bool>,
}
struct View {
    search: NodeId,
    list: NodeId,
    status: NodeId,
    status_row: NodeId,
    cancel: NodeId,
    select: NodeId,
    rows: Vec<(String, NodeId)>,
    selected: Option<String>,
}
impl View {
    fn build(
        tree: &mut Tree,
        styles: &Styles,
        labels: &Labels<'_>,
        height: f32,
        fonts: Arc<FontSet>,
    ) -> Result<Self> {
        styles.apply(tree)?;
        tree.append(tree.root(), Kind::TitleBar, labels.title)?;
        let scroll = tree.append(tree.root(), Kind::Scroll, labels.families)?;
        let search = tree.search_input(
            scroll,
            labels.search,
            labels.placeholder,
            Box::new(ParleyBackend::with_system_fonts(fonts)?),
        )?;
        let status_row = tree.append(scroll, Kind::Row, "")?;
        let status = tree.append(status_row, Kind::Label, labels.loading)?;
        let list = tree.list(scroll, labels.families, height, styles.menu.clone())?;
        let cancel_row = tree.append(scroll, Kind::Row, "")?;
        let cancel = tree.append(cancel_row, Kind::Button, labels.cancel)?;
        let select_row = tree.append(scroll, Kind::Row, "")?;
        let select = tree.append(select_row, Kind::Button, labels.select)?;
        tree.set_disabled(select, true)?;
        tree.focus(search)?;
        Ok(Self {
            search,
            list,
            status,
            status_row,
            cancel,
            select,
            rows: Vec::new(),
            selected: None,
        })
    }
    fn loaded(&mut self, tree: &mut Tree, catalogue: &Catalogue, initial: &str) -> Result<()> {
        for family in &catalogue.families {
            let id = tree.append(
                self.list,
                Kind::MenuOption {
                    selected: family.name == initial,
                },
                &family.name,
            )?;
            self.rows.push((family.name.clone(), id));
        }
        self.selected = self
            .rows
            .iter()
            .find(|(name, _)| name == initial)
            .map(|(name, _)| name.clone());
        // Hide the entire loading row, not an empty-height label alone.
        tree.set_hidden(self.status_row, true)?;
        self.filter(tree)
    }
    fn filter(&self, tree: &mut Tree) -> Result<()> {
        let query = tree.search_text(self.search)?.trim().to_lowercase();
        for (name, id) in &self.rows {
            tree.set_hidden(*id, !name.to_lowercase().contains(&query))?;
        }
        tree.set_disabled(self.select, !self.can_select(tree))?;
        Ok(())
    }
    fn can_select(&self, tree: &Tree) -> bool {
        self.rows
            .iter()
            .any(|(name, id)| self.selected.as_ref() == Some(name) && !tree.is_hidden(*id))
    }
    fn effect(&mut self, tree: &mut Tree, effect: Effect) -> Result<bool> {
        match effect {
            Effect::Changed(id) if id == self.search => self.filter(tree)?,
            Effect::Changed(id) if id == self.list => {
                self.selected = self
                    .rows
                    .iter()
                    .find(|(_, id)| {
                        matches!(
                            tree.node(*id).unwrap().kind(),
                            Kind::MenuOption { selected: true }
                        )
                    })
                    .map(|(name, _)| name.clone());
                tree.set_disabled(self.select, !self.can_select(tree))?;
            }
            Effect::Activated(id) if id == self.cancel => {
                self.selected = None;
                return Ok(true);
            }
            Effect::Activated(id) if id == self.select && self.can_select(tree) => {
                return Ok(true);
            }
            _ => {}
        }
        Ok(false)
    }
}
struct Picker<'a, 'p> {
    dialog: &'a mut DialogTree<'p>,
    view: View,
    text: ParleyBackend,
    styles: &'a Styles,
    bridge: &'a Bridge,
    panel: Option<&'a PanelMaterial>,
    material: Option<Material>,
    input: Composition,
    load: Load,
    operation: Operation,
    initial: &'a str,
    title: &'a str,
    publication: Option<u64>,
    configured: bool,
    result: &'a mut Option<String>,
    keep_open: &'a mut dyn FnMut() -> Result<bool>,
    interval: u32,
}
impl Picker<'_, '_> {
    fn live(&mut self, window: &mut Window) -> Result<bool> {
        self.bridge.check()?;
        if !(self.keep_open)()? {
            self.dialog.invalidate();
            self.load.cancel();
            *self.result = None;
            window.close();
            return Ok(false);
        }
        Ok(true)
    }
    fn update(&mut self, window: &mut Window) -> Result<()> {
        if !self.configured {
            return Ok(());
        }
        let (width, height) = window.size();
        self.dialog.view_mut().layout(
            Size {
                width: width as f32,
                height: height as f32,
            },
            false,
            &mut self.text,
        )?;
        self.input
            .sync_search_input(self.dialog.view_mut(), window)?;
        if self.dialog.view().invalidation().semantics || self.publication.is_none() {
            let snapshot = self.dialog.snapshot()?;
            self.bridge.update(snapshot.revision, snapshot.tree)?;
            self.publication = Some(snapshot.revision);
            self.dialog.view_mut().acknowledge_semantics();
        }
        if self.dialog.view().invalidation().paint {
            window.redraw();
        }
        Ok(())
    }
    fn effect(&mut self, effect: Effect, window: &mut Window) -> Result<bool> {
        if self.view.effect(self.dialog.view_mut(), effect)? {
            *self.result = self.view.selected.clone();
            window.close();
            return Ok(true);
        }
        Ok(false)
    }
}
impl Application for Picker<'_, '_> {
    fn poll_interval_ms(&self) -> u32 {
        self.interval
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        if !self.live(window)? {
            return Ok(());
        }
        if let Some(result) = self.load.poll(self.operation) {
            match result {
                Ok(catalogue) => {
                    self.view
                        .loaded(self.dialog.view_mut(), &catalogue, self.initial)?
                }
                Err(error) => self.dialog.view_mut().set_name(self.view.status, error)?,
            }
        }
        while let Ok((revision, request)) = self.bridge.requests.try_recv() {
            if let Ok(effect) = self.dialog.request(revision, request)
                && self.effect(effect, window)?
            {
                return Ok(());
            }
        }
        self.update(window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        if !self.live(window)? {
            return Ok(());
        }
        if let Event::Error(error) = &event {
            return Err(error.clone());
        }
        if matches!(&event, Event::Key(key) if key.sym == 0xff1b)
            && !(self.dialog.view().focused() == Some(self.view.search)
                && self.dialog.view().search_composing(self.view.search)?)
        {
            *self.result = None;
            window.close();
            return Ok(());
        }
        if matches!(event, Event::Configure) {
            self.configured = true;
            window.set_title(self.title)?;
            let (width, height) = window.size();
            self.material = self
                .panel
                .map(|panel| panel.at(f64::from(width.min(height))))
                .transpose()?;
            if let Some(material) = &mut self.material {
                material.shapes = vec![Pane {
                    x: 0.,
                    y: 0.,
                    width: width.into(),
                    height: height.into(),
                    radius: self.styles.menu.radius.into(),
                    exponent: 2.,
                }];
            }
        }
        let effect = self
            .input
            .event_with_window(self.dialog.view_mut(), &event, window)?;
        if self.effect(effect, window)? {
            return Ok(());
        }
        self.update(window)
    }
    fn paint(&mut self, mut frame: Frame) -> Result<Vec<u8>> {
        frame.material &= self.material.is_some();
        self.dialog
            .view()
            .paint(frame, Surface::Content, self.styles.palette)
    }
    fn material(&self) -> Option<Material> {
        self.material.clone()
    }
    fn committed(&mut self, _: u64) {
        self.dialog.view_mut().acknowledge();
    }
}
/// Native family selection only. The full font chooser adds face/point-size/preview.
pub fn choose_family(host: Host<'_>, launcher: NodeId, initial: &str) -> Result<Option<String>> {
    if host.poll_interval_ms == 0 {
        return Err("font dialog requires a polling interval".into());
    }
    if !(host.keep_open)()? {
        return Ok(None);
    }
    let mut dialog = DialogTree::new(host.tree, launcher, host.labels.title)?;
    let view = View::build(
        dialog.view_mut(),
        host.styles,
        &host.labels,
        host.list_height,
        host.fonts.clone(),
    )?;
    (host.prepare)(dialog.view_mut())?;
    let mut load = Load::default();
    load.start(host.operation)?;
    let mut selected = None;
    let result = nk_wayland::run_dialog_with_options(
        Picker {
            dialog: &mut dialog,
            view,
            text: ParleyBackend::with_system_fonts(host.fonts)?,
            styles: host.styles,
            bridge: host.bridge,
            panel: host.panel,
            material: None,
            input: Composition::default(),
            load,
            operation: host.operation,
            initial,
            title: host.labels.title,
            publication: None,
            configured: false,
            result: &mut selected,
            keep_open: host.keep_open,
            interval: host.poll_interval_ms,
        },
        host.window,
        Options {
            material: true,
            map: true,
            app_id: "",
            title: "",
            size: host.size,
            require_material: None,
        },
    );
    let live = (host.keep_open)();
    if !live.as_ref().is_ok_and(|live| *live) {
        dialog.invalidate();
        selected = None;
    }
    if result.is_err() {
        selected = None;
    }
    drop(dialog);
    let snapshot = PopupSnapshot::new(host.tree.semantics())?;
    host.bridge.update(snapshot.revision, snapshot.tree)?;
    *host.revision = snapshot.revision;
    host.window.redraw();
    result?;
    live?;
    Ok(selected)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{exports::Exports, portal::Appearance};
    fn styles() -> Styles {
        let root = std::env::var_os("NK_SETTINGS_DATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .join("../../build/settings-data")
            });
        let exports = Exports::load(&root).expect("real exported Settings styles are required");
        Styles::new(
            &exports,
            &Appearance {
                accent: [0., 136. / 255., 1.],
                dark: true,
                reduce_transparency: false,
                window_background: "tinted".into(),
                reduced_motion: false,
                font: "Inter Variable 11".into(),
                text_scale: 1.,
            },
        )
        .unwrap()
    }
    #[test]
    fn real_family_view_filters_retained_options_and_confirms_only_explicitly() {
        let styles = styles();
        let fonts = Arc::new(FontSet::discover_required().unwrap());
        let mut tree = Tree::new("Fonts", styles.metrics, styles.text.clone()).unwrap();
        let labels = Labels {
            title: "Choose font",
            search: "Search families",
            placeholder: "Search",
            families: "Font families",
            loading: "Loading",
            cancel: "Cancel",
            select: "Select",
        };
        let mut view = View::build(&mut tree, &styles, &labels, 160., fonts).unwrap();
        let catalogue = Catalogue {
            families: vec![
                crate::font_catalog::Family {
                    name: "Noto Sans".into(),
                    faces: vec![],
                },
                crate::font_catalog::Family {
                    name: "日本語".into(),
                    faces: vec![],
                },
            ],
        };
        let icons = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../ui/shell/assets/icons/nidara");
        tree.set_icon_theme(nk_icons::Icons::new("", &[], &icons).unwrap());
        let mut text =
            ParleyBackend::with_system_fonts(Arc::new(FontSet::discover_required().unwrap()))
                .unwrap();
        tree.layout(
            Size {
                width: 640.,
                height: 480.,
            },
            false,
            &mut text,
        )
        .unwrap();
        tree.paint(
            Frame {
                width: 640,
                height: 480,
                pixel_width: 640,
                pixel_height: 480,
                scale: 1.,
                material: false,
            },
            Surface::Content,
            styles.palette,
        )
        .unwrap();
        assert!(view.selected.is_none());
        assert!(
            !view
                .effect(&mut tree, Effect::Activated(view.select))
                .unwrap()
        );
        view.loaded(&mut tree, &catalogue, "Noto Sans").unwrap();
        let ids: Vec<_> = view.rows.iter().map(|(_, id)| *id).collect();
        tree.set_search_text(view.search, "日本").unwrap();
        view.effect(&mut tree, Effect::Changed(view.search))
            .unwrap();
        assert!(tree.is_hidden(ids[0]));
        assert!(!tree.is_hidden(ids[1]));
        let selected = tree
            .dispatch(tree.target(ids[1]), nk_widgets::Command::Activate)
            .unwrap();
        assert!(!view.effect(&mut tree, selected).unwrap());
        assert_eq!(view.selected.as_deref(), Some("日本語"));
        assert!(
            view.effect(&mut tree, Effect::Activated(view.select))
                .unwrap()
        );
        tree.set_search_text(view.search, "absent").unwrap();
        view.effect(&mut tree, Effect::Changed(view.search))
            .unwrap();
        assert!(tree.semantics().nodes[&view.list].children.is_empty());
        assert!(
            !view
                .effect(&mut tree, Effect::Activated(view.select))
                .unwrap(),
            "an empty filtered view cannot accept a hidden family"
        );
        tree.set_search_text(view.search, "").unwrap();
        view.effect(&mut tree, Effect::Changed(view.search))
            .unwrap();
        assert_eq!(tree.semantics().nodes[&view.list].children, ids);
        assert!(
            view.effect(&mut tree, Effect::Activated(view.cancel))
                .unwrap()
        );
        assert_eq!(view.selected, None);
    }
}
