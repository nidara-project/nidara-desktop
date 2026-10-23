// SPDX-License-Identifier: LGPL-3.0-or-later
//! The names and the routing on a private bus (a `dbus-daemon` of its own): a drawn page is
//! the window's, any other goes to the legacy Settings — started when it is not running —, a
//! second native Settings hands its request over, and before the takeover the entry point is
//! left to the legacy one.
use nk_settings::routing::{
    AlreadyRunning, ENTRY, LEGACY, Launcher, Mode, NATIVE, PATH, Route, Router,
};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zbus::blocking::Connection;

struct Bus {
    daemon: Child,
    address: String,
}

impl Bus {
    fn new() -> Self {
        static NEXT_BUS: AtomicUsize = AtomicUsize::new(0);
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../target")
            .join(format!(
                "rb-{}-{}",
                std::process::id(),
                NEXT_BUS.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&directory).unwrap();
        let address_option = format!("--address=unix:path={}", directory.join("bus").display());
        let mut daemon = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address", &address_option])
            .stdout(Stdio::piped())
            .spawn()
            .expect("dbus-daemon");
        let mut address = String::new();
        BufReader::new(daemon.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        Self {
            daemon,
            address: address.trim().to_owned(),
        }
    }
    fn connect(&self) -> Connection {
        zbus::blocking::connection::Builder::address(self.address.as_str())
            .unwrap()
            .method_timeout(Duration::from_secs(10))
            .build()
            .unwrap()
    }
}

impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
    }
}

/// The legacy Settings as the native one sees it: `Request` on `org.nidara.SettingsLegacy`.
struct Legacy(Arc<Mutex<Vec<Vec<String>>>>);

#[zbus::interface(name = "org.nidara.Settings")]
impl Legacy {
    fn request(&self, args: Vec<String>) -> String {
        self.0.lock().unwrap().push(args.clone());
        format!("legacy: {}", args.join(" "))
    }
}

fn serve_legacy(bus: &Bus, seen: Arc<Mutex<Vec<Vec<String>>>>) -> Connection {
    let c = bus.connect();
    c.object_server().at(PATH, Legacy(seen)).unwrap();
    c.request_name(LEGACY).unwrap();
    c
}

fn call(bus: &Bus, name: &str, args: &[&str]) -> zbus::Result<String> {
    let c = bus.connect();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    c.call_method(Some(name), PATH, Some(ENTRY), "Request", &(args,))?
        .body()
        .deserialize::<String>()
}

/// Answers the window's requests from its own thread, as the app's idle would.
fn window(router: Router, answered: Arc<Mutex<Vec<Route>>>) {
    std::thread::spawn(move || {
        loop {
            for incoming in router.poll() {
                answered.lock().unwrap().push(match &incoming.route {
                    Route::Navigate(p) => Route::Navigate(p.clone()),
                    Route::Raise => Route::Raise,
                    Route::Query(q) => Route::Query(q.clone()),
                    Route::Forward(a) => Route::Forward(a.clone()),
                });
                incoming.respond("ok");
            }
            std::thread::sleep(Duration::from_millis(5));
        }
    });
}

fn owner(bus: &Bus, name: &str) -> bool {
    let c = bus.connect();
    zbus::blocking::fdo::DBusProxy::new(&c)
        .unwrap()
        .name_has_owner(name.try_into().unwrap())
        .unwrap()
}

#[test]
fn the_entry_point_draws_its_pages_and_forwards_the_rest() {
    let bus = Bus::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let launches = Arc::new(AtomicUsize::new(0));
    let legacy_conn: Arc<Mutex<Option<Connection>>> = Arc::new(Mutex::new(None));
    let launcher: Launcher = {
        let (bus_address, seen, launches, slot) = (
            bus.address.clone(),
            seen.clone(),
            launches.clone(),
            legacy_conn.clone(),
        );
        Arc::new(move || {
            launches.fetch_add(1, Ordering::SeqCst);
            let (seen, slot, address) = (seen.clone(), slot.clone(), bus_address.clone());
            // Starts as a process would: a moment later, from elsewhere.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                let c = zbus::blocking::connection::Builder::address(address.as_str())
                    .unwrap()
                    .build()
                    .unwrap();
                c.object_server().at(PATH, Legacy(seen)).unwrap();
                c.request_name(LEGACY).unwrap();
                *slot.lock().unwrap() = Some(c);
            });
            Ok(())
        })
    };
    let native = bus.connect();
    let router = Router::start(&native, Mode::EntryPoint, launcher, &[])
        .unwrap()
        .unwrap();
    assert!(owner(&bus, NATIVE) && owner(&bus, ENTRY));
    let answered = Arc::new(Mutex::new(Vec::new()));
    window(router, answered.clone());

    assert_eq!(call(&bus, ENTRY, &["page", "appearance"]).unwrap(), "ok");
    assert_eq!(
        answered.lock().unwrap().as_slice(),
        &[Route::Navigate("appearance".into())]
    );
    // Not drawn: the legacy Settings, started for it.
    let t = Instant::now();
    assert_eq!(
        call(&bus, ENTRY, &["page", "network"]).unwrap(),
        "legacy: page network"
    );
    assert!(
        t.elapsed() >= Duration::from_millis(200),
        "answered before it started"
    );
    assert_eq!(launches.load(Ordering::SeqCst), 1);
    // Running now: no second start.
    assert_eq!(
        call(&bus, ENTRY, &["app", "foo.desktop"]).unwrap(),
        "legacy: app foo.desktop"
    );
    assert_eq!(launches.load(Ordering::SeqCst), 1);
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        &[
            vec!["page".to_string(), "network".to_string()],
            vec!["app".to_string(), "foo.desktop".to_string()]
        ]
    );
    // Its answers, unchanged.
    assert!(call(&bus, ENTRY, &["page"]).unwrap().starts_with("usage"));
    assert!(call(&bus, ENTRY, &["reload"]).is_err());
    assert_eq!(
        answered.lock().unwrap().len(),
        1,
        "a forwarded page reached the window"
    );
}

#[test]
fn a_second_native_settings_hands_its_request_over() {
    second_instance(Mode::EntryPoint);
    second_instance(Mode::Native);
}

// A test-only real bus endpoint starts the object server even when the fault
// omits Request, so that omission returns UnknownInterface instead of timing out.
struct RoutingReady;
#[zbus::interface(name = "org.nidara.Test.RoutingReady")]
impl RoutingReady {
    fn ping(&self) -> &str {
        "ready"
    }
}

fn second_instance(mode: Mode) {
    let bus = Bus::new();
    let first = bus.connect();
    first.object_server().at(PATH, RoutingReady).unwrap();
    let router = Router::start(&first, mode, Arc::new(|| Ok(())), &[])
        .unwrap()
        .unwrap();
    let answered = Arc::new(Mutex::new(Vec::new()));
    window(router, answered.clone());
    let second = bus.connect();
    let ready = second
        .call_method(
            Some(NATIVE),
            PATH,
            Some("org.nidara.Test.RoutingReady"),
            "Ping",
            &(),
        )
        .unwrap();
    assert_eq!(ready.body().deserialize::<String>().unwrap(), "ready");
    let again = Router::start(
        &second,
        mode,
        Arc::new(|| Ok(())),
        &["page".into(), "appearance".into()],
    );
    assert!(
        again.is_ok(),
        "second native Request handoff failed: {:?}",
        again.as_ref().err()
    );
    assert!(matches!(again.unwrap(), Err(AlreadyRunning)));
    let deadline = Instant::now() + Duration::from_secs(3);
    while answered.lock().unwrap().is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        answered.lock().unwrap().as_slice(),
        &[Route::Navigate("appearance".into())]
    );
}

#[test]
fn before_the_takeover_the_entry_point_stays_the_legacy_settings() {
    let bus = Bus::new();
    let seen = Arc::new(Mutex::new(Vec::new()));
    // The legacy Settings as it runs today: owning the entry point.
    let legacy = bus.connect();
    legacy
        .object_server()
        .at(PATH, Legacy(seen.clone()))
        .unwrap();
    legacy.request_name(ENTRY).unwrap();
    let native = bus.connect();
    let _router = Router::start(&native, Mode::Native, Arc::new(|| Ok(())), &[])
        .unwrap()
        .unwrap();
    assert!(owner(&bus, NATIVE));
    assert_eq!(
        call(&bus, ENTRY, &["page", "appearance"]).unwrap(),
        "legacy: page appearance"
    );
    let _ = serve_legacy;
}
