// SPDX-License-Identifier: GPL-3.0-or-later
//! Resolved paths and rendered pixels, bounded independently of client lifetime.
use super::{catalogue, icons::Pixels};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex, OnceLock},
};
pub const BYTES: usize = 64 * 1024 * 1024;
const ENTRIES: usize = 1024;
#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct Key {
    pub epoch: u64,
    pub id: String,
    pub generation: u64,
    pub revision: u64,
    pub theme: String,
    pub side: u32,
}
#[derive(Debug)]
pub struct Rendered {
    pub path: Option<PathBuf>,
    pub reason: &'static str,
    pub pixels: Pixels,
    hash: String,
}
impl Rendered {
    pub fn new(path: Option<PathBuf>, reason: &'static str, pixels: Pixels) -> Self {
        let hash = catalogue::hash(&pixels.2);
        Self {
            path,
            reason,
            pixels,
            hash,
        }
    }
    pub fn reply(&self, domain: &str, logical: u32, scale: f64) -> (String, u32, u32, Vec<u8>) {
        let token = catalogue::hash(
            format!(
                "{domain}:{logical}:{scale}:{}:{}:{}",
                self.reason,
                self.hash,
                self.path
                    .as_ref()
                    .map(|p| p.to_string_lossy())
                    .unwrap_or_default()
            )
            .as_bytes(),
        );
        (
            format!("{}:{token}", self.reason),
            self.pixels.0,
            self.pixels.1,
            self.pixels.2.clone(),
        )
    }
}
#[derive(Default)]
struct State {
    namespace: Option<(u64, u64, String)>,
    rows: HashMap<Key, (u64, Arc<Rendered>)>,
    clock: u64,
    bytes: usize,
    catalogue: Option<HashMap<String, u64>>,
    generations: HashMap<String, u64>,
}
#[derive(Default)]
pub struct Cache {
    state: Mutex<State>,
}
impl Cache {
    fn prepare(s: &mut State, key: &Key) -> bool {
        if s.namespace
            .as_ref()
            .is_some_and(|(e, r, _)| *e == key.epoch && *r > key.revision)
        {
            return false;
        }
        let namespace = (key.epoch, key.revision, key.theme.clone());
        if s.namespace.as_ref() != Some(&namespace) {
            s.rows.clear();
            s.bytes = 0;
            s.namespace = Some(namespace);
            s.catalogue = None;
            s.generations.clear();
        }
        if key.id.strip_prefix("app:").is_some_and(|id| {
            s.catalogue
                .as_ref()
                .is_some_and(|c| c.get(id) != Some(&key.generation))
        }) || s
            .generations
            .get(&key.id)
            .is_some_and(|g| *g > key.generation)
        {
            return false;
        }
        if s.generations.len() >= ENTRIES + 8 {
            // Failed or cancelled misses must not accumulate unbounded metadata.
            let resident: std::collections::HashSet<_> =
                s.rows.keys().map(|k| k.id.clone()).collect();
            s.generations.retain(|id, _| resident.contains(id));
        }
        s.generations.insert(key.id.clone(), key.generation);
        s.rows.retain(|k, (_, v)| {
            let keep = k.id != key.id || k.generation == key.generation;
            if !keep {
                s.bytes -= v.pixels.2.len();
            }
            keep
        });
        true
    }
    pub fn observe(
        &self,
        epoch: u64,
        revision: u64,
        theme: String,
        generations: HashMap<String, u64>,
    ) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let key = Key {
            epoch,
            revision,
            theme,
            id: String::new(),
            generation: 0,
            side: 0,
        };
        if !Self::prepare(&mut s, &key) {
            return;
        }
        let mut removed = 0;
        s.rows.retain(|k, (_, v)| {
            let keep =
                k.id.strip_prefix("app:")
                    .is_none_or(|id| generations.get(id) == Some(&k.generation));
            if !keep {
                removed += v.pixels.2.len();
            }
            keep
        });
        s.bytes -= removed;
        s.catalogue = Some(generations);
    }
    pub fn get(&self, key: &Key) -> Option<Arc<Rendered>> {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !Self::prepare(&mut s, key) {
            return None;
        }
        s.clock += 1;
        let tick = s.clock;
        s.rows.get_mut(key).map(|(at, value)| {
            *at = tick;
            value.clone()
        })
    }
    pub fn put(&self, key: Key, value: Arc<Rendered>) {
        let mut s = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if s.namespace.as_ref() != Some(&(key.epoch, key.revision, key.theme.clone()))
            || s.generations.get(&key.id) != Some(&key.generation)
            || key.id.strip_prefix("app:").is_some_and(|id| {
                s.catalogue
                    .as_ref()
                    .is_some_and(|c| c.get(id) != Some(&key.generation))
            })
            || value.pixels.2.len() > BYTES
        {
            return;
        }
        if let Some((_, old)) = s.rows.remove(&key) {
            s.bytes -= old.pixels.2.len();
        }
        while s.bytes + value.pixels.2.len() > BYTES || s.rows.len() >= ENTRIES {
            let Some(old) = s
                .rows
                .iter()
                .min_by_key(|(_, v)| v.0)
                .map(|(k, _)| k.clone())
            else {
                break;
            };
            if let Some((_, old)) = s.rows.remove(&old) {
                s.bytes -= old.pixels.2.len();
            }
        }
        s.bytes += value.pixels.2.len();
        s.clock += 1;
        let tick = s.clock;
        s.rows.insert(key, (tick, value));
    }
}
pub fn trace(kind: &str, hit: bool) {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    if *ENABLED.get_or_init(|| std::env::var_os("NK_ICON_METRICS").is_some()) {
        eprintln!(
            "ICON_DAEMON_METRIC {}",
            serde_json::json!({"kind":kind,"hit":hit,"us":glib::monotonic_time()})
        );
    }
}
pub fn resolved(id: &str, side: u32, path: Option<&std::path::Path>) {
    if std::env::var_os("NK_ICON_METRICS").is_some() {
        eprintln!(
            "ICON_DAEMON_ASSET {}",
            serde_json::json!({"id":id,"side":side,"path":path,"bytes":path.and_then(|p| p.metadata().ok()).map(|m|m.len()),"us":glib::monotonic_time()})
        );
    }
}
pub struct Span(Option<(i64, &'static str, String, u32)>);
pub fn span(stage: &'static str, id: &str, side: u32) -> Span {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    Span(
        (*ENABLED.get_or_init(|| std::env::var_os("NK_ICON_METRICS").is_some()))
            .then(|| (glib::monotonic_time(), stage, id.into(), side)),
    )
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some((start, stage, id, side)) = self.0.take() {
            let now = glib::monotonic_time();
            eprintln!(
                "ICON_DAEMON_DETAIL {}",
                serde_json::json!({"stage":stage,"id":id,"side":side,"start_us":start,"us":now,"elapsed_us":now-start})
            );
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn key(id: &str, revision: u64) -> Key {
        Key {
            epoch: 1,
            id: id.into(),
            generation: 1,
            revision,
            theme: "Papirus".into(),
            side: 64,
        }
    }
    fn image() -> Arc<Rendered> {
        Arc::new(Rendered::new(
            Some("/icon.svg".into()),
            "asset",
            (1, 1, vec![1, 2, 3, 255]),
        ))
    }
    #[test]
    fn revision_and_generation_invalidate_old_pixels_and_late_decodes() {
        let c = Cache::default();
        let first = key("one", 1);
        assert!(c.get(&first).is_none());
        let old = image();
        c.put(first.clone(), old.clone());
        assert!(Arc::ptr_eq(&old, &c.get(&first).unwrap()));
        let next = key("one", 2);
        assert!(c.get(&next).is_none());
        c.put(first.clone(), old);
        assert!(c.get(&first).is_none());
        c.put(next.clone(), image());
        let mut changed = next.clone();
        changed.generation = 2;
        assert!(c.get(&changed).is_none());
        assert!(c.state.lock().unwrap().rows.is_empty());
    }
    #[test]
    fn bounded_lru_preserves_a_hot_entry_and_stable_reply() {
        let c = Cache::default();
        let hot = key("hot", 1);
        c.get(&hot);
        let asset = image();
        let expected = asset.reply("app", 64, 1.);
        c.put(hot.clone(), asset);
        for i in 0..ENTRIES + 3 {
            c.get(&hot);
            let k = key(&format!("app{i}"), 1);
            c.get(&k);
            c.put(k, image());
        }
        assert_eq!(c.get(&hot).unwrap().reply("app", 64, 1.), expected);
        assert!(c.get(&key("app0", 1)).is_none());
        assert_eq!(c.state.lock().unwrap().rows.len(), ENTRIES);
    }
    #[test]
    fn publication_retires_removed_apps_and_late_generations() {
        let c = Cache::default();
        let old = key("app:one", 1);
        c.get(&old);
        c.put(old.clone(), image());
        c.observe(1, 1, "Papirus".into(), HashMap::from([("one".into(), 2)]));
        c.put(old.clone(), image());
        assert!(c.get(&old).is_none());
        let mut new = old.clone();
        new.generation = 2;
        c.get(&new);
        c.put(new.clone(), image());
        assert!(c.get(&new).is_some());
        c.observe(1, 1, "Papirus".into(), HashMap::new());
        c.put(new.clone(), image());
        assert!(c.get(&new).is_none());
        assert!(c.state.lock().unwrap().rows.is_empty());
    }
    #[test]
    fn pixel_budget_evicts_the_oldest_even_below_the_entry_cap() {
        let c = Cache::default();
        for i in 0..3 {
            let k = key(&format!("large{i}"), 1);
            c.get(&k);
            c.put(
                k,
                Arc::new(Rendered::new(None, "asset", (1, 1, vec![0; BYTES / 2]))),
            );
        }
        assert!(c.get(&key("large0", 1)).is_none());
        let s = c.state.lock().unwrap();
        assert_eq!(s.rows.len(), 2);
        assert_eq!(s.bytes, BYTES);
    }
}
