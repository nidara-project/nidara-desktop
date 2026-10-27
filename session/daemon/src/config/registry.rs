// SPDX-License-Identifier: GPL-3.0-or-later
//! The settings Config1 serves: each key, its type and validation, where it lives and how to
//! read and write it. The homes are the ones the desktop already uses — GSettings for almost
//! every key (`org.gnome.desktop.*`, `org.nidara.*`), the wallpaper's JSON file — so whoever
//! follows a key (the portal, Hyalo, an app) hears a change from any writer. Nothing here
//! applies a change beyond writing its home; what follows a key is not this file's.
//!
//! The rules are the registry's own (`ui/shell/core/ConfigRegistry.ts`, which the TypeScript
//! shell serves): the same parsing of a raw value per type, the same enum and bounds, the
//! same canonical values, the same schema shape (`Describe`/`Snapshot`). Labels are not
//! here: `ui` names i18n keys, and the client translates them from its own catalogue
//! (toolkit/PHASE1.md D4, one source for strings).
//!
//! Lives on the GLib thread (`store.rs`): a `gio::Settings` is not `Send`.

use gio::prelude::*;
use serde_json::{Value as Json, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Bool(bool),
    Number(f64),
    Text(String),
}
impl Value {
    pub fn json(&self) -> Json {
        match self {
            Value::Bool(b) => json!(b),
            Value::Number(n) => json!(n),
            Value::Text(s) => json!(s),
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Boolean,
    Number { min: f64, max: f64 },
    Enum,
    Text,
}
impl Kind {
    fn name(self) -> &'static str {
        match self {
            Kind::Boolean => "boolean",
            Kind::Number { .. } => "number",
            Kind::Enum => "enum",
            Kind::Text => "string",
        }
    }
}

/// Why a write was refused: the D-Bus error each maps to (`config/mod.rs`).
#[derive(Debug, PartialEq)]
pub enum Refusal {
    Invalid(String),
    Failed(String),
}

type Validate = fn(&str) -> Result<Value, String>;
type Write = fn(&Store, &Value) -> Result<(), String>;

pub struct Key {
    pub name: &'static str,
    desc: &'static str,
    pub kind: Kind,
    writable: bool,
    /// The GSettings schemas it reads: absent → the key is not available here.
    needs: &'static [&'static str],
    values: Option<fn(&Store) -> Vec<String>>,
    catalogue: Option<fn(&Store) -> Vec<String>>,
    /// Text keys: validates and canonicalises the raw value.
    validate: Option<Validate>,
    get: fn(&Store) -> Value,
    set: Option<Write>,
    ui: Option<fn(&Store) -> Json>,
    /// What announces a change: GSettings keys (schema, key), or the wallpaper file.
    pub watch: &'static [(&'static str, &'static str)],
    pub file: bool,
}

const INTERFACE: &str = "org.gnome.desktop.interface";
const WM: &str = "org.gnome.desktop.wm.preferences";
const BACKGROUND: &str = "org.gnome.desktop.background";
const APPEARANCE: &str = "org.nidara.appearance";
const NIGHT: &str = "org.nidara.night-light";
const MEDIA: &str = "org.nidara.media";
const AUDIO: &str = "org.nidara.audio";
const AI: &str = "org.nidara.ai";

/// The GSettings of this session, by schema; a schema not installed is simply absent.
pub struct Store {
    settings: HashMap<&'static str, gio::Settings>,
    schemas: HashMap<&'static str, gio::SettingsSchema>,
    home: PathBuf,
    config: PathBuf,
}
impl Store {
    pub fn new() -> Self {
        let source = gio::SettingsSchemaSource::default();
        let (mut settings, mut schemas) = (HashMap::new(), HashMap::new());
        for id in [
            INTERFACE, WM, BACKGROUND, APPEARANCE, NIGHT, AI, AUDIO, MEDIA,
        ] {
            if let Some(schema) = source.as_ref().and_then(|s| s.lookup(id, true)) {
                settings.insert(id, gio::Settings::new(id));
                schemas.insert(id, schema);
            } else {
                eprintln!("[config] {id}: schema not installed — its keys are unavailable");
            }
        }
        Self {
            settings,
            schemas,
            home: glib::home_dir(),
            config: glib::user_config_dir(),
        }
    }
    pub fn settings(&self, schema: &str) -> Option<&gio::Settings> {
        self.settings.get(schema)
    }
    /// Whether the installed schema has the key: GLib aborts the process on one it lacks
    /// (`accent-color` came with GNOME 47's schemas; an older system has none).
    pub fn has(&self, schema: &str, key: &str) -> bool {
        self.schemas.get(schema).is_some_and(|s| s.has_key(key))
    }
    fn s(&self, schema: &str) -> &gio::Settings {
        // Callers are keys whose `needs` were checked by `available`.
        &self.settings[schema]
    }
    pub fn wallpaper_file(&self) -> PathBuf {
        self.config.join("nidara/wallpaper")
    }
}

fn string(st: &Store, schema: &str, key: &str) -> String {
    st.s(schema).string(key).to_string()
}
fn put_string(st: &Store, schema: &str, key: &str, v: &str) -> Result<(), String> {
    let s = st.s(schema);
    if s.string(key) == v {
        return Ok(());
    }
    s.set_string(key, v).map_err(|e| e.to_string())
}
fn text(v: &Value) -> &str {
    match v {
        Value::Text(s) => s,
        _ => "",
    }
}

// ── The key table ────────────────────────────────────────────────────────────────────────

pub const ACCENTS: &[&str] = &[
    "blue", "teal", "green", "yellow", "orange", "red", "pink", "purple", "slate",
];
pub const TRANSITIONS: &[&str] = &[
    "random", "simple", "fade", "center", "grow", "outer", "wipe", "wave", "left", "right", "top",
    "bottom",
];
const WINDOW_BACKGROUNDS: &[&str] = &["opaque", "tinted", "translucent"];
const SIDES: &[&str] = &["right", "left"];
/// The built-in GTK theme's name, offered though no directory holds it
/// (`ui/lib/nidara-kit/platform/gtk-theme.ts`).
const GTK_BUILTIN_THEME: &str = "Adwaita";

fn options_i18n(values: &[String], prefix: &str) -> Json {
    Json::Array(
        values
            .iter()
            .map(|v| json!({"value": v, "i18n": format!("{prefix}.{v}")}))
            .collect(),
    )
}
fn options_named(values: &[String]) -> Json {
    Json::Array(
        values
            .iter()
            .map(|v| json!({"value": v, "label": v}))
            .collect(),
    )
}
fn owned(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

pub fn keys() -> &'static [Key] {
    static KEYS: OnceLock<Vec<Key>> = OnceLock::new();
    KEYS.get_or_init(table)
}

fn table() -> Vec<Key> {
    vec![
        Key {
            name: "appearance.darkMode",
            desc: "Dark mode (false = light). Propagates to GTK apps and the portal.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[INTERFACE],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(string(st, INTERFACE, "color-scheme") == "prefer-dark"),
            set: Some(|st, v| {
                let dark = *v == Value::Bool(true);
                put_string(
                    st,
                    INTERFACE,
                    "color-scheme",
                    if dark { "prefer-dark" } else { "prefer-light" },
                )
            }),
            ui: Some(|_| json!({"i18n": "settings.appearance.dark-mode", "control": "toggle"})),
            watch: &[(INTERFACE, "color-scheme")],
            file: false,
        },
        Key {
            name: "appearance.accent",
            desc: "Accent color used for active/selected state across the shell and libadwaita apps.",
            kind: Kind::Enum,
            writable: true,
            needs: &[INTERFACE],
            values: Some(|_| owned(ACCENTS)),
            catalogue: None,
            validate: None,
            // Drawn by Settings' own accentPicker: no `ui`.
            get: |st| {
                let a = string(st, INTERFACE, "accent-color");
                Value::Text(if ACCENTS.contains(&a.as_str()) {
                    a
                } else {
                    "blue".into()
                })
            },
            set: Some(|st, v| put_string(st, INTERFACE, "accent-color", text(v))),
            ui: None,
            watch: &[(INTERFACE, "accent-color")],
            file: false,
        },
        Key {
            name: "appearance.windowBackground",
            desc: "Nidara's own windows: opaque; tinted — the colour of what is behind comes through, heavily blurred, subtle; or translucent — less opaque and less blurred, what is behind shows. Ignored (opaque) while accessibility.reduceTransparency is on.",
            kind: Kind::Enum,
            writable: true,
            needs: &[APPEARANCE],
            values: Some(|_| owned(WINDOW_BACKGROUNDS)),
            catalogue: None,
            validate: None,
            get: |st| Value::Text(string(st, APPEARANCE, "window-background")),
            set: Some(|st, v| put_string(st, APPEARANCE, "window-background", text(v))),
            ui: Some(|_| {
                json!({"i18n": "settings.appearance.window-background", "control": "segmented",
                    "options": options_i18n(&owned(WINDOW_BACKGROUNDS), "settings.appearance.window-background")})
            }),
            watch: &[(APPEARANCE, "window-background")],
            file: false,
        },
        Key {
            name: "appearance.windowControls",
            desc: "Which side of a window its controls go on: right (close last) or left (close first). For every window: Hyalo's controls and the buttons of apps that draw their own title bar — all read org.gnome.desktop.wm.preferences button-layout, which this writes.",
            kind: Kind::Enum,
            writable: true,
            needs: &[WM],
            values: Some(|_| owned(SIDES)),
            catalogue: None,
            validate: None,
            get: |st| {
                Value::Text(
                    parse_button_layout(&string(st, WM, "button-layout"))
                        .0
                        .into(),
                )
            },
            set: Some(|st, v| {
                let (_, buttons) = parse_button_layout(&string(st, WM, "button-layout"));
                put_string(
                    st,
                    WM,
                    "button-layout",
                    &format_button_layout(text(v), &buttons),
                )
            }),
            ui: Some(|_| {
                json!({"i18n": "settings.appearance.window-controls", "control": "segmented",
                    "options": options_i18n(&owned(SIDES), "settings.appearance.window-controls")})
            }),
            watch: &[(WM, "button-layout")],
            file: false,
        },
        Key {
            name: "appearance.gtkTheme",
            desc: "GTK theme for THIRD-PARTY apps only — Nidara's own processes load no GTK theme.",
            kind: Kind::Enum,
            writable: true,
            needs: &[INTERFACE],
            values: Some(gtk_themes),
            catalogue: None,
            validate: None,
            get: |st| Value::Text(string(st, INTERFACE, "gtk-theme")),
            set: Some(|st, v| put_string(st, INTERFACE, "gtk-theme", text(v))),
            ui: Some(|st| {
                json!({"i18n": "settings.appearance.gtk-theme", "control": "dropdown",
                "options": options_named(&gtk_themes(st))})
            }),
            watch: &[(INTERFACE, "gtk-theme")],
            file: false,
        },
        Key {
            name: "appearance.iconTheme",
            desc: "System icon theme.",
            kind: Kind::Enum,
            writable: true,
            needs: &[INTERFACE],
            values: Some(icon_themes),
            catalogue: None,
            validate: None,
            get: |st| Value::Text(string(st, INTERFACE, "icon-theme")),
            set: Some(|st, v| put_string(st, INTERFACE, "icon-theme", text(v))),
            ui: Some(|st| {
                json!({"i18n": "settings.appearance.icons", "control": "dropdown",
                "options": options_named(&icon_themes(st))})
            }),
            watch: &[(INTERFACE, "icon-theme")],
            file: false,
        },
        Key {
            name: "appearance.interfaceIconTheme",
            desc: "Icon theme for Nidara's own interface icons (bar, menus, Settings), separate from the app icon theme. 'nidara' = Nidara's own drawings (default). Only themes made for Nidara's icon spec (X-Nidara-Icon-Spec in index.theme) are listed.",
            kind: Kind::Enum,
            writable: true,
            needs: &[APPEARANCE],
            values: Some(interface_icon_themes),
            catalogue: None,
            validate: None,
            // Stored as "" for Nidara's own, which reads the drawings straight from assets/.
            get: |st| {
                let t = string(st, APPEARANCE, "interface-icon-theme");
                Value::Text(if t.is_empty() { "nidara".into() } else { t })
            },
            set: Some(|st, v| {
                let t = text(v);
                put_string(
                    st,
                    APPEARANCE,
                    "interface-icon-theme",
                    if t == "nidara" { "" } else { t },
                )
            }),
            ui: Some(|st| {
                let options: Vec<Json> = interface_icon_themes(st)
                    .into_iter()
                    .map(|v| {
                        if v == "nidara" {
                            json!({"value": v, "i18n": "settings.appearance.interface-icons.opt.nidara"})
                        } else {
                            json!({"value": v, "label": v})
                        }
                    })
                    .collect();
                json!({"i18n": "settings.appearance.interface-icons", "control": "dropdown", "options": options})
            }),
            watch: &[(APPEARANCE, "interface-icon-theme")],
            file: false,
        },
        Key {
            name: "appearance.cursorTheme",
            desc: "System cursor theme.",
            kind: Kind::Enum,
            writable: true,
            needs: &[INTERFACE],
            values: Some(cursor_themes),
            catalogue: None,
            validate: None,
            get: |st| Value::Text(string(st, INTERFACE, "cursor-theme")),
            set: Some(|st, v| put_string(st, INTERFACE, "cursor-theme", text(v))),
            ui: Some(|st| {
                json!({"i18n": "settings.appearance.cursor", "control": "dropdown",
                "options": options_named(&cursor_themes(st))})
            }),
            watch: &[(INTERFACE, "cursor-theme")],
            file: false,
        },
        Key {
            name: "appearance.interfaceFont",
            desc: "The interface font as a Pango description, \"Family [Style] Size\" in points (unscaled: the text scale applies on top), as org.gnome.desktop.interface stores it. A family the system does not have is refused.",
            kind: Kind::Text,
            writable: true,
            needs: &[INTERFACE],
            values: None,
            catalogue: None,
            validate: Some(valid_font),
            get: |st| Value::Text(string(st, INTERFACE, "font-name")),
            set: Some(|st, v| put_string(st, INTERFACE, "font-name", text(v))),
            ui: None,
            watch: &[(INTERFACE, "font-name")],
            file: false,
        },
        Key {
            name: "appearance.monoFont",
            desc: "The monospace font as a Pango description, \"Family [Style] Size\" in points (unscaled), as org.gnome.desktop.interface stores it. A family the system does not have is refused.",
            kind: Kind::Text,
            writable: true,
            needs: &[INTERFACE],
            values: None,
            catalogue: None,
            validate: Some(valid_font),
            get: |st| Value::Text(string(st, INTERFACE, "monospace-font-name")),
            set: Some(|st, v| put_string(st, INTERFACE, "monospace-font-name", text(v))),
            ui: None,
            watch: &[(INTERFACE, "monospace-font-name")],
            file: false,
        },
        Key {
            name: "wallpaper.transition",
            desc: "Wallpaper transition animation style.",
            kind: Kind::Enum,
            writable: true,
            needs: &[],
            values: Some(|_| owned(TRANSITIONS)),
            catalogue: None,
            validate: None,
            get: |st| {
                let t = read_wallpaper(st)["transition"]
                    .as_str()
                    .unwrap_or("random")
                    .to_owned();
                Value::Text(t)
            },
            set: Some(|st, v| write_wallpaper(st, |c| c["transition"] = json!(text(v)))),
            ui: Some(|_| {
                json!({"i18n": "settings.appearance.transition", "control": "dropdown",
                "options": options_i18n(&owned(TRANSITIONS), "wallpaper.transition")})
            }),
            watch: &[],
            file: true,
        },
        Key {
            name: "wallpaper.current",
            desc: "The wallpaper image: an absolute path (or file:// URI) to a JPEG, PNG, GIF, WebP or AVIF file. The bundled wallpapers are offered in `catalogue`; any readable image of those types is accepted.",
            kind: Kind::Text,
            writable: true,
            needs: &[],
            values: None,
            catalogue: Some(bundled_wallpapers),
            validate: Some(valid_wallpaper),
            get: |st| Value::Text(read_wallpaper(st)["path"].as_str().unwrap_or("").to_owned()),
            set: Some(|st, v| {
                let path = text(v).to_owned();
                write_wallpaper(st, |c| c["path"] = json!(path))?;
                // GNOME's own key follows, for the apps that read it.
                if let (Some(bg), Some(uri)) =
                    (st.settings(BACKGROUND), file_uri(Path::new(text(v))))
                {
                    for k in ["picture-uri", "picture-uri-dark"] {
                        if !st.has(BACKGROUND, k) {
                            continue;
                        }
                        if bg.string(k) != uri.as_str() {
                            bg.set_string(k, &uri).map_err(|e| e.to_string())?;
                        }
                    }
                }
                Ok(())
            }),
            ui: None,
            watch: &[],
            file: true,
        },
        Key {
            name: "nightlight.enabled",
            desc: "Blue-light filter.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[NIGHT],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(NIGHT).boolean("enabled")),
            set: Some(|st, v| {
                st.s(NIGHT)
                    .set_boolean("enabled", *v == Value::Bool(true))
                    .map_err(|e| e.to_string())
            }),
            ui: Some(|_| json!({"i18n": "settings.appearance.night-light", "control": "toggle"})),
            watch: &[(NIGHT, "enabled")],
            file: false,
        },
        Key {
            name: "nightlight.temperature",
            desc: "Night light color temperature in Kelvin (lower = warmer).",
            kind: Kind::Number {
                min: 2700.,
                max: 6500.,
            },
            writable: true,
            needs: &[NIGHT],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Number(st.s(NIGHT).int("temperature") as f64),
            // Whole kelvins: the canonical value Apply answers.
            set: Some(|st, v| {
                let Value::Number(k) = v else {
                    return Err("not a number".into());
                };
                st.s(NIGHT)
                    .set_int("temperature", k.round() as i32)
                    .map_err(|e| e.to_string())
            }),
            ui: Some(|_| {
                json!({"i18n": "settings.appearance.night-light-temp", "control": "slider",
                // Live: the screen warms with the thumb.
                "slider": {"unit": "K", "icons": ["nd-value-decrease", "nd-value-increase"], "debounce": 0}})
            }),
            watch: &[(NIGHT, "temperature")],
            file: false,
        },
        Key {
            name: "nightlight.scheduleEnabled",
            desc: "Enable automatic night light schedule by time.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[NIGHT],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(NIGHT).boolean("schedule-enabled")),
            set: Some(|st, v| {
                st.s(NIGHT)
                    .set_boolean("schedule-enabled", *v == Value::Bool(true))
                    .map_err(|e| e.to_string())
            }),
            ui: Some(
                |_| json!({"i18n": "settings.appearance.night-light-schedule", "control": "toggle"}),
            ),
            watch: &[(NIGHT, "schedule-enabled")],
            file: false,
        },
        Key {
            name: "nightlight.scheduleFrom",
            desc: "Night light schedule: when it turns on, as HH:MM (24 h). Used while nightlight.scheduleEnabled is on.",
            kind: Kind::Text,
            writable: true,
            needs: &[NIGHT],
            values: None,
            catalogue: None,
            validate: Some(valid_time),
            get: |st| Value::Text(string(st, NIGHT, "schedule-from")),
            set: Some(|st, v| put_string(st, NIGHT, "schedule-from", text(v))),
            ui: None,
            watch: &[(NIGHT, "schedule-from")],
            file: false,
        },
        Key {
            name: "nightlight.scheduleTo",
            desc: "Night light schedule: when it turns off, as HH:MM (24 h). Used while nightlight.scheduleEnabled is on.",
            kind: Kind::Text,
            writable: true,
            needs: &[NIGHT],
            values: None,
            catalogue: None,
            validate: Some(valid_time),
            get: |st| Value::Text(string(st, NIGHT, "schedule-to")),
            set: Some(|st, v| put_string(st, NIGHT, "schedule-to", text(v))),
            ui: None,
            watch: &[(NIGHT, "schedule-to")],
            file: false,
        },
        Key {
            name: "accessibility.reduceTransparency",
            desc: "Reduce transparency: every glass surface — bar, panels, dock, menus, Nidara's windows, the lock screen and the login screen — becomes solid.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[APPEARANCE],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(APPEARANCE).boolean("reduce-transparency")),
            set: Some(|st, v| {
                st.s(APPEARANCE)
                    .set_boolean("reduce-transparency", *v == Value::Bool(true))
                    .map_err(|e| e.to_string())
            }),
            ui: Some(
                |_| json!({"i18n": "settings.accessibility.reduce-transparency", "control": "toggle"}),
            ),
            watch: &[(APPEARANCE, "reduce-transparency")],
            file: false,
        },
        Key {
            name: "media.lock-screen-controls",
            desc: "Native session media preference.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[MEDIA],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(MEDIA).boolean("lock-screen-controls")),
            set: Some(|st, v| {
                st.s(MEDIA)
                    .set_boolean("lock-screen-controls", *v == Value::Bool(true))
                    .map_err(|e| e.to_string())
            }),
            ui: None,
            watch: &[(MEDIA, "lock-screen-controls")],
            file: false,
        },
        Key {
            name: "media.pause-on-headphones-disconnect",
            desc: "Native session media preference.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[MEDIA],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(MEDIA).boolean("pause-on-headphones-disconnect")),
            set: Some(|st, v| {
                st.s(MEDIA)
                    .set_boolean("pause-on-headphones-disconnect", *v == Value::Bool(true))
                    .map_err(|e| e.to_string())
            }),
            ui: None,
            watch: &[(MEDIA, "pause-on-headphones-disconnect")],
            file: false,
        },
        Key {
            name: "audio.overamplification",
            desc: "Native session audio preference.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[AUDIO],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(AUDIO).boolean("overamplification")),
            set: Some(|st, v| {
                st.s(AUDIO)
                    .set_boolean("overamplification", *v == Value::Bool(true))
                    .map_err(|e| e.to_string())
            }),
            ui: None,
            watch: &[(AUDIO, "overamplification")],
            file: false,
        },
        Key {
            name: "audio.alerts-enabled",
            desc: "Native session audio preference.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[AUDIO],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(AUDIO).boolean("alerts-enabled")),
            set: Some(|st, v| {
                st.s(AUDIO)
                    .set_boolean("alerts-enabled", *v == Value::Bool(true))
                    .map_err(|e| e.to_string())
            }),
            ui: None,
            watch: &[(AUDIO, "alerts-enabled")],
            file: false,
        },
        Key {
            name: "audio.volume-feedback",
            desc: "Native session audio preference.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[AUDIO],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(AUDIO).boolean("volume-feedback")),
            set: Some(|st, v| {
                st.s(AUDIO)
                    .set_boolean("volume-feedback", *v == Value::Bool(true))
                    .map_err(|e| e.to_string())
            }),
            ui: None,
            watch: &[(AUDIO, "volume-feedback")],
            file: false,
        },
        Key {
            name: "audio.switch-on-connect",
            desc: "Native session audio preference.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[AUDIO],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(AUDIO).boolean("switch-on-connect")),
            set: Some(|st, v| {
                st.s(AUDIO)
                    .set_boolean("switch-on-connect", *v == Value::Bool(true))
                    .map_err(|e| e.to_string())
            }),
            ui: None,
            watch: &[(AUDIO, "switch-on-connect")],
            file: false,
        },
        Key {
            name: "audio.alert-volume",
            desc: "Native session audio preference.",
            kind: Kind::Number { min: 0.0, max: 1.0 },
            writable: true,
            needs: &[AUDIO],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Number(st.s(AUDIO).double("alert-volume")),
            set: Some(|st, v| {
                let Value::Number(n) = v else {
                    return Err("expected number".into());
                };
                st.s(AUDIO)
                    .set_double("alert-volume", *n)
                    .map_err(|e| e.to_string())
            }),
            ui: None,
            watch: &[(AUDIO, "alert-volume")],
            file: false,
        },
        Key {
            name: "ai.allowConfigWrite",
            desc: "Whether agents may change settings via setConfig. Toggle it in Settings → AI.",
            kind: Kind::Boolean,
            // The gate itself: never through this door.
            writable: false,
            needs: &[AI],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(AI).boolean("allow-config-write")),
            set: None,
            ui: Some(|_| json!({"i18n": "settings.ai.allow-config-write", "control": "toggle"})),
            watch: &[(AI, "allow-config-write")],
            file: false,
        },
    ]
}

// ── The registry's rules ─────────────────────────────────────────────────────────────────

pub fn find(name: &str) -> Option<&'static Key> {
    keys().iter().find(|k| k.name == name)
}
pub fn available(st: &Store, key: &Key) -> bool {
    key.needs.iter().all(|s| st.settings(s).is_some())
        && key.watch.iter().all(|(schema, k)| st.has(schema, k))
}
pub fn get(st: &Store, key: &Key) -> Value {
    (key.get)(st)
}
fn writable(key: &Key) -> bool {
    key.writable && key.set.is_some()
}
/// Whether agents may write (`ai.allowConfigWrite`); the native Settings is not asked.
pub fn agents_may_write(st: &Store) -> bool {
    st.has(AI, "allow-config-write") && st.s(AI).boolean("allow-config-write")
}

/// The raw text of a value as the registry parses it (`setConfigValue(key, String(v))`).
pub fn parse(st: &Store, key: &Key, raw: &str) -> Result<Value, String> {
    match key.kind {
        Kind::Boolean => match raw.to_lowercase().as_str() {
            "true" | "on" | "1" | "yes" => Ok(Value::Bool(true)),
            "false" | "off" | "0" | "no" => Ok(Value::Bool(false)),
            _ => Err(format!("expected a boolean (true/false), got: {raw}")),
        },
        Kind::Number { min, max } => {
            let n: f64 = raw
                .trim()
                .parse()
                .map_err(|_| format!("expected a number, got: {raw}"))?;
            if !n.is_finite() {
                return Err(format!("expected a number, got: {raw}"));
            }
            if n < min {
                return Err(format!("{n} is below the minimum ({min})"));
            }
            if n > max {
                return Err(format!("{n} is above the maximum ({max})"));
            }
            Ok(Value::Number(n))
        }
        Kind::Enum => {
            let values = key.values.map(|f| f(st)).unwrap_or_default();
            if values.iter().any(|v| v == raw) {
                Ok(Value::Text(raw.into()))
            } else {
                Err(format!(
                    "invalid value: {raw} — valid: {}",
                    values.join(", ")
                ))
            }
        }
        Kind::Text => match key.validate {
            Some(f) => f(raw),
            None => Ok(Value::Text(raw.into())),
        },
    }
}

/// Validated and written; the value in force after it.
pub fn set(st: &Store, name: &str, raw: &str) -> Result<Value, Refusal> {
    let key = find(name)
        .filter(|k| available(st, k))
        .ok_or_else(|| Refusal::Invalid(format!("unknown key: {name} — try `describeConfig`")))?;
    if !writable(key) {
        return Err(Refusal::Invalid(format!(
            "read-only key: {name} (changeable only from the Settings window)"
        )));
    }
    let value = parse(st, key, raw)
        .map_err(|e| Refusal::Invalid(format!("invalid value for {name}: {e}")))?;
    (key.set.expect("writable"))(st, &value)
        .map_err(|e| Refusal::Failed(format!("error applying {name}: {e}")))?;
    Ok(get(st, key))
}

/// `Describe`/`Snapshot`'s schema: every key, available or not, with its value, its enum
/// re-read now (a theme installed meanwhile appears), its catalogue and how to draw it.
pub fn describe(st: &Store) -> Json {
    let mut out = serde_json::Map::new();
    for key in keys() {
        let available = available(st, key);
        let mut e = json!({"desc": key.desc, "type": key.kind.name(), "writable": writable(key),
            "available": available});
        if let Kind::Number { min, max } = key.kind {
            e["min"] = json!(min);
            e["max"] = json!(max);
        }
        if available {
            e["value"] = get(st, key).json();
            if let Some(values) = key.values {
                e["values"] = json!(values(st));
            }
            if let Some(catalogue) = key.catalogue {
                e["catalogue"] = json!(catalogue(st));
            }
            if let Some(ui) = key.ui {
                e["ui"] = ui(st);
            }
        }
        out.insert(key.name.into(), e);
    }
    Json::Object(out)
}

// ── Homes and validation ─────────────────────────────────────────────────────────────────

/// `button-layout`'s side and buttons (`core/WindowButtons.ts`).
pub fn parse_button_layout(layout: &str) -> (&'static str, Vec<&'static str>) {
    const OURS: [&str; 3] = ["minimize", "maximize", "close"];
    let (l, r) = layout.split_once(':').unwrap_or((layout, ""));
    let names = |half: &str| -> Vec<&'static str> {
        half.split(',')
            .filter_map(|n| OURS.iter().copied().find(|o| *o == n.trim()))
            .collect()
    };
    let (l, r) = (names(l), names(r));
    let side = if l.contains(&"close") {
        "left"
    } else if r.contains(&"close") {
        "right"
    } else if l.len() > r.len() {
        "left"
    } else {
        "right"
    };
    let buttons = OURS
        .iter()
        .copied()
        .filter(|b| l.contains(b) || r.contains(b))
        .collect();
    (side, buttons)
}
pub fn format_button_layout(side: &str, buttons: &[&str]) -> String {
    let order: &[&str] = if side == "left" {
        &["close", "minimize", "maximize"]
    } else {
        &["minimize", "maximize", "close"]
    };
    let half = order
        .iter()
        .copied()
        .filter(|b| buttons.contains(b))
        .collect::<Vec<_>>()
        .join(",");
    if side == "left" {
        format!("{half}:appmenu")
    } else {
        format!("appmenu:{half}")
    }
}

fn dirs_in(paths: &[PathBuf]) -> Vec<String> {
    let mut out: Vec<String> = paths
        .iter()
        .filter_map(|p| std::fs::read_dir(p).ok())
        .flatten()
        .flatten()
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.file_name().into_string().ok())
        .collect();
    out.sort();
    out.dedup();
    out
}
fn theme_paths(st: &Store) -> Vec<PathBuf> {
    vec![
        "/usr/share/themes".into(),
        st.home.join(".local/share/themes"),
        st.home.join(".themes"),
    ]
}
fn icon_paths(st: &Store) -> Vec<PathBuf> {
    vec![
        "/usr/share/icons".into(),
        st.home.join(".local/share/icons"),
        st.home.join(".icons"),
    ]
}
/// A real GTK4 theme (a `gtk-4.0/`), the built-in under its name, and the configured one.
fn gtk_themes(st: &Store) -> Vec<String> {
    let paths = theme_paths(st);
    let mut themes: Vec<String> = dirs_in(&paths)
        .into_iter()
        .filter(|t| {
            t != GTK_BUILTIN_THEME && paths.iter().any(|p| p.join(t).join("gtk-4.0").is_dir())
        })
        .collect();
    themes.push(GTK_BUILTIN_THEME.into());
    keep_current(&mut themes, string(st, INTERFACE, "gtk-theme"));
    themes
}
/// An index.theme with a non-empty `Directories` and not `Hidden`; the plumbing excluded.
fn icon_themes(st: &Store) -> Vec<String> {
    let paths = icon_paths(st);
    let mut themes: Vec<String> = dirs_in(&paths)
        .into_iter()
        .filter(|t| !["default", "hicolor", "nidara"].contains(&t.as_str()))
        .filter(|t| {
            paths
                .iter()
                .any(|p| real_icon_theme(&p.join(t).join("index.theme")))
        })
        .collect();
    keep_current(&mut themes, string(st, INTERFACE, "icon-theme"));
    themes
}
fn cursor_themes(st: &Store) -> Vec<String> {
    let paths = icon_paths(st);
    dirs_in(&paths)
        .into_iter()
        .filter(|t| paths.iter().any(|p| p.join(t).join("cursors").exists()))
        .collect()
}
/// Nidara's own first, then the themes made for its icon spec.
fn interface_icon_themes(st: &Store) -> Vec<String> {
    let paths = icon_paths(st);
    let mut themes: Vec<String> = dirs_in(&paths)
        .into_iter()
        .filter(|t| t != "nidara")
        .filter(|t| {
            paths
                .iter()
                .any(|p| spec_theme(&p.join(t).join("index.theme")))
        })
        .collect();
    let current = string(st, APPEARANCE, "interface-icon-theme");
    if !current.is_empty() && current != "nidara" {
        keep_current(&mut themes, current);
    }
    themes.insert(0, "nidara".into());
    themes
}
fn keep_current(list: &mut Vec<String>, current: String) {
    if !current.is_empty() && !list.contains(&current) {
        list.push(current);
    }
    list.sort();
}
fn icon_group(path: &Path) -> Option<glib::KeyFile> {
    let kf = glib::KeyFile::new();
    kf.load_from_file(path, glib::KeyFileFlags::NONE).ok()?;
    kf.has_group("Icon Theme").then_some(kf)
}
fn real_icon_theme(path: &Path) -> bool {
    icon_group(path).is_some_and(|kf| {
        kf.string("Icon Theme", "Directories")
            .is_ok_and(|d| !d.trim().is_empty())
            && !kf.boolean("Icon Theme", "Hidden").unwrap_or(false)
    })
}
fn spec_theme(path: &Path) -> bool {
    icon_group(path)
        .is_some_and(|kf| kf.integer("Icon Theme", "X-Nidara-Icon-Spec").unwrap_or(0) > 0)
}

pub fn valid_time(raw: &str) -> Result<Value, String> {
    let t = raw.trim();
    let ok = t.len() == 5
        && t.as_bytes()[2] == b':'
        && t[..2]
            .parse::<u8>()
            .is_ok_and(|h| h < 24 && t[..2].bytes().all(|b| b.is_ascii_digit()))
        && t[3..]
            .parse::<u8>()
            .is_ok_and(|m| m < 60 && t[3..].bytes().all(|b| b.is_ascii_digit()));
    if ok {
        Ok(Value::Text(t.into()))
    } else {
        Err(format!(
            "expected a time as HH:MM (00:00–23:59), got: {raw}"
        ))
    }
}

/// Pango's trailing words that are not part of a family name (`pango_font_description_from_string`).
const FONT_WORDS: &[&str] = &[
    "normal",
    "roman",
    "oblique",
    "italic",
    "small-caps",
    "all-small-caps",
    "petite-caps",
    "all-petite-caps",
    "unicase",
    "title-caps",
    "thin",
    "ultra-light",
    "extra-light",
    "light",
    "semi-light",
    "demi-light",
    "book",
    "regular",
    "medium",
    "semi-bold",
    "demi-bold",
    "bold",
    "ultra-bold",
    "extra-bold",
    "heavy",
    "black",
    "ultra-heavy",
    "extra-heavy",
    "ultra-condensed",
    "extra-condensed",
    "condensed",
    "semi-condensed",
    "semi-expanded",
    "expanded",
    "extra-expanded",
    "ultra-expanded",
    "not-rotated",
    "south",
    "upside-down",
    "north",
    "rotated-left",
    "east",
    "rotated-right",
    "west",
];
/// "Family [Style] Size" → (family, size in points); a size in `px` is kept as px.
pub fn font_parts(raw: &str) -> Option<(String, f64, bool)> {
    let mut words: Vec<&str> = raw.split_whitespace().collect();
    let last = words.pop()?;
    let (num, px) = match last.strip_suffix("px") {
        Some(n) => (n, true),
        None => (last, false),
    };
    let size: f64 = num
        .parse()
        .ok()
        .filter(|s: &f64| *s > 0. && s.is_finite())?;
    while words
        .last()
        .is_some_and(|w| FONT_WORDS.contains(&w.to_lowercase().as_str()))
    {
        words.pop();
    }
    let family = words.join(" ").trim_end_matches(',').to_owned();
    (!family.is_empty()).then_some((family, size, px))
}
fn font_families() -> &'static std::collections::HashSet<String> {
    static FAMILIES: OnceLock<std::collections::HashSet<String>> = OnceLock::new();
    FAMILIES.get_or_init(|| {
        let out = std::process::Command::new("fc-list")
            .args([":", "family"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_default();
        out.lines()
            .flat_map(|l| l.split(','))
            .map(|f| f.trim().to_lowercase())
            .filter(|f| !f.is_empty())
            .collect()
    })
}
/// A family fontconfig knows and a positive size; a pixel size is stored in points (at 96
/// dpi), as the text scale only reaches a size in points.
pub fn valid_font(raw: &str) -> Result<Value, String> {
    let (family, size, px) =
        font_parts(raw).ok_or_else(|| format!("expected \"Family Size\" (points), got: {raw}"))?;
    if !font_families().contains(&family.to_lowercase()) {
        return Err(format!("no font family \"{family}\" on this system"));
    }
    let raw = raw.trim();
    if !px {
        return Ok(Value::Text(raw.into()));
    }
    let pt = (size * 72. / 96.).round().max(1.);
    let head = raw.rsplit_once(char::is_whitespace).map_or("", |(h, _)| h);
    Ok(Value::Text(format!("{head} {pt}")))
}

const WALLPAPER_EXTENSIONS: &[&str] = &["jpg", "jpeg", "png", "gif", "webp", "avif"];
fn file_uri(path: &Path) -> Option<String> {
    glib::filename_to_uri(path, None)
        .ok()
        .map(|u| u.to_string())
}
pub fn valid_wallpaper(raw: &str) -> Result<Value, String> {
    let raw = raw.trim();
    let path = if raw.starts_with("file://") {
        glib::filename_from_uri(raw)
            .map(|(p, _)| p)
            .map_err(|_| format!("not a local file URI: {raw}"))?
    } else {
        PathBuf::from(raw)
    };
    if !path.is_absolute() {
        return Err(format!("expected an absolute path, got: {raw}"));
    }
    if !path.is_file() {
        return Err(format!("no such file: {}", path.display()));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !WALLPAPER_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!(
            "not a JPEG/PNG/GIF/WebP/AVIF image: {}",
            path.display()
        ));
    }
    Ok(Value::Text(path.to_string_lossy().into_owned()))
}
/// The bundled wallpapers (the greeter's excluded): a checkout's own in dev mode, then the
/// installed ones (`ui/lib/wallpaper.ts`).
fn bundled_wallpapers(st: &Store) -> Vec<String> {
    let mut dirs = Vec::new();
    if let Ok(repo) = std::fs::read_to_string(st.config.join("nidara/.dev")) {
        dirs.push(PathBuf::from(repo.trim()).join("defaults/wallpaper"));
    }
    dirs.push("/usr/share/nidara/wallpapers".into());
    let mut out: Vec<String> = dirs
        .iter()
        .filter_map(|d| std::fs::read_dir(d).ok())
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(str::to_lowercase)
                .unwrap_or_default();
            WALLPAPER_EXTENSIONS.contains(&ext.as_str())
                && !p.to_string_lossy().contains("wallpaper-greeter")
        })
        .map(|p| p.to_string_lossy().into_owned())
        .collect();
    out.sort();
    out
}
fn read_wallpaper(st: &Store) -> Json {
    std::fs::read_to_string(st.wallpaper_file())
        .ok()
        .and_then(|s| serde_json::from_str::<Json>(&s).ok())
        .filter(Json::is_object)
        .unwrap_or_else(|| json!({}))
}
/// Merged over the file: it holds per-surface keys this service does not own.
fn write_wallpaper(st: &Store, edit: impl FnOnce(&mut Json)) -> Result<(), String> {
    let mut config = read_wallpaper(st);
    edit(&mut config);
    let file = st.wallpaper_file();
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Written aside and moved in: a reader never sees half a file.
    let next = file.with_extension("next");
    std::fs::write(&next, config.to_string()).map_err(|e| e.to_string())?;
    std::fs::rename(&next, &file).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn button_layout_round_trips_like_the_shell() {
        assert_eq!(
            parse_button_layout("appmenu:minimize,maximize,close"),
            ("right", vec!["minimize", "maximize", "close"])
        );
        assert_eq!(
            parse_button_layout("close,maximize:"),
            ("left", vec!["maximize", "close"])
        );
        assert_eq!(parse_button_layout(":"), ("right", vec![]));
        assert_eq!(
            format_button_layout("left", &["minimize", "maximize", "close"]),
            "close,minimize,maximize:appmenu"
        );
        assert_eq!(
            format_button_layout("right", &["maximize", "close"]),
            "appmenu:maximize,close"
        );
    }

    #[test]
    fn times_and_fonts_are_checked_as_the_registry_does() {
        assert_eq!(valid_time(" 07:30 "), Ok(Value::Text("07:30".into())));
        for bad in ["7:30", "24:00", "12:60", "8pm", "ab:cd"] {
            assert!(valid_time(bad).is_err(), "{bad}");
        }
        assert_eq!(
            font_parts("Inter Variable 11"),
            Some(("Inter Variable".into(), 11., false))
        );
        assert_eq!(
            font_parts("JetBrainsMono Nerd Font Medium 11"),
            Some(("JetBrainsMono Nerd Font".into(), 11., false))
        );
        assert_eq!(
            font_parts("Cantarell Bold Italic 14px"),
            Some(("Cantarell".into(), 14., true))
        );
        assert_eq!(font_parts("Inter"), None);
        assert_eq!(font_parts("Inter 0"), None);
    }

    #[test]
    fn wallpapers_take_paths_and_file_uris() {
        let dir = std::env::temp_dir().join(format!("nidara-wp-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let img = dir.join("a b.png");
        std::fs::write(&img, b"x").unwrap();
        let uri = glib::filename_to_uri(&img, None).unwrap();
        assert_eq!(
            valid_wallpaper(&uri),
            Ok(Value::Text(img.to_string_lossy().into()))
        );
        assert!(valid_wallpaper("relative.png").is_err());
        let txt = dir.join("a.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert!(valid_wallpaper(txt.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
