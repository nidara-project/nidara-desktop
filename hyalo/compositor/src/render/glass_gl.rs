//! The glass in raw GL, inside the frame being drawn (`GlesFrame::with_context`, public API).
//!
//! Two halves, because Smithay's damage tracker calls them separately (`render/glass.rs`):
//!
//! - **capture**, only when something behind the glass changed: copy the region under the
//!   shapes out of the frame (glCopyTexSubImage2D), then dual-kawase down and up through a
//!   pyramid of textures owned by this glass, stopping one level short of full size.
//! - **draw**, whenever the glass's own area is damaged: the last up-sample, straight into the
//!   frame, cut to each shape by its signed distance — and, with refractive glass, refracted,
//!   saturated, tinted per pixel and lit along the rim.
//!
//! Driving the passes through Smithay's `bind`/`render`/`finish` instead cost a framebuffer
//! object and an EGL fence + flush PER PASS: measured 2.7× Hyprland's blur in the prototype
//! (#679), 0.65× once the passes became plain draws between framebuffers kept alive.
//!
//! Coordinates: shapes and damage come in OUTPUT pixels (y down, before the output's
//! transform). The frame maps those to the framebuffer with Smithay's own projection, so the
//! final pass uses that same matrix and every rotation or flip of an output is handled once,
//! there. The captured copy lives in framebuffer orientation; the blur is isotropic, so the
//! pyramid does not care.
//!
//! ⚠️ glCopyTexSubImage2D copies into an RGB texture, which every 8-bit framebuffer (with or
//! without alpha) can feed. A 10-bit framebuffer would need a 10-bit texture; the DRM backend
//! asks for 8-bit formats only for that reason.

use std::{cell::RefCell, rc::Rc};

use smithay::{
    backend::renderer::gles::ffi::{self, Gles2},
    reexports::wayland_server::{Weak, protocol::wl_surface::WlSurface},
    utils::{Physical, Rectangle},
};

const VS_PASS: &str = r#"#version 100
precision highp float;
attribute vec2 pos;          // unit quad
uniform vec4 dst_rect;       // target pixels: x, y, w, h
uniform vec2 target_size;
varying vec2 v_px;
void main() {
    vec2 px = dst_rect.xy + pos * dst_rect.zw;
    v_px = px;
    gl_Position = vec4(px / target_size * 2.0 - 1.0, 0.0, 1.0);
}
"#;

const FS_DOWN: &str = r#"#version 100
precision highp float;
uniform sampler2D tex;
uniform vec2 src_size;   // the sampled texture's full size
uniform vec2 src_used;   // the part of it this capture wrote
uniform float offset;
varying vec2 v_px;
vec4 tap(vec2 uv) { return texture2D(tex, clamp(uv, 0.5 / src_size, (src_used - 0.5) / src_size)); }
void main() {
    vec2 uv = v_px * 2.0 / src_size;
    vec2 o = offset / src_size;
    vec4 sum = tap(uv) * 4.0;
    sum += tap(uv - o);
    sum += tap(uv + o);
    sum += tap(uv + vec2(o.x, -o.y));
    sum += tap(uv - vec2(o.x, -o.y));
    gl_FragColor = sum / 8.0;
}
"#;

const UP_COMMON: &str = r#"
uniform sampler2D tex;
uniform vec2 src_size;
uniform vec2 src_used;
uniform float offset;
vec4 tap(vec2 uv) { return texture2D(tex, clamp(uv, 0.5 / src_size, (src_used - 0.5) / src_size)); }
// The up-sample's taps sit a quarter and a half of a SOURCE texel per unit of offset: the
// half-pixel of the destination, as dual kawase has it and as Hyprland's blur2 does. Until
// 2026-10-02 they sat 1 and 2 texels out — four times as far — and a given size:passes
// blurred over twice as wide as the same numbers on Hyprland (a step edge, 10-90 %: 2:2 was
// 28 px against 12), which is what the owner saw: "1:2 here blurs more than Hyprland's 2:2".
// The numbers are shared with Hyprland (`GLASS_BLUR`), so they must mean the same blur.
vec4 up(vec2 src_px) {
    vec2 uv = src_px / src_size;
    vec2 o = 0.25 * offset / src_size;
    vec4 sum = tap(uv + vec2(-o.x * 2.0, 0.0));
    sum += tap(uv + vec2(-o.x, o.y)) * 2.0;
    sum += tap(uv + vec2(0.0, o.y * 2.0));
    sum += tap(uv + vec2(o.x, o.y)) * 2.0;
    sum += tap(uv + vec2(o.x * 2.0, 0.0));
    sum += tap(uv + vec2(o.x, -o.y)) * 2.0;
    sum += tap(uv + vec2(0.0, -o.y * 2.0));
    sum += tap(uv + vec2(-o.x, -o.y)) * 2.0;
    return sum / 12.0;
}
"#;

const FS_UP_MAIN: &str = r#"
varying vec2 v_px;
void main() { gl_FragColor = up(v_px * 0.5); }
"#;

const VS_FINAL: &str = r#"#version 100
precision highp float;
attribute vec2 pos;
uniform vec4 dst_rect;       // output pixels
uniform mat3 projection;     // Smithay's: output pixels → clip space
uniform vec2 fb_size;
varying vec2 v_out;
varying vec2 v_fb;
void main() {
    vec2 px = dst_rect.xy + pos * dst_rect.zw;
    v_out = px;
    vec3 ndc = projection * vec3(px, 1.0);
    v_fb = (ndc.xy + 1.0) * 0.5 * fb_size;
    gl_Position = vec4(ndc.xy, 0.0, 1.0);
}
"#;

const FS_FINAL_MAIN: &str = r#"
uniform vec4 region_fb;     // the captured region, framebuffer pixels
uniform mat2 out_to_fb;     // output-pixel offsets → framebuffer-pixel offsets
uniform vec4 rect;          // the shape, output pixels
uniform float radius;
uniform float exponent;
uniform float opacity;      // the whole glass in this shape, over the plain backdrop
uniform vec4 clip;          // what of the shape may show, output px: x, y, w, h
uniform float glass;        // 1: refractive glass — the compositor paints the whole glass
uniform vec3 tint;
uniform float alpha_min;
uniform float alpha_max;
uniform float target;
uniform float refraction;   // output px
uniform float rim;
uniform float saturation;
uniform float ink_dark;     // 1: this shape holds dark content (the ink event)
uniform vec3 ink_tint;
uniform float has_pointer;  // 1: a pointer is spliced into the shape (a tooltip, a menu)
uniform vec2 ptr_a;         // the pointer's triangle, inset by its tip radius, output px
uniform vec2 ptr_b;
uniform vec2 ptr_t;
uniform float ptr_tip_r;
uniform float ptr_base_r;
varying vec2 v_out;
varying vec2 v_fb;

// The shape's signed distance, output pixels: negative inside.
float sdf(vec2 px) {
    vec2 p = px - rect.xy;
    vec2 half_size = rect.zw * 0.5;
    vec2 q = abs(p - half_size);
    vec2 inner = half_size - vec2(radius);
    if (q.x > inner.x && q.y > inner.y && radius > 0.0) {
        vec2 k = (q - inner) / radius;
        return (pow(pow(k.x, exponent) + pow(k.y, exponent), 1.0 / exponent) - 1.0) * radius;
    }
    return max(q.x - half_size.x, q.y - half_size.y);
}

// WCAG relative luminance of an sRGB-encoded colour (glass-legibility.ts's `luminance`).
float to_linear(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float luminance(vec3 c) {
    return 0.2126 * to_linear(c.r) + 0.7152 * to_linear(c.g) + 0.0722 * to_linear(c.b);
}

// A triangle's signed distance (Inigo Quilez's, exact): negative inside, either winding.
float sd_triangle(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
    vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
    vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
    vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                     vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
}

// The whole silhouette: the shape, and its pointer if it has one — the inset triangle grown
// back by the tip radius (a round tip, straight sides where they were), joined to the body
// by a concave arc of the base radius (hg_sdf's round union).
float shape_sdf(vec2 px) {
    float d = sdf(px);
    if (has_pointer > 0.5) {
        float p = sd_triangle(px, ptr_a, ptr_b, ptr_t) - ptr_tip_r;
        vec2 u = max(vec2(ptr_base_r - d, ptr_base_r - p), vec2(0.0));
        d = max(ptr_base_r, min(d, p)) - length(u);
    }
    return d;
}

// Framebuffer pixels → the blurred copy (level 1, half size).
vec2 to_src(vec2 fb_px) { return (fb_px - region_fb.xy) * 0.5; }
vec4 backdrop(vec2 out_offset) { return up(to_src(v_fb + out_to_fb * out_offset)); }

void main() {
    float d = shape_sdf(v_out);
    // Cut straight where the clip ends (a list scrolled under its edge), anti-aliased.
    vec2 cin = min(v_out - clip.xy, clip.xy + clip.zw - v_out);
    float clipped = clamp(min(cin.x, cin.y) + 0.5, 0.0, 1.0);
    float cov = clamp(0.5 - d, 0.0, 1.0) * clipped * opacity;
    if (cov <= 0.0) discard;
    if (glass < 0.5) {
        vec4 c = backdrop(vec2(0.0));
        gl_FragColor = vec4(c.rgb * cov, cov);
        return;
    }

    // ── Refractive glass ──────────────────────────────────────────────────
    // The outward normal, from the distance field.
    vec2 n = vec2(shape_sdf(v_out + vec2(1.0, 0.0)) - shape_sdf(v_out - vec2(1.0, 0.0)),
                  shape_sdf(v_out + vec2(0.0, 1.0)) - shape_sdf(v_out - vec2(0.0, 1.0)));
    n = length(n) > 0.0001 ? normalize(n) : vec2(0.0);
    float inside = max(-d, 0.0);
    // Refraction: within a band along the edge the backdrop is read from further OUT, more so
    // the closer to the edge — the rim of a lens gathering what lies beyond it.
    float band = max(min(radius, min(rect.z, rect.w) * 0.5), 1.0);
    float t = clamp(inside / band, 0.0, 1.0);
    float bend = (1.0 - t) * (1.0 - t) * refraction;
    vec2 off = n * bend;
    // A little dispersion in the bend: red bends least, blue most.
    vec3 bg = vec3(backdrop(off * 0.92).r, backdrop(off).g, backdrop(off * 1.08).b);
    // Vibrancy: the backdrop's colour, a little stronger.
    float l = dot(bg, vec3(0.2126, 0.7152, 0.0722));
    bg = clamp(mix(vec3(l), bg, saturation), 0.0, 1.0);
    l = dot(bg, vec3(0.2126, 0.7152, 0.0722));
    // The tint thickens exactly where the backdrop is too bright for white content:
    // after tinting, the luminance does not exceed target (per pixel; #673's rule, on the GPU).
    // target is a WCAG relative luminance — LINEAR light — while the tint is mixed into the
    // encoded colour, so the least alpha is searched for, not solved for. Comparing the
    // ENCODED luma with it darkened a white backdrop to 10:1 where 4.5:1 was asked (owner-
    // caught 2026-10-01: "with a white background everything looks dark").
    vec3 c;
    if (ink_dark > 0.5) {
        // Dark content (the ink event): the backdrop under it is bright everywhere, so the
        // glass stops darkening it for white content — a light veil instead.
        c = mix(bg, ink_tint, alpha_min);
    } else {
        float a = 0.0;
        if (luminance(bg) > target) {
            float lo = 0.0;
            float hi = alpha_max;
            for (int i = 0; i < 8; i++) {
                float m = 0.5 * (lo + hi);
                if (luminance(mix(bg, tint, m)) > target) lo = m; else hi = m;
            }
            a = hi;
        }
        a = clamp(a, alpha_min, alpha_max);
        c = mix(bg, tint, a);
    }
    // Specular rim: a thin line of light along the edge, brightest where the edge faces the
    // light (top-left), a softer echo on the opposite side.
    vec2 light = normalize(vec2(-0.55, -0.85));
    float edge = 1.0 - smoothstep(0.0, 1.6, inside);
    float facing = max(dot(n, light), 0.0);
    float back = max(dot(n, -light), 0.0);
    float spec = edge * (0.18 + 0.82 * facing * facing + 0.35 * back) * rim;
    // And a faint inner glow, wider, so the edge reads as thickness, not as a stroke.
    float glow = (1.0 - smoothstep(0.0, band * 0.6, inside)) * (0.10 + 0.25 * facing) * rim;
    c = c + (spec + glow) * (1.0 - c);
    gl_FragColor = vec4(c * cov, cov);
}
"#;

/// The darkest and brightest WCAG luminance under one box (`nidara-material-v1` v3, v5), from
/// the blurred backdrop as the glass treats it before its tint: blurred and saturated. A grid
/// of samples is enough because the backdrop is blurred: nothing narrower than the blur
/// survives it. `unscale` divides out the shadow under the box (v5: what the backdrop is
/// without it; 1 for an ink box, whose question is what the content sits on now). Each is
/// written as two bytes (high, low) so 8-bit readback keeps ~16 bits of it: the darkest in
/// red and green, the brightest in blue and alpha.
const FS_INK: &str = r#"#version 100
precision highp float;
uniform sampler2D tex;
uniform vec2 src_size;
uniform vec2 src_used;
uniform vec4 box_src;       // the box in the blurred texture's pixels: x0, y0, x1, y1
uniform float saturation;
uniform float unscale;
varying vec2 v_px;
float to_linear(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float luminance(vec3 c) {
    return 0.2126 * to_linear(c.r) + 0.7152 * to_linear(c.g) + 0.0722 * to_linear(c.b);
}
void main() {
    float m = 1.0;
    float n = 0.0;
    for (int j = 0; j < 12; j++) {
        for (int i = 0; i < 12; i++) {
            vec2 p = mix(box_src.xy, box_src.zw, (vec2(float(i), float(j)) + 0.5) / 12.0);
            vec3 c = texture2D(tex, clamp(p / src_size, 0.5 / src_size, (src_used - 0.5) / src_size)).rgb;
            c = min(c * unscale, vec3(1.0));
            float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
            c = clamp(mix(vec3(l), c, saturation), 0.0, 1.0);
            float y = luminance(c);
            m = min(m, y);
            n = max(n, y);
        }
    }
    gl_FragColor = vec4(floor(m * 255.0) / 255.0, fract(m * 255.0), floor(n * 255.0) / 255.0, fract(n * 255.0));
}
"#;

/// One ink box (`nidara-material-v1` v3), output pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InkBox {
    pub id: u32,
    pub rect: Rectangle<f64, Physical>,
}

/// Where the backdrop under one shape is measured for its shadow (v5), output pixels: the
/// shape's body, inset where a round corner leaves it, and how much of it the shadow already
/// takes (1 / (1 − the shadow's opacity there)).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct LightProbe {
    pub shape: usize,
    pub rect: Rectangle<f64, Physical>,
    pub unscale: f32,
}

/// The most ink boxes measured in one glass at once, and the most shapes: together, the width
/// of the measurement's target.
pub const MAX_INK_BOXES: usize = 64;
pub const MAX_LIGHT_PROBES: usize = 64;
const MEASURE_WIDTH: usize = MAX_INK_BOXES + MAX_LIGHT_PROBES;

/// A shape in output pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    /// Its index in the material's shapes (the shadow's measurement is by shape, v5).
    pub index: usize,
    pub rect: Rectangle<f64, Physical>,
    pub radius: f64,
    pub exponent: f64,
    /// The glass's opacity in this shape over the plain backdrop, 0..1.
    pub opacity: f32,
    /// What of the shape may show, output pixels. None = all of it.
    pub clip: Option<Rectangle<f64, Physical>>,
    /// It holds an ink group whose content is dark (v3): the light veil, not the dark tint.
    pub ink_dark: bool,
    /// A pointer spliced into it (v3).
    pub pointer: Option<PointerPx>,
    /// How far its edge reads the backdrop from outside it, output pixels: the glass's
    /// refraction, or more on a large shape (`set_lensing`, v4). 0 where there is no glass.
    pub refraction: f64,
}

impl Shape {
    /// Everything it covers: the shape, and its pointer.
    pub fn bounds(&self) -> Rectangle<f64, Physical> {
        match &self.pointer {
            Some(p) => self.rect.merge(p.bounds),
            None => self.rect,
        }
    }
}

/// A pointer in output pixels, ready for the shader: its triangle inset by the tip radius.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PointerPx {
    pub a: [f64; 2],
    pub b: [f64; 2],
    pub t: [f64; 2],
    pub tip_radius: f64,
    pub base_radius: f64,
    /// The whole pointer, base join included.
    pub bounds: Rectangle<f64, Physical>,
}

impl PointerPx {
    /// From the protocol's description: the base centred on `base`, `width` wide, the tip at
    /// `tip`. The triangle's base is pushed `base_radius` into the shape along its own sides,
    /// so its two base corners are inside the body and only the concave join shows; then
    /// every corner is inset by the tip radius (the shader grows it back, rounding the tip).
    pub fn new(base: [f64; 2], tip: [f64; 2], width: f64, tip_radius: f64, base_radius: f64) -> Option<Self> {
        let (dx, dy) = (tip[0] - base[0], tip[1] - base[1]);
        let h = dx.hypot(dy);
        if h <= 0.0 || width <= 0.0 {
            return None;
        }
        let u = [dx / h, dy / h];
        let v = [-u[1], u[0]];
        let e = base_radius;
        let half = width / 2.0 * (h + e) / h;
        let bc = [base[0] - u[0] * e, base[1] - u[1] * e];
        let a = [bc[0] - v[0] * half, bc[1] - v[1] * half];
        let b = [bc[0] + v[0] * half, bc[1] + v[1] * half];
        let t = tip;
        // The inradius bounds how far a corner can be rounded.
        let side = |p: [f64; 2], q: [f64; 2]| (q[0] - p[0]).hypot(q[1] - p[1]);
        let (la, lb, lc) = (side(b, t), side(a, t), side(a, b));
        let area = ((b[0] - a[0]) * (t[1] - a[1]) - (t[0] - a[0]) * (b[1] - a[1])).abs() / 2.0;
        let inradius = 2.0 * area / (la + lb + lc);
        let r = tip_radius.min(inradius * 0.9);
        let inset = |p: [f64; 2], q: [f64; 2], s: [f64; 2]| {
            let n1 = side(p, q);
            let n2 = side(p, s);
            let d1 = [(q[0] - p[0]) / n1, (q[1] - p[1]) / n1];
            let d2 = [(s[0] - p[0]) / n2, (s[1] - p[1]) / n2];
            let half_angle = (d1[0] * d2[0] + d1[1] * d2[1]).clamp(-1.0, 1.0).acos() / 2.0;
            let bis = [d1[0] + d2[0], d1[1] + d2[1]];
            let nb = bis[0].hypot(bis[1]);
            let k = r / half_angle.sin().max(1e-6) / nb.max(1e-9);
            [p[0] + bis[0] * k, p[1] + bis[1] * k]
        };
        let pad = base_radius + 1.0;
        let xs = [base[0] - v[0] * width / 2.0, base[0] + v[0] * width / 2.0, tip[0]];
        let ys = [base[1] - v[1] * width / 2.0, base[1] + v[1] * width / 2.0, tip[1]];
        let (x0, x1) = (xs.iter().cloned().fold(f64::MAX, f64::min) - pad, xs.iter().cloned().fold(f64::MIN, f64::max) + pad);
        let (y0, y1) = (ys.iter().cloned().fold(f64::MAX, f64::min) - pad, ys.iter().cloned().fold(f64::MIN, f64::max) + pad);
        Some(Self {
            a: inset(a, b, t),
            b: inset(b, t, a),
            t: inset(t, a, b),
            tip_radius: r,
            base_radius,
            bounds: Rectangle::new((x0, y0).into(), (x1 - x0, y1 - y0).into()),
        })
    }
}

/// Refractive glass parameters, in output pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Glass {
    pub tint: [f32; 3],
    pub alpha_min: f32,
    pub alpha_max: f32,
    pub target: f32,
    pub rim: f32,
    pub saturation: f32,
    /// The veil over a shape whose content is dark (`set_ink`).
    pub ink_tint: [f32; 3],
}

pub(super) struct Program {
    pub(super) id: u32,
    pub(super) pos: u32,
}

impl Program {
    pub(super) unsafe fn loc(&self, gl: &Gles2, name: &std::ffi::CStr) -> i32 {
        unsafe { gl.GetUniformLocation(self.id, name.as_ptr()) }
    }
}

/// GL objects that belong to one GL context: compiled once, shared by every glass drawn in
/// it. Kept in the EGL context's user data.
pub(super) struct Programs {
    down: Program,
    up: Program,
    last: Program,
    ink: Program,
    /// The shadow under the glass (v5, render/scrim.rs).
    pub(super) scrim: Program,
    /// The measurement's target: MEASURE_WIDTH × 1, one texel per box. Made on first use.
    ink_target: std::cell::Cell<(u32, u32)>,
    pub(super) vbo: u32,
    /// Textures and framebuffers of glasses that went away, deleted on the next capture: a
    /// cache is dropped where no GL context is current.
    trash: Trash,
}

type Trash = Rc<RefCell<Vec<(u32, u32)>>>;

unsafe fn compile(gl: &Gles2, vs: &str, fs: &str) -> Program {
    unsafe {
        let shader = |kind, src: &str| {
            let s = gl.CreateShader(kind);
            let c = std::ffi::CString::new(src).unwrap();
            gl.ShaderSource(s, 1, &c.as_ptr(), std::ptr::null());
            gl.CompileShader(s);
            let mut ok = 0;
            gl.GetShaderiv(s, ffi::COMPILE_STATUS, &mut ok);
            if ok == 0 {
                let mut buf = vec![0u8; 4096];
                let mut len = 0;
                gl.GetShaderInfoLog(s, 4096, &mut len, buf.as_mut_ptr() as *mut _);
                panic!("glass shader: {}", String::from_utf8_lossy(&buf[..len as usize]));
            }
            s
        };
        let id = gl.CreateProgram();
        let (v, f) = (shader(ffi::VERTEX_SHADER, vs), shader(ffi::FRAGMENT_SHADER, fs));
        gl.AttachShader(id, v);
        gl.AttachShader(id, f);
        gl.LinkProgram(id);
        gl.DeleteShader(v);
        gl.DeleteShader(f);
        let pos = gl.GetAttribLocation(id, c"pos".as_ptr()) as u32;
        Program { id, pos }
    }
}

impl Programs {
    unsafe fn new(gl: &Gles2) -> Self {
        unsafe {
            let header = "#version 100\nprecision highp float;\n";
            let up_fs = format!("{header}{UP_COMMON}{FS_UP_MAIN}");
            let last_fs = format!("{header}{UP_COMMON}{FS_FINAL_MAIN}");
            let mut vbo = 0;
            gl.GenBuffers(1, &mut vbo);
            gl.BindBuffer(ffi::ARRAY_BUFFER, vbo);
            let quad: [f32; 8] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0];
            gl.BufferData(ffi::ARRAY_BUFFER, 32, quad.as_ptr() as *const _, ffi::STATIC_DRAW);
            gl.BindBuffer(ffi::ARRAY_BUFFER, 0);
            Self {
                down: compile(gl, VS_PASS, FS_DOWN),
                up: compile(gl, VS_PASS, &up_fs),
                last: compile(gl, VS_FINAL, &last_fs),
                ink: compile(gl, VS_PASS, FS_INK),
                scrim: compile(gl, VS_FINAL, super::scrim::FS_SCRIM),
                ink_target: Default::default(),
                vbo,
                trash: Default::default(),
            }
        }
    }

    unsafe fn empty_trash(&self, gl: &Gles2) {
        for (tex, fbo) in self.trash.borrow_mut().drain(..) {
            unsafe {
                if fbo != 0 {
                    gl.DeleteFramebuffers(1, &fbo);
                }
                gl.DeleteTextures(1, &tex);
            }
        }
    }
}

struct Level {
    tex: u32,
    /// 0 for level 0, which is only ever copied into.
    fbo: u32,
    w: i32,
    h: i32,
}

/// One glass's captured, blurred backdrop: what `draw` reads until the next capture.
#[derive(Default)]
pub struct Cache {
    levels: Vec<Level>,
    /// The captured region, framebuffer pixels (GL window coordinates).
    region_fb: Rectangle<i32, Physical>,
    passes: usize,
    offset: f32,
    valid: bool,
    trash: Option<Trash>,
    /// Moves at every capture: a measurement is of one capture.
    generation: u64,
    /// What the last measurement was of: the capture, the boxes, the probes, the saturation.
    measured: Option<(u64, Vec<InkBox>, Vec<LightProbe>, f32)>,
}

impl Drop for Cache {
    fn drop(&mut self) {
        if let Some(trash) = &self.trash {
            trash.borrow_mut().extend(self.levels.drain(..).map(|l| (l.tex, l.fbo)));
        }
    }
}

impl Cache {
    unsafe fn ensure(&mut self, gl: &Gles2, size: (i32, i32), levels: usize, trash: &Trash) {
        unsafe {
            let fits = self.levels.first().is_some_and(|l| (l.w, l.h) == size);
            if !fits {
                trash.borrow_mut().extend(self.levels.drain(..).map(|l| (l.tex, l.fbo)));
            }
            self.trash = Some(trash.clone());
            while self.levels.len() < levels {
                let k = self.levels.len() as i32;
                let (w, h) = ((size.0 >> k).max(1), (size.1 >> k).max(1));
                let mut tex = 0;
                gl.GenTextures(1, &mut tex);
                gl.BindTexture(ffi::TEXTURE_2D, tex);
                let format = if k == 0 { ffi::RGB } else { ffi::RGBA };
                gl.TexImage2D(
                    ffi::TEXTURE_2D, 0, format as i32, w, h, 0, format, ffi::UNSIGNED_BYTE, std::ptr::null(),
                );
                for (p, v) in [
                    (ffi::TEXTURE_MIN_FILTER, ffi::LINEAR),
                    (ffi::TEXTURE_MAG_FILTER, ffi::LINEAR),
                    (ffi::TEXTURE_WRAP_S, ffi::CLAMP_TO_EDGE),
                    (ffi::TEXTURE_WRAP_T, ffi::CLAMP_TO_EDGE),
                ] {
                    gl.TexParameteri(ffi::TEXTURE_2D, p, v as i32);
                }
                let mut fbo = 0;
                if k > 0 {
                    gl.GenFramebuffers(1, &mut fbo);
                    gl.BindFramebuffer(ffi::FRAMEBUFFER, fbo);
                    gl.FramebufferTexture2D(ffi::FRAMEBUFFER, ffi::COLOR_ATTACHMENT0, ffi::TEXTURE_2D, tex, 0);
                }
                self.levels.push(Level { tex, fbo, w, h });
            }
        }
    }
}

/// The frame's mapping from output pixels to framebuffer pixels: Smithay's projection
/// (column-major 3×3, output px → clip space) and the framebuffer's size.
#[derive(Debug, Clone, Copy)]
pub struct FrameMap {
    pub projection: [f32; 9],
    pub fb_size: (i32, i32),
}

impl FrameMap {
    pub fn map_point(&self, x: f64, y: f64) -> (f64, f64) {
        let m = &self.projection;
        let nx = m[0] as f64 * x + m[3] as f64 * y + m[6] as f64;
        let ny = m[1] as f64 * x + m[4] as f64 * y + m[7] as f64;
        ((nx + 1.0) * 0.5 * self.fb_size.0 as f64, (ny + 1.0) * 0.5 * self.fb_size.1 as f64)
    }

    /// An output rectangle's bounds in the framebuffer, whole pixels, clamped to it.
    pub fn rect_to_fb(&self, r: Rectangle<i32, Physical>) -> Option<Rectangle<i32, Physical>> {
        let corners = [
            self.map_point(r.loc.x as f64, r.loc.y as f64),
            self.map_point((r.loc.x + r.size.w) as f64, r.loc.y as f64),
            self.map_point(r.loc.x as f64, (r.loc.y + r.size.h) as f64),
            self.map_point((r.loc.x + r.size.w) as f64, (r.loc.y + r.size.h) as f64),
        ];
        let x0 = corners.iter().map(|c| c.0).fold(f64::MAX, f64::min).round().max(0.0) as i32;
        let y0 = corners.iter().map(|c| c.1).fold(f64::MAX, f64::min).round().max(0.0) as i32;
        let x1 = (corners.iter().map(|c| c.0).fold(f64::MIN, f64::max).round() as i32).min(self.fb_size.0);
        let y1 = (corners.iter().map(|c| c.1).fold(f64::MIN, f64::max).round() as i32).min(self.fb_size.1);
        (x1 - x0 >= 2 && y1 - y0 >= 2).then(|| Rectangle::new((x0, y0).into(), (x1 - x0, y1 - y0).into()))
    }

    /// The linear part, for offsets: output px → framebuffer px (column-major 2×2).
    fn linear(&self) -> [f32; 4] {
        let m = &self.projection;
        let (sx, sy) = (self.fb_size.0 as f32 * 0.5, self.fb_size.1 as f32 * 0.5);
        [m[0] * sx, m[1] * sy, m[3] * sx, m[4] * sy]
    }
}

pub(super) unsafe fn programs<'a>(gl: &Gles2, user_data: &'a smithay::utils::user_data::UserDataMap) -> &'a Programs {
    user_data.insert_if_missing(|| unsafe { Programs::new(gl) });
    user_data.get::<Programs>().unwrap()
}

/// The viewport Smithay set up for this frame: the framebuffer's size.
pub unsafe fn fb_size(gl: &Gles2) -> (i32, i32) {
    let mut vp = [0i32; 4];
    unsafe { gl.GetIntegerv(ffi::VIEWPORT, vp.as_mut_ptr()) };
    (vp[2], vp[3])
}

/// Copy `region` (output pixels) out of the frame being drawn and blur it into `cache`.
pub unsafe fn capture(
    gl: &Gles2,
    user_data: &smithay::utils::user_data::UserDataMap,
    map: FrameMap,
    region: Rectangle<i32, Physical>,
    offset: f32,
    passes: usize,
    cache: &mut Cache,
) {
    unsafe {
        let progs = programs(gl, user_data);
        progs.empty_trash(gl);
        cache.valid = false;
        let Some(region_fb) = map.rect_to_fb(region) else { return };
        if passes == 0 {
            return;
        }
        let mut prev_fbo = 0;
        gl.GetIntegerv(ffi::FRAMEBUFFER_BINDING, &mut prev_fbo);
        let mut vp = [0i32; 4];
        gl.GetIntegerv(ffi::VIEWPORT, vp.as_mut_ptr());

        cache.ensure(gl, (region_fb.size.w, region_fb.size.h), passes + 1, &progs.trash);
        cache.region_fb = region_fb;
        cache.generation += 1;
        cache.passes = passes;
        cache.offset = offset;

        // 1. The region, out of the frame, into level 0.
        gl.BindFramebuffer(ffi::FRAMEBUFFER, prev_fbo as u32);
        gl.ActiveTexture(ffi::TEXTURE0);
        gl.BindTexture(ffi::TEXTURE_2D, cache.levels[0].tex);
        gl.CopyTexSubImage2D(
            ffi::TEXTURE_2D, 0, 0, 0, region_fb.loc.x, region_fb.loc.y, region_fb.size.w, region_fb.size.h,
        );

        gl.Disable(ffi::BLEND);
        gl.Disable(ffi::SCISSOR_TEST);
        gl.BindBuffer(ffi::ARRAY_BUFFER, progs.vbo);
        let set_quad = |p: &Program| {
            gl.UseProgram(p.id);
            gl.EnableVertexAttribArray(p.pos);
            gl.VertexAttribPointer(p.pos, 2, ffi::FLOAT, ffi::FALSE, 0, std::ptr::null());
            gl.Uniform1i(p.loc(gl, c"tex"), 0);
            gl.Uniform1f(p.loc(gl, c"offset"), offset);
        };
        let size = region_fb.size;
        let used = |k: usize| ((size.w >> k).max(1), (size.h >> k).max(1));
        let levels = &cache.levels;
        let pass = |p: &Program, src: &Level, src_used: (i32, i32), dst: &Level, dst_used: (i32, i32)| {
            gl.Uniform2f(p.loc(gl, c"src_used"), src_used.0 as f32, src_used.1 as f32);
            gl.BindFramebuffer(ffi::FRAMEBUFFER, dst.fbo);
            gl.Viewport(0, 0, dst.w, dst.h);
            gl.BindTexture(ffi::TEXTURE_2D, src.tex);
            gl.Uniform2f(p.loc(gl, c"src_size"), src.w as f32, src.h as f32);
            gl.Uniform4f(p.loc(gl, c"dst_rect"), 0.0, 0.0, dst_used.0 as f32, dst_used.1 as f32);
            gl.Uniform2f(p.loc(gl, c"target_size"), dst.w as f32, dst.h as f32);
            gl.DrawArrays(ffi::TRIANGLE_STRIP, 0, 4);
        };

        // 2. Down: level 0 → … → level n.
        set_quad(&progs.down);
        for k in 1..=passes {
            pass(&progs.down, &levels[k - 1], used(k - 1), &levels[k], used(k));
        }
        gl.DisableVertexAttribArray(progs.down.pos);
        // 3. Up: level n → … → level 1. The last up-sample, to full size, is `draw`'s.
        set_quad(&progs.up);
        for k in (1..passes).rev() {
            pass(&progs.up, &levels[k + 1], used(k + 1), &levels[k], used(k));
        }
        gl.DisableVertexAttribArray(progs.up.pos);

        // Leave the state as Smithay's renderer expects to find it.
        gl.BindFramebuffer(ffi::FRAMEBUFFER, prev_fbo as u32);
        gl.Viewport(vp[0], vp[1], vp[2], vp[3]);
        gl.Enable(ffi::SCISSOR_TEST);
        gl.Enable(ffi::BLEND);
        gl.BlendFunc(ffi::ONE, ffi::ONE_MINUS_SRC_ALPHA);
        gl.BindBuffer(ffi::ARRAY_BUFFER, 0);
        gl.BindTexture(ffi::TEXTURE_2D, 0);
        gl.UseProgram(0);
        cache.valid = true;
    }
}

/// Paint the captured backdrop into the frame, inside `shapes`, limited to `clip` (output
/// pixels: the damaged part of the glass).
#[allow(clippy::too_many_arguments)]
pub unsafe fn draw(
    gl: &Gles2,
    user_data: &smithay::utils::user_data::UserDataMap,
    map: FrameMap,
    cache: &Cache,
    shapes: &[Shape],
    clip: &[Rectangle<i32, Physical>],
    glass: Option<&Glass>,
) {
    if !cache.valid || cache.passes == 0 {
        return;
    }
    unsafe {
        let progs = programs(gl, user_data);
        let p = &progs.last;
        gl.Enable(ffi::BLEND);
        gl.BlendFunc(ffi::ONE, ffi::ONE_MINUS_SRC_ALPHA);
        gl.BindBuffer(ffi::ARRAY_BUFFER, progs.vbo);
        gl.UseProgram(p.id);
        gl.EnableVertexAttribArray(p.pos);
        gl.VertexAttribPointer(p.pos, 2, ffi::FLOAT, ffi::FALSE, 0, std::ptr::null());
        let l1 = &cache.levels[1];
        let used1 = ((cache.region_fb.size.w >> 1).max(1), (cache.region_fb.size.h >> 1).max(1));
        gl.ActiveTexture(ffi::TEXTURE0);
        gl.BindTexture(ffi::TEXTURE_2D, l1.tex);
        gl.Uniform1i(p.loc(gl, c"tex"), 0);
        gl.Uniform1f(p.loc(gl, c"offset"), cache.offset);
        gl.Uniform2f(p.loc(gl, c"src_size"), l1.w as f32, l1.h as f32);
        gl.Uniform2f(p.loc(gl, c"src_used"), used1.0 as f32, used1.1 as f32);
        gl.UniformMatrix3fv(p.loc(gl, c"projection"), 1, ffi::FALSE, map.projection.as_ptr());
        gl.Uniform2f(p.loc(gl, c"fb_size"), map.fb_size.0 as f32, map.fb_size.1 as f32);
        let r = cache.region_fb;
        gl.Uniform4f(p.loc(gl, c"region_fb"), r.loc.x as f32, r.loc.y as f32, r.size.w as f32, r.size.h as f32);
        gl.UniformMatrix2fv(p.loc(gl, c"out_to_fb"), 1, ffi::FALSE, map.linear().as_ptr());
        gl.Uniform1f(p.loc(gl, c"glass"), glass.is_some() as i32 as f32);
        if let Some(g) = glass {
            gl.Uniform3f(p.loc(gl, c"tint"), g.tint[0], g.tint[1], g.tint[2]);
            gl.Uniform1f(p.loc(gl, c"alpha_min"), g.alpha_min);
            gl.Uniform1f(p.loc(gl, c"alpha_max"), g.alpha_max);
            gl.Uniform1f(p.loc(gl, c"target"), g.target);
            gl.Uniform1f(p.loc(gl, c"rim"), g.rim);
            gl.Uniform1f(p.loc(gl, c"saturation"), g.saturation);
            gl.Uniform3f(p.loc(gl, c"ink_tint"), g.ink_tint[0], g.ink_tint[1], g.ink_tint[2]);
        }
        for s in shapes {
            let sr = s.bounds();
            // One pixel of margin for the anti-aliased edge.
            let mut bounds = Rectangle::<i32, Physical>::new(
                ((sr.loc.x - 1.0).floor() as i32, (sr.loc.y - 1.0).floor() as i32).into(),
                ((sr.size.w + 3.0).ceil() as i32, (sr.size.h + 3.0).ceil() as i32).into(),
            );
            // No clip: one far larger than any output.
            let cl = s.clip.unwrap_or(Rectangle::new((-1e6, -1e6).into(), (2e6, 2e6).into()));
            if s.clip.is_some() {
                let cb = Rectangle::<i32, Physical>::new(
                    ((cl.loc.x - 1.0).floor() as i32, (cl.loc.y - 1.0).floor() as i32).into(),
                    ((cl.size.w + 3.0).ceil() as i32, (cl.size.h + 3.0).ceil() as i32).into(),
                );
                let Some(b) = bounds.intersection(cb) else { continue };
                bounds = b;
            }
            gl.Uniform4f(p.loc(gl, c"clip"), cl.loc.x as f32, cl.loc.y as f32, cl.size.w as f32, cl.size.h as f32);
            let rr = s.rect;
            gl.Uniform4f(p.loc(gl, c"rect"), rr.loc.x as f32, rr.loc.y as f32, rr.size.w as f32, rr.size.h as f32);
            match &s.pointer {
                Some(ptr) => {
                    gl.Uniform1f(p.loc(gl, c"has_pointer"), 1.0);
                    gl.Uniform2f(p.loc(gl, c"ptr_a"), ptr.a[0] as f32, ptr.a[1] as f32);
                    gl.Uniform2f(p.loc(gl, c"ptr_b"), ptr.b[0] as f32, ptr.b[1] as f32);
                    gl.Uniform2f(p.loc(gl, c"ptr_t"), ptr.t[0] as f32, ptr.t[1] as f32);
                    gl.Uniform1f(p.loc(gl, c"ptr_tip_r"), ptr.tip_radius as f32);
                    gl.Uniform1f(p.loc(gl, c"ptr_base_r"), ptr.base_radius as f32);
                }
                None => gl.Uniform1f(p.loc(gl, c"has_pointer"), 0.0),
            }
            gl.Uniform1f(p.loc(gl, c"radius"), s.radius as f32);
            gl.Uniform1f(p.loc(gl, c"exponent"), s.exponent as f32);
            gl.Uniform1f(p.loc(gl, c"opacity"), s.opacity);
            gl.Uniform1f(p.loc(gl, c"ink_dark"), s.ink_dark as i32 as f32);
            gl.Uniform1f(p.loc(gl, c"refraction"), s.refraction as f32);
            for c in clip {
                let Some(q) = bounds.intersection(*c) else { continue };
                gl.Uniform4f(p.loc(gl, c"dst_rect"), q.loc.x as f32, q.loc.y as f32, q.size.w as f32, q.size.h as f32);
                gl.DrawArrays(ffi::TRIANGLE_STRIP, 0, 4);
            }
        }
        gl.DisableVertexAttribArray(p.pos);
        gl.BindBuffer(ffi::ARRAY_BUFFER, 0);
        gl.BindTexture(ffi::TEXTURE_2D, 0);
        gl.UseProgram(0);
    }
}

// ── The ink (`nidara-material-v1` v3) ─────────────────────────────────────────

/// A measurement on its way back from the GPU: read into a pixel-pack buffer, fenced, and
/// mapped only once the fence has passed, so no frame ever waits for it.
struct Readback {
    fence: ffi::types::GLsync,
    pbo: u32,
    /// The ink group of each box, then the shape of each probe, in texel order.
    ids: Vec<u32>,
    shapes: Vec<usize>,
    surface: Weak<WlSurface>,
}

/// The measurements in flight in one GL context (its user data).
#[derive(Default)]
struct Readbacks(RefCell<Vec<Readback>>);

/// More in flight than this (a GPU that stopped answering), and the oldest are dropped.
const MAX_READBACKS: usize = 32;

thread_local! {
    /// A measurement was issued since the backend last looked (`take_ink_issued`).
    static INK_ISSUED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether a measurement was issued since the last call: the backend then polls for it.
pub fn take_ink_issued() -> bool {
    INK_ISSUED.with(|f| f.replace(false))
}

/// Whether this context can read back without waiting: GLES 3 (fences, pixel-pack buffers).
fn can_measure(gl: &Gles2) -> bool {
    gl.FenceSync.is_loaded() && gl.MapBufferRange.is_loaded() && gl.ClientWaitSync.is_loaded()
}

/// Measure the darkest point under each ink box, and the darkest and brightest under each
/// shape that casts a shadow (v5), if the capture, the boxes or the probes changed since the
/// last measurement. Called from `draw`'s context, inside the frame; leaves the GL state as
/// it found it.
#[allow(clippy::too_many_arguments)]
pub unsafe fn measure_ink(
    gl: &Gles2,
    user_data: &smithay::utils::user_data::UserDataMap,
    map: FrameMap,
    cache: &mut Cache,
    boxes: &[InkBox],
    probes: &[LightProbe],
    saturation: f32,
    surface: &Weak<WlSurface>,
) {
    if !cache.valid || cache.passes == 0 || (boxes.is_empty() && probes.is_empty()) || !can_measure(gl) {
        return;
    }
    let boxes = &boxes[..boxes.len().min(MAX_INK_BOXES)];
    let probes = &probes[..probes.len().min(MAX_LIGHT_PROBES)];
    if cache.measured.as_ref().is_some_and(|(g, b, p, s)| *g == cache.generation && b == boxes && p == probes && *s == saturation) {
        return;
    }
    cache.measured = Some((cache.generation, boxes.to_vec(), probes.to_vec(), saturation));
    unsafe {
        let progs = programs(gl, user_data);
        let (tex, fbo) = match progs.ink_target.get() {
            (0, _) => {
                let (mut tex, mut fbo) = (0, 0);
                gl.GenTextures(1, &mut tex);
                gl.BindTexture(ffi::TEXTURE_2D, tex);
                gl.TexImage2D(
                    ffi::TEXTURE_2D, 0, ffi::RGBA as i32, MEASURE_WIDTH as i32, 1, 0, ffi::RGBA,
                    ffi::UNSIGNED_BYTE, std::ptr::null(),
                );
                gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_MIN_FILTER, ffi::NEAREST as i32);
                gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_MAG_FILTER, ffi::NEAREST as i32);
                gl.GenFramebuffers(1, &mut fbo);
                gl.BindFramebuffer(ffi::FRAMEBUFFER, fbo);
                gl.FramebufferTexture2D(ffi::FRAMEBUFFER, ffi::COLOR_ATTACHMENT0, ffi::TEXTURE_2D, tex, 0);
                progs.ink_target.set((tex, fbo));
                (tex, fbo)
            }
            t => t,
        };
        let _ = tex;
        let mut prev_fbo = 0;
        gl.GetIntegerv(ffi::FRAMEBUFFER_BINDING, &mut prev_fbo);
        let mut vp = [0i32; 4];
        gl.GetIntegerv(ffi::VIEWPORT, vp.as_mut_ptr());
        let mut scissor = 0u8;
        gl.GetBooleanv(ffi::SCISSOR_TEST, &mut scissor);
        let mut blend = 0u8;
        gl.GetBooleanv(ffi::BLEND, &mut blend);

        gl.Disable(ffi::BLEND);
        gl.Disable(ffi::SCISSOR_TEST);
        gl.BindFramebuffer(ffi::FRAMEBUFFER, fbo);
        gl.Viewport(0, 0, MEASURE_WIDTH as i32, 1);
        let p = &progs.ink;
        gl.UseProgram(p.id);
        gl.BindBuffer(ffi::ARRAY_BUFFER, progs.vbo);
        gl.EnableVertexAttribArray(p.pos);
        gl.VertexAttribPointer(p.pos, 2, ffi::FLOAT, ffi::FALSE, 0, std::ptr::null());
        let l1 = &cache.levels[1];
        let used1 = ((cache.region_fb.size.w >> 1).max(1), (cache.region_fb.size.h >> 1).max(1));
        gl.ActiveTexture(ffi::TEXTURE0);
        gl.BindTexture(ffi::TEXTURE_2D, l1.tex);
        gl.Uniform1i(p.loc(gl, c"tex"), 0);
        gl.Uniform2f(p.loc(gl, c"src_size"), l1.w as f32, l1.h as f32);
        gl.Uniform2f(p.loc(gl, c"src_used"), used1.0 as f32, used1.1 as f32);
        gl.Uniform1f(p.loc(gl, c"saturation"), saturation);
        gl.Uniform2f(p.loc(gl, c"target_size"), MEASURE_WIDTH as f32, 1.0);
        let r = cache.region_fb;
        let all = boxes.iter().map(|b| (b.rect, 1.0)).chain(probes.iter().map(|p| (p.rect, p.unscale)));
        for (i, (q, unscale)) in all.enumerate() {
            gl.Uniform1f(p.loc(gl, c"unscale"), unscale);
            // The box in framebuffer pixels (follows the output's transform), then in the
            // blurred copy's: relative to the captured region, at half size.
            let (ax, ay) = map.map_point(q.loc.x, q.loc.y);
            let (bx, by) = map.map_point(q.loc.x + q.size.w, q.loc.y + q.size.h);
            let to_src = |x: f64, ox: i32| ((x - ox as f64) * 0.5) as f32;
            let (x0, x1) = (to_src(ax.min(bx), r.loc.x), to_src(ax.max(bx), r.loc.x));
            let (y0, y1) = (to_src(ay.min(by), r.loc.y), to_src(ay.max(by), r.loc.y));
            gl.Uniform4f(p.loc(gl, c"box_src"), x0, y0, x1, y1);
            gl.Uniform4f(p.loc(gl, c"dst_rect"), i as f32, 0.0, 1.0, 1.0);
            gl.DrawArrays(ffi::TRIANGLE_STRIP, 0, 4);
        }
        gl.DisableVertexAttribArray(p.pos);

        // Into a pixel-pack buffer: the copy is queued, not waited for.
        let mut pbo = 0;
        gl.GenBuffers(1, &mut pbo);
        gl.BindBuffer(ffi::PIXEL_PACK_BUFFER, pbo);
        let texels = boxes.len() + probes.len();
        gl.BufferData(ffi::PIXEL_PACK_BUFFER, (texels * 4) as isize, std::ptr::null(), ffi::STREAM_READ);
        gl.ReadPixels(0, 0, texels as i32, 1, ffi::RGBA, ffi::UNSIGNED_BYTE, std::ptr::null_mut());
        gl.BindBuffer(ffi::PIXEL_PACK_BUFFER, 0);
        let fence = gl.FenceSync(ffi::SYNC_GPU_COMMANDS_COMPLETE, 0);
        user_data.insert_if_missing(Readbacks::default);
        let mut list = user_data.get::<Readbacks>().unwrap().0.borrow_mut();
        while list.len() >= MAX_READBACKS {
            let old = list.remove(0);
            gl.DeleteSync(old.fence);
            gl.DeleteBuffers(1, &old.pbo);
        }
        list.push(Readback {
            fence,
            pbo,
            ids: boxes.iter().map(|b| b.id).collect(),
            shapes: probes.iter().map(|p| p.shape).collect(),
            surface: surface.clone(),
        });
        INK_ISSUED.with(|f| f.set(true));

        gl.BindFramebuffer(ffi::FRAMEBUFFER, prev_fbo as u32);
        gl.Viewport(vp[0], vp[1], vp[2], vp[3]);
        if scissor != 0 {
            gl.Enable(ffi::SCISSOR_TEST);
        }
        if blend != 0 {
            gl.Enable(ffi::BLEND);
        }
        gl.BindBuffer(ffi::ARRAY_BUFFER, 0);
        gl.BindTexture(ffi::TEXTURE_2D, 0);
        gl.UseProgram(0);
    }
}

/// One finished measurement: per ink group the darkest luminance under it (the least over its
/// boxes), and per shape the darkest and brightest under it, its shadow divided out (v5).
pub struct Measured {
    pub surface: Weak<WlSurface>,
    pub ink: Vec<(u32, f32)>,
    pub light: Vec<(usize, f32, f32)>,
}

/// The measurements the GPU has finished, without waiting for any, and whether any is still
/// in flight. Needs the context current (`GlesRenderer::with_context`).
pub unsafe fn poll_ink(gl: &Gles2, user_data: &smithay::utils::user_data::UserDataMap) -> (Vec<Measured>, bool) {
    let Some(list) = user_data.get::<Readbacks>() else { return (Vec::new(), false) };
    let mut list = list.0.borrow_mut();
    let mut out = Vec::new();
    let mut keep = Vec::new();
    for rb in list.drain(..) {
        let status = unsafe { gl.ClientWaitSync(rb.fence, 0, 0) };
        if status == ffi::TIMEOUT_EXPIRED {
            keep.push(rb);
            continue;
        }
        let mut darkest: Vec<(u32, f32)> = Vec::new();
        let mut light: Vec<(usize, f32, f32)> = Vec::new();
        unsafe {
            if status != ffi::WAIT_FAILED {
                gl.BindBuffer(ffi::PIXEL_PACK_BUFFER, rb.pbo);
                let len = (rb.ids.len() + rb.shapes.len()) * 4;
                let ptr = gl.MapBufferRange(ffi::PIXEL_PACK_BUFFER, 0, len as isize, ffi::MAP_READ_BIT) as *const u8;
                if !ptr.is_null() {
                    let bytes = std::slice::from_raw_parts(ptr, len);
                    let two = |at: usize| (bytes[at] as f32 + bytes[at + 1] as f32 / 255.0) / 255.0;
                    for (i, &id) in rb.ids.iter().enumerate() {
                        let l = two(i * 4);
                        match darkest.iter_mut().find(|(g, _)| *g == id) {
                            Some((_, m)) => *m = m.min(l),
                            None => darkest.push((id, l)),
                        }
                    }
                    for (k, &shape) in rb.shapes.iter().enumerate() {
                        let at = (rb.ids.len() + k) * 4;
                        light.push((shape, two(at), two(at + 2)));
                    }
                    gl.UnmapBuffer(ffi::PIXEL_PACK_BUFFER);
                }
                gl.BindBuffer(ffi::PIXEL_PACK_BUFFER, 0);
            }
            gl.DeleteSync(rb.fence);
            gl.DeleteBuffers(1, &rb.pbo);
        }
        if !darkest.is_empty() || !light.is_empty() {
            out.push(Measured { surface: rb.surface, ink: darkest, light });
        }
    }
    let pending = !keep.is_empty();
    *list = keep;
    (out, pending)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Smithay's projection for an output of `w`×`h` with `transform`, rebuilt the way
    /// `GlesRenderer::render` does it (see its source), for checking our mapping.
    fn projection(w: f32, h: f32, flip_y: bool) -> [f32; 9] {
        // Normal: output (x, y) → ndc (2x/w - 1, 2y/h - 1); Flipped180 negates y.
        let s = if flip_y { -1.0 } else { 1.0 };
        [2.0 / w, 0.0, 0.0, 0.0, s * 2.0 / h, 0.0, -1.0, -s, 1.0]
    }

    #[test]
    fn a_pointer_reaches_its_tip_and_rounds_it() {
        // A tooltip's pointer pointing down: base centred at (50, 20), 16 wide, tip at (50, 28).
        let p = PointerPx::new([50.0, 20.0], [50.0, 28.0], 16.0, 4.0, 8.0).unwrap();
        // The shader grows the inset triangle back by the tip radius: the apex is then where
        // an arc of that radius tangent to both sides puts it — as Cairo's path does (the
        // sides meet at 90° here, so the arc cuts r·(√2 − 1) off the sharp tip).
        let apex = p.t[1] + p.tip_radius;
        let expected = 28.0 - 4.0 * (2f64.sqrt() - 1.0);
        assert!((apex - expected).abs() < 0.01, "apex at {apex}, expected {expected}");
        assert!((p.t[0] - 50.0).abs() < 1e-9, "the tip stays on the axis");
        // Its base corners sit inside the body (above y = 20), so only the join shows.
        assert!(p.a[1] < 20.0 && p.b[1] < 20.0, "base corners {:?} {:?}", p.a, p.b);
        // Everything it covers is in its bounds.
        assert!(p.bounds.loc.y <= 20.0 - 8.0 && p.bounds.loc.y + p.bounds.size.h >= 28.0);
        assert!(PointerPx::new([0.0, 0.0], [0.0, 0.0], 16.0, 4.0, 8.0).is_none(), "no length, no pointer");
    }

    #[test]
    fn rect_to_fb_follows_the_projection() {
        let normal = FrameMap { projection: projection(100.0, 50.0, false), fb_size: (100, 50) };
        let r = Rectangle::new((10, 5).into(), (20, 10).into());
        assert_eq!(normal.rect_to_fb(r), Some(r), "Normal: output rows are framebuffer rows");
        let flipped = FrameMap { projection: projection(100.0, 50.0, true), fb_size: (100, 50) };
        assert_eq!(
            flipped.rect_to_fb(r),
            Some(Rectangle::new((10, 35).into(), (20, 10).into())),
            "a y-flipped output (winit's window) mirrors the rows"
        );
        let off = Rectangle::new((95, 45).into(), (20, 20).into());
        assert_eq!(normal.rect_to_fb(off), Some(Rectangle::new((95, 45).into(), (5, 5).into())));
    }
}
