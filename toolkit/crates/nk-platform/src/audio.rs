// SPDX-License-Identifier: LGPL-3.0-or-later
//! The Audio1 graph shared by the shell and Settings.

use std::collections::HashMap;
use zbus::{
    MatchRule, Message,
    blocking::{Connection, MessageIterator},
    message::{Sequence, Type},
    zvariant::{OwnedObjectPath, OwnedValue},
};

pub const SERVICE: &str = "org.nidara.Session";
pub const PATH: &str = "/org/nidara/Audio";
pub const IFACE: &str = "org.nidara.Audio1";
const NODE: &str = "org.nidara.AudioNode1";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const MANAGER: &str = "org.freedesktop.DBus.ObjectManager";

type Properties = HashMap<String, OwnedValue>;
type Objects = HashMap<OwnedObjectPath, HashMap<String, Properties>>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub owner: String,
    pub generation: u64,
    pub available: bool,
    pub default_output: String,
    pub default_input: String,
    pub can_set_default: bool,
    pub nodes: Vec<Node>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub path: String,
    pub owner: String,
    pub name: String,
    pub kind: String,
    pub icon: String,
    pub volume_limit: f64,
    pub volume: f64,
    pub muted: bool,
    pub capabilities: Vec<String>,
}

impl Node {
    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|value| value == capability)
    }
}

/// Install these subscriptions before reading the snapshot. Object changes
/// invalidate the in-flight snapshot and name changes invalidate its identities.
fn changes() -> [MatchRule<'static>; 4] {
    let audio_signal = |interface, member| {
        MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(SERVICE)
            .unwrap()
            .interface(interface)
            .unwrap()
            .member(member)
            .unwrap()
            .path_namespace(PATH)
            .unwrap()
            .build()
    };
    [
        audio_signal(PROPERTIES, "PropertiesChanged"),
        audio_signal(MANAGER, "InterfacesAdded"),
        audio_signal(MANAGER, "InterfacesRemoved"),
        MatchRule::builder()
            .msg_type(Type::Signal)
            .sender("org.freedesktop.DBus")
            .unwrap()
            .interface("org.freedesktop.DBus")
            .unwrap()
            .member("NameOwnerChanged")
            .unwrap()
            .add_arg(SERVICE)
            .unwrap()
            .build(),
    ]
}

pub fn owner(conn: &Connection) -> Result<String, String> {
    conn.call_method(
        Some("org.freedesktop.DBus"),
        "/org/freedesktop/DBus",
        Some("org.freedesktop.DBus"),
        "GetNameOwner",
        &(SERVICE,),
    )
    .and_then(|reply| reply.body().deserialize())
    .map_err(|error| error.to_string())
}

fn text<'a>(properties: &'a Properties, key: &str) -> &'a str {
    properties
        .get(key)
        .and_then(|v| <&str>::try_from(v).ok())
        .unwrap_or("")
}

fn strings(properties: &Properties, key: &str) -> Vec<String> {
    properties
        .get(key)
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| v.try_into().ok())
        .unwrap_or_default()
}

fn object_path(properties: &Properties, key: &str) -> String {
    properties
        .get(key)
        .and_then(|v| <&zbus::zvariant::ObjectPath<'_>>::try_from(v).ok())
        .map_or_else(|| "/".into(), ToString::to_string)
}

/// The two hydrated maps have separate sequence markers. A sparse signal
/// received before a map's reply is already reflected in that map.
struct Graph {
    owner: String,
    root: Properties,
    objects: Objects,
    root_at: Sequence,
    objects_at: Sequence,
}

impl Graph {
    fn load(conn: &Connection) -> Result<Self, String> {
        let owner = owner(conn)?;
        let call = |interface, method, body: &_| {
            conn.call_method(Some(owner.as_str()), PATH, Some(interface), method, body)
                .map_err(|error| error.to_string())
        };
        let root = call(PROPERTIES, "GetAll", &(IFACE,))?;
        let objects = conn
            .call_method(
                Some(owner.as_str()),
                PATH,
                Some(MANAGER),
                "GetManagedObjects",
                &(),
            )
            .map_err(|error| error.to_string())?;
        Ok(Self {
            owner,
            root_at: root.recv_position(),
            objects_at: objects.recv_position(),
            root: root.body().deserialize().map_err(|e| e.to_string())?,
            objects: objects.body().deserialize().map_err(|e| e.to_string())?,
        })
    }

    fn apply(&mut self, message: &Message) -> Result<bool, zbus::Error> {
        let header = message.header();
        if header
            .sender()
            .is_none_or(|value| value.as_str() != self.owner)
        {
            return Ok(false);
        }
        let sequence = message.recv_position();
        let Some(path) = header.path() else {
            return Ok(false);
        };
        if path.as_str() != PATH
            && !path
                .as_str()
                .strip_prefix(PATH)
                .is_some_and(|rest| rest.starts_with('/'))
        {
            return Ok(false);
        }
        match (
            header.interface().map(|v| v.as_str()),
            header.member().map(|v| v.as_str()),
        ) {
            (Some(PROPERTIES), Some("PropertiesChanged")) => {
                let (iface, fields, invalidated): (String, Properties, Vec<String>) =
                    message.body().deserialize()?;
                let properties =
                    if iface == IFACE && path.as_str() == PATH && sequence > self.root_at {
                        &mut self.root
                    } else if sequence > self.objects_at {
                        let Some(properties) = self
                            .objects
                            .get_mut(path)
                            .and_then(|interfaces| interfaces.get_mut(&iface))
                        else {
                            return Ok(false);
                        };
                        properties
                    } else {
                        return Ok(false);
                    };
                properties.extend(fields);
                for field in invalidated {
                    properties.remove(&field);
                }
            }
            (Some(MANAGER), Some("InterfacesAdded")) if sequence > self.objects_at => {
                let (path, interfaces): (OwnedObjectPath, HashMap<String, Properties>) =
                    message.body().deserialize()?;
                self.objects.entry(path).or_default().extend(interfaces);
            }
            (Some(MANAGER), Some("InterfacesRemoved")) if sequence > self.objects_at => {
                let (path, removed): (OwnedObjectPath, Vec<String>) =
                    message.body().deserialize()?;
                if let Some(interfaces) = self.objects.get_mut(&path) {
                    for iface in removed {
                        interfaces.remove(&iface);
                    }
                    if interfaces.is_empty() {
                        self.objects.remove(&path);
                    }
                }
            }
            _ => return Ok(false),
        }
        Ok(true)
    }

    fn view(&self) -> Snapshot {
        let root = &self.root;
        let identity = &self.owner;
        let volume_limit = root
            .get("VolumeLimit")
            .and_then(|value| f64::try_from(value).ok())
            .filter(|value| value.is_finite())
            .map_or(1., |value| value.clamp(0., 1.5));
        let mut nodes: Vec<_> = self
            .objects
            .iter()
            .filter_map(|(path, interfaces)| {
                let properties = interfaces.get(NODE)?;
                let name = ["Description", "ApplicationName", "MediaName", "Name"]
                    .iter()
                    .map(|key| text(properties, key))
                    .find(|name| !name.is_empty())
                    .map_or_else(|| path.to_string(), str::to_owned);
                Some(Node {
                    path: path.to_string(),
                    owner: identity.clone(),
                    name,
                    kind: text(properties, "Kind").into(),
                    icon: text(properties, "IconName").into(),
                    volume_limit,
                    volume: properties
                        .get("Volume")
                        .and_then(|value| f64::try_from(value).ok())
                        .filter(|value| value.is_finite() && *value >= 0.)
                        .unwrap_or(0.),
                    muted: properties
                        .get("Muted")
                        .and_then(|value| bool::try_from(value).ok())
                        .unwrap_or(false),
                    capabilities: strings(properties, "Capabilities"),
                })
            })
            .collect();
        nodes.sort_by(|a, b| a.name.cmp(&b.name).then(a.path.cmp(&b.path)));
        Snapshot {
            generation: root
                .get("Generation")
                .and_then(|value| u64::try_from(value).ok())
                .unwrap_or(0),
            available: !matches!(
                text(root, "State"),
                "Unavailable" | "unavailable" | "connecting"
            ),
            default_output: object_path(root, "DefaultOutput"),
            default_input: object_path(root, "DefaultInput"),
            can_set_default: strings(root, "Capabilities")
                .iter()
                .any(|cap| cap == "defaults"),
            nodes,
            owner: identity.clone(),
        }
    }
}

pub fn snapshot(conn: &Connection) -> Result<Snapshot, String> {
    Graph::load(conn).map(|graph| graph.view())
}

/// A dedicated connection gives the caller ownership of the subscription
/// lifetime. The ordered receive queue exists before the initial snapshot.
pub fn watch(
    conn: &Connection,
    mut emit: impl FnMut(Option<Snapshot>) -> bool,
) -> Result<(), String> {
    let mut messages = MessageIterator::from(conn);
    let dbus = zbus::blocking::fdo::DBusProxy::new(conn).map_err(|e| e.to_string())?;
    for rule in changes() {
        dbus.add_match_rule(rule).map_err(|e| e.to_string())?;
    }
    let mut graph = Graph::load(conn).ok();
    let mut previous = graph.as_ref().map(Graph::view);
    if !emit(previous.clone()) {
        return Ok(());
    }
    for message in &mut messages {
        let message = message.map_err(|e| e.to_string())?;
        let header = message.header();
        if header.message_type() != Type::Signal {
            continue;
        }
        if header
            .interface()
            .is_some_and(|iface| iface.as_str() == "org.freedesktop.DBus")
            && header
                .member()
                .is_some_and(|member| member.as_str() == "NameOwnerChanged")
        {
            let (name, _, new): (String, String, String) =
                message.body().deserialize().map_err(|e| e.to_string())?;
            if name != SERVICE || graph.as_ref().is_some_and(|old| old.owner == new) {
                continue;
            }
            graph = Graph::load(conn).ok();
        } else if let Some(graph) = &mut graph {
            if !graph.apply(&message).map_err(|e| e.to_string())? {
                continue;
            }
        } else {
            graph = Graph::load(conn).ok();
        }
        let next = graph.as_ref().map(Graph::view);
        if previous != next {
            previous = next.clone();
            if !emit(next) {
                break;
            }
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub enum Command {
    Volume(f64),
    Muted(bool),
    Default,
}

impl Command {
    pub fn send(self, conn: &Connection, identity: &str, path: &str) -> Result<(), String> {
        if owner(conn)? != identity {
            return Err("Audio1 service changed".into());
        }
        let path = zbus::zvariant::ObjectPath::try_from(path).map_err(|error| error.to_string())?;
        let result = match self {
            Self::Volume(value) => conn.call_method(
                Some(identity),
                PATH,
                Some(IFACE),
                "SetVolume",
                &(path, value),
            ),
            Self::Muted(value) => conn.call_method(
                Some(identity),
                PATH,
                Some(IFACE),
                "SetMuted",
                &(path, value),
            ),
            Self::Default => {
                conn.call_method(Some(identity), PATH, Some(IFACE), "SetDefault", &(path,))
            }
        };
        result.map(|_| ()).map_err(|error| error.to_string())
    }
}
