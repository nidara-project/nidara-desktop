//! The glass in raw GL, inside the frame being drawn (`GlesFrame::with_context`, public API).
//!
//! Two halves, because Smithay's damage tracker calls them separately (`render/glass.rs`):
//!
//! - **capture**, only when something behind the glass changed: copy the region under the
//!   shapes out of the frame (glCopyTexSubImage2D), then dual-kawase down and up through a
//!   pyramid of textures owned by this glass, stopping one level short of full size.
//! - **draw**, whenever the glass's own area is damaged: the last up-sample, straight into the
//!   frame, cut to each shape by its signed distance — and, with liquid glass, refracted,
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
vec4 up(vec2 src_px) {
    vec2 uv = src_px / src_size;
    vec2 o = offset / src_size;
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
uniform float glass;        // 1: liquid glass — the compositor paints the whole glass
uniform vec3 tint;
uniform float alpha_min;
uniform float alpha_max;
uniform float target;
uniform float refraction;   // output px
uniform float rim;
uniform float saturation;
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

// Framebuffer pixels → the blurred copy (level 1, half size).
vec2 to_src(vec2 fb_px) { return (fb_px - region_fb.xy) * 0.5; }
vec4 backdrop(vec2 out_offset) { return up(to_src(v_fb + out_to_fb * out_offset)); }

void main() {
    float d = sdf(v_out);
    float cov = clamp(0.5 - d, 0.0, 1.0);
    if (cov <= 0.0) discard;
    if (glass < 0.5) {
        vec4 c = backdrop(vec2(0.0));
        gl_FragColor = vec4(c.rgb * cov, cov);
        return;
    }

    // ── Liquid glass ──────────────────────────────────────────────────────
    // The outward normal, from the distance field.
    vec2 n = vec2(sdf(v_out + vec2(1.0, 0.0)) - sdf(v_out - vec2(1.0, 0.0)),
                  sdf(v_out + vec2(0.0, 1.0)) - sdf(v_out - vec2(0.0, 1.0)));
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
    float tl = dot(tint, vec3(0.2126, 0.7152, 0.0722));
    float a = l > target ? (l - target) / max(l - tl, 0.001) : 0.0;
    a = clamp(a, alpha_min, alpha_max);
    vec3 c = mix(bg, tint, a);
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

/// A shape in output pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    pub rect: Rectangle<f64, Physical>,
    pub radius: f64,
    pub exponent: f64,
}

/// Liquid glass parameters, in output pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Glass {
    pub tint: [f32; 3],
    pub alpha_min: f32,
    pub alpha_max: f32,
    pub target: f32,
    pub refraction: f32,
    pub rim: f32,
    pub saturation: f32,
}

struct Program {
    id: u32,
    pos: u32,
}

impl Program {
    unsafe fn loc(&self, gl: &Gles2, name: &std::ffi::CStr) -> i32 {
        unsafe { gl.GetUniformLocation(self.id, name.as_ptr()) }
    }
}

/// GL objects that belong to one GL context: compiled once, shared by every glass drawn in
/// it. Kept in the EGL context's user data.
struct Programs {
    down: Program,
    up: Program,
    last: Program,
    vbo: u32,
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
    fn map_point(&self, x: f64, y: f64) -> (f64, f64) {
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

unsafe fn programs<'a>(gl: &Gles2, user_data: &'a smithay::utils::user_data::UserDataMap) -> &'a Programs {
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
            gl.Uniform1f(p.loc(gl, c"refraction"), g.refraction);
            gl.Uniform1f(p.loc(gl, c"rim"), g.rim);
            gl.Uniform1f(p.loc(gl, c"saturation"), g.saturation);
        }
        for s in shapes {
            let sr = s.rect;
            // One pixel of margin for the anti-aliased edge.
            let bounds = Rectangle::<i32, Physical>::new(
                ((sr.loc.x - 1.0).floor() as i32, (sr.loc.y - 1.0).floor() as i32).into(),
                ((sr.size.w + 3.0).ceil() as i32, (sr.size.h + 3.0).ceil() as i32).into(),
            );
            gl.Uniform4f(p.loc(gl, c"rect"), sr.loc.x as f32, sr.loc.y as f32, sr.size.w as f32, sr.size.h as f32);
            gl.Uniform1f(p.loc(gl, c"radius"), s.radius as f32);
            gl.Uniform1f(p.loc(gl, c"exponent"), s.exponent as f32);
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
