// SPDX-License-Identifier: LGPL-3.0-or-later
//! Phase 0 uses the existing dark startup tokens, not a second colour table.
//! Live appearance/portal integration belongs to phase 1. No stylesheet engine.
use nk_render::{Color, rgba};
pub struct Palette {
    pub ink: Color,
    pub secondary: Color,
    pub field: Color,
    pub selection: Color,
}
impl Palette {
    pub fn startup() -> Result<Self, String> {
        Ok(Self {
            ink: token("--nidara-text")?,
            secondary: token("--nidara-text-secondary")?,
            field: token("--nidara-surface-back")?,
            selection: token("--nidara-accent-30")?,
        })
    }
}
fn token(name: &str) -> Result<Color, String> {
    let css = include_str!("../../../ui/shell/styles/_base.scss");
    let value = css
        .lines()
        .find_map(|line| line.trim().strip_prefix(&format!("{name}:")))
        .ok_or_else(|| format!("missing startup token {name}"))?;
    let rgba_text = value
        .trim()
        .strip_prefix("rgba(")
        .and_then(|s| s.split_once(')'))
        .map(|(v, _)| v)
        .ok_or_else(|| format!("startup token {name} is no longer rgba"))?;
    let parts: Vec<f32> = rgba_text
        .split(',')
        .map(|s| s.trim().parse().map_err(|e| format!("{name}: {e}")))
        .collect::<Result<_, _>>()?;
    if parts.len() != 4 {
        return Err(format!("invalid startup token {name}"));
    }
    Ok(rgba(
        parts[0] as u8,
        parts[1] as u8,
        parts[2] as u8,
        (parts[3] * 255.).round() as u8,
    ))
}
