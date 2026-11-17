// SPDX-License-Identifier: GPL-3.0-or-later
//! Domain invalidation and bounded filesystem candidates. No live Store crosses threads.
use super::{autostart, catalogue, icon_cache, icon_view, icons};
use gio::prelude::*;
use std::{
    cell::{Cell, RefCell},
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    path::{Path, PathBuf},
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
};
use tokio::sync::Notify;
pub const CATALOGUE: u32 = 1;
pub const ICONS: u32 = 2;
pub const AUTOSTART: u32 = 4;
pub const DEFAULTS: u32 = 8;
pub const LAYOUT: u32 = 16;
pub const THEME: u32 = 32;
pub const READ: u32 = CATALOGUE | ICONS | AUTOSTART | DEFAULTS;
pub const ASSETS: u32 = 64; // watch-plan group, not an invalidation domain
#[derive(Default)]
pub struct Dirty {
    pub wake: Notify,
    bits: AtomicU32,
}
impl Dirty {
    pub fn mark(&self, bits: u32) {
        self.bits.fetch_or(bits, Ordering::AcqRel);
        self.wake.notify_one();
    }
    pub fn take(&self) -> u32 {
        self.bits.swap(0, Ordering::AcqRel)
    }
}
// None means every direct child of this *actual target directory*. Missing
// targets always filter the next required component, never unrelated siblings.
pub type Plan = BTreeMap<(PathBuf, u32), Option<BTreeSet<OsString>>>;
fn add(plan: &mut Plan, path: PathBuf, domain: u32, names: Option<BTreeSet<OsString>>) {
    plan.entry((path, domain))
        .and_modify(|old| match (old.as_mut(), names.as_ref()) {
            (Some(old), Some(names)) => old.extend(names.iter().cloned()),
            _ => *old = None,
        })
        .or_insert(names);
}
pub fn directory(plan: &mut Plan, target: &Path, domain: u32) {
    let mut parent = target.to_owned();
    while !parent.is_dir() {
        if !parent.pop() {
            return;
        }
    }
    let names = if parent == target {
        None
    } else {
        target
            .strip_prefix(&parent)
            .ok()
            .and_then(|p| p.components().next())
            .map(|c| BTreeSet::from([c.as_os_str().to_owned()]))
    };
    add(plan, parent, domain, names);
}
pub fn file(plan: &mut Plan, target: &Path, domain: u32) {
    let Some(parent) = target.parent() else {
        return;
    };
    if parent.is_dir() {
        if let Some(name) = target.file_name() {
            add(
                plan,
                parent.to_owned(),
                domain,
                Some(BTreeSet::from([name.to_owned()])),
            );
        }
    } else {
        directory(plan, parent, domain);
    }
}
pub struct Input {
    pub icon_revision: u64,
    pub domains: u32,
    pub roots: Vec<PathBuf>,
    pub present: BTreeMap<PathBuf, String>,
    pub snapshot: Option<Arc<icon_view::Snapshot>>,
    pub theme: String,
}
pub struct Assets {
    pub signature: String,
    pub watches: Plan,
    pub apps: Vec<(String, String)>,
}
pub struct Output {
    pub icon_revision: u64,
    pub theme: String,
    pub catalogue: Option<(catalogue::Scan, BTreeMap<PathBuf, String>, Plan)>,
    pub artwork: Option<(String, Plan)>,
    pub assets: Option<Assets>,
    pub autostart: Option<(autostart::Index, Plan)>,
    pub default: Option<String>,
}
pub fn read(input: Input) -> Output {
    let _span = icon_cache::span("registry-read", "registry", 0);
    let mut out = Output {
        icon_revision: input.icon_revision,
        theme: input.theme.clone(),
        catalogue: None,
        artwork: None,
        assets: None,
        autostart: None,
        default: None,
    };
    if input.domains & CATALOGUE != 0 {
        let _span = icon_cache::span("catalogue-scan", "catalogue", 0);
        let mut present = input.present;
        let scan = catalogue::scan(&input.roots, &mut present);
        let standard = std::iter::once(glib::user_data_dir())
            .chain(glib::system_data_dirs())
            .map(|p| p.join("applications"))
            .collect::<BTreeSet<_>>();
        let mut plan = Plan::new();
        for root in &input.roots {
            if !standard.contains(root) {
                directory(&mut plan, root, CATALOGUE);
            }
        }
        // GIO covers standard top-level directories; preserve our recursive parser's
        // nested desktop directories, without an unfiltered parent of a missing root.
        for path in &scan.watches {
            if input
                .roots
                .iter()
                .any(|root| path != root && path.starts_with(root))
            {
                directory(&mut plan, path, CATALOGUE);
            }
        }
        file(&mut plan, &catalogue::root_history_path(), CATALOGUE);
        out.catalogue = Some((scan, present, plan));
    }
    let empty = BTreeMap::new();
    let before = input.snapshot.as_ref().map(|s| &s.apps).unwrap_or(&empty);
    let apps = out
        .catalogue
        .as_ref()
        .filter(|(s, _, _)| s.healthy || before.is_empty())
        .map(|(s, _, _)| &s.apps)
        .unwrap_or(before);
    if input.domains & ICONS != 0 {
        let _span = icon_cache::span("icon-tree-audit", "icons", 0);
        let (paths, _, signature) = icons::watches();
        let mut plan = Plan::new();
        for path in paths {
            directory(&mut plan, &path, ICONS);
        }
        out.artwork = Some((signature, plan));
    }
    if input.domains & ICONS != 0
        || apps
            .iter()
            .map(|(id, a)| (id, &a.icon))
            .ne(before.iter().map(|(id, a)| (id, &a.icon)))
    {
        let _span = icon_cache::span("selected-icon-audit", "icons", 0);
        let mut signatures = String::new();
        let mut plan = Plan::new();
        for app in apps.values() {
            if let Some(path) = icons::resolve(app, &input.theme, 64) {
                if let Ok(m) = path.metadata() {
                    signatures.push_str(&format!(
                        "{}:{}:{:?};",
                        path.display(),
                        m.len(),
                        m.modified()
                    ));
                }
                file(&mut plan, &path, ICONS);
                if let Ok(real) = path.canonicalize()
                    && real != path
                {
                    file(&mut plan, &real, ICONS);
                }
            }
        }
        out.assets = Some(Assets {
            signature: catalogue::hash(signatures.as_bytes()),
            watches: plan,
            apps: icon_ids(apps),
        });
    }
    if input.domains & AUTOSTART != 0 {
        let mut plan = Plan::new();
        for root in autostart::roots() {
            directory(&mut plan, &root, AUTOSTART);
        }
        out.autostart = Some((autostart::Index::scan(), plan));
    }
    if input.domains & DEFAULTS != 0 {
        // Also rearms AppInfoMonitor after its one-shot changed notice. Objects are
        // local to this read; only the desktop ID returns to the GLib owner.
        out.default = Some(
            gio::AppInfo::default_for_type("inode/directory", false)
                .and_then(|a| a.id())
                .map(|s| s.to_string())
                .unwrap_or_default(),
        );
    }
    out
}
pub fn icon_ids(apps: &BTreeMap<String, catalogue::App>) -> Vec<(String, String)> {
    apps.iter()
        .map(|(id, app)| (id.clone(), app.icon.clone()))
        .collect()
}
type Rules = BTreeMap<u32, Option<BTreeSet<OsString>>>;
pub struct Monitor {
    monitor: gio::FileMonitor,
    rules: Rc<RefCell<Rules>>,
    retired: Rc<Cell<bool>>,
}
impl Monitor {
    pub fn retired(&self) -> bool {
        self.retired.get() || self.monitor.is_cancelled()
    }
}
pub fn sync(
    monitors: &mut BTreeMap<PathBuf, Monitor>,
    plans: &BTreeMap<u32, Plan>,
    dirty: &Arc<Dirty>,
) -> u32 {
    sync_with_limit(monitors, plans, dirty, 8192)
}
fn sync_with_limit(
    monitors: &mut BTreeMap<PathBuf, Monitor>,
    plans: &BTreeMap<u32, Plan>,
    dirty: &Arc<Dirty>,
    limit: usize,
) -> u32 {
    let mut desired = BTreeMap::<PathBuf, Rules>::new();
    for plan in plans.values() {
        for ((path, domain), names) in plan {
            let p = desired.entry(path.clone()).or_default();
            match p.get_mut(domain) {
                Some(old) => match (old.as_mut(), names.as_ref()) {
                    (Some(old), Some(names)) => old.extend(names.iter().cloned()),
                    _ => *old = None,
                },
                None => {
                    p.insert(*domain, names.clone());
                }
            }
        }
    }
    let mut failed = 0;
    // Bound the desired set before retaining old monitors: an old path that is
    // displaced by a new earlier path must not survive beyond the budget.
    while desired.len() > limit {
        let (_, rules) = desired.pop_last().expect("excess monitor");
        failed |= rules.keys().fold(0, |a, b| a | b);
    }
    monitors.retain(|path, m| {
        let keep = desired.contains_key(path) && !m.retired();
        if !keep {
            m.monitor.cancel();
        }
        keep
    });
    for (path, rules) in desired {
        if let Some(m) = monitors.get_mut(&path) {
            *m.rules.borrow_mut() = rules;
            continue;
        }
        match gio::File::for_path(&path)
            .monitor_directory(gio::FileMonitorFlags::WATCH_MOVES, gio::Cancellable::NONE)
        {
            Ok(m) => {
                let rules = Rc::new(RefCell::new(rules));
                let r = rules.clone();
                let dirty = dirty.clone();
                let retired = Rc::new(Cell::new(false));
                let gone = retired.clone();
                let watched = path.clone();
                m.connect_changed(move |_, file, other, event| {
                    // A monitor belongs to a directory instance, not just its
                    // pathname. A quick replacement can leave the same plan
                    // pointing at an already-retired directory.
                    if file.path().as_deref() == Some(watched.as_path())
                        && matches!(
                            event,
                            gio::FileMonitorEvent::Deleted
                                | gio::FileMonitorEvent::Moved
                                | gio::FileMonitorEvent::Renamed
                                | gio::FileMonitorEvent::MovedOut
                                | gio::FileMonitorEvent::Unmounted
                        )
                    {
                        gone.set(true);
                        dirty.mark(r.borrow().keys().fold(0, |a, b| a | b));
                        return;
                    }
                    let bits = r
                        .borrow()
                        .iter()
                        .filter(|(_, names)| {
                            names.as_ref().is_none_or(|names| {
                                [Some(file), other].into_iter().flatten().any(|f| {
                                    f.basename().is_some_and(|n| names.contains(n.as_os_str()))
                                })
                            })
                        })
                        .fold(0, |a, (domain, _)| a | domain);
                    if bits != 0 {
                        dirty.mark(bits);
                    }
                });
                monitors.insert(
                    path,
                    Monitor {
                        monitor: m,
                        rules,
                        retired,
                    },
                );
            }
            Err(_) => failed |= rules.keys().fold(0, |a, b| a | b),
        }
    }
    failed
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "nidara-registry-watch-{}-{}",
                std::process::id(),
                crate::applications::unique()
            ));
            std::fs::create_dir(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn a_missing_root_watches_only_the_next_component_and_then_retargets() {
        let root = Directory::new();
        let target = root.0.join("flatpak/exports/share/applications");
        let mut plan = Plan::new();
        directory(&mut plan, &target, CATALOGUE);
        assert_eq!(
            plan[&(root.0.clone(), CATALOGUE)],
            Some(BTreeSet::from(["flatpak".into()]))
        );
        assert!(
            !plan[&(root.0.clone(), CATALOGUE)]
                .as_ref()
                .unwrap()
                .contains(std::ffi::OsStr::new("gvfs-metadata"))
        );
        std::fs::create_dir(root.0.join("flatpak")).unwrap();
        let mut plan = Plan::new();
        directory(&mut plan, &target, CATALOGUE);
        assert_eq!(
            plan[&(root.0.join("flatpak"), CATALOGUE)],
            Some(BTreeSet::from(["exports".into()]))
        );
        std::fs::create_dir_all(&target).unwrap();
        let mut plan = Plan::new();
        directory(&mut plan, &target, CATALOGUE);
        assert_eq!(plan[&(target, CATALOGUE)], None);
    }
    #[test]
    fn selected_assets_share_a_parent_filter_without_watching_usage_or_other_domains() {
        let root = Directory::new();
        let mut plan = Plan::new();
        file(&mut plan, &root.0.join("a.png"), ICONS);
        file(&mut plan, &root.0.join("b.png"), ICONS);
        assert_eq!(plan.len(), 1);
        assert_eq!(
            plan[&(root.0.clone(), ICONS)],
            Some(BTreeSet::from(["a.png".into(), "b.png".into()]))
        );
        file(
            &mut plan,
            &root.0.join("applications-roots-v1.json"),
            CATALOGUE,
        );
        assert_eq!(
            plan[&(root.0.clone(), CATALOGUE)],
            Some(BTreeSet::from(["applications-roots-v1.json".into()]))
        );
    }
    #[test]
    fn a_new_watch_displaces_an_old_one_without_exceeding_the_budget() {
        let root = Directory::new();
        for name in ["a", "b", "c"] {
            std::fs::create_dir(root.0.join(name)).unwrap();
        }
        let ctx = glib::MainContext::new();
        ctx.with_thread_default(|| {
            let dirty = Arc::new(Dirty::default());
            let mut monitors = BTreeMap::new();
            let mut plan = Plan::new();
            for name in ["b", "c"] {
                directory(&mut plan, &root.0.join(name), ICONS);
            }
            let mut plans = BTreeMap::from([(ICONS, plan)]);
            assert_eq!(sync_with_limit(&mut monitors, &plans, &dirty, 2), 0);
            assert_eq!(monitors.len(), 2);
            directory(plans.get_mut(&ICONS).unwrap(), &root.0.join("a"), ICONS);
            assert_eq!(sync_with_limit(&mut monitors, &plans, &dirty, 2), ICONS);
            assert_eq!(monitors.len(), 2);
            assert!(monitors.contains_key(&root.0.join("a")));
            assert!(!monitors.contains_key(&root.0.join("c")));
        })
        .unwrap();
    }
    #[test]
    fn a_replaced_directory_is_rearmed_even_when_the_path_and_plan_stay_the_same() {
        let root = Directory::new();
        let target = root.0.join("icons");
        std::fs::create_dir(&target).unwrap();
        let ctx = glib::MainContext::new();
        ctx.with_thread_default(|| {
            let dirty = Arc::new(Dirty::default());
            let mut monitors = BTreeMap::new();
            let mut plan = Plan::new();
            directory(&mut plan, &target, ICONS);
            let plans = BTreeMap::from([(ICONS, plan)]);
            assert_eq!(sync(&mut monitors, &plans, &dirty), 0);
            std::fs::rename(&target, root.0.join("old-icons")).unwrap();
            std::fs::create_dir(&target).unwrap();
            let pump = || {
                let end = std::time::Instant::now() + std::time::Duration::from_millis(300);
                while std::time::Instant::now() < end {
                    ctx.iteration(false);
                    std::thread::sleep(std::time::Duration::from_millis(5));
                }
            };
            pump();
            assert_eq!(dirty.take(), ICONS);
            assert!(monitors[&target].retired());
            assert_eq!(sync(&mut monitors, &plans, &dirty), 0);
            assert!(!monitors[&target].retired());
            std::fs::write(target.join("new.svg"), b"new icon").unwrap();
            pump();
            assert_eq!(dirty.take(), ICONS);
        })
        .unwrap();
    }
    #[test]
    fn invalidations_during_a_read_remain_pending_without_requeueing_other_domains() {
        let dirty = Dirty::default();
        dirty.mark(CATALOGUE);
        assert_eq!(dirty.take(), CATALOGUE); // the one reader now owns this work
        for _ in 0..100 {
            dirty.mark(AUTOSTART);
        }
        assert_eq!(dirty.take(), AUTOSTART); // completed catalogue still applies
        dirty.mark(CATALOGUE | THEME);
        dirty.mark(ICONS);
        assert_eq!(dirty.take(), CATALOGUE | THEME | ICONS);
        assert_eq!(dirty.take(), 0);
    }
}
