// SPDX-License-Identifier: LGPL-3.0-or-later
//! App-supplied material payload. Geometry and blur/refraction distances are
//! surface-local logical pixels; transport provides no visual defaults.
#[derive(Clone, Debug)]
pub struct Material {
    pub glass: Glass,
    pub tone: Tone,
    pub shadow: Shadow,
    pub shapes: Vec<Pane>,
}
#[derive(Clone, Copy, Debug)]
pub struct Glass {
    pub refraction: f64,
    pub rim: f64,
    pub lensing: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Tone {
    pub saturation: f64,
    pub ceiling: f64,
    pub lift: f64,
    pub gain: f64,
    /// sRGB red, green, blue and opacity.
    pub wash: [f64; 4],
    pub ambient: f64,
    pub ambient_lift: f64,
    pub ambient_gain: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Shadow {
    pub opacity_small: f64,
    pub opacity_large: f64,
    pub blur_small: f64,
    pub blur_large: f64,
    pub offset: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Pane {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
    pub exponent: f64,
}

pub(super) fn send_material(
    m: &crate::nidara_material_v1::NidaraMaterialV1,
    material: Option<&Material>,
) {
    m.clear_shapes();
    m.clear_glass();
    let Some(material) = material else { return };
    let g = material.glass;
    m.set_glass(0., 0., 0., 0., 0., 0., g.refraction, g.rim, 0.);
    m.set_lensing(g.lensing);
    let t = material.tone;
    m.set_tone(
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
    let s = material.shadow;
    m.set_shadow(
        s.opacity_small,
        s.opacity_large,
        s.blur_small,
        s.blur_large,
        s.offset,
    );
    for p in &material.shapes {
        m.add_shape(p.x, p.y, p.width, p.height, p.radius, p.exponent);
    }
}

/// A window's background (PHASE1.md D6): its colour, opaque, which Hyalo paints at the
/// windows' style. An app may ask for a named level instead of the user's.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowBackground {
    /// sRGB red, green, blue, 0–1; no alpha: how much shows is Hyalo's.
    pub color: [f64; 3],
    pub level: Option<WindowLevel>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowLevel {
    Opaque,
    Tinted,
    Translucent,
}

pub(super) fn send_background(
    m: &crate::nidara_material_v1::NidaraMaterialV1,
    b: WindowBackground,
) {
    use crate::nidara_material_v1::WindowBackgroundLevel as L;
    m.set_window_background(b.color[0], b.color[1], b.color[2]);
    if let Some(level) = b.level {
        m.set_window_background_level(match level {
            WindowLevel::Opaque => L::Opaque,
            WindowLevel::Tinted => L::Tinted,
            WindowLevel::Translucent => L::Translucent,
        });
    }
}
