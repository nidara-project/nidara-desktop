// SPDX-License-Identifier: LGPL-3.0-or-later
//! The installed glass export, selected with the portal and each pane's real size.
use nk_wayland::{Glass, Material, Shadow, Tone};
use nk_widgets::Result;
use serde_json::Value;

pub struct PanelMaterial {
    steps: Vec<(f64, Material)>,
}

fn number(v: &Value, key: &str) -> Result<f64> {
    v[key]
        .as_f64()
        .filter(|n| n.is_finite())
        .ok_or_else(|| format!("glass export: missing or invalid {key}"))
}
fn tone(v: &Value) -> Result<Tone> {
    Ok(Tone {
        saturation: number(v, "saturation")?,
        ceiling: number(v, "ceiling")?,
        lift: number(v, "lift")?,
        gain: number(v, "gain")?,
        wash: [
            number(&v["wash"], "r")?,
            number(&v["wash"], "g")?,
            number(&v["wash"], "b")?,
            number(&v["wash"], "a")?,
        ],
        ambient: number(v, "ambient")?,
        ambient_lift: number(v, "ambientLift")?,
        ambient_gain: number(v, "ambientGain")?,
    })
}
impl PanelMaterial {
    pub fn load(export: Value, dark: bool, reduce: bool) -> Result<Self> {
        let variant = export["variants"]
            .as_array()
            .ok_or("glass export: missing variants")?
            .iter()
            .find(|v| v["dark"] == dark && v["reduceTransparency"] == reduce)
            .ok_or("glass export: portal combination missing")?;
        let g = &variant["glass"];
        let glass = Glass {
            refraction: number(g, "refraction")?,
            lensing: number(g, "lensing")?,
            rim: number(g, "rim")?,
        };
        let mut steps = Vec::new();
        for step in variant["pieces"]["panel"]
            .as_array()
            .ok_or("glass export: missing pieces.panel")?
        {
            let side = number(step, "fromSide")?;
            if side < 0. || steps.last().is_some_and(|(last, _)| side <= *last) {
                return Err("glass export: panel steps must increase".into());
            }
            let s = &step["shadow"];
            steps.push((
                side,
                Material {
                    glass,
                    tone: tone(&step["tone"])?,
                    shadow: Shadow {
                        opacity_small: number(s, "opacitySmall")?,
                        opacity_large: number(s, "opacityLarge")?,
                        blur_small: number(s, "blurSmall")?,
                        blur_large: number(s, "blurLarge")?,
                        offset: number(s, "offset")?,
                    },
                    shapes: vec![],
                },
            ));
        }
        if steps.first().is_none_or(|(side, _)| *side != 0.) {
            return Err("glass export: panel steps must start at zero".into());
        }
        Ok(Self { steps })
    }
    pub fn at(&self, short_side: f64) -> Result<Material> {
        if !short_side.is_finite() || short_side < 0. {
            return Err("invalid panel side".into());
        }
        // Match the exporting material source's integer-side selection.
        let side = short_side.round();
        let material = self
            .steps
            .iter()
            .rev()
            .find(|(from, _)| *from <= side)
            .ok_or("glass export: no panel step")?
            .1
            .clone();
        Ok(material)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn exported() -> Value {
        // Real #881 export; other pieces removed, all panel steps/variants retained.
        serde_json::from_str(include_str!("../fixtures/glass.json")).unwrap()
    }
    #[test]
    fn real_export_selects_all_portal_variants_and_pane_sizes() {
        for dark in [false, true] {
            for reduce in [false, true] {
                let panel = PanelMaterial::load(exported(), dark, reduce).unwrap();
                let title = panel.at(48.).unwrap();
                let sidebar = panel.at(250.).unwrap();
                assert_eq!(title.glass.refraction, if reduce { 0. } else { 40. });
                assert_eq!(
                    title.tone.wash[3],
                    if reduce {
                        1.
                    } else if dark {
                        0.
                    } else {
                        0.2
                    }
                );
                assert_eq!(title.shadow.opacity_large, if dark { 0.175 } else { 0.115 });
                if dark && !reduce {
                    assert_eq!(title.tone.ceiling, 0.6);
                    assert_eq!(sidebar.tone.ceiling, 0.35);
                    assert_eq!(panel.at(64.49).unwrap().tone.ceiling, 0.6);
                    assert!(panel.at(64.5).unwrap().tone.ceiling < 0.6);
                    assert_eq!(panel.at(104.).unwrap().tone.ceiling, 0.35);
                }
                assert!(panel.at(f64::NAN).is_err());
            }
        }
    }
    #[test]
    fn missing_variant_malformed_material_and_stub_fail_explicitly() {
        let mut data = exported();
        data["variants"]
            .as_array_mut()
            .unwrap()
            .retain(|v| v["dark"] == false);
        assert!(
            PanelMaterial::load(data, true, false)
                .err()
                .unwrap()
                .contains("combination")
        );
        let mut data = exported();
        data["variants"][0]["pieces"]["panel"][0]["tone"]["wash"] = serde_json::json!([0, 0, 0, 0]);
        assert!(PanelMaterial::load(data, true, false).is_err());
        assert!(PanelMaterial::load(serde_json::json!({"TONES":{}}), true, false).is_err());
    }
}
