// SPDX-License-Identifier: GPL-3.0-or-later
//! Every provider here is on a disposable session bus, including fake logind.
use super::*;
#[derive(Clone, Default)]
struct Fixture {
    percent: Arc<RwLock<f64>>,
    profile: Arc<RwLock<String>>,
    brightness: Arc<RwLock<i32>>,
    charge: Arc<RwLock<bool>>,
    active: Arc<RwLock<bool>>,
    fd_peers: Arc<std::sync::Mutex<Vec<std::os::unix::net::UnixStream>>>,
    calls: Arc<Mutex<Vec<String>>>,
}
struct DisplayRecorder {
    marker: u32,
    calls: tokio::sync::mpsc::UnboundedSender<(u32, bool)>,
}
#[zbus::interface(name = "org.nidara.Display1")]
impl DisplayRecorder {
    async fn set_lid_state(&self, _generation: u64, _sequence: u64, closed: bool) {
        self.calls.send((self.marker, closed)).unwrap();
    }
}

struct Up;
#[zbus::interface(name = "org.freedesktop.UPower")]
impl Up {
    fn get_display_device(&self) -> Path {
        path("/org/freedesktop/UPower/devices/battery")
    }
    fn enumerate_devices(&self) -> Vec<Path> {
        vec![
            self.get_display_device(),
            path("/org/freedesktop/UPower/devices/physical"),
        ]
    }
    fn enumerate_kbd_backlights(&self) -> Vec<Path> {
        vec![path("/org/freedesktop/UPower/KbdBacklight")]
    }
    #[zbus(property)]
    fn on_battery(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn lid_is_closed(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn lid_is_present(&self) -> bool {
        true
    }
}
#[zbus::interface(name = "org.freedesktop.UPower.Device")]
impl Fixture {
    #[zbus(property)]
    fn percentage(&self) -> f64 {
        *self.percent.read().unwrap()
    }
    #[zbus(property)]
    fn is_present(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn power_supply(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn r#type(&self) -> u32 {
        2
    }
    #[zbus(property)]
    fn state(&self) -> u32 {
        2
    }
    #[zbus(property)]
    fn warning_level(&self) -> u32 {
        1
    }
    #[zbus(property)]
    fn energy_full(&self) -> f64 {
        40.0
    }
    #[zbus(property)]
    fn energy_full_design(&self) -> f64 {
        50.0
    }
    #[zbus(property)]
    fn charge_cycles(&self) -> i32 {
        321
    }
    #[zbus(property)]
    fn charge_threshold_supported(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn charge_threshold_enabled(&self) -> bool {
        *self.charge.read().unwrap()
    }
    async fn enable_charge_threshold(&self, enabled: bool) -> zbus::fdo::Result<()> {
        self.calls.lock().await.push(format!("charge:{enabled}"));
        if !enabled {
            return Err(zbus::fdo::Error::AccessDenied("fixture policy".into()));
        }
        *self.charge.write().unwrap() = enabled;
        Ok(())
    }
}
#[derive(Clone)]
struct Keyboard(Fixture);
#[zbus::interface(name = "org.freedesktop.UPower.KbdBacklight")]
impl Keyboard {
    fn get_max_brightness(&self) -> i32 {
        10
    }
    fn get_brightness(&self) -> i32 {
        *self.0.brightness.read().unwrap()
    }
    async fn set_brightness(&self, value: i32) {
        self.0
            .calls
            .lock()
            .await
            .push(format!("brightness:{value}"));
        *self.0.brightness.write().unwrap() = value;
    }
}
#[derive(Clone)]
struct Profiles(Fixture);
#[zbus::interface(name = "org.freedesktop.UPower.PowerProfiles")]
impl Profiles {
    #[zbus(property)]
    fn profiles(&self) -> Vec<HashMap<String, OwnedValue>> {
        ["balanced", "power-saver"]
            .into_iter()
            .map(|s| {
                HashMap::from([
                    ("Profile".into(), Value::from(s).try_into().unwrap()),
                    ("Driver".into(), Value::from("fixture").try_into().unwrap()),
                ])
            })
            .collect()
    }
    #[zbus(property)]
    fn active_profile(&self) -> String {
        self.0.profile.read().unwrap().clone()
    }
    #[zbus(property)]
    async fn set_active_profile(&self, value: String) {
        self.0.calls.lock().await.push(format!("profile:{value}"));
        *self.0.profile.write().unwrap() = value;
    }
    #[zbus(property)]
    fn active_profile_holds(&self) -> Vec<HashMap<String, OwnedValue>> {
        vec![]
    }
    async fn hold_profile(&self, profile: String, _reason: String, _app: String) -> u32 {
        let mut calls = self.0.calls.lock().await;
        calls.push(format!("hold:{profile}"));
        calls.len() as u32
    }
    async fn release_profile(&self, cookie: u32) {
        self.0.calls.lock().await.push(format!("release:{cookie}"));
    }
}
#[derive(Clone)]
struct Login(Fixture);
#[zbus::interface(name = "org.freedesktop.login1.Manager")]
impl Login {
    fn inhibit(
        &self,
        _what: String,
        _who: String,
        _why: String,
        _mode: String,
    ) -> zbus::zvariant::OwnedFd {
        let (read, write) = std::os::unix::net::UnixStream::pair().unwrap();
        read.set_nonblocking(true).unwrap();
        self.0.fd_peers.lock().unwrap().push(read);
        std::os::fd::OwnedFd::from(write).into()
    }
    fn get_session(&self, _name: String) -> Path {
        path("/org/freedesktop/login1/session/test")
    }
    fn can_suspend(&self) -> &str {
        "yes"
    }
    fn can_power_off(&self) -> &str {
        "challenge"
    }
    fn list_inhibitors(&self) -> Vec<(String, String, String, String, u32, u32)> {
        vec![(
            "sleep".into(),
            "fixture".into(),
            "test".into(),
            "delay".into(),
            1000,
            123,
        )]
    }
    async fn suspend(&self, interactive: bool) {
        self.0
            .calls
            .lock()
            .await
            .push(format!("suspend:{interactive}"));
    }
    async fn power_off(&self, interactive: bool) {
        self.0
            .calls
            .lock()
            .await
            .push(format!("poweroff:{interactive}"));
    }
    #[zbus(property)]
    fn docked(&self) -> bool {
        false
    }
    #[zbus(property)]
    fn lid_closed(&self) -> bool {
        false
    }
}
struct Session(Fixture);
#[zbus::interface(name = "org.freedesktop.login1.Session")]
impl Session {
    #[zbus(property)]
    fn active(&self) -> bool {
        *self.0.active.read().unwrap()
    }
    #[zbus(property)]
    fn remote(&self) -> bool {
        false
    }
}
struct AcceptMenu;
#[zbus::interface(name = "org.nidara.PowerMenuConsumer1")]
impl AcceptMenu {
    fn show(&self, _id: u64) {}
}
struct MenuCallback;
#[zbus::interface(name = "org.nidara.PowerMenuConsumer1")]
impl MenuCallback {
    fn show(&self, _id: u64) -> zbus::fdo::Result<()> {
        Err(zbus::fdo::Error::Failed("fixture consumer failure".into()))
    }
}
async fn changed(stream: &mut zbus::MessageStream, mut predicate: impl FnMut() -> bool) {
    loop {
        if predicate() {
            return;
        }
        stream
            .next()
            .await
            .expect("fixture bus disconnected")
            .unwrap();
    }
}
pub(super) fn power(conn: &Connection, system: &Connection, read_only: bool) -> Power {
    Power {
        strings: Arc::new(i18n::Strings::load()),
        conn: conn.clone(),
        system: Arc::new(RwLock::new(Some(system.clone()))),
        state: Default::default(),
        prefs: Arc::new(RwLock::new(Preferences {
            automatic_saver: false,
            ..Default::default()
        })),
        updates: Default::default(),
        announced: Default::default(),
        read_only,
        epoch: now(),
        serial: Arc::new(AtomicU64::new(1)),
        key_fd: Default::default(),
        lid_fd: Default::default(),
        policy_write: Default::default(),
        keyboard_write: Default::default(),
        keyboard_serial: Arc::new(AtomicU64::new(0)),
        menu_wait: Default::default(),
        display_lid: Default::default(),
        brightness_notify: Default::default(),
    }
}
async fn display_forwarding_run() {
    let conn = Connection::session().await.unwrap();
    let p = power(&conn, &conn, false);
    super::display::watch(&p).await.unwrap();
    super::display::update(&p, false);
    // A real bus owner transition starts forwarding without a provider refresh.
    let (display_tx, mut display_rx) = tokio::sync::mpsc::unbounded_channel();
    let display = Connection::session().await.unwrap();
    display
        .object_server()
        .at(
            "/org/nidara/Display",
            DisplayRecorder {
                marker: 1,
                calls: display_tx.clone(),
            },
        )
        .await
        .unwrap();
    display.request_name("org.nidara.Display").await.unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), display_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        (1, false)
    );
    super::display::update(&p, true);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), display_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        (1, true)
    );
    for _ in 0..100 {
        super::display::update(&p, true);
    }
    super::display::update(&p, false);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), display_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        (1, false)
    );
    display.release_name("org.nidara.Display").await.unwrap();
    let replacement_display = Connection::session().await.unwrap();
    replacement_display
        .object_server()
        .at(
            "/org/nidara/Display",
            DisplayRecorder {
                marker: 2,
                calls: display_tx,
            },
        )
        .await
        .unwrap();
    replacement_display
        .request_name("org.nidara.Display")
        .await
        .unwrap();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), display_rx.recv())
            .await
            .unwrap()
            .unwrap(),
        (2, false)
    );
}
#[test]
fn display_lid_forwarding_contract() {
    if std::env::var_os("NIDARA_DISPLAY_LID_TEST_CHILD").is_none() {
        assert!(
            std::process::Command::new("/usr/bin/dbus-run-session")
                .args(["--dbus-daemon=/usr/bin/dbus-daemon", "--"])
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "power::tests::display_lid_forwarding_contract",
                    "--nocapture"
                ])
                .env("NIDARA_DISPLAY_LID_TEST_CHILD", "1")
                .status()
                .unwrap()
                .success()
        );
        return;
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        tokio::time::timeout(Duration::from_secs(20), display_forwarding_run())
            .await
            .expect("Display1 forwarding fixture stalled");
    });
}

async fn run() {
    let fixture = Fixture::default();
    *fixture.active.write().unwrap() = true;
    *fixture.percent.write().unwrap() = 80.;
    *fixture.profile.write().unwrap() = "balanced".into();
    let up = Connection::session().await.unwrap();
    up.request_name(provider::UP).await.unwrap();
    up.object_server().at(provider::UP_PATH, Up).await.unwrap();
    for raw in [
        "/org/freedesktop/UPower/devices/battery",
        "/org/freedesktop/UPower/devices/physical",
    ] {
        up.object_server().at(raw, fixture.clone()).await.unwrap();
    }
    up.object_server()
        .at(
            "/org/freedesktop/UPower/KbdBacklight",
            Keyboard(fixture.clone()),
        )
        .await
        .unwrap();
    let ppd = Connection::session().await.unwrap();
    ppd.request_name(provider::PPD).await.unwrap();
    ppd.object_server()
        .at(provider::PPD_PATH, Profiles(fixture.clone()))
        .await
        .unwrap();
    let login = Connection::session().await.unwrap();
    login.request_name("org.freedesktop.login1").await.unwrap();
    login
        .object_server()
        .at(provider::LOGIN_PATH, Login(fixture.clone()))
        .await
        .unwrap();
    login
        .object_server()
        .at(
            "/org/freedesktop/login1/session/test",
            Session(fixture.clone()),
        )
        .await
        .unwrap();
    let conn = Connection::session().await.unwrap();
    conn.request_name("org.nidara.Session").await.unwrap();
    let p = power(&conn, &conn, false);
    conn.object_server()
        .at(ROOT, zbus::fdo::ObjectManager)
        .await
        .unwrap();
    conn.object_server()
        .at(ROOT, bus::Root(p.clone()))
        .await
        .unwrap();
    p.refresh().await.unwrap();
    assert_eq!(p.property::<String>(ROOT, "State"), "Ready");
    assert_eq!(
        p.property::<String>(ROOT, "PowerButtonEffectiveAction"),
        "suspend"
    );
    let client = Connection::session().await.unwrap();
    let root = Proxy::new(&client, "org.nidara.Session", ROOT, "org.nidara.Power1")
        .await
        .unwrap();
    let om = zbus::fdo::ObjectManagerProxy::builder(&client)
        .destination("org.nidara.Session")
        .unwrap()
        .path(ROOT)
        .unwrap()
        .build()
        .await
        .unwrap();
    let objects = om.get_managed_objects().await.unwrap();
    assert!(objects.len() >= 6);
    let devices = p.property::<Vec<String>>(ROOT, "Devices");
    assert_eq!(devices.len(), 2);
    let physical = p
        .state
        .read()
        .unwrap()
        .objects
        .values()
        .find(|o| o.props["Role"] == "system")
        .unwrap()
        .path
        .clone();
    assert_eq!(p.property::<f64>(&physical, "HealthPercent"), 80.);
    assert_eq!(p.property::<i32>(&physical, "Cycles"), 321);
    // A remove signal retires an identity before the next ObjectManager snapshot.
    p.state.write().unwrap().retired.insert(physical.clone());
    assert!(matches!(
        p.charge(path(&physical), true).await,
        Err(Error::NotFound(_))
    ));
    p.state.write().unwrap().retired.remove(&physical);
    root.call::<_, _, ()>("SetChargeProtection", &(path(&physical), true))
        .await
        .unwrap();
    assert!(p.property::<bool>(&physical, "ChargeProtectionEnabled"));
    assert!(
        root.call::<_, _, ()>("SetChargeProtection", &(path(&physical), false))
            .await
            .unwrap_err()
            .to_string()
            .contains("PermissionDenied")
    );
    root.call::<_, _, ()>("SetProfile", &("power-saver",))
        .await
        .unwrap();
    assert!(p.state.read().unwrap().policy.overridden);
    assert!(
        root.call::<_, _, ()>("SetProfile", &("performance",))
            .await
            .is_err()
    );
    let hold: Path = root
        .call(
            "HoldProfile",
            &("power-saver", "fixture", "org.nidara.fixture"),
        )
        .await
        .unwrap();
    let lease = Proxy::new(
        &client,
        "org.nidara.Session",
        hold.as_str(),
        "org.nidara.PowerProfileHold1",
    )
    .await
    .unwrap();
    let foreign = Connection::session().await.unwrap();
    let foreign_lease = Proxy::new(
        &foreign,
        "org.nidara.Session",
        hold.as_str(),
        "org.nidara.PowerProfileHold1",
    )
    .await
    .unwrap();
    assert!(
        foreign_lease
            .call::<_, _, ()>("Release", &())
            .await
            .unwrap_err()
            .to_string()
            .contains("PermissionDenied")
    );
    lease.call::<_, _, ()>("Release", &()).await.unwrap();
    assert!(p.object(hold.as_str()).is_err());
    let keyboard = p.property::<String>(ROOT, "PrimaryKeyboardBacklight");
    root.call::<_, _, ()>("SetKeyboardBrightness", &(path(&keyboard), 8i32))
        .await
        .unwrap();
    assert_eq!(*fixture.brightness.read().unwrap(), 8);
    root.call::<_, _, ()>("StepPrimaryKeyboardBrightness", &(-1i32,))
        .await
        .unwrap();
    assert_eq!(*fixture.brightness.read().unwrap(), 7);
    assert!(
        root.call::<_, _, ()>("SetKeyboardBrightness", &(path(&keyboard), 11i32))
            .await
            .is_err()
    );
    // Firmware event/readback never writes it back to hardware.
    let before = fixture.calls.lock().await.len();
    *fixture.brightness.write().unwrap() = 2;
    p.refresh().await.unwrap();
    assert_eq!(p.property::<i32>(&keyboard, "Brightness"), 2);
    assert_eq!(fixture.calls.lock().await.len(), before);
    let mut ro = p.clone();
    ro.read_only = true;
    assert!(ro.keyboard(path(&keyboard), 4).await.is_err());
    assert!(ro.profile("balanced".into()).await.is_err());
    assert!(ro.action("suspend", false).await.is_err());
    assert!(ro.charge(path(&physical), true).await.is_err());
    assert!(
        ro.hold(
            "x".into(),
            "power-saver".into(),
            "x".into(),
            "x".into(),
            false
        )
        .await
        .is_err()
    );
    ro.effects(vec![
        Effect::Low,
        Effect::Critical,
        Effect::Hook(1),
        Effect::HoldSaver,
    ])
    .await;
    assert_eq!(fixture.calls.lock().await.len(), before);
    p.state.write().unwrap().hyalo = json!({"locked":false});
    // Substitute a harmless descriptor solely to exercise the menu delivery contract.
    *p.key_fd.lock().await =
        Some(std::os::fd::OwnedFd::from(std::fs::File::open("/dev/null").unwrap()).into());
    p.power_button().await.unwrap();
    assert!(fixture.calls.lock().await.contains(&"suspend:false".into()));
    client
        .object_server()
        .at("/fixture/Menu", MenuCallback)
        .await
        .unwrap();
    let menu: Path = root
        .call("RegisterMenuConsumer", &(path("/fixture/Menu"),))
        .await
        .unwrap();
    *p.key_fd.lock().await =
        Some(std::os::fd::OwnedFd::from(std::fs::File::open("/dev/null").unwrap()).into());
    p.state.write().unwrap().hyalo = json!({"locked":false});
    let before = fixture.calls.lock().await.len();
    assert!(p.power_button().await.is_err());
    assert_eq!(fixture.calls.lock().await.len(), before);
    assert!(p.state.read().unwrap().menu.is_some());
    assert_eq!(
        p.property::<String>(ROOT, "State"),
        "Ready",
        "a consumer error is not degraded provider health"
    );
    let foreign_menu = Proxy::new(
        &foreign,
        "org.nidara.Session",
        menu.as_str(),
        "org.nidara.PowerMenuLease1",
    )
    .await
    .unwrap();
    assert!(
        foreign_menu
            .call::<_, _, ()>("MenuShown", &(1u64,))
            .await
            .unwrap_err()
            .to_string()
            .contains("PermissionDenied")
    );
    p.menu_release(menu.as_str(), client.unique_name().unwrap().as_str())
        .await
        .unwrap();
    // A unique-owner change invalidates the old physical path even when the raw path returns.
    let old = p.object(&physical).unwrap();
    up.release_name(provider::UP).await.unwrap();
    let replacement = Connection::session().await.unwrap();
    replacement.request_name(provider::UP).await.unwrap();
    replacement
        .object_server()
        .at(provider::UP_PATH, Up)
        .await
        .unwrap();
    for raw in [
        "/org/freedesktop/UPower/devices/battery",
        "/org/freedesktop/UPower/devices/physical",
    ] {
        replacement
            .object_server()
            .at(raw, fixture.clone())
            .await
            .unwrap();
    }
    assert!(p.check_object(&old).await.is_err());
    p.refresh().await.unwrap();
    assert!(p.object(&physical).is_err());
    assert!(
        !om.get_managed_objects()
            .await
            .unwrap()
            .contains_key(&path(&physical))
    );
    assert_eq!(p.property::<String>(ROOT, "ActiveProfile"), "power-saver");
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.freedesktop.DBus.Properties")
        .unwrap()
        .path_namespace(ROOT)
        .unwrap()
        .member("PropertiesChanged")
        .unwrap()
        .build();
    let mut updates = zbus::MessageStream::for_match_rule(rule, &client, Some(256))
        .await
        .unwrap();
    // Signal paths, caller cleanup and automatic-saver manual override on the private bus.
    replacement
        .object_server()
        .at(
            "/org/freedesktop/UPower/KbdBacklight",
            Keyboard(fixture.clone()),
        )
        .await
        .unwrap();
    provider::watch(p.clone()).await.unwrap().await.unwrap();
    p.refresh().await.unwrap();

    let ephemeral = Connection::session().await.unwrap();
    let name = ephemeral.unique_name().unwrap().to_string();
    let hold = p
        .hold(
            name,
            "power-saver".into(),
            "caller cleanup".into(),
            "fixture".into(),
            false,
        )
        .await
        .unwrap();
    drop(ephemeral);
    changed(&mut updates, || {
        !p.state.read().unwrap().holds.contains_key(hold.as_str())
    })
    .await;
    let before = fixture.calls.lock().await.len();
    *fixture.brightness.write().unwrap() = 3;
    replacement
        .emit_signal(
            None::<&str>,
            "/org/freedesktop/UPower/KbdBacklight",
            provider::KBD,
            "BrightnessChangedWithSource",
            &(3i32, "internal"),
        )
        .await
        .unwrap();
    changed(&mut updates, || {
        p.state.read().unwrap().objects.values().any(|o| {
            o.kind == "keyboard"
                && o.props["LastChangeSource"] == "internal"
                && o.props["Brightness"] == 3
        })
    })
    .await;
    assert_eq!(
        fixture.calls.lock().await.len(),
        before,
        "firmware signal must not echo SetBrightness"
    );
    p.prefs.write().unwrap().automatic_saver = true;
    *fixture.percent.write().unwrap() = 26.;
    p.refresh().await.unwrap();
    *fixture.percent.write().unwrap() = 20.;
    p.refresh().await.unwrap();
    let automatic = p
        .state
        .read()
        .unwrap()
        .holds
        .values()
        .find(|h| h.automatic)
        .unwrap()
        .clone();
    ppd.emit_signal(
        None::<&str>,
        provider::PPD_PATH,
        provider::PPD,
        "ProfileReleased",
        &(automatic.cookie,),
    )
    .await
    .unwrap();
    changed(&mut updates, || {
        p.state.read().unwrap().policy.overridden
            && p.state.read().unwrap().holds.values().all(|h| !h.automatic)
    })
    .await;
    let epoch = p.state.read().unwrap().providers["ppd"].epoch;
    ppd.release_name(provider::PPD).await.unwrap();
    let ppd2 = Connection::session().await.unwrap();
    ppd2.object_server()
        .at(provider::PPD_PATH, Profiles(fixture.clone()))
        .await
        .unwrap();
    ppd2.request_name(provider::PPD).await.unwrap();
    changed(&mut updates, || {
        p.state.read().unwrap().providers["ppd"].epoch != epoch
            && !p.state.read().unwrap().providers["ppd"].owner.is_empty()
    })
    .await;
    p.refresh().await.unwrap();
    assert!(p.state.read().unwrap().policy.overridden);
    assert!(p.state.read().unwrap().holds.values().all(|h| !h.automatic));
    // Ready forwarding takes two harmless fake logind FDs; route/seat loss drops them.
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
    let listener = tokio::net::UnixListener::bind(crate::hyalo::socket().unwrap()).unwrap();
    let info = Arc::new(RwLock::new(
        json!({"session":true,"nested":false,"locked":false,"power_key_forwarding":true,"docked_known":true,"docked":false,"inhibitors":[],"idle":{}}),
    ));
    let snapshot = info.clone();
    let compositor = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            let snapshot = snapshot.clone();
            tokio::spawn(async move {
                let (read, mut write) = stream.into_split();
                let mut lines = tokio::io::BufReader::new(read).lines();
                let _ = lines.next_line().await;
                let reply = json!({"ok":{"power":snapshot.read().unwrap().clone()}});
                let _ = write.write_all(format!("{reply}\n").as_bytes()).await;
            });
        }
    });
    p.refresh().await.unwrap();
    assert!(
        p.lid_fd.lock().await.is_none(),
        "default suspend belongs to logind even with sleep inhibitors"
    );
    assert_eq!(p.property::<String>(ROOT, "LidHandling"), "logind");
    p.prefs.write().unwrap().lid_battery = "lock".into();
    p.refresh().await.unwrap();
    assert!(p.key_fd.lock().await.is_some());
    assert!(p.lid_fd.lock().await.is_some());
    assert_eq!(
        p.property::<String>(ROOT, "PowerButtonHandling"),
        "sessiond"
    );
    info.write().unwrap()["power_key_forwarding"] = json!(false);
    p.refresh().await.unwrap();
    assert!(p.key_fd.lock().await.is_none());
    assert!(p.lid_fd.lock().await.is_some());
    assert!(p.power_button().await.is_err());
    p.state.write().unwrap().root["OnBatteryKnown"] = json!(false);
    provider::arm_inputs(&p).await;
    assert!(
        p.lid_fd.lock().await.is_none(),
        "unknown power source leaves logind in charge"
    );
    p.refresh().await.unwrap();
    *fixture.active.write().unwrap() = false;
    p.refresh().await.unwrap();
    assert!(p.lid_fd.lock().await.is_none());
    let peers = fixture
        .fd_peers
        .lock()
        .unwrap()
        .iter()
        .map(|peer| peer.try_clone().unwrap())
        .collect::<Vec<_>>();
    for peer in peers {
        let peer = tokio::net::UnixStream::from_std(peer).unwrap();
        peer.readable().await.unwrap();
        assert_eq!(peer.try_read(&mut [0u8; 1]).unwrap(), 0);
    }
    *fixture.active.write().unwrap() = true;
    info.write().unwrap()["power_key_forwarding"] = json!(true);
    p.refresh().await.unwrap();
    client
        .object_server()
        .at("/fixture/Accept", AcceptMenu)
        .await
        .unwrap();
    let menu: Path = root
        .call("RegisterMenuConsumer", &(path("/fixture/Accept"),))
        .await
        .unwrap();
    let mut requests = root.receive_signal("MenuRequested").await.unwrap();
    let press = p.clone();
    let request = tokio::spawn(async move { press.power_button().await });
    let signal = requests.next().await.unwrap();
    let (id,) = signal.body().deserialize::<(u64,)>().unwrap();
    p.menu_shown(menu.as_str(), id, client.unique_name().unwrap().as_str())
        .await
        .unwrap();
    request.await.unwrap().unwrap();
    assert!(matches!(
        p.menu_shown(menu.as_str(), id, client.unique_name().unwrap().as_str())
            .await,
        Err(Error::NotFound(_))
    ));
    let before = fixture.calls.lock().await.len();
    assert!(matches!(p.power_button().await, Err(Error::Timeout(_))));
    assert_eq!(fixture.calls.lock().await.len(), before);
    assert!(p.state.read().unwrap().menu.is_some());
    p.menu_release(menu.as_str(), client.unique_name().unwrap().as_str())
        .await
        .unwrap();
    compositor.abort();
    // Policy override survives serialization and provider restart.
    let saved = serde_json::to_string(&p.state.read().unwrap().policy).unwrap();
    let mut policy: Policy = serde_json::from_str(&saved).unwrap();
    assert!(
        !policy
            .update(
                &Battery {
                    present: true,
                    on_battery: Some(true),
                    percentage: Some(10.),
                    ..Default::default()
                },
                true
            )
            .contains(&Effect::HoldSaver)
    );
}
#[test]
fn private_provider_contract() {
    if std::env::var_os("NIDARA_POWER_TEST_CHILD").is_none() {
        let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/power-test-home");
        std::fs::create_dir_all(&home).unwrap();
        assert!(
            std::process::Command::new("/usr/bin/dbus-run-session")
                .arg("--dbus-daemon=/usr/bin/dbus-daemon")
                .arg("--")
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "power::tests::private_provider_contract",
                    "--nocapture"
                ])
                .env("NIDARA_POWER_TEST_CHILD", "1")
                .env("HOME", &home)
                .env("XDG_STATE_HOME", home.join("state"))
                .env("GSETTINGS_BACKEND", "memory")
                .env("HYALO_SOCKET", "/nonexistent-power-test.sock")
                .env("PATH", home.join("empty-path"))
                .status()
                .unwrap()
                .success()
        );
        return;
    }
    // This is a disposable subprocess: even the system-bus connector targets the fixture.
    unsafe {
        let home = std::fs::canonicalize(std::env::var_os("HOME").unwrap()).unwrap();
        std::env::set_var(
            "HYALO_SOCKET",
            home.join(format!("h{}.sock", std::process::id())),
        );
        std::env::set_var(
            "DBUS_SYSTEM_BUS_ADDRESS",
            std::env::var("DBUS_SESSION_BUS_ADDRESS").unwrap(),
        );
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        tokio::time::timeout(Duration::from_secs(30), run())
            .await
            .expect("Power1 fixture stalled");
    });
}
