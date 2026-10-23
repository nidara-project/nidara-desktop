// SPDX-License-Identifier: LGPL-3.0-or-later
//! Exact installed control material and state recipe; no numeric design defaults.
use crate::panel::{number, tone};
use nk_wayland::{Blur, ControlMaterial, Glass, Material, Pane, Response, Shadow};
use nk_widgets::{CapsuleMetrics, Result};
use serde_json::Value;

#[derive(Clone, Copy, Debug)]
pub struct StateStyle {
    pub wash: [f64; 4],
    pub ink: Option<[f64; 4]>,
}
#[derive(Clone, Debug)]
pub struct ControlStyle {
    pub material: ControlMaterial,
    pub hover: StateStyle,
    pub press: StateStyle,
    pub destructive_hover: StateStyle,
    pub destructive_press: StateStyle,
    pub fade_ms: u32,
}
pub struct ControlRecipe {
    steps: Vec<(f64, ControlStyle)>,
}
fn duration(v: &Value, key: &str) -> Result<u32> {
    v[key]
        .as_u64()
        .and_then(|n| u32::try_from(n).ok())
        .ok_or_else(|| format!("control export: invalid {key}"))
}
fn rgba(v: &Value) -> Result<[f64; 4]> {
    let rgba = [
        number(v, "r")?,
        number(v, "g")?,
        number(v, "b")?,
        number(v, "a")?,
    ];
    if !rgba.iter().all(|v| (0. ..=1.).contains(v)) {
        return Err("control export: invalid RGBA".into());
    }
    Ok(rgba)
}
fn state(v: &Value) -> Result<StateStyle> {
    Ok(StateStyle {
        wash: rgba(&v["wash"])?,
        ink: v
            .get("ink")
            .filter(|v| !v.is_null())
            .map(rgba)
            .transpose()?,
    })
}
impl ControlRecipe {
    pub fn load(export: &Value, dark: bool, reduce: bool) -> Result<Self> {
        let variants = export["variants"]
            .as_array()
            .ok_or("control export: missing variants")?;
        let mut matches = variants
            .iter()
            .filter(|v| v["dark"] == dark && v["reduceTransparency"] == reduce);
        let variant = matches
            .next()
            .ok_or("control export: portal combination missing")?;
        if matches.next().is_some() {
            return Err("control export: duplicate portal combination".into());
        }
        let glass = Glass {
            refraction: number(&variant["glass"], "refraction")?,
            lensing: number(&variant["glass"], "lensing")?,
            rim: number(&variant["glass"], "rim")?,
        };
        let blur = Blur {
            size: number(&export["blur"]["panel"], "size")?,
            passes: if reduce {
                0
            } else {
                duration(&export["blur"]["panel"], "passes")?
            },
        };
        let mut steps = Vec::new();
        for step in variant["pieces"]["control"]
            .as_array()
            .ok_or("control export: missing pieces.control")?
        {
            let side = number(step, "fromSide")?;
            if side < 0. || steps.last().is_some_and(|(last, _)| side <= *last) {
                return Err("control export: steps must increase".into());
            }
            let r = step
                .get("response")
                .ok_or("control export: missing response")?;
            if reduce != r.is_null() {
                return Err("control export: response does not match transparency mode".into());
            }
            let response = if r.is_null() {
                None
            } else {
                Some(Response {
                    luma_low: number(r, "lumaLow")?,
                    luma_high: number(r, "lumaHigh")?,
                    contrast_low: number(r, "contrastLow")?,
                    contrast_high: number(r, "contrastHigh")?,
                    shadow_white: number(r, "shadowWhite")?,
                    shadow_text: number(r, "shadowText")?,
                    settle_ms: duration(r, "settleMs")?,
                })
            };
            let s = &step["shadow"];
            let material = ControlMaterial {
                base: Material {
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
                blur,
                // Exported null means no alternate tone, as in Hyalo's Shape.
                ink_tone: match step
                    .get("inkTone")
                    .ok_or("control export: missing inkTone")?
                {
                    Value::Null => tone(&step["tone"])?,
                    value => tone(value)?,
                },
                response,
                light_ink: rgba(&step["ink"]["light"])?,
                dark_ink: rgba(&step["ink"]["dark"])?,
                states: vec![],
                coverage: vec![],
            };
            let states = &step["states"];
            let style = ControlStyle {
                material,
                hover: state(&states["hover"])?,
                press: state(&states["press"])?,
                destructive_hover: state(&states["destructiveHover"])?,
                destructive_press: state(&states["destructivePress"])?,
                fade_ms: duration(states, "fadeMs")?,
            };
            // Exercise the same wire validation before accepting any installed step.
            style.for_pane(
                Pane {
                    x: 0.,
                    y: 0.,
                    width: 1.,
                    height: 1.,
                    radius: 0.,
                    exponent: 2.,
                },
                false,
            )?;
            steps.push((side, style));
        }
        if steps.first().is_none_or(|(side, _)| *side != 0.) {
            return Err("control export: steps must start at zero".into());
        }
        Ok(Self { steps })
    }
    pub fn at(&self, short_side: f64) -> Result<ControlStyle> {
        if !short_side.is_finite() || short_side <= 0. {
            return Err("invalid control side".into());
        }
        self.steps
            .iter()
            .rev()
            .find(|(from, _)| *from <= short_side.round())
            .map(|(_, style)| style.clone())
            .ok_or_else(|| "control export: no size step".into())
    }
}
impl ControlStyle {
    pub fn for_pane(&self, pane: Pane, reduce_motion: bool) -> Result<ControlMaterial> {
        let mut material = self.material.clone();
        material.base.shapes = vec![pane];
        if reduce_motion && let Some(response) = &mut material.response {
            response.settle_ms = 0;
        }
        material.validate()?;
        Ok(material)
    }
    pub fn fade_ms(&self, reduce_motion: bool) -> u32 {
        if reduce_motion { 0 } else { self.fade_ms }
    }
}
/// Geometry belongs to components.json, independently of the glass material.
pub fn capsule_metrics(export: &Value, dark: bool, reduce: bool) -> Result<CapsuleMetrics> {
    let mut variants = export["variants"]
        .as_array()
        .ok_or("missing component variants")?
        .iter()
        .filter(|v| v["dark"] == dark && v["reduceTransparency"] == reduce);
    let v = &variants.next().ok_or("missing capsule variant")?["capsule"];
    if variants.next().is_some() {
        return Err("duplicate capsule variant".into());
    }
    let height = number(v, "height")?;
    let button = number(v, "button")?;
    let edge = number(v, "edge")?;
    if height <= 0.
        || button <= 0.
        || edge < 0.
        || height < button + 2. * edge
        || [height, button, edge].iter().any(|v| *v > f32::MAX as f64)
    {
        return Err("invalid installed capsule geometry".into());
    }
    Ok(CapsuleMetrics {
        padding: edge as f32,
        gap: edge as f32,
        button_min: button as f32,
        height_min: height as f32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn exported() -> Value {
        // Real export from this branch; all control steps and portal variants retained.
        serde_json::from_str(include_str!("../fixtures/control-glass.json")).unwrap()
    }
    #[test]
    fn exported_control_modes_sizes_states_and_accessibility_are_exact() {
        let export = exported();
        for dark in [false, true] {
            for reduce in [false, true] {
                let recipe = ControlRecipe::load(&export, dark, reduce).unwrap();
                let style = recipe.at(32.).unwrap();
                assert_eq!(style.material.response.is_none(), reduce);
                if !dark {
                    assert_eq!(
                        style.material.ink_tone.ceiling,
                        style.material.base.tone.ceiling
                    );
                }
                assert_eq!(style.material.blur.passes, if reduce { 0 } else { 2 });
                assert_eq!(style.hover.wash[3], if dark { 0.08 } else { 0.06 });
                assert_eq!(style.press.wash[3], if dark { 0.20 } else { 0.14 });
                assert_eq!(style.destructive_hover.wash, [0.82, 0.20, 0.22, 0.9]);
                assert_eq!(style.destructive_press.ink, Some([1., 1., 1., 1.]));
                assert_eq!(style.fade_ms(false), 150);
                assert_eq!(style.fade_ms(true), 0);
                let pane = Pane {
                    x: 0.,
                    y: 0.,
                    width: 91.,
                    height: 35.,
                    radius: 17.5,
                    exponent: 2.,
                };
                let material = style.for_pane(pane, true).unwrap();
                if let Some(r) = material.response {
                    assert_eq!(r.settle_ms, 0);
                }
                assert!(material.states.is_empty() && material.coverage.is_empty());
                for step in &recipe.steps {
                    let selected = recipe.at(step.0.max(1.)).unwrap();
                    assert_eq!(
                        selected.material.base.tone.ceiling,
                        step.1.material.base.tone.ceiling
                    );
                    if step.0 > 1. {
                        assert_eq!(
                            recipe.at(step.0 - 0.49).unwrap().material.base.tone.ceiling,
                            step.1.material.base.tone.ceiling
                        );
                        let previous = recipe
                            .steps
                            .iter()
                            .rev()
                            .find(|(from, _)| *from < step.0)
                            .unwrap();
                        assert_eq!(
                            recipe.at(step.0 - 0.51).unwrap().material.base.tone.ceiling,
                            previous.1.material.base.tone.ceiling
                        );
                    }
                }
                assert!(recipe.at(f64::NAN).is_err());
                assert!(recipe.at(0.).is_err());
            }
        }
    }
    #[test]
    fn generated_exports_supply_every_portal_mode_without_defaults() {
        let Some(root) = std::env::var_os("NK_SETTINGS_DATA") else {
            assert!(
                std::env::var_os("NK_REQUIRE_EXPORT").is_none(),
                "exports required"
            );
            return;
        };
        let tokens = std::path::PathBuf::from(root).join("tokens");
        let glass: Value =
            serde_json::from_slice(&std::fs::read(tokens.join("glass.json")).unwrap()).unwrap();
        let components: Value =
            serde_json::from_slice(&std::fs::read(tokens.join("components.json")).unwrap())
                .unwrap();
        for dark in [false, true] {
            for reduce in [false, true] {
                let recipe = ControlRecipe::load(&glass, dark, reduce).unwrap();
                let metrics = capsule_metrics(&components, dark, reduce).unwrap();
                assert!(metrics.height_min >= metrics.button_min + 2. * metrics.padding);
                for step in &recipe.steps {
                    recipe
                        .at(step.0.max(1.))
                        .unwrap()
                        .for_pane(
                            Pane {
                                x: 0.,
                                y: 0.,
                                width: 91.,
                                height: 35.,
                                radius: 17.5,
                                exponent: 2.,
                            },
                            false,
                        )
                        .unwrap()
                        .validate()
                        .unwrap();
                }
            }
        }
    }
    #[test]
    fn incomplete_ambiguous_and_invalid_exports_fail_without_defaults() {
        for field in ["tone", "inkTone", "shadow", "response", "states", "ink"] {
            let mut v = exported();
            v["variants"][0]["pieces"]["control"][0]
                .as_object_mut()
                .unwrap()
                .remove(field);
            assert!(
                ControlRecipe::load(&v, true, false).is_err(),
                "missing {field} accepted"
            );
        }
        let mut v = exported();
        v["variants"][0]["pieces"]["control"][0]["states"]["destructiveHover"]["ink"] = Value::Null;
        assert!(
            ControlRecipe::load(&v, true, false)
                .unwrap()
                .at(32.)
                .unwrap()
                .destructive_hover
                .ink
                .is_none()
        );
        let mut v = exported();
        v["variants"][0]["pieces"]["control"][0]["states"]["fadeMs"] = (-1).into();
        assert!(ControlRecipe::load(&v, true, false).is_err());
        let mut v = exported();
        v["variants"][0]["pieces"]["control"][0]["states"]["hover"]["wash"]["a"] = 1.1.into();
        assert!(ControlRecipe::load(&v, true, false).is_err());
        let mut v = exported();
        v["variants"][0]["pieces"]["control"][1]["fromSide"] = 0.into();
        assert!(ControlRecipe::load(&v, true, false).is_err());
        let mut v = exported();
        v["variants"][0]["pieces"]["control"][0]["response"]["lumaHigh"] = 0.25.into();
        assert!(ControlRecipe::load(&v, true, false).is_err());
        let mut v = exported();
        let duplicate = v["variants"][0].clone();
        v["variants"].as_array_mut().unwrap().push(duplicate);
        assert!(ControlRecipe::load(&v, true, false).is_err());
    }
    #[test]
    fn capsule_geometry_is_separate_and_has_no_fallback() {
        let v = serde_json::json!({"variants": [
            {"dark": true, "reduceTransparency": false, "capsule": {"height":38,"button":26,"edge":5}},
            {"dark": false, "reduceTransparency": false, "capsule": {"height":40,"button":30,"edge":5}}
        ]});
        let m = capsule_metrics(&v, false, false).unwrap();
        assert_eq!(m.height_min, 40.);
        assert_eq!(m.button_min + m.gap, 35.);
        assert!(capsule_metrics(&v, false, true).is_err());
        let mut v = v;
        v["variants"][0]["capsule"]
            .as_object_mut()
            .unwrap()
            .remove("edge");
        assert!(capsule_metrics(&v, true, false).is_err());
    }
}
