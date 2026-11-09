// SPDX-License-Identifier: LGPL-3.0-or-later
//! What the bar's widgets show (B1, #959): Wi-Fi from Network1, the default output's
//! volume from Audio1, the battery from Power1 — the session daemon's services, read the
//! way their READMEs ask (subscribe first, then read; a new owner reads again; no owner,
//! nothing shown). Each is `None` while its service is absent or has nothing to show: a
//! machine without Wi-Fi, a battery or an output never shows that widget.
//!
//! The icons are the TS widgets' rules (`ui/shell/widgets/{wifi,volume,battery}.ts`).
//!
//! The Control Center's tiles (B2.1) read more of the same services: the network's name,
//! the display's brightness (DisplayBrightness1), Bluetooth's radio (Bluetooth1) and the
//! selected player (Media1). Dark mode and Night Light are GSettings (prefs.rs).
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
const BRIGHTNESS_PATH: &str = "/org/nidara/DisplayBrightness";
const BRIGHTNESS_IFACE: &str = "org.nidara.DisplayBrightness1";
const BLUETOOTH: &str = "org.nidara.Bluetooth";
const BLUETOOTH_PATH: &str = "/org/nidara/Bluetooth";
const BLUETOOTH_IFACE: &str = "org.nidara.Bluetooth1";
pub(crate) const MEDIA_PATH: &str = "/org/nidara/Media";
pub(crate) const MEDIA_IFACE: &str = "org.nidara.Media1";

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

/// The display brightness the Control Center's slider moves: one device's raw range.
#[derive(Clone, Debug, PartialEq)]
pub struct Brightness {
    pub device: String,
    pub epoch: u64,
    pub min: u32,
    pub max: u32,
    pub current: u32,
}

impl Brightness {
    /// 0..1 across the device's range.
    pub fn fraction(&self) -> f64 {
        let span = self.max.saturating_sub(self.min);
        if span == 0 {
            return 0.;
        }
        (f64::from(self.current.saturating_sub(self.min)) / f64::from(span)).clamp(0., 1.)
    }
    /// The raw level for `fraction`.
    pub fn raw(&self, fraction: f64) -> u32 {
        let span = f64::from(self.max.saturating_sub(self.min));
        self.min + (fraction.clamp(0., 1.) * span).round() as u32
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Bluetooth {
    pub adapter: String,
    pub powered: bool,
}

/// Night Light (`org.nidara.night-light`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Night {
    pub enabled: bool,
    pub temperature: i32,
}

/// The selected player (Media1's `Selected`).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Media {
    pub owner: String,
    pub title: String,
    pub artist: String,
    pub playing: bool,
    pub can_control: bool,
    pub can_next: bool,
    pub can_previous: bool,
    /// The cover's file, once Media1 has fetched it.
    pub art: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Status {
    pub details: crate::ccdata::Details,
    pub capture: crate::capture::State,
    pub night_schedule: (bool, String, String),
    pub wifi: Option<Wifi>,
    /// The network joined or being joined.
    pub wifi_name: String,
    pub volume: Option<Volume>,
    pub battery: Option<Battery>,
    pub battery_state: u32,
    pub battery_time: Option<i64>,
    pub aux: crate::ccaux::Snapshot,
    /// Do Not Disturb (`org.nidara.notifications do-not-disturb`): the focus widget
    /// shows only while it is on.
    pub dnd: bool,
    /// `org.gnome.desktop.interface color-scheme` is prefer-dark.
    pub dark: bool,
    pub night: Option<Night>,
    pub brightness: Option<Brightness>,
    pub bluetooth: Option<Bluetooth>,
    /// None: no media service; Some with an empty title: nothing playing.
    pub media: Option<std::sync::Arc<Media>>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Update {
    BrightnessOwned(Option<Brightness>, String),
    NightSchedule(bool, String, String),
    Network(std::sync::Arc<Value>),
    BluetoothSnapshot(std::sync::Arc<Value>),
    Audio(
        Option<Volume>,
        String,
        std::sync::Arc<Vec<crate::ccdata::Choice>>,
    ),
    Players(
        Option<std::sync::Arc<Media>>,
        String,
        String,
        std::sync::Arc<Vec<crate::ccdata::Choice>>,
    ),
    Wifi(Option<Wifi>, String),
    Volume(Option<Volume>),
    Battery(Option<Battery>),
    BatteryInfo(Option<Battery>, u32, Option<i64>),
    Dnd(bool),
    Dark(bool),
    Night(Option<Night>),
    Brightness(Option<Brightness>),
    Bluetooth(Option<Bluetooth>),
    Media(Option<std::sync::Arc<Media>>),
}

impl Status {
    pub fn apply(&mut self, u: Update) {
        match u {
            Update::BrightnessOwned(value, owner) => {
                self.brightness = value;
                self.details.brightness_owner = owner;
            }
            Update::NightSchedule(on, from, to) => self.night_schedule = (on, from, to),
            Update::Network(s) => {
                self.wifi = wifi_of(&s);
                self.wifi_name = wifi_name(&s);
                self.details.network = Some(s);
            }
            Update::BluetoothSnapshot(s) => {
                self.bluetooth = bluetooth_of(&s);
                self.details.bluetooth = Some(s);
            }
            Update::Audio(v, default, nodes) => {
                self.volume = v;
                self.details.default_output = default;
                self.details.audio = nodes;
            }
            Update::Players(m, selected, pinned, players) => {
                self.media = m;
                self.details.selected = selected;
                self.details.pinned = pinned;
                self.details.players = players;
            }
            Update::Wifi(w, name) => {
                (self.wifi, self.wifi_name) = (w, name);
                self.details.network = None;
            }
            Update::Volume(v) => {
                self.volume = v;
                self.details.audio = Default::default();
                self.details.default_output.clear();
            }
            Update::Battery(b) => {
                self.battery = b;
                self.battery_time = None;
                self.battery_state = 0;
            }
            Update::BatteryInfo(b, state, time) => {
                self.battery = b;
                self.battery_state = state;
                self.battery_time = time;
            }
            Update::Dnd(d) => self.dnd = d,
            Update::Dark(d) => self.dark = d,
            Update::Night(n) => self.night = n,
            Update::Brightness(b) => {
                self.brightness = b;
                self.details.brightness_owner.clear();
            }
            Update::Bluetooth(b) => {
                self.bluetooth = b;
                self.details.bluetooth = None;
            }
            Update::Media(m) => {
                self.media = m;
                self.details.players = Default::default();
                self.details.selected.clear();
                self.details.pinned.clear();
            }
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

/// The network the Wi-Fi adapter is on or joining: its access point's name.
pub fn wifi_name(snapshot: &Value) -> String {
    const WIFI: u64 = 2;
    let Some(devices) = snapshot["devices"].as_array() else {
        return String::new();
    };
    devices
        .iter()
        .filter(|d| d["kind"].as_u64() == Some(WIFI))
        .find_map(|d| {
            let active = d["activeAp"].as_str()?;
            d["accessPoints"]
                .as_array()?
                .iter()
                .find(|a| a["path"].as_str() == Some(active))?["label"]
                .as_str()
                .map(str::to_string)
        })
        .unwrap_or_default()
}

/// DisplayBrightness1's device: id, output, provider, min, max, current, available,
/// writable, epoch.
pub type DeviceRecord = (String, String, String, u32, u32, u32, bool, bool, u64);

/// The device the Control Center's slider moves: an internal panel's first (logind's),
/// else the first that can be written.
pub fn brightness_of(devices: &[DeviceRecord]) -> Option<Brightness> {
    let usable = || devices.iter().filter(|d| d.6 && d.7 && d.4 > d.3);
    let (id, _, _, min, max, current, _, _, epoch) = usable()
        .find(|d| d.2 == "logind")
        .or_else(|| usable().next())?;
    Some(Brightness {
        device: id.clone(),
        epoch: *epoch,
        min: *min,
        max: *max,
        current: *current,
    })
}

/// The first adapter's radio, from a Bluetooth1 snapshot; None without one.
pub fn bluetooth_of(snapshot: &Value) -> Option<Bluetooth> {
    if !snapshot["available"].as_bool().unwrap_or(false) {
        return None;
    }
    let a = snapshot["adapters"].as_array()?.first()?;
    Some(Bluetooth {
        adapter: a["path"].as_str()?.to_string(),
        powered: a["powered"].as_bool().unwrap_or(false),
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
    let watchers: [(&str, Reader, Update, _); 6] = [
        (
            "network",
            read_wifi,
            Update::Wifi(None, String::new()),
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
                    "InterfacesAdded",
                    AUDIO_PATH,
                    false,
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
        (
            "brightness",
            read_brightness,
            Update::Brightness(None),
            vec![
                signal(SESSION, BRIGHTNESS_IFACE, "Changed", BRIGHTNESS_PATH, false),
                owner(SESSION),
            ],
        ),
        (
            "bluetooth",
            read_bluetooth,
            Update::Bluetooth(None),
            vec![
                signal(BLUETOOTH, BLUETOOTH_IFACE, "Updated", BLUETOOTH_PATH, false),
                owner(BLUETOOTH),
            ],
        ),
        (
            "media",
            read_media,
            Update::Media(None),
            vec![
                signal(
                    SESSION,
                    "org.freedesktop.DBus.Properties",
                    "PropertiesChanged",
                    MEDIA_PATH,
                    true,
                ),
                signal(
                    SESSION,
                    "org.freedesktop.DBus.ObjectManager",
                    "InterfacesAdded",
                    MEDIA_PATH,
                    false,
                ),
                signal(
                    SESSION,
                    "org.freedesktop.DBus.ObjectManager",
                    "InterfacesRemoved",
                    MEDIA_PATH,
                    false,
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

fn service_owner(conn: &Connection, name: &str) -> Result<String, String> {
    conn.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "GetNameOwner",
        &(name,),
    )
    .map_err(|e| e.to_string())?
    .body()
    .deserialize()
    .map_err(|e| e.to_string())
}
fn read_wifi(conn: &Connection) -> Result<Update, String> {
    let owner = service_owner(conn, NETWORK)?;
    let reply = conn
        .call_method(
            Some(owner.as_str()),
            NETWORK_PATH,
            Some(NETWORK_IFACE),
            "Snapshot",
            &(),
        )
        .map_err(|e| e.to_string())?;
    let (epoch, _, json): (u64, u64, String) =
        reply.body().deserialize().map_err(|e| e.to_string())?;
    let mut snapshot: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if snapshot["schemaVersion"] != 1 {
        return Err("unsupported service snapshot schema".into());
    }
    snapshot["_serviceOwner"] = Value::String(owner);
    snapshot["_serviceEpoch"] = Value::from(epoch);
    Ok(Update::Network(std::sync::Arc::new(snapshot)))
}

fn read_volume(conn: &Connection) -> Result<Update, String> {
    let owner = service_owner(conn, SESSION)?;
    let root = proxy(conn, &owner, AUDIO_PATH, "org.nidara.Audio1")?;
    let out: OwnedObjectPath = root
        .get_property("DefaultOutput")
        .map_err(|e| e.to_string())?;
    let mut nodes = crate::ccdata::objects(conn, &owner, AUDIO_PATH, "org.nidara.AudioNode1")?;
    let limit: f64 = root
        .get_property("VolumeLimit")
        .map_err(|e| e.to_string())?;
    for node in &mut nodes {
        node.volume_limit = if limit.is_finite() {
            limit.clamp(0., 1.5)
        } else {
            1.
        };
    }
    let nodes = std::sync::Arc::new(nodes);
    if out.as_str() == "/" {
        return Ok(Update::Audio(None, out.to_string(), nodes));
    }
    let node = proxy(conn, &owner, out.as_str(), "org.nidara.AudioNode1")?;
    let level: f64 = node.get_property("Volume").map_err(|e| e.to_string())?;
    let muted: bool = node.get_property("Muted").map_err(|e| e.to_string())?;
    Ok(Update::Audio(
        Some(Volume { level, muted }),
        out.to_string(),
        nodes,
    ))
}

fn read_battery(conn: &Connection) -> Result<Update, String> {
    let owner = service_owner(conn, SESSION)?;
    let root = proxy(conn, &owner, POWER_PATH, "org.nidara.Power1")?;
    let display: OwnedObjectPath = root
        .get_property("DisplayDevice")
        .map_err(|e| e.to_string())?;
    if display.as_str() == "/" {
        return Ok(Update::Battery(None));
    }
    let d = proxy(conn, &owner, display.as_str(), "org.nidara.PowerDevice1")?;
    let get = |name: &str| -> Result<OwnedValue, String> {
        d.get_property(name).map_err(|e| e.to_string())
    };
    let present = bool::try_from(get("Present")?).map_err(|e| e.to_string())?;
    let known = bool::try_from(get("PercentageKnown")?).map_err(|e| e.to_string())?;
    let percentage = f64::try_from(get("Percentage")?).map_err(|e| e.to_string())?;
    let state = u32::try_from(get("State")?).map_err(|e| e.to_string())?;
    let (known_key, time_key) = if matches!(state, 1 | 5) {
        ("TimeToFullKnown", "TimeToFull")
    } else {
        ("TimeToEmptyKnown", "TimeToEmpty")
    };
    let time = get(known_key)
        .ok()
        .and_then(|v| bool::try_from(v).ok())
        .filter(|v| *v)
        .and_then(|_| get(time_key).ok())
        .and_then(|v| i64::try_from(v).ok())
        .filter(|v| *v > 0);
    Ok(Update::BatteryInfo(
        battery_of(present, known, percentage, state),
        state,
        time,
    ))
}

fn read_brightness(conn: &Connection) -> Result<Update, String> {
    let owner = service_owner(conn, SESSION)?;
    let reply = conn
        .call_method(
            Some(owner.as_str()),
            BRIGHTNESS_PATH,
            Some(BRIGHTNESS_IFACE),
            "GetState",
            &(),
        )
        .map_err(|e| e.to_string())?;
    let (_, _, devices): (u64, u64, Vec<DeviceRecord>) =
        reply.body().deserialize().map_err(|e| e.to_string())?;
    Ok(Update::BrightnessOwned(brightness_of(&devices), owner))
}

fn read_bluetooth(conn: &Connection) -> Result<Update, String> {
    let owner = service_owner(conn, BLUETOOTH)?;
    let reply = conn
        .call_method(
            Some(owner.as_str()),
            BLUETOOTH_PATH,
            Some(BLUETOOTH_IFACE),
            "Snapshot",
            &(),
        )
        .map_err(|e| e.to_string())?;
    let (epoch, _, json): (u64, u64, String) =
        reply.body().deserialize().map_err(|e| e.to_string())?;
    let mut snapshot: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    if snapshot["schemaVersion"] != 1 {
        return Err("unsupported service snapshot schema".into());
    }
    snapshot["_serviceOwner"] = Value::String(owner);
    snapshot["_serviceEpoch"] = Value::from(epoch);
    Ok(Update::BluetoothSnapshot(std::sync::Arc::new(snapshot)))
}

fn read_media(conn: &Connection) -> Result<Update, String> {
    let owner = service_owner(conn, SESSION)?;
    let root = proxy(conn, &owner, MEDIA_PATH, MEDIA_IFACE)?;
    let selected: OwnedObjectPath = root.get_property("Selected").map_err(|e| e.to_string())?;
    let players = std::sync::Arc::new(crate::ccdata::objects(
        conn,
        &owner,
        MEDIA_PATH,
        "org.nidara.MediaPlayer1",
    )?);
    let pinned: String = root.get_property("PinnedBus").map_err(|e| e.to_string())?;
    if selected.as_str() == "/" {
        return Ok(Update::Players(
            Some(std::sync::Arc::new(Media {
                owner: owner.clone(),
                ..Default::default()
            })),
            selected.to_string(),
            pinned,
            players,
        ));
    }
    let p = proxy(conn, &owner, selected.as_str(), "org.nidara.MediaPlayer1")?;
    let text =
        |name: &str| -> Result<String, String> { p.get_property(name).map_err(|e| e.to_string()) };
    let flag =
        |name: &str| -> Result<bool, String> { p.get_property(name).map_err(|e| e.to_string()) };
    let artists: Vec<String> = p.get_property("Artists").map_err(|e| e.to_string())?;
    let art = (text("ArtState")? == "ready")
        .then(|| text("ArtPath"))
        .transpose()?
        .filter(|a| !a.is_empty());
    Ok(Update::Players(
        Some(std::sync::Arc::new(Media {
            owner: owner.clone(),
            title: text("Title")?,
            artist: artists.join(", "),
            playing: text("PlaybackStatus")? == "Playing",
            can_control: flag("CanControl")?,
            can_next: flag("CanGoNext")?,
            can_previous: flag("CanGoPrevious")?,
            art,
        })),
        selected.to_string(),
        pinned,
        players,
    ))
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
            Update::Wifi(None, String::new()),
            |u| seen.borrow_mut().push(u),
        );
        assert_eq!(reads.get(), 2);
        assert_eq!(
            *seen.borrow(),
            [Update::Wifi(None, String::new()), Update::Dnd(true)]
        );
    }
}

#[cfg(test)]
#[path = "ccwire.rs"]
mod wire_tests;
