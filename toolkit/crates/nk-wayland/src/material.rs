// SPDX-License-Identifier: LGPL-3.0-or-later
//! App-supplied material payload. Geometry and blur/refraction distances are
//! surface-local logical pixels; transport provides no visual defaults.
#[derive(Clone, Debug)]
pub struct Material {
    pub glass: Glass,
    pub tone: Tone,
    pub shadow: Shadow,
    pub shapes: Vec<Pane>,
    /// Further panes on the same surface, after `shapes`, each group in its own tone and
    /// shadow: one surface's glass holding pieces of different kinds (the bar's capsules
    /// and the Control Center's tiles).
    pub groups: Vec<Group>,
    /// Fixed veils under the panes whose centre lies inside each (`add_veil_region`).
    pub veils: Vec<Veil>,
    /// Washes over the glass: a hover, a press, an "on" (`add_state_region`). Hyalo
    /// draws them, so they stay glass (commandment 12).
    pub states: Vec<crate::StateRegion>,
}
#[derive(Clone, Debug)]
pub struct Group {
    pub clip: Option<crate::MaterialRect>,
    pub opacity: f64,
    pub tone: Tone,
    pub shadow: Shadow,
    pub shapes: Vec<Pane>,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Veil {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub falloff: f64,
    pub strength: f64,
    pub exponent: f64,
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
    /// Carried by `nidara-material-v1`, which stays at v1; Hyalo draws every corner with the
    /// desktop's one corner (`nidara_corner`) and reads only `radius`. Send 2.
    pub exponent: f64,
    /// A pointer spliced into one side (a tooltip's or a menu's, toward what it belongs
    /// to): the compositor draws body and pointer as one glass (`add_shape_pointed`).
    pub pointer: Option<Pointer>,
}
/// A pane's pointer, in the pane's coordinates: a triangle from its base, centred on the
/// pane's edge at `base`, `width` wide, to `tip`; the tip a circular arc of `tip_radius`,
/// meeting the edge in a concave arc of `base_radius`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pointer {
    pub base: (f64, f64),
    pub tip: (f64, f64),
    pub width: f64,
    pub tip_radius: f64,
    pub base_radius: f64,
}

/// One pane to the compositor, with its pointer when it has one.
pub(crate) fn add_pane(m: &crate::nidara_material_v1::NidaraMaterialV1, p: &Pane) {
    add_pane_clipped(m, p, None, 1.);
}
fn add_pane_clipped(
    m: &crate::nidara_material_v1::NidaraMaterialV1,
    p: &Pane,
    clip: Option<crate::MaterialRect>,
    opacity: f64,
) {
    let c = clip.unwrap_or(crate::MaterialRect {
        x: 0.,
        y: 0.,
        width: 0.,
        height: 0.,
    });
    match p.pointer {
        None if clip.is_none() && opacity == 1. => {
            m.add_shape(p.x, p.y, p.width, p.height, p.radius, p.exponent)
        }
        None => m.add_shape_clipped(
            p.x, p.y, p.width, p.height, p.radius, p.exponent, opacity, c.x, c.y, c.width, c.height,
        ),
        Some(q) => m.add_shape_pointed(
            p.x,
            p.y,
            p.width,
            p.height,
            p.radius,
            p.exponent,
            opacity,
            c.x,
            c.y,
            c.width,
            c.height,
            q.base.0,
            q.base.1,
            q.tip.0,
            q.tip.1,
            q.width,
            q.tip_radius,
            q.base_radius,
        ),
    }
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
    // Each group's tone and shadow hold for the shapes added after them.
    let first = (material.tone, material.shadow, &material.shapes, None, 1.);
    let rest = material
        .groups
        .iter()
        .map(|g| (g.tone, g.shadow, &g.shapes, g.clip, g.opacity));
    for (t, s, shapes, clip, opacity) in std::iter::once(first).chain(rest) {
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
        m.set_shadow(
            s.opacity_small,
            s.opacity_large,
            s.blur_small,
            s.blur_large,
            s.offset,
        );
        for p in shapes {
            add_pane_clipped(m, p, clip, opacity);
        }
    }
    for v in &material.veils {
        m.add_veil_region(
            v.x, v.y, v.width, v.height, v.falloff, v.strength, v.exponent,
        );
    }
    for r in &material.states {
        let (b, [red, green, blue, alpha]) = (r.bounds, r.wash);
        m.add_state_region(
            r.id, b.x, b.y, b.width, b.height, r.radius, red, green, blue, alpha, r.fade_ms,
        );
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

/// Client-painted material's backdrop blur, in logical pixels.
#[derive(Clone, Copy, Debug)]
pub struct Blur {
    pub size: f64,
    pub passes: u32,
}
/// A pane whose blur changes linearly from its top to its bottom.
#[derive(Clone, Copy, Debug)]
pub struct GradedPane {
    pub pane: Pane,
    pub top: f64,
    pub bottom: f64,
}
