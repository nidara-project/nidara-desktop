// SPDX-License-Identifier: LGPL-3.0-or-later
//! What a view measures and paints with, read from the exported tokens and never written in a
//! surface: the kit's spacing scale (`tokens/static.json`), the text and focus colours
//! (`tokens/colors.json`) and the washes of a control's states (`tokens/glass.json`).
use nk_render::Color;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The kit's spacing scale, `$space-1` … `$space-10` of `_tokens.scss`. Closed: a view
/// holds no other measure for a gap or a padding.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Space {
    S1,
    S2,
    S3,
    S4,
    S5,
    S6,
    S8,
    S10,
}
impl Space {
    pub const ALL: [Space; 8] = [
        Space::S1,
        Space::S2,
        Space::S3,
        Space::S4,
        Space::S5,
        Space::S6,
        Space::S8,
        Space::S10,
    ];
    fn token(self) -> &'static str {
        match self {
            Space::S1 => "space-1",
            Space::S2 => "space-2",
            Space::S3 => "space-3",
            Space::S4 => "space-4",
            Space::S5 => "space-5",
            Space::S6 => "space-6",
            Space::S8 => "space-8",
            Space::S10 => "space-10",
        }
    }
}

/// The scale's values in logical pixels, as exported.
#[derive(Clone, Debug, PartialEq)]
pub struct Spacing([f64; 8]);
impl Spacing {
    /// From `tokens/static.json`: its `scss` map holds `"space-1": "4px"` and so on. Every
    /// step must be there.
    pub fn from_static(statics: &Value) -> Result<Self, String> {
        let mut out = [0.; 8];
        for (i, s) in Space::ALL.iter().enumerate() {
            let raw = statics["scss"][s.token()]
                .as_str()
                .ok_or_else(|| format!("static.json: no {}", s.token()))?;
            out[i] = raw
                .strip_suffix("px")
                .and_then(|n| n.trim().parse::<f64>().ok())
                .filter(|v| v.is_finite() && *v >= 0.)
                .ok_or_else(|| format!("static.json: {} is {raw:?}, not pixels", s.token()))?;
        }
        Ok(Self(out))
    }
    pub fn px(&self, s: Space) -> f64 {
        self.0[Space::ALL.iter().position(|x| *x == s).unwrap_or(0)]
    }
    pub fn of(&self, s: Option<Space>) -> f64 {
        s.map_or(0., |s| self.px(s))
    }
}

/// The colours a view paints content in: text tiers, and the focus ring (content, D8).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    pub primary: Color,
    pub secondary: Color,
    pub dim: Color,
    pub focus: Color,
    /// The ring's width, as `nk-widgets` draws it (D8).
    pub focus_width: f64,
}
impl Look {
    /// From one set of `tokens/colors.json` (the caller picks it: accent, mode, reduce
    /// transparency). The shell's is always the dark skin.
    pub fn from_colors(set: &Value) -> Result<Self, String> {
        let token = |name: &str| {
            set["tokens"][name]
                .as_str()
                .ok_or_else(|| format!("colors.json: no {name}"))
                .and_then(parse_color)
        };
        Ok(Self {
            primary: token("--nidara-text")?,
            secondary: token("--nidara-text-secondary")?,
            dim: token("--nidara-text-dim")?,
            focus: token("--nidara-accent")?,
            focus_width: 2.,
        })
    }
    pub fn ink(&self, ink: crate::Ink) -> Color {
        match ink {
            crate::Ink::Primary => self.primary,
            crate::Ink::Secondary => self.secondary,
            crate::Ink::Dim => self.dim,
        }
    }
}

/// `#rrggbb` or `rgba(r, g, b, a)`, the two forms the colour export writes.
pub fn parse_color(s: &str) -> Result<Color, String> {
    let bad = || format!("not a colour: {s:?}");
    if let Some(hex) = s.strip_prefix('#') {
        let byte = |i: usize| {
            hex.get(i..i + 2)
                .and_then(|h| u8::from_str_radix(h, 16).ok())
        };
        return match hex.len() {
            6 => Ok(nk_render::rgba(
                byte(0).ok_or_else(bad)?,
                byte(2).ok_or_else(bad)?,
                byte(4).ok_or_else(bad)?,
                255,
            )),
            _ => Err(bad()),
        };
    }
    let inner = s
        .strip_prefix("rgba(")
        .and_then(|r| r.strip_suffix(')'))
        .ok_or_else(bad)?;
    let parts: Vec<f64> = inner
        .split(',')
        .map(|p| p.trim().parse::<f64>().map_err(|_| bad()))
        .collect::<Result<_, _>>()?;
    match parts[..] {
        [r, g, b, a]
            if [r, g, b].iter().all(|c| (0. ..=255.).contains(c)) && (0. ..=1.).contains(&a) =>
        {
            Ok(nk_render::rgba(
                r as u8,
                g as u8,
                b as u8,
                (a * 255.).round() as u8,
            ))
        }
        _ => Err(bad()),
    }
}

/// The washes Hyalo lays for a control's states: `tokens/glass.json`, the `control` piece's
/// `states` for the variant in force.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Washes {
    pub hover: [f64; 4],
    pub press: [f64; 4],
    pub destructive_hover: [f64; 4],
    pub destructive_press: [f64; 4],
    pub fade_ms: u32,
}
impl Washes {
    pub fn from_glass(
        glass: &Value,
        dark: bool,
        reduce_transparency: bool,
    ) -> Result<Self, String> {
        let variant = glass["variants"]
            .as_array()
            .and_then(|vs| {
                vs.iter().find(|v| {
                    v["dark"].as_bool() == Some(dark)
                        && v["reduceTransparency"].as_bool() == Some(reduce_transparency)
                })
            })
            .ok_or("glass.json: no variant for this mode")?;
        let states = &variant["pieces"]["control"][0]["states"];
        let wash = |name: &str| -> Result<[f64; 4], String> {
            let w = &states[name]["wash"];
            let mut out = [0.; 4];
            for (i, c) in ["r", "g", "b", "a"].iter().enumerate() {
                out[i] = w[c]
                    .as_f64()
                    .filter(|v| (0. ..=1.).contains(v))
                    .ok_or_else(|| format!("glass.json: {name}.wash.{c}"))?;
            }
            Ok(out)
        };
        Ok(Self {
            hover: wash("hover")?,
            press: wash("press")?,
            destructive_hover: wash("destructiveHover")?,
            destructive_press: wash("destructivePress")?,
            fade_ms: states["fadeMs"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .ok_or("glass.json: states.fadeMs")?,
        })
    }
}

/// Everything a view is laid out and drawn with.
#[derive(Clone, Debug, PartialEq)]
pub struct Tokens {
    pub spacing: Spacing,
    pub look: Look,
    pub washes: Washes,
}
