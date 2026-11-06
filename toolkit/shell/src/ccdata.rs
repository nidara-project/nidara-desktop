// SPDX-License-Identifier: LGPL-3.0-or-later
//! Detail data read on the status workers, never on the surface's thread.
use std::{collections::HashMap, sync::Arc};
use zbus::{
    blocking::Connection,
    zvariant::{OwnedObjectPath, OwnedValue},
};

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Choice {
    pub path: String,
    pub owner: String,
    pub name: String,
    pub kind: String,
    pub bus: String,
    pub volume: f64,
    pub volume_limit: f64,
    pub muted: bool,
    pub capabilities: Vec<String>,
    pub track_revision: u64,
    pub length: i64,
    pub position: i64,
    pub anchor: u64,
    pub rate: f64,
    pub playing: bool,
    pub seek: bool,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Details {
    pub network: Option<Arc<serde_json::Value>>,
    pub brightness_owner: String,
    pub bluetooth: Option<Arc<serde_json::Value>>,
    pub audio: Arc<Vec<Choice>>,
    pub default_output: String,
    pub players: Arc<Vec<Choice>>,
    pub selected: String,
    pub pinned: String,
}

pub fn objects(
    conn: &Connection,
    owner: &str,
    path: &str,
    iface: &str,
) -> Result<Vec<Choice>, String> {
    type Objects = HashMap<OwnedObjectPath, HashMap<String, HashMap<String, OwnedValue>>>;
    let reply = conn
        .call_method(
            Some(owner),
            path,
            Some("org.freedesktop.DBus.ObjectManager"),
            "GetManagedObjects",
            &(),
        )
        .map_err(|e| e.to_string())?;
    let objects: Objects = reply.body().deserialize().map_err(|e| e.to_string())?;
    let mut out = vec![];
    for (path, interfaces) in objects {
        let Some(p) = interfaces.get(iface) else {
            continue;
        };
        let text = |key: &str| {
            p.get(key)
                .and_then(|v| <&str>::try_from(v).ok())
                .unwrap_or("")
                .to_owned()
        };
        let name = [
            "Description",
            "ApplicationName",
            "MediaName",
            "Identity",
            "Name",
        ]
        .into_iter()
        .map(text)
        .find(|s| !s.is_empty())
        .unwrap_or_else(|| path.to_string());
        let capabilities = p
            .get("Capabilities")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| Vec::<String>::try_from(v).ok())
            .unwrap_or_default();
        let anchor = p
            .get("PositionAnchor")
            .and_then(|v| v.try_clone().ok())
            .and_then(|v| <(i64, u64, f64)>::try_from(v).ok())
            .unwrap_or((0, 0, 0.));
        out.push(Choice {
            path: path.to_string(),
            owner: owner.to_owned(),
            name,
            kind: text("Kind"),
            bus: text("BusName"),
            volume_limit: 1.,
            volume: p
                .get("Volume")
                .and_then(|v| f64::try_from(v).ok())
                .filter(|v| v.is_finite() && *v >= 0.)
                .unwrap_or(0.),
            track_revision: p
                .get("TrackRevision")
                .and_then(|v| u64::try_from(v).ok())
                .unwrap_or(0),
            length: p
                .get("LengthUs")
                .and_then(|v| i64::try_from(v).ok())
                .unwrap_or(0),
            position: anchor.0,
            anchor: anchor.1,
            rate: if anchor.2.is_finite() { anchor.2 } else { 0. },
            playing: text("PlaybackStatus") == "Playing",
            seek: p
                .get("CanSeek")
                .and_then(|v| bool::try_from(v).ok())
                .unwrap_or(false)
                && p.get("PositionAvailable")
                    .and_then(|v| bool::try_from(v).ok())
                    .unwrap_or(false),
            muted: p
                .get("Muted")
                .and_then(|v| bool::try_from(v).ok())
                .unwrap_or(false),
            capabilities,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
    Ok(out)
}
