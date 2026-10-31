// SPDX-License-Identifier: GPL-3.0-or-later
use crate::{Client, Fault};
use gio::prelude::*;
use serde_json::{Value, json};
use std::{
    io::{BufRead, BufReader, Read, Write},
    os::unix::net::UnixStream,
    path::PathBuf,
    time::Duration,
};
use zbus::zvariant::{OwnedValue, Value as Variant};

const CONFIG: (&str, &str, &str) = (
    "org.nidara.Config",
    "/org/nidara/Config",
    "org.nidara.Config1",
);
const SURFACES: &[(&str, &str)] = &[
    ("toggleCC", "cc"),
    ("toggleControlCenter", "cc"),
    ("toggleNC", "nc"),
    ("toggleNotificationCenter", "nc"),
    ("togglePrism", "prism"),
    ("toggleSearch", "prism"),
    ("toggleAppGrid", "app-grid"),
    ("toggleOverview", "overview"),
    ("togglePlayer", "player"),
    ("toggleAgent", "agent"),
    ("toggleAbout", "about"),
    ("toggleBarOverlay", "bar-overlay"),
    ("toggleGameOverlay", "bar-overlay"),
];
const WINDOWS: &[(&str, &str)] = &[
    ("focusWindow", "focus-window"),
    ("closeWindow", "close-window"),
    ("toggleFloat", "toggle-floating"),
    ("toggleFullscreen", "fullscreen"),
    ("centerWindow", "center"),
    ("togglePin", "pin"),
    ("togglePseudo", "pseudo"),
];
const DEFERRED: &[&str] = &[
    "queryUI",
    "widgetCatalog",
    "settingsMonitor",
    "takeNetworkCancel",
    "agentNewConversation",
    "notifyComputerAction",
    "agentPointer",
    "yieldInput",
    "openWindowMenu",
    "hideForLock",
    "showAfterLock",
    "toggleGroup",
    "moveWindowOutOfGroup",
    "setLayout",
];
fn count(args: &[String], min: usize, max: usize) -> Result<(), Fault> {
    if (min..=max).contains(&args.len()) {
        Ok(())
    } else {
        Err(Fault::invalid(format!(
            "expected {min}..={max} arguments, got {}",
            args.len()
        )))
    }
}
fn shell_error(e: nidara_shell_ipc::Error) -> Fault {
    match e {
        nidara_shell_ipc::Error::ZBus(e) => e.into(),
        nidara_shell_ipc::Error::Unavailable(e) => Fault::unavailable(e),
        nidara_shell_ipc::Error::AccessDenied(e) => Fault::new("AccessDenied", e),
        nidara_shell_ipc::Error::Invalid(e) => Fault::invalid(e),
        nidara_shell_ipc::Error::Failed(e) => Fault::new("Failed", e),
    }
}
fn shell_cap<'a>(
    client: &'a Client,
    cap: &str,
) -> Result<nidara_shell_ipc::ShellProxyBlocking<'a>, Fault> {
    let shell = client.shell()?;
    if !shell.available()? || !shell.capabilities()?.iter().any(|s| s == cap) {
        return Err(Fault::unavailable(format!(
            "Shell1 capability {cap} has no renderer"
        )));
    }
    Ok(shell)
}
fn described(client: &Client) -> Result<Value, Fault> {
    let p = client.proxy(CONFIG.0, CONFIG.1, CONFIG.2)?;
    let s: String = p.call("Describe", &())?;
    serde_json::from_str(&s)
        .map_err(|e| Fault::new("Failed", format!("invalid Config1 schema: {e}")))
}
fn apply(client: &Client, key: &str, raw: &str) -> Result<Value, Fault> {
    let schema = described(client)?;
    let entry = &schema[key];
    if entry["available"] != true {
        return Err(Fault::unavailable(format!("configuration key {key}")));
    }
    let value = match entry["type"].as_str() {
        Some("boolean") => OwnedValue::from(
            raw.parse::<bool>()
                .map_err(|_| Fault::invalid("expected true or false"))?,
        ),
        Some("number") => {
            let n = raw
                .parse::<f64>()
                .map_err(|_| Fault::invalid("expected a number"))?;
            if !n.is_finite() {
                return Err(Fault::invalid("number must be finite"));
            }
            OwnedValue::from(n)
        }
        Some("string" | "enum") => {
            OwnedValue::try_from(Variant::from(raw)).map_err(|e| Fault::invalid(e.to_string()))?
        }
        _ => {
            return Err(Fault::invalid(format!(
                "unknown configuration type for {key}"
            )));
        }
    };
    let p = client.proxy(CONFIG.0, CONFIG.1, CONFIG.2)?;
    let (revision, canonical): (u64, OwnedValue) = p.call("Apply", &(key, value))?;
    Ok(json!({"key": key, "revision": revision, "value": variant_json(&canonical)?}))
}
fn variant_json(value: &OwnedValue) -> Result<Value, Fault> {
    if let Ok(v) = bool::try_from(value) {
        return Ok(json!(v));
    }
    if let Ok(v) = f64::try_from(value) {
        return Ok(json!(v));
    }
    if let Ok(v) = <&str>::try_from(value) {
        return Ok(json!(v));
    }
    Err(Fault::new("Failed", "unsupported Config1 value type"))
}

fn socket() -> Result<PathBuf, Fault> {
    if let Some(s) = std::env::var_os("HYALO_SOCKET") {
        return Ok(s.into());
    }
    let rt = std::env::var_os("XDG_RUNTIME_DIR")
        .ok_or_else(|| Fault::unavailable("XDG_RUNTIME_DIR is unset"))?;
    let d = std::env::var_os("WAYLAND_DISPLAY")
        .ok_or_else(|| Fault::unavailable("WAYLAND_DISPLAY is unset"))?;
    let name = std::path::Path::new(&d)
        .file_name()
        .ok_or_else(|| Fault::invalid("invalid WAYLAND_DISPLAY"))?
        .to_string_lossy();
    Ok(PathBuf::from(rt).join(format!("nidara-hyalo.{name}.sock")))
}
fn hyalo(request: Value) -> Result<Value, Fault> {
    let path = socket()?;
    let mut stream = UnixStream::connect(&path)
        .map_err(|e| Fault::unavailable(format!("Hyalo {}: {e}", path.display())))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(io_error)?;
    stream
        .set_write_timeout(Some(Duration::from_secs(15)))
        .map_err(io_error)?;
    serde_json::to_writer(&mut stream, &request)
        .map_err(|e| Fault::new("Failed", e.to_string()))?;
    stream.write_all(b"\n").map_err(io_error)?;
    let mut bytes = vec![];
    BufReader::new(stream)
        .take(4 * 1024 * 1024)
        .read_until(b'\n', &mut bytes)
        .map_err(io_error)?;
    if bytes.last() != Some(&b'\n') {
        return Err(Fault::new("Failed", "incomplete or oversized Hyalo reply"));
    }
    let reply: Value =
        serde_json::from_slice(&bytes).map_err(|e| Fault::new("Failed", e.to_string()))?;
    if let Some(e) = reply.get("error") {
        return Err(Fault::new(
            if reply["code"] == "AccessDenied" {
                "AccessDenied"
            } else {
                "Failed"
            },
            e.as_str().unwrap_or("Hyalo refused"),
        ));
    }
    reply
        .get("ok")
        .cloned()
        .ok_or_else(|| Fault::new("Failed", "missing Hyalo result"))
}
fn io_error(e: std::io::Error) -> Fault {
    Fault::new("Failed", e.to_string())
}
fn read(kind: &str, field: &str) -> Result<Value, Fault> {
    hyalo(json!({"request":kind}))?
        .get(field)
        .cloned()
        .ok_or_else(|| Fault::new("Failed", format!("missing Hyalo {field}")))
}
fn action(command: String) -> Result<Value, Fault> {
    hyalo(json!({"request":"do", "command":command}))
}
fn words(value: &str) -> Result<&str, Fault> {
    if value.is_empty() || value.chars().any(char::is_whitespace) {
        Err(Fault::invalid("expected one non-empty argument"))
    } else {
        Ok(value)
    }
}
fn window(query: &str) -> Result<Value, Fault> {
    let windows = read("windows", "windows")?;
    let all = windows
        .as_array()
        .ok_or_else(|| Fault::new("Failed", "invalid window list"))?;
    // Exact ids/addresses are stable. A name must resolve unambiguously; never
    // choose an arbitrary window when several apps/titles match.
    let id = query
        .strip_prefix("0x")
        .and_then(|s| u64::from_str_radix(s, 16).ok())
        .or_else(|| query.parse().ok());
    if let Some(id) = id {
        return all
            .iter()
            .find(|w| w["id"].as_u64() == Some(id))
            .cloned()
            .ok_or_else(|| Fault::invalid("window id no longer exists"));
    }
    let q = query.to_lowercase();
    if q.is_empty() {
        return Err(Fault::invalid("window target is empty"));
    }
    let hits: Vec<_> = all
        .iter()
        .filter(|w| {
            ["app_id", "title"]
                .iter()
                .any(|k| w[k].as_str().unwrap_or("").to_lowercase().contains(&q))
        })
        .collect();
    match hits.as_slice() {
        [w] => Ok((*w).clone()),
        [] => Err(Fault::invalid(format!("no window matching {query:?}"))),
        _ => Err(Fault::invalid(format!(
            "ambiguous window {query:?}; use an address from listWindows"
        ))),
    }
}
fn window_id(w: &Value) -> Result<u64, Fault> {
    w["id"]
        .as_u64()
        .ok_or_else(|| Fault::new("Failed", "invalid Hyalo window id"))
}
fn compat_windows() -> Result<Value, Fault> {
    let windows = read("windows", "windows")?;
    let windows = windows
        .as_array()
        .ok_or_else(|| Fault::new("Failed", "invalid window list"))?;
    Ok(Value::Array(windows.iter().map(|w| json!({
        "address": format!("0x{:x}", w["id"].as_u64().unwrap_or(0)), "class": w["app_id"], "title": w["title"],
        "workspace": {"id": w["workspace"], "name": w["workspace"].to_string()},
        "at": [w["x"], w["y"]], "size": [w["width"], w["height"]],
        "floating": w["floating"], "fullscreen": w["fullscreen"] == "fullscreen", "pinned": w["pinned"],
        "grouped": false, "focused": w["focused"]
    })).collect()))
}
fn revoke() -> Result<(), Fault> {
    let schema = gio::SettingsSchemaSource::default()
        .and_then(|s| s.lookup("org.nidara.ai", true))
        .filter(|s| s.has_key("allow-computer-control"))
        .ok_or_else(|| Fault::unavailable("computer-control schema is missing"))?;
    let settings = gio::Settings::new_full(&schema, None::<&gio::SettingsBackend>, None);
    settings
        .set_boolean("allow-computer-control", false)
        .map_err(|e| Fault::new("Failed", e.to_string()))?;
    gio::Settings::sync();
    if settings.boolean("allow-computer-control") {
        return Err(Fault::new("Failed", "revocation was not applied"));
    }
    Ok(())
}

pub fn run(client: &Client, argv: &[String]) -> Result<String, Fault> {
    let cmd = argv[0].as_str();
    let a = &argv[1..];
    if let Some((_, surface)) = SURFACES.iter().find(|(n, _)| *n == cmd) {
        count(a, 0, 1)?;
        if a.first().is_some_and(|s| s != "keyboard") {
            return Err(Fault::invalid("only optional argument is keyboard"));
        }
        shell_cap(client, &format!("surface:{surface}"))?
            .toggle_surface(surface, !a.is_empty())
            .map_err(shell_error)?;
        return Ok("ok".into());
    }
    if let Some((_, verb)) = WINDOWS.iter().find(|(n, _)| *n == cmd) {
        count(a, 1, 1)?;
        let w = window(&a[0])?;
        let id = window_id(&w)?;
        action(format!("{verb} {id}"))?;
        if cmd == "focusWindow"
            && !window(&format!("0x{id:x}"))?["focused"]
                .as_bool()
                .unwrap_or(false)
        {
            return Err(Fault::new(
                "Failed",
                "Hyalo did not focus the requested window",
            ));
        }
        return Ok("ok".into());
    }
    let value = match cmd {
        "listApps" | "launchApp" => {
            return crate::applications::run(client, cmd, a);
        }
        "listActions" => {
            count(a, 0, 0)?;
            return Ok(catalogue().to_string());
        }
        "disableComputerControl" => {
            count(a, 0, 0)?;
            revoke()?;
            return Ok("computer-control disabled".into());
        }
        "openSettings" | "toggleSettings" | "settingsPage" | "settingsApp" => {
            count(
                a,
                usize::from(cmd == "settingsPage" || cmd == "settingsApp"),
                1,
            )?;
            let value = a.first().map(String::as_str).unwrap_or("");
            shell_cap(client, "settings")?
                .open_settings(
                    if cmd == "settingsPage" { value } else { "" },
                    if cmd == "settingsApp" { value } else { "" },
                )
                .map_err(shell_error)?;
            return Ok("ok".into());
        }
        "focusBar" | "focusDock" => {
            count(a, 0, 0)?;
            let s = if cmd == "focusBar" { "bar" } else { "dock" };
            shell_cap(client, &format!("focus:{s}"))?
                .focus_surface(s)
                .map_err(shell_error)?;
            return Ok("ok".into());
        }
        "setIsland" => {
            count(a, 1, 1)?;
            let mode = match a[0].as_str() {
                "closed" | "close" | "none" | "" => "",
                "agent" | "overview" | "player" | "battery" => &a[0],
                _ => return Err(Fault::invalid("unknown island mode")),
            };
            shell_cap(client, "island")?
                .set_island(mode)
                .map_err(shell_error)?;
            return Ok("ok".into());
        }
        "describeConfig" => {
            count(a, 0, 0)?;
            described(client)?
        }
        "getConfig" => {
            count(a, 0, 1)?;
            let p = client.proxy(CONFIG.0, CONFIG.1, CONFIG.2)?;
            let values: std::collections::HashMap<String, OwnedValue> = p.call("Get", &(a,))?;
            if let Some(key) = a.first() {
                json!({"key":key,"value":variant_json(values.get(key).ok_or_else(|| Fault::new("Failed", "missing Config1 key"))?)?})
            } else {
                let mut out = serde_json::Map::new();
                for (k, v) in values {
                    out.insert(k, variant_json(&v)?);
                }
                Value::Object(out)
            }
        }
        "setConfig" => {
            count(a, 2, usize::MAX)?;
            apply(client, &a[0], &a[1..].join(" "))?
        }
        "setWallpaper" | "set-wallpaper" | "settingsWallpaper" => {
            if cmd == "settingsWallpaper" {
                count(a, 2, 3)?;
                match a[0].as_str() {
                    "preview" => {
                        return Err(Fault::unavailable(
                            "wallpaper preview has no ephemeral Config1 API",
                        ));
                    }
                    "transition" => {
                        count(a, 2, 2)?;
                        apply(client, "wallpaper.transition", &a[1])?
                    }
                    "set" => {
                        count(a, 3, 3)?;
                        wallpaper(client, &a[1], Some(&a[2]))?
                    }
                    _ => {
                        return Err(Fault::invalid(
                            "settingsWallpaper expects set, transition or preview",
                        ));
                    }
                }
            } else {
                count(a, 1, 2)?;
                wallpaper(client, &a[0], a.get(1).map(String::as_str))?
            }
        }
        "listWindows" => {
            count(a, 0, 0)?;
            compat_windows()?
        }
        "listWorkspaces" => {
            count(a, 0, 0)?;
            let w = read("workspaces", "workspaces")?;
            Value::Array(w.as_array().ok_or_else(|| Fault::new("Failed", "invalid workspace list"))?.iter().map(|w| json!({"id":w["id"],"name":w["name"],"monitor":w["output"],"windows":w["windows"],"active":w["focused"],"special":w["special"]})).collect())
        }
        "reloadCompositor" | "reloadHyprland" => {
            count(a, 0, 0)?;
            hyalo(json!({"request":"reload_config"}))?
        }
        "focusDirection" => {
            count(a, 1, 1)?;
            let d = match a[0].as_str() {
                "l" | "left" => "left",
                "r" | "right" => "right",
                "u" | "up" => "up",
                "d" | "down" => "down",
                _ => return Err(Fault::invalid("expected left/right/up/down")),
            };
            action(format!("focus {d}"))?
        }
        "focusWorkspace" => {
            count(a, 1, 1)?;
            let target = match a[0].as_str() {
                "+1" => "e+1",
                "-1" => "e-1",
                s => words(s)?,
            };
            action(format!("workspace {target}"))?
        }
        "moveWindowToWorkspace" => {
            count(a, 2, 2)?;
            let w = window(&a[0])?;
            let ws = words(&a[1])?;
            action(format!("move-to-workspace-silent {ws} {}", window_id(&w)?))?
        }
        "sendWindowToSpecial" => {
            count(a, 0, 2)?;
            let name = words(a.first().map(String::as_str).unwrap_or("magic"))?
                .trim_start_matches("special:");
            let name = words(name)?;
            let id = if let Some(q) = a.get(1) {
                window_id(&window(q)?)?.to_string()
            } else {
                String::new()
            };
            action(format!("move-to-special {name} {id}"))?
        }
        "getWorkspaceMode" => {
            count(a, 1, 1)?;
            let id = a[0]
                .parse::<i64>()
                .map_err(|_| Fault::invalid("expected workspace id"))?;
            let ws = read("workspaces", "workspaces")?;
            let mode = ws
                .as_array()
                .and_then(|w| w.iter().find(|w| w["id"].as_i64() == Some(id)))
                .and_then(|w| w["mode"].as_str())
                .ok_or_else(|| Fault::invalid("workspace not found"))?;
            return Ok(mode.into());
        }
        "setWorkspaceMode" => {
            count(a, 2, 2)?;
            let id = a[0]
                .parse::<i32>()
                .map_err(|_| Fault::invalid("expected workspace id"))?;
            if !["floating", "tiling", "default"].contains(&a[1].as_str()) {
                return Err(Fault::invalid("expected floating/tiling/default"));
            }
            action(format!("set-workspace-mode {id} {}", a[1]))?
        }
        "toggleWorkspaceMode" => {
            count(a, 0, 1)?;
            let id = a
                .first()
                .map(|s| s.parse::<i32>())
                .transpose()
                .map_err(|_| Fault::invalid("expected workspace id"))?;
            action(format!(
                "toggle-workspace-mode {}",
                id.map(|n| n.to_string()).unwrap_or_default()
            ))?
        }
        "screenshot" => {
            count(a, 0, 1)?;
            let path = std::path::absolute(a.first().cloned().unwrap_or_else(|| {
                format!(
                    "/tmp/nidara-shot-{}-{}.png",
                    std::process::id(),
                    std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_nanos()
                )
            }))
            .map_err(io_error)?;
            let ws = read("workspaces", "workspaces")?;
            let output = ws
                .as_array()
                .and_then(|all| all.iter().find(|w| w["focused"] == true))
                .and_then(|w| w["output"].as_str());
            hyalo(json!({"request":"screenshot", "path":path, "output":output}))?;
            return Ok(path.to_string_lossy().into());
        }
        "dumpState" => {
            count(a, 0, 0)?;
            // A missing renderer is explicit, not a fabricated all-closed shell.
            let shell = match client.shell() {
                Ok(s) => {
                    json!({"available":s.available()?,"capabilities":s.capabilities()?,"state":s.get_state().map_err(shell_error)?})
                }
                Err(e) if e.code == "Unavailable" => {
                    json!({"available":false,"capabilities":[],"state":null})
                }
                Err(e) => return Err(e),
            };
            json!({"session":"rust","shell":shell,"compositor":"hyalo", "windows":read("windows","windows")?, "workspaces":read("workspaces","workspaces")?, "monitors":read("outputs","outputs")?})
        }
        c if DEFERRED.contains(&c) => {
            return Err(Fault::unavailable(format!(
                "{cmd} is not implemented in the Rust session; Applications1, native UI and helper migration are separate work"
            )));
        }
        _ => {
            return Err(Fault::invalid(format!(
                "unknown command {cmd:?}; see listActions"
            )));
        }
    };
    Ok(value.to_string())
}
fn wallpaper(client: &Client, path: &str, transition: Option<&str>) -> Result<Value, Fault> {
    // Config1 has per-key transactions, not an atomic multi-key write. Each Apply
    // answers only after its own validation/policy; never pretend to preview.
    if let Some(t) = transition {
        apply(client, "wallpaper.transition", t)?;
    }
    let path = if path.starts_with("file://") {
        path.to_string()
    } else {
        std::path::absolute(path)
            .map_err(io_error)?
            .to_string_lossy()
            .into()
    };
    apply(client, "wallpaper.current", &path)
}
fn catalogue() -> Value {
    let mut c = serde_json::Map::new();
    for (name, surface) in SURFACES {
        c.insert(
            (*name).into(),
            json!({"route":"Shell1","desc":format!("Toggle {surface}; optional keyboard argument; requires its renderer"),"capability":format!("surface:{surface}")}),
        );
    }
    for (name, _) in WINDOWS {
        c.insert((*name).into(),json!({"route":"Hyalo","desc":"Target window by address or unambiguous app/title; consent enforced by Hyalo"}));
    }
    for (route, names) in [
        (
            "Config1",
            "describeConfig getConfig setConfig setWallpaper set-wallpaper settingsWallpaper",
        ),
        (
            "Hyalo",
            "listWindows listWorkspaces reloadCompositor reloadHyprland focusDirection focusWorkspace moveWindowToWorkspace sendWindowToSpecial getWorkspaceMode setWorkspaceMode toggleWorkspaceMode screenshot",
        ),
        (
            "Shell1",
            "openSettings toggleSettings settingsPage settingsApp focusBar focusDock setIsland",
        ),
        ("Applications1", "listApps launchApp"),
        ("local", "disableComputerControl listActions dumpState"),
    ] {
        for name in names.split_whitespace() {
            c.insert(name.into(), json!({"route":route}));
        }
    }
    for name in DEFERRED {
        c.insert(
            (*name).into(),
            json!({"route":"unavailable","available":false,"desc":"Unavailable in Rust; implementation is separate work"}),
        );
    }
    for (name, description) in [
        (
            "describeConfig",
            "Describe Config1 keys, types, constraints and current values",
        ),
        (
            "getConfig",
            "getConfig [key]: read one or all Config1 values",
        ),
        (
            "setConfig",
            "setConfig <key> <value>: Config1 validates and authorizes the write; returns revision and canonical value",
        ),
        (
            "setWallpaper",
            "setWallpaper <path> [transition]: Config1 writes; transition and current are separate per-key operations",
        ),
        ("set-wallpaper", "Alias of setWallpaper"),
        (
            "settingsWallpaper",
            "settingsWallpaper set <path> <transition> | transition <name>; preview is Unavailable",
        ),
        (
            "listApps",
            "List visible launchable Applications1 apps with exact desktop IDs",
        ),
        (
            "launchApp",
            "launchApp <name-or-id> [--new-window|--action=ID|URI...]; waits for dispatch, never focus confirmation",
        ),
        (
            "listWindows",
            "List windows with address, class, title, workspace, geometry, flags and focus",
        ),
        (
            "listWorkspaces",
            "List workspaces with id, name, monitor, window count, active and special flags",
        ),
        (
            "reloadCompositor",
            "Reload Hyalo's existing configuration; public like its file watcher",
        ),
        (
            "reloadHyprland",
            "Compatibility alias of reloadCompositor; native route targets Hyalo",
        ),
        (
            "focusDirection",
            "focusDirection <left|right|up|down|l|r|u|d>",
        ),
        (
            "focusWorkspace",
            "focusWorkspace <id|+1|-1|previous|name:NAME>",
        ),
        (
            "moveWindowToWorkspace",
            "moveWindowToWorkspace <window> <workspace>; does not follow the moved window",
        ),
        (
            "sendWindowToSpecial",
            "sendWindowToSpecial [name] [window]; default magic and focused window",
        ),
        (
            "getWorkspaceMode",
            "getWorkspaceMode <id>: read floating/tiling",
        ),
        (
            "setWorkspaceMode",
            "setWorkspaceMode <id> <floating|tiling|default>",
        ),
        (
            "toggleWorkspaceMode",
            "toggleWorkspaceMode [id]; defaults to focused workspace",
        ),
        (
            "screenshot",
            "screenshot [path]: focused output to PNG; Hyalo enforces control and screenshot consent",
        ),
        (
            "openSettings",
            "Present native Settings via Shell1; requires the settings capability",
        ),
        ("toggleSettings", "Alias of openSettings"),
        (
            "settingsPage",
            "settingsPage <page>: present Settings on a page via Shell1",
        ),
        (
            "settingsApp",
            "settingsApp <desktop-id>: present Settings on an app via Shell1",
        ),
        (
            "focusBar",
            "Walk the native bar by keyboard; requires focus:bar capability",
        ),
        (
            "focusDock",
            "Walk the native dock by keyboard; requires focus:dock capability",
        ),
        (
            "setIsland",
            "setIsland <closed|agent|overview|player|battery>: exact island state; requires island capability",
        ),
        (
            "disableComputerControl",
            "Revoke computer control unconditionally; works with no renderer",
        ),
        (
            "listActions",
            "Describe native command routes and required capabilities; no service needed",
        ),
        (
            "dumpState",
            "Read native compositor and renderer state; absent renderer is explicitly unavailable",
        ),
    ] {
        c[name]["desc"] = json!(description);
    }
    Value::Object(c)
}
