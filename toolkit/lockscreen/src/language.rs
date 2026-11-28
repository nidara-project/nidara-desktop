// SPDX-License-Identifier: LGPL-3.0-or-later
//! The login screen's languages (#1195 L4): the ones it can speak, each by its own name.
//!
//! A language is offered when the system has a locale generated for it (`locale -a`, the
//! same list Settings → Language & region offers) and Nidara has its strings: choosing one
//! the screen could not show in would change nothing. One locale per catalogue, the first
//! the system lists; each is named in itself ("Español", "Deutsch"), as every login screen
//! names them, so a person finds theirs whatever language the screen is in now.
use nk_platform::exports;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Language {
    /// The locale, as the session's LANG spells it: `es_ES.UTF-8`.
    pub locale: String,
    /// Its own name.
    pub name: String,
}

/// What the system has generated and Nidara speaks, sorted by name.
pub fn available(root: &Path) -> Vec<Language> {
    let listed = std::process::Command::new("locale")
        .arg("-a")
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let mut seen = Vec::new();
    let mut out: Vec<Language> = Vec::new();
    for locale in parse(&listed) {
        let catalogue = exports::locale(Some(&locale));
        if seen.contains(&catalogue) {
            continue;
        }
        // English is the fallback of every lookup: a locale whose catalogue is "en" but
        // that is not English has no strings of its own.
        if catalogue == "en" && !locale.starts_with("en") {
            continue;
        }
        // Only the catalogue's own name is read here; the screen loads the rest when chosen.
        let Some(name) = exports::read(root, &format!("i18n/{catalogue}.json"))
            .ok()
            .and_then(|strings| strings["language.name"].as_str().map(str::to_owned))
        else {
            continue;
        };
        seen.push(catalogue);
        out.push(Language { locale, name });
    }
    out.sort_by_key(|a| a.name.to_lowercase());
    out
}

/// The locales `locale -a` lists, spelled as locale.conf spells them (`es_ES.UTF-8`), without
/// C and POSIX.
fn parse(listed: &str) -> Vec<String> {
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

/// Which of `languages` speaks `lang` (the screen's LANG), by catalogue.
pub fn current(languages: &[Language], lang: Option<&str>) -> Option<usize> {
    let want = exports::locale(lang);
    languages
        .iter()
        .position(|l| exports::locale(Some(&l.locale)) == want)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locales_are_spelled_as_locale_conf_spells_them() {
        assert_eq!(
            parse("C\nC.utf8\nPOSIX\nes_ES.utf8\nde_DE.UTF-8\nen_US\n"),
            ["de_DE.UTF-8", "es_ES.UTF-8"]
        );
    }
}
