// SPDX-License-Identifier: GPL-3.0-or-later
use super::{
    Error,
    catalogue::{self, App},
    layout, refresh,
};
use gio::prelude::*;
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::sync::{Notify, oneshot};
pub struct Store {
    pub launches: super::launch::Book,
    pub usage: super::usage::Usage,
    pub unity: super::unity::Unity,
    pub observation: super::observation::Model,
    pub index: super::observation::Index,
    identity_dirty: Arc<Notify>,
    _identity_monitor: Option<gio::FileMonitor>,
    identity_launches: BTreeMap<u64, (String, Instant)>,
    identity_pending: BTreeMap<u64, (String, Instant)>,
    pub identity_units: BTreeMap<String, String>,
    pub usage_revision: u64,
    pub launcher_revision: u64,
    matches: Vec<Value>,
    matching_cache: BTreeMap<u64, (String, Value)>,
    logged_windows: BTreeSet<u64>,
    observation_reason: String,
    unity_publish_at: Option<Instant>,
    persist_at: Option<Instant>,
    last_persist: Instant,
    decay_at: Instant,
    early_outcomes: BTreeMap<u64, (Instant, Vec<Value>)>,
    pub epoch: u64,
    pub revision: u64,
    pub catalogue_revision: u64,
    pub layout_revision: u64,
    pub icon_revision: u64,
    /// The icon theme app icons resolve against (`apply_theme`).
    pub theme: String,
    icon_view: Arc<super::icon_view::Published>,
    portal_theme: Option<String>,
    interface: Option<gio::Settings>,
    pub apps: BTreeMap<String, App>,
    pub layout: Vec<String>,
    pub healthy: bool,
    pub diagnostics: Vec<String>,
    pub default: String,
    roots: Vec<PathBuf>,
    present: BTreeMap<PathBuf, String>,
    next_generation: u64,
    icon_fingerprint: String,
    asset_fingerprint: String,
    icon_waiters: Vec<(u64, oneshot::Sender<Result<u64, Error>>)>,
    autostarts: Option<super::autostart::Index>,
    monitor_plans: BTreeMap<u32, refresh::Plan>,
    pins: Option<gio::Settings>,
    /// The layout this service last wrote. GSettings tells us of our own write too, and
    /// that is not a change to read again: answered with a full refresh, it held the
    /// `Changed` of every pin, unpin and move back by the refresh, 1.3–1.75 s measured
    /// (owner, 2026-11-02: pinning felt slow).
    written: Arc<std::sync::Mutex<Option<Vec<String>>>>,
    pub settings: super::super::config::registry::Store,
    monitors: BTreeMap<PathBuf, refresh::Monitor>,
    dirty: Arc<refresh::Dirty>,
    monitor_failed: u32,
    _app_monitor: gio::AppInfoMonitor,
    _volumes: gio::VolumeMonitor,
    pub notify: Arc<Notify>,
    domains: BTreeSet<String>,
}
impl Store {
    fn new(
        notify: Arc<Notify>,
        icon_view: Arc<super::icon_view::Published>,
        identity_dirty: Arc<Notify>,
        package_revision: Arc<std::sync::atomic::AtomicU64>,
    ) -> Self {
        let _identity_monitor = gio::File::for_path("/var/lib/pacman/local")
            .monitor_directory(gio::FileMonitorFlags::NONE, gio::Cancellable::NONE)
            .ok();
        if let Some(m) = &_identity_monitor {
            let dirty = identity_dirty.clone();
            let package_revision = package_revision.clone();
            m.connect_changed(move |_, _, _, _| {
                package_revision.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                dirty.notify_one();
            });
        }
        let schema = gio::SettingsSchemaSource::default()
            .and_then(|s| s.lookup("org.nidara.dock", true))
            .filter(|s| s.has_key("pinned") && s.has_key("layout") && s.has_key("layout-version"));
        let pins = schema.map(|s| gio::Settings::new_full(&s, None::<&gio::SettingsBackend>, None));
        let dirty = Arc::new(refresh::Dirty::default());
        let written: Arc<std::sync::Mutex<Option<Vec<String>>>> = Arc::default();
        if let Some(p) = &pins {
            let d = dirty.clone();
            let own = written.clone();
            p.connect_changed(None, move |s, key| {
                if key != "layout" && key != "layout-version" {
                    return;
                }
                let ours = own.lock().is_ok_and(|w| {
                    w.as_ref().is_some_and(|w| {
                        s.uint("layout-version") == 1
                            && s.strv("layout")
                                .iter()
                                .map(|v| v.as_str())
                                .eq(w.iter().map(String::as_str))
                    })
                });
                if !ours {
                    d.mark(refresh::LAYOUT);
                }
            });
        }
        // The theme the portal publishes is this key (bin/nidara-portal serves the schema).
        // It is read here only while no portal answers: the portal starts on demand, and
        // until some app asks for it every icon would resolve against hicolor alone.
        let interface = gio::SettingsSchemaSource::default()
            .and_then(|s| s.lookup("org.gnome.desktop.interface", true))
            .filter(|s| s.has_key("icon-theme"))
            .map(|s| gio::Settings::new_full(&s, None::<&gio::SettingsBackend>, None));
        if let Some(i) = &interface {
            let d = dirty.clone();
            i.connect_changed(Some("icon-theme"), move |_, _| d.mark(refresh::THEME));
        }
        let app_monitor = gio::AppInfoMonitor::get();
        let d = dirty.clone();
        app_monitor.connect_changed(move |_| d.mark(refresh::CATALOGUE | refresh::DEFAULTS));
        let volumes = gio::VolumeMonitor::get();
        let d = dirty.clone();
        volumes.connect_mount_added(move |_, _| d.mark(refresh::READ));
        let d = dirty.clone();
        volumes.connect_mount_removed(move |_, _| d.mark(refresh::READ));
        let d = dirty.clone();
        volumes.connect_mount_changed(move |_, _| d.mark(refresh::READ));
        Self {
            launches: super::launch::Book::default(),
            usage: super::usage::Usage::new(),
            unity: super::unity::Unity::default(),
            observation: super::observation::Model::default(),
            index: super::observation::Index::default(),
            identity_dirty,
            _identity_monitor,
            identity_launches: BTreeMap::new(),
            identity_pending: BTreeMap::new(),
            identity_units: BTreeMap::new(),
            usage_revision: 1,
            launcher_revision: 1,
            matches: vec![],
            matching_cache: BTreeMap::new(),
            logged_windows: BTreeSet::new(),
            observation_reason: "H1 not connected".into(),
            unity_publish_at: None,
            persist_at: None,
            last_persist: Instant::now(),
            decay_at: Instant::now() + Duration::from_secs(30),
            early_outcomes: BTreeMap::new(),
            epoch: super::unique(),
            revision: 1,
            catalogue_revision: 1,
            layout_revision: 1,
            icon_revision: 1,
            theme: String::new(),
            icon_view,
            portal_theme: None,
            interface,
            apps: BTreeMap::new(),
            layout: vec![],
            healthy: false,
            diagnostics: vec![],
            default: String::new(),
            roots: catalogue::roots(),
            present: catalogue::root_history(),
            next_generation: 0,
            icon_fingerprint: String::new(),
            asset_fingerprint: String::new(),
            icon_waiters: Vec::new(),
            autostarts: None,
            monitor_plans: BTreeMap::new(),
            pins,
            settings: super::super::config::registry::Store::new(),
            monitors: BTreeMap::new(),
            dirty,
            written,
            monitor_failed: 0,
            _app_monitor: app_monitor,
            _volumes: volumes,
            notify,
            domains: BTreeSet::new(),
        }
    }
    fn publish_icons(&self) {
        let stamp = (
            self.epoch,
            self.catalogue_revision,
            self.layout_revision,
            self.icon_revision,
        );
        if self.icon_view.get().is_ok_and(|s| s.stamp() == stamp) {
            return;
        }
        self.icon_view.publish(super::icon_view::Snapshot {
            epoch: self.epoch,
            catalogue_revision: self.catalogue_revision,
            layout_revision: self.layout_revision,
            revision: self.icon_revision,
            theme: self.theme.clone(),
            apps: self.apps.clone(),
            layout: self.layout.iter().cloned().collect(),
        });
    }
    pub fn withdraw_icons(&self) {
        self.icon_view.withdraw();
    }
    /// What the portal answered for the icon theme; None while no portal answers.
    pub fn set_portal_theme(&mut self, theme: Option<String>) {
        self.portal_theme = theme;
        self.apply_theme();
    }
    fn apply_theme(&mut self) {
        let local = self
            .interface
            .as_ref()
            .map(|i| i.string("icon-theme").to_string());
        let theme = effective_theme(self.portal_theme.as_deref(), local);
        if theme != self.theme {
            self.theme = theme;
            self.icons_changed();
            self.dirty.mark(refresh::ICONS);
        }
    }
    pub fn invalidate_autostart(&self) {
        self.dirty.mark(refresh::AUTOSTART);
    }
    pub fn mark(&mut self, domain: &str) {
        self.revision += 1;
        self.domains.insert(domain.into());
        self.notify.notify_one();
    }
    pub fn icons_changed(&mut self) {
        self.icon_revision += 1;
        // Keep the observed filesystem baseline. Clearing it could swallow the
        // first real asset event after a theme/override invalidation.
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
            .is_some_and(|p| p.uint("layout-version") <= 1)
    }
    pub fn save_layout(&mut self, next: Vec<String>) -> Result<(), Error> {
        let pins = self
            .pins
            .as_ref()
            .ok_or_else(|| Error::Unavailable("typed dock schema missing".into()))?;
        if pins.uint("layout-version") > 1 {
            return Err(Error::Unavailable(
                "future layout version; no overwrite".into(),
            ));
        }
        let next = layout::validate(&next)?;
        if next == self.layout && pins.uint("layout-version") == 1 {
            return Ok(());
        }
        if let Ok(mut w) = self.written.lock() {
            *w = Some(next.clone());
        }
        pins.delay();
        let result = pins
            .set_strv("layout", next.as_slice())
            .and_then(|_| pins.set_uint("layout-version", 1));
        if let Err(e) = result {
            pins.revert();
            return Err(Error::Failed(e.to_string()));
        }
        pins.apply();
        gio::Settings::sync();
        if pins
            .strv("layout")
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            != next
            || pins.uint("layout-version") != 1
        {
            return Err(Error::Failed("layout write readback differs".into()));
        }
        self.layout = next;
        self.layout_revision += 1;
        self.mark("layout");
        Ok(())
    }
    fn read_input(&self, domains: u32) -> refresh::Input {
        refresh::Input {
            icon_revision: self.icon_revision,
            domains,
            roots: self.roots.clone(),
            present: self.present.clone(),
            snapshot: self.icon_view.get().ok(),
            theme: self.theme.clone(),
        }
    }
    fn read_failed(&mut self, domains: u32, error: &str) {
        self.monitor_failed |= domains;
        if domains & refresh::CATALOGUE != 0 {
            let message = "registry read unavailable; keeping the previous catalogue";
            let changed = self.healthy || !self.diagnostics.iter().any(|s| s == message);
            self.healthy = false;
            if !self.diagnostics.iter().any(|s| s == message) {
                self.diagnostics.push(message.into());
            }
            if changed {
                self.mark("catalogue");
            }
        }
        if domains & refresh::ICONS != 0 {
            for (_, reply) in self.icon_waiters.drain(..) {
                let _ = reply.send(Err(Error::Failed(
                    "icon write applied; audit unavailable".into(),
                )));
            }
        }
        eprintln!("Applications1 read worker: {error}");
    }
    fn apply_read(&mut self, result: refresh::Output) {
        let _span = super::icon_cache::span("registry-apply", "registry", 0);
        let mut plans_changed = false;
        let mut plan = |plans: &mut BTreeMap<u32, refresh::Plan>, group, value| {
            if plans.get(&group) != Some(&value) {
                plans.insert(group, value);
                plans_changed = true;
            }
        };
        // Catalogue/default/autostart results always make progress. Only icon
        // audits depend on mutable theme/override context captured by the reader.
        let icon_context = result.icon_revision == self.icon_revision && result.theme == self.theme;
        if let Some((index, watches)) = result.autostart {
            self.autostarts = Some(index);
            plan(&mut self.monitor_plans, refresh::AUTOSTART, watches);
            let index = self.autostarts.as_ref().unwrap();
            let mut changed = false;
            for app in self.apps.values_mut() {
                let next = index.state(app);
                if app.record["Autostart"] != next {
                    app.record["Autostart"] = next;
                    changed = true;
                }
            }
            if changed {
                self.catalogue_revision += 1;
                self.mark("autostart");
            }
        }
        if let Some((mut scan, present, watches)) = result.catalogue {
            plan(&mut self.monitor_plans, refresh::CATALOGUE, watches);
            let previous = self.present.clone();
            self.present = present;
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
            self.apply_catalogue(scan);
        }
        let mut icons_changed = false;
        let mut settled = false;
        if icon_context {
            if let Some((signature, watches)) = result.artwork {
                icons_changed |=
                    !self.icon_fingerprint.is_empty() && self.icon_fingerprint != signature;
                self.icon_fingerprint = signature;
                plan(&mut self.monitor_plans, refresh::ICONS, watches);
                settled = true;
            }
            if let Some(refresh::Assets {
                signature,
                watches,
                apps,
            }) = result.assets
            {
                if apps == refresh::icon_ids(&self.apps) {
                    icons_changed |=
                        !self.asset_fingerprint.is_empty() && self.asset_fingerprint != signature;
                    self.asset_fingerprint = signature;
                    plan(&mut self.monitor_plans, refresh::ASSETS, watches);
                } else {
                    settled = false;
                    self.dirty.mark(refresh::ICONS);
                }
            }
            if icons_changed {
                self.icons_changed();
            }
        } else if result.artwork.is_some() || result.assets.is_some() {
            self.dirty.mark(refresh::ICONS);
        }
        if let Some(default) = result.default
            && self.default != default
        {
            self.default = default;
            self.mark("defaults");
        }
        if plans_changed
            || self.monitor_failed != 0
            || self.monitors.values().any(refresh::Monitor::retired)
        {
            self.monitor_failed =
                refresh::sync(&mut self.monitors, &self.monitor_plans, &self.dirty);
        }
        if settled {
            // Complete acknowledged writes only after their filesystem baseline
            // and new metadata are committed, never inside the blocking reader.
            self.publish_icons();
            for (revision, reply) in std::mem::take(&mut self.icon_waiters) {
                if revision <= result.icon_revision {
                    let _ = reply.send(Ok(self.icon_revision));
                } else if !reply.is_closed() {
                    self.icon_waiters.push((revision, reply));
                }
            }
        }
    }
    fn apply_catalogue(&mut self, scan: catalogue::Scan) {
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
        let ids = apps.keys().cloned().collect::<BTreeSet<_>>();
        if self.usage.catalogue(ids.clone(), self.healthy, wall()) {
            let _ = self.usage.save();
            self.last_persist = Instant::now();
        }
        self.unity.retain(&ids);
        let autostarts = self
            .autostarts
            .as_ref()
            .expect("autostart initialized before catalogue");
        for (id, a) in &mut apps {
            a.record["Autostart"] = autostarts.state(a);
            let (score, observed, is_new) = self.usage.fields(id);
            a.record["ForegroundScore"] = json!(score);
            a.record["NewlyObservedAt"] = json!(observed);
            a.record["IsNew"] = json!(is_new);
            a.record["Launcher"] = self.unity.record(id);
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
            if self.launches.invalidate_apps(&self.apps) {
                self.mark("launches");
            }
            self.catalogue_revision += 1;
            self.mark("catalogue");
            self.index = super::observation::Index::new(&self.apps);
            self.identity_dirty.notify_one();
            self.refresh_matches();
        }
        if previous_health != self.healthy || previous_diagnostics != self.diagnostics {
            self.mark("catalogue");
        }
        self.usage.boundary(
            self.observation.eligible(&self.index),
            monotonic_us(),
            false,
            false,
            wall(),
        );
        self.project_usage();
        self.refresh_layout();
    }
    fn refresh_layout(&mut self) {
        let pending = self.pins.as_ref().map(|p| {
            let raw = p
                .strv("layout")
                .iter()
                .map(|s| s.to_string())
                .collect::<Vec<_>>();
            match p.uint("layout-version") {
                0 => {
                    let legacy = p
                        .strv("pinned")
                        .iter()
                        .map(|s| s.to_string())
                        .collect::<Vec<_>>();
                    Ok(layout::migrate(&legacy, &self.apps))
                }
                1 => layout::validate(&raw),
                _ => Err(Error::Invalid("future layout version".into())),
            }
        });
        if let Some(pending) = pending {
            match pending {
                // A pin whose app is not installed stays: the dock hides it, and an
                // upgrade that briefly removes the entry or a reinstall finds it (#1053).
                Ok(next) => {
                    if let Err(e) = self.save_layout(next) {
                        self.diagnostics.push(e.to_string());
                    }
                }
                Err(e) => self.diagnostics.push(e.to_string()),
            }
        }
    }
    pub fn metadata(&self) -> Value {
        json!({"CatalogueRevision":self.catalogue_revision,"LayoutRevision":self.layout_revision,"UsageRevision":self.usage_revision,"LauncherRevision":self.launcher_revision,"IconRevision":self.icon_revision,"CatalogueComplete":self.healthy,"Diagnostics":self.diagnostics,"Apps":self.apps.values().map(|a|a.record.clone()).collect::<Vec<_>>(),"LayoutAvailable":self.layout_available(),"Layout":layout::records(&self.layout,&self.apps,&self.default),"DefaultDirectoryApp":self.default,"WindowMatches":self.matches,"HyaloEpoch":self.observation.epoch,"ActiveLaunches":self.launches.active(),"MatchingAvailable":self.observation.live,"UsageAvailable":self.observation.live&&self.usage.available(),"UsageReason":if self.usage.available(){&self.observation_reason}else{self.usage.unavailable_reason()},"NewAppsAvailable":self.usage.baseline_available(),"NewAppsReason":self.usage.unavailable_reason(),"LauncherAvailable":self.unity.available,"LauncherHydrationIncomplete":self.unity.incomplete,"LaunchAvailable":true,"LaunchObservationAvailable":self.observation.live})
    }
}
type Job = Box<dyn FnOnce(&mut Store) + Send>;
#[derive(Clone)]
pub struct Handle {
    icon_view: Arc<super::icon_view::Published>,
    pub identity_dirty: Arc<Notify>,
    pub package_revision: Arc<std::sync::atomic::AtomicU64>,
    tx: tokio::sync::mpsc::Sender<Job>,
}
impl Handle {
    pub fn icon_snapshot(&self) -> Result<Arc<super::icon_view::Snapshot>, Error> {
        self.icon_view.get()
    }
    #[cfg(test)]
    pub(super) fn held_for_test(
        snapshot: super::icon_view::Snapshot,
    ) -> (Self, impl Send, Arc<super::icon_view::Published>) {
        let (tx, rx) = tokio::sync::mpsc::channel::<Job>(256);
        let icon_view = Arc::new(super::icon_view::Published::default());
        icon_view.publish(snapshot);
        (
            Self {
                tx,
                identity_dirty: Arc::default(),
                package_revision: Arc::default(),
                icon_view: icon_view.clone(),
            },
            rx,
            icon_view,
        )
    }
    /// Writes are acknowledged after the existing single reader has committed
    /// the corresponding icon baseline. The actor/H1 keep serving other jobs.
    pub async fn icon_write(
        &self,
        write: impl FnOnce(&mut Store) -> Result<(), Error> + Send + 'static,
    ) -> Result<u64, Error> {
        let reply = self
            .call(move |s| {
                write(s)?;
                let (tx, rx) = oneshot::channel();
                s.icon_waiters.retain(|(_, tx)| !tx.is_closed());
                s.icon_waiters.push((s.icon_revision, tx));
                s.dirty.mark(refresh::ICONS);
                Ok(rx)
            })
            .await?;
        tokio::time::timeout(Duration::from_secs(5), reply)
            .await
            .map_err(|_| Error::Timeout("icon write applied; audit result uncertain".into()))?
            .map_err(|_| Error::Unavailable("icon audit worker exited".into()))?
    }
    pub async fn call<T: Send + 'static>(
        &self,
        f: impl FnOnce(&mut Store) -> Result<T, Error> + Send + 'static,
    ) -> Result<T, Error> {
        let (tx, rx) = oneshot::channel();
        self.tx
            .try_send(Box::new(move |store| {
                if !tx.is_closed() {
                    let result = f(store);
                    // Publish before the effect's reply: a subsequent read must
                    // see acknowledged overrides, generations and layout changes.
                    store.publish_icons();
                    let _ = tx.send(result);
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
    let (tx, mut rx) = tokio::sync::mpsc::channel::<Job>(256);
    let (ready_tx, ready_rx) = oneshot::channel();
    let notify = Arc::new(Notify::new());
    let icon_view = Arc::new(super::icon_view::Published::default());
    let identity_dirty = Arc::new(Notify::new());
    let package_revision = Arc::new(std::sync::atomic::AtomicU64::new(1));
    let identity_wake = identity_dirty.clone();
    let package_version = package_revision.clone();
    let published = icon_view.clone();
    let n = notify.clone();
    std::thread::Builder::new()
        .name("applications-glib".into())
        .spawn(move || {
            let _icons_lifetime = super::icon_view::Lifetime(published.clone());
            let ctx = glib::MainContext::new();
            let _ = ctx.with_thread_default(|| {
                let mut store = Store::new(n, published, identity_wake, package_version);
                store.apply_theme();
                // The initial read already includes the just-selected theme.
                store.dirty.take();
                let first=refresh::read(store.read_input(refresh::READ));
                store.apply_read(first);
                store.publish_icons();
                let _ = ready_tx.send(());
                let main_loop = glib::MainLoop::new(Some(&ctx), false);
                let stop = main_loop.clone();
                ctx.spawn_local(async move {
                    let mut backoff=1_u64;
                    let mut recovery_at=Instant::now()+Duration::from_secs(1);
                    let mut pending=store.dirty.take();
                    let mut debounce=None;
                    let mut work:Option<(u32,oneshot::Receiver<refresh::Output>)>=None;
                    loop {
                        if pending!=0 && debounce.is_none(){debounce=Some(Instant::now()+Duration::from_millis(100));}
                        let dirty=store.dirty.clone();
                        let deadline=store.tracking_deadline();
                        let tracking=async {match deadline {Some(at)=>glib::timeout_future(at.saturating_duration_since(Instant::now())).await,None=>std::future::pending::<()>().await}};
                        let ready_at=debounce.filter(|_|work.is_none());
                        let timer=async {match ready_at {Some(at)=>glib::timeout_future(at.saturating_duration_since(Instant::now())).await,None=>std::future::pending::<()>().await}};
                        let recover=(!store.healthy || store.monitor_failed!=0) && work.is_none() && pending==0;
                        let recovery=async {if recover {glib::timeout_future(recovery_at.saturating_duration_since(Instant::now())).await;}else{std::future::pending::<()>().await;}};
                        let completed=async {match work.as_mut(){Some((_,rx))=>rx.await,None=>std::future::pending().await}};
                        tokio::select! {
                            _=dirty.wake.notified()=>{
                                pending|=dirty.take();
                                if pending&refresh::THEME!=0 {store.apply_theme();pending&=!refresh::THEME;}
                                if pending&refresh::LAYOUT!=0 {store.refresh_layout();store.publish_icons();pending&=!refresh::LAYOUT;}
                            }
                            _=timer=>{
                                let domains=std::mem::take(&mut pending)&refresh::READ;debounce=None;
                                if domains!=0 {
                                    let input=store.read_input(domains);
                                    let (tx,rx)=oneshot::channel();
                                    match std::thread::Builder::new().name("applications-read".into()).spawn(move||{let _=tx.send(refresh::read(input));}) {
                                        Ok(_)=>work=Some((domains,rx)),
                                        Err(e)=>{store.read_failed(domains,&e.to_string());recovery_at=Instant::now()+Duration::from_secs(backoff);backoff=(backoff*2).min(60);}
                                    }
                                }
                            }
                            result=completed=>{
                                let (domains,_)=work.take().expect("completed read");
                                match result {
                                    Ok(candidate)=>store.apply_read(candidate),
                                    Err(e)=>{store.read_failed(domains,&e.to_string());}
                                }
                                store.publish_icons();
                                backoff=if store.healthy && store.monitor_failed==0 {1}else{(backoff*2).min(60)};
                                recovery_at=Instant::now()+Duration::from_secs(backoff);
                            }
                            _=recovery=>{
                                pending|=store.monitor_failed;
                                if !store.healthy {pending|=refresh::CATALOGUE|refresh::DEFAULTS;}
                            }
                            _=tracking=>{store.tracking_tick();store.publish_icons();}
                            job=rx.recv()=>{
                                let Some(job)=job else{break;};
                                // Keep consent notifications ahead of each effect.
                                glib::timeout_future_with_priority(glib::Priority::LOW,Duration::ZERO).await;
                                job(&mut store);
                            }
                        }
                    }
                    stop.quit();
                });
                main_loop.run();
            });
        })
        .map_err(|e| Error::Failed(e.to_string()))?;
    tokio::time::timeout(Duration::from_secs(10), ready_rx)
        .await
        .map_err(|_| Error::Timeout("catalogue startup".into()))?
        .map_err(|_| Error::Unavailable("catalogue worker failed".into()))?;
    let handle = Handle {
        tx,
        icon_view,
        identity_dirty,
        package_revision,
    };
    super::identity::spawn(handle.clone()).await?;
    Ok((handle, notify))
}

/// The portal's answer while it gives one; else the setting it would publish; else none
/// (hicolor and pixmaps only).
fn effective_theme(portal: Option<&str>, local: Option<String>) -> String {
    portal.map(str::to_owned).or(local).unwrap_or_default()
}

pub fn wall() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
}
pub fn monotonic_us() -> u64 {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut t) };
    t.tv_sec as u64 * 1_000_000 + t.tv_nsec as u64 / 1000
}
impl Store {
    pub fn project_usage(&mut self) {
        let ids = self.usage.take_changed();
        let mut foreground_ack = false;
        for id in &ids {
            if let Some(a) = self.apps.get_mut(id) {
                let (score, observed, is_new) = self.usage.fields(id);
                foreground_ack |= a.record["IsNew"] == true && !is_new;
                a.record["ForegroundScore"] = json!(score);
                a.record["NewlyObservedAt"] = json!(observed);
                a.record["IsNew"] = json!(is_new);
            }
        }
        if foreground_ack {
            let _ = self.usage.save();
            self.last_persist = Instant::now();
        }
        if !ids.is_empty() {
            self.usage_revision += 1;
            self.mark("usage");
        }
        if self.usage.dirty && self.persist_at.is_none() {
            self.persist_at =
                Some((self.last_persist + Duration::from_secs(1)).max(Instant::now()));
        }
    }
    pub fn record_identity_unit(&mut self, unit: String, exe: String) {
        if self.identity_units.len() < 4096 {
            self.identity_units.insert(unit, exe);
            self.identity_dirty.notify_one();
        }
    }
    pub(super) fn identity_applied(&mut self) {
        if !self.refresh_matches() {
            return;
        }
        self.usage.boundary(
            self.observation.eligible(&self.index),
            monotonic_us(),
            false,
            false,
            wall(),
        );
        self.project_usage();
    }
    pub fn window_match(&self, id: u64) -> Option<&Value> {
        self.matches.iter().find(|v| v["WindowId"] == id)
    }
    pub(super) fn refresh_matches(&mut self) -> bool {
        self.logged_windows
            .retain(|id| self.observation.windows.contains_key(id));
        self.matching_cache
            .retain(|id, _| self.observation.live && self.observation.windows.contains_key(id));
        let next = if self.observation.live {
            self.observation
                .windows
                .keys()
                .map(|id| {
                    let mut key = format!("{}:{}", self.catalogue_revision, self.observation.epoch);
                    let mut seen = BTreeSet::new();
                    let mut current = Some(*id);
                    while let Some(w) = current.and_then(|id| self.observation.windows.get(&id)) {
                        if seen.len() >= 32 || !seen.insert(w.id) {
                            break;
                        }
                        use std::fmt::Write;
                        let _ = write!(
                            &mut key,
                            "{:?}",
                            (w.identity(), &w.evidence, w.evidence_ready, &w.token_app)
                        );
                        current = w.parent;
                    }
                    if !self
                        .matching_cache
                        .get(id)
                        .is_some_and(|(old, _)| *old == key)
                    {
                        self.matching_cache
                            .insert(*id, (key, self.observation.resolve(&self.index, *id)));
                    }
                    self.matching_cache[id].1.clone()
                })
                .collect()
        } else {
            vec![]
        };
        if next != self.matches {
            for v in &next {
                if v["DesktopId"].as_str().is_some_and(|s| !s.is_empty())
                    && v["WindowId"]
                        .as_u64()
                        .is_some_and(|id| self.logged_windows.insert(id))
                {
                    eprintln!(
                        "[applications] window {} resolved to {} ({})",
                        v["WindowId"], v["DesktopId"], v["MatchKind"]
                    );
                }
            }
            self.matches = next;
            self.mark("matching");
            return true;
        }
        false
    }
    pub fn observation_start(&mut self, snapshot: Value) -> Result<(), Error> {
        self.usage.disconnect();
        self.early_outcomes.clear();
        self.identity_launches.clear();
        self.identity_pending.clear();
        self.logged_windows.clear();
        self.observation
            .bootstrap(snapshot)
            .map_err(Error::Unavailable)?;
        self.observation_reason.clear();
        self.identity_dirty.notify_one();
        self.refresh_matches();
        self.mark("matching");
        self.mark("usage");
        self.usage.boundary(
            self.observation.eligible(&self.index),
            self.observation.time,
            false,
            true,
            wall(),
        );
        self.project_usage();
        Ok(())
    }
    pub fn observation_event(&mut self, event: Value) -> Result<(), Error> {
        let identity_changed = matches!(
            event["event"].as_str(),
            Some("windows_changed" | "focus_transition")
        );
        let effect = self.observation.event(event).map_err(Error::Unavailable)?;
        if identity_changed {
            self.identity_pending.retain(|id, (app, at)| {
                if let Some(w) = self.observation.windows.get_mut(id) {
                    w.token_app = app.clone();
                    return false;
                }
                at.elapsed() < Duration::from_secs(10)
            });
            self.identity_dirty.notify_one();
        }
        if effect.boundary {
            self.refresh_matches();
            self.usage.boundary(
                self.observation.eligible(&self.index),
                self.observation.time,
                effect.idle_cap,
                effect.force,
                wall(),
            );
            self.project_usage();
        }
        if effect.stop {
            self.launches.stop_observation("session locked or sleeping");
            self.mark("launches");
        }
        if let Some((number, outcome)) = effect.outcome {
            self.launch_outcome(number, outcome);
        }
        if self.launches.reconcile(
            &self.observation.epoch,
            &self.matches,
            self.observation.focus,
        ) {
            self.mark("launches");
        }
        Ok(())
    }
    pub fn observation_lost(&mut self, reason: String) {
        let was = self.observation.live;
        self.observation.disconnect();
        self.usage.disconnect();
        self.early_outcomes.clear();
        self.observation_reason = reason;
        if was {
            self.refresh_matches();
            self.launches.stop_observation("H1 observation lost");
            self.mark("matching");
            self.mark("usage");
            self.mark("launches");
        }
    }
    pub fn unity_status(&mut self, available: bool, incomplete: bool) {
        let change = self.unity.status(available, incomplete);
        let ids = if !available {
            self.unity.flush()
        } else {
            BTreeSet::new()
        };
        self.project_unity(ids, change);
    }
    pub fn unity_update(
        &mut self,
        owner: String,
        path: String,
        id: String,
        patch: super::unity::Patch,
    ) {
        self.unity.update(owner, path, id, patch);
        if self.unity.pending() && self.unity_publish_at.is_none() {
            self.unity_publish_at = Some(Instant::now() + Duration::from_millis(100));
        }
    }
    pub fn unity_lost(&mut self, owner: &str) {
        let ids = self.unity.lost(owner);
        self.project_unity(ids, false);
    }
    fn project_unity(&mut self, ids: BTreeSet<String>, status: bool) {
        for id in &ids {
            if let Some(a) = self.apps.get_mut(id) {
                a.record["Launcher"] = self.unity.record(id);
            }
        }
        if status || !ids.is_empty() {
            self.launcher_revision += 1;
            self.mark("launcher");
        }
    }
    fn tracking_deadline(&self) -> Option<Instant> {
        self.unity_publish_at
            .into_iter()
            .chain(self.persist_at)
            .chain(self.usage.needs_decay().then_some(self.decay_at))
            .min()
    }
    fn tracking_tick(&mut self) {
        let now = Instant::now();
        if self.unity_publish_at.is_some_and(|at| at <= now) {
            self.unity_publish_at = None;
            let ids = self.unity.flush();
            self.project_unity(ids, false);
        }
        if self.decay_at <= now {
            self.decay_at = now + Duration::from_secs(30);
            self.usage.decay(wall());
            self.project_usage();
        }
        if self.persist_at.is_some_and(|at| at <= now) {
            let was = self.usage.available();
            let _ = self.usage.save();
            self.last_persist = now;
            self.persist_at = if self.usage.dirty {
                Some(now + Duration::from_secs(30))
            } else {
                None
            };
            if was != self.usage.available() {
                self.mark("usage");
            }
        }
    }
    fn launch_outcome(&mut self, number: u64, outcome: Value) {
        self.identity_launches
            .retain(|_, (_, at)| at.elapsed() < Duration::from_secs(60));
        if matches!(
            outcome["outcome"].as_str(),
            Some("window" | "activated" | "refused")
        ) && let Some((app, _)) = self.identity_launches.get(&number)
            && let Some(id) = outcome["window"].as_u64()
        {
            if let Some(w) = self.observation.windows.get_mut(&id) {
                w.token_app = app.clone();
            } else if self.identity_pending.len() < 4096 {
                self.identity_pending
                    .insert(id, (app.clone(), Instant::now()));
            }
            self.refresh_matches();
        }
        self.early_outcomes
            .retain(|_, (at, _)| at.elapsed() < Duration::from_secs(10));
        if self.launches.outcome(
            &self.observation.epoch,
            number,
            &outcome,
            self.observation.focus,
        ) {
            self.mark("launches");
        } else if !self.identity_launches.contains_key(&number) && self.early_outcomes.len() < 128 {
            let entry = self
                .early_outcomes
                .entry(number)
                .or_insert_with(|| (Instant::now(), Vec::new()));
            if entry.1.len() < 128 {
                entry.1.push(outcome);
            }
        }
    }
    pub fn bind_launch(
        &mut self,
        id: &str,
        connection: &str,
        run: u64,
        number: u64,
        already: Option<Value>,
    ) {
        if !self.observation.live
            || self.observation.epoch != connection
            || self.observation.run != run
        {
            return;
        }
        self.early_outcomes
            .retain(|_, (at, _)| at.elapsed() < Duration::from_secs(10));
        if let Some(app) = self.launches.desktop_id(id)
            && self.identity_launches.len() < 4096
        {
            self.identity_launches.insert(number, (app, Instant::now()));
        }
        self.launches.bind(id, connection, number);
        let mut results = self
            .early_outcomes
            .remove(&number)
            .map(|(_, v)| v)
            .unwrap_or_default();
        if let Some(v) = already {
            results.push(v);
        }
        for v in results {
            self.launch_outcome(number, v);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::effective_theme;
    #[test]
    fn the_icon_theme_is_known_before_any_portal_starts() {
        assert_eq!(effective_theme(None, Some("Papirus".into())), "Papirus");
        assert_eq!(
            effective_theme(Some("Adwaita"), Some("Papirus".into())),
            "Adwaita"
        );
        assert_eq!(effective_theme(None, None), "");
    }

    /// Writes `name` the way the store does (a temporary, then a rename) and says
    /// whether the history directory's monitor marked the catalogue dirty.
    fn dirtied_by(dir: &std::path::Path, name: &str) -> bool {
        let dirty = std::sync::Arc::new(super::refresh::Dirty::default());
        let ctx = glib::MainContext::new();
        ctx.with_thread_default(|| {
            let mut plan = super::refresh::Plan::new();
            super::refresh::file(
                &mut plan,
                &dir.join("applications-roots-v1.json"),
                super::refresh::CATALOGUE,
            );
            let mut monitors = std::collections::BTreeMap::new();
            let plans = std::collections::BTreeMap::from([(super::refresh::CATALOGUE, plan)]);
            assert_eq!(super::refresh::sync(&mut monitors, &plans, &dirty), 0);
            let temp = dir.join(format!(".{name}-{}", super::super::unique()));
            std::fs::write(&temp, b"{}").unwrap();
            std::fs::rename(&temp, dir.join(name)).unwrap();
            let end = std::time::Instant::now() + std::time::Duration::from_millis(400);
            while std::time::Instant::now() < end {
                ctx.iteration(false);
                std::thread::sleep(std::time::Duration::from_millis(5));
            }
        })
        .unwrap();
        dirty.take() != 0
    }

    #[test]
    fn the_store_does_not_wake_itself_with_its_own_usage_state() {
        let dir = std::env::current_dir()
            .unwrap()
            .join(format!("target/a1-history-{}", super::super::unique()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(
            !dirtied_by(&dir, "applications-v1.json"),
            "a usage checkpoint refreshed the catalogue (#1051)"
        );
        assert!(
            dirtied_by(&dir, "applications-roots-v1.json"),
            "a root-history change was missed"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
}
