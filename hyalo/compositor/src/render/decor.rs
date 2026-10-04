//! What Hyalo draws around a window (wave 2, #680 / #684): a 1 px line outside its box,
//! following its corners, and a shadow beneath it — in one pass, behind everything of the
//! window. The line is Hyprland's for Nidara (a light gradient on the focused window, a faint
//! grey on the others); the shadow is deeper under the focused window. Both are `[windows]
//! border` / `[windows] shadow` (config.rs), live.
//!
//! Neither reaches inside the box: a translucent window (kitty, our own) shows its backdrop
//! there, not a shadow. The shadow is what an app that draws its own frame lost when Hyalo cut
//! that frame to its box (render/window.rs `push`, #728).

use std::cell::RefCell;

use smithay::{
    backend::renderer::{
        element::{Element, Id, Kind, RenderElement},
        gles::{GlesError, ffi},
        utils::CommitCounter,
    },
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Buffer as BufferCoords, Physical, Rectangle, Scale, user_data::UserDataMap},
    wayland::compositor::with_states,
};

use super::{HyaloRenderer, glass_gl};
use crate::config::{WindowsConfig, parse_color};

/// The box's distance field is the corner shader's (render/window.rs): a superellipse of
/// `exponent` in the corner squares, straight edges between — negative inside, output px.
pub const FS_DECOR: &str = r#"#version 100
precision highp float;
uniform vec4 rect;        // the window's box, output px
uniform float radius;     // its corners, output px
uniform float exponent;
uniform float border;     // the line's width, output px; 0 none
uniform vec4 c0;          // the line: from c0 to c1 along `dir`, premultiplied
uniform vec4 c1;
uniform vec2 dir;
uniform vec4 shadow;      // premultiplied; a 0 none
uniform float range;      // output px
uniform float offset;     // output px, down
uniform float power;
varying vec2 v_out;
varying vec2 v_fb;
float sdf(vec2 p, vec4 r) {
    vec2 h = r.zw * 0.5;
    vec2 q = abs(p - r.xy - h);
    vec2 inner = h - vec2(radius);
    if (radius > 0.0 && q.x > inner.x && q.y > inner.y) {
        vec2 k = (q - inner) / radius;
        return (pow(pow(k.x, exponent) + pow(k.y, exponent), 1.0 / exponent) - 1.0) * radius;
    }
    return max(q.x - h.x, q.y - h.y);
}
void main() {
    float d = sdf(v_out, rect);
    // Nothing inside the box.
    float outside = clamp(0.5 + d, 0.0, 1.0);
    if (outside <= 0.0) discard;
    vec4 c = vec4(0.0);
    if (shadow.a > 0.0 && range > 0.0) {
        float ds = sdf(v_out, rect + vec4(0.0, offset, 0.0, 0.0));
        float t = clamp(ds / range, 0.0, 1.0);
        c = shadow * pow(1.0 - t, power) * outside;
    }
    if (border > 0.0) {
        float line = outside * clamp(border + 0.5 - d, 0.0, 1.0);
        vec2 uv = (v_out - rect.xy) / rect.zw - 0.5;
        float g = clamp(dot(uv, dir) / (0.5 * (abs(dir.x) + abs(dir.y))) * 0.5 + 0.5, 0.0, 1.0);
        vec4 b = mix(c0, c1, g) * line;
        c = b + c * (1.0 - b.a);
    }
    if (c.a <= 0.0) discard;
    gl_FragColor = c;
}
"#;

/// What one window's decoration draws, output px and premultiplied colours.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Look {
    rect: [f32; 4],
    radius: f32,
    exponent: f32,
    border: f32,
    c0: [f32; 4],
    c1: [f32; 4],
    dir: [f32; 2],
    shadow: [f32; 4],
    range: f32,
    offset: f32,
    power: f32,
}

#[derive(Debug, Clone)]
pub struct DecorElement {
    id: Id,
    commit: CommitCounter,
    /// Every pixel it may touch: the box grown by the line and the shadow.
    geometry: Rectangle<i32, Physical>,
    look: Look,
}

/// The element's id and what it last drew, kept on the window's surface.
#[derive(Default)]
struct DecorMemo(RefCell<Option<(Id, CommitCounter, String)>>);

impl DecorElement {
    /// The decoration of the window whose box is `frame` (output px, its title bar included),
    /// focused or not; None when the config draws neither line nor shadow.
    pub fn new(
        surface: &WlSurface,
        frame: Rectangle<f64, Physical>,
        radius: f64,
        active: bool,
        cfg: &WindowsConfig,
        scale: Scale<f64>,
    ) -> Option<Self> {
        let s = scale.x;
        let b = &cfg.border;
        let (c0, c1) = if active {
            (parse_color(&b.active[0]), parse_color(&b.active[1]))
        } else {
            let c = parse_color(&b.inactive);
            (c, c)
        };
        let border = if b.width > 0.0 && c0.is_some() { (b.width * s) as f32 } else { 0.0 };
        let sh = if active { &cfg.shadow.active } else { &cfg.shadow.inactive };
        let shadow = parse_color(&sh.color).filter(|_| cfg.shadow.enabled && sh.range > 0.0).unwrap_or([0.0; 4]);
        if border <= 0.0 && shadow[3] <= 0.0 {
            return None;
        }
        let angle = b.angle.to_radians();
        let look = Look {
            rect: [frame.loc.x as f32, frame.loc.y as f32, frame.size.w as f32, frame.size.h as f32],
            radius: radius as f32,
            exponent: cfg.rounding_power as f32,
            border,
            c0: c0.unwrap_or([0.0; 4]),
            c1: c1.unwrap_or([0.0; 4]),
            dir: [angle.cos() as f32, angle.sin() as f32],
            shadow,
            range: (sh.range * s) as f32,
            offset: (sh.offset * s) as f32,
            power: cfg.shadow.power as f32,
        };
        let reach = border.max(if shadow[3] > 0.0 { look.range + look.offset.abs() } else { 0.0 }) as f64 + 1.0;
        let geometry = Rectangle::new(
            (frame.loc.x - reach, frame.loc.y - reach).into(),
            (frame.size.w + 2.0 * reach, frame.size.h + 2.0 * reach).into(),
        )
        .to_i32_up::<i32>();
        let key = format!("{look:?}");
        let (id, commit) = with_states(surface, |states| {
            let memo = states.data_map.get_or_insert(DecorMemo::default);
            let mut memo = memo.0.borrow_mut();
            let entry = memo.get_or_insert_with(|| (Id::new(), CommitCounter::default(), key.clone()));
            if entry.2 != key {
                entry.1.increment();
                entry.2 = key;
            }
            (entry.0.clone(), entry.1)
        });
        Some(Self { id, commit, geometry, look })
    }

    fn draw_gles(
        &self,
        frame: &mut smithay::backend::renderer::gles::GlesFrame<'_, '_>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
    ) -> Result<(), GlesError> {
        let projection = *frame.projection();
        let user_data = frame.egl_context().user_data() as *const UserDataMap;
        let l = self.look;
        // `dst` is where the element's geometry lands: the box keeps its offset in it (a
        // recording of a region draws the scene elsewhere than the screen does).
        let rect = [
            dst.loc.x as f32 + (l.rect[0] - self.geometry.loc.x as f32),
            dst.loc.y as f32 + (l.rect[1] - self.geometry.loc.y as f32),
            l.rect[2],
            l.rect[3],
        ];
        frame.with_context(|gl| unsafe {
            // Safety: the EGL context outlives this frame, and its user data with it.
            let progs = glass_gl::programs(gl, &*user_data);
            let p = &progs.decor;
            let fb = glass_gl::fb_size(gl);
            gl.Enable(ffi::BLEND);
            gl.BlendFunc(ffi::ONE, ffi::ONE_MINUS_SRC_ALPHA);
            gl.BindBuffer(ffi::ARRAY_BUFFER, progs.vbo);
            gl.UseProgram(p.id);
            gl.EnableVertexAttribArray(p.pos);
            gl.VertexAttribPointer(p.pos, 2, ffi::FLOAT, ffi::FALSE, 0, std::ptr::null());
            gl.UniformMatrix3fv(p.loc(gl, c"projection"), 1, ffi::FALSE, projection.as_ptr());
            gl.Uniform2f(p.loc(gl, c"fb_size"), fb.0 as f32, fb.1 as f32);
            gl.Uniform4f(p.loc(gl, c"rect"), rect[0], rect[1], rect[2], rect[3]);
            gl.Uniform1f(p.loc(gl, c"radius"), l.radius);
            gl.Uniform1f(p.loc(gl, c"exponent"), l.exponent);
            gl.Uniform1f(p.loc(gl, c"border"), l.border);
            gl.Uniform4f(p.loc(gl, c"c0"), l.c0[0], l.c0[1], l.c0[2], l.c0[3]);
            gl.Uniform4f(p.loc(gl, c"c1"), l.c1[0], l.c1[1], l.c1[2], l.c1[3]);
            gl.Uniform2f(p.loc(gl, c"dir"), l.dir[0], l.dir[1]);
            gl.Uniform4f(p.loc(gl, c"shadow"), l.shadow[0], l.shadow[1], l.shadow[2], l.shadow[3]);
            gl.Uniform1f(p.loc(gl, c"range"), l.range);
            gl.Uniform1f(p.loc(gl, c"offset"), l.offset);
            gl.Uniform1f(p.loc(gl, c"power"), l.power);
            // Never the inside of the box, where every pixel would be discarded: a video
            // playing in the window damages it every frame.
            let r = l.radius.ceil() as i32 + 1;
            let inner = Rectangle::<i32, Physical>::new(
                (rect[0].ceil() as i32 + 1, rect[1].ceil() as i32 + r).into(),
                ((rect[2] as i32 - 2).max(0), (rect[3] as i32 - 2 * r).max(0)).into(),
            );
            for d in damage {
                let q = Rectangle::new(d.loc + dst.loc, d.size);
                for q in q.subtract_rect(inner) {
                    gl.Uniform4f(p.loc(gl, c"dst_rect"), q.loc.x as f32, q.loc.y as f32, q.size.w as f32, q.size.h as f32);
                    gl.DrawArrays(ffi::TRIANGLE_STRIP, 0, 4);
                }
            }
            gl.DisableVertexAttribArray(p.pos);
            gl.BindBuffer(ffi::ARRAY_BUFFER, 0);
            gl.UseProgram(0);
        })
    }
}

impl Element for DecorElement {
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

impl<R: HyaloRenderer> RenderElement<R> for DecorElement {
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
