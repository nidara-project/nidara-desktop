// SPDX-License-Identifier: GPL-3.0-or-later
//! #1103 8e: the keys of Settings → Top bar, in the homes the TS shell used
//! (`ui/shell/config-entries.ts`, `surfaces/bar/barState.ts`, `core/BarOrder.ts`,
//! `core/RegionConfig.ts`):
//!
//! - `bar.appTitle` and `bar.launcherIcon`: `org.nidara.bar`.
//! - `bar.trayHidden`: the tray icons kept out of the bar, as `tray:<Id>` members of
//!   `org.nidara.widgets` `bar-hidden`. Its `values` are the icons remembered in
//!   `tray-known` whose app is still installed; sessiond's tray service remembers them
//!   (`remember_tray`), so Settings lists an app while it is closed.
//! - The clock's three: `region.timeFormat`, `region.dateFormat`, `region.showSeconds`,
//!   `org.nidara.region`.
//!
//! Where each control appears (Wi-Fi, volume…) is not here: #1144.
use super::*;
use std::collections::BTreeMap;

pub(super) const REGION: &str = "org.nidara.region";
pub const LAUNCHER_DEFAULT: &str = "nidara";
const ICON_EXTENSIONS: &[&str] = &["svg", "png", "jpg", "jpeg", "webp"];
const TIME_FORMATS: &[&str] = &["24h", "12h"];
const DATE_FORMATS: &[&str] = &["none", "short", "short-year", "long", "numeric", "iso"];
const TRAY: &str = "tray:";

/// The system menu's icon: the built-in mark, or an absolute path to an image.
pub fn valid_launcher_icon(raw: &str) -> Result<Value, String> {
    let raw = raw.trim();
    if raw == LAUNCHER_DEFAULT {
        return Ok(Value::Text(raw.into()));
    }
    let path = Path::new(raw);
    if !path.is_absolute() {
        return Err(format!(
            "expected \"{LAUNCHER_DEFAULT}\" or an absolute path, got: {raw}"
        ));
    }
    if !path.is_file() {
        return Err(format!("no such file: {raw}"));
    }
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_lowercase)
        .unwrap_or_default();
    if !ICON_EXTENSIONS.contains(&ext.as_str()) {
        return Err(format!("not an SVG/PNG/JPEG/WebP image: {raw}"));
    }
    Ok(Value::Text(raw.into()))
}
/// What the bar shows: a stored image that is gone, or an old preset ("arch"), is the mark.
fn launcher_icon(st: &Store) -> Value {
    let stored = string(st, BAR, "launcher-icon");
    match valid_launcher_icon(&stored) {
        Ok(v) => v,
        Err(_) => Value::Text(LAUNCHER_DEFAULT.into()),
    }
}

/// A remembered tray icon: its title, its icon (a theme name or a file) and its app.
pub type Known = BTreeMap<String, (String, String, String)>;
fn known(st: &Store) -> Known {
    st.s(WIDGETS)
        .value("tray-known")
        .get::<std::collections::HashMap<String, (String, String, String)>>()
        .unwrap_or_default()
        .into_iter()
        .collect()
}
fn installed(app: &str) -> bool {
    // Its desktop file in the XDG data dirs, the user's first, as GIO looks it up.
    app.is_empty()
        || std::iter::once(glib::user_data_dir())
            .chain(glib::system_data_dirs())
            .any(|d| {
                d.join("applications")
                    .join(format!("{app}.desktop"))
                    .is_file()
            })
}
/// The icons Settings offers: remembered, and their app still installed (an icon no app
/// was matched to stays, nothing says it is gone). By title, then Id.
fn tray_ids(st: &Store) -> Vec<String> {
    let mut list: Vec<_> = known(st)
        .into_iter()
        .filter(|(_, (_, _, app))| installed(app))
        .collect();
    list.sort_by(|a, b| (a.1.0.to_lowercase(), &a.0).cmp(&(b.1.0.to_lowercase(), &b.0)));
    list.into_iter().map(|(id, _)| id).collect()
}
fn hidden(st: &Store) -> Vec<String> {
    st.s(WIDGETS)
        .strv("bar-hidden")
        .iter()
        .map(|s| s.to_string())
        .collect()
}
fn tray_hidden(st: &Store) -> Value {
    let stored = hidden(st);
    Value::List(
        tray_ids(st)
            .into_iter()
            .filter(|id| stored.contains(&format!("{TRAY}{id}")))
            .collect(),
    )
}
/// The offered icons take the new value; every other member stays (search, an app that
/// is not installed now and may come back).
fn put_tray_hidden(st: &Store, v: &Value) -> Result<(), String> {
    let Value::List(list) = v else {
        return Err("expected a list".into());
    };
    let offered = tray_ids(st);
    let before = hidden(st);
    let mut next: Vec<String> = before
        .iter()
        .filter(|k| {
            k.strip_prefix(TRAY)
                .is_none_or(|id| !offered.iter().any(|o| o == id))
        })
        .cloned()
        .collect();
    next.extend(list.iter().map(|id| format!("{TRAY}{id}")));
    if next == before {
        return Ok(());
    }
    let refs: Vec<&str> = next.iter().map(String::as_str).collect();
    st.s(WIDGETS)
        .set_strv("bar-hidden", refs.as_slice())
        .map_err(|e| e.to_string())
}

/// Called by the tray service when an app shows an icon. Writes only when something
/// changed: an app re-registers its icon often. `apps` are the candidate app ids from the
/// process's unit; the first one installed is its app.
pub fn remember_tray(st: &Store, id: &str, title: &str, icon: &str, apps: &[String]) {
    if id.is_empty() || st.settings(WIDGETS).is_none() || !st.has(WIDGETS, "tray-known") {
        return;
    }
    let app = apps
        .iter()
        .find(|a| !a.is_empty() && installed(a))
        .cloned()
        .unwrap_or_default();
    let mut all = known(st);
    let entry = (title.to_owned(), icon.to_owned(), app);
    if all.get(id) == Some(&entry) {
        return;
    }
    all.insert(id.to_owned(), entry);
    let map: std::collections::HashMap<_, _> = all.into_iter().collect();
    if let Err(e) = st.s(WIDGETS).set_value("tray-known", &map.to_variant()) {
        eprintln!("[config] cannot remember the tray icon {id}: {e}");
    }
}

fn tray_ui(st: &Store) -> Json {
    let all = known(st);
    let items: Vec<Json> = tray_ids(st)
        .into_iter()
        .map(|id| {
            let (title, icon, app) = all.get(&id).cloned().unwrap_or_default();
            json!({"value": id, "title": title, "icon": icon, "app": app})
        })
        .collect();
    json!({"i18n": "settings.bar.group.apps", "items": items})
}

pub(super) fn keys() -> Vec<Key> {
    vec![
        Key {
            name: "bar.appTitle",
            desc: "Show the active window title in the top bar.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[BAR],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(BAR).boolean("show-app-title")),
            set: Some(|st, v| put_bool(st, BAR, "show-app-title", v)),
            // Its row is one of the Top bar page's own list.
            ui: Some(|_| json!({"i18n": "settings.bar.app-title"})),
            watch: &[(BAR, "show-app-title")],
            file: false,
        },
        Key {
            name: "bar.launcherIcon",
            desc: "The system menu's icon in the top bar: \"nidara\" (the Nidara mark) or an \
                   absolute path to an SVG, PNG, JPEG or WebP image. A file that is gone \
                   reads as \"nidara\".",
            kind: Kind::Text,
            writable: true,
            needs: &[BAR],
            values: None,
            catalogue: None,
            validate: Some(valid_launcher_icon),
            get: launcher_icon,
            set: Some(|st, v| put_string(st, BAR, "launcher-icon", text(v))),
            ui: Some(|_| json!({"i18n": "settings.bar.item.system-menu"})),
            watch: &[(BAR, "launcher-icon")],
            file: false,
        },
        Key {
            name: "bar.trayHidden",
            desc: "The apps' tray icons kept out of the top bar, by their StatusNotifierItem \
                   Id. `values` are the icons seen so far whose app is still installed; \
                   `ui.items` names each.",
            kind: Kind::List,
            writable: true,
            needs: &[WIDGETS],
            values: Some(tray_ids),
            catalogue: None,
            validate: None,
            get: tray_hidden,
            set: Some(put_tray_hidden),
            ui: Some(tray_ui),
            watch: &[(WIDGETS, "bar-hidden"), (WIDGETS, "tray-known")],
            file: false,
        },
        Key {
            name: "region.timeFormat",
            desc: "24- or 12-hour clock: the bar's, the lock screen's and the login screen's.",
            kind: Kind::Enum,
            writable: true,
            needs: &[REGION],
            values: Some(|_| owned(TIME_FORMATS)),
            catalogue: None,
            validate: None,
            get: |st| Value::Text(string(st, REGION, "time-format")),
            set: Some(|st, v| put_string(st, REGION, "time-format", text(v))),
            ui: Some(|_| {
                json!({"i18n": "settings.region.time.format", "control": "dropdown",
                    "options": options_i18n(&owned(TIME_FORMATS), "settings.region.time")})
            }),
            watch: &[(REGION, "time-format")],
            file: false,
        },
        Key {
            name: "region.dateFormat",
            desc: "The date beside the bar's clock: 'none', 'short' (Mon, Apr 6), \
                   'short-year', 'long' (Monday, April 6), 'numeric' or 'iso'. Names and \
                   field order follow the regional format. The bar's only: the lock screen \
                   and the login screen always show the long date.",
            kind: Kind::Enum,
            writable: true,
            needs: &[REGION],
            values: Some(|_| owned(DATE_FORMATS)),
            catalogue: None,
            validate: None,
            get: |st| Value::Text(string(st, REGION, "date-format")),
            set: Some(|st, v| put_string(st, REGION, "date-format", text(v))),
            ui: Some(|_| {
                json!({"i18n": "settings.region.date.format", "control": "dropdown",
                    "options": options_i18n(&owned(DATE_FORMATS), "settings.region.date")})
            }),
            watch: &[(REGION, "date-format")],
            file: false,
        },
        Key {
            name: "region.showSeconds",
            desc: "Show seconds in the clock display.",
            kind: Kind::Boolean,
            writable: true,
            needs: &[REGION],
            values: None,
            catalogue: None,
            validate: None,
            get: |st| Value::Bool(st.s(REGION).boolean("show-seconds")),
            set: Some(|st, v| put_bool(st, REGION, "show-seconds", v)),
            ui: Some(|_| json!({"i18n": "settings.region.time.seconds", "control": "toggle"})),
            watch: &[(REGION, "show-seconds")],
            file: false,
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_menu_icon_is_the_mark_or_an_image_that_exists() {
        assert_eq!(
            valid_launcher_icon("nidara"),
            Ok(Value::Text("nidara".into()))
        );
        let dir = std::env::temp_dir().join(format!("nidara-launcher-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let svg = dir.join("mark.SVG");
        std::fs::write(&svg, b"<svg/>").unwrap();
        let svg = svg.to_str().unwrap();
        assert_eq!(valid_launcher_icon(svg), Ok(Value::Text(svg.into())));
        for bad in ["arch", "mark.svg", "/nonexistent/mark.svg"] {
            assert!(valid_launcher_icon(bad).is_err(), "{bad}");
        }
        let txt = dir.join("a.txt");
        std::fs::write(&txt, b"x").unwrap();
        assert!(valid_launcher_icon(txt.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
