// SPDX-License-Identifier: LGPL-3.0-or-later
//! Opaque fallback wash timeline, sampled once for the retained painter.
use crate::*;
use std::time::Duration;
#[derive(Clone, Copy)]
struct Wash {
    from: [f64; 4],
    to: [f64; 4],
    start: Duration,
    ms: u32,
}
impl Wash {
    fn sample(self, now: Duration) -> ([f64; 4], bool) {
        let t = if self.ms == 0 {
            1.
        } else {
            (now.saturating_sub(self.start).as_secs_f64() * 1000. / self.ms as f64).clamp(0., 1.)
        };
        (
            std::array::from_fn(|i| self.from[i] + (self.to[i] - self.from[i]) * t),
            t >= 1.,
        )
    }
}
#[derive(Default)]
pub(crate) struct Fallback {
    washes: BTreeMap<NodeId, Wash>,
    pub active: bool,
}
impl Fallback {
    pub fn update(&mut self, tree: &mut Tree, now: Duration, reduced: bool, enabled: bool) -> bool {
        let mut targets = BTreeMap::new();
        if enabled {
            for id in tree.capsule_ids().filter(|id| !tree.is_hidden(*id)) {
                if let Some(style) = tree.capsule_styles.get(&id) {
                    for button in &tree.nodes[&id].children {
                        if !tree.is_hidden(*button) {
                            targets.insert(
                                *button,
                                (
                                    tree.capsule_state(*button, style)
                                        .map_or([0.; 4], |s| s.wash),
                                    style.fade_ms(reduced),
                                ),
                            );
                        }
                    }
                }
            }
        }
        self.washes.retain(|id, _| targets.contains_key(id));
        self.active = false;
        let mut shown = BTreeMap::new();
        for (id, (to, ms)) in targets {
            let wash = self.washes.entry(id).or_insert(Wash {
                from: to,
                to,
                start: now,
                ms: 0,
            });
            // First appearance is immediate, like Hyalo's Presenting::committed.
            // Retarget from the current sample; reduced motion also ends an in-flight fade.
            if reduced || wash.to != to {
                *wash = Wash {
                    from: wash.sample(now).0,
                    to,
                    start: now,
                    ms,
                };
            }
            let (value, settled) = wash.sample(now);
            shown.insert(id, value);
            self.active |= !settled;
        }
        if tree.capsule_washes != shown {
            tree.capsule_washes = shown;
            tree.invalidate(tree.root(), Invalid::PAINT);
            true
        } else {
            false
        }
    }
}
