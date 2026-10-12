//! The fixed veils under a surface's glass (`nidara-material-v1`, add_veil_region), as a render
//! element of their own, drawn below the glass — inside what the glass captures and blurs.
//!
//! A veil is the darkening a group of panes lies on (the Control Center's, measured on the
//! reference, 2026-10-11): even under its region, falling outside it as (1 − d/falloff)^exp.
//! Nothing measures it: the backdrop does not change it. Every veil of a surface — or of the
//! whole shell chrome, its floor (render/mod.rs) — is one element and one pass, and overlapping
//! veils combine by their MAXIMUM, not by laying one over the other.
//!
//! Until 2026-10-11 this also drew a MEASURED shadow: what a per-pixel tint was missing to keep
//! white text legible. The tone (set_tone) replaced that tint and the shadow went with it.
//!
//! The same pass draws each pane's own SHADOW (set_shadow, 2026-10-12): the reference's, measured
//! outside its glass at six sizes — a black rounded rectangle blurred by a gaussian and moved down,
//! its opacity and deviation growing with the pane (glass-probe `refraction-sizes`, run
//! 38201914917: within 0.0012 of the captures). It is cut out of every shape that casts one: the
//! pane's tone was fitted to the reference's glass as it looks, so nothing may darken under it a
//! second time. Shadows combine by their maximum too; a veil is never cut out.

use std::cell::RefCell;

use smithay::{
    backend::renderer::{
        element::{Element, Id, Kind, RenderElement},
        gles::{GlesError, ffi},
        utils::CommitCounter,
    },
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Buffer as BufferCoords, Physical, Point, Rectangle, Scale, Size, user_data::UserDataMap},
};

use super::{HyaloRenderer, glass_gl};
use crate::protocols::material;

/// The most veils one surface draws; past it, the strongest.
pub const MAX_SCRIMS: usize = 32;

/// The fragment shader. Each veil: even under its rectangle, (1 − d/falloff)^exponent outside,
/// and a half-level of dither, so a long, faint gradient over 8 bits does not band.
pub const FS_SCRIM: &str = r#"#version 100
precision highp float;
uniform vec4 cores[32];     // x, y, w, h — output pixels
uniform vec4 pars[32];      // falloff, opacity, exponent, unused
uniform vec4 shad[32];      // a shadow: corner radius, deviation (> 0; 0 = a veil), offset down
uniform int count;
varying vec2 v_out;
varying vec2 v_fb;
float rr(vec2 p, vec4 r) {
    vec2 h = r.zw * 0.5;
    vec2 q = abs(p - r.xy - h) - h;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}
// The same, with round corners of radius c.
float rrc(vec2 p, vec4 r, float c) {
    vec2 h = r.zw * 0.5;
    vec2 q = abs(p - r.xy - h) - h + c;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - c;
}
// The normal distribution's cumulative function (Abramowitz & Stegun 7.1.26, error < 1.5e-7).
float phi(float x) {
    float z = abs(x) * 0.70710678;
    float t = 1.0 / (1.0 + 0.3275911 * z);
    float e = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * exp(-z * z);
    return 0.5 * (1.0 + (x < 0.0 ? -e : e));
}
void main() {
    float a = 0.0;
    float s = 0.0;
    bool under = false;
    for (int i = 0; i < 32; i++) {
        if (i >= count) break;
        if (shad[i].y > 0.0) {
            if (rrc(v_out, cores[i], shad[i].x) < 0.0) under = true;
            float d = rrc(v_out - vec2(0.0, shad[i].z), cores[i], shad[i].x);
            s = max(s, pars[i].y * phi(-d / shad[i].y));
        } else {
            float d = rr(v_out, cores[i]);
            float k = d > 0.0 ? pow(clamp(1.0 - d / max(pars[i].x, 1.0), 0.0, 1.0), pars[i].z) : 1.0;
            a = max(a, pars[i].y * k);
        }
    }
    if (!under) a = max(a, s);
    if (a <= 0.0) discard;
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    a = clamp(a + (n - 0.5) / 255.0, 0.0, 1.0);
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
"#;

/// One veil in output pixels, ready for the shader.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrimPx {
    pub core: [f64; 4],
    pub falloff: f64,
    pub alpha: f64,
    /// Its fall-off's exponent outside the core.
    pub exponent: f64,
    /// A pane's shadow (`sigma` > 0; 0: a veil): the core is the pane, `radius` its corners,
    /// `sigma` the gaussian's deviation and `dy` how far down it falls, output px.
    pub radius: f64,
    pub sigma: f64,
    pub dy: f64,
}

impl ScrimPx {
    /// The shader's value at `p`.
    #[cfg(test)]
    fn at(&self, p: Point<f64, Physical>) -> f64 {
        if self.sigma > 0.0 {
            return self.shadow_at(p);
        }
        let [x, y, w, h] = self.core;
        let (hw, hh) = (w / 2.0, h / 2.0);
        let qx = (p.x - x - hw).abs() - hw;
        let qy = (p.y - y - hh).abs() - hh;
        let d = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0);
        if d > 0.0 { self.alpha * (1.0 - d / self.falloff.max(1.0)).clamp(0.0, 1.0).powf(self.exponent) } else { self.alpha }
    }

    /// A shadow's value at `p`, before the cut-out (the shader's, with an exact Φ).
    #[cfg(test)]
    fn shadow_at(&self, p: Point<f64, Physical>) -> f64 {
        let [x, y, w, h] = self.core;
        let c = self.radius;
        let (hw, hh) = (w / 2.0, h / 2.0);
        let qx = (p.x - x - hw).abs() - hw + c;
        let qy = (p.y - self.dy - y - hh).abs() - hh + c;
        let d = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - c;
        self.alpha * 0.5 * (1.0 + libm_erf(-d / self.sigma / std::f64::consts::SQRT_2))
    }

    fn reach(&self) -> Rectangle<f64, Physical> {
        let [x, y, w, h] = self.core;
        if self.sigma > 0.0 {
            // Past 3.5 deviations a gaussian's tail is under 1/4000 of it.
            let r = 3.5 * self.sigma;
            return Rectangle::new((x - r, y - r + self.dy.min(0.0)).into(), (w + 2.0 * r, h + 2.0 * r + self.dy.abs()).into());
        }
        let f = self.falloff;
        Rectangle::new((x - f, y - f).into(), (w + 2.0 * f, h + 2.0 * f).into())
    }
}

/// The veils of `surface` placed at `location` (its origin, output pixels), each at its strength
/// times the opacity of its most opaque shape (it forms with them).
pub fn scrims_for(surface: &WlSurface, location: Point<i32, Physical>, scale: Scale<f64>, _now: std::time::Instant) -> Vec<ScrimPx> {
    let Some(current) = material::current(surface) else { return Vec::new() };
    let m = &current.state;
    let mut out: Vec<ScrimPx> = Vec::new();
    for unit in m.veil_units() {
        let opacity = unit.members.iter().map(|&i| m.shapes[i].opacity).fold(0.0, f64::max);
        let alpha = unit.veil.strength * opacity;
        if alpha < 0.5 / 255.0 {
            continue;
        }
        let [x, y, w, h] = unit.core;
        let o = location.to_f64();
        out.push(ScrimPx {
            core: [o.x + x * scale.x, o.y + y * scale.y, w * scale.x, h * scale.y],
            falloff: unit.falloff * scale.x,
            alpha,
            exponent: unit.veil.exponent,
            radius: 0.0,
            sigma: 0.0,
            dy: 0.0,
        });
    }
    // Each pane's own shadow (set_shadow), outside the glass.
    if m.glass.is_some() {
        let o = location.to_f64();
        for s in &m.shapes {
            let Some(law) = s.shadow else { continue };
            // What of the pane shows: its clip, where it has one.
            let [x, y, w, h] = match s.clip {
                Some([cx, cy, cw, ch]) => {
                    let (x0, y0) = (s.x.max(cx), s.y.max(cy));
                    let (x1, y1) = ((s.x + s.w).min(cx + cw), (s.y + s.h).min(cy + ch));
                    [x0, y0, (x1 - x0).max(0.0), (y1 - y0).max(0.0)]
                }
                None => [s.x, s.y, s.w, s.h],
            };
            if w <= 0.0 || h <= 0.0 {
                continue;
            }
            let (opacity, sigma) = law.at(s.w.min(s.h));
            let alpha = opacity * s.opacity.clamp(0.0, 1.0);
            if alpha < 0.5 / 255.0 || sigma <= 0.0 {
                continue;
            }
            out.push(ScrimPx {
                core: [o.x + x * scale.x, o.y + y * scale.y, w * scale.x, h * scale.y],
                falloff: 0.0,
                alpha,
                exponent: 1.0,
                radius: s.radius.min(w.min(h) / 2.0) * scale.x,
                sigma: sigma * scale.x,
                dy: law.offset * scale.y,
            });
        }
    }
    if out.len() > MAX_SCRIMS {
        out.sort_by(|a, b| b.alpha.total_cmp(&a.alpha));
        out.truncate(MAX_SCRIMS);
    }
    out
}

#[derive(Debug, Clone)]
pub struct ScrimElement {
    id: Id,
    commit: CommitCounter,
    geometry: Rectangle<i32, Physical>,
    scrims: Vec<ScrimPx>,
}

/// The element's id, and what it last drew: its counter moves when that changes.
#[derive(Default)]
struct ScrimMemo(RefCell<Option<(Id, CommitCounter, Vec<ScrimPx>)>>);

impl ScrimElement {
    /// The element drawing `scrims` (from `scrims_for`) on an output of `output_size`; none
    /// when there is nothing to draw. `memo` keeps its id and what it last drew: the surface's
    /// data for one surface's veils, the output's for the chrome's floor.
    pub fn new(memo: &UserDataMap, mut scrims: Vec<ScrimPx>, output_size: Size<i32, Physical>) -> Option<Self> {
        if scrims.is_empty() {
            return None;
        }
        if scrims.len() > MAX_SCRIMS {
            scrims.sort_by(|a, b| b.alpha.total_cmp(&a.alpha));
            scrims.truncate(MAX_SCRIMS);
        }
        let mut reach = scrims[0].reach();
        for s in &scrims[1..] {
            reach = reach.merge(s.reach());
        }
        let geometry = reach.to_i32_up::<i32>().intersection(Rectangle::from_size(output_size))?;
        let (id, commit) = {
            let memo = memo.get_or_insert(ScrimMemo::default);
            let mut memo = memo.0.borrow_mut();
            let (id, mut commit, last) = memo.take().unwrap_or_else(|| (Id::new(), CommitCounter::default(), Vec::new()));
            if last != scrims {
                commit.increment();
            }
            *memo = Some((id.clone(), commit, scrims.clone()));
            (id, commit)
        };
        Some(Self { id, commit, geometry, scrims })
    }

    fn draw_gles(
        &self,
        frame: &mut smithay::backend::renderer::gles::GlesFrame<'_, '_>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
    ) -> Result<(), GlesError> {
        let projection = *frame.projection();
        let user_data = frame.egl_context().user_data() as *const UserDataMap;
        let mut cores = [0f32; MAX_SCRIMS * 4];
        let mut pars = [0f32; MAX_SCRIMS * 4];
        let mut shad = [0f32; MAX_SCRIMS * 4];
        for (i, s) in self.scrims.iter().enumerate() {
            cores[i * 4..i * 4 + 4].copy_from_slice(&s.core.map(|v| v as f32));
            pars[i * 4..i * 4 + 4].copy_from_slice(&[s.falloff as f32, s.alpha as f32, s.exponent as f32, 0.0]);
            shad[i * 4..i * 4 + 4].copy_from_slice(&[s.radius as f32, s.sigma as f32, s.dy as f32, 0.0]);
        }
        frame.with_context(|gl| unsafe {
            // Safety: the EGL context outlives this frame, and its user data with it.
            let progs = glass_gl::programs(gl, &*user_data);
            let p = &progs.scrim;
            let fb = glass_gl::fb_size(gl);
            gl.Enable(ffi::BLEND);
            gl.BlendFunc(ffi::ONE, ffi::ONE_MINUS_SRC_ALPHA);
            gl.BindBuffer(ffi::ARRAY_BUFFER, progs.vbo);
            gl.UseProgram(p.id);
            gl.EnableVertexAttribArray(p.pos);
            gl.VertexAttribPointer(p.pos, 2, ffi::FLOAT, ffi::FALSE, 0, std::ptr::null());
            gl.UniformMatrix3fv(p.loc(gl, c"projection"), 1, ffi::FALSE, projection.as_ptr());
            gl.Uniform2f(p.loc(gl, c"fb_size"), fb.0 as f32, fb.1 as f32);
            gl.Uniform4fv(p.loc(gl, c"cores"), MAX_SCRIMS as i32, cores.as_ptr());
            gl.Uniform4fv(p.loc(gl, c"pars"), MAX_SCRIMS as i32, pars.as_ptr());
            gl.Uniform4fv(p.loc(gl, c"shad"), MAX_SCRIMS as i32, shad.as_ptr());
            gl.Uniform1i(p.loc(gl, c"count"), self.scrims.len() as i32);
            for d in damage {
                let q = Rectangle::new(d.loc + dst.loc, d.size);
                gl.Uniform4f(p.loc(gl, c"dst_rect"), q.loc.x as f32, q.loc.y as f32, q.size.w as f32, q.size.h as f32);
                gl.DrawArrays(ffi::TRIANGLE_STRIP, 0, 4);
            }
            gl.DisableVertexAttribArray(p.pos);
            gl.BindBuffer(ffi::ARRAY_BUFFER, 0);
            gl.UseProgram(0);
        })
    }
}

impl Element for ScrimElement {
    fn id(&self) -> &Id {
        &self.id
    }

    fn current_commit(&self) -> CommitCounter {
        self.commit
    }

    fn src(&self) -> Rectangle<f64, BufferCoords> {
        Rectangle::from_size((self.geometry.size.w as f64, self.geometry.size.h as f64).into())
    }

    fn geometry(&self, _scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.geometry
    }

    fn kind(&self) -> Kind {
        Kind::Unspecified
    }
}

impl<R: HyaloRenderer> RenderElement<R> for ScrimElement {
    fn draw(
        &self,
        frame: &mut R::Frame<'_, '_>,
        _src: Rectangle<f64, BufferCoords>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        _opaque_regions: &[Rectangle<i32, Physical>],
        _cache: Option<&UserDataMap>,
    ) -> Result<(), R::Error> {
        self.draw_gles(R::gles_frame(frame), dst, damage).map_err(R::from_gles_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_veil_is_even_under_its_core_and_falls_as_its_power() {
        let s = ScrimPx { core: [100.0, 0.0, 300.0, 200.0], falloff: 125.0, alpha: 0.078, exponent: 1.5, radius: 0.0, sigma: 0.0, dy: 0.0 };
        assert_eq!(s.at((250.0, 100.0).into()), 0.078, "under the core: its whole strength, even");
        assert_eq!(s.at((101.0, 199.0).into()), 0.078, "even at the core's corner");
        // The reference's own profile (2026-10-11): 25 px out, (1 − 0.2)^1.5 of it.
        assert!((s.at((75.0, 100.0).into()) - 0.078 * 0.8f64.powf(1.5)).abs() < 1e-9);
        assert_eq!(s.at((-30.0, 100.0).into()), 0.0, "past the falloff: nothing");
    }
}

#[cfg(test)]
fn libm_erf(x: f64) -> f64 {
    // Abramowitz & Stegun 7.1.26, the shader's own.
    let z = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * z);
    let e = 1.0 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * (-z * z).exp();
    if x < 0.0 { -e } else { e }
}

#[cfg(test)]
mod shadow_tests {
    use super::*;
    use crate::protocols::material::ShadowLaw;

    /// The reference's, as the kit sends it (glass-material.ts SHADOWS, dark face).
    const DARK: ShadowLaw = ShadowLaw { opacity: [0.013, 0.175], blur: [2.0, 17.0], offset: 8.0 };

    #[test]
    fn the_law_grows_from_64_to_160_and_holds() {
        assert_eq!(DARK.at(40.0), (0.013, 2.0), "small: the small ends");
        assert_eq!(DARK.at(400.0), (0.175, 17.0), "large: the large ends");
        let (o, s) = DARK.at(112.0);
        assert!((o - 0.094).abs() < 1e-9 && (s - 9.5).abs() < 1e-9, "halfway: halfway ({o}, {s})");
    }

    #[test]
    fn a_large_panes_shadow_is_the_measured_profile() {
        // A 400 px pane at 1×, its shadow as the reference's (run 38201914917, dark, 400 pt):
        // A·Φ(−d/σ) to the right (no offset across), A·Φ((dy − d)/σ) below.
        let (a, sigma) = DARK.at(400.0);
        let s = ScrimPx { core: [0.0, 0.0, 400.0, 400.0], falloff: 0.0, alpha: a, exponent: 1.0, radius: 50.0, sigma, dy: 8.0 };
        let right_1 = s.at((401.0, 200.0).into());
        let below_1 = s.at((200.0, 401.0).into());
        // The captures, α on the sRGB value 1 px out: 0.083 right, 0.118 below.
        assert!((right_1 - 0.083).abs() < 0.006, "1 px right: {right_1}");
        assert!((below_1 - 0.118).abs() < 0.006, "1 px below: {below_1}");
        assert!(s.at((200.0, 460.0).into()) < 0.004, "gone by 60 px below (the captures: 0 at 48)");
    }
}
