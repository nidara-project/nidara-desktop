// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use std::os::unix::fs::MetadataExt;
const AUDIO_ROOT: &str = "/org/nidara/Audio";
#[derive(Clone, Default)]
pub struct Node {
    pub path: String,
    pub pid: u32,
    pub app: String,
    pub volume: f64,
    pub volume_capable: bool,
}
#[derive(Clone, Default)]
pub struct Snapshot {
    pub nodes: Vec<Node>,
    pub limit: f64,
    pub headphone: bool,
}
pub(super) fn process(pid: u32) -> Option<(u32, u64)> {
    if pid == 0 {
        return None;
    }
    let root = format!("/proc/{pid}");
    let meta = std::fs::metadata(&root).ok()?;
    if meta.uid() != unsafe { libc::geteuid() } {
        return None;
    }
    let data = std::fs::read_to_string(format!("{root}/stat")).ok()?;
    let (_, rest) = data.rsplit_once(") ")?;
    let fields = rest.split_whitespace().collect::<Vec<_>>();
    Some((fields.get(1)?.parse().ok()?, fields.get(19)?.parse().ok()?))
}
fn related(stream: u32, owner: u32, owner_start: u64) -> bool {
    if stream == 0 || owner == 0 {
        return false;
    }
    let Some(owner_identity) = process(owner) else {
        return false;
    };
    if owner_start == 0 || owner_identity.1 != owner_start {
        return false;
    }
    let mut current = stream;
    let mut seen = BTreeMap::new();
    for _ in 0..32 {
        let Some(identity) = process(current) else {
            return false;
        };
        if seen.insert(current, identity).is_some() {
            return false;
        }
        if current == owner {
            return process(owner) == Some(owner_identity)
                && seen.iter().all(|(p, id)| process(*p) == Some(*id));
        }
        current = identity.0;
    }
    false
}
fn app(s: &str) -> String {
    s.trim_end_matches(".desktop").to_lowercase()
}
fn matches(p: &Player, n: &Node) -> bool {
    related(n.pid, p.pid, p.pid_start)
        || (!n.app.is_empty() && !p.desktop.is_empty() && app(&n.app) == app(&p.desktop))
}
pub fn targets(roster: &Roster, snapshot: &Snapshot, p: &Player) -> Vec<Node> {
    let exact = snapshot
        .nodes
        .iter()
        .filter(|n| related(n.pid, p.pid, p.pid_start))
        .collect::<Vec<_>>();
    let candidates = if exact.is_empty() {
        snapshot
            .nodes
            .iter()
            .filter(|n| {
                !n.app.is_empty() && !p.desktop.is_empty() && app(&n.app) == app(&p.desktop)
            })
            .collect::<Vec<_>>()
    } else {
        exact
    };
    candidates
        .into_iter()
        .filter(|n| {
            roster
                .players
                .values()
                .filter(|other| matches(other, n))
                .count()
                == 1
        })
        .cloned()
        .collect()
}
pub fn apply(roster: &mut Roster, snapshot: &Snapshot) {
    let updates = roster
        .players
        .values()
        .filter(|p| p.volume_source != "mpris")
        .map(|p| (p.path.clone(), targets(roster, snapshot, p)))
        .collect::<Vec<_>>();
    for (path, nodes) in updates {
        let p = roster.players.get_mut(&path).unwrap();
        p.volume_targets.clear();
        p.volume = None;
        p.volume_source = "none".into();
        p.volume_limit = snapshot.limit;
        if nodes.len() == 1 && nodes[0].volume_capable {
            p.volume_source = "audio1".into();
            p.volume = Some(nodes[0].volume);
            p.volume_targets.push(nodes[0].path.clone());
        }
    }
}
async fn snapshot(m: &Media) -> Result<Snapshot, Error> {
    let manager = Proxy::new(
        &m.conn,
        m.conn.unique_name().unwrap().as_str(),
        AUDIO_ROOT,
        "org.freedesktop.DBus.ObjectManager",
    )
    .await?;
    type Objects = HashMap<Path, HashMap<String, HashMap<String, OwnedValue>>>;
    let objects: Objects = tokio::time::timeout(
        Duration::from_secs(2),
        manager.call("GetManagedObjects", &()),
    )
    .await
    .map_err(|_| Error::Timeout("Audio1 snapshot".into()))??;
    let mut result = Snapshot {
        limit: 1.0,
        ..Default::default()
    };
    let root = Proxy::new(
        &m.conn,
        m.conn.unique_name().unwrap().as_str(),
        AUDIO_ROOT,
        "org.nidara.Audio1",
    )
    .await?;
    let external = root
        .get_property::<Vec<Path>>("Streams")
        .await
        .unwrap_or_default();
    result.limit = root.get_property("VolumeLimit").await.unwrap_or(1.0);
    result.headphone = root
        .get_property::<Vec<String>>("Capabilities")
        .await
        .unwrap_or_default()
        .iter()
        .any(|s| s == "headphone-fallback");
    for (path, ifaces) in objects {
        if let Some(props) = ifaces.get("org.nidara.Audio1") {
            let caps = props
                .get("Capabilities")
                .and_then(|v| v.try_clone().ok())
                .and_then(|v| Vec::<String>::try_from(v).ok())
                .unwrap_or_default();
            result.headphone = caps.iter().any(|c| c == "headphone-fallback");
            result.limit = number(props, "VolumeLimit").unwrap_or(1.0);
        }
        if let Some(props) = ifaces.get("org.nidara.AudioNode1")
            && text(props, "Kind") == "playback"
            && external.contains(&path)
        {
            let caps = props
                .get("Capabilities")
                .and_then(|v| v.try_clone().ok())
                .and_then(|v| Vec::<String>::try_from(v).ok())
                .unwrap_or_default();
            result.nodes.push(Node {
                path: path.to_string(),
                pid: props
                    .get("ProcessId")
                    .and_then(|v| u32::try_from(v).ok())
                    .unwrap_or(0),
                app: text(props, "ApplicationId"),
                volume: number(props, "Volume").unwrap_or(0.0),
                volume_capable: caps.iter().any(|c| c == "volume"),
            });
        }
    }
    Ok(result)
}
async fn refresh(m: &Media) {
    let snapshot = snapshot(m).await.unwrap_or_default();
    let _g = m.updates.lock().await;
    *m.audio.write().unwrap() = snapshot.clone();
    apply(&mut m.roster.write().unwrap(), &snapshot);
    let _ = bus::publish(m).await;
}
pub async fn volume(m: &Media, p: Player, volume: f64) -> Result<(), Error> {
    if !volume.is_finite() || volume < 0.0 || volume > p.volume_limit {
        return Err(Error::InvalidArgument("volume outside source range".into()));
    }
    if p.volume_source == "mpris" && volume > 1.0 {
        return Err(Error::InvalidArgument("MPRIS write limit is 1.0".into()));
    }
    if p.volume_source == "mpris" {
        return m.set(p, "Volume", Value::from(volume)).await;
    }
    if p.volume_source != "audio1" || p.volume_targets.len() != 1 {
        return Err(Error::NotSupported("no unique app volume target".into()));
    }
    let current = m.get(&p.path)?;
    if current.volume_targets != p.volume_targets || current.volume_source != "audio1" {
        return Err(Error::NotSupported("audio target changed".into()));
    }
    let proxy = Proxy::new(
        &m.conn,
        m.conn.unique_name().unwrap().as_str(),
        AUDIO_ROOT,
        "org.nidara.Audio1",
    )
    .await?;
    tokio::time::timeout(
        Duration::from_secs(6),
        proxy.call::<_, _, ()>("SetVolume", &(path(&p.volume_targets[0]), volume)),
    )
    .await
    .map_err(|_| Error::Timeout("Audio1 volume uncertain".into()))??;
    refresh(m).await;
    Ok(())
}
pub async fn pause_affected(m: &Media, id: u64, affected: &[Path]) {
    if m.prefs.read().unwrap().1 {
        let players = {
            let r = m.roster.read().unwrap();
            let audio = m.audio.read().unwrap();
            r.players
                .values()
                .filter(|p| {
                    p.status == "Playing"
                        && p.control
                        && p.pause
                        && targets(&r, &audio, p)
                            .iter()
                            .any(|n| affected.iter().any(|a| a.as_str() == n.path))
                })
                .cloned()
                .collect::<Vec<_>>()
        };
        for p in players {
            let result = if let Ok(current) = m.get(&p.path)
                && current.status == "Playing"
                && current.revision == p.revision
                && current.active == p.active
            {
                m.transport(current, "Pause").await
            } else {
                continue;
            };
            let status = match &result {
                Ok(()) => "accepted".to_string(),
                Err(e) => e.to_string(),
            };
            if let Err(e) = result
                && let Some(live) = m.roster.write().unwrap().players.get_mut(&p.path)
            {
                live.error = e.to_string();
            }
            let _ = m
                .conn
                .emit_signal(
                    None::<&str>,
                    ROOT,
                    "org.nidara.Media1",
                    "AutoPauseResult",
                    &(id, path(&p.path), status),
                )
                .await;
        }
    }
}
pub async fn watch(m: Media) -> zbus::Result<()> {
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .path_namespace(AUDIO_ROOT)?
        .build();
    let mut events = zbus::MessageStream::for_match_rule(rule, &m.conn, Some(128)).await?;
    tokio::spawn(async move {
        refresh(&m).await;
        let mut last = 0;
        while let Some(Ok(msg)) = events.next().await {
            if msg.header().sender().map(|s| s.as_str()) != m.conn.unique_name().map(|s| s.as_str())
            {
                continue;
            }
            if msg
                .header()
                .member()
                .is_some_and(|s| s.as_str() == "HeadphoneFallback")
                && let Ok((id, _old, _new, affected, _reason)) =
                    msg.body()
                        .deserialize::<(u64, Path, Path, Vec<Path>, String)>()
                && id > last
            {
                last = id;
                pause_affected(&m, id, &affected).await;
            }
            refresh(&m).await;
        }
    });
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ambiguous_app_ids_never_match_master_or_multiple_streams() {
        let mut r = Roster::default();
        let mut p = Player::new("a".into(), ":1.2".into(), "/a".into(), 0);
        p.desktop = "org.example.App".into();
        r.players.insert(p.path.clone(), p.clone());
        let s = Snapshot {
            limit: 1.0,
            nodes: vec![Node {
                path: "/stream".into(),
                app: "org.example.App".into(),
                volume_capable: true,
                ..Default::default()
            }],
            headphone: false,
        };
        apply(&mut r, &s);
        assert_eq!(r.players["/a"].volume_source, "audio1");
        let mut q = p.clone();
        q.path = "/b".into();
        r.players.insert(q.path.clone(), q);
        apply(&mut r, &s);
        assert_eq!(r.players["/a"].volume_source, "none");
        assert!(r.players["/a"].volume_targets.is_empty());
    }
    #[test]
    fn process_ancestry_checks_kernel_identity_and_departure() {
        let owner = std::process::id();
        let start = process(owner).unwrap().1;
        let mut child = std::process::Command::new("sleep")
            .arg("10")
            .spawn()
            .unwrap();
        let pid = child.id();
        assert!(related(pid, owner, start));
        assert!(!related(pid, owner, start.wrapping_add(1)));
        assert!(!related(owner, pid, process(pid).unwrap().1));
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!related(pid, owner, start));
    }
}
