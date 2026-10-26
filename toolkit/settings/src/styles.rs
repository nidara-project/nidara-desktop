// SPDX-License-Identifier: LGPL-3.0-or-later
//! The exported tokens as `nk-widgets`' styles: done here once, for the app and the widgets
//! demo alike (`CONTRACT.md` → "The native Settings"). Every number and colour comes from the
//! set the portal picked (`Exports::tokens`) or from `static.json`; a field missing is an error,
//! never a default.

use crate::exports::{Exports, Tokens};
use crate::portal::Appearance;
use nk_render::{Color, rgba};
use nk_widgets::{
    ChoiceStyle, DropdownStyle, MenuStyle, Metrics, Palette, RangeStyle, RowTextStyle, SearchStyle,
    SwitchStyle,
};
use serde_json::Value as Json;

pub struct Styles {
    /// Window capsule corner inset from components.json, independent of row spacing.
    pub controls_inset: f32,
    pub header: crate::header::Style,
    pub wallpaper: crate::wallpaper::Look,
    pub text_scale: f64,
    pub palette: Palette,
    pub metrics: Metrics,
    pub choices: ChoiceStyle,
    pub range: RangeStyle,
    pub switch: SwitchStyle,
    pub rows: RowTextStyle,
    pub dropdown: DropdownStyle,
    pub menu: MenuStyle,
    pub search: SearchStyle,
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
            titlebar: number(&c["header"]["band"])?,
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
        let rw = &c["rows"];
        let (sub, foot, disc) = (&rw["subtitle"], &rw["footer"], &rw["disclosure"]);
        let rows = RowTextStyle {
            subtitle_scale: em(statics, &field(&sub["fontSize"], "subtitle font size")?)?,
            subtitle: token(&field(&sub["color"], "subtitle colour")?)?,
            footer_scale: em(statics, &field(&foot["fontSize"], "footer font size")?)?,
            footer: token(&field(&foot["color"], "footer colour")?)?,
            footer_gap: number(&foot["gap"])?,
            disclosure_icon_size: number(&disc["iconSize"])?,
            disclosure_open: field(&disc["open"], "disclosure open icon")?,
            disclosure_closed: field(&disc["closed"], "disclosure closed icon")?,
        };
        let d = &c["dropdown"]["trigger"];
        let dropdown = DropdownStyle {
            padding_x: number(&d["paddingX"])?,
            padding_y: number(&d["paddingY"])?,
            border: number(&d["border"])?,
            min_content_height: number(&d["minContentHeight"])?,
            radius: number(&statics["ts"]["RADIUS"][field(&d["radius"], "dropdown radius")?])?,
            text_scale: em(statics, &field(&d["fontSize"], "dropdown font size")?)?,
            weight: scss(statics, &field(&d["fontWeight"], "dropdown weight")?)?,
            label_margin: scss(statics, &field(&d["labelMargin"], "dropdown label margin")?)?,
            arrow_size: number(&d["arrowSize"])?,
            arrow_gap: number(&d["arrowGap"])?,
            arrow: field(&d["arrow"], "dropdown arrow")?,
            background: token(&field(&d["background"], "dropdown background")?)?,
            hover: token(&field(&d["hover"], "dropdown hover")?)?,
            pressed: token(&field(&d["pressed"], "dropdown pressed")?)?,
            text: token(&field(&d["text"], "dropdown text")?)?,
            arrow_color: token(&field(&d["arrowColor"], "dropdown arrow colour")?)?,
            focus: token(&field(&d["focus"], "dropdown focus")?)?,
            disabled_opacity: number(&d["disabledOpacity"])?,
        };
        let m = &c["dropdown"]["menu"];
        let menu = MenuStyle {
            border: number(&m["border"])?,
            radius: number(&statics["ts"]["RADIUS"][field(&m["radius"], "menu radius")?])?,
            inset: number(&m["inset"])?,
            padding_x: number(&m["paddingX"])?,
            padding_y: number(&m["paddingY"])?,
            row_radius: number(
                &statics["ts"]["RADIUS"][field(&m["rowRadius"], "menu row radius")?],
            )?,
            text_scale: em(statics, &field(&m["fontSize"], "menu font")?)?,
            weight: scss(statics, &field(&m["fontWeight"], "menu font weight")?)?,
            check_size: number(&m["checkSize"])?,
            check_gap: number(&m["checkGap"])?,
            check_stroke: number(&m["checkStroke"])?,
            background: token(&field(&m["background"], "menu background")?)?,
            border_color: token(&field(&m["borderColor"], "menu border")?)?,
            text: token(&field(&m["text"], "menu text")?)?,
            accent: token(&field(&m["accent"], "menu accent")?)?,
            accent_text: token(&field(&m["accentText"], "menu accent ink")?)?,
            pressed_black: number(&m["pressedBlack"])?,
        };
        let q = &c["search"];
        let search = SearchStyle {
            padding_x: number(&q["paddingX"])?,
            border: number(&q["border"])?,
            min_height: number(&q["minHeight"])?,
            radius: tokens
                .colors
                .get(&field(&q["radius"], "search radius")?)
                .and_then(Json::as_str)
                .and_then(|v| v.strip_suffix("px"))
                .ok_or("missing search radius dimension")?
                .parse::<f32>()
                .map_err(|e| e.to_string())?,
            icon_size: number(&q["iconSize"])?,
            icon_gap: number(&q["iconGap"])?,
            icon: field(&q["icon"], "search icon")?,
            background: token(&field(&q["background"], "search background")?)?,
            border_color: token(&field(&q["borderColor"], "search border")?)?,
            focus_border: token(&field(&q["focusBorder"], "search focus border")?)?,
            text: token(&field(&q["text"], "search text")?)?,
            dim: token(&field(&q["dim"], "search dim")?)?,
            selection: token(&field(&q["selection"], "search selection")?)?,
            selection_text: token(&field(&q["selectionText"], "search selection text")?)?,
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
        let wallpaper = crate::wallpaper::Look::load(exports, &tokens)?;
        Ok(Self {
            controls_inset: number(&c["capsule"]["windowInset"])?,
            header: crate::header::Style::load(&c["header"], &exports.glass, appearance)?,
            wallpaper,
            text_scale: appearance.text_scale,
            palette,
            metrics,
            choices,
            range,
            switch,
            rows,
            dropdown,
            menu,
            search,
            accents,
            text,
        })
    }
}

impl Styles {
    /// Every style a tree draws with, at once (a tree built from these metrics and text).
    pub fn apply(&self, tree: &mut nk_widgets::Tree) -> Result<(), String> {
        tree.set_choice_style(self.choices)?;
        tree.set_range_style(self.range)?;
        tree.set_switch_style(self.switch)?;
        tree.set_row_text_style(self.rows.clone())?;
        tree.set_dropdown_style(self.dropdown.clone())?;
        tree.set_search_style(self.search.clone())?;
        tree.set_text_style(self.text.clone());
        Ok(())
    }
}

/// A colour the export names: a `--nidara-*` token of the set, or a literal `#rrggbb` /
/// `rgba(…)` (a value the kit's sheet writes as one, like the checked switch's edge).
pub(crate) fn colour(tokens: &Tokens<'_>, name: &str) -> Result<Color, String> {
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

pub(crate) fn number(v: &Json) -> Result<f32, String> {
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
    let font = crate::font_description::Description::parse(description)?;
    font.attributes
        .text_style(&font.family, font.points, scale, line_height)
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
        let root = std::env::var_os("NK_SETTINGS_DATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
            });
        if !root.join("version").exists() && std::env::var_os("NK_REQUIRE_EXPORT").is_none() {
            eprintln!("skipped: no build/settings-data (set NK_REQUIRE_EXPORT to require it)");
            return;
        }
        let mut exports = Exports::load(&root).unwrap();
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
                assert_eq!(s.dropdown.border, 2.);
                assert_eq!(s.dropdown.arrow, "nd-pan-down");
                nk_widgets::Tree::menu_list(
                    "Menu",
                    s.metrics,
                    s.text.clone(),
                    s.menu.clone(),
                    &["one"],
                    0,
                )
                .unwrap();
                let mut tree = nk_widgets::Tree::new("Styles", s.metrics, s.text.clone()).unwrap();
                s.apply(&mut tree).unwrap();
            }
        }
        for variant in exports.components["variants"].as_array_mut().unwrap() {
            variant["dropdown"]["trigger"]
                .as_object_mut()
                .unwrap()
                .remove("arrow");
        }
        let a = Appearance {
            accent: [0., 136. / 255., 1.],
            dark: true,
            reduce_transparency: false,
            window_background: "opaque".into(),
            reduced_motion: false,
            font: "Inter Variable 11".into(),
            text_scale: 1.,
        };
        assert!(
            Styles::new(&exports, &a)
                .err()
                .unwrap()
                .contains("dropdown arrow")
        );
        let mut missing = Exports::load(&root).unwrap();
        for variant in missing.components["variants"].as_array_mut().unwrap() {
            variant["search"].as_object_mut().unwrap().remove("icon");
        }
        assert!(
            Styles::new(&missing, &a)
                .err()
                .unwrap()
                .contains("search icon")
        );
    }
}
