// SPDX-License-Identifier: LGPL-3.0-or-later
//! What a view measures and paints with, read from the exported tokens and never written in a
//! surface: the kit's spacing scale (`tokens/static.json`), the text and focus colours
//! (`tokens/colors.json`) and the washes of a control's states (`tokens/glass.json`).
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

/// The colours a view paints content in: text tiers, and the focus ring (content, D8).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    pub primary: Color,
    pub secondary: Color,
    pub dim: Color,
    pub focus: Color,
    /// What is on is filled with (`--nidara-on`), and a well in the glass at rest
    /// (`--nidara-surface`) (VIEW.md §12.4).
    pub on: Color,
    pub surface: Color,
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
            on: token("--nidara-on")?,
            surface: token("--nidara-surface")?,
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
        track: n("track")?,
        thumb_radius: n("thumbRadius")?,
        fill_opacity: n("fillOpacity")?,
        page_steps: n("pageSteps")?,
    };
    if style.fill_opacity > 1. || style.thumb_radius <= 0. {
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

/// Everything a view is laid out and drawn with.
#[derive(Clone, Debug)]
pub struct Tokens {
    pub spacing: Spacing,
    pub radii: Radii,
    pub motion: Motion,
    pub look: Look,
    pub washes: Washes,
    pub scrollbar: ScrollbarStyle,
    pub slider: SliderStyle,
    pub switch: SwitchStyle,
}
