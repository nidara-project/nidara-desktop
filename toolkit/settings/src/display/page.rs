// SPDX-License-Identifier: LGPL-3.0-or-later
//! Retained Display1 page and selector content. Every action has the same keyboard
//! and AT-SPI path; the draggable diagram is a redundant pointer representation.
use super::{
    client::{Client, Command, State},
    model::*,
};
use crate::{exports::Exports, styles::Styles};
use nk_render::{Canvas, ImageFit, Raster};
use nk_text::{ParleyBackend, Point, Rect, Size, TextBackend};
use nk_widgets::{Effect, ImageStyle, Kind, NodeId, Result, Tree, ValueRange};
use std::{collections::BTreeMap, sync::Arc};
#[derive(Clone, Debug, PartialEq)]
enum Control {
    Select(String),
    Enabled,
    Primary,
    Mode,
    Scale,
    Transform,
    Vrr,
    X,
    Y,
    Previous,
    Next,
    Apply,
    Identify,
    Confirm,
    Cancel,
    Refresh,
    Preset(Preset),
    Brightness,
}
struct Diagram {
    id: NodeId,
    rects: Vec<(String, Rect)>,
    scale: f32,
    min: Point,
    size: Size,
}
struct Drag {
    id: String,
    start: Point,
    position: (i32, i32),
    scale: f32,
}
pub struct Page {
    pub client: Client,
    pub state: State,
    pub root: NodeId,
    parent: NodeId,
    selected: String,
    base: Option<Layout>,
    draft: Option<Layout>,
    dirty: bool,
    selector: bool,
    controls: BTreeMap<NodeId, Control>,
    diagram: Option<Diagram>,
    pointer: Point,
    drag: Option<Drag>,
    countdown: Option<NodeId>,
    last_second: Option<u64>,
    status: NodeId,
    status_row: NodeId,
    busy: bool,
}
fn label(e: &Exports, key: &str) -> Result<String> {
    e.text(&format!("settings.display.{key}"))
        .map(str::to_owned)
}
fn info(tree: &mut Tree, parent: NodeId, text: &str) -> Result<NodeId> {
    let row = tree.append(parent, Kind::Row, "")?;
    tree.append(row, Kind::Label, text)
}
fn mirrored(layout: &Layout, id: &str) -> bool {
    layout
        .mirror_groups
        .iter()
        .any(|g| g.iter().any(|v| v == id))
}
fn follower(layout: &Layout, id: &str) -> bool {
    layout
        .mirror_groups
        .iter()
        .any(|g| g.iter().skip(1).any(|v| v == id))
}
fn range(min: f32, max: f32, step: f32, decimals: usize) -> ValueRange {
    ValueRange {
        min,
        max,
        step,
        wrap: false,
        digits: 0,
        decimals,
        unit: String::new(),
    }
}
impl Page {
    pub fn mount(
        tree: &mut Tree,
        parent: NodeId,
        e: &Exports,
        _s: &Styles,
        selector: bool,
    ) -> Result<Self> {
        Self::with_client(tree, parent, e, selector, Client::connect()?)
    }
    pub fn with_client(
        tree: &mut Tree,
        parent: NodeId,
        e: &Exports,
        selector: bool,
        client: Client,
    ) -> Result<Self> {
        let root = tree.group(parent, &label(e, "title")?)?;
        let status_row = tree.append(root, Kind::Row, "")?;
        let status = tree.append(status_row, Kind::Label, e.text("settings.native.loading")?)?;
        Ok(Self {
            client,
            state: State::default(),
            root,
            parent,
            selected: String::new(),
            base: None,
            draft: None,
            dirty: false,
            selector,
            controls: BTreeMap::new(),
            diagram: None,
            pointer: Point::default(),
            drag: None,
            countdown: None,
            last_second: None,
            status,
            status_row,
            busy: false,
        })
    }
    pub fn unmount(self, tree: &mut Tree) -> Result<()> {
        tree.remove(self.root)
    }
    pub fn combo(&self, effect: Effect) -> Option<NodeId> {
        if let Effect::Activated(id) = effect
            && matches!(
                self.controls.get(&id),
                Some(Control::Mode | Control::Transform | Control::Vrr)
            )
        {
            return Some(id);
        }
        None
    }
    fn output_name(&self, output: &Output, e: &Exports) -> Result<String> {
        let mut name = format!(
            "{} · {} {} · {}",
            output.number, output.make, output.model, output.connector
        );
        if self.draft.as_ref().is_some_and(|l| l.primary == output.id) {
            name.push_str(&format!(" · {}", label(e, "native.primary-label")?));
        }
        if self
            .draft
            .as_ref()
            .is_some_and(|l| l.outputs.iter().any(|s| s.id == output.id && !s.enabled))
        {
            name.push_str(&format!(" · {}", label(e, "vrr.off")?));
        }
        Ok(name)
    }
    fn button(
        &mut self,
        tree: &mut Tree,
        group: NodeId,
        e: &Exports,
        key: &str,
        control: Control,
        disabled: bool,
    ) -> Result<NodeId> {
        let text = label(e, key)?;
        let (_, id) = tree.row(group, &text, Kind::Button)?;
        tree.set_disabled(id, disabled)?;
        self.controls.insert(id, control);
        Ok(id)
    }
    fn combo_row(
        &mut self,
        tree: &mut Tree,
        group: NodeId,
        text: &str,
        options: &[String],
        selected: usize,
        control: Control,
    ) -> Result<()> {
        if options.is_empty() {
            return Ok(());
        }
        let (_, id) = tree.dropdown(
            group,
            text,
            &options.iter().map(String::as_str).collect::<Vec<_>>(),
            selected.min(options.len() - 1),
        )?;
        self.controls.insert(id, control);
        Ok(())
    }
    fn spin(
        &mut self,
        tree: &mut Tree,
        group: NodeId,
        text: &str,
        value: f32,
        range: ValueRange,
        control: Control,
    ) -> Result<()> {
        let (_, _, ids) = tree.fields(group, text, vec![(text, range, value)])?;
        self.controls.insert(ids[0], control);
        Ok(())
    }
    pub fn restyle(
        &mut self,
        tree: &mut Tree,
        e: &Exports,
        s: &Styles,
        text: &mut ParleyBackend,
    ) -> Result<()> {
        self.render(tree, e, s, text)
    }
    fn render(
        &mut self,
        tree: &mut Tree,
        e: &Exports,
        s: &Styles,
        text: &mut ParleyBackend,
    ) -> Result<()> {
        let focus = tree
            .focused()
            .and_then(|id| self.controls.get(&id))
            .cloned();
        let old = self.root;
        self.root = tree.group(self.parent, &label(e, "title")?)?;
        self.controls.clear();
        self.diagram = None;
        self.countdown = None;
        self.drag = None;
        self.status_row = tree.append(self.root, Kind::Row, "")?;
        self.status = tree.append(self.status_row, Kind::Label, "")?;
        tree.set_hidden(
            self.status_row,
            self.state.error.is_none()
                && self
                    .state
                    .snapshot
                    .as_ref()
                    .is_some_and(|s| !s.outputs.is_empty()),
        )?;
        if let Some(pending) = self.state.owned.clone() {
            // A lease is a compact confirmation page, not controls buried below a
            // long monitor form. Keep it near the leading edge after a mode change.
            tree.set_width(self.root, s.metrics.content_floor.min(s.metrics.form_width))?;
            self.countdown = Some(info(tree, self.root, &label(e, "confirm.title")?)?);
            self.button(
                tree,
                self.root,
                e,
                "confirm.keep",
                Control::Confirm,
                self.busy
                    || pending.phase != "confirming"
                    || seconds(pending.deadline_us, now_us()) == 0,
            )?;
            let cancel = self.button(
                tree,
                self.root,
                e,
                "confirm.revert",
                Control::Cancel,
                self.busy,
            )?;
            if self.state.error.is_some() {
                tree.set_name(self.status, label(e, "native.error")?)?;
            }
            tree.remove(old)?;
            if let Some((id, _)) = self
                .controls
                .iter()
                .find(|(_, c)| Some(*c) == focus.as_ref())
            {
                let _ = tree.focus(*id);
            } else {
                let _ = tree.focus(cancel);
            }
            self.last_second = None;
            self.tick(tree, e)?;
            return Ok(());
        }
        self.button(
            tree,
            self.root,
            e,
            "native.refresh",
            Control::Refresh,
            self.busy,
        )?;
        if let Some(snapshot) = self.state.snapshot.clone() {
            let locked = self.busy
                || !snapshot.pending.token.is_empty()
                || !snapshot.capabilities.iter().any(|c| c == "preview");
            if snapshot.outputs.is_empty() {
                tree.set_name(self.status, label(e, "error.no-monitors")?)?;
            }
            if !snapshot.outputs.is_empty() {
                let list = tree.list(
                    self.root,
                    &label(e, "group.all")?,
                    s.metrics.row * snapshot.outputs.len().min(3) as f32,
                    s.menu.clone(),
                )?;
                for output in &snapshot.outputs {
                    let name = self.output_name(output, e)?;
                    let id = tree.append(
                        list,
                        Kind::MenuOption {
                            selected: output.id == self.selected,
                        },
                        name,
                    )?;
                    self.controls.insert(id, Control::Select(output.id.clone()));
                }
            }
            if !self.selector {
                let size = Size {
                    width: s.metrics.form_width.min(1024.),
                    height: s.metrics.row * 3.,
                };
                let id = tree.image(
                    self.root,
                    &label(e, "native.arrangement")?,
                    size,
                    ImageStyle {
                        fit: ImageFit::Contain,
                        radius: s.metrics.radius,
                        border_width: s.metrics.focus_width,
                        border: s.palette.separator,
                        background: s.palette.surface,
                    },
                )?;
                self.diagram = Some(Diagram {
                    id,
                    rects: vec![],
                    scale: 1.,
                    min: Point::default(),
                    size,
                });
            }
            let arrangement = if self.selector {
                "native.projection"
            } else {
                "native.arrangement"
            };
            info(tree, self.root, &label(e, arrangement)?)?;
            let presets = if self.selector {
                Some(tree.list(
                    self.root,
                    &label(e, arrangement)?,
                    s.metrics.row * 4.,
                    s.menu.clone(),
                )?)
            } else {
                None
            };
            for (key, choice) in [
                ("native.internal", Preset::Internal),
                ("native.external", Preset::External),
                ("native.extend", Preset::Extend),
                ("native.mirror", Preset::Mirror),
            ] {
                let available = preset(&snapshot, choice).is_ok();
                if let Some(list) = presets {
                    let id = tree.append(
                        list,
                        Kind::MenuOption {
                            selected: current_preset(&snapshot) == choice,
                        },
                        label(e, key)?,
                    )?;
                    tree.set_disabled(id, locked || !available)?;
                    self.controls.insert(id, Control::Preset(choice));
                } else {
                    self.button(
                        tree,
                        self.root,
                        e,
                        key,
                        Control::Preset(choice),
                        locked || !available,
                    )?;
                }
            }
            if !self.selector {
                if let (Some(layout), Some(output)) = (
                    self.draft.clone(),
                    snapshot.outputs.iter().find(|o| o.id == self.selected),
                ) {
                    let setting = layout
                        .outputs
                        .iter()
                        .find(|v| v.id == output.id)
                        .ok_or("selected output has no setting")?;
                    info(
                        tree,
                        self.root,
                        &format!("{} · {}", output.number, output.connector),
                    )?;
                    let group = self.root;
                    let (_, id) = tree.row(
                        group,
                        &label(e, "native.enabled")?,
                        Kind::Switch {
                            checked: setting.enabled,
                        },
                    )?;
                    tree.set_disabled(
                        id,
                        locked
                            || (setting.enabled
                                && layout.outputs.iter().filter(|s| s.enabled).count() == 1),
                    )?;
                    self.controls.insert(id, Control::Enabled);
                    self.button(
                        tree,
                        group,
                        e,
                        "native.primary",
                        Control::Primary,
                        locked
                            || !setting.enabled
                            || layout.primary == output.id
                            || follower(&layout, &output.id),
                    )?;
                    let modes: Vec<_> = output
                        .modes
                        .iter()
                        .map(|m| {
                            format!(
                                "{} × {} · {:.3} Hz",
                                m.width,
                                m.height,
                                m.refresh_mhz as f64 / 1000.
                            )
                        })
                        .collect();
                    self.combo_row(
                        tree,
                        group,
                        &label(e, "resolution")?,
                        &modes,
                        output
                            .modes
                            .iter()
                            .position(|m| m.id == setting.mode)
                            .unwrap_or(0),
                        Control::Mode,
                    )?;
                    self.spin(
                        tree,
                        group,
                        &label(e, "scale")?,
                        setting.scale as f32,
                        range(0.25, 4., 0.25, 2),
                        Control::Scale,
                    )?;
                    let transforms = [
                        "normal",
                        "90",
                        "180",
                        "270",
                        "flipped",
                        "flipped-90",
                        "flipped-180",
                        "flipped-270",
                    ];
                    self.combo_row(
                        tree,
                        group,
                        &label(e, "rotation")?,
                        &transforms
                            .iter()
                            .map(|v| match *v {
                                "normal" => label(e, "rotation.normal"),
                                v if v.starts_with("flipped") => Ok(format!(
                                    "{} {}°",
                                    label(e, "native.flipped")?,
                                    v.strip_prefix("flipped-").unwrap_or("0")
                                )),
                                v => Ok(format!("{v}°")),
                            })
                            .collect::<Result<Vec<_>>>()?,
                        transforms
                            .iter()
                            .position(|v| *v == setting.transform)
                            .unwrap_or(0),
                        Control::Transform,
                    )?;
                    let vrr = vec![
                        label(e, "vrr.off")?,
                        label(e, "vrr.always")?,
                        label(e, "vrr.games")?,
                    ];
                    if output.vrr_supported {
                        self.combo_row(
                            tree,
                            group,
                            &label(e, "vrr")?,
                            &vrr,
                            ["off", "on", "games"]
                                .iter()
                                .position(|v| *v == setting.vrr)
                                .unwrap_or(0),
                            Control::Vrr,
                        )?;
                    }
                    self.spin(
                        tree,
                        group,
                        &label(e, "native.x")?,
                        setting.x as f32,
                        range(-1_000_000., 1_000_000., 1., 0),
                        Control::X,
                    )?;
                    self.spin(
                        tree,
                        group,
                        &label(e, "native.y")?,
                        setting.y as f32,
                        range(-1_000_000., 1_000_000., 1., 0),
                        Control::Y,
                    )?;
                    self.button(
                        tree,
                        group,
                        e,
                        "native.previous",
                        Control::Previous,
                        locked || !setting.enabled || !layout.mirror_groups.is_empty(),
                    )?;
                    self.button(
                        tree,
                        group,
                        e,
                        "native.next",
                        Control::Next,
                        locked || !setting.enabled || !layout.mirror_groups.is_empty(),
                    )?;
                    for (id, control) in &self.controls {
                        if matches!(
                            control,
                            Control::Mode
                                | Control::Scale
                                | Control::Transform
                                | Control::Vrr
                                | Control::X
                                | Control::Y
                        ) {
                            let unsupported = match control {
                                Control::X | Control::Y => follower(&layout, &self.selected),
                                Control::Vrr => mirrored(&layout, &self.selected),
                                _ => false,
                            };
                            tree.set_disabled(*id, locked || !setting.enabled || unsupported)?;
                        }
                    }
                    let current = self.state.brightness.as_ref().and_then(|b| {
                        b.devices.iter().find(|d| {
                            d.output_id == output.id && d.available && d.writable && d.max > 0
                        })
                    });
                    if let Some(device) = current {
                        let (_, id) = tree.slider(
                            group,
                            &label(e, "native.brightness")?,
                            range(device.min as f32, device.max as f32, 1., 0),
                            device.current as f32,
                        )?;
                        self.controls.insert(id, Control::Brightness);
                    }
                }
                self.button(
                    tree,
                    self.root,
                    e,
                    "native.identify",
                    Control::Identify,
                    locked || !snapshot.capabilities.iter().any(|c| c == "identify"),
                )?;
                self.button(
                    tree,
                    self.root,
                    e,
                    "native.apply",
                    Control::Apply,
                    locked || !self.dirty,
                )?;
            }
            if !snapshot.pending.token.is_empty() {
                tree.set_name(self.status, label(e, "native.busy")?)?;
                tree.set_hidden(self.status_row, false)?;
            }
            self.draw(tree, s, text)?;
        }
        if self.state.error.is_some() {
            tree.set_name(self.status, label(e, "native.error")?)?;
        }
        tree.remove(old)?;
        let preferred = if self.selector {
            self.state
                .snapshot
                .as_ref()
                .map(|s| Control::Preset(current_preset(s)))
        } else {
            Some(Control::Select(self.selected.clone()))
        };
        let restore = focus
            .as_ref()
            .and_then(|focus| self.controls.iter().find(|(_, c)| *c == focus))
            .or_else(|| {
                preferred
                    .as_ref()
                    .and_then(|preferred| self.controls.iter().find(|(_, c)| *c == preferred))
            });
        if let Some((id, _)) = restore {
            let _ = tree.focus(*id);
        }
        self.last_second = None;
        self.tick(tree, e)?;
        Ok(())
    }
    pub fn poll(
        &mut self,
        tree: &mut Tree,
        e: &Exports,
        s: &Styles,
        text: &mut ParleyBackend,
    ) -> Result<()> {
        if let Some(state) = self.client.poll() {
            let was_busy = self.busy;
            self.busy = self.client.busy(&state);
            let changed = state.snapshot != self.state.snapshot
                || state.owned != self.state.owned
                || state.error != self.state.error;
            let identity_changed = state.owner != self.state.owner
                || match (&self.state.snapshot, &state.snapshot) {
                    (Some(old), Some(new)) => {
                        old.epoch != new.epoch
                            || !old
                                .outputs
                                .iter()
                                .map(|o| (&o.id, &o.identity, &o.connector, o.internal, &o.modes))
                                .eq(new.outputs.iter().map(|o| {
                                    (&o.id, &o.identity, &o.connector, o.internal, &o.modes)
                                }))
                    }
                    _ => true,
                };
            if let Some(snapshot) = &state.snapshot {
                if identity_changed || self.base.as_ref() != Some(&snapshot.layout) {
                    self.draft = Some(snapshot.layout.clone());
                    self.base = Some(snapshot.layout.clone());
                    self.dirty = false;
                }
                if !snapshot.outputs.iter().any(|o| o.id == self.selected) {
                    self.selected = snapshot
                        .outputs
                        .first()
                        .map(|o| o.id.clone())
                        .unwrap_or_default();
                }
            } else {
                self.draft = None;
                self.base = None;
                self.dirty = false;
            }
            let old_channels = self.state.brightness.as_ref().map(|b| {
                b.devices
                    .iter()
                    .map(|d| {
                        (
                            &d.id,
                            d.epoch,
                            d.output_id.clone(),
                            d.available,
                            d.writable,
                            d.min,
                            d.max,
                        )
                    })
                    .collect::<Vec<_>>()
            });
            let new_channels = state.brightness.as_ref().map(|b| {
                b.devices
                    .iter()
                    .map(|d| {
                        (
                            &d.id,
                            d.epoch,
                            d.output_id.clone(),
                            d.available,
                            d.writable,
                            d.min,
                            d.max,
                        )
                    })
                    .collect::<Vec<_>>()
            });
            let rebuild = changed || was_busy != self.busy || old_channels != new_channels;
            self.state = state;
            if rebuild {
                self.render(tree, e, s, text)?;
            } else {
                for (id, control) in &self.controls {
                    if *control == Control::Brightness
                        && let Some(d) = self.state.brightness.as_ref().and_then(|b| {
                            b.devices
                                .iter()
                                .find(|d| d.output_id == self.selected && d.available && d.writable)
                        })
                    {
                        tree.set_value(*id, d.current as f32)?;
                    }
                }
            }
        }
        self.tick(tree, e)
    }
    fn tick(&mut self, tree: &mut Tree, e: &Exports) -> Result<()> {
        if let (Some(id), Some(pending)) = (self.countdown, &self.state.owned) {
            let seconds = seconds(pending.deadline_us, now_us());
            if self.last_second != Some(seconds) {
                let message = if pending.phase == "confirming" {
                    label(e, "confirm.body")?.replace("%d", &seconds.to_string())
                } else {
                    label(e, "native.busy")?
                };
                tree.set_name(id, message)?;
                self.last_second = Some(seconds);
                if seconds == 0 {
                    for (id, c) in &self.controls {
                        if *c == Control::Confirm {
                            tree.set_disabled(*id, true)?;
                        }
                    }
                }
            }
        }
        Ok(())
    }
    fn sync_draft(
        &mut self,
        tree: &mut Tree,
        e: &Exports,
        s: &Styles,
        text: &mut ParleyBackend,
    ) -> Result<()> {
        let locked = self.busy
            || self.state.snapshot.as_ref().is_some_and(|s| {
                !s.pending.token.is_empty() || !s.capabilities.iter().any(|c| c == "preview")
            });
        let setting = self
            .draft
            .as_ref()
            .and_then(|l| l.outputs.iter().find(|o| o.id == self.selected));
        let output = self
            .state
            .snapshot
            .as_ref()
            .and_then(|s| s.outputs.iter().find(|o| o.id == self.selected));
        for (id, control) in &self.controls {
            let mut disabled = locked;
            match control {
                Control::Confirm => {
                    disabled = self.busy
                        || self.state.owned.as_ref().is_none_or(|p| {
                            p.phase != "confirming" || seconds(p.deadline_us, now_us()) == 0
                        })
                }
                Control::Cancel => disabled = self.busy,
                Control::Refresh => disabled = self.busy,
                Control::Apply => disabled = locked || !self.dirty,
                Control::Preset(p) => {
                    disabled = locked
                        || self
                            .state
                            .snapshot
                            .as_ref()
                            .is_none_or(|snapshot| preset(snapshot, *p).is_err())
                }
                Control::Select(output_id) => {
                    if let Some(output) = self
                        .state
                        .snapshot
                        .as_ref()
                        .and_then(|s| s.outputs.iter().find(|o| &o.id == output_id))
                    {
                        tree.set_name(*id, self.output_name(output, e)?)?;
                    }
                    continue;
                }
                Control::Brightness => continue,
                _ => {
                    if let (Some(setting), Some(output)) = (setting, output) {
                        match control {
                            Control::Enabled => {
                                tree.set_checked(*id, setting.enabled)?;
                                disabled |= setting.enabled
                                    && self.draft.as_ref().is_some_and(|l| {
                                        l.outputs.iter().filter(|o| o.enabled).count() == 1
                                    });
                            }
                            Control::Primary => {
                                disabled |= !setting.enabled
                                    || self
                                        .draft
                                        .as_ref()
                                        .is_some_and(|l| l.primary == self.selected)
                            }
                            Control::Mode => {
                                if let Some(i) =
                                    output.modes.iter().position(|m| m.id == setting.mode)
                                {
                                    tree.set_dropdown_selected(*id, i)?;
                                }
                                disabled |= !setting.enabled;
                            }
                            Control::Scale => {
                                tree.set_value(*id, setting.scale as f32)?;
                                disabled |= !setting.enabled;
                            }
                            Control::X => {
                                tree.set_value(*id, setting.x as f32)?;
                                disabled |= !setting.enabled;
                            }
                            Control::Y => {
                                tree.set_value(*id, setting.y as f32)?;
                                disabled |= !setting.enabled;
                            }
                            Control::Transform => {
                                if let Some(i) = [
                                    "normal",
                                    "90",
                                    "180",
                                    "270",
                                    "flipped",
                                    "flipped-90",
                                    "flipped-180",
                                    "flipped-270",
                                ]
                                .iter()
                                .position(|v| *v == setting.transform)
                                {
                                    tree.set_dropdown_selected(*id, i)?;
                                }
                                disabled |= !setting.enabled;
                            }
                            Control::Vrr => {
                                if let Some(i) = ["off", "on", "games"]
                                    .iter()
                                    .position(|v| *v == setting.vrr)
                                {
                                    tree.set_dropdown_selected(*id, i)?;
                                }
                                disabled |= !setting.enabled;
                            }
                            Control::Previous | Control::Next => disabled |= !setting.enabled,
                            _ => {}
                        }
                    }
                }
            }
            if let Some(layout) = &self.draft {
                disabled |= match control {
                    Control::Primary | Control::X | Control::Y => follower(layout, &self.selected),
                    Control::Vrr => mirrored(layout, &self.selected),
                    Control::Previous | Control::Next => !layout.mirror_groups.is_empty(),
                    _ => false,
                };
            }
            tree.set_disabled(*id, disabled)?;
        }
        if self.state.error.is_some() {
            tree.set_name(self.status, label(e, "native.error")?)?;
            tree.set_hidden(self.status_row, false)?;
        }
        self.draw(tree, s, text)
    }
    fn send(&mut self, command: Command) -> Result<()> {
        match self.client.send(command) {
            Ok(()) => self.busy = true,
            Err(error) => {
                self.state.error = Some(error);
                self.busy = false;
            }
        }
        Ok(())
    }
    pub fn effect(
        &mut self,
        tree: &mut Tree,
        e: &Exports,
        s: &Styles,
        text: &mut ParleyBackend,
        effect: Effect,
    ) -> Result<bool> {
        let id = match effect {
            Effect::Changed(id) | Effect::Activated(id) => id,
            _ => return Ok(false),
        };
        let id = if tree
            .node(id)
            .is_some_and(|n| matches!(n.kind(), Kind::List { .. }))
        {
            tree.node(id)
                .and_then(|n| {
                    n.children().iter().find(|child| {
                        tree.node(**child).is_some_and(|n| {
                            matches!(n.kind(), Kind::MenuOption { selected: true })
                        }) && self.controls.contains_key(child)
                    })
                })
                .copied()
                .unwrap_or(id)
        } else {
            id
        };
        let Some(control) = self.controls.get(&id).cloned() else {
            return Ok(false);
        };
        if let Control::Select(selected) = control {
            self.selected = selected;
            self.render(tree, e, s, text)?;
            return Ok(true);
        }
        if control == Control::Refresh {
            self.client = Client::connect()?;
            self.busy = false;
            return Ok(true);
        }
        if control == Control::Brightness {
            if let Some(b) = &self.state.brightness
                && let Some(d) = b
                    .devices
                    .iter()
                    .find(|d| d.output_id == self.selected && d.available && d.writable)
            {
                self.client.send(Command::Brightness {
                    generation: b.generation,
                    id: d.id.clone(),
                    epoch: d.epoch,
                    value: tree.value(id).unwrap_or(d.current as f32) as u32,
                })?;
            }
            return Ok(true);
        }
        if self.busy {
            return Ok(true);
        }
        let Some(snapshot) = self.state.snapshot.clone() else {
            return Ok(true);
        };
        match control {
            Control::Confirm => {
                if let Some(p) = &self.state.owned {
                    self.send(Command::Confirm(p.token.clone()))?;
                }
            }
            Control::Cancel => self.send(Command::Cancel)?,
            Control::Identify => self.send(Command::Identify {
                owner: self.state.owner.clone(),
                epoch: snapshot.epoch,
                revision: snapshot.revision,
            })?,
            Control::Apply => {
                if let Some(layout) = self.draft.clone() {
                    self.send(Command::Preview {
                        owner: self.state.owner.clone(),
                        epoch: snapshot.epoch,
                        revision: snapshot.revision,
                        layout,
                    })?;
                }
            }
            Control::Preset(choice) => match preset(&snapshot, choice) {
                Ok(layout) => {
                    self.draft = Some(layout.clone());
                    self.dirty = true;
                    if self.selector {
                        self.send(Command::Preview {
                            owner: self.state.owner.clone(),
                            epoch: snapshot.epoch,
                            revision: snapshot.revision,
                            layout,
                        })?;
                    }
                }
                Err(error) => {
                    self.state.error = Some(error);
                }
            },
            edit => {
                if !snapshot.pending.token.is_empty() {
                    return Ok(true);
                }
                if let Some(layout) = &mut self.draft {
                    if edit == Control::Primary {
                        layout.primary = self.selected.clone();
                    } else if edit == Control::Enabled {
                        let enabled = tree
                            .node(id)
                            .is_some_and(|n| matches!(n.kind(), Kind::Switch { checked: true }));
                        if let Err(error) =
                            set_enabled(layout, &snapshot.outputs, &self.selected, enabled)
                        {
                            self.state.error = Some(error);
                        }
                    } else if edit == Control::Previous || edit == Control::Next {
                        reorder(
                            layout,
                            &snapshot.outputs,
                            &self.selected,
                            if edit == Control::Previous { -1 } else { 1 },
                        );
                    } else if let Some(setting) =
                        layout.outputs.iter_mut().find(|v| v.id == self.selected)
                    {
                        let output = snapshot
                            .outputs
                            .iter()
                            .find(|o| o.id == self.selected)
                            .ok_or("output lost")?;
                        match edit {
                            Control::Mode => {
                                let i = tree.dropdown_selected(id)?;
                                if let Some(mode) = output.modes.get(i) {
                                    setting.mode = mode.id.clone();
                                }
                            }
                            Control::Scale => setting.scale = tree.value(id).unwrap_or(1.) as f64,
                            Control::X => setting.x = tree.value(id).unwrap_or(0.) as i32,
                            Control::Y => setting.y = tree.value(id).unwrap_or(0.) as i32,
                            Control::Transform => {
                                setting.transform = [
                                    "normal",
                                    "90",
                                    "180",
                                    "270",
                                    "flipped",
                                    "flipped-90",
                                    "flipped-180",
                                    "flipped-270",
                                ][tree.dropdown_selected(id)?]
                                .into()
                            }
                            Control::Vrr => {
                                setting.vrr =
                                    ["off", "on", "games"][tree.dropdown_selected(id)?].into()
                            }
                            _ => {}
                        }
                    }
                    if !layout
                        .outputs
                        .iter()
                        .any(|o| o.id == layout.primary && o.enabled)
                    {
                        layout.primary = layout
                            .outputs
                            .iter()
                            .find(|o| o.enabled)
                            .map(|o| o.id.clone())
                            .unwrap_or_default();
                    }
                    self.dirty = self.base.as_ref() != Some(layout);
                }
            }
        }
        self.sync_draft(tree, e, s, text)?;
        Ok(true)
    }
    fn draw(&mut self, tree: &mut Tree, s: &Styles, text: &mut ParleyBackend) -> Result<()> {
        let (Some(diagram), Some(layout), Some(snapshot)) =
            (&mut self.diagram, &self.draft, &self.state.snapshot)
        else {
            return Ok(());
        };
        let boxes: Vec<_> = layout
            .outputs
            .iter()
            .filter(|o| o.enabled)
            .filter_map(|setting| {
                let output = snapshot.outputs.iter().find(|o| o.id == setting.id)?;
                let (w, h) = dimensions(setting, output)?;
                Some((setting, output, w, h))
            })
            .collect();
        let minx = boxes.iter().map(|v| v.0.x).min().unwrap_or(0) as f32;
        let miny = boxes.iter().map(|v| v.0.y).min().unwrap_or(0) as f32;
        let maxx = boxes.iter().map(|v| v.0.x + v.2).max().unwrap_or(1) as f32;
        let maxy = boxes.iter().map(|v| v.0.y + v.3).max().unwrap_or(1) as f32;
        let pad = s.metrics.padding;
        let factor = ((diagram.size.width - 2. * pad) / (maxx - minx).max(1.))
            .min((diagram.size.height - 2. * pad) / (maxy - miny).max(1.));
        let (minx, miny, factor) = if self.drag.is_some() {
            (diagram.min.x, diagram.min.y, diagram.scale)
        } else {
            diagram.min = Point { x: minx, y: miny };
            diagram.scale = factor;
            (minx, miny, factor)
        };
        diagram.rects.clear();
        let width = diagram.size.width as u16;
        let height = diagram.size.height as u16;
        let mut canvas = Canvas::new(width, height, 1.);
        canvas.rect(
            Rect {
                x: 0.,
                y: 0.,
                width: width as f32,
                height: height as f32,
            },
            s.palette.background,
        );
        for (setting, output, w, h) in boxes {
            let r = Rect {
                x: pad + (setting.x as f32 - minx) * factor,
                y: pad + (setting.y as f32 - miny) * factor,
                width: w as f32 * factor,
                height: h as f32 * factor,
            };
            canvas.rounded_rect(r, s.metrics.radius as f64, s.palette.surface);
            canvas.rounded_ring(
                r,
                s.metrics.radius as f64,
                s.metrics.focus_width as f64,
                if setting.id == self.selected {
                    s.palette.accent
                } else {
                    s.palette.separator
                },
            );
            let name = format!("{} · {}", output.number, output.connector);
            let label = text.layout(&name, &s.text, (r.width - 2. * s.metrics.gap).max(1.))?;
            canvas.layout(
                &label,
                (r.x + s.metrics.gap, r.y + s.metrics.gap),
                s.palette.text,
            )?;
            diagram.rects.push((setting.id.clone(), r));
        }
        let pixels = canvas
            .finish()
            .as_chunks::<4>()
            .0
            .iter()
            .flat_map(|p| {
                let pixel = u32::from_ne_bytes(*p);
                let a = (pixel >> 24) as u8;
                let c = |shift: u32| {
                    let value = (pixel >> shift) & 255u32;
                    if a == 0 {
                        0
                    } else {
                        (value * 255 / a as u32).min(255) as u8
                    }
                };
                [c(16), c(8), c(0), a]
            })
            .collect();
        tree.set_image(
            diagram.id,
            Some(Arc::new(Raster::from_rgba(width, height, pixels)?)),
        )
    }
    /// Consumes only presses in the diagram and their matching releases; other
    /// input stays with the retained tree. Drag uses the initial projection.
    pub fn pointer(
        &mut self,
        tree: &mut Tree,
        e: &Exports,
        s: &Styles,
        text: &mut ParleyBackend,
        event: &nk_wayland::Event,
    ) -> Result<bool> {
        match event {
            nk_wayland::Event::Motion(x, y) => {
                self.pointer = Point {
                    x: *x as f32,
                    y: *y as f32,
                };
                if let Some(drag) = &self.drag {
                    if let Some(layout) = &mut self.draft
                        && let Some(setting) = layout.outputs.iter_mut().find(|o| o.id == drag.id)
                    {
                        setting.x = (drag.position.0
                            + ((self.pointer.x - drag.start.x) / drag.scale).round() as i32)
                            .clamp(-1_000_000, 1_000_000);
                        setting.y = (drag.position.1
                            + ((self.pointer.y - drag.start.y) / drag.scale).round() as i32)
                            .clamp(-1_000_000, 1_000_000);
                        self.dirty = true;
                    }
                    self.draw(tree, s, text)?;
                    return Ok(true);
                }
            }
            nk_wayland::Event::Button {
                button: 0x110,
                pressed: true,
                ..
            } => {
                if self.busy
                    || self
                        .state
                        .snapshot
                        .as_ref()
                        .is_none_or(|v| !v.pending.token.is_empty())
                    || self
                        .draft
                        .as_ref()
                        .is_some_and(|l| !l.mirror_groups.is_empty())
                {
                    return Ok(false);
                }
                if let Some(diagram) = &self.diagram
                    && tree.showing(diagram.id)
                {
                    let bounds = tree.node(diagram.id).unwrap().bounds();
                    let visible = tree.content_viewport();
                    let p = self.pointer;
                    if p.x < visible.x
                        || p.y < visible.y
                        || p.x > visible.x + visible.width
                        || p.y > visible.y + visible.height
                    {
                        return Ok(false);
                    }
                    let factor = bounds.width / diagram.size.width;
                    let local = Point {
                        x: (p.x - bounds.x) / factor,
                        y: (p.y - bounds.y) / factor,
                    };
                    if let Some((id, _)) = diagram.rects.iter().rev().find(|(_, r)| {
                        local.x >= r.x
                            && local.y >= r.y
                            && local.x <= r.x + r.width
                            && local.y <= r.y + r.height
                    }) {
                        self.selected = id.clone();
                        if let Some(setting) = self
                            .draft
                            .as_ref()
                            .and_then(|l| l.outputs.iter().find(|o| o.id == *id))
                        {
                            self.drag = Some(Drag {
                                id: id.clone(),
                                start: p,
                                position: (setting.x, setting.y),
                                scale: diagram.scale * factor,
                            });
                            return Ok(true);
                        }
                    }
                }
            }
            nk_wayland::Event::Button {
                button: 0x110,
                pressed: false,
                ..
            } => {
                if self.drag.take().is_some() {
                    if let (Some(layout), Some(snapshot)) = (&mut self.draft, &self.state.snapshot)
                    {
                        snap(layout, &snapshot.outputs, &self.selected);
                    }
                    self.render(tree, e, s, text)?;
                    return Ok(true);
                }
            }
            nk_wayland::Event::PointerLeave | nk_wayland::Event::Focus(false) => {
                self.drag = None;
            }
            _ => {}
        }
        Ok(false)
    }
}
/// Attach at the nearest edge, retaining the perpendicular offset while ensuring
/// positive shared-edge contact. Complex graphs still go through server Validate.
fn snap(layout: &mut Layout, outputs: &[Output], id: &str) {
    let Some(selected) = layout.outputs.iter().find(|s| s.id == id).cloned() else {
        return;
    };
    let Some((w, h)) = outputs
        .iter()
        .find(|o| o.id == id)
        .and_then(|o| dimensions(&selected, o))
    else {
        return;
    };
    let mut options = vec![];
    for other in layout.outputs.iter().filter(|s| s.id != id && s.enabled) {
        if let Some((ow, oh)) = outputs
            .iter()
            .find(|o| o.id == other.id)
            .and_then(|o| dimensions(other, o))
        {
            options.extend([
                (
                    other.x + ow,
                    selected.y.clamp(other.y - h + 1, other.y + oh - 1),
                ),
                (
                    other.x - w,
                    selected.y.clamp(other.y - h + 1, other.y + oh - 1),
                ),
                (
                    selected.x.clamp(other.x - w + 1, other.x + ow - 1),
                    other.y + oh,
                ),
                (
                    selected.x.clamp(other.x - w + 1, other.x + ow - 1),
                    other.y - h,
                ),
            ]);
        }
    }
    if let Some((x, y)) = options.into_iter().min_by_key(|(x, y)| {
        let dx = *x as i64 - selected.x as i64;
        let dy = *y as i64 - selected.y as i64;
        dx * dx + dy * dy
    }) && let Some(setting) = layout.outputs.iter_mut().find(|s| s.id == id)
    {
        setting.x = x;
        setting.y = y;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        display::tests::{Fixture, wait},
        portal::Appearance,
    };
    fn appearance() -> Appearance {
        Appearance {
            accent: [0., 136. / 255., 1.],
            dark: true,
            reduce_transparency: false,
            window_background: "opaque".into(),
            reduced_motion: false,
            font: "Inter Variable 11".into(),
            text_scale: 1.,
        }
    }
    fn control(page: &Page, needle: Control) -> NodeId {
        page.controls
            .iter()
            .find(|(_, c)| **c == needle)
            .map(|(id, _)| *id)
            .unwrap()
    }
    #[test]
    fn retained_display_edits_are_drafts_and_unmount_closes_the_lease_sender() {
        let fixture = Fixture::new();
        let exports = Exports::load(&Exports::root()).expect("actual complete exports required");
        let styles = Styles::new(&exports, &appearance()).unwrap();
        let mut tree = Tree::new("fixture", styles.metrics, styles.text.clone()).unwrap();
        styles.apply(&mut tree).unwrap();
        let parent = tree.append(tree.root(), Kind::Scroll, "content").unwrap();
        let mut page =
            Page::with_client(&mut tree, parent, &exports, false, fixture.client()).unwrap();
        let mut text = ParleyBackend::with_system_fonts(Arc::new(
            nk_text::FontSet::discover_required().unwrap(),
        ))
        .unwrap();
        wait(|| {
            page.poll(&mut tree, &exports, &styles, &mut text).unwrap();
            page.state.snapshot.is_some()
        });
        tree.layout(
            Size {
                width: 900.,
                height: 800.,
            },
            false,
            &mut text,
        )
        .unwrap();
        assert!(fixture.fake.calls.lock().unwrap().is_empty());
        assert!(page.diagram.as_ref().is_some_and(|d| d.rects.len() == 2));
        assert!(
            tree.semantics()
                .nodes
                .values()
                .any(|n| n.name == label(&exports, "native.x").unwrap())
        );
        let scale = control(&page, Control::Scale);
        let effect = tree.request_value(tree.target(scale), 1.25).unwrap();
        page.effect(&mut tree, &exports, &styles, &mut text, effect)
            .unwrap();
        assert!(page.dirty);
        assert_eq!(
            control(&page, Control::Scale),
            scale,
            "draft edits must keep semantic ids"
        );
        assert!(fixture.fake.calls.lock().unwrap().is_empty());
        // Even identical opaque ids/layouts cannot carry a draft across epochs.
        let stale_scale = tree.target(scale);
        fixture.fake.snapshot.lock().unwrap().epoch = 8;
        fixture
            .service
            .emit_signal(
                None::<&str>,
                crate::display::client::PATH,
                crate::display::client::IFACE,
                "Changed",
                &(8u64, 1u64),
            )
            .unwrap();
        wait(|| {
            page.poll(&mut tree, &exports, &styles, &mut text).unwrap();
            page.state.snapshot.as_ref().is_some_and(|s| s.epoch == 8)
        });
        assert!(!page.dirty);
        assert!(tree.request_value(stale_scale, 1.5).is_err());
        assert!(fixture.fake.calls.lock().unwrap().is_empty());
        let scale = control(&page, Control::Scale);
        let effect = tree.request_value(tree.target(scale), 1.25).unwrap();
        page.effect(&mut tree, &exports, &styles, &mut text, effect)
            .unwrap();
        let apply = control(&page, Control::Apply);
        let stale = tree.target(apply);
        let effect = tree.dispatch(stale, nk_widgets::Command::Activate).unwrap();
        page.effect(&mut tree, &exports, &styles, &mut text, effect)
            .unwrap();
        assert!(tree.dispatch(stale, nk_widgets::Command::Activate).is_err());
        wait(|| {
            page.poll(&mut tree, &exports, &styles, &mut text).unwrap();
            page.state.owned.is_some()
        });
        assert_eq!(
            &*fixture.fake.calls.lock().unwrap(),
            &["validate", "preview"]
        );
        let countdown = page.countdown.unwrap();
        assert!(!tree.node(countdown).unwrap().name().is_empty());
        let sender = fixture.fake.sender.lock().unwrap().clone();
        page.unmount(&mut tree).unwrap();
        let dbus = zbus::blocking::fdo::DBusProxy::new(&fixture.service).unwrap();
        wait(|| {
            !dbus
                .name_has_owner(sender.as_str().try_into().unwrap())
                .unwrap()
        });
    }
    #[test]
    fn mirror_followers_are_not_primary_or_independent_positions() {
        let fixture = Fixture::new();
        {
            let mut snapshot = fixture.fake.snapshot.lock().unwrap();
            snapshot.layout = preset(&snapshot, Preset::Mirror).unwrap();
        }
        let exports = Exports::load(&Exports::root()).unwrap();
        let styles = Styles::new(&exports, &appearance()).unwrap();
        let mut tree = Tree::new("fixture", styles.metrics, styles.text.clone()).unwrap();
        styles.apply(&mut tree).unwrap();
        let parent = tree.append(tree.root(), Kind::Scroll, "content").unwrap();
        let mut page =
            Page::with_client(&mut tree, parent, &exports, false, fixture.client()).unwrap();
        let mut text = ParleyBackend::with_system_fonts(Arc::new(
            nk_text::FontSet::discover_required().unwrap(),
        ))
        .unwrap();
        wait(|| {
            page.poll(&mut tree, &exports, &styles, &mut text).unwrap();
            page.state.snapshot.is_some()
        });
        let selected = control(&page, Control::Select("external".into()));
        let effect = tree
            .dispatch(tree.target(selected), nk_widgets::Command::Activate)
            .unwrap();
        page.effect(&mut tree, &exports, &styles, &mut text, effect)
            .unwrap();
        assert_eq!(page.selected, "external");
        for name in [
            Control::Primary,
            Control::X,
            Control::Y,
            Control::Vrr,
            Control::Previous,
            Control::Next,
        ] {
            let id = control(&page, name);
            assert!(
                tree.dispatch(tree.target(id), nk_widgets::Command::Focus)
                    .is_err()
            );
        }
        let enabled = control(&page, Control::Enabled);
        let effect = tree
            .dispatch(tree.target(enabled), nk_widgets::Command::Activate)
            .unwrap();
        page.effect(&mut tree, &exports, &styles, &mut text, effect)
            .unwrap();
        let draft = page.draft.as_ref().unwrap();
        assert!(draft.mirror_groups.is_empty());
        assert_eq!(draft.primary, "panel");
        assert!(fixture.fake.calls.lock().unwrap().is_empty());
    }
    #[test]
    fn drag_snap_and_keyboard_order_share_logical_coordinates() {
        let snapshot = crate::display::tests::snapshot();
        let mut layout = snapshot.layout.clone();
        let external = layout
            .outputs
            .iter_mut()
            .find(|o| o.id == "external")
            .unwrap();
        external.x = 1190;
        external.y = 12;
        snap(&mut layout, &snapshot.outputs, "external");
        let external = layout.outputs.iter().find(|o| o.id == "external").unwrap();
        assert_eq!((external.x, external.y), (1200, 12));
        let external = layout
            .outputs
            .iter_mut()
            .find(|o| o.id == "external")
            .unwrap();
        external.y = 100_000;
        // Clamp the perpendicular offset to one logical unit of shared edge,
        // rather than snapping the two origins together.
        snap(&mut layout, &snapshot.outputs, "external");
        let external = layout.outputs.iter().find(|o| o.id == "external").unwrap();
        assert_eq!((external.x, external.y), (1199, 800));
        reorder(&mut layout, &snapshot.outputs, "external", -1);
        let panel = layout.outputs.iter().find(|o| o.id == "panel").unwrap();
        assert_eq!(panel.x, 1600);
    }
}
