// SPDX-License-Identifier: LGPL-3.0-or-later
//! The shell's catalogue. Settings applies Language through localectl to locale1.
use nk_platform::exports::{Exports, locale};
use std::sync::{
    OnceLock, RwLock,
    atomic::{AtomicU64, Ordering},
};
use std::time::Duration;
use zbus::blocking::Proxy;

static CATALOGUE: OnceLock<RwLock<Option<Exports>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(0);
const LOCALE1: &str = "org.freedesktop.locale1";

fn catalogue() -> &'static RwLock<Option<Exports>> {
    CATALOGUE.get_or_init(|| {
        RwLock::new(
            Exports::load(&Exports::root())
                .map_err(|error| eprintln!("nidara-shell: could not load translations: {error}"))
                .ok(),
        )
    })
}

pub fn text(key: &str) -> String {
    catalogue()
        .read()
        .unwrap()
        .as_ref()
        .and_then(|exports| exports.text(key).ok())
        .unwrap_or_default()
        .into()
}

pub(crate) fn text_for(exports: &Exports, key: &str) -> String {
    if generation() == 0 {
        exports.text(key).unwrap_or_default().into()
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
        .unwrap_or_default()
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

fn language_values<'a>(proxy: &'a Proxy<'_>) -> impl Iterator<Item = Vec<String>> + 'a {
    let changes = proxy.receive_property_changed::<Vec<String>>("Locale");
    proxy
        .get_property::<Vec<String>>("Locale")
        .ok()
        .into_iter()
        .chain(changes.filter_map(|change| change.get().ok()))
}

pub fn watch(mut changed: impl FnMut()) {
    let mut watch = || -> zbus::Result<()> {
        let bus = zbus::blocking::connection::Builder::system()?
            .method_timeout(Duration::from_secs(3))
            .build()?;
        let proxy = Proxy::new(&bus, LOCALE1, "/org/freedesktop/locale1", LOCALE1)?;
        for values in language_values(&proxy) {
            if let Some(lang) = system_language(&values) {
                match language_changed(lang) {
                    Ok(true) => changed(),
                    Ok(false) => {}
                    Err(error) => eprintln!("nidara-shell: could not update translations: {error}"),
                }
            }
        }
        Ok(())
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
    struct LocaleService(Vec<String>);

    #[zbus::interface(name = "org.freedesktop.locale1")]
    impl LocaleService {
        #[zbus(property)]
        fn locale(&self) -> Vec<String> {
            self.0.clone()
        }

        #[zbus(property)]
        fn set_locale(&mut self, values: Vec<String>) {
            self.0 = values;
        }
    }

    #[test]
    fn a_locale1_change_reaches_an_existing_subscription() {
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
        let path = "/org/freedesktop/locale1";
        let _service = Builder::address(address)
            .unwrap()
            .name(LOCALE1)
            .unwrap()
            .serve_at(path, LocaleService(vec!["LANG=en_US.UTF-8".into()]))
            .unwrap()
            .build()
            .unwrap();
        let subscriber = Builder::address(address).unwrap().build().unwrap();
        let (reports, languages) = std::sync::mpsc::channel();
        let reader = std::thread::spawn(move || {
            let proxy = Proxy::new(&subscriber, LOCALE1, path, LOCALE1).unwrap();
            let mut previous = None;
            for lang in language_values(&proxy)
                .filter_map(|values| system_language(&values).map(|lang| locale(Some(lang))))
            {
                if previous.replace(lang) == Some(lang) {
                    continue;
                }
                if reports.send(lang).is_err() || lang == "es" {
                    break;
                }
            }
        });
        assert_eq!(
            languages.recv_timeout(Duration::from_secs(3)).unwrap(),
            "en"
        );
        let setter = Builder::address(address).unwrap().build().unwrap();
        let properties = Proxy::new(&setter, LOCALE1, path, LOCALE1).unwrap();
        properties
            .set_property("Locale", vec!["LANG=es_ES.UTF-8"])
            .unwrap();
        assert_eq!(
            languages.recv_timeout(Duration::from_secs(3)).unwrap(),
            "es"
        );
        reader.join().unwrap();
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
