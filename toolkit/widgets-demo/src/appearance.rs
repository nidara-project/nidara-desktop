// SPDX-License-Identifier: LGPL-3.0-or-later
//! Demo data is fixed; appearance is selected from the Settings portal, never Config1.
use nk_render::{Color, rgba};
use nk_wayland::{Glass, Material, Shadow, Tone};
use nk_widgets::{Metrics, Palette, Result};
use serde_json::Value;
use std::{collections::HashMap, path::Path, sync::mpsc};
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::OwnedValue,
};
type Settings = HashMap<String, HashMap<String, OwnedValue>>;
pub struct Appearance {
    pub palette: Palette,
    pub metrics: Metrics,
    pub panel: Material,
    pub style: nk_text::TextStyle,
    pub size: (u32, u32),
    pub reduce_motion: bool,
}
fn read(path: impl AsRef<Path>) -> Result<Value> {
    serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())
}
fn number(v: &Value) -> Result<f32> {
    v.as_f64()
        .map(|n| n as f32)
        .ok_or_else(|| "missing exported number".into())
}
fn scss(v: &Value) -> Result<f32> {
    v.as_str()
        .ok_or("missing SCSS token")?
        .trim_end_matches("px")
        .parse()
        .map_err(|e| format!("SCSS number: {e}"))
}
fn color(text: &str) -> Result<Color> {
    if let Some(hex) = text.strip_prefix('#')
        && hex.len() == 6
    {
        let n = u32::from_str_radix(hex, 16).map_err(|e| e.to_string())?;
        return Ok(rgba((n >> 16) as u8, (n >> 8) as u8, n as u8, 255));
    }
    if let Some(text) = text.strip_prefix("rgba(").and_then(|s| s.strip_suffix(')')) {
        let values = text
            .split(',')
            .map(|s| s.trim().parse::<f32>().map_err(|e| e.to_string()))
            .collect::<Result<Vec<_>>>()?;
        if values.len() == 4 && values.iter().all(|v| v.is_finite()) {
            return Ok(rgba(
                values[0] as u8,
                values[1] as u8,
                values[2] as u8,
                (values[3] * 255.).round() as u8,
            ));
        }
    }
    Err(format!("unsupported exported colour {text}"))
}
impl Appearance {
    fn load(root: &Path, settings: &Settings) -> Result<Self> {
        if std::fs::read_to_string(root.join("version"))
            .map_err(|e| e.to_string())?
            .trim()
            != "1"
        {
            return Err("unsupported settings-data version".into());
        }
        let colors = read(root.join("tokens/colors.json"))?;
        let sizes = read(root.join("tokens/static.json"))?;
        let get = |ns: &str, key: &str| {
            settings
                .get(ns)
                .and_then(|m| m.get(key))
                .ok_or_else(|| format!("portal missing {ns}.{key}"))
        };
        let scheme = u32::try_from(get("org.freedesktop.appearance", "color-scheme")?)
            .map_err(|e| e.to_string())?;
        if !matches!(scheme, 1 | 2) {
            return Err(format!("unknown portal colour scheme {scheme}"));
        }
        let accent = <(f64, f64, f64)>::try_from(
            get("org.freedesktop.appearance", "accent-color")?
                .try_clone()
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let reduce_motion = u32::try_from(get("org.freedesktop.appearance", "reduced-motion")?)
            .map_err(|e| e.to_string())?
            == 1;
        let reduce = bool::try_from(get("org.nidara.appearance", "reduce-transparency")?)
            .map_err(|e| e.to_string())?;
        let level = <&str>::try_from(get("org.nidara.appearance", "window-background")?)
            .map_err(|e| e.to_string())?;
        let target = rgba(
            (accent.0 * 255.).round() as u8,
            (accent.1 * 255.).round() as u8,
            (accent.2 * 255.).round() as u8,
            255,
        );
        let set = colors["sets"]
            .as_array()
            .ok_or("missing colour sets")?
            .iter()
            .find(|s| {
                s["dark"] == (scheme == 1)
                    && s["reduceTransparency"] == reduce
                    && s["windowBackground"] == level
                    && s["tokens"]["--nidara-accent"]
                        .as_str()
                        .and_then(|s| color(s).ok())
                        == Some(target)
            })
            .ok_or("portal combination missing from tokens export")?;
        let token = |key: &str| {
            color(
                set["tokens"][key]
                    .as_str()
                    .ok_or_else(|| format!("missing {key}"))?,
            )
        };
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
        };
        // These two switch measurements are absent from #856's export. Named stub
        // from _components.scss until Claude exports them with the panel material.
        let stub: Value =
            serde_json::from_str(include_str!("../panel-stub.json")).map_err(|e| e.to_string())?;
        let glass=read(root.join("tokens/glass.json")).or_else(|e| {
            if root.join("tokens/glass.json").exists() { Err(e) } else {
                eprintln!("PANEL_MATERIAL_STUB source=ui/lib/nidara-kit/platform/glass-material.ts piece=panel"); Ok(stub.clone())
            }
        })?;
        let face = if scheme == 1 { "dark" } else { "light" };
        let tone = &glass["TONES"]["panel"][face];
        let shadow = &glass["SHADOWS"]["panel"][face];
        let val = |v: &Value| -> Result<f64> {
            v.as_f64()
                .ok_or_else(|| "missing panel material field".into())
        };
        let mut panel = Material {
            glass: Glass {
                refraction: val(&glass["DEFAULTS"]["refraction"])?,
                rim: val(&glass["DEFAULTS"]["rim"])?,
                lensing: val(&glass["DEFAULTS"]["lensing"])?,
            },
            tone: Tone {
                saturation: val(&tone["saturation"])?,
                ceiling: val(&tone["ceiling"])?,
                lift: val(&tone["lift"])?,
                gain: val(&tone["gain"])?,
                wash: [
                    val(&tone["wash"][0])?,
                    val(&tone["wash"][1])?,
                    val(&tone["wash"][2])?,
                    val(&tone["wash"][3])?,
                ],
                ambient: val(&tone["ambient"])?,
                ambient_lift: val(&tone["ambientLift"])?,
                ambient_gain: val(&tone["ambientGain"])?,
            },
            shadow: Shadow {
                opacity_small: val(&shadow["opacitySmall"])?,
                opacity_large: val(&shadow["opacityLarge"])?,
                blur_small: val(&shadow["blurSmall"])?,
                blur_large: val(&shadow["blurLarge"])?,
                offset: val(&shadow["offset"])?,
            },
            shapes: vec![],
        };
        if reduce {
            let bg = palette.background.components;
            panel.tone = Tone {
                saturation: 1.,
                ceiling: 1.,
                lift: 0.,
                gain: 1.,
                wash: [bg[0] as f64, bg[1] as f64, bg[2] as f64, 1.],
                ambient: 0.,
                ambient_lift: 0.,
                ambient_gain: 1.,
            };
        }
        let metrics = Metrics {
            sidebar: number(&sizes["ts"]["WINDOW_LAYOUT"]["sidebar"])?,
            content: number(&sizes["ts"]["WINDOW_LAYOUT"]["content"])?,
            titlebar: scss(&sizes["scss"]["space-10"])? + scss(&sizes["scss"]["space-2"])?,
            padding: scss(&sizes["scss"]["space-3"])?,
            gap: scss(&sizes["scss"]["space-1"])?,
            row: number(&sizes["ts"]["ROW_HEIGHT"]["single"])?,
            control: number(&stub["SWITCH"]["minHeight"])?,
            switch_width: number(&stub["SWITCH"]["minWidth"])?,
            radius: number(&sizes["ts"]["RADIUS"]["sm"])?,
            group_radius: number(&sizes["ts"]["RADIUS"]["md"])?,
        };
        let description = <&str>::try_from(get("org.gnome.desktop.interface", "font-name")?)
            .map_err(|e| e.to_string())?;
        let scale = f64::try_from(get("org.gnome.desktop.interface", "text-scaling-factor")?)
            .map_err(|e| e.to_string())?;
        let style = font_style(description, scale, scss(&sizes["scss"]["lh-body"])?)?;
        let size = (
            (metrics.sidebar + number(&sizes["ts"]["WINDOW_LAYOUT"]["content"])?) as u32,
            number(&sizes["ts"]["WINDOW_LAYOUT"]["minHeight"])? as u32,
        );
        Ok(Self {
            palette,
            metrics,
            panel,
            style,
            size,
            reduce_motion,
        })
    }
}
/// Subscribe before ReadAll; each change takes one coherent portal snapshot.
pub fn watch(root: std::path::PathBuf) -> mpsc::Receiver<Result<Appearance>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let run = || -> Result<()> {
            let bus = Connection::session().map_err(|e| e.to_string())?;
            let proxy = Proxy::new(
                &bus,
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.Settings",
            )
            .map_err(|e| e.to_string())?;
            let changed = proxy
                .receive_signal("SettingChanged")
                .map_err(|e| e.to_string())?;
            let capture = || -> Result<()> {
                let settings: Settings = proxy
                    .call(
                        "ReadAll",
                        &(vec![
                            "org.freedesktop.appearance",
                            "org.nidara.appearance",
                            "org.gnome.desktop.interface",
                        ],),
                    )
                    .map_err(|e| e.to_string())?;
                tx.send(Appearance::load(&root, &settings))
                    .map_err(|e| e.to_string())
            };
            capture()?;
            for _ in changed {
                capture()?;
            }
            Ok(())
        };
        if let Err(e) = run() {
            let _ = tx.send(Err(e));
        }
    });
    rx
}

fn font_style(description: &str, scale: f64, line_height: f32) -> Result<nk_text::TextStyle> {
    let (family, size) = description
        .rsplit_once(' ')
        .ok_or("portal font needs family and point size")?;
    let size: f32 = size.parse().map_err(|e| format!("portal font size: {e}"))?;
    if !scale.is_finite() || scale <= 0. || !size.is_finite() || size <= 0. || family.is_empty() {
        return Err("invalid portal font or text scale".into());
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
    fn portal_fonts_are_points_and_scale_is_live_input() {
        let style = font_style("Noto Sans Hebrew Bold 12", 1.5, 1.3).unwrap();
        assert_eq!(style.family, "Noto Sans Hebrew");
        assert_eq!(style.size, 24.);
        assert_eq!(style.weight, 700.);
        assert!(font_style("Noto Sans 12", f64::NAN, 1.3).is_err());
    }
}
