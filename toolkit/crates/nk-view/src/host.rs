// SPDX-License-Identifier: LGPL-3.0-or-later
//! What every window or surface built on a view needs from the kit (VIEW.md §13.2): the
//! tokens in an appearance, the keys the view understands, and the interface glyphs.
use crate::state::KeyInput;
use crate::tokens::{
    Look, Motion, Radii, Spacing, Tokens, Washes, scrollbar_from, slider_from, switch_from,
};
use nk_platform::{exports::Exports, portal::Appearance};
use std::{collections::HashMap, sync::Arc};

impl Tokens {
    /// The kit's tokens in `appearance`, from the exported settings data. The shell passes
    /// its always-dark skin; an application passes the portal's appearance as it is.
    pub fn load(e: &Exports, appearance: &Appearance) -> Result<Self, String> {
        let set = e.tokens(appearance)?;
        let colors = serde_json::json!({ "tokens": set.colors });
        Ok(Self {
            spacing: Spacing::from_static(&e.statics)?,
            radii: Radii::from_static(&e.statics)?,
            motion: Motion::from_static(&e.statics)?,
            look: Look::from_colors(&colors)?,
            washes: Washes::from_glass(&e.glass, appearance.dark, appearance.reduce_transparency)?,
            scrollbar: scrollbar_from(&set.components["scrollbar"], &colors)?,
            slider: slider_from(&set.components["range"])?,
            switch: switch_from(&set.components["switch"], &colors)?,
            group_radius: set.components["common"]["groupRadius"]
                .as_f64()
                .filter(|v| v.is_finite() && *v >= 0.)
                .ok_or("components.json: no common.groupRadius")?,
        })
    }
}

impl KeyInput {
    /// What a key means to a view, by its keysym: Tab and Shift+Tab, Enter or Space, the
    /// arrows, Page Up and Page Down, Home and End (with Ctrl: a region's ends). None for a
    /// key the view has no meaning for; the surface handles that one itself. A surface that
    /// gives an arrow another meaning (a list's Down as the next row) maps it before this.
    pub fn from_key(key: &nk_wayland::Key) -> Option<Self> {
        Some(match key.sym {
            0xff09 if key.shift => Self::ShiftTab,
            0xff09 => Self::Tab,
            0xfe20 => Self::ShiftTab,
            0xff0d | 0xff8d | 0x20 => Self::Activate,
            0xff51 => Self::Left,
            0xff52 => Self::Up,
            0xff53 => Self::Right,
            0xff54 => Self::Down,
            0xff55 => Self::PageUp,
            0xff56 => Self::PageDown,
            0xff50 if key.ctrl => Self::Home,
            0xff57 if key.ctrl => Self::End,
            0xff50 => Self::LineStart,
            0xff57 => Self::LineEnd,
            _ => return None,
        })
    }
}

/// The interface glyphs (`nd-` names) a view draws, each looked up once per size. What is
/// not found is logged once and drawn as nothing.
pub struct Glyphs {
    icons: nk_icons::Icons,
    cache: HashMap<(String, u32), Option<Arc<nk_icons::Icon>>>,
}

impl Glyphs {
    pub fn new(icons: nk_icons::Icons) -> Self {
        Self {
            icons,
            cache: HashMap::new(),
        }
    }
    pub fn get(&mut self, name: &str, size: f64) -> Option<Arc<nk_icons::Icon>> {
        if name.is_empty() {
            return None;
        }
        let px = size.round() as u32;
        let icons = &mut self.icons;
        self.cache
            .entry((name.to_string(), px))
            .or_insert_with(|| {
                icons
                    .get(name, px)
                    .map_err(|e| eprintln!("nk-view: no glyph {name}: {e}"))
                    .ok()
            })
            .clone()
    }
}

/// A step of the type scale (`$fse-*`): sizes relative to the user's interface font.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Type {
    Mini,
    Caption,
    Small,
    Body,
    Subtitle,
    Title3,
    Title2,
    Title1,
}
impl Type {
    pub const ALL: [Type; 8] = [
        Type::Mini,
        Type::Caption,
        Type::Small,
        Type::Body,
        Type::Subtitle,
        Type::Title3,
        Type::Title2,
        Type::Title1,
    ];
    pub fn token(self) -> &'static str {
        match self {
            Type::Mini => "fse-mini",
            Type::Caption => "fse-caption",
            Type::Small => "fse-small",
            Type::Body => "fse-body",
            Type::Subtitle => "fse-subtitle",
            Type::Title3 => "fse-title-3",
            Type::Title2 => "fse-title-2",
            Type::Title1 => "fse-title-1",
        }
    }
}

/// A weight of the scale (`$fw-*`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Weight {
    Regular,
    Medium,
    Semibold,
    Bold,
}
impl Weight {
    pub fn token(self) -> &'static str {
        match self {
            Weight::Regular => "fw-regular",
            Weight::Medium => "fw-medium",
            Weight::Semibold => "fw-semibold",
            Weight::Bold => "fw-bold",
        }
    }
}

/// The type scale on the user's interface font: `style(Type::Small, Weight::Medium)` is
/// that font at `$fse-small` and `$fw-medium`. A text's size is never a number in a view.
#[derive(Clone, Debug)]
pub struct TypeScale {
    base: nk_text::TextStyle,
    sizes: [f32; 8],
    weights: [f32; 4],
}
/// The line height of interface text.
const LINE_HEIGHT: f32 = 1.3;
impl TypeScale {
    /// From the exported statics and the appearance's interface font and text scale.
    pub fn load(e: &Exports, appearance: &Appearance) -> Result<Self, String> {
        let base =
            nk_platform::styles::font_style(&appearance.font, appearance.text_scale, LINE_HEIGHT)?;
        Self::from_static(&e.statics, base)
    }
    /// From `static.json` (`"fse-small": "0.93em"`, `"fw-medium": "500"`) over `base`.
    pub fn from_static(
        statics: &serde_json::Value,
        base: nk_text::TextStyle,
    ) -> Result<Self, String> {
        let read = |key: &str, suffix: &str| -> Result<f32, String> {
            let raw = statics["scss"][key]
                .as_str()
                .ok_or_else(|| format!("static.json: no {key}"))?;
            raw.strip_suffix(suffix)
                .unwrap_or(raw)
                .trim()
                .parse::<f32>()
                .ok()
                .filter(|v| v.is_finite() && *v > 0.)
                .ok_or_else(|| format!("static.json: {key} is {raw:?}"))
        };
        let mut sizes = [0.; 8];
        for (i, t) in Type::ALL.iter().enumerate() {
            sizes[i] = read(t.token(), "em")?;
        }
        let mut weights = [0.; 4];
        for (i, w) in [
            Weight::Regular,
            Weight::Medium,
            Weight::Semibold,
            Weight::Bold,
        ]
        .iter()
        .enumerate()
        {
            weights[i] = read(w.token(), "")?;
        }
        Ok(Self {
            base,
            sizes,
            weights,
        })
    }
    pub fn style(&self, t: Type, w: Weight) -> nk_text::TextStyle {
        let i = Type::ALL.iter().position(|x| *x == t).unwrap_or(3);
        let j = [
            Weight::Regular,
            Weight::Medium,
            Weight::Semibold,
            Weight::Bold,
        ]
        .iter()
        .position(|x| *x == w)
        .unwrap_or(0);
        nk_text::TextStyle {
            size: self.base.size * self.sizes[i],
            weight: self.weights[j],
            ..self.base.clone()
        }
    }
}
