// SPDX-License-Identifier: GPL-3.0-or-later
//! Blocking evidence collection. No environment launch markers or executable guessing.
use super::observation::Window;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
    path::{Path, PathBuf},
};

pub fn spawn(store: super::store::Handle) {
    tokio::spawn(async move {
        let mut collector = Collector::default();
        let mut warned = false;
        loop {
            store.identity_dirty.notified().await;
            let Ok((epoch, windows, units)) = store
                .call(|s| {
                    Ok((
                        s.observation.epoch.clone(),
                        s.observation.windows.clone(),
                        s.identity_units.clone(),
                    ))
                })
                .await
            else {
                if !warned {
                    eprintln!("[applications] identity worker waiting for catalogue actor");
                    warned = true;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                store.identity_dirty.notify_one();
                continue;
            };
            let version = store
                .package_revision
                .load(std::sync::atomic::Ordering::Relaxed);
            let job = tokio::task::spawn_blocking(move || {
                if collector.known_units != units {
                    collector.known_units = units;
                    collector.cache.clear();
                    collector.main_pids.clear();
                }
                let evidence = collector.collect(&epoch, version, &windows);
                (collector, epoch, windows, evidence)
            })
            .await;
            let Ok((next, epoch, windows, evidence)) = job else {
                eprintln!("[applications] identity collection worker exited");
                return;
            };
            collector = next;
            // Continue bounded queued work, never poll when all identities are hydrated.
            if evidence.values().any(|e| e.pending) {
                store.identity_dirty.notify_one();
            }
            let watches = collector
                .packages
                .as_ref()
                .map(|p| p.watches.clone())
                .unwrap_or_default();
            let package_revision = store.package_revision.clone();
            let applied = store
                .call(move |s| {
                    if package_revision.load(std::sync::atomic::Ordering::Relaxed) != version
                        || s.observation.epoch != epoch
                    {
                        return Ok(());
                    }
                    s.monitor_packages(version, watches);
                    apply_evidence(&mut s.observation, &epoch, &windows, evidence);
                    s.identity_applied();
                    Ok(())
                })
                .await;
            if applied.is_err() {
                if !warned {
                    eprintln!("[applications] identity publication waiting for catalogue actor");
                    warned = true;
                }
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                store.identity_dirty.notify_one();
            } else {
                warned = false;
            }
        }
    });
}

fn apply_evidence(
    model: &mut super::observation::Model,
    epoch: &str,
    captured: &BTreeMap<u64, Window>,
    evidence: BTreeMap<u64, Evidence>,
) {
    if model.epoch != epoch {
        return;
    }
    for (id, e) in evidence {
        if let Some(w) = model.windows.get_mut(&id)
            && captured
                .get(&id)
                .is_some_and(|old| old.identity() == w.identity())
        {
            w.evidence_ready = !e.pending;
            w.evidence = e;
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Evidence {
    pub pending: bool,
    pub flatpak: Vec<String>,
    pub snap: Vec<String>,
    pub packages: Vec<String>, // exact desktop file paths, not basenames
    pub units: Vec<String>,
    pub scopes: Vec<String>,
}

fn read(path: impl AsRef<Path>) -> Option<String> {
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() <= 1024 * 1024)
        .then(|| String::from_utf8(bytes).ok())
        .flatten()
}

#[derive(Default)]
struct Packages {
    owners: BTreeMap<String, BTreeSet<String>>,
    desktops: BTreeMap<String, Vec<String>>,
    browsers: BTreeSet<String>,
    uncertain: BTreeSet<String>,
    cache: BTreeMap<String, Vec<String>>,
    watches: Vec<PathBuf>,
}
impl Packages {
    fn load(db: &Path, root: &Path) -> Option<Self> {
        let mut p = Self::default();
        for entry in std::fs::read_dir(db).ok()? {
            let dir = entry.ok()?.path();
            let Some(files) = read(dir.join("files")) else {
                continue;
            };
            let package = dir.file_name()?.to_str()?.to_owned();
            p.watches.push(dir.join("files"));
            let mut in_files = false;
            for line in files.lines() {
                if line.starts_with('%') {
                    in_files = line == "%FILES%";
                    continue;
                }
                if !in_files || line.is_empty() || line.ends_with('/') {
                    continue;
                }
                let path = format!("/{}", line.trim_start_matches('/'));
                p.owners
                    .entry(path.clone())
                    .or_default()
                    .insert(package.clone());
                if p.owners.len() > 2_000_000 {
                    return None;
                }
                if path.starts_with("/usr/share/applications/") && path.ends_with(".desktop") {
                    p.desktops
                        .entry(package.clone())
                        .or_default()
                        .push(path.clone());
                    let metadata = read(root.join(path.trim_start_matches('/')));
                    if metadata.is_none() {
                        p.uncertain.insert(package.clone());
                    }
                    if metadata.is_some_and(|s| {
                        s.lines().any(|l| {
                            l.strip_prefix("MimeType=")
                                .is_some_and(|v| v.split(';').any(|m| m == "x-scheme-handler/http"))
                        })
                    }) {
                        p.browsers.insert(package.clone());
                    }
                }
            }
        }
        Some(p)
    }
    fn for_exe(&mut self, exe: &str) -> Vec<String> {
        if self.cache.len() >= 8192 {
            self.cache.clear();
        }
        if let Some(v) = self.cache.get(exe) {
            return v.clone();
        }
        let mut result = BTreeSet::new();
        if let Some(owners) = self.owners.get(exe) {
            for owner in owners {
                // Even when a browser package also has another launcher, none qualify.
                if self.browsers.contains(owner) || self.uncertain.contains(owner) {
                    continue;
                }
                result.extend(self.desktops.get(owner).into_iter().flatten().cloned());
            }
        }
        let result: Vec<_> = result.into_iter().collect();
        self.cache.insert(exe.into(), result.clone());
        result
    }
}

fn unescape(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' {
            if b.get(i + 1) != Some(&b'x') {
                return None;
            }
            out.push(u8::from_str_radix(std::str::from_utf8(b.get(i + 2..i + 4)?).ok()?, 16).ok()?);
            i += 4;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}
/// Return possible exact app IDs; the catalogue, not a split on '-', selects them.
pub fn unit_ids(cgroup: &str) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut services = BTreeSet::new();
    let mut scopes = BTreeSet::new();
    let mut snaps = BTreeSet::new();
    for part in cgroup.lines().flat_map(|l| l.split('/')) {
        let Some(part) = unescape(part) else { continue };
        if let Some(s) = part
            .strip_prefix("snap.")
            .and_then(|s| s.split('.').next())
            .filter(|s| !s.is_empty())
        {
            snaps.insert(s.into());
        }
        let Some(s) = part.strip_prefix("app-") else {
            continue;
        };
        if let Some((id, _)) = s.strip_suffix(".service").and_then(|s| s.split_once('@')) {
            services.insert(id.into());
            // app-Nidara-org.telegram.desktop@... and other launcher prefixes.
            if let Some((launcher, app)) = id.split_once('-')
                && matches!(
                    launcher,
                    "Nidara" | "nidara" | "gnome" | "GNOME" | "kde" | "KDE" | "uwsm" | "systemd"
                )
            {
                services.insert(app.into());
            }
        } else if let Some((id, _)) = s.strip_suffix(".scope").and_then(|s| s.rsplit_once('-')) {
            scopes.insert(id.into());
            if let Some((launcher, app)) = id.split_once('-')
                && matches!(
                    launcher,
                    "Nidara" | "nidara" | "gnome" | "GNOME" | "kde" | "KDE" | "uwsm" | "systemd"
                )
            {
                scopes.insert(app.into());
            }
        }
    }
    (
        services.into_iter().collect(),
        scopes.into_iter().collect(),
        snaps.into_iter().collect(),
    )
}

fn flatpak(s: &str) -> Option<String> {
    let mut application = false;
    for line in s.lines().map(str::trim) {
        if line.starts_with('[') {
            application = line == "[Application]";
        } else if application && let Some(v) = line.strip_prefix("name=").filter(|v| !v.is_empty())
        {
            return Some(v.into());
        }
    }
    None
}
fn parent(stat: &str) -> Option<u32> {
    stat.rsplit_once(')')?
        .1
        .split_whitespace()
        .nth(1)?
        .parse()
        .ok()
}

pub struct Collector {
    proc: PathBuf,
    db: PathBuf,
    root: PathBuf,
    packages: Option<Packages>,
    loaded: bool,
    revision: u64,
    epoch: String,
    known_units: BTreeMap<String, String>,
    main_pids: BTreeMap<String, Option<u32>>,
    query_budget: usize,
    cache: BTreeMap<u64, (String, Evidence)>,
}
impl Default for Collector {
    fn default() -> Self {
        Self::new("/proc".into(), "/var/lib/pacman/local".into(), "/".into())
    }
}
impl Collector {
    fn new(proc: PathBuf, db: PathBuf, root: PathBuf) -> Self {
        Self {
            proc,
            db,
            root,
            packages: None,
            loaded: false,
            revision: 0,
            epoch: String::new(),
            known_units: BTreeMap::new(),
            main_pids: BTreeMap::new(),
            query_budget: 0,
            cache: BTreeMap::new(),
        }
    }
    pub fn collect(
        &mut self,
        epoch: &str,
        revision: u64,
        windows: &BTreeMap<u64, Window>,
    ) -> BTreeMap<u64, Evidence> {
        if self.revision != revision || self.epoch != epoch {
            self.cache.clear();
            self.epoch = epoch.into();
            if self.revision != revision {
                self.packages = None;
                self.loaded = false;
                self.revision = revision;
            }
        }
        self.query_budget = 12;
        if self.main_pids.len() > 8192 {
            self.main_pids.clear();
        }
        self.cache.retain(|id, _| windows.contains_key(id));
        windows
            .iter()
            .map(|(id, w)| {
                let signature = w.identity();
                if let Some((old, e)) = self.cache.get(id)
                    && *old == signature
                {
                    return (*id, e.clone());
                }
                let e = self.process(w.pid);
                if !e.pending {
                    self.cache.insert(*id, (signature, e.clone()));
                }
                (*id, e)
            })
            .collect()
    }
    fn process(&mut self, pid: Option<u32>) -> Evidence {
        let mut evidence = Evidence::default();
        let Some(mut pid) = pid.filter(|p| *p > 1) else {
            return evidence;
        };
        let original_pid = pid;
        let dir = self.proc.join(pid.to_string());
        let Some(window_exe) = std::fs::read_link(dir.join("exe")).ok() else {
            return evidence;
        };
        let before = read(dir.join("stat"));
        if let Some(v) = read(dir.join("root/.flatpak-info")).and_then(|s| flatpak(&s)) {
            evidence.flatpak.push(v);
        }
        evidence.snap = unit_ids(&read(dir.join("cgroup")).unwrap_or_default()).2;
        if !self.loaded {
            self.packages = Packages::load(&self.db, &self.root);
            self.loaded = true;
        }
        if let Some(p) = self.packages.as_mut()
            && let Some(exe) = window_exe.to_str()
        {
            evidence.packages = p.for_exe(exe);
        }
        let mut seen = BTreeSet::new();
        for _ in 0..32 {
            if pid <= 1 || !seen.insert(pid) {
                break;
            }
            let dir = self.proc.join(pid.to_string());
            if std::fs::read_link(dir.join("exe"))
                .ok()
                .as_ref()
                .and_then(|p| p.file_name())
                .and_then(|s| s.to_str())
                .is_some_and(|s| {
                    matches!(
                        s,
                        "systemd"
                            | "gnome-session-binary"
                            | "startplasma-wayland"
                            | "uwsm"
                            | "nidara-session"
                            | "nidara-sessiond"
                            | "nidara-hyalo"
                            | "gdm-session-worker"
                            | "sddm-helper"
                    )
                })
            {
                break;
            }
            let (units, scopes, pending) =
                self.verified_units(&read(dir.join("cgroup")).unwrap_or_default(), &window_exe);
            evidence.pending |= pending;
            if evidence.units.is_empty() {
                evidence.units = units;
            }
            if evidence.scopes.is_empty() {
                evidence.scopes = scopes;
            }
            if pid == original_pid && evidence.units.is_empty() {
                self.descendant_units(pid, &window_exe, &mut evidence);
            }
            let Some(next) = read(dir.join("stat")).and_then(|s| parent(&s)) else {
                break;
            };
            pid = next;
        }
        let after = read(self.proc.join(original_pid.to_string()).join("stat"));
        let identity = |s: &str| {
            s.rsplit_once(')').map(|(_, tail)| {
                tail.split_whitespace()
                    .nth(19)
                    .unwrap_or_default()
                    .to_owned()
            })
        };
        if before.as_deref().and_then(identity) != after.as_deref().and_then(identity) {
            return Evidence::default();
        }
        evidence
    }
    fn verified_units(&mut self, cgroup: &str, exe: &Path) -> (Vec<String>, Vec<String>, bool) {
        let mut services = Vec::new();
        let mut scopes = Vec::new();
        let mut pending = false;
        for unit in cgroup
            .lines()
            .flat_map(|s| s.split('/'))
            .filter(|s| s.starts_with("app-") && (s.ends_with(".service") || s.ends_with(".scope")))
        {
            let recorded = self.known_units.get(unit).is_some_and(|p| {
                Path::new(p) == exe || std::fs::canonicalize(p).is_ok_and(|p| p == exe)
            });
            let main = if recorded {
                true
            } else {
                if !self.main_pids.contains_key(unit) && self.query_budget > 0 {
                    self.query_budget -= 1;
                    let pid = if unit.ends_with(".scope") {
                        // Launch scopes conventionally end in their leader PID. Verify the
                        // actual kernel executable instead of trusting the unit's app name.
                        unit.strip_suffix(".scope")
                            .and_then(|s| s.rsplit_once('-'))
                            .and_then(|(_, pid)| pid.parse::<u32>().ok())
                            .filter(|pid| {
                                read(self.proc.join(pid.to_string()).join("cgroup")).is_some_and(
                                    |s| {
                                        s.lines()
                                            .flat_map(|s| s.split('/'))
                                            .any(|part| part == unit)
                                    },
                                )
                            })
                    } else {
                        tokio::runtime::Handle::try_current()
                            .ok()
                            .and_then(|rt| rt.block_on(main_pid(unit)))
                    };
                    self.main_pids.insert(unit.into(), pid);
                }
                if !self.main_pids.contains_key(unit) {
                    pending = true;
                }
                self.main_pids
                    .get(unit)
                    .copied()
                    .flatten()
                    .and_then(|pid| {
                        std::fs::read_link(self.proc.join(pid.to_string()).join("exe")).ok()
                    })
                    .is_some_and(|p| p == exe)
            };
            if main {
                let (a, b, _) = unit_ids(unit);
                services.extend(a);
                scopes.extend(b);
            }
        }
        (services, scopes, pending)
    }
    fn descendant_units(&mut self, pid: u32, exe: &Path, evidence: &mut Evidence) {
        let mut pending = vec![pid];
        let mut seen = BTreeSet::new();
        while let Some(pid) = pending.pop() {
            if !seen.insert(pid) {
                continue;
            }
            if seen.len() > 256 {
                break;
            }
            let dir = self.proc.join(pid.to_string());
            if let Some(children) = read(dir.join(format!("task/{pid}/children"))) {
                for child in children
                    .split_whitespace()
                    .filter_map(|s| s.parse::<u32>().ok())
                    .take(256)
                {
                    let child_dir = self.proc.join(child.to_string());
                    if read(child_dir.join("stat")).and_then(|s| parent(&s)) != Some(pid) {
                        continue;
                    }
                    let (units, _, incomplete) = self
                        .verified_units(&read(child_dir.join("cgroup")).unwrap_or_default(), exe);
                    evidence.units.extend(units);
                    evidence.pending |= incomplete;
                    pending.push(child);
                }
            }
        }
    }
}

async fn main_pid(unit: &str) -> Option<u32> {
    tokio::time::timeout(std::time::Duration::from_millis(200), async {
        let conn = zbus::Connection::session().await.ok()?;
        let manager = zbus::Proxy::new(
            &conn,
            "org.freedesktop.systemd1",
            "/org/freedesktop/systemd1",
            "org.freedesktop.systemd1.Manager",
        )
        .await
        .ok()?;
        let path: zbus::zvariant::OwnedObjectPath = manager.call("GetUnit", &(unit,)).await.ok()?;
        let service = zbus::Proxy::new(
            &conn,
            "org.freedesktop.systemd1",
            path,
            "org.freedesktop.systemd1.Service",
        )
        .await
        .ok()?;
        service
            .get_property::<u32>("MainPID")
            .await
            .ok()
            .filter(|pid| *pid > 1)
    })
    .await
    .ok()
    .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (PathBuf, Collector) {
        let base = std::env::var_os("NIDARA_IDENTITY_EVIDENCE")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("target/identity-fixtures")
            });
        let root = base.join(format!(
            "identity-fixture-{}-{}",
            std::process::id(),
            super::super::unique()
        ));
        std::fs::create_dir_all(root.join("db")).unwrap();
        let collector = Collector::new(root.join("proc"), root.join("db"), root.clone());
        (root, collector)
    }
    fn put(root: &Path, file: &str, text: &str) {
        let path = root.join(file);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
    }
    fn process(root: &Path, pid: u32, ppid: u32, exe: &str, cgroup: &str) {
        put(
            root,
            &format!("proc/{pid}/stat"),
            &format!("{pid} (app with ) name) S {ppid} 0 0"),
        );
        put(root, &format!("proc/{pid}/cgroup"), cgroup);
        std::os::unix::fs::symlink(exe, root.join(format!("proc/{pid}/exe"))).unwrap();
    }
    fn window(pid: u32) -> BTreeMap<u64, Window> {
        [(
            1,
            Window {
                id: 1,
                pid: Some(pid),
                ..Default::default()
            },
        )]
        .into()
    }
    #[test]
    fn late_evidence_cannot_retarget_a_changed_closed_or_reconnected_window() {
        let captured = window(20);
        let evidence = [(
            1,
            Evidence {
                units: vec!["app".into()],
                ..Default::default()
            },
        )]
        .into();
        let mut model = super::super::observation::Model::default();
        model.epoch = "e".into();
        model.windows = captured.clone();
        model.windows.get_mut(&1).unwrap().pid = Some(21);
        apply_evidence(&mut model, "e", &captured, evidence);
        assert!(!model.windows[&1].evidence_ready);
        model.windows = captured.clone();
        model.epoch = "new".into();
        apply_evidence(
            &mut model,
            "e",
            &captured,
            [(1, Evidence::default())].into(),
        );
        assert!(!model.windows[&1].evidence_ready);
        model.windows.clear();
        model.epoch = "e".into();
        apply_evidence(
            &mut model,
            "e",
            &captured,
            [(1, Evidence::default())].into(),
        );
        assert!(model.windows.is_empty());
        model.windows = captured.clone();
        apply_evidence(
            &mut model,
            "e",
            &captured,
            [(1, Evidence::default())].into(),
        );
        assert!(model.windows[&1].evidence_ready);
    }
    #[test]
    fn bounded_unit_queries_continue_queued_work_without_losing_the_last_window() {
        let (r, mut c) = fixture();
        let group = (0..13)
            .map(|n| format!("app-unknown{n}@launch.service"))
            .collect::<Vec<_>>()
            .join("/");
        process(&r, 80, 1, "/manual/app", &format!("0::/{group}"));
        assert!(c.collect("e", 1, &window(80))[&1].pending);
        assert!(!c.cache.contains_key(&1));
        assert!(!c.collect("e", 1, &window(80))[&1].pending);
        assert!(c.cache.contains_key(&1));
    }
    #[test]
    fn an_app_launched_from_a_dock_terminal_never_inherits_the_terminal_identity() {
        let (r, mut c) = fixture();
        put(
            &r,
            "db/terminal-1/files",
            "%FILES%\nusr/bin/terminal\nusr/share/applications/terminal.desktop\n",
        );
        put(
            &r,
            "usr/share/applications/terminal.desktop",
            "[Desktop Entry]\nExec=terminal\n",
        );
        process(
            &r,
            70,
            1,
            "/usr/bin/terminal",
            "0::/app-terminal@launch-7.service",
        );
        process(
            &r,
            71,
            70,
            "/home/user/manual-app",
            "0::/app-terminal@launch-7.service",
        );
        c.known_units.insert(
            "app-terminal@launch-7.service".into(),
            "/usr/bin/terminal".into(),
        );
        c.main_pids
            .insert("app-terminal@launch-7.service".into(), Some(70));
        assert_eq!(c.collect("e", 1, &window(71))[&1], Evidence::default());
        let terminal = c.collect("e", 1, &window(70));
        assert_eq!(
            terminal[&1].packages,
            vec!["/usr/share/applications/terminal.desktop"]
        );
        assert!(terminal[&1].units.contains(&"terminal".into()));
    }
    #[test]
    fn actual_package_ownership_not_exec_names_and_browser_exclusion() {
        let (r, mut c) = fixture();
        put(
            &r,
            "db/chatgpt-bin-1/files",
            "%FILES%\nusr/lib/chatgpt/ChatGPT\nusr/share/applications/chatgpt.desktop\n",
        );
        put(
            &r,
            "usr/share/applications/chatgpt.desktop",
            "[Desktop Entry]\nExec=codex-launcher\n",
        );
        put(
            &r,
            "db/chromium-1/files",
            "%FILES%\nopt/chromium/chrome\nusr/share/applications/chromium.desktop\nusr/share/applications/browser-alt.desktop\n",
        );
        put(
            &r,
            "usr/share/applications/chromium.desktop",
            "[Desktop Entry]\nMimeType=text/html;x-scheme-handler/http;\n",
        );
        put(
            &r,
            "usr/share/applications/browser-alt.desktop",
            "[Desktop Entry]\nExec=chrome\n",
        );
        process(&r, 10, 1, "/usr/lib/chatgpt/ChatGPT", "");
        let evidence = c.collect("e", 1, &window(10));
        assert_eq!(
            evidence[&1].packages,
            vec!["/usr/share/applications/chatgpt.desktop"]
        );
        process(&r, 11, 1, "/opt/chromium/chrome", "");
        assert!(c.collect("e", 1, &window(11))[&1].packages.is_empty());
        process(&r, 12, 1, "/unowned/chatgpt", "");
        assert!(c.collect("e", 1, &window(12))[&1].packages.is_empty());
    }
    #[test]
    fn proc_sandbox_unit_and_migrated_main_pid_use_kernel_tree_not_inherited_markers() {
        let (r, mut c) = fixture();
        process(
            &r,
            20,
            1,
            "/hand/claude",
            "0::/user.slice/app-org.chromium.Chromium-20.scope",
        );
        process(
            &r,
            21,
            20,
            "/hand/claude",
            "0::/app-claude@launch-123.service",
        );
        put(&r, "proc/20/task/20/children", "21 99");
        put(
            &r,
            "proc/20/environ",
            "NIDARA_DESKTOP_ID=wrong.desktop\0GIO_LAUNCHED_DESKTOP_FILE=/wrong.desktop\0",
        );
        c.main_pids
            .insert("app-claude@launch-123.service".into(), Some(21));
        let e = c.collect("e", 1, &window(20));
        assert!(e[&1].units.contains(&"claude".into()));
        assert!(e[&1].flatpak.is_empty());
        assert!(e[&1].packages.is_empty());
        process(&r, 30, 1, "/app/bin/flat", "");
        put(
            &r,
            "proc/30/root/.flatpak-info",
            "[Instance]\nname=wrong\n[Application]\nname=org.flat.App\n",
        );
        assert_eq!(
            c.collect("e", 1, &window(30))[&1].flatpak,
            vec!["org.flat.App"]
        );
        let (unit, scope, snap) = unit_ids(
            "0::/app-Nidara-org.telegram.desktop@launch-42.service/snap.editor.main.scope/app-gnome-org.foo.App-123.scope",
        );
        assert!(unit.contains(&"org.telegram.desktop".into()));
        assert!(scope.contains(&"org.foo.App".into()));
        assert_eq!(snap, vec!["editor"]);
    }
    #[test]
    fn unchanged_windows_are_cached_but_database_changes_and_epochs_invalidate() {
        let (r, mut c) = fixture();
        process(&r, 40, 1, "/usr/bin/app", "");
        let ws = window(40);
        assert!(c.collect("e", 1, &ws)[&1].packages.is_empty());
        put(
            &r,
            "db/app-1/files",
            "%FILES%\nusr/bin/app\nusr/share/applications/app.desktop\n",
        );
        put(
            &r,
            "usr/share/applications/app.desktop",
            "[Desktop Entry]\nExec=app\n",
        );
        assert!(c.collect("e", 1, &ws)[&1].packages.is_empty());
        assert_eq!(
            c.collect("e", 2, &ws)[&1].packages,
            vec!["/usr/share/applications/app.desktop"]
        );
        put(
            &r,
            "proc/40/root/.flatpak-info",
            "[Application]\nname=changed\n",
        );
        assert!(c.collect("e", 2, &ws)[&1].flatpak.is_empty());
        assert_eq!(c.collect("new", 2, &ws)[&1].flatpak, vec!["changed"]);
        c.collect("new", 2, &BTreeMap::new());
        assert!(c.cache.is_empty());
    }
    #[test]
    fn session_managers_are_boundaries_and_parent_cycles_are_bounded() {
        let (r, mut c) = fixture();
        process(&r, 50, 51, "/hand/app", "");
        process(
            &r,
            51,
            1,
            "/usr/lib/systemd/systemd",
            "0::/app-wrong@launch.service",
        );
        put(
            &r,
            "proc/51/root/.flatpak-info",
            "[Application]\nname=wrong\n",
        );
        let e = c.collect("e", 1, &window(50));
        assert!(e[&1].flatpak.is_empty());
        assert!(e[&1].units.is_empty());
        process(&r, 60, 61, "/hand/a", "");
        process(&r, 61, 60, "/hand/b", "");
        assert!(c.collect("e", 1, &window(60))[&1].units.is_empty());
    }
}
