// SPDX-License-Identifier: LGPL-3.0-or-later
//! Demo data is fixed; appearance is selected from the Settings portal, never Config1.
//! The tokens become `nk-widgets`' styles in `nk_settings::styles`, the one mapping the app
//! and this demo share; only the demo's own pieces (its panel, its title bar recipe) are here.
use crate::panel::PanelMaterial;
use nk_render::Color;
use nk_settings::exports::Exports;
use nk_settings::portal::{self, NAMESPACES};
use nk_settings::styles::Styles;
use nk_widgets::{Metrics, Palette, Result};
use serde_json::Value;
use std::{collections::HashMap, path::Path, sync::mpsc};
use zbus::{
    blocking::{Connection, Proxy},
    zvariant::OwnedValue,
};
type Settings = HashMap<String, HashMap<String, OwnedValue>>;
pub struct Appearance {
    pub palette: Palette,
    pub metrics: Metrics,
    pub panel: PanelMaterial,
    pub titlebar: nk_widgets::window::TitlebarStyle,
    pub style: nk_text::TextStyle,
    pub size: (u32, u32),
    pub reduce_motion: bool,
    pub titlebar_double_click_ms: u32,
    /// The radio groups' look (components.json `choices`, #882).
    pub choices: nk_widgets::ChoiceStyle,
    /// The range controls' look (components.json `range`, #882).
    pub range: nk_widgets::RangeStyle,
    /// The switch's look (components.json `switch`).
    pub switch: nk_widgets::SwitchStyle,
    /// The accent palette by name (colors.json `accents`).
    pub accents: Vec<(String, Color)>,
}
fn number(v: &Value) -> Result<f32> {
    v.as_f64()
        .map(|n| n as f32)
        .ok_or_else(|| "missing exported number".into())
}
fn scss(v: &Value) -> Result<f32> {
    v.as_str()
        .ok_or("missing SCSS token")?
        .trim_end_matches("px")
        .parse()
        .map_err(|e| format!("SCSS number: {e}"))
}
impl Appearance {
    fn load(root: &Path, settings: &Settings) -> Result<Self> {
        let exports = Exports::load(root)?;
        let portal = portal::Appearance::from_portal(settings)?;
        let Styles {
            palette,
            metrics,
            choices,
            range,
            switch,
            accents,
            text: style,
        } = Styles::new(&exports, &portal)?;
        let (dark, reduce) = (portal.dark, portal.reduce_transparency);
        let sizes = &exports.statics;
        let glass = &exports.glass;
        let panel = PanelMaterial::load(glass.clone(), dark, reduce)?;
        let recipe: Value = serde_json::from_str(include_str!("../titlebar-provisional.json"))
            .map_err(|e| e.to_string())?;
        let titlebar = nk_widgets::window::TitlebarStyle {
            blur: nk_wayland::Blur {
                size: number(&glass["blur"]["panel"]["size"])? as f64,
                passes: if reduce {
                    0
                } else {
                    u32::try_from(
                        glass["blur"]["panel"]["passes"]
                            .as_u64()
                            .ok_or("missing panel blur passes")?,
                    )
                    .map_err(|e| e.to_string())?
                },
            },
            height: if reduce {
                scss(&sizes["scss"]["space-10"])? + scss(&sizes["scss"]["space-2"])?
            } else {
                number(&recipe["height"])?
            },
            curve: recipe["curve"]
                .as_array()
                .ok_or("missing title curve")?
                .iter()
                .map(|v| v.as_f64().ok_or("invalid title curve".into()))
                .collect::<Result<_>>()?,
            opaque: reduce,
            background_opacity: if reduce {
                1.
            } else {
                number(&recipe["backgroundOpacity"])?
            },
        };
        titlebar.validate()?;
        let size = (
            (metrics.sidebar + number(&sizes["ts"]["WINDOW_LAYOUT"]["content"])?) as u32,
            number(&sizes["ts"]["WINDOW_LAYOUT"]["minHeight"])? as u32,
        );
        Ok(Self {
            palette,
            metrics,
            panel,
            titlebar,
            style,
            size,
            reduce_motion: portal.reduced_motion,
            choices,
            range,
            switch,
            accents,
            titlebar_double_click_ms: recipe["doubleClickMs"]
                .as_u64()
                .and_then(|v| u32::try_from(v).ok())
                .filter(|v| *v > 0)
                .ok_or("invalid title double click policy")?,
        })
    }
}
/// Subscribe before ReadAll; each change takes one coherent portal snapshot.
pub fn watch(root: std::path::PathBuf) -> mpsc::Receiver<Result<Appearance>> {
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let run = || -> Result<()> {
            let bus = Connection::session().map_err(|e| e.to_string())?;
            let proxy = Proxy::new(
                &bus,
                "org.freedesktop.portal.Desktop",
                "/org/freedesktop/portal/desktop",
                "org.freedesktop.portal.Settings",
            )
            .map_err(|e| e.to_string())?;
            let changed = proxy
                .receive_signal("SettingChanged")
                .map_err(|e| e.to_string())?;
            let capture = || -> Result<()> {
                let settings: Settings = proxy
                    .call("ReadAll", &(NAMESPACES.to_vec(),))
                    .map_err(|e| e.to_string())?;
                tx.send(Appearance::load(&root, &settings))
                    .map_err(|e| e.to_string())
            };
            capture()?;
            for _ in changed {
                capture()?;
            }
            Ok(())
        };
        if let Err(e) = run() {
            let _ = tx.send(Err(e));
        }
    });
    rx
}
