// SPDX-License-Identifier: LGPL-3.0-or-later
//! What the dock shows, in what order (DOCK.md §4): a pure projection of the pin layout,
//! the catalogue and Hyalo's windows. No bus, no Wayland; every rule here is unit-tested.
use std::collections::{BTreeMap, HashMap};

/// One catalogue record, as much of it as the dock reads (APPLICATIONS1-DOCK.md §2).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct App {
    pub id: String,
    pub generation: u64,
    pub name: String,
    pub startup_wm_class: String,
    /// Flatpak's own application ID when Origin is flatpak; empty otherwise.
    pub flatpak_id: String,
    pub launchable: bool,
    /// NewWindowMode is `declared-action` or `relaunch`: 'Nueva ventana' and middle-click.
    pub new_window: bool,
    /// The entry's declared desktop actions, in its order.
    pub actions: Vec<DesktopAction>,
    pub autostart: Autostart,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct DesktopAction {
    pub id: String,
    pub name: String,
}

/// 'Abrir al iniciar sesión' as Applications1 confirms it: never assumed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Autostart {
    pub available: bool,
    pub writable: bool,
    pub enabled: bool,
}

/// A stored layout entry with its stable key (APPLICATIONS1-DOCK.md §6).
#[derive(Clone, Debug, PartialEq)]
pub enum Pin {
    App {
        key: String,
        id: String,
    },
    /// `default-handler:inode/directory`: whatever app opens folders now.
    DefaultDirectory {
        key: String,
    },
    Folder {
        key: String,
        uri: String,
        name: String,
    },
}

/// A window as Hyalo reports it, as much as the dock reads.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Window {
    pub id: u64,
    pub app_id: String,
    pub initial_app_id: String,
    pub title: String,
    pub parent: Option<u64>,
    pub minimized: bool,
    pub minimized_order: u64,
    pub focus_order: u64,
    pub focused: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Inputs<'a> {
    pub apps: &'a [App],
    pub pins: &'a [Pin],
    /// The current inode/directory handler, if any.
    pub default_directory: Option<&'a str>,
    pub windows: &'a [Window],
    /// Hyalo's connection epoch: unknown windows are keyed by it, never reused across it.
    pub hyalo_epoch: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Kind {
    /// A catalogue app; `pinned` says which section it is in.
    App {
        id: String,
        generation: u64,
        launchable: bool,
        pinned: bool,
    },
    /// A pin whose app the catalogue does not have (yet): shown, never launched.
    MissingApp {
        id: String,
    },
    /// Windows no catalogue app claims, grouped by their exact app_id (presentation only).
    Unknown {
        app_id: String,
    },
    Folder {
        uri: String,
    },
    /// One minimized window in the trailing section.
    Minimized {
        window: u64,
        app: Option<String>,
    },
    Trash,
    Separator,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Item {
    /// Stable across views: layout keys, `app:<id>`, `window:<epoch>:<id>`, `trash`.
    pub key: String,
    pub kind: Kind,
    pub label: String,
    /// Live, not minimized windows, most recently focused first.
    pub windows: Vec<u64>,
    /// Its minimized windows, most recently minimized first.
    pub minimized: Vec<u64>,
}
impl Item {
    /// The running dot: live windows, minimized ones included.
    pub fn running(&self) -> bool {
        !self.windows.is_empty() || !self.minimized.is_empty()
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct View {
    pub items: Vec<Item>,
}

/// Who a window belongs to, in the contract's order. `None` = no app or more than one.
pub fn match_window(apps: &[App], w: &Window) -> Option<usize> {
    fn exact(apps: &[App], app_id: &str) -> Option<usize> {
        if app_id.is_empty() {
            return None;
        }
        let tiers: [&dyn Fn(&App) -> bool; 3] = [
            &|a| a.id == app_id || a.id.strip_suffix(".desktop") == Some(app_id),
            &|a| a.startup_wm_class == app_id,
            &|a| !a.flatpak_id.is_empty() && a.flatpak_id == app_id,
        ];
        for tier in tiers {
            let mut hits = apps.iter().enumerate().filter(|(_, a)| tier(a));
            match (hits.next(), hits.next()) {
                (Some((i, _)), None) => return Some(i),
                (Some(_), Some(_)) => return None,
                _ => {}
            }
        }
        None
    }
    exact(apps, &w.app_id).or_else(|| exact(apps, &w.initial_app_id))
}

/// The dock's memory between views: running groups keep the order in which their first
/// live window appeared, until their last window is gone.
#[derive(Debug, Default)]
pub struct Model {
    first_seen: HashMap<String, u64>,
    next: u64,
}

impl Model {
    pub fn view(&mut self, i: &Inputs) -> View {
        let by_id: HashMap<&str, usize> = i
            .apps
            .iter()
            .enumerate()
            .map(|(n, a)| (a.id.as_str(), n))
            .collect();
        let windows: HashMap<u64, &Window> = i.windows.iter().map(|w| (w.id, w)).collect();
        // Group every window: an app index, or its exact app_id when nobody claims it.
        let mut groups: BTreeMap<String, Vec<&Window>> = BTreeMap::new();
        let mut group_app: HashMap<String, usize> = HashMap::new();
        for w in i.windows {
            let key = match match_window(i.apps, w) {
                Some(n) => {
                    let key = format!("app:{}", i.apps[n].id);
                    group_app.insert(key.clone(), n);
                    key
                }
                None if !w.app_id.is_empty() => format!("appid:{}", w.app_id),
                None => format!("window:{}:{}", i.hyalo_epoch, w.id),
            };
            groups.entry(key).or_default().push(w);
        }
        self.first_seen.retain(|k, _| groups.contains_key(k));
        for key in groups.keys() {
            if !self.first_seen.contains_key(key) {
                self.first_seen.insert(key.clone(), self.next);
                self.next += 1;
            }
        }
        let split = |key: &str| -> (Vec<u64>, Vec<u64>) {
            let Some(ws) = groups.get(key) else {
                return (vec![], vec![]);
            };
            let mut live: Vec<&&Window> = ws.iter().filter(|w| !w.minimized).collect();
            live.sort_by_key(|w| std::cmp::Reverse(w.focus_order));
            let mut min: Vec<&&Window> = ws.iter().filter(|w| w.minimized).collect();
            min.sort_by_key(|w| std::cmp::Reverse(w.minimized_order));
            (
                live.iter().map(|w| w.id).collect(),
                min.iter().map(|w| w.id).collect(),
            )
        };

        let mut items = vec![];
        let mut used: Vec<String> = vec![];
        for pin in i.pins {
            let (key, id) = match pin {
                Pin::Folder { key, uri, name } => {
                    items.push(Item {
                        key: key.clone(),
                        kind: Kind::Folder { uri: uri.clone() },
                        label: name.clone(),
                        windows: vec![],
                        minimized: vec![],
                    });
                    continue;
                }
                Pin::App { key, id } => (key, id.as_str()),
                Pin::DefaultDirectory { key } => match i.default_directory {
                    Some(id) => (key, id),
                    // No handler now: the pin stays, as a slot that cannot open anything.
                    None => {
                        items.push(Item {
                            key: key.clone(),
                            kind: Kind::MissingApp { id: String::new() },
                            label: String::new(),
                            windows: vec![],
                            minimized: vec![],
                        });
                        continue;
                    }
                },
            };
            let group = format!("app:{id}");
            // Two pins resolving to one app keep one visible slot (the first).
            if used.contains(&group) {
                continue;
            }
            used.push(group.clone());
            let (windows, minimized) = split(&group);
            items.push(match by_id.get(id) {
                Some(&n) => Item {
                    key: key.clone(),
                    kind: Kind::App {
                        id: id.to_string(),
                        generation: i.apps[n].generation,
                        launchable: i.apps[n].launchable,
                        pinned: true,
                    },
                    label: i.apps[n].name.clone(),
                    windows,
                    minimized,
                },
                None => Item {
                    key: key.clone(),
                    kind: Kind::MissingApp { id: id.to_string() },
                    label: id.trim_end_matches(".desktop").to_string(),
                    windows,
                    minimized,
                },
            });
        }

        let mut running: Vec<(&String, u64)> = groups
            .keys()
            .filter(|k| !used.contains(k))
            .map(|k| (k, self.first_seen[k]))
            .collect();
        running.sort_by_key(|(_, seen)| *seen);
        let mut tail = vec![];
        for (key, _) in running {
            let (windows, minimized) = split(key);
            let first = groups[key][0];
            let (kind, label) = match group_app.get(key) {
                Some(&n) => (
                    Kind::App {
                        id: i.apps[n].id.clone(),
                        generation: i.apps[n].generation,
                        launchable: i.apps[n].launchable,
                        pinned: false,
                    },
                    i.apps[n].name.clone(),
                ),
                None => (
                    Kind::Unknown {
                        app_id: first.app_id.clone(),
                    },
                    first.title.clone(),
                ),
            };
            tail.push(Item {
                key: key.clone(),
                kind,
                label,
                windows,
                minimized,
            });
        }

        // Minimized windows, each its own slot, newest last; a dialog minimized with its
        // minimized parent is folded into the parent's slot.
        let mut min: Vec<&Window> = i
            .windows
            .iter()
            .filter(|w| w.minimized)
            .filter(|w| {
                !w.parent
                    .and_then(|p| windows.get(&p))
                    .is_some_and(|p| p.minimized)
            })
            .collect();
        min.sort_by_key(|w| w.minimized_order);
        let minimized: Vec<Item> = min
            .iter()
            .map(|w| Item {
                key: format!("minimized:{}:{}", i.hyalo_epoch, w.id),
                kind: Kind::Minimized {
                    window: w.id,
                    app: match_window(i.apps, w).map(|n| i.apps[n].id.clone()),
                },
                label: w.title.clone(),
                windows: vec![],
                minimized: vec![w.id],
            })
            .collect();

        let mut out = vec![];
        for section in [items, tail, minimized] {
            if section.is_empty() {
                continue;
            }
            if !out.is_empty() {
                out.push(separator(out.len()));
            }
            out.extend(section);
        }
        if !out.is_empty() {
            out.push(separator(out.len()));
        }
        out.push(Item {
            key: "trash".into(),
            kind: Kind::Trash,
            label: String::new(),
            windows: vec![],
            minimized: vec![],
        });
        View { items: out }
    }
}

fn separator(n: usize) -> Item {
    Item {
        key: format!("separator:{n}"),
        kind: Kind::Separator,
        label: String::new(),
        windows: vec![],
        minimized: vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn app(id: &str) -> App {
        App {
            id: id.into(),
            generation: 1,
            name: id.trim_end_matches(".desktop").into(),
            launchable: true,
            ..Default::default()
        }
    }
    fn win(id: u64, app_id: &str) -> Window {
        Window {
            id,
            app_id: app_id.into(),
            focus_order: id,
            ..Default::default()
        }
    }
    fn pin(id: &str) -> Pin {
        Pin::App {
            key: format!("app:{id}"),
            id: id.into(),
        }
    }
    fn keys(v: &View) -> Vec<&str> {
        v.items.iter().map(|i| i.key.as_str()).collect()
    }
    fn view(apps: &[App], pins: &[Pin], windows: &[Window]) -> View {
        Model::default().view(&Inputs {
            apps,
            pins,
            windows,
            ..Default::default()
        })
    }

    #[test]
    fn matching_follows_the_contract_order_and_never_guesses() {
        let mut steam = app("com.valvesoftware.Steam.desktop");
        steam.startup_wm_class = "steam".into();
        let mut flat = app("org.gnome.Maps.desktop");
        flat.flatpak_id = "org.gnome.Maps".into();
        let apps = [app("firefox.desktop"), steam, flat, app("Foot.desktop")];
        assert_eq!(match_window(&apps, &win(1, "firefox")), Some(0));
        assert_eq!(match_window(&apps, &win(1, "firefox.desktop")), Some(0));
        assert_eq!(match_window(&apps, &win(1, "steam")), Some(1));
        assert_eq!(match_window(&apps, &win(1, "org.gnome.Maps")), Some(2));
        // Case is identity: "foot" is not "Foot".
        assert_eq!(match_window(&apps, &win(1, "foot")), None);
        let mut w = win(1, "");
        w.initial_app_id = "firefox".into();
        assert_eq!(match_window(&apps, &w), Some(0));
        // Two apps claiming the same class: ambiguous, not the first one.
        let mut a = app("a.desktop");
        a.startup_wm_class = "x".into();
        let mut b = app("b.desktop");
        b.startup_wm_class = "x".into();
        assert_eq!(match_window(&[a, b], &win(1, "x")), None);
    }

    #[test]
    fn sections_are_pins_running_minimized_then_trash() {
        let apps = [
            app("files.desktop"),
            app("firefox.desktop"),
            app("foot.desktop"),
        ];
        let pins = [
            Pin::DefaultDirectory {
                key: "default-handler:inode/directory".into(),
            },
            pin("firefox.desktop"),
        ];
        let mut m = win(7, "foot");
        m.minimized = true;
        m.title = "shell".into();
        let v = Model::default().view(&Inputs {
            apps: &apps,
            pins: &pins,
            default_directory: Some("files.desktop"),
            windows: &[win(3, "firefox"), win(5, "foot"), m],
            hyalo_epoch: 2,
        });
        assert_eq!(
            keys(&v),
            [
                "default-handler:inode/directory",
                "app:firefox.desktop",
                "separator:2",
                "app:foot.desktop",
                "separator:4",
                "minimized:2:7",
                "separator:6",
                "trash"
            ]
        );
        assert_eq!(v.items[0].label, "files");
        assert_eq!(v.items[1].windows, [3]);
        // The foot group runs (one live, one minimized) and the minimized one has its slot.
        assert_eq!(
            (v.items[3].windows.clone(), v.items[3].minimized.clone()),
            (vec![5], vec![7])
        );
        assert!(v.items[3].running());
    }

    #[test]
    fn empty_sections_and_their_separators_vanish() {
        assert_eq!(keys(&view(&[], &[], &[])), ["trash"]);
        let apps = [app("a.desktop")];
        assert_eq!(
            keys(&view(&apps, &[pin("a.desktop")], &[])),
            ["app:a.desktop", "separator:1", "trash"]
        );
        assert_eq!(
            keys(&view(&apps, &[], &[win(1, "a")])),
            ["app:a.desktop", "separator:1", "trash"]
        );
    }

    #[test]
    fn running_order_is_first_window_and_focus_never_reorders() {
        let apps = [app("a.desktop"), app("b.desktop")];
        let mut m = Model::default();
        let mut i = Inputs {
            apps: &apps,
            ..Default::default()
        };
        let w1 = [win(1, "b")];
        i.windows = &w1;
        m.view(&i);
        let w2 = [win(1, "b"), win(2, "a")];
        i.windows = &w2;
        assert_eq!(keys(&m.view(&i))[..2], ["app:b.desktop", "app:a.desktop"]);
        // a gets focus: order stays.
        let mut focused = win(2, "a");
        focused.focus_order = 99;
        focused.focused = true;
        let w2b = [win(1, "b"), focused];
        i.windows = &w2b;
        assert_eq!(keys(&m.view(&i))[..2], ["app:b.desktop", "app:a.desktop"]);
        // b's last window goes, then comes back: it is now after a.
        let w3 = [win(2, "a")];
        i.windows = &w3;
        m.view(&i);
        let w4 = [win(2, "a"), win(4, "b")];
        i.windows = &w4;
        assert_eq!(keys(&m.view(&i))[..2], ["app:a.desktop", "app:b.desktop"]);
    }

    #[test]
    fn unknown_windows_group_by_exact_app_id_or_stand_alone() {
        let mut lone = win(9, "");
        lone.title = "untitled".into();
        let v = Model::default().view(&Inputs {
            windows: &[win(1, "mystery"), win(2, "mystery"), lone],
            hyalo_epoch: 5,
            ..Default::default()
        });
        assert_eq!(
            keys(&v),
            ["appid:mystery", "window:5:9", "separator:2", "trash"]
        );
        assert_eq!(v.items[0].windows, [2, 1]);
        assert_eq!(v.items[1].label, "untitled");
    }

    #[test]
    fn pins_never_vanish_and_resolve_to_one_slot() {
        // A pin the catalogue lacks stays visible; two pins for one app keep one slot.
        let apps = [app("files.desktop")];
        let pins = [
            Pin::DefaultDirectory {
                key: "default-handler:inode/directory".into(),
            },
            pin("files.desktop"),
            pin("gone.desktop"),
            Pin::Folder {
                key: "folder:file:///home/u/Docs".into(),
                uri: "file:///home/u/Docs".into(),
                name: "Docs".into(),
            },
        ];
        let v = Model::default().view(&Inputs {
            apps: &apps,
            pins: &pins,
            default_directory: Some("files.desktop"),
            ..Default::default()
        });
        assert_eq!(
            keys(&v),
            [
                "default-handler:inode/directory",
                "app:gone.desktop",
                "folder:file:///home/u/Docs",
                "separator:3",
                "trash"
            ]
        );
        assert_eq!(
            v.items[1].kind,
            Kind::MissingApp {
                id: "gone.desktop".into()
            }
        );
        // No handler at all: the default pin keeps its slot.
        let v = view(&apps, &pins[..1], &[]);
        assert_eq!(v.items[0].kind, Kind::MissingApp { id: String::new() });
    }

    #[test]
    fn a_dialog_minimized_with_its_parent_has_no_slot_of_its_own() {
        let apps = [app("a.desktop")];
        let mut parent = win(1, "a");
        parent.minimized = true;
        parent.minimized_order = 1;
        let mut dialog = win(2, "a");
        dialog.minimized = true;
        dialog.minimized_order = 2;
        dialog.parent = Some(1);
        let mut other = win(3, "a");
        other.minimized = true;
        other.minimized_order = 3;
        let v = view(&apps, &[], &[parent, dialog, other]);
        assert_eq!(
            keys(&v),
            [
                "app:a.desktop",
                "separator:1",
                "minimized:0:1",
                "minimized:0:3",
                "separator:4",
                "trash"
            ]
        );
        // The app's running state still counts all three; newest minimized first.
        assert_eq!(v.items[0].minimized, [3, 2, 1]);
    }
}
