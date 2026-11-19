// SPDX-License-Identifier: LGPL-3.0-or-later
//! Compositions shared by file choosers and browsers.
use crate::{
    Align, Button, Column, Image, Ink, Key, Label, ListSource, ListView, Node, Row, RowInfo,
    SidebarEntry, SidebarList, Space, Value, prelude::*,
};
use nk_files::{Entry, Place, PlaceKind};
use nk_text::TextStyle;
use std::{
    collections::{BTreeSet, HashMap},
    path::{Path, PathBuf},
};

/// The places as a window's sidebar (the kit's one sidebar, `SidebarList`): home and the
/// user's folders, bookmarks, drives, each under its heading, the current folder selected.
#[must_use]
pub struct PlacesSidebar<'a> {
    key: Key,
    places: &'a [Place],
    action: String,
    style: TextStyle,
    heading: TextStyle,
    glyph: f64,
    current: Option<&'a Path>,
    headings: [&'a str; 3],
}

impl<'a> PlacesSidebar<'a> {
    /// Entries in `style` with glyphs at `glyph` (the frame's, as any sidebar's), headings in
    /// `heading` (the caption type).
    pub fn new(
        key: impl Into<Key>,
        places: &'a [Place],
        action: impl Into<String>,
        style: TextStyle,
        heading: TextStyle,
        glyph: f64,
    ) -> Self {
        Self {
            key: key.into(),
            places,
            action: action.into(),
            style,
            heading,
            glyph,
            current: None,
            headings: ["Places", "Bookmarks", "Drives"],
        }
    }
    pub fn current(mut self, path: &'a Path) -> Self {
        self.current = Some(path);
        self
    }
    pub fn headings(mut self, headings: [&'a str; 3]) -> Self {
        self.headings = headings;
        self
    }
}

impl From<PlacesSidebar<'_>> for Node {
    fn from(sidebar: PlacesSidebar<'_>) -> Self {
        let mut list = SidebarList::new(sidebar.key.clone());
        for (section, heading) in sidebar.headings.into_iter().enumerate() {
            let entries = sidebar
                .places
                .iter()
                .enumerate()
                .filter_map(|(index, place)| {
                    let (group, icon) = match place.kind {
                        PlaceKind::Home => (0, "nd-home"),
                        PlaceKind::UserDir => (0, "nd-folder"),
                        PlaceKind::Bookmark => (1, "nd-bookmarks"),
                        PlaceKind::Drive => (2, "nd-drive-harddisk"),
                    };
                    (group == section).then(|| {
                        SidebarEntry::new(
                            format!("{}/place/{index}", sidebar.key.0),
                            &place.name,
                            icon,
                            &sidebar.action,
                            sidebar.style.clone(),
                            sidebar.glyph,
                        )
                        .selected(
                            place
                                .path()
                                .is_some_and(|path| Some(path) == sidebar.current),
                        )
                        .enabled(place.path().is_some())
                        .value(Value::Index(index))
                    })
                })
                .collect::<Vec<_>>();
            list = list.section(heading, sidebar.heading.clone(), entries);
        }
        list.into()
    }
}

/// Breadcrumb buttons. The reported index identifies a path from `locations`.
#[must_use]
pub struct PathBar<'a> {
    key: Key,
    path: &'a Path,
    action: String,
    style: TextStyle,
}
impl<'a> PathBar<'a> {
    pub fn new(
        key: impl Into<Key>,
        path: &'a Path,
        action: impl Into<String>,
        style: TextStyle,
    ) -> Self {
        Self {
            key: key.into(),
            path,
            action: action.into(),
            style,
        }
    }

    pub fn locations(path: &Path) -> Vec<PathBuf> {
        let mut paths: Vec<_> = path
            .ancestors()
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .collect();
        paths.reverse();
        paths
    }
}
impl From<PathBar<'_>> for Node {
    fn from(bar: PathBar<'_>) -> Self {
        let paths = PathBar::locations(bar.path);
        let buttons = paths
            .iter()
            .enumerate()
            .map(|(index, path)| {
                let text = path
                    .file_name()
                    .map_or_else(|| path.to_string_lossy(), |name| name.to_string_lossy());
                Button::new(
                    format!("{}/part/{index}", bar.key.0),
                    text.as_ref(),
                    &bar.action,
                    bar.style.clone(),
                )
                .value(Value::Index(index))
                .into()
            })
            .collect();
        Row::new(bar.key, buttons).gap(Space::S1).into()
    }
}

struct FileRows<'a> {
    entries: &'a [Entry],
    style: TextStyle,
    zone: jiff::tz::TimeZone,
    thumbnails: Option<&'a HashMap<PathBuf, String>>,
}

impl ListSource for FileRows<'_> {
    fn item(&self, index: usize) -> RowInfo {
        let entry = &self.entries[index];
        // Preserve path identity even when names cannot be represented as UTF-8.
        let key: String = entry
            .path
            .as_os_str()
            .as_encoded_bytes()
            .iter()
            .flat_map(|&b| [b >> 4, b & 15])
            .map(|digit| char::from(b"0123456789abcdef"[usize::from(digit)]))
            .collect();
        RowInfo {
            key: key.into(),
            name: entry.name.clone(),
        }
    }
    fn build(&self, index: usize, key: &Key) -> Node {
        let entry = &self.entries[index];
        if let Some(thumbnails) = self.thumbnails {
            let icon = match thumbnails.get(&entry.path) {
                Some(id) => Image::new(format!("{}/image", key.0), id, 80.).picture(),
                None => Image::new(format!("{}/image", key.0), &entry.icon, 64.)
                    .app_theme(if entry.is_dir { "nd-folder" } else { "nd-file" }),
            };
            return Column::new(
                format!("{}/tile", key.0),
                vec![
                    icon.into(),
                    Label::new(format!("{}/name", key.0), &entry.name, self.style.clone())
                        .lines(1)
                        .into(),
                ],
            )
            .align(Align::Center)
            .gap(Space::S1)
            .into();
        }
        let date = entry
            .modified
            .and_then(|time| jiff::Timestamp::try_from(time).ok())
            .map_or_else(
                || "—".into(),
                |stamp| stamp.to_zoned(self.zone.clone()).date().to_string(),
            );
        let size = if entry.is_dir {
            "—".into()
        } else {
            file_size(entry.size)
        };
        let icon = Image::new(format!("{}/icon", key.0), &entry.icon, 20.)
            .app_theme(if entry.is_dir { "nd-folder" } else { "nd-file" })
            .into();
        columns(
            key.clone(),
            Some(icon),
            [entry.name.clone(), size, date],
            &self.style,
            f64::from(self.style.size),
            Ink::Primary,
        )
    }
}

/// A list row's columns, the header's too, so that each title stands over its column: the
/// icon's room, the name, the size, the date modified. `em` is the rows' type size, which
/// sizes the fixed columns in both.
fn columns(
    key: Key,
    icon: Option<Node>,
    [name, size, date]: [String; 3],
    style: &TextStyle,
    em: f64,
    ink: Ink,
) -> Node {
    let k = &key.0;
    let icon = icon.unwrap_or_else(|| Row::new(format!("{k}/icon"), vec![]).width(20.).into());
    let label = |part: &str, text: String| {
        Label::new(format!("{k}/{part}"), text, style.clone())
            .lines(1)
            .ink(ink)
    };
    Row::new(
        format!("{k}/row"),
        vec![
            icon,
            label("name", name).grow().into(),
            label("size", size).width(6. * em).into(),
            label("date", date).width(7. * em).into(),
        ],
    )
    .gap(Space::S2)
    .align(Align::Center)
    .into()
}

fn file_size(bytes: u64) -> String {
    let mut size = bytes as f64;
    for unit in ["B", "KiB", "MiB", "GiB", "TiB", "PiB"] {
        if size < 1024. || unit == "PiB" {
            return if unit == "B" {
                format!("{bytes} B")
            } else {
                format!("{size:.1} {unit}")
            };
        }
        size /= 1024.;
    }
    unreachable!()
}

/// A virtualized, uniform-height file list. Its actions report indices into the supplied
/// snapshot. Retain selected paths in app state when the listing changes.
#[must_use]
pub struct FileList<'a> {
    key: Key,
    name: String,
    changed: String,
    open: String,
    rows: FileRows<'a>,
    cursor: Option<usize>,
    multiple: Option<crate::components::MultipleSelection>,
    row_height: f64,
    columns: usize,
    height: f64,
    fill_height: bool,
    viewport: Option<(f64, f64)>,
    headers: Option<([String; 3], TextStyle)>,
}

impl<'a> FileList<'a> {
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        entries: &'a [Entry],
        changed: impl Into<String>,
        open: impl Into<String>,
        style: TextStyle,
        row_height: f64,
    ) -> Self {
        Self {
            key: key.into(),
            name: name.into(),
            changed: changed.into(),
            open: open.into(),
            rows: FileRows {
                entries,
                style,
                zone: jiff::tz::TimeZone::system(),
                thumbnails: None,
            },
            cursor: None,
            multiple: None,
            row_height,
            columns: 1,
            height: 8. * row_height,
            fill_height: false,
            viewport: None,
            headers: None,
        }
    }
    /// In the list, a row naming the columns: the name, the size and the date modified, in
    /// `style` (a caption type). Without it nothing says what the numbers are (#1148).
    pub fn headers(mut self, name: &str, size: &str, modified: &str, style: TextStyle) -> Self {
        self.headers = Some(([name.into(), size.into(), modified.into()], style));
        self
    }
    /// Use the same retained selection and scroll model in a grid of square tiles,
    /// `tile_height` on each side whatever the window's width. Images are identifiers from
    /// `AppWindow::set_pictures`, indexed by the original path.
    pub fn grid(
        mut self,
        columns: usize,
        tile_height: f64,
        thumbnails: &'a HashMap<PathBuf, String>,
    ) -> Self {
        self.columns = columns.max(1);
        self.row_height = tile_height;
        self.rows.thumbnails = Some(thumbnails);
        self
    }
    pub fn cursor(mut self, index: Option<usize>) -> Self {
        self.cursor = index;
        self
    }
    pub fn multiple(
        mut self,
        indices: BTreeSet<usize>,
        anchor: Option<usize>,
        changed: impl Into<String>,
    ) -> Self {
        self.multiple = Some(crate::components::MultipleSelection {
            selected: indices,
            anchor,
            changed: changed.into(),
        });
        self
    }
    pub fn height(mut self, height: f64) -> Self {
        self.height = height;
        self
    }
    /// Use the surrounding column's remaining vertical space beyond `height`.
    pub fn fill_height(mut self) -> Self {
        self.fill_height = true;
        self
    }
    pub fn window(mut self, viewport: Option<(f64, f64)>) -> Self {
        self.viewport = viewport;
        self
    }
    pub fn scroll_key(key: &Key) -> Key {
        ListView::scroll_key(key)
    }
}
impl From<FileList<'_>> for Node {
    fn from(list: FileList<'_>) -> Self {
        let mut view = ListView::new(
            list.key,
            list.name,
            list.changed,
            &list.rows,
            list.rows.entries.len(),
            list.cursor.unwrap_or_default(),
            list.row_height,
        )
        .selected(list.cursor)
        .columns(list.columns)
        .tile_width(list.row_height)
        .height(list.height)
        .window(list.viewport.or(Some((0., list.height))))
        .activate(list.open);
        if let Some(multi) = list.multiple {
            view = view.multiple(multi.selected, multi.anchor, multi.changed);
        }
        if let (Some(([name, size, date], style)), 1) = (list.headers, list.columns) {
            view = view.header(columns(
                "file-list-header".into(),
                None,
                [name, size, date],
                &style,
                f64::from(list.rows.style.size),
                Ink::Secondary,
            ));
        }
        let node: Node = view.into();
        if list.fill_height { node.grow() } else { node }
    }
}
