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
