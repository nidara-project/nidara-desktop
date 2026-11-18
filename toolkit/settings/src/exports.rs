// SPDX-License-Identifier: LGPL-3.0-or-later
//! The Settings app's data: its OWN pages (`pages.json`, built in) on top of the strings and the
//! tokens every Nidara program reads (`nk_platform::exports`, #1072), installed under
//! `/usr/share/nidara/settings-data/`. The page list is this app's, not the TypeScript Settings'
//! (owner, 18-11): the exported `manifest.json` is that frozen app's and is not read here.

use crate::manifest::{self, Page};
pub use nk_platform::exports::{INSTALLED, Tokens, VERSION, locale, read};
use std::ops::{Deref, DerefMut};
use std::path::{Path, PathBuf};

pub struct Exports {
    pub pages: Vec<Page>,
    data: nk_platform::exports::Exports,
}

impl Exports {
    /// `NK_SETTINGS_DATA`, else the installed copy.
    pub fn root() -> PathBuf {
        nk_platform::exports::Exports::root()
    }

    pub fn load(root: &Path) -> Result<Self, String> {
        let data = nk_platform::exports::Exports::load(root)?;
        Ok(Self {
            pages: pages()?,
            data,
        })
    }

    pub fn page(&self, id: &str) -> Option<&Page> {
        self.pages.iter().find(|p| p.id == id)
    }
}

impl Deref for Exports {
    type Target = nk_platform::exports::Exports;
    fn deref(&self) -> &Self::Target {
        &self.data
    }
}

impl DerefMut for Exports {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.data
    }
}

/// The app's own page list.
pub fn pages() -> Result<Vec<Page>, String> {
    let json = serde_json::from_str(include_str!("../pages.json"))
        .map_err(|e| format!("pages.json: {e}"))?;
    manifest::parse(&json)
}

pub fn open_size(exports: &Exports) -> Result<(u32, u32), String> {
    let layout = &exports.statics["ts"]["WINDOW_LAYOUT"];
    let number = |key: &str| -> Result<f64, String> {
        let v = layout[key]
            .as_f64()
            .ok_or_else(|| format!("WINDOW_LAYOUT {key} missing"))?;
        if v.is_finite() && v > 0. {
            Ok(v)
        } else {
            Err(format!("invalid WINDOW_LAYOUT {key}"))
        }
    };
    let width = number("sidebar")? + number("content")? + number("openGutter")?;
    let height = number("minHeight")?;
    if width > u32::MAX as f64 || height > u32::MAX as f64 {
        return Err("window size overflow".into());
    }
    Ok((width.ceil() as u32, height.ceil() as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Against the real export, when it has been generated (`node --experimental-strip-types
    /// scripts/export-settings-data.mjs` and `export-tokens.mjs`); CI's toolkit job does.
    /// The app's own list names the native service's keys, never the TS Settings' ones.
    #[test]
    fn power_names_the_native_idle_keys() {
        let pages = pages().unwrap();
        let power = pages.iter().find(|p| p.id == "power").unwrap();
        let text = format!("{:?}", power.groups);
        assert!(text.contains("power.suspend-battery-seconds"), "{text}");
        assert!(text.contains("power.suspend-ac-seconds"), "{text}");
        assert!(!text.contains("\"power.suspend\""), "{text}");
    }

    #[test]
    fn reads_the_generated_pages() {
        let root = std::env::var_os("NK_SETTINGS_DATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
            });
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
    }
}
