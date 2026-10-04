//! A window opening and closing (#684 "Motion"): what the Hyprland session did for Nidara
//! (config/hypr/hyprland.lua, "Animations"), so nothing changes for the user at the switch.
//!
//! - **Opening**: it grows out of its own middle — Hyprland's `popin` from nothing — on
//!   `myBezier`, which goes a little past its size and settles, over `[animations] open` ms (700 =
//!   `windows`, speed 7); and it fades in on `easeOut` over `[animations] fade` ms (400 =
//!   `fade`). Its surfaces keep drawing: every frame of it is the window as it is now.
//! - **Closing**: it shrinks to 80 % on `default` over `[animations] close` ms (400 =
//!   `windowsOut`, `popin 80%`) and fades out over `fade`. Its app has destroyed it by then,
//!   so what is drawn is a picture of its last frame, taken as it went (render/snapshot.rs).
//!
//! Both are drawn as one picture of the whole window — corners, title bar, line, shadow —
//! scaled about its middle and faded as one (render/mod.rs). Not the blur behind a
//! translucent window: it comes in when the window has opened, and goes as it starts to close.
//! None with reduce motion (`[animations] enabled = false`), for a window a rule takes them
//! from (`animate = false`: games, a window with no app id), for one that opens on a workspace
//! nobody sees, or one that closes hidden.
//!
//! - **Going to another workspace** (`Slide`): the one shown slides out sideways and the other
//!   in, on `default` over `[animations] workspace` ms (600 = `workspaces`, Hyprland's `slide`)
//!   — to a higher number from the right, to a lower one from the left. The windows of the
//!   workspace left behind are hidden, not gone: they are drawn where they are, moved, from their
//!   last frame. Pinned windows stay put; the shell's bar and dock, and the wallpaper, too.

use std::time::{Duration, Instant};

use smithay::utils::{Logical, Rectangle};

use super::WindowId;
use crate::state::Hyalo;

/// A cubic Bézier from (0, 0) to (1, 1) through `p1` and `p2`, as Hyprland's curves are given:
/// the time `x` (0..1) → the progress. The control points' x must be within 0..1, which keeps
/// the curve a function of time; their y may leave it (an overshoot).
pub fn bezier(p1: (f64, f64), p2: (f64, f64), x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    let at = |t: f64, a: f64, b: f64| 3.0 * (1.0 - t) * (1.0 - t) * t * a + 3.0 * (1.0 - t) * t * t * b + t * t * t;
    // Solve at_x(t) = x by bisection: monotonic in t for control points with x in 0..1.
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..32 {
        let mid = (lo + hi) / 2.0;
        if at(mid, p1.0, p2.0) < x { lo = mid } else { hi = mid }
    }
    at((lo + hi) / 2.0, p1.1, p2.1)
}

/// The Hyprland session's curves (config/hypr/hyprland.lua).
pub mod curve {
    /// `myBezier`: fast, a little past the end (under 1 %), back.
    pub const MY_BEZIER: ((f64, f64), (f64, f64)) = ((0.05, 0.9), (0.1, 1.05));
    /// `default` (Hyprland's own): three quarters of the way in the first fifth of the time.
    pub const DEFAULT: ((f64, f64), (f64, f64)) = ((0.0, 0.75), (0.15, 1.0));
    /// `easeOut`.
    pub const EASE_OUT: ((f64, f64), (f64, f64)) = ((0.0, 0.0), (0.2, 1.0));
}

fn on(c: ((f64, f64), (f64, f64)), x: f64) -> f64 {
    bezier(c.0, c.1, x)
}

/// How far a closing window shrinks: Hyprland's `popin 80%`.
pub const CLOSED_SCALE: f64 = 0.8;

/// One window opening or closing: when it started and how long each half of it takes.
#[derive(Debug, Clone, Copy)]
pub struct Motion {
    pub start: Instant,
    /// Opening (true) or closing.
    pub opening: bool,
    pub size: Duration,
    pub fade: Duration,
}

/// What a window opening or closing looks like at a moment: scaled about its middle, faded.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Look {
    pub scale: f64,
    pub alpha: f64,
}

impl Motion {
    pub fn new(opening: bool, cfg: &crate::config::AnimationsConfig, now: Instant) -> Self {
        let size = if opening { cfg.open } else { cfg.close };
        Self { start: now, opening, size: Duration::from_millis(size as u64), fade: Duration::from_millis(cfg.fade as u64) }
    }

    /// Nothing more to draw: opened (the window as it is), or gone.
    pub fn done(&self, now: Instant) -> bool {
        now.duration_since(self.start) >= self.size.max(self.fade)
    }

    /// How it looks at `now`; `None` once it is done.
    pub fn look(&self, now: Instant) -> Option<Look> {
        if self.done(now) {
            return None;
        }
        let t = now.duration_since(self.start).as_secs_f64();
        let x = |d: Duration| if d.is_zero() { 1.0 } else { t / d.as_secs_f64() };
        let size = x(self.size);
        let fade = on(curve::EASE_OUT, x(self.fade));
        Some(if self.opening {
            Look { scale: on(curve::MY_BEZIER, size), alpha: fade }
        } else {
            Look { scale: 1.0 + (CLOSED_SCALE - 1.0) * on(curve::DEFAULT, size), alpha: 1.0 - fade }
        })
    }
}

/// A window opening.
#[derive(Debug, Clone, Copy)]
pub struct Opening {
    pub id: WindowId,
    pub motion: Motion,
}

/// A window closing: its picture (render/snapshot.rs) and where its whole box was, global
/// logical px.
#[derive(Debug)]
pub struct Closing {
    pub picture: crate::render::snapshot::Snapshot,
    pub frame: Rectangle<f64, Logical>,
    /// It was fullscreen: drawn over the shell's chrome, where it was.
    pub fullscreen: bool,
    pub motion: Motion,
}

/// An output going from one workspace to another.
#[derive(Debug, Clone)]
pub struct Slide {
    pub output: String,
    pub from: i32,
    pub to: i32,
    pub start: Instant,
    pub duration: Duration,
}

impl Slide {
    /// How far it has gone at `now`, 0..1 on `default`; `None` once it is over.
    pub fn progress(&self, now: Instant) -> Option<f64> {
        let t = now.duration_since(self.start);
        if t >= self.duration {
            return None;
        }
        Some(on(curve::DEFAULT, t.as_secs_f64() / self.duration.as_secs_f64()))
    }

    /// Where workspace `ws`'s windows are drawn at progress `p`, as a share of the output's
    /// width: the one arriving from one side, the one left behind toward the other. `None` for a
    /// workspace that is neither.
    pub fn shift(&self, ws: i32, p: f64) -> Option<f64> {
        // To a higher number, the new one comes from the right.
        let dir = if self.to > self.from { 1.0 } else { -1.0 };
        if ws == self.to {
            Some(dir * (1.0 - p))
        } else if ws == self.from {
            Some(-dir * p)
        } else {
            None
        }
    }
}

impl super::Wm {
    /// The workspace change going on on `output`, and how far it has gone.
    pub fn slide(&self, output: &str, now: Instant) -> Option<(&Slide, f64)> {
        self.slides.iter().find(|s| s.output == output).and_then(|s| Some((s, s.progress(now)?)))
    }

    /// How window `id` looks while it opens, if it is opening.
    pub fn opening(&self, id: WindowId, now: Instant) -> Option<Look> {
        self.openings.iter().find(|o| o.id == id).and_then(|o| o.motion.look(now))
    }
}

impl Hyalo {
    /// Whether window `id` opens and closes animated: animations on, no rule against it, on a
    /// workspace someone sees, not minimized.
    fn animates(&self, id: WindowId) -> bool {
        let cfg = &self.config.animations;
        cfg.enabled
            && (cfg.open > 0 || cfg.close > 0 || cfg.fade > 0)
            && self.wm.get(id).is_some_and(|m| m.animate && m.mapped && self.wm.is_visible(m.workspace) && !self.wm.is_hidden(m))
    }

    /// Window `id` was just shown: it opens.
    pub fn start_opening(&mut self, id: WindowId) {
        self.wm.openings.retain(|o| o.id != id);
        if !self.animates(id) {
            return;
        }
        let motion = Motion::new(true, &self.config.animations, Instant::now());
        self.wm.openings.push(Opening { id, motion });
        self.queue_redraw(None);
    }

    /// Window `id` is going: a picture of it, taken now — its app has destroyed it, and its
    /// surfaces go right after — fades away where it was.
    pub fn start_closing(&mut self, id: WindowId) {
        self.wm.openings.retain(|o| o.id != id);
        if !self.animates(id) || self.wm.closing_taken.contains(&id) {
            return;
        }
        self.wm.closing_taken.push(id);
        let Some(m) = self.wm.get(id) else { return };
        let (frame, fullscreen) = (m.frame().to_f64(), m.fullscreen == super::Fullscreen::Fullscreen);
        let window = m.window.clone();
        // The scale of the output it is on: the picture is as sharp as the window was.
        let scale = self
            .wm
            .workspaces
            .get(&m.workspace)
            .and_then(|w| self.output_named(&w.output))
            .map_or(1.0, |o| o.current_scale().fractional_scale());
        let picture = match crate::backend::snapshot_window(self, &window, scale) {
            Ok(p) => p,
            Err(err) => {
                tracing::debug!(%err, id, "no picture of a closing window");
                return;
            }
        };
        let motion = Motion::new(false, &self.config.animations, Instant::now());
        self.wm.closing.push(Closing { picture, frame, fullscreen, motion });
        self.queue_redraw(None);
    }

    /// `output` goes from workspace `from` to `to`: they slide.
    pub fn start_slide(&mut self, output: &str, from: i32, to: i32) {
        self.wm.slides.retain(|s| s.output != output);
        let cfg = &self.config.animations;
        if !cfg.enabled || cfg.workspace == 0 || from == to {
            return;
        }
        let duration = Duration::from_millis(cfg.workspace as u64);
        self.wm.slides.push(Slide { output: output.into(), from, to, start: Instant::now(), duration });
        self.queue_redraw(None);
    }

    /// Drops the openings, closings and workspace changes that are over; whether any is left.
    pub fn step_motions(&mut self) -> bool {
        let now = Instant::now();
        self.wm.openings.retain(|o| !o.motion.done(now));
        self.wm.closing.retain(|c| !c.motion.done(now));
        self.wm.slides.retain(|s| s.progress(now).is_some());
        !self.wm.openings.is_empty() || !self.wm.closing.is_empty() || !self.wm.slides.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn motion(opening: bool) -> (Motion, Instant) {
        let t0 = Instant::now();
        let cfg = crate::config::AnimationsConfig::default();
        (Motion::new(opening, &cfg, t0), t0)
    }

    #[test]
    fn opening_grows_from_nothing_past_its_size_and_settles() {
        let (m, t0) = motion(true);
        let at = |ms: u64| m.look(t0 + Duration::from_millis(ms));
        let first = at(0).unwrap();
        assert!(first.scale.abs() < 1e-6 && first.alpha.abs() < 1e-6, "{first:?}");
        // myBezier goes a little past the end: its control point is at 1.05, the curve
        // itself peaks under 1 %.
        let peak = (1..70).map(|i| at(i * 10).unwrap().scale).fold(0.0, f64::max);
        assert!(peak > 1.005 && peak < 1.02, "{peak}");
        // Faded in by `fade`, still settling until `open`.
        assert!((at(450).unwrap().alpha - 1.0).abs() < 1e-6);
        assert!(at(699).is_some() && at(700).is_none());
    }

    #[test]
    fn closing_shrinks_to_eighty_percent_and_fades_out() {
        let (m, t0) = motion(false);
        let at = |ms: u64| m.look(t0 + Duration::from_millis(ms)).unwrap();
        assert!((at(0).scale - 1.0).abs() < 1e-6 && (at(0).alpha - 1.0).abs() < 1e-6);
        let end = at(399);
        assert!(end.scale > 0.79 && end.scale < 0.81 && end.alpha < 0.02, "{end:?}");
        let mut last = at(0);
        for ms in (10..400).step_by(10) {
            let l = at(ms);
            assert!(l.scale <= last.scale + 1e-9 && l.alpha <= last.alpha + 1e-9, "at {ms}: {l:?} after {last:?}");
            last = l;
        }
        assert!(m.look(t0 + Duration::from_millis(400)).is_none());
    }

    #[test]
    fn a_workspace_slides_in_from_the_side_of_its_number() {
        let s = Slide { output: "o".into(), from: 1, to: 2, start: Instant::now(), duration: Duration::from_millis(600) };
        assert_eq!(s.shift(2, 0.0), Some(1.0), "a higher number comes from the right");
        assert_eq!(s.shift(1, 0.0), Some(-0.0));
        assert_eq!(s.shift(1, 1.0), Some(-1.0), "the one left behind goes left");
        assert_eq!(s.shift(2, 1.0), Some(0.0));
        assert_eq!(s.shift(3, 0.5), None);
        let back = Slide { from: 2, to: 1, ..s.clone() };
        assert_eq!(back.shift(1, 0.0), Some(-1.0), "a lower number comes from the left");
        assert!(s.progress(s.start + Duration::from_millis(600)).is_none());
    }

    #[test]
    fn a_zero_duration_is_already_there() {
        let cfg = crate::config::AnimationsConfig { open: 0, fade: 0, ..Default::default() };
        let t0 = Instant::now();
        assert!(Motion::new(true, &cfg, t0).look(t0).is_none());
    }
}
