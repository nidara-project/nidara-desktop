// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{Result, timing};
use serde_json::Value;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::OwnedValue,
};

pub const KEYS: [&str; 3] = [
    "appearance.darkMode",
    "appearance.windowBackground",
    "appearance.windowControls",
];
pub const DEADLINE: Duration = Duration::from_secs(3);
/// The settings-data format this build reads (scripts/settings-data-version.mjs).
pub const DATA_VERSION: &str = "1";
/// A directory of another format is a start-up error, never read as if it were this one
/// (PHASE1.md D4).
pub fn check_version(found: Option<&str>) -> Result<()> {
    match found.map(str::trim) {
        Some(DATA_VERSION) => Ok(()),
        Some(v) => Err(format!(
            "settings-data version {v}, this build reads {DATA_VERSION}"
        )),
        None => Err("settings-data has no version file".into()),
    }
}
pub type Portal = HashMap<String, HashMap<String, OwnedValue>>;
pub struct Services {
    pub schema: Value,
    pub portal: Portal,
    pub epoch: u64,
    pub revision: u64,
}
impl Services {
    fn capture(connection: &Connection) -> Result<Self> {
        let t = Instant::now();
        let config = Proxy::new(
            connection,
            "org.nidara.Config",
            "/org/nidara/Config",
            "org.nidara.Config1",
        )
        .map_err(err)?;
        let (epoch, revision, json): (u64, u64, String) =
            config.call("Snapshot", &()).map_err(err)?;
        timing("Config1.Snapshot", t);
        let schema: Value = serde_json::from_str(&json).map_err(err)?;
        if schema["schemaVersion"] != 1 {
            return Err("unsupported Config1 schemaVersion".into());
        }
        let t = Instant::now();
        let portal = Proxy::new(
            connection,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Settings",
        )
        .map_err(err)?
        .call(
            "ReadAll",
            &(vec!["org.freedesktop.appearance", "org.nidara.appearance"],),
        )
        .map_err(err)?;
        timing("portal_ReadAll", t);
        Ok(Self {
            schema,
            portal,
            epoch,
            revision,
        })
    }
}
pub fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
pub fn read(path: impl AsRef<Path>) -> Result<Value> {
    let p = path.as_ref();
    serde_json::from_slice(&std::fs::read(p).map_err(|e| format!("{}: {e}", p.display()))?)
        .map_err(err)
}
pub fn string(v: &Value) -> Result<&str> {
    v.as_str().ok_or_else(|| format!("expected string: {v}"))
}
pub fn session_languages() -> Vec<String> {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .into_iter()
        .find_map(|k| std::env::var(k).ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "en".into());
    let mut langs: Vec<_> = std::env::var("LANGUAGE")
        .unwrap_or(locale)
        .split(':')
        .flat_map(|s| {
            let s = s.split(['.', '@']).next().unwrap().replace('-', "_");
            let base = s.split('_').next().unwrap().to_owned();
            [s, base]
        })
        .collect();
    langs.push("en".into());
    langs
}
pub struct Exports {
    pub pages: Value,
    pub strings: Value,
    pub english: Value,
    pub colors: Value,
    pub sizes: Value,
}
impl Exports {
    pub fn load() -> Result<Self> {
        let root = PathBuf::from(
            std::env::var_os("NK_SETTINGS_DATA").unwrap_or_else(|| "build/settings-data".into()),
        );
        Self::load_from(&root)
    }
    pub fn load_from(root: &Path) -> Result<Self> {
        check_version(
            std::fs::read_to_string(root.join("version"))
                .ok()
                .as_deref(),
        )?;
        let english = read(root.join("i18n/en.json"))?;
        let mut strings = english.clone();
        for l in session_languages() {
            let p = root.join("i18n").join(format!("{l}.json"));
            if p.exists() {
                strings = read(p)?;
                break;
            }
        }
        Ok(Self {
            pages: read(root.join("manifest.json"))?,
            colors: read(root.join("tokens/colors.json"))?,
            sizes: read(root.join("tokens/static.json"))?,
            strings,
            english,
        })
    }
    pub fn label(&self, key: &Value) -> Result<String> {
        let k = string(key)?;
        self.strings
            .get(k)
            .or_else(|| self.english.get(k))
            .and_then(Value::as_str)
            .map(str::to_owned)
            .ok_or_else(|| format!("missing translation {k}"))
    }
    pub fn scss(&self, key: &str) -> Result<f32> {
        string(&self.sizes["scss"][key])?
            .trim_end_matches("px")
            .trim_end_matches("em")
            .parse()
            .map_err(err)
    }
    pub fn number(&self, group: &str, key: &str) -> Result<f32> {
        self.sizes["ts"][group][key]
            .as_f64()
            .map(|n| n as f32)
            .ok_or_else(|| format!("missing size {group}.{key}"))
    }
    pub fn palette(&self, portal: &Portal) -> Result<Value> {
        let get = |ns: &str, k: &str| {
            portal
                .get(ns)
                .and_then(|m| m.get(k))
                .ok_or_else(|| format!("portal missing {ns}.{k}"))
        };
        let rgb: (f64, f64, f64) = get("org.freedesktop.appearance", "accent-color")?
            .try_clone()
            .map_err(err)?
            .try_into()
            .map_err(err)?;
        let scheme =
            u32::try_from(get("org.freedesktop.appearance", "color-scheme")?).map_err(err)?;
        let dark = match scheme {
            1 => true,
            2 => false,
            _ => return Err(format!("unknown portal color-scheme {scheme}")),
        };
        let reduce =
            bool::try_from(get("org.nidara.appearance", "reduce-transparency")?).map_err(err)?;
        let background: &str = get("org.nidara.appearance", "window-background")?
            .downcast_ref()
            .map_err(err)?;
        let accent = self.colors["accents"]
            .as_object()
            .ok_or("missing accents")?
            .iter()
            .find_map(|(name, hex)| {
                let c = color(hex.as_str()?).ok()?;
                ([rgb.0, rgb.1, rgb.2]
                    .iter()
                    .zip(c)
                    .all(|(a, b)| (a - b as f64 / 255.).abs() < 0.00001))
                .then_some(name)
            })
            .ok_or_else(|| format!("unknown portal accent {rgb:?}"))?;
        let sets = self.colors["sets"].as_array().ok_or("missing color sets")?;
        let set = sets
            .iter()
            .find(|s| {
                s["accent"] == *accent
                    && s["dark"] == dark
                    && s["reduceTransparency"] == reduce
                    && s["windowBackground"] == background
            })
            .ok_or("unknown portal combination")?;
        Ok(set["tokens"].clone())
    }
}
pub fn color(text: &str) -> Result<[u8; 4]> {
    if let Some(h) = text.strip_prefix('#')
        && h.len() == 6
    {
        let n = u32::from_str_radix(h, 16).map_err(err)?;
        return Ok([(n >> 16) as u8, (n >> 8) as u8, n as u8, 255]);
    }
    if let Some(s) = text.strip_prefix("rgba(").and_then(|s| s.strip_suffix(')')) {
        let v = s
            .split(',')
            .map(|s| s.trim().parse::<f32>().map_err(err))
            .collect::<Result<Vec<_>>>()?;
        if v.len() == 4 && v.iter().all(|n| n.is_finite()) {
            return Ok([
                v[0] as u8,
                v[1] as u8,
                v[2] as u8,
                (v[3] * 255.).round() as u8,
            ]);
        }
    }
    Err(format!("unsupported exported color {text}"))
}

/// Subscriptions are installed BEFORE Snapshot. Signals trigger a new authoritative
/// read, never replay an event into a different epoch. One connection owns all calls.
pub fn start() -> std::sync::mpsc::Receiver<Result<Services>> {
    use std::sync::mpsc;
    let (result, rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let work = || -> Result<()> {
            let t = Instant::now();
            let connection = zbus::blocking::connection::Builder::session()
                .map_err(err)?
                .method_timeout(DEADLINE)
                .build()
                .map_err(err)?;
            timing("bus_connect", t);
            let config = Proxy::new(
                &connection,
                "org.nidara.Config",
                "/org/nidara/Config",
                "org.nidara.Config1",
            )
            .map_err(err)?;
            let portal = Proxy::new(
                &connection,
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.Settings",
            )
            .map_err(err)?;
            let updated = config.receive_signal("Updated").map_err(err)?;
            let changed = portal.receive_signal("SettingChanged").map_err(err)?;
            let owner = config.receive_owner_changed().map_err(err)?;
            let (notify, notifications) = mpsc::sync_channel(1);
            for mut stream in [updated, changed] {
                let notify = notify.clone();
                let disconnected = result.clone();
                std::thread::spawn(move || {
                    for _ in &mut stream {
                        let _ = notify.try_send(());
                    }
                    let _ = disconnected.send(Err("D-Bus signal stream disconnected".into()));
                });
            }
            let notify_owner = notify.clone();
            std::thread::spawn(move || {
                for _ in owner {
                    let _ = notify_owner.try_send(());
                }
            });
            drop(notify);
            result.send(Services::capture(&connection)).map_err(err)?;
            for _ in notifications {
                if result.send(Services::capture(&connection)).is_err() {
                    break;
                }
            }
            Ok(())
        };
        if let Err(e) = work() {
            let _ = result.send(Err(e));
        }
    });
    rx
}
