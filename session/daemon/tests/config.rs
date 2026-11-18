// SPDX-License-Identifier: GPL-3.0-or-later
//! `org.nidara.Config1` end to end: the real daemon (`--config`) on a private bus, with
//! GSettings on the keyfile backend in a directory of the test's own (nothing of the user's
//! is read or written) and the schemas compiled from this checkout and the system's GNOME
//! ones. A client follows the protocol (subscribe to `Updated`, then `Snapshot`) and checks
//! the trust gate, the canonical answers, the errors, and that a change made by ANOTHER
//! writer is announced.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use zbus::zvariant::{OwnedValue, Value};

struct Env {
    dir: PathBuf,
    bus: Child,
    daemon: Option<Child>,
    address: String,
}
impl Drop for Env {
    fn drop(&mut self) {
        if let Some(d) = &mut self.daemon {
            let _ = d.kill();
            let _ = d.wait();
        }
        let _ = self.bus.kill();
        let _ = self.bus.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// `without`: a key taken out of the system's interface schema, as an older GNOME lacks it.
fn setup_without(without: Option<&str>) -> Env {
    static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir =
        Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("config-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let schemas = dir.join("schemas");
    std::fs::create_dir_all(&schemas).unwrap();
    std::fs::copy(
        root().join("config/gsettings/org.nidara.gschema.xml"),
        schemas.join("org.nidara.gschema.xml"),
    )
    .unwrap();
    for f in [
        "org.gnome.desktop.enums.xml",
        "org.gnome.desktop.interface.gschema.xml",
        "org.gnome.desktop.wm.preferences.gschema.xml",
        "org.gnome.desktop.background.gschema.xml",
    ] {
        std::fs::copy(
            Path::new("/usr/share/glib-2.0/schemas").join(f),
            schemas.join(f),
        )
        .unwrap_or_else(|e| panic!("{f} (gsettings-desktop-schemas): {e}"));
    }
    if let Some(key) = without {
        let path = schemas.join("org.gnome.desktop.interface.gschema.xml");
        let xml = std::fs::read_to_string(&path).unwrap();
        if let Some(start) = xml.find(&format!("<key name=\"{key}\"")) {
            let end = start + xml[start..].find("</key>").unwrap() + "</key>".len();
            std::fs::write(&path, format!("{}{}", &xml[..start], &xml[end..])).unwrap();
        }
    }
    let ok = Command::new("glib-compile-schemas")
        .arg(&schemas)
        .status()
        .unwrap();
    assert!(ok.success(), "glib-compile-schemas");
    for d in ["config/nidara", "data", "state", "cache"] {
        std::fs::create_dir_all(dir.join(d)).unwrap();
    }
    let socket = dir.join("bus");
    let address = format!("unix:path={}", socket.display());
    let bus = Command::new("dbus-daemon")
        .args([
            "--session",
            "--nofork",
            "--nopidfile",
            &format!("--address={address}"),
        ])
        .stdout(Stdio::null())
        .spawn()
        .expect("dbus-daemon");
    for _ in 0..200 {
        if socket.exists() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    Env {
        dir,
        bus,
        daemon: None,
        address,
    }
}

fn setup() -> Env {
    let env = setup_without(None);
    env.gsettings_set("org.nidara.ai", "allow-computer-control", "true");
    env
}

impl Env {
    fn vars(&self, cmd: &mut Command) {
        cmd.env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("DBUS_SESSION_BUS_ADDRESS", &self.address)
            .env("HYALO_SOCKET", self.dir.join("hyalo.sock"))
            .env("GSETTINGS_BACKEND", "keyfile")
            .env("GIO_USE_VFS", "local")
            .env("GSETTINGS_SCHEMA_DIR", self.dir.join("schemas"))
            .env("HOME", &self.dir)
            .env("XDG_CONFIG_HOME", self.dir.join("config"))
            .env("XDG_DATA_HOME", self.dir.join("data"))
            .env("XDG_STATE_HOME", self.dir.join("state"))
            .env("XDG_CACHE_HOME", self.dir.join("cache"));
    }
    fn start(&mut self) {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_nidara-sessiond"));
        cmd.arg("--config");
        self.vars(&mut cmd);
        self.daemon = Some(cmd.spawn().expect("nidara-sessiond"));
    }
    /// Another writer: the gsettings tool on the same keyfile.
    fn gsettings_set(&self, schema: &str, key: &str, value: &str) {
        let mut cmd = Command::new("gsettings");
        cmd.args(["set", schema, key, value]);
        self.vars(&mut cmd);
        assert!(
            cmd.status().unwrap().success(),
            "gsettings set {schema} {key}"
        );
    }
}

async fn connect(address: &str) -> zbus::Connection {
    zbus::connection::Builder::address(address)
        .unwrap()
        .build()
        .await
        .unwrap()
}

async fn wait_for_config(conn: &zbus::Connection) {
    let dbus = zbus::fdo::DBusProxy::new(conn).await.unwrap();
    for _ in 0..500 {
        if dbus
            .name_has_owner("org.nidara.Config".try_into().unwrap())
            .await
            .unwrap()
        {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the daemon never took org.nidara.Config");
}

async fn call<R: serde::de::DeserializeOwned + zbus::zvariant::Type>(
    conn: &zbus::Connection,
    method: &str,
    body: &(impl serde::Serialize + zbus::zvariant::DynamicType),
) -> zbus::Result<R> {
    conn.call_method(
        Some("org.nidara.Config"),
        "/org/nidara/Config",
        Some("org.nidara.Config1"),
        method,
        body,
    )
    .await?
    .body()
    .deserialize()
}

fn error_name(e: zbus::Error) -> String {
    match e {
        zbus::Error::MethodError(name, _, _) => name.to_string(),
        other => format!("{other}"),
    }
}

type Updated = (u64, u64, HashMap<String, OwnedValue>);

#[tokio::test(flavor = "multi_thread")]
async fn config1_snapshot_apply_gate_and_other_writers() {
    let mut env = setup();
    // Both gates are closed here, so an external writer is refused.
    env.gsettings_set("org.nidara.ai", "allow-computer-control", "false");
    env.gsettings_set("org.nidara.ai", "allow-config-write", "false");
    env.start();
    let conn = connect(&env.address).await;
    wait_for_config(&conn).await;

    // Subscribe first, then the snapshot (PHASE1.md [A3]).
    let proxy = zbus::Proxy::new(
        &conn,
        "org.nidara.Config",
        "/org/nidara/Config",
        "org.nidara.Config1",
    )
    .await
    .unwrap();
    let mut updated = proxy.receive_signal("Updated").await.unwrap();
    let (epoch, revision, schema): (u64, u64, String) = call(&conn, "Snapshot", &()).await.unwrap();
    assert!(epoch > 0);
    assert_eq!(revision, 0, "nothing has changed yet");
    let schema: serde_json::Value = serde_json::from_str(&schema).unwrap();
    assert_eq!(schema["schemaVersion"], 1);
    let dark = &schema["keys"]["appearance.darkMode"];
    assert_eq!(dark["value"], false);
    assert_eq!(dark["ui"]["i18n"], "settings.appearance.dark-mode");
    assert!(
        dark["ui"]["title"].is_null(),
        "labels are the client's, from its catalogue"
    );
    assert_eq!(schema["keys"]["ai.allowConfigWrite"]["writable"], false);
    assert_eq!(
        schema["keys"]["appearance.windowControls"]["value"],
        "right"
    );
    // The dock's preferences, with the TS shell's names and bounds.
    assert_eq!(schema["keys"]["dock.position"]["value"], "bottom");
    assert_eq!(schema["keys"]["dock.iconSize"]["value"], 64.);
    assert_eq!(schema["keys"]["dock.maxIconSize"]["max"], 128.);
    assert_eq!(schema["keys"]["dock.hideDelay"]["ui"]["control"], "slider");
    assert!(
        schema["keys"]["wallpaper.transition"]["values"]
            .as_array()
            .unwrap()
            .len()
            >= 12
    );

    // An agent (not the native Settings), writes not allowed: Denied.
    let denied =
        call::<(u64, OwnedValue)>(&conn, "Apply", &("appearance.darkMode", Value::from(true)))
            .await;
    assert_eq!(
        error_name(denied.unwrap_err()),
        "org.nidara.Config1.Error.AccessDenied"
    );

    // A bus name is not executable identity. Spoofing SettingsNative grants nothing.
    conn.request_name("org.nidara.SettingsNative")
        .await
        .unwrap();
    let denied =
        call::<(u64, OwnedValue)>(&conn, "Apply", &("appearance.darkMode", Value::from(true)))
            .await;
    assert_eq!(
        error_name(denied.unwrap_err()),
        "org.nidara.Config1.Error.AccessDenied"
    );
    // The legacy specific gate alone is insufficient; control must also be granted.
    env.gsettings_set("org.nidara.ai", "allow-config-write", "true");
    let denied = call::<()>(&conn, "Set", &("appearance.darkMode", Value::from(true))).await;
    assert_eq!(
        error_name(denied.unwrap_err()),
        "org.nidara.Config1.Error.AccessDenied"
    );
    env.gsettings_set("org.nidara.ai", "allow-computer-control", "true");
    // Consume permission changes before measuring the next write's revision.
    let (_, baseline, _): (u64, u64, String) = call(&conn, "Snapshot", &()).await.unwrap();
    use futures_util::StreamExt;
    while tokio::time::timeout(Duration::from_millis(100), updated.next())
        .await
        .is_ok()
    {}
    let (rev, value): (u64, OwnedValue) =
        call(&conn, "Apply", &("appearance.darkMode", Value::from(true)))
            .await
            .unwrap();
    assert_eq!(rev, baseline + 1);
    assert!(bool::try_from(value).unwrap());
    let signal = tokio::time::timeout(Duration::from_secs(5), updated.next())
        .await
        .unwrap()
        .unwrap();
    let (e, r, values): Updated = signal.body().deserialize().unwrap();
    assert_eq!((e, r), (epoch, baseline + 1));
    assert!(bool::try_from(values["appearance.darkMode"].clone()).unwrap());

    // A no-op, before unrelated external-file notifications can advance revision.
    let (same_rev, _): (u64, OwnedValue) =
        call(&conn, "Apply", &("appearance.darkMode", Value::from(true)))
            .await
            .unwrap();
    assert_eq!(same_rev, rev);

    // Canonical answers: whole kelvins; a file URI made a path.
    let (_, value): (u64, OwnedValue) = call(
        &conn,
        "Apply",
        &("nightlight.temperature", Value::from(4321.6)),
    )
    .await
    .unwrap();
    assert_eq!(f64::try_from(value).unwrap(), 4322.);
    let image = env.dir.join("a wall.png");
    std::fs::write(&image, b"x").unwrap();
    let uri = format!("file://{}", image.display()).replace(' ', "%20");
    let (_, value): (u64, OwnedValue) = call(
        &conn,
        "Apply",
        &("wallpaper.current", Value::from(uri.as_str())),
    )
    .await
    .unwrap();
    assert_eq!(
        String::try_from(value).unwrap(),
        image.display().to_string()
    );
    let file: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(env.dir.join("config/nidara/wallpaper")).unwrap(),
    )
    .unwrap();
    assert_eq!(file["path"], image.display().to_string());

    // Errors: out of range, not in the enum, a read-only key.
    for (key, value) in [
        ("nightlight.temperature", Value::from(100.)),
        ("appearance.windowBackground", Value::from("glass")),
        ("ai.allowConfigWrite", Value::from(true)),
    ] {
        let err = call::<(u64, OwnedValue)>(&conn, "Apply", &(key, value))
            .await
            .unwrap_err();
        assert_eq!(error_name(err), "org.nidara.Config1.Error.Invalid", "{key}");
    }

    let before: (u64, u64, String) = call(&conn, "Snapshot", &()).await.unwrap();

    // Another writer (gsettings, a script, the TypeScript shell): heard and announced.
    while tokio::time::timeout(Duration::from_millis(200), updated.next())
        .await
        .is_ok()
    {}
    env.gsettings_set(
        "org.gnome.desktop.wm.preferences",
        "button-layout",
        "close,minimize,maximize:",
    );
    let signal = tokio::time::timeout(Duration::from_secs(5), updated.next())
        .await
        .unwrap()
        .unwrap();
    let (_, r, values): Updated = signal.body().deserialize().unwrap();
    assert!(r > before.1);
    assert_eq!(
        String::try_from(values["appearance.windowControls"].clone()).unwrap(),
        "left"
    );
    // The wallpaper file, written by somebody else.
    std::fs::write(
        env.dir.join("config/nidara/wallpaper"),
        r#"{"path":"","transition":"wave"}"#,
    )
    .unwrap();
    let mut heard = None;
    for _ in 0..5 {
        let Ok(Some(signal)) = tokio::time::timeout(Duration::from_secs(5), updated.next()).await
        else {
            break;
        };
        let (_, _, values): Updated = signal.body().deserialize().unwrap();
        if let Some(v) = values.get("wallpaper.transition") {
            heard = Some(String::try_from(v.clone()).unwrap());
            break;
        }
    }
    assert_eq!(heard.as_deref(), Some("wave"));
    // Revocation is effective on the same connection, even while it owns SettingsNative.
    env.gsettings_set("org.nidara.ai", "allow-computer-control", "false");
    let denied = call::<()>(&conn, "Set", &("appearance.darkMode", Value::from(false))).await;
    assert_eq!(
        error_name(denied.unwrap_err()),
        "org.nidara.Config1.Error.AccessDenied"
    );
    let values: HashMap<String, OwnedValue> = call(&conn, "Get", &(vec!["appearance.darkMode"],))
        .await
        .unwrap();
    assert!(bool::try_from(values["appearance.darkMode"].clone()).unwrap());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_second_server_leaves_the_name_alone() {
    let mut env = setup();
    let conn = connect(&env.address).await;
    // Somebody else (the TypeScript shell, in its session) already serves it.
    conn.request_name("org.nidara.Config").await.unwrap();
    env.start();
    tokio::time::sleep(Duration::from_millis(500)).await;
    let daemon = env.daemon.as_mut().unwrap();
    assert!(
        daemon.try_wait().unwrap().is_none(),
        "the daemon keeps serving notifications"
    );
    let dbus = zbus::fdo::DBusProxy::new(&conn).await.unwrap();
    let owner = dbus
        .get_name_owner("org.nidara.Config".try_into().unwrap())
        .await
        .unwrap();
    assert_eq!(owner.as_str(), conn.unique_name().unwrap().as_str());
}

#[tokio::test(flavor = "multi_thread")]
async fn a_key_its_schema_lacks_is_unavailable_not_fatal() {
    // GLib aborts the process on a key the schema lacks; an older GNOME has no accent-color.
    let mut env = setup_without(Some("accent-color"));
    env.gsettings_set("org.nidara.ai", "allow-computer-control", "true");
    env.start();
    let conn = connect(&env.address).await;
    wait_for_config(&conn).await;
    let (_, _, schema): (u64, u64, String) = call(&conn, "Snapshot", &()).await.unwrap();
    let schema: serde_json::Value = serde_json::from_str(&schema).unwrap();
    assert_eq!(schema["keys"]["appearance.accent"]["available"], false);
    assert_eq!(schema["keys"]["appearance.darkMode"]["available"], true);
    let err =
        call::<(u64, OwnedValue)>(&conn, "Apply", &("appearance.accent", Value::from("teal")))
            .await
            .unwrap_err();
    assert_eq!(error_name(err), "org.nidara.Config1.Error.Invalid");
    assert!(env.daemon.as_mut().unwrap().try_wait().unwrap().is_none());
}

/// Protocol peer, not an implementation of the effects: records requests and can refuse
/// them. Real Hyalo is checked separately in the nested session.
struct HyaloPeer {
    path: PathBuf,
    requests: std::sync::mpsc::Receiver<serde_json::Value>,
    pending: std::sync::Mutex<Vec<serde_json::Value>>,
    refuse: std::sync::Arc<std::sync::atomic::AtomicBool>,
    config: std::sync::Arc<std::sync::Mutex<serde_json::Value>>,
    ignore_input: std::sync::Arc<std::sync::atomic::AtomicBool>,
    events: std::sync::mpsc::Receiver<std::os::unix::net::UnixStream>,
    thread: Option<std::thread::JoinHandle<()>>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl HyaloPeer {
    fn new(path: PathBuf) -> Self {
        Self::with_input(path, serde_json::Value::Null)
    }
    fn with_input(path: PathBuf, input: serde_json::Value) -> Self {
        use std::io::{BufRead, Write};
        use std::sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        };
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let (tx, requests) = std::sync::mpsc::channel();
        let (events_tx, events) = std::sync::mpsc::channel();
        let refuse = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let config = Arc::new(std::sync::Mutex::new(if input.is_null() {
            serde_json::Value::Null
        } else {
            serde_json::json!({"input":input})
        }));
        let ignore_input = Arc::new(AtomicBool::new(false));
        let (cfg, ignore) = (config.clone(), ignore_input.clone());
        let (r, s) = (refuse.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !s.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut line = String::new();
                        std::io::BufReader::new(stream.try_clone().unwrap())
                            .read_line(&mut line)
                            .unwrap();
                        let value: serde_json::Value = serde_json::from_str(&line).unwrap();
                        if value["request"] == "event_stream" {
                            let _ = events_tx.send(stream);
                            continue;
                        }
                        let reply = if r.load(Ordering::Relaxed) {
                            serde_json::json!({"error":"injected refusal"})
                        } else {
                            let mut config = cfg.lock().unwrap();
                            if value["request"] == "config" && !config.is_null() {
                                serde_json::json!({"ok":{"config":*config}})
                            } else {
                                if !ignore.load(Ordering::Relaxed)
                                    && let Some(sections) = value["patch"]["input"].as_object()
                                {
                                    for (section, fields) in sections {
                                        for (key, v) in fields.as_object().unwrap() {
                                            config["input"][section][key] = v.clone();
                                        }
                                    }
                                }
                                serde_json::json!({"ok":{"kind":"handled"}})
                            }
                        };
                        let _ = stream.write_all(format!("{reply}\n").as_bytes());
                        let _ = tx.send(value);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(5))
                    }
                    Err(e) => panic!("peer: {e}"),
                }
            }
        });
        Self {
            path,
            requests,
            pending: std::sync::Mutex::new(Vec::new()),
            refuse,
            config,
            ignore_input,
            events,
            thread: Some(thread),
            stop,
        }
    }
    async fn expect(&self, expected: serde_json::Value) {
        for _ in 0..700 {
            let found = {
                let mut pending = self.pending.lock().unwrap();
                pending.extend(self.requests.try_iter());
                pending
                    .iter()
                    .position(|value| *value == expected)
                    .map(|i| pending.remove(i))
                    .is_some()
            };
            if found {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("follower never sent {expected}");
    }
}
impl Drop for HyaloPeer {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Relaxed);
        self.thread.take().unwrap().join().unwrap();
        let _ = std::fs::remove_file(&self.path);
    }
}
async fn eventually(label: &str, test: impl Fn() -> bool) {
    for _ in 0..700 {
        if test() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{label}");
}
fn ini(env: &Env, toolkit: &str, key: &str) -> Option<String> {
    let kf = glib::KeyFile::new();
    kf.load_from_file(
        env.dir.join("config").join(toolkit).join("settings.ini"),
        glib::KeyFileFlags::NONE,
    )
    .ok()?;
    kf.string("Settings", key).ok().map(|s| s.to_string())
}

#[tokio::test(flavor = "multi_thread")]
async fn followers_apply_initial_values_changes_retries_and_reconnect() {
    use serde_json::json;
    use std::io::Write;
    use std::os::unix::fs::PermissionsExt;
    let mut env = setup();
    let peer = HyaloPeer::new(env.dir.join("hyalo"));
    let bin = env.dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let awww = bin.join("awww");
    std::fs::write(
        &awww,
        r#"#!/usr/bin/env python3
import json, os, sys
with open(os.path.join(os.environ['HOME'], 'awww-calls'), 'a') as f:
    f.write(json.dumps(sys.argv[1:]) + '\n')
if os.path.exists(os.path.join(os.environ['HOME'], 'awww-refuse')):
    sys.exit(1)
"#,
    )
    .unwrap();
    std::fs::set_permissions(&awww, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::create_dir_all(env.dir.join("config/gtk-4.0")).unwrap();
    std::fs::write(
        env.dir.join("config/gtk-4.0/settings.ini"),
        "# user settings\n[Settings]\ngtk-enable-animations=false\n[Other]\ncustom=preserved\n",
    )
    .unwrap();
    env.gsettings_set(
        "org.gnome.desktop.interface",
        "cursor-theme",
        "'TestCursor'",
    );
    env.gsettings_set("org.gnome.desktop.interface", "cursor-size", "32");
    env.gsettings_set("org.gnome.desktop.interface", "enable-animations", "false");
    env.gsettings_set("org.nidara.night-light", "enabled", "true");
    env.gsettings_set("org.nidara.night-light", "temperature", "4300");
    let image = env.dir.join("an image;literal.png");
    std::fs::write(&image, b"fixture").unwrap();
    std::fs::write(
        env.dir.join("config/nidara/wallpaper"),
        json!({"path":image,"transition":"fade"}).to_string(),
    )
    .unwrap();
    let mut cmd = Command::new(env!("CARGO_BIN_EXE_nidara-sessiond"));
    cmd.arg("--config");
    env.vars(&mut cmd);
    cmd.env("HYALO_SOCKET", &peer.path)
        .env("WAYLAND_DISPLAY", "isolated-test")
        .env(
            "PATH",
            format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()),
        );
    env.daemon = Some(cmd.spawn().unwrap());
    let conn = connect(&env.address).await;
    wait_for_config(&conn).await;
    let cursor = json!({"request":"settings","patch":{"cursor":{"theme":"TestCursor","size":32}}});
    peer.expect(cursor.clone()).await;
    let reduce = json!({"request":"settings","patch":{"animations":{"enabled":false}}});
    let restore = json!({"request":"settings","patch":{"animations":{"enabled":null}}});
    peer.expect(reduce.clone()).await;
    // Another writer changes the existing GSettings home; restoring removes the key.
    env.gsettings_set("org.gnome.desktop.interface", "enable-animations", "true");
    peer.expect(restore.clone()).await;

    peer.expect(json!({"request":"night_light","temperature":4300}))
        .await;
    eventually("initial GTK values and preserved keys", || {
        ini(&env, "gtk-4.0", "gtk-cursor-theme-size").as_deref() == Some("32")
            && ini(&env, "gtk-4.0", "gtk-enable-animations").as_deref() == Some("false")
            && ini(&env, "gtk-3.0", "gtk-cursor-theme-name").as_deref() == Some("TestCursor")
    })
    .await;
    let calls = || {
        std::fs::read_to_string(env.dir.join("awww-calls"))
            .unwrap_or_default()
            .lines()
            .filter_map(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .collect::<Vec<_>>()
    };
    // On Hyalo the compositor draws the wallpaper: it is told, and no program is run.
    peer.expect(json!({"request":"wallpaper","path":image,"transition":"fade"}))
        .await;
    let wallpapers = || {
        let mut pending = peer.pending.lock().unwrap();
        pending.extend(peer.requests.try_iter());
        pending
            .iter()
            .filter(|value| value["request"] == "wallpaper")
            .count()
    };
    // Failed effects must retry without needing another Config1 change.
    peer.refuse
        .store(true, std::sync::atomic::Ordering::Relaxed);
    let _: (u64, OwnedValue) = call(
        &conn,
        "Apply",
        &("nightlight.temperature", OwnedValue::from(4700.)),
    )
    .await
    .unwrap();
    peer.expect(json!({"request":"night_light","temperature":4700}))
        .await;
    peer.refuse
        .store(false, std::sync::atomic::Ordering::Relaxed);
    peer.expect(json!({"request":"night_light","temperature":4700}))
        .await;
    // Another writer, not Apply, must drive both the compositor and the GTK files.
    env.gsettings_set("org.gnome.desktop.interface", "cursor-size", "48");
    peer.expect(json!({"request":"settings","patch":{"cursor":{"theme":"TestCursor","size":48}}}))
        .await;
    // An app that sets the wallpaper the GNOME way (no portal): its picture becomes the
    // wallpaper and Hyalo is told; a key that names no usable picture changes nothing.
    let by_app = env.dir.join("set-by-an-app.png");
    std::fs::write(&by_app, b"fixture").unwrap();
    env.gsettings_set(
        "org.gnome.desktop.background",
        "picture-uri",
        &format!("'file://{}'", by_app.display()),
    );
    peer.expect(json!({"request":"wallpaper","path":by_app,"transition":"fade"}))
        .await;
    let saved = || {
        let text = std::fs::read_to_string(env.dir.join("config/nidara/wallpaper")).unwrap();
        serde_json::from_str::<serde_json::Value>(&text).unwrap()["path"].clone()
    };
    assert_eq!(saved(), json!(by_app));
    env.gsettings_set(
        "org.gnome.desktop.background",
        "picture-uri",
        "'file:///no/such/picture.png'",
    );
    tokio::time::sleep(std::time::Duration::from_millis(400)).await;
    assert_eq!(saved(), json!(by_app), "a missing picture is not adopted");
    env.gsettings_set(
        "org.gnome.desktop.interface",
        "color-scheme",
        "'prefer-dark'",
    );
    eventually("external dark mode reflected in both GTK versions", || {
        ["gtk-3.0", "gtk-4.0"]
            .iter()
            .all(|t| ini(&env, t, "gtk-application-prefer-dark-theme").as_deref() == Some("1"))
    })
    .await;
    let _: (u64, OwnedValue) = call(
        &conn,
        "Apply",
        &("nightlight.enabled", OwnedValue::from(false)),
    )
    .await
    .unwrap();
    peer.expect(json!({"request":"night_light","temperature":null}))
        .await;
    // Enabling a schedule applies its current position once; an equal window is always empty.
    for key in ["nightlight.scheduleFrom", "nightlight.scheduleTo"] {
        let _: (u64, OwnedValue) = call(
            &conn,
            "Apply",
            &(key, OwnedValue::try_from(Value::from("00:00")).unwrap()),
        )
        .await
        .unwrap();
    }
    let _: (u64, OwnedValue) = call(
        &conn,
        "Apply",
        &("nightlight.enabled", OwnedValue::from(true)),
    )
    .await
    .unwrap();
    peer.expect(json!({"request":"night_light","temperature":4700}))
        .await;
    let _: (u64, OwnedValue) = call(
        &conn,
        "Apply",
        &("nightlight.scheduleEnabled", OwnedValue::from(true)),
    )
    .await
    .unwrap();
    peer.expect(json!({"request":"night_light","temperature":null}))
        .await;
    let enabled: HashMap<String, OwnedValue> = call(&conn, "Get", &(vec!["nightlight.enabled"],))
        .await
        .unwrap();
    assert!(
        !bool::try_from(&enabled["nightlight.enabled"]).unwrap(),
        "schedule writes its decision back to Config1's home"
    );
    // An enabled notification must not be mistaken for a schedule edit. In the empty
    // window a manual on is kept until a boundary/edit (clock transitions are unit-tested
    // with explicit minutes rather than depending on the wall clock or a minute-long sleep).
    let _: (u64, OwnedValue) = call(
        &conn,
        "Apply",
        &("nightlight.enabled", OwnedValue::from(true)),
    )
    .await
    .unwrap();
    peer.expect(json!({"request":"night_light","temperature":4700}))
        .await;
    let enabled: HashMap<String, OwnedValue> = call(&conn, "Get", &(vec!["nightlight.enabled"],))
        .await
        .unwrap();
    assert!(
        bool::try_from(&enabled["nightlight.enabled"]).unwrap(),
        "manual on survives its own notification"
    );
    let _: (u64, OwnedValue) = call(
        &conn,
        "Apply",
        &("nightlight.enabled", OwnedValue::from(false)),
    )
    .await
    .unwrap();
    peer.expect(json!({"request":"night_light","temperature":null}))
        .await;
    // A wallpaper refusal retries the current transition; writing the home externally is heard.
    peer.refuse
        .store(true, std::sync::atomic::Ordering::Relaxed);
    std::fs::write(
        env.dir.join("config/nidara/wallpaper"),
        json!({"path":image,"transition":"wipe"}).to_string(),
    )
    .unwrap();
    let expected = json!({"request":"wallpaper","path":image,"transition":"wipe"});
    peer.expect(expected.clone()).await;
    peer.refuse
        .store(false, std::sync::atomic::Ordering::Relaxed);
    peer.expect(expected).await;
    // Discard earlier motion requests so each assertion proves a fresh reload/reconnect.
    let clear_motion = || {
        let mut pending = peer.pending.lock().unwrap();
        pending.extend(peer.requests.try_iter());
        pending.retain(|v| v["patch"].get("animations").is_none());
    };
    clear_motion();
    // Hotplug restates output-dependent effects; reconnect also restores the cursor.
    let mut stream = peer.events.recv_timeout(Duration::from_secs(2)).unwrap();
    stream
        .write_all(b"{\"event\":\"outputs_changed\",\"outputs\":[]}\n")
        .unwrap();
    peer.expect(json!({"request":"night_light","temperature":null}))
        .await;
    peer.expect(restore.clone()).await;
    env.gsettings_set("org.gnome.desktop.interface", "enable-animations", "false");
    peer.expect(reduce.clone()).await;
    clear_motion();
    stream
        .write_all(b"{\"event\":\"outputs_changed\",\"outputs\":[]}\n")
        .unwrap();
    peer.expect(reduce.clone()).await;
    clear_motion();
    drop(stream);
    peer.expect(json!({"request":"settings","patch":{"cursor":{"theme":"TestCursor","size":48}}}))
        .await;
    peer.expect(json!({"request":"night_light","temperature":null}))
        .await;
    peer.expect(reduce).await;
    // A no-op must not rewrite the INI or reapply wallpaper after it has settled.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let file = env.dir.join("config/gtk-4.0/settings.ini");
    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
    let before = wallpapers();
    let _: (u64, OwnedValue) = call(
        &conn,
        "Apply",
        &("nightlight.enabled", OwnedValue::from(false)),
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        std::fs::metadata(file).unwrap().modified().unwrap(),
        modified
    );
    assert_eq!(wallpapers(), before);
    assert!(
        calls().is_empty(),
        "with Hyalo there, no wallpaper program is run"
    );
}

#[tokio::test]
async fn media_preferences_and_optional_audio_backend() {
    let mut env = setup();
    let mut command = Command::new(env!("CARGO_BIN_EXE_nidara-sessiond"));
    command.args(["--config", "--media"]);
    env.vars(&mut command);
    env.daemon = Some(command.spawn().unwrap());
    let conn = connect(&env.address).await;
    wait_for_config(&conn).await;
    // Config1 is registered earlier than Media. Do not initialize zbus' property
    // cache before the session readiness name exists: a failed initial GetAll is
    // cached permanently, so polling that same proxy never recovers.
    let dbus = zbus::fdo::DBusProxy::new(&conn).await.unwrap();
    let media = tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if dbus
                .name_has_owner("org.nidara.Session".try_into().unwrap())
                .await
                .unwrap()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        let media = zbus::Proxy::new(
            &conn,
            "org.nidara.Session",
            "/org/nidara/Media",
            "org.nidara.Media1",
        )
        .await
        .unwrap();
        assert_eq!(
            media.get_property::<String>("State").await.unwrap(),
            "Ready"
        );
        media
    })
    .await
    .expect("the selected services never announced session readiness");
    assert!(
        !media
            .get_property::<bool>("HeadphonePauseAvailable")
            .await
            .unwrap()
    );
    assert!(
        !media
            .get_property::<Vec<String>>("Capabilities")
            .await
            .unwrap()
            .iter()
            .any(|s| s == "headphone-fallback")
    );
    assert!(
        media
            .get_property::<String>("LastError")
            .await
            .unwrap()
            .is_empty()
    );
    for (key, property) in [
        ("media.lock-screen-controls", "LockScreenControls"),
        (
            "media.pause-on-headphones-disconnect",
            "PauseOnHeadphonesDisconnect",
        ),
    ] {
        assert!(media.get_property::<bool>(property).await.unwrap());
        let (_, value): (u64, OwnedValue) = call(&conn, "Apply", &(key, Value::from(false)))
            .await
            .unwrap();
        assert!(!bool::try_from(value).unwrap());
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if !media.get_property::<bool>(property).await.unwrap() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        env.gsettings_set(
            "org.nidara.media",
            key.strip_prefix("media.").unwrap(),
            "true",
        );
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if media.get_property::<bool>(property).await.unwrap() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn power_homes_and_effective_compositor_settings() {
    use futures_util::StreamExt;
    use std::sync::{Arc, Mutex};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let mut env = setup();
    let listener = tokio::net::UnixListener::bind(env.dir.join("hyalo.sock")).unwrap();
    let idle = Arc::new(Mutex::new(
        serde_json::json!({"screen_off":300,"lock":600,"suspend_battery":0,"suspend_ac":0,"dim_before_off":10}),
    ));
    let state = idle.clone();
    let requests = Arc::new(Mutex::new(Vec::new()));
    let calls = requests.clone();
    let task = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let state = state.clone();
            let calls = calls.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut lines = tokio::io::BufReader::new(read).lines();
                let line = lines.next_line().await.unwrap().unwrap();
                let request: serde_json::Value = serde_json::from_str(&line).unwrap();
                let reply = {
                    let mut idle = state.lock().unwrap();
                    calls.lock().unwrap().push(request.clone());
                    if request["request"] == "settings" {
                        if let Some(fields) = request["patch"]["idle"].as_object() {
                            for (key, value) in fields {
                                if key != "lock" {
                                    idle[key] = value.clone();
                                }
                            }
                        }
                        serde_json::json!({"ok":{}})
                    } else {
                        serde_json::json!({"ok":{"config":{"idle":*idle}}})
                    }
                };
                write
                    .write_all(format!("{reply}\n").as_bytes())
                    .await
                    .unwrap();
            });
        }
    });
    env.start();
    let conn = connect(&env.address).await;
    wait_for_config(&conn).await;
    let proxy = zbus::Proxy::new(
        &conn,
        "org.nidara.Config",
        "/org/nidara/Config",
        "org.nidara.Config1",
    )
    .await
    .unwrap();
    let mut updated = proxy.receive_signal("Updated").await.unwrap();
    let (_, _, schema): (u64, u64, String) = call(&conn, "Snapshot", &()).await.unwrap();
    let schema: serde_json::Value = serde_json::from_str(&schema).unwrap();
    assert_eq!(schema["keys"]["power.automatic-saver"]["value"], true);
    assert_eq!(schema["keys"]["power.power-button-action"]["value"], "menu");
    assert_eq!(schema["keys"]["power.lid-action-on-ac"]["value"], "suspend");
    assert_eq!(schema["keys"]["power.screen-off-seconds"]["value"], 300.0);
    let (revision, value): (u64, OwnedValue) = call(
        &conn,
        "Apply",
        &("power.suspend-ac-seconds", Value::from(60.)),
    )
    .await
    .unwrap();
    assert_eq!(f64::try_from(value).unwrap(), 60.);
    assert!(revision > 0);
    assert_eq!(idle.lock().unwrap()["suspend_ac"], 60);
    assert_eq!(idle.lock().unwrap()["suspend_battery"], 0);
    let error =
        call::<(u64, OwnedValue)>(&conn, "Apply", &("power.lock-seconds", Value::from(30.)))
            .await
            .unwrap_err();
    assert!(error.to_string().contains("overridden"));
    assert_eq!(idle.lock().unwrap()["lock"], 600);
    // The effective value, from another compositor writer, is announced independently.
    idle.lock().unwrap()["screen_off"] = serde_json::json!(450);
    let mut heard = false;
    for _ in 0..10 {
        let next = tokio::time::timeout(Duration::from_secs(5), updated.next())
            .await
            .unwrap()
            .unwrap();
        let (_, _, values): Updated = next.body().deserialize().unwrap();
        if values
            .get("power.screen-off-seconds")
            .is_some_and(|v| f64::try_from(v).ok() == Some(450.))
        {
            heard = true;
            break;
        }
    }
    assert!(heard);
    assert!(
        requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r["request"] == "settings")
    );
    assert!(
        !env.dir.join("config/nidara/hyalo-settings.toml").exists(),
        "only the compositor may persist its layer"
    );
    env.gsettings_set("org.nidara.power", "show-percentage", "false");
    let mut heard = false;
    for _ in 0..10 {
        let next = tokio::time::timeout(Duration::from_secs(5), updated.next())
            .await
            .unwrap()
            .unwrap();
        let (_, _, values): Updated = next.body().deserialize().unwrap();
        if values
            .get("power.show-percentage")
            .is_some_and(|v| bool::try_from(v).ok() == Some(false))
        {
            heard = true;
            break;
        }
    }
    assert!(heard);
    task.abort();
}

#[tokio::test(flavor = "multi_thread")]
async fn ordinary_pages_share_homes_and_hyalo_is_the_only_input_writer() {
    use serde_json::json;
    let mut env = setup();
    let peer = HyaloPeer::with_input(
        env.dir.join("hyalo.sock"),
        json!({
            "pointer":{"accel_speed":0.0,"accel_profile":"adaptive","natural_scroll":false},
            "touchpad":{"accel_speed":0.0,"accel_profile":"adaptive","natural_scroll":false,"tap":false},
            "keyboard":{"layout":"us","variant":"","numlock":false,"repeat_delay":600,"repeat_rate":25}
        }),
    );
    env.start();
    let conn = connect(&env.address).await;
    wait_for_config(&conn).await;
    let (_, _, raw): (u64, u64, String) = call(&conn, "Snapshot", &()).await.unwrap();
    let schema: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let expected = [
        "notifications.doNotDisturb",
        "notifications.popupTimeout",
        "accessibility.textScale",
        "accessibility.cursorSize",
        "accessibility.reduceMotion",
        "input.mouse.speed",
        "input.mouse.accel",
        "input.mouse.natural",
        "input.touchpad.natural",
        "input.touchpad.tap",
        "input.keyboard.layout",
        "input.keyboard.numlock",
        "input.keyboard.repeatDelay",
        "input.keyboard.repeatRate",
    ];
    for key in expected {
        assert_eq!(schema["keys"][key]["available"], true, "{key}");
        assert!(schema["keys"][key]["ui"]["control"].is_string(), "{key}");
    }
    let layout = &schema["keys"]["input.keyboard.layout"];
    assert!(
        layout["values"]
            .as_array()
            .unwrap()
            .contains(&json!("us-colemak"))
    );
    assert!(
        !layout["values"]
            .as_array()
            .unwrap()
            .contains(&json!("custom"))
    );
    assert_eq!(schema["keys"]["input.keyboard.repeatDelay"]["max"], 2000.);
    for (key, value, canonical) in [
        (
            "notifications.doNotDisturb",
            OwnedValue::from(true),
            json!(true),
        ),
        (
            "notifications.popupTimeout",
            OwnedValue::from(5.6f64),
            json!(6.),
        ),
        (
            "accessibility.textScale",
            OwnedValue::from(1.237f64),
            json!(1.24),
        ),
        (
            "accessibility.cursorSize",
            OwnedValue::from(31.5f64),
            json!(32.),
        ),
        (
            "accessibility.reduceMotion",
            OwnedValue::from(true),
            json!(true),
        ),
        ("input.mouse.speed", OwnedValue::from(0.4f64), json!(0.4)),
        (
            "input.mouse.accel",
            OwnedValue::try_from(Value::from("flat")).unwrap(),
            json!("flat"),
        ),
        ("input.mouse.natural", OwnedValue::from(true), json!(true)),
        (
            "input.touchpad.natural",
            OwnedValue::from(true),
            json!(true),
        ),
        ("input.touchpad.tap", OwnedValue::from(true), json!(true)),
        (
            "input.keyboard.layout",
            OwnedValue::try_from(Value::from("us-colemak")).unwrap(),
            json!("us-colemak"),
        ),
        (
            "input.keyboard.numlock",
            OwnedValue::from(true),
            json!(true),
        ),
        (
            "input.keyboard.repeatDelay",
            OwnedValue::from(501.6f64),
            json!(502.),
        ),
        (
            "input.keyboard.repeatRate",
            OwnedValue::from(30.5f64),
            json!(31.),
        ),
    ] {
        let (_, result): (u64, OwnedValue) = call(&conn, "Apply", &(key, value)).await.unwrap();
        let result = if let Ok(v) = bool::try_from(&result) {
            json!(v)
        } else if let Ok(v) = f64::try_from(&result) {
            json!(v)
        } else {
            json!(String::try_from(result).unwrap())
        };
        assert_eq!(result, canonical, "{key}");
    }
    let input = peer.config.lock().unwrap()["input"].clone();
    assert_eq!(input["pointer"]["accel_speed"], 0.4);
    assert_eq!(input["touchpad"]["accel_speed"], 0.4);
    assert_eq!(input["keyboard"]["variant"], "colemak");
    assert_eq!(input["keyboard"]["repeat_delay"], 502);
    assert!(
        !env.dir.join("config/nidara/hyalo-settings.toml").exists(),
        "sessiond must never write Hyalo's settings file"
    );
    for (name, key, value) in [
        ("org.nidara.notifications", "do-not-disturb", "true"),
        ("org.nidara.notifications", "popup-timeout", "6"),
        ("org.gnome.desktop.interface", "text-scaling-factor", "1.24"),
        ("org.gnome.desktop.interface", "cursor-size", "32"),
        ("org.gnome.desktop.interface", "enable-animations", "false"),
    ] {
        let mut command = Command::new("gsettings");
        command.args(["get", name, key]);
        env.vars(&mut command);
        let out = command.output().unwrap();
        assert!(out.status.success());
        assert_eq!(String::from_utf8(out.stdout).unwrap().trim(), value);
    }
    for (key, value) in [
        ("input.mouse.speed", OwnedValue::from(1.1f64)),
        ("input.keyboard.repeatDelay", OwnedValue::from(99.9f64)),
        (
            "input.keyboard.layout",
            OwnedValue::try_from(Value::from("custom")).unwrap(),
        ),
    ] {
        assert_eq!(
            error_name(
                call::<(u64, OwnedValue)>(&conn, "Apply", &(key, value))
                    .await
                    .unwrap_err()
            ),
            "org.nidara.Config1.Error.Invalid"
        );
    }
    // A successful RPC is not success when the user's later layer wins.
    peer.ignore_input
        .store(true, std::sync::atomic::Ordering::Relaxed);
    assert_eq!(
        error_name(
            call::<(u64, OwnedValue)>(
                &conn,
                "Apply",
                &("input.mouse.speed", OwnedValue::from(0.8f64))
            )
            .await
            .unwrap_err()
        ),
        "org.nidara.Config1.Error.Failed"
    );
    assert_eq!(
        peer.config.lock().unwrap()["input"]["pointer"]["accel_speed"],
        0.4
    );
    peer.ignore_input
        .store(false, std::sync::atomic::Ordering::Relaxed);
    // Another writer changes the compositor: the existing monitor refreshes Config1.
    peer.config.lock().unwrap()["input"]["pointer"]["accel_speed"] = json!(0.6);
    for n in 0..80 {
        let values: HashMap<String, OwnedValue> = call(&conn, "Get", &(vec!["input.mouse.speed"],))
            .await
            .unwrap();
        if f64::try_from(values.get("input.mouse.speed").unwrap()).unwrap() == 0.6 {
            break;
        }
        assert!(n < 79, "external Hyalo input change was not observed");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn ordinary_keys_are_unavailable_when_their_home_is_missing() {
    let mut env = setup_without(Some("text-scaling-factor"));
    env.start();
    let conn = connect(&env.address).await;
    wait_for_config(&conn).await;
    let (_, _, raw): (u64, u64, String) = call(&conn, "Snapshot", &()).await.unwrap();
    let schema: serde_json::Value = serde_json::from_str(&raw).unwrap();
    for key in [
        "accessibility.textScale",
        "input.mouse.speed",
        "input.keyboard.layout",
    ] {
        assert_eq!(schema["keys"][key]["available"], false, "{key}");
        assert!(
            schema["keys"][key].get("value").is_none(),
            "no invented effective value for {key}"
        );
    }
    assert_eq!(
        schema["keys"]["notifications.doNotDisturb"]["available"],
        true
    );
}
