//! What a frame costs, and where the glass samples (#766 A).
//!
//! Two instruments, both per output:
//!
//! - **Counters** (`nidara-hyalo msg stats`): over the last second, the frames drawn and the
//!   frames that had nothing new, the damaged area, the CPU time to build the frame's elements
//!   and to render them, the **GPU time** of the render (GL_EXT_disjoint_timer_query: two
//!   timestamps around it, read back a few frames later without waiting; none where the driver
//!   lacks the extension), and what the glass did — backdrop captures, blur passes, the area
//!   captured, draws, ink/shadow measurements — plus the GPU memory its caches hold.
//! - **An overlay** (`nidara-hyalo msg debug-overlay on`, or `HYALO_DEBUG_OVERLAY=1`): over each
//!   output, every glass element's capture region outlined, a flash where one re-captured, and
//!   the previous frame's damage outlined, fading.
//!
//! The overlay is drawn with damage tracking like anything else, so what it draws damages the
//! frame: the damage it shows leaves out what lies inside its own elements (of this frame and
//! the last), or it would chase its own tail. A flash and a damage outline fade out; once they
//! have, an idle desktop draws nothing again.
//!
//! Frames are drawn one output at a time on this thread: `frame_start` names the output the
//! counts that follow belong to.

use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, VecDeque},
    time::{Duration, Instant},
};

use serde::Serialize;
use smithay::{
    backend::renderer::{
        Color32F,
        element::{Id, Kind, solid::SolidColorRenderElement},
        gles::ffi::{self, Gles2},
        utils::CommitCounter,
    },
    utils::{Physical, Rectangle},
};

/// What the glass did while one frame was drawn.
#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct GlassCounts {
    /// Backdrops copied out of the frame and blurred.
    pub captures: u32,
    /// Blur passes run (down + up chains, each pass counted once).
    pub passes: u32,
    /// Output px copied into the captures.
    pub capture_px: u64,
    /// Glass elements drawn.
    pub draws: u32,
    /// Ink/shadow measurements issued.
    pub measures: u32,
}

struct Sample {
    at: Instant,
    rendered: bool,
    build: Duration,
    render: Duration,
    gpu: Option<Duration>,
    damage_px: u64,
    glass: GlassCounts,
    id: u64,
}

#[derive(Default)]
struct OutputState {
    samples: VecDeque<Sample>,
    /// Timer queries in flight: the frame, its two timestamps.
    queries: Vec<(u64, u32, u32)>,
    /// The output's size, output px.
    area: u64,
    /// Overlay: the last frame's damage (minus the overlay's own), when it was taken.
    damage: Vec<(Rectangle<i32, Physical>, Instant)>,
    /// Overlay: where a glass element re-captured, and when.
    flashes: Vec<(Rectangle<i32, Physical>, Instant)>,
    /// Overlay: re-captures of the frame being drawn, shown once it is known not to have been
    /// drawn whole (`frame_done`).
    pending: Vec<Rectangle<i32, Physical>>,
    /// Overlay: its own elements' geometry, this frame and the last.
    drawn: [Vec<Rectangle<i32, Physical>>; 2],
    /// Overlay: one id per piece, stable while the piece stays, so an unchanged overlay
    /// damages nothing.
    slots: HashMap<(u8, i32, i32, i32, i32), Slot>,
}

struct Slot {
    id: Id,
    commit: CommitCounter,
    color: Color32F,
    used: bool,
}

thread_local! {
    static CURRENT: RefCell<Option<String>> = const { RefCell::new(None) };
    static FRAME: Cell<GlassCounts> = Cell::new(GlassCounts::default());
    static FRAME_ID: Cell<u64> = const { Cell::new(0) };
    static OUTPUTS: RefCell<HashMap<String, OutputState>> = RefCell::new(HashMap::new());
    /// Bytes of GPU memory each glass texture holds, by GL name.
    static TEXTURES: RefCell<HashMap<u32, u64>> = RefCell::new(HashMap::new());
    static OVERLAY: Cell<bool> = Cell::new(std::env::var_os("HYALO_DEBUG_OVERLAY").is_some_and(|v| v != "0"));
    /// Whether this GL context has timer queries: unknown until asked.
    static TIMER: Cell<Option<bool>> = const { Cell::new(None) };
}

/// The window the counters are taken over.
const WINDOW: Duration = Duration::from_secs(1);
/// How long a flash and a damage outline take to fade.
const FADE: Duration = Duration::from_millis(400);

pub fn count(f: impl FnOnce(&mut GlassCounts)) {
    FRAME.with(|c| {
        let mut v = c.get();
        f(&mut v);
        c.set(v);
    });
}

pub fn texture_alloc(tex: u32, bytes: u64) {
    TEXTURES.with(|t| t.borrow_mut().insert(tex, bytes));
}

pub fn texture_free(tex: u32) {
    TEXTURES.with(|t| t.borrow_mut().remove(&tex));
}

pub fn overlay_enabled() -> bool {
    OVERLAY.with(Cell::get)
}

pub fn set_overlay(on: bool) {
    OVERLAY.with(|o| o.set(on));
    if !on {
        OUTPUTS.with(|o| {
            for s in o.borrow_mut().values_mut() {
                s.damage.clear();
                s.flashes.clear();
                s.drawn = Default::default();
                s.slots.clear();
            }
        });
    }
}

fn has_timer(gl: &Gles2) -> bool {
    TIMER.with(|t| {
        if let Some(v) = t.get() {
            return v;
        }
        // Safety: a current context (the caller is inside `with_context`).
        let v = unsafe {
            let p = gl.GetString(ffi::EXTENSIONS);
            !p.is_null()
                && std::ffi::CStr::from_ptr(p as *const _).to_string_lossy().split(' ').any(|e| e == "GL_EXT_disjoint_timer_query")
                && gl.QueryCounterEXT.is_loaded()
                && gl.GetQueryObjectui64vEXT.is_loaded()
        };
        t.set(Some(v));
        v
    })
}

unsafe fn timestamp(gl: &Gles2) -> u32 {
    let mut q = 0;
    unsafe {
        gl.GenQueriesEXT(1, &mut q);
        gl.QueryCounterEXT(q, ffi::TIMESTAMP_EXT);
    }
    q
}

/// A frame of `output` (`area` output px) starts: the counts that follow are its.
pub fn frame_begin(output: &str, area: u64) {
    CURRENT.with(|c| *c.borrow_mut() = Some(output.to_string()));
    FRAME.with(|c| c.set(GlassCounts::default()));
    FRAME_ID.with(|i| i.set(i.get() + 1));
    OUTPUTS.with(|o| o.borrow_mut().entry(output.to_string()).or_default().area = area);
}

/// The GPU side of a frame's start, after `frame_begin`: the GPU time of frames before it that
/// has come back is collected, and the frame's start timestamp is queued — returned, if the
/// context has timer queries. Inside `with_context`.
///
/// Only on the tty backend. In a window (winit) `with_context` makes the context current
/// without the window's surface, so the next `buffer_age` fails and every frame is drawn whole
/// (measured: damage 100 % of the output, EGL_BAD_SURFACE per frame); and its timestamps would
/// straddle the swap. The nested Hyalo reports no GPU time.
///
/// # Safety
/// The GL context must be current.
pub unsafe fn gpu_start(gl: &Gles2, output: &str) -> Option<u32> {
    let timer = has_timer(gl);
    OUTPUTS.with(|o| {
        let mut o = o.borrow_mut();
        let st = o.entry(output.to_string()).or_default();
        if !timer {
            return;
        }
        // Collect what has come back, oldest first; stop at the first still in flight.
        unsafe {
            let mut disjoint = 0;
            gl.GetIntegerv(ffi::GPU_DISJOINT_EXT, &mut disjoint);
            while let Some(&(id, q0, q1)) = st.queries.first() {
                let mut ready = 0;
                gl.GetQueryObjectivEXT(q1, ffi::QUERY_RESULT_AVAILABLE_EXT, &mut ready);
                if ready == 0 {
                    break;
                }
                let (mut t0, mut t1) = (0u64, 0u64);
                gl.GetQueryObjectui64vEXT(q0, ffi::QUERY_RESULT_EXT, &mut t0);
                gl.GetQueryObjectui64vEXT(q1, ffi::QUERY_RESULT_EXT, &mut t1);
                gl.DeleteQueriesEXT(2, [q0, q1].as_ptr());
                st.queries.remove(0);
                if disjoint == 0
                    && t1 >= t0
                    && let Some(s) = st.samples.iter_mut().find(|s| s.id == id)
                {
                    s.gpu = Some(Duration::from_nanos(t1 - t0));
                }
            }
            // A GPU that stopped answering: drop the oldest rather than grow.
            while st.queries.len() > 16 {
                let (_, q0, q1) = st.queries.remove(0);
                gl.DeleteQueriesEXT(2, [q0, q1].as_ptr());
            }
        }
    });
    if timer { Some(unsafe { timestamp(gl) }) } else { None }
}

/// The render was submitted: its end timestamp, paired with `gpu_start`'s.
///
/// # Safety
/// The GL context must be current.
pub unsafe fn gpu_end(gl: &Gles2, output: &str, start: Option<u32>) {
    let Some(q0) = start else { return };
    let q1 = unsafe { timestamp(gl) };
    let id = FRAME_ID.with(Cell::get);
    OUTPUTS.with(|o| o.borrow_mut().entry(output.to_string()).or_default().queries.push((id, q0, q1)));
}

/// The frame is done: what it cost on the CPU, whether anything was new, and its damage
/// (output px; None = the whole output, a direct scan-out).
pub fn frame_done(output: &str, rendered: bool, build: Duration, render: Duration, damage: Option<&[Rectangle<i32, Physical>]>) {
    let now = Instant::now();
    let glass = FRAME.with(Cell::get);
    let id = FRAME_ID.with(Cell::get);
    OUTPUTS.with(|o| {
        let mut o = o.borrow_mut();
        let st = o.entry(output.to_string()).or_default();
        let damage_px = if !rendered {
            0
        } else {
            damage.map_or(st.area, |d| d.iter().map(|r| r.size.w.max(0) as u64 * r.size.h.max(0) as u64).sum())
        };
        st.samples.push_back(Sample { at: now, rendered, build, render, gpu: None, damage_px, glass, id });
        while st.samples.front().is_some_and(|s| now.duration_since(s.at) > WINDOW * 2) {
            st.samples.pop_front();
        }
        let pending = std::mem::take(&mut st.pending);
        // A frame drawn whole (a direct scan-out; in a window, a buffer age the host did not
        // give) says nothing about what changed: showing it, and the re-captures it caused, would
        // keep the overlay fading for ever, each fade a frame drawn whole again.
        if overlay_enabled() && rendered && (damage_px as f64) < st.area as f64 * 0.99 {
            // What the overlay drew itself is not the desktop's damage (see the header).
            let own = |r: &Rectangle<i32, Physical>| st.drawn.iter().flatten().any(|o| o.contains_rect(*r));
            if let Some(d) = damage {
                let shown: Vec<_> = d.iter().filter(|r| !own(r)).copied().collect();
                for r in shown {
                    remember(&mut st.damage, r, now);
                }
            }
            for r in pending {
                remember(&mut st.flashes, r, now);
            }
        }
    });
}

/// A glass element re-captured `region` (output px) this frame: the overlay flashes it.
pub fn captured(region: Rectangle<i32, Physical>) {
    if !overlay_enabled() {
        return;
    }
    let Some(output) = CURRENT.with(|c| c.borrow().clone()) else { return };
    OUTPUTS.with(|o| o.borrow_mut().entry(output).or_default().pending.push(region));
}

/// A rectangle shown from `at`: one entry per rectangle, the newest time — a region re-captured
/// every frame flashes once, it does not stack sixty translucent fills.
fn remember(list: &mut Vec<(Rectangle<i32, Physical>, Instant)>, r: Rectangle<i32, Physical>, at: Instant) {
    match list.iter_mut().find(|(q, _)| *q == r) {
        Some(e) => e.1 = at,
        None => list.push((r, at)),
    }
}

/// Whether the overlay on `output` is still fading something out (the backend redraws).
pub fn overlay_animating(output: &str) -> bool {
    overlay_enabled()
        && OUTPUTS.with(|o| {
            o.borrow().get(output).is_some_and(|s| {
                let now = Instant::now();
                s.damage.iter().chain(&s.flashes).any(|(_, t)| now.duration_since(*t) < FADE)
            })
        })
}

/// The overlay's elements for `output`, front first: `regions` are the glass elements' capture
/// regions in this frame, output px.
pub fn overlay(output: &str, regions: &[Rectangle<i32, Physical>]) -> Vec<SolidColorRenderElement> {
    if !overlay_enabled() {
        return Vec::new();
    }
    let now = Instant::now();
    OUTPUTS.with(|o| {
        let mut o = o.borrow_mut();
        let st = o.entry(output.to_string()).or_default();
        st.damage.retain(|(_, t)| now.duration_since(*t) < FADE);
        st.flashes.retain(|(_, t)| now.duration_since(*t) < FADE);
        let fade = |t: Instant| 1.0 - now.duration_since(t).as_secs_f32() / FADE.as_secs_f32();
        let mut pieces: Vec<(u8, Rectangle<i32, Physical>, Color32F)> = Vec::new();
        let outline = |pieces: &mut Vec<_>, kind: u8, r: Rectangle<i32, Physical>, c: Color32F| {
            let w = 2;
            for e in [
                Rectangle::new(r.loc, (r.size.w, w).into()),
                Rectangle::new((r.loc.x, r.loc.y + r.size.h - w).into(), (r.size.w, w).into()),
                Rectangle::new(r.loc, (w, r.size.h).into()),
                Rectangle::new((r.loc.x + r.size.w - w, r.loc.y).into(), (w, r.size.h).into()),
            ] {
                pieces.push((kind, e, c));
            }
        };
        // Damage: magenta outlines, fading.
        for (r, t) in &st.damage {
            let a = 0.9 * fade(*t);
            outline(&mut pieces, 0, *r, Color32F::new(1.0 * a, 0.0, 0.6 * a, a));
        }
        // Capture regions: cyan outlines; a re-capture flashes the region.
        for r in regions {
            outline(&mut pieces, 1, *r, Color32F::new(0.0, 0.75 * 0.85, 0.85, 0.85));
        }
        for (r, t) in &st.flashes {
            let a = 0.22 * fade(*t);
            pieces.push((2, *r, Color32F::new(0.0, 0.75 * a, a, a)));
        }
        for s in st.slots.values_mut() {
            s.used = false;
        }
        let mut out = Vec::with_capacity(pieces.len());
        let mut drawn = Vec::with_capacity(pieces.len());
        for (kind, r, color) in pieces {
            if r.size.w <= 0 || r.size.h <= 0 {
                continue;
            }
            let slot = st.slots.entry((kind, r.loc.x, r.loc.y, r.size.w, r.size.h)).or_insert_with(|| Slot {
                id: Id::new(),
                commit: CommitCounter::default(),
                color,
                used: false,
            });
            if slot.color != color {
                slot.color = color;
                slot.commit.increment();
            }
            slot.used = true;
            out.push(SolidColorRenderElement::new(slot.id.clone(), r, slot.commit, color, Kind::Unspecified));
            drawn.push(r);
        }
        st.slots.retain(|_, s| s.used);
        st.drawn.swap(0, 1);
        st.drawn[0] = drawn;
        out
    })
}

#[derive(Debug, Clone, Serialize)]
pub struct Timing {
    pub avg_ms: f64,
    pub max_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputStats {
    pub output: String,
    /// Frames in the last second: drawn with something new, and skipped as unchanged.
    pub frames_drawn: usize,
    pub frames_unchanged: usize,
    /// Of the frames drawn, those drawn WHOLE (damage ≥ 99 % of the output).
    pub frames_whole: usize,
    /// Damage per drawn frame, output px, and as a share of the output.
    pub damage_px_avg: f64,
    pub damage_share_avg: f64,
    pub damage_share_max: f64,
    /// CPU: building the frame's elements, and rendering them (submission included).
    pub cpu_build: Option<Timing>,
    pub cpu_render: Option<Timing>,
    /// GPU time of the render; null where the driver has no timer queries.
    pub gpu: Option<Timing>,
    /// The glass, summed over the second.
    pub glass: GlassCounts,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub window_ms: u64,
    pub outputs: Vec<OutputStats>,
    /// GPU memory held by the glass's caches (every pyramid level and kept blur), bytes.
    pub glass_texture_bytes: u64,
    pub gpu_timer_queries: Option<bool>,
    pub overlay: bool,
}

fn timing(v: impl Iterator<Item = Duration>) -> Option<Timing> {
    let ms: Vec<f64> = v.map(|d| d.as_secs_f64() * 1000.0).collect();
    if ms.is_empty() {
        return None;
    }
    let r = |x: f64| (x * 1000.0).round() / 1000.0;
    Some(Timing { avg_ms: r(ms.iter().sum::<f64>() / ms.len() as f64), max_ms: r(ms.iter().cloned().fold(0.0, f64::max)) })
}

pub fn snapshot() -> Stats {
    let now = Instant::now();
    let outputs = OUTPUTS.with(|o| {
        let mut out: Vec<OutputStats> = o
            .borrow()
            .iter()
            .map(|(name, st)| {
                let recent: Vec<&Sample> = st.samples.iter().filter(|s| now.duration_since(s.at) <= WINDOW).collect();
                let drawn: Vec<&&Sample> = recent.iter().filter(|s| s.rendered).collect();
                let area = st.area.max(1) as f64;
                let damage: Vec<f64> = drawn.iter().map(|s| s.damage_px as f64).collect();
                let avg = |v: &[f64]| if v.is_empty() { 0.0 } else { v.iter().sum::<f64>() / v.len() as f64 };
                let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
                let mut glass = GlassCounts::default();
                for s in &recent {
                    glass.captures += s.glass.captures;
                    glass.passes += s.glass.passes;
                    glass.capture_px += s.glass.capture_px;
                    glass.draws += s.glass.draws;
                    glass.measures += s.glass.measures;
                }
                OutputStats {
                    output: name.clone(),
                    frames_drawn: drawn.len(),
                    frames_unchanged: recent.len() - drawn.len(),
                    frames_whole: damage.iter().filter(|d| **d >= area * 0.99).count(),
                    damage_px_avg: avg(&damage).round(),
                    damage_share_avg: r3(avg(&damage) / area),
                    damage_share_max: r3(damage.iter().cloned().fold(0.0, f64::max) / area),
                    cpu_build: timing(recent.iter().map(|s| s.build)),
                    cpu_render: timing(recent.iter().map(|s| s.render)),
                    gpu: timing(drawn.iter().filter_map(|s| s.gpu)),
                    glass,
                }
            })
            .collect();
        out.sort_by(|a, b| a.output.cmp(&b.output));
        out
    });
    Stats {
        window_ms: WINDOW.as_millis() as u64,
        outputs,
        glass_texture_bytes: TEXTURES.with(|t| t.borrow().values().sum()),
        gpu_timer_queries: TIMER.with(Cell::get),
        overlay: overlay_enabled(),
    }
}
