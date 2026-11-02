// SPDX-License-Identifier: LGPL-3.0-or-later
//! The bar's tray (B1, #959): the apps' StatusNotifierItems through the session daemon's
//! Tray1 (`session/daemon/src/tray/README.md`, the wire contract). This side is the host:
//! it registers as one, reads the items, finds their icons, and makes the calls a click
//! asks for. Passive items are left out; one that needs attention shows its attention icon.
//!
//! Icons: a themed name is looked up the way GTK would (the interface icon theme, what it
//! inherits, hicolor, the item's own IconThemePath, /usr/share/pixmaps); a name it cannot
//! find, or none, falls back to the item's pixmap (`GetIcon`). A `-symbolic` icon is drawn
//! in the bar's ink. All of it on the watcher's thread, never the bar's.
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

/// Straight (not premultiplied) RGBA.
#[derive(Clone, Debug, PartialEq)]
pub struct Picture {
    pub width: u16,
    pub height: u16,
    pub rgba: Vec<u8>,
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
            let mut cache: HashMap<(String, u64, String), Option<Arc<Picture>>> = HashMap::new();
            run(
                "tray",
                &rx,
                || {
                    let owner = owner_of(&conn)?;
                    // A new daemon knows no host: register with it, and forget its handles.
                    if host.as_deref() != Some(owner.as_str()) {
                        call(&conn, "RegisterHost", &())?;
                        host = Some(owner);
                        cache.clear();
                    }
                    let (_, rows): (u64, Vec<Props>) = call(&conn, "GetSnapshot", &())?
                        .body()
                        .deserialize()
                        .map_err(|e| e.to_string())?;
                    let theme = icon_theme();
                    let items = items_of(&rows, |p, attention| {
                        let name = icon_name(p, attention);
                        let key = (text(p, "Handle"), number(p, "Generation")?, name.clone());
                        cache
                            .entry(key)
                            .or_insert_with(|| {
                                picture(&conn, &theme, p, &name, attention).map(Arc::new)
                            })
                            .clone()
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

fn picture(
    conn: &Connection,
    theme: &str,
    p: &Props,
    name: &str,
    attention: bool,
) -> Option<Picture> {
    let extra: Vec<PathBuf> = Some(text(p, "IconThemePath"))
        .filter(|t| t.starts_with('/'))
        .map(PathBuf::from)
        .into_iter()
        .collect();
    let themed = nk_icons::find_app_icon(theme, name, PIXELS, &nk_icons::search_path(), &extra)
        .and_then(|path| load(&path));
    let mut pic = match themed {
        Some(pic) => pic,
        None => {
            let kind = if attention { "attention" } else { "normal" };
            let (w, h, rgba): (u32, u32, Vec<u8>) = conn
                .call_method(
                    Some(SESSION),
                    ROOT,
                    Some(IFACE),
                    "GetIcon",
                    &(text(p, "Handle"), number(p, "Generation")?, kind, PIXELS),
                )
                .ok()?
                .body()
                .deserialize()
                .ok()?;
            let (width, height) = (u16::try_from(w).ok()?, u16::try_from(h).ok()?);
            (rgba.len() == usize::from(width) * usize::from(height) * 4).then_some(Picture {
                width,
                height,
                rgba,
            })?
        }
    };
    if name.ends_with("-symbolic") {
        // Drawn in the bar's ink: white, keeping the drawing's alpha.
        for px in pic.rgba.as_chunks_mut::<4>().0 {
            px[..3].fill(255);
        }
    }
    Some(pic)
}

/// An SVG drawn at the bar's size, or a PNG as it is (the bar scales it).
fn load(path: &std::path::Path) -> Option<Picture> {
    let bytes = std::fs::read(path).ok()?;
    if path.extension().is_some_and(|e| e == "svg") {
        let tree = resvg::usvg::Tree::from_data(&bytes, &resvg::usvg::Options::default()).ok()?;
        let size = tree.size();
        let scale = PIXELS as f32 / size.width().max(size.height());
        let mut pixmap = resvg::tiny_skia::Pixmap::new(PIXELS, PIXELS)?;
        let dx = (PIXELS as f32 - size.width() * scale) / 2.;
        let dy = (PIXELS as f32 - size.height() * scale) / 2.;
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::from_scale(scale, scale).post_translate(dx, dy),
            &mut pixmap.as_mut(),
        );
        let rgba = pixmap
            .pixels()
            .iter()
            .flat_map(|p| {
                let c = p.demultiply();
                [c.red(), c.green(), c.blue(), c.alpha()]
            })
            .collect();
        return Some(Picture {
            width: PIXELS as u16,
            height: PIXELS as u16,
            rgba,
        });
    }
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()?];
    let info = reader.next_frame(&mut buf).ok()?;
    let px = &buf[..info.buffer_size()];
    let rgba: Vec<u8> = match info.color_type {
        png::ColorType::Rgba => px.to_vec(),
        png::ColorType::Rgb => px
            .as_chunks::<3>()
            .0
            .iter()
            .flat_map(|c| [c[0], c[1], c[2], 255])
            .collect(),
        png::ColorType::GrayscaleAlpha => px
            .as_chunks::<2>()
            .0
            .iter()
            .flat_map(|c| [c[0], c[0], c[0], c[1]])
            .collect(),
        png::ColorType::Grayscale => px.iter().flat_map(|g| [*g, *g, *g, 255]).collect(),
        png::ColorType::Indexed => return None,
    };
    Some(Picture {
        width: u16::try_from(info.width).ok()?,
        height: u16::try_from(info.height).ok()?,
        rgba,
    })
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
