// SPDX-License-Identifier: GPL-3.0-or-later
// Embed only Power1's strings from the canonical catalogs. Installed JSON exports
// can override them, but a standalone Rust build must have all twelve languages.
use std::{collections::BTreeSet, env, fs, path::PathBuf};
fn main() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/core/i18n/locales");
    let mut locales = Vec::new();
    let mut canonical = None;
    for locale in [
        "en", "es", "de", "fr", "it", "ja", "nl", "pl", "pt-BR", "pt-PT", "ru", "zh-CN",
    ] {
        let path = dir.join(format!("{locale}.ts"));
        println!("cargo:rerun-if-changed={}", path.display());
        let src = fs::read_to_string(path).expect("canonical locale");
        let entries = src
            .lines()
            .map(str::trim)
            .filter(|line| line.starts_with("\"power1."))
            .map(|line| line.trim_end_matches(','))
            .collect::<Vec<_>>();
        assert!(!entries.is_empty(), "missing Power1 translations: {locale}");
        let keys = entries
            .iter()
            .map(|line| line.split_once(':').unwrap().0.to_string())
            .collect::<BTreeSet<_>>();
        if let Some(expected) = &canonical {
            assert_eq!(&keys, expected, "Power1 locale parity: {locale}");
        } else {
            canonical = Some(keys);
        }
        locales.push(format!("\"{locale}\":{{{}}}", entries.join(",")));
    }
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("power1-i18n.json"),
        format!("{{{}}}", locales.join(",")),
    )
    .unwrap();
}
