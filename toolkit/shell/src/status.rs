// SPDX-License-Identifier: LGPL-3.0-or-later
//! What the bar's widgets show (B1, #959): Wi-Fi from Network1, the default output's
//! volume from Audio1, the battery from Power1 — the session daemon's services, read the
//! way their READMEs ask (subscribe first, then read; a new owner reads again; no owner,
//! nothing shown). Each is `None` while its service is absent or has nothing to show: a
//! machine without Wi-Fi, a battery or an output never shows that widget.
//!
//! The icons are the TS widgets' rules (`ui/shell/widgets/{wifi,volume,battery}.ts`).
use serde_json::Value;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::{Duration, Instant};
use zbus::MatchRule;
use zbus::blocking::{Connection, MessageIterator};
use zbus::message::Type;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

pub(crate) const SESSION: &str = "org.nidara.Session";
const NETWORK: &str = "org.nidara.Network";
const NETWORK_PATH: &str = "/org/nidara/Network";
const NETWORK_IFACE: &str = "org.nidara.Network1";
const AUDIO_PATH: &str = "/org/nidara/Audio";
const POWER_PATH: &str = "/org/nidara/Power";

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Wifi {
    Off,
    /// Joining a network.
    Connecting,
    /// On a network, its signal in 0–3 arcs.
    Connected(u8),
    /// On, on no network.
    Disconnected,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Volume {
    pub level: f64,
    pub muted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Battery {
    /// 0..1.
    pub fraction: f64,
    /// On AC: charging or full. The glyph's bolt means AC, not "still filling".
    pub charging: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Status {
    pub wifi: Option<Wifi>,
    pub volume: Option<Volume>,
    pub battery: Option<Battery>,
    /// Do Not Disturb (`org.nidara.notifications do-not-disturb`): the focus widget
    /// shows only while it is on.
    pub dnd: bool,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Update {
    Wifi(Option<Wifi>),
    Volume(Option<Volume>),
    Battery(Option<Battery>),
    Dnd(bool),
}

impl Status {
    pub fn apply(&mut self, u: Update) {
        match u {
            Update::Wifi(w) => self.wifi = w,
            Update::Volume(v) => self.volume = v,
            Update::Battery(b) => self.battery = b,
            Update::Dnd(d) => self.dnd = d,
        }
    }
}

/// Signal strength (0–100) as arcs: GNOME's thresholds on our four glyphs.
pub fn signal_level(strength: u64) -> u8 {
    match strength {
        80.. => 3,
        55.. => 2,
        30.. => 1,
        _ => 0,
    }
}

/// The Wi-Fi adapter's state from a Network1 snapshot: the one on a network if any, else
/// the first. None without an adapter.
pub fn wifi_of(snapshot: &Value) -> Option<Wifi> {
    // NM_DEVICE_TYPE_WIFI; NM_DEVICE_STATE_PREPARE and _ACTIVATED.
    const WIFI: u64 = 2;
    const PREPARE: u64 = 40;
    const ACTIVATED: u64 = 100;
    let devices = snapshot["devices"].as_array()?;
    let adapters: Vec<&Value> = devices
        .iter()
        .filter(|d| d["kind"].as_u64() == Some(WIFI))
        .collect();
    let device = adapters
        .iter()
        .find(|d| d["state"].as_u64() == Some(ACTIVATED))
        .or(adapters.first())?;
    if !snapshot["wirelessEnabled"].as_bool().unwrap_or(false) {
        return Some(Wifi::Off);
    }
    let state = device["state"].as_u64().unwrap_or(0);
    let active = device["activeAp"].as_str().unwrap_or("/");
    let ap = device["accessPoints"]
        .as_array()
        .and_then(|aps| aps.iter().find(|a| a["path"].as_str() == Some(active)));
    Some(match (state, ap) {
        (ACTIVATED, Some(ap)) => {
            Wifi::Connected(signal_level(ap["strength"].as_u64().unwrap_or(0)))
        }
        (s, _) if (PREPARE..ACTIVATED).contains(&s) => Wifi::Connecting,
        _ => Wifi::Disconnected,
    })
}

pub fn wifi_icon(w: Wifi) -> &'static str {
    match w {
        Wifi::Off => "nd-network-wireless-disabled",
        Wifi::Connecting => "nd-network-wireless-acquiring",
        Wifi::Connected(0) => "nd-network-wireless-signal-none",
        Wifi::Connected(1) => "nd-network-wireless-signal-weak",
        Wifi::Connected(2) => "nd-network-wireless-signal-ok",
        Wifi::Connected(_) | Wifi::Disconnected => "nd-network-wireless",
    }
}

pub fn volume_icon(v: Volume) -> &'static str {
    match v.level {
        _ if v.muted => "nd-audio-volume-muted",
        l if l <= 0. => "nd-audio-volume-muted",
        l if l < 0.34 => "nd-audio-volume-low",
        l if l < 0.67 => "nd-audio-volume-medium",
        _ => "nd-audio-volume-high",
    }
}

/// The battery from the display device's PowerDevice1 properties. UPower's states:
/// 1 charging, 4 fully charged.
pub fn battery_of(present: bool, known: bool, percentage: f64, state: u32) -> Option<Battery> {
    (present && known).then_some(Battery {
        fraction: (percentage / 100.).clamp(0., 1.),
        charging: matches!(state, 1 | 4),
    })
}

/// One service's read: what the bar shows of it now.
type Reader = fn(&Connection) -> Result<Update, String>;

/// The three watchers, each on its own thread for as long as the shell lives.
pub fn watch(conn: &Connection, emit: Sender<Update>) {
    let watchers: [(&str, Reader, Update, _); 3] = [
        (
            "network",
            read_wifi,
            Update::Wifi(None),
            vec![
                signal(NETWORK, NETWORK_IFACE, "Updated", NETWORK_PATH, false),
                owner(NETWORK),
            ],
        ),
        (
            "audio",
            read_volume,
            Update::Volume(None),
            vec![
                signal(
                    SESSION,
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                    AUDIO_PATH,
                    true,
                ),
                signal(
                    SESSION,
                    "org.freedesktop.DBus.ObjectManager",
                    "InterfacesRemoved",
                    AUDIO_PATH,
                    false,
                ),
                owner(SESSION),
            ],
        ),
        (
            "power",
            read_battery,
            Update::Battery(None),
            vec![
                signal(
                    SESSION,
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                    POWER_PATH,
                    true,
                ),
                owner(SESSION),
            ],
        ),
    ];
    for (name, read, absent, rules) in watchers {
        let (conn, emit) = (conn.clone(), emit.clone());
        let _ = std::thread::Builder::new()
            .name(format!("status-{name}"))
            .spawn(move || {
                let (tx, rx) = channel();
                // Every iterator exists before the first read: nothing is missed between.
                let mut iters = vec![];
                for rule in rules.into_iter().flatten() {
                    match MessageIterator::for_match_rule(rule, &conn, Some(64)) {
                        Ok(it) => iters.push(it),
                        Err(e) => eprintln!("nidara-shell: the bar cannot watch {name}: {e}"),
                    }
                }
                forward(iters, &tx, name);
                run(
                    name,
                    &rx,
                    || read(&conn),
                    absent,
                    |u| {
                        let _ = emit.send(u);
                    },
                );
            });
    }
}

/// Each iterator's messages, as pokes on `tx`, from a thread of its own.
pub(crate) fn forward(iters: Vec<MessageIterator>, tx: &Sender<()>, name: &str) {
    for it in iters {
        let tx = tx.clone();
        let _ = std::thread::Builder::new()
            .name(format!("status-{name}-signal"))
            .spawn(move || {
                for _ in it.flatten() {
                    if tx.send(()).is_err() {
                        return;
                    }
                }
            });
    }
}

pub(crate) fn signal(
    sender: &'static str,
    iface: &'static str,
    member: &'static str,
    path: &'static str,
    namespace: bool,
) -> Option<MatchRule<'static>> {
    let b = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender(sender)
        .ok()?
        .interface(iface)
        .ok()?
        .member(member)
        .ok()?;
    let b = if namespace {
        b.path_namespace(path).ok()?
    } else {
        b.path(path).ok()?
    };
    Some(b.build())
}

pub(crate) fn owner(name: &'static str) -> Option<MatchRule<'static>> {
    Some(
        MatchRule::builder()
            .msg_type(Type::Signal)
            .sender("org.freedesktop.DBus")
            .ok()?
            .interface("org.freedesktop.DBus")
            .ok()?
            .member("NameOwnerChanged")
            .ok()?
            .add_arg(name)
            .ok()?
            .build(),
    )
}

/// Read at once, then again after each poke (a burst read once); a failed read shows
/// nothing and retries, backing off, until the service answers or a poke comes.
pub(crate) fn run<T: Clone + PartialEq>(
    what: &str,
    rx: &Receiver<()>,
    mut read: impl FnMut() -> Result<T, String>,
    absent: T,
    emit: impl Fn(T),
) {
    let mut last: Option<T> = None;
    let mut retry: Option<Instant>;
    let mut backoff = Duration::from_secs(1);
    loop {
        match read() {
            Ok(u) => {
                retry = None;
                backoff = Duration::from_secs(1);
                if last.as_ref() != Some(&u) {
                    last = Some(u.clone());
                    emit(u);
                }
            }
            Err(e) => {
                retry = Some(Instant::now() + backoff);
                backoff = (backoff * 2).min(Duration::from_secs(60));
                if last.as_ref() != Some(&absent) {
                    eprintln!("nidara-shell: the bar shows no {what}: {e}");
                    last = Some(absent.clone());
                    emit(absent.clone());
                }
            }
        }
        let woke = match retry {
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(()) => true,
                Err(RecvTimeoutError::Timeout) => false,
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(()) => true,
                Err(_) => return,
            },
        };
        if woke {
            // A volume drag is a burst: read once for all of it.
            std::thread::sleep(Duration::from_millis(16));
            while rx.try_recv().is_ok() {}
        }
    }
}

fn proxy<'a>(
    conn: &Connection,
    dest: &'a str,
    path: &'a str,
    iface: &'a str,
) -> Result<zbus::blocking::Proxy<'a>, String> {
    zbus::blocking::Proxy::new(conn, dest, path, iface).map_err(|e| e.to_string())
}

fn read_wifi(conn: &Connection) -> Result<Update, String> {
    let reply = conn
        .call_method(
            Some(NETWORK),
            NETWORK_PATH,
            Some(NETWORK_IFACE),
            "Snapshot",
            &(),
        )
        .map_err(|e| e.to_string())?;
    let (_, _, json): (u64, u64, String) = reply.body().deserialize().map_err(|e| e.to_string())?;
    let snapshot: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    Ok(Update::Wifi(wifi_of(&snapshot)))
}

fn read_volume(conn: &Connection) -> Result<Update, String> {
    let root = proxy(conn, SESSION, AUDIO_PATH, "org.nidara.Audio1")?;
    let out: OwnedObjectPath = root
        .get_property("DefaultOutput")
        .map_err(|e| e.to_string())?;
    if out.as_str() == "/" {
        return Ok(Update::Volume(None));
    }
    let node = proxy(conn, SESSION, out.as_str(), "org.nidara.AudioNode1")?;
    let level: f64 = node.get_property("Volume").map_err(|e| e.to_string())?;
    let muted: bool = node.get_property("Muted").map_err(|e| e.to_string())?;
    Ok(Update::Volume(Some(Volume { level, muted })))
}

fn read_battery(conn: &Connection) -> Result<Update, String> {
    let root = proxy(conn, SESSION, POWER_PATH, "org.nidara.Power1")?;
    let display: OwnedObjectPath = root
        .get_property("DisplayDevice")
        .map_err(|e| e.to_string())?;
    if display.as_str() == "/" {
        return Ok(Update::Battery(None));
    }
    let d = proxy(conn, SESSION, display.as_str(), "org.nidara.PowerDevice1")?;
    let get = |name: &str| -> Result<OwnedValue, String> {
        d.get_property(name).map_err(|e| e.to_string())
    };
    let present = bool::try_from(get("Present")?).map_err(|e| e.to_string())?;
    let known = bool::try_from(get("PercentageKnown")?).map_err(|e| e.to_string())?;
    let percentage = f64::try_from(get("Percentage")?).map_err(|e| e.to_string())?;
    let state = u32::try_from(get("State")?).map_err(|e| e.to_string())?;
    Ok(Update::Battery(battery_of(
        present, known, percentage, state,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(enabled: bool, state: u64, strength: u64) -> Value {
        json!({
            "wirelessEnabled": enabled,
            "devices": [
                {"kind": 1, "state": 100},
                {"kind": 2, "state": state, "activeAp": "/ap/1",
                 "accessPoints": [{"path": "/ap/1", "strength": strength}]},
            ],
        })
    }

    #[test]
    fn wifi_reads_like_the_ts_widget() {
        assert_eq!(wifi_of(&snapshot(false, 100, 90)), Some(Wifi::Off));
        assert_eq!(wifi_of(&snapshot(true, 100, 90)), Some(Wifi::Connected(3)));
        assert_eq!(wifi_of(&snapshot(true, 100, 54)), Some(Wifi::Connected(1)));
        assert_eq!(wifi_of(&snapshot(true, 70, 0)), Some(Wifi::Connecting));
        assert_eq!(wifi_of(&snapshot(true, 30, 0)), Some(Wifi::Disconnected));
        // No adapter: no widget.
        assert_eq!(
            wifi_of(&json!({"wirelessEnabled": true, "devices": [{"kind": 1}]})),
            None
        );
        assert_eq!(
            wifi_icon(Wifi::Connected(2)),
            "nd-network-wireless-signal-ok"
        );
    }

    #[test]
    fn volume_and_battery() {
        let v = |level, muted| volume_icon(Volume { level, muted });
        assert_eq!(v(0.5, true), "nd-audio-volume-muted");
        assert_eq!(v(0., false), "nd-audio-volume-muted");
        assert_eq!(v(0.2, false), "nd-audio-volume-low");
        assert_eq!(v(0.5, false), "nd-audio-volume-medium");
        assert_eq!(v(1.2, false), "nd-audio-volume-high");
        assert_eq!(battery_of(false, true, 50., 2), None);
        assert_eq!(
            battery_of(true, true, 150., 4),
            Some(Battery {
                fraction: 1.,
                charging: true
            })
        );
    }

    #[test]
    fn a_burst_is_read_once_and_an_absent_service_shows_nothing() {
        let (tx, rx) = channel();
        let reads = std::cell::Cell::new(0);
        let seen = std::cell::RefCell::new(vec![]);
        for _ in 0..5 {
            tx.send(()).unwrap();
        }
        drop(tx);
        run(
            "test",
            &rx,
            || {
                reads.set(reads.get() + 1);
                if reads.get() == 1 {
                    Err("no owner".into())
                } else {
                    Ok(Update::Dnd(true))
                }
            },
            Update::Wifi(None),
            |u| seen.borrow_mut().push(u),
        );
        assert_eq!(reads.get(), 2);
        assert_eq!(*seen.borrow(), [Update::Wifi(None), Update::Dnd(true)]);
    }
}
