// SPDX-License-Identifier: GPL-3.0-or-later
//! Both providers are pinned to their UNIQUE owner, on distinct buses.
use super::Error;
use serde::{Serialize, de::DeserializeOwned};
use std::{collections::BTreeMap, time::Duration};
use zbus::{
    Connection,
    message::Header,
    zvariant::{DynamicType, OwnedObjectPath as Path, OwnedValue, Type, Value},
};
pub const BLUEZ: &str = "org.bluez";
pub const OBEX: &str = "org.bluez.obex";
pub const ADAPTER: &str = "org.bluez.Adapter1";
pub const DEVICE: &str = "org.bluez.Device1";
pub const BATTERY: &str = "org.bluez.Battery1";
pub const TRANSFER: &str = "org.bluez.obex.Transfer1";
pub const SESSION: &str = "org.bluez.obex.Session1";
pub const OBEX_ROOT: &str = "/org/bluez/obex";
pub type Props = BTreeMap<String, OwnedValue>;
pub type Objects = BTreeMap<String, BTreeMap<String, Props>>;
#[derive(Clone)]
pub struct Peer {
    pub bus: Connection,
    pub owner: String,
}
impl Peer {
    pub async fn current(bus: &Connection, name: &str) -> Result<Self, Error> {
        let owner = zbus::fdo::DBusProxy::new(bus)
            .await?
            .get_name_owner(
                name.try_into()
                    .map_err(|_| Error::Invalid("invalid provider".into()))?,
            )
            .await
            .map_err(|_| Error::Unavailable("provider unavailable".into()))?
            .to_string();
        Ok(Self {
            bus: bus.clone(),
            owner,
        })
    }
    pub fn authenticate(&self, header: &Header<'_>) -> Result<(), Error> {
        if header.sender().map(|s| s.as_str()) != Some(self.owner.as_str()) {
            return Err(Error::Denied("not the current provider".into()));
        }
        Ok(())
    }
    pub async fn call<R: DeserializeOwned + Type>(
        &self,
        path: &str,
        iface: &str,
        method: &str,
        body: &(impl Serialize + DynamicType),
    ) -> Result<R, Error> {
        self.call_for(path, iface, method, body, Duration::from_secs(10))
            .await
    }
    pub async fn call_for<R: DeserializeOwned + Type>(
        &self,
        path: &str,
        iface: &str,
        method: &str,
        body: &(impl Serialize + DynamicType),
        deadline: Duration,
    ) -> Result<R, Error> {
        tokio::time::timeout(deadline, async {
            self.bus
                .call_method(Some(self.owner.as_str()), path, Some(iface), method, body)
                .await?
                .body()
                .deserialize()
        })
        .await
        .map_err(|_| Error::TimedOut("provider call timed out".into()))?
        .map_err(|e| match &e {
            zbus::Error::MethodError(n, _, _)
                if n.as_str().ends_with("NotAuthorized")
                    || n.as_str().ends_with("AccessDenied") =>
            {
                Error::Denied("provider refused permission".into())
            }
            zbus::Error::MethodError(n, _, _) if n.as_str().ends_with("InProgress") => {
                Error::Busy("provider operation in progress".into())
            }
            // Remote errors can contain peer-controlled text; do not leak it into logs/UI.
            _ => Error::Failed("provider call failed".into()),
        })
    }
    pub async fn objects(&self, root: &str) -> Result<Objects, Error> {
        let objects: std::collections::HashMap<Path, BTreeMap<String, Props>> = self
            .call(
                root,
                "org.freedesktop.DBus.ObjectManager",
                "GetManagedObjects",
                &(),
            )
            .await?;
        Ok(objects
            .into_iter()
            .map(|(p, v)| (p.to_string(), v))
            .collect())
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
}
pub async fn alive(bus: &Connection, name: &str) -> bool {
    match zbus::fdo::DBusProxy::new(bus).await {
        Ok(p) => match name.try_into() {
            Ok(n) => p.name_has_owner(n).await.unwrap_or(false),
            Err(_) => false,
        },
        Err(_) => false,
    }
}
pub fn text(p: &Props, key: &str) -> String {
    p.get(key)
        .and_then(|v| {
            <&str>::try_from(v).ok().map(str::to_owned).or_else(|| {
                Path::try_from(v.try_clone().ok()?)
                    .ok()
                    .map(|p| p.to_string())
            })
        })
        .unwrap_or_default()
}
pub fn flag(p: &Props, key: &str) -> bool {
    p.get(key)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false)
}
pub fn number(p: &Props, key: &str) -> Option<u64> {
    p.get(key).and_then(|v| {
        u64::try_from(v)
            .ok()
            .or_else(|| u32::try_from(v).ok().map(u64::from))
            .or_else(|| u8::try_from(v).ok().map(u64::from))
    })
}
pub fn strings(p: &Props, key: &str) -> Vec<String> {
    p.get(key)
        .and_then(|v| Vec::try_from(v.try_clone().ok()?).ok())
        .unwrap_or_default()
}
pub fn object<'a>(objects: &'a Objects, path: &str, iface: &str) -> Result<&'a Props, Error> {
    objects
        .get(path)
        .and_then(|v| v.get(iface))
        .ok_or_else(|| Error::NotFound("object/interface no longer present".into()))
}

/// Observed local service advertisements are a warning, not proof of daemon flags.
pub fn advertised_file_service(uuid: &str) -> Option<&'static str> {
    match uuid.to_ascii_lowercase().as_str() {
        "1106" | "00001106" | "00001106-0000-1000-8000-00805f9b34fb" => Some("obex-ftp"),
        "00005005-0000-1000-8000-0002ee000001" => Some("nokia-pcsuite"),
        "00000002-0000-1000-8000-0002ee000002" => Some("syncevolution"),
        _ => None,
    }
}
pub fn is_ftp(uuid: &str) -> bool {
    advertised_file_service(uuid) == Some("obex-ftp")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn known_file_service_uuid_forms() {
        for uuid in ["1106", "00001106", "00001106-0000-1000-8000-00805F9B34FB"] {
            assert!(is_ftp(uuid));
        }
        assert!(!is_ftp("00001105-0000-1000-8000-00805f9b34fb"));
        assert_eq!(
            advertised_file_service("00005005-0000-1000-8000-0002ee000001"),
            Some("nokia-pcsuite")
        );
    }
}
