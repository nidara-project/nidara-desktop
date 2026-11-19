// SPDX-License-Identifier: LGPL-3.0-or-later
//! Compositions shared by file choosers and browsers.
use crate::{
    Align, Button, Column, Image, Key, Label, ListSource, ListView, Node, Row, RowInfo,
    SidebarEntry, Space, Value, prelude::*,
};
use nk_files::{Entry, Place, PlaceKind};
use nk_text::TextStyle;
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

/// Places in sidebar sections, with the current location highlighted.
#[must_use]
pub struct PlacesSidebar<'a> {
    key: Key,
    places: &'a [Place],
    action: String,
    style: TextStyle,
    current: Option<&'a Path>,
    headings: [&'a str; 3],
}

impl<'a> PlacesSidebar<'a> {
    pub fn new(
        key: impl Into<Key>,
        places: &'a [Place],
        action: impl Into<String>,
        style: TextStyle,
    ) -> Self {
        Self {
            key: key.into(),
            places,
            action: action.into(),
            style,
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
        let mut sections = Vec::new();
        for (section, heading) in sidebar.headings.into_iter().enumerate() {
            let mut rows = Vec::new();
            for (index, place) in sidebar.places.iter().enumerate() {
                let (group, icon) = match place.kind {
                    PlaceKind::Home => (0, "user-home"),
                    PlaceKind::UserDir => (0, "folder"),
                    PlaceKind::Bookmark => (1, "user-bookmarks"),
                    PlaceKind::Drive => (2, "drive-removable-media"),
                };
                if group == section {
                    rows.push(
                        SidebarEntry::new(
                            format!("{}/place/{index}", sidebar.key.0),
                            &place.name,
                            icon,
                            &sidebar.action,
                            sidebar.style.clone(),
                            20.,
                        )
                        .selected(
                            place
                                .path()
                                .is_some_and(|path| Some(path) == sidebar.current),
                        )
                        .enabled(place.path().is_some())
                        .value(Value::Index(index))
                        .into(),
                    );
                }
            }
            if !rows.is_empty() {
                let key = format!("{}/section/{section}", sidebar.key.0);
                rows.insert(
                    0,
                    Label::new(format!("{key}/heading"), heading, sidebar.style.clone()).into(),
                );
                sections.push(Column::new(key, rows).gap(Space::S1).into());
            }
        }
        Column::new(sidebar.key, sections).gap(Space::S3).into()
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
        let em = f64::from(self.style.size);
        Row::new(
            format!("{}/row", key.0),
            vec![
                Image::new(format!("{}/icon", key.0), &entry.icon, 20.).into(),
                Label::new(format!("{}/name", key.0), &entry.name, self.style.clone())
                    .lines(1)
                    .grow()
                    .into(),
                Label::new(format!("{}/size", key.0), size, self.style.clone())
                    .lines(1)
                    .width(6. * em)
                    .into(),
                Label::new(format!("{}/date", key.0), date, self.style.clone())
                    .lines(1)
                    .width(7. * em)
                    .into(),
            ],
        )
        .gap(Space::S2)
        .align(Align::Center)
        .into()
    }
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
    multiple: Option<(BTreeSet<usize>, String)>,
    row_height: f64,
    height: f64,
    viewport: Option<(f64, f64)>,
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
            },
            cursor: None,
            multiple: None,
            row_height,
            height: 8. * row_height,
            viewport: None,
        }
    }
    pub fn cursor(mut self, index: Option<usize>) -> Self {
        self.cursor = index;
        self
    }
    pub fn multiple(mut self, indices: BTreeSet<usize>, toggle: impl Into<String>) -> Self {
        self.multiple = Some((indices, toggle.into()));
        self
    }
    pub fn height(mut self, height: f64) -> Self {
        self.height = height;
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
        .height(list.height)
        .window(list.viewport.or(Some((0., list.height))))
        .activate(list.open);
        if let Some((selected, toggle)) = list.multiple {
            view = view.multiple(selected, toggle);
        }
        view.into()
    }
}
