// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
pub const UP: &str = "org.freedesktop.UPower";
pub const UP_PATH: &str = "/org/freedesktop/UPower";
pub const DEVICE: &str = "org.freedesktop.UPower.Device";
pub const KBD: &str = "org.freedesktop.UPower.KbdBacklight";
pub const PPD: &str = "org.freedesktop.UPower.PowerProfiles";
pub const PPD_PATH: &str = "/org/freedesktop/UPower/PowerProfiles";
pub const LOGIN: &str = "org.freedesktop.login1.Manager";
pub const LOGIN_PATH: &str = "/org/freedesktop/login1";
type Props = HashMap<String, OwnedValue>;
pub async fn bounded<T, E: std::fmt::Display>(
    future: impl std::future::Future<Output = Result<T, E>>,
) -> Result<T, Error> {
    tokio::time::timeout(Duration::from_secs(5), future)
        .await
        .map_err(|_| Error::Timeout("provider reply deadline; result uncertain".into()))?
        .map_err(|e| {
            let message = e.to_string();
            if message.contains("InteractiveAuthorizationRequired") {
                Error::AuthenticationRequired(message)
            } else if message.contains("AccessDenied") || message.contains("NotAuthorized") {
                Error::PermissionDenied(message)
            } else {
                Error::Failed(message)
            }
        })
}
fn string(p: &Props, k: &str) -> String {
    p.get(k)
        .and_then(|v| <&str>::try_from(v).ok())
        .unwrap_or_default()
        .chars()
        .take(1024)
        .collect()
}
fn flag(p: &Props, k: &str) -> bool {
    p.get(k)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or(false)
}
fn num(p: &Props, k: &str) -> Option<f64> {
    p.get(k)
        .and_then(|v| f64::try_from(v).ok())
        .filter(|n| n.is_finite())
}
fn uint(p: &Props, k: &str) -> u32 {
    p.get(k).and_then(|v| u32::try_from(v).ok()).unwrap_or(0)
}
fn signed(p: &Props, k: &str) -> Option<i64> {
    p.get(k).and_then(|v| {
        i64::try_from(v)
            .ok()
            .or_else(|| i32::try_from(v).ok().map(i64::from))
    })
}
fn list(p: &Props, k: &str) -> Vec<Props> {
    p.get(k)
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| Vec::<Props>::try_from(v).ok())
        .unwrap_or_default()
}
async fn all(p: &Power, provider: &'static str, path: &str, iface: &str) -> Result<Props, Error> {
    let proxy = p
        .backend(provider, path, "org.freedesktop.DBus.Properties")
        .await?;
    bounded(proxy.call("GetAll", &(iface,))).await
}
fn object(p: &Power, provider: &'static str, raw: &str, kind: &'static str, props: Json) -> Object {
    let state = p.state.read().unwrap();
    let epoch = state.providers.get(provider).map_or(p.epoch, |p| p.epoch);
    let key = state
        .objects
        .values()
        .find(|o| {
            o.provider == provider
                && o.epoch == epoch
                && o.raw == raw
                && o.kind == kind
                && !state.retired.contains(&o.path)
        })
        .map(|o| o.path.clone())
        .unwrap_or_else(|| {
            format!(
                "{ROOT}/s{}/{provider}/g{epoch}/n{}",
                p.epoch,
                p.serial.fetch_add(1, Ordering::Relaxed)
            )
        });
    Object {
        path: key,
        kind,
        provider,
        raw: raw.into(),
        epoch,
        props,
    }
}
fn device_props(raw: &Props, display: bool) -> Json {
    let kind = uint(raw, "Type");
    let system = flag(raw, "PowerSupply") && [2, 3].contains(&kind);
    let role = if display {
        "aggregate"
    } else if system {
        "system"
    } else if kind == 1 {
        "line-power"
    } else {
        "peripheral"
    };
    let percent = num(raw, "Percentage").filter(|p| (0.0..=100.0).contains(p));
    let reported = num(raw, "Capacity").filter(|p| *p > 0.0);
    let full = num(raw, "EnergyFull").filter(|n| *n > 0.0);
    let design = num(raw, "EnergyFullDesign").filter(|n| *n > 0.0);
    let calculated = full
        .zip(design)
        .map(|(f, d)| f / d * 100.0)
        .filter(|v| v.is_finite());
    let health = if display {
        None
    } else {
        reported.or(calculated)
    };
    let cycles = if display {
        -1
    } else {
        signed(raw, "ChargeCycles").unwrap_or(-1)
    };
    let support = flag(raw, "ChargeThresholdSupported") && system && !display;
    let mut caps = vec![];
    if support {
        caps.push("charge-protection")
    }
    if health.is_some() {
        caps.push("health")
    }
    if cycles >= 0 {
        caps.push("cycles")
    }
    json!({
        "ProviderPath": raw.get("NativePath").and_then(|v|<&str>::try_from(v).ok()).unwrap_or(""),
        "Kind": kind,
        "Role": role,
        "Vendor": string(raw,"Vendor"),
        "Model": string(raw,"Model"),
        "IconName": string(raw,"IconName"),
        "Present": flag(raw,"IsPresent"),
        "PowerSupply": flag(raw,"PowerSupply"),
        "Rechargeable": flag(raw,"IsRechargeable"),
        "State": uint(raw,"State"),
        "PercentageKnown": percent.is_some(),
        "Percentage": percent.unwrap_or(0.0),
        "TimeToEmptyKnown": signed(raw,"TimeToEmpty").is_some_and(|v|v>0),
        "TimeToFullKnown": signed(raw,"TimeToFull").is_some_and(|v|v>0),
        "TimeToEmpty": signed(raw,"TimeToEmpty").unwrap_or(0).max(0),
        "TimeToFull": signed(raw,"TimeToFull").unwrap_or(0).max(0),
        "WarningLevel": uint(raw,"WarningLevel"),
        "BatteryLevel": uint(raw,"BatteryLevel"),
        "HealthKnown": health.is_some(),
        "HealthPercent": health.unwrap_or(0.0),
        "HealthSource": if health.is_none(){"unknown"}else if reported.is_some(){"reported"}else if calculated.is_some(){"calculated"}else{"unknown"},
        "CyclesKnown": cycles>=0,
        "Cycles": cycles,
        "ChargeProtectionSupported": support,
        "ChargeProtectionEnabled": flag(raw,"ChargeThresholdEnabled"),
        "StartThresholdKnown": uint(raw,"ChargeStartThreshold")>0,
        "EndThresholdKnown": uint(raw,"ChargeEndThreshold")>0,
        "StartThreshold": uint(raw,"ChargeStartThreshold"),
        "EndThreshold": uint(raw,"ChargeEndThreshold"),
        "Capabilities": caps,
        "BluetoothDevicePath": "/",
        "BatteryOwner": "power1",
        "DeduplicationState": "unlinked",
    })
}
async fn upower(
    p: &Power,
    objects: &mut BTreeMap<String, Object>,
    root: &mut Json,
) -> Result<Battery, Error> {
    let values = all(p, "upower", UP_PATH, UP).await?;
    let on_battery = values.get("OnBattery").and_then(|v| bool::try_from(v).ok());
    root["OnBatteryKnown"] = json!(on_battery.is_some());
    root["OnBattery"] = json!(on_battery.unwrap_or(false));
    root["LidKnown"] = json!(values.contains_key("LidIsClosed"));
    root["LidPresent"] = json!(flag(&values, "LidIsPresent"));
    root["LidClosed"] = json!(flag(&values, "LidIsClosed"));
    let proxy = p.backend("upower", UP_PATH, UP).await?;
    let display: Path = bounded(proxy.call("GetDisplayDevice", &())).await?;
    let mut paths: Vec<Path> = bounded(proxy.call("EnumerateDevices", &())).await?;
    if !paths.contains(&display) {
        paths.push(display.clone());
    }
    let mut battery = Battery {
        on_battery,
        ..Default::default()
    };
    for raw_path in paths.into_iter().take(128) {
        let props = match all(p, "upower", raw_path.as_str(), DEVICE).await {
            Ok(props) => props,
            Err(e) => {
                root["UPowerError"] = json!(e.to_string());
                continue;
            }
        };
        let display_device = raw_path == display;
        let mut props_json = device_props(&props, display_device);
        props_json["ProviderPath"] = json!(raw_path.as_str());
        props_json["NativePath"] = json!(string(&props, "NativePath"));
        props_json["Serial"] = json!(string(&props, "Serial"));
        let node = object(p, "upower", raw_path.as_str(), "device", props_json);
        if display_device {
            root["DisplayDevice"] = json!(node.path);
            battery.present = node.props["Present"].as_bool().unwrap_or(false);
            battery.percentage = node.props["PercentageKnown"]
                .as_bool()
                .unwrap_or(false)
                .then(|| node.props["Percentage"].as_f64())
                .flatten();
            battery.warning = uint(&props, "WarningLevel");
            battery.charging = matches!(uint(&props, "State"), 1 | 4);
        }
        objects.insert(node.path.clone(), node);
    }
    let keyboard_paths: Vec<Path> = match bounded(proxy.call("EnumerateKbdBacklights", &())).await {
        Ok(paths) => paths,
        Err(_) => vec![path("/org/freedesktop/UPower/KbdBacklight")],
    };
    for raw in keyboard_paths.into_iter().take(16) {
        let Ok(proxy) = p.backend("upower", raw.as_str(), KBD).await else {
            continue;
        };
        let max: Result<i32, _> = bounded(proxy.call("GetMaxBrightness", &())).await;
        let value: Result<i32, _> = bounded(proxy.call("GetBrightness", &())).await;
        if let (Ok(max), Ok(value)) = (max, value)
            && max > 0
            && value >= 0
            && value <= max
        {
            let previous = p
                .state
                .read()
                .unwrap()
                .objects
                .values()
                .find(|o| o.raw == raw.as_str() && o.kind == "keyboard")
                .map(|o| o.props["LastChangeSource"].clone())
                .unwrap_or(json!("unknown"));
            let node = object(
                p,
                "upower",
                raw.as_str(),
                "keyboard",
                json!({"Brightness": value,"MaxBrightness": max,"Known": true,"LastChangeSource": previous,"Capabilities": ["brightness"]}),
            );
            objects.insert(node.path.clone(), node);
        }
    }
    Ok(battery)
}
async fn ppd(
    p: &Power,
    objects: &mut BTreeMap<String, Object>,
    root: &mut Json,
) -> Result<(), Error> {
    let values = all(p, "ppd", PPD_PATH, PPD).await?;
    root["ActiveProfile"] = json!(string(&values, "ActiveProfile"));
    root["PerformanceDegraded"] = json!(string(&values, "PerformanceDegraded"));
    root["PerformanceInhibited"] = json!(string(&values, "PerformanceInhibited"));
    for profile in list(&values, "Profiles").into_iter().take(16) {
        let name = string(&profile, "Profile");
        if name.is_empty() {
            continue;
        }
        let node = object(
            p,
            "ppd",
            &format!("profile:{name}"),
            "profile",
            json!({
                "Name": name,
                "Driver": string(&profile,"Driver"),
                "Available": true,
                "PerformanceDegraded": string(&values,"PerformanceDegraded"),
                "PerformanceInhibited": string(&values,"PerformanceInhibited"),
            }),
        );
        objects.insert(node.path.clone(), node);
    }
    let owned = p
        .state
        .read()
        .unwrap()
        .holds
        .values()
        .cloned()
        .collect::<Vec<_>>();
    let mut consumed = std::collections::BTreeSet::new();
    for (index, h) in list(&values, "ActiveProfileHolds")
        .iter()
        .enumerate()
        .take(128)
    {
        let profile = string(h, "Profile");
        let reason = string(h, "Reason");
        let app = string(h, "ApplicationId");
        if let Some(own) = owned.iter().find(|h| {
            h.profile == profile
                && h.reason == reason
                && h.app == app
                && !consumed.contains(&h.cookie)
        }) {
            consumed.insert(own.cookie);
            continue;
        }
        let node = object(
            p,
            "ppd",
            &format!("foreign-hold:{index}:{profile}:{app}:{reason}"),
            "hold",
            json!({"Profile": profile,"Reason": reason,"ApplicationId": app,"Owner": "","OwnedByPower1": false,"State": "active"}),
        );
        objects.insert(node.path.clone(), node);
    }
    Ok(())
}
async fn logind(
    p: &Power,
    objects: &mut BTreeMap<String, Object>,
    root: &mut Json,
) -> Result<(), Error> {
    let proxy = p.backend("logind", LOGIN_PATH, LOGIN).await?;
    let values = all(p, "logind", LOGIN_PATH, LOGIN).await?;
    root["BlockInhibited"] = json!(string(&values, "BlockInhibited"));
    root["DelayInhibited"] = json!(string(&values, "DelayInhibited"));
    root["DockedKnown"] = json!(values.contains_key("Docked"));
    root["Docked"] = json!(flag(&values, "Docked"));
    root["LidHoldoffUSec"] = json!(
        values
            .get("HoldoffTimeoutUSec")
            .and_then(|v| u64::try_from(v).ok())
            .unwrap_or(30_000_000)
    );
    if !root["LidKnown"].as_bool().unwrap_or(false) && values.contains_key("LidClosed") {
        root["LidKnown"] = json!(true);
        root["LidClosed"] = json!(flag(&values, "LidClosed"));
        root["LidPresent"] = json!(true);
    }
    let session: Path = bounded(proxy.call("GetSession", &("auto",))).await?;
    let session_props = all(
        p,
        "logind",
        session.as_str(),
        "org.freedesktop.login1.Session",
    )
    .await?;
    root["SessionActive"] =
        json!(flag(&session_props, "Active") && !flag(&session_props, "Remote"));
    for (method, key) in [("CanSuspend", "CanSuspend"), ("CanPowerOff", "CanPowerOff")] {
        let state: String = bounded(proxy.call(method, &()))
            .await
            .unwrap_or("na".into());
        root[key] = json!(state);
    }
    let inhibitors: Vec<(String, String, String, String, u32, u32)> =
        bounded(proxy.call("ListInhibitors", &())).await?;
    for (index, (what, who, why, mode, uid, pid)) in inhibitors.into_iter().enumerate().take(256) {
        let node = object(
            p,
            "logind",
            &format!("inhibitor:{index}:{uid}:{pid}:{what}:{mode}"),
            "inhibitor",
            json!({"Source": "logind","What": what.split(':').collect::<Vec<_>>(),"Who": who,"Reason": why,"ApplicationId": "","Pid": pid,"Uid": uid,"IdentityKnown": true,"Mode": mode,"Effective": true}),
        );
        objects.insert(node.path.clone(), node);
    }
    root["InhibitorsUpdatedAt"] = json!(now());
    Ok(())
}
async fn hyalo(p: &Power, objects: &mut BTreeMap<String, Object>, root: &mut Json) -> Json {
    let result =
        tokio::task::spawn_blocking(|| crate::hyalo::request(json!({"request": "power_info"})))
            .await;
    let value = match result {
        Ok(Ok(v)) => v,
        _ => return Json::Null,
    };
    if let Some(socket) = crate::hyalo::socket()
        && let Ok(meta) = std::fs::metadata(socket)
    {
        use std::os::unix::fs::MetadataExt;
        let owner = format!("{}:{}", meta.dev(), meta.ino());
        let mut state = p.state.write().unwrap();
        let provider = state.providers.entry("hyalo").or_default();
        if provider.owner != owner {
            provider.owner = owner;
            provider.epoch = p.serial.fetch_add(1, Ordering::Relaxed);
            state.lid_sequence += 1;
            state.last_lid = None;
            state.last_docked = None;
        }
    }
    let Some(info) = value.get("power") else {
        return Json::Null;
    };
    if info["docked_known"].as_bool().unwrap_or(false) {
        root["DockedKnown"] = json!(true);
        root["Docked"] = json!(
            root["Docked"].as_bool().unwrap_or(false) || info["docked"].as_bool().unwrap_or(false)
        );
    }
    root["EffectiveIdle"] = info.get("idle").cloned().unwrap_or(json!({}));
    for item in info["inhibitors"].as_array().into_iter().flatten() {
        let raw = item["id"].as_str().unwrap_or("anonymous");
        let node = object(
            p,
            "hyalo",
            raw,
            "inhibitor",
            json!({
                "Source": item["source"],
                "What": ["idle"],
                "Who": item["who"],
                "Reason": item["reason"],
                "ApplicationId": item["app_id"],
                "Pid": item["pid"].as_u64().unwrap_or(0),
                "Uid": item["uid"].as_u64().unwrap_or(0),
                "IdentityKnown": item["identity_known"].as_bool().unwrap_or(false),
                "Mode": "idle",
                "Effective": item["effective"].as_bool().unwrap_or(false),
            }),
        );
        objects.insert(node.path.clone(), node);
    }
    info.clone()
}
pub async fn check_owner(p: &Power, name: &'static str) -> Result<(), Error> {
    let system = p
        .system
        .read()
        .unwrap()
        .clone()
        .ok_or_else(|| Error::Unavailable("system bus missing".into()))?;
    let service = match name {
        "upower" => UP,
        "ppd" => PPD,
        "logind" => "org.freedesktop.login1",
        _ => return Ok(()),
    };
    let dbus = zbus::fdo::DBusProxy::new(&system).await?;
    let current = dbus
        .get_name_owner(service.try_into().unwrap())
        .await
        .map_err(|_| Error::Unavailable("provider disappeared".into()))?;
    if p.state
        .read()
        .unwrap()
        .providers
        .get(name)
        .is_some_and(|s| s.owner == current.as_str())
    {
        Ok(())
    } else {
        Err(Error::NotFound("provider replaced".into()))
    }
}
pub async fn refresh(p: &Power) -> Result<(), Error> {
    let guard = p.updates.lock().await;
    let system = p.system.read().unwrap().clone();
    let mut logind_changed = false;
    let mut ended_holds = Vec::new();
    for (key, name) in [
        ("upower", UP),
        ("ppd", PPD),
        ("logind", "org.freedesktop.login1"),
    ] {
        let owner = if let Some(system) = &system {
            match zbus::fdo::DBusProxy::new(system).await {
                Ok(d) => d
                    .get_name_owner(name.try_into().unwrap())
                    .await
                    .map(|n| n.to_string())
                    .unwrap_or_default(),
                Err(_) => String::new(),
            }
        } else {
            String::new()
        };
        let mut state = p.state.write().unwrap();
        let old = state.providers.entry(key).or_default();
        if old.owner != owner {
            if key == "logind" {
                logind_changed = true;
            }
            old.owner = owner;
            old.epoch = p.serial.fetch_add(1, Ordering::Relaxed);
            old.error.clear();
            if ["upower", "logind"].contains(&key) {
                state.lid_sequence += 1;
                state.last_lid = None;
                state.last_docked = None;
            }
            if key == "ppd" {
                ended_holds.extend(state.holds.values().cloned());
                state.released.clear();
                state.releasing.clear();
                state.holds.clear();
                state.policy.hold_failed();
            }
        }
    }
    if logind_changed {
        *p.key_fd.lock().await = None;
        *p.lid_fd.lock().await = None;
    }
    let mut root = json!({
        "State": "Unavailable",
        "LastError": "",
        "Generation": p.epoch,
        "DisplayDevice": "/",
        "OnBatteryKnown": false,
        "OnBattery": false,
        "LidKnown": false,
        "LidPresent": false,
        "LidClosed": false,
        "DockedKnown": false,
        "Docked": false,
        "CanSuspend": "na",
        "CanPowerOff": "na",
        "SessionActive": false,
        "LidHoldoffUSec": 30_000_000,
        "EffectiveIdle": {},
    });
    let mut objects = BTreeMap::new();
    let mut caps = vec![];
    let battery = match upower(p, &mut objects, &mut root).await {
        Ok(b) => {
            p.state
                .write()
                .unwrap()
                .providers
                .get_mut("upower")
                .unwrap()
                .error
                .clear();
            if let Some(error) = root["UPowerError"].as_str() {
                p.state
                    .write()
                    .unwrap()
                    .providers
                    .get_mut("upower")
                    .unwrap()
                    .error = error.into();
            }
            caps.push("devices");
            if b.present {
                caps.push("battery");
            }
            b
        }
        Err(e) => {
            p.state
                .write()
                .unwrap()
                .providers
                .get_mut("upower")
                .unwrap()
                .error = e.to_string();
            Battery::default()
        }
    };
    match ppd(p, &mut objects, &mut root).await {
        Ok(()) => {
            caps.push("profiles");
            p.state
                .write()
                .unwrap()
                .providers
                .get_mut("ppd")
                .unwrap()
                .error
                .clear();
        }
        Err(e) => {
            p.state
                .write()
                .unwrap()
                .providers
                .get_mut("ppd")
                .unwrap()
                .error = e.to_string()
        }
    }
    match logind(p, &mut objects, &mut root).await {
        Ok(()) => {
            caps.push("logind");
            caps.push("inhibitors");
            p.state
                .write()
                .unwrap()
                .providers
                .get_mut("logind")
                .unwrap()
                .error
                .clear();
        }
        Err(e) => {
            p.state
                .write()
                .unwrap()
                .providers
                .get_mut("logind")
                .unwrap()
                .error = e.to_string()
        }
    }
    deduplicate(p, &mut objects).await;
    let compositor = hyalo(p, &mut objects, &mut root).await;
    if !compositor.is_null() {
        caps.push("hyalo-idle");
    }
    let preferences = p.prefs.read().unwrap().clone();
    let active = root["SessionActive"].as_bool().unwrap_or(false);
    let can_saver = preferences.automatic_saver && active && caps.contains(&"profiles");
    let old_saver = p.property::<String>(ROOT, "AutomaticSaverState");
    let effects = {
        let mut state = p.state.write().unwrap();
        let effects = state.policy.update(&battery, can_saver);
        state.battery = battery;
        state.hyalo = compositor.clone();
        root["LowActive"] = json!(
            state.battery.present && state.battery.on_battery == Some(true) && state.policy.low
        );
        root["CriticalActive"] = json!(
            state.battery.present
                && state.battery.on_battery == Some(true)
                && state.policy.critical
        );
        root["AutomaticSaverState"] = json!(if !can_saver {
            "unsupported"
        } else if state.policy.overridden {
            "overridden"
        } else if state.holds.values().any(|h| h.automatic) {
            "held"
        } else {
            "inactive"
        });
        let errors = state
            .providers
            .iter()
            .filter(|(_, s)| !s.error.is_empty())
            .map(|(k, s)| format!("{k}: {}", s.error))
            .collect::<Vec<_>>();
        root["State"] = json!(if caps.is_empty() {
            "Unavailable"
        } else if errors.is_empty() {
            "Ready"
        } else {
            "Degraded"
        });
        root["LastError"] = json!(errors.join("; "));
        root["ProviderStates"] = json!(
            state
                .providers
                .iter()
                .map(|(k, v)| (
                    *k,
                    if v.owner.is_empty() {
                        "unavailable"
                    } else if v.error.is_empty() {
                        "ready"
                    } else {
                        "degraded"
                    }
                ))
                .collect::<BTreeMap<_, _>>()
        );
        root["ProviderEpochs"] = json!(
            state
                .providers
                .iter()
                .map(|(k, v)| (*k, v.epoch))
                .collect::<BTreeMap<_, _>>()
        );
        for h in state.holds.values() {
            objects.insert(h.path.clone(),Object{path:h.path.clone(),kind:"hold",provider:"session",raw:h.path.clone(),epoch:p.epoch,props:json!({"Profile": h.profile,"Reason": h.reason,"ApplicationId": h.app,"Owner": h.owner,"OwnedByPower1": true,"State": "active"})});
        }
        root["MenuAvailable"] = json!(state.menu.is_some());
        root["PowerButtonEffectiveAction"] = json!(model::effective_button(
            &preferences.power_button,
            state.menu.is_some(),
            compositor["locked"].as_bool().unwrap_or(false)
        ));
        root["PowerButtonAction"] = json!(preferences.power_button);
        root["LidActionOnBattery"] = json!(preferences.lid_battery);
        root["LidActionOnAC"] = json!(preferences.lid_ac);
        root["AutomaticSaverEnabled"] = json!(preferences.automatic_saver);
        root["ShowPercentage"] = json!(preferences.show_percentage);
        root["PolicyOwner"] = json!(if p.read_only { "none" } else { "sessiond" });
        if let Some(menu) = &state.menu {
            objects.insert(menu.path.clone(),Object{path:menu.path.clone(),kind:"menu",provider:"session",raw:menu.path.clone(),epoch:p.epoch,props:json!({"Owner": menu.owner,"ConsumerPath": menu.consumer.as_str(),"Active": true})});
        }
        effects
    };
    for (key, kind) in [
        ("Devices", "device"),
        ("Profiles", "profile"),
        ("ProfileHolds", "hold"),
        ("KeyboardBacklights", "keyboard"),
        ("Inhibitors", "inhibitor"),
    ] {
        root[key] = json!(
            objects
                .values()
                .filter(|o| o.kind == kind)
                .map(|o| o.path.clone())
                .collect::<Vec<_>>()
        );
    }
    root["PeripheralDevices"] = json!(
        objects
            .values()
            .filter(|o| o.kind == "device"
                && o.props["Role"] == "peripheral"
                && o.props["BluetoothDevicePath"] == "/")
            .map(|o| o.path.clone())
            .collect::<Vec<_>>()
    );
    let keyboards = objects
        .values()
        .filter(|o| o.kind == "keyboard")
        .collect::<Vec<_>>();
    root["PrimaryKeyboardBacklight"] = json!(if let Some(primary) = keyboards
        .iter()
        .find(|o| o.raw == "/org/freedesktop/UPower/KbdBacklight")
    {
        primary.path.as_str()
    } else if keyboards.len() == 1 {
        keyboards[0].path.as_str()
    } else {
        "/"
    });
    if !keyboards.is_empty() {
        caps.push("keyboard-backlight");
    }
    if !p.read_only {
        caps.push("policies");
    }
    root["InhibitorsMode"] = json!("snapshot");
    root["BlockInhibited"] = root.get("BlockInhibited").cloned().unwrap_or(json!(""));
    root["DelayInhibited"] = root.get("DelayInhibited").cloned().unwrap_or(json!(""));
    root["NCurrentInhibitors"] = json!(
        objects
            .values()
            .filter(|o| o.kind == "inhibitor" && o.provider == "logind")
            .count() as u32
    );
    root["Capabilities"] = json!(caps);
    let saver = root["AutomaticSaverState"]
        .as_str()
        .unwrap_or("")
        .to_string();
    bus::publish(p, objects, root).await?;
    p.state.write().unwrap().retired.clear();
    for hold in ended_holds {
        let cleanup = hold.clone();
        tokio::spawn(async move {
            if let Ok(proxy) = Proxy::new(
                &cleanup.provider_connection,
                cleanup.provider_owner.as_str(),
                PPD_PATH,
                PPD,
            )
            .await
            {
                let _ = bounded(proxy.call::<_, _, ()>("ReleaseProfile", &(cleanup.cookie,))).await;
            }
        });
        let _ = p
            .conn
            .emit_signal(
                Some(hold.owner.as_str()),
                hold.path.as_str(),
                "org.nidara.PowerProfileHold1",
                "Ended",
                &("provider-lost",),
            )
            .await;
    }
    if old_saver != saver {
        let _ = p
            .conn
            .emit_signal(
                None::<&str>,
                ROOT,
                "org.nidara.Power1",
                "AutomaticSaverChanged",
                &(saver, "policy-update"),
            )
            .await;
    }
    drop(guard);
    arm_inputs(p).await;
    lid_changes(p).await;
    peripheral_alerts(p).await;
    p.effects(effects).await;
    Ok(())
}
pub(super) async fn arm_inputs(p: &Power) {
    let info = p.state.read().unwrap().hyalo.clone();
    let active = p.active()
        && info["session"].as_bool().unwrap_or(false)
        && !info["nested"].as_bool().unwrap_or(true)
        && !p.read_only;
    let source = p
        .property::<bool>(ROOT, "OnBatteryKnown")
        .then(|| p.property::<bool>(ROOT, "OnBattery"));
    let owns_lid = model::owns_lid(&p.prefs.read().unwrap(), source);
    for (fd, what, ready) in [
        (
            &p.key_fd,
            "handle-power-key",
            active && info["power_key_forwarding"].as_bool().unwrap_or(false),
        ),
        (
            &p.lid_fd,
            "handle-lid-switch",
            active && owns_lid && p.property::<bool>(ROOT, "LidKnown"),
        ),
    ] {
        let mut lock = fd.lock().await;
        if !ready {
            *lock = None;
            continue;
        }
        if lock.is_none()
            && let Ok(proxy) = p.backend("logind", LOGIN_PATH, LOGIN).await
        {
            match bounded(proxy.call::<_, _, zbus::zvariant::OwnedFd>(
                "Inhibit",
                &(what, "Nidara Power", "Session hardware policy", "block"),
            ))
            .await
            {
                Ok(value) => *lock = Some(value),
                Err(e) => p.failure(what, ROOT, &e).await,
            }
        }
    }
    let _guard = p.updates.lock().await;
    let state = p.state.read().unwrap().clone();
    let mut root = state.root;
    root["PowerButtonHandling"] = json!(if p.key_fd.lock().await.is_some() {
        "sessiond"
    } else {
        "logind"
    });
    root["LidHandling"] = json!(if p.lid_fd.lock().await.is_some() {
        "sessiond"
    } else {
        "logind"
    });
    let _ = bus::publish(p, state.objects, root).await;
}
async fn lid_changes(p: &Power) {
    let closed = p.property::<bool>(ROOT, "LidClosed");
    let known = p.property::<bool>(ROOT, "LidKnown");
    let docked = p.property::<bool>(ROOT, "Docked");
    let dock_known = p.property::<bool>(ROOT, "DockedKnown");
    let mut schedule = None;
    {
        let mut state = p.state.write().unwrap();
        if !known
            || !state.root["SessionActive"].as_bool().unwrap_or(false)
            || !state.hyalo["session"].as_bool().unwrap_or(false)
            || state.hyalo["nested"].as_bool().unwrap_or(true)
        {
            state.last_lid = None;
            state.last_docked = None;
            state.lid_sequence += 1;
            return;
        }
        if !closed {
            state.lid_sequence += 1;
        }
        if state.last_lid == Some(false) && closed {
            state.lid_sequence += 1;
            schedule = Some((state.lid_sequence, 0));
        } else if state.last_lid == Some(true)
            && closed
            && state.last_docked == Some(true)
            && dock_known
            && !docked
        {
            state.lid_sequence += 1;
            schedule = Some((
                state.lid_sequence,
                state.root["LidHoldoffUSec"].as_u64().unwrap_or(30_000_000),
            ));
        }
        state.last_lid = Some(closed);
        state.last_docked = dock_known.then_some(docked);
    }
    if let Some((ticket, delay)) = schedule {
        let p = p.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_micros(delay)).await;
            if p.lid_fd.lock().await.is_none() {
                return;
            }
            let state = p.state.read().unwrap().clone();
            if state.lid_sequence != ticket || !state.root["LidClosed"].as_bool().unwrap_or(false) {
                return;
            }
            let preferences = p.prefs.read().unwrap().clone();
            let action = if state.root["OnBatteryKnown"].as_bool().unwrap_or(false) {
                if state.root["OnBattery"].as_bool().unwrap_or(false) {
                    preferences.lid_battery
                } else {
                    preferences.lid_ac
                }
            } else {
                return;
            };
            // Suspend is delegated to logind, including its inhibitor and dock rules.
            if action == "suspend" {
                return;
            }
            if let Err(e) = p.action(&action, false).await {
                p.failure("lid", ROOT, &e).await;
            }
        });
    }
}
pub async fn watch(p: Power) -> zbus::Result<oneshot::Receiver<()>> {
    let (ready_tx, ready_rx) = oneshot::channel();
    let session = zbus::fdo::DBusProxy::new(&p.conn).await?;
    let mut owners = session.receive_name_owner_changed().await?;
    let local = p.clone();
    tokio::spawn(async move {
        while let Some(event) = owners.next().await {
            let Ok(args) = event.args() else { continue };
            if args.new_owner().is_some() {
                continue;
            }
            let owner = args.name().as_str();
            let keys = local
                .state
                .read()
                .unwrap()
                .holds
                .values()
                .filter(|h| h.owner == owner)
                .map(|h| h.path.clone())
                .collect::<Vec<_>>();
            for key in keys {
                let _ = local.release(&key, None).await;
            }
            let menu = local
                .state
                .read()
                .unwrap()
                .menu
                .clone()
                .filter(|m| m.owner == owner);
            if let Some(menu) = menu {
                let _ = local.menu_release(&menu.path, owner).await;
            }
        }
    });
    // Bluetooth is optional and can appear after Power1; its identity changes must
    // re-evaluate deduplication even when UPower has no new battery sample.
    let bluetooth = p.clone();
    let mut signals = futures_util::stream::SelectAll::new();
    let updated = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.nidara.Bluetooth")?
        .path("/org/nidara/Bluetooth")?
        .interface("org.nidara.Bluetooth1")?
        .member("Updated")?
        .build();
    let owners = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender("org.freedesktop.DBus")?
        .interface("org.freedesktop.DBus")?
        .member("NameOwnerChanged")?
        .add_arg("org.nidara.Bluetooth")?
        .build();
    signals.push(zbus::MessageStream::for_match_rule(updated, &p.conn, Some(64)).await?);
    signals.push(zbus::MessageStream::for_match_rule(owners, &p.conn, Some(64)).await?);
    tokio::spawn(async move {
        while let Some(Ok(message)) = signals.next().await {
            let header = message.header();
            let member = header.member().map(|m| m.as_str()).unwrap_or("");
            let changed = header
                .path()
                .is_some_and(|path| path.as_str() == "/org/nidara/Bluetooth")
                && header
                    .interface()
                    .is_some_and(|iface| iface.as_str() == "org.nidara.Bluetooth1")
                && member == "Updated";
            let owner = member == "NameOwnerChanged"
                && message
                    .body()
                    .deserialize::<(String, String, String)>()
                    .is_ok_and(|(name, _, _)| name == "org.nidara.Bluetooth");
            if changed || owner {
                let _ = bluetooth.refresh().await;
            }
        }
    });
    let compositor = p.clone();
    tokio::spawn(async move {
        loop {
            if let Some(socket) = crate::hyalo::socket()
                && let Ok(mut stream) = tokio::net::UnixStream::connect(socket).await
            {
                use tokio::io::{AsyncBufReadExt, AsyncWriteExt};
                let _ = stream.write_all(b"{\"request\":\"event_stream\"}\n").await;
                let mut lines = tokio::io::BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if [
                        "config_reloaded",
                        "outputs_changed",
                        "lock_changed",
                        "power_state_changed",
                        "idle_inhibitors_changed",
                    ]
                    .iter()
                    .any(|event| line.contains(event))
                    {
                        let _ = compositor.refresh().await;
                    }
                }
            }
            {
                let mut state = compositor.state.write().unwrap();
                let provider = state.providers.entry("hyalo").or_default();
                if !provider.owner.is_empty() {
                    provider.owner.clear();
                    provider.epoch = compositor.serial.fetch_add(1, Ordering::Relaxed);
                    state.lid_sequence += 1;
                    state.last_lid = None;
                }
            }
            *compositor.key_fd.lock().await = None;
            *compositor.lid_fd.lock().await = None;
            tokio::time::sleep(Duration::from_secs(2)).await;
            let _ = compositor.refresh().await;
        }
    });
    tokio::spawn(async move {
        let mut ready_tx = Some(ready_tx);
        loop {
            let system = match Connection::system().await {
                Ok(c) => c,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                    continue;
                }
            };
            *p.system.write().unwrap() = Some(system.clone());
            let subscribe = async {
                let mut stream = futures_util::stream::SelectAll::new();
                for (name, namespace) in [
                    (UP, UP_PATH),
                    (PPD, PPD_PATH),
                    ("org.freedesktop.login1", LOGIN_PATH),
                ] {
                    let rule = zbus::MatchRule::builder()
                        .msg_type(zbus::message::Type::Signal)
                        .sender(name)?
                        .path_namespace(namespace)?
                        .build();
                    stream
                        .push(zbus::MessageStream::for_match_rule(rule, &system, Some(128)).await?);
                    let rule = zbus::MatchRule::builder()
                        .msg_type(zbus::message::Type::Signal)
                        .sender("org.freedesktop.DBus")?
                        .interface("org.freedesktop.DBus")?
                        .member("NameOwnerChanged")?
                        .add_arg(name)?
                        .build();
                    stream
                        .push(zbus::MessageStream::for_match_rule(rule, &system, Some(16)).await?);
                }
                Ok::<_, zbus::Error>(stream)
            }
            .await;
            let Ok(mut stream) = subscribe else {
                continue;
            };
            let _ = p.refresh().await;
            if let Some(tx) = ready_tx.take() {
                let _ = tx.send(());
            }
            while let Some(Ok(msg)) = stream.next().await {
                let header = msg.header();
                let member = header.member().map(|s| s.as_str()).unwrap_or("");
                let sender = header.sender().map(|s| s.as_str()).unwrap_or("");
                let ours = p
                    .state
                    .read()
                    .unwrap()
                    .providers
                    .values()
                    .any(|v| v.owner == sender);
                let names = member == "NameOwnerChanged"
                    && msg
                        .body()
                        .deserialize::<(String, String, String)>()
                        .is_ok_and(|(name, _, _)| {
                            [UP, PPD, "org.freedesktop.login1"].contains(&name.as_str())
                        });
                if !ours && !names {
                    continue;
                }
                let ppd_sender = p
                    .state
                    .read()
                    .unwrap()
                    .providers
                    .get("ppd")
                    .is_some_and(|v| v.owner == sender);
                let up_sender = p
                    .state
                    .read()
                    .unwrap()
                    .providers
                    .get("upower")
                    .is_some_and(|v| v.owner == sender);
                if member == "DeviceRemoved"
                    && up_sender
                    && let Ok((raw,)) = msg.body().deserialize::<(Path,)>()
                {
                    let _guard = p.updates.lock().await;
                    let mut state = p.state.write().unwrap();
                    let keys = state
                        .objects
                        .values()
                        .filter(|o| o.provider == "upower" && o.raw == raw.as_str())
                        .map(|o| o.path.clone())
                        .collect::<Vec<_>>();
                    state.retired.extend(keys);
                }
                if member == "ProfileReleased"
                    && ppd_sender
                    && let Ok((cookie,)) = msg.body().deserialize::<(u32,)>()
                {
                    let removed = {
                        let mut state = p.state.write().unwrap();
                        let epoch = state.providers.get("ppd").map_or(0, |p| p.epoch);
                        state.released.insert((epoch, cookie));
                        let own_release = state.releasing.remove(&(epoch, cookie));
                        let holds = state
                            .holds
                            .values()
                            .filter(|h| h.cookie == cookie)
                            .cloned()
                            .collect::<Vec<_>>();
                        for h in &holds {
                            state.holds.remove(&h.path);
                            if h.automatic && !own_release {
                                state.policy.manual_override();
                            }
                        }
                        holds
                    };
                    for h in removed {
                        let _ = p
                            .conn
                            .emit_signal(
                                Some(h.owner.as_str()),
                                h.path.as_str(),
                                "org.nidara.PowerProfileHold1",
                                "Ended",
                                &("manual-profile-change",),
                            )
                            .await;
                    }
                    p.persist().await;
                }
                if member == "BrightnessChangedWithSource"
                    && up_sender
                    && let Ok((value, source)) = msg.body().deserialize::<(i32, String)>()
                    && let Some(raw) = header.path()
                {
                    let keys = {
                        let mut state = p.state.write().unwrap();
                        state
                            .objects
                            .values_mut()
                            .filter(|o| o.kind == "keyboard" && o.raw == raw.as_str())
                            .map(|o| {
                                o.props["LastChangeSource"] = json!(source);
                                o.path.clone()
                            })
                            .collect::<Vec<_>>()
                    };
                    for key in keys {
                        let _ = p
                            .conn
                            .emit_signal(
                                None::<&str>,
                                ROOT,
                                "org.nidara.Power1",
                                "KeyboardBrightnessChanged",
                                &(path(&key), value, source.clone()),
                            )
                            .await;
                    }
                }
                let _ = p.refresh().await;
            }
            *p.system.write().unwrap() = None;
            {
                let mut state = p.state.write().unwrap();
                for provider in state.providers.values_mut() {
                    provider.owner.clear();
                    provider.epoch = p.serial.fetch_add(1, Ordering::Relaxed);
                }
                state.holds.clear();
                state.policy.hold_failed();
            }
            *p.key_fd.lock().await = None;
            *p.lid_fd.lock().await = None;
            let _ = p.refresh().await;
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    });
    Ok(ready_rx)
}

async fn deduplicate(p: &Power, objects: &mut BTreeMap<String, Object>) {
    let Ok(proxy) = Proxy::new(
        &p.conn,
        "org.nidara.Bluetooth",
        "/org/nidara/Bluetooth",
        "org.nidara.Bluetooth1",
    )
    .await
    else {
        return;
    };
    let Ok((_, _, snapshot)) =
        bounded(proxy.call::<_, _, (u64, u64, String)>("Snapshot", &())).await
    else {
        return;
    };
    let Ok(snapshot) = serde_json::from_str::<Json>(&snapshot) else {
        return;
    };
    let devices = snapshot["devices"].as_array().cloned().unwrap_or_default();
    for object in objects
        .values_mut()
        .filter(|o| o.kind == "device" && o.props["Role"] == "peripheral")
    {
        link_bluetooth(&mut object.props, &devices);
    }
}
fn link_bluetooth(props: &mut Json, devices: &[Json]) {
    let native = props["NativePath"].as_str().unwrap_or("");
    let serial = props["Serial"].as_str().unwrap_or("");
    let address = normalize_address(serial).or_else(|| normalize_address(native));
    let matches = devices
        .iter()
        .filter(|d| {
            d["path"].as_str() == Some(native)
                || address.as_ref().is_some_and(|a| {
                    normalize_address(d["address"].as_str().unwrap_or("")).as_ref() == Some(a)
                })
        })
        .collect::<Vec<_>>();
    if matches.len() == 1 {
        props["BluetoothDevicePath"] = matches[0]["path"].clone();
        props["BatteryOwner"] = json!("bluetooth1");
        props["DeduplicationState"] = json!("linked");
    } else if matches.len() > 1 {
        props["DeduplicationState"] = json!("unresolved");
    }
}
fn normalize_address(raw: &str) -> Option<String> {
    let parts = raw.split(':').collect::<Vec<_>>();
    (parts.len() == 6
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.bytes().all(|b| b.is_ascii_hexdigit())))
    .then(|| raw.to_ascii_uppercase())
}
async fn peripheral_alerts(p: &Power) {
    if p.read_only {
        return;
    }
    let alerts = {
        let mut state = p.state.write().unwrap();
        let devices = state
            .objects
            .values()
            .filter(|o| {
                o.kind == "device"
                    && o.props["Role"] == "peripheral"
                    && o.props["BatteryOwner"] == "power1"
            })
            .cloned()
            .collect::<Vec<_>>();
        let mut alerts = Vec::new();
        for o in devices {
            let battery = Battery {
                present: o.props["Present"].as_bool().unwrap_or(false),
                on_battery: Some(!matches!(o.props["State"].as_u64(), Some(1 | 4))),
                percentage: (o.props["WarningLevel"].as_u64().unwrap_or(0) == 0
                    && o.props["PercentageKnown"].as_bool().unwrap_or(false))
                .then(|| o.props["Percentage"].as_f64())
                .flatten(),
                warning: o.props["WarningLevel"].as_u64().unwrap_or(0) as u32,
                ..Default::default()
            };
            let effects = state
                .peripheral
                .entry(o.path.clone())
                .or_default()
                .update(&battery, false);
            if effects.contains(&Effect::Low) {
                alerts.push((o.path.clone(), false, battery.percentage));
            }
            if effects.contains(&Effect::Critical) {
                alerts.push((o.path, true, battery.percentage));
            }
        }
        alerts
    };
    for (path, critical, pct) in alerts {
        p.notify(&path, critical, pct).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bluetooth_matching_requires_a_unique_actual_identity() {
        let devices = vec![
            json!({"path": "/org/bluez/hci0/dev_AA","address": "AA:BB:CC:DD:EE:FF","name": "Mouse"}),
        ];
        let mut props = json!({"NativePath": "Mouse","Serial": "Mouse"});
        link_bluetooth(&mut props, &devices);
        assert!(props["BluetoothDevicePath"].is_null());
        props["Serial"] = json!("aa:bb:cc:dd:ee:ff");
        link_bluetooth(&mut props, &devices);
        assert_eq!(props["BatteryOwner"], "bluetooth1");
        let mut ambiguous = json!({"Serial": "AA:BB:CC:DD:EE:FF"});
        link_bluetooth(&mut ambiguous, &[devices[0].clone(), devices[0].clone()]);
        assert_eq!(ambiguous["DeduplicationState"], "unresolved");
        let mut path = json!({"NativePath": "/org/bluez/hci0/dev_AA"});
        link_bluetooth(&mut path, &devices);
        assert_eq!(path["BatteryOwner"], "bluetooth1");
    }
    #[test]
    fn absent_health_and_cycles_are_unknown_and_not_fabricated() {
        let p = device_props(&Props::new(), false);
        assert_eq!(p["HealthKnown"], false);
        assert_eq!(p["Cycles"], -1);
        assert_eq!(p["PercentageKnown"], false);
    }
}
