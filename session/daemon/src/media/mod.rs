// SPDX-License-Identifier: GPL-3.0-or-later
//! Opt-in native MPRIS service. No UI or legacy selection bridge.
mod art;
mod audio;
mod bus;
mod model;
mod prefs;
use futures_util::StreamExt;
use model::{Player, Roster};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, RwLock},
    time::Duration,
};
use tokio::sync::Mutex;
use zbus::{
    Connection, Proxy,
    zvariant::{OwnedObjectPath as Path, OwnedValue, Value},
};
const ROOT: &str = "/org/nidara/Media";
const MPRIS_PATH: &str = "/org/mpris/MediaPlayer2";
const PLAYER: &str = "org.mpris.MediaPlayer2.Player";
const MPRIS: &str = "org.mpris.MediaPlayer2";
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.Media1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    Unavailable(String),
    NotFound(String),
    NotSupported(String),
    InvalidArgument(String),
    StaleTrack(String),
    StaleSelection(String),
    Busy(String),
    Timeout(String),
    Failed(String),
}
impl From<zbus::fdo::Error> for Error {
    fn from(e: zbus::fdo::Error) -> Self {
        Self::Failed(e.to_string())
    }
}
fn now() -> u64 {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) };
    ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1000
}
fn path(s: &str) -> Path {
    Path::try_from(s).expect("internal object path")
}
fn text(m: &HashMap<String, OwnedValue>, k: &str) -> String {
    m.get(k)
        .map(|v| {
            <&str>::try_from(v)
                .map(|s| s.to_string())
                .unwrap_or_else(|_| {
                    v.try_clone()
                        .ok()
                        .and_then(|v| Path::try_from(v).ok())
                        .map(|p| p.to_string())
                        .unwrap_or_default()
                })
        })
        .unwrap_or_default()
}
fn boolean(m: &HashMap<String, OwnedValue>, k: &str) -> bool {
    m.get(k)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false)
}
fn number(m: &HashMap<String, OwnedValue>, k: &str) -> Option<f64> {
    m.get(k)
        .and_then(|v| f64::try_from(v).ok())
        .filter(|n| n.is_finite())
}
fn integer(m: &HashMap<String, OwnedValue>, k: &str) -> Option<i64> {
    m.get(k).and_then(|v| {
        i64::try_from(v)
            .ok()
            .or_else(|| u64::try_from(v).ok().and_then(|n| n.try_into().ok()))
    })
}
#[derive(Clone)]
struct Media {
    errors: Arc<RwLock<BTreeMap<String, String>>>,
    audio: Arc<RwLock<audio::Snapshot>>,
    art: art::Art,
    conn: Connection,
    roster: Arc<RwLock<Roster>>,
    serial: Arc<std::sync::atomic::AtomicU64>,
    epoch: u64,
    updates: Arc<Mutex<()>>,
    announced: Arc<Mutex<BTreeMap<String, bus::Props>>>,
    prefs: Arc<RwLock<(bool, bool)>>,
    syncs: Arc<Mutex<std::collections::BTreeSet<String>>>,
}
impl Media {
    fn get(&self, p: &str) -> Result<Player, Error> {
        self.roster
            .read()
            .unwrap()
            .players
            .get(p)
            .cloned()
            .ok_or_else(|| Error::NotFound("player owner has departed".into()))
    }
    fn selected(&self, expected: Option<&str>) -> Result<Player, Error> {
        let r = self.roster.read().unwrap();
        let p = r
            .selected()
            .ok_or_else(|| Error::NotFound("no selected player".into()))?;
        if expected.is_some_and(|e| e != p.path) {
            return Err(Error::StaleSelection("selected player changed".into()));
        }
        Ok(p.clone())
    }
    async fn proxy<'a>(&'a self, p: &'a Player, iface: &'a str) -> Result<Proxy<'a>, Error> {
        Ok(Proxy::new(&self.conn, p.owner.as_str(), MPRIS_PATH, iface).await?)
    }
    async fn transport(&self, p: Player, method: &str) -> Result<(), Error> {
        let allowed = match method {
            "Raise" => p.raise,
            "Next" => p.control && p.next,
            "Previous" => p.control && p.previous,
            "Play" => p.control && p.play,
            "Pause" => p.control && p.pause,
            "PlayPause" => {
                p.control
                    && if p.status == "Playing" {
                        p.pause
                    } else {
                        p.play
                    }
            }
            "Stop" => p.control,
            _ => false,
        };
        if !allowed {
            return Err(Error::NotSupported(method.into()));
        }
        self.get(&p.path)?;
        let iface = if method == "Raise" { MPRIS } else { PLAYER };
        tokio::time::timeout(
            Duration::from_secs(5),
            self.proxy(&p, iface).await?.call::<_, _, ()>(method, &()),
        )
        .await
        .map_err(|_| Error::Timeout("MPRIS call result uncertain".into()))??;
        Ok(())
    }
    async fn set(&self, p: Player, key: &str, v: Value<'_>) -> Result<(), Error> {
        if !p.control {
            return Err(Error::NotSupported("CanControl=false".into()));
        }
        let supported = match key {
            "Shuffle" => p.shuffle.is_some(),
            "LoopStatus" => p.loop_status.is_some(),
            "Volume" => p.volume_source == "mpris",
            _ => false,
        };
        if !supported {
            return Err(Error::NotSupported(key.into()));
        }
        self.get(&p.path)?;
        tokio::time::timeout(
            Duration::from_secs(5),
            self.proxy(&p, PLAYER).await?.set_property(key, v),
        )
        .await
        .map_err(|_| Error::Timeout("MPRIS property result uncertain".into()))??;
        self.refresh(&p.bus, &p.owner).await?;
        Ok(())
    }
    async fn seek(&self, p: Player, revision: u64, position: i64) -> Result<(), Error> {
        if !p.control || !p.seek {
            return Err(Error::NotSupported("seek".into()));
        }
        if position < 0 || (p.length > 0 && position > p.length) {
            return Err(Error::InvalidArgument("position outside track".into()));
        }
        if p.revision != revision {
            return Err(Error::StaleTrack("track changed".into()));
        }
        let current = self.get(&p.path)?;
        if current.revision != revision {
            return Err(Error::StaleTrack("track changed".into()));
        }
        let proxy = self.proxy(&p, PLAYER).await?;
        let operation = async {
            if p.track != "/" {
                proxy
                    .call::<_, _, ()>("SetPosition", &(path(&p.track), position))
                    .await?;
            } else {
                let at = self.position(&p, true).await?;
                let c = self.get(&p.path)?;
                if c.revision != revision {
                    return Err(Error::StaleTrack("track changed".into()));
                }
                proxy
                    .call::<_, _, ()>("Seek", &(position.saturating_sub(at)))
                    .await?;
            }
            Ok::<_, Error>(())
        };
        tokio::time::timeout(Duration::from_secs(5), operation)
            .await
            .map_err(|_| Error::Timeout("seek result uncertain".into()))??;
        self.position(&p, true).await?;
        Ok(())
    }
    async fn position(&self, p: &Player, force: bool) -> Result<i64, Error> {
        let current = self.get(&p.path)?;
        if !force && now().saturating_sub(current.synced) < 10_000_000 {
            return if current.position_available {
                Ok(current.position_at(now()))
            } else {
                Err(Error::NotSupported("Position unavailable".into()))
            };
        }
        {
            let mut s = self.syncs.lock().await;
            if !s.insert(p.path.clone()) {
                return Ok(current.position_at(now()));
            }
        }
        let result = async {
            tokio::time::timeout(
                Duration::from_secs(2),
                self.proxy(p, PLAYER).await?.get_property::<i64>("Position"),
            )
            .await
            .map_err(|_| Error::Timeout("Position unavailable".into()))?
            .map_err(Error::from)
        }
        .await;
        self.syncs.lock().await.remove(&p.path);
        {
            let _guard = self.updates.lock().await;
            if let Some(live) = self.roster.write().unwrap().players.get_mut(&p.path)
                && live.revision == p.revision
                && live.owner == p.owner
            {
                live.synced = now();
                match &result {
                    Ok(pos) => live.anchor(*pos, now()),
                    Err(_) => live.position_available = false,
                }
            }
            bus::publish(self).await?;
        }
        result
    }
    async fn refresh(&self, bus: &str, owner: &str) -> Result<(), Error> {
        let result = self.refresh_inner(bus, owner).await;
        if let Err(e) = &result {
            let _g = self.updates.lock().await;
            self.errors
                .write()
                .unwrap()
                .insert(bus.into(), e.to_string());
            for p in self
                .roster
                .write()
                .unwrap()
                .players
                .values_mut()
                .filter(|p| p.bus == bus && p.owner == owner)
            {
                p.error = e.to_string();
                p.control = false;
                p.raise = false;
                if p.volume_source == "mpris" {
                    p.volume = None;
                }
                p.shuffle = None;
                p.loop_status = None;
            }
            let _ = bus::publish(self).await;
        }
        result
    }
    async fn refresh_inner(&self, bus: &str, owner: &str) -> Result<(), Error> {
        let _guard = self.updates.lock().await;
        let existing = self
            .roster
            .read()
            .unwrap()
            .players
            .values()
            .find(|p| p.bus == bus)
            .cloned();
        if existing.as_ref().is_some_and(|p| p.owner != owner) {
            return Ok(());
        }
        let mut p = existing.unwrap_or_else(|| {
            Player::new(
                bus.into(),
                owner.into(),
                format!(
                    "{ROOT}/players/g{}/p{}",
                    self.epoch,
                    self.serial
                        .fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                ),
                now(),
            )
        });
        let props = Proxy::new(
            &self.conn,
            owner,
            MPRIS_PATH,
            "org.freedesktop.DBus.Properties",
        )
        .await?;
        let root: HashMap<String, OwnedValue> =
            tokio::time::timeout(Duration::from_secs(2), props.call("GetAll", &(MPRIS,)))
                .await
                .map_err(|_| Error::Timeout("MPRIS root snapshot".into()))??;
        let values: HashMap<String, OwnedValue> =
            tokio::time::timeout(Duration::from_secs(2), props.call("GetAll", &(PLAYER,)))
                .await
                .map_err(|_| Error::Timeout("MPRIS player snapshot".into()))??;
        let identity = text(&root, "Identity");
        let desktop = text(&root, "DesktopEntry");
        if identity != p.identity || desktop != p.desktop || p.icon.is_empty() {
            p.icon = prefs::icon(desktop.clone(), p.bus.clone(), identity.clone()).await;
        }
        p.identity = identity;
        p.desktop = desktop;
        p.raise = boolean(&root, "CanRaise");
        let meta: HashMap<String, OwnedValue> = values
            .get("Metadata")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| v.try_into().ok())
            .unwrap_or_default();
        let track = model::track(&text(&meta, "mpris:trackid"));
        let title = text(&meta, "xesam:title");
        let album = text(&meta, "xesam:album");
        let artists = meta
            .get("xesam:artist")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| Vec::<String>::try_from(v).ok())
            .unwrap_or_else(|| {
                let s = text(&meta, "xesam:artist");
                if s.is_empty() { vec![] } else { vec![s] }
            });
        let track_changed = (
            p.track.as_str(),
            p.title.as_str(),
            p.album.as_str(),
            &p.artists,
        ) != (track.as_str(), title.as_str(), album.as_str(), &artists);
        if track_changed {
            p.revision += 1;
            p.position = 0;
            p.at = now();
            p.position_available = false;
            p.synced = 0;
        }
        p.track = track;
        p.title = title;
        p.album = album;
        p.artists = artists;
        p.length = model::length(integer(&meta, "mpris:length").unwrap_or(0));
        let status = text(&values, "PlaybackStatus");
        let status = if ["Playing", "Paused", "Stopped"].contains(&status.as_str()) {
            status
        } else {
            "Stopped".into()
        };
        p.playback(status, number(&values, "Rate").unwrap_or(1.0), now());
        if let Some(pos) = integer(&values, "Position") {
            p.anchor(pos, now());
        }
        p.control = boolean(&values, "CanControl");
        p.play = boolean(&values, "CanPlay");
        p.pause = boolean(&values, "CanPause");
        p.next = boolean(&values, "CanGoNext");
        p.previous = boolean(&values, "CanGoPrevious");
        p.seek = boolean(&values, "CanSeek");
        p.shuffle = values.get("Shuffle").and_then(|v| bool::try_from(v).ok());
        let lp = text(&values, "LoopStatus");
        p.loop_status = ["None", "Track", "Playlist"]
            .contains(&lp.as_str())
            .then_some(lp);
        p.volume = number(&values, "Volume").filter(|v| *v >= 0.0);
        p.volume_source = if values.contains_key("Volume") {
            "mpris"
        } else {
            "none"
        }
        .into();
        if p.volume_source == "mpris" {
            p.volume_limit = 1.0;
        }
        let art_url = text(&meta, "mpris:artUrl");
        let new_art = art_url != p.art_url || track_changed || p.art_state == "failed";
        p.art_url = art_url;
        if new_art {
            p.art_state = if p.art_url.is_empty() {
                "none"
            } else {
                "loading"
            }
            .into();
            p.art_path.clear();
            p.art_error.clear();
        }
        let dbus = zbus::fdo::DBusProxy::new(&self.conn).await?;
        if dbus
            .get_name_owner(
                zbus::names::BusName::try_from(bus).map_err(|e| Error::Failed(e.to_string()))?,
            )
            .await?
            .as_str()
            != owner
        {
            return Ok(());
        }
        if p.pid == 0 {
            p.pid = dbus
                .get_connection_unix_process_id(
                    zbus::names::BusName::try_from(owner)
                        .map_err(|e| Error::Failed(e.to_string()))?,
                )
                .await
                .unwrap_or(0);
            p.pid_start = audio::process(p.pid).map(|p| p.1).unwrap_or(0);
        }
        p.error.clear();
        self.errors.write().unwrap().remove(bus);
        let added = !self.roster.read().unwrap().players.contains_key(&p.path);
        if added {
            self.conn
                .object_server()
                .at(
                    p.path.as_str(),
                    bus::PlayerObject(self.clone(), p.path.clone(), p.clone()),
                )
                .await?;
        }
        self.roster
            .write()
            .unwrap()
            .players
            .insert(p.path.clone(), p.clone());
        audio::apply(
            &mut self.roster.write().unwrap(),
            &self.audio.read().unwrap(),
        );
        bus::publish(self).await?;
        if new_art && !p.art_url.is_empty() {
            let media = self.clone();
            tokio::spawn(async move {
                let result = media.art.resolve(p.art_url.clone()).await;
                let _guard = media.updates.lock().await;
                if let Some(live) = media.roster.write().unwrap().players.get_mut(&p.path)
                    && live.owner == p.owner
                    && live.revision == p.revision
                    && live.art_url == p.art_url
                {
                    match result {
                        Ok(file) => {
                            live.art_state = "ready".into();
                            live.art_path = file;
                            live.art_error.clear();
                        }
                        Err(e) => {
                            live.art_state = "failed".into();
                            live.art_path.clear();
                            live.art_error = e;
                        }
                    }
                }
                let _ = bus::publish(&media).await;
            });
        }
        Ok(())
    }
    async fn remove(&self, bus: &str, owner: &str) -> Result<(), Error> {
        self.errors.write().unwrap().remove(bus);
        let _guard = self.updates.lock().await;
        let p = self
            .roster
            .read()
            .unwrap()
            .players
            .values()
            .find(|p| p.bus == bus && p.owner == owner)
            .cloned();
        if let Some(p) = p {
            self.roster.write().unwrap().remove(&p.path);
            bus::publish(self).await?;
            self.conn
                .object_server()
                .remove::<bus::PlayerObject, _>(p.path.as_str())
                .await?;
        }
        Ok(())
    }
}
pub async fn serve(conn: &Connection) -> zbus::Result<()> {
    let media = start(conn).await?;
    prefs::watch(media);
    Ok(())
}
async fn start(conn: &Connection) -> zbus::Result<Media> {
    let m = Media {
        errors: Default::default(),
        audio: Default::default(),
        art: art::Art::new(),
        conn: conn.clone(),
        roster: Default::default(),
        serial: Arc::new(std::sync::atomic::AtomicU64::new(1)),
        epoch: now(),
        updates: Default::default(),
        announced: Default::default(),
        prefs: Arc::new(RwLock::new((true, true))),
        syncs: Default::default(),
    };
    conn.object_server()
        .at(ROOT, zbus::fdo::ObjectManager)
        .await?;
    conn.object_server().at(ROOT, bus::Root(m.clone())).await?;
    let rules = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .path(MPRIS_PATH)?
        .build();
    let mut signals = zbus::MessageStream::for_match_rule(rules, conn, Some(256)).await?;
    let dbus = zbus::fdo::DBusProxy::new(conn).await?;
    let mut owners = dbus.receive_name_owner_changed().await?;
    let list = dbus.list_names().await?;
    for name in list {
        if name.as_str().starts_with("org.mpris.MediaPlayer2.")
            && let Ok(owner) = dbus.get_name_owner(name.clone().into()).await
        {
            let _ = m.refresh(name.as_str(), owner.as_str()).await;
        }
    }
    audio::watch(m.clone()).await?;
    let service = m.clone();
    tokio::spawn(async move {
        loop {
            tokio::select! {
                Some(event) = owners.next() => {
                    if let Ok(args)=event.args() {
                        let name=args.name().as_str();
                        if name.starts_with("org.mpris.MediaPlayer2.") {
                            if let Some(old)=args.old_owner().as_ref() {
                                let _=m.remove(name,old.as_str()).await;
                            }
                            if let Some(new)=args.new_owner().as_ref() {
                                let _=m.refresh(name,new.as_str()).await;
                            }
                        }
                    }
                }
                Some(Ok(message)) = signals.next() => {
                    let header=message.header();
                    if let Some(sender)=header.sender() {
                        let players=m.roster.read().unwrap().players.values()
                            .filter(|p|p.owner==sender.as_str()).cloned().collect::<Vec<_>>();
                        for player in players {
                            if header.interface().is_some_and(|i|i.as_str()==PLAYER)
                                && header.member().is_some_and(|s|s.as_str()=="Seeked") {
                                if let Ok((position,))=message.body().deserialize::<(i64,)>() {
                                    let _guard=m.updates.lock().await;
                                    if let Some(live)=m.roster.write().unwrap().players.get_mut(&player.path) {
                                        live.anchor(position,now());
                                    }
                                    let _=bus::publish(&m).await;
                                }
                            } else if header.interface().is_some_and(|i|i.as_str()=="org.freedesktop.DBus.Properties") {
                                let _=m.refresh(&player.bus,&player.owner).await;
                            }
                        }
                    }
                }
                else => break,
            }
        }
    });
    Ok(service)
}

#[cfg(test)]
mod tests;
