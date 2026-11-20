// SPDX-License-Identifier: LGPL-3.0-or-later
//! A panel appearing and going (#764, as the TS shell's `ScaleRevealer`): its glass does not
//! fade, it FORMS — Hyalo grows its blur, refraction, tint and rim from the number each shape
//! carries — over the whole of the motion, and what lies on it (text, icons, what is on) comes by
//! opacity over its second half, so it never floats on glass not yet formed. Going, the other way
//! round: the content goes over the first half, the glass dissolves over the whole.
//!
//! One timing for every panel of the kit: a reveal in a view (`Node::reveal`) forms its panes and
//! fades its content by it, and a surface's panel that is not a view's reveal (the Control
//! Center hanging from the bar) asks an `Appear` how formed and how shown it is.
use std::time::{Duration, Instant};

/// TS's `OVERLAY_POP`: in decelerating, out accelerating.
pub const IN: Duration = Duration::from_millis(220);
pub const OUT: Duration = Duration::from_millis(150);

/// How formed the glass is and how shown its content, for a panel `shown` of the way in (0..1).
pub fn formation(shown: f64) -> (f64, f64) {
    let p = shown.clamp(0., 1.);
    let c = ((p - 0.5) / 0.5).clamp(0., 1.);
    (p, c * c * (3. - 2. * c))
}

/// A panel's appearing and going.
#[derive(Clone, Copy, Debug)]
pub struct Appear {
    open: bool,
    /// When it last turned, and how far shown it was then. None: at rest. Its clock starts at
    /// the first frame drawn after it turned (`frame`), not when it was asked: a panel whose
    /// surface must first grow to hold it would otherwise have spent its motion before it is
    /// ever on screen (measured: the notification centre, 2.4 s on a software compositor).
    since: Option<(Option<Instant>, f64)>,
}

impl Appear {
    pub fn new(open: bool) -> Self {
        Self { open, since: None }
    }
    pub fn open(&self) -> bool {
        self.open
    }
    /// Opens or closes it from where it is now; at once when motion is reduced.
    pub fn set(&mut self, open: bool, now: Instant, reduced: bool) {
        if open == self.open {
            return;
        }
        let from = self.shown(now);
        self.open = open;
        self.since = (!reduced).then_some((None, from));
    }
    /// How far it is shown, 0..1: eased out appearing, eased in going.
    pub fn shown(&self, now: Instant) -> f64 {
        let target = if self.open { 1. } else { 0. };
        let Some((start, from)) = self.since else {
            return target;
        };
        let Some(start) = start else { return from };
        let d = if self.open { IN } else { OUT };
        let t = now.saturating_duration_since(start).as_secs_f64() / d.as_secs_f64().max(1e-3);
        if t >= 1. {
            return target;
        }
        if self.open {
            from + (1. - from) * (1. - (1. - t) * (1. - t))
        } else {
            from * (1. - t * t)
        }
    }
    /// A frame is being drawn: the motion runs from the first one. Its look now.
    pub fn frame(&mut self, now: Instant) -> (f64, f64) {
        if let Some((start @ None, _)) = &mut self.since {
            *start = Some(now);
        }
        self.look(now)
    }
    /// Its glass's formation and its content's opacity now (`formation`).
    pub fn look(&self, now: Instant) -> (f64, f64) {
        formation(self.shown(now))
    }
    /// Still moving: frames are wanted.
    pub fn moving(&self, now: Instant) -> bool {
        let s = self.shown(now);
        if self.open { s < 1. } else { s > 0. }
    }
    /// Drawn: open, or still going.
    pub fn visible(&self, now: Instant) -> bool {
        self.open || self.shown(now) > 0.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_glass_forms_over_the_whole_and_the_content_over_the_second_half() {
        assert_eq!(formation(0.), (0., 0.));
        assert_eq!(formation(0.5), (0.5, 0.));
        assert_eq!(formation(1.), (1., 1.));
        let (g, c) = formation(0.75);
        assert_eq!(g, 0.75);
        assert!(c > 0. && c < 1.);
    }

    #[test]
    fn it_goes_from_where_it_is() {
        let t0 = Instant::now();
        let mut a = Appear::new(false);
        a.set(true, t0, false);
        a.frame(t0);
        let mid = a.shown(t0 + IN / 2);
        assert!(
            mid > 0.5 && mid < 1.,
            "eased out: past half at half time ({mid})"
        );
        a.set(false, t0 + IN / 2, false);
        assert!(
            (a.shown(t0 + IN / 2) - mid).abs() < 1e-9,
            "no jump when it turns"
        );
        a.frame(t0 + IN / 2);
        assert_eq!(a.shown(t0 + IN / 2 + OUT), 0.);
        assert!(!a.visible(t0 + IN / 2 + OUT));
    }

    #[test]
    fn its_clock_starts_at_its_first_frame() {
        let t0 = Instant::now();
        let mut a = Appear::new(false);
        a.set(true, t0, false);
        let late = t0 + Duration::from_secs(2);
        assert_eq!(a.shown(late), 0., "nothing drawn yet: still where it was");
        assert!(a.moving(late), "and frames are wanted");
        assert_eq!(a.frame(late), (0., 0.));
        assert!(a.shown(late + IN / 2) > 0.5);
        assert_eq!(a.shown(late + IN), 1.);
    }
}
