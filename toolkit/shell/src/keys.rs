// SPDX-License-Identifier: LGPL-3.0-or-later
//! Keyboard rules (DOCK.md §7): one roving focus; arrows along the dock's axis stop at the
//! ends, Tab/Shift+Tab wrap, Home/End jump, Enter/Space act, Menu/Shift+F10/the arrow away
//! from the edge open the item's menu, Escape leaves. A separator takes the focus as the
//! dock's size adjuster (resize.rs): there the arrow away from the edge grows the icons
//! and the arrow toward it shrinks them. The focus starts on the first item, never on one.
use crate::geometry::Position;
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
const MENU: u32 = 0xff67;
const F10: u32 = 0xffc7;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Nav {
    Back {
        wrap: bool,
    },
    Forward {
        wrap: bool,
    },
    First,
    Last,
    Act,
    /// The focused item's menu.
    Menu,
    /// The arrow away from the dock's edge (an item's menu; a separator grows the icons),
    /// and toward it (a separator shrinks them).
    Outward,
    Inward,
    Leave,
}

pub fn nav(sym: u32, shift: bool, position: Position) -> Option<Nav> {
    let (back, forward) = if position.horizontal() {
        (LEFT, RIGHT)
    } else {
        (UP, DOWN)
    };
    // Away from the edge the dock sits on: where its menus open.
    let (outward, inward) = match position {
        Position::Bottom => (UP, DOWN),
        Position::Left => (RIGHT, LEFT),
        Position::Right => (LEFT, RIGHT),
    };
    Some(match sym {
        MENU => Nav::Menu,
        F10 if shift => Nav::Menu,
        s if s == outward => Nav::Outward,
        s if s == inward => Nav::Inward,
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
    (0..items.len()).collect()
}

pub fn first(items: &[Item]) -> Option<usize> {
    items.iter().position(|i| i.kind != Kind::Separator)
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
        Nav::Act | Nav::Menu | Nav::Outward | Nav::Inward | Nav::Leave => return None,
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
            signal: Default::default(),
        }
    }
    #[test]
    fn arrows_stop_tab_wraps_and_separators_are_stops() {
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
        assert_eq!(first(&items[1..]), Some(1), "never starts on a separator");
        let forward = nav(RIGHT, false, Position::Bottom).unwrap();
        assert_eq!(
            moved(&items, 0, forward),
            Some(1),
            "the separator is a stop"
        );
        assert_eq!(moved(&items, 3, forward), Some(4));
        assert_eq!(moved(&items, 4, forward), Some(4), "arrows stop at the end");
        assert_eq!(
            moved(&items, 4, nav(TAB, false, Position::Bottom).unwrap()),
            Some(0),
            "Tab wraps"
        );
        assert_eq!(
            moved(&items, 0, nav(TAB, true, Position::Bottom).unwrap()),
            Some(4),
            "Shift+Tab wraps"
        );
        assert_eq!(
            moved(&items, 0, nav(LEFT_TAB, false, Position::Bottom).unwrap()),
            Some(4)
        );
        assert_eq!(
            moved(&items, 0, nav(LEFT, false, Position::Bottom).unwrap()),
            Some(0)
        );
        assert_eq!(
            moved(&items, 2, nav(END, false, Position::Bottom).unwrap()),
            Some(4)
        );
        assert_eq!(
            moved(&items, 4, nav(HOME, false, Position::Bottom).unwrap()),
            Some(0)
        );
        // A side dock moves with Up/Down; Left/Right go across it.
        assert_eq!(
            nav(DOWN, false, Position::Left),
            Some(Nav::Forward { wrap: false })
        );
        assert_eq!(nav(LEFT, false, Position::Left), Some(Nav::Inward));
        // Menu and Shift+F10 open the menu; the arrows across the dock are told apart.
        assert_eq!(nav(RIGHT, false, Position::Left), Some(Nav::Outward));
        assert_eq!(nav(LEFT, false, Position::Right), Some(Nav::Outward));
        assert_eq!(nav(UP, false, Position::Bottom), Some(Nav::Outward));
        assert_eq!(nav(DOWN, false, Position::Bottom), Some(Nav::Inward));
        assert_eq!(nav(MENU, false, Position::Bottom), Some(Nav::Menu));
        assert_eq!(nav(F10, true, Position::Bottom), Some(Nav::Menu));
        assert_eq!(nav(F10, false, Position::Bottom), None);
        assert_eq!(nav(RETURN, false, Position::Bottom), Some(Nav::Act));
        assert_eq!(nav(ESCAPE, false, Position::Left), Some(Nav::Leave));
        assert_eq!(moved(&[], 0, forward), None);
    }
}
