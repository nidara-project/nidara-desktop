// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicU64, Ordering},
};
use zbus::Connection;
#[test]
fn ranges_steps_and_ddc_parser_are_strict() {
    assert_eq!(model::step(1, 100, -1), Some(1));
    assert_eq!(model::step(50, 100, 1), Some(55));
    assert_eq!(model::step(1, 3, 1), Some(2));
    assert_eq!(model::step(3, 3, 1), Some(3));
    assert_eq!(model::step(5, 100, 0), None);
    assert_eq!(model::step(0, 0, 1), None);
    assert_eq!(model::vcp("VCP 10 C 50 100\n"), Some((50, 100)));
    for text in [
        "VCP 10 C 101 100",
        "VCP 10 ERR",
        "VCP 10 C 1 0",
        "VCP 10 C -1 100",
        "VCP 10 C 1 65536",
        "VCP 10 C 1 2\nVCP 10 C 1 2",
    ] {
        assert_eq!(model::vcp(text), None);
    }
}
#[test]
fn recovery_is_finite_read_only_and_resets_after_success() {
    let mut recovery = model::Recovery::default();
    let mut now = Instant::now();
    assert!(recovery.deadline().is_none());
    for delay in [2, 10, 60] {
        recovery.failed(now);
        let due = now + Duration::from_secs(delay);
        assert_eq!(recovery.deadline(), Some(due));
        recovery.failed(now + Duration::from_millis(1));
        assert_eq!(recovery.deadline(), Some(due));
        assert!(!recovery.take_due(due - Duration::from_nanos(1)));
        assert!(recovery.take_due(due));
        assert!(!recovery.take_due(due));
        now = due;
    }
    recovery.failed(now);
    assert!(recovery.deadline().is_none());
    recovery.recovered();
    assert!(recovery.deadline().is_none());
    recovery.failed(now);
    assert_eq!(recovery.deadline(), Some(now + Duration::from_secs(2)));
}
static NEXT: AtomicU64 = AtomicU64::new(0);
struct Tree {
    root: PathBuf,
    paths: Paths,
    hardware: hardware::Snapshot,
    panel: PathBuf,
    external: PathBuf,
}
impl Tree {
    fn new() -> Self {
        use std::os::unix::{fs::PermissionsExt, fs::symlink};
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../target/brightness/tests")
            .join(format!(
                "{}-{}-{}",
                std::process::id(),
                super::super::now(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let sys = root.join("sys");
        let dev = root.join("dev");
        let gpu = sys.join("devices/gpu");
        fs::create_dir_all(sys.join("class/drm")).unwrap();
        fs::create_dir_all(sys.join("class/backlight")).unwrap();
        fs::create_dir_all(&dev).unwrap();
        let mut outputs = Vec::new();
        for (name, id, internal, x) in [
            ("eDP-1", "internal", true, 0),
            ("DP-1", "external", false, 100),
        ] {
            let connector = gpu.join("drm/card0").join(format!("card0-{name}"));
            fs::create_dir_all(&connector).unwrap();
            fs::write(connector.join("status"), "connected\n").unwrap();
            fs::write(connector.join("edid"), id).unwrap();
            symlink(
                &connector,
                sys.join("class/drm").join(format!("card0-{name}")),
            )
            .unwrap();
            outputs.push(hardware::Output {
                id: id.into(),
                identity: id.into(),
                connector: name.into(),
                port: format!("{}:{name}", gpu.display()),
                edid: discovery::edid_key(id.as_bytes()),
                internal,
                enabled: true,
                logical: true,
                x,
                y: 0,
                width: 100,
                height: 100,
                powered: true,
            });
        }
        let panel = gpu.join("backlight/panel");
        fs::create_dir_all(&panel).unwrap();
        symlink(&panel, sys.join("class/backlight/panel")).unwrap();
        for (file, value) in [
            ("type", "raw"),
            ("max_brightness", "100"),
            ("brightness", "50"),
            ("actual_brightness", "50"),
        ] {
            fs::write(panel.join(file), value).unwrap();
        }
        let external = gpu.join("drm/card0/card0-DP-1");
        let i2c = gpu.join("i2c-7");
        fs::create_dir_all(&i2c).unwrap();
        symlink(&i2c, external.join("ddc")).unwrap();
        fs::write(dev.join("i2c-7"), "").unwrap();
        fs::write(root.join("ddc-value"), "50").unwrap();
        fs::write(root.join("ddc-mode"), "normal").unwrap();
        let ddcutil = root.join("ddcutil");
        let script = format!(
            r#"#!/usr/bin/python3
import pathlib,sys,time,os
root=pathlib.Path({:?})
a=sys.argv[1:]
assert a[0:2]==['--bus','7'],a
mode=(root/'ddc-mode').read_text()
if mode=='hang':
    (root/'child-pid').write_text(str(os.getpid()))
    time.sleep(30)
if mode=='fail':sys.exit(1)
if a[2:]==['--terse','getvcp','10']:
    with (root/'ddc-reads').open('a') as f:f.write(str(time.monotonic_ns())+'\n')
    if (root/'ddc-pending').exists():
        value,at=(root/'ddc-pending').read_text().split()
        if time.monotonic()>=float(at):
            (root/'ddc-value').write_text(value)
            (root/'ddc-pending').unlink()
    print('VCP 10 C', (root/'ddc-value').read_text(),100)
elif len(a)==6 and a[2:5]==['--noverify','setvcp','10']:
    with (root/'ddc-writes').open('a') as f:f.write(str(time.monotonic_ns())+' '+a[5]+'\n')
    if mode=='delayed':(root/'ddc-pending').write_text(a[5]+' '+str(time.monotonic()+0.25))
    elif mode!='mismatch':(root/'ddc-value').write_text(a[5])
else:sys.exit(2)
"#,
            root.to_string_lossy()
        );
        fs::write(&ddcutil, script).unwrap();
        fs::set_permissions(&ddcutil, fs::Permissions::from_mode(0o700)).unwrap();
        Self {
            root,
            paths: Paths { sys, dev, ddcutil },
            hardware: hardware::Snapshot {
                epoch: 1,
                revision: 1,
                outputs,
            },
            panel,
            external,
        }
    }
}
impl Drop for Tree {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn associations_require_exact_gpu_port_edid_and_unique_channel() {
    let tree = Tree::new();
    let links = discovery::discover(&tree.paths, &tree.hardware.outputs);
    assert_eq!(links.len(), 2);
    for link in &links {
        discovery::verify(link).unwrap();
    }
    let node = tree.paths.dev.join("i2c-7");
    fs::remove_file(&node).unwrap();
    let pending = discovery::discover(&tree.paths, &tree.hardware.outputs);
    assert_eq!(pending.len(), 2);
    assert!(discovery::verify(pending.iter().find(|l| !l.output.internal).unwrap()).is_err());
    fs::write(&node, "").unwrap();
    discovery::verify(pending.iter().find(|l| !l.output.internal).unwrap()).unwrap();
    fs::write(tree.external.join("edid"), "replacement").unwrap();
    assert!(discovery::verify(links.iter().find(|l| !l.output.internal).unwrap()).is_err());
    assert_eq!(
        discovery::discover(&tree.paths, &tree.hardware.outputs).len(),
        1
    );
    let mut wrong = tree.hardware.outputs.clone();
    wrong[0].port = "/other/gpu:eDP-1".into();
    assert!(discovery::discover(&tree.paths, &wrong).is_empty());
}
// A platform/firmware device has no path or device symlink to the DRM GPU.
fn platform_backlight(tree: &Tree, name: &str, kind: &str) -> PathBuf {
    use std::os::unix::fs::symlink;
    let path = tree.paths.sys.join("devices/platform").join(name);
    fs::create_dir_all(&path).unwrap();
    for (file, value) in [
        ("type", kind),
        ("max_brightness", "100"),
        ("brightness", "50"),
        ("actual_brightness", "50"),
    ] {
        fs::write(path.join(file), value).unwrap();
    }
    symlink(&path, tree.paths.sys.join("class/backlight").join(name)).unwrap();
    path
}
#[test]
fn unique_platform_or_firmware_panel_has_a_revalidated_association() {
    for kind in ["firmware", "platform"] {
        let tree = Tree::new();
        fs::remove_file(tree.paths.sys.join("class/backlight/panel")).unwrap();
        let path = platform_backlight(&tree, "platform-panel", kind);
        let links = discovery::discover(&tree.paths, &tree.hardware.outputs);
        let link = links.iter().find(|l| l.output.internal).unwrap();
        assert!(link.platform_backlights.is_some());
        assert!(matches!(&link.channel, Channel::Panel { path:p, name, .. }
            if p == &path && name == "platform-panel"));
        discovery::verify(link).unwrap();
        fs::write(path.join("type"), "raw").unwrap();
        assert!(discovery::verify(link).is_err());
        assert!(
            !discovery::discover(&tree.paths, &tree.hardware.outputs)
                .iter()
                .any(|l| l.output.internal)
        );
        fs::write(path.join("type"), kind).unwrap();
        // Count a second candidate even with a broken range; never select by order.
        let second = platform_backlight(&tree, "other-panel", "firmware");
        fs::write(second.join("max_brightness"), "invalid").unwrap();
        assert!(discovery::verify(link).is_err());
        assert!(
            !discovery::discover(&tree.paths, &tree.hardware.outputs)
                .iter()
                .any(|l| l.output.internal)
        );
    }
}
#[test]
fn platform_fallback_rejects_multiple_internals_and_associated_raw() {
    let tree = Tree::new();
    let path = platform_backlight(&tree, "platform-panel", "platform");
    let links = discovery::discover(&tree.paths, &tree.hardware.outputs);
    let raw = links.iter().find(|l| l.output.internal).unwrap();
    assert!(raw.platform_backlights.is_none());
    assert!(matches!(&raw.channel, Channel::Panel { path:p, .. } if p == &tree.panel));
    // Even an unusable associated raw blocks fallback to a global device.
    fs::write(tree.panel.join("max_brightness"), "invalid").unwrap();
    assert!(
        !discovery::discover(&tree.paths, &tree.hardware.outputs)
            .iter()
            .any(|l| l.output.internal)
    );
    fs::remove_file(tree.paths.sys.join("class/backlight/panel")).unwrap();
    let mut outputs = tree.hardware.outputs.clone();
    let mut second = outputs[0].clone();
    second.id = "another-internal".into();
    second.port = "/another-gpu:eDP-2".into();
    second.enabled = false;
    outputs.push(second);
    assert!(
        !discovery::discover(&tree.paths, &outputs)
            .iter()
            .any(|l| l.output.internal)
    );
    outputs.pop();
    let links = discovery::discover(&tree.paths, &outputs);
    let link = links.iter().find(|l| l.output.internal).unwrap();
    discovery::verify(link).unwrap();
    // A newly associated raw also invalidates an already discovered fallback.
    use std::os::unix::fs::symlink;
    symlink(&tree.panel, tree.paths.sys.join("class/backlight/panel")).unwrap();
    assert!(discovery::verify(link).is_err());
    fs::remove_file(tree.paths.sys.join("class/backlight/panel")).unwrap();
    outputs[0].edid.clear();
    assert!(
        !discovery::discover(&tree.paths, &outputs)
            .iter()
            .any(|l| l.output.internal)
    );
    fs::write(path.join("type"), "unknown").unwrap();
    assert!(
        !discovery::discover(&tree.paths, &tree.hardware.outputs)
            .iter()
            .any(|l| l.output.internal)
    );
}
#[derive(Clone)]
struct FakeSession {
    active: Arc<AtomicBool>,
    deny: Arc<AtomicBool>,
    panel: PathBuf,
    calls: Arc<Mutex<Vec<(Instant, u32)>>>,
}
#[zbus::interface(name = "org.freedesktop.login1.Session")]
impl FakeSession {
    #[zbus(property)]
    fn active(&self) -> bool {
        self.active.load(Ordering::SeqCst)
    }
    #[zbus(property)]
    fn remote(&self) -> bool {
        false
    }
    fn set_brightness(&self, subsystem: &str, name: &str, value: u32) -> zbus::fdo::Result<()> {
        assert_eq!((subsystem, name), ("backlight", "panel"));
        if self.deny.load(Ordering::SeqCst) {
            return Err(zbus::fdo::Error::AccessDenied("fixture denial".into()));
        }
        self.calls.lock().unwrap().push((Instant::now(), value));
        fs::write(self.panel.join("brightness"), value.to_string()).unwrap();
        fs::write(self.panel.join("actual_brightness"), value.to_string()).unwrap();
        Ok(())
    }
}
struct FakeDisplay(Arc<Mutex<hardware::Snapshot>>);
#[zbus::interface(name = "org.nidara.Display1")]
impl FakeDisplay {
    fn get_hardware_state(&self) -> hardware::Snapshot {
        self.0.lock().unwrap().clone()
    }
}
async fn until(mut predicate: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(6);
    while !predicate() {
        assert!(Instant::now() < deadline, "brightness fixture timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
async fn run() {
    let mut tree = Tree::new();
    fs::remove_file(tree.paths.sys.join("class/backlight/panel")).unwrap();
    tree.panel = platform_backlight(&tree, "panel", "firmware");
    let provider = Connection::session().await.unwrap();
    let session = FakeSession {
        active: Arc::new(AtomicBool::new(true)),
        deny: Default::default(),
        panel: tree.panel.clone(),
        calls: Default::default(),
    };
    provider
        .object_server()
        .at("/session/one", session.clone())
        .await
        .unwrap();
    provider
        .request_name("org.freedesktop.login1")
        .await
        .unwrap();
    let display = Connection::session().await.unwrap();
    let hardware = Arc::new(Mutex::new(tree.hardware.clone()));
    display
        .object_server()
        .at("/org/nidara/Display", FakeDisplay(hardware.clone()))
        .await
        .unwrap();
    display.request_name(DISPLAY).await.unwrap();
    let conn = Connection::session().await.unwrap();
    conn.request_name("org.nidara.Session").await.unwrap();
    let power = super::super::tests::power(&conn, &conn, false);
    {
        let mut s = power.state.write().unwrap();
        s.providers.insert(
            "logind",
            super::super::Provider {
                owner: provider.unique_name().unwrap().to_string(),
                epoch: 7,
                error: String::new(),
            },
        );
        s.root = serde_json::json!({"SessionActive":true,"SessionPath":"/session/one"});
    }
    fs::write(tree.root.join("ddc-mode"), "fail").unwrap();
    let service = start(power.clone(), tree.paths.clone()).await.unwrap();
    service.refresh(false).await.unwrap();
    until(|| {
        let state = service.state.lock().unwrap();
        state
            .entries
            .values()
            .any(|e| e.device.provider == "ddc" && !e.probing && e.recovery.deadline().is_some())
    })
    .await;
    fs::write(tree.root.join("ddc-mode"), "normal").unwrap();
    until(|| {
        service
            .snapshot()
            .devices
            .iter()
            .filter(|d| d.available)
            .count()
            == 2
    })
    .await;
    assert!(!tree.root.join("ddc-writes").exists());
    // Healthy DDC has no timer; recovery after the initial failure issued reads only.
    assert!(service.next_recovery().is_none());
    let old_ids: Vec<_> = service
        .snapshot()
        .devices
        .iter()
        .map(|d| d.id.clone())
        .collect();
    hardware.lock().unwrap().outputs[1].powered = false;
    service.refresh(false).await.unwrap();
    assert!(
        !service
            .snapshot()
            .devices
            .iter()
            .find(|d| d.provider == "ddc")
            .unwrap()
            .writable
    );
    hardware.lock().unwrap().outputs[1].powered = true;
    service.refresh(false).await.unwrap();
    until(|| {
        service
            .snapshot()
            .devices
            .iter()
            .filter(|d| d.available)
            .count()
            == 2
    })
    .await;
    assert!(
        service
            .snapshot()
            .devices
            .iter()
            .all(|d| !old_ids.contains(&d.id))
    );
    assert!(!tree.root.join("ddc-writes").exists());
    // Only an authenticated PrepareForSleep(false) wakes the existing service.
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface("org.freedesktop.login1.Manager")
        .unwrap()
        .member("PrepareForSleep")
        .unwrap()
        .build();
    let mut signals = zbus::MessageStream::for_match_rule(rule, &conn, Some(8))
        .await
        .unwrap();
    for (emitter, sleeping, path, accepted) in [
        (&conn, false, "/org/freedesktop/login1", false),
        (&provider, true, "/org/freedesktop/login1", false),
        (&provider, false, "/wrong", false),
        (&provider, false, "/org/freedesktop/login1", true),
    ] {
        let old = service.snapshot().devices[0].id.clone();
        emitter
            .emit_signal(
                None::<&str>,
                path,
                "org.freedesktop.login1.Manager",
                "PrepareForSleep",
                &(sleeping,),
            )
            .await
            .unwrap();
        let message = signals.next().await.unwrap().unwrap();
        assert_eq!(provider::brightness_resume(&power, &message), accepted);
        if accepted {
            until(|| {
                let snap = service.snapshot();
                snap.devices.len() == 2 && snap.devices.iter().all(|d| d.available && d.id != old)
            })
            .await;
        }
    }
    assert!(!tree.root.join("ddc-writes").exists());
    let internal = service
        .snapshot()
        .devices
        .into_iter()
        .find(|d| d.provider == "logind")
        .unwrap();
    let target = service.target(&internal.id).unwrap();
    assert!(target.link.platform_backlights.is_some());
    // Fresh compositor state must reject a second internal even before its signal
    // reaches the service; never write using a cached global-uniqueness decision.
    let mut second = tree.hardware.outputs[0].clone();
    second.id = "second-gpu-internal".into();
    second.port = "/other-gpu:eDP-2".into();
    hardware.lock().unwrap().outputs.push(second);
    assert!(matches!(service.guard(&target).await, Err(Error::Stale(_))));
    hardware.lock().unwrap().outputs.pop();
    assert!(session.calls.lock().unwrap().is_empty());
    let client = Connection::session().await.unwrap();
    let proxy = zbus::Proxy::new(&client, "org.nidara.Session", ROOT, IFACE)
        .await
        .unwrap();
    let snapshot: Snapshot = proxy.call("GetState", &()).await.unwrap();
    assert_eq!(snapshot.devices.len(), 2);
    let mut panel = snapshot
        .devices
        .iter()
        .find(|d| d.provider == "logind")
        .unwrap()
        .clone();
    let actual: Device = proxy
        .call("SetBrightness", &(&panel.id, panel.epoch, 75u32))
        .await
        .unwrap();
    assert_eq!(actual.current, 75);
    assert_eq!(session.calls.lock().unwrap().len(), 1);
    assert!(
        proxy
            .call::<_, _, Device>("SetBrightness", &(&panel.id, panel.epoch + 1, 80u32))
            .await
            .is_err()
    );
    assert_eq!(session.calls.lock().unwrap().len(), 1);
    // Withdrawal during the rate/lock wait must finish the pending method, not leave
    // its reply sender stranded in an unavailable entry. The lock makes this deterministic.
    let channel = service.target(&panel.id).unwrap().io;
    let held = channel.lock().await;
    let waiting = {
        let s = service.clone();
        let p = panel.clone();
        tokio::spawn(async move { s.enqueue(p.id, p.epoch, Some(80), None).await })
    };
    until(|| {
        service.state.lock().unwrap().entries[&panel.id]
            .desired
            .is_some()
    })
    .await;
    fs::write(tree.panel.join("actual_brightness"), "invalid").unwrap();
    service.panels().await;
    assert!(waiting.await.unwrap().is_err());
    assert_eq!(session.calls.lock().unwrap().len(), 1);
    drop(held);
    fs::write(tree.panel.join("actual_brightness"), "75").unwrap();
    // A fresh output epoch must not reset the physical channel's rate limiter.
    hardware.lock().unwrap().outputs[0].id = "internal-epoch2".into();
    service.refresh(false).await.unwrap();
    until(|| {
        service
            .snapshot()
            .devices
            .iter()
            .filter(|d| d.available)
            .count()
            == 2
    })
    .await;
    let fresh = service.snapshot();
    panel = fresh
        .devices
        .iter()
        .find(|d| d.provider == "logind")
        .unwrap()
        .clone();
    let ddc = fresh
        .devices
        .iter()
        .find(|d| d.provider == "ddc")
        .unwrap()
        .clone();
    service
        .enqueue(panel.id.clone(), panel.epoch, Some(76), None)
        .await
        .unwrap();
    let firmware_before = session.calls.lock().unwrap().len();
    // Firmware changes update observation, with no echo write through logind.
    fs::write(tree.panel.join("actual_brightness"), "25").unwrap();
    service.panels().await;
    assert_eq!(
        service
            .snapshot()
            .devices
            .iter()
            .find(|d| d.id == panel.id)
            .unwrap()
            .current,
        25
    );
    assert_eq!(session.calls.lock().unwrap().len(), firmware_before);
    let initial_serial = service.state.lock().unwrap().entries[&panel.id].serial;
    let mut requests = Vec::new();
    for n in 30..60 {
        let s = service.clone();
        let p = panel.clone();
        requests.push(tokio::spawn(async move {
            s.enqueue(p.id, p.epoch, Some(n), None).await
        }));
    }
    until(|| service.state.lock().unwrap().entries[&panel.id].serial >= initial_serial + 30).await;
    let final_value = service
        .enqueue(panel.id.clone(), panel.epoch, Some(90), None)
        .await
        .unwrap();
    assert_eq!(final_value.current, 90);
    for request in requests {
        let _ = request.await.unwrap();
    }
    let calls = session.calls.lock().unwrap().clone();
    assert!(calls.len() < 10, "drag was not coalesced");
    let stepped = service.step(1).await.unwrap();
    assert_eq!(stepped.output_id, panel.output_id);
    assert_eq!(stepped.current, 95);
    // Fn must not jump from an outdated UI sample after a firmware change/wake.
    fs::write(tree.panel.join("brightness"), "10").unwrap();
    fs::write(tree.panel.join("actual_brightness"), "10").unwrap();
    assert_eq!(service.step(1).await.unwrap().current, 15);
    // Measure issue times at the service, not delivery times at a scheduled fake provider.
    // Slow CI cannot turn compliant spacing into an apparent server-arrival burst.
    let channel = service
        .io
        .lock()
        .unwrap()
        .get(&tree.panel.to_string_lossy().into_owned())
        .unwrap()
        .clone();
    let issues = channel.lock().await.issues.clone();
    assert_eq!(issues.len(), session.calls.lock().unwrap().len());
    for pair in issues.windows(2) {
        assert!(
            pair[1].duration_since(pair[0]) >= Duration::from_millis(250),
            "write issues exceeded 4/s across callers or epochs"
        );
    }
    fs::write(tree.root.join("ddc-mode"), "delayed").unwrap();
    fs::write(tree.root.join("ddc-reads"), "").unwrap();
    let observed: Device = proxy
        .call("SetBrightness", &(&ddc.id, ddc.epoch, 77u32))
        .await
        .unwrap();
    assert_eq!(observed.current, 77);
    let reads: Vec<u64> = fs::read_to_string(tree.root.join("ddc-reads"))
        .unwrap()
        .lines()
        .map(|line| line.parse().unwrap())
        .collect();
    assert!(reads.len() >= 2);
    for pair in reads.windows(2) {
        assert!(pair[1] - pair[0] >= 100_000_000);
    }
    assert_eq!(
        fs::read_to_string(tree.root.join("ddc-writes"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    fs::write(tree.root.join("ddc-mode"), "normal").unwrap();
    assert_eq!(
        fs::read_to_string(tree.root.join("ddc-value")).unwrap(),
        "77"
    );
    // Read-only mode rejects before issuing any provider action.
    let mut readonly = service.clone();
    readonly.power.read_only = true;
    assert!(matches!(
        readonly
            .enqueue(panel.id.clone(), panel.epoch, Some(50), None)
            .await,
        Err(Error::PermissionDenied(_))
    ));
    assert!(matches!(
        readonly.step(1).await,
        Err(Error::PermissionDenied(_))
    ));
    // Cached active=true is insufficient: the live session property must still agree.
    session.active.store(false, Ordering::SeqCst);
    let before = session.calls.lock().unwrap().len();
    assert!(
        service
            .enqueue(panel.id.clone(), panel.epoch, Some(50), None)
            .await
            .is_err()
    );
    assert_eq!(session.calls.lock().unwrap().len(), before);
    session.active.store(true, Ordering::SeqCst);
    // A hung DDC child is cancelled and reaped when the bound output disappears.
    fs::write(tree.root.join("ddc-mode"), "hang").unwrap();
    let pending = {
        let s = service.clone();
        let d = ddc.clone();
        tokio::spawn(async move { s.enqueue(d.id, d.epoch, Some(40), None).await })
    };
    until(|| tree.root.join("child-pid").exists()).await;
    let pid: i32 = fs::read_to_string(tree.root.join("child-pid"))
        .unwrap()
        .parse()
        .unwrap();
    hardware.lock().unwrap().outputs.retain(|o| o.internal);
    display
        .emit_signal(
            None::<&str>,
            "/org/nidara/Display",
            "org.nidara.Display1",
            "Changed",
            &(1u64, 2u64),
        )
        .await
        .unwrap();
    until(|| service.snapshot().devices.len() == 1).await;
    assert!(pending.await.unwrap().is_err());
    until(|| unsafe { libc::kill(pid, 0) } < 0).await;
    assert!(
        service
            .enqueue(ddc.id, ddc.epoch, Some(10), None)
            .await
            .is_err()
    );
    // Reconnection gets fresh opaque ids. A successful Set packet without readback
    // must withdraw the channel rather than returning optimistic success.
    fs::write(tree.root.join("ddc-mode"), "mismatch").unwrap();
    let mut reconnected = tree.hardware.outputs[1].clone();
    reconnected.id = "external-v2".into();
    hardware.lock().unwrap().outputs.push(reconnected);
    service.refresh(false).await.unwrap();
    until(|| {
        service
            .snapshot()
            .devices
            .iter()
            .filter(|d| d.available)
            .count()
            == 2
    })
    .await;
    let replacement = service.snapshot();
    let ddc2 = replacement
        .devices
        .iter()
        .find(|d| d.provider == "ddc")
        .unwrap();
    assert!(
        service
            .enqueue(ddc2.id.clone(), ddc2.epoch, Some(66), None)
            .await
            .is_err()
    );
    assert!(
        !service
            .snapshot()
            .devices
            .iter()
            .find(|d| d.id == ddc2.id)
            .unwrap()
            .available
    );
    let writes = fs::read_to_string(tree.root.join("ddc-writes")).unwrap();
    until(|| {
        service
            .snapshot()
            .devices
            .iter()
            .any(|d| d.provider == "ddc" && d.available && d.epoch != ddc2.epoch)
    })
    .await;
    assert_eq!(
        fs::read_to_string(tree.root.join("ddc-writes")).unwrap(),
        writes
    );
    assert_eq!(
        fs::read_to_string(tree.root.join("ddc-value")).unwrap(),
        "77"
    );
    let panel2 = replacement
        .devices
        .iter()
        .find(|d| d.provider == "logind")
        .unwrap();
    session.deny.store(true, Ordering::SeqCst);
    let before = session.calls.lock().unwrap().len();
    assert!(matches!(
        service
            .enqueue(panel2.id.clone(), panel2.epoch, Some(20), None)
            .await,
        Err(Error::PermissionDenied(_))
    ));
    assert_eq!(session.calls.lock().unwrap().len(), before);
    session.deny.store(false, Ordering::SeqCst);
    hardware.lock().unwrap().outputs.retain(|o| o.internal);
    service.refresh(false).await.unwrap();
    until(|| service.snapshot().devices.iter().any(|d| d.available)).await;
    // Existing Power1 authority changes drive this service, without another logind watcher.
    power.state.write().unwrap().root["SessionActive"] = serde_json::json!(false);
    power.brightness_notify.notify_one();
    until(|| !service.state.lock().unwrap().context.active).await;
    assert!(service.snapshot().devices.iter().all(|d| !d.writable));
    power.state.write().unwrap().root["SessionActive"] = serde_json::json!(true);
    power.brightness_notify.notify_one();
    until(|| {
        let active = service.state.lock().unwrap().context.active;
        active && service.snapshot().devices.iter().any(|d| d.available)
    })
    .await;
    let panel3 = service.snapshot().devices[0].clone();
    provider
        .release_name("org.freedesktop.login1")
        .await
        .unwrap();
    assert!(
        service
            .enqueue(panel3.id, panel3.epoch, Some(30), None)
            .await
            .is_err()
    );
    assert_eq!(session.calls.lock().unwrap().len(), before);
    // A replacement bus owner cannot inherit an old device id.
    display.release_name(DISPLAY).await.unwrap();
    until(|| service.snapshot().devices.is_empty()).await;
    assert!(service.snapshot().devices.is_empty());
    assert!(
        service
            .enqueue(panel.id, panel.epoch, Some(20), None)
            .await
            .is_err()
    );
    proxy.call::<_, _, u64>("Refresh", &()).await.unwrap();
    assert!(proxy.call::<_, _, u64>("Refresh", &()).await.is_err());
    println!(
        "brightness private-bus/readback/coalescing/session/hotplug/cancellation contract passed"
    );
}
#[test]
fn private_bus_brightness_contract() {
    if std::env::var_os("NIDARA_BRIGHTNESS_TEST_CHILD").is_none() {
        assert!(
            std::process::Command::new("/usr/bin/dbus-run-session")
                .args(["--dbus-daemon=/usr/bin/dbus-daemon", "--"])
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "power::brightness::tests::private_bus_brightness_contract",
                    "--nocapture"
                ])
                .env("NIDARA_BRIGHTNESS_TEST_CHILD", "1")
                .status()
                .unwrap()
                .success()
        );
        return;
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        tokio::time::timeout(Duration::from_secs(30), run())
            .await
            .expect("brightness private bus stalled");
    });
}

#[test]
fn fn_helper_falls_back_only_when_our_service_is_confirmed_missing() {
    use std::os::unix::fs::PermissionsExt;
    let tree = Tree::new();
    let tools = tree.root.join("tools");
    fs::create_dir_all(&tools).unwrap();
    let gdbus = tools.join("gdbus");
    let brightnessctl = tools.join("brightnessctl");
    let log = tree.root.join("fallback-log");
    fs::write(&gdbus,"#!/bin/sh\ncase \"$*\" in *NameHasOwner*) printf '%s\\n' \"$FIXTURE_OWNER\"; exit 0;; esac\nprintf 'GDBus.Error:%s: fixture\\n' \"$FIXTURE_ERROR\" >&2\nexit 1\n").unwrap();
    fs::write(&brightnessctl,"#!/bin/sh\n[ \"$1\" = -n ] && [ \"$2\" = s ] && [ \"$3\" = '5%-' ] || exit 3\nprintf 'fallback\\n' >> \"$FIXTURE_LOG\"\n").unwrap();
    for file in [&gdbus, &brightnessctl] {
        fs::set_permissions(file, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let helper =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../bin/nidara-display-brightness");
    for (error, owner, expected, fallback) in [
        (
            "org.freedesktop.DBus.Error.ServiceUnknown",
            "(false,)",
            true,
            true,
        ),
        (
            "org.freedesktop.DBus.Error.ServiceUnknown",
            "(true,)",
            false,
            false,
        ),
        (
            "org.nidara.DisplayBrightness1.Error.PermissionDenied",
            "(false,)",
            false,
            false,
        ),
        (
            "org.nidara.DisplayBrightness1.Error.Timeout",
            "(false,)",
            false,
            false,
        ),
        (
            "org.freedesktop.DBus.Error.NoReply",
            "(false,)",
            false,
            false,
        ),
        (
            "org.freedesktop.DBus.Error.NameHasNoOwner",
            "(false,)",
            false,
            false,
        ),
        (
            "org.nidara.DisplayBrightness1.Error.Superseded",
            "(false,)",
            true,
            false,
        ),
    ] {
        let before = fs::read_to_string(&log).unwrap_or_default();
        let result = std::process::Command::new(&helper)
            .arg("down")
            .env("PATH", &tools)
            .env("FIXTURE_ERROR", error)
            .env("FIXTURE_OWNER", owner)
            .env("FIXTURE_LOG", &log)
            .output()
            .unwrap();
        assert_eq!(result.status.success(), expected, "{error}");
        let after = fs::read_to_string(&log).unwrap_or_default();
        assert_eq!(after.len() > before.len(), fallback, "{error}");
    }
}

#[test]
fn duplicate_backlights_and_shared_ddc_buses_are_not_guessed() {
    use std::os::unix::fs::symlink;
    let tree = Tree::new();
    symlink(&tree.panel, tree.paths.sys.join("class/backlight/second")).unwrap();
    let mut outputs = tree.hardware.outputs.clone();
    let mut duplicate = outputs[1].clone();
    duplicate.id = "duplicate".into();
    outputs.push(duplicate);
    assert!(discovery::discover(&tree.paths, &outputs).is_empty());
}
#[test]
fn ddc_deadline_cancellation_and_output_bounds_are_enforced() {
    let tree = Tree::new();
    fs::write(tree.root.join("ddc-mode"), "hang").unwrap();
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let (cancel, rx) = watch::channel(false);
        let paths = tree.paths.clone();
        let task = tokio::spawn(async move {
            process::run(
                &paths.ddcutil,
                &[
                    "--bus".into(),
                    "7".into(),
                    "--terse".into(),
                    "getvcp".into(),
                    "10".into(),
                ],
                rx,
            )
            .await
        });
        until(|| tree.root.join("child-pid").exists()).await;
        let pid: i32 = fs::read_to_string(tree.root.join("child-pid"))
            .unwrap()
            .parse()
            .unwrap();
        cancel.send(true).unwrap();
        assert!(matches!(task.await.unwrap(), Err(Error::Stale(_))));
        until(|| unsafe { libc::kill(pid, 0) } < 0).await;
        fs::remove_file(tree.root.join("child-pid")).unwrap();
        let (_cancel, rx) = watch::channel(false);
        let result = process::run(
            &tree.paths.ddcutil,
            &[
                "--bus".into(),
                "7".into(),
                "--terse".into(),
                "getvcp".into(),
                "10".into(),
            ],
            rx,
        )
        .await;
        assert!(matches!(result,Err(Error::Unavailable(s))if s.contains("deadline")));
        let pid: i32 = fs::read_to_string(tree.root.join("child-pid"))
            .unwrap()
            .parse()
            .unwrap();
        until(|| unsafe { libc::kill(pid, 0) } < 0).await;
        // Bounded pipes reject excessive output rather than retaining an unbounded Vec.
        for code in [
            "import sys; sys.stdout.write('x'*70000)",
            "import sys; sys.stderr.write('x'*20000)",
        ] {
            fs::write(&tree.paths.ddcutil, format!("#!/usr/bin/python3\n{code}\n")).unwrap();
            let (_cancel, rx) = watch::channel(false);
            assert!(matches!(
                process::run(&tree.paths.ddcutil, &[], rx).await,
                Err(Error::Unavailable(s)) if s.contains("output bounds")
            ));
        }
    });
}
