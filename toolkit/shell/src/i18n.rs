// SPDX-License-Identifier: LGPL-3.0-or-later
//! The shell's catalogue. Settings applies Language through localectl to locale1.
use nk_platform::exports::{Exports, locale};
use std::collections::HashSet;
use std::sync::{
    Mutex, OnceLock, RwLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use zbus::blocking::{Connection, MessageIterator, Proxy};
use zbus::{MatchRule, message::Type};

static CATALOGUE: OnceLock<RwLock<Option<Exports>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);
const LOCALE1: &str = "org.freedesktop.locale1";
const LOCALE_PATH: &str = "/org/freedesktop/locale1";

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

fn system_language(values: &[String]) -> Option<&str> {
    values.iter().find_map(|entry| entry.strip_prefix("LANG="))
}

fn system_locale(bus: &Connection, destination: &str) -> zbus::Result<Vec<String>> {
    zbus::blocking::proxy::Builder::<Proxy>::new(bus)
        .destination(destination)?
        .path(LOCALE_PATH)?
        .interface(LOCALE1)?
        .cache_properties(zbus::proxy::CacheProperties::No)
        .build()
        .and_then(|proxy: Proxy<'_>| proxy.get_property("Locale"))
}

fn observe_language(bus: &Connection, mut changed: impl FnMut(&str) -> bool) -> zbus::Result<()> {
    let dbus = zbus::blocking::fdo::DBusProxy::new(bus)?;
    let messages = MessageIterator::from(bus);
    let owner_match = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender("org.freedesktop.DBus")?
        .interface("org.freedesktop.DBus")?
        .member("NameOwnerChanged")?
        .add_arg(LOCALE1)?
        .build();
    let locale_match = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender(LOCALE1)?
        .path(LOCALE_PATH)?
        .interface("org.freedesktop.DBus.Properties")?
        .member("PropertiesChanged")?
        .add_arg(LOCALE1)?
        .build();
    dbus.add_match_rule(owner_match)?;
    dbus.add_match_rule(locale_match)?;
    // This is a comparison baseline. A user's session LANG takes precedence at
    // startup, and a daemon waking up with the same value does not change it.
    let initial = system_locale(bus, LOCALE1).ok();
    let mut previous = initial
        .as_deref()
        .map(|values| system_language(values).unwrap_or_default().to_owned());
    let mut owner = dbus
        .get_name_owner(LOCALE1.try_into()?)
        .ok()
        .map(|name| name.to_string());
    for signal in messages {
        let signal = signal?;
        let header = signal.header();
        if signal.message_type() != Type::Signal {
            continue;
        }
        let member = header.member().map(|member| member.as_str());
        let owner_changed = member == Some("NameOwnerChanged")
            && header
                .sender()
                .is_some_and(|sender| sender.as_str() == "org.freedesktop.DBus");
        if owner_changed {
            let Ok((name, _, new)) = signal.body().deserialize::<(String, String, String)>() else {
                continue;
            };
            if name != LOCALE1 {
                continue;
            }
            owner = (!new.is_empty()).then_some(new);
        } else {
            if member != Some("PropertiesChanged")
                || header
                    .path()
                    .is_none_or(|path| path.as_str() != LOCALE_PATH)
                || header
                    .interface()
                    .is_none_or(|iface| iface.as_str() != "org.freedesktop.DBus.Properties")
                || header
                    .sender()
                    .is_none_or(|sender| owner.as_deref() != Some(sender.as_str()))
            {
                continue;
            }
            type Properties = (
                String,
                std::collections::HashMap<String, zbus::zvariant::OwnedValue>,
                Vec<String>,
            );
            let Ok((interface, props, invalidated)) = signal.body().deserialize::<Properties>()
            else {
                continue;
            };
            if interface != LOCALE1
                || (!props.contains_key("Locale") && !invalidated.iter().any(|key| key == "Locale"))
            {
                continue;
            }
        }
        let Some(owner) = owner.as_deref() else {
            continue;
        };
        let Ok(values) = system_locale(bus, owner) else {
            continue;
        };
        let current = system_language(&values).unwrap_or_default();
        if previous.as_deref() == Some(current) {
            continue;
        }
        // A replacement's first reading can still supply the baseline when
        // the authority was unavailable at startup. An explicit change does not.
        let known = previous.replace(current.into()).is_some();
        if (known || !owner_changed) && !changed(current) {
            break;
        }
    }
    Ok(())
}

pub fn watch(mut changed: impl FnMut()) {
    let mut watch = || -> zbus::Result<()> {
        let bus = zbus::blocking::connection::Builder::system()?
            .method_timeout(Duration::from_secs(3))
            .build()?;
        observe_language(&bus, |lang| {
            match language_changed(lang) {
                Ok(true) => changed(),
                Ok(false) => {}
                Err(error) => eprintln!("nidara-shell: could not update translations: {error}"),
            }
            true
        })
    };
    if let Err(error) = watch() {
        eprintln!("nidara-shell: could not watch the system language: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_uses_locale1_lang_not_the_regional_format() {
        let settings = ["LC_TIME=en_GB.UTF-8".into(), "LANG=es_ES.UTF-8".into()];
        assert_eq!(locale(system_language(&settings)), "es");
    }

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
    struct LocaleService(Vec<String>, std::sync::mpsc::Sender<()>);

    #[zbus::interface(name = "org.freedesktop.locale1")]
    impl LocaleService {
        #[zbus(property)]
        fn locale(&self) -> Vec<String> {
            let _ = self.1.send(());
            self.0.clone()
        }

        #[zbus(property)]
        fn set_locale(&mut self, values: Vec<String>) {
            self.0 = values;
        }
    }

    #[test]
    fn locale1_changes_survive_restart_without_overriding_session_startup() {
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
        let (reads, baseline) = std::sync::mpsc::channel();
        let service = |lang: &str| {
            Builder::address(address)
                .unwrap()
                .name(LOCALE1)
                .unwrap()
                .serve_at(
                    LOCALE_PATH,
                    LocaleService(vec![format!("LANG={lang}")], reads.clone()),
                )
                .unwrap()
                .build()
                .unwrap()
        };

        let first = service("es_ES.UTF-8");
        let subscriber = Builder::address(address).unwrap().build().unwrap();
        let (reports, languages) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            observe_language(&subscriber, |lang| {
                let lang = locale(Some(lang));
                reports.send(lang).is_ok() && lang != "fr"
            })
            .unwrap();
        });
        let wait = Duration::from_secs(3);
        baseline.recv_timeout(wait).unwrap();
        assert!(
            languages.try_recv().is_err(),
            "the system baseline must not override session LANG"
        );

        let setter = Builder::address(address).unwrap().build().unwrap();
        let properties = Proxy::new(&setter, LOCALE1, LOCALE_PATH, LOCALE1).unwrap();
        properties
            .set_property("Locale", vec!["LANG=en_US.UTF-8"])
            .unwrap();
        assert_eq!(languages.recv_timeout(wait).unwrap(), "en");
        baseline.recv_timeout(wait).unwrap();

        first.release_name(LOCALE1).unwrap();
        let second = service("en_US.UTF-8");
        baseline.recv_timeout(wait).unwrap();
        assert!(
            languages.try_recv().is_err(),
            "daemon restart with the same value does not change LANG"
        );
        properties
            .set_property("Locale", vec!["LANG=es_ES.UTF-8"])
            .unwrap();
        assert_eq!(languages.recv_timeout(wait).unwrap(), "es");
        second.release_name(LOCALE1).unwrap();

        let _third = service("fr_FR.UTF-8");
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
