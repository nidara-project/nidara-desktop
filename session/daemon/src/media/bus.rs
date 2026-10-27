// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
pub type Props = HashMap<String, OwnedValue>;
fn val<T: Into<Value<'static>>>(v: T) -> OwnedValue {
    v.into().try_into().unwrap()
}
fn root_props(m: &Media) -> Props {
    let r = m.roster.read().unwrap();
    let prefs = *m.prefs.read().unwrap();
    HashMap::from([
        (
            "State".into(),
            val(if m.errors.read().unwrap().is_empty() {
                "Ready"
            } else {
                "Degraded"
            }
            .to_string()),
        ),
        (
            "LastError".into(),
            val(m
                .errors
                .read()
                .unwrap()
                .values()
                .next()
                .cloned()
                .unwrap_or_default()),
        ),
        ("Generation".into(), val(m.epoch)),
        (
            "Players".into(),
            val(r.players.keys().map(|s| path(s)).collect::<Vec<_>>()),
        ),
        (
            "Selected".into(),
            val(path(r.selected().map_or("/", |p| p.path.as_str()))),
        ),
        (
            "SelectionMode".into(),
            val(if r.pin.is_empty() { "Auto" } else { "Pinned" }.to_string()),
        ),
        ("PinnedBus".into(), val(r.pin.clone())),
        (
            "Capabilities".into(),
            val({
                let mut caps = vec![
                    "mpris".to_string(),
                    "selection".into(),
                    "position".into(),
                    "artwork".into(),
                ];
                if m.audio.read().unwrap().headphone {
                    caps.push("headphone-fallback".into());
                }
                caps
            }),
        ),
        ("LockScreenControls".into(), val(prefs.0)),
        ("PauseOnHeadphonesDisconnect".into(), val(prefs.1)),
        (
            "HeadphonePauseAvailable".into(),
            val(m.audio.read().unwrap().headphone),
        ),
    ])
}
fn player_props(p: &Player) -> Props {
    HashMap::from([
        ("BusName".into(), val(p.bus.clone())),
        ("Owner".into(), val(p.owner.clone())),
        ("Identity".into(), val(p.identity.clone())),
        ("DesktopEntry".into(), val(p.desktop.clone())),
        ("AppIcon".into(), val(p.icon.clone())),
        ("Title".into(), val(p.title.clone())),
        ("Album".into(), val(p.album.clone())),
        ("PlaybackStatus".into(), val(p.status.clone())),
        ("VolumeSource".into(), val(p.volume_source.clone())),
        ("ArtState".into(), val(p.art_state.clone())),
        ("ArtPath".into(), val(p.art_path.clone())),
        ("ArtError".into(), val(p.art_error.clone())),
        ("LastError".into(), val(p.error.clone())),
        ("Artists".into(), val(p.artists.clone())),
        ("LengthUs".into(), val(p.length)),
        ("TrackId".into(), val(path(&p.track))),
        ("TrackRevision".into(), val(p.revision)),
        ("Rate".into(), val(p.rate)),
        ("PositionAnchor".into(), val((p.position, p.at, p.rate))),
        ("PositionAvailable".into(), val(p.position_available)),
        ("CanControl".into(), val(p.control)),
        ("CanPlay".into(), val(p.play)),
        ("CanPause".into(), val(p.pause)),
        ("CanGoNext".into(), val(p.next)),
        ("CanGoPrevious".into(), val(p.previous)),
        ("CanSeek".into(), val(p.seek)),
        ("CanRaise".into(), val(p.raise)),
        ("ShuffleAvailable".into(), val(p.shuffle.is_some())),
        ("Shuffle".into(), val(p.shuffle.unwrap_or(false))),
        ("LoopAvailable".into(), val(p.loop_status.is_some())),
        (
            "LoopStatus".into(),
            val(p.loop_status.clone().unwrap_or("None".into())),
        ),
        ("VolumeAvailable".into(), val(p.volume.is_some())),
        ("Volume".into(), val(p.volume.unwrap_or(0.0))),
        ("VolumeLimit".into(), val(p.volume_limit)),
        (
            "VolumeTargets".into(),
            val(p.volume_targets.iter().map(|s| path(s)).collect::<Vec<_>>()),
        ),
        (
            "State".into(),
            val(if p.error.is_empty() {
                "Ready"
            } else {
                "Degraded"
            }
            .to_string()),
        ),
        ("Capabilities".into(), val(p.capabilities())),
    ])
}
pub async fn publish(m: &Media) -> zbus::Result<()> {
    let current = {
        let r = m.roster.read().unwrap();
        r.players
            .iter()
            .map(|(k, p)| (k.clone(), player_props(p)))
            .collect::<Vec<_>>()
    };
    let mut maps = current;
    maps.push((ROOT.into(), root_props(m)));
    let mut announced = m.announced.lock().await;
    for (p, props) in maps {
        let old = announced.entry(p.clone()).or_default();
        let delta: Props = props
            .iter()
            .filter(|(k, v)| old.get(*k) != Some(*v))
            .map(|(k, v)| (k.clone(), v.try_clone().unwrap()))
            .collect();
        if !delta.is_empty() {
            m.conn
                .emit_signal(
                    None::<&str>,
                    p.as_str(),
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                    &(
                        if p == ROOT {
                            "org.nidara.Media1"
                        } else {
                            "org.nidara.MediaPlayer1"
                        },
                        delta,
                        Vec::<String>::new(),
                    ),
                )
                .await?;
        }
        *old = props;
    }
    let live = m
        .roster
        .read()
        .unwrap()
        .players
        .keys()
        .cloned()
        .collect::<std::collections::BTreeSet<_>>();
    announced.retain(|p, _| p == ROOT || live.contains(p));
    Ok(())
}
#[derive(Clone)]
pub struct Root(pub Media);
#[zbus::interface(name = "org.nidara.Media1")]
impl Root {
    #[zbus(signal)]
    async fn auto_pause_result(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        event_id: u64,
        player: Path,
        result: &str,
    ) -> zbus::Result<()>;
    #[zbus(property)]
    fn state(&self) -> String {
        root_props(&self.0)
            .remove("State")
            .unwrap()
            .try_into()
            .unwrap()
    }
    #[zbus(property)]
    fn last_error(&self) -> String {
        root_props(&self.0)
            .remove("LastError")
            .unwrap()
            .try_into()
            .unwrap()
    }
    #[zbus(property)]
    fn generation(&self) -> u64 {
        root_props(&self.0)
            .remove("Generation")
            .unwrap()
            .try_into()
            .unwrap()
    }
    #[zbus(property)]
    fn players(&self) -> Vec<Path> {
        root_props(&self.0)
            .remove("Players")
            .unwrap()
            .try_into()
            .unwrap()
    }
    #[zbus(property)]
    fn selected(&self) -> Path {
        root_props(&self.0)
            .remove("Selected")
            .unwrap()
            .try_into()
            .unwrap()
    }
    #[zbus(property)]
    fn selection_mode(&self) -> String {
        root_props(&self.0)
            .remove("SelectionMode")
            .unwrap()
            .try_into()
            .unwrap()
    }
    #[zbus(property)]
    fn pinned_bus(&self) -> String {
        root_props(&self.0)
            .remove("PinnedBus")
            .unwrap()
            .try_into()
            .unwrap()
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<String> {
        root_props(&self.0)
            .remove("Capabilities")
            .unwrap()
            .try_into()
            .unwrap()
    }
    #[zbus(property)]
    fn lock_screen_controls(&self) -> bool {
        root_props(&self.0)
            .remove("LockScreenControls")
            .unwrap()
            .try_into()
            .unwrap()
    }
    #[zbus(property)]
    fn pause_on_headphones_disconnect(&self) -> bool {
        root_props(&self.0)
            .remove("PauseOnHeadphonesDisconnect")
            .unwrap()
            .try_into()
            .unwrap()
    }
    #[zbus(property)]
    fn headphone_pause_available(&self) -> bool {
        root_props(&self.0)
            .remove("HeadphonePauseAvailable")
            .unwrap()
            .try_into()
            .unwrap()
    }
    async fn set_selection(&self, bus: String) -> Result<(), Error> {
        let _g = self.0.updates.lock().await;
        {
            let mut r = self.0.roster.write().unwrap();
            if !bus.is_empty() && !r.players.values().any(|p| p.bus == bus) {
                return Err(Error::NotFound("bus absent".into()));
            }
            r.pin = bus;
        }
        publish(&self.0).await?;
        Ok(())
    }
    async fn selected_play(&self) -> Result<(), Error> {
        self.0.transport(self.0.selected(None)?, "Play").await
    }
    async fn selected_pause(&self) -> Result<(), Error> {
        self.0.transport(self.0.selected(None)?, "Pause").await
    }
    async fn selected_play_pause(&self) -> Result<(), Error> {
        self.0.transport(self.0.selected(None)?, "PlayPause").await
    }
    async fn selected_stop(&self) -> Result<(), Error> {
        self.0.transport(self.0.selected(None)?, "Stop").await
    }
    async fn selected_next(&self) -> Result<(), Error> {
        self.0.transport(self.0.selected(None)?, "Next").await
    }
    async fn selected_previous(&self) -> Result<(), Error> {
        self.0.transport(self.0.selected(None)?, "Previous").await
    }
    async fn selected_raise(&self) -> Result<(), Error> {
        self.0.transport(self.0.selected(None)?, "Raise").await
    }
    async fn selected_seek_to(
        &self,
        expected_player: Path,
        revision: u64,
        position_us: i64,
    ) -> Result<(), Error> {
        self.0
            .seek(
                self.0.selected(Some(expected_player.as_str()))?,
                revision,
                position_us,
            )
            .await
    }
    async fn selected_set_shuffle(
        &self,
        expected_player: Path,
        shuffle: bool,
    ) -> Result<(), Error> {
        self.0
            .set(
                self.0.selected(Some(expected_player.as_str()))?,
                "Shuffle",
                Value::from(shuffle),
            )
            .await
    }
    async fn selected_set_loop_status(
        &self,
        expected_player: Path,
        status: String,
    ) -> Result<(), Error> {
        check_loop(&status)?;
        self.0
            .set(
                self.0.selected(Some(expected_player.as_str()))?,
                "LoopStatus",
                Value::from(status),
            )
            .await
    }
    async fn selected_set_volume(&self, expected_player: Path, volume: f64) -> Result<(), Error> {
        audio::volume(
            &self.0,
            self.0.selected(Some(expected_player.as_str()))?,
            volume,
        )
        .await
    }
}
fn check_loop(s: &str) -> Result<(), Error> {
    if ["None", "Track", "Playlist"].contains(&s) {
        Ok(())
    } else {
        Err(Error::InvalidArgument("LoopStatus".into()))
    }
}

#[derive(Clone)]
pub struct PlayerObject(pub Media, pub String, pub Player);
impl PlayerObject {
    fn initial_or_live(&self) -> Player {
        self.0.get(&self.1).unwrap_or_else(|_| self.2.clone())
    }
}
#[zbus::interface(name = "org.nidara.MediaPlayer1")]
impl PlayerObject {
    #[zbus(property)]
    fn bus_name(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.bus.clone())
    }
    #[zbus(property)]
    fn owner(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.owner.clone())
    }
    #[zbus(property)]
    fn identity(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.identity.clone())
    }
    #[zbus(property)]
    fn desktop_entry(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.desktop.clone())
    }
    #[zbus(property)]
    fn app_icon(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.icon.clone())
    }
    #[zbus(property)]
    fn title(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.title.clone())
    }
    #[zbus(property)]
    fn album(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.album.clone())
    }
    #[zbus(property)]
    fn playback_status(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.status.clone())
    }
    #[zbus(property)]
    fn volume_source(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.volume_source.clone())
    }
    #[zbus(property)]
    fn art_state(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.art_state.clone())
    }
    #[zbus(property)]
    fn art_path(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.art_path.clone())
    }
    #[zbus(property)]
    fn art_error(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.art_error.clone())
    }
    #[zbus(property)]
    fn last_error(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.error.clone())
    }
    #[zbus(property)]
    fn artists(&self) -> zbus::fdo::Result<Vec<String>> {
        let p = self.initial_or_live();
        Ok(p.artists.clone())
    }
    #[zbus(property)]
    fn length_us(&self) -> zbus::fdo::Result<i64> {
        let p = self.initial_or_live();
        Ok(p.length)
    }
    #[zbus(property)]
    fn track_id(&self) -> zbus::fdo::Result<Path> {
        let p = self.initial_or_live();
        Ok(path(&p.track))
    }
    #[zbus(property)]
    fn track_revision(&self) -> zbus::fdo::Result<u64> {
        let p = self.initial_or_live();
        Ok(p.revision)
    }
    #[zbus(property)]
    fn rate(&self) -> zbus::fdo::Result<f64> {
        let p = self.initial_or_live();
        Ok(p.rate)
    }
    #[zbus(property(emits_changed_signal = "false"))]
    fn position_us(&self) -> zbus::fdo::Result<i64> {
        let p = self.initial_or_live();
        Ok(p.position_at(now()))
    }
    #[zbus(property)]
    fn position_anchor(&self) -> zbus::fdo::Result<(i64, u64, f64)> {
        let p = self.initial_or_live();
        Ok((p.position, p.at, p.rate))
    }
    #[zbus(property)]
    fn position_available(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.position_available)
    }
    #[zbus(property)]
    fn can_control(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.control)
    }
    #[zbus(property)]
    fn can_play(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.play)
    }
    #[zbus(property)]
    fn can_pause(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.pause)
    }
    #[zbus(property)]
    fn can_go_next(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.next)
    }
    #[zbus(property)]
    fn can_go_previous(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.previous)
    }
    #[zbus(property)]
    fn can_seek(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.seek)
    }
    #[zbus(property)]
    fn can_raise(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.raise)
    }
    #[zbus(property)]
    fn shuffle_available(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.shuffle.is_some())
    }
    #[zbus(property)]
    fn shuffle(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.shuffle.unwrap_or(false))
    }
    #[zbus(property)]
    fn loop_available(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.loop_status.is_some())
    }
    #[zbus(property)]
    fn loop_status(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(p.loop_status.clone().unwrap_or("None".into()))
    }
    #[zbus(property)]
    fn volume_available(&self) -> zbus::fdo::Result<bool> {
        let p = self.initial_or_live();
        Ok(p.volume.is_some())
    }
    #[zbus(property)]
    fn volume(&self) -> zbus::fdo::Result<f64> {
        let p = self.initial_or_live();
        Ok(p.volume.unwrap_or(0.0))
    }
    #[zbus(property)]
    fn volume_limit(&self) -> zbus::fdo::Result<f64> {
        let p = self.initial_or_live();
        Ok(p.volume_limit)
    }
    #[zbus(property)]
    fn volume_targets(&self) -> zbus::fdo::Result<Vec<Path>> {
        let p = self.initial_or_live();
        Ok(p.volume_targets.iter().map(|s| path(s)).collect::<Vec<_>>())
    }
    #[zbus(property)]
    fn state(&self) -> zbus::fdo::Result<String> {
        let p = self.initial_or_live();
        Ok(if p.error.is_empty() {
            "Ready"
        } else {
            "Degraded"
        }
        .into())
    }
    #[zbus(property)]
    fn capabilities(&self) -> zbus::fdo::Result<Vec<String>> {
        let p = self.initial_or_live();
        Ok(p.capabilities())
    }
    async fn play(&self) -> Result<(), Error> {
        self.0.transport(self.0.get(&self.1)?, "Play").await
    }
    async fn pause(&self) -> Result<(), Error> {
        self.0.transport(self.0.get(&self.1)?, "Pause").await
    }
    async fn play_pause(&self) -> Result<(), Error> {
        self.0.transport(self.0.get(&self.1)?, "PlayPause").await
    }
    async fn stop(&self) -> Result<(), Error> {
        self.0.transport(self.0.get(&self.1)?, "Stop").await
    }
    async fn next(&self) -> Result<(), Error> {
        self.0.transport(self.0.get(&self.1)?, "Next").await
    }
    async fn previous(&self) -> Result<(), Error> {
        self.0.transport(self.0.get(&self.1)?, "Previous").await
    }
    async fn raise(&self) -> Result<(), Error> {
        self.0.transport(self.0.get(&self.1)?, "Raise").await
    }
    async fn seek_to(&self, revision: u64, position_us: i64) -> Result<(), Error> {
        self.0
            .seek(self.0.get(&self.1)?, revision, position_us)
            .await
    }
    async fn set_shuffle(&self, shuffle: bool) -> Result<(), Error> {
        self.0
            .set(self.0.get(&self.1)?, "Shuffle", Value::from(shuffle))
            .await
    }
    async fn set_loop_status(&self, status: String) -> Result<(), Error> {
        check_loop(&status)?;
        self.0
            .set(self.0.get(&self.1)?, "LoopStatus", Value::from(status))
            .await
    }
    async fn set_volume(&self, volume: f64) -> Result<(), Error> {
        audio::volume(&self.0, self.0.get(&self.1)?, volume).await
    }
    async fn request_position(&self) -> Result<(i64, u64, f64), Error> {
        let p = self.0.get(&self.1)?;
        let position = self.0.position(&p, false).await?;
        Ok((position, now(), self.0.get(&self.1)?.rate))
    }
}
