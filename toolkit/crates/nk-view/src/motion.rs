// SPDX-License-Identifier: LGPL-3.0-or-later
//! The motion state (VIEW.md §6, §7): each reveal's progress, eased by the kit's motion
//! tokens, the slides of panes a rebuilt view moved, and the cards being swiped away.
use crate::layout::{Placed, Rect, What};
use crate::tokens::{Bezier, Motion};
use crate::view::{Key, Kind, Node};
use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Clone, Copy, Debug)]
struct Ease {
    from: f64,
    to: f64,
    start: Instant,
    duration: Duration,
    curve: Bezier,
}
impl Ease {
    /// The value at `now`, and whether it has arrived.
    fn at(&self, now: Instant) -> (f64, bool) {
        let t = if self.duration.is_zero() {
            1.
        } else {
            now.saturating_duration_since(self.start).as_secs_f64() / self.duration.as_secs_f64()
        };
        if t >= 1. {
            return (self.to, true);
        }
        (self.from + (self.to - self.from) * self.curve.at(t), false)
    }
}

struct RevealState {
    open: bool,
    ease: Option<Ease>,
}

/// The swipe's feel, as the TS shell had it (`ui/shell/common/ScaleRevealer.ts`): logical px a
/// press must travel, more across than down, to become a swipe; how far a release must have
/// gone to dismiss; the free travel before the drag resists, and how much of the rest shows;
/// and the distance over which the content fades, never below the floor.
pub(crate) const SWIPE_CLAIM: f64 = 8.;
pub(crate) const SWIPE_DISMISS: f64 = 90.;
const SWIPE_FREE: f64 = 140.;
const SWIPE_RESIST: f64 = 0.15;
const SWIPE_FADE: f64 = 320.;
const SWIPE_FLOOR: f64 = 0.15;

fn rubber(dx: f64) -> f64 {
    let a = dx.abs();
    if a <= SWIPE_FREE {
        dx
    } else {
        dx.signum() * (SWIPE_FREE + (a - SWIPE_FREE) * SWIPE_RESIST)
    }
}
fn fade(dx: f64) -> f64 {
    (1. - dx.abs() / SWIPE_FADE).max(SWIPE_FLOOR)
}

enum Swipe {
    /// Following the pointer, at this drawn offset.
    Follow(f64),
    /// Released: settling back, or flung off the surface (`away`), then reporting `out`.
    Ease {
        ease: Ease,
        away: bool,
        out: Option<String>,
    },
    /// Flung and reported; hidden until the surface drops it from the view.
    Gone,
}

/// A pane drawn `offset` away from its place at `start`, easing to it.
struct Slide {
    offset: (f64, f64),
    start: Instant,
}

#[derive(Default)]
pub(crate) struct MotionState {
    reveals: HashMap<Key, RevealState>,
    slides: HashMap<Key, Slide>,
    swipes: HashMap<Key, Swipe>,
    pub reduced: bool,
}

/// Each reveal's, switch's and mark's key and state; `true` last for a switch or a mark, which
/// eases the same both ways (VIEW.md §12.6).
fn walk<'a>(n: &'a Node, out: &mut Vec<(&'a Key, bool, bool)>) {
    match &n.kind {
        Kind::Switch(sw) => out.push((&n.key, sw.on, true)),
        Kind::Check(c) => out.push((&n.key, c.on, true)),
        Kind::Reveal(r) => {
            out.push((&n.key, r.open, false));
            walk(&r.child, out);
        }
        Kind::Stack(s) => s.children.iter().for_each(|c| walk(c, out)),
        Kind::Pane(p) => walk(&p.child, out),
        Kind::Group(g) => walk(&g.child, out),
        Kind::Control(c) => walk(&c.child, out),
        Kind::Scroll(sc) => walk(&sc.child, out),
        Kind::Overlay(o) => {
            walk(&o.base, out);
            o.layers.iter().for_each(|l| walk(&l.child, out));
        }
        Kind::Grid(g) => g.cells.iter().for_each(|c| walk(&c.child, out)),
        _ => {}
    }
}

impl MotionState {
    /// A rebuilt view: a reveal or switch seen for the first time takes its state at once; one
    /// whose state changed eases from where it is. Those gone are forgotten.
    pub fn view(&mut self, view: &Node, now: Instant, m: &Motion) {
        let mut seen = vec![];
        walk(view, &mut seen);
        let mut next = HashMap::new();
        for (key, open, switch) in seen {
            let state = match self.reveals.remove(key) {
                Some(s) if s.open != open => {
                    let from = s.ease.map_or(if s.open { 1. } else { 0. }, |e| e.at(now).0);
                    let (duration, curve) = if switch || !open {
                        (m.base, m.ease)
                    } else {
                        (m.slow, m.emphasized)
                    };
                    RevealState {
                        open,
                        ease: (!self.reduced).then_some(Ease {
                            from,
                            to: if open { 1. } else { 0. },
                            start: now,
                            duration,
                            curve,
                        }),
                    }
                }
                Some(s) => s,
                None => RevealState { open, ease: None },
            };
            next.insert(key.clone(), state);
        }
        self.reveals = next;
    }

    /// Each reveal's progress at `now`; finished eases are dropped.
    pub fn progress(&mut self, now: Instant) -> HashMap<Key, f64> {
        self.reveals
            .iter_mut()
            .map(|(k, s)| {
                let p = match s.ease {
                    Some(e) => {
                        let (v, done) = e.at(now);
                        if done {
                            s.ease = None;
                        }
                        v
                    }
                    None => {
                        if s.open {
                            1.
                        } else {
                            0.
                        }
                    }
                };
                (k.clone(), p)
            })
            .collect()
    }

    /// Panes that were drawn somewhere else before this rebuild start a slide from there.
    pub fn moved(&mut self, before: &HashMap<Key, Rect>, after: &[Placed], now: Instant) {
        if self.reduced {
            self.slides.clear();
            return;
        }
        for p in after.iter().filter(|p| matches!(p.what, What::Pane(_))) {
            if let Some(old) = before.get(&p.key) {
                let offset = (old[0] - p.rect[0], old[1] - p.rect[1]);
                if offset.0.abs() >= 0.5 || offset.1.abs() >= 0.5 {
                    self.slides
                        .insert(p.key.clone(), Slide { offset, start: now });
                }
            }
        }
        self.slides.retain(|k, _| after.iter().any(|p| &p.key == k));
    }

    /// Moves each sliding pane and what lies in it by what is left of its offset, snapped to
    /// the device grid. Returns whether any still slides.
    pub fn slide(&mut self, placed: &mut [Placed], now: Instant, m: &Motion, scale: f64) -> bool {
        let snap = |v: f64| (v * scale).round() / scale;
        self.slides
            .retain(|_, s| now.saturating_duration_since(s.start) < m.base);
        for (key, s) in &self.slides {
            let Some(pane) = placed.iter().position(|p| &p.key == key) else {
                continue;
            };
            let t = now.saturating_duration_since(s.start).as_secs_f64() / m.base.as_secs_f64();
            let left = 1. - m.ease.at(t);
            let (dx, dy) = (s.offset.0 * left, s.offset.1 * left);
            let pane_clip = placed[pane].clip;
            for i in pane..placed.len() {
                let inside = i == pane
                    || std::iter::successors(placed[i].parent, |&q| placed[q].parent)
                        .any(|q| q == pane);
                if !inside {
                    continue;
                }
                let r = placed[i].rect;
                let (x, y) = (snap(r[0] + dx), snap(r[1] + dy));
                placed[i].rect = [x, y, r[2], r[3]];
                // A clip from a reveal inside the pane moves with it; one from outside stays.
                if let Some(c) = placed[i].clip
                    && placed[i].clip != pane_clip
                {
                    placed[i].clip = Some([snap(c[0] + dx), snap(c[1] + dy), c[2], c[3]]);
                }
            }
        }
        !self.slides.is_empty()
    }

    pub fn animating(&self) -> bool {
        !self.slides.is_empty()
            || self.reveals.values().any(|s| s.ease.is_some())
            || self
                .swipes
                .values()
                .any(|s| matches!(s, Swipe::Ease { .. }))
    }

    /// The swiped control follows the pointer, `dx` from where the press began.
    pub fn swipe_follow(&mut self, key: &Key, dx: f64) {
        self.swipes.insert(key.clone(), Swipe::Follow(rubber(dx)));
    }

    /// The press ended `dx` from where it began, or was lost (`dx` 0). Past the threshold the
    /// control is flung off a surface `width` wide, and `action` is reported when it is gone:
    /// at once with reduced motion, which this returns; otherwise from `finished`.
    pub fn swipe_release(
        &mut self,
        key: &Key,
        dx: f64,
        width: f64,
        action: String,
        now: Instant,
        m: &Motion,
    ) -> Option<String> {
        let from = match self.swipes.get(key) {
            Some(Swipe::Follow(d)) => *d,
            _ => return None,
        };
        let fling = dx.abs() >= SWIPE_DISMISS;
        if self.reduced {
            return if fling {
                self.swipes.insert(key.clone(), Swipe::Gone);
                Some(action)
            } else {
                self.swipes.remove(key);
                None
            };
        }
        let to = if fling { dx.signum() * width } else { 0. };
        let ease = Ease {
            from,
            to,
            start: now,
            duration: m.base,
            curve: m.emphasized,
        };
        let out = fling.then_some(action);
        self.swipes.insert(
            key.clone(),
            Swipe::Ease {
                ease,
                away: fling,
                out,
            },
        );
        None
    }

    /// Flings `keys` off a surface `width` wide, one after another `stagger` apart, as if
    /// each had been swiped: the last reports `action` when it is gone. With reduced motion
    /// they go at once and this returns the action.
    pub fn cascade(
        &mut self,
        keys: &[Key],
        stagger: Duration,
        width: f64,
        action: String,
        now: Instant,
        m: &Motion,
    ) -> Option<String> {
        if self.reduced || keys.is_empty() {
            for k in keys {
                self.swipes.insert(k.clone(), Swipe::Gone);
            }
            return Some(action);
        }
        for (i, k) in keys.iter().enumerate() {
            let last = i + 1 == keys.len();
            let ease = Ease {
                from: 0.,
                to: width,
                start: now + stagger * i as u32,
                duration: m.base,
                curve: m.emphasized,
            };
            self.swipes.insert(
                k.clone(),
                Swipe::Ease {
                    ease,
                    away: true,
                    out: last.then(|| action.clone()),
                },
            );
        }
        None
    }

    /// The flings that arrived by `now`, and what each reports; settles that arrived end.
    pub fn finished(&mut self, now: Instant) -> Vec<(Key, String)> {
        let mut out = vec![];
        self.swipes.retain(|k, s| {
            let Swipe::Ease {
                ease,
                away,
                out: report,
            } = s
            else {
                return true;
            };
            if !ease.at(now).1 {
                return true;
            }
            if let Some(action) = report.take() {
                out.push((k.clone(), action));
            }
            let away = *away;
            if away {
                *s = Swipe::Gone;
            }
            away
        });
        out
    }

    /// Moves each swiped control's card (its nearest pane, or itself outside one) and all it
    /// holds by the swipe's offset, fading its content. Clips from outside the card stop
    /// cutting it across, so it can leave its list. Swipes whose control left are dropped.
    pub fn swipe(&mut self, placed: &mut [Placed], now: Instant, width: f64, scale: f64) {
        let snap = |v: f64| (v * scale).round() / scale;
        self.swipes
            .retain(|k, _| placed.iter().any(|p| &p.key == k));
        for (key, s) in &self.swipes {
            let Some(c) = placed.iter().position(|p| &p.key == key) else {
                continue;
            };
            let (dx, alpha) = match s {
                Swipe::Follow(d) => (*d, fade(*d)),
                Swipe::Ease { ease, away, .. } => {
                    let v = ease.at(now).0;
                    let gone = if *away && ease.to != ease.from {
                        (v - ease.from) / (ease.to - ease.from)
                    } else {
                        0.
                    };
                    (v, fade(v) * (1. - gone))
                }
                Swipe::Gone => (0., 0.),
            };
            let card = placed[c].pane.unwrap_or(c);
            let outside = placed[card].clip;
            for i in card..placed.len() {
                let inside = i == card
                    || std::iter::successors(placed[i].parent, |&q| placed[q].parent)
                        .any(|q| q == card);
                if !inside {
                    continue;
                }
                let r = placed[i].rect;
                placed[i].rect = [snap(r[0] + dx), r[1], r[2], r[3]];
                placed[i].alpha *= alpha;
                placed[i].clip = match placed[i].clip {
                    Some(c) if Some(c) == outside => Some([0., c[1], width, c[3]]),
                    Some(c) => Some([snap(c[0] + dx), c[1], c[2], c[3]]),
                    None => None,
                };
            }
        }
    }
}
