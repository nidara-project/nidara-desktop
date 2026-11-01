// SPDX-License-Identifier: GPL-3.0-or-later
use super::{
    Error,
    catalogue::{App, home},
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};
const DEFAULT: &str = "default-handler:inode/directory";
pub fn canonical(token: &str) -> Result<String, Error> {
    if token.len() > 8192 {
        return Err(Error::Invalid("layout target length".into()));
    }
    if token == DEFAULT {
        return Ok(token.into());
    }
    if let Some(id) = token.strip_prefix("app:") {
        if id.is_empty()
            || id.len() > 1024
            || id.contains(['/', '\0', '\r', '\n'])
            || !id.ends_with(".desktop")
        {
            return Err(Error::Invalid("invalid desktop ID".into()));
        }
        return Ok(token.into());
    }
    if let Some(uri) = token.strip_prefix("folder:") {
        let (p, host) = glib::filename_from_uri(uri).map_err(|e| Error::Invalid(e.to_string()))?;
        if host.is_some_and(|h| h != "localhost") || !p.is_absolute() {
            return Err(Error::Invalid(
                "folder must be an absolute local file URI".into(),
            ));
        }
        return Ok(format!(
            "folder:{}",
            glib::filename_to_uri(p, None).map_err(|e| Error::Invalid(e.to_string()))?
        ));
    }
    Err(Error::Invalid("unknown layout target".into()))
}
pub fn migrate(old: &[String], apps: &BTreeMap<String, App>) -> Vec<String> {
    let mut result = vec![DEFAULT.to_string()];
    if apps.contains_key("org.nidara.Apps.desktop") {
        result.push("app:org.nidara.Apps.desktop".into());
    }
    for id in old {
        let id = id
            .strip_prefix("pinned-ghost-")
            .or_else(|| id.strip_prefix("pinned-"))
            .or_else(|| id.strip_prefix("running-"))
            .unwrap_or(id);
        if id.is_empty() || id.contains('/') {
            continue;
        }
        let id = resolve_legacy(id, apps);
        let t = format!("app:{id}");
        if canonical(&t).is_ok() && !result.contains(&t) && result.len() < 256 {
            result.push(t);
        }
    }
    result
}
/// The TS dock kept a pin as the desktop ID lowercased with every `.desktop` cut off
/// (`org.telegram` for `org.telegram.desktop.desktop`, `chrome-…-default` for
/// `chrome-…-Default.desktop`), so the catalogue entry it names is the one that reads the
/// same that way. An exact ID wins; with no entry, the ID as written (`prune` decides).
fn resolve_legacy(id: &str, apps: &BTreeMap<String, App>) -> String {
    let exact = if id.ends_with(".desktop") {
        id.to_string()
    } else {
        format!("{id}.desktop")
    };
    if apps.contains_key(&exact) {
        return exact;
    }
    let key = |s: &str| {
        let mut s = s.to_lowercase();
        while let Some(t) = s.strip_suffix(".desktop") {
            s = t.to_string();
        }
        s
    };
    let wanted = key(id);
    apps.keys()
        .find(|k| key(k) == wanted)
        .cloned()
        .unwrap_or(exact)
}
pub fn validate(raw: &[String]) -> Result<Vec<String>, Error> {
    if raw.len() > 256 || raw.iter().map(String::len).sum::<usize>() > 128 * 1024 {
        return Err(Error::Invalid("layout limit is 256".into()));
    }
    let mut seen = BTreeSet::new();
    raw.iter()
        .map(|s| {
            let s = canonical(s)?;
            if !seen.insert(s.clone()) {
                return Err(Error::Invalid("duplicate layout target".into()));
            }
            Ok(s)
        })
        .collect()
}
pub fn prune(layout: &mut Vec<String>, apps: &BTreeMap<String, App>, healthy: bool) {
    if healthy {
        layout.retain(|t| {
            t.strip_prefix("app:")
                .is_none_or(|id| apps.contains_key(id))
        });
    }
}
pub fn edit(
    old: &[String],
    edit: Value,
    apps: &BTreeMap<String, App>,
) -> Result<Vec<String>, Error> {
    let obj = edit
        .as_object()
        .ok_or_else(|| Error::Invalid("edit must be a record".into()))?;
    let op = obj
        .get("Operation")
        .and_then(Value::as_str)
        .ok_or_else(|| Error::Invalid("Operation is required".into()))?;
    let allowed: &[&str] = match op {
        "insert-app" => &["Operation", "DesktopId", "BeforeKey"],
        "insert-folder" => &["Operation", "Uri", "BeforeKey"],
        "move" => &["Operation", "Key", "BeforeKey"],
        "remove" => &["Operation", "Key"],
        _ => return Err(Error::Invalid("unknown layout edit".into())),
    };
    if obj
        .iter()
        .any(|(k, v)| !allowed.contains(&k.as_str()) || !v.is_string())
    {
        return Err(Error::Invalid("unknown key or wrong layout type".into()));
    }
    let get = |k: &str| {
        obj.get(k)
            .and_then(Value::as_str)
            .ok_or_else(|| Error::Invalid(format!("missing {k}")))
    };
    let key = match op {
        "insert-app" => {
            let id = get("DesktopId")?;
            if id == DEFAULT {
                DEFAULT.into()
            } else {
                if !apps.contains_key(id) {
                    return Err(Error::NotFound("app missing from catalogue".into()));
                }
                format!("app:{id}")
            }
        }
        "insert-folder" => {
            let uri = get("Uri")?;
            let (p, _) = glib::filename_from_uri(uri).map_err(|e| Error::Invalid(e.to_string()))?;
            if !p.is_dir() {
                return Err(Error::NotFound("directory does not exist".into()));
            }
            format!("folder:{uri}")
        }
        _ => get("Key")?.to_string(),
    };
    let key = canonical(&key)?;
    if (op == "move" || op == "remove") && !old.contains(&key) {
        return Err(Error::NotFound("layout key missing".into()));
    }
    if op.starts_with("insert") && old.contains(&key) {
        return Ok(old.to_vec());
    }
    let before = obj
        .get("BeforeKey")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    if before == Some(&key) {
        return Ok(old.to_vec());
    }
    let mut next: Vec<_> = old.iter().filter(|t| *t != &key).cloned().collect();
    if op != "remove" {
        let at = before
            .map(|b| {
                next.iter()
                    .position(|t| t == b)
                    .ok_or_else(|| Error::Conflict("insertion anchor missing".into()))
            })
            .transpose()?
            .unwrap_or(next.len());
        next.insert(at, key);
    }
    validate(&next)
}
pub fn records(layout: &[String], apps: &BTreeMap<String, App>, default: &str) -> Vec<Value> {
    let mut resolved = BTreeSet::new();
    layout.iter().map(|t|{
        if let Some(uri)=t.strip_prefix("folder:"){let path=glib::filename_from_uri(uri).ok().map(|v|v.0).unwrap_or_else(home);return json!({"Key":t,"Kind":"folder","Uri":uri,"Name":path.file_name().and_then(|n|n.to_str()).unwrap_or("Folder"),"Available":Path::new(&path).is_dir()});}
        let id=t.strip_prefix("app:").unwrap_or(default);let app=apps.get(id);let duplicate=!id.is_empty()&&!resolved.insert(id.to_string());
        json!({"Key":t,"Kind":"app","DesktopId":id,"Available":app.is_some_and(|a|a.record["EntryAvailable"]!=false),"DuplicateResolvedTarget":duplicate,"Name":app.map(App::name).unwrap_or(if t==DEFAULT{"Files"}else{id}),"UnavailableReason":if id.is_empty(){"No default directory handler"}else if app.is_none(){"App unavailable in catalogue"}else if app.is_some_and(|a|a.record["EntryAvailable"]==false){"TryExec is unavailable"}else{""}})
    }).collect()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_and_health() {
        let apps = BTreeMap::new();
        let mut l = migrate(&["pinned-kitty".into()], &apps);
        assert_eq!(l, [DEFAULT, "app:kitty.desktop"]);
        prune(&mut l, &apps, false);
        assert_eq!(l.len(), 2);
        prune(&mut l, &apps, true);
        assert_eq!(l, [DEFAULT]);
        assert!(validate(&[DEFAULT.into(), DEFAULT.into()]).is_err());
        assert!(canonical("app:../../bad.desktop").is_err());
        assert!(canonical("folder:file://remote/tmp").is_err());
    }
    #[test]
    fn migration_finds_the_entry_the_ts_dock_pinned() {
        let app = |id: &str| {
            (
                id.to_string(),
                App {
                    id: id.into(),
                    generation: 1,
                    digest: String::new(),
                    source_hash: String::new(),
                    exec_hash: String::new(),
                    record: json!({}),
                    executable: String::new(),
                    keywords: vec![],
                    icon: String::new(),
                },
            )
        };
        let apps: BTreeMap<String, App> = [
            app("org.telegram.desktop.desktop"),
            app("io.missioncenter.MissionCenter.desktop"),
            app("chrome-abc-Default.desktop"),
            app("kitty.desktop"),
        ]
        .into();
        let old = [
            "org.telegram",
            "io.missioncenter.missioncenter",
            "pinned-chrome-abc-default",
            "kitty",
            "gone",
        ]
        .map(String::from);
        let mut l = migrate(&old, &apps);
        prune(&mut l, &apps, true);
        assert_eq!(
            l,
            [
                DEFAULT,
                "app:org.telegram.desktop.desktop",
                "app:io.missioncenter.MissionCenter.desktop",
                "app:chrome-abc-Default.desktop",
                "app:kitty.desktop",
            ]
        );
    }
}
