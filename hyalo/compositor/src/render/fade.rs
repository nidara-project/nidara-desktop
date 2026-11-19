//! The window's background faded over one of its layers (`nidara-material-v1`
//! `set_background_fade`, #1148 point 11): a title bar's veil over the content scrolled under
//! it. The client paints none of it, so it is always the background Hyalo paints for the window
//! (render/decor.rs), at the same level: opaque, tinted or translucent alike. Drawn in front of
//! the layer's glass and behind the layer's own buffer, cut to the window's corners.

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

pub const FS_FADE: &str = r#"#version 100
precision highp float;
uniform vec4 rect;        // the fade's box, output px
uniform vec4 outer;       // the window's box, output px
uniform float radius;     // its corners, output px
uniform vec4 fill;        // the window's background, premultiplied, at its level
uniform float top;        // the strength at the box's top edge
uniform float bottom;     // and at its bottom edge
varying vec2 v_out;
varying vec2 v_fb;
void main() {
    float t = clamp((v_out.y - rect.y) / max(rect.w, 1.0), 0.0, 1.0);
    vec2 h = outer.zw * 0.5;
    float inside = clamp(0.5 - corner_sdf(v_out - outer.xy - h, h, radius), 0.0, 1.0);
    vec4 c = fill * mix(top, bottom, t) * inside;
    if (c.a <= 0.0) discard;
    gl_FragColor = c;
}
"#;

#[derive(Debug, Clone, Copy, PartialEq)]
struct Look {
    rect: [f32; 4],
    outer: [f32; 4],
    radius: f32,
    fill: [f32; 4],
    top: f32,
    bottom: f32,
}

#[derive(Debug, Clone)]
pub struct FadeElement {
    id: Id,
    commit: CommitCounter,
    geometry: Rectangle<i32, Physical>,
    look: Look,
}

/// The element's id and what it last drew, kept on the layer's surface.
#[derive(Default)]
struct FadeMemo(RefCell<Option<(Id, CommitCounter, String)>>);

impl FadeElement {
    /// `fill` (premultiplied, the window's background at its level) over `rect` (output px),
    /// `top` to `bottom` strength; None when it would draw nothing.
    pub fn new(layer: &WlSurface, rect: Rectangle<f64, Physical>, fill: [f32; 4], [top, bottom]: [f64; 2]) -> Option<Self> {
        if fill[3] <= 0.0 || (top <= 0.0 && bottom <= 0.0) || rect.size.w <= 0.0 || rect.size.h <= 0.0 {
            return None;
        }
        let r = [rect.loc.x as f32, rect.loc.y as f32, rect.size.w as f32, rect.size.h as f32];
        let look = Look { rect: r, outer: r, radius: 0.0, fill, top: top as f32, bottom: bottom as f32 };
        let geometry = rect.to_i32_up::<i32>();
        let key = format!("{look:?}");
        let (id, commit) = with_states(layer, |states| {
            let memo = states.data_map.get_or_insert(FadeMemo::default);
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

    /// Cut to the window's box and corners, as its layer's surface and glass are.
    pub fn rounded_to(mut self, outer: glass_gl::Outer) -> Self {
        let o = outer.rect;
        self.look.outer = [o.loc.x as f32, o.loc.y as f32, o.size.w as f32, o.size.h as f32];
        self.look.radius = outer.radius as f32;
        self
    }

    /// Fading in or out with its layer.
    pub fn with_alpha(mut self, alpha: f64) -> Self {
        self.look.fill = self.look.fill.map(|c| c * alpha as f32);
        self
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
        // `dst` is where the element's geometry lands: both boxes keep their offset in it.
        let (dx, dy) = (dst.loc.x as f32 - self.geometry.loc.x as f32, dst.loc.y as f32 - self.geometry.loc.y as f32);
        let rect = [l.rect[0] + dx, l.rect[1] + dy, l.rect[2], l.rect[3]];
        let outer = [l.outer[0] + dx, l.outer[1] + dy, l.outer[2], l.outer[3]];
        frame.with_context(|gl| unsafe {
            // Safety: the EGL context outlives this frame, and its user data with it.
            let progs = glass_gl::programs(gl, &*user_data);
            let p = &progs.fade;
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
            gl.Uniform4f(p.loc(gl, c"outer"), outer[0], outer[1], outer[2], outer[3]);
            gl.Uniform1f(p.loc(gl, c"radius"), l.radius);
            gl.Uniform4f(p.loc(gl, c"fill"), l.fill[0], l.fill[1], l.fill[2], l.fill[3]);
            gl.Uniform1f(p.loc(gl, c"top"), l.top);
            gl.Uniform1f(p.loc(gl, c"bottom"), l.bottom);
            for d in damage {
                gl.Uniform4f(p.loc(gl, c"dst_rect"), (d.loc.x + dst.loc.x) as f32, (d.loc.y + dst.loc.y) as f32, d.size.w as f32, d.size.h as f32);
                gl.DrawArrays(ffi::TRIANGLE_STRIP, 0, 4);
            }
            gl.DisableVertexAttribArray(p.pos);
            gl.BindBuffer(ffi::ARRAY_BUFFER, 0);
            gl.UseProgram(0);
        })
    }
}

impl Element for FadeElement {
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

impl<R: HyaloRenderer> RenderElement<R> for FadeElement {
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
