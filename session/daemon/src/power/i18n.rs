// SPDX-License-Identifier: GPL-3.0-or-later
use std::{collections::HashMap, path::PathBuf};
type Catalog = HashMap<String, String>;
pub struct Strings {
    selected: Catalog,
    english: Catalog,
}
impl Strings {
    pub fn load() -> Self {
        let lang = std::env::var("LANG").unwrap_or_default();
        let dir = std::env::var_os("NIDARA_I18N_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| "/usr/share/nidara/settings-data/i18n".into());
        Self::for_language(&lang, Some(&dir))
    }
    fn for_language(lang: &str, dir: Option<&std::path::Path>) -> Self {
        let mut catalogs: HashMap<String, Catalog> =
            serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/power1-i18n.json")))
                .expect("validated canonical Power1 catalogs");
        let lang = lang.to_ascii_lowercase();
        let locale = [
            ("pt_br", "pt-BR"),
            ("pt", "pt-PT"),
            ("zh", "zh-CN"),
            ("es", "es"),
            ("de", "de"),
            ("fr", "fr"),
            ("it", "it"),
            ("ja", "ja"),
            ("nl", "nl"),
            ("pl", "pl"),
            ("ru", "ru"),
        ]
        .into_iter()
        .find(|(prefix, _)| lang.starts_with(prefix))
        .map_or("en", |(_, locale)| locale);
        let read = |locale: &str| {
            dir.and_then(|dir| std::fs::read(dir.join(format!("{locale}.json"))).ok())
                .and_then(|bytes| serde_json::from_slice::<Catalog>(&bytes).ok())
        };
        let mut english = catalogs.remove("en").unwrap();
        if let Some(export) = read("en") {
            english.extend(export);
        }
        let mut selected = catalogs.remove(locale).unwrap_or_else(|| english.clone());
        if let Some(export) = read(locale) {
            selected.extend(export);
        }
        Self { selected, english }
    }
    pub fn text(&self, key: &str) -> &str {
        self.selected
            .get(key)
            .or_else(|| self.english.get(key))
            .expect("known Power1 message")
    }
    pub fn format(&self, key: &str, args: &[(&str, &str)]) -> String {
        args.iter()
            .fold(self.text(key).to_string(), |s, (key, value)| {
                s.replace(&format!("{{{key}}}"), value)
            })
    }
    pub fn device(&self, kind: u32) -> &str {
        self.text(match kind {
            5 => "power1.device.mouse",
            6 => "power1.device.keyboard",
            8 => "power1.device.phone",
            17 | 18 => "power1.device.headphones",
            _ => "power1.device.peripheral",
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn all_locales_and_percent_placeholders_come_from_the_same_catalogs() {
        for lang in [
            "en_US.UTF-8",
            "es_ES.UTF-8",
            "de_DE",
            "fr_FR",
            "it_IT",
            "ja_JP",
            "nl_NL",
            "pl_PL",
            "pt_BR",
            "pt_PT",
            "ru_RU",
            "zh_CN",
        ] {
            let s = Strings::for_language(lang, None);
            assert!(
                !s.format("power1.alert.remaining", &[("percent", "20")])
                    .contains('{')
            );
            assert!(
                !s.format(
                    "power1.alert.device-title",
                    &[("device", "Mouse"), ("warning", s.text("power1.alert.low"))]
                )
                .contains('{')
            );
        }
        let es = Strings::for_language("es_ES.UTF-8", None);
        assert_eq!(es.text("power1.alert.low"), "Batería baja");
        assert_eq!(es.device(5), "Ratón");
        assert_eq!(
            Strings::for_language("pt_BR.UTF-8", None).device(5),
            "Mouse"
        );
        assert_eq!(Strings::for_language("pt_PT.UTF-8", None).device(5), "Rato");
    }
}
