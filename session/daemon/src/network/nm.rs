// SPDX-License-Identifier: GPL-3.0-or-later
//! NetworkManager's wire API. All calls pin its UNIQUE owner; no subprocesses.
use super::{Error, Settings};
use serde::de::DeserializeOwned;
use serde_json::{Value as Json, json};
use std::{collections::HashMap, time::Duration};
use zbus::{
    Connection,
    zvariant::{DynamicType, OwnedObjectPath as Path, OwnedValue, Type, Value},
};
pub const NAME: &str = "org.freedesktop.NetworkManager";
pub const ROOT: &str = "/org/freedesktop/NetworkManager";
pub const DEVICE: &str = "org.freedesktop.NetworkManager.Device";
pub const WIFI: &str = "org.freedesktop.NetworkManager.Device.Wireless";
pub const PROFILE: &str = "org.freedesktop.NetworkManager.Settings.Connection";
pub const ACTIVE: &str = "org.freedesktop.NetworkManager.Connection.Active";
pub const SETTINGS: &str = "/org/freedesktop/NetworkManager/Settings";
pub type Props = HashMap<String, OwnedValue>;
#[derive(Clone)]
pub struct Nm {
    pub bus: Connection,
    pub owner: String,
}
impl Nm {
    pub async fn current(bus: &Connection) -> Result<Self, Error> {
        let owner = zbus::fdo::DBusProxy::new(bus)
            .await?
            .get_name_owner(NAME.try_into().unwrap())
            .await
            .map_err(|_| Error::Unavailable("NetworkManager is unavailable".into()))?
            .to_string();
        Ok(Self {
            bus: bus.clone(),
            owner,
        })
    }
    pub async fn call<R: DeserializeOwned + Type>(
        &self,
        path: &str,
        iface: &str,
        method: &str,
        body: &(impl serde::Serialize + DynamicType),
    ) -> Result<R, Error> {
        self.call_timeout(path, iface, method, body, Duration::from_secs(10))
            .await
    }
    pub async fn call_timeout<R: DeserializeOwned + Type>(
        &self,
        path: &str,
        iface: &str,
        method: &str,
        body: &(impl serde::Serialize + DynamicType),
        duration: Duration,
    ) -> Result<R, Error> {
        tokio::time::timeout(duration, async {
            self.bus
                .call_method(Some(self.owner.as_str()), path, Some(iface), method, body)
                .await?
                .body()
                .deserialize()
        })
        .await
        .map_err(|_| Error::Failed("NetworkManager call timed out".into()))?
        .map_err(|e| match &e {
            zbus::Error::MethodError(name, _, _)
                if name.as_str().ends_with("PermissionDenied")
                    || name.as_str().ends_with("AccessDenied")
                    || name.as_str().ends_with("NotAuthorized") =>
            {
                Error::Denied("NetworkManager denied permission for this operation".into())
            }
            zbus::Error::MethodError(name, _, _) if name.as_str().contains("VersionId") => {
                Error::Conflict("NetworkManager profile version changed".into())
            }
            _ => Error::ZBus(e),
        })
    }
    pub async fn props(&self, path: &str, iface: &str) -> Result<Props, Error> {
        self.call(path, "org.freedesktop.DBus.Properties", "GetAll", &(iface,))
            .await
    }
    pub async fn set(
        &self,
        path: &str,
        iface: &str,
        key: &str,
        value: Value<'_>,
    ) -> Result<(), Error> {
        self.call(
            path,
            "org.freedesktop.DBus.Properties",
            "Set",
            &(iface, key, value),
        )
        .await
    }
    pub async fn devices(&self) -> Result<Vec<Path>, Error> {
        self.call(ROOT, NAME, "GetDevices", &()).await
    }
    pub async fn profiles(&self) -> Result<Vec<(Path, Settings)>, Error> {
        let paths: Vec<Path> = self
            .call(
                SETTINGS,
                "org.freedesktop.NetworkManager.Settings",
                "ListConnections",
                &(),
            )
            .await?;
        let mut out = Vec::new();
        for path in paths {
            match self.call(path.as_str(), PROFILE, "GetSettings", &()).await {
                Ok(s) => out.push((path, s)),
                Err(Error::ZBus(zbus::Error::MethodError(ref name, _, _)))
                    if name.as_str().ends_with("UnknownObject") => {}
                Err(e) => return Err(e),
            }
        }
        Ok(out)
    }
    pub async fn profile(&self, uuid: &str) -> Result<(Path, Settings), Error> {
        self.profiles()
            .await?
            .into_iter()
            .find(|(_, s)| text(s.get("connection"), "uuid") == uuid)
            .ok_or_else(|| Error::Invalid("unknown profile UUID".into()))
    }
    pub async fn update(&self, path: &Path, settings: &Settings) -> Result<(), Error> {
        self.call(path, PROFILE, "Update", &(settings,)).await
    }
    pub async fn activate(
        &self,
        profile: &Path,
        device: &Path,
        specific: &Path,
    ) -> Result<Path, Error> {
        self.call(
            ROOT,
            NAME,
            "ActivateConnection",
            &(profile, device, specific),
        )
        .await
    }
    pub async fn wait_active(&self, active: &Path) -> Result<(), Error> {
        let end = tokio::time::Instant::now() + Duration::from_secs(150);
        loop {
            let p = self.props(active, ACTIVE).await?;
            match number(Some(&p), "State") {
                2 => return Ok(()),
                4 => return Err(Error::Failed("activation failed".into())),
                _ => {}
            }
            if tokio::time::Instant::now() >= end {
                return Err(Error::Failed("activation timed out".into()));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
    pub async fn snapshot(&self) -> Result<Json, Error> {
        let root = self.props(ROOT, NAME).await?;
        let profiles = self.profiles().await?;
        let mut devices = Vec::new();
        for path in self.devices().await? {
            let p = self.props(&path, DEVICE).await?;
            let kind = number(Some(&p), "DeviceType");
            let mut d = json!({"path": path.as_str(), "kind":kind, "interface":text(Some(&p),"Interface"), "state":number(Some(&p),"State"), "stateReason": json_prop(&p,"StateReason"), "autoconnect":boolean(Some(&p),"Autoconnect",true), "active":text(Some(&p),"ActiveConnection"), "ip4":{}, "ip6":{}});
            for (key, iface, target) in [
                (
                    "Ip4Config",
                    "org.freedesktop.NetworkManager.IP4Config",
                    "ip4",
                ),
                (
                    "Ip6Config",
                    "org.freedesktop.NetworkManager.IP6Config",
                    "ip6",
                ),
            ] {
                let ip = text(Some(&p), key);
                if !ip.is_empty() && ip != "/" {
                    let p = self.props(&ip, iface).await?;
                    d[target] = json!({"addresses":json_prop(&p,"AddressData"),"gateway":text(Some(&p),"Gateway"),"nameservers":dns_live(&p, target == "ip6"),"domains":json_prop(&p,"Domains")});
                }
            }
            if kind == 2 {
                let w = self.props(&path, WIFI).await?;
                d["activeAp"] = json!(text(Some(&w), "ActiveAccessPoint"));
                d["bitrate"] = json!(number(Some(&w), "Bitrate"));
                d["lastScan"] = json_prop(&w, "LastScan");
                let aps: Vec<Path> = self.call(&path, WIFI, "GetAllAccessPoints", &()).await?;
                let mut rows = Vec::new();
                for ap in aps {
                    let p = self
                        .props(&ap, "org.freedesktop.NetworkManager.AccessPoint")
                        .await?;
                    let ssid = bytes(Some(&p), "Ssid");
                    let wpa = number(Some(&p), "WpaFlags");
                    let rsn = number(Some(&p), "RsnFlags");
                    rows.push(json!({"path":ap.as_str(),"ssid":ssid,"label":String::from_utf8_lossy(&ssid),"strength":number(Some(&p),"Strength"),"frequency":number(Some(&p),"Frequency"),"flags":number(Some(&p),"Flags"),"wpaFlags":wpa,"rsnFlags":rsn,"needsEnterprise":(wpa|rsn)&0x200!=0,"bssid":text(Some(&p),"HwAddress")}));
                }
                rows.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
                d["accessPoints"] = json!(rows);
            } else if kind == 1 {
                let p = self
                    .props(&path, "org.freedesktop.NetworkManager.Device.Wired")
                    .await?;
                d["carrier"] = json!(boolean(Some(&p), "Carrier", false));
                d["speed"] = json!(number(Some(&p), "Speed"));
                d["wiredEnabled"] = json!(self.wired_enabled(&path, &profiles).await?);
            }
            devices.push(d);
        }
        devices.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        let mut saved: Vec<Json> = profiles.iter().map(|(path,s)| {
            let w = s.get("802-11-wireless"); let conn = s.get("connection");
            json!({"path":path.as_str(),"uuid":text(conn,"uuid"),"name":text(conn,"id"),"type":text(conn,"type"),"interface":text(conn,"interface-name"),"autoconnect":boolean(conn,"autoconnect",true),"ssid":bytes(w,"ssid"),"hidden":boolean(w,"hidden",false),"secured":s.contains_key("802-11-wireless-security"),"needsEnterprise":s.contains_key("802-1x")})
        }).collect();
        for (row, (_, settings)) in saved.iter_mut().zip(&profiles) {
            let metadata = super::storage::metadata(settings);
            for key in ["secretStorage", "permissions", "allUsers"] {
                row[key] = metadata[key].clone();
            }
        }
        saved.sort_by(|a, b| a["uuid"].as_str().cmp(&b["uuid"].as_str()));
        let active_paths: Vec<Path> = root
            .get("ActiveConnections")
            .and_then(|v| Vec::<Path>::try_from(v.try_clone().ok()?).ok())
            .unwrap_or_default();
        let mut active = Vec::new();
        for path in active_paths {
            let p = self.props(&path, ACTIVE).await?;
            active.push(json!({"path":path.as_str(),"uuid":text(Some(&p),"Uuid"),"type":text(Some(&p),"Type"),"state":number(Some(&p),"State"),"vpn":boolean(Some(&p),"Vpn",false),"default":boolean(Some(&p),"Default",false),"devices":json_prop(&p,"Devices")}));
        }
        active.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        Ok(
            json!({"schemaVersion":1,"available":true,"state":number(Some(&root),"State"),"connectivity":number(Some(&root),"Connectivity"),"wirelessEnabled":boolean(Some(&root),"WirelessEnabled",false),"wirelessHardwareEnabled":boolean(Some(&root),"WirelessHardwareEnabled",false),"devices":devices,"profiles":saved,"active":active}),
        )
    }
    async fn compatible_wired(
        &self,
        device: &Path,
        profiles: &[(Path, Settings)],
    ) -> Result<Vec<(Path, Settings)>, Error> {
        let p = self.props(device, DEVICE).await?;
        if number(Some(&p), "DeviceType") != 1 {
            return Err(Error::Invalid("not an Ethernet device".into()));
        }
        // AvailableConnections is availability, not compatibility: with no carrier or
        // autoconnect disabled NM may omit a profile that our switch must restore.
        let iface = text(Some(&p), "Interface");
        let wired = self
            .props(device, "org.freedesktop.NetworkManager.Device.Wired")
            .await?;
        let mac = text(Some(&wired), "PermHwAddress");
        let mac = if mac.is_empty() {
            text(Some(&wired), "HwAddress")
        } else {
            mac
        };
        let mut out: Vec<_> = profiles
            .iter()
            .filter(|(_, s)| {
                let c = s.get("connection");
                let bound = text(c, "interface-name");
                if text(c, "type") != "802-3-ethernet" || !bound.is_empty() && bound != iface {
                    return false;
                }
                let setting = s.get("802-3-ethernet");
                let bound = bytes(setting, "mac-address");
                let mac_bytes: Vec<u8> = mac
                    .split(':')
                    .filter_map(|b| u8::from_str_radix(b, 16).ok())
                    .collect();
                if !bound.is_empty() && bound != mac_bytes {
                    return false;
                }
                let blocked: Vec<String> = setting
                    .and_then(|p| p.get("mac-address-blacklist"))
                    .and_then(|v| Vec::try_from(v.try_clone().ok()?).ok())
                    .unwrap_or_default();
                !blocked.iter().any(|b| b.eq_ignore_ascii_case(&mac))
            })
            .cloned()
            .collect();
        out.sort_by_key(|(_, s)| std::cmp::Reverse(number(s.get("connection"), "timestamp")));
        Ok(out)
    }
    async fn wired_enabled(
        &self,
        device: &Path,
        profiles: &[(Path, Settings)],
    ) -> Result<bool, Error> {
        let p = self.props(device, DEVICE).await?;
        let active = text(Some(&p), "ActiveConnection");
        if !active.is_empty() && active != "/" {
            return Ok(true);
        }
        if !boolean(Some(&p), "Autoconnect", true) {
            return Ok(false);
        }
        let profiles = self.compatible_wired(device, profiles).await?;
        Ok(profiles.is_empty()
            || profiles
                .iter()
                .any(|(_, s)| boolean(s.get("connection"), "autoconnect", true)))
    }
    pub async fn wired_switch(&self, device: &Path, on: bool) -> Result<Option<Path>, Error> {
        let all = self.profiles().await?;
        let profiles = self.compatible_wired(device, &all).await?;
        let mark = "org.nidara.wired-off";
        let marked = profiles.iter().any(|(_, s)| {
            s.get("user")
                .and_then(|u| u.get("data"))
                .and_then(|v| HashMap::<String, String>::try_from(v.try_clone().ok()?).ok())
                .is_some_and(|m| m.contains_key(mark))
        });
        let any_auto = profiles
            .iter()
            .any(|(_, s)| boolean(s.get("connection"), "autoconnect", true));
        let mut selected = None;
        for (i, (path, mut s)) in profiles.into_iter().enumerate() {
            let mut data: HashMap<String, String> = s
                .get("user")
                .and_then(|u| u.get("data"))
                .and_then(|v| HashMap::try_from(v.try_clone().ok()?).ok())
                .unwrap_or_default();
            let edit = if on {
                if marked {
                    data.contains_key(mark)
                } else {
                    !any_auto && i == 0
                }
            } else {
                boolean(s.get("connection"), "autoconnect", true)
            };
            if edit {
                s.entry("connection".into())
                    .or_default()
                    .insert("autoconnect".into(), on.into());
                if on {
                    data.remove(mark);
                } else {
                    data.insert(mark.into(), "1".into());
                }
                s.entry("user".into())
                    .or_default()
                    .insert("data".into(), owned(data));
                self.update(&path, &s).await?;
            }
            if selected.is_none()
                && (edit && on || boolean(s.get("connection"), "autoconnect", true))
            {
                selected = Some(path);
            }
        }
        let p = self.props(device, DEVICE).await?;
        if on {
            self.set(device, DEVICE, "Autoconnect", Value::from(true))
                .await?;
            let wired = self
                .props(device, "org.freedesktop.NetworkManager.Device.Wired")
                .await?;
            if boolean(Some(&wired), "Carrier", false) && text(Some(&p), "ActiveConnection") == "/"
            {
                let a = self
                    .activate(&selected.unwrap_or_else(root_path), device, &root_path())
                    .await?;
                return Ok(Some(a));
            }
        } else if text(Some(&p), "ActiveConnection") != "/" {
            self.call::<()>(device, DEVICE, "Disconnect", &()).await?;
        }
        Ok(None)
    }
}
pub fn root_path() -> Path {
    Path::try_from("/").unwrap()
}
pub fn owned<'a>(v: impl Into<Value<'a>>) -> OwnedValue {
    OwnedValue::try_from(v.into()).expect("valid D-Bus value")
}
pub fn text(p: Option<&Props>, key: &str) -> String {
    p.and_then(|p| p.get(key))
        .and_then(|v| {
            <&str>::try_from(v).ok().map(str::to_owned).or_else(|| {
                <&zbus::zvariant::ObjectPath<'_>>::try_from(v)
                    .ok()
                    .map(|p| p.as_str().to_owned())
            })
        })
        .unwrap_or_default()
}
pub fn number(p: Option<&Props>, key: &str) -> u64 {
    p.and_then(|p| p.get(key))
        .and_then(|v| {
            u64::try_from(v)
                .ok()
                .or_else(|| u32::try_from(v).ok().map(u64::from))
                .or_else(|| u8::try_from(v).ok().map(u64::from))
        })
        .unwrap_or(0)
}
pub fn boolean(p: Option<&Props>, key: &str, default: bool) -> bool {
    p.and_then(|p| p.get(key))
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(default)
}
pub fn bytes(p: Option<&Props>, key: &str) -> Vec<u8> {
    p.and_then(|p| p.get(key))
        .and_then(|v| Vec::<u8>::try_from(v.try_clone().ok()?).ok())
        .unwrap_or_default()
}
pub fn json_prop(p: &Props, key: &str) -> Json {
    // zvariant's serde representation preserves the variant signature. Expose just its value.
    fn plain(v: Json) -> Json {
        match v {
            Json::Object(mut m) if m.contains_key("signature") && m.contains_key("value") => {
                plain(m.remove("value").unwrap())
            }
            Json::Object(m) => Json::Object(m.into_iter().map(|(k, v)| (k, plain(v))).collect()),
            Json::Array(a) => Json::Array(a.into_iter().map(plain).collect()),
            v => v,
        }
    }
    p.get(key)
        .and_then(|v| serde_json::to_value(v).ok())
        .map(plain)
        .unwrap_or(Json::Null)
}

fn dns_live(p: &Props, v6: bool) -> Json {
    if p.contains_key("NameserverData") {
        return json_prop(p, "NameserverData");
    }
    let addresses: Vec<String> = if v6 {
        p.get("Nameservers")
            .and_then(|v| Vec::<Vec<u8>>::try_from(v.try_clone().ok()?).ok())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|a| <[u8; 16]>::try_from(a).ok())
            .map(|a| std::net::Ipv6Addr::from(a).to_string())
            .collect()
    } else {
        p.get("Nameservers")
            .and_then(|v| Vec::<u32>::try_from(v.try_clone().ok()?).ok())
            .unwrap_or_default()
            .into_iter()
            .map(|a| std::net::Ipv4Addr::from(a.to_ne_bytes()).to_string())
            .collect()
    };
    json!(
        addresses
            .into_iter()
            .map(|address| json!({"address":address}))
            .collect::<Vec<_>>()
    )
}
