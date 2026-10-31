// SPDX-License-Identifier: GPL-3.0-or-later
//! Committed foreground seconds and a separate, never-persisted pending watch.
use super::{Error, catalogue};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};
const HALF_LIFE: f64 = 14.0 * 86400.0;
const LIMIT: usize = 16384;
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AppUsage {
    seconds: f64,
    observed: f64,
    is_new: bool,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Data {
    version: u32,
    decay_at: f64,
    baseline: Option<BTreeSet<String>>,
    apps: BTreeMap<String, AppUsage>,
}
impl Default for Data {
    fn default() -> Self {
        Self {
            version: 1,
            decay_at: 0.0,
            baseline: None,
            apps: BTreeMap::new(),
        }
    }
}
struct Pending {
    id: String,
    since: u64,
}
pub struct Usage {
    data: Data,
    pending: Option<Pending>,
    last_time: u64,
    path: PathBuf,
    load_ok: bool,
    pub reason: String,
    pub dirty: bool,
    changed: BTreeSet<String>,
}
impl Usage {
    pub fn new() -> Self {
        let root = std::env::var_os("XDG_STATE_HOME")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
            .filter(|p| p.is_absolute())
            .unwrap_or_else(|| catalogue::home().join(".local/state"));
        let path = root.join("nidara/applications-v1.json");
        let loaded = match fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Data::default()),
            Ok(m) if m.file_type().is_symlink() => Err("usage state is a symlink".into()),
            _ => catalogue::bounded(&path, 8 * 1024 * 1024).and_then(|b| {
                serde_json::from_slice::<Data>(&b).map_err(|_| "invalid usage state".into())
            }),
        }
        .and_then(|d| {
            if valid(&d) {
                Ok(d)
            } else {
                Err("unsupported/invalid usage state".into())
            }
        });
        let (data, reason) = match loaded {
            Ok(d) => (d, String::new()),
            Err(e) => (Data::default(), e),
        };
        Self {
            data,
            pending: None,
            last_time: 0,
            path,
            load_ok: reason.is_empty(),
            reason,
            dirty: false,
            changed: BTreeSet::new(),
        }
    }
    pub fn baseline_available(&self) -> bool {
        self.load_ok && self.reason.is_empty() && self.data.baseline.is_some()
    }
    pub fn unavailable_reason(&self) -> &str {
        if self.reason.is_empty() && self.data.baseline.is_none() {
            "healthy catalogue baseline unavailable"
        } else {
            &self.reason
        }
    }
    pub fn available(&self) -> bool {
        self.load_ok && self.reason.is_empty() && self.data.baseline.is_some()
    }
    pub fn catalogue(&mut self, ids: BTreeSet<String>, healthy: bool, wall: f64) -> bool {
        if !healthy || !self.load_ok || ids.len() > LIMIT {
            return false;
        }
        if self.data.baseline.as_ref() == Some(&ids) {
            return false;
        }
        let first = self.data.baseline.is_none();
        self.data.apps.retain(|id, _| ids.contains(id));
        for id in &ids {
            if !self.data.apps.contains_key(id) {
                self.data.apps.insert(
                    id.clone(),
                    AppUsage {
                        seconds: 0.0,
                        observed: wall,
                        is_new: !first,
                    },
                );
                self.changed.insert(id.clone());
            }
        }
        self.data.baseline = Some(ids);
        self.dirty = true;
        true
    }
    pub fn fields(&self, id: &str) -> (f64, f64, bool) {
        self.data.apps.get(id).map_or((0.0, 0.0, false), |a| {
            (a.seconds / (a.seconds + 3600.0), a.observed, a.is_new)
        })
    }
    pub fn decay(&mut self, wall: f64) {
        if !self.load_ok || !wall.is_finite() || wall < 0.0 {
            return;
        }
        if self.data.decay_at == 0.0 {
            self.data.decay_at = wall;
            self.dirty = true;
            return;
        }
        let elapsed = (wall - self.data.decay_at).max(0.0);
        if elapsed == 0.0 {
            return;
        }
        let factor = 2.0_f64.powf(-elapsed / HALF_LIFE);
        for (id, a) in &mut self.data.apps {
            if a.seconds > 0.0 {
                a.seconds *= factor;
                self.changed.insert(id.clone());
            }
        }
        self.data.decay_at = wall;
        self.dirty = true;
    }
    /// A real boundary commits the old watch. Idle caps THIS watch from its start.
    pub fn boundary(&mut self, id: Option<String>, at: u64, idle: bool, force: bool, wall: f64) {
        if !self.load_ok {
            return;
        }
        if !force && self.pending.as_ref().map(|p| &p.id) == id.as_ref() {
            return;
        }
        let at = at.max(self.last_time);
        self.last_time = at;
        self.decay(wall);
        if let Some(p) = self.pending.take() {
            let end = if idle {
                at.min(p.since.saturating_add(30_000_000))
            } else {
                at
            };
            let seconds = end.saturating_sub(p.since) as f64 / 1e6;
            if seconds > 0.0
                && let Some(a) = self.data.apps.get_mut(&p.id)
            {
                a.seconds = (a.seconds + seconds).min(1e12);
                self.dirty = true;
                self.changed.insert(p.id);
            }
        }
        if let Some(id) = id {
            if let Some(a) = self.data.apps.get_mut(&id)
                && a.is_new
            {
                a.is_new = false;
                self.dirty = true;
                self.changed.insert(id.clone());
            }
            self.pending = Some(Pending { id, since: at });
        }
    }
    /// Nothing infers the time at which a lost stream stopped being trustworthy.
    pub fn disconnect(&mut self) {
        self.pending = None;
    }
    pub fn acknowledge(&mut self, ids: &[String]) -> Result<bool, Error> {
        if !self.baseline_available() {
            return Err(Error::Unavailable(
                "durable new-app baseline unavailable".into(),
            ));
        }
        let old_reason = self.reason.clone();
        let old = self.data.clone();
        let old_changed = self.changed.clone();
        let old_dirty = self.dirty;
        let mut changed = false;
        for id in ids {
            if let Some(a) = self.data.apps.get_mut(id)
                && a.is_new
            {
                a.is_new = false;
                self.changed.insert(id.clone());
                changed = true;
            }
        }
        if changed {
            self.dirty = true;
            if let Err(e) = self.save() {
                self.data = old;
                self.changed = old_changed;
                self.dirty = old_dirty;
                self.reason = old_reason;
                return Err(e);
            }
        }
        Ok(changed)
    }
    pub fn needs_decay(&self) -> bool {
        self.data.apps.values().any(|a| a.seconds > 0.0)
    }
    pub fn take_changed(&mut self) -> BTreeSet<String> {
        std::mem::take(&mut self.changed)
    }
    pub fn save(&mut self) -> Result<(), Error> {
        if !self.load_ok {
            return Err(Error::Unavailable(self.reason.clone()));
        }
        if !self.dirty {
            return Ok(());
        }
        let result = save(&self.path, &self.data);
        match result {
            Ok(()) => {
                self.dirty = false;
                self.reason.clear();
                Ok(())
            }
            Err(e) => {
                self.reason = "usage state write failed".into();
                Err(e)
            }
        }
    }
}
fn valid(d: &Data) -> bool {
    d.version == 1
        && d.decay_at.is_finite()
        && d.decay_at >= 0.0
        && d.apps.len() <= LIMIT
        && match d.baseline.as_ref() {
            None => d.apps.is_empty(),
            Some(b) => {
                b.len() <= LIMIT
                    && b.len() == d.apps.len()
                    && b.iter().all(|id| d.apps.contains_key(id))
            }
        }
        && d.apps.iter().all(|(id, a)| {
            id.ends_with(".desktop")
                && id.len() <= 1024
                && !id.contains(['\0', '/'])
                && a.seconds.is_finite()
                && (0.0..=1e12).contains(&a.seconds)
                && a.observed.is_finite()
                && a.observed >= 0.0
        })
}
fn save(path: &Path, data: &Data) -> Result<(), Error> {
    use std::{
        io::Write,
        os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    };
    for p in path.ancestors() {
        if fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::AccessDenied("usage state parent is symlink".into()));
        }
    }
    if let Ok(m) = fs::metadata(path)
        && (m.uid() != unsafe { libc::geteuid() } || m.permissions().mode() & 0o222 == 0)
    {
        return Err(Error::AccessDenied(
            "usage state is not writable/owned".into(),
        ));
    }
    let bytes =
        serde_json::to_vec(data).map_err(|_| Error::Failed("usage serialization".into()))?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(Error::Busy("usage state budget".into()));
    }
    let dir = path.parent().unwrap();
    fs::create_dir_all(dir).map_err(|_| Error::Failed("usage directory".into()))?;
    let temp = dir.join(format!(".applications-{}", super::unique()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|_| Error::Failed("usage temporary file".into()))?;
    let result = (|| {
        file.write_all(&bytes)?;
        file.sync_all()?;
        fs::rename(&temp, path)?;
        fs::File::open(dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
        return Err(Error::Failed("atomic usage write".into()));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    fn u() -> Usage {
        Usage {
            data: Data::default(),
            pending: None,
            last_time: 0,
            path: "/unused".into(),
            load_ok: true,
            reason: String::new(),
            dirty: false,
            changed: BTreeSet::new(),
        }
    }
    fn ids(v: &[&str]) -> BTreeSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }
    #[test]
    fn idle_caps_pending_watch_and_checkpoints_never_serialize_it() {
        let mut u = u();
        u.catalogue(ids(&["A.desktop"]), true, 100.0);
        u.boundary(Some("A.desktop".into()), 0, false, false, 100.0);
        u.decay(130.0);
        let persisted = serde_json::to_value(&u.data).unwrap();
        assert_eq!(persisted["apps"]["A.desktop"]["seconds"], 0.0);
        u.boundary(None, 300_000_000, true, true, 400.0);
        assert_eq!(u.data.apps["A.desktop"].seconds, 30.0);
        u.boundary(Some("A.desktop".into()), 400_000_000, false, true, 500.0);
        u.boundary(None, 410_000_000, false, true, 510.0);
        assert!(u.data.apps["A.desktop"].seconds > 39.0);
    }
    #[test]
    fn disconnect_discards_pending_and_new_markers_have_no_expiry() {
        let mut u = u();
        u.catalogue(ids(&["A.desktop"]), true, 100.0);
        assert!(!u.fields("A.desktop").2);
        u.catalogue(ids(&["A.desktop", "B.desktop"]), true, 200.0);
        assert!(u.fields("B.desktop").2);
        u.decay(200.0 + 365.0 * 86400.0);
        assert!(u.fields("B.desktop").2);
        u.boundary(Some("B.desktop".into()), 100, false, false, 999.0);
        assert!(!u.fields("B.desktop").2);
        u.disconnect();
        assert_eq!(u.data.apps["B.desktop"].seconds, 0.0);
    }
    #[test]
    fn degraded_roots_do_not_create_reinstalls_but_healthy_readds_do() {
        let mut u = u();
        u.catalogue(ids(&["A.desktop"]), true, 100.0);
        u.catalogue(ids(&[]), false, 200.0);
        u.catalogue(ids(&["A.desktop"]), true, 300.0);
        assert!(!u.fields("A.desktop").2);
        u.catalogue(ids(&[]), true, 400.0);
        u.catalogue(ids(&["A.desktop"]), true, 500.0);
        assert!(u.fields("A.desktop").2);
    }
    #[test]
    fn decay_is_fourteen_days_and_backward_clocks_do_not_add_usage() {
        let mut u = u();
        u.catalogue(ids(&["A.desktop"]), true, 100.0);
        u.boundary(Some("A.desktop".into()), 0, false, true, 100.0);
        u.boundary(None, 100_000_000, false, true, 200.0);
        u.decay(200.0 + HALF_LIFE);
        assert!((u.data.apps["A.desktop"].seconds - 50.0).abs() < 1e-9);
        u.decay(1.0);
        assert!((u.data.apps["A.desktop"].seconds - 50.0).abs() < 1e-9);
    }
    #[test]
    fn previous_committed_watches_are_not_capped_again_on_idle() {
        let mut u = u();
        u.catalogue(ids(&["A.desktop", "B.desktop"]), true, 100.0);
        u.boundary(Some("A.desktop".into()), 0, false, true, 100.0);
        u.boundary(Some("B.desktop".into()), 60_000_000, false, true, 100.0);
        u.boundary(None, 360_000_000, true, true, 100.0);
        assert_eq!(u.data.apps["A.desktop"].seconds, 60.0);
        assert_eq!(u.data.apps["B.desktop"].seconds, 30.0);
        let saved = serde_json::to_vec(&u.data).unwrap();
        let d: Data = serde_json::from_slice(&saved).unwrap();
        assert!(valid(&d));
    }
}
