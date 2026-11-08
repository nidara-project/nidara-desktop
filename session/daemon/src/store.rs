// SPDX-License-Identifier: GPL-3.0-or-later
//! Append-only notification journal; only compaction rewrites the live set.
use crate::model::{Notification, truthy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{self, BufRead, Write},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use zbus::zvariant::OwnedValue;

#[derive(Clone)]
pub struct Store {
    pub dir: PathBuf,
    lines: Arc<AtomicUsize>,
    health: Arc<Mutex<Health>>,
}
#[derive(Default)]
struct Health {
    dirty: bool,
    protect_input: bool,
    warned: bool,
    disabled: bool,
}
#[derive(Deserialize, Serialize)]
struct History {
    version: u32,
    notifications: Vec<Notification>,
}
#[derive(Deserialize, Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum Change {
    Put { notification: Notification },
    Remove { ids: Vec<u32> },
}
fn private_dir(path: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}
impl Store {
    pub fn at(dir: PathBuf) -> Self {
        Self {
            dir,
            lines: Arc::new(AtomicUsize::new(0)),
            health: Default::default(),
        }
    }
    pub fn new() -> io::Result<Self> {
        let cache = std::env::var_os("XDG_CACHE_HOME")
            .filter(|p| Path::new(p).is_absolute())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".cache")))
            .ok_or_else(|| io::Error::other("neither XDG_CACHE_HOME nor HOME is available"))?;
        Ok(Self::at(cache.join("nidara/notifd")))
    }
    fn load(&self) -> io::Result<(Vec<Notification>, bool)> {
        private_dir(&self.dir)?;
        let path = self.dir.join("history.jsonl");
        let legacy = self.dir.join("state.json");
        let mut live: Vec<Notification> = Vec::new();
        let mut needs_publication = false;
        match fs::File::open(&path) {
            Ok(file) => {
                let mut reader = io::BufReader::new(file);
                let mut bytes = Vec::new();
                loop {
                    bytes.clear();
                    if reader.read_until(b'\n', &mut bytes)? == 0 {
                        break;
                    }
                    if !bytes.ends_with(b"\n") {
                        eprintln!("[notifd] ignored incomplete journal tail");
                        needs_publication = true;
                        break;
                    }
                    let change: Change =
                        serde_json::from_slice(&bytes).map_err(io::Error::other)?;
                    match change {
                        Change::Put { notification: n } => {
                            if let Some(old) = live.iter_mut().find(|v| v.id == n.id) {
                                *old = n;
                            } else {
                                live.push(n);
                            }
                        }
                        Change::Remove { ids } => {
                            let ids: HashSet<_> = ids.into_iter().collect();
                            live.retain(|n| !ids.contains(&n.id));
                        }
                    }
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => match fs::read(&legacy) {
                Ok(bytes) => {
                    // Until import is published, a new journal containing only
                    // the next arrival would hide the legacy history on restart.
                    needs_publication = true;
                    live = serde_json::from_slice::<History>(&bytes)
                        .map_err(io::Error::other)?
                        .notifications
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            },
            Err(e) => return Err(e),
        }
        live.retain(|n| !truthy(n.hints.get("transient")));
        Ok((live, needs_publication))
    }
    #[cfg(test)]
    pub fn restore(&self) -> io::Result<Vec<Notification>> {
        let (live, _) = self.load()?;
        self.compact(&live)?;
        self.remove_legacy()?;
        Ok(live)
    }
    fn remove_legacy(&self) -> io::Result<()> {
        match fs::remove_file(self.dir.join("state.json")) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        Ok(())
    }
    pub fn volatile(error: impl std::fmt::Display) -> Self {
        let store = Self::at(PathBuf::new());
        let mut health = store.health.lock().unwrap();
        health.disabled = true;
        Self::warn(&mut health, error);
        drop(health);
        store
    }
    fn warn(health: &mut Health, error: impl std::fmt::Display) {
        if !health.warned {
            eprintln!(
                "[notifd] history is not durable; notifications remain available in memory: {error}"
            );
            health.warned = true;
        }
    }
    // A damaged input must never be overwritten by recovery. Failed renames keep
    // writes disabled until the original can be preserved, even across retries.
    fn preserve_input(&self, health: &mut Health) -> io::Result<()> {
        if health.protect_input {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            for name in ["history.jsonl", "state.json"] {
                let path = self.dir.join(name);
                match fs::rename(&path, self.dir.join(format!("{name}.broken-{stamp}"))) {
                    Ok(()) => {}
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                    Err(e) => return Err(e),
                }
            }
            health.protect_input = false;
        }
        Ok(())
    }
    /// Notification storage never prevents the other session services starting.
    pub fn startup(&self) -> Vec<Notification> {
        let mut health = self.health.lock().unwrap();
        if health.disabled {
            return vec![];
        }
        let (mut live, needs_publication) = match self.load() {
            Ok(rows) => rows,
            Err(e) => {
                Self::warn(&mut health, e);
                health.protect_input = true;
                health.dirty = true;
                (vec![], false)
            }
        };
        let now = crate::model::now();
        let expired: HashSet<_> =
            crate::model::retention(&live, now, crate::model::today_start(now))
                .into_iter()
                .collect();
        live.retain(|n| !expired.contains(&n.id));
        // An optional startup compaction may fail while a valid journal still
        // accepts appends. A partial/corrupt/legacy input needs publication first.
        health.dirty |= needs_publication;
        let published = self
            .preserve_input(&mut health)
            .and_then(|()| self.compact(&live));
        match published {
            Ok(()) => {
                health.dirty = false;
                if let Err(e) = self.remove_legacy() {
                    Self::warn(&mut health, e);
                }
            }
            Err(e) => Self::warn(&mut health, e),
        }
        // Never collect images against an unknown/damaged history.
        if !health.dirty
            && let Err(e) = self.clean_images(&live)
        {
            Self::warn(&mut health, e);
        }
        live
    }
    /// Best-effort durability. The caller always commits the live model/signals.
    /// After a gap, publish that live model before appending the next operation.
    pub fn record(&self, change: &Change, live: &[Notification]) {
        let mut health = self.health.lock().unwrap();
        if health.disabled {
            return;
        }
        let result = (|| {
            if health.dirty {
                self.preserve_input(&mut health)?;
                self.compact(live)?;
            }
            self.append(change, live)
        })();
        match result {
            Ok(()) => {
                health.dirty = false;
                if health.warned {
                    eprintln!("[notifd] notification history is durable again");
                    health.warned = false;
                }
            }
            Err(e) => {
                health.dirty = true;
                Self::warn(&mut health, e);
            }
        }
    }
    pub fn append(&self, change: &Change, live: &[Notification]) -> io::Result<()> {
        // Amortized compaction, before the next operation, never N calls for a bulk removal.
        if self.lines.load(Ordering::Relaxed) > live.len().max(1) * 2 {
            self.compact(live)?;
        }
        let mut bytes = serde_json::to_vec(change).map_err(io::Error::other)?;
        bytes.push(b'\n');
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(self.dir.join("history.jsonl"))?;
        let before = file.metadata()?.len();
        if let Err(e) = file.write_all(&bytes).and_then(|_| file.sync_data()) {
            // Preserve the original disk error even if rollback also fails.
            // record() then requires a full recovery before any later append.
            let _ = file.set_len(before).and_then(|()| file.sync_data());
            return Err(e);
        }
        self.lines.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
    pub fn compact(&self, live: &[Notification]) -> io::Result<()> {
        private_dir(&self.dir)?;
        let tmp = self.dir.join("history.jsonl.tmp");
        let mut file = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(&tmp)?;
        for n in live.iter().filter(|n| !truthy(n.hints.get("transient"))) {
            serde_json::to_writer(
                &mut file,
                &Change::Put {
                    notification: n.clone(),
                },
            )
            .map_err(io::Error::other)?;
            file.write_all(b"\n")?;
        }
        file.sync_all()?;
        fs::rename(tmp, self.dir.join("history.jsonl"))?;
        fs::File::open(&self.dir)?.sync_all()?;
        self.lines.store(live.len(), Ordering::Relaxed);
        Ok(())
    }
    pub fn owned_image(&self, n: &Notification) -> Option<PathBuf> {
        if !self.dir.is_absolute() {
            return None;
        }
        let raw = n
            .hints
            .get("image-path")
            .and_then(serde_json::Value::as_str)
            .filter(|v| !v.is_empty())
            .or_else(|| {
                n.hints
                    .get("image_path")
                    .and_then(serde_json::Value::as_str)
            })?;
        let p = PathBuf::from(raw);
        let stem = p.file_stem()?.to_str()?;
        (p.parent() == Some(self.dir.join("images").as_path())
            && p.extension()?.to_str()? == "png"
            && stem.len() == 32
            && stem.bytes().all(|b| b.is_ascii_hexdigit()))
        .then_some(p)
    }
    pub fn clean_images(&self, live: &[Notification]) -> io::Result<()> {
        let keep: HashSet<_> = live.iter().filter_map(|n| self.owned_image(n)).collect();
        match fs::read_dir(self.dir.join("images")) {
            Ok(files) => {
                for file in files {
                    let path = file?.path();
                    let owned = path
                        .file_name()
                        .and_then(|n| n.to_str())
                        .and_then(|n| {
                            n.strip_suffix(".png")
                                .or_else(|| n.strip_suffix(".png.tmp"))
                        })
                        .is_some_and(|stem| {
                            stem.len() == 32 && stem.bytes().all(|b| b.is_ascii_hexdigit())
                        });
                    if owned && !keep.contains(&path) {
                        fs::remove_file(path)?;
                    }
                }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        Ok(())
    }
    pub fn image(&self, hints: &HashMap<String, OwnedValue>) -> Option<String> {
        if !self.dir.is_absolute() {
            return None;
        }
        let raw = hints.get("image-data")?;
        match self.decode_image(raw) {
            Ok(path) => Some(path.to_string_lossy().into_owned()),
            Err(e) => {
                eprintln!("[notifd] could not decode image-data: {e}");
                None
            }
        }
    }
    fn decode_image(&self, value: &OwnedValue) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let (w, h, stride, alpha, bps, _channels, data): (i32, i32, i32, bool, i32, i32, Vec<u8>) =
            value.try_clone()?.try_into()?;
        // GdkPixbuf's RGB decoder used has-alpha for the channel count, not the
        // sender's redundant channels field. Its rowstride may include padding.
        let channels = if alpha { 4usize } else { 3 };
        if bps != 8 || w <= 0 || h <= 0 || stride <= 0 {
            return Err("unsupported image dimensions/bits per sample".into());
        }
        let row = (w as usize)
            .checked_mul(channels)
            .ok_or("image row overflow")?;
        let stride = stride as usize;
        let end = (h as usize - 1)
            .checked_mul(stride)
            .and_then(|n| n.checked_add(row))
            .ok_or("image size overflow")?;
        if stride < row || data.len() < end {
            return Err("short image-data or rowstride".into());
        }
        let dir = self.dir.join("images");
        private_dir(&dir)?;
        let hash = format!("{:x}", Sha256::digest(&data));
        let path = dir.join(format!("{}.png", &hash[..32]));
        if path.exists() {
            return Ok(path);
        }
        // Write packed rows. The final row need not include trailing padding.
        let mut pixels = Vec::with_capacity(row * h as usize);
        for y in 0..h as usize {
            pixels.extend_from_slice(&data[y * stride..y * stride + row]);
        }
        publish_image(&path, |file| {
            let mut encoder = png::Encoder::new(file, w as u32, h as u32);
            encoder.set_color(if alpha {
                png::ColorType::Rgba
            } else {
                png::ColorType::Rgb
            });
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header()?;
            writer.write_image_data(&pixels)?;
            // finish() reports errors writing IEND; Drop cannot report them.
            writer.finish()?;
            Ok(())
        })?;
        Ok(path)
    }
}
// A cache hit must always name a complete PNG. Keep a failed/partial encode
// out of the hash namespace, and use the same directory so rename is atomic.
fn publish_image(
    path: &Path,
    encode: impl FnOnce(&mut fs::File) -> Result<(), Box<dyn std::error::Error>>,
) -> Result<(), Box<dyn std::error::Error>> {
    let tmp = path.with_extension("png.tmp");
    let result = (|| {
        let mut file = fs::File::create(&tmp)?;
        encode(&mut file)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Write};
    use zbus::zvariant::Value as Variant;

    fn scratch(label: &str) -> Store {
        let p = std::env::temp_dir().join(format!(
            "notif-journal-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = Store::at(p);
        private_dir(&store.dir).unwrap();
        store
    }
    fn n(id: u32) -> Notification {
        serde_json::from_value(serde_json::json!({"id":id,"summary":"bounded record","time":123}))
            .unwrap()
    }
    #[test]
    fn startup_preserves_corrupt_input_and_can_continue_with_live_notifications() {
        let store = scratch("startup-corrupt");
        let bytes =
            b"{\"op\":\"remove\",\"ids\":[]}\nbroken interior\n{\"op\":\"remove\",\"ids\":[]}\n";
        fs::write(store.dir.join("history.jsonl"), bytes).unwrap();
        assert!(store.startup().is_empty());
        let saved = fs::read_dir(&store.dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .find(|p| {
                p.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with("history.jsonl.broken-")
            })
            .unwrap();
        assert_eq!(fs::read(saved).unwrap(), bytes);
        store.record(&Change::Put { notification: n(7) }, &[]);
        assert_eq!(store.restore().unwrap()[0].id, 7);
        fs::remove_dir_all(store.dir).unwrap();
    }
    #[test]
    fn startup_compaction_failure_does_not_prevent_a_valid_journal_append() {
        let store = scratch("startup-full");
        let mut first = n(1);
        first.hints.insert("urgency".into(), 2.into());
        store.compact(std::slice::from_ref(&first)).unwrap();
        fs::create_dir(store.dir.join("history.jsonl.tmp")).unwrap();
        let live = store.startup();
        assert_eq!(live.len(), 1);
        store.record(&Change::Put { notification: n(2) }, &live);
        assert_eq!(store.load().unwrap().0.len(), 2);
        fs::remove_dir_all(store.dir).unwrap();
    }
    #[test]
    fn failed_legacy_import_must_publish_all_live_records_before_creating_a_journal() {
        let store = scratch("legacy-full");
        let mut first = n(1);
        first.hints.insert("urgency".into(), 2.into());
        fs::write(
            store.dir.join("state.json"),
            serde_json::to_vec(&History {
                version: 1,
                notifications: vec![first],
            })
            .unwrap(),
        )
        .unwrap();
        let blocked = store.dir.join("history.jsonl.tmp");
        fs::create_dir(&blocked).unwrap();
        let mut live = store.startup();
        assert_eq!(live.len(), 1);
        store.record(&Change::Put { notification: n(2) }, &live);
        live.push(n(2));
        assert!(!store.dir.join("history.jsonl").exists());
        assert!(store.dir.join("state.json").exists());
        fs::remove_dir(blocked).unwrap();
        store.record(&Change::Put { notification: n(3) }, &live);
        assert_eq!(
            store
                .restore()
                .unwrap()
                .iter()
                .map(|n| n.id)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        fs::remove_dir_all(store.dir).unwrap();
    }
    #[test]
    fn refused_writes_recover_the_live_model_without_resurrecting_removed_records() {
        use std::os::unix::fs::PermissionsExt;
        let store = scratch("unwritable");
        store.compact(&[n(1)]).unwrap();
        let journal = store.dir.join("history.jsonl");
        fs::set_permissions(&journal, fs::Permissions::from_mode(0o400)).unwrap();
        fs::set_permissions(&store.dir, fs::Permissions::from_mode(0o500)).unwrap();
        store.record(&Change::Put { notification: n(2) }, &[n(1)]);
        store.record(&Change::Remove { ids: vec![1] }, &[n(1), n(2)]);
        assert!(store.health.lock().unwrap().dirty);
        assert!(store.health.lock().unwrap().warned);
        fs::set_permissions(&store.dir, fs::Permissions::from_mode(0o700)).unwrap();
        fs::set_permissions(&journal, fs::Permissions::from_mode(0o600)).unwrap();
        store.record(&Change::Put { notification: n(3) }, &[n(2)]);
        assert!(!store.health.lock().unwrap().dirty);
        assert_eq!(
            store
                .restore()
                .unwrap()
                .iter()
                .map(|n| n.id)
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        fs::remove_dir_all(store.dir).unwrap();
    }
    #[test]
    fn failed_compaction_never_replaces_the_journal_or_removes_legacy_input() {
        let store = scratch("compaction-failure");
        let live = vec![n(1)];
        store.compact(&live).unwrap();
        let before = fs::read(store.dir.join("history.jsonl")).unwrap();
        fs::create_dir(store.dir.join("history.jsonl.tmp")).unwrap();
        assert!(store.compact(&[n(2)]).is_err());
        assert_eq!(fs::read(store.dir.join("history.jsonl")).unwrap(), before);
        let legacy = store.dir.join("state.json");
        fs::write(&legacy, b"original legacy input").unwrap();
        assert!(store.restore().is_err());
        assert!(legacy.exists());
        fs::remove_dir_all(store.dir).unwrap();
    }
    #[test]
    fn journal_append_is_one_bounded_operation_without_rewriting_history() {
        use std::os::unix::fs::MetadataExt;
        let store = scratch("append");
        let rows: Vec<_> = (1..=2000).map(n).collect();
        store.compact(&rows).unwrap();
        let p = store.dir.join("history.jsonl");
        let before = fs::read(&p).unwrap();
        let inode = fs::metadata(&p).unwrap().ino();
        store
            .append(
                &Change::Put {
                    notification: n(2001),
                },
                &rows,
            )
            .unwrap();
        let after = fs::read(&p).unwrap();
        assert_eq!(
            fs::metadata(&p).unwrap().ino(),
            inode,
            "append must not replace the full journal"
        );
        assert!(after.starts_with(&before));
        assert!(after.len() - before.len() < 2048);
        let lines = after.iter().filter(|b| **b == b'\n').count();
        store
            .append(
                &Change::Remove {
                    ids: rows.iter().map(|n| n.id).collect(),
                },
                &rows,
            )
            .unwrap();
        assert_eq!(
            fs::read_to_string(&p).unwrap().lines().count(),
            lines + 1,
            "bulk is one journal operation"
        );
        fs::remove_dir_all(store.dir).unwrap();
    }
    #[test]
    fn journal_import_replay_partial_tail_and_corrupt_interior() {
        let store = scratch("recover");
        fs::write(
            store.dir.join("state.json"),
            serde_json::to_vec(&History {
                version: 1,
                notifications: vec![n(1)],
            })
            .unwrap(),
        )
        .unwrap();
        let live = store.restore().unwrap();
        assert_eq!(live.len(), 1);
        assert!(!store.dir.join("state.json").exists());
        store
            .append(&Change::Put { notification: n(2) }, &live)
            .unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(store.dir.join("history.jsonl"))
            .unwrap()
            .write_all(b"{\"op\":")
            .unwrap();
        assert_eq!(
            store
                .restore()
                .unwrap()
                .iter()
                .map(|n| n.id)
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        fs::OpenOptions::new()
            .append(true)
            .open(store.dir.join("history.jsonl"))
            .unwrap()
            .write_all(b"broken\n")
            .unwrap();
        assert!(
            store.restore().is_err(),
            "invalid complete records must not silently erase history"
        );
        fs::remove_dir_all(store.dir).unwrap();
    }
    #[test]
    fn startup_image_collection_preserves_live_and_external_files() {
        let store = scratch("images");
        private_dir(&store.dir.join("images")).unwrap();
        let image = store
            .dir
            .join("images/0123456789abcdef0123456789abcdef.png");
        fs::write(&image, b"fixture").unwrap();
        let mut record = n(1);
        record.hints.insert(
            "image-path".into(),
            image.to_string_lossy().to_string().into(),
        );
        store.clean_images(std::slice::from_ref(&record)).unwrap();
        assert!(image.exists());
        let legacy = record.hints.remove("image-path").unwrap();
        record.hints.insert("image_path".into(), legacy);
        store.clean_images(&[record]).unwrap();
        assert!(image.exists(), "legacy spelling is still a reference");
        let foreign = store.dir.join("images/personal.png");
        fs::write(&foreign, b"not generated by this cache").unwrap();
        store.clean_images(&[]).unwrap();
        assert!(!image.exists());
        assert!(
            foreign.exists(),
            "unknown files are not daemon-owned hash images"
        );
        fs::remove_dir_all(store.dir).unwrap();
    }
    #[test]
    fn failed_image_write_never_publishes_the_hash_and_can_be_retried() {
        let dir = std::env::temp_dir().join(format!(
            "nidara-image-failure-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = Store::at(dir.clone());
        let images = dir.join("images");
        private_dir(&images).unwrap();
        let data = vec![220u8, 64, 200];
        let hash = format!("{:x}", Sha256::digest(&data));
        let path = images.join(format!("{}.png", &hash[..32]));
        let error = publish_image(&path, |file| {
            file.write_all(b"partial PNG")?;
            assert!(!path.exists(), "a partial image must not be a cache hit");
            // Simulate ENOSPC after writing a prefix, without filling the disk.
            Err(io::Error::from_raw_os_error(28).into())
        })
        .unwrap_err();
        assert_eq!(
            error.downcast_ref::<io::Error>().unwrap().raw_os_error(),
            Some(28)
        );
        assert!(!path.exists());
        assert_eq!(
            fs::read_dir(&images).unwrap().count(),
            0,
            "remove failed temporary files"
        );
        let hint = OwnedValue::try_from(Variant::from((1i32, 1i32, 3i32, false, 8i32, 3i32, data)))
            .unwrap();
        assert_eq!(store.decode_image(&hint).unwrap(), path);
        let mut reader = png::Decoder::new(BufReader::new(fs::File::open(&path).unwrap()))
            .read_info()
            .unwrap();
        let mut pixels = vec![0; reader.output_buffer_size().unwrap()];
        let info = reader.next_frame(&mut pixels).unwrap();
        assert_eq!(&pixels[..info.buffer_size()], &[220, 64, 200]);
        assert_eq!(
            fs::read_dir(images).unwrap().count(),
            1,
            "only the complete PNG remains"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn padded_rgb_and_rgba_match_the_original_pixbuf_decoder() {
        let dir = std::env::temp_dir().join(format!(
            "nidara-image-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = Store::at(dir.clone());
        for (alpha, stride, data, pixels, color) in [
            (
                false,
                4,
                vec![220u8, 64, 200, 0, 10, 20, 30],
                vec![220, 64, 200, 10, 20, 30],
                png::ColorType::Rgb,
            ),
            (
                true,
                5,
                vec![220, 64, 200, 80, 0, 10, 20, 30, 40],
                vec![220, 64, 200, 80, 10, 20, 30, 40],
                png::ColorType::Rgba,
            ),
        ] {
            // channels is deliberately inconsistent: the old Pixbuf decoder uses
            // has-alpha, and ignores this redundant sender field.
            let hint = OwnedValue::try_from(Variant::from((
                1i32, 2i32, stride, alpha, 8i32, 99i32, data,
            )))
            .unwrap();
            let path = store.decode_image(&hint).unwrap();
            let decoder = png::Decoder::new(BufReader::new(fs::File::open(path).unwrap()));
            let mut reader = decoder.read_info().unwrap();
            let mut output = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut output).unwrap();
            assert_eq!((info.width, info.height, info.color_type), (1, 2, color));
            assert_eq!(&output[..info.buffer_size()], pixels);
        }
        let unsupported = OwnedValue::try_from(Variant::from((
            1i32,
            1i32,
            3i32,
            false,
            16i32,
            3i32,
            vec![1u8, 2, 3],
        )))
        .unwrap();
        assert!(store.decode_image(&unsupported).is_err());
        let short = OwnedValue::try_from(Variant::from((
            1i32,
            2i32,
            3i32,
            false,
            8i32,
            3i32,
            vec![1u8],
        )))
        .unwrap();
        assert!(store.decode_image(&short).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
