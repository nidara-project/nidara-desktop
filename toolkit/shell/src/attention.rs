// SPDX-License-Identifier: LGPL-3.0-or-later
//! The attention bounce (APPLICATIONS1-DOCK.md §5): three gentle lifts over at most 3 s for
//! each new false→true edge of a slot's attention; a slot that stays in attention, however
//! often it is told so again, does not bounce again. Reduced motion has no bounce at all:
//! the still mark the dock draws beside it is the whole indication. Pure: no clock of its
//! own, no Wayland.
use crate::model::Item;
use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;
use std::time::{Duration, Instant};

pub const BOUNCE: Duration = Duration::from_secs(3);
pub const CYCLES: f64 = 3.;
/// While a bounce runs: about one frame at 60 Hz.
pub const FRAME: Duration = Duration::from_millis(16);

#[derive(Default)]
pub struct Attention {
    /// Slots in attention now, by key.
    on: HashSet<String>,
    /// When each one's latest edge began.
    since: HashMap<String, Instant>,
    /// A bounce was running at the last tick: one more frame puts it back at rest.
    was_moving: bool,
}

impl Attention {
    /// A new view: edges start bounces, slots out of attention forget theirs.
    pub fn update(&mut self, items: &[Item], now: Instant) {
        let on: HashSet<String> = items
            .iter()
            .filter(|i| i.signal.attention)
            .map(|i| i.key.clone())
            .collect();
        for key in on.difference(&self.on) {
            self.since.insert(key.clone(), now);
        }
        self.since.retain(|k, _| on.contains(k));
        self.on = on;
    }

    /// How far the slot is lifted now, as a share of its whole lift: 0 at rest.
    pub fn lift(&self, key: &str, now: Instant, reduce_motion: bool) -> f64 {
        if reduce_motion {
            return 0.;
        }
        self.since.get(key).map_or(0., |t| {
            let e = now.saturating_duration_since(*t);
            if e >= BOUNCE {
                0.
            } else {
                (PI * CYCLES * e.as_secs_f64() / BOUNCE.as_secs_f64())
                    .sin()
                    .abs()
            }
        })
    }

    fn moving(&self, now: Instant, reduce_motion: bool) -> bool {
        !reduce_motion
            && self
                .since
                .values()
                .any(|t| now.saturating_duration_since(*t) < BOUNCE)
    }

    /// Frames are wanted: a bounce runs, or one just ended and must be drawn at rest.
    pub fn wants_frames(&self, now: Instant, reduce_motion: bool) -> bool {
        self.was_moving || self.moving(now, reduce_motion)
    }

    /// Once per idle turn: whether to draw another frame.
    pub fn tick(&mut self, now: Instant, reduce_motion: bool) -> bool {
        let draw = self.wants_frames(now, reduce_motion);
        self.was_moving = self.moving(now, reduce_motion);
        draw
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Kind, Signal};

    fn item(key: &str, attention: bool) -> Item {
        Item {
            key: key.into(),
            kind: Kind::Trash,
            label: String::new(),
            windows: vec![],
            minimized: vec![],
            signal: Signal {
                attention,
                ..Default::default()
            },
        }
    }

    #[test]
    fn an_edge_bounces_three_times_within_three_seconds_and_repeats_restart_nothing() {
        let mut a = Attention::default();
        let t = Instant::now();
        let at = |ms| t + Duration::from_millis(ms);
        a.update(&[item("a", true)], t);
        // Three lifts: peaks at 1/6, 3/6 and 5/6 of the bounce, at rest between them.
        for peak in [500, 1500, 2500] {
            assert!((a.lift("a", at(peak), false) - 1.).abs() < 1e-9);
        }
        for rest in [0, 1000, 2000] {
            assert!(a.lift("a", at(rest), false) < 1e-9);
        }
        // Told again while still in attention: the same bounce goes on, then ends.
        a.update(&[item("a", true)], at(1200));
        assert!((a.lift("a", at(2500), false) - 1.).abs() < 1e-9);
        assert_eq!(a.lift("a", at(3000), false), 0.);
        assert_eq!(a.lift("a", at(9000), false), 0.);
        // Out and back in: a new edge, a new bounce.
        a.update(&[item("a", false)], at(4000));
        a.update(&[item("a", true)], at(5000));
        assert!((a.lift("a", at(5500), false) - 1.).abs() < 1e-9);
    }

    #[test]
    fn reduced_motion_never_moves_and_the_last_frame_comes_to_rest() {
        let mut a = Attention::default();
        let t = Instant::now();
        a.update(&[item("a", true), item("b", false)], t);
        assert_eq!(a.lift("a", t + Duration::from_millis(500), true), 0.);
        assert!(!a.tick(t, true), "reduced motion: no frames");
        assert_eq!(a.lift("b", t + Duration::from_millis(500), false), 0.);
        assert!(a.tick(t, false));
        assert!(a.tick(t + BOUNCE, false), "one more frame, at rest");
        assert!(!a.tick(t + BOUNCE + FRAME, false));
    }
}
