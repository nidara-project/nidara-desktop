//! A window's controls, drawn by Hyalo over the app's header where the app reserved room for
//! them (protocols/window_controls.rs, #708 point 5): one capsule of one to three buttons — the
//! shape of the back/forward pair in Settings' header. Painted in one pass by a shader of ours,
//! in output pixels: the capsule, its inset edge, the hovered button's circle (close's red), and
//! the glyphs, all anti-aliased at the output's scale. The colours are the mockup's, the
//! owner's choice (2026-10-03): white, like the pair beside it — or dark, when the app says its
//! header is light (`set_ink`: white glyphs were invisible on Settings' light header, owner,
//! 2026-10-08).

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
use crate::protocols::window_controls::Buttons;

// Independently usable mirror of capsule.json, checked by the existing layout test.
pub(crate) const GLYPH_SIZE: f64 = 14.0;
pub(crate) const GLYPH_STROKE: f64 = 1.6;
pub(crate) const GLYPH_MINIMIZE_HALF: f64 = 3.5;
pub(crate) const GLYPH_MAXIMIZE_HALF: f64 = 3.7;
pub(crate) const GLYPH_MAXIMIZE_RADIUS: f64 = 1.6;
pub(crate) const GLYPH_CLOSE_HALF: f64 = 3.0;

/// The capsule's GLSL, shared with Hyalo's title bar (render/title_bar.rs), which draws the
/// same capsule in its own pass: its uniforms, and `controls(p, dark)` — the capsule's colour at
/// output pixel `p`, premultiplied, transparent outside it; `dark` 1 draws it with dark ink, for
/// a light title bar.
macro_rules! controls_glsl {
    () => {
        r#"
uniform vec4 rect;      // the capsule, output px
uniform float px;       // output px per logical px
uniform vec3 glyphs;    // per slot, left to right: 0 minimize, 1 maximize, 2 close
uniform float count;    // how many slots: 1 to 3
uniform float hover;    // the slot under the pointer, -1 none
uniform float pressed;  // 1 while that button is held
uniform float active;   // 1: the window has the focus
uniform float glass_under; // 1: the shell's glass is drawn under the capsule
uniform vec4 ink_rgba;    // over that glass: the glyphs' ink, straight (render/controls.rs `glass`)
float box(vec2 p, vec2 h, float r) {
    vec2 q = abs(p) - h + vec2(r);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float seg(vec2 p, vec2 a, vec2 b) {
    vec2 pa = p - a, ba = b - a;
    return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// A glyph's distance, logical px from the slot's centre: a 14 px icon, strokes 1.6 wide.
uniform vec4 glyph_geometry; // stroke half-width, minimize half, maximize half, radius
uniform float glyph_close_half;
float glyph(float g, vec2 p) {
    if (g < 0.5) return seg(p, vec2(-glyph_geometry.y, 0.0), vec2(glyph_geometry.y, 0.0)) - glyph_geometry.x;
    if (g < 1.5) return abs(box(p, vec2(glyph_geometry.z), glyph_geometry.w)) - glyph_geometry.x;
    return min(seg(p, vec2(-glyph_close_half), vec2(glyph_close_half)), seg(p, vec2(glyph_close_half, -glyph_close_half), vec2(-glyph_close_half, glyph_close_half))) - glyph_geometry.x;
}
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }
// window_controls::{HOVER_D, EDGE, GAP, PITCH}, given by Rust (`set_geometry`): each button a
// circle HOVER_D across, EDGE from the capsule's ends and GAP from the next one.
uniform vec4 geometry;  // the circle's radius, the edge, the pitch, the gap — logical px
#define HOVER_R geometry.x
#define EDGE geometry.y
#define PITCH geometry.z
#define GAP geometry.w
// The hover and the press, as the bar's pills (GLASS_STATE_MIX in the kit's tokens.ts: the
// same numbers there, white ink and dark): one hover across the desktop (owner, 2026-10-06).
const vec2 HOVER_A = vec2(0.08, 0.06);
const vec2 PRESS_A = vec2(0.20, 0.14);
vec4 controls(vec2 p_out, float dark) {
    vec2 size = rect.zw / px;
    vec2 p = (p_out - rect.xy) / px;
    float d = box(p - size * 0.5, size * 0.5, size.y * 0.5);
    float inside = clamp(0.5 - d * px, 0.0, 1.0);
    if (inside <= 0.0) return vec4(0.0);
    vec4 ink = dark > 0.5 ? vec4(0.0, 0.0, 0.0, 1.0) : vec4(1.0);
    // Over the glass the glyphs take the ink its answer to the backdrop mixes, and the hover and
    // the press are washes in the glass itself (render/glass_gl.rs `StatePx`): no disc here.
    if (glass_under > 0.5) ink = vec4(ink_rgba.rgb * ink_rgba.a, ink_rgba.a);
    float slot = clamp(floor((p.x - EDGE + GAP * 0.5) / PITCH), 0.0, count - 1.0);
    vec2 centre = vec2(EDGE + HOVER_R + slot * PITCH, size.y * 0.5);
    float g = slot < 0.5 ? glyphs.x : (slot < 1.5 ? glyphs.y : glyphs.z);
    bool on = active > 0.5;
    // Over the shell's glass (`glass_under`, render/controls.rs `glass`) the capsule is the
    // glass's — its tone, its rim — and only the state and the glyphs are drawn here.
    vec4 c = vec4(0.0);
    if (glass_under < 0.5) {
        c = ink * (on ? 0.08 : 0.04);
        // The inset edge: one physical pixel inside the rim.
        c = over(ink * 0.07 * clamp(1.0 - abs(d * px + 0.5), 0.0, 1.0), c);
    }
    bool hov = abs(slot - hover) < 0.5;
    bool red = hov && g > 1.5 && glass_under < 0.5;
    if (hov && glass_under < 0.5) {
        float a = pressed > 0.5 ? (dark > 0.5 ? PRESS_A.y : PRESS_A.x) : (dark > 0.5 ? HOVER_A.y : HOVER_A.x);
        vec4 fill = ink * a;
        if (red) fill = pressed > 0.5 ? vec4(0.69, 0.16, 0.18, 1.0) : vec4(0.82, 0.20, 0.22, 1.0);
        // A circle round the button's glyph, never the slot cut by the capsule.
        float disc = clamp(0.5 - (length(p - centre) - HOVER_R) * px, 0.0, 1.0);
        c = over(fill * disc, c);
    }
    float ga = clamp(0.5 - glyph(g, p - centre) * px, 0.0, 1.0);
    float k = hov ? 1.0 : (on ? 0.80 : 0.36);
    // Over close's red the glyph is white, whatever the ink.
    c = over((red ? vec4(1.0) : ink) * k * ga, c);
    return c * inside;
}
"#
    };
}
pub(crate) use controls_glsl;

pub const FS_CONTROLS: &str = concat!(
    "#version 100\nprecision highp float;\nvarying vec2 v_out;\nvarying vec2 v_fb;\n",
    controls_glsl!(),
    r#"
uniform float dark_ink;  // 1: the app's header is light (`set_ink`)
void main() {
    vec4 c = controls(v_out, dark_ink);
    if (c.a <= 0.0) discard;
    gl_FragColor = c;
}
"#
);

/// The capsule's geometry for the shader (its `geometry` uniform): the one copy, window_controls.rs.
pub(super) unsafe fn set_geometry(gl: &smithay::backend::renderer::gles::ffi::Gles2, p: &glass_gl::Program) {
    use crate::protocols::window_controls::{EDGE, GAP, HOVER_D, PITCH};
    unsafe {
        debug_assert!(GLYPH_SIZE >= 2.0 * (GLYPH_MAXIMIZE_HALF + GLYPH_STROKE / 2.0));
        gl.Uniform4f(p.loc(gl, c"glyph_geometry"), (GLYPH_STROKE / 2.0) as f32, GLYPH_MINIMIZE_HALF as f32, GLYPH_MAXIMIZE_HALF as f32, GLYPH_MAXIMIZE_RADIUS as f32);
        gl.Uniform1f(p.loc(gl, c"glyph_close_half"), GLYPH_CLOSE_HALF as f32);
        gl.Uniform4f(p.loc(gl, c"geometry"), (HOVER_D / 2.0) as f32, EDGE as f32, PITCH as f32, GAP as f32) };
}

/// What the capsule shows: its buttons left to right (only those that do something), the one
/// under the pointer and whether it is held, and whether its window has the focus.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Controls {
    pub buttons: Buttons,
    pub hover: Option<usize>,
    pub pressed: bool,
    pub active: bool,
    /// Dark ink, over a light header: the app's `set_ink` (Hyalo's own title bar decides its
    /// ink from the bar's colour instead, and ignores this).
    pub dark: bool,
    /// Its window is drawn moving (into the dock, out of it, to another workspace): the glass
    /// keeps the ink it had, measuring nothing — what passes under a capsule in flight is not
    /// its header, and its ink must not flicker on the way.
    pub moving: bool,
    /// Over the shell's glass: the glyphs' ink, straight sRGB and alpha (`glass`). None: `dark`.
    pub ink: Option<[f32; 4]>,
    /// Reduce motion: the washes change at once.
    pub reduce_motion: bool,
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
    /// The shell's glass is drawn under it (`glass`): no fill or edge of its own.
    glass_under: bool,
}

/// The element's id and what it last drew, kept on the window's surface.
#[derive(Default)]
struct ControlsMemo(RefCell<Option<(Id, CommitCounter, String)>>);

impl ControlsElement {
    pub fn new(surface: &WlSurface, rect: Rectangle<f64, Physical>, scale: Scale<f64>, controls: Controls, glass_under: bool) -> Self {
        let key = format!("{rect:?} {controls:?} {glass_under}");
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
        Self { id, commit, rect, geometry, scale: scale.x, controls, glass_under }
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
        let (glyphs, count) = c.buttons.glyphs();
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
            gl.Uniform1f(p.loc(gl, c"count"), count);
            set_geometry(gl, p);
            gl.Uniform1f(p.loc(gl, c"hover"), c.hover.map_or(-1.0, |h| h as f32));
            gl.Uniform1f(p.loc(gl, c"pressed"), if c.pressed { 1.0 } else { 0.0 });
            gl.Uniform1f(p.loc(gl, c"active"), if c.active { 1.0 } else { 0.0 });
            gl.Uniform1f(p.loc(gl, c"dark_ink"), if c.dark { 1.0 } else { 0.0 });
            gl.Uniform1f(p.loc(gl, c"glass_under"), if self.glass_under { 1.0 } else { 0.0 });
            let ink = c.ink.unwrap_or([1.0; 4]);
            gl.Uniform4f(p.loc(gl, c"ink_rgba"), ink[0], ink[1], ink[2], ink[3]);
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

/// The commit of the controls' own material, kept on the window's surface: it moves when the
/// material does.
#[derive(Default)]
struct GlassMemo(RefCell<Option<(CommitCounter, String)>>);

/// The controls' answer to their backdrop and their washes as they ease (protocols/material.rs
/// `Presenting`), and the response they were drawn with — kept on the window's surface.
#[derive(Default)]
struct PresentMemo(RefCell<PresentState>);

#[derive(Default)]
struct PresentState {
    presenting: crate::protocols::material::Presenting,
    response: Option<crate::protocols::material::Response>,
    /// The material last drawn, as committed (before `present`): what `answers_info` reads.
    state: crate::protocols::material::MaterialState,
    /// The button hovered and whether it is pressed, as last drawn.
    input: (Option<usize>, bool),
    /// Moves when what is drawn does — the input or the material (`msg windows`' `revision`).
    revision: u64,
}

/// The capsule's one shape.
const SHAPE: usize = 0;

/// Each button a circle `HOVER_D` across, `EDGE` from the capsule's ends and `GAP` from the next
/// one — where its wash lies (protocols/window_controls.rs, the one copy of these in Hyalo).
use crate::protocols::window_controls::{EDGE, HOVER_D, PITCH};
const HOVER_R: f64 = HOVER_D / 2.0;

/// The shell's glass under the capsule (toolkit/PHASE1.md D7: the window controls use the
/// shell's glass) — the glass of a `control` pane of the token export, the same in every respect
/// as the toolkit's controls (toolkit/CONTRACT.md, "Floating control capsule"): its tone mixed
/// towards its ink tone by its answer to the backdrop, its shadow growing with that answer, the
/// hovered or pressed button a wash in the glass, and the glyphs' ink mixed by the same answer.
/// It blurs only `window` (its box, output px). Empty without an export that has the control's
/// answer, states and inks: the capsule paints its own fill then, and the app's `set_ink` says
/// its ink. With it, the glyphs' ink is returned.
#[allow(clippy::too_many_arguments)]
pub fn glass(
    surface: &WlSurface,
    rect: Rectangle<f64, Physical>,
    window: Rectangle<f64, Physical>,
    scale: Scale<f64>,
    output_size: smithay::utils::Size<i32, Physical>,
    reduce_transparency: bool,
    controls: &Controls,
    when: std::time::Instant,
) -> (Vec<super::GlassElement>, Option<[f32; 4]>, Option<super::ScrimElement>) {
    use crate::protocols::material::{Current, MaterialState, Shape, StateRegion};
    let (x, y, w, h) = (rect.loc.x / scale.x, rect.loc.y / scale.y, rect.size.w / scale.x, rect.size.h / scale.y);
    // The bar's face: the shell's skin is dark whatever the mode.
    let Some(pane) = super::glass_tokens::pane("control", w.min(h), true, reduce_transparency) else { return (Vec::new(), None, None) };
    let Some(look) = pane.control else { return (Vec::new(), None, None) };
    let (glyphs, count) = controls.buttons.glyphs();
    let fade_ms = if controls.reduce_motion { 0 } else { look.fade_ms };
    // A wash per button, where its circle is: the hovered one's state, the others' none — at
    // their own colour, so one fading out keeps its hue.
    let state_regions: Vec<StateRegion> = (0..count as usize)
        .map(|i| {
            let close = glyphs[i] > 1.5;
            let (hover, press) = if close { (look.destructive_hover, look.destructive_press) } else { (look.hover, look.press) };
            let on = controls.hover == Some(i);
            let mut wash = if on && controls.pressed { press.wash } else { hover.wash };
            if !on {
                wash[3] = 0.0;
            }
            let cx = x + EDGE + HOVER_R + i as f64 * PITCH;
            let cy = y + h / 2.0;
            StateRegion { id: i as u32, x: cx - HOVER_R, y: cy - HOVER_R, w: 2.0 * HOVER_R, h: 2.0 * HOVER_R, radius: HOVER_R, wash, fade_ms }
        })
        .collect();
    let mut state = MaterialState {
        shapes: vec![Shape {
            x,
            y,
            w,
            h,
            radius: h / 2.0,
            exponent: 2.0,
            opacity: 1.0,
            clip: None,
            pointer: None,
            fusion: None,
            tone: Some(pane.tone),
            ink_tone: pane.ink_tone,
            blur: None,
            shadow: pane.shadow,
            grade: None,
            response: look.response,
            answer: None,
        }],
        glass: Some(pane.glass),
        lensing: pane.lensing,
        state_regions,
        ink_colors: Some(look.ink),
        ..Default::default()
    };
    let (easing, _) = with_states(surface, |states| {
        let memo = states.data_map.get_or_insert(PresentMemo::default);
        let mut memo = memo.0.borrow_mut();
        memo.response = look.response;
        let input = (controls.hover, controls.pressed);
        if memo.revision == 0 || memo.input != input || memo.state != state {
            memo.revision += 1;
        }
        memo.input = input;
        memo.state = state.clone();
        memo.presenting.committed(&state, when);
        memo.presenting.present(&mut state, when)
    });
    if easing {
        crate::protocols::material::mark_easing();
    }
    // The glyphs' ink: the hovered destructive button's own, else the mix by the answer.
    let hovered_close = controls.hover.is_some_and(|i| glyphs.get(i).is_some_and(|g| *g > 1.5));
    let destructive_ink = if controls.pressed { look.destructive_press.ink } else { look.destructive_hover.ink };
    let r = state.shapes[SHAPE].answer.map_or(0.0, |a| a[0]);
    let ink = match destructive_ink.filter(|_| hovered_close) {
        Some(i) => i,
        None => std::array::from_fn(|k| look.ink[0][k] + (look.ink[1][k] - look.ink[0][k]) * r),
    };
    // Its commit moves when what it shows does: the answers and washes are in the state.
    let key = format!("{state:?}");
    let commit = with_states(surface, |states| {
        let memo = states.data_map.get_or_insert(GlassMemo::default);
        let mut memo = memo.0.borrow_mut();
        let entry = memo.get_or_insert_with(|| (CommitCounter::default(), key.clone()));
        if entry.1 != key {
            entry.0.increment();
            entry.1 = key;
        }
        entry.0
    });
    let current = Current { state, commit, ..Default::default() };
    // It reads its window only: past the window's edge the desktop would darken the header it
    // answers to (a capsule 12 px from the top, under a blur that reaches 64).
    let bounds = window.to_i32_round();
    let elements = super::GlassElement::for_material(surface, super::glass::Whose::Hyalo, &current, (0, 0).into(), scale, output_size)
        .into_iter()
        .filter_map(|g| g.within(bounds))
        // In flight (into the dock, to another workspace) it keeps the answer it had: what passes
        // under a capsule on the way is not its header.
        .map(|g| if controls.moving { g.measuring_nothing() } else { g })
        .collect();
    // Its shadow, as the bar capsule's: drawn apart from the glass, under it (render/scrim.rs),
    // remembered apart from the window's own material's.
    let scrims = super::scrim::scrims_of(&current.state, (0, 0).into(), scale);
    let shadow = with_states(surface, |states| {
        let memo = states.data_map.get_or_insert(ShadowMemo::default);
        super::ScrimElement::new(&memo.0, scrims, output_size)
    });
    (elements, Some(ink.map(|v| v as f32)), shadow)
}

/// The controls' shadow element's id and what it last drew, apart from the surface's own.
#[derive(Default)]
struct ShadowMemo(UserDataMap);

/// A measurement of the glass under a window's controls came back (render/glass_gl.rs): their
/// answer to the backdrop moves on. Whether it changed (the frame is redrawn).
pub fn response_measured(surface: &WlSurface, answers: &[(usize, f32, f32)]) -> bool {
    let Some(&(_, mean, sigma)) = answers.iter().find(|(i, _, _)| *i == SHAPE) else { return false };
    with_states(surface, |states| {
        let Some(memo) = states.data_map.get::<PresentMemo>() else { return false };
        let mut memo = memo.0.borrow_mut();
        let Some(response) = memo.response else { return false };
        memo.presenting.measured(SHAPE, &response, mean as f64, sigma as f64, std::time::Instant::now())
    })
}

/// What the glass under a window's controls shows now of its answer and its washes, for
/// `msg windows`. None before it was first drawn on the glass.
pub fn answers_info(surface: &WlSurface, now: std::time::Instant) -> Option<crate::ipc::AnswersInfo> {
    with_states(surface, |states| {
        let memo = states.data_map.get::<PresentMemo>()?;
        let memo = memo.0.borrow();
        memo.response.map(|_| memo.presenting.info(&memo.state, memo.revision, now))
    })
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
