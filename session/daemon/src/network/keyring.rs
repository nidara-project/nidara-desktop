// SPDX-License-Identifier: GPL-3.0-or-later
//! Secret Service, with NetworkManager/libsecret's existing lookup attributes.
//! Plain sessions on the user's private bus, never plaintext files or command arguments.
use super::{
    Error, Settings,
    nm::{Props, number, owned, text},
};
use futures_util::StreamExt;
use std::{collections::HashMap, time::Duration};
use zbus::{
    Connection, Proxy,
    zvariant::{OwnedObjectPath as Path, OwnedValue, Value},
};
const NAME: &str = "org.freedesktop.secrets";
const ROOT: &str = "/org/freedesktop/secrets";
const SERVICE: &str = "org.freedesktop.Secret.Service";
type Secret = (Path, Vec<u8>, Vec<u8>, String);
async fn proxy<'a>(bus: &'a Connection, path: &'a str, iface: &'a str) -> Result<Proxy<'a>, Error> {
    Ok(Proxy::new(bus, NAME, path, iface).await?)
}
async fn prompt(bus: &Connection, path: &Path) -> Result<OwnedValue, Error> {
    let p = proxy(bus, path, "org.freedesktop.Secret.Prompt").await?;
    let mut signals = p.receive_signal("Completed").await?;
    p.call::<_, _, ()>("Prompt", &("",)).await?;
    let msg = tokio::time::timeout(Duration::from_secs(110), signals.next())
        .await
        .map_err(|_| Error::Failed("keyring prompt timed out".into()))?
        .ok_or_else(|| Error::Failed("keyring prompt closed".into()))?;
    let (dismissed, result): (bool, OwnedValue) = msg.body().deserialize()?;
    if dismissed {
        return Err(Error::Cancelled("keyring prompt cancelled".into()));
    }
    Ok(result)
}
async fn unlock(bus: &Connection, paths: &[Path]) -> Result<(), Error> {
    let p = proxy(bus, ROOT, SERVICE).await?;
    let (_unlocked, prompt_path): (Vec<Path>, Path) = p.call("Unlock", &(paths,)).await?;
    if prompt_path.as_str() != "/" {
        prompt(bus, &prompt_path).await?;
    }
    Ok(())
}
fn attrs(uuid: &str, setting: Option<&str>, key: Option<&str>) -> HashMap<String, String> {
    let mut a = HashMap::from([("connection-uuid".into(), uuid.into())]);
    if let Some(s) = setting {
        a.insert("setting-name".into(), s.into());
    }
    if let Some(k) = key {
        a.insert("setting-key".into(), k.into());
    }
    a
}
async fn search(bus: &Connection, a: &HashMap<String, String>) -> Result<Vec<Path>, Error> {
    let p = proxy(bus, ROOT, SERVICE).await?;
    let (mut paths, locked): (Vec<Path>, Vec<Path>) = p.call("SearchItems", &(a,)).await?;
    unlock(bus, &locked).await?;
    paths.extend(locked);
    Ok(paths)
}
async fn session(bus: &Connection) -> Result<Path, Error> {
    let p = proxy(bus, ROOT, SERVICE).await?;
    let (_, session): (OwnedValue, Path) =
        p.call("OpenSession", &("plain", Value::from(""))).await?;
    Ok(session)
}
async fn close(bus: &Connection, s: &Path) {
    if let Ok(p) = proxy(bus, s, "org.freedesktop.Secret.Session").await {
        let _ = p.call::<_, _, ()>("Close", &()).await;
    }
}
pub async fn lookup(bus: &Connection, uuid: &str, setting: &str) -> Result<Props, Error> {
    let paths = search(bus, &attrs(uuid, Some(setting), None)).await?;
    if paths.is_empty() {
        return Ok(Props::new());
    }
    let s = session(bus).await?;
    let result = async {
        let p = proxy(bus, ROOT, SERVICE).await?;
        let values: HashMap<Path, Secret> = p.call("GetSecrets", &(&paths, &s)).await?;
        let mut out = Props::new();
        for (path, (_, _, value, _)) in values {
            let item = proxy(bus, &path, "org.freedesktop.Secret.Item").await?;
            let a: HashMap<String, String> = item.get_property("Attributes").await?;
            if let Some(key) = a.get("setting-key")
                && let Ok(value) = String::from_utf8(value)
            {
                out.insert(key.clone(), owned(value));
            }
        }
        Ok(out)
    }
    .await;
    close(bus, &s).await;
    result
}
pub async fn save(bus: &Connection, s: &Settings) -> Result<(), Error> {
    let uuid = text(s.get("connection"), "uuid");
    if uuid.is_empty() {
        return Err(Error::Invalid("missing connection UUID".into()));
    }
    let mut values = Vec::new();
    for (setting, p) in s {
        if !super::agent::supported(setting) {
            continue;
        }
        for key in p.keys().filter(|k| super::agent::secret_key(setting, k)) {
            let flag = if key.starts_with("wep-key") {
                "wep-key-flags".to_string()
            } else {
                format!("{key}-flags")
            };
            let flags = number(Some(p), &flag);
            if flags & 1 != 0 && flags & 2 == 0 {
                let v = text(Some(p), key);
                if !v.is_empty() {
                    values.push((setting, key.as_str(), v));
                }
            }
        }
    }

    if values.is_empty() {
        return Ok(());
    }
    let svc = proxy(bus, ROOT, SERVICE).await?;
    let mut collection: Path = svc.call("ReadAlias", &("default",)).await?;
    if collection.as_str() == "/" {
        let props = Props::from([(
            "org.freedesktop.Secret.Collection.Label".into(),
            owned("Network secrets"),
        )]);
        let (created, pp): (Path, Path) =
            svc.call("CreateCollection", &(&props, "default")).await?;
        collection = if pp.as_str() != "/" {
            Path::try_from(prompt(bus, &pp).await?)
                .map_err(|_| Error::Failed("invalid keyring collection reply".into()))?
        } else {
            created
        };
    }
    unlock(bus, std::slice::from_ref(&collection)).await?;
    let session = session(bus).await?;
    let result = async {
        let p = proxy(bus, &collection, "org.freedesktop.Secret.Collection").await?;
        for (setting, key, value) in values {
            let a = attrs(&uuid, Some(setting), Some(key));
            let properties = Props::from([
                ("org.freedesktop.Secret.Item.Attributes".into(), owned(a)),
                (
                    "org.freedesktop.Secret.Item.Label".into(),
                    owned(format!(
                        "Network secret for {}/{setting}/{key}",
                        text(s.get("connection"), "id")
                    )),
                ),
            ]);
            let secret = (
                session.clone(),
                Vec::<u8>::new(),
                value.into_bytes(),
                "text/plain; charset=utf8",
            );
            let (_, pp): (Path, Path) = p.call("CreateItem", &(&properties, secret, true)).await?;
            if pp.as_str() != "/" {
                prompt(bus, &pp).await?;
            }
        }
        Ok(())
    }
    .await;
    close(bus, &session).await;
    result
}
pub async fn delete(bus: &Connection, uuid: &str) -> Result<(), Error> {
    for path in search(bus, &attrs(uuid, None, None)).await? {
        let p = proxy(bus, &path, "org.freedesktop.Secret.Item").await?;
        let pp: Path = p.call("Delete", &()).await?;
        if pp.as_str() != "/" {
            prompt(bus, &pp).await?;
        }
    }
    Ok(())
}
