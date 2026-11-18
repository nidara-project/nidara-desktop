// SPDX-License-Identifier: GPL-3.0-or-later
//! #1103 7c. Workspace modes. Home: Hyalo's settings layer (`[workspaces]`), as
//! `saveWorkspaceModes` in hyalo-settings.ts; Hyalo reorganizes the windows itself.
use super::*;

const MODES: &[&str] = &["floating", "tiling"];
const OVERRIDES: &[&str] = &["default", "floating", "tiling"];
const DEFAULT: &str = "workspaces.defaultMode";
/// The five workspaces Settings offers, as in WorkspaceModes.ts.
const NAMES: [&str; 5] = [
    "workspaces.workspace1Mode",
    "workspaces.workspace2Mode",
    "workspaces.workspace3Mode",
    "workspaces.workspace4Mode",
    "workspaces.workspace5Mode",
];
const DESCS: [&str; 5] = [
    "Window mode for workspace 1: 'default' (inherits default mode), 'floating', or 'tiling'.",
    "Window mode for workspace 2: 'default' (inherits default mode), 'floating', or 'tiling'.",
    "Window mode for workspace 3: 'default' (inherits default mode), 'floating', or 'tiling'.",
    "Window mode for workspace 4: 'default' (inherits default mode), 'floating', or 'tiling'.",
    "Window mode for workspace 5: 'default' (inherits default mode), 'floating', or 'tiling'.",
];

fn workspace(name: &str) -> Option<usize> {
    NAMES.iter().position(|n| *n == name).map(|i| i + 1)
}
pub(super) fn is_key(name: &str) -> bool {
    name == DEFAULT || workspace(name).is_some()
}
pub(super) fn available(st: &Store) -> bool {
    let w = st.workspaces.borrow();
    w["default_mode"].is_string() && w["modes"].is_object()
}
/// A workspace without a mode of its own in the merged configuration follows the default.
fn value(w: &Json, name: &str) -> Value {
    Value::Text(match workspace(name) {
        None => w["default_mode"].as_str().unwrap_or_default().into(),
        Some(n) => w["modes"][n.to_string()]
            .as_str()
            .unwrap_or("default")
            .into(),
    })
}
pub(super) fn changed(name: &str, before: &Json, after: &Json) -> bool {
    is_key(name) && value(before, name) != value(after, name)
}
fn get(st: &Store, name: &str) -> Value {
    value(&st.workspaces.borrow(), name)
}
fn put(st: &Store, name: &str, v: &Value) -> Result<(), String> {
    let mode = text(v);
    let patch = match workspace(name) {
        None => json!({"default_mode": mode}),
        // `null` takes this workspace out of our layer, so it follows the default again.
        Some(n) => {
            json!({"modes": {n.to_string(): if mode == "default" { Json::Null } else { json!(mode) }}})
        }
    };
    let result = crate::hyalo::request(json!({"request":"settings","patch":{"workspaces":patch}}));
    *st.workspaces.borrow_mut() = read_compositor()["workspaces"].clone();
    // The existing monitor may have captured its request before this write.
    st.idle_serial
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    result?;
    if get(st, name) != *v {
        return Err("workspace mode unavailable or overridden by user configuration".into());
    }
    // A mode chosen in Settings wins over one toggled at runtime, as in TS (`pushAll`):
    // clearing the runtime mode lets Hyalo reorganize the windows to the configured one.
    let affected: Vec<usize> = match workspace(name) {
        Some(n) => vec![n],
        None => (1..=NAMES.len())
            .filter(|n| st.workspaces.borrow()["modes"][n.to_string()].is_null())
            .collect(),
    };
    for n in affected {
        crate::hyalo::request(
            json!({"request":"do","command":format!("set-workspace-mode {n} default")}),
        )?;
    }
    Ok(())
}

pub(super) fn keys() -> Vec<Key> {
    let mut keys = vec![Key {
        name: DEFAULT,
        desc: "Default mode for workspaces: 'floating' or 'tiling'.",
        kind: Kind::Enum,
        writable: true,
        needs: &[],
        values: Some(|_| owned(MODES)),
        catalogue: None,
        validate: None,
        get: |st| get(st, DEFAULT),
        set: Some(|st, v| put(st, DEFAULT, v)),
        ui: Some(|_| {
            json!({"i18n": "settings.desktop.default-mode", "control": "segmented",
                "options": options_i18n(&owned(MODES), "settings.desktop.mode")})
        }),
        watch: &[],
        file: false,
    }];
    macro_rules! workspace_key {
        ($i:literal, $n:literal) => {
            Key {
                name: NAMES[$i],
                desc: DESCS[$i],
                kind: Kind::Enum,
                writable: true,
                needs: &[],
                values: Some(|_| owned(OVERRIDES)),
                catalogue: None,
                validate: None,
                get: |st| get(st, NAMES[$i]),
                set: Some(|st, v| put(st, NAMES[$i], v)),
                ui: Some(|_| {
                    json!({"i18n": concat!("settings.desktop.workspace-", $n), "control": "segmented",
                        "options": options_i18n(&owned(OVERRIDES), "settings.desktop.mode")})
                }),
                watch: &[],
                file: false,
            }
        };
    }
    keys.extend([
        workspace_key!(0, "1"),
        workspace_key!(1, "2"),
        workspace_key!(2, "3"),
        workspace_key!(3, "4"),
        workspace_key!(4, "5"),
    ]);
    keys
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_workspace_without_its_own_mode_follows_the_default() {
        let w = json!({"default_mode": "tiling", "modes": {"3": "floating"}});
        assert_eq!(value(&w, DEFAULT), Value::Text("tiling".into()));
        assert_eq!(value(&w, NAMES[2]), Value::Text("floating".into()));
        assert_eq!(value(&w, NAMES[0]), Value::Text("default".into()));
        let after = json!({"default_mode": "tiling", "modes": {}});
        assert!(changed(NAMES[2], &w, &after));
        assert!(!changed(NAMES[0], &w, &after));
        assert!(!changed("input.mouse.speed", &w, &after));
    }
}
