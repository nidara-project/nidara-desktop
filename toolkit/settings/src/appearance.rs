// SPDX-License-Identifier: LGPL-3.0-or-later
//! Settings → Appearance on `AppWindow` (#1103 step 8c). Its keys with a schema control are
//! ordinary rows (`Model::items`); this module draws the rest from the kit: the accent as
//! `nk::Swatches`, the night light's schedule as two `nk::TimeField`s, and each font as an
//! `nk::FontButton` that opens `nk::FontDialog`. The wallpaper is not here: it gets a page
//! of its own (#1146, owner 23-11), so its group is left out.
use crate::{Value, exports::Exports, manifest::Item, session::Session};
use nk::{FontChoice, FontFace, FontSize, Node, Type, TypeScale, Weight};
use nk_platform::font_description::{Attributes, Description};

/// The keys this page writes besides its ordinary rows.
pub const KEYS: [&str; 5] = [
    "appearance.accent",
    "appearance.interfaceFont",
    "appearance.monoFont",
    "nightlight.scheduleFrom",
    "nightlight.scheduleTo",
];
/// The manifest's wallpaper group, which moves to its own page.
pub const WALLPAPER_GROUP: &str = "settings.appearance.group.wallpaper";

/// The font key a font row edits, by its manifest name.
pub fn font_key(custom: &str) -> Option<&'static str> {
    match custom {
        "interfaceFont" => Some("appearance.interfaceFont"),
        "monoFont" => Some("appearance.monoFont"),
        _ => None,
    }
}

/// A Pango description ("Family [Style] Size", points) as the font dialog's choice.
pub fn font_choice(raw: &str) -> Option<FontChoice> {
    let d = Description::parse(raw).ok()?;
    // The style words between the family and the size ("Bold Italic"); the dialog finds the
    // face by its attributes, the name is only what it is called.
    let words: Vec<&str> = raw
        .trim()
        .strip_prefix(d.family.as_str())
        .unwrap_or_default()
        .trim_start_matches(',')
        .split_whitespace()
        .filter(|w| w.parse::<f32>().is_err() && !w.starts_with('@'))
        .collect();
    let a = &d.attributes;
    Some(
        FontChoice::new(d.family.clone(), FontSize::Points(d.points)).face(FontFace {
            name: if words.is_empty() {
                "Regular".into()
            } else {
                words.join(" ")
            },
            weight: a.weight,
            width: a.width,
            slant: a.slant,
        }),
    )
}

/// The dialog's choice as the Pango description Config1 stores, in points.
pub fn font_value(c: &FontChoice) -> Result<String, String> {
    let points = match c.size {
        FontSize::Points(p) => p,
        FontSize::Pixels(px) => px * 72. / 96.,
    };
    Description {
        family: c.family.clone(),
        points,
        attributes: Attributes {
            weight: c.face.weight,
            slant: c.face.slant,
            width: c.face.width,
            variations: vec![],
        },
    }
    .canonical()
}

/// What a page row needs to draw itself.
pub struct Row<'a> {
    pub id: String,
    pub types: &'a TypeScale,
    pub session: &'a Session,
    pub exports: &'a Exports,
    /// The value shown: a held one, else the session's.
    pub shown: &'a dyn Fn(&str) -> Option<Value>,
    pub error: &'a dyn Fn(&str) -> Option<String>,
}

impl Row<'_> {
    fn disabled(&self, key: &str, item: &Item) -> bool {
        let s = self.session;
        !s.available()
            || !s
                .store()
                .and_then(|st| st.key(key))
                .is_some_and(|k| k.available && k.writable())
            || item.sensitive_when().is_some_and(|p| !p.holds(s))
    }
    fn row(&self, key: &str, title: &str, subtitle: Option<String>, end: Node, off: bool) -> Node {
        let mut row = nk::ListRow::new(
            self.id.clone(),
            title,
            self.types.style(Type::Body, Weight::Regular),
        )
        .trailing(end)
        .enabled(!off);
        if let Some(line) = (self.error)(key).or(subtitle) {
            row = row.subtitle(line, self.types.style(Type::Small, Weight::Regular));
        }
        row.into()
    }
    fn titles(&self, i18n: &str) -> Result<(String, Option<String>), String> {
        Ok((
            self.exports.text(i18n)?.to_owned(),
            self.exports
                .text(&format!("{i18n}.desc"))
                .ok()
                .map(str::to_owned),
        ))
    }

    /// The accent: one swatch per value of `appearance.accent`, in Config1's order, each in
    /// its exported colour and named by its exported name.
    pub fn accent(&self, item: &Item, i18n: &str) -> Result<Vec<Node>, String> {
        let key = "appearance.accent";
        let Some(entry) = self.session.store().and_then(|s| s.key(key)) else {
            return Ok(vec![]);
        };
        if !entry.available {
            return Ok(vec![]);
        }
        let colors = &self.exports.colors;
        let values: Vec<String> = entry.entry["values"]
            .as_array()
            .ok_or_else(|| format!("{key}: no values"))?
            .iter()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect();
        let swatches = values
            .iter()
            .map(|v| {
                let color = colors["accents"][v]
                    .as_str()
                    .ok_or_else(|| format!("colors.json: no accent colour {v}"))
                    .and_then(nk::parse_color)?;
                let name = colors["accentNames"][v].as_str().unwrap_or(v).to_owned();
                Ok((name, color))
            })
            .collect::<Result<Vec<_>, String>>()?;
        let shown = (self.shown)(key);
        let chosen = values
            .iter()
            .position(|v| shown.as_ref().and_then(Value::as_text) == Some(v.as_str()))
            .unwrap_or(0);
        let (title, subtitle) = self.titles(i18n)?;
        let off = self.disabled(key, item);
        Ok(vec![
            self.row(
                key,
                &title,
                subtitle,
                nk::Swatches::new(
                    format!("key/{key}"),
                    &title,
                    "appearance:accent",
                    swatches,
                    chosen,
                )
                .enabled(!off)
                .into(),
                off,
            ),
        ])
    }

    /// The night light's schedule: when it turns on and when off, each a time field.
    pub fn schedule(&self, item: &Item) -> Result<Vec<Node>, String> {
        let mut rows = vec![];
        for (n, (key, i18n)) in [
            (
                "nightlight.scheduleFrom",
                "settings.appearance.night-light-from",
            ),
            (
                "nightlight.scheduleTo",
                "settings.appearance.night-light-to",
            ),
        ]
        .into_iter()
        .enumerate()
        {
            if !self
                .session
                .store()
                .and_then(|s| s.key(key))
                .is_some_and(|k| k.available)
            {
                continue;
            }
            let title = self.exports.text(i18n)?;
            let time = (self.shown)(key)
                .and_then(|v| v.as_text().map(str::to_owned))
                .unwrap_or_default();
            let off = self.disabled(key, item);
            let field = nk::TimeField::new(
                format!("key/{key}"),
                title,
                format!("appearance:time:{key}"),
                &time,
                self.types.style(Type::Body, Weight::Regular),
            )
            .enabled(!off);
            rows.push(
                Row {
                    id: format!("{}/{n}", self.id),
                    ..*self
                }
                .row(key, title, None, field.into(), off),
            );
        }
        Ok(rows)
    }

    /// A font: its current face as a button that opens the font dialog.
    pub fn font(&self, item: &Item, name: &str, i18n: &str) -> Result<Vec<Node>, String> {
        let Some(key) = font_key(name) else {
            return Err(format!("{name}: not a font row"));
        };
        if !self
            .session
            .store()
            .and_then(|s| s.key(key))
            .is_some_and(|k| k.available)
        {
            return Ok(vec![]);
        }
        let (title, subtitle) = self.titles(i18n)?;
        let raw = (self.shown)(key)
            .and_then(|v| v.as_text().map(str::to_owned))
            .unwrap_or_default();
        let choice =
            font_choice(&raw).unwrap_or_else(|| FontChoice::new(raw, FontSize::Points(11.)));
        let off = self.disabled(key, item);
        Ok(vec![
            self.row(
                key,
                &title,
                subtitle,
                nk::FontButton::new(
                    format!("key/{key}"),
                    &choice,
                    format!("appearance:font:{key}"),
                )
                .enabled(!off)
                .into(),
                off,
            ),
        ])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_font_goes_to_the_dialog_and_back_as_the_same_description() {
        for raw in [
            "Inter 11",
            "Inter Bold 12",
            "JetBrains Mono 10.5",
            "Cantarell Italic 11",
        ] {
            let choice = font_choice(raw).unwrap();
            assert_eq!(
                Description::parse(&font_value(&choice).unwrap()).unwrap(),
                Description::parse(raw).unwrap(),
                "{raw}"
            );
        }
        let bold = font_choice("Inter Bold 12").unwrap();
        assert_eq!((bold.family.as_str(), bold.face.weight), ("Inter", 700.));
        // Pixels from the dialog are stored as points.
        let px = FontChoice::new("Inter", FontSize::Pixels(16.));
        assert_eq!(
            Description::parse(&font_value(&px).unwrap())
                .unwrap()
                .points,
            12.
        );
    }
}
