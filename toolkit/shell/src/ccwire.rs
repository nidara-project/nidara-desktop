// SPDX-License-Identifier: LGPL-3.0-or-later
//! A private real D-Bus contract test. No default session bus or hardware is used.
use super::*;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
};
use zbus::zvariant::{OwnedObjectPath as Path, OwnedValue};
const AUDIO: &str = "/org/nidara/Audio";
const ONE: &str = "/org/nidara/Audio/nodes/g1/n1";
const TWO: &str = "/org/nidara/Audio/nodes/g1/n2";
struct Bus {
    child: Child,
    dir: std::path::PathBuf,
    address: String,
}
impl Bus {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "nidara-cc-wire-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&dir).unwrap();
        let child = Command::new("dbus-daemon")
            .args([
                "--session",
                "--nofork",
                "--print-address=1",
                &format!("--address=unix:path={}/bus", dir.display()),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut bus = Self {
            address: String::new(),
            dir,
            child,
        };
        BufReader::new(bus.child.stdout.take().unwrap())
            .read_line(&mut bus.address)
            .unwrap();
        bus.address = bus.address.trim().to_owned();
        assert!(bus.address.starts_with("unix:"));
        bus
    }
    fn client(&self) -> Connection {
        zbus::blocking::connection::Builder::address(self.address.as_str())
            .unwrap()
            .method_timeout(Duration::from_secs(2))
            .build()
            .unwrap()
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
struct Graph {
    default: String,
    nodes: HashMap<String, (f64, bool)>,
    calls: Vec<String>,
}
impl Default for Graph {
    fn default() -> Self {
        Self {
            default: ONE.into(),
            nodes: HashMap::from([(ONE.into(), (0.4, false)), (TWO.into(), (0.8, false))]),
            calls: vec![],
        }
    }
}
#[derive(Clone)]
struct Audio(Arc<Mutex<Graph>>);
#[zbus::interface(name = "org.nidara.Audio1")]
impl Audio {
    #[zbus(property)]
    fn default_output(&self) -> Path {
        self.0.lock().unwrap().default.clone().try_into().unwrap()
    }
    #[zbus(property)]
    fn volume_limit(&self) -> f64 {
        1.5
    }
    fn set_default(&self, node: Path) -> zbus::fdo::Result<()> {
        let mut g = self.0.lock().unwrap();
        if !g.nodes.contains_key(node.as_str()) {
            return Err(zbus::fdo::Error::Failed("node removed".into()));
        }
        g.default = node.to_string();
        g.calls.push("default".into());
        Ok(())
    }
    fn set_volume(&self, node: Path, value: f64) -> zbus::fdo::Result<()> {
        let mut g = self.0.lock().unwrap();
        let n = g
            .nodes
            .get_mut(node.as_str())
            .ok_or_else(|| zbus::fdo::Error::Failed("node removed".into()))?;
        n.0 = value;
        g.calls.push("volume".into());
        Ok(())
    }
    fn set_muted(&self, node: Path, value: bool) -> zbus::fdo::Result<()> {
        let mut g = self.0.lock().unwrap();
        let n = g
            .nodes
            .get_mut(node.as_str())
            .ok_or_else(|| zbus::fdo::Error::Failed("node removed".into()))?;
        n.1 = value;
        g.calls.push("mute".into());
        Ok(())
    }
}
#[derive(Clone)]
struct Node {
    graph: Arc<Mutex<Graph>>,
    path: &'static str,
}
#[zbus::interface(name = "org.nidara.AudioNode1")]
impl Node {
    #[zbus(property)]
    fn volume(&self) -> f64 {
        self.graph.lock().unwrap().nodes[self.path].0
    }
    #[zbus(property)]
    fn muted(&self) -> bool {
        self.graph.lock().unwrap().nodes[self.path].1
    }
}
struct Objects(Arc<Mutex<Graph>>);
#[zbus::interface(name = "org.freedesktop.DBus.ObjectManager")]
impl Objects {
    fn get_managed_objects(&self) -> HashMap<Path, HashMap<String, HashMap<String, OwnedValue>>> {
        self.0
            .lock()
            .unwrap()
            .nodes
            .iter()
            .map(|(path, (volume, muted))| {
                let values = HashMap::from([
                    (
                        "Kind".into(),
                        OwnedValue::from(zbus::zvariant::Str::from("output")),
                    ),
                    (
                        "Description".into(),
                        OwnedValue::from(zbus::zvariant::Str::from(if path == ONE {
                            "First output"
                        } else {
                            "Second output"
                        })),
                    ),
                    ("Volume".into(), OwnedValue::from(*volume)),
                    ("Muted".into(), OwnedValue::from(*muted)),
                    (
                        "Capabilities".into(),
                        zbus::zvariant::Value::from(vec!["volume", "mute"])
                            .try_into()
                            .unwrap(),
                    ),
                ]);
                (
                    path.clone().try_into().unwrap(),
                    HashMap::from([("org.nidara.AudioNode1".into(), values)]),
                )
            })
            .collect()
    }
}
fn server(bus: &Bus, graph: &Arc<Mutex<Graph>>) -> Connection {
    zbus::blocking::connection::Builder::address(bus.address.as_str())
        .unwrap()
        .name(SESSION)
        .unwrap()
        .serve_at(AUDIO, Audio(graph.clone()))
        .unwrap()
        .serve_at(AUDIO, Objects(graph.clone()))
        .unwrap()
        .serve_at(
            ONE,
            Node {
                graph: graph.clone(),
                path: ONE,
            },
        )
        .unwrap()
        .serve_at(
            TWO,
            Node {
                graph: graph.clone(),
                path: TWO,
            },
        )
        .unwrap()
        .build()
        .unwrap()
}
#[test]
fn audio_choices_use_real_wire_types_and_cannot_retarget_a_replacement_service() {
    use crate::cc::detail::{Action, Detail, write};
    let bus = Bus::new();
    let graph = Arc::new(Mutex::new(Graph::default()));
    let server = server(&bus, &graph);
    let client = bus.client();
    let mut status = Status::default();
    status.apply(read_volume(&client).unwrap());
    assert_eq!(status.details.audio.len(), 2);
    assert_eq!(status.details.default_output, ONE);
    let mut detail = Detail::new("volume", 1);
    detail.refresh(&status, [0., 50., 396., 400.]);
    let default = detail
        .rows
        .iter()
        .find(|r| matches!(&r.action,Some(Action::AudioDefault(path)) if path==TWO))
        .unwrap()
        .id;
    write(&client, &detail.action(default, None).unwrap()).unwrap();
    assert_eq!(graph.lock().unwrap().default, TWO);
    let volume = detail
        .rows
        .iter()
        .find(|r| matches!(&r.action,Some(Action::AudioVolume(path,_)) if path==ONE))
        .unwrap()
        .id;
    let old = detail.action(volume, Some(74.)).unwrap();
    write(&client, &old).unwrap();
    assert_eq!(graph.lock().unwrap().nodes[ONE].0, 0.74);
    let mute = detail
        .rows
        .iter()
        .find(|r| matches!(&r.action,Some(Action::AudioMute(path,_)) if path==ONE))
        .unwrap()
        .id;
    write(&client, &detail.action(mute, None).unwrap()).unwrap();
    assert!(graph.lock().unwrap().nodes[ONE].1);
    graph.lock().unwrap().nodes.remove(ONE);
    let calls = graph.lock().unwrap().calls.len();
    assert!(write(&client, &old).is_err());
    assert_eq!(graph.lock().unwrap().calls.len(), calls);
    server.close().unwrap();
    let replacement = Arc::new(Mutex::new(Graph::default()));
    let _next = self::server(&bus, &replacement);
    assert!(
        write(&client, &old).is_err(),
        "old unique owner must not become the replacement's same path"
    );
    assert!(replacement.lock().unwrap().calls.is_empty());
}

#[derive(Clone)]
struct PowerFixture(Arc<Mutex<(bool, u32, bool, i64)>>);
struct PowerRoot;
#[zbus::interface(name = "org.nidara.Power1")]
impl PowerRoot {
    #[zbus(property)]
    fn display_device(&self) -> Path {
        "/org/nidara/Power/devices/display".try_into().unwrap()
    }
}
#[zbus::interface(name = "org.nidara.PowerDevice1")]
impl PowerFixture {
    #[zbus(property)]
    fn present(&self) -> bool {
        self.0.lock().unwrap().0
    }
    #[zbus(property)]
    fn percentage_known(&self) -> bool {
        true
    }
    #[zbus(property)]
    fn percentage(&self) -> f64 {
        42.
    }
    #[zbus(property)]
    fn state(&self) -> u32 {
        self.0.lock().unwrap().1
    }
    #[zbus(property)]
    fn time_to_full_known(&self) -> bool {
        self.0.lock().unwrap().2
    }
    #[zbus(property)]
    fn time_to_empty_known(&self) -> bool {
        self.0.lock().unwrap().2
    }
    #[zbus(property)]
    fn time_to_full(&self) -> i64 {
        self.0.lock().unwrap().3
    }
    #[zbus(property)]
    fn time_to_empty(&self) -> i64 {
        self.0.lock().unwrap().3
    }
}
#[test]
fn battery_reads_typed_power_state_known_time_and_hardware_loss_on_a_private_bus() {
    let bus = Bus::new();
    let values = Arc::new(Mutex::new((true, 1, true, 3600i64)));
    let server = zbus::blocking::connection::Builder::address(bus.address.as_str())
        .unwrap()
        .serve_at(POWER_PATH, PowerRoot)
        .unwrap()
        .serve_at(
            "/org/nidara/Power/devices/display",
            PowerFixture(values.clone()),
        )
        .unwrap()
        .name(SESSION)
        .unwrap()
        .build()
        .unwrap();
    let client = bus.client();
    let mut status = Status::default();
    status.apply(read_battery(&client).unwrap());
    assert_eq!(status.battery.unwrap().fraction, 0.42);
    assert_eq!((status.battery_state, status.battery_time), (1, Some(3600)));
    *values.lock().unwrap() = (true, 2, false, 9999);
    status.apply(read_battery(&client).unwrap());
    assert_eq!((status.battery_state, status.battery_time), (2, None));
    *values.lock().unwrap() = (false, 2, true, 3600);
    status.apply(read_battery(&client).unwrap());
    assert!(status.battery.is_none());
    drop(server);
    assert!(read_battery(&client).is_err());
}
