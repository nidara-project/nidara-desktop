// SPDX-License-Identifier: LGPL-3.0-or-later
//! A gallery consumer of the shared read-only file model and views.
use nk::{
    Activated, Align, Column, FileList, Key, Label, Node, PathBar, PlacesSidebar, Row, Space,
    Switch, Type, TypeScale, Value, Weight,
    files::{Entry, Listing, MimeDb, Options, Place, Sources},
    prelude::*,
};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::Arc,
};

#[derive(Default)]
pub(super) struct Browser {
    places: Vec<Place>,
    mime: Option<Arc<MimeDb>>,
    path: Option<PathBuf>,
    scan: Option<Listing>,
    error: Option<String>,
    opened: Option<String>,
    cursor: Option<PathBuf>,
    anchor: Option<PathBuf>,
    selected: BTreeSet<PathBuf>,
    multiple: bool,
    revision: u64,
}

impl Browser {
    pub fn start(&mut self) {
        if self.mime.is_some() {
            return;
        }
        match Sources::user() {
            Ok(sources) => {
                self.places = sources.places();
                self.mime = Some(Arc::new(sources.mime_db()));
                self.navigate(sources.home);
            }
            Err(error) => self.error = Some(error.to_string()),
        }
    }

    fn navigate(&mut self, path: PathBuf) {
        let Some(db) = &self.mime else { return };
        self.path = Some(path.clone());
        self.revision += 1;
        self.cursor = None;
        self.anchor = None;
        self.selected.clear();
        self.opened = None;
        self.error = None;
        self.scan = match Listing::start(path, Options::default(), Arc::clone(db)) {
            Ok(scan) => Some(scan),
            Err(error) => {
                self.error = Some(error.to_string());
                None
            }
        };
    }

    pub fn loading(&self) -> bool {
        self.scan.as_ref().is_some_and(Listing::loading)
    }

    pub fn poll(&mut self) -> bool {
        self.scan.as_mut().is_some_and(Listing::poll)
    }

    pub fn key(&self) -> Key {
        format!("files/list/{}", self.revision).into()
    }

    fn entries(&self) -> &[Entry] {
        self.scan.as_ref().map_or(&[], Listing::entries)
    }

    pub fn activate(&mut self, action: Activated) {
        if let ("files-mode", Some(Value::Bool(multiple))) = (action.action.as_str(), &action.value)
        {
            self.multiple = *multiple;
            self.anchor = self.cursor.clone();
            self.selected.clear();
            if let Some(path) = &self.cursor {
                self.selected.insert(path.clone());
            }
            return;
        }
        if let (
            "files-selection",
            Some(Value::Selection {
                cursor,
                anchor,
                indices,
            }),
        ) = (action.action.as_str(), &action.value)
        {
            let path_for = |index| {
                self.entries()
                    .get(index)
                    .map(|entry: &Entry| entry.path.clone())
            };
            let selected = indices
                .iter()
                .filter_map(|&index| path_for(index))
                .collect();
            let cursor = path_for(*cursor);
            self.anchor = path_for(*anchor);
            self.cursor = cursor;
            self.selected = selected;
            return;
        }
        let Some(Value::Index(index)) = action.value else {
            return;
        };
        match action.action.as_str() {
            "files-place" => {
                if let Some(path) = self
                    .places
                    .get(index)
                    .and_then(Place::path)
                    .map(Path::to_owned)
                {
                    self.navigate(path);
                }
            }
            "files-path" => {
                if let Some(path) = &self.path
                    && let Some(path) = PathBar::locations(path).into_iter().nth(index)
                {
                    self.navigate(path);
                }
            }
            "files-cursor" | "files-open" => {
                let Some(entry) = self.entries().get(index) else {
                    return;
                };
                let path = entry.path.clone();
                if action.action == "files-open" {
                    if entry.is_dir {
                        self.navigate(path);
                    } else {
                        self.opened = Some(entry.name.clone());
                    }
                } else {
                    self.cursor = Some(path);
                }
            }
            _ => {}
        }
    }

    pub fn view(
        &self,
        types: &TypeScale,
        row_height: f64,
        window: Option<(f64, f64)>,
        glyph: f64,
    ) -> Vec<Node> {
        let body = || types.style(Type::Body, Weight::Regular);
        let Some(path) = &self.path else {
            let text = self
                .error
                .as_deref()
                .unwrap_or("Home folder is unavailable");
            return vec![Label::new("files/error", text, body()).lines(2).into()];
        };
        let entries = self.entries();
        let cursor = entries
            .iter()
            .position(|entry| Some(&entry.path) == self.cursor.as_ref());
        let mut list = FileList::new(
            self.key(),
            "Files",
            entries,
            "files-cursor",
            "files-open",
            body(),
            row_height,
        )
        .cursor(cursor)
        .window(window);
        if self.multiple {
            let selected = entries
                .iter()
                .enumerate()
                .filter_map(|(i, entry)| self.selected.contains(&entry.path).then_some(i))
                .collect();
            let anchor = entries
                .iter()
                .position(|entry| Some(&entry.path) == self.anchor.as_ref());
            list = list.multiple(selected, anchor, "files-selection");
        }
        let mut content = vec![
            PathBar::new("files/path", path, "files-path", body()).into(),
            nk::ListRow::new("files/mode", "Select multiple files", body())
                .trailing(Switch::new(
                    "files/multi",
                    "Select multiple files",
                    "files-mode",
                    self.multiple,
                ))
                .into(),
            list.into(),
        ];
        let message = self
            .error
            .clone()
            .or_else(|| self.scan.as_ref()?.error().map(ToString::to_string))
            .or_else(|| self.loading().then(|| "Loading…".into()))
            .or_else(|| self.opened.clone())
            .or_else(|| entries.is_empty().then(|| "Folder is empty".into()));
        if let Some(text) = message {
            content.push(Label::new("files/status", text, body()).lines(2).into());
        }
        vec![
            Row::new(
                "files/browser",
                vec![
                    PlacesSidebar::new(
                        "files/places",
                        &self.places,
                        "files-place",
                        body(),
                        types.style(Type::Caption, Weight::Medium),
                        glyph,
                    )
                    .current(path)
                    .into(),
                    Column::new("files/content", content)
                        .gap(Space::S2)
                        .grow()
                        .into(),
                ],
            )
            .align(Align::Start)
            .gap(Space::S3)
            .into(),
        ]
    }
}
