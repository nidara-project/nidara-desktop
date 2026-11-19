// SPDX-License-Identifier: LGPL-3.0-or-later
use nk::files::Filter;
use serde::{Deserialize, Serialize};
use std::{
    ffi::OsString,
    os::unix::ffi::OsStringExt,
    path::{Path, PathBuf},
};

pub type WireFilter = (String, Vec<(u32, String)>);

#[derive(Deserialize)]
#[serde(default)]
pub struct Request {
    /// The portal's method: `OpenFile`, `SaveFile` or `SaveFiles`.
    pub method: String,
    pub parent_window: String,
    pub title: String,
    pub accept_label: String,
    pub modal: bool,
    pub directory: bool,
    pub multiple: bool,
    pub filters: Vec<WireFilter>,
    pub current_filter: Option<WireFilter>,
    pub current_folder: Vec<u8>,
    /// SaveFile: the name the app proposes, and the file it saves over (its folder and name
    /// win over `current_folder` and `current_name`).
    pub current_name: String,
    pub current_file: Vec<u8>,
    /// SaveFiles: the names of the files the app saves into the folder chosen.
    pub files: Vec<Vec<u8>>,
}

impl Default for Request {
    fn default() -> Self {
        Self {
            method: "OpenFile".into(),
            parent_window: String::new(),
            title: String::new(),
            accept_label: String::new(),
            modal: true,
            directory: false,
            multiple: false,
            filters: Vec::new(),
            current_filter: None,
            current_folder: Vec::new(),
            current_name: String::new(),
            current_file: Vec::new(),
            files: Vec::new(),
        }
    }
}

#[derive(Serialize)]
pub struct Response {
    pub uris: Vec<String>,
    pub current_filter: Option<WireFilter>,
}

pub struct Filters {
    items: Vec<(WireFilter, Filter)>,
    pub chosen: usize,
}
impl Filters {
    pub fn new(items: Vec<WireFilter>, initial: Option<WireFilter>) -> Result<Self, String> {
        let mut items = items;
        if items.is_empty() {
            items.extend(initial.iter().cloned());
        }
        let chosen = initial
            .as_ref()
            .and_then(|current| items.iter().position(|item| item == current))
            .unwrap_or_default();
        let items = items
            .into_iter()
            .map(|item| {
                let filter = Filter::new(&item.0, &item.1)?;
                Ok((item, filter))
            })
            .collect::<Result<Vec<_>, String>>()?;
        Ok(Self { items, chosen })
    }
    pub fn labels(&self) -> Vec<String> {
        self.items.iter().map(|(wire, _)| wire.0.clone()).collect()
    }
    pub fn select(&mut self, index: usize) -> bool {
        if index >= self.items.len() || index == self.chosen {
            return false;
        }
        self.chosen = index;
        true
    }
    pub fn rule(&self) -> Option<Filter> {
        self.items
            .get(self.chosen)
            .map(|(_, filter)| filter.clone())
    }
    pub fn wire(&self) -> Option<WireFilter> {
        self.items.get(self.chosen).map(|(wire, _)| wire.clone())
    }
}

pub fn folder(bytes: Vec<u8>) -> Option<PathBuf> {
    let bytes = bytes.strip_suffix(&[0])?;
    if bytes.contains(&0) {
        return None;
    }
    let path = PathBuf::from(OsString::from_vec(bytes.to_vec()));
    path.is_absolute().then_some(path)
}

/// A file name the portal sent (a NUL-terminated byte string): one name, no folder.
pub fn file_name(bytes: Vec<u8>) -> Option<OsString> {
    let bytes = bytes.strip_suffix(&[0]).unwrap_or(&bytes);
    let name = OsString::from_vec(bytes.to_vec());
    valid_name(&name).then_some(name)
}

/// A name a file can be saved under in a folder: not empty, not `.` or `..`, no `/` or NUL.
pub fn valid_name(name: &std::ffi::OsStr) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes != b"."
        && bytes != b".."
        && !bytes.contains(&b'/')
        && !bytes.contains(&0)
}

/// `name` in `folder`, or `name (2)`, `name (3)`… before its extension when that is taken:
/// how SaveFiles keeps every file it was given without writing over one already there.
pub fn free_name(folder: &Path, name: &std::ffi::OsStr, taken: impl Fn(&Path) -> bool) -> PathBuf {
    let first = folder.join(name);
    if !taken(&first) {
        return first;
    }
    let path = Path::new(name);
    let stem = path.file_stem().unwrap_or(name).to_string_lossy();
    let extension = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|n| folder.join(format!("{stem} ({n}){extension}")))
        .find(|candidate| !taken(candidate))
        .expect("an unbounded range finds a free name")
}

pub fn location(input: &str, home: &Path) -> Option<PathBuf> {
    if input == "~" {
        Some(home.to_owned())
    } else if let Some(tail) = input.strip_prefix("~/") {
        Some(home.join(tail.trim_start_matches('/')))
    } else if input.starts_with('/') && !input.contains('\0') {
        Some(input.into())
    } else {
        None
    }
}

pub fn label(text: &str) -> String {
    let mut out = String::new();
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if ch == '_' {
            if let Some(next) = chars.next() {
                out.push(next);
            }
        } else {
            out.push(ch);
        }
    }
    out
}

#[cfg(test)]
#[test]
fn wire_options_keep_path_bytes_and_the_selected_filter() {
    use std::os::unix::ffi::OsStrExt;
    assert_eq!(
        folder(vec![b'/', 0xff, 0]).unwrap().as_os_str().as_bytes(),
        &[b'/', 0xff]
    );
    assert!(folder(b"/one\0two\0".to_vec()).is_none());
    let current = ("Images".into(), vec![(1, "image/*".into())]);
    let filters = Filters::new(Vec::new(), Some(current.clone())).unwrap();
    assert_eq!(filters.wire(), Some(current));
    assert_eq!(
        location("~//Pictures", Path::new("/home/test")).unwrap(),
        Path::new("/home/test/Pictures")
    );
    assert_eq!(label("_Open __selected"), "Open _selected");
}

#[cfg(test)]
#[test]
fn save_names_are_one_name_and_never_overwrite_in_save_files() {
    use std::ffi::OsStr;
    assert_eq!(file_name(b"report.pdf\0".to_vec()).unwrap(), "report.pdf");
    assert!(file_name(b"../x\0".to_vec()).is_none());
    assert!(file_name(b"..\0".to_vec()).is_none());
    assert!(!valid_name(OsStr::new("")));
    let taken = |p: &Path| p.ends_with("a.txt") || p.ends_with("a (2).txt");
    assert_eq!(
        free_name(Path::new("/f"), OsStr::new("a.txt"), taken),
        Path::new("/f/a (3).txt")
    );
    assert_eq!(
        free_name(Path::new("/f"), OsStr::new("b"), taken),
        Path::new("/f/b")
    );
    assert_eq!(
        free_name(Path::new("/f"), OsStr::new("a.txt"), |p: &Path| p
            .ends_with("a.txt")),
        Path::new("/f/a (2).txt")
    );
}
