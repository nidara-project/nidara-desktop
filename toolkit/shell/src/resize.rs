// SPDX-License-Identifier: LGPL-3.0-or-later
//! Resizing the dock (D2, APPLICATIONS1-DOCK.md §9): dragging a separator away from the
//! screen edge or toward it changes the icon-size preference continuously, within
//! Config1's bounds. The dock shows only what Config1 committed: the hub keeps one Apply in
//! flight and the latest value waiting (`Coalesce`), and Escape restores the size the
//! gesture started from through the same checked path. A separator is also the
//! accessible equivalent: a named size adjuster, stepped by keys or set by a reader.
use crate::geometry::Position;

/// Config1's bounds for `dock.iconSize`, and a key's step.
pub const MIN: u32 = 32;
pub const MAX: u32 = 96;
pub const STEP: u32 = 8;

pub fn clamp(v: f64) -> u32 {
    v.round().clamp(MIN as f64, MAX as f64) as u32
}

/// A key's step from the committed size, up or down.
pub fn step(current: u32, up: bool) -> u32 {
    if up {
        (current + STEP).min(MAX)
    } else {
        current.saturating_sub(STEP).max(MIN)
    }
}

/// The pointer's distance from the dock's screen edge, from surface coordinates: the
/// surface keeps its anchored edge where it is as it resizes, so this stays put while the
/// rest of the surface moves under the pointer.
pub fn depth(position: Position, size: (u32, u32), p: (f64, f64)) -> f64 {
    match position {
        Position::Bottom => size.1 as f64 - p.1,
        Position::Left => p.0,
        Position::Right => size.0 as f64 - p.0,
    }
}

/// One drag of a separator: the size follows the pointer one logical pixel for one.
pub struct Drag {
    from: f64,
    start: u32,
    last: u32,
}

impl Drag {
    pub fn new(depth: f64, start: u32) -> Self {
        Drag {
            from: depth,
            start,
            last: start,
        }
    }

    /// The size for the pointer now `depth` from the edge; None while it is unchanged.
    pub fn to(&mut self, depth: f64) -> Option<u32> {
        let v = clamp(self.start as f64 + depth - self.from);
        (v != self.last).then(|| {
            self.last = v;
            v
        })
    }

    /// What the gesture started from: Escape goes back to it.
    pub fn start(&self) -> u32 {
        self.start
    }
}

/// One Config1 Apply of the icon size at a time, and the latest value waiting: a drag
/// sends dozens of values a second, and only the one in flight and the newest matter.
#[derive(Default)]
pub struct Coalesce {
    busy: bool,
    waiting: Option<u32>,
}

impl Coalesce {
    /// A value wanted: Some to send it now, None when it waits behind the one in flight
    /// (replacing whatever waited before it).
    pub fn want(&mut self, v: u32) -> Option<u32> {
        if self.busy {
            self.waiting = Some(v);
            None
        } else {
            self.busy = true;
            Some(v)
        }
    }

    /// The Apply in flight answered (taken or refused): the waiting value goes next.
    pub fn done(&mut self) -> Option<u32> {
        let next = self.waiting.take();
        self.busy = next.is_some();
        next
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_drag_follows_the_pointer_within_bounds() {
        let mut d = Drag::new(30., 64);
        assert_eq!(d.to(30.4), None, "no change, nothing sent");
        assert_eq!(d.to(40.), Some(74));
        assert_eq!(d.to(500.), Some(MAX));
        assert_eq!(d.to(600.), None, "still the maximum");
        assert_eq!(d.to(-500.), Some(MIN));
        assert_eq!(d.start(), 64);
    }

    #[test]
    fn the_depth_is_measured_from_the_screen_edge() {
        assert_eq!(depth(Position::Bottom, (500, 100), (10., 70.)), 30.);
        assert_eq!(depth(Position::Left, (100, 500), (30., 10.)), 30.);
        assert_eq!(depth(Position::Right, (100, 500), (70., 10.)), 30.);
    }

    #[test]
    fn one_apply_in_flight_and_only_the_latest_waits() {
        let mut c = Coalesce::default();
        assert_eq!(c.want(65), Some(65));
        assert_eq!(c.want(66), None);
        assert_eq!(c.want(67), None);
        assert_eq!(c.done(), Some(67), "66 never goes");
        assert_eq!(c.want(68), None, "67 is in flight");
        assert_eq!(c.done(), Some(68));
        assert_eq!(c.done(), None);
        assert_eq!(c.want(69), Some(69), "idle again");
    }

    #[test]
    fn keys_step_within_bounds() {
        assert_eq!(step(64, true), 72);
        assert_eq!(step(92, true), MAX);
        assert_eq!(step(36, false), MIN);
        assert_eq!(clamp(10.), MIN);
    }
}
