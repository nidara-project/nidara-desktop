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
    /// A selection in the accent (`--nidara-accent`) and what lies on it
    /// (`--nidara-accent-fg`): a sidebar's selected entry (D1).
    pub accent: Color,
    pub accent_fg: Color,
    /// A disabled control's text and glyphs (`--nidara-text-disabled`).
    pub disabled: Color,
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
            accent: token("--nidara-accent")?,
            accent_fg: token("--nidara-accent-fg")?,
            disabled: token("--nidara-text-disabled")?,
            focus_width: 2.,
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
pub struct ButtonStyle {
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
    Ok(ButtonStyle {
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
    pub focus: Color,
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
    pub focus: Color,
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
        focus: colour("focus")?,
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
    pub focus: Color,
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
        focus: color("focus")?,
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
        focus: colour(t, "focus")?,
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
    pub check: CheckStyle,
    pub button: ButtonStyle,
    pub dropdown: DropdownStyle,
    pub segmented: SegmentStyle,
    pub swatch: SwatchStyle,
    /// A setting row's least height (`static.json` `ts.ROW_HEIGHT.single`).
    pub row_height: f64,
    /// A group's corner (`components.json` `common.groupRadius`), as Settings' cards.
    pub group_radius: f64,
}
