//! What a frame costs, and where the glass samples (#766 A).
//!
//! Two instruments, both per output:
//!
//! - **Counters** (`nidara-hyalo msg stats`): over the last second, the frames drawn and the
//!   frames that had nothing new, the area repainted, the CPU time to build the frame's elements
//!   and to render them, what the glass did — backdrop captures, blur passes, the area
//!   captured, draws, ink/shadow measurements — plus the GPU memory its caches hold. And, for
//!   the whole process, **Hyalo's GPU time**: the kernel's own accounting of the engine time
//!   its jobs took (`gpu_time`).
//!
//! - **Presentation** (#766 B, tty only): for each frame the kernel timed on screen, how far the
//!   moment its animations were drawn at (render/timing.rs) landed from the flip, and how long
//!   after the frame began building it showed — what sampling at the build would be off by.
//!
//! The repainted area is what the renderer drew, which is the frame's damage united with the
//! damage of the frames since the buffer it draws into was last used (its buffer age): with
//! three buffers, a window that moves repaints where it is, was and was before. That is the
//! cost, so it is what is counted — not the new damage alone.
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
    damage_px: u64,
    glass: GlassCounts,
}

/// A frame the kernel timed on screen (`presented`).
struct Shown {
    at: Instant,
    /// From the frame beginning to be built to the flip.
    lead: Duration,
    /// The flip minus the moment predicted, ms: positive = it showed later.
    error_ms: f64,
    /// It showed a refresh or more after the one predicted.
    late: bool,
}

#[derive(Default)]
struct OutputState {
    samples: VecDeque<Sample>,
    shown: VecDeque<Shown>,
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
    static OUTPUTS: RefCell<HashMap<String, OutputState>> = RefCell::new(HashMap::new());
    /// Bytes of GPU memory each glass texture holds, by GL name.
    static TEXTURES: RefCell<HashMap<u32, u64>> = RefCell::new(HashMap::new());
    static OVERLAY: Cell<bool> = Cell::new(std::env::var_os("HYALO_DEBUG_OVERLAY").is_some_and(|v| v != "0"));
    static GPU: RefCell<GpuClock> = RefCell::new(GpuClock::default());
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

/// A frame of `output` (`area` output px) starts: the counts that follow are its.
pub fn frame_begin(output: &str, area: u64) {
    CURRENT.with(|c| *c.borrow_mut() = Some(output.to_string()));
    FRAME.with(|c| c.set(GlassCounts::default()));
    GPU.with(|g| g.borrow_mut().tick(Instant::now()));
    OUTPUTS.with(|o| o.borrow_mut().entry(output.to_string()).or_default().area = area);
}

/// The frame is done: what it cost on the CPU, whether anything was new, and its damage
/// (output px; None = the whole output, a direct scan-out).
pub fn frame_done(output: &str, rendered: bool, build: Duration, render: Duration, damage: Option<&[Rectangle<i32, Physical>]>) {
    let now = Instant::now();
    let glass = FRAME.with(Cell::get);
    OUTPUTS.with(|o| {
        let mut o = o.borrow_mut();
        let st = o.entry(output.to_string()).or_default();
        let damage_px = if !rendered {
            0
        } else {
            damage.map_or(st.area, |d| d.iter().map(|r| r.size.w.max(0) as u64 * r.size.h.max(0) as u64).sum())
        };
        st.samples.push_back(Sample { at: now, rendered, build, render, damage_px, glass });
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

/// A frame of `output`, begun at `begun` and predicted to show at `predicted`, was flipped at
/// `shown`, by the kernel's clock; the output refreshes every `period`.
pub fn presented(output: &str, begun: Instant, predicted: Instant, shown: Instant, period: Duration) {
    let error = shown.saturating_duration_since(predicted).as_secs_f64() - predicted.saturating_duration_since(shown).as_secs_f64();
    OUTPUTS.with(|o| {
        let mut o = o.borrow_mut();
        let st = o.entry(output.to_string()).or_default();
        let now = Instant::now();
        st.shown.push_back(Shown {
            at: now,
            lead: shown.saturating_duration_since(begun),
            error_ms: error * 1000.0,
            late: error > period.as_secs_f64() / 2.0,
        });
        while st.shown.front().is_some_and(|s| now.duration_since(s.at) > WINDOW * 2) {
            st.shown.pop_front();
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
    /// Of the frames drawn, those repainted WHOLE (≥ 99 % of the output).
    pub frames_whole: usize,
    /// The area repainted per drawn frame (the damage with its buffer age, see the header),
    /// output px, and as a share of the output.
    pub damage_px_avg: f64,
    pub damage_share_avg: f64,
    pub damage_share_max: f64,
    /// CPU: building the frame's elements, and rendering them (submission included).
    pub cpu_build: Option<Timing>,
    pub cpu_render: Option<Timing>,
    /// The glass, summed over the second.
    pub glass: GlassCounts,
    /// The frames the kernel timed on screen; null where it timed none (in a window, at rest).
    pub presentation: Option<Presentation>,
}

/// How the frames' predicted presentation held (render/timing.rs).
#[derive(Debug, Clone, Serialize)]
pub struct Presentation {
    pub frames: usize,
    /// From a frame beginning to be built to its flip: what sampling the animations at the
    /// build put them behind by.
    pub build_to_shown: Timing,
    /// The flip minus the moment the animations were drawn at, ms: `avg_ms` signed, `max_ms`
    /// the largest either way.
    pub error: Timing,
    /// Frames shown a refresh or more after the one predicted.
    pub late: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct Stats {
    pub window_ms: u64,
    pub outputs: Vec<OutputStats>,
    /// GPU memory held by the glass's caches (every pyramid level and kept blur), bytes.
    pub glass_texture_bytes: u64,
    /// Hyalo's GPU time, every output together; null where the driver does not account it.
    pub gpu_time: Option<GpuTime>,
    pub overlay: bool,
}

fn presentation(shown: &VecDeque<Shown>, now: Instant) -> Option<Presentation> {
    let recent: Vec<&Shown> = shown.iter().filter(|s| now.duration_since(s.at) <= WINDOW).collect();
    let build_to_shown = timing(recent.iter().map(|s| s.lead))?;
    let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
    let errors: Vec<f64> = recent.iter().map(|s| s.error_ms).collect();
    Some(Presentation {
        frames: recent.len(),
        build_to_shown,
        error: Timing {
            avg_ms: r3(errors.iter().sum::<f64>() / errors.len() as f64),
            max_ms: r3(errors.iter().fold(0.0, |m, e| e.abs().max(m))),
        },
        late: recent.iter().filter(|s| s.late).count(),
    })
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
    let gpu_time = GPU.with(|g| g.borrow_mut().rate(now)).map(|(since, ms_per_s, engines)| {
        let frames: usize = OUTPUTS.with(|o| {
            o.borrow().values().map(|st| st.samples.iter().filter(|s| s.rendered && s.at > since).count()).sum()
        });
        let secs = now.duration_since(since).as_secs_f64();
        let r3 = |x: f64| (x * 1000.0).round() / 1000.0;
        GpuTime {
            ms_per_s: r3(ms_per_s),
            ms_per_frame: (frames > 0).then(|| r3(ms_per_s * secs / frames as f64)),
            engines: engines.into_iter().map(|(k, v)| (k, r3(v))).collect(),
            over_ms: (secs * 1000.0).round() as u64,
        }
    });
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
                    glass,
                    presentation: presentation(&st.shown, now),
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
        gpu_time,
        overlay: overlay_enabled(),
    }
}

/// Hyalo's GPU time over the window.
#[derive(Debug, Clone, Serialize)]
pub struct GpuTime {
    /// Engine time per second of wall time, ms, every engine together.
    pub ms_per_s: f64,
    /// The same per frame drawn on any output; null when none was.
    pub ms_per_frame: Option<f64>,
    /// ms per second by engine (`gfx`, `compute`… as the driver names them).
    pub engines: std::collections::BTreeMap<String, f64>,
    /// The span it was taken over, ms (about the window; longer when nothing was drawn).
    pub over_ms: u64,
}

/// The kernel's accounting of the GPU time this process's jobs took: `drm-engine-<name>: <ns>`
/// in `/proc/self/fdinfo/<fd>` of each DRM file it holds (the DRM client usage stats; amdgpu,
/// i915, xe, msm, panfrost… report it, a software renderer does not). Engine time is the time
/// the jobs RAN — not a span between two timestamps on the GL timeline, which also holds the
/// waits on other clients' buffers: that is what #767's GL timer queries measured, and they
/// read ~10 ms a frame where the work was 1.4 (#761).
#[derive(Default)]
struct GpuClock {
    /// The fds that are DRM clients, found by scanning `/proc/self/fdinfo`; and when.
    fds: Vec<u32>,
    scanned: Option<Instant>,
    /// Readings, oldest first: when, and the ns by engine.
    readings: VecDeque<(Instant, std::collections::BTreeMap<String, u64>)>,
}

/// How often a reading is taken while frames are drawn, and how often the fds are found again.
const GPU_EVERY: Duration = Duration::from_millis(250);
const GPU_RESCAN: Duration = Duration::from_secs(10);

/// One fdinfo: its DRM client id and its engines' ns. None for an fd that is not a DRM client.
fn read_fdinfo(text: &str) -> Option<(u64, Vec<(String, u64)>)> {
    let mut client = None;
    let mut engines = Vec::new();
    for line in text.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        if key == "drm-client-id" {
            client = value.parse().ok();
        } else if let Some(engine) = key.strip_prefix("drm-engine-")
            && let Some(ns) = value.strip_suffix(" ns").and_then(|v| v.trim().parse().ok())
        {
            // `drm-engine-capacity-<name>` is a count, not a time: it has no " ns".
            engines.push((engine.to_string(), ns));
        }
    }
    client.map(|c| (c, engines))
}

impl GpuClock {
    fn scan(&mut self, now: Instant) {
        self.scanned = Some(now);
        self.fds.clear();
        let Ok(dir) = std::fs::read_dir("/proc/self/fdinfo") else { return };
        for entry in dir.flatten() {
            let Some(fd) = entry.file_name().to_str().and_then(|n| n.parse().ok()) else { continue };
            if std::fs::read_to_string(entry.path()).ok().as_deref().and_then(read_fdinfo).is_some() {
                self.fds.push(fd);
            }
        }
    }

    /// Now, by engine: per DRM client the largest of its fds' values (an fd duplicated, or the
    /// same client reached twice, reports the same counters read a moment apart), then summed
    /// over clients (a render node and a primary node, two GPUs). None without any client.
    fn read(&mut self, now: Instant) -> Option<std::collections::BTreeMap<String, u64>> {
        if self.scanned.is_none_or(|t| now.duration_since(t) >= GPU_RESCAN) {
            self.scan(now);
        }
        let mut clients: HashMap<u64, HashMap<String, u64>> = HashMap::new();
        let mut gone = false;
        for fd in &self.fds {
            match std::fs::read_to_string(format!("/proc/self/fdinfo/{fd}")).ok().as_deref().and_then(read_fdinfo) {
                Some((client, engines)) => {
                    let c = clients.entry(client).or_default();
                    for (engine, ns) in engines {
                        let v = c.entry(engine).or_default();
                        *v = (*v).max(ns);
                    }
                }
                None => gone = true,
            }
        }
        if gone {
            // An fd closed (or reused by something else): find them again next time.
            self.scanned = None;
        }
        let mut total = std::collections::BTreeMap::new();
        for engines in clients.into_values() {
            for (engine, ns) in engines {
                *total.entry(engine).or_insert(0u64) += ns;
            }
        }
        (!total.is_empty()).then_some(total)
    }

    /// A frame starts: a reading every `GPU_EVERY`, kept for twice the window.
    fn tick(&mut self, now: Instant) {
        if self.readings.back().is_some_and(|(t, _)| now.duration_since(*t) < GPU_EVERY) {
            return;
        }
        self.record(now);
    }

    fn record(&mut self, now: Instant) {
        if let Some(r) = self.read(now) {
            self.readings.push_back((now, r));
        }
        self.trim(now);
    }

    fn trim(&mut self, now: Instant) {
        while self.readings.len() > 2 && self.readings.front().is_some_and(|(t, _)| now.duration_since(*t) > WINDOW * 2) {
            self.readings.pop_front();
        }
    }

    /// The engine time per second since the reading closest to one window ago (the oldest
    /// there is if none is that old): from when, the total ms/s, and ms/s by engine.
    fn rate(&mut self, now: Instant) -> Option<(Instant, f64, std::collections::BTreeMap<String, f64>)> {
        let fresh = self.read(now)?;
        let base = self
            .readings
            .iter()
            .rev()
            .find(|(t, _)| now.duration_since(*t) >= WINDOW)
            .or(self.readings.front())
            .cloned();
        self.readings.push_back((now, fresh.clone()));
        self.trim(now);
        let (since, old) = base?;
        let secs = now.duration_since(since).as_secs_f64();
        if secs < 0.05 {
            return None;
        }
        let engines: std::collections::BTreeMap<String, f64> = fresh
            .iter()
            .map(|(k, v)| (k.clone(), v.saturating_sub(old.get(k).copied().unwrap_or(*v)) as f64 / 1e6 / secs))
            .collect();
        Some((since, engines.values().sum(), engines))
    }
}

#[cfg(test)]
mod gpu_tests {
    use super::*;

    #[test]
    fn fdinfo_gives_the_client_and_its_engine_times() {
        let amdgpu = "pos:\t0\nflags:\t02100002\ndrm-driver:\tamdgpu\ndrm-client-id:\t6556\ndrm-pdev:\t0000:2d:00.0\n\
                      drm-memory-vram:\t320892 KiB\ndrm-engine-gfx:\t37879210026 ns\ndrm-engine-compute:\t141560541 ns\n\
                      drm-engine-capacity-gfx:\t2\n";
        let (client, engines) = read_fdinfo(amdgpu).expect("a DRM client");
        assert_eq!(client, 6556);
        assert_eq!(engines, vec![("gfx".to_string(), 37879210026), ("compute".to_string(), 141560541)], "the capacity is no time");
        assert!(read_fdinfo("pos:\t0\nflags:\t02\n").is_none(), "an fd that is not a DRM client");
    }
}
