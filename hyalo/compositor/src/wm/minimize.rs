//! Minimizing (#724), as the owner decided it (2026-10-04):
//!
//! - **Where it goes.** Nowhere: a minimized window stays on its workspace, hidden — a state of
//!   the window that the workspaces skip (`Wm::is_hidden`), not a special workspace (the Hyprland workaround, which would have to remember where the window
//!   came from). It is out of the `Space`, so it gets no frames, no input and no outputs, like a
//!   window on a hidden workspace. On a tiling workspace it leaves the layout and the others take
//!   its room; it comes back into the layout when it is restored. Its dialogs go with it.
//! - **How it comes back.** Every route to a window's focus comes through `focus_window`, and a
//!   hidden window is restored there: the dock's icon and its thumbnail of the window (the
//!   shell), `focus-window` over IPC, an app asking to be activated (xdg-activation).
//!   `unminimize` does the same without asking for the focus.
//! - **The animation.** The window shrinks into its place in the dock — the thumbnail the dock
//!   gives each minimized window — and grows back out of it. The dock says where those places are
//!   (`minimize_targets` over IPC, rectangles in the dock's own surface): Hyalo cannot know a
//!   layout of the shell's. A new thumbnail is laid out only after the dock hears of the
//!   minimized window, so a window waits for its place, drawn where it was, at most `WAIT`; with
//!   no place by then (no dock) it goes at once. `[animations] enabled = false` (reduce motion):
//!   always at once.
//! - **What asks for it.** The minimize button of Hyalo's controls, an app's own button
//!   (`xdg_toplevel.set_minimized`), `minimize` over IPC. Never a dialog by itself: it goes
//!   with the window it belongs to (window_controls.rs shows it no minimize button).

use std::{
    collections::HashMap,
    time::{Duration, Instant},
};

use smithay::{
    desktop::layer_map_for_output,
    utils::{Logical, Point, Rectangle},
};

use super::{Managed, WindowId};
use crate::state::Hyalo;

/// How long a minimized window waits for the dock to say where its thumbnail is before it goes
/// without an animation: the dock hears of the window through the IPC's event stream, lays out
/// a new item and answers — measured nested (`hyalo-minimize-check.sh` prints it).
pub const WAIT: Duration = Duration::from_millis(250);

/// The places a dock gave its minimized windows: rectangles in the dock's own layer surface,
/// logical px, by window. Kept per output (one dock each).
#[derive(Debug, Clone, Default)]
pub struct Targets {
    /// The layer surface the rectangles are in (`nidara-dock`).
    pub namespace: String,
    pub rects: HashMap<WindowId, Rectangle<f64, Logical>>,
}

/// A window shrinking into the dock (`out`) or growing back out of it.
#[derive(Debug, Clone)]
pub struct Anim {
    pub id: WindowId,
    pub out: bool,
    /// When it was minimized or restored.
    pub asked: Instant,
    /// Once its place in the dock is known: when it started moving, and that place (global
    /// logical px).
    pub start: Option<Instant>,
    pub to: Option<Rectangle<f64, Logical>>,
    pub duration: Duration,
}

/// Where a window's whole box is drawn at a moment of its animation: its top-left corner,
/// global logical px, and how much it is scaled. Everything of the window is drawn from these
/// (render/mod.rs), so its corners, its line and its shadow shrink with it.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Placement {
    pub origin: Point<f64, Logical>,
    pub scale: f64,
}

/// What an animation shows now.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Shown {
    /// The window, scaled and moved.
    At(Placement),
    /// Nothing: it has gone into the dock, or it never had a place to go.
    Gone,
    /// The window as it is: restored (the animation is over).
    Whole,
}

/// The Hyprland session's `default` curve, `bezier(0, 0.75, 0.15, 1)` (Hyprland's own
/// `AnimationManager`): fast out, settling in. `x` in 0..1 → the progress, 0..1.
pub fn ease(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    let (x1, y1, x2, y2) = (0.0, 0.75, 0.15, 1.0);
    let bez = |t: f64, a: f64, b: f64| 3.0 * (1.0 - t) * (1.0 - t) * t * a + 3.0 * (1.0 - t) * t * t * b + t * t * t;
    // Solve bez_x(t) = x by bisection: monotonic in t for these control points.
    let (mut lo, mut hi) = (0.0, 1.0);
    for _ in 0..32 {
        let mid = (lo + hi) / 2.0;
        if bez(mid, x1, x2) < x { lo = mid } else { hi = mid }
    }
    bez((lo + hi) / 2.0, y1, y2)
}

/// `frame` fitted inside `target`, its proportions kept, centred: where the window lands.
pub fn fitted(frame: Rectangle<f64, Logical>, target: Rectangle<f64, Logical>) -> Rectangle<f64, Logical> {
    let k = (target.size.w / frame.size.w.max(1.0)).min(target.size.h / frame.size.h.max(1.0));
    let (w, h) = (frame.size.w * k, frame.size.h * k);
    Rectangle::new(
        (target.loc.x + (target.size.w - w) / 2.0, target.loc.y + (target.size.h - h) / 2.0).into(),
        (w, h).into(),
    )
}

/// The window's whole box `frame` moved toward `to` by `e` (0 = where it is, 1 = landed).
pub fn between(frame: Rectangle<f64, Logical>, to: Rectangle<f64, Logical>, e: f64) -> Placement {
    let land = fitted(frame, to);
    let k = land.size.w / frame.size.w.max(1.0);
    Placement {
        origin: (frame.loc.x + (land.loc.x - frame.loc.x) * e, frame.loc.y + (land.loc.y - frame.loc.y) * e).into(),
        scale: 1.0 + (k - 1.0) * e,
    }
}

impl Anim {
    /// What it shows at `now`, for a window whose whole box is `frame`.
    pub fn shown(&self, frame: Rectangle<f64, Logical>, now: Instant) -> Shown {
        let (Some(start), Some(to)) = (self.start, self.to) else {
            // Waiting for its place: still where it was, for at most `WAIT`.
            return if self.out && now.duration_since(self.asked) < WAIT {
                Shown::At(Placement { origin: frame.loc, scale: 1.0 })
            } else if self.out {
                Shown::Gone
            } else {
                Shown::Whole
            };
        };
        let x = now.duration_since(start).as_secs_f64() / self.duration.as_secs_f64().max(1e-3);
        if x >= 1.0 {
            return if self.out { Shown::Gone } else { Shown::Whole };
        }
        let e = ease(x);
        Shown::At(between(frame, to, if self.out { e } else { 1.0 - e }))
    }

    /// Over: nothing more to draw.
    pub fn done(&self, now: Instant) -> bool {
        match self.start {
            Some(start) => now.duration_since(start) >= self.duration,
            None => !self.out || now.duration_since(self.asked) >= WAIT,
        }
    }
}

impl super::Wm {
    /// Not shown because it, or the window it is a dialog of, is minimized.
    pub fn is_hidden(&self, m: &Managed) -> bool {
        self.minimized_root(m).is_some()
    }

    /// The minimized window that hides `m`: itself, or a window it is a dialog of.
    pub fn minimized_root(&self, m: &Managed) -> Option<WindowId> {
        let mut cur = m;
        // Bounded: a client could make a cycle of parents.
        for _ in 0..8 {
            if cur.minimized.is_some() {
                return Some(cur.id);
            }
            cur = cur.window.toplevel().and_then(|t| t.parent()).and_then(|p| self.by_surface(&p))?;
        }
        None
    }

    /// The animation of window `id`, if it has one.
    pub fn anim(&self, id: WindowId) -> Option<&Anim> {
        self.animations.iter().find(|a| a.id == id)
    }

    /// Where `m`'s whole box is drawn at `now`, scaled, while it — or the window it is a
    /// dialog of, which carries it along — goes into the dock or comes back; `None` = as it is.
    pub fn placement(&self, m: &Managed, now: Instant) -> Option<Placement> {
        let mut cur = m;
        // Bounded: a client could make a cycle of parents.
        for _ in 0..8 {
            if let Some(a) = self.anim(cur.id) {
                let frame = cur.frame().to_f64();
                let Shown::At(p) = a.shown(frame, now) else { return None };
                let own = m.frame().to_f64();
                return Some(Placement { origin: p.origin + (own.loc - frame.loc).upscale(p.scale), scale: p.scale });
            }
            cur = cur.window.toplevel().and_then(|t| t.parent()).and_then(|p| self.by_surface(&p))?;
        }
        None
    }
}

impl Hyalo {
    /// Minimizes window `id`: hidden on its workspace, out of its layout, its focus to the
    /// window focused before it. A dialog is never minimized by itself.
    pub fn minimize(&mut self, id: WindowId) -> Result<(), String> {
        let m = self.wm.get(id).ok_or_else(|| format!("no window {id}"))?;
        if m.minimized.is_some() {
            return Ok(());
        }
        if m.window.toplevel().and_then(|t| t.parent()).is_some() {
            return Err("a dialog is minimized with the window it belongs to".into());
        }
        let ws = m.workspace;
        self.wm.minimize_counter += 1;
        let order = self.wm.minimize_counter;
        if let Some(w) = self.wm.workspaces.get_mut(&ws) {
            w.layout.remove(id);
        }
        self.wm.get_mut(id).unwrap().minimized = Some(order);
        self.start_anim(id, true);
        self.wm.dirty_windows = true;
        self.wm.dirty_workspaces = true;
        // The focus goes back to the window focused before it — or before its dialog.
        let focused_hidden = self.wm.focused.and_then(|f| self.wm.get(f)).is_some_and(|f| self.wm.is_hidden(f));
        if focused_hidden {
            self.wm.focused = None;
            let next = self.wm.last_focused_on(ws);
            self.focus_window(next);
        }
        self.arrange_workspace(ws);
        self.sync_space();
        Ok(())
    }

    /// Brings window `id` back where it was — into its layout on a tiling workspace — without
    /// asking for the focus (`focus_window` restores and focuses). A window hidden because the
    /// window it is a dialog of is minimized brings that one back.
    pub fn unminimize(&mut self, id: WindowId) {
        let Some(root) = self.wm.get(id).and_then(|m| self.wm.minimized_root(m)) else { return };
        let Some(m) = self.wm.get(root) else { return };
        let (ws, floating, full) = (m.workspace, m.floating, m.fullscreen);
        self.wm.get_mut(root).unwrap().minimized = None;
        if !floating && full == super::Fullscreen::None
            && let Some(output) = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output))
        {
            let area = super::inset(self.work_area(&output), self.config.layout.gaps_out);
            let near = self.wm.last_focused_on(ws).filter(|n| *n != root);
            if let Some(w) = self.wm.workspaces.get_mut(&ws) {
                w.layout.insert(root, area, near, None);
            }
        }
        self.start_anim(root, false);
        self.wm.dirty_windows = true;
        self.wm.dirty_workspaces = true;
        self.arrange_workspace(ws);
        self.sync_space();
    }

    /// The window's place in a dock, global logical px: the dock on its own output first.
    pub fn minimize_target(&self, id: WindowId) -> Option<Rectangle<f64, Logical>> {
        let own = self.wm.get(id).and_then(|m| self.wm.workspaces.get(&m.workspace)).map(|w| w.output.clone());
        let mut outputs: Vec<&String> = self.wm.minimize_targets.keys().collect();
        outputs.sort_by_key(|o| Some(*o) != own.as_ref());
        outputs.into_iter().find_map(|name| {
            let t = &self.wm.minimize_targets[name];
            let r = *t.rects.get(&id)?;
            let output = self.output_named(name)?;
            let og = self.space.output_geometry(&output)?;
            let map = layer_map_for_output(&output);
            let layer = map.layers().find(|l| l.namespace() == t.namespace)?;
            let lg = crate::shell::layer::layer_geometry(&map, layer)?;
            Some(Rectangle::new((r.loc.x + (og.loc.x + lg.loc.x) as f64, r.loc.y + (og.loc.y + lg.loc.y) as f64).into(), r.size))
        })
    }

    /// Starts window `id`'s animation into the dock or out of it — at once when its place is
    /// known; a window going in waits for it (`WAIT`). None with reduce motion.
    fn start_anim(&mut self, id: WindowId, out: bool) {
        self.wm.animations.retain(|a| a.id != id);
        let cfg = &self.config.animations;
        if !cfg.enabled || cfg.minimize == 0 {
            return;
        }
        let to = self.minimize_target(id);
        // Coming back from nowhere it knows: no animation, the window is simply there.
        if !out && to.is_none() {
            return;
        }
        let now = Instant::now();
        self.wm.animations.push(Anim {
            id,
            out,
            asked: now,
            start: to.map(|_| now),
            to,
            duration: Duration::from_millis(cfg.minimize as u64),
        });
        self.queue_redraw(None);
    }

    /// The places a dock gave its minimized windows (`minimize_targets` over IPC). A window
    /// waiting for its place starts moving now.
    pub fn set_minimize_targets(&mut self, output: String, namespace: String, rects: HashMap<WindowId, Rectangle<f64, Logical>>) {
        self.wm.minimize_targets.insert(output, Targets { namespace, rects });
        let now = Instant::now();
        let waiting: Vec<WindowId> = self.wm.animations.iter().filter(|a| a.out && a.start.is_none() && !a.done(now)).map(|a| a.id).collect();
        for id in waiting {
            let to = self.minimize_target(id);
            if let Some(a) = self.wm.animations.iter_mut().find(|a| a.id == id)
                && to.is_some()
            {
                a.to = to;
                a.start = Some(now);
            }
        }
        self.queue_redraw(None);
    }

    /// After a frame: the animations that are over go; any still moving wants the next frame.
    pub fn step_animations(&mut self) -> bool {
        let now = Instant::now();
        self.wm.animations.retain(|a| !a.done(now));
        !self.wm.animations.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: f64, y: f64, w: f64, h: f64) -> Rectangle<f64, Logical> {
        Rectangle::new((x, y).into(), (w, h).into())
    }

    #[test]
    fn the_curve_starts_fast_and_ends_where_it_should() {
        assert!(ease(0.0).abs() < 1e-6);
        assert!((ease(1.0) - 1.0).abs() < 1e-6);
        // Hyprland's `default`: three quarters of the way in the first fifth of the time.
        assert!(ease(0.2) > 0.75, "{}", ease(0.2));
        let mut last = 0.0;
        for i in 1..=100 {
            let e = ease(i as f64 / 100.0);
            assert!(e >= last - 1e-9, "not monotonic at {i}");
            last = e;
        }
    }

    #[test]
    fn a_window_lands_inside_its_place_with_its_proportions() {
        // A 1000×500 window into a 50×50 thumbnail: 50×25, centred in it.
        let to = r(2000.0, 1300.0, 50.0, 50.0);
        let land = fitted(r(100.0, 100.0, 1000.0, 500.0), to);
        assert_eq!(land, r(2000.0, 1312.5, 50.0, 25.0));
        let p = between(r(100.0, 100.0, 1000.0, 500.0), to, 1.0);
        assert_eq!(p.origin, Point::from((2000.0, 1312.5)));
        assert!((p.scale - 0.05).abs() < 1e-9);
        // Halfway in progress, halfway in place and in size.
        let p = between(r(100.0, 100.0, 1000.0, 500.0), to, 0.5);
        assert_eq!(p.origin, Point::from((1050.0, 706.25)));
        assert!((p.scale - 0.525).abs() < 1e-9);
    }

    #[test]
    fn going_in_waits_for_its_place_and_then_moves() {
        let frame = r(0.0, 0.0, 400.0, 300.0);
        let t0 = Instant::now();
        let mut a = Anim { id: 1, out: true, asked: t0, start: None, to: None, duration: Duration::from_millis(400) };
        // No place yet: where it was, until WAIT.
        assert_eq!(a.shown(frame, t0), Shown::At(Placement { origin: frame.loc, scale: 1.0 }));
        assert!(!a.done(t0));
        assert_eq!(a.shown(frame, t0 + WAIT), Shown::Gone);
        assert!(a.done(t0 + WAIT));
        // With one: moving, then gone at the end.
        a.start = Some(t0);
        a.to = Some(r(1000.0, 1000.0, 40.0, 40.0));
        let Shown::At(mid) = a.shown(frame, t0 + Duration::from_millis(100)) else { panic!("not moving") };
        assert!(mid.scale < 1.0 && mid.origin.x > 0.0);
        assert_eq!(a.shown(frame, t0 + Duration::from_millis(400)), Shown::Gone);
        // Coming back: from the place to the window, then whole.
        let back = Anim { out: false, ..a.clone() };
        let Shown::At(first) = back.shown(frame, t0) else { panic!("not moving") };
        assert!(first.scale < 0.2, "{}", first.scale);
        assert_eq!(back.shown(frame, t0 + Duration::from_millis(400)), Shown::Whole);
    }
}
