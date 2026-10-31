// SPDX-License-Identifier: GPL-3.0-or-later
use gio::prelude::*;
use glib::translate::{ToGlibPtr, from_glib_full};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
};

// gio 0.22 split the Unix wrappers into a separate crate. This libgio
// symbols provide its actual desktop parser without pulling GTK into sessiond.
unsafe extern "C" {
    fn g_desktop_app_info_new_from_keyfile(
        keyfile: *mut glib::ffi::GKeyFile,
    ) -> *mut gio::ffi::GAppInfo;
}
#[derive(Clone, Debug, PartialEq)]
pub struct App {
    pub id: String,
    pub generation: u64,
    pub digest: String,
    pub source_hash: String,
    pub exec_hash: String,
    pub record: Value,
    pub executable: String,
    pub keywords: Vec<String>,
    pub icon: String,
}
impl App {
    pub fn name(&self) -> &str {
        self.record["Name"].as_str().unwrap_or(&self.id)
    }
    pub fn visible(&self) -> bool {
        self.record["Visible"] == true
    }
}
#[derive(Default)]
pub struct Scan {
    pub apps: BTreeMap<String, App>,
    pub diagnostics: Vec<String>,
    pub healthy: bool,
    pub watches: BTreeSet<PathBuf>,
    metadata_bytes: usize,
    inspected: usize,
}
pub fn data_home() -> PathBuf {
    std::env::var_os("XDG_DATA_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/share"))
}
pub fn home() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/nonexistent"))
}
pub fn data_dirs() -> Vec<PathBuf> {
    let dirs=std::env::var("XDG_DATA_DIRS").ok().filter(|s|!s.is_empty()).unwrap_or_else(||format!("/usr/local/share:/usr/share:{}/flatpak/exports/share:/var/lib/flatpak/exports/share:/var/lib/snapd/desktop",data_home().display()));
    let mut seen = BTreeSet::new();
    std::iter::once(data_home())
        .chain(
            dirs.split(':')
                .filter(|p| p.starts_with('/'))
                .map(PathBuf::from),
        )
        .filter(|p| seen.insert(p.clone()))
        .collect()
}
pub fn roots() -> Vec<PathBuf> {
    let explicit = std::env::var_os("XDG_DATA_DIRS").is_some_and(|s| !s.is_empty());
    let history = root_history();
    data_dirs()
        .iter()
        .map(|p| p.join("applications"))
        .filter(|p| {
            explicit
                || (!p.to_string_lossy().contains("flatpak")
                    && !p.to_string_lossy().contains("snapd"))
                || p.is_dir()
                || history.contains_key(p)
        })
        .collect()
}
pub fn bounded(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("not a regular file".into());
    }
    let mut out = vec![];
    file.take(max + 1)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    if out.len() as u64 > max {
        return Err("file exceeds size limit".into());
    }
    Ok(out)
}
pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn strv(k: &glib::KeyFile, group: &str, key: &str) -> Vec<String> {
    k.string_list(group, key)
        .map(|v| v.iter().map(|s| s.to_string()).collect())
        .unwrap_or_default()
}
fn s(k: &glib::KeyFile, g: &str, key: &str) -> String {
    k.string(g, key).map(|s| s.to_string()).unwrap_or_default()
}
pub fn scan(roots: &[PathBuf], ever_present: &mut BTreeMap<PathBuf, String>) -> Scan {
    let mut result = Scan {
        healthy: true,
        ..Scan::default()
    };
    let mut seen = BTreeSet::new();
    if roots.len() > 64 {
        result.healthy = false;
        result.diagnostics.push("catalogue root limit".into());
    }
    for root in roots.iter().take(64) {
        if root.is_dir() {
            let key = mount_key(root);
            if ever_present.get(root).is_some_and(|old| *old != key) {
                result.healthy = false;
                result
                    .diagnostics
                    .push(format!("root mount changed/unmounted: {}", root.display()));
            } else {
                ever_present.insert(root.clone(), key);
            }
        } else if ever_present.contains_key(root) || root.try_exists().unwrap_or(true) {
            result.healthy = false;
            result
                .diagnostics
                .push(format!("catalogue root unavailable: {}", root.display()));
        }
        let mut ancestor = root.clone();
        while !ancestor.is_dir() {
            if !ancestor.pop() {
                break;
            }
        }
        result.watches.insert(ancestor);
        walk(root, root, 0, &mut seen, &mut result);
    }
    result
}
fn walk(root: &Path, dir: &Path, depth: usize, seen: &mut BTreeSet<String>, out: &mut Scan) {
    if depth > 16 || out.watches.len() > 4096 {
        out.healthy = false;
        out.diagnostics.push("desktop directory depth limit".into());
        return;
    }
    let files = match fs::read_dir(dir) {
        Ok(v) => v,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound && dir == root => return,
        Err(e) => {
            out.healthy = false;
            out.diagnostics.push(format!("{}: {e}", dir.display()));
            return;
        }
    };
    out.watches.insert(dir.into());
    let mut paths = vec![];
    for f in files {
        out.inspected += 1;
        if out.inspected > 65536 {
            out.healthy = false;
            if out.diagnostics.len() < 256 {
                out.diagnostics
                    .push("catalogue directory-entry budget".into());
            }
            break;
        }
        match f {
            Ok(f) => paths.push(f.path()),
            Err(e) => {
                out.healthy = false;
                out.diagnostics.push(e.to_string());
            }
        }
    }
    paths.sort();
    for path in paths {
        if fs::symlink_metadata(&path).is_ok_and(|m| m.is_dir()) {
            walk(root, &path, depth + 1, seen, out);
            continue;
        }
        if path.extension().is_none_or(|x| x != "desktop") {
            continue;
        }
        let Some(id) = path
            .strip_prefix(root)
            .ok()
            .and_then(|p| p.to_str())
            .map(|s| s.to_string())
        else {
            out.healthy = false;
            continue;
        };
        let id = id.replace('/', "-");
        if !seen.insert(id.clone()) {
            continue;
        }
        if seen.len() > 16384 {
            out.healthy = false;
            out.diagnostics.push("catalogue admission limit".into());
            return;
        }
        if id.len() > 1024 {
            out.healthy = false;
            out.diagnostics.push("desktop ID exceeds bound".into());
            continue;
        }
        match parse(&path, &id) {
            Ok(Some(app)) => {
                let bytes = app.record.to_string().len();
                if out.metadata_bytes + bytes > 32 * 1024 * 1024 {
                    out.healthy = false;
                    if out.diagnostics.len() < 256 {
                        out.diagnostics.push("catalogue metadata budget".into());
                    }
                    return;
                }
                out.metadata_bytes += bytes;
                out.apps.insert(id, app);
            }
            Ok(None) => {}
            Err(e) => {
                out.healthy = false;
                if out.diagnostics.len() < 256 {
                    out.diagnostics.push(format!("{}: {e}", path.display()));
                }
            }
        }
    }
}
fn parse(path: &Path, id: &str) -> Result<Option<App>, String> {
    let bytes = bounded(path, 256 * 1024)?;
    let text = std::str::from_utf8(&bytes).map_err(|e| e.to_string())?;
    let k = glib::KeyFile::new();
    k.load_from_data(text, glib::KeyFileFlags::NONE)
        .map_err(|e| e.to_string())?;
    let g = "Desktop Entry";
    if k.boolean(g, "Hidden").unwrap_or(false) {
        return Ok(None);
    }
    if s(&k, g, "Type") != "Application" {
        return Ok(None);
    }
    let try_exec = s(&k, g, "TryExec");
    let entry_available = try_exec.is_empty() || glib::find_program_in_path(&try_exec).is_some();
    if !entry_available {
        let _ = k.remove_key(g, "TryExec");
    }
    let dbus = k.boolean(g, "DBusActivatable").unwrap_or(false);
    let raw_exec = s(&k, g, "Exec");
    // GIO refuses an entry whose Exec program is not installed, as it does a missing
    // TryExec. That is an entry read successfully and found unavailable, never a failed
    // scan: one such file (another package's panel for a tool that is not installed)
    // must not keep the whole catalogue unhealthy and block every prune.
    let exec_missing = !raw_exec.trim().is_empty()
        && !glib::shell_parse_argv(&raw_exec)
            .ok()
            .and_then(|argv| argv.into_iter().next())
            .is_some_and(|program| glib::find_program_in_path(program).is_some());
    let unavailable_reason = if !entry_available {
        "TryExec is unavailable"
    } else if !dbus && raw_exec.trim().is_empty() {
        "no Exec or D-Bus activation"
    } else if exec_missing {
        "Exec program is unavailable"
    } else {
        ""
    };
    let entry_available = unavailable_reason.is_empty();
    // GIO's from_keyfile lacks the filename needed for a D-Bus-only app id, and refuses
    // a missing Exec program. A synthetic Exec is ONLY for metadata parsing; never a
    // launch fallback (the entry is then not Launchable).
    if (dbus && raw_exec.is_empty()) || exec_missing {
        k.set_string(g, "Exec", "/usr/bin/true");
    }
    let ptr = unsafe { g_desktop_app_info_new_from_keyfile(k.to_glib_none().0) };
    if ptr.is_null() {
        return Err("GIO rejected desktop entry (Exec/TryExec/required fields)".into());
    }
    let app: gio::AppInfo = unsafe { from_glib_full(ptr) };
    let name = app.display_name().to_string();
    let comment = app.description().map(|s| s.to_string()).unwrap_or_default();
    let keywords = k
        .locale_string_list(g, "Keywords", None)
        .map(|v| v.iter().map(|s| s.to_string()).collect::<Vec<_>>())
        .unwrap_or_default();
    if name.len() > 1024 || comment.len() + keywords.iter().map(String::len).sum::<usize>() > 8192 {
        return Err("desktop field budget".into());
    }
    let actions = strv(&k, g, "Actions");
    if actions.len() > 64 {
        return Err("desktop action limit".into());
    }
    let actions:Vec<_>=actions.into_iter().map(|id|{let g=format!("Desktop Action {id}");json!({"Id":id,"Name":k.locale_string(&g,"Name",None).unwrap_or_default().to_string(),"Icon":s(&k,&g,"Icon")})}).collect();
    let fp = s(&k, g, "X-Flatpak");
    let snap = Path::new("/var/lib/snapd/desktop");
    let origin = if !fp.is_empty() {
        "flatpak"
    } else if path.starts_with(snap) {
        "snap"
    } else if path.starts_with(data_home()) {
        "user"
    } else {
        "system"
    };
    let icon = s(&k, g, "Icon");
    let dbus = k.boolean(g, "DBusActivatable").unwrap_or(false);
    let single = k.boolean(g, "SingleMainWindow").unwrap_or(false);
    // GIO accepts Exec-less entries, but gio-rs' non-optional executable()
    // dereferences NULL for them. Keep the nullable C contract at this seam.
    let executable_ptr = unsafe { gio::ffi::g_app_info_get_executable(app.to_glib_none().0) };
    let exec: Option<PathBuf> = if raw_exec.is_empty() || executable_ptr.is_null() {
        None
    } else {
        Some(unsafe { glib::translate::from_glib_none(executable_ptr) })
    };
    let executable = exec
        .as_ref()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let new_action = actions.iter().any(|a| {
        a["Id"]
            .as_str()
            .is_some_and(|s| s.eq_ignore_ascii_case("new-window") || s == "NewWindow")
    });
    let new_window = if single || !entry_available {
        "unsupported"
    } else if new_action {
        "declared-action"
    } else if dbus {
        "unsupported"
    } else {
        "relaunch"
    };
    let record = json!({"DesktopId":id,"Name":name,"GenericName":k.locale_string(g,"GenericName",None).unwrap_or_default().to_string(),"Comment":comment,"Keywords":keywords,"Visible":entry_available&&app.should_show(),"EntryAvailable":entry_available,"Launchable":entry_available,"UnavailableReason":unavailable_reason,"Origin":origin,"OriginId":fp,"DesktopPath":path.to_string_lossy(),"DBusActivatable":dbus,"StartupWMClass":s(&k,g,"StartupWMClass"),"Terminal":k.boolean(g,"Terminal").unwrap_or(false),"SingleMainWindow":single,"SupportsOpen":app.supports_files()||app.supports_uris()||(dbus&&!strv(&k,g,"MimeType").is_empty()),"NewWindowMode":new_window,"Actions":actions,"RawIcon":icon,"IconRef":{"Kind":"desktop","Value":icon},"ForegroundScore":0.0,"NewlyObservedAt":0.0,"IsNew":false,"Autostart":{"Available":false,"Reason":"Application autostart is A2"}});
    if record.to_string().len() > 32768 {
        return Err("desktop record budget".into());
    }
    let digest = hash(format!("{text}{}", record).as_bytes());
    Ok(Some(App {
        id: id.into(),
        generation: 0,
        digest,
        source_hash: hash(&bytes),
        exec_hash: hash(raw_exec.as_bytes()),
        record,
        executable,
        keywords,
        icon,
    }))
}

pub fn mount_key(root: &Path) -> String {
    let text = fs::read_to_string("/proc/self/mountinfo").unwrap_or_default();
    let mut best = (0, String::new());
    for line in text.lines() {
        let fields: Vec<_> = line.split_whitespace().collect();
        if fields.len() < 10 {
            continue;
        }
        let mount = fields[4]
            .replace("\\040", " ")
            .replace("\\011", "\t")
            .replace("\\134", "\\");
        if root.starts_with(&mount) && mount.len() >= best.0 {
            let source = fields
                .iter()
                .position(|s| *s == "-")
                .and_then(|i| fields.get(i + 2))
                .unwrap_or(&"");
            best = (mount.len(), format!("{}:{}:{}", fields[2], mount, source));
        }
    }
    best.1
}
pub fn root_history_path() -> PathBuf {
    std::env::var_os("XDG_STATE_HOME")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/state"))
        .join("nidara/applications-roots-v1.json")
}
pub fn root_history() -> BTreeMap<PathBuf, String> {
    bounded(&root_history_path(), 64 * 1024)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
pub fn root_history_valid() -> bool {
    let p = root_history_path();
    match fs::symlink_metadata(&p) {
        Ok(m) if m.is_file() && !m.file_type().is_symlink() => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return true,
        _ => return false,
    }
    bounded(&p, 64 * 1024)
        .ok()
        .and_then(|b| serde_json::from_slice::<BTreeMap<PathBuf, String>>(&b).ok())
        .is_some_and(|h| h.len() <= 256 && h.keys().all(|p| p.is_absolute()))
}

pub fn save_root_history(history: &BTreeMap<PathBuf, String>) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let path = root_history_path();
    let parent = path.parent().unwrap();
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if parent
        .ancestors()
        .take(2)
        .any(|p| fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()))
    {
        return Err("root history directory symlink".into());
    }
    let bytes = serde_json::to_vec(history).map_err(|e| e.to_string())?;
    if bytes.len() > 64 * 1024 {
        return Err("root history budget".into());
    }
    let temp = parent.join(format!(".roots-{}-{}", std::process::id(), super::unique()));
    let mut f = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temp)
        .map_err(|e| e.to_string())?;
    let result = (|| -> Result<(), std::io::Error> {
        f.write_all(&bytes)?;
        f.sync_all()?;
        fs::rename(&temp, &path)?;
        fs::File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn real_roots_and_mount_loss_never_look_like_uninstall() {
        let dir = std::env::current_dir()
            .unwrap()
            .join(format!("target/a1-root-{}", super::super::unique()));
        fs::create_dir_all(&dir).unwrap();
        let root = dir.join("applications");
        fs::create_dir(&root).unwrap();
        let mut history = BTreeMap::new();
        assert!(scan(std::slice::from_ref(&root), &mut history).healthy);
        assert!(!history[&root].is_empty());
        let renamed = dir.join("offline");
        fs::rename(&root, &renamed).unwrap();
        assert!(!scan(std::slice::from_ref(&root), &mut history).healthy);
        fs::rename(&renamed, &root).unwrap();
        assert!(scan(std::slice::from_ref(&root), &mut history).healthy);
        history.insert(root.clone(), "previous-mounted-export".into());
        assert!(!scan(std::slice::from_ref(&root), &mut history).healthy);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn an_entry_whose_program_is_not_installed_keeps_the_catalogue_healthy() {
        let dir = std::env::current_dir()
            .unwrap()
            .join(format!("target/a1-exec-{}", super::super::unique()));
        let root = dir.join("applications");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("absent-panel.desktop"),
            "[Desktop Entry]\nType=Application\nName=Panel\nNoDisplay=true\n\
             Exec=nidara-no-such-program-anywhere panel\n",
        )
        .unwrap();
        let scan = scan(std::slice::from_ref(&root), &mut BTreeMap::new());
        assert!(scan.healthy, "{:?}", scan.diagnostics);
        let record = &scan.apps["absent-panel.desktop"].record;
        assert_eq!(record["Launchable"], json!(false));
        assert_eq!(
            record["UnavailableReason"],
            json!("Exec program is unavailable")
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
