// SPDX-License-Identifier: GPL-3.0-or-later
use super::{
    Error,
    catalogue::{self, App},
    layout,
};
use gio::prelude::*;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::{Notify, oneshot};
pub struct Store {
    pub epoch: u64,
    pub revision: u64,
    pub catalogue_revision: u64,
    pub layout_revision: u64,
    pub icon_revision: u64,
    pub theme: String,
    pub apps: BTreeMap<String, App>,
    pub layout: Vec<String>,
    pub healthy: bool,
    pub diagnostics: Vec<String>,
    pub default: String,
    roots: Vec<PathBuf>,
    present: BTreeMap<PathBuf, String>,
    next_generation: u64,
    icon_fingerprint: String,
    pins: Option<gio::Settings>,
    pub settings: super::super::config::registry::Store,
    monitors: Vec<gio::FileMonitor>,
    dirty: Arc<AtomicBool>,
    pub notify: Arc<Notify>,
    domains: BTreeSet<String>,
}
impl Store {
    fn new(notify: Arc<Notify>) -> Self {
        let schema = gio::SettingsSchemaSource::default()
            .and_then(|s| s.lookup("org.nidara.dock", true))
            .filter(|s| s.has_key("pinned") && s.has_key("pinned-layout-version"));
        let pins = schema.map(|s| gio::Settings::new_full(&s, None::<&gio::SettingsBackend>, None));
        let dirty = Arc::new(AtomicBool::new(true));
        if let Some(p) = &pins {
            let d = dirty.clone();
            p.connect_changed(None, move |_, _| {
                d.store(true, Ordering::Release);
            });
        }
        Self {
            epoch: super::unique(),
            revision: 1,
            catalogue_revision: 1,
            layout_revision: 1,
            icon_revision: 1,
            theme: String::new(),
            apps: BTreeMap::new(),
            layout: vec![],
            healthy: false,
            diagnostics: vec![],
            default: String::new(),
            roots: catalogue::roots(),
            present: catalogue::root_history(),
            next_generation: 0,
            icon_fingerprint: String::new(),
            pins,
            settings: super::super::config::registry::Store::new(),
            monitors: vec![],
            dirty,
            notify,
            domains: BTreeSet::new(),
        }
    }
    pub fn mark(&mut self, domain: &str) {
        self.revision += 1;
        self.domains.insert(domain.into());
        self.notify.notify_one();
    }
    pub fn icons_changed(&mut self) {
        self.icon_revision += 1;
        self.icon_fingerprint.clear();
        for a in self.apps.values_mut() {
            a.record["IconRevision"] = json!(self.icon_revision);
        }
        self.mark("icons");
    }
    pub fn take_domains(&mut self) -> Vec<String> {
        std::mem::take(&mut self.domains).into_iter().collect()
    }
    pub fn epoch(&self, e: u64) -> Result<(), Error> {
        if e != self.epoch {
            Err(Error::Stale("service epoch changed".into()))
        } else {
            Ok(())
        }
    }
    pub fn app(&self, id: &str, generation: u64) -> Result<&App, Error> {
        let a = self
            .apps
            .get(id)
            .ok_or_else(|| Error::NotFound("app not found".into()))?;
        if a.generation != generation {
            return Err(Error::Stale("app generation changed".into()));
        }
        Ok(a)
    }
    pub fn authorize(
        &self,
        peer: &nidara_access::Peer,
        op: nidara_access::Operation,
    ) -> Result<(), Error> {
        peer.authorize(op, super::super::config::registry::consent(&self.settings))
            .map_err(Error::AccessDenied)
    }
    pub fn layout_available(&self) -> bool {
        self.pins
            .as_ref()
            .is_some_and(|p| p.uint("pinned-layout-version") <= 1)
    }
    pub fn save_layout(&mut self, next: Vec<String>) -> Result<(), Error> {
        let pins = self
            .pins
            .as_ref()
            .ok_or_else(|| Error::Unavailable("typed dock schema missing".into()))?;
        if pins.uint("pinned-layout-version") > 1 {
            return Err(Error::Unavailable(
                "future layout version; no overwrite".into(),
            ));
        }
        let next = layout::validate(&next)?;
        if next == self.layout && pins.uint("pinned-layout-version") == 1 {
            return Ok(());
        }
        pins.delay();
        let result = pins
            .set_strv("pinned", next.as_slice())
            .and_then(|_| pins.set_uint("pinned-layout-version", 1));
        if let Err(e) = result {
            pins.revert();
            return Err(Error::Failed(e.to_string()));
        }
        pins.apply();
        gio::Settings::sync();
        if pins
            .strv("pinned")
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            != next
            || pins.uint("pinned-layout-version") != 1
        {
            return Err(Error::Failed("layout write readback differs".into()));
        }
        self.layout = next;
        self.layout_revision += 1;
        self.mark("layout");
        Ok(())
    }
    pub fn refresh(&mut self) {
        let previous = self.present.clone();
        let mut scan = catalogue::scan(&self.roots, &mut self.present);
        if previous != self.present
            && catalogue::root_history_valid()
            && let Err(e) = catalogue::save_root_history(&self.present)
        {
            scan.healthy = false;
            scan.diagnostics.push(format!("root history: {e}"));
            self.present = previous;
        }
        if !catalogue::root_history_valid() {
            scan.healthy = false;
            scan.diagnostics
                .push("root history corrupt or unreadable; pruning disabled".into());
        }
        let mut signatures = String::new();
        let mut assets = std::collections::BTreeMap::new();
        for a in scan.apps.values() {
            let path = assets
                .entry((a.id.clone(), a.icon.clone()))
                .or_insert_with(|| super::icons::resolve(a, &self.theme, 64));
            if let Some(p) = path.as_ref()
                && let Ok(m) = std::fs::metadata(p)
            {
                signatures.push_str(&format!("{}:{}:{:?};", p.display(), m.len(), m.modified()));
            }
        }
        let fingerprint = catalogue::hash(signatures.as_bytes());
        if !self.icon_fingerprint.is_empty() && self.icon_fingerprint != fingerprint {
            self.icon_revision += 1;
            self.mark("icons");
        }
        self.icon_fingerprint = fingerprint;
        let previous_health = self.healthy;
        let previous_diagnostics = self.diagnostics.clone();
        self.healthy = scan.healthy;
        self.diagnostics = scan.diagnostics;
        // Preserve the last good catalogue on partial/unreadable roots. First boot
        // can publish partial metadata explicitly degraded, but never prune it.
        let mut apps = if self.healthy || self.apps.is_empty() {
            scan.apps
        } else {
            self.apps.clone()
        };
        for (id, a) in &mut apps {
            if let Some(old) = self.apps.get(id).filter(|old| old.digest == a.digest) {
                a.generation = old.generation;
            } else {
                self.next_generation += 1;
                a.generation = self.next_generation;
            }
            a.record["Generation"] = json!(a.generation);
            a.record["IconRevision"] = json!(self.icon_revision);
        }
        if apps != self.apps {
            self.apps = apps;
            self.catalogue_revision += 1;
            self.mark("catalogue");
        }
        let default = gio::AppInfo::default_for_type("inode/directory", false)
            .and_then(|a| a.id())
            .map(|s| s.to_string())
            .unwrap_or_default();
        if default != self.default {
            self.default = default;
            self.mark("defaults");
        }
        let pending = self.pins.as_ref().map(|p| {
            let raw = p
                .strv("pinned")
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>();
            match p.uint("pinned-layout-version") {
                0 => Ok(layout::migrate(&raw, &self.apps)),
                1 => layout::validate(&raw),
                _ => Err(Error::Invalid("future layout version".into())),
            }
        });
        if let Some(pending) = pending {
            match pending {
                Ok(mut next) => {
                    layout::prune(&mut next, &self.apps, self.healthy);
                    if let Err(e) = self.save_layout(next) {
                        self.diagnostics.push(e.to_string());
                    }
                }
                Err(e) => self.diagnostics.push(e.to_string()),
            }
        }
        if previous_health != self.healthy || previous_diagnostics != self.diagnostics {
            self.mark("catalogue");
        }
        for m in self.monitors.drain(..) {
            m.cancel();
        }
        for path in scan
            .watches
            .into_iter()
            .chain(std::iter::once(catalogue::data_home().join("icons")))
        {
            let mut path = path;
            while !path.is_dir() {
                if !path.pop() {
                    break;
                }
            }
            if let Ok(m) = gio::File::for_path(path).monitor_directory(
                gio::FileMonitorFlags::WATCH_MOVES,
                None::<&gio::Cancellable>,
            ) {
                let d = self.dirty.clone();
                m.connect_changed(move |_, _, _, _| {
                    d.store(true, Ordering::Release);
                });
                self.monitors.push(m);
            }
        }
    }
    pub fn metadata(&self) -> Value {
        json!({"CatalogueRevision":self.catalogue_revision,"LayoutRevision":self.layout_revision,"UsageRevision":0_u64,"LauncherRevision":0_u64,"IconRevision":self.icon_revision,"CatalogueComplete":self.healthy,"Diagnostics":self.diagnostics,"Apps":self.apps.values().map(|a|a.record.clone()).collect::<Vec<_>>(),"LayoutAvailable":self.layout_available(),"Layout":layout::records(&self.layout,&self.apps,&self.default),"DefaultDirectoryApp":self.default,"WindowMatches":[],"ActiveLaunches":[],"MatchingAvailable":false,"UsageAvailable":false,"LauncherAvailable":false})
    }
}
type Job = Box<dyn FnOnce(&mut Store) + Send>;
#[derive(Clone)]
pub struct Handle {
    tx: std::sync::mpsc::SyncSender<Job>,
}
impl Handle {
    pub async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Store) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .try_send(Box::new(move |store| {
                if !tx.is_closed() {
                    let _ = tx.send(f(store));
                }
            }))
            .map_err(|_| Error::Busy("application queue full or unavailable".into()))?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| Error::Timeout("application result uncertain".into()))?
            .map_err(|_| Error::Unavailable("application worker exited".into()))?
    }
}
pub async fn spawn() -> Result<(Handle, Arc<Notify>), Error> {
    let (tx, rx) = std::sync::mpsc::sync_channel::<Job>(256);
    let (ready_tx, ready_rx) = oneshot::channel();
    let notify = Arc::new(Notify::new());
    let n = notify.clone();
    std::thread::Builder::new()
        .name("applications-glib".into())
        .spawn(move || {
            let ctx = glib::MainContext::new();
            let _ = ctx.with_thread_default(|| {
                let mut store = Store::new(n);
                store.refresh();
                let _ = ready_tx.send(());
                let mut last_scan = Instant::now();
                let mut health = Instant::now();
                loop {
                    while ctx.pending() {
                        ctx.iteration(false);
                    }
                    // Bound each batch and dispatch consent notifications before
                    // every effect, even while callers keep the queue nonempty.
                    for _ in 0..16 {
                        while ctx.pending() {
                            ctx.iteration(false);
                        }
                        let Ok(job) = rx.try_recv() else { break };
                        job(&mut store);
                    }
                    if store.dirty.load(Ordering::Acquire)
                        && last_scan.elapsed() >= Duration::from_millis(100)
                        || health.elapsed() >= Duration::from_secs(2)
                    {
                        store.dirty.store(false, Ordering::Release);
                        store.refresh();
                        last_scan = Instant::now();
                        health = Instant::now();
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            });
        })
        .map_err(|e| Error::Failed(e.to_string()))?;
    tokio::time::timeout(Duration::from_secs(10), ready_rx)
        .await
        .map_err(|_| Error::Timeout("catalogue startup".into()))?
        .map_err(|_| Error::Unavailable("catalogue worker failed".into()))?;
    Ok((Handle { tx }, notify))
}
