// SPDX-License-Identifier: GPL-3.0-or-later
//! #1103 8b: Settings → Region's two keys, each in the home that decides it (#573 in
//! `ui/shell/core/RegionConfig.ts`):
//!
//! - `region.timezone`: the SYSTEM's, `/etc/localtime`, changed through systemd-timedated's
//!   `SetTimezone` with an interactive polkit prompt. The prompt can take as long as the
//!   person does, so the call is asynchronous: `Apply` answers the zone in force (still the
//!   old one) and the new one is announced when timedated has set it. A cancelled prompt
//!   changes nothing and says nothing, as `timedatectl` cancelled did in TS.
//! - `region.regionalFormat`: THIS user's, `~/.config/environment.d/nidara-locale.conf`, the
//!   file the systemd user manager reads at login; "" (no file) means the language's format.
//!   It takes effect at the next login.
use super::*;

const TIMEZONE: &str = "region.timezone";
const FORMAT: &str = "region.regionalFormat";
const TIMEDATED: &str = "org.freedesktop.timedate1";
const TIMEDATED_PATH: &str = "/org/freedesktop/timedate1";
const ZONEINFO: &str = "/usr/share/zoneinfo";
const TIMEOUT_MS: i32 = 2000;
/// The format variables the regional format sets together; never `LANG` or `LC_MESSAGES`,
/// which are the language.
const FORMAT_VARS: &[&str] = &[
    "LC_TIME",
    "LC_NUMERIC",
    "LC_MONETARY",
    "LC_PAPER",
    "LC_ADDRESS",
    "LC_TELEPHONE",
    "LC_MEASUREMENT",
];

/// The zone in force, read once and again whenever it is announced.
fn zone() -> String {
    ZONE.with(|z| z.borrow_mut().get_or_insert_with(read_zone).clone())
}
fn refresh() {
    ZONE.with(|z| *z.borrow_mut() = Some(read_zone()));
}
/// timedated's `Timezone`; `/etc/localtime`'s link when it cannot be asked.
fn read_zone() -> String {
    let asked = gio::bus_get_sync(gio::BusType::System, gio::Cancellable::NONE)
        .ok()
        .and_then(|bus| {
            bus.call_sync(
                Some(TIMEDATED),
                TIMEDATED_PATH,
                "org.freedesktop.DBus.Properties",
                "Get",
                Some(&(TIMEDATED, "Timezone").to_variant()),
                None,
                gio::DBusCallFlags::NONE,
                TIMEOUT_MS,
                gio::Cancellable::NONE,
            )
            .ok()
        })
        .and_then(|reply| reply.get::<(glib::Variant,)>())
        .and_then(|(v,)| v.get::<String>());
    asked
        .filter(|z| !z.is_empty())
        .unwrap_or_else(|| zone_of(&std::fs::read_link("/etc/localtime").unwrap_or_default()))
}
fn zone_of(link: &Path) -> String {
    let link = link.to_string_lossy();
    link.split_once("zoneinfo/")
        .map(|(_, z)| z.to_owned())
        .unwrap_or_default()
}

/// Every zone timedated accepts, sorted: the same list as `timedatectl list-timezones`
/// (tzdata's zones and the names linked to them).
fn zones() -> &'static Vec<String> {
    static ZONES: OnceLock<Vec<String>> = OnceLock::new();
    ZONES.get_or_init(|| {
        parse_zones(&std::fs::read_to_string(format!("{ZONEINFO}/tzdata.zi")).unwrap_or_default())
    })
}
fn parse_zones(tzdata: &str) -> Vec<String> {
    let mut zones: Vec<String> = tzdata
        .lines()
        .filter_map(|l| {
            let mut f = l.split_whitespace();
            match f.next()? {
                "Z" => f.next(),
                "L" => f.nth(1),
                _ => None,
            }
        })
        .map(str::to_owned)
        .collect();
    zones.sort();
    zones.dedup();
    zones
}

fn put_zone(_: &Store, v: &Value) -> Result<(), String> {
    let zone = text(v).to_owned();
    let bus = gio::bus_get_sync(gio::BusType::System, gio::Cancellable::NONE)
        .map_err(|e| e.to_string())?;
    // As long as the person takes with the password; the answer comes from timedated.
    bus.call(
        Some(TIMEDATED),
        TIMEDATED_PATH,
        TIMEDATED,
        "SetTimezone",
        Some(&(zone.as_str(), true).to_variant()),
        None,
        gio::DBusCallFlags::ALLOW_INTERACTIVE_AUTHORIZATION,
        -1,
        gio::Cancellable::NONE,
        move |result| match result {
            Ok(_) => {
                refresh();
                ANNOUNCE.with(|a| {
                    if let Some(announce) = a.borrow().as_ref() {
                        announce();
                    }
                })
            }
            Err(e) => eprintln!("[config] {TIMEZONE} {zone} not set: {e}"),
        },
    );
    Ok(())
}

thread_local! {
    /// The zone last read; None until the first ask.
    static ZONE: std::cell::RefCell<Option<String>> = const { std::cell::RefCell::new(None) };
    /// Announces the timezone key; set by `watch` on the config thread.
    static ANNOUNCE: std::cell::RefCell<Option<Box<dyn Fn()>>> = const { std::cell::RefCell::new(None) };
    static SUBSCRIPTIONS: std::cell::RefCell<Vec<gio::SignalSubscription>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// A zone set by anyone (`timedatectl`, another Settings) is announced: timedated says so
/// while it runs, and a write of ours says so when it is done.
pub(super) fn watch(changed: impl Fn() + Clone + 'static) {
    ANNOUNCE.with(|a| *a.borrow_mut() = Some(Box::new(changed.clone())));
    let Ok(bus) = gio::bus_get_sync(gio::BusType::System, gio::Cancellable::NONE) else {
        return;
    };
    let props = bus.subscribe_to_signal(
        Some(TIMEDATED),
        Some("org.freedesktop.DBus.Properties"),
        Some("PropertiesChanged"),
        Some(TIMEDATED_PATH),
        None,
        gio::DBusSignalFlags::NONE,
        move |_| {
            refresh();
            changed()
        },
    );
    SUBSCRIPTIONS.with(|s| s.borrow_mut().push(props));
}

pub(super) fn format_file(st: &Store) -> PathBuf {
    st.config.join("environment.d/nidara-locale.conf")
}
/// The saved regional format: the file's `LC_TIME`, "" without one.
fn format(st: &Store) -> String {
    format_of(&std::fs::read_to_string(format_file(st)).unwrap_or_default())
}
fn format_of(text: &str) -> String {
    text.lines()
        .find_map(|l| l.trim().strip_prefix("LC_TIME="))
        .map(|v| v.trim().trim_matches('"').to_owned())
        .unwrap_or_default()
}
/// The locales a regional format can be: `locale -a`'s, without the C/POSIX family, spelled
/// as `locale.conf` spells them (`.UTF-8`).
fn locales() -> &'static Vec<String> {
    static LOCALES: OnceLock<Vec<String>> = OnceLock::new();
    LOCALES.get_or_init(|| {
        let out = std::process::Command::new("locale").arg("-a").output();
        parse_locales(
            &out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_default(),
        )
    })
}
fn parse_locales(listed: &str) -> Vec<String> {
    let mut locales: Vec<String> = listed
        .lines()
        .map(str::trim)
        .filter(|l| l.contains('.') && !l.starts_with("C.") && *l != "POSIX")
        .map(|l| match l.rsplit_once('.') {
            Some((name, enc)) if enc.eq_ignore_ascii_case("utf8") => format!("{name}.UTF-8"),
            _ => l.to_owned(),
        })
        .collect();
    locales.sort();
    locales.dedup();
    locales
}
/// "" first (the language's format), then every locale; a saved one the system stopped
/// listing stays, so the row shows what the file holds rather than a neighbour.
fn formats(st: &Store) -> Vec<String> {
    let mut values = vec![String::new()];
    values.extend(locales().iter().cloned());
    let saved = format(st);
    if !values.contains(&saved) {
        values.push(saved);
    }
    values
}
fn put_format(st: &Store, v: &Value) -> Result<(), String> {
    let locale = text(v);
    let path = format_file(st);
    if locale.is_empty() {
        return match std::fs::remove_file(&path) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
            _ => Ok(()),
        };
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let content: String = FORMAT_VARS
        .iter()
        .map(|v| format!("{v}={locale}\n"))
        .collect();
    let tmp = path.with_extension("conf.tmp");
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

pub(super) fn keys() -> Vec<Key> {
    vec![
        Key {
            name: TIMEZONE,
            desc: "The system's time zone, an IANA name ('Europe/Madrid'); `catalogue` lists \
                   every one. It is the whole computer's, so setting it asks for an \
                   administrator's password: the value changes once that is given, and not \
                   at all if it is refused.",
            kind: Kind::Text,
            writable: true,
            needs: &[],
            values: None,
            catalogue: Some(|_| zones().clone()),
            validate: Some(|raw| {
                if zones().iter().any(|z| z == raw) {
                    Ok(Value::Text(raw.into()))
                } else {
                    Err(format!("not a time zone: {raw}"))
                }
            }),
            get: |_| Value::Text(zone()),
            set: Some(put_zone),
            // Drawn by the Region page's own city search, not by a generic control.
            ui: Some(|_| json!({"i18n": "settings.region.tz.change"})),
            watch: &[],
            file: false,
        },
        Key {
            name: FORMAT,
            desc: "How dates, numbers and money are written, as a locale ('es_ES.UTF-8'); \
                   '' follows the language. This user's only, from the next login.",
            kind: Kind::Enum,
            writable: true,
            needs: &[],
            values: Some(formats),
            catalogue: None,
            validate: None,
            get: |st| Value::Text(format(st)),
            set: Some(put_format),
            ui: Some(|st| {
                let options: Vec<Json> = formats(st)
                    .into_iter()
                    .map(|v| {
                        if v.is_empty() {
                            json!({"value": "", "i18n": "settings.region.locale.regional.same"})
                        } else {
                            json!({"value": v, "label": v})
                        }
                    })
                    .collect();
                json!({"i18n": "settings.region.locale.regional", "control": "dropdown", "options": options})
            }),
            watch: &[],
            file: false,
        },
    ]
}

pub(super) fn is_key(name: &str) -> bool {
    name == TIMEZONE || name == FORMAT
}
pub(super) fn available(name: &str) -> bool {
    if name == TIMEZONE {
        !zones().is_empty()
    } else {
        true
    }
}
pub(super) const TIMEZONE_KEY: &str = TIMEZONE;
pub(super) const FORMAT_KEY: &str = FORMAT;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zones_are_tzdata_zones_and_their_links() {
        let zones = parse_zones(
            "# comment\nR Spain 1918 o - Ap 15 23 1 S\nZ Europe/Madrid -0:14:44 - LMT 1901\nL Etc/GMT GMT\nZ Etc/GMT 0 - GMT\n",
        );
        assert_eq!(zones, ["Etc/GMT", "Europe/Madrid", "GMT"]);
    }

    #[test]
    fn the_zone_is_what_localtime_links_to() {
        assert_eq!(
            zone_of(Path::new("/usr/share/zoneinfo/Europe/Madrid")),
            "Europe/Madrid"
        );
        assert_eq!(
            zone_of(Path::new("../usr/share/zoneinfo/America/Argentina/Salta")),
            "America/Argentina/Salta"
        );
        assert_eq!(zone_of(Path::new("")), "");
    }

    #[test]
    fn locales_are_spelled_as_locale_conf_spells_them() {
        assert_eq!(
            parse_locales("C\nC.utf8\nPOSIX\nes_ES.utf8\nde_DE.UTF-8\nen_US\n"),
            ["de_DE.UTF-8", "es_ES.UTF-8"]
        );
    }

    #[test]
    fn the_saved_format_is_the_files_lc_time() {
        assert_eq!(
            format_of("LC_TIME=es_ES.UTF-8\nLC_NUMERIC=es_ES.UTF-8\n"),
            "es_ES.UTF-8"
        );
        assert_eq!(format_of(""), "");
    }
}
