// SPDX-License-Identifier: LGPL-3.0-or-later
//! The exported tokens as `nk-widgets`' styles: done here once, for the app and the widgets
//! demo alike (`CONTRACT.md` → "The native Settings"). Every number and colour comes from the
//! set the portal picked (`Exports::tokens`) or from `static.json`; a field missing is an error,
//! never a default.

use crate::exports::{Exports, Tokens};
use crate::portal::Appearance;
use nk_render::{Color, rgba};
use nk_widgets::{ChoiceStyle, Metrics, Palette, RangeStyle, SwitchStyle};
use serde_json::Value as Json;

pub struct Styles {
    pub palette: Palette,
    pub metrics: Metrics,
    pub choices: ChoiceStyle,
    pub range: RangeStyle,
    pub switch: SwitchStyle,
    /// The accent palette by name, in its export order (`colors.json` `accents`).
    pub accents: Vec<(String, Color)>,
    /// The interface font at the text scale (the portal's), at the kit's body line height.
    pub text: nk_text::TextStyle,
}

impl Styles {
    pub fn new(exports: &Exports, appearance: &Appearance) -> Result<Self, String> {
        let tokens = exports.tokens(appearance)?;
        let statics = &exports.statics;
        let c = tokens.components;
        let token = |name: &str| colour(&tokens, name);
        let field = |v: &Json, what: &str| -> Result<String, String> {
            v.as_str()
                .map(str::to_owned)
                .ok_or_else(|| format!("missing {what}"))
        };
        let list = list_tokens(c)?;
        let palette = Palette {
            background: token("--nidara-bg")?,
            surface: token("--nidara-surface")?,
            text: token("--nidara-text")?,
            disabled: token("--nidara-text-disabled")?,
            selected: token("--nidara-state-selected")?,
            accent: token("--nidara-accent")?,
            track: token("--nidara-surface")?,
            thumb: token("--nidara-thumb")?,
            focus: token("--nidara-accent")?,
            separator: token(&field(
                &list["separator"]["color"],
                "list separator colour",
            )?)?,
        };
        let sw = &c["switch"];
        let switch = SwitchStyle {
            border: number(&sw["border"])?,
            border_color: token(&field(&sw["borderColor"], "switch border colour")?)?,
            checked_border_color: token(&field(
                &sw["checkedBorderColor"],
                "switch checked border colour",
            )?)?,
            track: token(&field(&sw["trackColor"], "switch track colour")?)?,
            checked: token(&field(&sw["checkedColor"], "switch checked colour")?)?,
            thumb: token(&field(&sw["thumbColor"], "switch thumb colour")?)?,
            thumb_margin: number(&sw["thumbMargin"])?,
            disabled_opacity: number(&sw["disabledOpacity"])?,
        };
        let layout = &statics["ts"]["WINDOW_LAYOUT"];
        let metrics = Metrics {
            sidebar: number(&layout["sidebar"])?,
            content: number(&layout["content"])?,
            form_width: number(&c["widths"]["form"]["preferred"])?,
            content_floor: number(&c["widths"]["form"]["floor"])?,
            titlebar: scss(statics, "space-10")? + scss(statics, "space-2")?,
            padding: number(&c["common"]["padding"])?,
            gap: number(&c["common"]["gap"])?,
            row: number(&statics["ts"]["ROW_HEIGHT"]["single"])?,
            control: number(&sw["height"])?,
            switch_width: number(&sw["width"])?,
            radius: number(&c["common"]["radius"])?,
            group_radius: number(&c["common"]["groupRadius"])?,
            focus_width: number(&list["focus"]["width"])?,
            highlight_inset: number(&list["highlight"]["inset"])?,
            hover_opacity: number(&list["highlight"]["hoverOpacity"])?,
            separator_width: number(&list["separator"]["physicalPixels"])?,
        };
        let ch = &c["choices"];
        let (seg, sw_) = (&ch["segmented"], &ch["swatch"]);
        let choices = ChoiceStyle {
            segment_padding_x: number(&seg["paddingX"])?,
            segment_padding_y: number(&seg["paddingY"])?,
            segment_border: number(&seg["border"])?,
            segment_text_scale: em(statics, &field(&seg["fontSize"], "choices font size")?)?,
            segment_border_color: token(&field(&seg["borderColor"], "segment border colour")?)?,
            segment_selected: token(&field(&seg["selectedColor"], "segment colour")?)?,
            segment_selected_text: token(&field(&seg["selectedText"], "segment text colour")?)?,
            swatch_diameter: number(&sw_["diameter"])?,
            swatch_border: number(&sw_["border"])?,
            swatch_ring: number(&sw_["ring"])?,
            swatch_gap: number(&sw_["gap"])?,
            swatch_selected: token(&field(&sw_["selectedColor"], "swatch ring colour")?)?,
            swatch_hover: token(&field(&sw_["hoverColor"], "swatch hover colour")?)?,
        };
        let (slider, spin) = (&c["range"]["slider"], &c["range"]["spin"]);
        let range = RangeStyle {
            slider_width: number(&slider["width"])?,
            slider_track: number(&slider["track"])?,
            slider_thumb_radius: number(&slider["thumbRadius"])?,
            slider_value_gap: number(&slider["valueGap"])?,
            slider_fill_opacity: number(&slider["fillOpacity"])?,
            slider_page_steps: number(&slider["pageSteps"])?,
            slider_icon_size: number(&slider["iconSize"])?,
            slider_icon_opacity: number(&slider["iconOpacity"])?,
            slider_icon_gap: number(&slider["iconGap"])?,
            spin_height: number(&spin["height"])?,
            spin_text_width: number(&spin["textWidth"])?,
            spin_button_width: number(&spin["buttonWidth"])?,
            spin_border: number(&spin["border"])?,
            spin_border_color: token(&field(&spin["borderColor"], "spin border colour")?)?,
            spin_gap: number(&spin["gap"])?,
        };
        let accents = exports.colors["accents"]
            .as_object()
            .ok_or("missing accent palette")?
            .iter()
            .map(|(name, hex)| Ok((name.clone(), parse(hex.as_str().ok_or("accent colour")?)?)))
            .collect::<Result<_, String>>()?;
        let text = font_style(
            &appearance.font,
            appearance.text_scale,
            scss(statics, "lh-body")?,
        )?;
        Ok(Self {
            palette,
            metrics,
            choices,
            range,
            switch,
            accents,
            text,
        })
    }
}

/// A colour the export names: a `--nidara-*` token of the set, or a literal `#rrggbb` /
/// `rgba(…)` (a value the kit's sheet writes as one, like the checked switch's edge).
fn colour(tokens: &Tokens<'_>, name: &str) -> Result<Color, String> {
    if name.starts_with("--") {
        let v = tokens
            .colors
            .get(name)
            .ok_or_else(|| format!("missing {name}"))?;
        return parse(
            v.as_str()
                .ok_or_else(|| format!("{name} is not a colour"))?,
        );
    }
    parse(name)
}

/// `#rrggbb` or `rgba(r, g, b, a)` as the export writes them.
pub fn parse(text: &str) -> Result<Color, String> {
    if let Some(h) = text.strip_prefix('#')
        && h.len() == 6
    {
        let n = u32::from_str_radix(h, 16).map_err(|e| e.to_string())?;
        return Ok(rgba((n >> 16) as u8, (n >> 8) as u8, n as u8, 255));
    }
    if let Some(inner) = text.strip_prefix("rgba(").and_then(|s| s.strip_suffix(')')) {
        let v = inner
            .split(',')
            .map(|s| s.trim().parse::<f32>().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>, _>>()?;
        if v.len() == 4 && v.iter().all(|n| n.is_finite()) {
            return Ok(rgba(
                v[0] as u8,
                v[1] as u8,
                v[2] as u8,
                (v[3] * 255.).round() as u8,
            ));
        }
    }
    Err(format!("unsupported exported colour {text}"))
}

/// A components variant's D8 list data, checked: a width, inset, opacity or line out of range
/// is refused, not drawn.
fn list_tokens(variant: &Json) -> Result<&Json, String> {
    let list = &variant["list"];
    let width = number(&list["focus"]["width"])?;
    let inset = number(&list["highlight"]["inset"])?;
    let opacity = number(&list["highlight"]["hoverOpacity"])?;
    let line = number(&list["separator"]["physicalPixels"])?;
    if width <= 0.
        || inset < 0.
        || !(0. ..=1.).contains(&opacity)
        || line <= 0.
        || list["separator"]["color"].as_str().is_none()
    {
        return Err("invalid list tokens".into());
    }
    Ok(list)
}

fn number(v: &Json) -> Result<f32, String> {
    v.as_f64()
        .map(|n| n as f32)
        .ok_or_else(|| format!("missing exported number (found {v})"))
}

fn scss(statics: &Json, key: &str) -> Result<f32, String> {
    statics["scss"][key]
        .as_str()
        .and_then(|s| s.strip_suffix("px").or(Some(s)))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("missing scss token {key}"))
}

fn em(statics: &Json, key: &str) -> Result<f32, String> {
    statics["scss"][key]
        .as_str()
        .and_then(|s| s.strip_suffix("em"))
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("scss token {key} is not a relative size"))
}

/// A Pango description (`Family [Style] Size`, points) at a text scale, as pixels at 96 dpi.
pub fn font_style(
    description: &str,
    scale: f64,
    line_height: f32,
) -> Result<nk_text::TextStyle, String> {
    let (family, size) = description
        .rsplit_once(' ')
        .ok_or("the font needs a family and a point size")?;
    let size: f32 = size.parse().map_err(|e| format!("font size: {e}"))?;
    if !scale.is_finite() || scale <= 0. || !size.is_finite() || size <= 0. || family.is_empty() {
        return Err("invalid font or text scale".into());
    }
    let mut family = family.to_owned();
    let mut weight = 400.;
    for (suffix, value) in [
        (" Regular", 400.),
        (" Normal", 400.),
        (" SemiBold", 600.),
        (" Bold", 700.),
        (" Light", 300.),
    ] {
        if let Some(name) = family.strip_suffix(suffix) {
            family = name.into();
            weight = value;
            break;
        }
    }
    Ok(nk_text::TextStyle {
        family,
        size: size * (96. / 72.) * scale as f32,
        weight,
        line_height,
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fonts_are_points_and_the_scale_applies() {
        let style = font_style("Noto Sans Hebrew Bold 12", 1.5, 1.3).unwrap();
        assert_eq!(style.family, "Noto Sans Hebrew");
        assert_eq!(style.size, 24.);
        assert_eq!(style.weight, 700.);
        assert!(font_style("Noto Sans 12", f64::NAN, 1.3).is_err());
    }

    #[test]
    fn list_tokens_refuse_missing_or_invalid_fields() {
        let ok = serde_json::json!({"list": {
            "focus": {"width": 2}, "highlight": {"inset": 4, "hoverOpacity": 0.08},
            "separator": {"physicalPixels": 1, "color": "--nidara-border"}}});
        assert!(list_tokens(&ok).is_ok());
        let mut missing = ok.clone();
        missing["list"].as_object_mut().unwrap().remove("highlight");
        assert!(list_tokens(&missing).is_err());
        let mut invalid = ok.clone();
        invalid["list"]["highlight"]["hoverOpacity"] = serde_json::json!(1.5);
        assert!(list_tokens(&invalid).is_err());
    }

    #[test]
    fn colours_as_exported() {
        assert_eq!(parse("#0088FF").unwrap(), rgba(0, 136, 255, 255));
        assert_eq!(parse("rgba(0, 0, 0, 0.1)").unwrap(), rgba(0, 0, 0, 26));
        assert!(parse("blue").is_err());
    }

    /// Every combination the portal can say gives complete styles from the real export.
    #[test]
    fn every_set_gives_complete_styles() {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data");
        if !root.join("version").exists() && std::env::var_os("NK_REQUIRE_EXPORT").is_none() {
            eprintln!("skipped: no build/settings-data (set NK_REQUIRE_EXPORT to require it)");
            return;
        }
        let exports = Exports::load(&root).unwrap();
        for dark in [true, false] {
            for reduce in [true, false] {
                let a = Appearance {
                    accent: [0.0, 136.0 / 255.0, 1.0],
                    dark,
                    reduce_transparency: reduce,
                    window_background: "opaque".into(),
                    reduced_motion: false,
                    font: "Inter Variable 11".into(),
                    text_scale: 1.0,
                };
                let s = Styles::new(&exports, &a).unwrap();
                assert!(s.metrics.switch_width >= s.metrics.control);
                assert_eq!(s.accents.len(), 9);
            }
        }
    }
}
