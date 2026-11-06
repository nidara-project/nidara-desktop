// SPDX-License-Identifier: LGPL-3.0-or-later
//! Drops from other apps (D3, APPLICATIONS1-DOCK.md §9 "Drag sources, drops"): files and
//! folders dragged from a file manager as `text/uri-list`. Over the right-hand side of the
//! strip (from the separator after the last app or minimized window on) they are pinned
//! there, in the folders' and files' section, which opens a slot where they would land; over
//! an app that opens files, the whole of its icon included,
//! that app opens them. Anywhere else the drag is refused, and the source shows it. Nothing
//! happens while hovering: the edit or the launch is made at the drop.
//!
//! An app dragged from Apps (`nidara_shell_ipc::drag`, D4) opens a slot among the pinned
//! apps, up to half a slot past the last one, and is pinned there at the drop; what it
//! names is checked against the dock's own catalogue first. Already pinned, nothing
//! changes (EditLayout's insert is a no-op).
use crate::model::{Item, Kind, Signal, View};
use crate::reorder::{aim, section};
use std::path::PathBuf;

/// Files and folders.
pub const URI_LIST: &str = "text/uri-list";
/// An app from Apps.
pub const APP: &str = nidara_shell_ipc::drag::APP_MIME;

/// What a drag over the strip carries, of what the dock takes.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Offer {
    Files,
    App,
}

/// The kind of drag offering `mimes`; an app first, when a source offers both.
pub fn offer(mimes: &[String]) -> Option<Offer> {
    if mimes.iter().any(|m| m == APP) {
        Some(Offer::App)
    } else if mimes.iter().any(|m| m == URI_LIST) {
        Some(Offer::Files)
    } else {
        None
    }
}

impl Offer {
    pub fn mime(self) -> &'static str {
        match self {
            Offer::Files => URI_LIST,
            Offer::App => APP,
        }
    }
}
/// The open slot's key: never a layout key.
pub const KEY: &str = "drop:";
/// At most this many URIs are taken from one drop (Applications1's bound for Open).
pub const MAX_URIS: usize = 128;

/// Where a drop would go now.
#[derive(Clone, Debug, PartialEq)]
pub enum Target {
    /// Pinned in the folders' and files' section, at this place in it.
    Pin(usize),
    /// An app from Apps, pinned among the pinned apps at this place.
    PinApp(usize),
    /// Opened by this app.
    Open {
        id: String,
        generation: u64,
    },
    None,
}

/// What the drop over `view` as drawn (`hits`) at `along` would do. `opens` says whether an
/// app opens files. Past the end of the last app, running app or minimized window — over the
/// separator that follows it — it pins; never over half an icon, as a pin being moved does,
/// because a file over an app is the app's to open. The slot that opens there leaves
/// everything left of it where it was, so the answer holds while the pointer stays in it.
pub fn target(
    view: &View,
    hits: &[[f64; 4]],
    horizontal: bool,
    along: f64,
    files: &[String],
    opens: impl Fn(&str) -> bool,
) -> Target {
    if files.is_empty() {
        return Target::None;
    }
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
        along >= a + len
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

/// Where an app from Apps dropped at `along` would be pinned: among the pinned apps, up to
/// half a slot past the last one (as a running app picked up from the strip).
pub fn app_target(view: &View, hits: &[[f64; 4]], horizontal: bool, along: f64) -> Target {
    match aim(view, false, hits, horizontal, KEY, along) {
        (to, true) => Target::PinApp(to),
        _ => Target::None,
    }
}

/// `view` with an app's open slot at `to` among the pinned apps; with none pinned yet, the
/// slot comes with the separator that ends that section.
pub fn preview_app(view: &View, to: usize) -> View {
    let mut items = view.items.clone();
    let range = section(view, false);
    let slot = item(KEY, Kind::MissingApp { id: String::new() });
    if range.is_empty() {
        let lone = items.first().is_none_or(|i| i.kind != Kind::Separator);
        items.insert(0, slot);
        if lone {
            items.insert(1, item("drop:separator", Kind::Separator));
        }
    } else {
        items.insert(range.start + to.min(range.len()), slot);
    }
    View { items }
}

/// How many pins the section a pinning drop goes into holds in `view`; None for a drop
/// that pins nothing.
pub fn pins(view: &View, target: &Target) -> Option<usize> {
    match target {
        Target::Pin(_) => Some(section(view, true).len()),
        Target::PinApp(_) => Some(section(view, false).len()),
        _ => None,
    }
}

/// Whether the service's `view` has what a drop pinned: its section holds more pins than
/// the `before` it held at the drop. Until then the dock keeps the slot open.
pub fn landed(view: &View, target: &Target, before: usize) -> bool {
    pins(view, target).is_none_or(|now| now > before)
}

/// The pinned app a drop at `to` goes before (None: at the end of the pinned apps).
pub fn before_app(view: &View, to: usize) -> Option<String> {
    let range = section(view, false);
    view.items[range]
        .iter()
        .filter(|i| i.key != KEY)
        .nth(to)
        .map(|i| i.key.clone())
}

/// `view` with the open slot at `to` in the folders' and files' section; that section
/// and its separator come with it when there is none yet.
pub fn preview(view: &View, to: usize) -> View {
    let mut items = view.items.clone();
    let range = section(view, true);
    if range.is_empty() {
        // Places share the right-hand section with minimized windows and Trash.
        let at = items
            .iter()
            .position(|i| i.kind == Kind::Trash)
            .unwrap_or(items.len());
        items.insert(at, slot());
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
/// blank lines are ignored. Invalid/non-local items or exceeded bounds reject the
/// whole list: never silently lose one item from an open request.
pub fn uris(data: &[u8]) -> Vec<String> {
    let Ok(text) = std::str::from_utf8(data) else {
        return Vec::new();
    };
    let lines: Vec<_> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .collect();
    if lines.len() > MAX_URIS
        || lines.iter().any(|l| path(l).is_none())
        || lines.iter().map(|l| l.len()).sum::<usize>() > 256 * 1024
    {
        return Vec::new();
    }
    lines.into_iter().map(str::to_owned).collect()
}

/// The local path a `file:` URI names (`file:///p` or `file://localhost/p`,
/// percent-decoded); None for anything else.
pub fn path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') || rest.contains(['?', '#']) {
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
        }
        items.push(item("trash", Kind::Trash));
        View { items }
    }
    #[test]
    fn a_drop_lands_once_its_section_has_one_more_pin() {
        let v = view(true);
        let places = Target::Pin(1);
        let before = pins(&v, &places).unwrap();
        assert_eq!(before, 1);
        // The service has not answered yet: the slot stays open.
        assert!(!landed(&v, &places, before));
        let mut after = v.clone();
        let at = after
            .items
            .iter()
            .position(|i| i.key == "folder:x")
            .unwrap();
        after
            .items
            .insert(at + 1, item("file:y", Kind::File { uri: "y".into() }));
        assert!(landed(&after, &places, before));
        // A running app pinned from Apps moves into the pins: that section grows too.
        let apps = Target::PinApp(2);
        let before = pins(&v, &apps).unwrap();
        let mut after = v.clone();
        let r = after.items.iter().position(|i| i.key == "r").unwrap();
        after.items.remove(r);
        after.items.insert(2, app("r", true));
        assert!(!landed(&v, &apps, before));
        assert!(landed(&after, &apps, before));
        // A drop that opens files pins nothing and holds nothing.
        let open = Target::Open {
            id: "a".into(),
            generation: 1,
        };
        assert!(landed(&v, &open, 0));
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
        assert_eq!(
            target(
                &v,
                &h,
                true,
                centre(&v, 1),
                &["file:///fixture".into()],
                |id| id == "b"
            ),
            open
        );
        // One that does not: refused.
        assert_eq!(
            target(
                &v,
                &h,
                true,
                centre(&v, 0),
                &["file:///fixture".into()],
                |id| id == "b"
            ),
            Target::None
        );
        // The last running app, all of it: past its centre too, it opens.
        let r = Target::Open {
            id: "r".into(),
            generation: 1,
        };
        assert_eq!(
            target(
                &v,
                &h,
                true,
                centre(&v, 3) - 4.,
                &["file:///fixture".into()],
                |_| true
            ),
            r
        );
        let [x, _, w, _] = h[3];
        assert_eq!(
            target(
                &v,
                &h,
                true,
                x + w - 0.5,
                &["file:///fixture".into()],
                |_| true
            ),
            r
        );
        // Over the separator after it, pinned.
        assert_eq!(
            target(
                &v,
                &h,
                true,
                centre(&v, 4),
                &["file:///fixture".into()],
                |_| true
            ),
            Target::Pin(0)
        );
    }

    #[test]
    fn on_the_right_it_pins_where_the_slot_opens() {
        let v = view(true);
        let h = hits(&v);
        // Before the folder, then after it, then over the Trash: at the end.
        assert_eq!(
            target(
                &v,
                &h,
                true,
                centre(&v, 5) - 8.,
                &["file:///fixture".into()],
                |_| false
            ),
            Target::Pin(0)
        );
        assert_eq!(
            target(
                &v,
                &h,
                true,
                centre(&v, 5) + 8.,
                &["file:///fixture".into()],
                |_| false
            ),
            Target::Pin(1)
        );
        assert_eq!(
            target(
                &v,
                &h,
                true,
                centre(&v, 6),
                &["file:///fixture".into()],
                |_| false
            ),
            Target::Pin(1)
        );
        assert_eq!(keys(&preview(&v, 0))[5..], ["drop:", "folder:x", "trash"]);
        assert_eq!(before(&v, 0).as_deref(), Some("folder:x"));
        assert_eq!(before(&v, 1), None);
        // Held where it opened: the pointer in the slot still lands there.
        let p = preview(&v, 0);
        assert_eq!(
            target(
                &p,
                &hits(&p),
                true,
                centre(&p, 5),
                &["file:///fixture".into()],
                |_| false
            ),
            Target::Pin(0)
        );
    }

    #[test]
    fn with_no_folders_the_section_opens_before_the_trash() {
        let v = view(false);
        assert_eq!(
            keys(&preview(&v, 0)),
            ["a", "b", "sep", "r", "sep2", "drop:", "trash"]
        );
        assert_eq!(before(&v, 0), None);
        let p = preview(&v, 0);
        assert_eq!(
            target(
                &p,
                &hits(&p),
                true,
                centre(&p, 5),
                &["file:///fixture".into()],
                |_| false
            ),
            Target::Pin(0)
        );
    }

    #[test]
    fn an_app_from_apps_opens_a_slot_among_the_pins() {
        let v = view(true);
        let h = hits(&v);
        assert_eq!(
            app_target(&v, &h, true, centre(&v, 0) - 8.),
            Target::PinApp(0)
        );
        assert_eq!(
            app_target(&v, &h, true, centre(&v, 0) + 8.),
            Target::PinApp(1)
        );
        assert_eq!(
            app_target(&v, &h, true, centre(&v, 1) + 8.),
            Target::PinApp(2)
        );
        // Over the running app, past half a slot after the last pin: refused.
        assert_eq!(app_target(&v, &h, true, centre(&v, 3)), Target::None);
        assert_eq!(keys(&preview_app(&v, 1))[..4], ["a", "drop:", "b", "sep"]);
        assert_eq!(before_app(&v, 1).as_deref(), Some("b"));
        assert_eq!(before_app(&v, 2), None);
        // Held: the pointer in the slot keeps it there.
        let p = preview_app(&v, 1);
        assert_eq!(
            app_target(&p, &hits(&p), true, centre(&p, 1)),
            Target::PinApp(1)
        );
        // With no pins, the section opens first, with its separator.
        let bare = View {
            items: v.items[3..].to_vec(),
        };
        assert_eq!(
            keys(&preview_app(&bare, 0))[..3],
            ["drop:", "drop:separator", "r"]
        );
        assert_eq!(offer(&[URI_LIST.into(), APP.into()]), Some(Offer::App));
        assert_eq!(offer(&["text/plain".into()]), None);
    }

    #[test]
    fn minimized_slots_are_not_place_drop_targets_or_internal_boundaries() {
        let mut v = View {
            items: vec![
                app("a", true),
                item(
                    "min",
                    Kind::Minimized {
                        window: 1,
                        app: None,
                    },
                ),
                item("trash", Kind::Trash),
            ],
        };
        v.normalize_sections();
        let n = v.items.iter().position(|i| i.key == "min").unwrap();
        assert_eq!(
            target(
                &v,
                &hits(&v),
                true,
                centre(&v, n),
                &["file:///fixture".into()],
                |_| false
            ),
            Target::None
        );
        let p = preview(&v, 0);
        assert_eq!(keys(&p), ["a", "separator:2", "min", "drop:", "trash"]);
        assert_eq!(before(&v, 0), None);
        assert_eq!(
            target(
                &p,
                &hits(&p),
                true,
                centre(&p, n + 1),
                &["file:///fixture".into()],
                |_| false
            ),
            Target::Pin(0)
        );
    }

    #[test]
    fn a_slow_or_unknown_offer_has_no_target_even_over_the_pinning_zone() {
        let v = view(true);
        assert_eq!(
            target(&v, &hits(&v), true, centre(&v, 0), &[], |_| true),
            Target::None
        );
        assert_eq!(
            target(&v, &hits(&v), true, centre(&v, 5), &[], |_| true),
            Target::None
        );
    }

    #[test]
    fn only_local_files_are_taken() {
        let list = b"# from a file manager\r\nfile:///home/u/My%20Docs\r\nhttps://x.org/a\r\nfile://localhost/tmp/a.pdf\r\nfile://host/x\r\n\r\nfile:///bad%00\r\n";
        assert_eq!(uris(list), Vec::<String>::new());
        assert_eq!(
            path("file:///home/u/My%20Docs"),
            Some(PathBuf::from("/home/u/My Docs"))
        );
        assert_eq!(path("file:///a%2"), None);
        assert_eq!(path("file:///a#fragment"), None);
        assert_eq!(
            uris(b"# comment\r\nfile:///a%20b\r\nfile:///c\n"),
            ["file:///a%20b", "file:///c"]
        );
        assert!(uris(b"file:///a\nfile://host/b\n").is_empty());
        assert!(uris(&[255]).is_empty());
        assert!(uris("file:///a\n".repeat(MAX_URIS + 1).as_bytes()).is_empty());
    }
}
