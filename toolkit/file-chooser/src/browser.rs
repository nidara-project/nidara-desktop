// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{
    pictures::{Job, Pictures},
    request::{self, Filters, Request, Response},
};
use nk::{
    Activated, Align, AppWindow, Button, ButtonAppearance, Column, DropDown, Entry, FileList,
    Image, Ink, Key, Label, Node, Page, PathBar, PlacesSidebar, Row, Segmented, Space, Type, Value,
    Weight,
    files::{self, Listing, MimeDb, Options, Place, Sources},
    prelude::*,
};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
    sync::{
        Arc,
        mpsc::{self, Receiver, TryRecvError},
    },
};

const TILE_HEIGHT: f64 = 116.;
const VIEWPORT: f64 = 350.;

pub struct Browser {
    sources: Sources,
    mime: Arc<MimeDb>,
    places: Vec<Place>,
    path: PathBuf,
    listing: Listing,
    fallback_home: bool,
    directories: bool,
    multiple: bool,
    filters: Filters,
    pub title: String,
    accept: String,
    generation: u64,
    grid: bool,
    width: u32,
    show_hidden: bool,
    cursor: Option<PathBuf>,
    anchor: Option<PathBuf>,
    selection: BTreeSet<PathBuf>,
    location: Option<String>,
    pending_path: Option<Receiver<std::io::Result<(PathBuf, bool)>>>,
    message: Option<String>,
    pictures: Pictures,
}

impl Browser {
    pub fn new(spec: Request, sources: Sources) -> Result<Self, String> {
        let requested = request::folder(spec.current_folder);
        let path = requested.clone().unwrap_or_else(|| sources.home.clone());
        let mime = Arc::new(sources.mime_db());
        let filters = Filters::new(spec.filters, spec.current_filter)?;
        let listing = Listing::start(
            path.clone(),
            Options {
                directories_only: spec.directory,
                filter: filters.rule(),
                ..Default::default()
            },
            mime.clone(),
        )
        .map_err(|error| error.to_string())?;
        let accept = request::label(&spec.accept_label);
        Ok(Self {
            places: sources.places(),
            pictures: Pictures::new(sources.clone())?,
            sources,
            mime,
            path,
            listing,
            fallback_home: requested.is_some(),
            directories: spec.directory,
            multiple: spec.multiple,
            filters,
            title: if spec.title.is_empty() {
                "Open".into()
            } else {
                spec.title
            },
            accept: if accept.is_empty() {
                "Open".into()
            } else {
                accept
            },
            generation: 0,
            grid: false,
            width: 940,
            show_hidden: false,
            cursor: None,
            anchor: None,
            selection: BTreeSet::new(),
            location: None,
            pending_path: None,
            message: None,
        })
    }

    pub fn resize(&mut self, width: u32) {
        self.width = width;
    }
    fn columns(&self) -> usize {
        if !self.grid {
            1
        } else if self.width >= 900 {
            4
        } else if self.width >= 730 {
            3
        } else {
            2
        }
    }
    fn file_list_key(&self) -> Key {
        format!("chooser/files/{}/{}", self.generation, self.columns()).into()
    }
    fn navigate(&mut self, path: PathBuf) -> Result<(), String> {
        self.listing = Listing::start(
            path.clone(),
            Options {
                show_hidden: self.show_hidden,
                directories_only: self.directories,
                filter: self.filters.rule(),
                ..Default::default()
            },
            self.mime.clone(),
        )
        .map_err(|error| error.to_string())?;
        self.path = path;
        self.generation += 1;
        self.fallback_home = false;
        self.cursor = None;
        self.anchor = None;
        self.selection.clear();
        self.location = None;
        self.pending_path = None;
        self.message = None;
        Ok(())
    }

    pub fn location_open(&self) -> bool {
        self.location.is_some()
    }

    pub fn show_location(&mut self, initial: Option<&str>) {
        self.location =
            Some(initial.map_or_else(|| self.path.to_string_lossy().into_owned(), str::to_owned));
    }
    fn submit_location(&mut self) -> Result<(), String> {
        let Some(path) = self
            .location
            .as_ref()
            .and_then(|text| request::location(text, &self.sources.home))
        else {
            self.message = Some("Enter an absolute path or a path starting with ~/.".into());
            return Ok(());
        };
        let (send, receive) = mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("chooser-location".into())
            .spawn(move || {
                let result = path.canonicalize().and_then(|path| {
                    let metadata = path.metadata()?;
                    if metadata.is_dir() || metadata.is_file() {
                        Ok((path, metadata.is_dir()))
                    } else {
                        Err(std::io::Error::other(
                            "The path is not a regular file or folder",
                        ))
                    }
                });
                let _ = send.send(result);
            })
            .map_err(|error| error.to_string())?;
        self.pending_path = Some(receive);
        self.message = None;
        Ok(())
    }
    fn poll_location(&mut self) -> Result<bool, String> {
        let Some(receive) = &self.pending_path else {
            return Ok(false);
        };
        let outcome = match receive.try_recv() {
            Ok(outcome) => outcome,
            Err(TryRecvError::Empty) => return Ok(false),
            Err(TryRecvError::Disconnected) => {
                Err(std::io::Error::other("The location could not be read"))
            }
        };
        self.pending_path = None;
        match outcome {
            Ok((path, true)) => self.navigate(path)?,
            Ok((_, false)) if self.directories => self.message = Some("Select a folder.".into()),
            Ok((path, false)) => {
                let parent = path.parent().ok_or("file has no parent")?.to_owned();
                self.navigate(parent)?;
                self.cursor = Some(path.clone());
                self.anchor = Some(path.clone());
                self.selection.insert(path);
            }
            Err(error) => self.message = Some(error.to_string()),
        }
        Ok(true)
    }
    pub fn poll(&mut self) -> Result<bool, String> {
        let changed = self.poll_location()?;
        let rows_changed = self.listing.poll();
        if self.fallback_home && !self.listing.loading() {
            self.fallback_home = false;
            if self.listing.error().is_some() && self.path != self.sources.home {
                self.navigate(self.sources.home.clone())?;
                return Ok(true);
            }
        }
        Ok(changed || rows_changed)
    }
    pub fn pending(&self) -> bool {
        self.listing.loading() || self.pending_path.is_some() || self.pictures.pending()
    }

    fn job(&self, path: &Path, large: bool) -> Job {
        Job {
            generation: self.generation,
            path: path.to_owned(),
            large,
        }
    }
    fn preview_entry(&self) -> Option<&files::Entry> {
        let path = self.cursor.as_ref()?;
        self.listing
            .entries()
            .iter()
            .find(|entry| entry.path == *path && !entry.is_dir && entry.mime.starts_with("image/"))
    }
    pub fn update_pictures(&mut self, host: &mut AppWindow) -> bool {
        let mut wanted: Vec<_> = self
            .preview_entry()
            .map(|entry| self.job(&entry.path, true))
            .into_iter()
            .collect();
        if self.grid {
            let (offset, height) = host
                .scroll_window(&FileList::scroll_key(&self.file_list_key()))
                .unwrap_or((0., VIEWPORT));
            let first =
                ((offset / TILE_HEIGHT).floor() as usize).saturating_sub(1) * self.columns();
            let count = ((height / TILE_HEIGHT).ceil() as usize + 3) * self.columns();
            wanted.extend(
                self.listing
                    .entries()
                    .iter()
                    .skip(first)
                    .take(count)
                    .filter(|entry| !entry.is_dir && entry.mime.starts_with("image/"))
                    .map(|entry| self.job(&entry.path, false)),
            );
        }
        if !self.pictures.update(&wanted) {
            return false;
        }
        host.set_pictures(self.pictures.rasters());
        true
    }

    fn accepted_paths(&self) -> Option<Vec<&Path>> {
        if !self.multiple {
            if let Some(cursor) = &self.cursor {
                return self
                    .listing
                    .entries()
                    .iter()
                    .find(|entry| &entry.path == cursor && self.directories == entry.is_dir)
                    .map(|entry| vec![entry.path.as_path()]);
            }
        } else if !self.selection.is_empty() {
            let listed: Vec<_> = self
                .listing
                .entries()
                .iter()
                .filter(|entry| {
                    self.directories == entry.is_dir && self.selection.contains(&entry.path)
                })
                .map(|entry| entry.path.as_path())
                .collect();
            return (listed.len() == self.selection.len()).then_some(listed);
        }
        (self.directories && !self.listing.loading() && self.listing.error().is_none())
            .then(|| vec![self.path.as_path()])
    }
    fn response(&self) -> Option<Response> {
        self.finish(self.accepted_paths()?)
    }
    fn finish<'a>(&self, paths: impl IntoIterator<Item = &'a Path>) -> Option<Response> {
        let uris: Vec<_> = paths
            .into_iter()
            .map(files::file_uri)
            .collect::<Option<_>>()?;
        (!uris.is_empty()).then(|| Response {
            uris,
            current_filter: self.filters.wire(),
        })
    }
    pub fn accept(&mut self) -> Result<Option<Response>, String> {
        if !self.directories {
            let folder = self
                .cursor
                .as_ref()
                .and_then(|path| {
                    self.listing
                        .entries()
                        .iter()
                        .find(|e| e.path == *path && e.is_dir)
                })
                .map(|e| e.path.clone());
            if let Some(path) = folder
                && (!self.multiple || self.selection.len() == 1 && self.selection.contains(&path))
            {
                self.navigate(path)?;
                return Ok(None);
            }
        }
        Ok(self.response())
    }
    fn can_accept(&self) -> bool {
        self.accepted_paths().is_some()
            || !self.directories
                && self.listing.entries().iter().any(|entry| {
                    entry.is_dir
                        && self.cursor.as_ref() == Some(&entry.path)
                        && (!self.multiple
                            || self.selection.len() == 1 && self.selection.contains(&entry.path))
                })
    }

    pub fn activate(&mut self, action: Activated) -> Result<Option<Response>, String> {
        match (action.action.as_str(), action.value) {
            ("accept", _) => return self.accept(),
            ("location-change", Some(Value::Text(value))) => {
                self.pending_path = None;
                self.location = Some(value);
            }
            ("location-go", _) => self.submit_location()?,
            ("hidden", Some(Value::Bool(hidden))) => {
                self.show_hidden = hidden;
                self.navigate(self.path.clone())?;
            }
            ("layout:0", _) => self.grid = false,
            ("layout:1", _) => self.grid = true,
            ("filter", Some(Value::Index(i))) if self.filters.select(i) => {
                self.navigate(self.path.clone())?
            }
            ("place", Some(Value::Index(i))) => {
                if let Some(path) = self.places.get(i).and_then(Place::path) {
                    self.navigate(path.to_owned())?;
                }
            }
            ("breadcrumb", Some(Value::Index(i))) => {
                if let Some(path) = PathBar::locations(&self.path).into_iter().nth(i) {
                    self.navigate(path)?;
                }
            }
            ("cursor", Some(Value::Index(i))) => {
                self.cursor = self
                    .listing
                    .entries()
                    .get(i)
                    .map(|entry| entry.path.clone());
            }
            (
                "selection",
                Some(Value::Selection {
                    cursor,
                    anchor,
                    indices,
                }),
            ) => {
                let entries = self.listing.entries();
                self.cursor = entries.get(cursor).map(|entry| entry.path.clone());
                self.anchor = entries.get(anchor).map(|entry| entry.path.clone());
                self.selection = indices
                    .into_iter()
                    .filter_map(|i| entries.get(i).map(|entry| entry.path.clone()))
                    .collect();
            }
            ("open-row", Some(Value::Index(i))) => {
                if let Some(entry) = self.listing.entries().get(i) {
                    if entry.is_dir {
                        self.navigate(entry.path.clone())?;
                    } else if self.multiple && self.selection.contains(&entry.path) {
                        return Ok(self.response());
                    } else {
                        return Ok(self.finish([entry.path.as_path()]));
                    }
                }
            }
            _ => {}
        }
        Ok(None)
    }

    pub fn page(&self, host: &AppWindow) -> Page {
        let look = host.look();
        let body = || look.types.style(Type::Body, Weight::Regular);
        let entries = self.listing.entries();
        let position =
            |path: Option<&PathBuf>| entries.iter().position(|entry| Some(&entry.path) == path);
        let key = self.file_list_key();
        let viewport = host.scroll_window(&FileList::scroll_key(&key));
        let thumbnails = self.pictures.thumbnails();
        let mut list = FileList::new(
            key,
            "Files",
            entries,
            "cursor",
            "open-row",
            body(),
            look.tokens.row_height,
        )
        .height(VIEWPORT)
        .window(viewport)
        .cursor(position(self.cursor.as_ref()));
        if self.grid {
            list = list.grid(self.columns(), TILE_HEIGHT, &thumbnails);
        }
        if self.multiple {
            let indices = entries
                .iter()
                .enumerate()
                .filter_map(|(i, entry)| self.selection.contains(&entry.path).then_some(i))
                .collect();
            list = list.multiple(indices, position(self.anchor.as_ref()), "selection");
        }
        let nav: Node = if let Some(text) = &self.location {
            Entry::new("chooser/location", "Location", "location-change", text)
                .submit("location-go")
                .into()
        } else {
            PathBar::new("chooser/path", &self.path, "breadcrumb", body()).into()
        };
        let mut controls = vec![
            Segmented::new(
                "chooser/layout",
                "View",
                "layout",
                vec!["List".into(), "Icons".into()],
                usize::from(self.grid),
            )
            .into(),
            nk::SettingRow::new("chooser/hidden-row", "Show hidden files", body())
                .trailing(nk::Switch::new(
                    "chooser/hidden",
                    "Show hidden files",
                    "hidden",
                    self.show_hidden,
                ))
                .into(),
        ];
        let choices = self.filters.labels();
        if !choices.is_empty() {
            controls.push(
                DropDown::new(
                    "chooser/filter",
                    "File type",
                    "filter",
                    choices,
                    self.filters.chosen,
                )
                .into(),
            );
        }
        let list: Node = list.into();
        let mut listing = vec![Column::new("chooser/list-column", vec![list]).grow().into()];
        if let Some(id) = self
            .preview_entry()
            .and_then(|entry| self.pictures.preview(&entry.path))
        {
            let size = if self.width >= 900 { 214. } else { 128. };
            listing.push(Image::new("chooser/preview", id, size).picture().into());
        }
        let mut content = vec![
            nav,
            Row::new("chooser/tools", controls)
                .align(Align::Center)
                .gap(Space::S3)
                .into(),
            Row::new("chooser/list-and-preview", listing)
                .align(Align::Center)
                .gap(Space::S3)
                .into(),
        ];
        let message = self
            .message
            .clone()
            .or_else(|| self.listing.error().map(ToString::to_string))
            .or_else(|| self.listing.loading().then(|| "Loading…".into()))
            .or_else(|| entries.is_empty().then(|| "Folder is empty".into()));
        if let Some(message) = message {
            content.push(
                Label::new("chooser/status", message, body())
                    .ink(Ink::Secondary)
                    .lines(2)
                    .into(),
            );
        }
        content.push(
            Row::new(
                "chooser/responses",
                vec![
                    Button::new("chooser/cancel", "Cancel", "cancel", body()).into(),
                    Button::new("chooser/accept", &self.accept, "accept", body())
                        .enabled(self.can_accept())
                        .button_appearance(ButtonAppearance::Default)
                        .into(),
                ],
            )
            .justify(nk::Justify::End)
            .gap(Space::S2)
            .into(),
        );
        Page {
            sidebar: PlacesSidebar::new("chooser/places", &self.places, "place", body())
                .current(&self.path)
                .into(),
            content: Column::new("chooser/content", content)
                .gap(Space::S3)
                .padding(nk::Padding::all(Space::S3))
                .into(),
            title: self.title.clone(),
            can_back: false,
            can_forward: false,
        }
    }
}
