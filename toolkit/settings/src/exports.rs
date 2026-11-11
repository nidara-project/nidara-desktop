// SPDX-License-Identifier: LGPL-3.0-or-later
//! The Settings app's export: its pages (`manifest.json`) on top of the strings and the tokens
//! every Nidara program reads (`nk_platform::exports`, #1072). Installed under
//! `/usr/share/nidara/settings-data/`.

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
            pages: manifest::parse(&read(root, "manifest.json")?)?,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Against the real export, when it has been generated (`node --experimental-strip-types
    /// scripts/export-settings-data.mjs` and `export-tokens.mjs`); CI's toolkit job does.
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
