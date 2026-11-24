// SPDX-License-Identifier: LGPL-3.0-or-later
//! AppWindow client for Network1. The shell owns the agent's secret renderer.
mod ip;

use crate::exports::Exports;
use ip::{Editor, Form, Target};
use nk::{Activated, Node, Space, Type, TypeScale, Value, Weight};
use nk_platform::network::{self, IFACE, PATH, Snapshot, items, text as item_text};
use serde_json::Value as Json;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::mpsc::{self, Receiver, Sender},
    time::Duration,
};
use zbus::{
    blocking::{Connection, connection::Builder},
    zvariant::ObjectPath,
};

pub const PAGE: &str = "network";
const PREFIX: &str = "network:";
const WIFI: &str = "802-11-wireless";
const WIRED: &str = "802-3-ethernet";

#[derive(Default)]
pub struct Network {
    client: Option<Client>,
    snapshot: Option<Snapshot>,
    loaded: bool,
    pending: BTreeMap<&'static str, u64>,
    sequence: u64,
    error: Option<&'static str>,
    ip: Option<Editor>,
}

struct Client {
    conn: Connection,
    snapshots: Receiver<Option<Snapshot>>,
    replies: Receiver<Reply>,
    send: Sender<Reply>,
}

struct Reply {
    owner: String,
    epoch: u64,
    lane: &'static str,
    sequence: u64,
    result: Result<Option<Form>, String>,
}

impl Client {
    fn connect() -> Result<Self, String> {
        let conn = Builder::session()
            .and_then(|builder| builder.method_timeout(Duration::from_secs(150)).build())
            .map_err(|e| e.to_string())?;
        let (tx, snapshots) = mpsc::channel();
        let read = conn.clone();
        std::thread::spawn(move || {
            if network::watch(&read, |value| tx.send(value).is_ok()).is_err() {
                let _ = tx.send(None);
            }
        });
        let (send, replies) = mpsc::channel();
        Ok(Self {
            conn,
            snapshots,
            replies,
            send,
        })
    }

    fn call(&self, snapshot: &Snapshot, lane: &'static str, sequence: u64, operation: Call) {
        let conn = self.conn.clone();
        let send = self.send.clone();
        let owner = snapshot.owner.clone();
        let epoch = snapshot.epoch;
        std::thread::spawn(move || {
            let result = operation.send(&conn, &owner);
            let _ = send.send(Reply {
                owner,
                epoch,
                lane,
                sequence,
                result,
            });
        });
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.conn.clone().close();
    }
}

enum Call {
    Wifi(bool),
    Scan(String),
    Connect(String, String, String),
    Disconnect(String),
    Forget(String),
    Wired(String, bool),
    Activate(String, String),
    Deactivate(String),
    ReadIp(String),
    ApplyIp(String, String, String),
    Renew(String),
}

impl Call {
    fn send(self, conn: &Connection, owner: &str) -> Result<Option<Form>, String> {
        if network::owner(conn)? != owner {
            return Err("Network1 owner changed".into());
        }
        fn path(value: &str) -> Result<ObjectPath<'_>, String> {
            ObjectPath::try_from(value).map_err(|e| e.to_string())
        }
        let dest = Some(owner);
        let iface = Some(IFACE);
        let reply = match &self {
            Self::Wifi(on) => conn.call_method(dest, PATH, iface, "SetWifiEnabled", &(on,)),
            Self::Scan(device) => conn.call_method(dest, PATH, iface, "Scan", &(path(device)?,)),
            Self::Connect(device, ap, uuid) => conn.call_method(
                dest,
                PATH,
                iface,
                "ConnectDefault",
                &(path(device)?, path(ap)?, uuid),
            ),
            Self::Disconnect(device) => {
                conn.call_method(dest, PATH, iface, "Disconnect", &(path(device)?,))
            }
            Self::Forget(uuid) => conn.call_method(dest, PATH, iface, "Forget", &(uuid,)),
            Self::Wired(device, on) => {
                conn.call_method(dest, PATH, iface, "SetWiredEnabled", &(path(device)?, on))
            }
            Self::Activate(uuid, device) => {
                conn.call_method(dest, PATH, iface, "Activate", &(uuid, path(device)?))
            }
            Self::Deactivate(active) => {
                conn.call_method(dest, PATH, iface, "Deactivate", &(path(active)?,))
            }
            Self::ReadIp(uuid) => conn.call_method(dest, PATH, iface, "GetIp", &(uuid,)),
            Self::ApplyIp(uuid, device, form) => {
                conn.call_method(dest, PATH, iface, "ApplyIp", &(uuid, path(device)?, form))
            }
            Self::Renew(device) => conn.call_method(dest, PATH, iface, "Renew", &(path(device)?,)),
        }
        .map_err(|e| e.to_string())?;
        if matches!(self, Self::ReadIp(_)) {
            let form: String = reply.body().deserialize().map_err(|e| e.to_string())?;
            return serde_json::from_str(&form)
                .map(Some)
                .map_err(|e| e.to_string());
        }
        Ok(None)
    }
}

pub(super) struct ChoiceContext<'a>(&'a Snapshot);
impl ChoiceContext<'_> {
    fn action(&self, verb: &str, target: &str, extra: &str) -> String {
        format!(
            "{PREFIX}{}|{}|{verb}|{target}|{extra}",
            self.0.owner, self.0.epoch
        )
    }
}

fn by_path<'a>(data: &'a Json, key: &str, path: &str) -> Option<&'a Json> {
    items(data, key).find(|line| item_text(line, "path") == path)
}

fn profile<'a>(data: &'a Json, uuid: &str) -> Option<&'a Json> {
    items(data, "profiles").find(|p| item_text(p, "uuid") == uuid)
}

fn active_profile<'a>(data: &'a Json, device: &Json) -> Option<&'a Json> {
    by_path(data, "active", item_text(device, "active"))
        .and_then(|active| profile(data, item_text(active, "uuid")))
}

fn wired_target(data: &Json, device: &Json) -> Target {
    let interface = item_text(device, "interface");
    let saved = active_profile(data, device).or_else(|| {
        items(data, "profiles")
            .filter(|p| {
                p["type"] == WIRED
                    && (item_text(p, "interface").is_empty()
                        || item_text(p, "interface") == interface)
            })
            .max_by_key(|p| (p["interface"] == interface, p["autoconnect"] == true))
    });
    Target {
        device: item_text(device, "path").into(),
        uuid: saved.map_or("", |p| item_text(p, "uuid")).into(),
        name: saved.map_or(interface, |p| item_text(p, "name")).into(),
    }
}

fn ip_live<'a>(data: &'a Json, target: &Target) -> Option<&'a Json> {
    let device = by_path(data, "devices", &target.device)?;
    let active = by_path(data, "active", item_text(device, "active"))?;
    (device["state"] == 100 && active["uuid"] == target.uuid).then_some(device)
}

impl Network {
    pub fn visit(&mut self) {
        match Client::connect() {
            Ok(client) => self.client = Some(client),
            Err(error) => {
                self.loaded = true;
                eprintln!("nidara-settings-view: Network1 subscription failed: {error}");
            }
        }
    }

    pub fn poll(&mut self) -> bool {
        let Some(client) = &self.client else {
            return false;
        };
        let mut changed = false;
        if let Some(snapshot) = client.snapshots.try_iter().last() {
            self.loaded = true;
            if self
                .snapshot
                .as_ref()
                .zip(snapshot.as_ref())
                .is_none_or(|(a, b)| a.owner != b.owner || a.epoch != b.epoch)
                || snapshot
                    .as_ref()
                    .is_none_or(|value| value.data["available"] != true)
            {
                self.pending.clear();
                self.ip = None;
                self.error = None;
            }
            self.snapshot = snapshot;
            if let (Some(ip), Some(snapshot)) = (&self.ip, &self.snapshot)
                && (ip.target.uuid.is_empty()
                    && by_path(&snapshot.data, "devices", &ip.target.device).is_none()
                    || !ip.target.uuid.is_empty()
                        && profile(&snapshot.data, &ip.target.uuid).is_none())
            {
                self.ip = None;
            }
            changed = true;
        }
        let replies: Vec<_> = client.replies.try_iter().collect();
        for reply in replies {
            if self
                .snapshot
                .as_ref()
                .is_none_or(|s| s.owner != reply.owner || s.epoch != reply.epoch)
            {
                continue;
            }
            if self.pending.get(reply.lane) != Some(&reply.sequence) {
                continue;
            }
            self.pending.remove(reply.lane);
            if reply.lane == "ip" {
                if let Some(ip) = &mut self.ip {
                    ip.busy = false;
                    match reply.result {
                        Ok(Some(form)) => {
                            ip.saved = Some(form.clone());
                            ip.draft = Some(form);
                            ip.failed = false;
                        }
                        Ok(None) => {
                            ip.failed = false;
                            if ip.target.uuid.is_empty() {
                                // The new profile is selected from the next snapshot.
                                self.ip = None;
                            } else {
                                self.reload_ip();
                            }
                        }
                        Err(_) => ip.failed = true,
                    }
                }
            } else {
                self.error = reply.result.err().and_then(|error| {
                    if error.contains("Cancelled") {
                        return None;
                    }
                    Some(if error.contains("NeedsProfile") {
                        "settings.network.native.needs-profile"
                    } else if error.contains("NeedsSecrets") {
                        "settings.network.native.needs-password"
                    } else {
                        "settings.network.native.error"
                    })
                });
            }
            changed = true;
        }
        changed
    }

    fn request(&mut self, lane: &'static str, call: Call) -> bool {
        if let (Some(snapshot), Some(client)) = (&self.snapshot, &self.client)
            && !self.pending.contains_key(lane)
        {
            self.sequence += 1;
            self.pending.insert(lane, self.sequence);
            self.error = None;
            client.call(snapshot, lane, self.sequence, call);
            true
        } else {
            false
        }
    }

    fn reload_ip(&mut self) {
        if let Some(uuid) = self.ip.as_ref().map(|ip| ip.target.uuid.clone())
            && self.request("ip", Call::ReadIp(uuid))
            && let Some(ip) = &mut self.ip
        {
            ip.busy = true;
            ip.failed = false;
        }
    }

    pub fn activate(&mut self, activated: &Activated) -> bool {
        let Some(action) = activated.action.strip_prefix(PREFIX) else {
            return false;
        };
        let Some(snapshot) = self
            .snapshot
            .as_ref()
            .filter(|snapshot| snapshot.data["available"] == true)
        else {
            return true;
        };
        let mut fields = action.split('|');
        let [
            Some(owner),
            Some(epoch),
            Some(verb),
            Some(target),
            Some(extra),
        ] = std::array::from_fn(|_| fields.next())
        else {
            return true;
        };
        if fields.next().is_some()
            || owner != snapshot.owner
            || epoch.parse::<u64>() != Ok(snapshot.epoch)
        {
            return true;
        }
        let data = &snapshot.data;
        let device = by_path(data, "devices", target);
        let selected_profile = profile(data, target);
        if let Some(ip) = &mut self.ip {
            match verb {
                "ip-back" if !ip.busy => self.ip = None,
                "ip-edit" => {
                    let live = ip_live(data, &ip.target);
                    ip.input(target, activated.value.as_ref(), live);
                }
                "ip-revert" => self.reload_ip(),
                "ip-apply" if !ip.busy && ip.dirty() => {
                    if let Some(form) = ip.draft.as_ref().filter(|form| form.valid())
                        && let Ok(form) = serde_json::to_string(form)
                    {
                        let device =
                            if ip.target.uuid.is_empty() || ip_live(data, &ip.target).is_some() {
                                ip.target.device.clone()
                            } else {
                                "/".into()
                            };
                        let uuid = ip.target.uuid.clone();
                        let busy = self.request("ip", Call::ApplyIp(uuid, device, form));
                        if let Some(ip) = &mut self.ip {
                            ip.busy = busy;
                        }
                    }
                }
                "ip-renew" if !ip.busy && ip_live(data, &ip.target).is_some() => {
                    let device = ip.target.device.clone();
                    self.request("renew", Call::Renew(device));
                }
                _ => {}
            }
            return true;
        }
        let command = match (verb, &activated.value) {
            ("wifi", Some(Value::Bool(on))) => Some(("radio", Call::Wifi(*on))),
            ("scan", _) => device
                .filter(|d| d["kind"] == 2)
                .map(|_| ("scan", Call::Scan(target.into()))),
            ("wired", Some(Value::Bool(on))) => device
                .filter(|d| d["kind"] == 1)
                .map(|_| ("wired", Call::Wired(target.into(), *on))),
            ("connect", _) => device.filter(|d| d["kind"] == 2).and_then(|device| {
                let ap = by_path(device, "accessPoints", extra)?;
                let saved = network::saved_ap(data, device, ap);
                if ap["needsEnterprise"] == true && saved.is_none() {
                    self.error = Some("settings.network.native.needs-profile");
                    return None;
                }
                Some((
                    "connect",
                    Call::Connect(
                        target.into(),
                        extra.into(),
                        saved.map_or("", |p| item_text(p, "uuid")).into(),
                    ),
                ))
            }),
            ("disconnect", _) => device.map(|_| ("disconnect", Call::Disconnect(target.into()))),
            ("forget", _) => selected_profile
                .filter(|p| {
                    p["type"] == WIFI && !items(data, "active").any(|a| a["uuid"] == target)
                })
                .map(|_| ("forget", Call::Forget(target.into()))),
            ("activate", _) => {
                selected_profile.map(|_| ("connect", Call::Activate(target.into(), "/".into())))
            }
            ("deactivate", _) => by_path(data, "active", target)
                .map(|_| ("disconnect", Call::Deactivate(target.into()))),
            ("ip-wired" | "ip-wifi", _) => {
                let ip_target = match verb {
                    "ip-wired" => device
                        .filter(|d| d["kind"] == 1)
                        .map(|device| wired_target(data, device)),
                    _ => selected_profile
                        .filter(|p| p["type"] == WIFI)
                        .map(|p| Target {
                            uuid: target.into(),
                            device: extra.into(),
                            name: item_text(p, "name").into(),
                        }),
                };
                if let Some(target) = ip_target {
                    self.ip = Some(Editor {
                        target,
                        saved: None,
                        draft: None,
                        busy: false,
                        failed: false,
                    });
                    self.reload_ip();
                }
                None
            }
            _ => None,
        };
        if let Some((lane, command)) = command {
            self.request(lane, command);
        }
        true
    }

    pub fn rows(&self, types: &TypeScale, e: &Exports) -> Result<Vec<Node>, String> {
        let Some(snapshot) = self
            .snapshot
            .as_ref()
            .filter(|s| s.data["available"] == true)
        else {
            return Ok(vec![label(
                "network/status",
                if self.loaded {
                    "settings.network.error.no-service"
                } else {
                    "settings.native.loading"
                },
                types,
                e,
            )?]);
        };
        let data = &snapshot.data;
        let cx = ChoiceContext(snapshot);
        if let Some(editor) = &self.ip {
            return editor.rows(&cx, types, e, ip_live(data, &editor.target));
        }
        let mut rows = Vec::new();
        if let Some(error) = self.error {
            rows.push(label("network/error", error, types, e)?);
        }
        self.wifi_rows(&mut rows, &cx, types, e)?;
        self.wired_rows(&mut rows, &cx, types, e)?;
        self.vpn_rows(&mut rows, &cx, types, e)?;
        Ok(rows)
    }
}

fn label(key: &str, text: &str, types: &TypeScale, e: &Exports) -> Result<Node, String> {
    Ok(nk::Label::new(key, e.text(text)?, types.style(Type::Body, Weight::Regular)).into())
}

fn button(
    key: &str,
    title: &str,
    action: String,
    enabled: bool,
    types: &TypeScale,
    e: &Exports,
) -> Result<Node, String> {
    Ok(nk::Button::new(
        key,
        e.text(title)?,
        action,
        types.style(Type::Body, Weight::Regular),
    )
    .enabled(enabled)
    .into())
}

fn group(
    rows: &mut Vec<Node>,
    key: &str,
    title: &str,
    body: Vec<Node>,
    types: &TypeScale,
    e: &Exports,
) -> Result<(), String> {
    if !body.is_empty() {
        rows.push(
            nk::Label::new(
                format!("{key}/title"),
                e.text(title)?,
                types.style(Type::Body, Weight::Medium),
            )
            .into(),
        );
        rows.push(nk::Group::new(key, nk::Column::new(format!("{key}/rows"), body)).into());
    }
    Ok(())
}

fn row(key: &str, title: &str, details: &str, controls: Vec<Node>, types: &TypeScale) -> Node {
    let body = types.style(Type::Body, Weight::Regular);
    let mut row = nk::ListRow::new(key, title, body);
    if !details.is_empty() {
        row = row.subtitle(details, types.style(Type::Small, Weight::Regular));
    }
    if !controls.is_empty() {
        row = row.trailing(nk::Row::new(format!("{key}/actions"), controls).gap(Space::S2));
    }
    row.into()
}

fn security_key(ap: &Json) -> Option<&'static str> {
    let flags = ap["flags"].as_u64().unwrap_or(0);
    let wpa = ap["wpaFlags"].as_u64().unwrap_or(0);
    let rsn = ap["rsnFlags"].as_u64().unwrap_or(0);
    if ap["needsEnterprise"] == true {
        Some("settings.network.security.enterprise")
    } else if flags & 1 == 0 && wpa == 0 && rsn == 0 {
        Some("settings.network.security.open")
    } else {
        None
    }
}

fn security(ap: &Json, e: &Exports) -> Result<String, String> {
    if let Some(key) = security_key(ap) {
        return e.text(key).map(str::to_owned);
    }
    let wpa = ap["wpaFlags"].as_u64().unwrap_or(0);
    let rsn = ap["rsnFlags"].as_u64().unwrap_or(0);
    let alternatives: Vec<_> = [(rsn & 0x400 != 0, "WPA3"), (rsn & 0x800 != 0, "OWE")]
        .into_iter()
        .filter_map(|(present, label)| present.then_some(label))
        .collect();
    Ok(if alternatives.is_empty() {
        if rsn != 0 {
            "WPA2"
        } else if wpa != 0 {
            "WPA"
        } else {
            "WEP"
        }
        .into()
    } else {
        alternatives.join(" / ")
    })
}

impl Network {
    fn wifi_rows(
        &self,
        rows: &mut Vec<Node>,
        cx: &ChoiceContext<'_>,
        types: &TypeScale,
        e: &Exports,
    ) -> Result<(), String> {
        let data = &cx.0.data;
        let mut adapters = items(data, "devices").filter(|d| d["kind"] == 2).peekable();
        if adapters.peek().is_none() {
            rows.push(label(
                "network/no-wifi",
                "settings.network.error.no-wifi-hw",
                types,
                e,
            )?);
            return Ok(());
        }
        let enabled = data["wirelessEnabled"] == true;
        let title = e.text("settings.network.enable-wifi")?;
        let controls = vec![
            nk::Switch::new(
                "network/wifi/power",
                title,
                cx.action("wifi", "", ""),
                enabled,
            )
            .enabled(data["wirelessHardwareEnabled"] == true && !self.pending.contains_key("radio"))
            .into(),
        ];
        let mut wireless = vec![row("network/wifi/power-row", title, "", controls, types)];
        if enabled {
            for device in adapters {
                let path = item_text(device, "path");
                wireless.push(row(
                    &format!("network/wifi/{path}"),
                    item_text(device, "interface"),
                    network::wifi_name(data).as_str(),
                    vec![button(
                        &format!("network/wifi/{path}/scan"),
                        "settings.network.ap.scan",
                        cx.action("scan", path, ""),
                        !self.pending.contains_key("scan"),
                        types,
                        e,
                    )?],
                    types,
                ));
            }
        }
        group(
            rows,
            "network/wifi",
            "settings.network.group.wi-fi",
            wireless,
            types,
            e,
        )?;
        if !enabled {
            return Ok(());
        }

        let mut nearby = Vec::new();
        let mut shown = BTreeSet::new();
        for (device, ap) in network::access_points(data).into_iter().take(128) {
            let path = item_text(device, "path");
            let ap_path = item_text(ap, "path");
            let key = format!("network/ap/{ap_path}");
            let ssid = item_text(ap, "label");
            let current = device["activeAp"] == ap["path"];
            let active = current && device["state"] == 100;
            let connecting = current && (40..100).contains(&device["state"].as_u64().unwrap_or(0));
            let saved = network::saved_ap(data, device, ap);
            let mut controls = Vec::new();
            if let Some(saved) = saved {
                let uuid = item_text(saved, "uuid");
                shown.insert(uuid);
                controls.push(button(
                    &format!("{key}/settings"),
                    "settings.network.ap.details",
                    cx.action("ip-wifi", uuid, path),
                    !self.pending.contains_key("ip"),
                    types,
                    e,
                )?);
                if !current {
                    controls.push(button(
                        &format!("{key}/forget"),
                        "settings.network.ap.forget",
                        cx.action("forget", uuid, ""),
                        !self.pending.contains_key("forget"),
                        types,
                        e,
                    )?);
                }
            }
            if active || connecting {
                controls.push(button(
                    &format!("{key}/join"),
                    "settings.network.ap.disconnect",
                    cx.action("disconnect", path, ""),
                    !self.pending.contains_key("disconnect"),
                    types,
                    e,
                )?);
            } else {
                controls.push(button(
                    &format!("{key}/join"),
                    "settings.network.ap.connect",
                    cx.action("connect", path, ap_path),
                    !self.pending.contains_key("connect"),
                    types,
                    e,
                )?);
            }
            let strength = ap["strength"].as_u64().unwrap_or(0).min(100);
            let frequency = ap["frequency"].as_u64().unwrap_or(0);
            let state = if active {
                Some("settings.network.status.connected")
            } else if connecting {
                Some("settings.network.ap.connecting")
            } else {
                None
            };
            let mut detail = format!("{strength}% · {frequency} MHz · {}", security(ap, e)?);
            if let Some(state) = state {
                detail.push_str(&format!(" · {}", e.text(state)?));
            }
            nearby.push(row(&key, ssid, &detail, controls, types));
        }
        if nearby.is_empty() {
            nearby.push(label(
                "network/ap/empty",
                "settings.network.ap.empty",
                types,
                e,
            )?);
        }
        group(
            rows,
            "network/ap",
            "settings.network.group.access-points",
            nearby,
            types,
            e,
        )?;

        let mut saved = Vec::new();
        for p in items(data, "profiles").filter(|p| p["type"] == WIFI) {
            let uuid = item_text(p, "uuid");
            if shown.contains(uuid) {
                continue;
            }
            let key = format!("network/saved/{uuid}");
            let active = items(data, "active").find(|a| a["uuid"] == uuid);
            let device = active.and_then(|a| a["devices"][0].as_str()).unwrap_or("/");
            let mut controls = vec![button(
                &format!("{key}/settings"),
                "settings.network.ap.details",
                cx.action("ip-wifi", uuid, device),
                !self.pending.contains_key("ip"),
                types,
                e,
            )?];
            if let Some(active) = active {
                controls.push(button(
                    &format!("{key}/disconnect"),
                    "settings.network.ap.disconnect",
                    cx.action("deactivate", item_text(active, "path"), ""),
                    !self.pending.contains_key("disconnect"),
                    types,
                    e,
                )?);
            } else {
                controls.push(button(
                    &format!("{key}/connect"),
                    "settings.network.ap.connect",
                    cx.action("activate", uuid, ""),
                    !self.pending.contains_key("connect"),
                    types,
                    e,
                )?);
                controls.push(button(
                    &format!("{key}/forget"),
                    "settings.network.ap.forget",
                    cx.action("forget", uuid, ""),
                    !self.pending.contains_key("forget"),
                    types,
                    e,
                )?);
            }
            saved.push(row(&key, item_text(p, "name"), "", controls, types));
        }
        group(
            rows,
            "network/saved",
            "settings.network.native.saved",
            saved,
            types,
            e,
        )
    }

    fn wired_rows(
        &self,
        rows: &mut Vec<Node>,
        cx: &ChoiceContext<'_>,
        types: &TypeScale,
        e: &Exports,
    ) -> Result<(), String> {
        let mut wired = Vec::new();
        for device in items(&cx.0.data, "devices").filter(|d| d["kind"] == 1) {
            let path = item_text(device, "path");
            let key = format!("network/wired/{path}");
            let enabled = device["wiredEnabled"] == true;
            let state = if device["state"] == 100 {
                "settings.network.status.connected"
            } else if device["carrier"] == true {
                "settings.network.status.disconnected"
            } else {
                "settings.network.status.disconnected-hw"
            };
            let address = item_text(&device["ip4"]["addresses"][0], "address");
            let details = if address.is_empty() {
                e.text(state)?.into()
            } else {
                format!("{} · {address}", e.text(state)?)
            };
            wired.push(row(
                &key,
                item_text(device, "interface"),
                &details,
                vec![
                    nk::Switch::new(
                        format!("{key}/enable"),
                        e.text("settings.network.ethernet")?,
                        cx.action("wired", path, ""),
                        enabled,
                    )
                    .enabled(!self.pending.contains_key("wired"))
                    .into(),
                    button(
                        &format!("{key}/ip"),
                        "settings.network.ethernet.details",
                        cx.action("ip-wired", path, ""),
                        !self.pending.contains_key("ip"),
                        types,
                        e,
                    )?,
                ],
                types,
            ));
        }
        group(
            rows,
            "network/wired",
            "settings.network.group.ethernet",
            wired,
            types,
            e,
        )
    }

    fn vpn_rows(
        &self,
        rows: &mut Vec<Node>,
        cx: &ChoiceContext<'_>,
        types: &TypeScale,
        e: &Exports,
    ) -> Result<(), String> {
        let data = &cx.0.data;
        let mut vpn = Vec::new();
        for profile in items(data, "profiles")
            .filter(|p| matches!(p["type"].as_str(), Some("vpn" | "wireguard")))
        {
            let uuid = item_text(profile, "uuid");
            let key = format!("network/vpn/{uuid}");
            let active = items(data, "active").find(|line| line["uuid"] == uuid);
            let (title, action, free) = if let Some(active) = active {
                (
                    "settings.network.vpn.btn.disconnect",
                    cx.action("deactivate", item_text(active, "path"), ""),
                    !self.pending.contains_key("disconnect"),
                )
            } else {
                (
                    "settings.network.vpn.btn.connect",
                    cx.action("activate", uuid, ""),
                    !self.pending.contains_key("connect"),
                )
            };
            vpn.push(row(
                &key,
                item_text(profile, "name"),
                "",
                vec![button(
                    &format!("{key}/action"),
                    title,
                    action,
                    free,
                    types,
                    e,
                )?],
                types,
            ));
        }
        group(
            rows,
            "network/vpn",
            "settings.network.group.vpn",
            vpn,
            types,
            e,
        )
    }
}
