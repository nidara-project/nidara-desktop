// SPDX-License-Identifier: LGPL-3.0-or-later
//! The owner's header geometry and provisional D7 grade, from the token export.
use crate::portal::Appearance;
use nk_widgets::{CapsuleMetrics, Result, window::TitlebarStyle};
use serde_json::Value;
#[derive(Clone, Debug)]
pub struct Style {
    pub band: f32,
    pub inset: f32,
    pub button: f32,
    pub icon: f32,
    pub sidebar_radius: f32,
    pub content_gap: f32,
    pub navigation: CapsuleMetrics,
    pub nav_icon: f32,
    pub title_gap: f32,
    pub title_size: f32,
    pub title_weight: f32,
    pub search_width: f32,
    pub search_padding: f32,
    pub search_size: f32,
    pub search_gap: f32,
    pub titlebar: TitlebarStyle,
    pub double_click_ms: u32,
}
impl Style {
    pub fn load(v: &Value, glass: &Value, appearance: &Appearance) -> Result<Self> {
        fn n(v: &Value) -> Result<f32> {
            v.as_f64()
                .filter(|v| v.is_finite() && *v >= 0.)
                .map(|v| v as f32)
                .ok_or("missing/invalid header measurement".into())
        }
        let band = n(&v["band"])?;
        let reduce = appearance.reduce_transparency;
        let titlebar = TitlebarStyle {
            blur: nk_wayland::Blur {
                size: n(&glass["blur"]["panel"]["size"])? as f64,
                passes: if reduce {
                    0
                } else {
                    glass["blur"]["panel"]["passes"]
                        .as_u64()
                        .and_then(|v| v.try_into().ok())
                        .ok_or("invalid header blur passes")?
                },
            },
            height: band
                + if reduce {
                    0.
                } else {
                    n(&v["titlebar"]["extraHeight"])?
                },
            curve: v["titlebar"]["curve"]
                .as_array()
                .ok_or("missing header grade")?
                .iter()
                .map(|v| v.as_f64().ok_or("invalid header grade".into()))
                .collect::<Result<_>>()?,
            background_opacity: if reduce {
                1.
            } else {
                n(&v["titlebar"]["backgroundOpacity"])?
            },
            opaque: reduce,
        };
        titlebar.validate()?;
        Ok(Self {
            band,
            inset: n(&v["inset"])?,
            button: n(&v["button"])?,
            icon: n(&v["icon"])?,
            sidebar_radius: n(&v["sidebarRadius"])?,
            content_gap: n(&v["contentTopGap"])?,
            navigation: CapsuleMetrics {
                padding: n(&v["navigation"]["edge"])?,
                gap: n(&v["navigation"]["gap"])?,
                button_min: n(&v["navigation"]["button"])?,
                height_min: n(&v["navigation"]["height"])?,
            },
            nav_icon: n(&v["navigation"]["icon"])?,
            title_gap: n(&v["titleGap"])?,
            title_size: n(&v["titleSize"])?,
            title_weight: n(&v["titleWeight"])?,
            search_width: n(&v["search"]["width"])?,
            search_padding: n(&v["search"]["padding"])?,
            search_size: n(&v["search"]["size"])?,
            search_gap: n(&v["search"]["gap"])?,
            double_click_ms: v["titlebar"]["doubleClickMs"]
                .as_u64()
                .filter(|v| *v > 0)
                .and_then(|v| v.try_into().ok())
                .ok_or("invalid header double click")?,
            titlebar,
        })
    }
}
