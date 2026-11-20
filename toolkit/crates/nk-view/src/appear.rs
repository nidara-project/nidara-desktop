// SPDX-License-Identifier: LGPL-3.0-or-later
//! A panel appearing and going (#764), as the TS shell's `ScaleRevealer` did it: its glass does
//! not fade, it FORMS — Hyalo grows its blur, refraction, tint and rim from the number each
//! shape carries — over the whole motion, while the panel grows from a little smaller about the
//! point it hangs from; what lies on it (text, icons, what is on) comes by opacity over the
//! second half of the TIME, so for the first half the glass is seen forming alone, its bend
//! growing, and text never floats on glass not yet formed. Going, the other way round: the
//! content goes over the first half of the time, the glass dissolves over the whole.
//!
//! One component for every panel the kit draws on a surface of its own making (the Control
//! Center and the Notification Center hanging from the bar): `Appear` keeps the clock, `Look`
//! is where the motion is, and applies it to what the panel paints (`Canvas::push_zoom` and
//! `push_opacity`) and to the glass it declares (`Look::material`), so both move as one. A
//! reveal inside a view (`Node::reveal`, an unrolling clip) forms its panes by `formation`.
use nk_wayland::{Group, MaterialRect, Pane, StateRegion, Veil};
use std::time::{Duration, Instant};

/// How a panel appears: its durations and how much smaller it starts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Style {
    /// Its scale when it starts appearing (and when it has gone), about its pivot.
    pub scale_from: f64,
    pub duration_in: Duration,
    pub duration_out: Duration,
}

impl Style {
    /// The big panels (TS's `OVERLAY_POP`): a subtle grow, decelerating in and accelerating
    /// out, the leaving faster than the coming.
    pub const POP: Style = Style {
        scale_from: 0.97,
        duration_in: Duration::from_millis(220),
        duration_out: Duration::from_millis(150),
    };
}

/// Where a panel is in its motion.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Look {
    /// How formed its glass is, 0..1: the opacity its panes are declared with.
    pub formed: f64,
    /// Its content's opacity, 0..1.
    pub content: f64,
    /// Its scale about its pivot.
    pub scale: f64,
}

impl Look {
    pub const SHOWN: Look = Look {
        formed: 1.,
        content: 1.,
        scale: 1.,
    };

    /// A point of the panel at rest, where it is drawn now.
    pub fn place(&self, pivot: (f64, f64), p: (f64, f64)) -> (f64, f64) {
        (
            pivot.0 + (p.0 - pivot.0) * self.scale,
            pivot.1 + (p.1 - pivot.1) * self.scale,
        )
    }

    fn rect(&self, pivot: (f64, f64), r: MaterialRect) -> MaterialRect {
        let (x, y) = self.place(pivot, (r.x, r.y));
        MaterialRect {
            x,
            y,
            width: r.width * self.scale,
            height: r.height * self.scale,
        }
    }

    fn pane(&self, pivot: (f64, f64), p: &mut Pane) {
        let (x, y) = self.place(pivot, (p.x, p.y));
        let k = self.scale;
        p.x = x;
        p.y = y;
        p.width *= k;
        p.height *= k;
        p.radius *= k;
        if let Some(q) = &mut p.pointer {
            q.base = (q.base.0 * k, q.base.1 * k);
            q.tip = (q.tip.0 * k, q.tip.1 * k);
            q.width *= k;
            q.tip_radius *= k;
            q.base_radius *= k;
        }
    }

    /// The glass a panel declares, as it is now: its panes scaled about `pivot` and formed,
    /// the veils under it as formed, and the washes on it (what is on, a hover) with its
    /// content, since they belong to what lies on the glass.
    pub fn material(
        &self,
        pivot: (f64, f64),
        groups: &mut [Group],
        states: &mut [StateRegion],
        veils: &mut [Veil],
    ) {
        if *self == Look::SHOWN {
            return;
        }
        for g in groups {
            g.opacity *= self.formed;
            g.clip = g.clip.map(|c| self.rect(pivot, c));
            for p in &mut g.shapes {
                self.pane(pivot, p);
            }
        }
        for s in states {
            s.bounds = self.rect(pivot, s.bounds);
            s.radius *= self.scale;
            s.wash[3] *= self.content;
            // Hyalo eases a wash over its `fade_ms` toward each new value: the motion sets it
            // every frame, so an ease would leave it behind the content (measured: the Control
            // Center's on discs still white on empty glass, its closing is that 150 ms long).
            s.fade_ms = 0;
        }
        for v in veils {
            let r = self.rect(
                pivot,
                MaterialRect {
                    x: v.x,
                    y: v.y,
                    width: v.width,
                    height: v.height,
                },
            );
            (v.x, v.y, v.width, v.height) = (r.x, r.y, r.width, r.height);
            v.falloff *= self.scale;
            v.strength *= self.formed;
        }
    }
}

/// For a reveal inside a view `shown` of the way in (0..1): how formed its glass is and how
/// shown its content, the content over the second half.
pub fn formation(shown: f64) -> (f64, f64) {
    let p = shown.clamp(0., 1.);
    (p, smooth((p - 0.5) / 0.5))
}

fn smooth(x: f64) -> f64 {
    let c = x.clamp(0., 1.);
    c * c * (3. - 2. * c)
}

#[derive(Clone, Copy, Debug)]
struct Run {
    /// None until its first frame is drawn (`Appear::frame`).
    start: Option<Instant>,
    /// Where it was when it turned: its progress and its content.
    from: f64,
    from_content: f64,
}

/// A panel's appearing and going.
#[derive(Clone, Copy, Debug)]
pub struct Appear {
    style: Style,
    open: bool,
    run: Option<Run>,
}

impl Appear {
    pub fn new(style: Style, open: bool) -> Self {
        Self {
            style,
            open,
            run: None,
        }
    }
    pub fn open(&self) -> bool {
        self.open
    }
    /// Opens or closes it from where it is now; at once when motion is reduced.
    pub fn set(&mut self, open: bool, now: Instant, reduced: bool) {
        if open == self.open {
            return;
        }
        let (from, from_content) = (self.progress(now), self.content(now));
        self.open = open;
        self.run = (!reduced).then_some(Run {
            start: None,
            from,
            from_content,
        });
    }
    /// How far through its time it is, 0..1; None at rest, Some(0) until its first frame. Its
    /// clock starts at the first frame drawn after it turned, not when it was asked: a panel
    /// whose surface must first grow to hold it would otherwise have spent its motion before
    /// it is ever on screen (measured: the notification centre, 2.4 s on a software compositor).
    fn time(&self, now: Instant) -> Option<(f64, Run)> {
        let run = self.run?;
        let Some(start) = run.start else {
            return Some((0., run));
        };
        let d = if self.open {
            self.style.duration_in
        } else {
            self.style.duration_out
        };
        let t = now.saturating_duration_since(start).as_secs_f64() / d.as_secs_f64().max(1e-3);
        (t < 1.).then_some((t, run))
    }
    fn target(&self) -> f64 {
        if self.open { 1. } else { 0. }
    }
    /// Its progress, 0..1: cubic, decelerating in and accelerating out.
    fn progress(&self, now: Instant) -> f64 {
        let Some((t, run)) = self.time(now) else {
            return self.target();
        };
        let eased = if self.open {
            1. - (1. - t).powi(3)
        } else {
            t.powi(3)
        };
        run.from + (self.target() - run.from) * eased
    }
    /// Its content's opacity: in over the second half of the time, out over the first.
    fn content(&self, now: Instant) -> f64 {
        let Some((t, run)) = self.time(now) else {
            return self.target();
        };
        let c = run.from_content;
        if self.open {
            c + (1. - c) * smooth((t - 0.5) / 0.5)
        } else {
            c * (1. - smooth(t / 0.5))
        }
    }
    /// A frame is being drawn: the motion runs from the first one. Its look now.
    pub fn frame(&mut self, now: Instant) -> Look {
        if let Some(run @ Run { start: None, .. }) = &mut self.run {
            run.start = Some(now);
        }
        self.look(now)
    }
    /// Where it is now.
    pub fn look(&self, now: Instant) -> Look {
        let p = self.progress(now);
        Look {
            formed: p,
            content: self.content(now),
            scale: self.style.scale_from + (1. - self.style.scale_from) * p,
        }
    }
    /// Still moving: frames are wanted.
    pub fn moving(&self, now: Instant) -> bool {
        self.time(now).is_some()
    }
    /// Drawn: open, or still going.
    pub fn visible(&self, now: Instant) -> bool {
        self.open || self.moving(now)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use nk_wayland::{Shadow, Tone};

    const IN: Duration = Style::POP.duration_in;
    const OUT: Duration = Style::POP.duration_out;

    fn opened(t0: Instant) -> Appear {
        let mut a = Appear::new(Style::POP, false);
        a.set(true, t0, false);
        a.frame(t0);
        a
    }

    #[test]
    fn a_reveal_in_a_view_forms_over_the_whole_and_shows_over_the_second_half() {
        assert_eq!(formation(0.), (0., 0.));
        assert_eq!(formation(0.5), (0.5, 0.));
        assert_eq!(formation(1.), (1., 1.));
        let (g, c) = formation(0.75);
        assert_eq!(g, 0.75);
        assert!(c > 0. && c < 1.);
    }

    #[test]
    fn the_glass_forms_alone_for_the_first_half_of_the_time() {
        let t0 = Instant::now();
        let a = opened(t0);
        let half = a.look(t0 + IN / 2);
        assert_eq!(half.content, 0., "no content before half the time");
        assert!(
            half.formed > 0.8,
            "the glass far on: eased out ({})",
            half.formed
        );
        assert!(half.scale > 0.97 && half.scale < 1.);
        let late = a.look(t0 + IN * 3 / 4);
        assert!(late.content > 0. && late.content < 1.);
        assert_eq!(a.look(t0 + IN), Look::SHOWN);
        assert!(!a.moving(t0 + IN));
    }

    #[test]
    fn going_the_content_leaves_first() {
        let t0 = Instant::now();
        let mut a = Appear::new(Style::POP, true);
        a.set(false, t0, false);
        a.frame(t0);
        let half = a.look(t0 + OUT / 2);
        assert_eq!(half.content, 0., "the content gone at half the time");
        assert!(
            half.formed > 0.8,
            "the glass still there: eased in ({})",
            half.formed
        );
        assert!(a.visible(t0 + OUT / 2));
        assert!(!a.visible(t0 + OUT));
        assert_eq!(a.look(t0 + OUT).formed, 0.);
        assert_eq!(a.look(t0 + OUT).scale, Style::POP.scale_from);
    }

    #[test]
    fn it_turns_from_where_it_is() {
        let t0 = Instant::now();
        let mut a = opened(t0);
        let at = t0 + IN * 3 / 4;
        let before = a.look(at);
        a.set(false, at, false);
        assert_eq!(a.look(at), before, "no jump when it turns");
        a.frame(at);
        assert_eq!(a.look(at + OUT).formed, 0.);
    }

    #[test]
    fn its_clock_starts_at_its_first_frame() {
        let t0 = Instant::now();
        let mut a = Appear::new(Style::POP, false);
        a.set(true, t0, false);
        let late = t0 + Duration::from_secs(2);
        assert_eq!(
            a.look(late).formed,
            0.,
            "nothing drawn yet: still where it was"
        );
        assert!(a.moving(late), "and frames are wanted");
        assert_eq!(a.frame(late).formed, 0.);
        assert!(a.look(late + IN / 2).formed > 0.5);
        assert_eq!(a.look(late + IN), Look::SHOWN);
    }

    #[test]
    fn reduced_motion_lands_at_once() {
        let t0 = Instant::now();
        let mut a = Appear::new(Style::POP, false);
        a.set(true, t0, true);
        assert_eq!(a.look(t0), Look::SHOWN);
        assert!(!a.moving(t0));
    }

    #[test]
    fn its_glass_is_scaled_about_the_pivot_and_its_washes_go_with_the_content() {
        let look = Look {
            formed: 0.5,
            content: 0.25,
            scale: 0.5,
        };
        let pivot = (100., 0.);
        let pane = Pane {
            x: 60.,
            y: 10.,
            width: 40.,
            height: 20.,
            radius: 8.,
            exponent: 2.,
            pointer: None,
        };
        let mut groups = vec![Group {
            clip: None,
            opacity: 1.,
            tone: Tone {
                saturation: 1.,
                ceiling: 1.,
                lift: 0.,
                gain: 1.,
                wash: [0.; 4],
                ambient: 0.,
                ambient_lift: 0.,
                ambient_gain: 0.,
            },
            shadow: Shadow {
                opacity_small: 0.,
                opacity_large: 0.,
                blur_small: 0.,
                blur_large: 0.,
                offset: 0.,
            },
            shapes: vec![pane],
        }];
        let mut states = vec![StateRegion {
            id: 1,
            bounds: MaterialRect {
                x: 60.,
                y: 10.,
                width: 40.,
                height: 20.,
            },
            radius: 8.,
            wash: [1., 1., 1., 0.8],
            fade_ms: 150,
        }];
        look.material(pivot, &mut groups, &mut states, &mut []);
        let p = groups[0].shapes[0];
        assert_eq!(
            (p.x, p.y, p.width, p.height, p.radius),
            (80., 5., 20., 10., 4.)
        );
        assert_eq!(groups[0].opacity, 0.5);
        assert_eq!(states[0].bounds.x, 80.);
        assert_eq!(states[0].wash[3], 0.2);
        assert_eq!(
            states[0].fade_ms, 0,
            "a wash follows the motion frame by frame"
        );
    }
}
