// SPDX-License-Identifier: GPL-3.0-or-later
//! #1103: the Power page's performance profile. Home: power-profiles-daemon's
//! `ActiveProfile`, which TS set with `powerprofilesctl`. Power1 observes such a write as a
//! manual choice (power/README.md), so the automatic saver stands aside as it did for TS.
use super::*;

const NAME: &str = "power.profile";
const PPD: &str = "org.freedesktop.UPower.PowerProfiles";
const PATH: &str = "/org/freedesktop/UPower/PowerProfiles";
const TIMEOUT_MS: i32 = 2000;

fn system() -> Option<gio::DBusConnection> {
    gio::bus_get_sync(gio::BusType::System, gio::Cancellable::NONE).ok()
}

/// `{active, profiles}` read now from PPD, `Null` when there is none to ask.
pub(super) fn read() -> Json {
    let Some(bus) = system() else {
        return Json::Null;
    };
    let Ok(reply) = bus.call_sync(
        Some(PPD),
        PATH,
        "org.freedesktop.DBus.Properties",
        "GetAll",
        Some(&(PPD,).to_variant()),
        None,
        gio::DBusCallFlags::NO_AUTO_START,
        TIMEOUT_MS,
        gio::Cancellable::NONE,
    ) else {
        return Json::Null;
    };
    let Some((props,)) = reply.get::<(HashMap<String, glib::Variant>,)>() else {
        return Json::Null;
    };
    let active = props.get("ActiveProfile").and_then(|v| v.get::<String>());
    let names: Vec<String> = props
        .get("Profiles")
        .and_then(|v| v.get::<Vec<HashMap<String, glib::Variant>>>())
        .unwrap_or_default()
        .iter()
        .filter_map(|p| p.get("Profile").and_then(|v| v.get::<String>()))
        .filter(|n| !n.is_empty())
        .take(16)
        .collect();
    match active {
        Some(active) if !names.is_empty() => json!({"active": active, "profiles": names}),
        _ => Json::Null,
    }
}

/// PPD's changes and its arrival or departure re-read the profile and announce the key.
pub(super) fn watch(changed: impl Fn() + Clone + 'static) {
    let Some(bus) = system() else { return };
    let on_props = changed.clone();
    let props = bus.subscribe_to_signal(
        Some(PPD),
        Some("org.freedesktop.DBus.Properties"),
        Some("PropertiesChanged"),
        Some(PATH),
        None,
        gio::DBusSignalFlags::NONE,
        move |_| on_props(),
    );
    let owner = bus.subscribe_to_signal(
        Some("org.freedesktop.DBus"),
        Some("org.freedesktop.DBus"),
        Some("NameOwnerChanged"),
        Some("/org/freedesktop/DBus"),
        Some(PPD),
        gio::DBusSignalFlags::NONE,
        move |_| changed(),
    );
    // For the daemon's life, on the config thread that owns them.
    SUBSCRIPTIONS.with(|s| s.borrow_mut().extend([props, owner]));
}
thread_local! {
    static SUBSCRIPTIONS: std::cell::RefCell<Vec<gio::SignalSubscription>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn names(st: &Store) -> Vec<String> {
    st.profile.borrow()["profiles"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|n| n.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn put(st: &Store, v: &Value) -> Result<(), String> {
    let name = text(v).to_owned();
    let bus = system().ok_or("system bus unavailable")?;
    let result = bus
        .call_sync(
            Some(PPD),
            PATH,
            "org.freedesktop.DBus.Properties",
            "Set",
            Some(&(PPD, "ActiveProfile", name.to_variant()).to_variant()),
            None,
            gio::DBusCallFlags::NO_AUTO_START,
            TIMEOUT_MS,
            gio::Cancellable::NONE,
        )
        .map(|_| ())
        .map_err(|e| e.to_string());
    *st.profile.borrow_mut() = read();
    result?;
    if st.profile.borrow()["active"] != name.as_str() {
        return Err("profile selection not observed".into());
    }
    Ok(())
}

pub(super) fn keys() -> Vec<Key> {
    vec![Key {
        name: NAME,
        desc: "Performance profile: one of the profiles power-profiles-daemon advertises \
               ('power-saver', 'balanced', 'performance'). Choosing one is a manual choice: \
               the automatic saver stands aside until the next unplug.",
        kind: Kind::Enum,
        writable: true,
        needs: &[],
        values: Some(names),
        catalogue: None,
        validate: None,
        get: |st| {
            Value::Text(
                st.profile.borrow()["active"]
                    .as_str()
                    .unwrap_or_default()
                    .into(),
            )
        },
        set: Some(put),
        ui: Some(|st| {
            let order = ["performance", "balanced", "power-saver"];
            let mut profiles = names(st);
            profiles.sort_by_key(|profile| {
                order
                    .iter()
                    .position(|name| name == profile)
                    .unwrap_or(order.len())
            });
            let options: Vec<_> = profiles
                .iter()
                .map(|profile| {
                    let mut option = json!({
                        "value": profile,
                        "i18n": format!("settings.power.profile.{profile}"),
                    });
                    if order.contains(&profile.as_str()) {
                        option["icon"] = json!(format!("nd-power-profile-{profile}"));
                    }
                    option
                })
                .collect();
            json!({"i18n": "settings.power.group.profile", "control": "listbox", "options": options})
        }),
        watch: &[],
        file: false,
    }]
}

pub(super) fn is_key(name: &str) -> bool {
    name == NAME
}
pub(super) fn available(st: &Store) -> bool {
    !st.profile.borrow().is_null()
}
pub(super) const KEY: &str = NAME;
