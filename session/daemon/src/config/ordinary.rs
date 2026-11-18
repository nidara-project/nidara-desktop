// SPDX-License-Identifier: GPL-3.0-or-later
//! #1103 7b. Same homes and canonical values as config-entries.ts; no second writer.
use super::*;
use std::{collections::BTreeMap, io::Read};

pub(super) fn at<'a>(input: &'a Json, path: &str) -> &'a Json {
    path.split('.').fold(input, |node, part| &node[part])
}
pub(super) fn input_paths(name: &str) -> Option<&'static [&'static str]> {
    Some(match name {
        "input.mouse.speed" => &["pointer.accel_speed", "touchpad.accel_speed"],
        "input.mouse.accel" => &["pointer.accel_profile", "touchpad.accel_profile"],
        "input.mouse.natural" => &["pointer.natural_scroll"],
        "input.touchpad.natural" => &["touchpad.natural_scroll"],
        "input.touchpad.tap" => &["touchpad.tap"],
        "input.keyboard.layout" => &["keyboard.layout", "keyboard.variant"],
        "input.keyboard.numlock" => &["keyboard.numlock"],
        "input.keyboard.repeatDelay" => &["keyboard.repeat_delay"],
        "input.keyboard.repeatRate" => &["keyboard.repeat_rate"],
        _ => return None,
    })
}
pub(super) fn input_available(st: &Store, key: &Key, paths: &[&str]) -> bool {
    let input = st.input.borrow();
    (key.name != "input.keyboard.layout" || !keyboards().is_empty())
        && paths.iter().all(|path| {
            let value = at(&input, path);
            match key.kind {
                Kind::Boolean => value.is_boolean(),
                Kind::Number { .. } => value.is_number(),
                _ => value.is_string(),
            }
        })
}
fn input_value(st: &Store, name: &str) -> Value {
    let input = st.input.borrow();
    let paths = input_paths(name).unwrap();
    let value = at(&input, paths[0]);
    if name == "input.keyboard.layout" {
        let layout = value.as_str().unwrap_or_default();
        let variant = at(&input, paths[1]).as_str().unwrap_or_default();
        Value::Text(if variant.is_empty() {
            layout.into()
        } else {
            format!("{layout}-{variant}")
        })
    } else if let Some(b) = value.as_bool() {
        Value::Bool(b)
    } else if let Some(n) = value.as_f64() {
        Value::Number(n)
    } else {
        Value::Text(value.as_str().unwrap_or_default().into())
    }
}
fn input_patch(name: &str, value: &Value) -> Json {
    let mut input = json!({});
    for (index, path) in input_paths(name).unwrap().iter().enumerate() {
        let (section, field) = path.split_once('.').unwrap();
        if input[section].is_null() {
            input[section] = json!({});
        }
        input[section][field] = if name == "input.keyboard.layout" {
            let (layout, variant) = text(value).split_once('-').unwrap_or((text(value), ""));
            json!(if index == 0 { layout } else { variant })
        } else if matches!(
            name,
            "input.keyboard.repeatDelay" | "input.keyboard.repeatRate"
        ) {
            json!(match value {
                Value::Number(n) => n.round() as i32,
                _ => unreachable!(),
            })
        } else {
            value.json()
        };
    }
    input
}
fn put_input(st: &Store, name: &str, value: &Value) -> Result<(), String> {
    let patch = input_patch(name, value);
    let result = crate::hyalo::request(json!({"request":"settings","patch":{"input":patch}}));
    *st.input.borrow_mut() = read_compositor()["input"].clone();
    // The existing monitor may have captured its request before this write.
    st.idle_serial
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    result?;
    if !input_paths(name)
        .unwrap()
        .iter()
        .all(|path| at(&st.input.borrow(), path) == at(&patch, path))
    {
        return Err("input setting unavailable or overridden by user configuration".into());
    }
    Ok(())
}
/// Same IDs as ui/lib/keyboards.ts: base layout + first '-' + possibly hyphenated variant.
/// The console bridge is deliberately outside this graphical-only catalogue.
fn parse_keyboards(raw: &str) -> Vec<(String, String)> {
    let mut section = "";
    let mut result = BTreeMap::new();
    for line in raw.lines() {
        if line.starts_with('!') {
            section = line.trim();
            continue;
        }
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((code, rest)) = line.split_once(char::is_whitespace) else {
            continue;
        };
        let rest = rest.trim();
        match section {
            "! layout" if code != "custom" => {
                result.insert(code.into(), rest.into());
            }
            "! variant" => {
                if let Some((layout, label)) = rest.split_once(':') {
                    result.insert(format!("{}-{code}", layout.trim()), label.trim().into());
                }
            }
            _ => {}
        }
        if result.len() > 16384 {
            return vec![];
        }
    }
    result.into_iter().collect()
}
fn keyboards() -> &'static Vec<(String, String)> {
    static CATALOGUE: OnceLock<Vec<(String, String)>> = OnceLock::new();
    CATALOGUE.get_or_init(|| {
        let mut bytes = Vec::new();
        let Ok(file) = std::fs::File::open("/usr/share/X11/xkb/rules/base.lst") else {
            return vec![];
        };
        if file.take(1024 * 1024 + 1).read_to_end(&mut bytes).is_err() || bytes.len() > 1024 * 1024
        {
            return vec![];
        }
        std::str::from_utf8(&bytes)
            .map(parse_keyboards)
            .unwrap_or_default()
    })
}
fn key(
    name: &'static str,
    desc: &'static str,
    kind: Kind,
    get: fn(&Store) -> Value,
    set: Write,
    ui: fn(&Store) -> Json,
) -> Key {
    Key {
        name,
        desc,
        kind,
        writable: true,
        needs: &[],
        values: None,
        catalogue: None,
        validate: None,
        get,
        set: Some(set),
        ui: Some(ui),
        watch: &[],
        file: false,
    }
}
fn number(min: f64, max: f64) -> Kind {
    Kind::Number { min, max }
}
fn toggle(i18n: &str) -> Json {
    json!({"control":"toggle","i18n":i18n})
}
fn slider(i18n: &str, options: Json) -> Json {
    json!({"control":"slider","i18n":i18n,"slider":options})
}
fn named(i18n: &str, values: &[&str]) -> Json {
    json!({"control":"dropdown","i18n":i18n,"options":options_named(&owned(values))})
}
pub(super) fn keys() -> Vec<Key> {
    let mut dnd = key(
        "notifications.doNotDisturb",
        "Do Not Disturb: suppress notification popups (critical ones still show). Persists across sessions until turned off.",
        Kind::Boolean,
        |s| Value::Bool(s.s(NOTIFICATIONS).boolean("do-not-disturb")),
        |s, v| put_bool(s, NOTIFICATIONS, "do-not-disturb", v),
        |_| toggle("settings.notif.dnd"),
    );
    dnd.needs = &[NOTIFICATIONS];
    dnd.watch = &[(NOTIFICATIONS, "do-not-disturb")];
    let mut timeout = key(
        "notifications.popupTimeout",
        "Seconds a notification popup stays on screen.",
        number(2., 15.),
        |s| Value::Number(s.s(NOTIFICATIONS).int("popup-timeout") as f64),
        |s, v| put_int(s, NOTIFICATIONS, "popup-timeout", v),
        |_| slider("settings.notif.timeout", json!({"unit":"s"})),
    );
    timeout.needs = &[NOTIFICATIONS];
    timeout.watch = &[(NOTIFICATIONS, "popup-timeout")];
    let mut scale = key(
        "accessibility.textScale",
        "Text scale factor (0.75 to 1.50).",
        number(0.75, 1.5),
        |s| Value::Number(s.s(INTERFACE).double("text-scaling-factor")),
        |s, v| {
            let Value::Number(n) = v else { unreachable!() };
            s.s(INTERFACE)
                .set_double("text-scaling-factor", (*n * 100.).round() / 100.)
                .map_err(|e| e.to_string())
        },
        |_| {
            slider(
                "settings.accessibility.text-scale",
                json!({"decimals":2,"step":0.05,"commitOnRelease":false}),
            )
        },
    );
    scale.needs = &[INTERFACE];
    scale.watch = &[(INTERFACE, "text-scaling-factor")];
    let mut cursor = key(
        "accessibility.cursorSize",
        "Cursor size in pixels (16 to 96).",
        number(16., 96.),
        |s| Value::Number(s.s(INTERFACE).int("cursor-size") as f64),
        |s, v| put_int(s, INTERFACE, "cursor-size", v),
        |_| {
            slider(
                "settings.accessibility.cursor-size",
                json!({"unit":"px","icons":["nd-preferences-desktop-peripherals","nd-preferences-desktop-peripherals"],"commitOnRelease":true}),
            )
        },
    );
    cursor.needs = &[INTERFACE];
    cursor.watch = &[(INTERFACE, "cursor-size")];
    let mut motion = key(
        "accessibility.reduceMotion",
        "Reduce motion: overlays appear without their pop, dock icons snap instead of springing, and the compositor's window/workspace animations are switched off.",
        Kind::Boolean,
        |s| Value::Bool(!s.s(INTERFACE).boolean("enable-animations")),
        |s, v| {
            put_bool(
                s,
                INTERFACE,
                "enable-animations",
                &Value::Bool(*v != Value::Bool(true)),
            )
        },
        |_| toggle("settings.accessibility.reduce-motion"),
    );
    motion.needs = &[INTERFACE];
    motion.watch = &[(INTERFACE, "enable-animations")];
    let mut accel = key(
        "input.mouse.accel",
        "Pointer acceleration profile: 'adaptive' or 'flat'.",
        Kind::Enum,
        |s| input_value(s, "input.mouse.accel"),
        |s, v| put_input(s, "input.mouse.accel", v),
        |_| named("settings.input.mouse.accel", &["adaptive", "flat"]),
    );
    accel.values = Some(|_| owned(&["adaptive", "flat"]));
    let mut layout = key(
        "input.keyboard.layout",
        "Keyboard layout: an xkb layout code, optionally '-' and a variant — 'us', 'us-colemak', 'de-nodeadkeys'. The whole xkb catalogue is offered (/usr/share/X11/xkb/rules/base.lst). This is the GRAPHICAL layout only: it never touches the text console, which the installer sets.",
        Kind::Enum,
        |s| input_value(s, "input.keyboard.layout"),
        |s, v| put_input(s, "input.keyboard.layout", v),
        |_| json!({"control":"dropdown","i18n":"settings.input.keyboard.layout","options":keyboards().iter().map(|(id,label)|json!({"value":id,"label":label})).collect::<Vec<_>>()}),
    );
    layout.values = Some(|_| keyboards().iter().map(|(id, _)| id.clone()).collect());
    vec![
        dnd,
        timeout,
        scale,
        cursor,
        motion,
        accel,
        layout,
        key(
            "input.mouse.speed",
            "Pointer sensitivity (-1.0 to 1.0).",
            number(-1., 1.),
            |s| input_value(s, "input.mouse.speed"),
            |s, v| put_input(s, "input.mouse.speed", v),
            |_| {
                slider(
                    "settings.input.mouse.speed",
                    json!({"pct":true,"commitOnRelease":true,"icons":["nd-preferences-desktop-peripherals","nd-preferences-desktop-peripherals"]}),
                )
            },
        ),
        key(
            "input.mouse.natural",
            "Invert mouse scroll direction (natural scrolling).",
            Kind::Boolean,
            |s| input_value(s, "input.mouse.natural"),
            |s, v| put_input(s, "input.mouse.natural", v),
            |_| toggle("settings.input.mouse.natural"),
        ),
        key(
            "input.touchpad.natural",
            "Invert touchpad scroll direction (natural scrolling).",
            Kind::Boolean,
            |s| input_value(s, "input.touchpad.natural"),
            |s, v| put_input(s, "input.touchpad.natural", v),
            |_| toggle("settings.input.touchpad.natural"),
        ),
        key(
            "input.touchpad.tap",
            "Tap touchpad to click.",
            Kind::Boolean,
            |s| input_value(s, "input.touchpad.tap"),
            |s, v| put_input(s, "input.touchpad.tap", v),
            |_| toggle("settings.input.touchpad.tap"),
        ),
        key(
            "input.keyboard.numlock",
            "Enable NumLock on boot.",
            Kind::Boolean,
            |s| input_value(s, "input.keyboard.numlock"),
            |s, v| put_input(s, "input.keyboard.numlock", v),
            |_| toggle("settings.input.keyboard.numlock"),
        ),
        key(
            "input.keyboard.repeatDelay",
            "Keyboard repeat delay in milliseconds before repeating keys.",
            number(100., 2000.),
            |s| input_value(s, "input.keyboard.repeatDelay"),
            |s, v| put_input(s, "input.keyboard.repeatDelay", v),
            |_| {
                slider(
                    "settings.input.keyboard.repeat-delay",
                    json!({"unit":"ms","commitOnRelease":true}),
                )
            },
        ),
        key(
            "input.keyboard.repeatRate",
            "Keyboard repeat rate in characters per second.",
            number(1., 100.),
            |s| input_value(s, "input.keyboard.repeatRate"),
            |s, v| put_input(s, "input.keyboard.repeatRate", v),
            |_| {
                slider(
                    "settings.input.keyboard.repeat-rate",
                    json!({"commitOnRelease":true}),
                )
            },
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keyboard_catalogue_keeps_variants_with_hyphens_and_excludes_custom() {
        let catalogue = parse_keyboards(
            "! model\npc105 Keyboard\n! layout\nus English (US)\nde German\ncustom A user-defined custom Layout\n! variant\ncolemak us: English (Colemak)\ndvorak-alt-intl us: Dvorak alternate international\n! option\ngrp:alt_shift_toggle Layout switch\n",
        );
        assert_eq!(catalogue.len(), 4);
        assert!(catalogue.iter().any(|(id, _)| id == "us-dvorak-alt-intl"));
        assert!(
            !catalogue
                .iter()
                .any(|(id, _)| id == "custom" || id.starts_with("grp:"))
        );
        assert_eq!(
            input_patch(
                "input.keyboard.layout",
                &Value::Text("us-dvorak-alt-intl".into())
            ),
            json!({"keyboard":{"layout":"us","variant":"dvorak-alt-intl"}})
        );
        assert_eq!(
            input_patch("input.keyboard.layout", &Value::Text("de".into())),
            json!({"keyboard":{"layout":"de","variant":""}})
        );
    }
    #[test]
    fn unified_pointer_writes_both_kinds_and_rounds_only_integer_fields() {
        assert_eq!(
            input_patch("input.mouse.speed", &Value::Number(0.35)),
            json!({"pointer":{"accel_speed":0.35},"touchpad":{"accel_speed":0.35}})
        );
        assert_eq!(
            input_patch("input.mouse.accel", &Value::Text("flat".into())),
            json!({"pointer":{"accel_profile":"flat"},"touchpad":{"accel_profile":"flat"}})
        );
        assert_eq!(
            input_patch("input.keyboard.repeatDelay", &Value::Number(501.6)),
            json!({"keyboard":{"repeat_delay":502}})
        );
    }
}
