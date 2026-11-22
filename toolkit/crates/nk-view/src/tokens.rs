// SPDX-License-Identifier: LGPL-3.0-or-later
//! What a view measures and paints with, read from the exported tokens and never written in a
//! surface: the kit's spacing scale (`tokens/static.json`), the text and focus colours
//! (`tokens/colors.json`) and the washes of a control's states (`tokens/glass.json`).
use crate::host::{Type, Weight};
use nk_render::Color;
use nk_widgets::ScrollbarStyle;
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

/// The kit's radius scale, `RADIUS` of `platform/tokens.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Radius {
    Xs,
    Sm,
    Md,
    Lg,
    Xl,
}
impl Radius {
    pub const ALL: [Radius; 5] = [Radius::Xs, Radius::Sm, Radius::Md, Radius::Lg, Radius::Xl];
    fn token(self) -> &'static str {
        match self {
            Radius::Xs => "xs",
            Radius::Sm => "sm",
            Radius::Md => "md",
            Radius::Lg => "lg",
            Radius::Xl => "xl",
        }
    }
}
/// The radius scale's values in logical pixels, as exported.
#[derive(Clone, Debug, PartialEq)]
pub struct Radii([f64; 5]);
impl Radii {
    /// From `tokens/static.json`: its `ts.RADIUS` map, every step.
    pub fn from_static(statics: &Value) -> Result<Self, String> {
        let mut out = [0.; 5];
        for (i, r) in Radius::ALL.iter().enumerate() {
            out[i] = statics["ts"]["RADIUS"][r.token()]
                .as_f64()
                .filter(|v| v.is_finite() && *v >= 0.)
                .ok_or_else(|| format!("static.json: no RADIUS.{}", r.token()))?;
        }
        Ok(Self(out))
    }
    pub fn px(&self, r: Radius) -> f64 {
        self.0[Radius::ALL.iter().position(|x| *x == r).unwrap_or(0)]
    }
}

/// A CSS `cubic-bezier(x1, y1, x2, y2)` easing.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Bezier(pub [f64; 4]);
impl Bezier {
    pub fn parse(s: &str) -> Result<Self, String> {
        let bad = || format!("not a cubic-bezier: {s:?}");
        let inner = s
            .trim()
            .strip_prefix("cubic-bezier(")
            .and_then(|r| r.strip_suffix(')'))
            .ok_or_else(bad)?;
        let v: Vec<f64> = inner
            .split(',')
            .map(|p| p.trim().parse::<f64>().map_err(|_| bad()))
            .collect::<Result<_, _>>()?;
        match v[..] {
            [x1, y1, x2, y2]
                if (0. ..=1.).contains(&x1)
                    && (0. ..=1.).contains(&x2)
                    && y1.is_finite()
                    && y2.is_finite() =>
            {
                Ok(Self([x1, y1, x2, y2]))
            }
            _ => Err(bad()),
        }
    }
    /// The eased value at time `t` in 0..1: the curve's y where its x is `t`.
    pub fn at(self, t: f64) -> f64 {
        if t <= 0. {
            return 0.;
        }
        if t >= 1. {
            return 1.;
        }
        let [x1, y1, x2, y2] = self.0;
        let cubic = |a: f64, b: f64, u: f64| {
            3. * (1. - u).powi(2) * u * a + 3. * (1. - u) * u * u * b + u.powi(3)
        };
        // x is monotonic in u for x1, x2 in 0..1: bisect.
        let (mut lo, mut hi) = (0., 1.);
        for _ in 0..40 {
            let mid = (lo + hi) / 2.;
            if cubic(x1, x2, mid) < t {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        cubic(y1, y2, (lo + hi) / 2.)
    }
}

/// The kit's motion: its two curves and its durations (`_tokens.scss`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Motion {
    pub ease: Bezier,
    pub emphasized: Bezier,
    pub base: std::time::Duration,
    pub slow: std::time::Duration,
}
impl Motion {
    pub fn from_static(statics: &Value) -> Result<Self, String> {
        let scss = |k: &str| {
            statics["scss"][k]
                .as_str()
                .ok_or_else(|| format!("static.json: no {k}"))
        };
        let ms = |k: &str| -> Result<std::time::Duration, String> {
            let raw = scss(k)?;
            raw.strip_suffix("ms")
                .and_then(|n| n.trim().parse::<u64>().ok())
                .map(std::time::Duration::from_millis)
                .ok_or_else(|| format!("static.json: {k} is {raw:?}, not milliseconds"))
        };
        Ok(Self {
            ease: Bezier::parse(scss("ease")?)?,
            emphasized: Bezier::parse(scss("ease-emphasized")?)?,
            base: ms("dur-base")?,
            slow: ms("dur-slow")?,
        })
    }
}

/// Content inks and selection colours. Keyboard outlines use the shared FocusStyle.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    pub primary: Color,
    pub secondary: Color,
    pub dim: Color,
    /// What is on is filled with (`--nidara-on`), and a well in the glass at rest
    /// (`--nidara-surface`) (VIEW.md §12.4).
    pub on: Color,
    pub surface: Color,
    /// A selection in the accent (`--nidara-accent`) and what lies on it
    /// (`--nidara-accent-fg`): a sidebar's selected entry (D1).
    pub accent: Color,
    pub accent_fg: Color,
    /// Selected row tint (`--nidara-state-selected`).
    pub selected: Color,
    /// A disabled control's text and glyphs (`--nidara-text-disabled`).
    pub disabled: Color,
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
            on: token("--nidara-on")?,
            surface: token("--nidara-surface")?,
            accent: token("--nidara-accent")?,
            accent_fg: token("--nidara-accent-fg")?,
            selected: token("--nidara-state-selected")?,
            disabled: token("--nidara-text-disabled")?,
        })
    }
    pub fn ink(&self, ink: crate::Ink) -> Color {
        match ink {
            crate::Ink::Primary => self.primary,
            crate::Ink::Secondary => self.secondary,
            crate::Ink::Dim => self.dim,
            crate::Ink::Disabled => self.disabled,
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
    /// The glass's own levels in the destructive states (lift rgb, gain rgb; `levels` in the
    /// export): a red glass, not red laid over it. None: an export without them.
    pub destructive_levels: [Option<[f64; 6]>; 2],
    pub fade_ms: u32,
}
impl Washes {
    /// The levels a state region of this wash shows the glass in: a destructive hover's or
    /// press's — matched by its colour, which no other state shares, so its fade-out (the same
    /// colour at no opacity) keeps them. The neutral washes are already levels of the glass (a
    /// white wash at a lifts it by a), so they need none.
    pub fn levels_of(&self, wash: [f64; 4]) -> Option<[f64; 6]> {
        [self.destructive_hover, self.destructive_press]
            .iter()
            .zip(self.destructive_levels)
            .find(|(w, _)| w[..3] == wash[..3])
            .and_then(|(_, l)| l)
    }
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
        let levels = |name: &str| -> Result<Option<[f64; 6]>, String> {
            let l = &states[name]["levels"];
            if l.is_null() {
                return Ok(None);
            }
            let mut out = [0.; 6];
            for (k, part) in ["lift", "gain"].iter().enumerate() {
                for (i, c) in ["r", "g", "b"].iter().enumerate() {
                    out[3 * k + i] = l[part][c]
                        .as_f64()
                        .filter(|v| v.is_finite())
                        .ok_or_else(|| format!("glass.json: {name}.levels.{part}.{c}"))?;
                }
            }
            Ok(Some(out))
        };
        Ok(Self {
            hover: wash("hover")?,
            press: wash("press")?,
            destructive_hover: wash("destructiveHover")?,
            destructive_press: wash("destructivePress")?,
            destructive_levels: [levels("destructiveHover")?, levels("destructivePress")?],
            fade_ms: states["fadeMs"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .ok_or("glass.json: states.fadeMs")?,
        })
    }
}

/// The kit's scroll bar (`components.json` `scrollbar`, from `toolkit/tokens/scrollbar.json`),
/// its colours named by token and resolved in one set of `tokens/colors.json`: the one bar the
/// native Tree draws too.
pub fn scrollbar_from(component: &Value, set: &Value) -> Result<ScrollbarStyle, String> {
    let n = |k: &str| {
        component[k]
            .as_f64()
            .map(|v| v as f32)
            .ok_or_else(|| format!("scrollbar: no {k}"))
    };
    let colour = |k: &str| -> Result<Color, String> {
        let name = component[k]
            .as_str()
            .ok_or_else(|| format!("scrollbar: no {k}"))?;
        set["tokens"][name]
            .as_str()
            .ok_or_else(|| format!("colors.json: no {name}"))
            .and_then(parse_color)
    };
    ScrollbarStyle {
        lane: n("lane")?,
        thumb_rest: n("thumbRest")?,
        thumb_hover: n("thumbHover")?,
        thumb_min: n("thumbMin")?,
        edge_clear: n("edgeClear")?,
        corner_clear: n("cornerClear")?,
        hide_ms: n("hideMs")?,
        fade_ms: n("fadeMs")?,
        width_tau_ms: n("widthTauMs")?,
        track_opacity: n("trackOpacity")?,
        color: colour("color")?,
        active: colour("active")?,
    }
    .checked()
}

/// The row slider's measures (`components.json` `range.slider`), the native Settings
/// slider's: the track's thickness, the thumb's radius, the fill's opacity, and how many steps
/// Page Up and Page Down move.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SliderStyle {
    /// A row slider's width, the gap to its value, and its flanking glyphs' size, opacity
    /// and gap (VIEW.md §13.7).
    pub width: f64,
    pub value_gap: f64,
    pub icon_size: f64,
    pub icon_opacity: f64,
    pub icon_gap: f64,
    pub track: f64,
    pub thumb_radius: f64,
    pub fill_opacity: f64,
    pub page_steps: f64,
}

pub fn slider_from(range: &Value) -> Result<SliderStyle, String> {
    let s = &range["slider"];
    let n = |k: &str| {
        s[k].as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .ok_or_else(|| format!("range.slider: no {k}"))
    };
    let style = SliderStyle {
        width: n("width")?,
        value_gap: n("valueGap")?,
        icon_size: n("iconSize")?,
        icon_opacity: n("iconOpacity")?,
        icon_gap: n("iconGap")?,
        track: n("track")?,
        thumb_radius: n("thumbRadius")?,
        fill_opacity: n("fillOpacity")?,
        page_steps: n("pageSteps")?,
    };
    if style.fill_opacity > 1.
        || style.icon_opacity > 1.
        || style.thumb_radius <= 0.
        || style.width <= 2. * style.thumb_radius
    {
        return Err("range.slider: invalid measures".into());
    }
    Ok(style)
}

/// The on/off switch's measures and colours (`components.json` `switch`), the native
/// switch's (VIEW.md §12.6).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SwitchStyle {
    pub width: f64,
    pub height: f64,
    pub border: f64,
    pub border_color: Color,
    pub checked_border_color: Color,
    pub track: Color,
    pub checked: Color,
    pub thumb: Color,
    pub thumb_margin: f64,
    pub disabled_opacity: f64,
}

/// A button in a page's content, which no glass lies under (`components.json` `button`,
/// `toolkit/tokens/button.json`: Settings' row button). The view paints all of it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ButtonPaintStyle {
    pub background: Color,
    pub border: Color,
    pub hover: Color,
    pub pressed: Color,
    pub text: Color,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ButtonStyle {
    pub primary: ButtonPaintStyle,
    pub destructive: ButtonPaintStyle,
    pub padding_x: f64,
    pub padding_y: f64,
    pub border: f64,
    pub min_content_height: f64,
    pub background: Color,
    pub border_color: Color,
    pub hover: Color,
    pub pressed: Color,
    pub disabled_opacity: f64,
}
impl ButtonStyle {
    /// Its height at the least: the content's floor, the padding and the border.
    pub fn min_height(&self) -> f64 {
        self.min_content_height + 2. * (self.padding_y + self.border)
    }
}

pub fn button_from(component: &Value, set: &Value) -> Result<ButtonStyle, String> {
    let n = |k: &str| {
        component[k]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .ok_or_else(|| format!("button: no {k}"))
    };
    let colour = |k: &str| -> Result<Color, String> {
        let name = component[k]
            .as_str()
            .ok_or_else(|| format!("button: no {k}"))?;
        if !name.starts_with("--") {
            return parse_color(name);
        }
        set["tokens"][name]
            .as_str()
            .ok_or_else(|| format!("colors.json: no {name}"))
            .and_then(parse_color)
    };
    let colour_at = |v: &Value, key: &str| -> Result<Color, String> {
        let name = v[key]
            .as_str()
            .ok_or_else(|| format!("button appearance: no {key}"))?;
        set["tokens"][name]
            .as_str()
            .ok_or_else(|| format!("colors.json: no {name}"))
            .and_then(parse_color)
    };
    let fraction = |v: &Value, key: &str| -> Result<f32, String> {
        v[key]
            .as_f64()
            .filter(|n| n.is_finite() && (0. ..=1.).contains(n))
            .map(|n| n as f32)
            .ok_or_else(|| format!("button appearance: invalid {key}"))
    };
    let primary = &component["primary"];
    let accent = colour_at(primary, "color")?;
    let white = fraction(primary, "hoverWhite")?;
    let black = fraction(primary, "pressedBlack")?;
    let mix = |amount: f32, endpoint: f32| {
        Color::new([
            accent.components[0] * (1. - amount) + endpoint * amount,
            accent.components[1] * (1. - amount) + endpoint * amount,
            accent.components[2] * (1. - amount) + endpoint * amount,
            accent.components[3],
        ])
    };
    let destructive = &component["destructive"];
    let red = colour_at(destructive, "color")?;
    Ok(ButtonStyle {
        primary: ButtonPaintStyle {
            background: accent,
            border: accent.with_alpha(fraction(primary, "borderAlpha")?),
            hover: mix(white, 1.),
            pressed: mix(black, 0.),
            text: colour_at(primary, "text")?,
        },
        destructive: ButtonPaintStyle {
            background: red.with_alpha(fraction(destructive, "restAlpha")?),
            border: red.with_alpha(fraction(destructive, "borderAlpha")?),
            hover: red.with_alpha(fraction(destructive, "hoverAlpha")?),
            pressed: red.with_alpha(fraction(destructive, "pressedAlpha")?),
            text: colour_at(destructive, "text")?,
        },
        padding_x: n("paddingX")?,
        padding_y: n("paddingY")?,
        border: n("border")?,
        min_content_height: n("minContentHeight")?,
        background: colour("background")?,
        border_color: colour("borderColor")?,
        hover: colour("hover")?,
        pressed: colour("pressed")?,
        disabled_opacity: n("disabledOpacity")?,
    })
}

/// The switch from its component, its colours named by token and resolved in one set of
/// `tokens/colors.json`, or written out (`checkedBorderColor` is an `rgba()`).
pub fn switch_from(component: &Value, set: &Value) -> Result<SwitchStyle, String> {
    let n = |k: &str| {
        component[k]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .ok_or_else(|| format!("switch: no {k}"))
    };
    let colour = |k: &str| -> Result<Color, String> {
        let name = component[k]
            .as_str()
            .ok_or_else(|| format!("switch: no {k}"))?;
        if !name.starts_with("--") {
            return parse_color(name);
        }
        set["tokens"][name]
            .as_str()
            .ok_or_else(|| format!("colors.json: no {name}"))
            .and_then(parse_color)
    };
    let style = SwitchStyle {
        width: n("width")?,
        height: n("height")?,
        border: n("border")?,
        border_color: colour("borderColor")?,
        checked_border_color: colour("checkedBorderColor")?,
        track: colour("trackColor")?,
        checked: colour("checkedColor")?,
        thumb: colour("thumbColor")?,
        thumb_margin: n("thumbMargin")?,
        disabled_opacity: n("disabledOpacity")?,
    };
    if style.disabled_opacity > 1.
        || style.height <= 2. * style.thumb_margin
        || style.width < style.height
    {
        return Err("switch: invalid measures".into());
    }
    Ok(style)
}

/// The checkbox's and the radio's mark (`components.json` `check`, `toolkit/tokens/check.json`):
/// a CheckButton's, off glass. The view paints its fill, border and states itself.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CheckStyle {
    pub size: f64,
    pub border: f64,
    /// The checkbox's corner; the radio is round.
    pub radius: f64,
    pub background: Color,
    pub border_color: Color,
    pub hover: Color,
    pub hover_border: Color,
    pub pressed: Color,
    pub checked: Color,
    pub tick: Color,
    pub tick_width: f64,
    /// A chosen radio's band of `dot_band_color` inside its border, around the accent dot.
    pub dot_band: f64,
    pub dot_band_color: Color,
    pub disabled_opacity: f64,
}

/// The mark from its component, its colours named by token and resolved in one set of
/// `tokens/colors.json`, its corner a step of `radii`.
pub fn check_from(component: &Value, set: &Value, radii: &Radii) -> Result<CheckStyle, String> {
    let n = |k: &str| {
        component[k]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .ok_or_else(|| format!("check: no {k}"))
    };
    let colour = |k: &str| -> Result<Color, String> {
        let name = component[k]
            .as_str()
            .ok_or_else(|| format!("check: no {k}"))?;
        if !name.starts_with("--") {
            return parse_color(name);
        }
        set["tokens"][name]
            .as_str()
            .ok_or_else(|| format!("colors.json: no {name}"))
            .and_then(parse_color)
    };
    let radius = component["radius"]
        .as_str()
        .and_then(|r| Radius::ALL.into_iter().find(|x| x.token() == r))
        .ok_or("check: no radius")?;
    let style = CheckStyle {
        size: n("size")?,
        border: n("border")?,
        radius: radii.px(radius),
        background: colour("background")?,
        border_color: colour("borderColor")?,
        hover: colour("hover")?,
        hover_border: colour("hoverBorder")?,
        pressed: colour("pressed")?,
        checked: colour("checked")?,
        tick: colour("tick")?,
        tick_width: n("tickWidth")?,
        dot_band: n("dotBand")?,
        dot_band_color: colour("dotBandColor")?,
        disabled_opacity: n("disabledOpacity")?,
    };
    if style.disabled_opacity > 1.
        || style.size <= 2. * (style.border + style.dot_band)
        || style.radius > style.size / 2.
    {
        return Err("check: invalid measures".into());
    }
    Ok(style)
}

/// A dropdown's closed trigger (`components.json` `dropdown.trigger`,
/// `toolkit/tokens/dropdown.json`): Settings' dropdown button, off glass. The view paints it.
#[derive(Clone, Debug, PartialEq)]
pub struct TriggerStyle {
    pub padding_x: f64,
    pub padding_y: f64,
    pub border: f64,
    pub min_content_height: f64,
    pub radius: f64,
    pub font: (Type, Weight),
    /// Room before the label, inside the padding.
    pub label_margin: f64,
    pub arrow_size: f64,
    pub arrow_gap: f64,
    /// The arrow's `nd-` name.
    pub arrow: String,
    pub background: Color,
    pub hover: Color,
    pub pressed: Color,
    pub text: Color,
    pub arrow_color: Color,
    pub disabled_opacity: f64,
}
impl TriggerStyle {
    /// Its inset on each side across (border and padding) and down, and its least height.
    pub fn inset(&self) -> (f64, f64, f64) {
        let down = self.border + self.padding_y;
        (
            self.border + self.padding_x,
            down,
            self.min_content_height + 2. * down,
        )
    }
}

/// A dropdown's open list (`components.json` `dropdown.menu`): a popup on panel glass, each
/// option a row, the one under the pointer or the keyboard filled with the accent, the chosen
/// one ticked.
#[derive(Clone, Debug, PartialEq)]
pub struct MenuStyle {
    pub border: f64,
    pub radius: f64,
    /// Room between the menu's border and its rows.
    pub inset: f64,
    pub padding_x: f64,
    pub padding_y: f64,
    pub row_radius: f64,
    pub font: (Type, Weight),
    pub check_size: f64,
    pub check_gap: f64,
    /// The tick's stroke, in the 24-unit box it is drawn in.
    pub check_stroke: f64,
    /// Under the rows without the compositor's glass (D5).
    pub background: Color,
    pub border_color: Color,
    pub text: Color,
    pub accent: Color,
    pub accent_text: Color,
    /// How much darker a pressed row's accent is.
    pub pressed_black: f64,
}
impl MenuStyle {
    /// A row's inset across and down, and its least height.
    pub fn row_inset(&self) -> (f64, f64, f64) {
        (
            self.padding_x,
            self.padding_y,
            self.check_size + 2. * self.padding_y,
        )
    }
    /// Its rows' distance from its edge.
    pub fn edge(&self) -> f64 {
        self.border + self.inset
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DropdownStyle {
    pub trigger: TriggerStyle,
    pub menu: MenuStyle,
}

/// The dropdown from its component: colours named by token and resolved in one set of
/// `tokens/colors.json`, corners steps of `radii`, the label's margin a step of `spacing`,
/// the fonts steps of the type scale.
/// A segmented choice's look (VIEW.md §13.10; `components.json` `choices.segmented`, from
/// `toolkit/tokens/choices.json`): Settings' linked preset buttons, off glass. The view paints
/// it; the chosen segment is the accent.
#[derive(Clone, Debug, PartialEq)]
pub struct SegmentStyle {
    pub padding_x: f64,
    pub padding_y: f64,
    pub border: f64,
    /// The text line's least height inside the padding (the button's).
    pub min_content_height: f64,
    /// The group's corner: its two ends are rounded, the joins between segments are not.
    pub radius: f64,
    pub font: (Type, Weight),
    pub background: Color,
    pub hover: Color,
    pub pressed: Color,
    pub text: Color,
    pub border_color: Color,
    pub selected: Color,
    pub selected_text: Color,
    /// How much white the chosen segment takes under the pointer, and black while pressed.
    pub selected_hover_white: f64,
    pub selected_pressed_black: f64,
    pub disabled_opacity: f64,
}
impl SegmentStyle {
    /// A segment's padding across and down, and its least height (as `TriggerStyle::inset`).
    pub fn inset(&self) -> (f64, f64, f64) {
        let down = self.border + self.padding_y;
        (
            self.border + self.padding_x,
            down,
            self.min_content_height + 2. * down,
        )
    }
}

/// The segmented choice's look from the exported `choices.segmented` (`component`), its colours
/// resolved in `set` (one `colors.json` set) and its corner in `radii`. A field missing or out of
/// range is an error: there is no default here.
pub fn segmented_from(
    component: &Value,
    set: &Value,
    radii: &Radii,
) -> Result<SegmentStyle, String> {
    let c = component;
    if !c.is_object() {
        return Err("choices: no segmented".into());
    }
    let n = |k: &str| {
        c[k].as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .ok_or_else(|| format!("segmented: no {k}"))
    };
    let word = |k: &str| {
        c[k].as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("segmented: no {k}"))
    };
    let colour = |k: &str| -> Result<Color, String> {
        let name = word(k)?;
        if !name.starts_with("--") {
            return parse_color(&name);
        }
        set["tokens"][&name]
            .as_str()
            .ok_or_else(|| format!("colors.json: no {name}"))
            .and_then(parse_color)
    };
    let corner = word("radius")?;
    let (size, weight) = (word("fontSize")?, word("fontWeight")?);
    let s = SegmentStyle {
        padding_x: n("paddingX")?,
        padding_y: n("paddingY")?,
        border: n("border")?,
        min_content_height: n("minContentHeight")?,
        radius: Radius::ALL
            .into_iter()
            .find(|r| r.token() == corner)
            .map(|r| radii.px(r))
            .ok_or_else(|| format!("segmented: radius {corner:?} is not a radius"))?,
        font: (
            Type::ALL
                .into_iter()
                .find(|x| x.token() == size)
                .ok_or_else(|| format!("segmented: {size:?} is not a type step"))?,
            Weight::ALL
                .into_iter()
                .find(|x| x.token() == weight)
                .ok_or_else(|| format!("segmented: {weight:?} is not a weight"))?,
        ),
        background: colour("background")?,
        hover: colour("hover")?,
        pressed: colour("pressed")?,
        text: colour("text")?,
        border_color: colour("borderColor")?,
        selected: colour("selectedColor")?,
        selected_text: colour("selectedText")?,
        selected_hover_white: n("selectedHoverWhite")?,
        selected_pressed_black: n("selectedPressedBlack")?,
        disabled_opacity: n("disabledOpacity")?,
    };
    if s.disabled_opacity > 1. || s.selected_hover_white > 1. || s.selected_pressed_black > 1. {
        return Err("segmented: invalid measures".into());
    }
    Ok(s)
}

/// Colour samples, outside glass; every field comes from `choices.swatch`.
#[derive(Clone, Debug, PartialEq)]
pub struct SwatchStyle {
    pub diameter: f64,
    pub border: f64,
    pub ring: f64,
    pub gap: f64,
    pub selected: Color,
    pub hover: Color,
    pub disabled_opacity: f64,
}
pub fn swatch_from(c: &Value, set: &Value) -> Result<SwatchStyle, String> {
    let n = |k: &str| {
        c[k].as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .ok_or_else(|| format!("swatch: no {k}"))
    };
    let color = |k: &str| -> Result<Color, String> {
        let word = c[k].as_str().ok_or_else(|| format!("swatch: no {k}"))?;
        let value = if word.starts_with("--") {
            set["tokens"][word]
                .as_str()
                .ok_or_else(|| format!("colors.json: no {word}"))?
        } else {
            word
        };
        parse_color(value)
    };
    let s = SwatchStyle {
        diameter: n("diameter")?,
        border: n("border")?,
        ring: n("ring")?,
        gap: n("gap")?,
        selected: color("selectedColor")?,
        hover: color("hoverColor")?,
        disabled_opacity: n("disabledOpacity")?,
    };
    if [s.diameter, s.border, s.ring, s.gap]
        .iter()
        .any(|v| *v <= 0.)
        || s.border * 2. >= s.diameter
        || s.disabled_opacity > 1.
    {
        return Err("swatch: invalid measures".into());
    }
    Ok(s)
}

pub fn dropdown_from(
    component: &Value,
    set: &Value,
    radii: &Radii,
    spacing: &Spacing,
) -> Result<DropdownStyle, String> {
    let part = |name: &str| {
        let c = &component[name];
        c.is_object()
            .then_some(c)
            .ok_or_else(|| format!("dropdown: no {name}"))
    };
    let (t, m) = (part("trigger")?, part("menu")?);
    let n = |c: &Value, k: &str| {
        c[k].as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .ok_or_else(|| format!("dropdown: no {k}"))
    };
    let word = |c: &Value, k: &str| {
        c[k].as_str()
            .map(str::to_owned)
            .ok_or_else(|| format!("dropdown: no {k}"))
    };
    let colour = |c: &Value, k: &str| -> Result<Color, String> {
        let name = word(c, k)?;
        if !name.starts_with("--") {
            return parse_color(&name);
        }
        set["tokens"][&name]
            .as_str()
            .ok_or_else(|| format!("colors.json: no {name}"))
            .and_then(parse_color)
    };
    let radius = |c: &Value, k: &str| {
        let w = word(c, k)?;
        Radius::ALL
            .into_iter()
            .find(|r| r.token() == w)
            .map(|r| radii.px(r))
            .ok_or_else(|| format!("dropdown: {k} {w:?} is not a radius"))
    };
    let font = |c: &Value| -> Result<(Type, Weight), String> {
        let (size, weight) = (word(c, "fontSize")?, word(c, "fontWeight")?);
        Ok((
            Type::ALL
                .into_iter()
                .find(|x| x.token() == size)
                .ok_or_else(|| format!("dropdown: {size:?} is not a type step"))?,
            Weight::ALL
                .into_iter()
                .find(|x| x.token() == weight)
                .ok_or_else(|| format!("dropdown: {weight:?} is not a weight"))?,
        ))
    };
    let margin = word(t, "labelMargin")?;
    let trigger = TriggerStyle {
        padding_x: n(t, "paddingX")?,
        padding_y: n(t, "paddingY")?,
        border: n(t, "border")?,
        min_content_height: n(t, "minContentHeight")?,
        radius: radius(t, "radius")?,
        font: font(t)?,
        label_margin: Space::ALL
            .into_iter()
            .find(|s| s.token() == margin)
            .map(|s| spacing.px(s))
            .ok_or_else(|| format!("dropdown: {margin:?} is not a space"))?,
        arrow_size: n(t, "arrowSize")?,
        arrow_gap: n(t, "arrowGap")?,
        arrow: word(t, "arrow")?,
        background: colour(t, "background")?,
        hover: colour(t, "hover")?,
        pressed: colour(t, "pressed")?,
        text: colour(t, "text")?,
        arrow_color: colour(t, "arrowColor")?,
        disabled_opacity: n(t, "disabledOpacity")?,
    };
    let menu = MenuStyle {
        border: n(m, "border")?,
        radius: radius(m, "radius")?,
        inset: n(m, "inset")?,
        padding_x: n(m, "paddingX")?,
        padding_y: n(m, "paddingY")?,
        row_radius: radius(m, "rowRadius")?,
        font: font(m)?,
        check_size: n(m, "checkSize")?,
        check_gap: n(m, "checkGap")?,
        check_stroke: n(m, "checkStroke")?,
        background: colour(m, "background")?,
        border_color: colour(m, "borderColor")?,
        text: colour(m, "text")?,
        accent: colour(m, "accent")?,
        accent_text: colour(m, "accentText")?,
        pressed_black: n(m, "pressedBlack")?,
    };
    if trigger.disabled_opacity > 1.
        || menu.pressed_black > 1.
        || trigger.arrow_size <= 0.
        || menu.check_size <= 0.
        || menu.check_stroke <= 0.
        || trigger.arrow.is_empty()
    {
        return Err("dropdown: invalid measures".into());
    }
    Ok(DropdownStyle { trigger, menu })
}

/// Settings' disclosure row, from rows/common/list and the shared row-height token.
#[derive(Clone, Debug)]
pub struct DisclosureStyle {
    pub padding: f64,
    pub height: f64,
    pub icon_size: f64,
    pub view_box: f64,
    pub stroke: f64,
    pub points: [(f64, f64); 3],
    pub hover_opacity: f64,
}
pub fn disclosure_from(components: &Value, statics: &Value) -> Result<DisclosureStyle, String> {
    let n = |v: &Value, field: &str, positive: bool| {
        v.as_f64()
            .filter(|v| v.is_finite() && if positive { *v > 0. } else { *v >= 0. })
            .ok_or_else(|| format!("disclosure: invalid {field}"))
    };
    let d = &components["rows"]["disclosure"];
    let c = &d["chevron"];
    let mut points = [(0., 0.); 3];
    let raw = c["closedPoints"]
        .as_array()
        .filter(|v| v.len() == 3)
        .ok_or("disclosure: invalid chevron points")?;
    let view_box = n(&c["viewBox"], "viewBox", true)?;
    for (out, point) in points.iter_mut().zip(raw) {
        let p = point
            .as_array()
            .filter(|v| v.len() == 2)
            .ok_or("disclosure: invalid point")?;
        *out = (n(&p[0], "point x", false)?, n(&p[1], "point y", false)?);
        if out.0 > view_box || out.1 > view_box {
            return Err("disclosure: point outside viewBox".into());
        }
    }
    let hover_opacity = n(
        &components["list"]["highlight"]["hoverOpacity"],
        "hoverOpacity",
        false,
    )?;
    if hover_opacity > 1. {
        return Err("disclosure: hoverOpacity exceeds one".into());
    }
    Ok(DisclosureStyle {
        padding: n(&components["common"]["padding"], "padding", false)?,
        height: n(&statics["ts"]["ROW_HEIGHT"]["single"], "height", true)?,
        icon_size: n(&d["iconSize"], "iconSize", true)?,
        view_box,
        points,
        stroke: n(&c["strokeWidth"], "strokeWidth", true)?,
        hover_opacity,
    })
}

/// Single-line entry/search chrome, shared with Settings' existing search export.
#[derive(Clone, Debug)]
pub struct EntryStyle {
    pub padding_x: f64,
    pub border: f64,
    pub min_height: f64,
    pub radius: f64,
    pub icon_size: f64,
    pub icon_gap: f64,
    pub icon: String,
    pub clear_icon: String,
    /// Visible icon button follows header.navigation; the hit frame is unchanged.
    pub clear_button: f64,
    pub clear_edge: f64,
    pub background: Color,
    pub border_color: Color,
    pub text: Color,
    pub dim: Color,
    pub selection: Color,
    pub selection_text: Color,
}
pub fn entry_from(
    component: &Value,
    set: &Value,
    navigation: &Value,
) -> Result<EntryStyle, String> {
    let n = |k: &str| {
        component[k]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .ok_or_else(|| format!("entry: invalid {k}"))
    };
    let name = |k: &str| {
        component[k]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .ok_or_else(|| format!("entry: missing {k}"))
    };
    let color = |k: &str| -> Result<Color, String> {
        let token = name(k)?;
        set["tokens"][&token]
            .as_str()
            .ok_or_else(|| format!("entry: no {token}"))
            .and_then(parse_color)
    };
    let radius = set["tokens"][name("radius")?]
        .as_str()
        .and_then(|s| s.strip_suffix("px"))
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v >= 0.)
        .ok_or("entry: invalid radius")?;
    let style = EntryStyle {
        padding_x: n("paddingX")?,
        border: n("border")?,
        min_height: n("minHeight")?,
        radius,
        icon_size: n("iconSize")?,
        icon_gap: n("iconGap")?,
        icon: name("icon")?,
        clear_icon: name("clearIcon")?,
        clear_button: navigation["button"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0.)
            .ok_or("entry: navigation.button")?,
        clear_edge: navigation["edge"]
            .as_f64()
            .filter(|v| v.is_finite() && *v >= 0.)
            .ok_or("entry: navigation.edge")?,
        background: color("background")?,
        border_color: color("borderColor")?,
        text: color("text")?,
        dim: color("dim")?,
        selection: color("selection")?,
        selection_text: color("selectionText")?,
    };
    if style.min_height <= 0.
        || style.icon_size <= 0.
        || style.clear_button + 2. * style.clear_edge > style.min_height
        || style.icon_size > style.clear_button
    {
        return Err("entry: empty control".into());
    }
    Ok(style)
}

/// Everything a view is laid out and drawn with.
#[derive(Clone, Debug)]
pub struct Tokens {
    pub focus: FocusStyle,
    pub list: ListStyle,
    pub spacing: Spacing,
    pub radii: Radii,
    pub motion: Motion,
    pub look: Look,
    pub washes: Washes,
    pub scrollbar: ScrollbarStyle,
    pub slider: SliderStyle,
    pub switch: SwitchStyle,
    pub check: CheckStyle,
    pub button: ButtonStyle,
    pub dropdown: DropdownStyle,
    pub segmented: SegmentStyle,
    pub swatch: SwatchStyle,
    pub disclosure: DisclosureStyle,
    pub entry: EntryStyle,
    pub tile: TileStyle,
    /// The notification card's measures (`toolkit/tokens/notification.json`).
    pub notification: NotificationStyle,
    /// A list row's least height (`static.json` `ts.ROW_HEIGHT.single`).
    pub row_height: f64,
    /// A group's corner (`components.json` `common.groupRadius`), as Settings' cards.
    pub group_radius: f64,
}

/// The kit's tiles (`components.json` `tile`, from `toolkit/tokens/tile.json`): `nk::Tile` and
/// `nk::SliderTile`, and the grid they lie on.
#[derive(Clone, Debug, PartialEq)]
pub struct TileStyle {
    /// A grid cell and the gap between two.
    pub cell: f64,
    pub gap: f64,
    /// A 2×2's corner.
    pub corner_square: f64,
    /// A row's distance from the tile's edge; a tall slider's fill from the glass.
    pub pad: f64,
    pub tall_pad: f64,
    /// A badge's circle, its gap to the titles and its inset from the pad.
    pub badge: f64,
    pub badge_gap: f64,
    pub badge_inset: f64,
    /// A tile's glyph.
    pub icon: f64,
    /// Title and subtitle sizes, the title's weight, the small size.
    pub title: f32,
    pub title_weight: f32,
    pub subtitle: f32,
    pub small: f32,
    /// A picture tile: its picture wide and square, the row's lead and gap, its actions'
    /// glyph and the room each takes wide and square, the square's text side.
    pub picture_wide: f64,
    pub picture_square: f64,
    pub picture_lead: f64,
    pub picture_gap: f64,
    pub action_glyph: f64,
    pub action_room_wide: f64,
    pub action_room_square: f64,
    pub picture_side: f64,
    /// Above and below a square picture tile's titles.
    pub picture_between: f64,
    /// A 1×2 slider: its value's distance from the top and its height, its icon's from the
    /// bottom.
    pub tall_top: f64,
    pub tall_value: f64,
    pub tall_bottom: f64,
    /// A 4×1 slider: its lead, its icons, their gap to the slider, the value's width.
    pub slider_lead: f64,
    pub slider_icon: f64,
    pub slider_gap: f64,
    pub slider_value: f64,
    /// A ring's track opacity.
    pub track: f64,
}
pub fn tile_from(v: &Value) -> Result<TileStyle, String> {
    let n = |path: &[&str]| -> Result<f64, String> {
        path.iter()
            .fold(v, |v, k| &v[*k])
            .as_f64()
            .filter(|x| x.is_finite() && *x >= 0.)
            .ok_or_else(|| format!("tile: no {}", path.join(".")))
    };
    Ok(TileStyle {
        cell: n(&["grid", "cell"])?,
        gap: n(&["grid", "gap"])?,
        corner_square: n(&["cornerSquare"])?,
        pad: n(&["pad"])?,
        tall_pad: n(&["tallPad"])?,
        badge: n(&["badge", "size"])?,
        badge_gap: n(&["badge", "gap"])?,
        badge_inset: n(&["badge", "inset"])?,
        icon: n(&["icon"])?,
        title: n(&["text", "title"])? as f32,
        title_weight: n(&["text", "titleWeight"])? as f32,
        subtitle: n(&["text", "subtitle"])? as f32,
        small: n(&["text", "small"])? as f32,
        picture_wide: n(&["picture", "wide"])?,
        picture_square: n(&["picture", "square"])?,
        picture_lead: n(&["picture", "lead"])?,
        picture_gap: n(&["picture", "gap"])?,
        action_glyph: n(&["picture", "glyph"])?,
        action_room_wide: n(&["picture", "roomWide"])?,
        action_room_square: n(&["picture", "roomSquare"])?,
        picture_side: n(&["picture", "side"])?,
        picture_between: n(&["picture", "between"])?,
        tall_top: n(&["tall", "top"])?,
        tall_value: n(&["tall", "value"])?,
        tall_bottom: n(&["tall", "bottom"])?,
        slider_lead: n(&["slider", "lead"])?,
        slider_icon: n(&["slider", "icon"])?,
        slider_gap: n(&["slider", "gap"])?,
        slider_value: n(&["slider", "value"])?,
        track: n(&["track"]).and_then(|t| {
            (t <= 1.)
                .then_some(t)
                .ok_or_else(|| "tile: track above 1".to_string())
        })?,
    })
}

/// `nk::NotificationCard`'s measures (`toolkit/tokens/notification.json`).
#[derive(Clone, Debug, PartialEq)]
pub struct NotificationStyle {
    /// The card's corner, and an open card's big picture's, on the radius scale.
    pub corner: Radius,
    pub hero_corner: Radius,
    /// The app icon and the thumbnail beside the text.
    pub art: f64,
    pub line_height: f32,
    pub title: f32,
    pub title_weight: f32,
    pub age: f32,
    pub count: f32,
    pub count_weight: f32,
    pub body: f32,
    pub action: f32,
    pub error: f32,
    /// The body's lines folded (and the room it keeps however short) and open; an error's.
    pub lines_folded: usize,
    pub lines_open: usize,
    pub lines_error: usize,
    /// The close and show-more glyphs.
    pub glyph: f64,
    /// A picture spans an open card when its source is at least this wide, at a height
    /// between the two bounds.
    pub hero_source: u32,
    pub hero_min: f64,
    pub hero_max: f64,
}
impl NotificationStyle {
    /// How tall a `w`×`h` picture is across `across` px of an open card: None when it is too
    /// small to span it (a chat avatar), and keeps its thumbnail.
    pub fn hero_height(&self, across: f64, (w, h): (u32, u32)) -> Option<f64> {
        (w >= self.hero_source && w > 0 && across > 0.).then(|| {
            (across * f64::from(h) / f64::from(w))
                .round()
                .clamp(self.hero_min, self.hero_max)
        })
    }
}
pub fn notification_from(v: &Value) -> Result<NotificationStyle, String> {
    let n = |path: &[&str]| -> Result<f64, String> {
        path.iter()
            .fold(v, |v, k| &v[*k])
            .as_f64()
            .filter(|x| x.is_finite() && *x >= 0.)
            .ok_or_else(|| format!("notification: no {}", path.join(".")))
    };
    let radius = |k: &str| -> Result<Radius, String> {
        let name = v[k]
            .as_str()
            .ok_or_else(|| format!("notification: no {k}"))?;
        Radius::ALL
            .into_iter()
            .find(|r| r.token() == name)
            .ok_or_else(|| format!("notification: {k} {name} is not on the radius scale"))
    };
    let (min, max) = (n(&["hero", "min"])?, n(&["hero", "max"])?);
    if min > max {
        return Err("notification: hero.min above hero.max".into());
    }
    Ok(NotificationStyle {
        corner: radius("corner")?,
        hero_corner: radius("heroCorner")?,
        art: n(&["art"])?,
        line_height: n(&["lineHeight"])? as f32,
        title: n(&["text", "title"])? as f32,
        title_weight: n(&["text", "titleWeight"])? as f32,
        age: n(&["text", "age"])? as f32,
        count: n(&["text", "count"])? as f32,
        count_weight: n(&["text", "countWeight"])? as f32,
        body: n(&["text", "body"])? as f32,
        action: n(&["text", "action"])? as f32,
        error: n(&["text", "error"])? as f32,
        lines_folded: n(&["lines", "folded"])? as usize,
        lines_open: n(&["lines", "open"])? as usize,
        lines_error: n(&["lines", "error"])? as usize,
        glyph: n(&["glyph"])?,
        hero_source: n(&["hero", "source"])? as u32,
        hero_min: min,
        hero_max: max,
    })
}

#[derive(Clone, Debug, PartialEq)]
pub struct ListStyle {
    pub inset: f64,
    pub hover_opacity: f32,
    /// The line between two rows: its width in physical pixels and its colour.
    pub separator_px: f64,
    pub separator: Color,
}
pub fn list_from(value: &Value, set: &Value) -> Result<ListStyle, String> {
    let inset = value["highlight"]["inset"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.)
        .ok_or("list.highlight.inset")?;
    let hover = value["highlight"]["hoverOpacity"]
        .as_f64()
        .filter(|v| v.is_finite() && (0.0..=1.0).contains(v))
        .ok_or("list.highlight.hoverOpacity")?;
    let separator_px = value["separator"]["physicalPixels"]
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.)
        .ok_or("list.separator.physicalPixels")?;
    let name = value["separator"]["color"]
        .as_str()
        .ok_or("list.separator.color")?;
    let separator = set["tokens"][name]
        .as_str()
        .ok_or_else(|| "list.separator.color token".to_owned())
        .and_then(parse_color)?;
    Ok(ListStyle {
        inset,
        hover_opacity: hover as f32,
        separator_px,
        separator,
    })
}

/// Shared keyboard focus tokens, from components.focus.
#[derive(Clone, Debug, PartialEq)]
pub struct FocusStyle {
    pub width: f64,
    pub gap: f64,
    pub color: Color,
}
pub fn focus_from(value: &Value, set: &Value) -> Result<FocusStyle, String> {
    let width = value["width"]
        .as_f64()
        .filter(|v| v.is_finite() && *v > 0.)
        .ok_or("focus.width")?;
    let gap = value["gap"]
        .as_f64()
        .filter(|v| v.is_finite() && *v >= 0.)
        .ok_or("focus.gap")?;
    let name = value["color"].as_str().ok_or("focus.color")?;
    let color = set["tokens"][name]
        .as_str()
        .ok_or_else(|| "focus.color token".to_owned())
        .and_then(parse_color)?;
    Ok(FocusStyle { width, gap, color })
}

impl FocusStyle {
    pub(crate) fn outside(&self, bounds: crate::Rect) -> crate::Rect {
        let out = self.gap + self.width;
        [
            bounds[0] - out,
            bounds[1] - out,
            bounds[2] + 2. * out,
            bounds[3] + 2. * out,
        ]
    }
}
