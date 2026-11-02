// SPDX-License-Identifier: LGPL-3.0-or-later
//! Drops from other apps (D3, APPLICATIONS1-DOCK.md §9 "Drag sources, drops"): files and
//! folders dragged from a file manager as `text/uri-list`. Over the right-hand side of the
//! strip (past the last app or minimized window) they are pinned there, in the folders' and
//! files' section, which opens a slot where they would land; over an app that opens files,
//! that app opens them. Anywhere else the drag is refused, and the source shows it. Nothing
//! happens while hovering: the edit or the launch is made at the drop.
use crate::model::{Item, Kind, Signal, View};
use crate::reorder::{aim, section};
use std::path::PathBuf;

/// The only type the dock takes.
pub const URI_LIST: &str = "text/uri-list";
/// The open slot's key: never a layout key.
pub const KEY: &str = "drop:";
/// At most this many URIs are taken from one drop (Applications1's bound for Open).
pub const MAX_URIS: usize = 128;

/// Where a drop would go now.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// Pinned in the folders' and files' section, at this place in it.
    Pin(usize),
    /// Opened by this app.
    Open {
        id: String,
        generation: u64,
    },
    None,
}

/// What the drop over `view` as drawn (`hits`) at `along` would do. `opens` says whether an
/// app opens files. Past the centre of the last app, running app or minimized window, it
/// pins: the slot that opens there leaves everything left of it where it was, so the
/// answer holds while the pointer stays in it.
pub fn target(
    view: &View,
    hits: &[[f64; 4]],
    horizontal: bool,
    along: f64,
    opens: impl Fn(&str) -> bool,
) -> Target {
    let span = |n: usize| {
        let [x, y, w, h] = hits[n];
        if horizontal { (x, w) } else { (y, h) }
    };
    let last = view.items.iter().rposition(|i| {
        matches!(
            i.kind,
            Kind::App { .. }
                | Kind::MissingApp { .. }
                | Kind::Unknown { .. }
                | Kind::Minimized { .. }
        )
    });
    let pins = last.is_none_or(|n| {
        let (a, len) = span(n);
        along > a + len / 2.
    });
    if pins {
        return Target::Pin(aim(view, true, hits, horizontal, KEY, along).0);
    }
    let over = (0..view.items.len()).find(|&n| {
        let (a, len) = span(n);
        along >= a && along < a + len
    });
    match over.map(|n| &view.items[n].kind) {
        Some(Kind::App {
            id,
            generation,
            launchable: true,
            ..
        }) if opens(id) => Target::Open {
            id: id.clone(),
            generation: *generation,
        },
        _ => Target::None,
    }
}

/// `view` with the open slot at `to` in the folders' and files' section; that section
/// and its separator come with it when there is none yet.
pub fn preview(view: &View, to: usize) -> View {
    let mut items = view.items.clone();
    let range = section(view, true);
    if range.is_empty() {
        // [… section, separator, Trash] → [… section, separator, slot, separator, Trash].
        let at = items
            .iter()
            .position(|i| i.kind == Kind::Trash)
            .unwrap_or(items.len());
        items.insert(at, slot());
        items.insert(at + 1, item("drop:separator", Kind::Separator));
    } else {
        items.insert(range.start + to.min(range.len()), slot());
    }
    View { items }
}

fn slot() -> Item {
    item(KEY, Kind::File { uri: String::new() })
}

fn item(key: &str, kind: Kind) -> Item {
    Item {
        key: key.into(),
        kind,
        label: String::new(),
        windows: vec![],
        minimized: vec![],
        signal: Signal::default(),
    }
}

/// The pin a drop at `to` goes before (None: at the end of the section).
pub fn before(view: &View, to: usize) -> Option<String> {
    let range = section(view, true);
    view.items[range]
        .iter()
        .filter(|i| i.key != KEY)
        .nth(to)
        .map(|i| i.key.clone())
}

/// The local file URIs of a `text/uri-list`, in order, at most `MAX_URIS`: comments,
/// blank lines and anything not a local `file:` URI are left out.
pub fn uris(data: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(data)
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter(|l| path(l).is_some())
        .take(MAX_URIS)
        .map(str::to_owned)
        .collect()
}

/// The local path a `file:` URI names (`file:///p` or `file://localhost/p`,
/// percent-decoded); None for anything else.
pub fn path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut n = 0;
    while n < bytes.len() {
        if bytes[n] == b'%' {
            let hex = std::str::from_utf8(bytes.get(n + 1..n + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            n += 3;
        } else {
            out.push(bytes[n]);
            n += 1;
        }
    }
    if out.contains(&0) {
        return None;
    }
    use std::os::unix::ffi::OsStringExt;
    Some(PathBuf::from(std::ffi::OsString::from_vec(out)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::geometry::{Position, Slot, layout};

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
    fn view(places: bool) -> View {
        let mut items = vec![
            app("a", true),
            app("b", true),
            item("sep", Kind::Separator),
            app("r", false),
            item("sep2", Kind::Separator),
        ];
        if places {
            items.push(item("folder:x", Kind::Folder { uri: "x".into() }));
            items.push(item("sep3", Kind::Separator));
        }
        items.push(item("trash", Kind::Trash));
        View { items }
    }
    fn hits(v: &View) -> Vec<[f64; 4]> {
        let slots: Vec<_> = v
            .items
            .iter()
            .map(|i| match i.kind {
                Kind::Separator => Slot::Separator,
                _ => Slot::Icon,
            })
            .collect();
        layout(&slots, 64, Position::Bottom, (2560, 1440), 0.).hits
    }
    fn centre(v: &View, n: usize) -> f64 {
        let [x, _, w, _] = hits(v)[n];
        x + w / 2.
    }
    fn keys(v: &View) -> Vec<&str> {
        v.items.iter().map(|i| i.key.as_str()).collect()
    }

    #[test]
    fn over_an_app_that_opens_files_it_opens_them() {
        let v = view(true);
        let h = hits(&v);
        let open = Target::Open {
            id: "b".into(),
            generation: 1,
        };
        assert_eq!(target(&v, &h, true, centre(&v, 1), |id| id == "b"), open);
        // One that does not: refused.
        assert_eq!(
            target(&v, &h, true, centre(&v, 0), |id| id == "b"),
            Target::None
        );
        // The running app's left half too; past its centre, pinned.
        assert_eq!(
            target(&v, &h, true, centre(&v, 3) - 4., |_| true).clone(),
            Target::Open {
                id: "r".into(),
                generation: 1
            }
        );
        assert_eq!(
            target(&v, &h, true, centre(&v, 3) + 4., |_| true),
            Target::Pin(0)
        );
    }

    #[test]
    fn on_the_right_it_pins_where_the_slot_opens() {
        let v = view(true);
        let h = hits(&v);
        // Before the folder, then after it, then over the Trash: at the end.
        assert_eq!(
            target(&v, &h, true, centre(&v, 5) - 8., |_| false),
            Target::Pin(0)
        );
        assert_eq!(
            target(&v, &h, true, centre(&v, 5) + 8., |_| false),
            Target::Pin(1)
        );
        assert_eq!(
            target(&v, &h, true, centre(&v, 7), |_| false),
            Target::Pin(1)
        );
        assert_eq!(
            keys(&preview(&v, 0))[5..],
            ["drop:", "folder:x", "sep3", "trash"]
        );
        assert_eq!(before(&v, 0).as_deref(), Some("folder:x"));
        assert_eq!(before(&v, 1), None);
        // Held where it opened: the pointer in the slot still lands there.
        let p = preview(&v, 0);
        assert_eq!(
            target(&p, &hits(&p), true, centre(&p, 5), |_| false),
            Target::Pin(0)
        );
    }

    #[test]
    fn with_no_folders_the_section_opens_before_the_trash() {
        let v = view(false);
        assert_eq!(
            keys(&preview(&v, 0)),
            [
                "a",
                "b",
                "sep",
                "r",
                "sep2",
                "drop:",
                "drop:separator",
                "trash"
            ]
        );
        assert_eq!(before(&v, 0), None);
        let p = preview(&v, 0);
        assert_eq!(
            target(&p, &hits(&p), true, centre(&p, 5), |_| false),
            Target::Pin(0)
        );
    }

    #[test]
    fn only_local_files_are_taken() {
        let list = b"# from a file manager\r\nfile:///home/u/My%20Docs\r\nhttps://x.org/a\r\nfile://localhost/tmp/a.pdf\r\nfile://host/x\r\n\r\nfile:///bad%00\r\n";
        assert_eq!(
            uris(list),
            ["file:///home/u/My%20Docs", "file://localhost/tmp/a.pdf"]
        );
        assert_eq!(
            path("file:///home/u/My%20Docs"),
            Some(PathBuf::from("/home/u/My Docs"))
        );
        assert_eq!(path("file:///a%2"), None);
    }
}
