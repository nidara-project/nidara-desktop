// SPDX-License-Identifier: LGPL-3.0-or-later
//! Config1's supported Pango font-description attributes, without a second shaper.
use nk_text::{AxisSetting, Slant, TextStyle};

type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Debug, PartialEq)]
pub struct Attributes {
    pub weight: f32,
    pub slant: Slant,
    pub width: f32,
    pub variations: Vec<AxisSetting>,
}
impl Default for Attributes {
    fn default() -> Self {
        Self {
            weight: 400.,
            slant: Slant::Normal,
            width: 100.,
            variations: vec![],
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Description {
    pub family: String,
    /// Unscaled points, including conversion from an absolute px description.
    pub points: f32,
    pub attributes: Attributes,
}
impl Attributes {
    pub fn text_style(
        &self,
        family: &str,
        points: f32,
        scale: f64,
        line_height: f32,
    ) -> Result<TextStyle> {
        if !scale.is_finite() || scale <= 0. {
            return Err("invalid text scale".into());
        }
        let style = TextStyle {
            family: family.into(),
            size: points * (96. / 72.) * scale as f32,
            weight: self.weight,
            slant: self.slant,
            width: self.width,
            variations: self.variations.clone(),
            line_height,
            ..Default::default()
        };
        style.validate(1.)?;
        Ok(style)
    }
    /// A catalogue style name contains attributes only; unknown words are refused.
    pub fn named(name: &str) -> Result<Self> {
        let mut out = Self::default();
        for word in name.split_whitespace().rev() {
            if !out.word(word) {
                return Err(format!("unsupported font style: {name}"));
            }
        }
        Ok(out)
    }
    fn word(&mut self, word: &str) -> bool {
        let word = word.to_ascii_lowercase().replace('-', "");
        match word.as_str() {
            "normal" => {}
            "roman" => self.slant = Slant::Normal,
            "italic" => self.slant = Slant::Italic,
            "oblique" => self.slant = Slant::Oblique,
            "thin" => self.weight = 100.,
            "ultralight" | "extralight" => self.weight = 200.,
            "light" => self.weight = 300.,
            "semilight" | "demilight" => self.weight = 350.,
            "book" => self.weight = 380.,
            "regular" => self.weight = 400.,
            "medium" => self.weight = 500.,
            "semibold" | "demibold" => self.weight = 600.,
            "bold" => self.weight = 700.,
            "ultrabold" | "extrabold" => self.weight = 800.,
            "heavy" | "black" => self.weight = 900.,
            "ultrablack" | "extrablack" | "ultraheavy" => self.weight = 1000.,
            "ultracondensed" => self.width = 50.,
            "extracondensed" => self.width = 62.5,
            "condensed" => self.width = 75.,
            "semicondensed" => self.width = 87.5,
            "semiexpanded" => self.width = 112.5,
            "expanded" => self.width = 125.,
            "extraexpanded" => self.width = 150.,
            "ultraexpanded" => self.width = 200.,
            _ => return false,
        }
        true
    }
    fn words(&self) -> Result<Vec<&'static str>> {
        let mut out = vec![];
        out.push(match self.weight {
            100. => "Thin",
            200. => "Ultra-Light",
            300. => "Light",
            350. => "Semi-Light",
            380. => "Book",
            400. => "",
            500. => "Medium",
            600. => "Semi-Bold",
            700. => "Bold",
            800. => "Ultra-Bold",
            900. => "Heavy",
            1000. => "Ultra-Heavy",
            _ => return Err("unsupported description weight".into()),
        });
        out.push(match self.slant {
            Slant::Normal => "",
            Slant::Italic => "Italic",
            Slant::Oblique => "Oblique",
        });
        out.push(match self.width {
            50. => "Ultra-Condensed",
            62.5 => "Extra-Condensed",
            75. => "Condensed",
            87.5 => "Semi-Condensed",
            100. => "",
            112.5 => "Semi-Expanded",
            125. => "Expanded",
            150. => "Extra-Expanded",
            200. => "Ultra-Expanded",
            _ => return Err("unsupported description stretch".into()),
        });
        out.retain(|s| !s.is_empty());
        Ok(out)
    }
}
impl Description {
    pub fn parse(raw: &str) -> Result<Self> {
        if raw.chars().any(char::is_control) || raw.contains('#') {
            return Err("unsupported font description feature/control".into());
        }
        let (body, axes) = raw
            .trim()
            .split_once('@')
            .map_or((raw.trim(), None), |(b, a)| (b.trim(), Some(a)));
        let (head, size) = body
            .rsplit_once(char::is_whitespace)
            .ok_or("font needs a family and size")?;
        let (size, absolute) = size.strip_suffix("px").map_or((size, false), |s| (s, true));
        let size: f32 = size.parse().map_err(|_| "invalid font size")?;
        let points = if absolute { size * 72. / 96. } else { size };
        let points = (points * 1024.).round() / 1024.;
        if !points.is_finite() || points <= 0. {
            return Err("invalid point size".into());
        }
        let mut attributes = Attributes::default();
        let mut family = head.trim();
        while !family.ends_with(',') {
            let Some((rest, word)) = family.rsplit_once(char::is_whitespace) else {
                break;
            };
            if !attributes.word(word) {
                break;
            }
            family = rest.trim_end();
        }
        let escaped = family.ends_with(',');
        let family = family.strip_suffix(',').unwrap_or(family).trim();
        if !escaped && Attributes::default().word(family) {
            return Err("font description has no family".into());
        }
        if family.is_empty() || family.contains(',') {
            return Err("font requires one family".into());
        }
        // These are legal Pango attributes not implemented by our single text shaper.
        for word in family.split_whitespace().rev().take(1) {
            let w = word.to_ascii_lowercase().replace('-', "");
            if [
                "smallcaps",
                "allsmallcaps",
                "petitecaps",
                "allpetitecaps",
                "unicase",
                "titlecaps",
                "south",
                "north",
                "east",
                "west",
                "notrotated",
                "upsidedown",
                "rotatedleft",
                "rotatedright",
                "withcolor",
                "withoutcolor",
            ]
            .contains(&w.as_str())
                && !escaped
            {
                return Err("unsupported variant/gravity/color in font description".into());
            }
        }
        if let Some(axes) = axes {
            for setting in axes.split(',') {
                let (tag, value) = setting
                    .trim()
                    .split_once('=')
                    .ok_or("invalid font variation")?;
                attributes.variations.push(AxisSetting {
                    axis: tag
                        .as_bytes()
                        .try_into()
                        .map_err(|_| "font axis needs four bytes")?,
                    value: value.parse().map_err(|_| "invalid variation value")?,
                });
            }
        }
        attributes.text_style(family, points, 1., 1.5)?;
        Ok(Self {
            family: family.into(),
            points,
            attributes,
        })
    }
    pub fn canonical(&self) -> Result<String> {
        self.attributes
            .text_style(&self.family, self.points, 1., 1.5)?;
        if self.family.trim() != self.family
            || self.family.is_empty()
            || self.family.contains([',', '@', '#'])
            || self.family.chars().any(char::is_control)
        {
            return Err("invalid single font family".into());
        }
        let mut family = self.family.clone();
        let last = family.split_whitespace().last().unwrap();
        if Attributes::default().word(last)
            || last.parse::<f32>().is_ok()
            || Self::parse(&format!("{} {}", self.family, self.points)).is_err()
        {
            family.push(',');
        }
        let mut parts = vec![family];
        parts.extend(self.attributes.words()?.into_iter().map(str::to_owned));
        parts.push(self.points.to_string());
        if !self.attributes.variations.is_empty() {
            parts.push(format!(
                "@{}",
                self.attributes
                    .variations
                    .iter()
                    .map(|s| format!("{}={}", std::str::from_utf8(&s.axis).unwrap(), s.value))
                    .collect::<Vec<_>>()
                    .join(",")
            ));
        }
        Ok(parts.join(" "))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn attributes_and_points_roundtrip_without_reinterpreting_family_words() {
        for (raw, family, weight, slant, width, points) in [
            (
                "Noto Sans Hebrew Bold Italic 12",
                "Noto Sans Hebrew",
                700.,
                Slant::Italic,
                100.,
                12.,
            ),
            (
                "Noto Sans SemiBold Condensed 15",
                "Noto Sans",
                600.,
                Slant::Normal,
                75.,
                15.,
            ),
            (
                "Studio Bold, 16px",
                "Studio Bold",
                400.,
                Slant::Normal,
                100.,
                12.,
            ),
            ("日本語 12.5", "日本語", 400., Slant::Normal, 100., 12.5),
        ] {
            let d = Description::parse(raw).unwrap();
            assert_eq!(
                (
                    &*d.family,
                    d.attributes.weight,
                    d.attributes.slant,
                    d.attributes.width,
                    d.points
                ),
                (family, weight, slant, width, points)
            );
            assert_eq!(Description::parse(&d.canonical().unwrap()).unwrap(), d);
        }
        let d = Description::parse("Inter Bold 13 @wght=720,wdth=90").unwrap();
        assert_eq!(d.attributes.variations.len(), 2);
        assert_eq!(Description::parse(&d.canonical().unwrap()).unwrap(), d);
        for invalid in [
            "Noto Sans Small-Caps 12",
            "Noto Sans 12 #tnum=1",
            "Sans,Serif 12",
            "Sans 0",
            "Sans NaN",
            "Sans 12 @wght=500,wght=700",
        ] {
            assert!(Description::parse(invalid).is_err(), "{invalid}");
        }
        assert!(Attributes::named("MysteryFace").is_err());
        assert_eq!(Attributes::named("").unwrap(), Attributes::default());
    }
}
