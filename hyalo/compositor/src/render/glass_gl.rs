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

use std::{
    cell::{Cell, RefCell},
    path::PathBuf,
    rc::Rc,
};

use smithay::{
    backend::renderer::gles::ffi::{self, Gles2},
    reexports::wayland_server::{Weak, protocol::wl_surface::WlSurface},
    utils::{Physical, Point, Rectangle},
};

pub(super) const VS_PASS: &str = r#"#version 100
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

// The down-sample, with Hyprland's finishing for a window's backdrop (`Finish`; neutral for the
// shell's glass): its contrast and brightness on what is read from the frame (`prepare`, the
// first pass only — Hyprland's blurprepare), its vibrancy on each pass's result (blur1.glsl,
// the same formulas and constants).
const FS_DOWN: &str = r#"#version 100
precision highp float;
uniform sampler2D tex;
uniform vec2 src_size;   // the sampled texture's full size
uniform vec2 src_used;   // the part of it this capture wrote
uniform float offset;
uniform float prepare;   // 1 on the first pass: contrast and brightness on each tap
uniform float contrast;
uniform float brightness;
uniform float vibrancy;
uniform float vibrancy_darkness;
uniform float passes;
varying vec2 v_px;

vec3 gain(vec3 src, float k) {
    vec3 x = clamp(src, 0.0, 1.0);
    vec3 t = step(0.5, x);
    vec3 y = mix(x, 1.0 - x, t);
    vec3 a = 0.5 * pow(2.0 * y, vec3(k));
    return mix(a, 1.0 - a, t);
}
vec4 tap(vec2 uv) {
    vec4 c = texture2D(tex, clamp(uv, 0.5 / src_size, (src_used - 0.5) / src_size));
    if (prepare > 0.5) {
        if (contrast != 1.0) c.rgb = gain(c.rgb, contrast);
        c.rgb *= max(1.0, brightness);
    }
    return c;
}

float double_circle_sigmoid(float x, float a) {
    a = clamp(a, 0.0, 1.0);
    if (x <= a) return a - sqrt(a * a - x * x);
    return a + sqrt(pow(1.0 - a, 2.0) - pow(x - 1.0, 2.0));
}
vec3 rgb2hsl(vec3 col) {
    float minc = min(col.r, min(col.g, col.b));
    float maxc = max(col.r, max(col.g, col.b));
    float delta = maxc - minc;
    float lum = (minc + maxc) * 0.5;
    float sat = 0.0;
    float hue = 0.0;
    if (lum > 0.0 && lum < 1.0) {
        float mul = (lum < 0.5) ? lum : (1.0 - lum);
        sat = delta / (mul * 2.0);
    }
    if (delta > 0.0) {
        vec3 maxv = vec3(maxc);
        vec3 masks = vec3(equal(maxv, col)) * vec3(notEqual(maxv, vec3(col.g, col.b, col.r)));
        vec3 adds = vec3(0.0, 2.0, 4.0) + vec3(col.g - col.b, col.b - col.r, col.r - col.g) / delta;
        hue = dot(adds, masks) / 6.0;
        if (hue < 0.0) hue += 1.0;
    }
    return vec3(hue, sat, lum);
}
vec3 hsl2rgb(vec3 col) {
    float third = 1.0 / 3.0;
    float hue = col.x;
    float sat = col.y;
    float lum = col.z;
    vec3 xt = vec3(0.0);
    if (hue < third) {
        xt = vec3(6.0 * (third - hue), 6.0 * hue, 0.0);
    } else if (hue < 2.0 * third) {
        xt = vec3(0.0, 6.0 * (2.0 * third - hue), 6.0 * (hue - third));
    } else {
        xt = vec3(6.0 * (hue - 2.0 * third), 0.0, 6.0 * (1.0 - hue));
    }
    xt = min(xt, 1.0);
    vec3 ct = 2.0 * sat * xt + (1.0 - sat);
    if (lum >= 0.5) return (1.0 - lum) * ct + (2.0 * lum - 1.0);
    return lum * ct;
}
vec3 vibrant(vec3 c) {
    float darkness = 1.0 - vibrancy_darkness;
    vec3 hsl = rgb2hsl(c);
    float perceived = double_circle_sigmoid(sqrt(c.r * c.r * 0.299 + c.g * c.g * 0.587 + c.b * c.b * 0.114), 0.8 * darkness);
    float b1 = 0.11 * darkness;
    float boost = hsl.y > 0.0
        ? smoothstep(b1 - 0.33, b1 + 0.33, 1.0 - (pow(1.0 - hsl.y * cos(0.93), 2.0) + pow(1.0 - perceived * sin(0.93), 2.0)))
        : 0.0;
    float sat = clamp(hsl.y + boost * vibrancy / passes, 0.0, 1.0);
    return hsl2rgb(vec3(hsl.x, sat, hsl.z));
}

void main() {
    vec2 uv = v_px * 2.0 / src_size;
    vec2 o = offset / src_size;
    vec4 sum = tap(uv) * 4.0;
    sum += tap(uv - o);
    sum += tap(uv + o);
    sum += tap(uv + vec2(o.x, -o.y));
    sum += tap(uv - vec2(o.x, -o.y));
    vec4 c = sum / 8.0;
    if (vibrancy != 0.0) c.rgb = vibrant(c.rgb);
    gl_FragColor = c;
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

pub(super) const VS_FINAL: &str = r#"#version 100
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

const FS_FINAL_MAIN: &str = include_str!("glass_final.glsl");

/// The glass shader's LAB hooks (glass_final.glsl), as Hyalo ships them: every hook is its
/// value and every `#ifdef GLASS_LAB` block is compiled out — the arithmetic is the shader's
/// alone. The glass lab (scripts/dev/glass-lab) runs the SAME file with `LAB_ON` instead
/// (HYALO_SHADER_DIR), so what it shows at its neutral values is the factory glass, and a
/// change to the glass is a change the lab sees with no copy to keep in step.
const LAB_OFF: &str = "#define LAB_ADD(i, x) (x)\n#define LAB_MUL(i, x) (x)\n";
/// The lab's: 16 values from lab_params.conf, each 0 where it changes nothing. `LAB_ADD`
/// adds the value; `LAB_MUL` scales by 1 + it; a block runs only where its value is not 0.
const LAB_ON: &str = r#"#define GLASS_LAB 1
uniform vec4 lab_params[4];
float lab(int i) {
    int r = i / 4;
    int c = i - r * 4;
    vec4 v = r == 0 ? lab_params[0] : r == 1 ? lab_params[1] : r == 2 ? lab_params[2] : lab_params[3];
    return c == 0 ? v.x : c == 1 ? v.y : c == 2 ? v.z : v.w;
}
#define LAB_ADD(i, x) ((x) + lab(i))
#define LAB_MUL(i, x) ((x) * (1.0 + lab(i)))
"#;

/// The darkest and brightest WCAG luminance under one box (`nidara-material-v1`), from
/// the blurred backdrop as the glass treats it before its tint: blurred and saturated. A grid
/// of samples is enough because the backdrop is blurred: nothing narrower than the blur
/// survives it. `unscale` divides out the shadow under the box (what the backdrop is
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

/// One ink box (`nidara-material-v1`), output pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InkBox {
    pub id: u32,
    pub rect: Rectangle<f64, Physical>,
}

/// Where the backdrop under one shape is measured for its shadow, output pixels: the
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
    /// Its index in the material's shapes (the shadow's measurement is by shape).
    pub index: usize,
    pub rect: Rectangle<f64, Physical>,
    pub radius: f64,
    pub exponent: f64,
    /// The glass's opacity in this shape over the plain backdrop, 0..1.
    pub opacity: f32,
    /// What of the shape may show, output pixels. None = all of it.
    pub clip: Option<Rectangle<f64, Physical>>,
    /// It holds an ink group whose content is dark: the light veil, not the dark tint.
    pub ink_dark: bool,
    /// A pointer spliced into it.
    pub pointer: Option<PointerPx>,
    /// How far its edge reads the backdrop from outside it, output pixels: the glass's
    /// refraction, or more on a large shape (`set_lensing`). 0 where there is no glass.
    pub refraction: f64,
    /// Output px per logical px (the output's scale): the shader's own widths in px — the rim's
    /// band, the bevel's cap — are logical, so a pane looks the same at any scale.
    pub px_scale: f64,
    /// Its fusion group (`set_fusion`) and the smooth union's width, output px: twice the
    /// group's spacing, so two shapes closer than the spacing are joined.
    pub fusion: Option<(u32, f64)>,
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

/// The most shapes one fusion group draws as one silhouette (the shader's arrays); past it the
/// rest of the group is drawn shape by shape.
pub const FUSE_MAX: usize = 8;

/// How `draw` paints `shapes`, in their order: each shape on its own, or a fusion group as ONE
/// draw at the place of its first member. Indices into `shapes`.
pub fn draw_plan(shapes: &[Shape]) -> Vec<Vec<usize>> {
    let mut plan: Vec<Vec<usize>> = Vec::new();
    let mut seen: Vec<u32> = Vec::new();
    for (i, s) in shapes.iter().enumerate() {
        match s.fusion {
            Some((g, _)) if !seen.contains(&g) => {
                seen.push(g);
                let members: Vec<usize> =
                    (i..shapes.len()).filter(|&j| shapes[j].fusion.map(|f| f.0) == Some(g)).collect();
                let mut chunks = members.chunks(FUSE_MAX);
                if let Some(first) = chunks.next() {
                    plan.push(first.to_vec());
                }
                plan.extend(chunks.flatten().map(|&j| vec![j]));
            }
            Some(_) => {}
            None => plan.push(vec![i]),
        }
    }
    plan
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

/// Hyprland's `decoration:blur` finishing, for a window's backdrop (config `[windows.backdrop]`).
/// `NEUTRAL` changes nothing: the shell's glass has its own saturation and tint instead.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Finish {
    pub contrast: f32,
    pub brightness: f32,
    pub vibrancy: f32,
    pub vibrancy_darkness: f32,
    pub noise: f32,
}

impl Finish {
    pub const NEUTRAL: Finish = Finish { contrast: 1.0, brightness: 1.0, vibrancy: 0.0, vibrancy_darkness: 0.0, noise: 0.0 };
}

#[derive(Clone, Copy)]
pub(super) struct Program {
    pub(super) id: u32,
    pub(super) pos: u32,
}

impl Program {
    pub(super) unsafe fn loc(&self, gl: &Gles2, name: &std::ffi::CStr) -> i32 {
        unsafe { gl.GetUniformLocation(self.id, name.as_ptr()) }
    }
}

struct DevShaderState {
    dir: PathBuf,
    shader_mtime: Cell<Option<std::time::SystemTime>>,
    params_mtime: Cell<Option<std::time::SystemTime>>,
    params: Cell<[f32; 16]>,
}

/// `lab_params.conf` (development only, beside the shader HYALO_SHADER_DIR names): lines
/// `lab[i] = value`, i in 0..16, to `LAB_ON`'s `uniform vec4 lab_params[4]`. What each index
/// means is glass_final.glsl's own header; unknown lines
/// are skipped, so a half-written file applies what it can.
fn parse_lab_params(src: &str) -> [f32; 16] {
    let mut params = [0.0f32; 16];
    for line in src.lines() {
        let line = line.split('#').next().unwrap_or("").trim();
        let Some((key, val)) = line.split_once('=') else { continue };
        let Some(idx) = key.trim().strip_prefix("lab[").and_then(|k| k.strip_suffix(']')) else { continue };
        if let (Ok(i), Ok(v)) = (idx.trim().parse::<usize>(), val.trim().parse::<f32>())
            && i < 16
        {
            params[i] = v;
        }
    }
    params
}

/// GL objects that belong to one GL context: compiled once, shared by every glass drawn in
/// it. Kept in the EGL context's user data.
pub(super) struct Programs {
    down: Program,
    up: Program,
    last: Cell<Program>,
    ink: Program,
    /// The shadow under the glass (render/scrim.rs).
    pub(super) scrim: Program,
    /// A window's controls (render/controls.rs).
    pub(super) controls: Program,
    /// A window's line and shadow (render/decor.rs).
    pub(super) decor: Program,
    /// The measurement's target: MEASURE_WIDTH × 1, one texel per box. Made on first use.
    ink_target: std::cell::Cell<(u32, u32)>,
    pub(super) vbo: u32,
    /// Textures and framebuffers of glasses that went away, deleted on the next capture: a
    /// cache is dropped where no GL context is current.
    trash: Trash,
    dev: Option<DevShaderState>,
}

type Trash = Rc<RefCell<Vec<(u32, u32)>>>;

pub(super) unsafe fn try_compile(gl: &Gles2, vs: &str, fs: &str) -> Result<Program, String> {
    unsafe {
        let shader = |kind, src: &str| -> Result<u32, String> {
            let s = gl.CreateShader(kind);
            let c = std::ffi::CString::new(src).map_err(|e| e.to_string())?;
            gl.ShaderSource(s, 1, &c.as_ptr(), std::ptr::null());
            gl.CompileShader(s);
            let mut ok = 0;
            gl.GetShaderiv(s, ffi::COMPILE_STATUS, &mut ok);
            if ok == 0 {
                let mut buf = vec![0u8; 4096];
                let mut len = 0;
                gl.GetShaderInfoLog(s, 4096, &mut len, buf.as_mut_ptr() as *mut _);
                let err = String::from_utf8_lossy(&buf[..len as usize]).into_owned();
                gl.DeleteShader(s);
                return Err(err);
            }
            Ok(s)
        };
        let v = shader(ffi::VERTEX_SHADER, vs)?;
        let f = match shader(ffi::FRAGMENT_SHADER, fs) {
            Ok(f) => f,
            Err(e) => {
                gl.DeleteShader(v);
                return Err(e);
            }
        };
        let id = gl.CreateProgram();
        gl.AttachShader(id, v);
        gl.AttachShader(id, f);
        gl.LinkProgram(id);
        gl.DeleteShader(v);
        gl.DeleteShader(f);
        let mut linked = 0;
        gl.GetProgramiv(id, ffi::LINK_STATUS, &mut linked);
        if linked == 0 {
            let mut buf = vec![0u8; 4096];
            let mut len = 0;
            gl.GetProgramInfoLog(id, 4096, &mut len, buf.as_mut_ptr() as *mut _);
            let err = String::from_utf8_lossy(&buf[..len as usize]).into_owned();
            gl.DeleteProgram(id);
            return Err(err);
        }
        let pos = gl.GetAttribLocation(id, c"pos".as_ptr()) as u32;
        Ok(Program { id, pos })
    }
}

pub(super) unsafe fn compile(gl: &Gles2, vs: &str, fs: &str) -> Program {
    unsafe {
        match try_compile(gl, vs, fs) {
            Ok(p) => p,
            Err(e) => panic!("glass shader: {e}"),
        }
    }
}

impl Programs {
    /// Development only (HYALO_SHADER_DIR): the file's modification time, when it changed.
    fn changed(path: &std::path::Path, seen: &Cell<Option<std::time::SystemTime>>) -> bool {
        let Ok(mtime) = std::fs::metadata(path).and_then(|m| m.modified()) else { return false };
        if seen.get() == Some(mtime) {
            return false;
        }
        seen.set(Some(mtime));
        true
    }

    /// Development only: recompiles the dev shader when its file changes — keeping the last
    /// program that compiled when the new one does not — and re-reads lab_params.conf.
    unsafe fn poll_dev_reload(&self, gl: &Gles2, dev: &DevShaderState) {
        let shader_path = dev.dir.join("glass_final.glsl");
        if Self::changed(&shader_path, &dev.shader_mtime)
            && let Ok(src) = std::fs::read_to_string(&shader_path)
        {
            let fs_src = format!("#version 100\nprecision highp float;\n{LAB_ON}{UP_COMMON}{src}");
            match unsafe { try_compile(gl, VS_FINAL, &fs_src) } {
                Ok(program) => {
                    unsafe { gl.DeleteProgram(self.last.get().id) };
                    self.last.set(program);
                    eprintln!("glass dev shader reloaded: {}", shader_path.display());
                }
                Err(err) => eprintln!("glass dev shader compile error: {err}"),
            }
        }
        let params_path = dev.dir.join("lab_params.conf");
        if Self::changed(&params_path, &dev.params_mtime)
            && let Ok(src) = std::fs::read_to_string(&params_path)
        {
            dev.params.set(parse_lab_params(&src));
            eprintln!("glass dev lab_params reloaded: {}", params_path.display());
        }
    }

    unsafe fn new(gl: &Gles2) -> Self {
        unsafe {
            let header = "#version 100\nprecision highp float;\n";
            let up_fs = format!("{header}{UP_COMMON}{FS_UP_MAIN}");
            let last_fs = format!("{header}{LAB_OFF}{UP_COMMON}{FS_FINAL_MAIN}");
            let mut vbo = 0;
            gl.GenBuffers(1, &mut vbo);
            gl.BindBuffer(ffi::ARRAY_BUFFER, vbo);
            let quad: [f32; 8] = [0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0];
            gl.BufferData(ffi::ARRAY_BUFFER, 32, quad.as_ptr() as *const _, ffi::STATIC_DRAW);
            gl.BindBuffer(ffi::ARRAY_BUFFER, 0);
            let dev = std::env::var_os("HYALO_SHADER_DIR").map(|d| DevShaderState {
                dir: PathBuf::from(d),
                shader_mtime: Cell::new(None),
                params_mtime: Cell::new(None),
                params: Cell::new([0.0f32; 16]),
            });
            let progs = Self {
                down: compile(gl, VS_PASS, FS_DOWN),
                up: compile(gl, VS_PASS, &up_fs),
                last: Cell::new(compile(gl, VS_FINAL, &last_fs)),
                ink: compile(gl, VS_PASS, FS_INK),
                scrim: compile(gl, VS_FINAL, super::scrim::FS_SCRIM),
                controls: compile(gl, VS_FINAL, super::controls::FS_CONTROLS),
                decor: compile(gl, VS_FINAL, super::decor::FS_DECOR),
                ink_target: Default::default(),
                vbo,
                trash: Default::default(),
                dev,
            };
            if let Some(dev_state) = &progs.dev {
                progs.poll_dev_reload(gl, dev_state);
            }
            progs
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
#[allow(clippy::too_many_arguments)]
pub unsafe fn capture(
    gl: &Gles2,
    user_data: &smithay::utils::user_data::UserDataMap,
    map: FrameMap,
    region: Rectangle<i32, Physical>,
    offset: f32,
    passes: usize,
    finish: &Finish,
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
        let d = &progs.down;
        gl.Uniform1f(d.loc(gl, c"contrast"), finish.contrast);
        gl.Uniform1f(d.loc(gl, c"brightness"), finish.brightness);
        gl.Uniform1f(d.loc(gl, c"vibrancy"), finish.vibrancy);
        gl.Uniform1f(d.loc(gl, c"vibrancy_darkness"), finish.vibrancy_darkness);
        gl.Uniform1f(d.loc(gl, c"passes"), passes as f32);
        for k in 1..=passes {
            gl.Uniform1f(d.loc(gl, c"prepare"), (k == 1) as i32 as f32);
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
    finish: &Finish,
) {
    if !cache.valid || cache.passes == 0 {
        return;
    }
    unsafe {
        let progs = programs(gl, user_data);
        if let Some(dev) = &progs.dev {
            progs.poll_dev_reload(gl, dev);
        }
        let p = progs.last.get();
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
        gl.Uniform1f(p.loc(gl, c"noise"), finish.noise);
        gl.Uniform1f(p.loc(gl, c"brightness"), finish.brightness);
        if let Some(g) = glass {
            gl.Uniform3f(p.loc(gl, c"tint"), g.tint[0], g.tint[1], g.tint[2]);
            gl.Uniform1f(p.loc(gl, c"alpha_min"), g.alpha_min);
            gl.Uniform1f(p.loc(gl, c"alpha_max"), g.alpha_max);
            gl.Uniform1f(p.loc(gl, c"target"), g.target);
            gl.Uniform1f(p.loc(gl, c"rim"), g.rim);
            gl.Uniform1f(p.loc(gl, c"saturation"), g.saturation);
            gl.Uniform3f(p.loc(gl, c"ink_tint"), g.ink_tint[0], g.ink_tint[1], g.ink_tint[2]);
        }
        if let Some(dev) = &progs.dev {
            let loc = p.loc(gl, c"lab_params");
            if loc >= 0 {
                let params = dev.params.get();
                gl.Uniform4fv(loc, 4, params.as_ptr());
            }
        }
        for members in draw_plan(shapes) {
            let s = &shapes[members[0]];
            let fused = members.len() > 1;
            let sr = if fused {
                // The bridges lie between the members, bulging past their bounds by at most a
                // quarter of the union's width.
                let k = s.fusion.map_or(0.0, |f| f.1);
                let mut b = s.bounds();
                for &j in &members[1..] {
                    b = b.merge(shapes[j].bounds());
                }
                Rectangle::new(b.loc - Point::from((k / 4.0, k / 4.0)), (b.size.w + k / 2.0, b.size.h + k / 2.0).into())
            } else {
                s.bounds()
            };
            // One pixel of margin for the anti-aliased edge.
            let mut bounds = Rectangle::<i32, Physical>::new(
                ((sr.loc.x - 1.0).floor() as i32, (sr.loc.y - 1.0).floor() as i32).into(),
                ((sr.size.w + 3.0).ceil() as i32, (sr.size.h + 3.0).ceil() as i32).into(),
            );
            // No clip: one far larger than any output. A fusion group's members carry their
            // own (the shader cuts each one's outline).
            let cl = if fused { None } else { s.clip }.unwrap_or(Rectangle::new((-1e6, -1e6).into(), (2e6, 2e6).into()));
            if !fused && s.clip.is_some() {
                let cb = Rectangle::<i32, Physical>::new(
                    ((cl.loc.x - 1.0).floor() as i32, (cl.loc.y - 1.0).floor() as i32).into(),
                    ((cl.size.w + 3.0).ceil() as i32, (cl.size.h + 3.0).ceil() as i32).into(),
                );
                let Some(b) = bounds.intersection(cb) else { continue };
                bounds = b;
            }
            gl.Uniform4f(p.loc(gl, c"clip"), cl.loc.x as f32, cl.loc.y as f32, cl.size.w as f32, cl.size.h as f32);
            if fused {
                let mut rects = [0f32; 4 * FUSE_MAX];
                let mut pars = [0f32; 4 * FUSE_MAX];
                let mut clips = [0f32; 4 * FUSE_MAX];
                let mut refr = [0f32; FUSE_MAX];
                for (k, &j) in members.iter().enumerate() {
                    let m = &shapes[j];
                    rects[4 * k..4 * k + 4].copy_from_slice(&[
                        m.rect.loc.x as f32, m.rect.loc.y as f32, m.rect.size.w as f32, m.rect.size.h as f32,
                    ]);
                    pars[4 * k..4 * k + 4].copy_from_slice(&[
                        m.radius as f32, m.exponent as f32, m.opacity, m.ink_dark as i32 as f32,
                    ]);
                    if let Some(c) = m.clip {
                        clips[4 * k..4 * k + 4].copy_from_slice(&[
                            c.loc.x as f32, c.loc.y as f32, c.size.w as f32, c.size.h as f32,
                        ]);
                    }
                    refr[k] = m.refraction as f32;
                }
                gl.Uniform1f(p.loc(gl, c"fused"), 1.0);
                gl.Uniform1f(p.loc(gl, c"f_count"), members.len() as f32);
                gl.Uniform1f(p.loc(gl, c"f_k"), s.fusion.map_or(0.0, |f| f.1) as f32);
                gl.Uniform4fv(p.loc(gl, c"f_rect"), FUSE_MAX as i32, rects.as_ptr());
                gl.Uniform4fv(p.loc(gl, c"f_par"), FUSE_MAX as i32, pars.as_ptr());
                gl.Uniform4fv(p.loc(gl, c"f_clip"), FUSE_MAX as i32, clips.as_ptr());
                gl.Uniform1fv(p.loc(gl, c"f_refr"), FUSE_MAX as i32, refr.as_ptr());
            } else {
                gl.Uniform1f(p.loc(gl, c"fused"), 0.0);
            }
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
            gl.Uniform1f(p.loc(gl, c"px_scale"), s.px_scale as f32);
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

// ── The ink (`nidara-material-v1`) ─────────────────────────────────────────

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
/// shape that casts a shadow, if the capture, the boxes or the probes changed since the
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
/// boxes), and per shape the darkest and brightest under it, its shadow divided out.
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

    #[test]
    fn a_fusion_group_is_one_draw_where_its_first_member_was() {
        let shape = |fusion: Option<(u32, f64)>| Shape {
            index: 0,
            rect: Rectangle::new((0.0, 0.0).into(), (10.0, 10.0).into()),
            radius: 5.0,
            exponent: 2.0,
            opacity: 1.0,
            clip: None,
            ink_dark: false,
            pointer: None,
            refraction: 0.0,
            px_scale: 1.0,
            fusion,
        };
        // A lone shape, a group of two around another lone one, a group of one.
        let shapes = [shape(None), shape(Some((7, 8.0))), shape(None), shape(Some((7, 8.0))), shape(Some((3, 8.0)))];
        assert_eq!(draw_plan(&shapes), vec![vec![0], vec![1, 3], vec![2], vec![4]]);
        // Past the shader's arrays the rest of the group is drawn shape by shape, never lost.
        let many: Vec<Shape> = (0..FUSE_MAX + 2).map(|_| shape(Some((1, 8.0)))).collect();
        let plan = draw_plan(&many);
        assert_eq!(plan[0].len(), FUSE_MAX);
        assert_eq!(plan.iter().map(Vec::len).sum::<usize>(), FUSE_MAX + 2);
    }
}
