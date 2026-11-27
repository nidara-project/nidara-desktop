// SPDX-License-Identifier: LGPL-3.0-or-later
//! The shell's catalogue follows the session's language and Config1 changes.
use nk_platform::exports::{Exports, locale};
use std::collections::{HashMap, HashSet};
use std::sync::{
    Mutex, OnceLock, RwLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use zbus::blocking::{Connection, Proxy, proxy::SignalIterator};
use zbus::zvariant::OwnedValue;

static CATALOGUE: OnceLock<RwLock<Option<Exports>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);
const CONFIG1: &str = "org.nidara.Config1";
const CONFIG_PATH: &str = "/org/nidara/Config";
const LANGUAGE: &str = "region.language";

fn catalogue() -> &'static RwLock<Option<Exports>> {
    CATALOGUE.get_or_init(|| {
        RwLock::new(
            Exports::load(&Exports::root())
                .map_err(|error| eprintln!("nidara-shell: could not load translations: {error}"))
                .ok(),
        )
    })
}

fn missing(key: &str) -> String {
    if !key.is_empty() {
        static REPORTED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
        if REPORTED
            .get_or_init(Mutex::default)
            .lock()
            .unwrap()
            .insert(key.into())
        {
            eprintln!("nidara-shell: no translation for {key}");
        }
    }
    key.into()
}

pub fn text(key: &str) -> String {
    let catalogue = catalogue().read().unwrap();
    match catalogue
        .as_ref()
        .and_then(|exports| exports.text(key).ok())
    {
        Some(text) => text.into(),
        None => missing(key),
    }
}

pub(crate) fn text_for(exports: &Exports, key: &str) -> String {
    if generation() == 0 {
        exports
            .text(key)
            .map_or_else(|_| missing(key), str::to_owned)
    } else {
        text(key)
    }
}

pub(crate) fn count(key: &str, n: u64) -> String {
    catalogue()
        .read()
        .unwrap()
        .as_ref()
        .and_then(|exports| exports.count(key, n).ok())
        .unwrap_or_else(|| missing(key))
}

pub(crate) fn format(key: &str, values: &[(&str, &str)]) -> String {
    expand(&text(key), values)
}

fn expand(mut template: &str, values: &[(&str, &str)]) -> String {
    let mut message = String::with_capacity(template.len());
    while let Some((head, field)) = template.split_once('{') {
        let Some((name, rest)) = field.split_once('}') else {
            break;
        };
        message.push_str(head);
        if let Some((_, value)) = values.iter().find(|(key, _)| *key == name) {
            message.push_str(value);
        } else {
            message.push('{');
            message.push_str(name);
            message.push('}');
        }
        template = rest;
    }
    message.push_str(template);
    message
}

pub(crate) fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

fn language_changed(lang: &str) -> Result<bool, String> {
    let stored = catalogue();
    if stored
        .read()
        .unwrap()
        .as_ref()
        .is_some_and(|exports| exports.locale == locale(Some(lang)))
    {
        return Ok(false);
    }
    let next = Exports::load_for(&Exports::root(), Some(lang))?;
    let mut stored = stored.write().unwrap();
    if stored
        .as_ref()
        .is_some_and(|before| before.locale == next.locale)
    {
        return Ok(false);
    }
    *stored = Some(next);
    GENERATION.fetch_add(1, Ordering::Release);
    Ok(true)
}

fn language_changes(bus: &Connection) -> zbus::Result<SignalIterator<'static>> {
    // The proxy tracks Config1's owner even if it appears after startup.
    Proxy::new(bus, CONFIG1, CONFIG_PATH, CONFIG1)?.receive_signal("Changed")
}

fn observe_language(changes: SignalIterator<'_>, mut changed: impl FnMut(&str) -> bool) {
    for signal in changes {
        let Ok(values) = signal.body().deserialize::<HashMap<String, OwnedValue>>() else {
            continue;
        };
        if let Some(lang) = values
            .get(LANGUAGE)
            .and_then(|value| <&str>::try_from(value).ok())
            .filter(|lang| !lang.trim().is_empty())
            && !changed(lang)
        {
            break;
        }
    }
}

pub fn watch(mut changed: impl FnMut()) {
    let mut watch = || -> zbus::Result<()> {
        let bus = zbus::blocking::connection::Builder::session()?
            .method_timeout(Duration::from_secs(3))
            .build()?;
        // The initial catalogue comes from LANG. Only later Config1 changes
        // can override it in this process.
        observe_language(language_changes(&bus)?, |lang| {
            match language_changed(lang) {
                Ok(true) => changed(),
                Ok(false) => {}
                Err(error) => eprintln!("nidara-shell: could not update translations: {error}"),
            }
            true
        });
        Ok(())
    };
    if let Err(error) = watch() {
        eprintln!("nidara-shell: could not watch the session language: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translated_templates_can_reorder_fields_and_leave_app_names_alone() {
        assert_eq!(
            expand(
                "{count} avisos de {app}",
                &[("app", "Mail {count}"), ("count", "2")]
            ),
            "2 avisos de Mail {count}",
        );
    }

    #[test]
    fn language_follows_only_config1_language_changes() {
        use std::io::{BufRead, BufReader};
        use std::process::{Child, Command, Stdio};
        use zbus::blocking::connection::Builder;

        struct Bus(Child);
        impl Drop for Bus {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }

        let endpoint = format!(
            "--address=unix:abstract=nidara-i18n-test-{}",
            std::process::id()
        );
        let mut bus = Bus(Command::new("dbus-daemon")
            .args(["--session", &endpoint, "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap());
        let mut address = String::new();
        BufReader::new(bus.0.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        let address = address.trim();
        let connect = || {
            Builder::address(address)
                .unwrap()
                .method_timeout(Duration::from_secs(3))
                .build()
                .unwrap()
        };
        let subscriber = connect();
        let changes = language_changes(&subscriber).unwrap();
        let (reports, languages) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            observe_language(changes, |lang| {
                let lang = locale(Some(lang));
                reports.send(lang).is_ok() && lang != "fr"
            });
        });

        let emit = |conn: &Connection, key: &str, value: OwnedValue| {
            let values = HashMap::from([(key, value)]);
            conn.emit_signal(None::<&str>, CONFIG_PATH, CONFIG1, "Changed", &values)
                .unwrap();
        };
        let string = |value: &str| OwnedValue::from(zbus::zvariant::Str::from(value));
        let config = connect();
        config.request_name(CONFIG1).unwrap();
        emit(&connect(), LANGUAGE, string("de_DE.UTF-8"));
        emit(&config, "region.regionalFormat", string("it_IT.UTF-8"));
        emit(&config, LANGUAGE, OwnedValue::from(true));
        emit(&config, LANGUAGE, string("es_ES.UTF-8"));
        let wait = Duration::from_secs(3);
        assert_eq!(languages.recv_timeout(wait).unwrap(), "es");

        config.release_name(CONFIG1).unwrap();
        let replacement = connect();
        replacement.request_name(CONFIG1).unwrap();
        emit(&config, LANGUAGE, string("pt_BR.UTF-8"));
        emit(&replacement, LANGUAGE, string("fr_FR.UTF-8"));
        assert_eq!(languages.recv_timeout(wait).unwrap(), "fr");
        reader.join().unwrap();
    }

    #[test]
    fn missing_catalogue_text_uses_its_key() {
        assert_eq!(missing("shell.missing-test"), "shell.missing-test");
        assert_eq!(missing(""), "");
    }

    #[test]
    fn shell_catalogue_literals_are_in_the_english_export() {
        let Some(root) = std::env::var_os("NK_SETTINGS_DATA") else {
            return;
        };
        let en = nk_platform::exports::read(std::path::Path::new(&root), "i18n/en.json").unwrap();
        let mut directories = vec![std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src")];
        let mut absent = std::collections::BTreeSet::new();
        while let Some(dir) = directories.pop() {
            for entry in std::fs::read_dir(dir).unwrap() {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    directories.push(path);
                    continue;
                }
                if path.extension().is_none_or(|extension| extension != "rs") {
                    continue;
                }
                let code = std::fs::read_to_string(&path).unwrap();
                let production = code.split("#[cfg(test)]\nmod tests").next().unwrap();
                for (line, text) in production.lines().enumerate() {
                    let mut parts = text.split('"');
                    while let (Some(context), Some(key)) = (parts.next(), parts.next()) {
                        let context = context.trim_end();
                        let is_label = context.ends_with("Label::Key(");
                        let is_shell_key = (key.starts_with("shell.")
                            || key.starts_with("settings."))
                            && key
                                .bytes()
                                .all(|b| b.is_ascii_alphanumeric() || b"-._".contains(&b));
                        let present = if context.ends_with("i18n::count(") {
                            en.get(format!("{key}.other"))
                                .and_then(serde_json::Value::as_str)
                        } else {
                            en.get(key).and_then(serde_json::Value::as_str)
                        };
                        if (is_label || is_shell_key) && present.is_none() {
                            absent.insert(format!("{}:{}: {key}", path.display(), line + 1));
                        }
                    }
                }
            }
        }
        assert!(absent.is_empty(), "missing English keys: {absent:?}");
    }

    #[test]
    fn the_export_resolves_known_visual_and_accessible_labels_in_both_languages() {
        let root = Exports::root();
        if !root.join("version").exists() && std::env::var_os("NK_REQUIRE_EXPORT").is_none() {
            return;
        }
        let en = Exports::load_for(&root, Some("en_US.UTF-8")).unwrap();
        let es = Exports::load_for(&root, Some("es_ES.UTF-8")).unwrap();
        assert_eq!(
            en.text("shell.nc.close-notification").unwrap(),
            "Close notification"
        );
        assert_eq!(
            es.text("shell.nc.close-notification").unwrap(),
            "Cerrar notificación"
        );
        assert_eq!(es.text("dock.special.trash.name").unwrap(), "Papelera");
    }
}
