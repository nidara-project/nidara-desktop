//! A window as it is drawn: its corners rounded, and — when it is translucent — a blur behind it;
//! its controls over its header (render/controls.rs).
//! What Hyprland did for Nidara (`rounding`, `rounding_power`, `decoration:blur`), which the
//! desktop was built around: our own windows draw square, transparent toplevels and leave the
//! corners and the backdrop to the compositor (`window.nidara-app-window`, the kit's
//! `_components.scss`).
//!
//! - **Corners**: the window's surfaces are drawn through a texture shader of ours (Smithay's
//!   `override_default_tex_program`, public API) that cuts the corners of the window's box with
//!   the same superellipse as the glass (`rounding_power` 2 = a circle). Only inside the box's
//!   corner squares; a fullscreen window is never rounded, and neither is one whose surface
//!   reaches past its geometry — a client-side decoration with a shadow margin draws its own
//!   corners. Popups are not cut.
//! - **Backdrop** (#708 point 1, "A, automatic"): the WINDOW material — blur and Hyprland's
//!   finishing (contrast, vibrancy, noise), no refraction, no tint: a window's own translucent
//!   background is its tint. Its own settings (`[windows.backdrop]`), apart from the shell's
//!   glass. Under every window that is translucent: whose opaque region leaves some of its box
//!   uncovered, beyond the corners' squares. Cut to the box and its corners — never the
//!   client-side shadow margin, or a blurred halo would ring the window.
//! - A rule (`rounding = false`, `backdrop = false`) turns either off for an app.

use std::cell::RefCell;

use smithay::{
    backend::renderer::{
        element::{
            Element, Id, Kind, RenderElement, UnderlyingStorage,
            surface::{WaylandSurfaceRenderElement, render_elements_from_surface_tree},
        },
        gles::{GlesTexProgram, Uniform, UniformName, UniformType},
        utils::{CommitCounter, DamageSet, OpaqueRegions, RendererSurfaceStateUserData},
    },
    desktop::{PopupManager, Window},
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Buffer as BufferCoords, Logical, Physical, Point, Rectangle, Scale, Size, Transform, user_data::UserDataMap},
    wayland::compositor::with_states,
};

use super::{GlassElement, HyaloRenderer, OutputElement, glass_gl};
use crate::config::WindowsConfig;

/// The surface texture shader with the corners cut: Smithay's own (`texture.frag`), plus the
/// window's box in output pixels and the map from the framebuffer back to them.
const FS_ROUNDED: &str = r#"#version 100

//_DEFINES_

#if defined(EXTERNAL)
#extension GL_OES_EGL_image_external : require
#endif

precision highp float;
#if defined(EXTERNAL)
uniform samplerExternalOES tex;
#else
uniform sampler2D tex;
#endif

uniform float alpha;
varying vec2 v_coords;

#if defined(DEBUG_FLAGS)
uniform float tint;
#endif

uniform mat3 fb_to_out;   // framebuffer pixels → output pixels (the inverse of the projection)
uniform vec4 geo;         // the window's box, output pixels
uniform float radius;
uniform float exponent;
uniform vec4 clip;        // nothing is drawn outside it, output pixels: a client's shadow margin

void main() {
    vec4 color = texture2D(tex, v_coords);
#if defined(NO_ALPHA)
    color = vec4(color.rgb, 1.0) * alpha;
#else
    color = color * alpha;
#endif

    // Only inside the corner squares: the superellipse of the glass (glass_gl.rs `sdf_box`),
    // anti-aliased over one pixel.
    vec2 p = (fb_to_out * vec3(gl_FragCoord.xy, 1.0)).xy;
    if (p.x < clip.x || p.y < clip.y || p.x >= clip.x + clip.z || p.y >= clip.y + clip.w) discard;
    vec2 h = geo.zw * 0.5;
    vec2 q = abs(p - geo.xy - h);
    vec2 inner = h - vec2(radius);
    if (radius > 0.0 && q.x > inner.x && q.y > inner.y) {
        vec2 k = (q - inner) / radius;
        float d = (pow(pow(k.x, exponent) + pow(k.y, exponent), 1.0 / exponent) - 1.0) * radius;
        color *= clamp(0.5 - d, 0.0, 1.0);
    }

#if defined(DEBUG_FLAGS)
    if (tint == 1.0)
        color = vec4(0.0, 0.2, 0.0, 0.2) + color * 0.8;
#endif

    gl_FragColor = color;
}
"#;

/// An element whose geometry is computed at a scale of its own, not the output's: a window
/// shrinking into the dock is drawn at `scale × k` (wm/minimize.rs), and Smithay's surface
/// elements size themselves from the scale the damage tracker passes — the output's. Without
/// this, a shrinking window's surfaces kept their full size from a scaled origin: the box
/// around the small window was drawn too, stale or blank (seen nested, 2026-10-04). At the
/// output's own scale it changes nothing.
#[derive(Debug)]
pub struct AtScale<E> {
    pub inner: E,
    pub scale: Scale<f64>,
}

impl<E: Element> Element for AtScale<E> {
    fn id(&self) -> &Id {
        self.inner.id()
    }
    fn current_commit(&self) -> CommitCounter {
        self.inner.current_commit()
    }
    fn location(&self, _scale: Scale<f64>) -> Point<i32, Physical> {
        self.inner.location(self.scale)
    }
    fn src(&self) -> Rectangle<f64, BufferCoords> {
        self.inner.src()
    }
    fn transform(&self) -> Transform {
        self.inner.transform()
    }
    fn geometry(&self, _scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.inner.geometry(self.scale)
    }
    fn damage_since(&self, _scale: Scale<f64>, commit: Option<CommitCounter>) -> DamageSet<i32, Physical> {
        self.inner.damage_since(self.scale, commit)
    }
    fn opaque_regions(&self, _scale: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        self.inner.opaque_regions(self.scale)
    }
    fn alpha(&self) -> f32 {
        self.inner.alpha()
    }
    fn kind(&self) -> Kind {
        self.inner.kind()
    }
}

impl<R: smithay::backend::renderer::Renderer, E: RenderElement<R>> RenderElement<R> for AtScale<E> {
    fn draw(
        &self,
        frame: &mut R::Frame<'_, '_>,
        src: Rectangle<f64, BufferCoords>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        opaque_regions: &[Rectangle<i32, Physical>],
        cache: Option<&UserDataMap>,
    ) -> Result<(), R::Error> {
        self.inner.draw(frame, src, dst, damage, opaque_regions, cache)
    }

    /// Passed on: a fullscreen window still goes straight to the display (direct scan-out).
    fn underlying_storage(&self, renderer: &mut R) -> Option<UnderlyingStorage<'_>> {
        self.inner.underlying_storage(renderer)
    }
}

/// The compiled shader, once per GL context (its user data).
struct RoundedProgram(Option<GlesTexProgram>);

fn rounded_program<R: HyaloRenderer>(renderer: &mut R) -> Option<GlesTexProgram> {
    let gles = renderer.gles();
    if let Some(p) = gles.egl_context().user_data().get::<RoundedProgram>() {
        return p.0.clone();
    }
    let compiled = gles
        .compile_custom_texture_shader(
            FS_ROUNDED,
            &[
                UniformName::new("fb_to_out", UniformType::Matrix3x3),
                UniformName::new("geo", UniformType::_4f),
                UniformName::new("radius", UniformType::_1f),
                UniformName::new("exponent", UniformType::_1f),
                UniformName::new("clip", UniformType::_4f),
            ],
        )
        .map_err(|err| tracing::error!(?err, "the rounded-corner shader did not compile: windows stay square"))
        .ok();
    gles.egl_context().user_data().insert_if_missing(|| RoundedProgram(compiled.clone()));
    compiled
}

/// A surface of a window, its corners cut to the window's box.
pub struct RoundedElement<R: smithay::backend::renderer::Renderer> {
    inner: AtScale<WaylandSurfaceRenderElement<R>>,
    program: GlesTexProgram,
    /// The window's box, output pixels.
    geo: Rectangle<f64, Physical>,
    radius: f64,
    exponent: f64,
    /// Where the surface may draw, output pixels: the client's box when it draws a frame with a
    /// shadow margin (`push`), else anywhere.
    clip: Option<Rectangle<f64, Physical>>,
}

/// The rounded shader's uniforms for a box `geo` with its corners, drawing only inside `clip`.
fn rounded_uniforms(
    projection: &[f32; 9],
    fb: (i32, i32),
    geo: Rectangle<f64, Physical>,
    radius: f64,
    exponent: f64,
    clip: Option<Rectangle<f64, Physical>>,
) -> Vec<Uniform<'static>> {
    let c = clip.map_or((-1e7, -1e7, 2e7, 2e7), |c| (c.loc.x as f32, c.loc.y as f32, c.size.w as f32, c.size.h as f32));
    vec![
        Uniform::new(
            "fb_to_out",
            smithay::backend::renderer::gles::UniformValue::Matrix3x3 { matrices: vec![fb_to_out(projection, fb)], transpose: false },
        ),
        Uniform::new("geo", (geo.loc.x as f32, geo.loc.y as f32, geo.size.w as f32, geo.size.h as f32)),
        Uniform::new("radius", radius as f32),
        Uniform::new("exponent", exponent as f32),
        Uniform::new("clip", c),
    ]
}

impl<R: smithay::backend::renderer::Renderer> std::fmt::Debug for RoundedElement<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RoundedElement").field("inner", &self.inner).field("geo", &self.geo).finish()
    }
}

impl<R: HyaloRenderer> RoundedElement<R> {
    /// The parts of the box's corner squares the curve leaves out, output pixels, whole pixels
    /// grown outward: what is no longer opaque.
    fn corners(&self) -> [Rectangle<i32, Physical>; 4] {
        let r = self.radius.ceil() as i32;
        let g = self.geo.to_i32_round::<i32>();
        let (x0, y0, x1, y1) = (g.loc.x, g.loc.y, g.loc.x + g.size.w - r, g.loc.y + g.size.h - r);
        [(x0, y0), (x1, y0), (x0, y1), (x1, y1)].map(|(x, y)| Rectangle::new((x, y).into(), (r, r).into()))
    }
}

impl<R: HyaloRenderer> Element for RoundedElement<R> {
    fn id(&self) -> &Id {
        self.inner.id()
    }
    fn current_commit(&self) -> CommitCounter {
        self.inner.current_commit()
    }
    fn location(&self, scale: Scale<f64>) -> Point<i32, Physical> {
        self.inner.location(scale)
    }
    fn src(&self) -> Rectangle<f64, BufferCoords> {
        self.inner.src()
    }
    fn transform(&self) -> Transform {
        self.inner.transform()
    }
    fn geometry(&self, scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.inner.geometry(scale)
    }
    fn damage_since(&self, scale: Scale<f64>, commit: Option<CommitCounter>) -> DamageSet<i32, Physical> {
        self.inner.damage_since(scale, commit)
    }
    /// The surface's own, without the cut corners and inside the clip: what lies behind them
    /// must still be drawn.
    fn opaque_regions(&self, scale: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        let at = self.inner.geometry(scale).loc;
        let corners = self.corners().map(|c| Rectangle::new(c.loc - at, c.size));
        let clip = self.clip.map(|c| {
            let c = c.to_i32_up::<i32>();
            Rectangle::new(c.loc - at, c.size)
        });
        let regions: Vec<Rectangle<i32, Physical>> = self
            .inner
            .opaque_regions(scale)
            .iter()
            .filter_map(|r| match clip {
                Some(c) => r.intersection(c),
                None => Some(*r),
            })
            .collect();
        Rectangle::subtract_rects_many(regions, corners).into_iter().collect()
    }
    fn alpha(&self) -> f32 {
        self.inner.alpha()
    }
    /// Never a candidate for scan-out: the plane would show the corners uncut.
    fn kind(&self) -> Kind {
        Kind::Unspecified
    }
}

impl<R: HyaloRenderer> RenderElement<R> for RoundedElement<R> {
    fn draw(
        &self,
        frame: &mut R::Frame<'_, '_>,
        src: Rectangle<f64, BufferCoords>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        opaque_regions: &[Rectangle<i32, Physical>],
        cache: Option<&UserDataMap>,
    ) -> Result<(), R::Error> {
        {
            let gles = R::gles_frame(frame);
            let projection = *gles.projection();
            // Safety: only reads the viewport Smithay set for this frame.
            let fb = gles.with_context(|gl| unsafe { glass_gl::fb_size(gl) }).map_err(R::from_gles_error)?;
            gles.override_default_tex_program(
                self.program.clone(),
                rounded_uniforms(&projection, fb, self.geo, self.radius, self.exponent, self.clip),
            );
        }
        let drawn = self.inner.draw(frame, src, dst, damage, opaque_regions, cache);
        R::gles_frame(frame).clear_tex_program_override();
        drawn
    }

    fn underlying_storage(&self, _renderer: &mut R) -> Option<UnderlyingStorage<'_>> {
        None
    }
}

/// Framebuffer pixels → output pixels: the inverse of Smithay's projection (output pixels →
/// clip space, column-major) after framebuffer pixels → clip space.
fn fb_to_out(projection: &[f32; 9], fb: (i32, i32)) -> [f32; 9] {
    let m = |c: usize, r: usize| projection[c * 3 + r] as f64;
    let det = m(0, 0) * (m(1, 1) * m(2, 2) - m(2, 1) * m(1, 2)) - m(1, 0) * (m(0, 1) * m(2, 2) - m(2, 1) * m(0, 2))
        + m(2, 0) * (m(0, 1) * m(1, 2) - m(1, 1) * m(0, 2));
    if det.abs() < 1e-12 {
        return [1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0];
    }
    // inv[c][r], column-major, by cofactors.
    let mut inv = [[0f64; 3]; 3];
    for (c, col) in inv.iter_mut().enumerate() {
        for (r, v) in col.iter_mut().enumerate() {
            // The cofactor of (row c, column r) of m, transposed.
            let (r0, r1) = match c {
                0 => (1, 2),
                1 => (0, 2),
                _ => (0, 1),
            };
            let (c0, c1) = match r {
                0 => (1, 2),
                1 => (0, 2),
                _ => (0, 1),
            };
            let minor = m(c0, r0) * m(c1, r1) - m(c1, r0) * m(c0, r1);
            let sign = if (r + c) % 2 == 0 { 1.0 } else { -1.0 };
            *v = sign * minor / det;
        }
    }
    // Framebuffer pixels → clip space: x * 2 / w − 1.
    let (sx, sy) = (2.0 / fb.0.max(1) as f64, 2.0 / fb.1.max(1) as f64);
    let s = [[sx, 0.0, 0.0], [0.0, sy, 0.0], [-1.0, -1.0, 1.0]];
    let mut out = [0f32; 9];
    for c in 0..3 {
        for r in 0..3 {
            out[c * 3 + r] = (0..3).map(|k| inv[k][r] * s[c][k]).sum::<f64>() as f32;
        }
    }
    out
}

/// The backdrop's element id and what it was last drawn as, kept on the window's surface: the
/// commit moves when the box or the numbers change, so the blur is captured again.
#[derive(Default)]
struct BackdropState(RefCell<Option<(Id, CommitCounter, String)>>);

/// Whether `surface` lets anything through inside `geo` (surface-local logical), beyond the
/// corner squares of `radius`: its opaque region leaves part of the box uncovered.
pub fn translucent(surface: &WlSurface, geo: Rectangle<i32, Logical>, radius: f64) -> bool {
    let opaque: Vec<Rectangle<i32, Logical>> = with_states(surface, |states| {
        states
            .data_map
            .get::<RendererSurfaceStateUserData>()
            .and_then(|s| s.lock().unwrap().opaque_regions().map(|r| r.to_vec()))
            .unwrap_or_default()
    });
    let r = radius.ceil() as i32;
    let in_a_corner = |u: &Rectangle<i32, Logical>| {
        let (x0, y0, x1, y1) = (geo.loc.x, geo.loc.y, geo.loc.x + geo.size.w, geo.loc.y + geo.size.h);
        let left = u.loc.x + u.size.w <= x0 + r;
        let right = u.loc.x >= x1 - r;
        let top = u.loc.y + u.size.h <= y0 + r;
        let bottom = u.loc.y >= y1 - r;
        (left || right) && (top || bottom)
    };
    Rectangle::subtract_rects_many([geo], opaque).iter().any(|u| u.size.w > 0 && u.size.h > 0 && !in_a_corner(u))
}

/// What one window looks like: whether it is rounded and blurred behind, and why not.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize)]
pub struct Look {
    pub rounded: bool,
    pub backdrop: bool,
}

/// The size of a surface's buffer as it is shown, logical.
fn surface_size(surface: &WlSurface) -> Option<Size<i32, Logical>> {
    with_states(surface, |states| {
        states.data_map.get::<RendererSurfaceStateUserData>().and_then(|s| s.lock().unwrap().surface_size())
    })
}

/// Whether a window's surface is its box: no client-side shadow margin around it — the
/// decorations it may draw are inside its geometry, or it draws none.
pub fn fits(window: &Window) -> bool {
    let Some(surface) = window.toplevel().map(|t| t.wl_surface().clone()) else { return false };
    let geo = window.geometry();
    geo.loc == Point::from((0, 0)) && surface_size(&surface).is_some_and(|s| s == geo.size)
}

/// What `cfg` and the window's rules make of it.
pub fn look(window: &Window, fullscreen: bool, rule_rounded: bool, rule_backdrop: bool, cfg: &WindowsConfig) -> Look {
    let Some(surface) = window.toplevel().map(|t| t.wl_surface().clone()) else { return Look::default() };
    let geo = window.geometry();
    // Every window, its own frame drawn or not (owner, 2026-10-04: "no window keeps square
    // corners"): one that draws a frame with a shadow margin is cut to its box (`push`).
    let rounded = rule_rounded && !fullscreen && cfg.rounding > 0.0;
    let radius = if rounded { cfg.rounding } else { 0.0 };
    let backdrop = rule_backdrop && cfg.backdrop.enabled && cfg.backdrop.passes > 0 && translucent(&surface, geo, radius);
    Look { rounded, backdrop }
}

/// A window, front to back: its popups, its surfaces (cut to its corners), and the blur behind
/// it. `location` is where its surface's origin lands, output pixels; `geo` its box there.
#[allow(clippy::too_many_arguments)]
pub fn push<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    renderer: &mut R,
    window: &Window,
    look: Look,
    location: Point<i32, Physical>,
    geo: Rectangle<f64, Physical>,
    scale: Scale<f64>,
    output_size: Size<i32, Physical>,
    cfg: &WindowsConfig,
    controls: Option<(Rectangle<f64, Physical>, super::controls::Controls)>,
    title_bar: Option<super::title_bar::TitleBar>,
    decor: Option<bool>,
    when: std::time::Instant,
) {
    let Some(surface) = window.toplevel().map(|t| t.wl_surface().clone()) else { return };
    // A popup's position is relative to its parent's WINDOW GEOMETRY, not its surface (xdg-shell;
    // Smithay's own `Window::render_elements` adds `geometry().loc`). Left out, the menus of a
    // window whose geometry starts inside its surface — Firefox drawing its own frame, a 21,19 px
    // shadow margin — were drawn that much up and left of where the pointer reached them
    // (owner, 2026-10-04: "the hover lights with the pointer below the item").
    let geometry_loc = window.geometry().loc;
    for (popup, offset) in PopupManager::popups_for_surface(&surface) {
        let offset = (geometry_loc + offset - popup.geometry().loc).to_f64().to_physical(scale).to_i32_round();
        super::push_tree(out, renderer, popup.wl_surface(), location + offset, scale, output_size, Kind::Unspecified, when);
    }
    // Its controls: over its own surfaces, under its popups (a menu opened from the header
    // covers them).
    if let Some((rect, controls)) = controls {
        out.push(OutputElement::Controls(super::controls::ControlsElement::new(&surface, rect, scale, controls)));
    }
    let radius = cfg.rounding * scale.x;
    // With Hyalo's title bar on top, the window's box — its corners, its backdrop — is the
    // bar and the client together: the client's top corners are inside, not cut.
    let bar_px = title_bar.as_ref().map_or(0.0, |t| t.height * scale.x);
    let frame = Rectangle::new((geo.loc.x, geo.loc.y - bar_px).into(), (geo.size.w, geo.size.h + bar_px).into());
    // A client-side frame with a shadow margin (Chrome's web apps, Telegram) is cut to its box,
    // the margin dropped, and its corners to the window's — as every desktop rounds a web page
    // (owner, 2026-10-04, over a ring of Hyalo's own: it stretched the client's edges, and what
    // touched them streaked). What lies in the corners' outer 4.7 px along the diagonal
    // (`rounding` 24, `rounding_power` 3.2) is not shown.
    let clip = (!fits(window)).then_some(geo);
    let program = look.rounded.then(|| rounded_program(renderer)).flatten();
    let at = out.len();
    match &program {
        Some(program) => {
            let elements: Vec<WaylandSurfaceRenderElement<R>> =
                render_elements_from_surface_tree(renderer, &surface, location, scale, 1.0, Kind::Unspecified);
            out.extend(elements.into_iter().map(|inner| {
                OutputElement::Rounded(RoundedElement {
                    inner: AtScale { inner, scale },
                    program: program.clone(),
                    geo: frame,
                    radius,
                    exponent: cfg.rounding_power,
                    clip,
                })
            }));
            super::push_material(out, &surface, location, scale, output_size, when);
        }
        None => super::push_tree(out, renderer, &surface, location, scale, output_size, Kind::ScanoutCandidate, when),
    }
    // The title bar, made after the surfaces (their buffers are imported by now, and it samples
    // the client's), placed before them: under its popups like the controls.
    if let Some(tb) = title_bar {
        // The topmost surface of its tree over its top row that has drawn (Firefox's is a
        // subsurface).
        let (sampled, client) = super::title_bar::sampled_surfaces(&surface, window.geometry())
            .into_iter()
            .find_map(|(s, g)| renderer.surface_texture(&s).map(|t| ((s, g), t)))
            .unzip();
        let r = if look.rounded { radius } else { 0.0 };
        let element = super::title_bar::TitleBarElement::new(
            &surface,
            sampled.as_ref().map(|(s, g)| (s, *g)),
            geo,
            tb,
            client,
            r,
            cfg.rounding_power,
            scale,
            output_size,
        );
        out.insert(at, OutputElement::TitleBar(element));
    }
    let geo = frame;
    // Its line and its shadow: outside its box, so under its popups where they reach past it —
    // and IN FRONT of its backdrop, which then does not see them: behind it, the blur took the
    // window's own shadow in at its edges and darkened its inside (measured: 103 → 96).
    let decor = decor.and_then(|active| {
        super::decor::DecorElement::new(&surface, geo, if look.rounded { radius } else { 0.0 }, active, cfg, scale)
    });
    out.extend(decor.map(OutputElement::Decor));
    if look.backdrop {
        let b = &cfg.backdrop;
        let radius = if look.rounded { radius } else { 0.0 };
        let key = format!("{geo:?} {radius} {} {b:?} {}", cfg.rounding_power, scale.x);
        let (id, commit) = with_states(&surface, |states| {
            let state = states.data_map.get_or_insert(BackdropState::default);
            let mut state = state.0.borrow_mut();
            let entry = state.get_or_insert_with(|| (Id::new(), CommitCounter::default(), key.clone()));
            if entry.2 != key {
                entry.1.increment();
                entry.2 = key;
            }
            (entry.0.clone(), entry.1)
        });
        let finish = glass_gl::Finish {
            contrast: b.contrast as f32,
            brightness: b.brightness as f32,
            vibrancy: b.vibrancy as f32,
            vibrancy_darkness: b.vibrancy_darkness as f32,
            noise: b.noise as f32,
        };
        out.extend(
            GlassElement::backdrop(id, commit, geo, radius, cfg.rounding_power, b.size * scale.x, b.passes, finish, output_size, &surface)
                .map(OutputElement::Glass),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fb_to_out_inverts_the_projection() {
        // A 1920×1080 output, framebuffer the same size, y flipped (Smithay's flip180).
        let (w, h) = (1920.0f32, 1080.0f32);
        let projection = [2.0 / w, 0.0, 0.0, 0.0, -2.0 / h, 0.0, -1.0, 1.0, 1.0];
        let m = fb_to_out(&projection, (1920, 1080));
        let apply = |x: f32, y: f32| (m[0] * x + m[3] * y + m[6], m[1] * x + m[4] * y + m[7]);
        // The framebuffer's bottom-left pixel corner is the output's top-left... flipped: y up.
        let (ox, oy) = apply(0.0, 0.0);
        assert!((ox - 0.0).abs() < 1e-3 && (oy - 1080.0).abs() < 1e-3, "({ox}, {oy})");
        let (ox, oy) = apply(1920.0, 1080.0);
        assert!((ox - 1920.0).abs() < 1e-3 && oy.abs() < 1e-3, "({ox}, {oy})");
        let (ox, oy) = apply(100.0, 1080.0 - 40.0);
        assert!((ox - 100.0).abs() < 1e-3 && (oy - 40.0).abs() < 1e-3, "({ox}, {oy})");
    }
}
