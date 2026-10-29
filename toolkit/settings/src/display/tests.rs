// SPDX-License-Identifier: LGPL-3.0-or-later
use super::{
    client::{Client, Command, State},
    model::*,
};
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    process::{Child, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use zbus::blocking::Connection;
pub(super) fn wait(mut predicate: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(8);
    while !predicate() {
        assert!(Instant::now() < end, "display fixture stalled");
        std::thread::sleep(Duration::from_millis(5));
    }
}
pub(super) fn snapshot() -> Snapshot {
    let outputs = [("panel", true, 1200, 800), ("external", false, 1600, 900)]
        .into_iter()
        .enumerate()
        .map(|(i, (id, internal, w, h))| Output {
            id: id.into(),
            identity: id.into(),
            connector: if internal {
                "eDP-1".into()
            } else {
                "DP-1".into()
            },
            internal,
            enabled: true,
            powered: true,
            make: "fixture".into(),
            model: id.into(),
            serial: String::new(),
            physical_width_mm: 300,
            physical_height_mm: 200,
            modes: vec![
                Mode {
                    id: "preferred".into(),
                    width: w,
                    height: h,
                    refresh_mhz: 60000,
                    preferred: true,
                },
                Mode {
                    id: "second".into(),
                    width: 800,
                    height: 600,
                    refresh_mhz: 60000,
                    preferred: false,
                },
            ],
            current_mode: "preferred".into(),
            scale: 1.,
            transform: "normal".into(),
            x: if i == 0 { 0 } else { 1200 },
            y: 0,
            vrr_supported: !internal,
            vrr: "off".into(),
            vrr_enabled: false,
            number: i as u32 + 1,
        })
        .collect::<Vec<_>>();
    Snapshot {
        epoch: 7,
        revision: 1,
        capabilities: vec![
            "extend".into(),
            "mirror".into(),
            "preview".into(),
            "identify".into(),
        ],
        layout: Layout {
            primary: "panel".into(),
            outputs: outputs
                .iter()
                .map(|o| Setting {
                    id: o.id.clone(),
                    enabled: true,
                    mode: o.current_mode.clone(),
                    scale: 1.,
                    transform: "normal".into(),
                    x: o.x,
                    y: o.y,
                    vrr: "off".into(),
                })
                .collect(),
            mirror_groups: vec![],
        },
        outputs,
        pending: Pending::default(),
        last_error: String::new(),
    }
}
pub(super) struct Bus {
    daemon: Child,
    directory: PathBuf,
    address: String,
}
impl Bus {
    fn new() -> Self {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let directory = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../target")
            .join(format!(
                "display-bus-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&directory).unwrap();
        let config = directory.join("bus.conf");
        std::fs::write(&config,format!("<busconfig><type>session</type><listen>unix:abstract={}</listen><auth>EXTERNAL</auth><policy context=\"default\"><allow send_destination=\"*\"/><allow receive_sender=\"*\"/><allow own=\"*\"/></policy></busconfig>",directory.file_name().unwrap().to_string_lossy())).unwrap();
        let mut daemon = std::process::Command::new("dbus-daemon")
            .args(["--nofork", "--print-address"])
            .arg(format!("--config-file={}", config.display()))
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut address = String::new();
        BufReader::new(daemon.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        Self {
            daemon,
            directory,
            address: address.trim().into(),
        }
    }
    pub(super) fn connect(&self) -> Connection {
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
        std::fs::remove_dir_all(&self.directory).unwrap();
    }
}
pub(super) struct Fake {
    pub(super) snapshot: Mutex<Snapshot>,
    pub(super) calls: Mutex<Vec<String>>,
    pub(super) sender: Mutex<String>,
    pub(super) fail_confirm: AtomicBool,
    pub(super) preview_error: AtomicUsize,
    pub(super) hold_preview: AtomicBool,
    pub(super) brightness: Mutex<Brightness>,
}
#[derive(Clone)]
struct Display(Arc<Fake>);
#[zbus::interface(name = "org.nidara.Display1")]
impl Display {
    fn get_state(&self) -> Snapshot {
        self.0.snapshot.lock().unwrap().clone()
    }
    fn validate(&self, epoch: u64, revision: u64, layout: Layout) -> zbus::fdo::Result<Layout> {
        self.0.calls.lock().unwrap().push("validate".into());
        let s = self.0.snapshot.lock().unwrap();
        if (epoch, revision) != (s.epoch, s.revision) {
            return Err(zbus::fdo::Error::Failed("stale".into()));
        }
        Ok(layout)
    }
    async fn preview(
        &self,
        _epoch: u64,
        _revision: u64,
        layout: Layout,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] conn: &zbus::Connection,
    ) -> zbus::fdo::Result<Pending> {
        self.0.calls.lock().unwrap().push("preview".into());
        while self.0.hold_preview.load(Ordering::Acquire) {
            std::thread::sleep(Duration::from_millis(5));
        }
        match self.0.preview_error.load(Ordering::Acquire) {
            1 => return Err(zbus::fdo::Error::Failed("busy".into())),
            2 => return Err(zbus::fdo::Error::NoReply("uncertain".into())),
            _ => {}
        }
        *self.0.sender.lock().unwrap() = header.sender().unwrap().to_string();
        let pending = Pending {
            token: "lease-1".into(),
            phase: "confirming".into(),
            deadline_us: now_us() + 15_000_000,
        };
        {
            let mut s = self.0.snapshot.lock().unwrap();
            s.layout = layout;
            s.pending = pending.clone();
            s.revision += 1;
        }
        conn.emit_signal(
            None::<&str>,
            super::client::PATH,
            super::client::IFACE,
            "Changed",
            &(7u64, 2u64),
        )
        .await
        .unwrap();
        Ok(pending)
    }
    fn confirm(
        &self,
        token: &str,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<()> {
        assert_eq!(token, "lease-1");
        assert_eq!(
            header.sender().unwrap().as_str(),
            self.0.sender.lock().unwrap().as_str()
        );
        self.0.calls.lock().unwrap().push("confirm".into());
        if self.0.fail_confirm.load(Ordering::Relaxed) {
            return Err(zbus::fdo::Error::Failed("save failed".into()));
        }
        self.0.snapshot.lock().unwrap().pending = Pending::default();
        Ok(())
    }
    fn cancel(&self, _token: &str) {
        self.0.calls.lock().unwrap().push("cancel".into());
        self.0.snapshot.lock().unwrap().pending = Pending::default();
    }
    fn identify(&self, _epoch: u64, _revision: u64) {
        self.0.calls.lock().unwrap().push("identify".into());
    }
}
#[derive(Clone)]
struct Bright(Arc<Fake>);
#[zbus::interface(name = "org.nidara.DisplayBrightness1")]
impl Bright {
    fn get_state(&self) -> Brightness {
        self.0.brightness.lock().unwrap().clone()
    }
    fn set_brightness(&self, id: &str, epoch: u64, value: u32) -> zbus::fdo::Result<Device> {
        let mut b = self.0.brightness.lock().unwrap();
        let d = &mut b.devices[0];
        if id != d.id || epoch != d.epoch || !d.writable || value > d.max {
            return Err(zbus::fdo::Error::Failed("stale brightness".into()));
        }
        self.0
            .calls
            .lock()
            .unwrap()
            .push(format!("brightness {value}"));
        d.current = value;
        Ok(d.clone())
    }
}
pub(super) struct Fixture {
    pub(super) bus: Bus,
    pub(super) fake: Arc<Fake>,
    pub(super) service: Connection,
}
impl Fixture {
    pub(super) fn new() -> Self {
        let bus = Bus::new();
        let service = bus.connect();
        let fake = Arc::new(Fake {
            snapshot: Mutex::new(snapshot()),
            calls: Mutex::new(vec![]),
            sender: Mutex::new(String::new()),
            fail_confirm: AtomicBool::new(false),
            preview_error: AtomicUsize::new(0),
            hold_preview: AtomicBool::new(false),
            brightness: Mutex::new(Brightness {
                generation: 11,
                revision: 1,
                devices: vec![Device {
                    id: "brightness".into(),
                    output_id: "panel".into(),
                    provider: "fixture".into(),
                    min: 0,
                    max: 100,
                    current: 40,
                    available: true,
                    writable: true,
                    epoch: 5,
                }],
            }),
        });
        service
            .object_server()
            .at(super::client::PATH, Display(fake.clone()))
            .unwrap();
        service.request_name(super::client::NAME).unwrap();
        service
            .object_server()
            .at("/org/nidara/DisplayBrightness", Bright(fake.clone()))
            .unwrap();
        service.request_name("org.nidara.Session").unwrap();
        Self { bus, fake, service }
    }
    pub(super) fn client(&self) -> Client {
        Client::start(self.bus.connect()).unwrap()
    }
}
fn state(client: &Client, mut test: impl FnMut(&State) -> bool) -> State {
    let mut result = None;
    wait(|| {
        if let Some(state) = client.poll()
            && test(&state)
        {
            result = Some(state);
            return true;
        }
        false
    });
    result.unwrap()
}
#[test]
fn presets_countdown_and_keyboard_order_are_drafts() {
    let s = snapshot();
    let mirror = preset(&s, Preset::Mirror).unwrap();
    assert_eq!(mirror.mirror_groups, vec![vec!["panel", "external"]]);
    assert!(mirror.outputs.iter().all(|o| o.vrr == "off"));
    let mut promoted = mirror.clone();
    set_enabled(&mut promoted, &s.outputs, "panel", false).unwrap();
    assert!(promoted.mirror_groups.is_empty());
    assert_eq!(promoted.primary, "external");
    assert!(set_enabled(&mut promoted, &s.outputs, "external", false).is_err());
    let internal = preset(&s, Preset::Internal).unwrap();
    assert_eq!(internal.outputs.iter().filter(|s| s.enabled).count(), 1);
    let external = preset(&s, Preset::External).unwrap();
    assert_eq!(external.primary, "external");
    let mut extended = preset(&s, Preset::Extend).unwrap();
    reorder(&mut extended, &s.outputs, "external", -1);
    assert_eq!(
        extended
            .outputs
            .iter()
            .find(|o| o.id == "external")
            .unwrap()
            .x,
        0
    );
    assert_eq!(seconds(15_000_000, 1), 15);
    assert_eq!(seconds(15_000_000, 14_000_001), 1);
    assert_eq!(seconds(15_000_000, 16_000_000), 0);
    let mut no_mirror = s.clone();
    no_mirror.capabilities.retain(|c| c != "mirror");
    assert!(preset(&no_mirror, Preset::Mirror).is_err());
}
#[test]
fn private_bus_client_lease_owner_refusal_and_final_brightness() {
    let f = Fixture::new();
    let dedicated = f.bus.connect();
    let name = dedicated.unique_name().unwrap().to_string();
    let c = Client::start(dedicated).unwrap();
    let initial = state(&c, |s| s.snapshot.is_some());
    assert!(f.fake.calls.lock().unwrap().is_empty());
    let snapshot = initial.snapshot.unwrap();
    c.send(Command::Preview {
        owner: initial.owner.clone(),
        epoch: snapshot.epoch,
        revision: snapshot.revision,
        layout: preset(&snapshot, Preset::Mirror).unwrap(),
    })
    .unwrap();
    let pending = state(&c, |s| s.owned.is_some()).owned.unwrap();
    assert_eq!(&*f.fake.calls.lock().unwrap(), &["validate", "preview"]);
    f.fake.fail_confirm.store(true, Ordering::Relaxed);
    c.send(Command::Confirm(pending.token.clone())).unwrap();
    state(&c, |s| s.error.is_some() && s.owned.is_some());
    f.fake.fail_confirm.store(false, Ordering::Relaxed);
    c.send(Command::Confirm(pending.token)).unwrap();
    state(&c, |s| {
        s.owned.is_none()
            && s.snapshot
                .as_ref()
                .is_some_and(|s| s.pending.token.is_empty())
    });
    for value in 41..=95 {
        c.send(Command::Brightness {
            generation: 11,
            id: "brightness".into(),
            epoch: 5,
            value,
        })
        .unwrap();
    }
    state(&c, |s| {
        s.brightness
            .as_ref()
            .is_some_and(|b| b.devices[0].current == 95)
    });
    let before = f.fake.calls.lock().unwrap().len();
    c.send(Command::Brightness {
        generation: 12,
        id: "brightness".into(),
        epoch: 5,
        value: 96,
    })
    .unwrap();
    state(&c, |s| s.error.is_some());
    assert_eq!(f.fake.calls.lock().unwrap().len(), before);
    f.service.release_name(super::client::NAME).unwrap();
    state(&c, |s| s.snapshot.is_none());
    drop(c);
    let dbus = zbus::blocking::fdo::DBusProxy::new(&f.service).unwrap();
    wait(|| {
        !dbus
            .name_has_owner(name.as_str().try_into().unwrap())
            .unwrap()
    });
}

#[test]
fn definite_preview_refusal_can_retry_but_no_reply_releases_connection() {
    let f = Fixture::new();
    let dedicated = f.bus.connect();
    let name = dedicated.unique_name().unwrap().to_string();
    let c = Client::start(dedicated).unwrap();
    let initial = state(&c, |s| s.snapshot.is_some());
    let snapshot = initial.snapshot.unwrap();
    let preview = || Command::Preview {
        owner: initial.owner.clone(),
        epoch: snapshot.epoch,
        revision: snapshot.revision,
        layout: snapshot.layout.clone(),
    };
    f.fake.preview_error.store(1, Ordering::Release);
    f.fake.hold_preview.store(true, Ordering::Release);
    // Leave a completed observation unread; receiving it must not clear a later
    // in-flight action's busy state.
    c.send(Command::Refresh).unwrap();
    wait(|| c.notified.load(Ordering::Acquire));
    c.send(preview()).unwrap();
    wait(|| f.fake.calls.lock().unwrap().iter().any(|s| s == "preview"));
    let stale = c.poll().unwrap();
    assert!(c.busy(&stale));
    f.fake.hold_preview.store(false, Ordering::Release);
    let rejected = state(&c, |s| s.error.is_some() && s.snapshot.is_some());
    assert!(!c.busy(&rejected));
    assert!(c.busy(&stale));
    f.fake.preview_error.store(0, Ordering::Release);
    c.send(preview()).unwrap();
    state(&c, |s| s.owned.is_some());
    c.send(Command::Cancel).unwrap();
    state(&c, |s| s.owned.is_none() && s.error.is_none());
    let current = state_after_refresh(&c);
    let snapshot = current.snapshot.unwrap();
    f.fake.preview_error.store(2, Ordering::Release);
    c.send(Command::Preview {
        owner: current.owner,
        epoch: snapshot.epoch,
        revision: snapshot.revision,
        layout: snapshot.layout,
    })
    .unwrap();
    state(&c, |s| s.error.is_some() && s.snapshot.is_none());
    let dbus = zbus::blocking::fdo::DBusProxy::new(&f.service).unwrap();
    wait(|| {
        !dbus
            .name_has_owner(name.as_str().try_into().unwrap())
            .unwrap()
    });
}

fn state_after_refresh(client: &Client) -> State {
    client.send(Command::Refresh).unwrap();
    state(client, |s| s.snapshot.is_some())
}
