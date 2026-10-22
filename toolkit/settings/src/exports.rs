// SPDX-License-Identifier: LGPL-3.0-or-later
//! `settings-data`: the pages, the strings and the tokens, exported from the same sources the
//! legacy Settings reads (PHASE1.md D4: `scripts/export-settings-data.mjs`,
//! `scripts/export-tokens.mjs`). Installed under `/usr/share/nidara/settings-data/`.
//!
//! A `version` other than this build's is a start-up error, never read as if it were this one.

use crate::manifest::{self, Page};
use crate::portal::Appearance;
use serde_json::Value as Json;
use std::path::{Path, PathBuf};

/// The format this build reads (`scripts/settings-data-version.mjs`).
pub const VERSION: &str = "1";
pub const INSTALLED: &str = "/usr/share/nidara/settings-data";

pub struct Exports {
    pub pages: Vec<Page>,
    strings: Json,
    english: Json,
    /// `tokens/colors.json`: the 108 colour sets (accent × mode × reduce transparency × window
    /// background) and the accent palette by name.
    pub colors: Json,
    /// `tokens/static.json`: `_tokens.scss`'s variables and `tokens.ts`'s data.
    pub statics: Json,
    /// `tokens/glass.json` (D7): the material per mode × reduce transparency.
    pub glass: Json,
    /// `tokens/components.json`: the components' look per mode × reduce transparency.
    pub components: Json,
    /// The locale whose strings are in force (`en` when the session's has no file).
    pub locale: String,
}

/// The tokens of one appearance: what the app paints with until the portal says otherwise.
pub struct Tokens<'a> {
    /// `--nidara-*` → its CSS value.
    pub colors: &'a serde_json::Map<String, Json>,
    pub glass: &'a Json,
    pub components: &'a Json,
}

impl Exports {
    /// `NK_SETTINGS_DATA`, else the installed copy.
    pub fn root() -> PathBuf {
        std::env::var_os("NK_SETTINGS_DATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| INSTALLED.into())
    }

    pub fn load(root: &Path) -> Result<Self, String> {
        let version = std::fs::read_to_string(root.join("version"))
            .map_err(|e| format!("{}: {e}", root.join("version").display()))?;
        if version.trim() != VERSION {
            return Err(format!(
                "settings-data version {}, this build reads {VERSION}",
                version.trim()
            ));
        }
        let read = |p: &str| -> Result<Json, String> {
            let path = root.join(p);
            let bytes = std::fs::read(&path).map_err(|e| format!("{}: {e}", path.display()))?;
            serde_json::from_slice(&bytes).map_err(|e| format!("{}: {e}", path.display()))
        };
        let locale = locale(std::env::var("LANG").ok().as_deref());
        let english = read("i18n/en.json")?;
        let (strings, locale) = match read(&format!("i18n/{locale}.json")) {
            Ok(s) => (s, locale.to_owned()),
            Err(_) => (english.clone(), "en".to_owned()),
        };
        Ok(Self {
            pages: manifest::parse(&read("manifest.json")?)?,
            strings,
            english,
            colors: read("tokens/colors.json")?,
            statics: read("tokens/static.json")?,
            glass: read("tokens/glass.json")?,
            components: read("tokens/components.json")?,
            locale,
        })
    }

    pub fn page(&self, id: &str) -> Option<&Page> {
        self.pages.iter().find(|p| p.id == id)
    }

    /// A manifest string in the session's language, else English (per key, as the shell's
    /// `t()`); missing in both is an error, never the key shown.
    pub fn text(&self, key: &str) -> Result<&str, String> {
        self.strings
            .get(key)
            .or_else(|| self.english.get(key))
            .and_then(Json::as_str)
            .ok_or_else(|| format!("no string for {key}"))
    }

    /// The set the portal's values pick. None of the sets: an error shown (D4), never the
    /// nearest one.
    pub fn tokens(&self, a: &Appearance) -> Result<Tokens<'_>, String> {
        let accent = self.colors["accents"]
            .as_object()
            .ok_or("colors.json has no accents")?
            .iter()
            .find_map(|(name, hex)| (hex_rgb(hex.as_str()?)? == rgb255(a.accent)).then_some(name))
            .ok_or_else(|| format!("the portal's accent {:?} is none of the palette", a.accent))?;
        let set = self.colors["sets"]
            .as_array()
            .ok_or("colors.json has no sets")?
            .iter()
            .find(|s| {
                s["accent"] == **accent
                    && s["dark"] == a.dark
                    && s["reduceTransparency"] == a.reduce_transparency
                    && s["windowBackground"] == *a.window_background
            })
            .ok_or_else(|| format!("no colour set for {a:?}"))?;
        let by_mode = |export: &str, v: &'_ Json| -> Result<usize, String> {
            v["variants"]
                .as_array()
                .ok_or_else(|| format!("{export} has no variants"))?
                .iter()
                .position(|v| {
                    v["dark"] == a.dark && v["reduceTransparency"] == a.reduce_transparency
                })
                .ok_or_else(|| format!("{export} has no variant for {a:?}"))
        };
        let glass = by_mode("glass.json", &self.glass)?;
        let components = by_mode("components.json", &self.components)?;
        Ok(Tokens {
            colors: set["tokens"]
                .as_object()
                .ok_or("a colour set without tokens")?,
            glass: &self.glass["variants"][glass],
            components: &self.components["variants"][components],
        })
    }
}

/// The locale the shell picks (`ui/shell/core/i18n/index.ts`, `detectLanguage`): from `LANG`
/// alone, with Brazil before the generic Portuguese. The same rule, so both Settings speak the
/// same language in the same session.
pub fn locale(lang: Option<&str>) -> &'static str {
    let l = lang.unwrap_or("").to_lowercase();
    const CHAIN: [(&str, &str); 12] = [
        ("en", "en"),
        ("es", "es"),
        ("fr", "fr"),
        ("de", "de"),
        ("pt_br", "pt-BR"),
        ("pt", "pt-PT"),
        ("it", "it"),
        ("pl", "pl"),
        ("nl", "nl"),
        ("ru", "ru"),
        ("zh", "zh-CN"),
        ("ja", "ja"),
    ];
    CHAIN
        .iter()
        .find(|(prefix, _)| l.starts_with(prefix))
        .map_or("en", |(_, locale)| locale)
}

fn rgb255(c: [f64; 3]) -> [u8; 3] {
    c.map(|v| (v * 255.0).round().clamp(0.0, 255.0) as u8)
}

fn hex_rgb(hex: &str) -> Option<[u8; 3]> {
    let h = hex.strip_prefix('#').filter(|h| h.len() == 6)?;
    let n = u32::from_str_radix(h, 16).ok()?;
    Some([(n >> 16) as u8, (n >> 8) as u8, n as u8])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_locale_is_the_shells() {
        assert_eq!(locale(Some("pt_BR.UTF-8")), "pt-BR");
        assert_eq!(locale(Some("pt_PT.UTF-8")), "pt-PT");
        assert_eq!(locale(Some("pt_AO.UTF-8")), "pt-PT");
        assert_eq!(locale(Some("es_ES.UTF-8")), "es");
        assert_eq!(locale(Some("zh_TW.UTF-8")), "zh-CN");
        assert_eq!(locale(Some("C")), "en");
        assert_eq!(locale(None), "en");
    }

    #[test]
    fn hex_and_portal_accents_meet() {
        assert_eq!(hex_rgb("#0088FF"), Some(rgb255([0.0, 136.0 / 255.0, 1.0])));
        assert_eq!(hex_rgb("rgba(0,0,0,1)"), None);
    }

    /// Against the real export, when it has been generated (`node --experimental-strip-types
    /// scripts/export-settings-data.mjs` and `export-tokens.mjs`); CI's toolkit job does.
    #[test]
    fn reads_the_generated_export() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data");
        if !root.join("version").exists() && std::env::var_os("NK_REQUIRE_EXPORT").is_none() {
            eprintln!("skipped: no build/settings-data (set NK_REQUIRE_EXPORT to require it)");
            return;
        }
        let e = Exports::load(&root).unwrap();
        let appearance = e.page("appearance").expect("an appearance page");
        assert!(!appearance.groups.is_empty());
        for p in &e.pages {
            e.text(&p.label).unwrap();
        }
        // Every combination the portal can say has its set.
        let accents: Vec<[u8; 3]> = e.colors["accents"]
            .as_object()
            .unwrap()
            .values()
            .map(|h| hex_rgb(h.as_str().unwrap()).unwrap())
            .collect();
        let mut n = 0;
        for rgb in &accents {
            for dark in [true, false] {
                for reduce in [true, false] {
                    for level in ["opaque", "tinted", "translucent"] {
                        let a = Appearance {
                            accent: rgb.map(|c| c as f64 / 255.0),
                            dark,
                            reduce_transparency: reduce,
                            window_background: level.into(),
                            reduced_motion: false,
                            font: "Inter 11".into(),
                            text_scale: 1.0,
                        };
                        let t = e.tokens(&a).unwrap();
                        assert!(t.colors.contains_key("--nidara-bg"));
                        n += 1;
                    }
                }
            }
        }
        assert_eq!(n, 108);
        let unknown = Appearance {
            accent: [0.123, 0.456, 0.789],
            dark: true,
            reduce_transparency: false,
            window_background: "opaque".into(),
            reduced_motion: false,
            font: "Inter 11".into(),
            text_scale: 1.0,
        };
        assert!(e.tokens(&unknown).is_err());
    }
}
