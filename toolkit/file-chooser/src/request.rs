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
    pub parent_window: String,
    pub title: String,
    pub accept_label: String,
    pub modal: bool,
    pub directory: bool,
    pub multiple: bool,
    pub filters: Vec<WireFilter>,
    pub current_filter: Option<WireFilter>,
    pub current_folder: Vec<u8>,
}

impl Default for Request {
    fn default() -> Self {
        Self {
            parent_window: String::new(),
            title: String::new(),
            accept_label: String::new(),
            modal: true,
            directory: false,
            multiple: false,
            filters: Vec::new(),
            current_filter: None,
            current_folder: Vec::new(),
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
