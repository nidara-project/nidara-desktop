// SPDX-License-Identifier: LGPL-3.0-or-later
//! Auto-hide (D2, DOCK.md §5): with `auto-hide` on the dock reserves no room, slides out
//! past its screen edge once the pointer has been gone `hide-delay` ms, and comes back
//! when the pointer reaches that edge along it. It slides the way the TS dock did, by the
//! layer's margin on its anchored edge, so the surface and everything laid out in it stay
//! as they are; while it is out a thin band along the screen edge still takes the pointer.
//! A menu, the chooser or the keyboard keeps it out until they let go.
use crate::geometry::{Layout, Position, SCREEN_GAP};
use std::time::{Duration, Instant};

/// The slide's easing time constant, seconds: settled in about a third of a second.
const SLIDE: f64 = 0.08;
/// How deep, from the screen edge, a hidden dock still feels the pointer: logical px.
const BAND: i32 = 2;
/// Out of sight past this share of the way: from here the band is all that takes input.
const OUT: f64 = 0.8;

/// How far the dock slides to be out of sight: from its glass's inner edge to the screen
/// edge (the glass sits against the surface's anchored edge; the room for magnification
/// is on the other side).
pub fn distance(l: &Layout) -> f64 {
    let [x, y, w, _] = l.glass;
    let inside = match l.position {
        Position::Bottom => l.size.1 as f64 - y,
        Position::Left => x + w,
        Position::Right => l.size.0 as f64 - x,
    };
    inside + SCREEN_GAP
}

/// The margin on the anchored edge with the dock `slide` of the way out (negative once
/// the surface reaches past the screen edge).
pub fn margin(l: &Layout, slide: f64) -> i32 {
    SCREEN_GAP as i32 - (slide * distance(l)).round() as i32
}

/// The strip along the screen edge, `BAND` deep and as long as the glass, in surface
/// coordinates, with the surface placed `margin` in from that edge.
pub fn band(l: &Layout, margin: i32) -> [i32; 4] {
    let [x, y, w, h] = l.glass.map(|v| v.round() as i32);
    let (sw, sh) = (l.size.0 as i32, l.size.1 as i32);
    match l.position {
        Position::Bottom => [x, sh + margin - BAND, w, BAND],
        Position::Left => [-margin, y, BAND, h],
        Position::Right => [sw + margin - BAND, y, BAND, h],
    }
}

pub struct Hide {
    auto: bool,
    /// Wanted on screen: the pointer came, or something holds it there.
    revealed: bool,
    /// How far out it is now, 0 (in place) to 1 (out of sight).
    pub slide: f64,
    at: Instant,
    hide_at: Option<Instant>,
    inside: bool,
}

impl Hide {
    /// A dock that starts with auto-hide on starts out of sight.
    pub fn new(auto: bool) -> Self {
        Hide {
            auto,
            revealed: !auto,
            slide: if auto { 1. } else { 0. },
            at: Instant::now(),
            hide_at: None,
            inside: false,
        }
    }

    /// The preference changed: off brings it back; on hides it once the pointer is away.
    pub fn set_auto(&mut self, auto: bool, delay: Duration, now: Instant) {
        if auto == self.auto {
            return;
        }
        self.auto = auto;
        if auto {
            self.release(delay, now);
        } else {
            self.reveal();
        }
    }

    /// The pointer is on the dock (or the band).
    pub fn enter(&mut self) {
        self.inside = true;
        self.reveal();
    }

    pub fn leave(&mut self, delay: Duration, now: Instant) {
        self.inside = false;
        self.release(delay, now);
    }

    /// Something holds the dock on screen: a popup, the keyboard, the pointer.
    pub fn reveal(&mut self) {
        self.revealed = true;
        self.hide_at = None;
    }

    /// What held it let go: it hides after the delay unless the pointer is on it.
    pub fn release(&mut self, delay: Duration, now: Instant) {
        if self.auto && !self.inside {
            self.hide_at = Some(now + delay);
        }
    }

    /// Only the band takes the pointer: the dock is (nearly) out of sight.
    pub fn out(&self) -> bool {
        !self.revealed && self.slide >= OUT
    }

    /// Time passes: hide when the delay is over and nothing holds the dock (`held`: a
    /// popup or the keyboard, which release it when they go), and move the slide toward
    /// where it is wanted. True when the slide moved.
    pub fn tick(&mut self, now: Instant, held: bool, reduce_motion: bool) -> bool {
        if self.hide_at.is_some_and(|t| now >= t) {
            self.hide_at = None;
            if !held {
                self.revealed = false;
            }
        }
        let dt = now.saturating_duration_since(self.at).as_secs_f64();
        self.at = now;
        let target = if self.revealed { 0. } else { 1. };
        if self.slide == target {
            return false;
        }
        let next = self.slide + (target - self.slide) * (1. - (-dt / SLIDE).exp());
        self.slide = if reduce_motion || (next - target).abs() < 0.005 {
            target
        } else {
            next
        };
        true
    }

    /// How long the loop may sleep: a frame while sliding, else until the hide is due.
    pub fn wait(&self, now: Instant, frame: Duration) -> Option<Duration> {
        let target = if self.revealed { 0. } else { 1. };
        if self.slide != target {
            return Some(frame);
        }
        self.hide_at.map(|t| t.saturating_duration_since(now))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{Slot, envelope, layout};

    const MS: Duration = Duration::from_millis(1);

    #[test]
    fn hides_after_the_delay_and_comes_back_on_the_pointer() {
        let t0 = Instant::now();
        let mut h = Hide::new(true);
        assert!(h.out());
        h.enter();
        assert!(h.tick(t0 + 100 * MS, false, true));
        assert_eq!(h.slide, 0.);
        h.leave(500 * MS, t0 + 100 * MS);
        assert!(!h.tick(t0 + 599 * MS, false, true), "not before the delay");
        assert!(h.tick(t0 + 600 * MS, false, true));
        assert!(h.out());
    }

    #[test]
    fn a_popup_or_the_keyboard_holds_it_until_released() {
        let t0 = Instant::now();
        let mut h = Hide::new(true);
        h.enter();
        h.tick(t0, false, true);
        h.leave(Duration::ZERO, t0);
        assert!(!h.tick(t0 + MS, true, true), "held: stays");
        assert_eq!(h.slide, 0.);
        h.release(Duration::ZERO, t0 + MS);
        assert!(h.tick(t0 + 2 * MS, false, true));
        assert!(h.out());
    }

    #[test]
    fn turning_it_off_brings_the_dock_back_and_on_hides_it() {
        let t0 = Instant::now();
        let mut h = Hide::new(true);
        h.set_auto(false, Duration::ZERO, t0);
        h.tick(t0 + MS, false, true);
        assert_eq!(h.slide, 0.);
        h.set_auto(true, Duration::ZERO, t0 + MS);
        h.tick(t0 + 2 * MS, false, true);
        assert!(h.out());
        // The slide eases without reduced motion, and the loop is told to keep ticking.
        let mut h = Hide::new(false);
        h.set_auto(true, Duration::ZERO, t0);
        h.tick(t0, false, false);
        assert!(h.tick(t0 + 16 * MS, false, false));
        assert!(h.slide > 0. && h.slide < 1.);
        assert_eq!(h.wait(t0 + 16 * MS, 16 * MS), Some(16 * MS));
    }

    #[test]
    fn out_of_sight_past_the_edge_with_the_band_on_screen() {
        let slots = [Slot::Icon, Slot::Separator, Slot::Icon];
        for pos in [Position::Bottom, Position::Left, Position::Right] {
            let rest = layout(&slots, 48, pos, (1280, 800), 0.);
            let l = envelope(rest.clone(), &slots, 96, (1280, 800), 0.);
            assert_eq!(margin(&l, 0.), SCREEN_GAP as i32);
            let m = margin(&l, 1.);
            // Fully out: the glass's inner edge lies on the screen edge, or past it.
            let glass_inner = match pos {
                Position::Bottom => l.size.1 as f64 - l.glass[1],
                Position::Left => l.glass[0] + l.glass[2],
                Position::Right => l.size.0 as f64 - l.glass[0],
            };
            assert!(
                m as f64 + glass_inner <= 0.5,
                "{pos:?}: {m} + {glass_inner}"
            );
            // The band is the strip just inside the screen edge.
            let [x, y, w, h] = band(&l, m);
            let edge = match pos {
                Position::Bottom => (y + h) - (l.size.1 as i32 + m),
                Position::Left => x + m,
                Position::Right => (x + w) - (l.size.0 as i32 + m),
            };
            assert_eq!(edge, 0, "{pos:?}");
            assert!(w > 0 && h > 0);
        }
    }
}
