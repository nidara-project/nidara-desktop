// SPDX-License-Identifier: GPL-3.0-or-later
//! Provider-independent state. Times are monotonic microseconds, lengths signed MPRIS µs.
use std::collections::BTreeMap;
#[derive(Clone, Debug, PartialEq)]
pub struct Player {
    pub path: String,
    pub bus: String,
    pub owner: String,
    pub pid: u32,
    pub pid_start: u64,
    pub identity: String,
    pub desktop: String,
    pub icon: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: String,
    pub track: String,
    pub revision: u64,
    pub length: i64,
    pub status: String,
    pub rate: f64,
    pub position: i64,
    pub at: u64,
    pub synced: u64,
    pub position_available: bool,
    pub active: u64,
    pub control: bool,
    pub play: bool,
    pub pause: bool,
    pub next: bool,
    pub previous: bool,
    pub seek: bool,
    pub raise: bool,
    pub shuffle: Option<bool>,
    pub loop_status: Option<String>,
    pub volume: Option<f64>,
    pub volume_source: String,
    pub volume_limit: f64,
    pub volume_targets: Vec<String>,
    pub art_url: String,
    pub art_state: String,
    pub art_path: String,
    pub art_error: String,
    pub error: String,
}
impl Player {
    pub fn new(bus: String, owner: String, path: String, now: u64) -> Self {
        Self {
            bus,
            owner,
            path,
            pid: 0,
            pid_start: 0,
            identity: String::new(),
            desktop: String::new(),
            icon: String::new(),
            title: String::new(),
            artists: vec![],
            album: String::new(),
            track: "/".into(),
            revision: 1,
            length: 0,
            status: "Stopped".into(),
            rate: 1.0,
            position: 0,
            at: now,
            synced: 0,
            position_available: false,
            active: now,
            control: false,
            play: false,
            pause: false,
            next: false,
            previous: false,
            seek: false,
            raise: false,
            shuffle: None,
            loop_status: None,
            volume: None,
            volume_source: "none".into(),
            volume_limit: 1.0,
            volume_targets: vec![],
            art_url: String::new(),
            art_state: "none".into(),
            art_path: String::new(),
            art_error: String::new(),
            error: String::new(),
        }
    }
    pub fn position_at(&self, now: u64) -> i64 {
        let advance = if self.status == "Playing" {
            now.saturating_sub(self.at) as f64 * self.rate
        } else {
            0.0
        };
        let pos = (self.position as f64 + advance).clamp(0.0, i64::MAX as f64) as i64;
        if self.length > 0 {
            pos.min(self.length)
        } else {
            pos
        }
    }
    pub fn anchor(&mut self, position: i64, now: u64) {
        self.position = position.max(0);
        self.at = now;
        self.synced = now;
        self.position_available = true;
    }
    pub fn playback(&mut self, status: String, rate: f64, now: u64) {
        if self.status != status || self.rate != rate {
            self.position = self.position_at(now);
            self.at = now;
            if self.status != status {
                self.active = now;
            }
            self.status = status;
            self.rate = rate;
        }
    }
    pub fn capabilities(&self) -> Vec<String> {
        let mut out = vec![];
        for (ok, name) in [
            (self.control, "control"),
            (self.control && self.play, "play"),
            (self.control && self.pause, "pause"),
            (self.control && self.next, "next"),
            (self.control && self.previous, "previous"),
            (self.control && self.seek, "seek"),
            (self.raise, "raise"),
            (self.control && self.shuffle.is_some(), "shuffle"),
            (self.control && self.loop_status.is_some(), "loop"),
            (self.volume.is_some(), "volume"),
        ] {
            if ok {
                out.push(name.into());
            }
        }
        out
    }
}
#[derive(Default)]
pub struct Roster {
    pub players: BTreeMap<String, Player>,
    pub pin: String,
}
impl Roster {
    pub fn selected(&self) -> Option<&Player> {
        if !self.pin.is_empty()
            && let Some(p) = self.players.values().find(|p| p.bus == self.pin)
        {
            return Some(p);
        }
        self.players.values().max_by(|a, b| {
            (a.status == "Playing")
                .cmp(&(b.status == "Playing"))
                .then(a.active.cmp(&b.active))
                .then_with(|| b.bus.cmp(&a.bus))
        })
    }
    pub fn remove(&mut self, path: &str) -> Option<Player> {
        let p = self.players.remove(path)?;
        if self.pin == p.bus {
            self.pin.clear();
        }
        Some(p)
    }
}
pub fn length(raw: i64) -> i64 {
    if (0..=9_007_199_254_740_991).contains(&raw) {
        raw
    } else {
        0
    }
}
pub fn track(raw: &str) -> String {
    if raw != "/org/mpris/MediaPlayer2/TrackList/NoTrack"
        && zbus::zvariant::ObjectPath::try_from(raw).is_ok()
    {
        raw.into()
    } else {
        "/".into()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_pin_and_owner_departure() {
        let mut r = Roster::default();
        let mut a = Player::new("a".into(), ":1.1".into(), "/a".into(), 1);
        let mut b = Player::new("b".into(), ":1.2".into(), "/b".into(), 2);
        a.playback("Playing".into(), 1.0, 3);
        b.playback("Playing".into(), 1.0, 4);
        r.players.insert(a.path.clone(), a);
        r.players.insert(b.path.clone(), b);
        assert_eq!(r.selected().unwrap().bus, "b");
        r.pin = "a".into();
        assert_eq!(r.selected().unwrap().bus, "a");
        r.remove("/a");
        assert!(r.pin.is_empty());
        assert_eq!(r.selected().unwrap().bus, "b");
    }
    #[test]
    fn clock_freezes_reanchors_and_handles_reverse_rate() {
        let mut p = Player::new("a".into(), ":1.1".into(), "/a".into(), 0);
        p.anchor(1_000_000, 0);
        p.playback("Playing".into(), 2.0, 0);
        assert_eq!(p.position_at(1_000_000), 3_000_000);
        p.playback("Paused".into(), 2.0, 1_000_000);
        assert_eq!(p.position_at(9_000_000), 3_000_000);
        p.playback("Playing".into(), -1.0, 9_000_000);
        assert_eq!(p.position_at(10_000_000), 2_000_000);
        p.anchor(400, 10_000_000);
        assert_eq!(p.position_at(11_000_000), 0);
        assert_eq!(length(i64::MAX), 0);
        assert_eq!(length(-1), 0);
        assert_eq!(track("not/a/path"), "/");
    }
}
