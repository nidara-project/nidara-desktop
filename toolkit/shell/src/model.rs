// SPDX-License-Identifier: LGPL-3.0-or-later
//! What the dock shows, in what order (DOCK.md §4): a pure projection of the pin layout,
//! the catalogue and Hyalo's windows. No bus, no Wayland; every rule here is unit-tested.
use std::collections::{BTreeMap, HashMap};

/// One catalogue record, as much of it as the dock reads (APPLICATIONS1-DOCK.md §2).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct App {
    pub id: String,
    pub raw_icon: String,
    pub generation: u64,
    pub name: String,
    pub startup_wm_class: String,
    /// Flatpak's own application ID when Origin is flatpak; empty otherwise.
    pub flatpak_id: String,
    pub launchable: bool,
    /// SupportsFileDrop: a real file field, independent of D-Bus Open.
    pub opens: bool,
    /// Declared desktop MimeType entries, from Applications1.
    pub mime_types: Vec<String>,
    /// NewWindowMode is `declared-action` or `relaunch`: 'Nueva ventana' and middle-click.
    pub new_window: bool,
    /// The entry's declared desktop actions, in its order.
    pub actions: Vec<DesktopAction>,
    pub autostart: Autostart,
    pub launcher: Launcher,
    /// Listed in Apps (not NoDisplay, Hidden or shown only elsewhere).
    pub visible: bool,
    /// Newly observed, not used or acknowledged yet: Apps marks it.
    pub is_new: bool,
}

/// What the app says of itself through Unity (APPLICATIONS1-DOCK.md §5), as Applications1
/// publishes it: a count or a progress only while the app makes it visible.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Launcher {
    /// Visible and above zero.
    pub count: Option<u64>,
    /// Visible, 0..1.
    pub progress: Option<f64>,
    pub urgent: bool,
}

/// What a slot shows beside its running dot (DOCK.md §6). Attention is Hyalo's flag on
/// any of the slot's windows, or the app's Unity `urgent`: display only, never focus.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Signal {
    pub count: Option<u64>,
    pub progress: Option<f64>,
    pub attention: bool,
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
    /// A pinned file: a click opens it with the default app for its content type.
    File {
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
    /// The daemon's WindowMatch, hydrated for this compositor run. Empty = unknown.
    pub desktop_id: String,
    pub title: String,
    pub parent: Option<u64>,
    pub minimized: bool,
    pub minimized_order: u64,
    pub focus_order: u64,
    pub focused: bool,
    /// Hyalo's `demands_attention`: a refused activation, or X11 urgency.
    pub attention: bool,
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
    /// The default-directory pin with no handler app: shown, never launched.
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
    File {
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
    pub signal: Signal,
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

impl View {
    /// One boundary between nonempty groups, after every local preview/hold is composed.
    /// Boundary identity follows the group on its right, independent of item counts.
    pub fn normalize_sections(&mut self) {
        let mut items = Vec::with_capacity(self.items.len());
        let mut previous = None;
        for item in std::mem::take(&mut self.items) {
            let group = match item.kind {
                Kind::Separator => continue,
                Kind::App { pinned: true, .. } | Kind::MissingApp { .. } => 0,
                Kind::App { pinned: false, .. } | Kind::Unknown { .. } => 1,
                _ => 2,
            };
            if previous.is_some_and(|old| old != group) {
                items.push(separator(group));
            }
            previous = Some(group);
            items.push(item);
        }
        self.items = items;
    }
}

/// Consume Applications1's answer. Identity policy lives exclusively in sessiond.
pub fn resolved_app(apps: &[App], w: &Window) -> Option<usize> {
    apps.iter()
        .position(|a| !w.desktop_id.is_empty() && a.id == w.desktop_id)
}

/// The dock's memory between views: running groups keep the order in which their first
/// live window appeared, until their last window is gone.
#[derive(Debug, Default)]
pub struct Model {
    first_seen: HashMap<String, u64>,
    next: u64,
}

impl Model {
    /// A pin dropped among running groups changes their session order, never the
    /// persistent pin layout's order. Every output receives the same projection.
    pub fn place_running(&mut self, id: &str, before: Option<&str>) {
        let key = format!("app:{id}");
        if !self.first_seen.contains_key(&key) {
            return;
        }
        let mut keys: Vec<_> = self
            .first_seen
            .keys()
            .filter(|k| **k != key)
            .cloned()
            .collect();
        keys.sort_by_key(|k| self.first_seen[k]);
        let at = before
            .and_then(|b| keys.iter().position(|k| k == b))
            .unwrap_or(keys.len());
        keys.insert(at, key);
        for (n, key) in keys.into_iter().enumerate() {
            self.first_seen.insert(key, n as u64);
        }
        self.next = self.first_seen.len() as u64;
    }

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
            let key = match resolved_app(i.apps, w) {
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
        // Pinned folders and files: their own section, after the minimized windows and
        // before the Trash (owner, 2026-11-02), in their stored order.
        let mut places = vec![];
        let mut used: Vec<String> = vec![];
        for pin in i.pins {
            let (key, id) = match pin {
                Pin::Folder { key, uri, name } | Pin::File { key, uri, name } => {
                    places.push(Item {
                        key: key.clone(),
                        kind: match pin {
                            Pin::Folder { .. } => Kind::Folder { uri: uri.clone() },
                            _ => Kind::File { uri: uri.clone() },
                        },
                        label: name.clone(),
                        windows: vec![],
                        minimized: vec![],
                        signal: Default::default(),
                    });
                    continue;
                }
                // A pin whose app is not installed is kept but not shown (#1053): an upgrade
                // briefly removes its entry, and a reinstall brings the pin back. Its
                // windows, if any, show as a running app.
                Pin::App { id, .. } if !by_id.contains_key(id.as_str()) => continue,
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
                            signal: Default::default(),
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
                    signal: Default::default(),
                },
                None => Item {
                    key: key.clone(),
                    kind: Kind::MissingApp { id: id.to_string() },
                    label: id.trim_end_matches(".desktop").to_string(),
                    windows,
                    minimized,
                    signal: Default::default(),
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
                signal: Default::default(),
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
                    app: resolved_app(i.apps, w).map(|n| i.apps[n].id.clone()),
                },
                label: w.title.clone(),
                windows: vec![],
                minimized: vec![w.id],
                signal: Default::default(),
            })
            .collect();

        let mut out: Vec<_> = [items, tail, minimized, places]
            .into_iter()
            .flatten()
            .collect();
        for item in &mut out {
            let launcher = match &item.kind {
                Kind::App { id, .. } => by_id.get(id.as_str()).map(|&n| i.apps[n].launcher),
                _ => None,
            }
            .unwrap_or_default();
            let attention = item
                .windows
                .iter()
                .chain(&item.minimized)
                .any(|w| windows.get(w).is_some_and(|w| w.attention));
            item.signal = Signal {
                count: launcher.count,
                progress: launcher.progress,
                attention: attention || launcher.urgent,
            };
        }
        out.push(Item {
            key: "trash".into(),
            kind: Kind::Trash,
            label: String::new(),
            windows: vec![],
            minimized: vec![],
            signal: Default::default(),
        });
        let mut view = View { items: out };
        view.normalize_sections();
        view
    }
}

fn separator(n: usize) -> Item {
    Item {
        key: format!("separator:{n}"),
        kind: Kind::Separator,
        label: String::new(),
        windows: vec![],
        minimized: vec![],
        signal: Default::default(),
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
            desktop_id: if app_id.is_empty() {
                String::new()
            } else {
                format!("{}.desktop", app_id.trim_end_matches(".desktop"))
            },
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
    fn window_identity_comes_only_from_applications1() {
        let apps = [app("chatgpt.desktop"), app("firefox.desktop")];
        let mut w = win(1, "Chatgpt");
        w.desktop_id.clear();
        assert_eq!(resolved_app(&apps, &w), None);
        w.desktop_id = "firefox.desktop".into();
        assert_eq!(resolved_app(&apps, &w), Some(1));
        w.desktop_id = "missing.desktop".into();
        assert_eq!(resolved_app(&apps, &w), None);
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
                "separator:1",
                "app:foot.desktop",
                "separator:2",
                "minimized:2:7",
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
            ["app:a.desktop", "separator:2", "trash"]
        );
        assert_eq!(
            keys(&view(&apps, &[], &[win(1, "a")])),
            ["app:a.desktop", "separator:2", "trash"]
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
    fn folders_and_files_sit_after_the_minimized_windows() {
        // Pinned apps, running apps, minimized windows, pinned folders and files, Trash
        // (owner, 2026-11-02): a place pinned among the apps still shows on the right.
        let apps = [app("files.desktop"), app("foot.desktop")];
        let place = |kind: &str, uri: &str| {
            let (key, uri, name) = (format!("{kind}:{uri}"), uri.to_string(), String::new());
            if kind == "folder" {
                Pin::Folder { key, uri, name }
            } else {
                Pin::File { key, uri, name }
            }
        };
        let pins = [
            place("file", "file:///home/u/a.pdf"),
            pin("files.desktop"),
            place("folder", "file:///home/u/Docs"),
        ];
        let mut m = win(7, "foot");
        m.minimized = true;
        let v = view(&apps, &pins, &[win(5, "foot"), m]);
        assert_eq!(
            keys(&v),
            [
                "app:files.desktop",
                "separator:1",
                "app:foot.desktop",
                "separator:2",
                "minimized:0:7",
                "file:file:///home/u/a.pdf",
                "folder:file:///home/u/Docs",
                "trash"
            ]
        );
        assert_eq!(
            v.items[5].kind,
            Kind::File {
                uri: "file:///home/u/a.pdf".into()
            }
        );
    }

    #[test]
    fn missing_apps_hide_and_pins_resolve_to_one_slot() {
        // A pin the catalogue lacks is hidden, not dropped (#1053); two pins for one app
        // keep one slot.
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
                "separator:2",
                "folder:file:///home/u/Docs",
                "trash"
            ]
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
                "separator:2",
                "minimized:0:1",
                "minimized:0:3",
                "trash"
            ]
        );
        // The app's running state still counts all three; newest minimized first.
        assert_eq!(v.items[0].minimized, [3, 2, 1]);
    }

    #[test]
    fn signals_come_from_the_app_and_its_windows_only() {
        let mut a = app("a.desktop");
        a.launcher = Launcher {
            count: Some(3),
            progress: Some(0.5),
            urgent: false,
        };
        let mut b = app("b.desktop");
        b.launcher.urgent = true;
        let mut w = win(1, "c");
        w.attention = true;
        let mut hidden = win(2, "a");
        (hidden.minimized, hidden.attention) = (true, true);
        let v = view(
            &[a, b, app("c.desktop")],
            &[pin("a.desktop"), pin("b.desktop")],
            &[w, hidden],
        );
        let at = |key: &str| v.items.iter().find(|i| i.key == key).unwrap().signal;
        assert_eq!(
            at("app:a.desktop"),
            Signal {
                count: Some(3),
                progress: Some(0.5),
                attention: true
            },
            "a minimized window that demands attention marks its app"
        );
        assert_eq!(
            at("minimized:0:2").count,
            None,
            "the count is the app slot's alone"
        );
        assert!(at("minimized:0:2").attention);
        assert!(
            at("app:b.desktop").attention,
            "Unity urgent, no window at all"
        );
        assert!(
            at("app:c.desktop").attention,
            "Hyalo's flag on a running app"
        );
        assert_eq!(at("trash"), Signal::default());
    }
    #[test]
    fn dropping_a_pin_into_running_keeps_windows_and_the_shared_drop_order() {
        let apps = [app("a.desktop"), app("b.desktop"), app("c.desktop")];
        let windows = [win(1, "a"), win(2, "b"), win(3, "c")];
        let pins = [pin("a.desktop")];
        let mut m = Model::default();
        m.view(&Inputs {
            apps: &apps,
            pins: &pins,
            windows: &windows,
            ..Default::default()
        });
        m.place_running("a.desktop", Some("app:c.desktop"));
        let after = m.view(&Inputs {
            apps: &apps,
            windows: &windows,
            ..Default::default()
        });
        assert_eq!(
            keys(&after),
            [
                "app:b.desktop",
                "app:a.desktop",
                "app:c.desktop",
                "separator:2",
                "trash"
            ]
        );
        assert_eq!(after.items[1].windows, [1]);
        // A later focus update cannot undo the position chosen by the drop.
        let again = m.view(&Inputs {
            apps: &apps,
            windows: &windows,
            ..Default::default()
        });
        assert_eq!(after, again);
        // With no windows, an unpinned app has no running slot.
        let gone = m.view(&Inputs {
            apps: &apps,
            windows: &windows[1..],
            ..Default::default()
        });
        assert!(!keys(&gone).contains(&"app:a.desktop"));
    }
}
