// SPDX-License-Identifier: LGPL-3.0-or-later
//! Native family/style/point-size chooser with retained preview, on one semantic Bridge.
use crate::{
    font_catalog::{Catalogue, Load, Operation},
    font_description::{Attributes, Description},
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
    pub styles: &'a str,
    pub unnamed: &'a str,
    pub unsupported_style: &'a str,
    pub preview: &'a str,
    pub point_size: &'a str,
    pub loading: &'a str,
    pub cancel: &'a str,
    pub select: &'a str,
}
/// Owned translated strings; borrow them for each modal opening.
pub struct DialogLabels {
    pub search: String,
    pub placeholder: String,
    pub families: String,
    pub styles: String,
    pub unnamed: String,
    pub unsupported_style: String,
    pub preview: String,
    pub point_size: String,
    pub loading: String,
    pub cancel: String,
    pub select: String,
}
impl DialogLabels {
    pub fn borrowed<'a>(&'a self, title: &'a str) -> Labels<'a> {
        Labels {
            title,
            search: &self.search,
            placeholder: &self.placeholder,
            families: &self.families,
            styles: &self.styles,
            unnamed: &self.unnamed,
            unsupported_style: &self.unsupported_style,
            preview: &self.preview,
            point_size: &self.point_size,
            loading: &self.loading,
            cancel: &self.cancel,
            select: &self.select,
        }
    }
}
pub type PrepareTree = dyn FnMut(&mut Tree) -> Result<()>;
pub struct Configuration {
    pub fonts: Arc<FontSet>,
    pub labels: DialogLabels,
    pub size: (u32, u32),
    pub list_height: f32,
    pub point_range: nk_widgets::ValueRange,
    pub prepare: Box<PrepareTree>,
}
pub struct Request {
    pub title: String,
    pub launcher: NodeId,
    pub operation: Operation,
    pub initial: Selection,
}
pub type Selection = Description;
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
    pub point_range: nk_widgets::ValueRange,
    pub text_scale: f32,
    pub labels: Labels<'a>,
    /// Supply the actual interface icon theme to the transient tree.
    pub prepare: &'a mut dyn FnMut(&mut Tree) -> Result<()>,
    /// Stage Config1/appearance/routing/mount notices; false invalidates before input.
    pub keep_open: &'a mut dyn FnMut() -> Result<bool>,
}
struct PointSize {
    attributes: Attributes,
    initial: f32,
    range: nk_widgets::ValueRange,
    scale: f32,
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
    style_list: NodeId,
    style_options: Vec<(NodeId, Attributes)>,
    catalogue_styles: std::collections::BTreeMap<String, Vec<(String, bool)>>,
    unnamed: String,
    unsupported_style: String,
    attributes: Attributes,
    preview: NodeId,
    preview_row: NodeId,
    preview_style: nk_text::TextStyle,
    points: NodeId,
    text_scale: f32,
}
impl View {
    fn build(
        tree: &mut Tree,
        styles: &Styles,
        labels: &Labels<'_>,
        height: f32,
        fonts: Arc<FontSet>,
        points: PointSize,
    ) -> Result<Self> {
        let PointSize {
            attributes,
            initial: initial_points,
            range: point_range,
            scale: text_scale,
        } = points;
        if !point_range.min.is_finite()
            || point_range.min <= 0.
            || !text_scale.is_finite()
            || text_scale <= 0.
            || !initial_points.is_finite()
            || initial_points <= 0.
        {
            return Err("invalid chooser point size or text scale".into());
        }
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
        let style_list = tree.list(scroll, labels.styles, height, styles.menu.clone())?;
        let (_, _, point_controls) = tree.fields(
            scroll,
            labels.point_size,
            vec![(labels.point_size, point_range, initial_points)],
        )?;
        let points = point_controls[0];
        if tree.value(points) != Some(initial_points) {
            return Err("point range cannot represent the current font size".into());
        }
        let preview_row = tree.append(scroll, Kind::Row, "")?;
        let preview = tree.append(preview_row, Kind::Label, labels.preview)?;
        tree.set_hidden(preview_row, true)?;
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
            style_list,
            style_options: vec![],
            catalogue_styles: Default::default(),
            unnamed: labels.unnamed.into(),
            unsupported_style: labels.unsupported_style.into(),
            attributes,
            preview,
            preview_row,
            preview_style: styles.text.clone(),
            points,
            text_scale,
        })
    }
    fn loaded(&mut self, tree: &mut Tree, catalogue: &Catalogue, initial: &str) -> Result<()> {
        for family in &catalogue.families {
            self.catalogue_styles.insert(
                family.name.clone(),
                family
                    .faces
                    .iter()
                    .map(|face| (face.style.clone(), face.index >> 16 != 0))
                    .collect(),
            );
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
        self.rebuild_styles(tree, true)?;
        self.preview(tree)?;
        self.filter(tree)
    }
    fn rebuild_styles(&mut self, tree: &mut Tree, preserve_initial: bool) -> Result<()> {
        for (id, _) in self.style_options.drain(..) {
            tree.remove(id)?;
        }
        // Also retire disabled unsupported options; all IDs are dialog-owned.
        let old = tree.node(self.style_list).unwrap().children().to_vec();
        for id in old {
            tree.remove(id)?;
        }
        if let Some(styles) = self
            .selected
            .as_ref()
            .and_then(|name| self.catalogue_styles.get(name))
        {
            let mut names = std::collections::BTreeMap::<String, bool>::new();
            for (name, named_instance) in styles {
                *names.entry(name.clone()).or_default() |= !named_instance;
            }
            for (name, selectable_face) in names {
                let id = tree.append(
                    self.style_list,
                    Kind::MenuOption { selected: false },
                    if name.is_empty() {
                        &self.unnamed
                    } else {
                        &name
                    },
                )?;
                match Attributes::named(&name) {
                    Ok(attributes) if selectable_face => self.style_options.push((id, attributes)),
                    _ => tree.set_disabled(id, true)?,
                }
            }
        }
        let matching = self.style_options.iter().find(|(_, a)| {
            a.weight == self.attributes.weight
                && a.slant == self.attributes.slant
                && a.width == self.attributes.width
        });
        let chosen = if preserve_initial {
            matching
        } else {
            matching.or(self.style_options.first())
        };
        tree.set_hidden(self.status_row, chosen.is_some())?;
        if chosen.is_none() {
            tree.set_name(self.status, &self.unsupported_style)?;
        }
        if let Some((id, attributes)) = chosen {
            if attributes.weight != self.attributes.weight
                || attributes.slant != self.attributes.slant
                || attributes.width != self.attributes.width
            {
                self.attributes = attributes.clone();
            }
            tree.set_list_selected(self.style_list, Some(*id))?;
        }
        Ok(())
    }
    fn preview(&self, tree: &mut Tree) -> Result<()> {
        let visible = self.selected.is_some() && self.has_style(tree);
        tree.set_hidden(self.preview_row, !visible)?;
        if !visible {
            return Ok(());
        }
        if let Some(family) = &self.selected {
            let mut style = self.preview_style.clone();
            style.family = family.clone();
            style.weight = self.attributes.weight;
            style.slant = self.attributes.slant;
            style.width = self.attributes.width;
            style.variations = self.attributes.variations.clone();
            style.size = tree.value(self.points).ok_or("font size control missing")?
                * (96. / 72.)
                * self.text_scale;
            tree.set_label_style(self.preview, Some(style))?;
        }
        Ok(())
    }
    fn filter(&self, tree: &mut Tree) -> Result<()> {
        let query = tree.search_text(self.search)?.trim().to_lowercase();
        for (name, id) in &self.rows {
            tree.set_hidden(*id, !name.to_lowercase().contains(&query))?;
        }
        tree.set_disabled(self.select, !self.can_select(tree))?;
        Ok(())
    }
    fn has_style(&self, tree: &Tree) -> bool {
        self.style_options.iter().any(|(id, _)| {
            matches!(
                tree.node(*id).unwrap().kind(),
                Kind::MenuOption { selected: true }
            )
        })
    }
    fn can_select(&self, tree: &Tree) -> bool {
        self.has_style(tree)
            && self
                .rows
                .iter()
                .any(|(name, id)| self.selected.as_ref() == Some(name) && !tree.is_hidden(*id))
    }
    fn effect(&mut self, tree: &mut Tree, effect: Effect) -> Result<bool> {
        match effect {
            Effect::Changed(id) if id == self.search => self.filter(tree)?,
            Effect::Changed(id) if id == self.points => self.preview(tree)?,
            Effect::Changed(id) if id == self.style_list => {
                if let Some((_, attributes)) = self.style_options.iter().find(|(id, _)| {
                    matches!(
                        tree.node(*id).unwrap().kind(),
                        Kind::MenuOption { selected: true }
                    )
                }) {
                    self.attributes = attributes.clone();
                    self.preview(tree)?;
                    tree.set_hidden(self.status_row, true)?;
                    tree.set_disabled(self.select, !self.can_select(tree))?;
                }
            }
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
                self.attributes.variations.clear();
                self.rebuild_styles(tree, false)?;
                self.preview(tree)?;
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
    result: &'a mut Option<Selection>,
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
            *self.result = self.view.selected.clone().map(|family| Selection {
                family,
                attributes: self.view.attributes.clone(),
                points: self.dialog.view().value(self.view.points).unwrap(),
            });
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
                && self
                    .dialog
                    .view()
                    .search_consumes_escape(self.view.search)?)
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
/// A draft family/style/point-size choice. Exact face identity and Config1 Apply are separate.
pub fn choose(host: Host<'_>, launcher: NodeId, initial: Selection) -> Result<Option<Selection>> {
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
        PointSize {
            attributes: initial.attributes.clone(),
            initial: initial.points,
            range: host.point_range,
            scale: host.text_scale,
        },
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
            initial: &initial.family,
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
            styles: "Font styles",
            unnamed: "Unnamed style",
            unsupported_style: "Unsupported styles",
            preview: "The quick brown fox",
            point_size: "Point size",
            loading: "Loading",
            cancel: "Cancel",
            select: "Select",
        };
        let mut view = View::build(
            &mut tree,
            &styles,
            &labels,
            160.,
            fonts,
            PointSize {
                attributes: Attributes::default(),
                initial: 11.,
                range: nk_widgets::ValueRange {
                    min: 1.,
                    max: 100.,
                    step: 0.5,
                    wrap: false,
                    digits: 0,
                    decimals: 1,
                    unit: " pt".into(),
                },
                scale: 1.,
            },
        )
        .unwrap();
        let mut catalogue = Catalogue {
            skipped_records: 0,
            families: vec![
                crate::font_catalog::Family {
                    name: "Noto Sans".into(),
                    faces: vec![
                        crate::font_catalog::Face {
                            style: "Regular".into(),
                            file: "/synthetic/font.ttf".into(),
                            index: 0,
                        },
                        crate::font_catalog::Face {
                            style: "Bold".into(),
                            file: "/synthetic/bold.ttf".into(),
                            index: 0,
                        },
                    ],
                },
                crate::font_catalog::Family {
                    name: "日本語".into(),
                    faces: vec![
                        crate::font_catalog::Face {
                            style: "Regular".into(),
                            file: "/synthetic/font.ttf".into(),
                            index: 0,
                        },
                        crate::font_catalog::Face {
                            style: "Bold".into(),
                            file: "/synthetic/bold.ttf".into(),
                            index: 0,
                        },
                    ],
                },
            ],
        };
        catalogue.families[0].faces.extend([
            crate::font_catalog::Face {
                style: "Mystery".into(),
                file: "/synthetic/mystery.ttf".into(),
                index: 0,
            },
            crate::font_catalog::Face {
                style: "Italic".into(),
                file: "/synthetic/instance.ttf".into(),
                index: 1 << 16,
            },
            crate::font_catalog::Face {
                style: "".into(),
                file: "/synthetic/unnamed.ttf".into(),
                index: 0,
            },
        ]);
        catalogue.families.push(crate::font_catalog::Family {
            name: "Unavailable".into(),
            faces: vec![crate::font_catalog::Face {
                style: "Unknown Style".into(),
                file: "/synthetic/unsupported.ttf".into(),
                index: 0,
            }],
        });
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
        for label in ["Mystery", "Italic"] {
            let id = *tree
                .node(view.style_list)
                .unwrap()
                .children()
                .iter()
                .find(|id| tree.node(**id).unwrap().name() == label)
                .unwrap();
            assert!(
                tree.dispatch(tree.target(id), nk_widgets::Command::Activate)
                    .is_err(),
                "unsupported style/named instance must not activate"
            );
        }
        assert!(
            tree.node(view.style_list)
                .unwrap()
                .children()
                .iter()
                .any(|id| tree.node(*id).unwrap().name() == "Unnamed style")
        );
        view.attributes.weight = 800.;
        view.rebuild_styles(&mut tree, true).unwrap();
        view.preview(&mut tree).unwrap();
        assert_eq!(
            view.attributes.weight, 800.,
            "opening cannot silently replace an unsupported initial style"
        );
        assert!(!view.can_select(&tree));
        assert!(tree.is_hidden(view.preview_row));
        let regular = view
            .style_options
            .iter()
            .find(|(_, a)| a.weight == 400.)
            .unwrap()
            .0;
        let effect = tree
            .dispatch(tree.target(regular), nk_widgets::Command::Activate)
            .unwrap();
        view.effect(&mut tree, effect).unwrap();
        assert!(view.can_select(&tree));
        assert!(tree.is_hidden(view.status_row));
        assert_eq!(
            tree.dispatch(tree.target(view.select), nk_widgets::Command::Activate)
                .unwrap(),
            Effect::Activated(view.select)
        );
        let ids: Vec<_> = view.rows.iter().map(|(_, id)| *id).collect();
        tree.layout(
            Size {
                width: 640.,
                height: 480.,
            },
            false,
            &mut text,
        )
        .unwrap();
        let layout = tree.node(view.preview).unwrap().text_layout().unwrap();
        assert_eq!(layout.style().family, "Noto Sans");
        assert_eq!(layout.style().size, 11. * (96. / 72.));
        let effect = tree.request_value(tree.target(view.points), 18.).unwrap();
        view.effect(&mut tree, effect).unwrap();
        tree.layout(
            Size {
                width: 640.,
                height: 480.,
            },
            false,
            &mut text,
        )
        .unwrap();
        assert_eq!(
            tree.node(view.preview)
                .unwrap()
                .text_layout()
                .unwrap()
                .style()
                .size,
            24.
        );
        view.text_scale = 1.25;
        view.preview(&mut tree).unwrap();
        tree.layout(
            Size {
                width: 640.,
                height: 480.,
            },
            false,
            &mut text,
        )
        .unwrap();
        assert_eq!(
            tree.node(view.preview)
                .unwrap()
                .text_layout()
                .unwrap()
                .style()
                .size,
            30.
        );
        tree.layout(
            Size {
                width: 640.,
                height: 900.,
            },
            false,
            &mut text,
        )
        .unwrap();
        let preview_bounds = tree.node(view.preview).unwrap().bounds();
        assert!(
            preview_bounds.height > 0.
                && preview_bounds.y >= 0.
                && preview_bounds.y + preview_bounds.height <= 900.
        );
        let paint_preview = |tree: &Tree| {
            tree.paint(
                Frame {
                    width: 640,
                    height: 900,
                    pixel_width: 640,
                    pixel_height: 900,
                    scale: 1.,
                    material: false,
                },
                Surface::Content,
                styles.palette,
            )
            .unwrap()
        };
        let regular_pixels = paint_preview(&tree);
        let bold = view
            .style_options
            .iter()
            .find(|(_, a)| a.weight == 700.)
            .unwrap()
            .0;
        let effect = tree
            .dispatch(tree.target(bold), nk_widgets::Command::Activate)
            .unwrap();
        assert_eq!(effect, Effect::Changed(view.style_list));
        view.effect(&mut tree, effect).unwrap();
        tree.layout(
            Size {
                width: 640.,
                height: 900.,
            },
            false,
            &mut text,
        )
        .unwrap();
        assert_eq!(
            tree.node(view.preview)
                .unwrap()
                .text_layout()
                .unwrap()
                .style()
                .weight,
            700.
        );
        let bold_pixels = paint_preview(&tree);
        assert!(
            regular_pixels
                .as_chunks::<4>()
                .0
                .iter()
                .zip(bold_pixels.as_chunks::<4>().0.iter())
                .enumerate()
                .any(|(i, (a, b))| {
                    let x = (i % 640) as f32;
                    let y = (i / 640) as f32;
                    x >= preview_bounds.x
                        && x < preview_bounds.x + preview_bounds.width
                        && y >= preview_bounds.y
                        && y < preview_bounds.y + preview_bounds.height
                        && a != b
                }),
            "style activation must change the actual visible preview pixels"
        );
        let old = tree
            .node(view.preview)
            .unwrap()
            .text_layout()
            .unwrap()
            .style()
            .clone();
        let mut invalid = old.clone();
        invalid.width = f32::NAN;
        assert!(tree.set_label_style(view.preview, Some(invalid)).is_err());
        assert_eq!(
            tree.node(view.preview)
                .unwrap()
                .text_layout()
                .unwrap()
                .style(),
            &old
        );

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
        let unsupported_family = view
            .rows
            .iter()
            .find(|(name, _)| name == "Unavailable")
            .unwrap()
            .1;
        let effect = tree
            .dispatch(
                tree.target(unsupported_family),
                nk_widgets::Command::Activate,
            )
            .unwrap();
        view.effect(&mut tree, effect).unwrap();
        assert!(
            tree.is_hidden(view.preview_row),
            "unsupported styles cannot display a fake regular preview"
        );
        assert!(!tree.is_hidden(view.status_row));
        assert!(
            !view
                .effect(&mut tree, Effect::Activated(view.select))
                .unwrap()
        );
        assert!(
            view.effect(&mut tree, Effect::Activated(view.cancel))
                .unwrap()
        );
        assert_eq!(view.selected, None);
    }
}

#[cfg(feature = "ime-gates")]
mod ime_probe;
#[cfg(feature = "ime-gates")]
pub use ime_probe::run as run_ime_probe;
