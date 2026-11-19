// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{
    pictures::{Job, Pictures},
    request::{self, Filters, Request, Response},
    strings::Strings,
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
    ffi::OsString,
    path::{Path, PathBuf},
    sync::{
        Arc,
        mpsc::{self, Receiver, TryRecvError},
    },
};

const TILE_HEIGHT: f64 = 116.;

/// What the dialog chooses: files to open, or where to save.
pub enum Saving {
    /// OpenFile: files or folders that exist.
    No,
    /// SaveFile: a name in a folder; the name is the user's to edit.
    One { name: String },
    /// SaveFiles: a folder, into which the app's files go under their own names.
    Many { names: Vec<OsString> },
}

/// What accepting led to.
pub enum Outcome {
    Done(Response),
    /// The file is there already: the user is asked first (`main.rs`).
    Replace {
        name: String,
        folder: String,
        response: Response,
    },
}

pub struct Browser {
    pub strings: Strings,
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
    /// The folders before this one and after it, for back and forward (the band's arrows,
    /// Alt+Left and Right). Going somewhere new forgets what was ahead, as in a browser.
    back: Vec<PathBuf>,
    forward: Vec<PathBuf>,
    saving: Saving,
    /// The name being typed for a new folder; None: not making one.
    new_folder: Option<String>,
    /// A control to give the keyboard to on the next commit (`main.rs`).
    pub focus: Option<&'static str>,
}

impl Browser {
    pub fn new(spec: Request, sources: Sources, strings: Strings) -> Result<Self, String> {
        let mut spec = spec;
        let saving = match spec.method.as_str() {
            "OpenFile" => Saving::No,
            "SaveFile" => {
                let mut name = spec.current_name.clone();
                // The file it saves over: its folder and its name.
                if let Some(file) = request::folder(std::mem::take(&mut spec.current_file)) {
                    if let Some(parent) = file.parent() {
                        let mut bytes =
                            std::os::unix::ffi::OsStrExt::as_bytes(parent.as_os_str()).to_vec();
                        bytes.push(0);
                        spec.current_folder = bytes;
                    }
                    if let Some(file_name) = file.file_name() {
                        name = file_name.to_string_lossy().into_owned();
                    }
                }
                spec.directory = false;
                spec.multiple = false;
                Saving::One { name }
            }
            "SaveFiles" => {
                let names = std::mem::take(&mut spec.files)
                    .into_iter()
                    .map(|bytes| {
                        request::file_name(bytes).ok_or("SaveFiles: a file name is not one name")
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if names.is_empty() {
                    return Err("SaveFiles: no files".into());
                }
                spec.directory = true;
                spec.multiple = false;
                Saving::Many { names }
            }
            other => return Err(format!("unknown file chooser method {other}")),
        };
        let saves = !matches!(saving, Saving::No);
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
        let mut places = sources.places();
        if let Some(home) = places
            .iter_mut()
            .find(|place| place.kind == files::PlaceKind::Home)
        {
            home.name.clone_from(&strings.home);
        }
        Ok(Self {
            places,
            pictures: Pictures::new(sources.clone())?,
            back: Vec::new(),
            forward: Vec::new(),
            sources,
            mime,
            path,
            listing,
            fallback_home: requested.is_some(),
            directories: spec.directory,
            multiple: spec.multiple,
            filters,
            title: if !spec.title.is_empty() {
                spec.title
            } else if saves {
                strings.save.clone()
            } else {
                strings.open.clone()
            },
            accept: if !accept.is_empty() {
                accept
            } else if saves {
                strings.save.clone()
            } else {
                strings.open.clone()
            },
            focus: matches!(saving, Saving::One { .. }).then_some("chooser/name"),
            saving,
            new_folder: None,
            strings,
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
    /// To another folder, by the user's hand: remembered for back.
    fn go(&mut self, path: PathBuf) -> Result<(), String> {
        if path == self.path {
            return Ok(());
        }
        let from = self.path.clone();
        self.navigate(path)?;
        self.back.push(from);
        self.forward.clear();
        Ok(())
    }
    fn step(&mut self, back: bool) -> Result<(), String> {
        let (from, to) = if back {
            (&mut self.back, &mut self.forward)
        } else {
            (&mut self.forward, &mut self.back)
        };
        let Some(path) = from.pop() else {
            return Ok(());
        };
        to.push(self.path.clone());
        self.navigate(path)
    }
    /// Lists `path`: a move the history does not see (a refresh, the first folder's fallback).
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
        self.new_folder = None;
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
            self.message = Some(self.strings.invalid_location.clone());
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
                        Err(std::io::ErrorKind::InvalidInput.into())
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
            Err(TryRecvError::Disconnected) => Err(std::io::ErrorKind::Other.into()),
        };
        self.pending_path = None;
        match outcome {
            Ok((path, true)) => self.go(path)?,
            Ok((_, false)) if self.directories => {
                self.message = Some(self.strings.folder_only.clone())
            }
            Ok((path, false)) => {
                let parent = path.parent().ok_or("file has no parent")?.to_owned();
                self.go(parent)?;
                self.cursor = Some(path.clone());
                self.anchor = Some(path.clone());
                self.selection.insert(path);
            }
            Err(error) => {
                eprintln!("nidara-file-chooser: cannot read location: {error}");
                self.message = Some(self.strings.unreadable_location.clone());
            }
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
                .unwrap_or((0., TILE_HEIGHT));
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
        match &self.saving {
            Saving::Many { names } => {
                let [folder] = self.accepted_paths()?[..] else {
                    return None;
                };
                // Each file under its own name, or a numbered one where that is taken —
                // by a file already there or by one of the others.
                let mut chosen: Vec<PathBuf> = Vec::new();
                for name in names {
                    let path = request::free_name(folder, name, |p| {
                        chosen.iter().any(|c| c == p) || p.symlink_metadata().is_ok()
                    });
                    chosen.push(path);
                }
                self.finish(chosen.iter().map(PathBuf::as_path))
            }
            _ => self.finish(self.accepted_paths()?),
        }
    }
    /// SaveFile: where the typed name would go, when it can be a file's name.
    fn save_target(&self) -> Option<PathBuf> {
        let Saving::One { name } = &self.saving else {
            return None;
        };
        let name = std::ffi::OsStr::new(name.as_str());
        (request::valid_name(name) && self.listing.error().is_none()).then(|| self.path.join(name))
    }
    fn save(&mut self) -> Result<Option<Outcome>, String> {
        let Saving::One { name } = &self.saving else {
            return Ok(None);
        };
        // Nothing typed and a folder picked in the list: into it, as Enter on it does.
        if name.is_empty()
            && let Some(folder) = self.cursor_folder()
        {
            self.go(folder)?;
            return Ok(None);
        }
        let Some(target) = self.save_target() else {
            self.message = Some(self.strings.invalid_name.clone());
            return Ok(None);
        };
        let name = name.clone();
        match target.metadata() {
            // A folder's name typed: into it (GTK and Finder alike).
            Ok(metadata) if metadata.is_dir() => {
                self.go(target)?;
                Ok(None)
            }
            Ok(_) => {
                let Some(response) = self.finish([target.as_path()]) else {
                    return Ok(None);
                };
                let folder = self
                    .path
                    .file_name()
                    .map_or_else(|| self.path.to_string_lossy(), |f| f.to_string_lossy())
                    .into_owned();
                Ok(Some(Outcome::Replace {
                    name,
                    folder,
                    response,
                }))
            }
            Err(_) => Ok(self.finish([target.as_path()]).map(Outcome::Done)),
        }
    }
    fn cursor_folder(&self) -> Option<PathBuf> {
        let path = self.cursor.as_ref()?;
        self.listing
            .entries()
            .iter()
            .find(|e| e.path == *path && e.is_dir)
            .map(|e| e.path.clone())
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
    pub fn accept(&mut self) -> Result<Option<Outcome>, String> {
        if self.new_folder.is_some() {
            self.create_folder()?;
            return Ok(None);
        }
        if matches!(self.saving, Saving::One { .. }) {
            return self.save();
        }
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
                self.go(path)?;
                return Ok(None);
            }
        }
        Ok(self.response().map(Outcome::Done))
    }
    fn can_accept(&self) -> bool {
        if let Saving::One { name } = &self.saving {
            return self.save_target().is_some()
                || name.is_empty() && self.cursor_folder().is_some();
        }
        self.accepted_paths().is_some()
            || !self.directories
                && self.listing.entries().iter().any(|entry| {
                    entry.is_dir
                        && self.cursor.as_ref() == Some(&entry.path)
                        && (!self.multiple
                            || self.selection.len() == 1 && self.selection.contains(&entry.path))
                })
    }

    fn set_hidden(&mut self, hidden: bool) -> Result<(), String> {
        self.show_hidden = hidden;
        self.navigate(self.path.clone())
    }
    pub fn toggle_hidden(&mut self) -> Result<(), String> {
        self.set_hidden(!self.show_hidden)
    }

    /// Where a new folder can be made: saving, or choosing a folder.
    fn can_make_folders(&self) -> bool {
        !matches!(self.saving, Saving::No) || self.directories
    }
    fn create_folder(&mut self) -> Result<(), String> {
        let Some(name) = self.new_folder.clone() else {
            return Ok(());
        };
        if !request::valid_name(std::ffi::OsStr::new(&name)) {
            self.message = Some(self.strings.invalid_name.clone());
            return Ok(());
        }
        let path = self.path.join(&name);
        match std::fs::create_dir(&path) {
            // Made: into it, as Finder does; GTK's selects it, which saving then needs a
            // second step for.
            Ok(()) => self.go(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                self.message = Some(self.strings.folder_exists.clone());
                Ok(())
            }
            Err(error) => {
                eprintln!(
                    "nidara-file-chooser: cannot create {}: {error}",
                    path.display()
                );
                self.message = Some(self.strings.cannot_create.clone());
                Ok(())
            }
        }
    }

    pub fn activate(&mut self, action: Activated) -> Result<Option<Outcome>, String> {
        match (action.action.as_str(), action.value) {
            ("accept", _) => return self.accept(),
            ("name-change", Some(Value::Text(value))) => {
                if let Saving::One { name } = &mut self.saving {
                    *name = value;
                    self.message = None;
                }
            }
            ("new-folder", _) if self.can_make_folders() => {
                self.new_folder = Some(String::new());
                self.message = None;
                self.focus = Some("chooser/new-folder-name");
            }
            ("new-folder-change", Some(Value::Text(value))) => {
                if self.new_folder.is_some() {
                    self.new_folder = Some(value);
                    self.message = None;
                }
            }
            ("new-folder-go", _) => self.create_folder()?,
            ("new-folder-cancel", _) => {
                self.new_folder = None;
                self.message = None;
            }
            (nk::BACK, _) => self.step(true)?,
            (nk::FORWARD, _) => self.step(false)?,
            ("location-change", Some(Value::Text(value))) => {
                self.pending_path = None;
                self.location = Some(value);
            }
            ("location-go", _) => self.submit_location()?,
            ("hidden", Some(Value::Bool(hidden))) => {
                self.set_hidden(hidden)?;
            }
            ("layout:0", _) => self.grid = false,
            ("layout:1", _) => self.grid = true,
            ("filter", Some(Value::Index(i))) if self.filters.select(i) => {
                self.navigate(self.path.clone())?
            }
            ("place", Some(Value::Index(i))) => {
                if let Some(path) = self.places.get(i).and_then(Place::path) {
                    self.go(path.to_owned())?;
                }
            }
            ("breadcrumb", Some(Value::Index(i))) => {
                if let Some(path) = PathBar::locations(&self.path).into_iter().nth(i) {
                    self.go(path)?;
                }
            }
            ("cursor", Some(Value::Index(i))) => {
                let entry = self.listing.entries().get(i);
                self.cursor = entry.map(|entry| entry.path.clone());
                // Saving: a file picked in the list lends its name, to save over it.
                if let (Saving::One { name }, Some(entry)) = (&mut self.saving, entry)
                    && !entry.is_dir
                    && let Some(file) = entry.path.file_name()
                {
                    *name = file.to_string_lossy().into_owned();
                    self.message = None;
                }
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
                        self.go(entry.path.clone())?;
                    } else if let Saving::One { name } = &mut self.saving {
                        // Saving over this file: its name, then asked as Save asks.
                        if let Some(file) = entry.path.file_name() {
                            *name = file.to_string_lossy().into_owned();
                        }
                        return self.save();
                    } else if self.multiple && self.selection.contains(&entry.path) {
                        return Ok(self.response().map(Outcome::Done));
                    } else {
                        return Ok(self.finish([entry.path.as_path()]).map(Outcome::Done));
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
            &self.strings.files,
            entries,
            "cursor",
            "open-row",
            body(),
            look.tokens.row_height,
        )
        .height(if self.grid {
            TILE_HEIGHT
        } else {
            look.tokens.row_height
        })
        .window(viewport)
        .cursor(position(self.cursor.as_ref()))
        .headers(
            &self.strings.name,
            &self.strings.size,
            &self.strings.modified,
            look.types.style(Type::Caption, Weight::Medium),
        );
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
            Entry::new(
                "chooser/location",
                &self.strings.location,
                "location-change",
                text,
            )
            .submit("location-go")
            .into()
        } else {
            PathBar::new("chooser/path", &self.path, "breadcrumb", body()).into()
        };
        let mut controls = vec![];
        if self.can_make_folders() {
            controls.push(
                Button::new(
                    "chooser/new-folder",
                    &self.strings.new_folder,
                    "new-folder",
                    body(),
                )
                .enabled(self.new_folder.is_none())
                .into(),
            );
        }
        controls.extend([
            Segmented::new(
                "chooser/layout",
                &self.strings.view,
                "layout",
                vec![self.strings.list.clone(), self.strings.icons.clone()],
                usize::from(self.grid),
            )
            .into(),
            nk::ListRow::new("chooser/hidden-row", &self.strings.hidden, body())
                .trailing(nk::Switch::new(
                    "chooser/hidden",
                    &self.strings.hidden,
                    "hidden",
                    self.show_hidden,
                ))
                .into(),
        ]);
        let choices = self.filters.labels();
        if !choices.is_empty() {
            controls.push(
                DropDown::new(
                    "chooser/filter",
                    &self.strings.file_type,
                    "filter",
                    choices,
                    self.filters.chosen,
                )
                .into(),
            );
        }
        let list: Node = list.fill_height().into();
        let mut listing = vec![Column::new("chooser/list-column", vec![list]).grow().into()];
        if let Some(id) = self
            .preview_entry()
            .and_then(|entry| self.pictures.preview(&entry.path))
        {
            let size = if self.width >= 900 { 214. } else { 128. };
            listing.push(
                Image::new("chooser/preview", id, size)
                    .picture()
                    .height(look.tokens.row_height)
                    .into(),
            );
        }
        let mut content = Vec::new();
        if let Saving::One { name } = &self.saving {
            content.push(
                Row::new(
                    "chooser/name-row",
                    vec![
                        Label::new("chooser/name-label", &self.strings.name, body()).into(),
                        Column::new(
                            "chooser/name-field",
                            vec![
                                Entry::new("chooser/name", &self.strings.name, "name-change", name)
                                    .submit("accept")
                                    .into(),
                            ],
                        )
                        .grow()
                        .into(),
                    ],
                )
                .align(Align::Center)
                .gap(Space::S3)
                .into(),
            );
        }
        content.extend([
            nav,
            Row::new("chooser/tools", controls)
                .align(Align::Center)
                .gap(Space::S3)
                .into(),
        ]);
        if let Some(folder) = &self.new_folder {
            content.push(
                Row::new(
                    "chooser/new-folder-row",
                    vec![
                        Column::new(
                            "chooser/new-folder-field",
                            vec![
                                Entry::new(
                                    "chooser/new-folder-name",
                                    &self.strings.folder_name,
                                    "new-folder-change",
                                    folder,
                                )
                                .placeholder(&self.strings.folder_name)
                                .submit("new-folder-go")
                                .into(),
                            ],
                        )
                        .grow()
                        .into(),
                        Button::new(
                            "chooser/new-folder-cancel",
                            &self.strings.cancel,
                            "new-folder-cancel",
                            body(),
                        )
                        .into(),
                        Button::new(
                            "chooser/new-folder-go",
                            &self.strings.create,
                            "new-folder-go",
                            body(),
                        )
                        .enabled(request::valid_name(std::ffi::OsStr::new(folder)))
                        .into(),
                    ],
                )
                .align(Align::Center)
                .gap(Space::S2)
                .into(),
            );
        }
        content.extend([Row::new("chooser/list-and-preview", listing)
            .gap(Space::S3)
            .grow()
            .into()]);
        let message = self
            .message
            .clone()
            .or_else(|| {
                self.listing
                    .error()
                    .map(|_| self.strings.unreadable_location.clone())
            })
            .or_else(|| self.listing.loading().then(|| self.strings.loading.clone()))
            .or_else(|| entries.is_empty().then(|| self.strings.empty.clone()));
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
                    Button::new("chooser/cancel", &self.strings.cancel, "cancel", body()).into(),
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
            sidebar: PlacesSidebar::new(
                "chooser/places",
                &self.places,
                "place",
                body(),
                look.types.style(Type::Caption, Weight::Medium),
                look.frame.icon,
            )
            .headings([
                &self.strings.places,
                &self.strings.bookmarks,
                &self.strings.drives,
            ])
            .current(&self.path)
            .into(),
            content: Column::new("chooser/content", content)
                .gap(Space::S3)
                .padding(nk::Padding::all(Space::S3))
                .into(),
            title: self.title.clone(),
            can_back: !self.back.is_empty(),
            can_forward: !self.forward.is_empty(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("nk-chooser-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("home")).unwrap();
        dir
    }
    fn browser(dir: &Path, method: &str, name: &str, files: &[&str]) -> Browser {
        let mut bytes = dir.as_os_str().as_encoded_bytes().to_vec();
        bytes.push(0);
        let spec = Request {
            method: method.into(),
            current_folder: bytes,
            current_name: name.into(),
            files: files
                .iter()
                .map(|f| [f.as_bytes(), b"\0"].concat())
                .collect(),
            ..Default::default()
        };
        let sources = Sources {
            home: dir.join("home"),
            config: dir.join("config"),
            data: dir.join("data"),
            cache: dir.join("cache"),
            mountinfo: dir.join("mountinfo"),
            media: None,
        };
        let mut b = Browser::new(spec, sources, Strings::default()).unwrap();
        settle(&mut b);
        b
    }
    fn settle(b: &mut Browser) {
        for _ in 0..500 {
            b.poll().unwrap();
            if !b.listing.loading() {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(2));
        }
        panic!("the listing never finished");
    }
    fn act(b: &mut Browser, action: &str, value: Option<Value>) -> Option<Outcome> {
        let outcome = b
            .activate(Activated {
                key: "test".into(),
                action: action.into(),
                value,
            })
            .unwrap();
        settle(b);
        outcome
    }
    fn uris(outcome: Option<Outcome>) -> Vec<String> {
        match outcome {
            Some(Outcome::Done(r)) => r.uris,
            Some(Outcome::Replace { .. }) => panic!("asked to replace"),
            None => panic!("nothing accepted"),
        }
    }

    #[test]
    fn save_asks_before_replacing_and_enters_a_folder_typed_or_made() {
        let dir = folder("save");
        std::fs::write(dir.join("taken.txt"), "x").unwrap();
        std::fs::create_dir(dir.join("Docs")).unwrap();
        let mut b = browser(&dir, "SaveFile", "new.txt", &[]);
        assert_eq!(b.focus, Some("chooser/name"));
        assert!(b.can_accept());
        let base = files::file_uri(&dir).unwrap();
        assert_eq!(
            uris(act(&mut b, "accept", None)),
            [format!("{base}/new.txt")]
        );

        // A file that is there: the question first, with its name and folder.
        act(&mut b, "name-change", Some(Value::Text("taken.txt".into())));
        match act(&mut b, "accept", None) {
            Some(Outcome::Replace { name, response, .. }) => {
                assert_eq!(name, "taken.txt");
                assert_eq!(response.uris, [format!("{base}/taken.txt")]);
            }
            _ => panic!("saved over a file without asking"),
        }

        // No name, or one that is not one name: nothing is accepted.
        for bad in ["", "a/b", ".."] {
            act(&mut b, "name-change", Some(Value::Text(bad.into())));
            assert!(!b.can_accept(), "{bad:?} could be saved");
            assert!(act(&mut b, "accept", None).is_none());
        }

        // A folder's name typed: into it, the name kept for the next try.
        act(&mut b, "name-change", Some(Value::Text("Docs".into())));
        assert!(act(&mut b, "accept", None).is_none());
        assert_eq!(b.path, dir.join("Docs"));
        assert!(matches!(&b.saving, Saving::One { name } if name == "Docs"));

        // A new folder: made and entered.
        act(&mut b, "new-folder", None);
        assert_eq!(b.focus, Some("chooser/new-folder-name"));
        act(
            &mut b,
            "new-folder-change",
            Some(Value::Text("Inside".into())),
        );
        act(&mut b, "new-folder-go", None);
        assert!(dir.join("Docs/Inside").is_dir());
        assert_eq!(b.path, dir.join("Docs/Inside"));
        assert!(b.new_folder.is_none());

        // Picking a file in the list lends its name.
        std::fs::write(dir.join("Docs/Inside/picked.odt"), "x").unwrap();
        act(&mut b, "new-folder-cancel", None);
        b.navigate(dir.join("Docs/Inside")).unwrap();
        settle(&mut b);
        let i = b
            .listing
            .entries()
            .iter()
            .position(|e| e.path.ends_with("picked.odt"))
            .unwrap();
        act(&mut b, "cursor", Some(Value::Index(i)));
        assert!(matches!(&b.saving, Saving::One { name } if name == "picked.odt"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_files_keeps_every_name_without_writing_over_one() {
        let dir = folder("save-files");
        std::fs::write(dir.join("a.txt"), "x").unwrap();
        let mut b = browser(&dir, "SaveFiles", "", &["a.txt", "b.txt", "a.txt"]);
        let base = files::file_uri(&dir).unwrap();
        assert_eq!(
            uris(act(&mut b, "accept", None)),
            [
                format!("{base}/a%20(2).txt"),
                format!("{base}/b.txt"),
                format!("{base}/a%20(3).txt"),
            ]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
