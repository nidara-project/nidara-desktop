// SPDX-License-Identifier: GPL-3.0-or-later
//! Only XDG preference files. The existing session runner is the sole executor.
use super::{
    Error,
    catalogue::{self, App},
    desktop::Desktop,
};
use serde_json::{Value, json};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
const G: &str = "Desktop Entry";
pub fn config_home() -> PathBuf {
    std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| catalogue::home().join(".config"))
}
pub fn roots() -> Vec<PathBuf> {
    std::iter::once(config_home())
        .chain(
            std::env::var("XDG_CONFIG_DIRS")
                .ok()
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "/etc/xdg".into())
                .split(':')
                .filter(|p| p.starts_with('/'))
                .map(PathBuf::from)
                .collect::<Vec<_>>(),
        )
        .map(|p| p.join("autostart"))
        .collect()
}
struct Entry {
    path: PathBuf,
    text: String,
    exec_hash: String,
    marker: String,
    hidden: bool,
    applies: bool,
}
pub struct Index {
    entries: BTreeMap<String, Entry>,
    pub complete: bool,
}
fn load(path: &Path) -> Result<Entry, Error> {
    let text = String::from_utf8(catalogue::bounded(path, 256 * 1024).map_err(Error::Failed)?)
        .map_err(|_| Error::Invalid("autostart encoding".into()))?;
    let k = glib::KeyFile::new();
    k.load_from_data(
        &text,
        glib::KeyFileFlags::KEEP_COMMENTS | glib::KeyFileFlags::KEEP_TRANSLATIONS,
    )
    .map_err(|_| Error::Invalid("autostart syntax".into()))?;
    let desktops = std::env::var("XDG_CURRENT_DESKTOP")
        .unwrap_or_default()
        .split(':')
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let only = catalogue::strv(&k, G, "OnlyShowIn");
    let not = catalogue::strv(&k, G, "NotShowIn");
    let applies = !k.boolean(G, "X-systemd-skip").unwrap_or(false)
        && k.boolean(G, "X-GNOME-Autostart-enabled").unwrap_or(true)
        && (k
            .string(G, "TryExec")
            .ok()
            .is_none_or(|p| p.is_empty() || glib::find_program_in_path(&p).is_some()))
        && (only.is_empty() || only.iter().any(|d| desktops.contains(d)))
        && !not.iter().any(|d| desktops.contains(d));
    Ok(Entry {
        path: path.into(),
        exec_hash: catalogue::hash(k.string(G, "Exec").unwrap_or_default().as_bytes()),
        marker: k
            .string(G, "X-Nidara-DesktopId")
            .unwrap_or_default()
            .to_string(),
        hidden: k.boolean(G, "Hidden").unwrap_or(false),
        applies,
        text,
    })
}
impl Index {
    pub fn scan() -> Self {
        let mut s = Self {
            entries: BTreeMap::new(),
            complete: true,
        };
        let mut bytes = 0;
        for dir in roots() {
            let iter = match fs::read_dir(dir) {
                Ok(i) => i,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => {
                    s.complete = false;
                    continue;
                }
            };
            for p in iter {
                let Ok(p) = p else {
                    s.complete = false;
                    continue;
                };
                let p = p.path();
                if p.extension().is_none_or(|s| s != "desktop") {
                    continue;
                }
                let Some(id) = p.file_name().and_then(|s| s.to_str()).map(str::to_owned) else {
                    s.complete = false;
                    continue;
                };
                if s.entries.contains_key(&id) {
                    continue;
                }
                if s.entries.len() >= 512 {
                    s.complete = false;
                    break;
                }
                match load(&p) {
                    Ok(e) => {
                        bytes += e.text.len();
                        if bytes > 4 * 1024 * 1024 {
                            s.complete = false;
                            break;
                        }
                        s.entries.insert(id, e);
                    }
                    Err(_) => s.complete = false,
                }
            }
        }
        s
    }
    fn reason(&self, app: &App) -> Option<&'static str> {
        if !self.complete {
            return Some("autostart index incomplete");
        }
        if app.record["EntryAvailable"] != true {
            return Some("application entry is unavailable");
        }
        if app.record["DBusActivatable"] == true
            || app.record["Terminal"] == true
            || matches!(app.record["Origin"].as_str(), Some("flatpak" | "snap"))
        {
            return Some(
                "session-start activation/terminal/portal fixture not established for this app",
            );
        }
        if app.id.len() > 255 {
            return Some("autostart filename exceeds filesystem bound");
        }
        if let Some(e) = self.entries.get(&app.id) {
            if e.path == config_home().join("autostart").join(&app.id)
                && let Ok(m) = fs::symlink_metadata(&e.path)
            {
                if m.file_type().is_symlink() {
                    return Some("autostart file is a symlink");
                }
                if m.uid() != unsafe { libc::geteuid() } || m.permissions().mode() & 0o222 == 0 {
                    return Some("autostart file is read-only or owned by another user");
                }
            }
            if !belongs(e, app) {
                return Some("autostart basename belongs to a different app");
            }
        }
        if self.entries.iter().any(|(id, e)| {
            id != &app.id
                && (e.marker == app.id || (e.marker.is_empty() && e.exec_hash == app.exec_hash))
        }) {
            return Some("app already has a differently named autostart entry");
        }
        None
    }
    pub fn state(&self, app: &App) -> Value {
        let e = self.entries.get(&app.id);
        let reason = self.reason(app).unwrap_or("");
        let preference = e.is_some_and(|e| !e.hidden);
        let applies = e.is_none_or(|e| e.applies);
        json!({"Available":reason.is_empty(),"Writable":reason.is_empty(),"Enabled":preference&&applies,"PreferenceEnabled":preference,"AppliesToDesktop":applies,"Reason":reason,"Started":false})
    }
}
fn belongs(e: &Entry, app: &App) -> bool {
    e.exec_hash == app.exec_hash && (e.marker.is_empty() || e.marker == app.id)
}
fn safe_parent(path: &Path) -> Result<(), Error> {
    let base = config_home();
    if !base.is_absolute() {
        return Err(Error::AccessDenied("config home must be absolute".into()));
    }
    for p in path.ancestors() {
        if fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::AccessDenied("autostart parent is symlink".into()));
        }
    }
    Ok(())
}
pub fn set(app: &App, enabled: bool) -> Result<Value, Error> {
    let index = Index::scan();
    if let Some(reason) = index.reason(app) {
        return Err(
            if reason.contains("different") || reason.contains("belongs") {
                Error::Conflict(reason.into())
            } else if reason.contains("read-only") || reason.contains("symlink") {
                Error::AccessDenied(reason.into())
            } else {
                Error::Unavailable(reason.into())
            },
        );
    }
    let desktop = Desktop::load(app)?;
    let dir = config_home().join("autostart");
    safe_parent(&dir)?;
    fs::create_dir_all(&dir)
        .map_err(|_| Error::AccessDenied("cannot create autostart directory".into()))?;
    safe_parent(&dir)?;
    let path = dir.join(&app.id);
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(Error::AccessDenied(
            "autostart destination is symlink".into(),
        ));
    }
    let key = if let Some(e) = index.entries.get(&app.id) {
        // Preserve every unknown/localized key from the effective matching entry.
        if e.path == path {
            let current = load(&path)?;
            if current.text != e.text {
                return Err(Error::Conflict("autostart changed during edit".into()));
            }
        }
        let k = glib::KeyFile::new();
        k.load_from_data(
            &e.text,
            glib::KeyFileFlags::KEEP_COMMENTS | glib::KeyFileFlags::KEEP_TRANSLATIONS,
        )
        .map_err(|_| Error::Invalid("autostart syntax".into()))?;
        k
    } else {
        desktop.key
    };
    key.set_boolean(G, "Hidden", !enabled);
    if enabled {
        // Older tools disabled user copies with this key. Restore it too so
        // our effective state and compatible runners honor the enable request.
        key.set_boolean(G, "X-GNOME-Autostart-enabled", true);
    }
    key.set_string(G, "X-Nidara-DesktopId", &app.id);
    let data = key.to_data();
    if data.len() > 256 * 1024 {
        return Err(Error::Invalid("autostart file budget".into()));
    }
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let temp = dir.join(format!(".nidara-autostart-{}", super::unique()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&temp)
        .map_err(|_| Error::AccessDenied("cannot create autostart file".into()))?;
    let result = (|| {
        file.write_all(data.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temp, &path)?;
        fs::File::open(&dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp);
        return Err(Error::Failed("atomic autostart write failed".into()));
    }
    let confirmed = Index::scan();
    let state = confirmed.state(app);
    if state["PreferenceEnabled"] != enabled {
        return Err(Error::Failed("autostart readback differs".into()));
    }
    Ok(state)
}
