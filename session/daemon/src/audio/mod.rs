// SPDX-License-Identifier: GPL-3.0-or-later
//! Audio1, opt-in. WirePlumber owns graph policy and persistent mixer state.
mod bus;
mod model;
#[cfg(feature = "audio-native")]
mod native;
#[cfg(feature = "audio-native")]
mod sound;
#[cfg(feature = "audio-native")]
mod streams;
use model::{Graph, Preferences};
use std::collections::BTreeMap;
use std::sync::{
    Arc, RwLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use tokio::sync::{Notify, oneshot, watch};
use zbus::{Connection, zvariant::OwnedObjectPath as Path};
pub const ROOT: &str = "/org/nidara/Audio";
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.Audio1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    Unavailable(String),
    NotSupported(String),
    InvalidArgument(String),
    NotFound(String),
    PermissionDenied(String),
    Busy(String),
    Timeout(String),
    Failed(String),
    Superseded(String),
}
#[cfg_attr(not(feature = "audio-native"), allow(dead_code))]
#[derive(Clone, Debug)]
pub enum Action {
    Volume(f64),
    Muted(bool),
    Balance(f64),
    Default,
    ClearDefault(String),
    Move(Option<String>),
    Profile,
    Route(String),
    Switch(bool),
    Synchronize,
}
#[cfg_attr(not(feature = "audio-native"), allow(dead_code))]
pub struct Request {
    pub path: String,
    pub generation: u64,
    pub sequence: u64,
    pub action: Action,
    pub reply: oneshot::Sender<Result<(), Error>>,
}
#[derive(Clone)]
pub struct Backend {
    pub commands: std::sync::mpsc::Sender<Request>,
}
impl Backend {
    async fn send(
        &self,
        path: &str,
        generation: u64,
        action: Action,
        sequence: u64,
    ) -> Result<(), Error> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(Request {
                path: path.into(),
                generation,
                sequence,
                action,
                reply: tx,
            })
            .map_err(|_| Error::Unavailable("audio worker stopped".into()))?;
        tokio::time::timeout(Duration::from_secs(5), rx)
            .await
            .map_err(|_| Error::Timeout("audio worker did not answer".into()))?
            .map_err(|_| Error::Unavailable("audio worker stopped".into()))?
    }
}
struct PendingVolume {
    sequence: u64,
    changed: Arc<Notify>,
}
#[derive(Clone)]
pub struct Audio {
    graph: Arc<RwLock<Graph>>,
    prefs: Arc<RwLock<Preferences>>,
    backend: Backend,
    changed: Arc<Notify>,
    sequence: Arc<AtomicU64>,
    announced_root: Arc<std::sync::Mutex<bus::Props>>,
    pending: Arc<std::sync::Mutex<BTreeMap<String, PendingVolume>>>,
    #[cfg(feature = "audio-native")]
    streams: streams::Manager,
}
impl Audio {
    fn snapshot(&self) -> Graph {
        self.graph.read().unwrap().clone()
    }
    async fn apply(&self, path: &str, action: Action) -> Result<(), Error> {
        let before = self.snapshot();
        match &action {
            Action::Volume(v) => {
                model::finite(*v, 0.0, self.prefs.read().unwrap().limit())?;
                before.node(path, Some("volume"))?;
            }
            Action::Muted(_) => {
                before.node(path, Some("mute"))?;
            }
            Action::Balance(v) => {
                model::finite(*v, -1.0, 1.0)?;
                before.node(path, Some("balance"))?;
            }
            Action::Default => {
                let n = before.node(path, None)?;
                if !before.defaults_available {
                    return Err(Error::NotSupported(
                        "default-node metadata unavailable".into(),
                    ));
                }
                if !matches!(n.kind.as_str(), "input" | "output") {
                    return Err(Error::InvalidArgument("default must be an endpoint".into()));
                }
            }
            Action::Move(target) => {
                let n = before.node(path, Some("move"))?;
                if n.kind != "playback" {
                    return Err(Error::InvalidArgument(
                        "only playback streams can be moved".into(),
                    ));
                }
                if let Some(t) = target
                    && before.node(t, None)?.kind != "output"
                {
                    return Err(Error::InvalidArgument("target must be an output".into()));
                }
            }
            Action::Profile => {
                if !before.profiles.contains_key(path) {
                    return Err(Error::NotFound("profile removed".into()));
                }
            }
            Action::Route(route) => {
                let n = before.node(path, Some("routes"))?;
                if !n.routes.contains(route) {
                    return Err(Error::InvalidArgument(
                        "route does not belong to node".into(),
                    ));
                }
            }
            Action::ClearDefault(s) => {
                if matches!(before.state.as_str(), "ready" | "degraded")
                    && !before.defaults_available
                {
                    return Err(Error::NotSupported(
                        "default-node metadata unavailable".into(),
                    ));
                }
                if !matches!(s.as_str(), "input" | "output") {
                    return Err(Error::InvalidArgument("expected input or output".into()));
                }
            }
            Action::Switch(_) | Action::Synchronize => {}
        }
        let ticket = if matches!(action, Action::Volume(_)) {
            let sequence = self.sequence.fetch_add(1, Ordering::Relaxed);
            let changed = Arc::new(Notify::new());
            let mut pending = self.pending.lock().unwrap();
            if let Some(old) = pending.insert(
                path.into(),
                PendingVolume {
                    sequence,
                    changed: changed.clone(),
                },
            ) {
                old.changed.notify_one();
            }
            Some((sequence, changed))
        } else {
            None
        };
        let wait = async {
            self.backend
                .send(
                    path,
                    before.generation,
                    action.clone(),
                    ticket.as_ref().map_or(0, |t| t.0),
                )
                .await?;
            if matches!(
                action,
                Action::ClearDefault(_) | Action::Switch(_) | Action::Synchronize
            ) {
                return Ok(());
            }
            let deadline = tokio::time::Instant::now()
                + Duration::from_secs(
                    if matches!(
                        action,
                        Action::Volume(_) | Action::Muted(_) | Action::Balance(_)
                    ) {
                        5
                    } else {
                        15
                    },
                );
            loop {
                let notified = self.changed.notified();
                let graph = self.snapshot();
                if graph.generation != before.generation || graph.state == "unavailable" {
                    return Err(Error::Unavailable("audio provider disconnected".into()));
                }
                let n = graph.nodes.get(path);
                let confirmed = match &action {
                    Action::Volume(v) => n.is_some_and(|n| (n.volume - v).abs() < 0.002),
                    Action::Muted(v) => n.is_some_and(|n| n.muted == *v),
                    Action::Balance(v) => {
                        n.is_some_and(|n| (model::balance(&n.channels) - v).abs() < 0.005)
                    }
                    Action::Default => graph.default_input == path || graph.default_output == path,
                    Action::Move(Some(t)) => n.is_some_and(|n| n.targets.contains(t)),
                    Action::Move(None) => n.is_some_and(|n| {
                        n.requested_target == "/" && n.targets.contains(&graph.default_output)
                    }),
                    Action::Profile => graph
                        .profiles
                        .get(path)
                        .and_then(|p| graph.devices.get(&p.device))
                        .is_some_and(|d| d.active_profile == path),
                    Action::Route(r) => graph.routes.get(r).is_some_and(|r| r.active),
                    _ => true,
                };
                if confirmed {
                    return Ok(());
                }
                if n.is_none() && !matches!(action, Action::Profile) {
                    return Err(Error::NotFound("target removed during operation".into()));
                }
                tokio::time::timeout_at(deadline, notified)
                    .await
                    .map_err(|_| {
                        Error::Timeout(
                            "backend result not confirmed; operation may still complete".into(),
                        )
                    })?;
            }
        };
        let result = if let Some((_, ref changed)) = ticket {
            tokio::select! {r=wait=>r,_=changed.notified()=>Err(Error::Superseded("newer volume request replaced this request".into()))}
        } else {
            wait.await
        };
        if let Some((seq, _)) = ticket {
            let mut p = self.pending.lock().unwrap();
            if p.get(path).is_some_and(|v| v.sequence == seq) {
                p.remove(path);
            }
        }
        result
    }
}
pub fn path(s: &str) -> Path {
    Path::try_from(if s.is_empty() { "/" } else { s }).expect("internally constructed object path")
}

pub async fn serve(conn: &Connection) -> Result<(), Box<dyn std::error::Error>> {
    let (snapshots_tx, mut snapshots) = watch::channel(Graph::default());
    let (commands, rx) = std::sync::mpsc::channel();
    let prefs = Arc::new(RwLock::new(Preferences::default()));
    #[cfg(feature = "audio-native")]
    let streams = streams::Manager::new();
    #[cfg(feature = "audio-native")]
    native::start(rx, snapshots_tx, prefs.clone(), streams.clone());
    #[cfg(not(feature = "audio-native"))]
    {
        let _ = snapshots_tx.send(Graph {
            error: "this build has no audio-native feature".into(),
            ..Default::default()
        });
        std::thread::spawn(move || {
            while let Ok(r) = rx.recv() {
                let Request { reply, .. } = r;
                let _ = reply.send(Err(Error::Unavailable("build without audio-native".into())));
            }
        });
    }
    let audio = Audio {
        graph: Arc::new(RwLock::new(Graph::default())),
        prefs,
        backend: Backend { commands },
        changed: Arc::new(Notify::new()),
        sequence: Arc::new(AtomicU64::new(1)),
        announced_root: Arc::new(std::sync::Mutex::new(BTreeMap::new())),
        pending: Arc::new(std::sync::Mutex::new(BTreeMap::new())),
        #[cfg(feature = "audio-native")]
        streams,
    };
    conn.object_server()
        .at(ROOT, zbus::fdo::ObjectManager)
        .await?;
    conn.object_server()
        .at(ROOT, bus::Root(audio.clone()))
        .await?;
    let c = conn.clone();
    let a = audio.clone();
    tokio::spawn(async move {
        let mut previous = Graph::default();
        loop {
            let next = snapshots.borrow_and_update().clone();
            if let Err(e) = bus::publish(&c, &a, &previous, &next).await {
                eprintln!("[audio] publish: {e}");
            }
            previous = next;
            if snapshots.changed().await.is_err() {
                break;
            }
        }
    });
    #[cfg(feature = "audio-native")]
    audio.streams.serve(conn.clone(), audio.clone()).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures_util::StreamExt;
    use model::{Channel, Node};
    #[test]
    fn private_bus_contract_and_last_volume_wins() {
        if std::env::var_os("NIDARA_AUDIO_PRIVATE_TEST").is_none() {
            let status = std::process::Command::new("dbus-run-session")
                .arg("--")
                .arg(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "audio::tests::private_bus_contract_and_last_volume_wins",
                    "--nocapture",
                ])
                .env("NIDARA_AUDIO_PRIVATE_TEST", "1")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            let (tx, rx) = std::sync::mpsc::channel();
            let a = Audio {
                graph: Arc::new(RwLock::new(Graph::default())),
                prefs: Arc::new(RwLock::new(Preferences::default())),
                backend: Backend { commands: tx },
                changed: Arc::new(Notify::new()),
                sequence: Arc::new(AtomicU64::new(1)),
                announced_root: Arc::new(std::sync::Mutex::new(BTreeMap::new())),
                pending: Arc::new(std::sync::Mutex::new(BTreeMap::new())),
                #[cfg(feature = "audio-native")]
                streams: streams::Manager::new(),
            };
            let c = zbus::connection::Builder::session()
                .unwrap()
                .name("org.nidara.Session")
                .unwrap()
                .serve_at(ROOT, zbus::fdo::ObjectManager)
                .unwrap()
                .serve_at(ROOT, bus::Root(a.clone()))
                .unwrap()
                .build()
                .await
                .unwrap();
            let client = Connection::session().await.unwrap();
            let key = format!("{ROOT}/g1/nodes/n27");
            let mut g = Graph {
                generation: 1,
                state: "ready".into(),
                default_output: key.clone(),
                ..Default::default()
            };
            g.nodes.insert(
                key.clone(),
                Node {
                    path: key.clone(),
                    id: 7,
                    serial: 27,
                    name: "fake-output".into(),
                    kind: "output".into(),
                    volume: 0.6,
                    channels: vec![
                        Channel {
                            position: "FL".into(),
                            volume: 0.3,
                        },
                        Channel {
                            position: "FR".into(),
                            volume: 0.6,
                        },
                    ],
                    capabilities: vec!["volume".into(), "mute".into(), "balance".into()],
                    device: "/".into(),
                    requested_target: "/".into(),
                    active_route: "/".into(),
                    ..Default::default()
                },
            );
            bus::publish(&c, &a, &Graph::default(), &g).await.unwrap();
            let om = zbus::fdo::ObjectManagerProxy::builder(&client)
                .destination("org.nidara.Session")
                .unwrap()
                .path(ROOT)
                .unwrap()
                .build()
                .await
                .unwrap();
            let snapshot = om.get_managed_objects().await.unwrap();
            assert!(snapshot.contains_key(&path(&key)));
            let root: zbus::Proxy<'_> = zbus::proxy::Builder::new(&client)
                .destination("org.nidara.Session")
                .unwrap()
                .path(ROOT)
                .unwrap()
                .interface("org.nidara.Audio1")
                .unwrap()
                .cache_properties(zbus::proxy::CacheProperties::No)
                .build()
                .await
                .unwrap();
            let node_properties = zbus::fdo::PropertiesProxy::builder(&client)
                .destination("org.nidara.Session")
                .unwrap()
                .path(key.as_str())
                .unwrap()
                .build()
                .await
                .unwrap();
            let mut node_updates = node_properties.receive_properties_changed().await.unwrap();
            assert_eq!(
                root.get_property::<Path>("DefaultOutput").await.unwrap(),
                path(&key)
            );
            for value in [f64::NAN, f64::INFINITY, 1.1, -0.01] {
                let err = root
                    .call::<_, _, ()>("SetVolume", &(path(&key), value))
                    .await
                    .unwrap_err();
                assert!(err.to_string().contains("InvalidArgument"));
            }
            // Keep the backend's first reply pending: the second call must supersede it
            // immediately, without waiting for mixer confirmation or any timer.
            let first_client = client.clone();
            let first_key = key.clone();
            let first = tokio::spawn(async move {
                first_client
                    .call_method(
                        Some("org.nidara.Session"),
                        ROOT,
                        Some("org.nidara.Audio1"),
                        "SetVolume",
                        &(path(&first_key), 0.2),
                    )
                    .await
            });
            let rx = Arc::new(std::sync::Mutex::new(rx));
            let r = rx.clone();
            let request1 = tokio::task::spawn_blocking(move || {
                r.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap()
            })
            .await
            .unwrap();
            let second_client = client.clone();
            let second_key = key.clone();
            let second = tokio::spawn(async move {
                second_client
                    .call_method(
                        Some("org.nidara.Session"),
                        ROOT,
                        Some("org.nidara.Audio1"),
                        "SetVolume",
                        &(path(&second_key), 0.7),
                    )
                    .await
            });
            let err = first.await.unwrap().unwrap_err();
            assert!(err.to_string().contains("Superseded"));
            let r = rx.clone();
            let request2 = tokio::task::spawn_blocking(move || {
                r.lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(3))
                    .unwrap()
            })
            .await
            .unwrap();
            assert!(request2.sequence > request1.sequence && request1.sequence > 0);
            assert_eq!(request2.path, key);
            assert_eq!(request2.generation, 1);
            assert!(matches!(request2.action,Action::Volume(v) if v==0.7));
            let _ = request1.reply.send(Ok(()));
            let _ = request2.reply.send(Ok(()));
            let before = g.clone();
            g.nodes.get_mut(&key).unwrap().volume = 0.7;
            bus::publish(&c, &a, &before, &g).await.unwrap();
            second.await.unwrap().unwrap();
            let signal = node_updates.next().await.unwrap();
            let args = signal.args().unwrap();
            assert!(args.invalidated_properties().is_empty());
            assert_eq!(args.changed_properties().len(), 1);
            assert_eq!(
                f64::try_from(&args.changed_properties()["Volume"]).unwrap(),
                0.7
            );

            // Recycling a numeric ID inside the same connection must also withdraw
            // the old path, rather than redirect an old client to a different node.
            let mut replacement = g.clone();
            let new_key = format!("{ROOT}/g1/nodes/n28");
            let mut recycled = replacement.nodes.remove(&key).unwrap();
            recycled.path = new_key.clone();
            recycled.serial = 28;
            replacement.nodes.insert(new_key.clone(), recycled);
            replacement.default_output = new_key.clone();
            bus::publish(&c, &a, &g, &replacement).await.unwrap();
            let err = root
                .call::<_, _, ()>("SetMuted", &(path(&key), true))
                .await
                .unwrap_err();
            assert!(err.to_string().contains("NotFound"));
            assert!(
                om.get_managed_objects()
                    .await
                    .unwrap()
                    .contains_key(&path(&new_key))
            );
            g = replacement;
            // Provider loss withdraws references and old objects. Recycled PW id 7
            // in generation 2 cannot make an old client target a new apparatus.
            let dead = Graph {
                generation: 2,
                error: "provider disconnected".into(),
                ..Default::default()
            };
            bus::publish(&c, &a, &g, &dead).await.unwrap();
            assert_eq!(
                root.get_property::<Path>("DefaultOutput").await.unwrap(),
                path("/")
            );
            assert!(
                !om.get_managed_objects()
                    .await
                    .unwrap()
                    .contains_key(&path(&key))
            );
            let err = root
                .call::<_, _, ()>("SetMuted", &(path(&key), true))
                .await
                .unwrap_err();
            assert!(err.to_string().contains("Unavailable"));
        });
    }
}
