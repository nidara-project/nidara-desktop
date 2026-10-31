// SPDX-License-Identifier: LGPL-3.0-or-later
//! What each dock menu holds (APPLICATIONS1-DOCK.md §8 "Clicks, menus and keyboard",
//! DOCK.md §8): the rows and what each one asks for. Pure: the dock draws the rows with
//! the kit's action menu and sends the chosen command to the hub, which re-reads the
//! window or app before acting. Every capability shown is one a service confirmed.
use crate::geometry::Position;
use crate::model::{App, Item, Kind};
use crate::prefs::Prefs;
use std::collections::HashMap;

/// A row's text: a catalogue key, or the app's or window's own words.
#[derive(Clone, Debug, PartialEq)]
pub enum Label {
    Key(&'static str),
    Text(String),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Mark {
    Plain,
    Check(bool),
    Radio(bool),
    Separator,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Launch {
    Activate,
    NewWindow,
    Action(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Command {
    None,
    Launch {
        id: String,
        generation: u64,
        mode: Launch,
    },
    /// A Hyalo window verb: focus-window, minimize, unminimize, close-window.
    Window {
        verb: &'static str,
        id: u64,
    },
    /// A close request to each window: the app may still ask to save.
    CloseAll(Vec<u64>),
    Pin {
        id: String,
    },
    Unpin {
        key: String,
    },
    Autostart {
        id: String,
        generation: u64,
        enabled: bool,
    },
    OpenFolder(String),
    OpenTrash,
    EmptyTrash,
    /// A Config1 dock key and the value to apply.
    Pref {
        key: &'static str,
        value: PrefValue,
    },
    DockSettings,
}

#[derive(Clone, Debug, PartialEq)]
pub enum PrefValue {
    Bool(bool),
    Text(&'static str),
    /// The separator's size gesture.
    Number(f64),
}

#[derive(Clone, Debug, PartialEq)]
pub struct Row {
    pub label: Label,
    pub mark: Mark,
    pub enabled: bool,
    pub command: Command,
}
fn row(label: Label, command: Command) -> Row {
    Row {
        label,
        mark: Mark::Plain,
        enabled: true,
        command,
    }
}
fn separator() -> Row {
    Row {
        label: Label::Text(String::new()),
        mark: Mark::Separator,
        enabled: false,
        command: Command::None,
    }
}

/// What the app menu needs besides the item: the catalogue record, window titles, and
/// which services are there.
pub struct Context<'a> {
    pub app: Option<&'a App>,
    pub titles: &'a HashMap<u64, String>,
    pub can_launch: bool,
    pub can_edit_layout: bool,
    pub can_autostart: bool,
    pub can_open_directory: bool,
    /// The Trash can be emptied here (its backend is GIO's trash:///).
    pub can_empty_trash: bool,
    pub trash_full: bool,
}

/// The rows of one item's menu, separators only between groups that have rows.
pub fn item_menu(item: &Item, cx: &Context) -> Vec<Row> {
    let mut groups: Vec<Vec<Row>> = vec![];
    match &item.kind {
        Kind::Separator => return vec![],
        Kind::Trash => {
            groups.push(vec![row(Label::Key("dock.menu.open"), Command::OpenTrash)]);
            groups.push(vec![Row {
                enabled: cx.can_empty_trash && cx.trash_full,
                ..row(
                    Label::Key("settings.dock.dockitem.empty-trash"),
                    Command::EmptyTrash,
                )
            }]);
        }
        Kind::Folder { uri } => {
            groups.push(vec![Row {
                enabled: cx.can_open_directory,
                ..row(
                    Label::Key("dock.menu.open"),
                    Command::OpenFolder(uri.clone()),
                )
            }]);
            if cx.can_edit_layout {
                groups.push(vec![unpin(item)]);
            }
        }
        Kind::Minimized { window, .. } => {
            groups.push(vec![row(
                Label::Key("dock.menu.restore"),
                Command::Window {
                    verb: "unminimize",
                    id: *window,
                },
            )]);
            groups.push(vec![row(
                Label::Key("dock.menu.close-window"),
                Command::Window {
                    verb: "close-window",
                    id: *window,
                },
            )]);
        }
        Kind::MissingApp { .. } => {
            if cx.can_edit_layout {
                groups.push(vec![unpin(item)]);
            }
        }
        Kind::App { .. } | Kind::Unknown { .. } => app_menu(item, cx, &mut groups),
    }
    let mut rows = vec![];
    for g in groups.into_iter().filter(|g| !g.is_empty()) {
        if !rows.is_empty() {
            rows.push(separator());
        }
        rows.extend(g);
    }
    rows
}

fn unpin(item: &Item) -> Row {
    row(
        Label::Key("settings.dock.dockitem.unpin"),
        Command::Unpin {
            key: item.key.clone(),
        },
    )
}

fn app_menu(item: &Item, cx: &Context, groups: &mut Vec<Vec<Row>>) {
    let launchable = match (&item.kind, cx.app) {
        (Kind::App { launchable, .. }, Some(_)) => *launchable && cx.can_launch,
        _ => false,
    };
    let launch = |mode: Launch| match (&item.kind, cx.app) {
        (Kind::App { id, generation, .. }, Some(_)) => Command::Launch {
            id: id.clone(),
            generation: *generation,
            mode,
        },
        _ => Command::None,
    };
    // Open, new window, the entry's own actions.
    let mut start = vec![];
    if launchable && !item.running() {
        start.push(row(Label::Key("dock.menu.open"), launch(Launch::Activate)));
    }
    if let Some(app) = cx.app.filter(|_| launchable) {
        if app.new_window {
            start.push(row(
                Label::Key("dock.menu.new-window"),
                launch(Launch::NewWindow),
            ));
        }
        for a in &app.actions {
            // The new-window action is the row above, under the desktop's own words.
            if app.new_window && (a.id.eq_ignore_ascii_case("new-window") || a.id == "NewWindow") {
                continue;
            }
            start.push(row(
                Label::Text(a.name.clone()),
                launch(Launch::Action(a.id.clone())),
            ));
        }
    }
    groups.push(start);
    // Its windows, most recent first: a visible one is focused, a minimized one restored.
    let title = |id: &u64| {
        cx.titles
            .get(id)
            .filter(|t| !t.trim().is_empty())
            .cloned()
            .unwrap_or_else(|| item.label.clone())
    };
    let mut windows: Vec<Row> = item
        .windows
        .iter()
        .map(|id| {
            row(
                Label::Text(title(id)),
                Command::Window {
                    verb: "focus-window",
                    id: *id,
                },
            )
        })
        .collect();
    windows.extend(item.minimized.iter().map(|id| {
        row(
            Label::Text(title(id)),
            Command::Window {
                verb: "unminimize",
                id: *id,
            },
        )
    }));
    groups.push(windows);
    let mut state = vec![];
    if let Some(id) = item.windows.first() {
        state.push(row(
            Label::Key("dock.menu.minimize"),
            Command::Window {
                verb: "minimize",
                id: *id,
            },
        ));
    }
    if let Some(id) = item.minimized.first() {
        state.push(row(
            Label::Key("dock.menu.restore"),
            Command::Window {
                verb: "unminimize",
                id: *id,
            },
        ));
    }
    groups.push(state);
    // Keep / remove, and starting at login.
    let mut keep = vec![];
    if cx.can_edit_layout {
        match &item.kind {
            Kind::App { pinned: true, .. } => keep.push(unpin(item)),
            Kind::App { id, .. } => keep.push(row(
                Label::Key("settings.dock.dockitem.keep"),
                Command::Pin { id: id.clone() },
            )),
            _ => {}
        }
    }
    if let (Some(app), Kind::App { id, generation, .. }) = (cx.app, &item.kind)
        && cx.can_autostart
        && app.autostart.available
    {
        keep.push(Row {
            mark: Mark::Check(app.autostart.enabled),
            enabled: app.autostart.writable,
            ..row(
                Label::Key("dock.menu.open-at-login"),
                Command::Autostart {
                    id: id.clone(),
                    generation: *generation,
                    enabled: !app.autostart.enabled,
                },
            )
        });
    }
    groups.push(keep);
    let all: Vec<u64> = item
        .windows
        .iter()
        .chain(&item.minimized)
        .copied()
        .collect();
    groups.push(match all.as_slice() {
        [] => vec![],
        [only] => vec![row(
            Label::Key("dock.menu.close-window"),
            Command::Window {
                verb: "close-window",
                id: *only,
            },
        )],
        _ => vec![row(
            Label::Key("settings.dock.dockitem.close-all"),
            Command::CloseAll(all),
        )],
    });
}

/// The menu of the separator and the dock's empty space: its own preferences, each shown
/// as Config1 last confirmed it.
pub fn dock_menu(prefs: &Prefs, can_settings: bool) -> Vec<Row> {
    let check = |label, key, on: bool| Row {
        mark: Mark::Check(on),
        ..row(
            Label::Key(label),
            Command::Pref {
                key,
                value: PrefValue::Bool(!on),
            },
        )
    };
    let side = |label, value: &'static str, position: Position| Row {
        mark: Mark::Radio(prefs.position == position),
        ..row(
            Label::Key(label),
            Command::Pref {
                key: "dock.position",
                value: PrefValue::Text(value),
            },
        )
    };
    vec![
        check("settings.dock.autohide", "dock.autoHide", prefs.auto_hide),
        check(
            "settings.dock.magnification",
            "dock.magnification",
            prefs.magnification,
        ),
        check(
            "settings.dock.indicators",
            "dock.indicators",
            prefs.indicators,
        ),
        separator(),
        side("settings.dock.opt.bottom", "bottom", Position::Bottom),
        side("settings.dock.opt.left", "left", Position::Left),
        side("settings.dock.opt.right", "right", Position::Right),
        separator(),
        Row {
            enabled: can_settings,
            ..row(Label::Key("dock.menu.dock-settings"), Command::DockSettings)
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Autostart, DesktopAction};

    fn app() -> App {
        App {
            id: "org.example.Editor.desktop".into(),
            generation: 2,
            name: "Editor".into(),
            launchable: true,
            new_window: true,
            actions: vec![
                DesktopAction {
                    id: "new-window".into(),
                    name: "New Window".into(),
                },
                DesktopAction {
                    id: "private".into(),
                    name: "Private Window".into(),
                },
            ],
            autostart: Autostart {
                available: true,
                writable: true,
                enabled: false,
            },
            ..Default::default()
        }
    }
    fn item(windows: &[u64], minimized: &[u64], pinned: bool) -> Item {
        Item {
            key: if pinned {
                "pin:3".into()
            } else {
                "app:org.example.Editor.desktop".into()
            },
            kind: Kind::App {
                id: "org.example.Editor.desktop".into(),
                generation: 2,
                launchable: true,
                pinned,
            },
            label: "Editor".into(),
            windows: windows.to_vec(),
            minimized: minimized.to_vec(),
        }
    }
    fn cx<'a>(app: Option<&'a App>, titles: &'a HashMap<u64, String>) -> Context<'a> {
        Context {
            app,
            titles,
            can_launch: true,
            can_edit_layout: true,
            can_autostart: true,
            can_open_directory: true,
            can_empty_trash: true,
            trash_full: true,
        }
    }
    fn labels(rows: &[Row]) -> Vec<String> {
        rows.iter()
            .map(|r| match (&r.label, r.mark) {
                (_, Mark::Separator) => "—".into(),
                (Label::Key(k), _) => k.to_string(),
                (Label::Text(t), _) => t.clone(),
            })
            .collect()
    }

    #[test]
    fn a_closed_pinned_app_offers_open_new_window_actions_unpin_and_login() {
        let (a, titles) = (app(), HashMap::new());
        let rows = item_menu(&item(&[], &[], true), &cx(Some(&a), &titles));
        assert_eq!(
            labels(&rows),
            [
                "dock.menu.open",
                "dock.menu.new-window",
                "Private Window",
                "—",
                "settings.dock.dockitem.unpin",
                "dock.menu.open-at-login",
            ]
        );
        assert_eq!(rows[5].mark, Mark::Check(false));
        assert_eq!(
            rows[5].command,
            Command::Autostart {
                id: "org.example.Editor.desktop".into(),
                generation: 2,
                enabled: true
            }
        );
    }

    #[test]
    fn a_running_app_lists_its_windows_and_closes_them_all() {
        let (a, mut titles) = (app(), HashMap::new());
        titles.insert(4, "notes.txt".to_string());
        titles.insert(9, " ".to_string());
        let rows = item_menu(&item(&[4], &[9], false), &cx(Some(&a), &titles));
        assert_eq!(
            labels(&rows),
            [
                "dock.menu.new-window",
                "Private Window",
                "—",
                "notes.txt",
                // A blank title reads as the app's name.
                "Editor",
                "—",
                "dock.menu.minimize",
                "dock.menu.restore",
                "—",
                "settings.dock.dockitem.keep",
                "dock.menu.open-at-login",
                "—",
                "settings.dock.dockitem.close-all",
            ]
        );
        assert_eq!(
            rows[4].command,
            Command::Window {
                verb: "unminimize",
                id: 9
            }
        );
        assert_eq!(rows.last().unwrap().command, Command::CloseAll(vec![4, 9]));
    }

    #[test]
    fn what_a_service_cannot_do_is_not_offered() {
        let mut a = app();
        a.new_window = false;
        a.autostart.writable = false;
        let titles = HashMap::new();
        let mut c = cx(Some(&a), &titles);
        c.can_edit_layout = false;
        let rows = item_menu(&item(&[4], &[], true), &c);
        assert_eq!(
            labels(&rows),
            [
                // Without a new-window mode, its declared action is just one more action.
                "New Window",
                "Private Window",
                "—",
                "Editor",
                "—",
                "dock.menu.minimize",
                "—",
                "dock.menu.open-at-login",
                "—",
                "dock.menu.close-window",
            ]
        );
        // Shown as confirmed, but not writable here.
        assert!(!rows[7].enabled);
        c.can_launch = false;
        assert_eq!(
            labels(&item_menu(&item(&[], &[], true), &c))[0],
            "dock.menu.open-at-login"
        );
    }

    #[test]
    fn trash_folder_and_minimized_menus() {
        let titles = HashMap::new();
        let mut c = cx(None, &titles);
        let trash = Item {
            key: "trash".into(),
            kind: Kind::Trash,
            label: "Trash".into(),
            windows: vec![],
            minimized: vec![],
        };
        let rows = item_menu(&trash, &c);
        assert_eq!(
            labels(&rows),
            ["dock.menu.open", "—", "settings.dock.dockitem.empty-trash"]
        );
        assert!(rows[2].enabled);
        c.trash_full = false;
        assert!(
            !item_menu(&trash, &c)[2].enabled,
            "an empty Trash cannot be emptied"
        );
        let folder = Item {
            kind: Kind::Folder {
                uri: "file:///home/a/Docs".into(),
            },
            key: "pin:9".into(),
            ..trash.clone()
        };
        assert_eq!(
            item_menu(&folder, &c)[2].command,
            Command::Unpin {
                key: "pin:9".into()
            }
        );
        let minimized = Item {
            kind: Kind::Minimized {
                window: 7,
                app: None,
            },
            ..trash
        };
        assert_eq!(
            labels(&item_menu(&minimized, &c)),
            ["dock.menu.restore", "—", "dock.menu.close-window"]
        );
    }

    #[test]
    fn the_dock_menu_shows_confirmed_preferences() {
        let prefs = Prefs {
            position: Position::Left,
            auto_hide: true,
            ..Default::default()
        };
        let rows = dock_menu(&prefs, false);
        assert_eq!(rows[0].mark, Mark::Check(true));
        assert_eq!(
            rows[0].command,
            Command::Pref {
                key: "dock.autoHide",
                value: PrefValue::Bool(false)
            }
        );
        assert_eq!(rows[5].mark, Mark::Radio(true));
        assert_eq!(rows[4].mark, Mark::Radio(false));
        assert!(
            !rows.last().unwrap().enabled,
            "no Settings page: said, not hidden"
        );
    }
}
