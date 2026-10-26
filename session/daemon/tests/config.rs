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
    setup_without(None)
}

impl Env {
    fn vars(&self, cmd: &mut Command) {
        cmd.env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("DBUS_SESSION_BUS_ADDRESS", &self.address)
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
    // The gate is open by default; closed here, so an agent's write is refused.
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
        "org.nidara.Config1.Error.Denied"
    );

    // The native Settings writes freely.
    conn.request_name("org.nidara.SettingsNative")
        .await
        .unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let (rev, value): (u64, OwnedValue) =
        call(&conn, "Apply", &("appearance.darkMode", Value::from(true)))
            .await
            .unwrap();
    assert_eq!(rev, 1);
    assert!(bool::try_from(value).unwrap());
    use futures_util::StreamExt;
    let signal = tokio::time::timeout(Duration::from_secs(5), updated.next())
        .await
        .unwrap()
        .unwrap();
    let (e, r, values): Updated = signal.body().deserialize().unwrap();
    assert_eq!((e, r), (epoch, 1));
    assert!(bool::try_from(values["appearance.darkMode"].clone()).unwrap());

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

    // A no-op answers the current revision and announces nothing.
    let before: (u64, u64, String) = call(&conn, "Snapshot", &()).await.unwrap();
    let (rev, _): (u64, OwnedValue) =
        call(&conn, "Apply", &("appearance.darkMode", Value::from(true)))
            .await
            .unwrap();
    assert_eq!(rev, before.1);

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
/// them. Real Hyalo + awww are checked separately in the nested session.
struct HyaloPeer {
    path: PathBuf,
    requests: std::sync::mpsc::Receiver<serde_json::Value>,
    pending: std::sync::Mutex<Vec<serde_json::Value>>,
    refuse: std::sync::Arc<std::sync::atomic::AtomicBool>,
    events: std::sync::mpsc::Receiver<std::os::unix::net::UnixStream>,
    thread: Option<std::thread::JoinHandle<()>>,
    stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
}
impl HyaloPeer {
    fn new(path: PathBuf) -> Self {
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
                            "{\"error\":\"injected refusal\"}\n"
                        } else {
                            "{\"ok\":{\"kind\":\"handled\"}}\n"
                        };
                        let _ = stream.write_all(reply.as_bytes());
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
    let expected = json!(["img", image, "--transition-type", "fade"]);
    eventually("initial wallpaper applied with literal argv", || {
        calls().contains(&expected)
    })
    .await;
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
    // The clock owns enabled while scheduled; an equal window is always empty.
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
    // A wallpaper refusal retries the current transition; writing the home externally is heard.
    std::fs::write(env.dir.join("awww-refuse"), b"1").unwrap();
    std::fs::write(
        env.dir.join("config/nidara/wallpaper"),
        json!({"path":image,"transition":"wipe"}).to_string(),
    )
    .unwrap();
    let expected = json!(["img", image, "--transition-type", "wipe"]);
    eventually("external wallpaper change attempted", || {
        calls().contains(&expected)
    })
    .await;
    let before = calls().len();
    std::fs::remove_file(env.dir.join("awww-refuse")).unwrap();
    eventually("failed wallpaper retried", || calls().len() > before).await;
    // Hotplug and a fresh event connection both restate runtime effects.
    let mut stream = peer.events.recv_timeout(Duration::from_secs(2)).unwrap();
    stream
        .write_all(b"{\"event\":\"outputs_changed\",\"outputs\":[]}\n")
        .unwrap();
    peer.expect(json!({"request":"night_light","temperature":null}))
        .await;
    drop(stream);
    peer.expect(json!({"request":"night_light","temperature":null}))
        .await;
    // A no-op must not rewrite the INI or reapply wallpaper after it has settled.
    tokio::time::sleep(Duration::from_millis(100)).await;
    let file = env.dir.join("config/gtk-4.0/settings.ini");
    let modified = std::fs::metadata(&file).unwrap().modified().unwrap();
    let before = calls().len();
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
    assert_eq!(calls().len(), before);
}
