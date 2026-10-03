//! Hyalo's title bar (#708 point 5, its second half): the bar Hyalo draws over a window whose
//! app left its decorations to the compositor — kitty, Qt apps, Chrome with "Use system title
//! bar and borders" (shell/decoration.rs). The owner's design, chosen on a mockup (2026-10-03):
//!
//! - **One piece with the window.** No line, no colour of its own: the bar takes the colour of
//!   the app's top row — averaged on the GPU, alpha included, so a translucent kitty gets a
//!   translucent bar with the window's blur behind it — and the window's top corners.
//! - **The same capsule** as over our own apps' headers (render/controls.rs), on the side the
//!   user chose, and the title centred in the interface font at the chrome's fixed 13 px.
//! - **Ink that reads.** White over a dark bar, dark over a light one — decided on the GPU from
//!   the same average, where black beats white for contrast (the WCAG crossover).
//! - Dragged, it moves the window; a double click maximizes it (input.rs). The app sees no
//!   pointer over it (state.rs `chrome_under`).
//!
//! It sits on top of the client's box, inside the window's: the layout gives the client the
//! rest (wm/mod.rs `Managed::bar`). Drawn in one element, in three steps inside its `draw`: the
//! client's top row sampled into a small target through Smithay's own texture path (which knows
//! the buffer's format, transform and whether it is an external image), that target averaged
//! into one texel, then the bar itself — background, title, capsule, corners — in one pass.

use std::{
    cell::RefCell,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

use pangocairo::{cairo, pango};
use smithay::{
    backend::renderer::{
        element::{Element, Id, Kind, RenderElement},
        gles::{GlesError, GlesFrame, GlesTexture, ffi},
        utils::{CommitCounter, RendererSurfaceStateUserData},
    },
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Buffer as BufferCoords, Physical, Rectangle, Scale, Size, Transform, user_data::UserDataMap},
    wayland::compositor::with_states,
};

use super::{
    HyaloRenderer,
    controls::{Controls, controls_glsl},
    glass_gl::{self, Program},
};

/// The title's size, logical px: the shell chrome's fixed `$fs-small` (ui/lib/nidara-kit/
/// styles/_tokens.scss) — chrome does not grow with the font picker, its family follows it.
const TITLE_PX: f64 = 13.0;

/// The client's top row is sampled at SAMPLES × SAMPLES points: whatever the output's
/// rotation, at least SAMPLES of them lie along the row.
const SAMPLES: i32 = 16;

const FS_AVERAGE: &str = r#"#version 100
precision highp float;
uniform sampler2D tex;
varying vec2 v_px;
void main() {
    vec4 sum = vec4(0.0);
    for (int y = 0; y < 16; y++) {
        for (int x = 0; x < 16; x++) {
            sum += texture2D(tex, (vec2(float(x), float(y)) + 0.5) / 16.0);
        }
    }
    gl_FragColor = sum / 256.0;
}
"#;

const FS_BAR: &str = concat!(
    "#version 100\nprecision highp float;\nvarying vec2 v_out;\nvarying vec2 v_fb;\n",
    controls_glsl!(),
    r#"
uniform sampler2D avg_tex;    // the client's top row, averaged: one texel, premultiplied
uniform sampler2D title_tex;  // the title, alpha only
uniform float has_avg;
uniform vec4 frame;           // the whole window, output px
uniform vec4 bar;             // the title bar, output px
uniform float radius;         // the window's corners, output px
uniform float exponent;
uniform vec4 title_rect;      // output px
uniform float has_title;
uniform float has_controls;
void main() {
    vec2 p = v_out;
    if (p.x < bar.x || p.y < bar.y || p.x >= bar.x + bar.z || p.y >= bar.y + bar.w) discard;
    vec4 bg = has_avg > 0.5 ? texture2D(avg_tex, vec2(0.5)) : vec4(0.12, 0.12, 0.13, 1.0);
    vec3 col = bg.a > 0.004 ? bg.rgb / bg.a : vec3(0.0);
    float lum = dot(pow(col, vec3(2.2)), vec3(0.2126, 0.7152, 0.0722));
    // Dark ink where black has the better contrast (WCAG: above 0.179) — on a translucent bar
    // only when it is mostly opaque, since through it the backdrop shows.
    float dark = (lum > 0.179 && bg.a > 0.5) ? 1.0 : 0.0;
    vec4 ink = dark > 0.5 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(1.0);
    vec4 c = bg;
    if (has_title > 0.5) {
        vec2 uv = (p - title_rect.xy) / title_rect.zw;
        if (uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0) {
            float a = texture2D(title_tex, uv).a;
            c = over(ink * a * (active > 0.5 ? 0.80 : 0.45), c);
        }
    }
    if (has_controls > 0.5) c = over(controls(p, dark), c);
    // The window's top corners: the glass's superellipse, as render/window.rs cuts them.
    vec2 h = frame.zw * 0.5;
    vec2 q = abs(p - frame.xy - h);
    vec2 inner = h - vec2(radius);
    if (radius > 0.0 && q.x > inner.x && q.y > inner.y) {
        vec2 k = (q - inner) / radius;
        float d = (pow(pow(k.x, exponent) + pow(k.y, exponent), 1.0 / exponent) - 1.0) * radius;
        c *= clamp(0.5 - d, 0.0, 1.0);
    }
    gl_FragColor = c;
}
"#
);

// ── The title, rasterised ──────────────────────────────────────────────────────────────

/// A window's title as Pango laid it out: alpha only, tightly packed rows, physical px.
pub struct Raster {
    id: u64,
    w: i32,
    h: i32,
    alpha: Vec<u8>,
}

impl std::fmt::Debug for Raster {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Raster").field("id", &self.id).field("w", &self.w).field("h", &self.h).finish()
    }
}

static NEXT_RASTER: AtomicU64 = AtomicU64::new(1);

/// The last title rasterised for a window, kept on its surface with what it was made from.
#[derive(Default)]
struct TitleMemo(RefCell<Option<(String, Option<Arc<Raster>>)>>);

/// `title` in `family` at `px` physical px, ellipsized to `max_w` px.
fn rasterize(title: &str, family: &str, px: f64, max_w: i32) -> Option<Raster> {
    let layout_on = |surface: &cairo::ImageSurface| -> Option<(cairo::Context, pango::Layout)> {
        let cr = cairo::Context::new(surface).ok()?;
        let layout = pangocairo::functions::create_layout(&cr);
        let mut desc = pango::FontDescription::new();
        desc.set_family(family);
        desc.set_weight(pango::Weight::Medium);
        desc.set_absolute_size(px * pango::SCALE as f64);
        layout.set_font_description(Some(&desc));
        layout.set_single_paragraph_mode(true);
        layout.set_ellipsize(pango::EllipsizeMode::End);
        layout.set_width(max_w * pango::SCALE);
        layout.set_text(title);
        Some((cr, layout))
    };
    let probe = cairo::ImageSurface::create(cairo::Format::A8, 1, 1).ok()?;
    let (_, layout) = layout_on(&probe)?;
    let (_, logical) = layout.pixel_extents();
    let (w, h) = (logical.width().clamp(1, max_w.max(1)), logical.height().max(1));
    let mut surface = cairo::ImageSurface::create(cairo::Format::A8, w, h).ok()?;
    {
        let (cr, layout) = layout_on(&surface)?;
        cr.set_source_rgba(1.0, 1.0, 1.0, 1.0);
        cr.move_to(-logical.x() as f64, -logical.y() as f64);
        pangocairo::functions::show_layout(&cr, &layout);
    }
    surface.flush();
    let stride = surface.stride() as usize;
    let data = surface.data().ok()?;
    let mut alpha = Vec::with_capacity((w * h) as usize);
    for row in 0..h as usize {
        alpha.extend_from_slice(&data[row * stride..row * stride + w as usize]);
    }
    Some(Raster { id: NEXT_RASTER.fetch_add(1, Ordering::Relaxed), w, h, alpha })
}

/// The window's title, rasterised — the one already made when nothing it depends on changed.
fn title_raster(surface: &WlSurface, title: &str, family: &str, px: f64, max_w: i32) -> Option<Arc<Raster>> {
    if title.trim().is_empty() || max_w < 16 {
        return None;
    }
    let key = format!("{family}\u{1}{px}\u{1}{max_w}\u{1}{title}");
    let cached = with_states(surface, |states| {
        let memo = states.data_map.get_or_insert(TitleMemo::default);
        memo.0.borrow().as_ref().filter(|(k, _)| *k == key).map(|(_, r)| r.clone())
    });
    if let Some(r) = cached {
        return r;
    }
    let raster = rasterize(title, family, px, max_w).map(Arc::new);
    if raster.is_none() {
        tracing::warn!(%family, "the title could not be rasterised");
    }
    with_states(surface, |states| {
        *states.data_map.get_or_insert(TitleMemo::default).0.borrow_mut() = Some((key, raster.clone()));
    });
    raster
}

// ── The element ────────────────────────────────────────────────────────────────────────

/// What `render/mod.rs` knows of a window's title bar: the rest comes from the window.
pub struct TitleBar {
    /// Its height, logical px.
    pub height: f64,
    pub title: String,
    pub family: String,
    pub active: bool,
    /// The capsule, output px, and what it shows.
    pub controls: Option<(Rectangle<f64, Physical>, Controls)>,
}

#[derive(Debug, Clone)]
pub struct TitleBarElement {
    id: Id,
    commit: CommitCounter,
    /// The bar and the whole window, output px (exact); the pixels the bar touches.
    bar: Rectangle<f64, Physical>,
    frame: Rectangle<f64, Physical>,
    geometry: Rectangle<i32, Physical>,
    radius: f64,
    exponent: f64,
    scale: f64,
    output_size: Size<i32, Physical>,
    /// The client's texture, the strip of it sampled (its top row, buffer px) and its transform.
    client: Option<(GlesTexture, Rectangle<f64, BufferCoords>, Transform)>,
    title: Option<(Arc<Raster>, Rectangle<i32, Physical>)>,
    controls: Option<(Rectangle<f64, Physical>, Controls)>,
    active: bool,
}

/// The element's id and what it last drew, kept on the window's surface.
#[derive(Default)]
struct BarMemo(RefCell<Option<(Id, CommitCounter, String)>>);

impl TitleBarElement {
    /// The bar over the client whose box is `geo` (output px). `client` is the client's texture
    /// in this renderer, if it has one.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        surface: &WlSurface,
        geo: Rectangle<f64, Physical>,
        bar: TitleBar,
        client: Option<GlesTexture>,
        radius: f64,
        exponent: f64,
        scale: Scale<f64>,
        output_size: Size<i32, Physical>,
    ) -> Self {
        let s = scale.x;
        let h = bar.height * s;
        let bar_rect = Rectangle::new((geo.loc.x, geo.loc.y - h).into(), (geo.size.w, h).into());
        let frame = Rectangle::new(bar_rect.loc, (geo.size.w, geo.size.h + h).into());
        // The row a little under the top edge (one buffer scale's worth): a client's very first
        // row is sometimes an edge of its own.
        let (strip, client_commit) = with_states(surface, |states| {
            states.data_map.get::<RendererSurfaceStateUserData>().map_or((None, CommitCounter::default()), |d| {
                let d = d.lock().unwrap();
                let strip = d.buffer_size().map(|_| (d.buffer_scale(), d.buffer_transform()));
                (strip, d.current_commit())
            })
        });
        let client = client.zip(strip).and_then(|(tex, (bscale, transform))| {
            use smithay::backend::renderer::Texture;
            let size = tex.size();
            if size.w <= 0 || size.h <= 0 {
                return None;
            }
            let y = (bscale.max(1) as f64).min(size.h as f64 - 1.0);
            Some((tex, Rectangle::new((0.0, y).into(), (size.w as f64, 1.0).into()), transform))
        });
        // The title, centred in the bar, never under the capsule: as wide as what the capsule
        // leaves on BOTH sides, so centred it stays clear of it.
        let reserve = (crate::protocols::window_controls::BAR_BUTTON_W * 3.0
            + 2.0 * crate::protocols::window_controls::BAR_MARGIN)
            * s;
        let max_w = (geo.size.w - 2.0 * reserve).floor() as i32;
        let title = title_raster(surface, &bar.title, &bar.family, (TITLE_PX * s).round(), max_w).map(|r| {
            let x = (bar_rect.loc.x + (bar_rect.size.w - r.w as f64) / 2.0).round() as i32;
            let y = (bar_rect.loc.y + (bar_rect.size.h - r.h as f64) / 2.0).round() as i32;
            let at = Rectangle::new((x, y).into(), (r.w, r.h).into());
            (r, at)
        });
        let key = format!(
            "{bar_rect:?} {frame:?} {radius} {exponent} {} {:?} {:?} {client_commit:?} {}",
            bar.active,
            bar.controls,
            title.as_ref().map(|(r, at)| (r.id, *at)),
            client.is_some(),
        );
        let (id, commit) = with_states(surface, |states| {
            let memo = states.data_map.get_or_insert(BarMemo::default);
            let mut memo = memo.0.borrow_mut();
            let entry = memo.get_or_insert_with(|| (Id::new(), CommitCounter::default(), key.clone()));
            if entry.2 != key {
                entry.1.increment();
                entry.2 = key;
            }
            (entry.0.clone(), entry.1)
        });
        Self {
            id,
            commit,
            bar: bar_rect,
            frame,
            geometry: bar_rect.to_i32_up::<i32>(),
            radius,
            exponent,
            scale: s,
            output_size,
            client,
            title,
            controls: bar.controls,
            active: bar.active,
        }
    }

    fn draw_gles(
        &self,
        frame: &mut GlesFrame<'_, '_>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
    ) -> Result<(), GlesError> {
        let projection = *frame.projection();
        let user_data = frame.egl_context().user_data() as *const UserDataMap;
        // 1. The client's top row into the sample target, through Smithay's texture path.
        let mut have_avg = false;
        if let Some((tex, src, transform)) = &self.client {
            // Safety: the EGL context outlives this frame, and its user data with it.
            let saved = frame.with_context(|gl| unsafe { begin_sampling(gl, &*user_data) })?;
            let full = Rectangle::from_size(self.output_size);
            let drawn = frame.render_texture_from_to(
                tex,
                *src,
                full,
                &[Rectangle::from_size(full.size)],
                &[],
                *transform,
                1.0,
                None,
                &[],
            );
            // 2. Averaged into one texel; the frame's own target back.
            frame.with_context(|gl| unsafe { end_sampling(gl, &*user_data, saved) })?;
            have_avg = drawn.is_ok();
        }
        // 3. The bar.
        let off = (dst.loc.x - self.geometry.loc.x) as f64;
        let off_y = (dst.loc.y - self.geometry.loc.y) as f64;
        let shift = |r: Rectangle<f64, Physical>| [(r.loc.x + off) as f32, (r.loc.y + off_y) as f32, r.size.w as f32, r.size.h as f32];
        let (bar, win) = (shift(self.bar), shift(self.frame));
        frame.with_context(|gl| unsafe {
            // Safety: as above.
            let ud = &*user_data;
            let progs = glass_gl::programs(gl, ud);
            let tb = gl_objects(gl, ud);
            let fb = glass_gl::fb_size(gl);
            let title_tex = self.title.as_ref().map(|(r, _)| tb.title_texture(gl, r));
            gl.Enable(ffi::BLEND);
            gl.BlendFunc(ffi::ONE, ffi::ONE_MINUS_SRC_ALPHA);
            gl.BindBuffer(ffi::ARRAY_BUFFER, progs.vbo);
            let p = &tb.bar;
            gl.UseProgram(p.id);
            gl.EnableVertexAttribArray(p.pos);
            gl.VertexAttribPointer(p.pos, 2, ffi::FLOAT, ffi::FALSE, 0, std::ptr::null());
            gl.ActiveTexture(ffi::TEXTURE0);
            gl.BindTexture(ffi::TEXTURE_2D, tb.avg.0);
            gl.Uniform1i(p.loc(gl, c"avg_tex"), 0);
            gl.ActiveTexture(ffi::TEXTURE1);
            gl.BindTexture(ffi::TEXTURE_2D, title_tex.unwrap_or(0));
            gl.Uniform1i(p.loc(gl, c"title_tex"), 1);
            gl.UniformMatrix3fv(p.loc(gl, c"projection"), 1, ffi::FALSE, projection.as_ptr());
            gl.Uniform2f(p.loc(gl, c"fb_size"), fb.0 as f32, fb.1 as f32);
            gl.Uniform1f(p.loc(gl, c"has_avg"), if have_avg { 1.0 } else { 0.0 });
            gl.Uniform4f(p.loc(gl, c"frame"), win[0], win[1], win[2], win[3]);
            gl.Uniform4f(p.loc(gl, c"bar"), bar[0], bar[1], bar[2], bar[3]);
            gl.Uniform1f(p.loc(gl, c"radius"), self.radius as f32);
            gl.Uniform1f(p.loc(gl, c"exponent"), self.exponent as f32);
            match (&self.title, title_tex) {
                (Some((_, at)), Some(_)) => {
                    gl.Uniform4f(
                        p.loc(gl, c"title_rect"),
                        (at.loc.x as f64 + off) as f32,
                        (at.loc.y as f64 + off_y) as f32,
                        at.size.w as f32,
                        at.size.h as f32,
                    );
                    gl.Uniform1f(p.loc(gl, c"has_title"), 1.0);
                }
                _ => gl.Uniform1f(p.loc(gl, c"has_title"), 0.0),
            }
            gl.Uniform1f(p.loc(gl, c"active"), if self.active { 1.0 } else { 0.0 });
            gl.Uniform1f(p.loc(gl, c"px"), self.scale as f32);
            match &self.controls {
                Some((r, c)) => {
                    let r = shift(*r);
                    let glyphs = c.buttons.map(crate::protocols::window_controls::Button::glyph);
                    let enabled = c.enabled.map(|e| if e { 1.0f32 } else { 0.0 });
                    gl.Uniform1f(p.loc(gl, c"has_controls"), 1.0);
                    gl.Uniform4f(p.loc(gl, c"rect"), r[0], r[1], r[2], r[3]);
                    gl.Uniform3f(p.loc(gl, c"glyphs"), glyphs[0], glyphs[1], glyphs[2]);
                    gl.Uniform3f(p.loc(gl, c"enabled"), enabled[0], enabled[1], enabled[2]);
                    gl.Uniform1f(p.loc(gl, c"hover"), c.hover.map_or(-1.0, |h| h as f32));
                    gl.Uniform1f(p.loc(gl, c"pressed"), if c.pressed { 1.0 } else { 0.0 });
                }
                None => gl.Uniform1f(p.loc(gl, c"has_controls"), 0.0),
            }
            for d in damage {
                let q = Rectangle::new(d.loc + dst.loc, d.size);
                gl.Uniform4f(p.loc(gl, c"dst_rect"), q.loc.x as f32, q.loc.y as f32, q.size.w as f32, q.size.h as f32);
                gl.DrawArrays(ffi::TRIANGLE_STRIP, 0, 4);
            }
            gl.BindTexture(ffi::TEXTURE_2D, 0);
            gl.ActiveTexture(ffi::TEXTURE0);
            gl.BindTexture(ffi::TEXTURE_2D, 0);
            gl.DisableVertexAttribArray(p.pos);
            gl.BindBuffer(ffi::ARRAY_BUFFER, 0);
            gl.UseProgram(0);
        })
    }
}

impl Element for TitleBarElement {
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

impl<R: HyaloRenderer> RenderElement<R> for TitleBarElement {
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

// ── GL objects ─────────────────────────────────────────────────────────────────────────

/// What the title bars need in one GL context (its user data): the two programs, the sample
/// target and its one-texel average, and the titles' textures.
struct TitleBarGl {
    average: Program,
    bar: Program,
    /// SAMPLES × SAMPLES: texture, framebuffer.
    strip: (u32, u32),
    /// 1 × 1: texture, framebuffer.
    avg: (u32, u32),
    /// Uploaded titles, most recently used last: raster id, texture.
    titles: RefCell<Vec<(u64, u32)>>,
}

/// The most title textures kept: one per window with a bar on screen, and some to spare.
const MAX_TITLES: usize = 32;

unsafe fn target(gl: &ffi::Gles2, w: i32, h: i32) -> (u32, u32) {
    unsafe {
        let (mut tex, mut fbo) = (0, 0);
        gl.GenTextures(1, &mut tex);
        gl.BindTexture(ffi::TEXTURE_2D, tex);
        gl.TexImage2D(ffi::TEXTURE_2D, 0, ffi::RGBA as i32, w, h, 0, ffi::RGBA, ffi::UNSIGNED_BYTE, std::ptr::null());
        gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_MIN_FILTER, ffi::NEAREST as i32);
        gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_MAG_FILTER, ffi::NEAREST as i32);
        gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_WRAP_S, ffi::CLAMP_TO_EDGE as i32);
        gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_WRAP_T, ffi::CLAMP_TO_EDGE as i32);
        gl.BindTexture(ffi::TEXTURE_2D, 0);
        let mut prev = 0;
        gl.GetIntegerv(ffi::FRAMEBUFFER_BINDING, &mut prev);
        gl.GenFramebuffers(1, &mut fbo);
        gl.BindFramebuffer(ffi::FRAMEBUFFER, fbo);
        gl.FramebufferTexture2D(ffi::FRAMEBUFFER, ffi::COLOR_ATTACHMENT0, ffi::TEXTURE_2D, tex, 0);
        gl.BindFramebuffer(ffi::FRAMEBUFFER, prev as u32);
        (tex, fbo)
    }
}

impl TitleBarGl {
    unsafe fn new(gl: &ffi::Gles2) -> Self {
        unsafe {
            Self {
                average: glass_gl::compile(gl, glass_gl::VS_PASS, FS_AVERAGE),
                bar: glass_gl::compile(gl, glass_gl::VS_FINAL, FS_BAR),
                strip: target(gl, SAMPLES, SAMPLES),
                avg: target(gl, 1, 1),
                titles: RefCell::new(Vec::new()),
            }
        }
    }

    /// The texture of `r`, uploaded if it is not yet.
    unsafe fn title_texture(&self, gl: &ffi::Gles2, r: &Raster) -> u32 {
        let mut titles = self.titles.borrow_mut();
        if let Some(i) = titles.iter().position(|(id, _)| *id == r.id) {
            let hit = titles.remove(i);
            titles.push(hit);
            return hit.1;
        }
        unsafe {
            if titles.len() >= MAX_TITLES {
                let (_, old) = titles.remove(0);
                gl.DeleteTextures(1, &old);
            }
            let mut tex = 0;
            gl.GenTextures(1, &mut tex);
            gl.BindTexture(ffi::TEXTURE_2D, tex);
            gl.PixelStorei(ffi::UNPACK_ALIGNMENT, 1);
            gl.TexImage2D(
                ffi::TEXTURE_2D, 0, ffi::ALPHA as i32, r.w, r.h, 0, ffi::ALPHA, ffi::UNSIGNED_BYTE,
                r.alpha.as_ptr() as *const _,
            );
            gl.PixelStorei(ffi::UNPACK_ALIGNMENT, 4);
            gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_MIN_FILTER, ffi::LINEAR as i32);
            gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_MAG_FILTER, ffi::LINEAR as i32);
            gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_WRAP_S, ffi::CLAMP_TO_EDGE as i32);
            gl.TexParameteri(ffi::TEXTURE_2D, ffi::TEXTURE_WRAP_T, ffi::CLAMP_TO_EDGE as i32);
            titles.push((r.id, tex));
            tex
        }
    }
}

unsafe fn gl_objects<'a>(gl: &ffi::Gles2, user_data: &'a UserDataMap) -> &'a TitleBarGl {
    user_data.insert_if_missing(|| unsafe { TitleBarGl::new(gl) });
    user_data.get::<TitleBarGl>().unwrap()
}

/// The frame's GL state that sampling changes.
#[derive(Clone, Copy)]
struct Saved {
    fbo: i32,
    viewport: [i32; 4],
    scissor: bool,
    blend: bool,
}

/// The sample target bound, cleared and filling the viewport: Smithay's next texture draw,
/// stretched over the whole output, lands in it.
unsafe fn begin_sampling(gl: &ffi::Gles2, user_data: &UserDataMap) -> Saved {
    unsafe {
        let tb = gl_objects(gl, user_data);
        let mut saved = Saved { fbo: 0, viewport: [0; 4], scissor: false, blend: false };
        gl.GetIntegerv(ffi::FRAMEBUFFER_BINDING, &mut saved.fbo);
        gl.GetIntegerv(ffi::VIEWPORT, saved.viewport.as_mut_ptr());
        saved.scissor = gl.IsEnabled(ffi::SCISSOR_TEST) == ffi::TRUE;
        saved.blend = gl.IsEnabled(ffi::BLEND) == ffi::TRUE;
        gl.BindFramebuffer(ffi::FRAMEBUFFER, tb.strip.1);
        gl.Viewport(0, 0, SAMPLES, SAMPLES);
        gl.Disable(ffi::SCISSOR_TEST);
        gl.ClearColor(0.0, 0.0, 0.0, 0.0);
        gl.Clear(ffi::COLOR_BUFFER_BIT);
        saved
    }
}

/// The samples averaged into the one-texel target, and the frame's state put back.
unsafe fn end_sampling(gl: &ffi::Gles2, user_data: &UserDataMap, saved: Saved) {
    unsafe {
        let progs = glass_gl::programs(gl, user_data);
        let tb = gl_objects(gl, user_data);
        gl.BindFramebuffer(ffi::FRAMEBUFFER, tb.avg.1);
        gl.Viewport(0, 0, 1, 1);
        gl.Disable(ffi::BLEND);
        let p = &tb.average;
        gl.UseProgram(p.id);
        gl.BindBuffer(ffi::ARRAY_BUFFER, progs.vbo);
        gl.EnableVertexAttribArray(p.pos);
        gl.VertexAttribPointer(p.pos, 2, ffi::FLOAT, ffi::FALSE, 0, std::ptr::null());
        gl.ActiveTexture(ffi::TEXTURE0);
        gl.BindTexture(ffi::TEXTURE_2D, tb.strip.0);
        gl.Uniform1i(p.loc(gl, c"tex"), 0);
        gl.Uniform4f(p.loc(gl, c"dst_rect"), 0.0, 0.0, 1.0, 1.0);
        gl.Uniform2f(p.loc(gl, c"target_size"), 1.0, 1.0);
        gl.DrawArrays(ffi::TRIANGLE_STRIP, 0, 4);
        gl.DisableVertexAttribArray(p.pos);
        gl.BindBuffer(ffi::ARRAY_BUFFER, 0);
        gl.BindTexture(ffi::TEXTURE_2D, 0);
        gl.UseProgram(0);
        gl.BindFramebuffer(ffi::FRAMEBUFFER, saved.fbo as u32);
        let v = saved.viewport;
        gl.Viewport(v[0], v[1], v[2], v[3]);
        if saved.scissor {
            gl.Enable(ffi::SCISSOR_TEST);
        }
        if saved.blend {
            gl.Enable(ffi::BLEND);
        } else {
            gl.Disable(ffi::BLEND);
        }
    }
}
