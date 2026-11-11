// SPDX-License-Identifier: LGPL-3.0-or-later
//! The Settings app's styles: the platform's (`nk_platform::styles`, #1072), which every Nidara
//! program reads, plus the two looks only this app has — its header and its wallpaper picker.

use crate::exports::Exports;
use crate::portal::Appearance;
pub use nk_platform::styles::{colour, font_style, number, parse, window_glyph_style};
use std::ops::{Deref, DerefMut};

pub struct Styles {
    pub header: crate::header::Style,
    pub wallpaper: crate::wallpaper::Look,
    base: nk_platform::styles::Styles,
}

impl Styles {
    pub fn new(exports: &Exports, appearance: &Appearance) -> Result<Self, String> {
        let base = nk_platform::styles::Styles::new(exports, appearance)?;
        let tokens = exports.tokens(appearance)?;
        Ok(Self {
            wallpaper: crate::wallpaper::Look::load(exports, &tokens)?,
            header: crate::header::Style::load(
                &tokens.components["header"],
                &exports.glass,
                appearance,
            )?,
            base,
        })
    }
}

impl Deref for Styles {
    type Target = nk_platform::styles::Styles;
    fn deref(&self) -> &Self::Target {
        &self.base
    }
}

impl DerefMut for Styles {
    fn deref_mut(&mut self) -> &mut Self::Target {
        &mut self.base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every combination of mode and transparency gives the app's own looks too.
    #[test]
    fn every_set_gives_the_apps_looks() {
        let root = std::env::var_os("NK_SETTINGS_DATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
            });
        if !root.join("version").exists() && std::env::var_os("NK_REQUIRE_EXPORT").is_none() {
            eprintln!("skipped: no build/settings-data (set NK_REQUIRE_EXPORT to require it)");
            return;
        }
        let exports = Exports::load(&root).unwrap();
        for dark in [true, false] {
            for reduce in [true, false] {
                let a = Appearance {
                    accent: [0.0, 136.0 / 255.0, 1.0],
                    dark,
                    reduce_transparency: reduce,
                    window_background: "opaque".into(),
                    reduced_motion: false,
                    font: "Inter Variable 11".into(),
                    text_scale: 1.0,
                };
                Styles::new(&exports, &a).unwrap();
            }
        }
    }
}
