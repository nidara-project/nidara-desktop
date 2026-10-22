// SPDX-License-Identifier: LGPL-3.0-or-later
//! Claude's named builders of Appearance (#915): `accentPicker` and `nightScheduleTimes`,
//! after `ui/shell/surfaces/settings/custom/appearance.ts`. Sol's (wallpaper, fonts,
//! dropdown) live in their own modules.

use crate::manifest::Item;
use crate::render::{Builder, Builders, Built, Cx, Result, failure};
use crate::session::Notice;
use crate::value::Value;
use nk_widgets::{ChoiceKind, Effect, NodeId, ValueRange};

/// Registers this module's builders.
pub fn register(builders: &mut Builders) {
    builders.register("accentPicker", || Box::new(AccentPicker::default()));
    builders.register("nightScheduleTimes", || Box::new(ScheduleTimes::default()));
}

/// A row's title and second line from its manifest i18n key (`<key>` and `<key>.desc`).
fn titles(cx: &Cx<'_>, item: &Item) -> Result<(String, Option<String>)> {
    let Item::Custom { i18n: Some(k), .. } = item else {
        return Err("a custom row without its i18n".into());
    };
    let title = cx.exports.text(k)?.to_owned();
    let subtitle = cx
        .exports
        .text(&format!("{k}.desc"))
        .ok()
        .map(str::to_owned);
    Ok((title, subtitle))
}

/// The accent colours as a swatch choice, one per value of `appearance.accent`, each named as
/// the current Settings names its button and painted in its colour.
#[derive(Default)]
pub struct AccentPicker {
    key: String,
    row: NodeId,
    subtitle: Option<String>,
    swatches: Vec<(NodeId, String)>,
}

impl AccentPicker {
    fn show(&self, cx: &mut Cx<'_>, error: Option<String>) -> Result<()> {
        if let Some(Value::Text(v)) = cx.session().shown(&self.key).cloned()
            && let Some((id, _)) = self.swatches.iter().find(|(_, s)| *s == v)
        {
            cx.tree.set_choice(*id)?;
        }
        let line = error.or_else(|| self.subtitle.clone());
        cx.tree.set_subtitle(self.row, line.as_deref())?;
        Ok(())
    }
}

impl Builder for AccentPicker {
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, item: &Item) -> Result<Built> {
        let key = item.key().ok_or("accentPicker needs its key")?.to_owned();
        let (title, subtitle) = titles(cx, item)?;
        let session = cx.session();
        let entry = session
            .store()
            .and_then(|s| s.key(&key))
            .ok_or_else(|| format!("{key}: not in the snapshot"))?;
        let values: Vec<String> = entry.entry["values"]
            .as_array()
            .ok_or_else(|| format!("{key}: no values"))?
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        let shown = session
            .shown(&key)
            .and_then(Value::as_text)
            .map(str::to_owned);
        let names = &cx.exports.colors["accentNames"];
        let mut options: Vec<(String, String)> = values
            .iter()
            .map(|v| {
                (
                    names[v.as_str()].as_str().unwrap_or(v).to_owned(),
                    v.clone(),
                )
            })
            .collect();
        // A value none of the swatches is (D2): one more, named by the value itself.
        if let Some(v) = &shown
            && !values.contains(v)
        {
            options.push((v.clone(), v.clone()));
        }
        let selected = shown
            .as_ref()
            .and_then(|v| options.iter().position(|(_, o)| o == v))
            .unwrap_or(0);
        let labels: Vec<&str> = options.iter().map(|(l, _)| l.as_str()).collect();
        let (row, choices, ids) =
            cx.tree
                .choices(group, &title, ChoiceKind::Swatch, &labels, selected)?;
        for (id, (_, value)) in ids.iter().zip(&options) {
            let colour = cx
                .styles
                .accents
                .iter()
                .find(|(k, _)| k == value)
                .map_or(cx.styles.palette.surface, |(_, c)| *c);
            cx.tree.set_swatch(*id, colour)?;
        }
        for id in [row, choices].iter().chain(&ids) {
            cx.own(*id);
        }
        cx.tree.set_subtitle(row, subtitle.as_deref())?;
        self.key = key.clone();
        self.row = row;
        self.subtitle = subtitle;
        self.swatches = ids
            .into_iter()
            .zip(options.into_iter().map(|(_, v)| v))
            .collect();
        Ok(Built {
            rows: vec![row],
            keys: vec![key],
        })
    }

    fn notice(&mut self, cx: &mut Cx<'_>, notice: &Notice) -> Result<()> {
        let error = match notice {
            Notice::Failed { error, .. } => Some(failure(error)),
            _ => None,
        };
        self.show(cx, error)
    }

    fn effect(&mut self, cx: &mut Cx<'_>, effect: Effect) -> Result<()> {
        if let Effect::Activated(id) = effect
            && let Some((_, value)) = self.swatches.iter().find(|(s, _)| *s == id)
        {
            let value = Value::Text(value.clone());
            if let Err(e) = cx.apply(&self.key.clone(), value) {
                self.show(cx, Some(failure(&e)))?;
            }
        }
        Ok(())
    }
}

const FROM: &str = "nightlight.scheduleFrom";
const TO: &str = "nightlight.scheduleTo";

/// The schedule's two times, "Turn on at" and "Turn off at", each an hour and a minute that
/// wrap like a clock's, written back as `HH:MM` (the service's own `isTime`).
#[derive(Default)]
pub struct ScheduleTimes {
    /// Per key: its row, its hour spin, its minute spin.
    times: Vec<(String, NodeId, NodeId, NodeId)>,
}

fn parse_time(v: Option<&Value>) -> Option<(f32, f32)> {
    let (h, m) = v?.as_text()?.split_once(':')?;
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some((h as f32, m as f32))
}

fn clock(max: f32) -> ValueRange {
    ValueRange {
        min: 0.,
        max,
        step: 1.,
        wrap: true,
        digits: 2,
        decimals: 0,
        unit: String::new(),
    }
}

impl Builder for ScheduleTimes {
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, _item: &Item) -> Result<Built> {
        let hour = cx.exports.text("settings.appearance.time.hour")?.to_owned();
        let minute = cx
            .exports
            .text("settings.appearance.time.minute")?
            .to_owned();
        for (key, label) in [
            (FROM, "settings.appearance.night-light-from"),
            (TO, "settings.appearance.night-light-to"),
        ] {
            let label = cx.exports.text(label)?.to_owned();
            let (h, m) = parse_time(cx.session().shown(key)).unwrap_or((0., 0.));
            let (row, fields, spins) = cx.tree.fields(
                group,
                &label,
                vec![
                    (&format!("{label}, {hour}"), clock(23.), h),
                    (&format!("{label}, {minute}"), clock(59.), m),
                ],
            )?;
            for id in [row, fields].iter().chain(&spins) {
                cx.own(*id);
            }
            self.times.push((key.to_owned(), row, spins[0], spins[1]));
        }
        Ok(Built {
            rows: self.times.iter().map(|t| t.1).collect(),
            keys: vec![FROM.into(), TO.into()],
        })
    }

    fn notice(&mut self, cx: &mut Cx<'_>, _notice: &Notice) -> Result<()> {
        for (key, _, h, m) in &self.times {
            if let Some((hv, mv)) = parse_time(cx.session().shown(key)) {
                cx.tree.set_value(*h, hv)?;
                cx.tree.set_value(*m, mv)?;
            }
        }
        Ok(())
    }

    fn effect(&mut self, cx: &mut Cx<'_>, effect: Effect) -> Result<()> {
        let Effect::Changed(id) = effect else {
            return Ok(());
        };
        let Some((key, _, h, m)) = self
            .times
            .iter()
            .find(|(_, _, h, m)| *h == id || *m == id)
            .cloned()
        else {
            return Ok(());
        };
        let (hv, mv) = (
            cx.tree.value(h).ok_or("an hour without value")?,
            cx.tree.value(m).ok_or("a minute without value")?,
        );
        let text = format!("{:02}:{:02}", hv as u32, mv as u32);
        // A refusal before sending (the service gone) is the rows' insensitivity already;
        // a refusal answered comes back as a notice and the next one shows the time in force.
        let _ = cx.apply(&key, Value::Text(text));
        Ok(())
    }
}
