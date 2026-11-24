// SPDX-License-Identifier: LGPL-3.0-or-later
//! Display1 page for AppWindow. A visit owns its own lease connection.
use super::{
    client::{Client, Command, State},
    model::*,
};
use crate::exports::Exports;
use nk::{
    Activated, AppWindow, Arrangement, ArrangementItem, ArrangementProjection, Node, Space, Type,
    Value, Weight,
};

pub(crate) const ID: &str = "display";
pub(crate) const REVERT_GROUP: &str = "display/confirmation/buttons";
const PREFIX: &str = "display:";
const TRANSFORMS: [&str; 8] = [
    "normal",
    "90",
    "180",
    "270",
    "flipped",
    "flipped-90",
    "flipped-180",
    "flipped-270",
];
const VRR: [&str; 3] = ["off", "on", "games"];
const PRESETS: [(&str, Preset); 4] = [
    ("internal", Preset::Internal),
    ("external", Preset::External),
    ("extend", Preset::Extend),
    ("mirror", Preset::Mirror),
];

#[derive(Default)]
pub struct Display {
    client: Option<Client>,
    state: State,
    selected: String,
    draft: Option<Layout>,
    busy: bool,
    last_second: Option<u64>,
    focus_revert: bool,
    drag: Option<Drag>,
    coordinates: [Option<String>; 2],
}

struct Drag {
    id: String,
    origin: (i32, i32),
    projection: ArrangementProjection,
}

fn label<'a>(e: &'a Exports, key: &str) -> Result<&'a str, String> {
    e.text(&format!("settings.display.{key}"))
}

fn diagram_items(
    snapshot: &Snapshot,
    layout: &Layout,
    selected: &str,
    movable: bool,
) -> Vec<ArrangementItem> {
    layout
        .outputs
        .iter()
        .filter(|setting| setting.enabled)
        .filter_map(|setting| {
            let output = snapshot
                .outputs
                .iter()
                .find(|output| output.id == setting.id)?;
            let (width, height) = dimensions(setting, output)?;
            let name = format!("{} · {}", output.number, output.connector);
            Some(ArrangementItem {
                key: format!("display/diagram/{}", output.id).into(),
                action: format!("display:diagram:{}", output.id),
                name: name.clone(),
                label: name,
                bounds: [
                    setting.x.into(),
                    setting.y.into(),
                    width.into(),
                    height.into(),
                ],
                selected: output.id == selected,
                movable,
            })
        })
        .collect()
}

fn scales(current: f64) -> Vec<f64> {
    let mut values: Vec<_> = (1..=16).map(|n| f64::from(n) / 4.).collect();
    if !values.contains(&current) {
        let index = values.partition_point(|value| *value < current);
        values.insert(index, current);
    }
    values
}

impl Display {
    pub fn visit(&mut self) {
        self.client = None;
        self.busy = false;
        match Client::connect() {
            Ok(client) => self.client = Some(client),
            Err(error) => self.state.error = Some(error),
        }
    }

    pub(crate) fn take_revert_focus(&mut self) -> bool {
        !self.busy && self.state.owned.is_some() && std::mem::take(&mut self.focus_revert)
    }

    pub fn poll(&mut self) -> bool {
        let mut changed = false;
        if let Some(client) = &self.client
            && let Some(state) = client.poll()
        {
            changed = true;
            self.busy = client.busy(&state);
            self.focus_revert =
                state.owned.is_some() && (self.focus_revert || self.state.owned.is_none());
            let old = self.state.snapshot.as_ref();
            let new = state.snapshot.as_ref();
            let replace_draft = self.state.owner != state.owner
                || match old.zip(new) {
                    Some((old, new)) => {
                        old.epoch != new.epoch
                            || old.layout != new.layout
                            || !old
                                .outputs
                                .iter()
                                .map(output_identity)
                                .eq(new.outputs.iter().map(output_identity))
                    }
                    None => true,
                };
            if replace_draft {
                self.draft = new.map(|snapshot| snapshot.layout.clone());
                self.coordinates = Default::default();
                self.drag = None;
            }
            if let Some(snapshot) = new
                && !snapshot
                    .outputs
                    .iter()
                    .any(|output| output.id == self.selected)
            {
                self.selected = snapshot
                    .outputs
                    .first()
                    .map_or_else(String::new, |output| output.id.clone());
                self.coordinates = Default::default();
            }
            self.state = state;
        }
        let second = self
            .state
            .owned
            .as_ref()
            .map(|pending| seconds(pending.deadline_us, now_us()));
        changed |= second != self.last_second;
        self.last_second = second;
        changed
    }

    fn send(&mut self, command: Command) {
        let Some(client) = &self.client else { return };
        let blocks = !matches!(command, Command::Brightness { .. });
        match client.send(command) {
            Ok(()) => self.busy |= blocks,
            Err(error) => self.state.error = Some(error),
        }
    }

    fn locked(&self, snapshot: &Snapshot) -> bool {
        self.busy || !snapshot.pending.token.is_empty() || !has(snapshot, "preview")
    }

    fn brightness(&self) -> Option<(&Brightness, &Device)> {
        let brightness = self.state.brightness.as_ref()?;
        let device = brightness.devices.iter().find(|device| {
            device.output_id == self.selected
                && device.available
                && device.writable
                && device.max > device.min
        })?;
        Some((brightness, device))
    }

    pub fn activate(
        &mut self,
        action: &Activated,
        held: bool,
        size: (f64, f64),
        inset: f64,
    ) -> bool {
        let Some(action_name) = action.action.strip_prefix(PREFIX) else {
            return false;
        };
        if action_name == "refresh" && !self.busy {
            self.visit();
            return true;
        }
        if self.busy {
            return true;
        }
        if let ("brightness", Some(value), Some((brightness, device))) = (
            action_name,
            action.value.as_ref().and_then(Value::number),
            self.brightness(),
        ) {
            self.send(Command::Brightness {
                generation: brightness.generation,
                id: device.id.clone(),
                epoch: device.epoch,
                value: value.clamp(f64::from(device.min), f64::from(device.max)) as u32,
            });
            return true;
        }
        if let Some(pending) = &self.state.owned {
            match action_name {
                "keep"
                    if pending.phase == "confirming"
                        && seconds(pending.deadline_us, now_us()) > 0 =>
                {
                    self.send(Command::Confirm(pending.token.clone()));
                }
                "revert" => self.send(Command::Cancel),
                _ => {}
            }
            return true;
        }
        let Some(snapshot) = self.state.snapshot.as_ref() else {
            return true;
        };
        if let ("output", Some(Value::Index(index))) = (action_name, &action.value) {
            if let Some(output) = snapshot.outputs.get(*index) {
                self.selected.clone_from(&output.id);
                self.coordinates = Default::default();
                self.drag = None;
            }
            return true;
        }
        let locked = self.locked(snapshot);
        let Some(layout) = self.draft.as_mut() else {
            return true;
        };
        if let Some(id) = action_name.strip_prefix("diagram:") {
            self.selected = id.to_owned();
            self.coordinates = Default::default();
            if let Some(Value::Displacement(dx, dy)) = action.value
                && !locked
                && layout.mirror_groups.is_empty()
            {
                if self.drag.as_ref().is_none_or(|drag| drag.id != id) {
                    let Some(setting) = layout
                        .outputs
                        .iter()
                        .find(|setting| setting.id == id && setting.enabled)
                    else {
                        return true;
                    };
                    self.drag = Some(Drag {
                        id: id.into(),
                        origin: (setting.x, setting.y),
                        projection: ArrangementProjection::fit(
                            &diagram_items(snapshot, layout, id, true),
                            size,
                            inset,
                        ),
                    });
                }
                if let Some(drag) = &self.drag
                    && let Some(setting) =
                        layout.outputs.iter_mut().find(|setting| setting.id == id)
                {
                    setting.x = (f64::from(drag.origin.0) + dx)
                        .round()
                        .clamp(-1_000_000., 1_000_000.) as i32;
                    setting.y = (f64::from(drag.origin.1) + dy)
                        .round()
                        .clamp(-1_000_000., 1_000_000.) as i32;
                }
                if !held && self.drag.take().is_some() && (dx != 0. || dy != 0.) {
                    snap(layout, &snapshot.outputs, id);
                }
            }
            return true;
        }
        if locked {
            return true;
        }
        self.drag = None;
        match action_name {
            "apply" if valid_coordinates(&self.coordinates) && *layout != snapshot.layout => {
                let command = Command::Preview {
                    owner: self.state.owner.clone(),
                    epoch: snapshot.epoch,
                    revision: snapshot.revision,
                    layout: layout.clone(),
                };
                self.send(command);
            }
            "identify" if has(snapshot, "identify") => self.send(Command::Identify {
                owner: self.state.owner.clone(),
                epoch: snapshot.epoch,
                revision: snapshot.revision,
            }),
            action_name if action_name.starts_with("preset:") => {
                if let Some((_, choice)) = PRESETS
                    .iter()
                    .find(|(key, _)| Some(*key) == action_name.strip_prefix("preset:"))
                    && let Ok(next) = preset(snapshot, *choice)
                {
                    *layout = next;
                    self.coordinates = Default::default();
                }
            }
            _ => {
                if let Err(error) = edit(
                    layout,
                    snapshot,
                    &self.selected,
                    action_name,
                    action.value.as_ref(),
                    &mut self.coordinates,
                ) {
                    self.state.error = Some(error);
                }
            }
        }
        true
    }

    pub fn cancel_drag(&mut self) -> bool {
        let Some(drag) = self.drag.take() else {
            return false;
        };
        if let Some(layout) = self.draft.as_mut()
            && let Some(setting) = layout
                .outputs
                .iter_mut()
                .find(|setting| setting.id == drag.id)
        {
            (setting.x, setting.y) = drag.origin;
        }
        true
    }
}

fn valid_coordinates(coordinates: &[Option<String>; 2]) -> bool {
    coordinates.iter().flatten().all(|text| {
        text.parse::<i32>()
            .is_ok_and(|number| (-1_000_000..=1_000_000).contains(&number))
    })
}

fn has(snapshot: &Snapshot, capability: &str) -> bool {
    snapshot
        .capabilities
        .iter()
        .any(|value| value == capability)
}

fn output_identity(output: &Output) -> (&str, &str, &str, bool, &[Mode]) {
    (
        &output.id,
        &output.identity,
        &output.connector,
        output.internal,
        &output.modes,
    )
}

fn edit(
    layout: &mut Layout,
    snapshot: &Snapshot,
    selected: &str,
    action: &str,
    value: Option<&Value>,
    coordinates: &mut [Option<String>; 2],
) -> Result<(), String> {
    if let ("enabled", Some(Value::Bool(enabled))) = (action, value) {
        set_enabled(layout, &snapshot.outputs, selected, *enabled)?;
        *coordinates = Default::default();
        return Ok(());
    }
    let Some(output) = snapshot.outputs.iter().find(|output| output.id == selected) else {
        return Ok(());
    };
    let follows = follower(layout, selected);
    let mirrors = mirrored(layout, selected);
    let Some(setting) = layout
        .outputs
        .iter_mut()
        .find(|setting| setting.id == selected && setting.enabled)
    else {
        return Ok(());
    };
    match (action, value) {
        ("primary", _) if !follows => layout.primary = selected.into(),
        ("before" | "after", _) if layout.mirror_groups.is_empty() => {
            reorder(
                layout,
                &snapshot.outputs,
                selected,
                if action == "before" { -1 } else { 1 },
            );
            *coordinates = Default::default();
        }
        ("mode", Some(Value::Index(index))) => {
            if let Some(mode) = output.modes.get(*index) {
                setting.mode.clone_from(&mode.id);
            }
        }
        ("scale", Some(Value::Index(index))) => {
            if let Some(scale) = scales(setting.scale).get(*index) {
                setting.scale = *scale;
            }
        }
        ("rotation", Some(Value::Index(index))) => {
            if let Some(value) = TRANSFORMS.get(*index) {
                setting.transform = (*value).into();
            }
        }
        ("vrr", Some(Value::Index(index))) if !mirrors && output.vrr_supported => {
            if let Some(value) = VRR.get(*index) {
                setting.vrr = (*value).into();
            }
        }
        ("x" | "y", Some(Value::Text(text))) if !follows => {
            let axis = usize::from(action == "y");
            coordinates[axis] = Some(text.clone());
            if let Ok(value) = text.parse::<i32>()
                && (-1_000_000..=1_000_000).contains(&value)
            {
                if axis == 0 {
                    setting.x = value;
                } else {
                    setting.y = value;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

pub(crate) fn diagram_metrics(host: &AppWindow) -> ((f64, f64), f64) {
    let frame = &host.look().frame;
    let inset = host.look().tokens.spacing.px(Space::S3);
    ((frame.icon * 16., frame.icon * 8.), inset)
}

impl Display {
    pub fn rows(&self, host: &AppWindow, e: &Exports) -> Result<Vec<Node>, String> {
        let types = &host.look().types;
        let body = || types.style(Type::Body, Weight::Regular);
        let title = |id, text| nk::Label::new(id, text, types.style(Type::Body, Weight::Medium));
        let button = |key: &str, text: &str, enabled: bool| {
            Ok::<_, String>(
                nk::Button::new(
                    format!("display/{key}"),
                    label(e, text)?,
                    format!("{PREFIX}{key}"),
                    body(),
                )
                .enabled(enabled)
                .into(),
            )
        };
        let row = |id: &str, text: &str, end: Node| {
            nk::ListRow::new(format!("display/row/{id}"), text, body())
                .trailing(end)
                .into()
        };
        let dropdown = |id: &str, text: &str, labels, chosen, enabled| {
            row(
                id,
                text,
                nk::DropDown::new(
                    format!("display/{id}"),
                    text,
                    format!("{PREFIX}{id}"),
                    labels,
                    chosen,
                )
                .enabled(enabled)
                .into(),
            )
        };
        let group = |key: &str, rows| {
            nk::Group::new(
                format!("display/{key}/group"),
                nk::Column::new(format!("display/{key}/rows"), rows),
            )
            .into()
        };
        let mut rows = Vec::new();
        if self.state.error.is_some() {
            rows.push(nk::Label::new("display/status", label(e, "native.error")?, body()).into());
        }
        if let Some(pending) = &self.state.owned {
            let seconds = seconds(pending.deadline_us, now_us());
            let confirming = pending.phase == "confirming";
            let message = if confirming {
                label(e, "confirm.body")?.replace("%d", &seconds.to_string())
            } else {
                label(e, "native.busy")?.into()
            };
            rows.push(title("display/confirmation/title", label(e, "confirm.title")?).into());
            rows.push(nk::Label::new("display/confirmation/countdown", message, body()).into());
            rows.push(
                nk::Row::new(
                    REVERT_GROUP,
                    vec![
                        button("revert", "confirm.revert", !self.busy)?,
                        button(
                            "keep",
                            "confirm.keep",
                            !self.busy && confirming && seconds > 0,
                        )?,
                    ],
                )
                .gap(Space::S2)
                .into(),
            );
            return Ok(rows);
        }
        rows.push(button("refresh", "native.refresh", !self.busy)?);
        let Some(snapshot) = self.state.snapshot.as_ref() else {
            if self.state.error.is_none() {
                rows.push(
                    nk::Label::new(
                        "display/loading",
                        e.text("settings.native.loading")?,
                        body(),
                    )
                    .into(),
                );
            }
            return Ok(rows);
        };
        if snapshot.outputs.is_empty() {
            rows.push(
                nk::Label::new(
                    "display/no-monitors",
                    label(e, "error.no-monitors")?,
                    body(),
                )
                .into(),
            );
            return Ok(rows);
        }
        let Some(layout) = self.draft.as_ref() else {
            return Ok(rows);
        };
        if !snapshot.pending.token.is_empty() {
            rows.push(nk::Label::new("display/busy", label(e, "native.busy")?, body()).into());
        }
        let locked = self.locked(snapshot);
        let primary_text = label(e, "native.primary-label")?;
        let off_text = label(e, "vrr.off")?;
        let options = snapshot
            .outputs
            .iter()
            .map(|output| {
                let mut name = format!(
                    "{} · {} {} · {}",
                    output.number, output.make, output.model, output.connector
                );
                if layout.primary == output.id {
                    name.push_str(&format!(" · {primary_text}"));
                }
                if layout
                    .outputs
                    .iter()
                    .any(|setting| setting.id == output.id && !setting.enabled)
                {
                    name.push_str(&format!(" · {off_text}"));
                }
                nk::ListBoxOption::new(name)
            })
            .collect();
        rows.push(
            nk::ListBox::new(
                "display/output",
                label(e, "group.all")?,
                "display:output",
                options,
                body(),
            )
            .selected(
                snapshot
                    .outputs
                    .iter()
                    .position(|item| item.id == self.selected),
            )
            .into(),
        );

        rows.push(title("display/arrangement-title", label(e, "native.arrangement")?).into());
        let (size, inset) = diagram_metrics(host);
        let items = diagram_items(
            snapshot,
            layout,
            &self.selected,
            !locked && layout.mirror_groups.is_empty(),
        );
        if !items.is_empty() {
            let projection = self.drag.as_ref().map_or_else(
                || ArrangementProjection::fit(&items, size, inset),
                |drag| drag.projection,
            );
            rows.push(Arrangement::view(
                "display/diagram",
                size,
                projection,
                items,
                body(),
            ));
        }
        let presets = PRESETS
            .iter()
            .map(|(key, preset_kind)| {
                button(
                    &format!("preset:{key}"),
                    &format!("native.{key}"),
                    !locked && preset(snapshot, *preset_kind).is_ok(),
                )
            })
            .collect::<Result<Vec<_>, _>>()?;
        rows.push(
            nk::Column::new("display/presets", presets)
                .gap(Space::S1)
                .into(),
        );

        if let Some((output, setting)) = snapshot
            .outputs
            .iter()
            .find(|output| output.id == self.selected)
            .zip(
                layout
                    .outputs
                    .iter()
                    .find(|setting| setting.id == self.selected),
            )
        {
            rows.push(
                nk::Label::new(
                    "display/output-title",
                    format!("{} · {}", output.number, output.connector),
                    types.style(Type::Body, Weight::Medium),
                )
                .into(),
            );
            let enabled = label(e, "native.enabled")?;
            let edit = !locked && setting.enabled;
            let position = edit && !follower(layout, &output.id);
            let set_enabled = !locked
                && (!setting.enabled
                    || layout
                        .outputs
                        .iter()
                        .filter(|output| output.enabled)
                        .count()
                        > 1);
            let mut settings = vec![row(
                "enabled",
                enabled,
                nk::Switch::new(
                    "display/enabled",
                    enabled,
                    "display:enabled",
                    setting.enabled,
                )
                .enabled(set_enabled)
                .into(),
            )];
            settings.push(row(
                "primary",
                label(e, "native.primary-label")?,
                button(
                    "primary",
                    "native.primary",
                    position && layout.primary != output.id,
                )?,
            ));
            if !output.modes.is_empty() {
                let mode_labels = output
                    .modes
                    .iter()
                    .map(|mode| {
                        format!(
                            "{} × {} · {:.3} Hz",
                            mode.width,
                            mode.height,
                            f64::from(mode.refresh_mhz) / 1000.,
                        )
                    })
                    .collect();
                settings.push(dropdown(
                    "mode",
                    label(e, "resolution")?,
                    mode_labels,
                    output
                        .modes
                        .iter()
                        .position(|mode| mode.id == setting.mode)
                        .unwrap_or(0),
                    edit,
                ));
            }
            let scales = scales(setting.scale);
            settings.push(dropdown(
                "scale",
                label(e, "scale")?,
                scales.iter().map(|value| format!("{value}×")).collect(),
                scales
                    .iter()
                    .position(|value| *value == setting.scale)
                    .unwrap_or(0),
                edit,
            ));
            let normal = label(e, "rotation.normal")?;
            let flipped = label(e, "native.flipped")?;
            let rotations = TRANSFORMS
                .iter()
                .map(|value| match *value {
                    "normal" => normal.into(),
                    "flipped" => format!("{flipped} 0°"),
                    value if value.starts_with("flipped-") => format!("{flipped} {}°", &value[8..]),
                    value => format!("{value}°"),
                })
                .collect();
            settings.push(dropdown(
                "rotation",
                label(e, "rotation")?,
                rotations,
                TRANSFORMS
                    .iter()
                    .position(|value| *value == setting.transform)
                    .unwrap_or(0),
                edit,
            ));
            if output.vrr_supported {
                let values = ["vrr.off", "vrr.always", "vrr.games"]
                    .map(|key| label(e, key).map(str::to_owned));
                settings.push(dropdown(
                    "vrr",
                    label(e, "vrr")?,
                    values.into_iter().collect::<Result<Vec<_>, _>>()?,
                    VRR.iter()
                        .position(|value| *value == setting.vrr)
                        .unwrap_or(0),
                    edit && !mirrored(layout, &output.id),
                ));
            }
            for (axis, (id, coordinate)) in
                [("x", setting.x), ("y", setting.y)].into_iter().enumerate()
            {
                let name = label(e, &format!("native.{id}"))?;
                settings.push(row(
                    id,
                    name,
                    nk::Entry::new(
                        format!("display/{id}"),
                        name,
                        format!("{PREFIX}{id}"),
                        self.coordinates[axis]
                            .clone()
                            .unwrap_or_else(|| coordinate.to_string()),
                    )
                    .enabled(position)
                    .into(),
                ));
            }
            if let Some((_, device)) = self.brightness() {
                let text = label(e, "native.brightness")?;
                let range = nk::SliderRange::new(
                    device.min.into(),
                    device.max.into(),
                    1.,
                    device.current.into(),
                );
                settings.push(row(
                    "brightness",
                    text,
                    nk::SliderEnd::new(
                        "display/brightness",
                        text,
                        "display:brightness",
                        range,
                        body(),
                    )
                    .into(),
                ));
            }
            rows.push(group("output-settings", settings));
            let reorder = edit && layout.mirror_groups.is_empty();
            rows.push(
                nk::Column::new(
                    "display/reorder",
                    vec![
                        button("before", "native.previous", reorder)?,
                        button("after", "native.next", reorder)?,
                    ],
                )
                .gap(Space::S1)
                .into(),
            );
        }
        rows.push(
            nk::Row::new(
                "display/actions",
                vec![
                    button(
                        "identify",
                        "native.identify",
                        !locked && has(snapshot, "identify"),
                    )?,
                    button(
                        "apply",
                        "native.apply",
                        !locked
                            && valid_coordinates(&self.coordinates)
                            && *layout != snapshot.layout,
                    )?,
                ],
            )
            .gap(Space::S2)
            .into(),
        );
        Ok(rows)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::display::tests::{Fixture, wait};

    #[test]
    fn appwindow_draft_preview_and_page_lifetime_share_the_display_lease() {
        let fixture = Fixture::new();
        let mut page = Display {
            client: Some(fixture.client()),
            ..Display::default()
        };
        wait(|| {
            page.poll();
            page.state.snapshot.is_some()
        });
        let activate = |page: &mut Display, name: &str, value, dragging| {
            let action = Activated {
                key: name.into(),
                action: format!("display:{name}"),
                value,
            };
            assert!(page.activate(&action, dragging, (300., 150.), 12.));
        };
        activate(&mut page, "output", Some(Value::Index(1)), false);
        activate(&mut page, "mode", Some(Value::Index(1)), false);
        activate(&mut page, "scale", Some(Value::Index(4)), false);
        activate(&mut page, "rotation", Some(Value::Index(1)), false);
        activate(&mut page, "vrr", Some(Value::Index(1)), false);
        activate(
            &mut page,
            "diagram:external",
            Some(Value::Displacement(0., 0.)),
            true,
        );
        activate(
            &mut page,
            "diagram:external",
            Some(Value::Displacement(-10., 12.)),
            false,
        );
        let draft = page.draft.as_ref().unwrap();
        let external = &draft.outputs[1];
        assert_eq!((external.x, external.y), (1200, 12));
        assert_eq!(
            (
                &*external.mode,
                external.scale,
                &*external.transform,
                &*external.vrr
            ),
            ("second", 1.25, "90", "on")
        );
        assert!(fixture.fake.calls.lock().unwrap().is_empty());

        activate(&mut page, "apply", None, false);
        wait(|| {
            page.poll();
            page.state.owned.is_some() && !page.busy
        });
        assert!(page.take_revert_focus());
        assert!(!page.take_revert_focus());
        assert_eq!(
            &*fixture.fake.calls.lock().unwrap(),
            &["validate", "preview"]
        );

        let sender = fixture.fake.sender.lock().unwrap().clone();
        drop(page);
        let bus = zbus::blocking::fdo::DBusProxy::new(&fixture.service).unwrap();
        wait(|| {
            !bus.name_has_owner(sender.as_str().try_into().unwrap())
                .unwrap()
        });
    }
}
