// SPDX-License-Identifier: GPL-3.0-or-later
//! Every test owns its bus and sockets. No request reaches the user's session.
use nidara_shell_ipc::{Error, State, SurfaceState};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    os::unix::net::UnixListener,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use zbus::{blocking::Connection, zvariant::OwnedValue};

struct Bus {
    child: Child,
    address: String,
}
impl Bus {
    fn new() -> Self {
        let mut child = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut address = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        Self {
            child,
            address: address.trim().into(),
        }
    }
    fn cli(&self, args: &[&str]) -> std::process::Output {
        self.cli_env(args, None)
    }
    fn cli_env(&self, args: &[&str], session: Option<&str>) -> std::process::Output {
        let mut cli = Command::new(env!("CARGO_BIN_EXE_nidara-ipc"));
        cli.env("DBUS_SESSION_BUS_ADDRESS", &self.address)
            .env_remove("NIDARA_SESSION")
            .env_remove("HYALO_SOCKET");
        if let Some(session) = session {
            cli.env("NIDARA_SESSION", session);
        }
        cli.args(args).output().unwrap()
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
#[derive(Clone)]
struct Legacy(Arc<Mutex<Vec<Vec<String>>>>);
#[zbus::interface(name = "org.nidara.Shell")]
impl Legacy {
    fn request(&self, args: Vec<String>) -> String {
        self.0.lock().unwrap().push(args);
        "{\"verbatim\": \"%s \\n ü\"}".into()
    }
}
#[derive(Clone)]
struct Shell(Arc<Mutex<Vec<String>>>);
#[zbus::interface(name = "org.nidara.Shell1")]
impl Shell {
    #[zbus(property)]
    fn available(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<&str> {
        vec!["surface:cc", "focus:bar", "settings", "osd:volume"]
    }
    fn get_state(&self) -> State {
        State {
            locked: false,
            surfaces: vec![SurfaceState {
                name: "cc".into(),
                visible: false,
            }],
            island: String::new(),
        }
    }
    fn toggle_surface(&self, surface: &str, keyboard: bool) -> Result<(), Error> {
        self.0
            .lock()
            .unwrap()
            .push(format!("toggle:{surface}:{keyboard}"));
        Err(Error::AccessDenied("injected server denial".into()))
    }
    fn show_osd(&self, _kind: &str, _value: f64, _muted: bool, _label: &str) -> Result<(), Error> {
        Err(Error::Unavailable("fixture lock active".into()))
    }
    fn focus_surface(&self, surface: &str) {
        self.0.lock().unwrap().push(format!("focus:{surface}"));
    }
    fn open_settings(&self, page: &str, app: &str) {
        self.0
            .lock()
            .unwrap()
            .push(format!("settings:{page}:{app}"));
    }
}
fn conn(bus: &Bus) -> Connection {
    zbus::blocking::connection::Builder::address(bus.address.as_str())
        .unwrap()
        .build()
        .unwrap()
}
fn stderr(out: &std::process::Output) -> String {
    String::from_utf8_lossy(&out.stderr).into()
}

#[test]
fn ts_verbatim_and_native_never_retry_into_ts() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let _entered = runtime.enter();
    let bus = Bus::new();
    let calls = Arc::new(Mutex::new(vec![]));
    let native = Arc::new(Mutex::new(vec![]));
    let c = conn(&bus);
    c.object_server()
        .at("/org/nidara/Shell", Legacy(calls.clone()))
        .unwrap();
    c.object_server()
        .at("/org/nidara/Shell", Shell(native.clone()))
        .unwrap();
    c.request_name("org.nidara.Shell").unwrap();
    let proxy = nidara_shell_ipc::ShellProxyBlocking::new(&c).unwrap();
    assert_eq!(proxy.get_state().unwrap().surfaces[0].name, "cc");
    assert!(matches!(
        proxy.show_osd("volume", 0.5, false, "Headphones"),
        Err(Error::Unavailable(_))
    ));
    let out = bus.cli(&["--", "setConfig", "key", "spaces %s", "-1"]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert_eq!(
        String::from_utf8(out.stdout).unwrap(),
        "{\"verbatim\": \"%s \\n ü\"}\n"
    );
    assert_eq!(
        calls.lock().unwrap()[0],
        ["setConfig", "key", "spaces %s", "-1"]
    );
    let out = bus.cli(&["--session=rust", "toggleCC", "keyboard"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("AccessDenied"), "{}", stderr(&out));
    assert_eq!(*native.lock().unwrap(), ["toggle:cc:true"]);
    let out = bus.cli(&["--session=rust", "toggleNC"]);
    assert!(stderr(&out).contains("Unavailable"));
    let out = bus.cli(&["--session=rust", "focusBar"]);
    assert!(out.status.success(), "{}", stderr(&out));
    let out = bus.cli(&["--session=rust", "settingsPage", "display"]);
    assert!(out.status.success());
    for cmd in ["listApps", "launchApp", "queryUI"] {
        let out = bus.cli(&["--session=rust", cmd]);
        assert!(stderr(&out).contains("Unavailable"));
    }
    let out = bus.cli(&["--session=rust", "settingsWallpaper", "preview", "fade"]);
    assert!(stderr(&out).contains("Unavailable"));
    assert_eq!(
        calls.lock().unwrap().len(),
        1,
        "native routes must not retry via legacy Request"
    );
}
#[test]
fn unknown_environment_warns_and_preserves_ts_shortcuts() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let _entered = runtime.enter();
    let bus = Bus::new();
    let calls = Arc::new(Mutex::new(vec![]));
    let c = conn(&bus);
    c.object_server()
        .at("/org/nidara/Shell", Legacy(calls.clone()))
        .unwrap();
    c.request_name("org.nidara.Shell").unwrap();
    for value in ["unexpected", "Rust", "rust ", ""] {
        let out = bus.cli_env(&["toggleCC", "keyboard"], Some(value));
        assert!(out.status.success(), "{}", stderr(&out));
        assert!(stderr(&out).contains("unknown NIDARA_SESSION="));
        assert!(stderr(&out).contains("using ts compatibility"));
        assert!(String::from_utf8(out.stdout).unwrap().ends_with('\n'));
    }
    assert_eq!(
        *calls.lock().unwrap(),
        vec![vec!["toggleCC", "keyboard"]; 4]
    );
    let out = bus.cli_env(&["--session=ts", "dumpState"], Some("unexpected"));
    assert!(out.status.success());
    assert!(
        out.stderr.is_empty(),
        "explicit selection overrides the environment"
    );
    let out = bus.cli_env(&["--session=rust", "listActions"], Some("unexpected"));
    assert!(out.status.success());
    assert!(out.stderr.is_empty());
    let out = bus.cli_env(&["--session=broken", "dumpState"], Some("unexpected"));
    assert_eq!(out.status.code(), Some(2));
    assert_eq!(
        calls.lock().unwrap().len(),
        5,
        "bad explicit option never dispatches"
    );
}
#[test]
fn absent_or_wrong_interface_is_failure_and_no_activation() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let _entered = runtime.enter();
    let bus = Bus::new();
    let out = bus.cli(&["--session=rust", "toggleCC"]);
    assert!(stderr(&out).contains("Unavailable"));
    let calls = Arc::new(Mutex::new(vec![]));
    let c = conn(&bus);
    c.object_server()
        .at("/org/nidara/Shell", Legacy(calls.clone()))
        .unwrap();
    c.request_name("org.nidara.Shell").unwrap();
    let out = bus.cli(&["--session=rust", "toggleCC"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(stderr(&out).contains("Unavailable"), "{}", stderr(&out));
    assert!(calls.lock().unwrap().is_empty());
    let out = bus.cli(&["--session=broken", "dumpState"]);
    assert_eq!(out.status.code(), Some(2));
    let out = bus.cli(&[]);
    assert_eq!(out.status.code(), Some(2));
}
struct Config(Arc<Mutex<Vec<String>>>);
#[zbus::interface(name = "org.nidara.Config1")]
impl Config {
    fn describe(&self) -> String {
        r#"{"test.bool":{"type":"boolean","available":true},"test.number":{"type":"number","available":true},"test.string":{"type":"string","available":true},"wallpaper.transition":{"type":"enum","available":true},"wallpaper.current":{"type":"string","available":true}}"#.into()
    }
    fn get(&self, keys: Vec<String>) -> HashMap<String, OwnedValue> {
        keys.into_iter()
            .map(|k| (k, OwnedValue::from(true)))
            .collect()
    }
    fn apply(&self, key: &str, value: OwnedValue) -> zbus::fdo::Result<(u64, OwnedValue)> {
        self.0.lock().unwrap().push(key.into());
        if key == "test.bool" {
            return Err(zbus::fdo::Error::AccessDenied("server policy".into()));
        }
        Ok((42, value))
    }
}
#[test]
fn config_uses_typed_values_and_owner_denial() {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(1)
        .enable_all()
        .build()
        .unwrap();
    let _entered = runtime.enter();
    let bus = Bus::new();
    let calls = Arc::new(Mutex::new(vec![]));
    let c = conn(&bus);
    c.object_server()
        .at("/org/nidara/Config", Config(calls.clone()))
        .unwrap();
    c.request_name("org.nidara.Config").unwrap();
    let out = bus.cli(&["--session=rust", "setConfig", "test.bool", "false"]);
    assert!(stderr(&out).contains("AccessDenied"));
    let out = bus.cli(&["--session=rust", "setConfig", "test.number", "1.25"]);
    assert!(out.status.success(), "{}", stderr(&out));
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(v["value"], 1.25);
    assert_eq!(v["revision"], 42);
    let out = bus.cli(&["--session=rust", "setConfig", "test.number", "NaN"]);
    assert_eq!(out.status.code(), Some(1));
    let out = bus.cli(&["--session=rust", "setConfig", "test.string", "hello world"]);
    assert!(out.status.success(), "{}", stderr(&out));
    let out = bus.cli(&["--session=rust", "getConfig", "test.bool"]);
    assert!(out.status.success());
    let out = bus.cli(&[
        "--session=rust",
        "settingsWallpaper",
        "set",
        "/some path",
        "fade",
    ]);
    assert!(out.status.success(), "{}", stderr(&out));
    assert_eq!(
        *calls.lock().unwrap(),
        [
            "test.bool",
            "test.number",
            "test.string",
            "wallpaper.transition",
            "wallpaper.current"
        ]
    );
}
#[test]
fn hyalo_denial_and_ambiguous_windows_never_turn_into_success() {
    let tag = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path = std::env::temp_dir().join(format!("nk-ipc-{}-{tag}.sock", std::process::id()));
    let listener = UnixListener::bind(&path).unwrap();
    let requests = Arc::new(Mutex::new(vec![]));
    let observed = requests.clone();
    let server = std::thread::spawn(move || {
        for stream in listener.incoming().take(3) {
            let mut stream = stream.unwrap();
            let mut s = String::new();
            BufReader::new(&stream).read_line(&mut s).unwrap();
            let v: serde_json::Value = serde_json::from_str(&s).unwrap();
            observed.lock().unwrap().push(v.clone());
            let reply = if v["request"] == "windows" {
                r#"{"ok":{"windows":[{"id":1,"app_id":"same","title":"one"},{"id":2,"app_id":"same","title":"two"}]}}"#
            } else {
                r#"{"error":"AccessDenied: computer control disabled","code":"AccessDenied"}"#
            };
            writeln!(stream, "{reply}").unwrap();
        }
    });
    let cli = |args: &[&str]| {
        Command::new(env!("CARGO_BIN_EXE_nidara-ipc"))
            .env("HYALO_SOCKET", &path)
            .env("NIDARA_SESSION", "rust")
            .args(args)
            .output()
            .unwrap()
    };
    let out = cli(&["focusWindow", "same"]);
    assert!(stderr(&out).contains("ambiguous"));
    let out = cli(&["closeWindow", "0x1"]);
    assert!(stderr(&out).contains("AccessDenied"));
    assert_eq!(out.status.code(), Some(1));
    server.join().unwrap();
    std::fs::remove_file(path).unwrap();
    assert_eq!(requests.lock().unwrap()[2]["command"], "close-window 1");
}
