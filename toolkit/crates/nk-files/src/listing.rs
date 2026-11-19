// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{Filter, MimeDb};
use std::{
    cmp::Ordering,
    ffi::OsStr,
    fs, io,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering as AtomicOrdering},
        mpsc::{self, Receiver, TryRecvError},
    },
    time::SystemTime,
};

#[derive(Clone, Debug)]
pub struct Entry {
    pub path: PathBuf,
    pub name: String,
    pub size: u64,
    pub modified: Option<SystemTime>,
    pub is_dir: bool,
    pub mime: String,
    pub icon: String,
    name_key: String,
}

#[derive(Clone, Copy, Debug, Default)]
pub enum Sort {
    #[default]
    Name,
    Modified,
    Size,
}

#[derive(Clone, Debug, Default)]
pub struct Options {
    pub sort: Sort,
    pub descending: bool,
    pub show_hidden: bool,
    pub filter: Option<Filter>,
}
impl Options {
    fn compare(&self, a: &Entry, b: &Entry) -> Ordering {
        let name = || {
            a.name_key
                .cmp(&b.name_key)
                .then_with(|| a.path.cmp(&b.path))
        };
        let order = match self.sort {
            Sort::Name => name(),
            Sort::Modified => a.modified.cmp(&b.modified).then_with(name),
            Sort::Size => a.size.cmp(&b.size).then_with(name),
        };
        b.is_dir.cmp(&a.is_dir).then(if self.descending {
            order.reverse()
        } else {
            order
        })
    }
}

const BATCH: usize = 256;

/// A nonblocking, progressively sorted directory listing. Drop it to abandon a scan.
pub struct Listing {
    entries: Vec<Entry>,
    results: Option<Receiver<io::Result<Vec<Entry>>>>,
    options: Options,
    error: Option<io::Error>,
    cancelled: Arc<AtomicBool>,
}
impl Listing {
    pub fn start(path: PathBuf, options: Options, mime: Arc<MimeDb>) -> io::Result<Self> {
        let (sender, results) = mpsc::sync_channel(2);
        let worker_options = options.clone();
        let cancelled = Arc::new(AtomicBool::new(false));
        let stop = Arc::clone(&cancelled);
        std::thread::Builder::new()
            .name("file-listing".into())
            .spawn(move || {
                let read = match fs::read_dir(path) {
                    Ok(read) => read,
                    Err(error) => {
                        let _ = sender.send(Err(error));
                        return;
                    }
                };
                let mut batch = Vec::with_capacity(BATCH);
                for item in read {
                    if stop.load(AtomicOrdering::Relaxed) {
                        return;
                    }
                    match item {
                        Ok(item) => {
                            if let Some(entry) = read_entry(item, &worker_options, &mime) {
                                batch.push(entry);
                            }
                        }
                        Err(err) => {
                            let _ = sender.send(Err(err));
                            return;
                        }
                    }
                    if batch.len() == BATCH {
                        batch.sort_unstable_by(|a, b| worker_options.compare(a, b));
                        if sender
                            .send(Ok(std::mem::replace(&mut batch, Vec::with_capacity(BATCH))))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
                if !batch.is_empty() {
                    batch.sort_unstable_by(|a, b| worker_options.compare(a, b));
                    let _ = sender.send(Ok(batch));
                }
            })?;
        Ok(Self {
            entries: Vec::new(),
            results: Some(results),
            options,
            error: None,
            cancelled,
        })
    }

    /// Take at most one batch. Returns true when rows, completion, or error changed.
    pub fn poll(&mut self) -> bool {
        let Some(results) = &self.results else {
            return false;
        };
        match results.try_recv() {
            Ok(Ok(batch)) => {
                self.merge(batch);
                true
            }
            Ok(Err(error)) => {
                self.results = None;
                self.error = Some(error);
                true
            }
            Err(TryRecvError::Disconnected) => {
                self.results = None;
                true
            }
            Err(TryRecvError::Empty) => false,
        }
    }

    fn merge(&mut self, batch: Vec<Entry>) {
        let mut entries = Vec::with_capacity(self.entries.len() + batch.len());
        let mut old = std::mem::take(&mut self.entries).into_iter().peekable();
        for entry in batch {
            while old
                .peek()
                .is_some_and(|row| self.options.compare(row, &entry).is_le())
            {
                entries.extend(old.next());
            }
            entries.push(entry);
        }
        entries.extend(old);
        self.entries = entries;
    }

    pub fn entries(&self) -> &[Entry] {
        &self.entries
    }
    pub fn loading(&self) -> bool {
        self.results.is_some()
    }
    pub fn error(&self) -> Option<&io::Error> {
        self.error.as_ref()
    }
}

impl Drop for Listing {
    fn drop(&mut self) {
        self.cancelled.store(true, AtomicOrdering::Relaxed);
    }
}

fn read_entry(item: fs::DirEntry, options: &Options, mime: &MimeDb) -> Option<Entry> {
    let raw = item.file_name();
    let name = raw.to_string_lossy();
    if !options.show_hidden && name.starts_with('.') {
        return None;
    }
    let path = item.path();
    let metadata = item.metadata().ok()?;
    let metadata = if metadata.is_symlink() {
        fs::metadata(&path).unwrap_or(metadata)
    } else {
        metadata
    };
    let is_dir = metadata.is_dir();
    let kind = if is_dir {
        "inode/directory"
    } else {
        mime.guess(&name)
    };
    if !is_dir
        && options
            .filter
            .as_ref()
            .is_some_and(|filter| !filter.matches(&name, kind))
    {
        return None;
    }
    Some(Entry {
        path,
        name_key: name.to_lowercase(),
        name: name.into_owned(),
        size: metadata.len(),
        modified: metadata.modified().ok(),
        is_dir,
        mime: kind.to_owned(),
        icon: mime.icon(kind),
    })
}

pub(crate) fn name(path: &Path) -> String {
    path.file_name()
        .unwrap_or_else(|| OsStr::new("/"))
        .to_string_lossy()
        .into_owned()
}
