// SPDX-License-Identifier: LGPL-3.0-or-later
//! Keyboard rules (DOCK.md §7): one roving focus; arrows along the dock's axis stop at the
//! ends, Tab/Shift+Tab wrap, Home/End jump, Enter/Space act, Escape leaves. Separators
//! never take the focus.
use crate::model::{Item, Kind};

const TAB: u32 = 0xff09;
const LEFT_TAB: u32 = 0xfe20;
const LEFT: u32 = 0xff51;
const UP: u32 = 0xff52;
const RIGHT: u32 = 0xff53;
const DOWN: u32 = 0xff54;
const HOME: u32 = 0xff50;
const END: u32 = 0xff57;
const RETURN: u32 = 0xff0d;
const KP_ENTER: u32 = 0xff8d;
const SPACE: u32 = 0x20;
const ESCAPE: u32 = 0xff1b;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Nav {
    Back { wrap: bool },
    Forward { wrap: bool },
    First,
    Last,
    Act,
    Leave,
}

pub fn nav(sym: u32, shift: bool, horizontal: bool) -> Option<Nav> {
    let (back, forward) = if horizontal {
        (LEFT, RIGHT)
    } else {
        (UP, DOWN)
    };
    Some(match sym {
        TAB if shift => Nav::Back { wrap: true },
        LEFT_TAB => Nav::Back { wrap: true },
        TAB => Nav::Forward { wrap: true },
        s if s == back => Nav::Back { wrap: false },
        s if s == forward => Nav::Forward { wrap: false },
        HOME => Nav::First,
        END => Nav::Last,
        RETURN | KP_ENTER | SPACE => Nav::Act,
        ESCAPE => Nav::Leave,
        _ => return None,
    })
}

fn focusable(items: &[Item]) -> Vec<usize> {
    (0..items.len())
        .filter(|&n| items[n].kind != Kind::Separator)
        .collect()
}

pub fn first(items: &[Item]) -> Option<usize> {
    focusable(items).first().copied()
}

/// Where the focus goes from `from`; None for Act/Leave or an empty dock.
pub fn moved(items: &[Item], from: usize, nav: Nav) -> Option<usize> {
    let slots = focusable(items);
    let at = slots.iter().position(|&n| n == from).unwrap_or(0);
    let last = slots.len().checked_sub(1)?;
    let to = match nav {
        Nav::Back { wrap } => match at.checked_sub(1) {
            Some(n) => n,
            None if wrap => last,
            None => at,
        },
        Nav::Forward { wrap } => {
            if at < last {
                at + 1
            } else if wrap {
                0
            } else {
                at
            }
        }
        Nav::First => 0,
        Nav::Last => last,
        Nav::Act | Nav::Leave => return None,
    };
    Some(slots[to])
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(kind: Kind) -> Item {
        Item {
            key: String::new(),
            kind,
            label: String::new(),
            windows: vec![],
            minimized: vec![],
        }
    }
    #[test]
    fn arrows_stop_tab_wraps_and_separators_are_skipped() {
        let app = || {
            item(Kind::Folder {
                uri: "file:///".into(),
            })
        };
        let items = [
            app(),
            item(Kind::Separator),
            app(),
            item(Kind::Separator),
            item(Kind::Trash),
        ];
        assert_eq!(first(&items), Some(0));
        let forward = nav(RIGHT, false, true).unwrap();
        assert_eq!(moved(&items, 0, forward), Some(2));
        assert_eq!(moved(&items, 2, forward), Some(4));
        assert_eq!(moved(&items, 4, forward), Some(4), "arrows stop at the end");
        assert_eq!(
            moved(&items, 4, nav(TAB, false, true).unwrap()),
            Some(0),
            "Tab wraps"
        );
        assert_eq!(
            moved(&items, 0, nav(TAB, true, true).unwrap()),
            Some(4),
            "Shift+Tab wraps"
        );
        assert_eq!(
            moved(&items, 0, nav(LEFT_TAB, false, true).unwrap()),
            Some(4)
        );
        assert_eq!(moved(&items, 0, nav(LEFT, false, true).unwrap()), Some(0));
        assert_eq!(moved(&items, 2, nav(END, false, true).unwrap()), Some(4));
        assert_eq!(moved(&items, 4, nav(HOME, false, true).unwrap()), Some(0));
        // A side dock moves with Up/Down; Left/Right mean nothing there.
        assert_eq!(nav(DOWN, false, false), Some(Nav::Forward { wrap: false }));
        assert_eq!(nav(RIGHT, false, false), None);
        assert_eq!(nav(RETURN, false, true), Some(Nav::Act));
        assert_eq!(nav(ESCAPE, false, false), Some(Nav::Leave));
        assert_eq!(moved(&[], 0, forward), None);
    }
}
