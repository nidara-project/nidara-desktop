//! A window's controls, drawn by Hyalo over the app's header where the app reserved room for
//! them (protocols/window_controls.rs, #708 point 5): one capsule of three buttons — the shape
//! of the back/forward pair in Settings' header. Painted in one pass by a shader of ours, in
//! output pixels: the capsule, its inset edge, the hovered button's fill (close's red), and the
//! three glyphs, all anti-aliased at the output's scale. The colours are the mockup's, the
//! owner's choice (2026-10-03): white over whatever the header is, like the pair beside it.

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
use crate::protocols::window_controls::Button;

pub const FS_CONTROLS: &str = r#"#version 100
precision highp float;
uniform vec4 rect;      // the capsule, output px
uniform float px;       // output px per logical px
uniform vec3 glyphs;    // per slot, left to right: 0 minimize, 1 maximize, 2 close
uniform vec3 enabled;   // per slot: 1 does something
uniform float hover;    // the slot under the pointer, -1 none
uniform float pressed;  // 1 while that button is held
uniform float active;   // 1: the window has the focus
varying vec2 v_out;
varying vec2 v_fb;
float box(vec2 p, vec2 h, float r) {
    vec2 q = abs(p) - h + vec2(r);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float seg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// A glyph's distance, logical px from the slot's centre: a 14 px icon, strokes 1.6 wide.
float glyph(float g, vec2 p) {
    if (g < 0.5) return seg(p, vec2(-3.5, 0.0), vec2(3.5, 0.0)) - 0.8;
    if (g < 1.5) return abs(box(p, vec2(3.7), 1.6)) - 0.8;
    return min(seg(p, vec2(-3.0, -3.0), vec2(3.0, 3.0)), seg(p, vec2(3.0, -3.0), vec2(-3.0, 3.0))) - 0.8;
}
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }
void main() {
    vec2 size = rect.zw / px;
    vec2 p = (v_out - rect.xy) / px;
    float d = box(p - size * 0.5, size * 0.5, size.y * 0.5);
    float inside = clamp(0.5 - d * px, 0.0, 1.0);
    if (inside <= 0.0) discard;
    float bw = size.x / 3.0;
    float slot = clamp(floor(p.x / bw), 0.0, 2.0);
    float g = slot < 0.5 ? glyphs.x : (slot < 1.5 ? glyphs.y : glyphs.z);
    float en = slot < 0.5 ? enabled.x : (slot < 1.5 ? enabled.y : enabled.z);
    bool on = active > 0.5;
    vec4 c = vec4(1.0) * (on ? 0.08 : 0.04);
    // The inset edge: one physical pixel inside the rim.
    c = over(vec4(1.0) * 0.07 * clamp(1.0 - abs(d * px + 0.5), 0.0, 1.0), c);
    bool hov = abs(slot - hover) < 0.5 && en > 0.5;
    if (hov) {
        vec4 fill = vec4(1.0) * (pressed > 0.5 ? 0.20 : 0.14);
        if (g > 1.5) fill = pressed > 0.5 ? vec4(0.69, 0.16, 0.18, 1.0) : vec4(0.82, 0.20, 0.22, 1.0);
        c = over(fill, c);
    }
    float ga = clamp(0.5 - glyph(g, p - vec2((slot + 0.5) * bw, size.y * 0.5)) * px, 0.0, 1.0);
    float ink = en < 0.5 ? 0.30 : (hov ? 1.0 : (on ? 0.80 : 0.36));
    c = over(vec4(1.0) * ink * ga, c);
    gl_FragColor = c * inside;
}
"#;

/// What the capsule shows: its buttons left to right, which do anything, the one under the
/// pointer and whether it is held, and whether its window has the focus.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Controls {
    pub buttons: [Button; 3],
    pub enabled: [bool; 3],
    pub hover: Option<usize>,
    pub pressed: bool,
    pub active: bool,
}

#[derive(Debug, Clone)]
pub struct ControlsElement {
    id: Id,
    commit: CommitCounter,
    /// The capsule, output px (exact), and the pixels it touches.
    rect: Rectangle<f64, Physical>,
    geometry: Rectangle<i32, Physical>,
    scale: f64,
    controls: Controls,
}

/// The element's id and what it last drew, kept on the window's surface.
#[derive(Default)]
struct ControlsMemo(RefCell<Option<(Id, CommitCounter, String)>>);

impl ControlsElement {
    pub fn new(surface: &WlSurface, rect: Rectangle<f64, Physical>, scale: Scale<f64>, controls: Controls) -> Self {
        let key = format!("{rect:?} {controls:?}");
        let (id, commit) = with_states(surface, |states| {
            let memo = states.data_map.get_or_insert(ControlsMemo::default);
            let mut memo = memo.0.borrow_mut();
            let entry = memo.get_or_insert_with(|| (Id::new(), CommitCounter::default(), key.clone()));
            if entry.2 != key {
                entry.1.increment();
                entry.2 = key;
            }
            (entry.0.clone(), entry.1)
        });
        let geometry = rect.to_i32_up::<i32>();
        Self { id, commit, rect, geometry, scale: scale.x, controls }
    }

    fn draw_gles(
        &self,
        frame: &mut smithay::backend::renderer::gles::GlesFrame<'_, '_>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
    ) -> Result<(), GlesError> {
        let projection = *frame.projection();
        let user_data = frame.egl_context().user_data() as *const UserDataMap;
        let c = self.controls;
        let glyphs = c.buttons.map(Button::glyph);
        let enabled = c.enabled.map(|e| if e { 1.0f32 } else { 0.0 });
        // `dst` is where the element's geometry lands: the capsule keeps its offset in it.
        let off = (self.rect.loc.x - self.geometry.loc.x as f64, self.rect.loc.y - self.geometry.loc.y as f64);
        let rect = [
            (dst.loc.x as f64 + off.0) as f32,
            (dst.loc.y as f64 + off.1) as f32,
            self.rect.size.w as f32,
            self.rect.size.h as f32,
        ];
        frame.with_context(|gl| unsafe {
            // Safety: the EGL context outlives this frame, and its user data with it.
            let progs = glass_gl::programs(gl, &*user_data);
            let p = &progs.controls;
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
            gl.Uniform1f(p.loc(gl, c"px"), self.scale as f32);
            gl.Uniform3f(p.loc(gl, c"glyphs"), glyphs[0], glyphs[1], glyphs[2]);
            gl.Uniform3f(p.loc(gl, c"enabled"), enabled[0], enabled[1], enabled[2]);
            gl.Uniform1f(p.loc(gl, c"hover"), c.hover.map_or(-1.0, |h| h as f32));
            gl.Uniform1f(p.loc(gl, c"pressed"), if c.pressed { 1.0 } else { 0.0 });
            gl.Uniform1f(p.loc(gl, c"active"), if c.active { 1.0 } else { 0.0 });
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

impl Element for ControlsElement {
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

impl<R: HyaloRenderer> RenderElement<R> for ControlsElement {
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
