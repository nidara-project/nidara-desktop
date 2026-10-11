//! The shadow under a surface's glass (`nidara-material-v1`), as a render element of its
//! own, drawn below the glass — inside what the glass captures and blurs.
//!
//! Why it exists: the glass's tint thickens per pixel where the backdrop is too bright for
//! white content, so one pane over a backdrop bright in one place and dark in another came out
//! grey in one part and clear in the other (owner, 2026-10-02: "parts almost entirely grey and
//! parts right, on the same element"). A shadow under the glass, even across each shape and
//! just strong enough that the brightest point of the backdrop comes down to the tint's target,
//! leaves the tint even: one pane of glass over a shadow, the way the other platform does it.
//!
//! The strength is decided in protocols/material.rs from what the glass measured (the shadow
//! divided out, so it does not chase itself); here it is only drawn. Every shadow of a surface
//! — or of the whole shell chrome, its floor (render/mod.rs) — is one element and one pass,
//! and overlapping shadows combine by their MAXIMUM, not by laying one over the other: two
//! panes side by side never make a darker band between them.

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

/// The most shadows one surface draws; past it, the strongest.
pub const MAX_SCRIMS: usize = 32;

/// The fragment shader. Each shadow: a rounded-rectangle core, whole at its centre and swept
/// out to `edge` of that at its rim (a superellipse norm, so the sweep follows the core's
/// shape: a tall panel sweeps from its centre to its sides and its ends alike), then fading
/// over its falloff with smootherstep — no visible edge where the core ends nor where the fade
/// does — and a half-level of dither, so a long, faint gradient over 8 bits does not band.
/// `edge` 1: even across the core.
pub const FS_SCRIM: &str = r#"#version 100
precision highp float;
uniform vec4 cores[32];     // x, y, w, h — output pixels
uniform vec4 pars[32];      // corner radius, falloff, opacity, edge
uniform int count;
varying vec2 v_out;
varying vec2 v_fb;
float ss(float t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }
float rr(vec2 p, vec4 r, float rad) {
    vec2 h = r.zw * 0.5;
    vec2 q = abs(p - r.xy - h) - h + vec2(rad);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rad;
}
void main() {
    float a = 0.0;
    for (int i = 0; i < 32; i++) {
        if (i >= count) break;
        float d = rr(v_out, cores[i], pars[i].x);
        float k;
        if (d > 0.0) {
            k = pars[i].w * (1.0 - ss(clamp(d / max(pars[i].y, 1.0), 0.0, 1.0)));
        } else {
            vec2 h = cores[i].zw * 0.5;
            vec2 q = abs(v_out - cores[i].xy - h) / max(h, vec2(1.0));
            vec2 q2 = q * q;
            float n = sqrt(sqrt(q2.x * q2.x + q2.y * q2.y));
            k = mix(1.0, pars[i].w, ss(min(n, 1.0)));
        }
        a = max(a, pars[i].z * k);
    }
    if (a <= 0.0) discard;
    float n = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
    a = clamp(a + (n - 0.5) / 255.0, 0.0, 1.0);
    gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}
"#;

/// One shadow in output pixels, ready for the shader.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrimPx {
    pub core: [f64; 4],
    pub radius: f64,
    pub falloff: f64,
    pub alpha: f64,
    /// At the core's rim, as a fraction of its centre (the shader's sweep); 1: even.
    pub edge: f64,
}

impl ScrimPx {
    /// The shader's value at `p`: what the glass's measurement divides out there.
    fn at(&self, p: Point<f64, Physical>) -> f64 {
        let ss = |t: f64| t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
        let [x, y, w, h] = self.core;
        let (hw, hh) = (w / 2.0, h / 2.0);
        let qx = (p.x - x - hw).abs() - hw + self.radius;
        let qy = (p.y - y - hh).abs() - hh + self.radius;
        let d = qx.max(0.0).hypot(qy.max(0.0)) + qx.max(qy).min(0.0) - self.radius;
        if d > 0.0 {
            return self.alpha * self.edge * (1.0 - ss((d / self.falloff.max(1.0)).clamp(0.0, 1.0)));
        }
        let (nx, ny) = (((p.x - x - hw) / hw.max(1.0)).powi(4), ((p.y - y - hh) / hh.max(1.0)).powi(4));
        let n = (nx + ny).sqrt().sqrt().min(1.0);
        self.alpha * (1.0 + (self.edge - 1.0) * ss(n))
    }

    fn reach(&self) -> Rectangle<f64, Physical> {
        let [x, y, w, h] = self.core;
        let f = self.falloff;
        Rectangle::new((x - f, y - f).into(), (w + 2.0 * f, h + 2.0 * f).into())
    }
}

/// The shadow's opacity at `p`: the strongest of them there.
pub fn alpha_at(scrims: &[ScrimPx], p: Point<f64, Physical>) -> f64 {
    scrims.iter().map(|s| s.at(p)).fold(0.0, f64::max)
}

thread_local! {
    /// A shadow is still easing: the backend keeps redrawing (`take_easing`).
    static EASING: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether a shadow drawn since the last call is still easing toward its strength.
pub fn take_easing() -> bool {
    EASING.with(|f| f.replace(false))
}

/// The shadows of `surface` placed at `location` (its origin, output pixels), as they stand
/// at `now`: each at its eased strength times the opacity of its most opaque shape.
pub fn scrims_for(surface: &WlSurface, location: Point<i32, Physical>, scale: Scale<f64>, now: std::time::Instant) -> Vec<ScrimPx> {
    let Some(current) = material::current(surface) else { return Vec::new() };
    let m = &current.state;
    let mut out: Vec<ScrimPx> = Vec::new();
    for unit in m.scrim_units() {
        let Some(anim) = current.scrims.get(&unit.key) else { continue };
        if !anim.settled(now) {
            EASING.with(|f| f.set(true));
        }
        let opacity = unit.members.iter().map(|&i| m.shapes[i].opacity).fold(0.0, f64::max);
        let alpha = anim.value(now) * opacity;
        if alpha < 0.5 / 255.0 {
            continue;
        }
        let [x, y, w, h] = unit.core;
        let o = location.to_f64();
        out.push(ScrimPx {
            core: [o.x + x * scale.x, o.y + y * scale.y, w * scale.x, h * scale.y],
            // The Lab's optional area dim uses the largest pane's corner radius for a
            // shared underlay. This avoids forcing its whole region into a capsule.
            // Production region geometry remains unchanged.
            radius: if std::env::var_os("HYALO_LAB_AREA_DIM").is_some()
                && unit.key < material::LONE_SCRIM
            {
                if w > h * 10.0 && h <= 64.0 {
                    // The Lab's optional bar band fills its 40 px exclusive strip. A
                    // capsule radius would cut holes at the output's top corners.
                    0.0
                } else {
                    unit.members.iter()
                        .map(|&i| &m.shapes[i])
                        .max_by(|a, b| (a.w * a.h).total_cmp(&(b.w * b.h)))
                        .map_or(0.0, |s| s.radius.min(w.min(h) * 0.5) * scale.x)
                }
            } else {
                unit.radius * scale.x
            },
            falloff: unit.falloff * scale.x,
            alpha,
            edge: unit.edge,
        });
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
    /// data for one surface's shadows, the output's for the chrome's floor.
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
        for (i, s) in self.scrims.iter().enumerate() {
            cores[i * 4..i * 4 + 4].copy_from_slice(&s.core.map(|v| v as f32));
            pars[i * 4..i * 4 + 4].copy_from_slice(&[s.radius as f32, s.falloff as f32, s.alpha as f32, s.edge as f32]);
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
    fn the_shadow_is_even_over_its_core_and_gone_past_its_falloff() {
        let s = ScrimPx { core: [100.0, 0.0, 300.0, 200.0], radius: 0.0, falloff: 100.0, alpha: 0.5, edge: 1.0 };
        assert_eq!(s.at((250.0, 100.0).into()), 0.5, "inside: the whole strength");
        assert_eq!(s.at((100.0, 100.0).into()), 0.5, "on the core's edge: still whole");
        assert!((s.at((50.0, 100.0).into()) - 0.25).abs() < 1e-9, "halfway out: half (smootherstep is symmetric)");
        assert_eq!(s.at((0.0, 100.0).into()), 0.0, "past the falloff: nothing");
        let other = ScrimPx { core: [0.0, 0.0, 50.0, 50.0], radius: 0.0, falloff: 10.0, alpha: 0.3, edge: 1.0 };
        assert_eq!(alpha_at(&[s, other], (40.0, 25.0).into()), s.at((40.0, 25.0).into()).max(0.3), "two shadows: the stronger, never their sum");
    }

    #[test]
    fn a_swept_core_is_whole_at_its_centre_and_at_its_edge_on_the_rim() {
        let s = ScrimPx { core: [100.0, 100.0, 200.0, 400.0], radius: 0.0, falloff: 50.0, alpha: 0.4, edge: 0.75 };
        assert_eq!(s.at((200.0, 300.0).into()), 0.4, "the centre: the whole strength");
        let side = s.at((100.0, 300.0).into());
        let end = s.at((200.0, 100.0).into());
        assert!((side - 0.3).abs() < 1e-9 && (end - 0.3).abs() < 1e-9, "the rim, sides and ends alike: the edge's ({side}, {end})");
        let halfway = s.at((150.0, 300.0).into());
        assert!(halfway < 0.4 && halfway > 0.3, "between: the sweep ({halfway})");
        assert!((s.at((75.0, 300.0).into()) - 0.15).abs() < 1e-9, "halfway through the falloff: half the edge's");
        assert_eq!(s.at((40.0, 300.0).into()), 0.0, "past it: nothing");
        let even = ScrimPx { edge: 1.0, ..s };
        assert_eq!(even.at((101.0, 101.0).into()), 0.4, "edge 1: even across the core");
    }
}
