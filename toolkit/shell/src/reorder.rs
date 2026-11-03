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
//! Pinned folders and files are a section of their own, before the Trash (owner,
//! 2026-11-02): one moves among them the same way, and never into the apps' section.
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

/// Which pinned section an item belongs to: `Some(false)` a pinned app (present or
/// missing), `Some(true)` a pinned folder or file; None for anything a drag cannot move.
pub fn section_of(kind: &Kind) -> Option<bool> {
    match kind {
        Kind::App { pinned: true, .. } | Kind::MissingApp { .. } => Some(false),
        Kind::Folder { .. } | Kind::File { .. } => Some(true),
        _ => None,
    }
}

/// An item a drag may move: a pinned app, folder or file.
pub fn is_pin(kind: &Kind) -> bool {
    section_of(kind).is_some()
}

/// A pinned section: the apps' (the leading run) or the folders' and files' (`places`).
pub fn section(view: &View, places: bool) -> std::ops::Range<usize> {
    let start = if places {
        view.items
            .iter()
            .position(|i| section_of(&i.kind) == Some(true))
            .unwrap_or(view.items.len())
    } else {
        0
    };
    let len = view.items[start..]
        .iter()
        .take_while(|i| section_of(&i.kind) == Some(places))
        .count();
    start..start + len
}

/// The apps' pinned section, where a running app may be pinned.
pub fn pins(view: &View) -> std::ops::Range<usize> {
    section(view, false)
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
    /// A pinned folder or file: it moves in that section, not the apps'.
    pub places: bool,
    /// A running app over the pinned section, where a drop would pin it at `to`.
    pub into: bool,
    /// Over the Trash: a drop unpins it.
    pub trash: bool,
}

impl Reorder {
    /// Pick up the pin at `slot` of `view`; None if it is not a pin. `to` counts from the
    /// start of its section.
    pub fn new(view: &View, slot: usize, grab: (f64, f64), size: f64) -> Option<Self> {
        let item = view.items.get(slot)?;
        let places = section_of(&item.kind) == Some(true);
        let range = section(view, places);
        let running = match &item.kind {
            _ if range.contains(&slot) => None,
            Kind::App {
                id, pinned: false, ..
            } => Some(id.clone()),
            _ => return None,
        };
        Some(Reorder {
            key: item.key.clone(),
            to: if running.is_some() {
                range.len()
            } else {
                slot - range.start
            },
            original: view.items[range].iter().map(|i| i.key.clone()).collect(),
            out: false,
            grab,
            size,
            running,
            places,
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
        let range = section(view, self.places);
        let mut items = view.items.clone();
        let Some(from) = items[range.clone()].iter().position(|i| i.key == self.key) else {
            return view.clone();
        };
        let item = items.remove(range.start + from);
        let to = self.to.min(range.len() - 1);
        items.insert(range.start + to, item);
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

/// Where the pin in the air (`key`) at `along` (main axis) would land in `view` as drawn
/// (`hits`, each item's share of the main axis): `(to, into)`, the pinned slot and
/// whether a running app is over the pinned section at all.
///
/// The slot is how many of the OTHER pins have their centre behind the pointer. Its own
/// open slot sits between those and the rest, so the answer holds while the pointer stays
/// in it, and past the last pin's centre it is the end of the section. The nearest
/// centre, as it was, could never be the end for a running app coming in from the right,
/// and with magnification it stuck one short of it (owner, 2026-11-02).
pub fn aim(
    view: &View,
    places: bool,
    hits: &[[f64; 4]],
    horizontal: bool,
    key: &str,
    along: f64,
) -> (usize, bool) {
    let span = |n: usize| {
        let [x, y, w, h] = hits[n];
        if horizontal { (x, w) } else { (y, h) }
    };
    let range = section(view, places);
    let to = range
        .clone()
        .filter(|&n| view.items[n].key != key)
        .filter(|&n| {
            let (a, len) = span(n);
            a + len / 2. < along
        })
        .count();
    // A running app is over the pinned section up to half a slot past the last pin, as
    // wide as that pin is drawn now (magnified, it is wider than at rest).
    let into = range.last().is_none_or(|n| {
        let (a, len) = span(n);
        along < a + 1.5 * len
    });
    (to, into)
}

/// `view` with its pins in `order`, while the service has not caught up with a drop:
/// only when they are the same pins (otherwise something else changed them, and the
/// service's view wins). None when it already has that order.
pub fn hold(view: &View, order: &[String]) -> Option<View> {
    // The section the order is of: the one its pins are in.
    let places = view
        .items
        .iter()
        .any(|i| section_of(&i.kind) == Some(true) && order.contains(&i.key));
    let range = section(view, places);
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
    let range = section(
        &View {
            items: items.clone(),
        },
        places,
    );
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
                app("d", true),
                app("c", true),
                item("sep", Kind::Separator),
                app("r", false),
                item("sep2", Kind::Separator),
                item("folder:x", Kind::Folder { uri: "x".into() }),
                item("file:y", Kind::File { uri: "y".into() }),
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
        for slot in [4, 6, 9] {
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
            [
                "a", "r", "b", "d", "c", "sep", "sep2", "folder:x", "file:y", "trash"
            ]
        );
        assert_eq!(pins(&r.preview(&v)), 0..5);
        assert_eq!(r.pins_at(), Some(Some("b".to_string())));
        r.to = 4;
        assert_eq!(r.pins_at(), Some(None), "past the last pin: at the end");
        // Until the service has it, the strip holds it there.
        let order = r.order();
        assert_eq!(order, ["a", "b", "d", "c", "r"]);
        let held = hold(&v, &order).unwrap();
        assert_eq!(
            keys(&held),
            [
                "a", "b", "d", "c", "r", "sep", "sep2", "folder:x", "file:y", "trash"
            ]
        );
        assert_eq!(pins(&held), 0..5);
        // Off the strip, nothing.
        r.out = true;
        assert_eq!(r.pins_at(), None);
    }

    /// The strip as the dock draws `view` with the pointer at `p`: 64 px icons, magnified
    /// to 128 when `mag`.
    fn strip(view: &View, mag: bool, p: f64) -> crate::geometry::Layout {
        use crate::geometry::{Position, Slot, envelope, layout};
        let slots: Vec<_> = view
            .items
            .iter()
            .map(|i| match i.kind {
                Kind::Separator => Slot::Separator,
                _ => Slot::Icon,
            })
            .collect();
        let l = layout(&slots, 64, Position::Bottom, (2560, 1440), 0.);
        if !mag {
            return l;
        }
        envelope(l, &slots, 128, (2560, 1440), 0.).magnify(&slots, (p, 0.), 1.)
    }

    /// The centre of `view`'s item `n` at rest.
    fn centre(view: &View, mag: bool, n: usize) -> f64 {
        let [x, _, w, _] = strip(view, mag, -1e4).rects[n];
        x + w / 2.
    }

    /// Carry `r` to `to` a pixel at a time, as the dock does: each step aims at the strip
    /// as the preview draws it, magnified around the pointer.
    fn carry(v: &View, r: &mut Reorder, mag: bool, from: f64, to: f64) {
        let mut p = from;
        while (p - to).abs() > 0.5 {
            p += (to - p).signum();
            let shown = r.preview(v);
            let (at, into) = aim(
                &shown,
                r.places,
                &strip(&shown, mag, p).hits,
                true,
                &r.key,
                p,
            );
            if r.running.is_some() {
                r.into = into;
            }
            if r.running.is_none() || r.into {
                r.to = at;
            }
        }
    }

    #[test]
    fn a_running_app_can_be_pinned_after_the_last_pin() {
        let v = view();
        for mag in [false, true] {
            let (c, sep, run) = (centre(&v, mag, 3), centre(&v, mag, 4), centre(&v, mag, 5));
            // Brought in from its slot to anywhere between the last pin's centre and the
            // separator: it is pinned at the end. Magnified, that centre is where the pin
            // is drawn, a few pixels right of where it rests.
            let mut x = sep;
            while x > c + if mag { 6. } else { 1. } {
                let mut r = Reorder::new(&v, 5, (0., 0.), 64.).unwrap();
                carry(&v, &mut r, mag, run, x);
                assert_eq!(r.pins_at(), Some(None), "mag {mag}, dropped at {x}");
                x -= 1.;
            }
            // Further, past that pin's centre: before it.
            let mut r = Reorder::new(&v, 5, (0., 0.), 64.).unwrap();
            carry(&v, &mut r, mag, run, c - 8.);
            assert_eq!(r.pins_at(), Some(Some("c".into())), "mag {mag}");
            // And back out past the Trash: nothing.
            let out = centre(&v, mag, 9) + 200.;
            carry(&v, &mut r, mag, c - 8., out);
            assert_eq!(r.pins_at(), None, "mag {mag}");
        }
    }

    #[test]
    fn a_pin_can_be_carried_to_the_end_and_back() {
        let v = view();
        for mag in [false, true] {
            let (a, c, sep) = (centre(&v, mag, 0), centre(&v, mag, 3), centre(&v, mag, 4));
            let mut r = Reorder::new(&v, 0, (0., 0.), 64.).unwrap();
            carry(&v, &mut r, mag, a, (c + sep) / 2.);
            assert_eq!(r.edit(), Some(None), "mag {mag}: to the end");
            carry(&v, &mut r, mag, (c + sep) / 2., a - 200.);
            assert_eq!(r.edit(), None, "mag {mag}: back where it was");
        }
    }

    #[test]
    fn folders_and_files_move_only_among_themselves() {
        let v = view();
        assert_eq!(section(&v, true), 7..9);
        let r = Reorder::new(&v, 8, (0., 0.), 64.).unwrap();
        assert!(r.places && r.running.is_none());
        assert_eq!(
            (r.to, r.original.clone()),
            (1, vec!["folder:x".into(), "file:y".into()])
        );
        for mag in [false, true] {
            let (a, trash) = (centre(&v, mag, 0), centre(&v, mag, 9));
            // Carried over the apps, as far as the first of them: first among the places,
            // never among the apps.
            let mut r = Reorder::new(&v, 8, (0., 0.), 64.).unwrap();
            carry(&v, &mut r, mag, centre(&v, mag, 8), a - 200.);
            assert_eq!(r.edit(), Some(Some("folder:x".into())), "mag {mag}");
            assert_eq!(
                keys(&r.preview(&v))[6..],
                ["sep2", "file:y", "folder:x", "trash"],
                "mag {mag}"
            );
            // The order holds until the service has it.
            let held = hold(&v, &r.order()).unwrap();
            assert_eq!(keys(&held)[..5], ["a", "b", "d", "c", "sep"]);
            assert_eq!(keys(&held)[7..9], ["file:y", "folder:x"]);
            // And back past the last one: where it was.
            carry(&v, &mut r, mag, a - 200., trash);
            assert_eq!(r.edit(), None, "mag {mag}");
        }
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
            [
                "b", "d", "a", "c", "sep", "r", "sep2", "folder:x", "file:y", "trash"
            ]
        );
        // Never past the pins.
        r.to = 9;
        assert_eq!(keys(&r.preview(&v))[..5], ["b", "d", "c", "a", "sep"]);
    }

    #[test]
    fn a_drop_asks_to_move_before_the_pin_that_follows_it() {
        let v = view();
        let mut r = Reorder::new(&v, 0, (0., 0.), 64.).unwrap();
        // Where it was: no edit at all.
        assert_eq!(r.edit(), None);
        r.to = 2;
        assert_eq!(r.edit(), Some(Some("c".into())));
        assert_eq!(r.order(), ["b", "d", "a", "c"]);
        // To the end: no pin follows it.
        r.to = 3;
        assert_eq!(r.edit(), Some(None));
        // Backwards.
        let mut r = Reorder::new(&v, 3, (0., 0.), 64.).unwrap();
        r.to = 0;
        assert_eq!(r.edit(), Some(Some("a".into())));
        assert_eq!(r.order(), ["c", "a", "b", "d"]);
    }

    #[test]
    fn a_dropped_order_holds_until_the_service_has_it() {
        let v = view();
        let order: Vec<String> = ["c", "a", "b", "d"].map(String::from).into();
        let held = hold(&v, &order).unwrap();
        assert_eq!(keys(&held)[..5], ["c", "a", "b", "d", "sep"]);
        // The service has it: nothing to hold.
        assert!(hold(&held, &order).is_none());
        // Another change to the pins: the service's view wins.
        let other: Vec<String> = ["c", "a", "b"].map(String::from).into();
        assert!(hold(&v, &other).is_none());
    }
}
