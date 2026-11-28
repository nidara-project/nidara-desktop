// SPDX-License-Identifier: LGPL-3.0-or-later
//! The login screen's Wi-Fi (#1195, owner 2026-11-28): how it is, and the networks saved for
//! every user, to join one.
//!
//! Joining a network the system does not know yet is not offered here. Saved for every user
//! it would be a system connection, which NetworkManager lets only an administrator add
//! (`settings.modify.system`), and a local account logs in without a network anyway; GDM's
//! own attempt failed for years and Red Hat turns it off. A network is added in Settings,
//! "for all users" when it should connect before anybody logs in. What is offered here needs
//! only `network-control`, which NetworkManager grants an active local session, the login
//! screen's included.
//!
//! The list is the saved networks with no `permissions` (every user's) that are in range,
//! the strongest first. NetworkManager says what changed; after a burst of its signals the
//! state is read again once, and the main thread hears it only when it changed.
use std::collections::HashMap;
use std::sync::mpsc::Sender;
use std::time::{Duration, Instant};

use zbus::blocking::Connection;
use zbus::zvariant::{OwnedObjectPath, OwnedValue};

use crate::Msg;

const NM: &str = "org.freedesktop.NetworkManager";
const ROOT: &str = "/org/freedesktop/NetworkManager";
const SETTINGS: &str = "/org/freedesktop/NetworkManager/Settings";
const DEVICE: &str = "org.freedesktop.NetworkManager.Device";
const WIRELESS: &str = "org.freedesktop.NetworkManager.Device.Wireless";
const AP: &str = "org.freedesktop.NetworkManager.AccessPoint";
const PROFILE: &str = "org.freedesktop.NetworkManager.Settings.Connection";
/// How long NetworkManager's signals are let settle before the state is read again.
const SETTLE: Duration = Duration::from_millis(500);

type Settings = HashMap<String, HashMap<String, OwnedValue>>;

/// The Wi-Fi as the bar shows it.
#[derive(Clone, Debug, PartialEq)]
pub struct Wifi {
    device: OwnedObjectPath,
    /// The saved networks in range, strongest first.
    pub networks: Vec<Network>,
    /// The one connected, among `networks`.
    pub active: Option<usize>,
    /// The bar's glyph: off, connecting, or the signal of the network in use.
    pub glyph: &'static str,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Network {
    pub ssid: String,
    profile: OwnedObjectPath,
}

/// Watches on a thread of its own; each change goes to the main thread as `Msg::Wifi`. A
/// machine without Wi-Fi hears `None` once.
pub fn watch(tx: Sender<Msg>) {
    std::thread::Builder::new()
        .name("lock-wifi".into())
        .spawn(move || {
            if let Err(e) = watch_wifi(&tx) {
                eprintln!("nidara-lock: the Wi-Fi is not shown: {e}");
            }
        })
        .ok();
}

/// Joins `network` on the Wi-Fi's device, on a thread of its own; a refusal is said in the
/// journal, and the bar shows what NetworkManager does.
pub fn join(wifi: &Wifi, network: usize) {
    let Some(n) = wifi.networks.get(network) else {
        return;
    };
    let (profile, device) = (n.profile.clone(), wifi.device.clone());
    std::thread::spawn(move || {
        let call = || -> zbus::Result<()> {
            let bus = Connection::system()?;
            let none = OwnedObjectPath::try_from("/").expect("a path");
            bus.call_method(
                Some(NM),
                ROOT,
                Some(NM),
                "ActivateConnection",
                &(&profile, &device, &none),
            )?;
            Ok(())
        };
        if let Err(e) = call() {
            eprintln!("nidara-lock: joining {}: {e}", profile.as_str());
        }
    });
}

fn watch_wifi(tx: &Sender<Msg>) -> zbus::Result<()> {
    let bus = Connection::system()?;
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender(NM)?
        .build();
    // Subscribed before the first read, so a change between the two is seen.
    let signals = zbus::blocking::MessageIterator::for_match_rule(rule, &bus, Some(256))?;
    let Some(device) = device(&bus) else {
        let _ = tx.send(Msg::Wifi(None));
        return Ok(());
    };
    // A fresh list of what is in range; NetworkManager refuses it when it scanned just now.
    let _ = bus.call_method(
        Some(NM),
        device.as_str(),
        Some(WIRELESS),
        "RequestScan",
        &(HashMap::<String, OwnedValue>::new(),),
    );
    let mut last = None;
    let mut send = |w: Option<Wifi>| {
        if w != last {
            last = w.clone();
            tx.send(Msg::Wifi(w)).is_ok()
        } else {
            true
        }
    };
    if !send(read(&bus, &device)) {
        return Ok(());
    }
    let (wake, woken) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        for msg in signals {
            if msg.is_err() || wake.send(()).is_err() {
                return;
            }
        }
    });
    while woken.recv().is_ok() {
        let until = Instant::now() + SETTLE;
        while let Some(left) = until.checked_duration_since(Instant::now()) {
            if woken.recv_timeout(left).is_err() {
                break;
            }
        }
        if !send(read(&bus, &device)) {
            return Ok(());
        }
    }
    Ok(())
}

fn get(bus: &Connection, path: &str, iface: &str, name: &str) -> Option<OwnedValue> {
    let reply = bus
        .call_method(
            Some(NM),
            path,
            Some("org.freedesktop.DBus.Properties"),
            "Get",
            &(iface, name),
        )
        .ok()?;
    reply.body().deserialize().ok()
}

/// The first Wi-Fi device (NetworkManager's type 2).
fn device(bus: &Connection) -> Option<OwnedObjectPath> {
    let reply = bus
        .call_method(Some(NM), ROOT, Some(NM), "GetDevices", &())
        .ok()?;
    let devices: Vec<OwnedObjectPath> = reply.body().deserialize().ok()?;
    devices.into_iter().find(|d| {
        get(bus, d.as_str(), DEVICE, "DeviceType").and_then(|v| u32::try_from(v).ok()) == Some(2)
    })
}

fn read(bus: &Connection, device: &OwnedObjectPath) -> Option<Wifi> {
    let ssid_of = |ap: &str| -> Option<(String, u8)> {
        let ssid = get(bus, ap, AP, "Ssid").and_then(|v| Vec::<u8>::try_from(v).ok())?;
        let strength = get(bus, ap, AP, "Strength")
            .and_then(|v| u8::try_from(v).ok())
            .unwrap_or(0);
        Some((String::from_utf8_lossy(&ssid).into_owned(), strength))
    };
    let mut range: HashMap<String, u8> = HashMap::new();
    let aps: Vec<OwnedObjectPath> = get(bus, device.as_str(), WIRELESS, "AccessPoints")
        .and_then(|v| Vec::<OwnedObjectPath>::try_from(v).ok())
        .unwrap_or_default();
    for ap in &aps {
        if let Some((ssid, strength)) = ssid_of(ap.as_str()) {
            let best = range.entry(ssid).or_default();
            *best = (*best).max(strength);
        }
    }
    let mut networks: Vec<(Network, u8)> = saved(bus)
        .into_iter()
        .filter_map(|(ssid, profile)| {
            let strength = *range.get(&ssid)?;
            Some((Network { ssid, profile }, strength))
        })
        .collect();
    networks.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.ssid.cmp(&b.0.ssid)));
    let in_use = get(bus, device.as_str(), WIRELESS, "ActiveAccessPoint")
        .and_then(|v| OwnedObjectPath::try_from(v).ok())
        .filter(|p| p.as_str() != "/")
        .and_then(|p| ssid_of(p.as_str()));
    let state = get(bus, device.as_str(), DEVICE, "State")
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0);
    let enabled = get(bus, ROOT, NM, "WirelessEnabled")
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(true);
    let glyph = glyph(enabled, state, in_use.as_ref().map(|u| u.1));
    let active = in_use
        .filter(|_| state == 100)
        .and_then(|(ssid, _)| networks.iter().position(|n| n.0.ssid == ssid));
    Some(Wifi {
        device: device.clone(),
        networks: networks.into_iter().map(|n| n.0).collect(),
        active,
        glyph,
    })
}

/// The bar's glyph from NetworkManager's word: off; connecting (states 40 to 90, preparing
/// to the secondaries); connected, by the signal; or not connected.
fn glyph(enabled: bool, state: u32, strength: Option<u8>) -> &'static str {
    match (enabled, state, strength) {
        (false, ..) => "nd-network-wireless-disabled",
        (_, 40..=90, _) => "nd-network-wireless-acquiring",
        (_, 100, Some(s)) if s <= 33 => "nd-network-wireless-signal-weak",
        (_, 100, _) => "nd-network-wireless-signal-ok",
        _ => "nd-network-wireless-signal-none",
    }
}

/// The saved Wi-Fi networks every user may use (no `permissions`), by SSID.
fn saved(bus: &Connection) -> Vec<(String, OwnedObjectPath)> {
    let Some(profiles) = bus
        .call_method(
            Some(NM),
            SETTINGS,
            Some("org.freedesktop.NetworkManager.Settings"),
            "ListConnections",
            &(),
        )
        .ok()
        .and_then(|r| r.body().deserialize::<Vec<OwnedObjectPath>>().ok())
    else {
        return Vec::new();
    };
    profiles
        .into_iter()
        .filter_map(|p| {
            let reply = bus
                .call_method(Some(NM), p.as_str(), Some(PROFILE), "GetSettings", &())
                .ok()?;
            let settings: Settings = reply.body().deserialize().ok()?;
            for_everyone(&settings).map(|ssid| (ssid, p))
        })
        .collect()
}

/// The SSID of a Wi-Fi profile saved for every user.
fn for_everyone(settings: &Settings) -> Option<String> {
    let connection = settings.get("connection")?;
    let kind = connection
        .get("type")
        .and_then(|v| <&str>::try_from(v).ok());
    if kind != Some("802-11-wireless") {
        return None;
    }
    let restricted = connection
        .get("permissions")
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| Vec::<String>::try_from(v).ok())
        .is_some_and(|p| !p.is_empty());
    if restricted {
        return None;
    }
    let ssid = settings
        .get("802-11-wireless")?
        .get("ssid")
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| Vec::<u8>::try_from(v).ok())?;
    Some(String::from_utf8_lossy(&ssid).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_glyph_follows_networkmanager() {
        assert_eq!(glyph(false, 100, Some(90)), "nd-network-wireless-disabled");
        assert_eq!(glyph(true, 50, None), "nd-network-wireless-acquiring");
        assert_eq!(
            glyph(true, 100, Some(20)),
            "nd-network-wireless-signal-weak"
        );
        assert_eq!(glyph(true, 100, Some(80)), "nd-network-wireless-signal-ok");
        assert_eq!(glyph(true, 30, None), "nd-network-wireless-signal-none");
    }
}
