// SPDX-License-Identifier: LGPL-3.0-or-later
use std::{
    env,
    ffi::OsString,
    fmt::Write,
    fs, io,
    os::unix::ffi::OsStringExt,
    path::{Component, Path, PathBuf},
};
use url::Url;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PlaceKind {
    Home,
    UserDir,
    Bookmark,
    Drive,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Place {
    pub kind: PlaceKind,
    pub name: String,
    pub location: Location,
}
impl Place {
    pub fn path(&self) -> Option<&Path> {
        match &self.location {
            Location::Local(path) => Some(path),
            Location::Remote(_) => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Location {
    Local(PathBuf),
    Remote(String),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Recent {
    pub uri: String,
    pub title: Option<String>,
    pub modified: Option<String>,
}

/// Paths for the freedesktop data sources. No files are written by the model.
#[derive(Clone, Debug)]
pub struct Sources {
    pub home: PathBuf,
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    pub mountinfo: PathBuf,
    pub media: Option<PathBuf>,
}

impl Sources {
    pub fn user() -> io::Result<Self> {
        let home = env::var_os("HOME")
            .filter(|home| Path::new(home).is_absolute())
            .map(PathBuf::from)
            .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no home directory"))?;
        let xdg = |var, fallback| {
            env::var_os(var)
                .filter(|p| Path::new(p).is_absolute())
                .map_or_else(|| home.join(fallback), PathBuf::from)
        };
        let media = env::var_os("USER")
            .filter(|user| !user.is_empty() && Path::new(user).file_name() == Some(user))
            .map(|user| Path::new("/run/media").join(user));
        Ok(Self {
            config: xdg("XDG_CONFIG_HOME", ".config"),
            data: xdg("XDG_DATA_HOME", ".local/share"),
            cache: xdg("XDG_CACHE_HOME", ".cache"),
            home,
            mountinfo: "/proc/self/mountinfo".into(),
            media,
        })
    }

    pub fn mime_db(&self) -> crate::MimeDb {
        let dirs = env::var_os("XDG_DATA_DIRS")
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
        crate::MimeDb::load(
            std::iter::once(self.data.join("mime")).chain(
                env::split_paths(&dirs)
                    .filter(|p| p.is_absolute())
                    .map(|p| p.join("mime")),
            ),
        )
    }

    pub fn places(&self) -> Vec<Place> {
        let mut places = vec![Place {
            kind: PlaceKind::Home,
            name: "Home".into(),
            location: Location::Local(self.home.clone()),
        }];
        if let Ok(dirs) = fs::read_to_string(self.config.join("user-dirs.dirs")) {
            for line in dirs.lines() {
                if let Some(path) = user_dir(line, &self.home)
                    && !places.iter().any(|place| place.path() == Some(&path))
                {
                    places.push(place(path, PlaceKind::UserDir, None));
                }
            }
        }
        if let Ok(bookmarks) = fs::read_to_string(self.config.join("gtk-3.0/bookmarks")) {
            places.extend(bookmarks.lines().filter_map(bookmark));
        }
        if let (Some(media), Ok(mounts)) = (&self.media, fs::read(&self.mountinfo)) {
            for path in mounts
                .split(|&byte| byte == b'\n')
                .filter_map(|line| {
                    line.split(u8::is_ascii_whitespace)
                        .filter(|field| !field.is_empty())
                        .nth(4)
                })
                .map(mount_path)
            {
                if path.parent() == Some(media)
                    && fs::read_dir(&path).is_ok()
                    && !places
                        .iter()
                        .any(|place| place.kind == PlaceKind::Drive && place.path() == Some(&path))
                {
                    places.push(place(path, PlaceKind::Drive, None));
                }
            }
        }
        places
    }

    pub fn recents(&self) -> io::Result<Vec<Recent>> {
        let data = match fs::read_to_string(self.data.join("recently-used.xbel")) {
            Ok(data) => data,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let xml = roxmltree::Document::parse(&data).map_err(io::Error::other)?;
        let mut recent: Vec<_> = xml
            .root_element()
            .children()
            .filter(|node| node.has_tag_name("bookmark"))
            .filter_map(|node| {
                Some(Recent {
                    uri: node.attribute("href")?.to_owned(),
                    title: node
                        .children()
                        .find(|n| n.has_tag_name("title"))
                        .and_then(|n| n.text())
                        .map(str::to_owned),
                    modified: node.attribute("modified").map(str::to_owned),
                })
            })
            .collect();
        recent.sort_by(|a, b| b.modified.cmp(&a.modified));
        Ok(recent)
    }

    /// Find the existing thumbnail for a local absolute path. Large previews prefer the
    /// large cache, while either size may use the other when it is the only cached copy.
    pub fn thumbnail(&self, path: &Path, large: bool) -> Option<PathBuf> {
        self.thumbnail_uri(&file_uri(path)?, large)
    }

    /// Hash the exact URI when a caller already has one, as with recent files.
    pub fn thumbnail_uri(&self, uri: &str, large: bool) -> Option<PathBuf> {
        let filename = format!("{:x}.png", md5::compute(uri));
        let sizes = if large {
            ["large", "normal"]
        } else {
            ["normal", "large"]
        };
        sizes
            .into_iter()
            .map(|size| self.cache.join("thumbnails").join(size).join(&filename))
            .find(|path| path.is_file())
    }
}

fn place(path: PathBuf, kind: PlaceKind, label: Option<&str>) -> Place {
    Place {
        name: label
            .filter(|label| !label.is_empty())
            .map_or_else(|| crate::listing::name(&path), str::to_owned),
        location: Location::Local(path),
        kind,
    }
}

fn bookmark(line: &str) -> Option<Place> {
    let line = line.trim();
    let (uri, label) = line
        .split_once(char::is_whitespace)
        .map_or((line, None), |(uri, label)| {
            (uri, Some(label.trim()).filter(|label| !label.is_empty()))
        });
    let parsed = Url::parse(uri).ok()?;
    if let Ok(path) = parsed.to_file_path() {
        return Some(place(path, PlaceKind::Bookmark, label));
    }
    Some(Place {
        kind: PlaceKind::Bookmark,
        name: label
            .unwrap_or_else(|| parsed.host_str().unwrap_or(parsed.scheme()))
            .to_owned(),
        location: Location::Remote(uri.to_owned()),
    })
}

fn user_dir(line: &str, home: &Path) -> Option<PathBuf> {
    let (key, value) = line.trim().split_once('=')?;
    if !key.starts_with("XDG_") || !key.ends_with("_DIR") {
        return None;
    }
    let value = value.strip_prefix('"')?.strip_suffix('"')?;
    let (root, value) = match value.strip_prefix("$HOME") {
        Some("") => return Some(home.to_owned()),
        Some(suffix) => (Some(home), suffix.strip_prefix('/')?),
        None => (None, value),
    };
    let mut unescaped = String::new();
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' => unescaped.push(chars.next()?),
            '$' | '`' | '"' => return None,
            _ => unescaped.push(ch),
        }
    }
    let path = root.map_or_else(|| PathBuf::from(&unescaped), |home| home.join(&unescaped));
    path.is_absolute().then_some(path)
}

fn mount_path(mut bytes: &[u8]) -> PathBuf {
    let mut raw = Vec::new();
    while let [first, rest @ ..] = bytes {
        if let [
            b'\\',
            a @ b'0'..=b'3',
            b @ b'0'..=b'7',
            c @ b'0'..=b'7',
            tail @ ..,
        ] = bytes
        {
            raw.push((a - b'0') * 64 + (b - b'0') * 8 + (c - b'0'));
            bytes = tail;
        } else {
            raw.push(*first);
            bytes = rest;
        }
    }
    PathBuf::from(OsString::from_vec(raw))
}

/// Canonical URI used by GTK thumbnail producers. Encode Linux path bytes
/// directly, retaining the URI path characters those producers leave unescaped.
pub fn file_uri(path: &Path) -> Option<String> {
    if !path.is_absolute() {
        return None;
    }
    let mut uri = String::from("file://");
    let mut segments = Vec::new();
    for part in path.components() {
        match part {
            Component::Normal(name) => {
                segments.push(uri.len());
                uri.push('/');
                for &byte in name.as_encoded_bytes() {
                    if byte.is_ascii_alphanumeric() || b"-._~!$&'()*+,=:@".contains(&byte) {
                        uri.push(char::from(byte));
                    } else {
                        write!(uri, "%{byte:02X}").expect("writing to String");
                    }
                }
            }
            Component::ParentDir => {
                if let Some(start) = segments.pop() {
                    uri.truncate(start);
                }
            }
            _ => {}
        }
    }
    if segments.is_empty() {
        uri.push('/');
    }
    Some(uri)
}
