// SPDX-License-Identifier: LGPL-3.0-or-later
//! Reordering the pinned section (D3, APPLICATIONS1-DOCK.md §9). A long press on a pin
//! picks it up; while the button is held it follows the pointer and the other pins make
//! room where it would land. Released on the strip, it moves there (EditLayout `move`,
//! before the pin that now follows it); released far enough from the strip, away from the
//! screen edge, it is unpinned (`remove`): a running app keeps its windows and its slot.
//! Pointer movement alone never launches anything, and another button or Escape puts it
//! back with no edit. Only pins move: Trash, separators, running and minimized slots do
//! not. The preview is local until the drop, and after it the strip keeps the dropped
//! order until the service's view has it (`hold`), so nothing jumps back meanwhile.
//!
//! A running app that is not pinned can be picked up too: over the pinned section it
//! makes room there and a drop pins it at that place (`insert-app` before the pin that
//! follows it); anywhere else it goes back to its slot. Dropped on the Trash, a pin is
//! unpinned as if dropped off the strip.
use crate::model::{Kind, View};
use std::time::Duration;

/// How long a press must last, still, to pick a pin up: the TS dock's.
pub const LONG_PRESS: Duration = Duration::from_millis(400);
/// How far the pointer may wander, in logical pixels, before a press is no longer a long
/// press (a click that wobbles stays a click).
pub const SLOP: f64 = 6.;
/// How far past the glass, away from the screen edge, as a share of the icon size, a drop
/// must land to unpin.
pub const OUT: f64 = 0.75;
/// How long a dropped order is kept over the service's views before giving up on it.
pub const HOLD: Duration = Duration::from_millis(2000);

/// An item a drag may move: a pinned app (present or missing) or a pinned folder.
pub fn is_pin(kind: &Kind) -> bool {
    matches!(
        kind,
        Kind::App { pinned: true, .. } | Kind::MissingApp { .. } | Kind::Folder { .. }
    )
}

/// The pinned section: the leading run of pins.
pub fn pins(view: &View) -> std::ops::Range<usize> {
    0..view.items.iter().take_while(|i| is_pin(&i.kind)).count()
}

/// One pin in the air.
#[derive(Clone, Debug)]
pub struct Reorder {
    pub key: String,
    /// The pinned order before it was picked up.
    pub original: Vec<String>,
    /// Where in the pinned section it would land now.
    pub to: usize,
    /// Far enough off the strip that a drop unpins it.
    pub out: bool,
    /// The pointer's offset in the icon it picked up, and that icon's size: the icon in
    /// the air keeps both.
    pub grab: (f64, f64),
    pub size: f64,
    /// Picked up from the running section: the app's desktop id. It is not a pin until
    /// it lands in the pinned section.
    pub running: Option<String>,
    /// A running app over the pinned section, where a drop would pin it at `to`.
    pub into: bool,
    /// Over the Trash: a drop unpins it.
    pub trash: bool,
}

impl Reorder {
    /// Pick up the pin at `slot` of `view`; None if it is not a pin.
    pub fn new(view: &View, slot: usize, grab: (f64, f64), size: f64) -> Option<Self> {
        let range = pins(view);
        let item = view.items.get(slot)?;
        let running = match &item.kind {
            _ if range.contains(&slot) => None,
            Kind::App {
                id, pinned: false, ..
            } => Some(id.clone()),
            _ => return None,
        };
        Some(Reorder {
            key: item.key.clone(),
            to: if running.is_some() { range.len() } else { slot },
            original: view.items[range].iter().map(|i| i.key.clone()).collect(),
            out: false,
            grab,
            size,
            running,
            into: false,
            trash: false,
        })
    }

    /// A drop now would unpin it: off the strip, or on the Trash.
    pub fn unpins(&self) -> bool {
        self.running.is_none() && (self.out || self.trash)
    }

    /// A running app a drop now would pin: `Some(before)`, the pin it goes before (None:
    /// at the end of the pinned section).
    pub fn pins_at(&self) -> Option<Option<String>> {
        (self.running.is_some() && self.into && !self.out)
            .then(|| self.original.get(self.to).cloned())
    }

    /// `view` with this pin moved to where it would land; unchanged if it is no longer
    /// among the pins (the service dropped it meanwhile).
    pub fn preview(&self, view: &View) -> View {
        if self.running.is_some() {
            if self.pins_at().is_none() {
                return view.clone();
            }
            let mut items = view.items.clone();
            let Some(from) = items.iter().position(|i| i.key == self.key) else {
                return view.clone();
            };
            let mut item = items.remove(from);
            if let Kind::App { pinned, .. } = &mut item.kind {
                *pinned = true;
            }
            let at = self.to.min(
                pins(&View {
                    items: items.clone(),
                })
                .len(),
            );
            items.insert(at, item);
            return View { items };
        }
        let range = pins(view);
        let mut items = view.items.clone();
        let Some(from) = items[range.clone()].iter().position(|i| i.key == self.key) else {
            return view.clone();
        };
        let item = items.remove(from);
        let to = self.to.min(range.len() - 1);
        items.insert(to, item);
        View { items }
    }

    /// What a drop asks of the service: `Some(before)` to move it before that pin (None:
    /// to the end), or nothing if it lands where it was.
    pub fn edit(&self) -> Option<Option<String>> {
        if self.running.is_some() {
            return None;
        }
        let mut order = self.original.clone();
        let from = order.iter().position(|k| *k == self.key)?;
        if from == self.to.min(order.len() - 1) {
            return None;
        }
        let key = order.remove(from);
        let to = self.to.min(order.len());
        let before = order.get(to).cloned();
        order.insert(to, key);
        Some(before)
    }

    /// The pinned order a drop on the strip leaves.
    pub fn order(&self) -> Vec<String> {
        let mut order = self.original.clone();
        if self.running.is_some() {
            order.insert(self.to.min(order.len()), self.key.clone());
            return order;
        }
        if let Some(from) = order.iter().position(|k| *k == self.key) {
            let key = order.remove(from);
            order.insert(self.to.min(order.len()), key);
        }
        order
    }
}

/// The pinned slot a pin dropped at `along` lands in: the one whose centre (along the
/// dock, in order) is nearest.
pub fn slot_at(centres: &[f64], along: f64) -> usize {
    centres
        .iter()
        .enumerate()
        .min_by(|a, b| (a.1 - along).abs().total_cmp(&(b.1 - along).abs()))
        .map_or(0, |(i, _)| i)
}

/// `view` with its pins in `order`, while the service has not caught up with a drop:
/// only when they are the same pins (otherwise something else changed them, and the
/// service's view wins). None when it already has that order.
pub fn hold(view: &View, order: &[String]) -> Option<View> {
    let range = pins(view);
    let keys: Vec<&str> = view.items[range.clone()]
        .iter()
        .map(|i| i.key.as_str())
        .collect();
    if keys.iter().copied().eq(order.iter().map(|k| k.as_str())) {
        return None;
    }
    // The same pins, or those plus one running app a drop just pinned.
    let missing: Vec<&String> = order
        .iter()
        .filter(|k| !keys.contains(&k.as_str()))
        .collect();
    if keys.iter().any(|k| !order.iter().any(|o| o == k)) || missing.len() > 1 {
        return None;
    }
    let mut items = view.items.clone();
    let mut pulled = None;
    if let Some(key) = missing.first() {
        let at = items
            .iter()
            .position(|i| i.key == **key && matches!(i.kind, Kind::App { pinned: false, .. }))?;
        let mut item = items.remove(at);
        if let Kind::App { pinned, .. } = &mut item.kind {
            *pinned = true;
        }
        pulled = Some(item);
    }
    let range = pins(&View {
        items: items.clone(),
    });
    let pins: Vec<_> = order
        .iter()
        .filter_map(|k| {
            items[range.clone()]
                .iter()
                .find(|i| i.key == *k)
                .cloned()
                .or_else(|| pulled.clone().filter(|p| p.key == *k))
        })
        .collect();
    items.splice(range, pins);
    Some(View { items })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Item, Signal};

    fn item(key: &str, kind: Kind) -> Item {
        Item {
            key: key.into(),
            kind,
            label: key.into(),
            windows: vec![],
            minimized: vec![],
            signal: Signal::default(),
        }
    }
    fn app(key: &str, pinned: bool) -> Item {
        item(
            key,
            Kind::App {
                id: key.into(),
                generation: 1,
                launchable: true,
                pinned,
            },
        )
    }
    fn view() -> View {
        View {
            items: vec![
                app("a", true),
                app("b", true),
                item("folder:x", Kind::Folder { uri: "x".into() }),
                app("c", true),
                item("sep", Kind::Separator),
                app("r", false),
                item("trash", Kind::Trash),
            ],
        }
    }
    fn keys(v: &View) -> Vec<&str> {
        v.items.iter().map(|i| i.key.as_str()).collect()
    }

    #[test]
    fn pins_and_running_apps_are_picked_up() {
        let v = view();
        assert_eq!(pins(&v), 0..4);
        assert!(Reorder::new(&v, 2, (0., 0.), 64.).is_some_and(|r| r.running.is_none()));
        let r = Reorder::new(&v, 5, (0., 0.), 64.).unwrap();
        assert_eq!(r.running.as_deref(), Some("r"));
        for slot in [4, 6] {
            assert!(Reorder::new(&v, slot, (0., 0.), 64.).is_none(), "{slot}");
        }
    }

    #[test]
    fn a_running_app_is_pinned_where_it_is_dropped() {
        let v = view();
        let mut r = Reorder::new(&v, 5, (0., 0.), 64.).unwrap();
        // Not over the pinned section: it stays where it is, and a drop pins nothing.
        assert_eq!(keys(&r.preview(&v)), keys(&v));
        assert_eq!(r.pins_at(), None);
        assert!(!r.unpins(), "a running app is never unpinned by a drag");
        r.into = true;
        r.to = 1;
        assert_eq!(
            keys(&r.preview(&v)),
            ["a", "r", "b", "folder:x", "c", "sep", "trash"]
        );
        assert_eq!(pins(&r.preview(&v)), 0..5);
        assert_eq!(r.pins_at(), Some(Some("b".to_string())));
        r.to = 4;
        assert_eq!(r.pins_at(), Some(None), "past the last pin: at the end");
        // Until the service has it, the strip holds it there.
        let order = r.order();
        assert_eq!(order, ["a", "b", "folder:x", "c", "r"]);
        let held = hold(&v, &order).unwrap();
        assert_eq!(
            keys(&held),
            ["a", "b", "folder:x", "c", "r", "sep", "trash"]
        );
        assert_eq!(pins(&held), 0..5);
        // Off the strip, nothing.
        r.out = true;
        assert_eq!(r.pins_at(), None);
    }

    #[test]
    fn a_pin_dropped_on_the_trash_is_unpinned() {
        let v = view();
        let mut r = Reorder::new(&v, 1, (0., 0.), 64.).unwrap();
        assert!(!r.unpins());
        r.trash = true;
        assert!(r.unpins());
    }

    #[test]
    fn the_preview_moves_only_the_pin() {
        let v = view();
        let mut r = Reorder::new(&v, 0, (0., 0.), 64.).unwrap();
        r.to = 2;
        assert_eq!(
            keys(&r.preview(&v)),
            ["b", "folder:x", "a", "c", "sep", "r", "trash"]
        );
        // Never past the pins.
        r.to = 9;
        assert_eq!(
            keys(&r.preview(&v))[..5],
            ["b", "folder:x", "c", "a", "sep"]
        );
    }

    #[test]
    fn a_drop_asks_to_move_before_the_pin_that_follows_it() {
        let v = view();
        let mut r = Reorder::new(&v, 0, (0., 0.), 64.).unwrap();
        // Where it was: no edit at all.
        assert_eq!(r.edit(), None);
        r.to = 2;
        assert_eq!(r.edit(), Some(Some("c".into())));
        assert_eq!(r.order(), ["b", "folder:x", "a", "c"]);
        // To the end: no pin follows it.
        r.to = 3;
        assert_eq!(r.edit(), Some(None));
        // Backwards.
        let mut r = Reorder::new(&v, 3, (0., 0.), 64.).unwrap();
        r.to = 0;
        assert_eq!(r.edit(), Some(Some("a".into())));
        assert_eq!(r.order(), ["c", "a", "b", "folder:x"]);
    }

    #[test]
    fn it_lands_in_the_nearest_slot() {
        let centres = [32., 100., 168., 236.];
        assert_eq!(slot_at(&centres, -50.), 0);
        assert_eq!(slot_at(&centres, 70.), 1);
        assert_eq!(slot_at(&centres, 140.), 2);
        assert_eq!(slot_at(&centres, 900.), 3);
    }

    #[test]
    fn a_dropped_order_holds_until_the_service_has_it() {
        let v = view();
        let order: Vec<String> = ["c", "a", "b", "folder:x"].map(String::from).into();
        let held = hold(&v, &order).unwrap();
        assert_eq!(keys(&held)[..5], ["c", "a", "b", "folder:x", "sep"]);
        // The service has it: nothing to hold.
        assert!(hold(&held, &order).is_none());
        // Another change to the pins: the service's view wins.
        let other: Vec<String> = ["c", "a", "b"].map(String::from).into();
        assert!(hold(&v, &other).is_none());
    }
}
