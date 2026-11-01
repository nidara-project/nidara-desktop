// SPDX-License-Identifier: LGPL-3.0-or-later
//! The wheel over an app (APPLICATIONS1-DOCK.md §8): it walks the app's visible windows in
//! a stable most-recent-first order, one step per notch. The order is taken when a walk
//! starts and kept while it lasts, so focusing a window does not reshuffle what the next
//! notch reaches. High-resolution wheels add up to a notch; a step at most every
//! `MIN_STEP`. It never launches or closes anything. Pure: the dock asks Hyalo to focus.
use crate::model::{Item, Kind};
use std::time::{Duration, Instant};

/// One wheel notch, in wl_pointer axis units.
pub const NOTCH: f64 = 10.;
pub const MIN_STEP: Duration = Duration::from_millis(120);
/// A pause this long ends a walk: the next notch starts from the focused window again.
pub const IDLE: Duration = Duration::from_millis(1200);

#[derive(Default)]
pub struct Cycle {
    key: Option<String>,
    order: Vec<u64>,
    /// Where the walk is in `order`; None before its first step.
    at: Option<usize>,
    acc: f64,
    last: Option<Instant>,
    stepped: Option<Instant>,
}

impl Cycle {
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// One scroll event of `delta` over `item`: the window to focus, if a step was made.
    pub fn scroll(
        &mut self,
        item: &Item,
        focused: Option<u64>,
        delta: f64,
        now: Instant,
    ) -> Option<u64> {
        if !matches!(item.kind, Kind::App { .. } | Kind::Unknown { .. }) || item.windows.is_empty()
        {
            self.reset();
            return None;
        }
        let idle = self.last.is_none_or(|t| now.duration_since(t) >= IDLE);
        if self.key.as_deref() != Some(item.key.as_str()) || idle {
            *self = Self {
                key: Some(item.key.clone()),
                order: item.windows.clone(),
                at: focused.and_then(|f| item.windows.iter().position(|w| *w == f)),
                ..Self::default()
            };
        }
        self.last = Some(now);
        // A window that went away leaves the walk; one that came stays out until the next.
        // If the one it is at closed, the walk goes on to the one after it.
        let before = self.at.map(|n| (n, self.order[n]));
        self.order.retain(|w| item.windows.contains(w));
        self.at = before.and_then(|(n, b)| {
            self.order
                .iter()
                .position(|w| *w == b)
                .or_else(|| n.checked_sub(1))
        });
        if self.order.is_empty() {
            return None;
        }
        self.acc = (self.acc + delta).clamp(-NOTCH, NOTCH);
        if self.acc.abs() < NOTCH
            || self
                .stepped
                .is_some_and(|t| now.duration_since(t) < MIN_STEP)
        {
            return None;
        }
        let forward = self.acc > 0.;
        self.acc = 0.;
        self.stepped = Some(now);
        let n = self.order.len();
        let next = match (self.at, forward) {
            (Some(at), true) => (at + 1) % n,
            (Some(at), false) => (at + n - 1) % n,
            (None, true) => 0,
            (None, false) => n - 1,
        };
        self.at = Some(next);
        Some(self.order[next])
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app(windows: &[u64]) -> Item {
        Item {
            key: "app:a.desktop".into(),
            kind: Kind::App {
                id: "a.desktop".into(),
                generation: 1,
                launchable: true,
                pinned: true,
            },
            label: "A".into(),
            windows: windows.to_vec(),
            minimized: vec![9],
            signal: Default::default(),
        }
    }

    #[test]
    fn notches_walk_a_stable_order_and_wrap() {
        let mut c = Cycle::default();
        let t = Instant::now();
        let ms = |n| t + Duration::from_millis(n);
        // Focused is the most recent (5): the next notch reaches 4, then 3, then wraps.
        assert_eq!(c.scroll(&app(&[5, 4, 3]), Some(5), 10., t), Some(4));
        // Hyalo now lists 4 first; the walk keeps its own order.
        assert_eq!(c.scroll(&app(&[4, 5, 3]), Some(4), 10., ms(200)), Some(3));
        assert_eq!(c.scroll(&app(&[3, 4, 5]), Some(3), 10., ms(400)), Some(5));
        // Back up.
        assert_eq!(c.scroll(&app(&[5, 3, 4]), Some(5), -10., ms(600)), Some(3));
    }

    #[test]
    fn small_deltas_add_up_and_fast_wheels_are_bounded() {
        let mut c = Cycle::default();
        let t = Instant::now();
        let ms = |n| t + Duration::from_millis(n);
        assert_eq!(c.scroll(&app(&[5, 4]), Some(5), 4., t), None);
        assert_eq!(c.scroll(&app(&[5, 4]), Some(5), 4., ms(10)), None);
        assert_eq!(c.scroll(&app(&[5, 4]), Some(5), 4., ms(20)), Some(4));
        // A burst within MIN_STEP does not step again, nor bank steps for later.
        assert_eq!(c.scroll(&app(&[4, 5]), Some(4), 40., ms(30)), None);
        assert_eq!(c.scroll(&app(&[4, 5]), Some(4), 40., ms(60)), None);
        assert_eq!(c.scroll(&app(&[4, 5]), Some(4), 10., ms(200)), Some(5));
    }

    #[test]
    fn a_pause_restarts_from_the_focused_window_and_nothing_launches() {
        let mut c = Cycle::default();
        let t = Instant::now();
        assert_eq!(c.scroll(&app(&[5, 4, 3]), Some(5), 10., t), Some(4));
        let later = t + IDLE + Duration::from_millis(1);
        assert_eq!(c.scroll(&app(&[4, 5, 3]), Some(4), 10., later), Some(5));
        // Only minimized windows, or none: no step, no launch.
        assert_eq!(c.scroll(&app(&[]), None, 10., later), None);
        // A window that closed leaves the walk.
        let mut c = Cycle::default();
        assert_eq!(c.scroll(&app(&[5, 4, 3]), Some(5), 10., t), Some(4));
        assert_eq!(
            c.scroll(&app(&[5, 3]), Some(5), 10., t + Duration::from_millis(200)),
            Some(3),
            "4 closed while the walk was on it: the next notch reaches the one after it"
        );
    }
}
