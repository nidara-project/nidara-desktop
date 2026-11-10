// SPDX-License-Identifier: LGPL-3.0-or-later
//! The motion state (VIEW.md §6): each reveal's progress, eased by the kit's motion tokens,
//! and the slides of panes a rebuilt view moved.
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

/// A pane drawn `offset` away from its place at `start`, easing to it.
struct Slide {
    offset: (f64, f64),
    start: Instant,
}

#[derive(Default)]
pub(crate) struct MotionState {
    reveals: HashMap<Key, RevealState>,
    slides: HashMap<Key, Slide>,
    pub reduced: bool,
}

fn walk<'a>(n: &'a Node, out: &mut Vec<(&'a Key, bool)>) {
    match &n.kind {
        Kind::Reveal(r) => {
            out.push((&n.key, r.open));
            walk(&r.child, out);
        }
        Kind::Stack(s) => s.children.iter().for_each(|c| walk(c, out)),
        Kind::Pane(p) => walk(&p.child, out),
        Kind::Control(c) => walk(&c.child, out),
        _ => {}
    }
}

impl MotionState {
    /// A rebuilt view: a reveal seen for the first time takes its state at once; one whose
    /// `open` changed eases from where it is. Reveals gone are forgotten.
    pub fn view(&mut self, view: &Node, now: Instant, m: &Motion) {
        let mut seen = vec![];
        walk(view, &mut seen);
        let mut next = HashMap::new();
        for (key, open) in seen {
            let state = match self.reveals.remove(key) {
                Some(s) if s.open != open => {
                    let from = s.ease.map_or(if s.open { 1. } else { 0. }, |e| e.at(now).0);
                    let (duration, curve) = if open {
                        (m.slow, m.emphasized)
                    } else {
                        (m.base, m.ease)
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
        !self.slides.is_empty() || self.reveals.values().any(|s| s.ease.is_some())
    }
}
