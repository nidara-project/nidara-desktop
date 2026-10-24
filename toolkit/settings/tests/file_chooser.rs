// SPDX-License-Identifier: LGPL-3.0-or-later
//! Actual private D-Bus OpenFile/Response/Close; synthetic portal and parent string, no native UI.
use nk_settings::file_chooser::{Chooser, Open, Operation, StartError};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU32, Ordering},
    },
    time::{Duration, Instant},
};
use zbus::{
    blocking::Connection,
    zvariant::{OwnedObjectPath, OwnedValue, Value},
};
const NAME: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const REQUEST: &str = "org.freedesktop.portal.Request";
#[derive(Clone, Default)]
struct State {
    mode: Arc<AtomicU32>,
    opened: Arc<AtomicU32>,
    closed: Arc<AtomicU32>,
}
struct Bus {
    daemon: Child,
    directory: PathBuf,
    address: String,
}
impl Bus {
    fn new() -> Self {
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("target")
            .join(format!("fc-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let config = directory.join("bus.conf");
        std::fs::write(&config,format!(r#"<busconfig><type>session</type><listen>unix:path={}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>"#,directory.join("bus").display())).unwrap();
        let mut daemon = Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--nofork", "--print-address"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut address = String::new();
        assert!(
            BufReader::new(daemon.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap()
                > 0
        );
        Self {
            daemon,
            directory,
            address: address.trim().into(),
        }
    }
    fn connection(&self) -> Connection {
        zbus::blocking::connection::Builder::address(self.address.as_str())
            .unwrap()
            .method_timeout(Duration::from_secs(3))
            .build()
            .unwrap()
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
struct Request(State);
#[zbus::interface(name = "org.freedesktop.portal.Request")]
impl Request {
    fn close(&self) {
        self.0.closed.fetch_add(1, Ordering::SeqCst);
    }
}
struct Portal(State);
#[zbus::interface(name = "org.freedesktop.portal.FileChooser")]
impl Portal {
    async fn open_file(
        &self,
        parent: &str,
        title: &str,
        options: HashMap<String, OwnedValue>,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] connection: &zbus::Connection,
        #[zbus(object_server)] server: &zbus::ObjectServer,
    ) -> zbus::fdo::Result<OwnedObjectPath> {
        assert_eq!(parent, "wayland:synthetic-parent");
        assert_eq!(title, "Choose wallpaper");
        assert!(bool::try_from(&options["modal"]).unwrap());
        assert!(!bool::try_from(&options["multiple"]).unwrap());
        assert_eq!(
            options["filters"].value_signature().to_string(),
            "a(sa(us))"
        );
        let token = <&str>::try_from(&options["handle_token"]).unwrap();
        assert!(token.starts_with("nidara_") && token.len() > 25);
        let sender = header.sender().unwrap().as_str();
        // Deliberately differs from the prediction. Responses are emitted BEFORE the method reply.
        let path = format!("{PATH}/request/older_portal/{token}");
        server
            .at(path.clone(), Request(self.0.clone()))
            .await
            .unwrap();
        let mode = self.0.mode.load(Ordering::SeqCst);
        if mode != 3 {
            let values = HashMap::from([(
                "uris",
                OwnedValue::try_from(Value::from(vec!["file:///wrong.png"])).unwrap(),
            )]);
            connection
                .emit_signal(
                    Some(sender),
                    format!("{PATH}/request/unrelated/{token}"),
                    REQUEST,
                    "Response",
                    &(0u32, values),
                )
                .await
                .unwrap();
            let response: u32 = match mode {
                1 => 1,
                2 => 2,
                _ => 0,
            };
            let uris = match mode {
                4 => vec!["file:///one.png", "file:///two.png"],
                5 => vec!["file://remote/home/a.png"],
                _ => vec!["file:///home/test/Wallpaper%20%23.png"],
            };
            let values =
                HashMap::from([("uris", OwnedValue::try_from(Value::from(uris)).unwrap())]);
            connection
                .emit_signal(
                    Some(sender),
                    path.as_str(),
                    REQUEST,
                    "Response",
                    &(response, values),
                )
                .await
                .unwrap();
        }
        self.0.opened.fetch_add(1, Ordering::SeqCst);
        Ok(path.try_into().unwrap())
    }
}
fn spin(mut predicate: impl FnMut() -> bool) {
    let limit = Instant::now() + Duration::from_secs(5);
    while !predicate() {
        assert!(
            Instant::now() < limit,
            "private portal fixture did not reach its required state"
        );
        std::thread::yield_now();
    }
}
fn operation(request: u64) -> Operation {
    Operation { mount: 7, request }
}
fn start(chooser: &mut Chooser, connection: &Connection, request: u64) {
    spin(|| {
        match chooser.start(
            connection,
            operation(request),
            Open {
                parent: "wayland:synthetic-parent".into(),
                title: "Choose wallpaper".into(),
                images_label: "Images".into(),
            },
        ) {
            Ok(()) => true,
            Err(StartError::Busy) => false,
            Err(e) => panic!("{e:?}"),
        }
    });
}
fn result(chooser: &mut Chooser, request: u64) -> Result<Option<PathBuf>, String> {
    let mut result = None;
    spin(|| {
        result = chooser.poll(operation(request));
        result.is_some()
    });
    result.unwrap()
}
#[test]
fn private_bus_early_response_actual_path_cancel_and_owner_loss() {
    let bus = Bus::new();
    let service = bus.connection();
    let client = bus.connection();
    let state = State::default();
    service
        .object_server()
        .at(PATH, Portal(state.clone()))
        .unwrap();
    service.request_name(NAME).unwrap();
    let mut chooser = Chooser::default();
    start(&mut chooser, &client, 1);
    let selected = result(&mut chooser, 1).unwrap();
    assert!(state.opened.load(Ordering::SeqCst) >= 1);
    assert_eq!(
        selected,
        Some(PathBuf::from("/home/test/Wallpaper #.png")),
        "response must match the returned request path, not unrelated early signal"
    );
    state.mode.store(1, Ordering::SeqCst);
    start(&mut chooser, &client, 2);
    assert_eq!(result(&mut chooser, 2).unwrap(), None);
    state.mode.store(2, Ordering::SeqCst);
    start(&mut chooser, &client, 3);
    assert!(result(&mut chooser, 3).unwrap_err().contains("response 2"));
    state.mode.store(4, Ordering::SeqCst);
    start(&mut chooser, &client, 6);
    assert!(result(&mut chooser, 6).unwrap_err().contains("exactly one"));
    state.mode.store(5, Ordering::SeqCst);
    start(&mut chooser, &client, 7);
    assert!(
        result(&mut chooser, 7)
            .unwrap_err()
            .contains("remote authority")
    );
    state.mode.store(3, Ordering::SeqCst);
    let before = state.opened.load(Ordering::SeqCst);
    start(&mut chooser, &client, 4);
    spin(|| state.opened.load(Ordering::SeqCst) > before);
    let closed = state.closed.load(Ordering::SeqCst);
    chooser.cancel();
    assert!(!chooser.pending());
    spin(|| state.closed.load(Ordering::SeqCst) > closed);
    let before = state.opened.load(Ordering::SeqCst);
    start(&mut chooser, &client, 5);
    spin(|| state.opened.load(Ordering::SeqCst) > before);
    let closed = state.closed.load(Ordering::SeqCst);
    service.release_name(NAME).unwrap();
    assert!(
        result(&mut chooser, 5)
            .unwrap_err()
            .contains("owner changed")
    );
    assert!(state.closed.load(Ordering::SeqCst) > closed);
}
