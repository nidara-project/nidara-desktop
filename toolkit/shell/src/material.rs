// SPDX-License-Identifier: LGPL-3.0-or-later
//! The dock's glass, as the exported tokens give it (DOCK.md §5): `tokens/glass.json`, the
//! kit's own material for the `dock` piece, by mode and reduce transparency, stepped by the
//! pane's short side. Hyalo paints it; the dock only declares it (commandment 12).
use nk_wayland::{Glass, Material, Pane, Shadow, Tone};
use serde_json::Value;
use std::path::PathBuf;

/// Where the exports are: the variable a checkout run sets, else the installed copy.
pub fn exports_root() -> PathBuf {
    std::env::var_os("NK_SETTINGS_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/usr/share/nidara/settings-data"))
}

pub fn load() -> Result<Value, String> {
    let path = exports_root().join("tokens/glass.json");
    let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
}

fn tone(t: &Value) -> Option<Tone> {
    let n = |k: &str| t[k].as_f64();
    let w = &t["wash"];
    Some(Tone {
        saturation: n("saturation")?,
        ceiling: n("ceiling")?,
        lift: n("lift")?,
        gain: n("gain")?,
        wash: [
            w["r"].as_f64()?,
            w["g"].as_f64()?,
            w["b"].as_f64()?,
            w["a"].as_f64()?,
        ],
        ambient: n("ambient")?,
        ambient_lift: n("ambientLift")?,
        ambient_gain: n("ambientGain")?,
    })
}

fn shadow(s: &Value) -> Shadow {
    let n = |k: &str| s[k].as_f64().unwrap_or(0.);
    Shadow {
        opacity_small: n("opacitySmall"),
        opacity_large: n("opacityLarge"),
        blur_small: n("blurSmall"),
        blur_large: n("blurLarge"),
        offset: n("offset"),
    }
}

/// The dock's material for one capsule; None when the tokens lack it (then nothing is
/// declared and Hyalo draws no glass, which the check notices).
pub fn dock(
    tokens: &Value,
    dark: bool,
    reduce_transparency: bool,
    capsule: Pane,
) -> Option<Material> {
    let variant = tokens["variants"].as_array()?.iter().find(|v| {
        v["dark"].as_bool() == Some(dark)
            && v["reduceTransparency"].as_bool() == Some(reduce_transparency)
    })?;
    let side = capsule.width.min(capsule.height);
    let step = variant["pieces"]["dock"]
        .as_array()?
        .iter()
        .filter(|s| s["fromSide"].as_f64().is_some_and(|f| f <= side))
        .max_by(|a, b| {
            a["fromSide"]
                .as_f64()
                .partial_cmp(&b["fromSide"].as_f64())
                .unwrap()
        })?;
    let g = &variant["glass"];
    Some(Material {
        glass: Glass {
            refraction: g["refraction"].as_f64()?,
            rim: g["rim"].as_f64()?,
            lensing: g["lensing"].as_f64()?,
        },
        tone: tone(&step["tone"])?,
        shadow: shadow(&step["shadow"]),
        shapes: vec![capsule],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn step(from: f64, saturation: f64) -> Value {
        let t = json!({"saturation": saturation, "ceiling": 1, "lift": 0, "gain": 1,
            "wash": {"r": 0, "g": 0, "b": 0, "a": 0}, "ambient": 0, "ambientLift": 0, "ambientGain": 1});
        json!({"fromSide": from, "tone": t, "inkTone": t, "shadow": null})
    }
    #[test]
    fn the_step_for_the_short_side_of_the_right_variant() {
        let tokens = json!({"variants": [
            {"dark": true, "reduceTransparency": false, "glass": {"refraction": 40, "lensing": 0.15, "rim": 0.5},
             "pieces": {"dock": [step(0., 1.1), step(80., 1.3)]}},
            {"dark": false, "reduceTransparency": false, "glass": {"refraction": 40, "lensing": 0.15, "rim": 0.5},
             "pieces": {"dock": [step(0., 0.9)]}}
        ]});
        let pane = |h: f64| Pane {
            x: 0.,
            y: 0.,
            width: 400.,
            height: h,
            radius: h / 2.,
            exponent: 3.2,
        };
        let m = dock(&tokens, true, false, pane(92.)).unwrap();
        assert_eq!(
            (m.tone.saturation, m.glass.refraction, m.shapes.len()),
            (1.3, 40., 1)
        );
        assert_eq!(
            dock(&tokens, true, false, pane(40.))
                .unwrap()
                .tone
                .saturation,
            1.1
        );
        assert_eq!(
            dock(&tokens, false, false, pane(92.))
                .unwrap()
                .tone
                .saturation,
            0.9
        );
        assert!(dock(&tokens, false, true, pane(92.)).is_none());
    }
}
