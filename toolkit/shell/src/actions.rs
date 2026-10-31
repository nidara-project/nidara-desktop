// SPDX-License-Identifier: LGPL-3.0-or-later
//! What a primary click does (APPLICATIONS1-DOCK.md §8 "Clicks", DOCK.md §6). Pure: the
//! hub carries the action out against Hyalo/Applications1 after re-reading the window.
use crate::model::{Item, Kind};

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Launch {
        id: String,
        generation: u64,
    },
    Focus(u64),
    Minimize(u64),
    Restore(u64),
    /// Two or more visible windows: the chooser offers them, most recent first.
    Choose(Vec<u64>),
    OpenFolder(String),
    OpenTrash,
    /// Nothing can happen, and the dock says why (no launch service yet, a missing app).
    Unavailable,
}

/// `focused` is the window holding the keyboard; `can_launch` whether Applications1
/// advertises launching at all (A1 does not).
pub fn primary(item: &Item, focused: Option<u64>, can_launch: bool) -> Option<Action> {
    match &item.kind {
        Kind::Separator => None,
        Kind::Folder { uri } => Some(Action::OpenFolder(uri.clone())),
        Kind::Trash => Some(Action::OpenTrash),
        Kind::Minimized { window, .. } => Some(Action::Restore(*window)),
        kind => Some(match (item.windows.as_slice(), item.minimized.first()) {
            // One visible window: focus it, or put it away if it already has the keyboard.
            ([only], _) if focused == Some(*only) => Action::Minimize(*only),
            ([only], _) => Action::Focus(*only),
            // Two or more: the chooser (APPLICATIONS1-DOCK.md §8).
            (windows @ [_, _, ..], _) => Action::Choose(windows.to_vec()),
            ([], Some(newest)) => Action::Restore(*newest),
            ([], None) => match kind {
                Kind::App {
                    id,
                    generation,
                    launchable: true,
                    ..
                } if can_launch => Action::Launch {
                    id: id.clone(),
                    generation: *generation,
                },
                _ => Action::Unavailable,
            },
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(windows: &[u64], minimized: &[u64]) -> Item {
        Item {
            key: "app:a.desktop".into(),
            kind: Kind::App {
                id: "a.desktop".into(),
                generation: 3,
                launchable: true,
                pinned: true,
            },
            label: "a".into(),
            windows: windows.to_vec(),
            minimized: minimized.to_vec(),
        }
    }

    #[test]
    fn the_click_rules_of_the_contract() {
        use Action::*;
        assert_eq!(
            primary(&item(&[], &[]), None, true),
            Some(Launch {
                id: "a.desktop".into(),
                generation: 3
            })
        );
        // No launch service (A1): nothing else is tried.
        assert_eq!(primary(&item(&[], &[]), None, false), Some(Unavailable));
        assert_eq!(primary(&item(&[4], &[]), None, true), Some(Focus(4)));
        assert_eq!(primary(&item(&[4], &[]), Some(4), true), Some(Minimize(4)));
        // Only minimized windows: the newest comes back.
        assert_eq!(primary(&item(&[], &[9, 2]), None, true), Some(Restore(9)));
        // One visible plus minimized ones: the visible one keeps the single-window rule.
        assert_eq!(primary(&item(&[4], &[9]), Some(4), true), Some(Minimize(4)));
        assert_eq!(
            primary(&item(&[5, 4], &[]), None, true),
            Some(Choose(vec![5, 4]))
        );
        assert_eq!(
            primary(&item(&[5, 4], &[]), Some(5), true),
            Some(Choose(vec![5, 4]))
        );
        let mut not_launchable = item(&[], &[]);
        not_launchable.kind = Kind::App {
            id: "a.desktop".into(),
            generation: 3,
            launchable: false,
            pinned: true,
        };
        assert_eq!(primary(&not_launchable, None, true), Some(Unavailable));
        let mut missing = item(&[], &[]);
        missing.kind = Kind::MissingApp {
            id: "a.desktop".into(),
        };
        assert_eq!(primary(&missing, None, true), Some(Unavailable));
        let mut sep = item(&[], &[]);
        sep.kind = Kind::Separator;
        assert_eq!(primary(&sep, None, true), None);
        let mut m = item(&[], &[7]);
        m.kind = Kind::Minimized {
            window: 7,
            app: None,
        };
        assert_eq!(primary(&m, None, true), Some(Restore(7)));
    }
}
