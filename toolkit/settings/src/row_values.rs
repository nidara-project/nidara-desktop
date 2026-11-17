// SPDX-License-Identifier: LGPL-3.0-or-later
//! Schema conversions shared by both Settings windows. No widget or view types.
use crate::Value;
use std::time::Duration;
pub struct SliderSpec {
    pub min: f32,
    pub max: f32,
    pub step: f32,
    pub decimals: usize,
    pub unit: String,
    pub factor: f32,
    pub commit_on_release: bool,
    pub debounce: Duration,
}
/// A radio group's options: the schema's `ui.options` (segmented) or `ui.presets` (preset).
pub fn choice_options(
    key: &str,
    entry: &serde_json::Value,
    control: &str,
) -> Result<Vec<(String, Value)>, String> {
    let ui = &entry["ui"];
    if control == "preset" {
        let unit = ui["presetUnit"].as_str().unwrap_or_default();
        return ui["presets"]
            .as_array()
            .ok_or_else(|| format!("{key}: a preset row without presets"))?
            .iter()
            .map(|p| {
                let v = Value::from_json(p).ok_or_else(|| format!("{key}: a preset of no kind"))?;
                Ok((format!("{}{unit}", v.predicate_text()), v))
            })
            .collect();
    }
    ui["options"]
        .as_array()
        .ok_or_else(|| format!("{key}: a segmented row without options"))?
        .iter()
        .map(|o| {
            let value = o["value"]
                .as_str()
                .ok_or_else(|| format!("{key}: an option without its value"))?;
            let label = o["label"].as_str().unwrap_or(value);
            Ok((label.to_owned(), Value::Text(value.to_owned())))
        })
        .collect()
}

/// A slider's range from the schema: `min`/`max`, and `ui.slider`'s unit, pct, decimals,
/// step, commitOnRelease and debounce — with the legacy row's defaults where it has them
/// (`NidaraSliderRow`: whole numbers unless decimals or pct; a debounce of 32 ms).
pub fn slider(key: &str, entry: &serde_json::Value) -> Result<SliderSpec, String> {
    let s = &entry["ui"]["slider"];
    let num = |v: &serde_json::Value, what: &str| {
        v.as_f64()
            .map(|n| n as f32)
            .ok_or_else(|| format!("{key}: no {what}"))
    };
    let pct = s["pct"].as_bool().unwrap_or(false);
    let factor = if pct { 100. } else { 1. };
    let decimals = s["decimals"].as_u64().map(|d| d as usize);
    let step = match s["step"].as_f64() {
        Some(step) => step as f32 * factor,
        None => match decimals {
            Some(d) if !pct => 10f32.powi(-(d as i32)),
            _ => 1.,
        },
    };
    let range = SliderSpec {
        min: num(&entry["min"], "min")? * factor,
        max: num(&entry["max"], "max")? * factor,
        step,
        decimals: if pct { 0 } else { decimals.unwrap_or(0) },
        factor,
        commit_on_release: false,
        debounce: Duration::ZERO,
        unit: if pct {
            "%".into()
        } else {
            s["unit"].as_str().unwrap_or_default().to_owned()
        },
    };
    Ok(SliderSpec {
        factor,
        commit_on_release: s["commitOnRelease"].as_bool().unwrap_or(false),
        debounce: Duration::from_millis(s["debounce"].as_u64().unwrap_or(32)),
        ..range
    })
}

pub fn dropdown_options(
    entry: &serde_json::Value,
    current: &str,
) -> Result<Vec<(String, String)>, String> {
    let mut out = Vec::new();
    for option in entry["ui"]["options"]
        .as_array()
        .ok_or("dropdown schema has no options")?
    {
        let value = option["value"]
            .as_str()
            .ok_or("dropdown option has no string value")?;
        if out.iter().any(|(v, _)| v == value) {
            return Err("duplicate dropdown value".into());
        }
        out.push((
            value.to_owned(),
            option["label"].as_str().unwrap_or(value).to_owned(),
        ));
    }
    if out.is_empty() {
        return Err("dropdown schema options are empty".into());
    }
    if !out.iter().any(|(v, _)| v == current) {
        out.push((current.into(), current.into()));
    }
    Ok(out)
}
