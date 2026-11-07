// SPDX-License-Identifier: LGPL-3.0-or-later
//! The bar's tray (B1, #959): the apps' StatusNotifierItems through the session daemon's
//! Tray1 (`session/daemon/src/tray/README.md`, the wire contract). This side is the host:
//! it registers as one, reads the items, finds their icons, and makes the calls a click
//! asks for. Passive items are left out; one that needs attention shows its attention icon.
//!
//! Icons: a themed name is looked up the way GTK would (the interface icon theme, what it
//! inherits, hicolor, the item's own IconThemePath, /usr/share/pixmaps); a name it cannot
//! find, or none, falls back to the item's pixmap (`GetIcon`). A `-symbolic` icon is drawn
//! in the bar's ink. Resolution and decoding use the process-wide icon memory's worker pool.
//!
//! A left click raises the window of the process that owns the item (that process, or one
//! it started), and only when there is none asks the app (`Activate`). An item that is
//! only a menu, or a right click, opens its menu in the shell's own popup; a submenu opens
//! in place of its parent.
use crate::menu::{Command, Label, Mark, Row};
use crate::status::{SESSION, forward, owner, run, signal};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use zbus::blocking::{Connection, MessageIterator};
use zbus::zvariant::{OwnedValue, Value};

pub const ROOT: &str = "/org/nidara/Tray";
pub const IFACE: &str = "org.nidara.Tray1";
/// The bar's 18 px icon at scale 2.
const PIXELS: u32 = 36;
/// How far up a window's process tree its tray item's process may be.
const ANCESTRY: usize = 8;

pub type Props = HashMap<String, OwnedValue>;

/// Asset identity only; decoded pixels belong to the shared icon memory.
#[derive(Clone, Debug, PartialEq)]
pub struct Picture {
    owner: String,
    handle: String,
    generation: u64,
    revision: u64,
    theme: String,
    name: String,
    extra: Vec<PathBuf>,
    attention: bool,
}
impl Picture {
    pub fn asset(&self) -> Option<Arc<crate::icon_memory::Asset>> {
        let memory = crate::icon_memory::global()?;
        let symbolic = self.name.ends_with("-symbolic");
        if !self.attention
            && !symbolic
            && self.extra.is_empty()
            && let Some(key) = memory.app_for_name(&self.name, PIXELS, 1.)
        {
            memory.request(key.clone());
            return memory.get(&key);
        }
        if !self.name.is_empty() {
            let key = memory.named(
                &self.theme,
                &self.name,
                self.extra.clone(),
                PIXELS,
                symbolic,
            );
            memory.request(key.clone());
            if let Some(asset) = memory.get(&key) {
                return Some(asset);
            }
            if !memory.unavailable(&key) {
                return None;
            }
        }
        let key = crate::icon_memory::Key::Tray {
            owner: self.owner.clone(),
            handle: self.handle.clone(),
            generation: self.generation,
            revision: self.revision,
            attention: self.attention,
            side: PIXELS,
            symbolic,
        };
        memory.request(key.clone());
        memory.get(&key)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct TrayItem {
    pub handle: String,
    pub generation: u64,
    pub title: String,
    pub pid: Option<i32>,
    /// The item is only a menu: a left click opens it.
    pub item_is_menu: bool,
    /// It has a menu Tray1 can read.
    pub menu: bool,
    pub icon: Option<Arc<Picture>>,
}

fn text(p: &Props, k: &str) -> String {
    p.get(k)
        .and_then(|v| String::try_from(v.try_clone().ok()?).ok())
        .unwrap_or_default()
}
fn flag(p: &Props, k: &str, default: bool) -> bool {
    p.get(k)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(default)
}
fn number(p: &Props, k: &str) -> Option<u64> {
    p.get(k).and_then(|v| u64::try_from(v).ok())
}
fn int(p: &Props, k: &str) -> Option<i32> {
    p.get(k).and_then(|v| i32::try_from(v).ok())
}

/// The items to show, in Tray1's order: every one but the Passive.
pub fn items_of(
    rows: &[Props],
    mut icon: impl FnMut(&Props, bool) -> Option<Arc<Picture>>,
) -> Vec<TrayItem> {
    rows.iter()
        .filter_map(|p| {
            let status = text(p, "Status");
            if status == "Passive" {
                return None;
            }
            let title = [text(p, "Title"), text(p, "ToolTipTitle"), text(p, "Id")]
                .into_iter()
                .find(|t| !t.is_empty())
                .unwrap_or_default();
            Some(TrayItem {
                handle: text(p, "Handle"),
                generation: number(p, "Generation")?,
                title,
                pid: p
                    .get("OwnerPid")
                    .and_then(|v| u32::try_from(v).ok())
                    .and_then(|v| i32::try_from(v).ok())
                    .filter(|v| *v > 0),
                item_is_menu: flag(p, "ItemIsMenu", false),
                menu: flag(p, "MenuAvailable", false),
                icon: icon(p, status == "NeedsAttention"),
            })
        })
        .collect()
}

/// The window a left click on a tray item raises: one of the item's own process, else one
/// whose process the item's started (up to `ANCESTRY` generations up). Never the other way:
/// the process that started the item's may be the terminal it was run from.
pub fn window_for(
    pid: i32,
    windows: &[(u64, i32)],
    parent: impl Fn(i32) -> Option<i32>,
) -> Option<u64> {
    if let Some((id, _)) = windows.iter().find(|(_, p)| *p == pid) {
        return Some(*id);
    }
    windows.iter().find_map(|(id, p)| {
        let mut at = *p;
        for _ in 0..ANCESTRY {
            at = parent(at)?;
            if at == pid {
                return Some(*id);
            }
            if at <= 1 {
                return None;
            }
        }
        None
    })
}

/// A process's parent, from /proc.
pub fn parent_of(pid: i32) -> Option<i32> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // The command name may hold spaces and parentheses: the fields start after the last ')'.
    stat[stat.rfind(')')? + 1..]
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

/// A dbusmenu label as it reads: `_` marks the mnemonic, `__` is an underscore.
pub fn unmnemonic(label: &str) -> String {
    let mut out = String::new();
    let mut chars = label.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '_' {
            if chars.peek() == Some(&'_') {
                chars.next();
                out.push('_');
            }
            continue;
        }
        out.push(c);
    }
    out
}

/// One level of an item's menu as the shell's popup rows.
pub fn rows_of(rows: &[Props], token: &str, revision: u32) -> Vec<Row> {
    rows.iter()
        .filter(|p| flag(p, "visible", true))
        .filter_map(|p| {
            if text(p, "type") == "separator" {
                return Some(Row {
                    label: Label::Text(String::new()),
                    mark: Mark::Separator,
                    enabled: false,
                    command: Command::None,
                });
            }
            let id = int(p, "Id")?;
            let state = int(p, "toggle-state") == Some(1);
            let mark = match text(p, "toggle-type").as_str() {
                "checkmark" => Mark::Check(state),
                "radio" => Mark::Radio(state),
                _ => Mark::Plain,
            };
            let submenu = text(p, "children-display") == "submenu";
            let mut label = unmnemonic(&text(p, "label"));
            if submenu {
                label.push_str("  ›");
            }
            let limit = flag(p, "LimitReached", false);
            Some(Row {
                label: Label::Text(label),
                mark,
                enabled: flag(p, "enabled", true) && !limit,
                command: if limit {
                    Command::None
                } else {
                    Command::Tray {
                        token: token.to_string(),
                        revision,
                        id,
                        submenu,
                    }
                },
            })
        })
        .collect()
}

/// Watches Tray1 for as long as the shell lives; every change of what shows goes to `emit`.
pub fn watch(conn: &Connection, emit: Sender<Arc<Vec<TrayItem>>>) {
    let conn = conn.clone();
    let _ = std::thread::Builder::new()
        .name("tray".into())
        .spawn(move || {
            let (tx, rx) = channel();
            let rules = [
                signal(SESSION, IFACE, "Changed", ROOT, false),
                signal(
                    SESSION,
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                    ROOT,
                    false,
                ),
                owner(SESSION),
            ];
            let mut iters = vec![];
            for rule in rules.into_iter().flatten() {
                match MessageIterator::for_match_rule(rule, &conn, Some(64)) {
                    Ok(it) => iters.push(it),
                    Err(e) => eprintln!("nidara-shell: the bar cannot watch the tray: {e}"),
                }
            }
            forward(iters, &tx, "tray");
            let mut host: Option<String> = None;
            run(
                "tray",
                &rx,
                || {
                    let owner = owner_of(&conn)?;
                    // A new daemon knows no host: register with it, and forget its handles.
                    if host.as_deref() != Some(owner.as_str()) {
                        call(&conn, "RegisterHost", &())?;
                        host = Some(owner.clone());
                    }
                    let (revision, rows): (u64, Vec<Props>) = call(&conn, "GetSnapshot", &())?
                        .body()
                        .deserialize()
                        .map_err(|e| e.to_string())?;
                    let theme = icon_theme();
                    let items = items_of(&rows, |p, attention| {
                        Some(Arc::new(Picture {
                            owner: host.clone()?,
                            handle: text(p, "Handle"),
                            generation: number(p, "Generation")?,
                            revision,
                            theme: theme.clone(),
                            name: icon_name(p, attention),
                            extra: Some(text(p, "IconThemePath"))
                                .filter(|p| p.starts_with('/'))
                                .map(PathBuf::from)
                                .into_iter()
                                .collect(),
                            attention,
                        }))
                    });
                    Ok(Arc::new(items))
                },
                Arc::new(vec![]),
                |items| {
                    let _ = emit.send(items);
                },
            );
        });
}

fn owner_of(conn: &Connection) -> Result<String, String> {
    conn.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "GetNameOwner",
        &(SESSION,),
    )
    .and_then(|m| m.body().deserialize::<String>())
    .map_err(|e| e.to_string())
}

fn call<B: serde::Serialize + zbus::zvariant::DynamicType>(
    conn: &Connection,
    method: &str,
    body: &B,
) -> Result<zbus::Message, String> {
    conn.call_method(Some(SESSION), ROOT, Some(IFACE), method, body)
        .map_err(|e| format!("Tray1 {method}: {e}"))
}

fn icon_name(p: &Props, attention: bool) -> String {
    let attention_name = text(p, "AttentionIconName");
    if attention && !attention_name.is_empty() {
        attention_name
    } else {
        text(p, "IconName")
    }
}

/// The interface icon theme (`org.gnome.desktop.interface icon-theme`), where apps' themed
/// icons come from.
fn icon_theme() -> String {
    gio::SettingsSchemaSource::default()
        .and_then(|s| s.lookup("org.gnome.desktop.interface", true))
        .filter(|s| s.has_key("icon-theme"))
        .map(|_| {
            use gio::prelude::*;
            gio::Settings::new("org.gnome.desktop.interface")
                .string("icon-theme")
                .to_string()
        })
        .unwrap_or_else(|| "hicolor".into())
}

// What a click asks of an item. Each runs on a worker thread of the caller's.

/// `Activate`, `SecondaryActivate` or `ContextMenu`, at a global logical point.
pub fn point(
    conn: &Connection,
    method: &str,
    item: &TrayItem,
    (x, y): (i32, i32),
) -> Result<(), String> {
    call(conn, method, &(&item.handle, item.generation, x, y)).map(|_| ())
}

pub fn scroll(
    conn: &Connection,
    item: &TrayItem,
    delta: i32,
    horizontal: bool,
) -> Result<(), String> {
    let orientation = if horizontal { "horizontal" } else { "vertical" };
    call(
        conn,
        "Scroll",
        &(&item.handle, item.generation, delta, orientation),
    )
    .map(|_| ())
}

/// The root of an item's menu: a token for its session, and its rows.
pub fn open_menu(conn: &Connection, item: &TrayItem) -> Result<(String, u32, Vec<Props>), String> {
    call(conn, "OpenMenu", &(&item.handle, item.generation, 0i32))?
        .body()
        .deserialize()
        .map_err(|e| e.to_string())
}

pub fn read_menu(conn: &Connection, token: &str, parent: i32) -> Result<(u32, Vec<Props>), String> {
    call(conn, "ReadMenu", &(token, parent))?
        .body()
        .deserialize()
        .map_err(|e| e.to_string())
}

pub fn clicked(conn: &Connection, token: &str, revision: u32, id: i32) -> Result<(), String> {
    call(
        conn,
        "MenuEvent",
        &(token, revision, id, "clicked", Value::from(0i32), 0u32),
    )
    .map(|_| ())
}

pub fn close_menu(conn: &Connection, token: &str) -> Result<(), String> {
    call(conn, "CloseMenu", &(token,)).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(pairs: &[(&str, Value)]) -> Props {
        pairs
            .iter()
            .map(|(k, v)| {
                (
                    k.to_string(),
                    OwnedValue::try_from(v.try_clone().unwrap()).unwrap(),
                )
            })
            .collect()
    }

    #[test]
    fn passive_items_are_left_out_and_the_title_falls_back() {
        let rows = [
            props(&[
                ("Handle", Value::from("a")),
                ("Generation", Value::from(1u64)),
                ("Status", Value::from("Active")),
                ("Id", Value::from("nm-applet")),
                ("OwnerPid", Value::from(42u32)),
                ("MenuAvailable", Value::from(true)),
            ]),
            props(&[
                ("Handle", Value::from("b")),
                ("Generation", Value::from(2u64)),
                ("Status", Value::from("Passive")),
            ]),
        ];
        let mut asked = vec![];
        let items = items_of(&rows, |p, attention| {
            asked.push((text(p, "Handle"), attention));
            None
        });
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "nm-applet");
        assert_eq!(items[0].pid, Some(42));
        assert!(items[0].menu && !items[0].item_is_menu);
        assert_eq!(asked, [("a".to_string(), false)]);
    }

    #[test]
    fn a_click_raises_the_items_own_window_or_one_it_started() {
        // 10 started 11 started 12; 30 started 10 (a terminal, say).
        let parent = |p: i32| match p {
            11 => Some(10),
            12 => Some(11),
            10 => Some(30),
            _ => Some(1),
        };
        assert_eq!(window_for(10, &[(1, 30), (2, 10)], parent), Some(2));
        assert_eq!(window_for(10, &[(1, 12)], parent), Some(1));
        // The terminal that started the app is not the app.
        assert_eq!(window_for(10, &[(1, 30)], parent), None);
        assert!(parent_of(std::process::id() as i32).is_some());
    }

    #[test]
    fn menu_rows_read_as_dbusmenu_means_them() {
        let rows = [
            props(&[
                ("Id", Value::from(1i32)),
                ("label", Value::from("_Open __it")),
            ]),
            props(&[
                ("Id", Value::from(2i32)),
                ("type", Value::from("separator")),
            ]),
            props(&[
                ("Id", Value::from(3i32)),
                ("label", Value::from("Mute")),
                ("toggle-type", Value::from("checkmark")),
                ("toggle-state", Value::from(1i32)),
                ("enabled", Value::from(false)),
            ]),
            props(&[
                ("Id", Value::from(4i32)),
                ("label", Value::from("More")),
                ("children-display", Value::from("submenu")),
            ]),
            props(&[("Id", Value::from(5i32)), ("visible", Value::from(false))]),
        ];
        let out = rows_of(&rows, "t", 7);
        assert_eq!(out.len(), 4);
        assert_eq!(out[0].label, Label::Text("Open _it".into()));
        assert_eq!(
            out[0].command,
            Command::Tray {
                token: "t".into(),
                revision: 7,
                id: 1,
                submenu: false
            }
        );
        assert_eq!(out[1].mark, Mark::Separator);
        assert_eq!(out[2].mark, Mark::Check(true));
        assert!(!out[2].enabled);
        assert_eq!(out[3].label, Label::Text("More  ›".into()));
        assert!(matches!(
            out[3].command,
            Command::Tray { submenu: true, .. }
        ));
    }
}
