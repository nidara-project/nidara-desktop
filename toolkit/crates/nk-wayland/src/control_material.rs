// SPDX-License-Identifier: LGPL-3.0-or-later
//! Explicit material-v1 payload for one control capsule; no theme defaults.
use crate::layers::fixed;
use crate::{Blur, Material, Result, Tone};

#[derive(Clone, Copy, Debug)]
pub struct Response {
    pub luma_low: f64,
    pub luma_high: f64,
    pub contrast_low: f64,
    pub contrast_high: f64,
    pub shadow_white: f64,
    pub shadow_text: f64,
    pub settle_ms: u32,
}
#[derive(Clone, Copy, Debug)]
pub struct MaterialRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct StateRegion {
    pub id: u32,
    pub bounds: MaterialRect,
    pub radius: f64,
    pub wash: [f64; 4],
    pub fade_ms: u32,
}
#[derive(Clone, Copy, Debug)]
pub struct InkCoverage {
    pub bounds: MaterialRect,
    /// Alpha zero uses the material's continuous ink; otherwise an explicit override.
    pub override_color: [f64; 4],
}
#[derive(Clone, Debug)]
pub struct ControlMaterial {
    pub base: Material,
    pub blur: Blur,
    pub ink_tone: Tone,
    pub response: Option<Response>,
    pub light_ink: [f64; 4],
    pub dark_ink: [f64; 4],
    pub states: Vec<StateRegion>,
    pub coverage: Vec<InkCoverage>,
}
// wayland-scanner serializes fixed arguments with a truncating cast, not round().
fn wire(v: f64) -> f64 {
    (v * 256.) as i32 as f64 / 256.
}
fn color(values: &[f64; 4]) -> Result<()> {
    if values.iter().all(|v| (0. ..=1.).contains(v)) {
        Ok(())
    } else {
        Err("invalid control RGBA".into())
    }
}
impl MaterialRect {
    fn validate(self) -> Result<()> {
        fixed(&[self.x, self.y, self.width, self.height])?;
        if wire(self.width) <= 0. || wire(self.height) <= 0. {
            return Err("control rectangle is empty on the wire".into());
        }
        Ok(())
    }
    fn overlaps(self, other: Self) -> bool {
        wire(self.x) < wire(other.x) + wire(other.width)
            && wire(other.x) < wire(self.x) + wire(self.width)
            && wire(self.y) < wire(other.y) + wire(other.height)
            && wire(other.y) < wire(self.y) + wire(self.height)
    }
}
fn tone(t: Tone) -> Result<()> {
    fixed(&[
        t.saturation,
        t.ceiling,
        t.lift,
        t.gain,
        t.ambient,
        t.ambient_lift,
        t.ambient_gain,
    ])?;
    color(&t.wash)
}
impl ControlMaterial {
    /// Validate the complete transaction before sending any Wayland request.
    pub fn validate(&self) -> Result<()> {
        if self.base.shapes.len() != 1 {
            return Err("a control capsule declares one pane".into());
        }
        if self.states.len() > 8 || self.coverage.len() > 16 {
            return Err("control material exceeds 8 washes or 16 coverage rectangles".into());
        }
        let g = self.base.glass;
        let s = self.base.shadow;
        fixed(&[
            g.refraction,
            g.rim,
            g.lensing,
            self.blur.size,
            s.opacity_small,
            s.opacity_large,
            s.blur_small,
            s.blur_large,
            s.offset,
        ])?;
        if self.blur.size < 0. {
            return Err("invalid control blur".into());
        }
        tone(self.base.tone)?;
        tone(self.ink_tone)?;
        color(&self.light_ink)?;
        color(&self.dark_ink)?;
        for p in &self.base.shapes {
            MaterialRect {
                x: p.x,
                y: p.y,
                width: p.width,
                height: p.height,
            }
            .validate()?;
            fixed(&[p.radius, p.exponent])?;
            if p.radius < 0. || p.exponent <= 0. {
                return Err("invalid control pane".into());
            }
        }
        if let Some(r) = self.response {
            fixed(&[
                r.luma_low,
                r.luma_high,
                r.contrast_low,
                r.contrast_high,
                r.shadow_white,
                r.shadow_text,
            ])?;
            if !(0. ..=1.).contains(&r.luma_low)
                || !(0. ..=1.).contains(&r.luma_high)
                || !(0. ..=1.).contains(&r.contrast_low)
                || !(0. ..=1.).contains(&r.contrast_high)
                || wire(r.luma_low) >= wire(r.luma_high)
                || wire(r.contrast_low) >= wire(r.contrast_high)
            {
                return Err("invalid control response thresholds on the wire".into());
            }
        }
        for (index, region) in self.states.iter().enumerate() {
            region.bounds.validate()?;
            fixed(&[region.radius])?;
            color(&region.wash)?;
            if region.radius < 0.
                || self.states[..index]
                    .iter()
                    .any(|other| other.id == region.id)
            {
                return Err("invalid radius or duplicate control state id".into());
            }
        }
        for (index, coverage) in self.coverage.iter().enumerate() {
            coverage.bounds.validate()?;
            color(&coverage.override_color)?;
            if self.coverage[..index]
                .iter()
                .any(|other| coverage.bounds.overlaps(other.bounds))
            {
                return Err("overlapping control ink coverage on the wire".into());
            }
        }
        Ok(())
    }
    pub(crate) fn send(&self, m: &crate::nidara_material_v1::NidaraMaterialV1) {
        let mut base = self.base.clone();
        base.shapes.clear();
        crate::material::send_material(m, Some(&base));
        m.set_blur(self.blur.size, self.blur.passes);
        let t = self.ink_tone;
        m.set_ink_tone(
            t.saturation,
            t.ceiling,
            t.lift,
            t.gain,
            t.wash[0],
            t.wash[1],
            t.wash[2],
            t.wash[3],
            t.ambient,
            t.ambient_lift,
            t.ambient_gain,
        );
        if let Some(r) = self.response {
            m.set_response(
                r.luma_low,
                r.luma_high,
                r.contrast_low,
                r.contrast_high,
                r.shadow_white,
                r.shadow_text,
                r.settle_ms,
            );
        }
        let a = self.light_ink;
        let b = self.dark_ink;
        m.set_ink_colors(a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]);
        for p in &self.base.shapes {
            crate::material::add_pane(m, p);
        }
        for region in &self.states {
            let p = region.bounds;
            let c = region.wash;
            m.add_state_region(
                region.id,
                p.x,
                p.y,
                p.width,
                p.height,
                region.radius,
                c[0],
                c[1],
                c[2],
                c[3],
                region.fade_ms,
            );
        }
        for coverage in &self.coverage {
            let p = coverage.bounds;
            let c = coverage.override_color;
            m.add_ink_coverage(p.x, p.y, p.width, p.height, c[0], c[1], c[2], c[3]);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Glass, Pane, Shadow};
    fn fixture() -> ControlMaterial {
        let tone = Tone {
            saturation: 1.,
            ceiling: 1.,
            lift: 0.,
            gain: 1.,
            wash: [0.; 4],
            ambient: 0.,
            ambient_lift: 0.,
            ambient_gain: 1.,
        };
        ControlMaterial {
            base: Material {
                glass: Glass {
                    refraction: 0.,
                    rim: 0.,
                    lensing: 0.,
                },
                tone,
                shadow: Shadow {
                    opacity_small: 0.,
                    opacity_large: 0.,
                    blur_small: 0.,
                    blur_large: 0.,
                    offset: 0.,
                },
                shapes: vec![Pane {
                    x: 0.,
                    y: 0.,
                    width: 100.,
                    height: 32.,
                    radius: 16.,
                    exponent: 2.,
                    pointer: None,
                }],
            },
            blur: Blur {
                size: 2.,
                passes: 2,
            },
            ink_tone: tone,
            response: Some(Response {
                luma_low: 0.25,
                luma_high: 0.35,
                contrast_low: 0.02,
                contrast_high: 0.1,
                shadow_white: 1.,
                shadow_text: 0.5,
                settle_ms: 200,
            }),
            light_ink: [1.; 4],
            dark_ink: [0., 0., 0., 1.],
            states: vec![StateRegion {
                id: 1,
                bounds: MaterialRect {
                    x: 0.,
                    y: 0.,
                    width: 10.,
                    height: 10.,
                },
                radius: 5.,
                wash: [0.; 4],
                fade_ms: 150,
            }],
            coverage: vec![InkCoverage {
                bounds: MaterialRect {
                    x: 0.,
                    y: 0.,
                    width: 10.,
                    height: 10.,
                },
                override_color: [0.; 4],
            }],
        }
    }
    #[test]
    fn adjacent_coverage_and_zero_alpha_exit_states_remain_valid() {
        let mut payload = fixture();
        let mut adjacent = payload.coverage[0];
        adjacent.bounds.x = 10.;
        payload.coverage.push(adjacent);
        payload.validate().unwrap();
        payload.response = None;
        payload.states[0].fade_ms = 0;
        payload.validate().unwrap();
    }
    #[test]
    fn empty_overlapping_and_wire_quantized_invalid_regions_are_refused() {
        let mut payload = fixture();
        payload.coverage[0].bounds.width = 0.001;
        assert!(
            payload
                .validate()
                .unwrap_err()
                .contains("empty on the wire")
        );
        payload = fixture();
        payload.coverage.push(payload.coverage[0]);
        assert!(payload.validate().unwrap_err().contains("overlapping"));
        payload = fixture();
        payload.coverage[0].bounds.x = -0.003;
        payload.coverage[0].bounds.width = 1.;
        let mut touching = payload.coverage[0];
        touching.bounds.x += touching.bounds.width;
        payload.coverage.push(touching);
        assert!(
            payload.validate().unwrap_err().contains("overlapping"),
            "wire truncation changed touching into overlapping"
        );
        payload = fixture();
        payload.response.as_mut().unwrap().luma_high = 0.25001;
        assert!(
            payload
                .validate()
                .unwrap_err()
                .contains("thresholds on the wire")
        );
    }
    #[test]
    fn transaction_limits_ids_nonfinite_and_overflow_are_refused() {
        let mut payload = fixture();
        payload.states.push(payload.states[0]);
        assert!(payload.validate().unwrap_err().contains("duplicate"));
        payload = fixture();
        payload.states = (0..9)
            .map(|id| StateRegion {
                id,
                ..payload.states[0]
            })
            .collect();
        assert!(payload.validate().unwrap_err().contains("8 washes"));
        payload = fixture();
        payload.coverage = (0..17)
            .map(|i| InkCoverage {
                bounds: MaterialRect {
                    x: f64::from(i) * 10.,
                    ..payload.coverage[0].bounds
                },
                ..payload.coverage[0]
            })
            .collect();
        assert!(payload.validate().unwrap_err().contains("16 coverage"));
        payload = fixture();
        payload.dark_ink[0] = f64::NAN;
        assert!(payload.validate().unwrap_err().contains("RGBA"));
        payload = fixture();
        payload.coverage[0].bounds.x = 1e12;
        assert!(payload.validate().unwrap_err().contains("Wayland fixed"));
        payload = fixture();
        payload.base.shapes.push(payload.base.shapes[0]);
        assert!(payload.validate().unwrap_err().contains("one pane"));
    }
}
