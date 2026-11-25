// SPDX-License-Identifier: LGPL-3.0-or-later
//! Ordered Network1 snapshots and presentation shared by the shell and Settings.
use serde_json::Value;
use std::{cmp::Reverse, collections::BTreeMap};
use zbus::{
    MatchRule,
    blocking::{Connection, MessageIterator},
    message::Type,
};

pub const NAME: &str = "org.nidara.Network";
pub const PATH: &str = "/org/nidara/Network";
pub const IFACE: &str = "org.nidara.Network1";

#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub owner: String,
    pub epoch: u64,
    pub revision: u64,
    pub data: Value,
}

impl Snapshot {
    fn decode(owner: String, (epoch, revision, json): (u64, u64, String)) -> Result<Self, String> {
        let data: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        if data["schemaVersion"] != 1 {
            return Err("unsupported Network1 schema".into());
        }
        Ok(Self {
            owner,
            epoch,
            revision,
            data,
        })
    }

    pub fn with_identity(self) -> Value {
        let mut data = self.data;
        data["_serviceOwner"] = Value::String(self.owner);
        data["_serviceEpoch"] = Value::from(self.epoch);
        data
    }
}

pub fn owner(conn: &Connection) -> Result<String, String> {
    conn.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "GetNameOwner",
        &(NAME,),
    )
    .and_then(|reply| reply.body().deserialize())
    .map_err(|e| e.to_string())
}

fn snapshot(conn: &Connection, owner: &str) -> Result<Snapshot, String> {
    let packet = conn
        .call_method(Some(owner), PATH, Some(IFACE), "Snapshot", &())
        .and_then(|reply| reply.body().deserialize())
        .map_err(|e| e.to_string())?;
    Snapshot::decode(owner.into(), packet)
}

/// Use a dedicated connection so the caller can end the subscriptions at will.
pub fn watch(
    conn: &Connection,
    mut emit: impl FnMut(Option<Snapshot>) -> bool,
) -> Result<(), String> {
    let mut messages = MessageIterator::from(conn);
    let dbus = zbus::blocking::fdo::DBusProxy::new(conn).map_err(|e| e.to_string())?;
    let signal = || MatchRule::builder().msg_type(Type::Signal);
    let updated = signal()
        .sender(NAME)
        .unwrap()
        .interface(IFACE)
        .unwrap()
        .member("Updated")
        .unwrap()
        .path(PATH)
        .unwrap()
        .build();
    let owner_changed = signal()
        .sender("org.freedesktop.DBus")
        .unwrap()
        .interface("org.freedesktop.DBus")
        .unwrap()
        .member("NameOwnerChanged")
        .unwrap()
        .add_arg(NAME)
        .unwrap()
        .build();
    for rule in [updated, owner_changed] {
        dbus.add_match_rule(rule).map_err(|e| e.to_string())?;
    }
    let mut current_owner = owner(conn).ok();
    let mut latest = current_owner
        .as_deref()
        .and_then(|name| snapshot(conn, name).ok());
    if !emit(latest.clone()) {
        return Ok(());
    }
    for message in &mut messages {
        let message = message.map_err(|e| e.to_string())?;
        let header = message.header();
        if header.message_type() != Type::Signal {
            continue;
        }
        let interface = header.interface().map(|value| value.as_str());
        let member = header.member().map(|value| value.as_str());
        match (interface, member) {
            (Some("org.freedesktop.DBus"), Some("NameOwnerChanged")) => {
                let (name, _, _): (String, String, String) =
                    message.body().deserialize().map_err(|e| e.to_string())?;
                if name != NAME {
                    continue;
                }
                let next = owner(conn).ok();
                if next == current_owner {
                    continue;
                }
                current_owner = next;
                if latest.take().is_some() && !emit(None) {
                    break;
                }
                latest = current_owner
                    .as_deref()
                    .and_then(|name| snapshot(conn, name).ok());
                if latest.is_some() && !emit(latest.clone()) {
                    break;
                }
            }
            (Some(IFACE), Some("Updated"))
                if header.path().is_some_and(|path| path.as_str() == PATH) =>
            {
                let Some(sender) = header.sender().map(|sender| sender.as_str()) else {
                    continue;
                };
                if current_owner.as_deref() != Some(sender) {
                    continue;
                }
                let packet: (u64, u64, String) =
                    message.body().deserialize().map_err(|e| e.to_string())?;
                if latest
                    .as_ref()
                    .is_some_and(|last| last.epoch != packet.0 || packet.1 <= last.revision)
                {
                    continue;
                }
                let Ok(next) = Snapshot::decode(sender.into(), packet) else {
                    continue;
                };
                latest = Some(next);
                if !emit(latest.clone()) {
                    break;
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub fn items<'a>(value: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    value[key].as_array().into_iter().flatten()
}

pub fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or_default()
}

/// Prefer the currently active profile, then a saved profile with the same
/// SSID and authentication family.
pub fn saved_ap<'a>(data: &'a Value, device: &Value, ap: &Value) -> Option<&'a Value> {
    let active = items(data, "active").find(|a| a["path"] == device["active"]);
    let saved = || {
        items(data, "profiles")
            .filter(|p| p["type"] == "802-11-wireless" && p["ssid"] == ap["ssid"])
    };
    active
        .and_then(|link| saved().find(|profile| profile["uuid"] == link["uuid"]))
        .or_else(|| {
            let secured = ap["flags"].as_u64().unwrap_or(0) & 1 != 0
                || ap["wpaFlags"].as_u64().unwrap_or(0) != 0
                || ap["rsnFlags"].as_u64().unwrap_or(0) != 0;
            saved()
                .find(|p| p["secured"] == secured && p["needsEnterprise"] == ap["needsEnterprise"])
        })
}

/// Keep the active AP for an SSID, otherwise the strongest. Identity is the
/// original byte array so different non-UTF-8 SSIDs never collapse together.
pub fn access_points(data: &Value) -> Vec<(&Value, &Value)> {
    let mut networks: BTreeMap<Vec<u8>, (&Value, &Value)> = BTreeMap::new();
    for device in items(data, "devices").filter(|d| d["kind"] == 2) {
        for ap in items(device, "accessPoints").filter(|ap| !text(ap, "label").is_empty()) {
            let Some(ssid) = ap["ssid"]
                .as_array()
                .and_then(|bytes| {
                    bytes
                        .iter()
                        .map(|byte| u8::try_from(byte.as_u64()?).ok())
                        .collect::<Option<Vec<_>>>()
                })
                .filter(|ssid| !ssid.is_empty())
            else {
                continue;
            };
            if networks
                .get(&ssid)
                .is_none_or(|(previous_device, previous)| {
                    device["activeAp"] == ap["path"]
                        || (previous_device["activeAp"] != previous["path"]
                            && previous["strength"].as_u64() < ap["strength"].as_u64())
                })
            {
                networks.insert(ssid, (device, ap));
            }
        }
    }
    let mut networks: Vec<_> = networks.into_values().collect();
    networks.sort_by_key(|(device, ap)| {
        (
            device["activeAp"] != ap["path"],
            Reverse(ap["strength"].as_u64().unwrap_or(0)),
            text(ap, "label"),
        )
    });
    networks
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn aps_keep_the_active_radio_and_saved_credentials_match_authentication() {
        let snapshot = json!({
            "devices": [{
              "kind": 2, "active": "/active", "activeAp": "/weak", "accessPoints": [
                {"ssid":[70], "label":"F", "path":"/weak", "strength":30, "flags":1, "needsEnterprise":true},
                {"ssid":[70], "label":"F", "path":"/strong", "strength":90, "flags":1, "needsEnterprise":true},
                {"ssid":[255], "label":"�", "path":"/raw1", "strength":65},
                {"ssid":[254], "label":"�", "path":"/raw2", "strength":60}
              ]
            }],
            "active": [{"path":"/active", "uuid":"active-enterprise"}],
            "profiles": [
                {"uuid":"open", "type":"802-11-wireless", "ssid":[70], "secured":false, "needsEnterprise":false},
                {"uuid":"enterprise", "type":"802-11-wireless", "ssid":[70], "secured":true, "needsEnterprise":true},
                {"uuid":"active-enterprise", "type":"802-11-wireless", "ssid":[70], "secured":true, "needsEnterprise":true}
            ]
        });
        let aps = access_points(&snapshot);
        assert_eq!(aps.len(), 3);
        let (device, ap) = aps[0];
        assert_eq!(ap["path"], "/weak");
        assert_eq!(
            saved_ap(&snapshot, device, ap).unwrap()["uuid"],
            "active-enterprise"
        );
        assert_eq!(
            saved_ap(&snapshot, &json!({"active":"/"}), ap).unwrap()["uuid"],
            "enterprise"
        );
    }

    #[test]
    fn network_snapshot_preserves_owner_epoch_and_revision_in_the_shared_reader() {
        let snapshot =
            Snapshot::decode(":1.5".into(), (7, 9, r#"{"schemaVersion":1}"#.into())).unwrap();
        assert_eq!((snapshot.epoch, snapshot.revision), (7, 9));
        let data = snapshot.with_identity();
        assert_eq!(data["_serviceOwner"], ":1.5");
        assert_eq!(data["_serviceEpoch"], 7);
        assert!(Snapshot::decode(":1.5".into(), (7, 10, r#"{"schemaVersion":2}"#.into())).is_err());
    }
}
