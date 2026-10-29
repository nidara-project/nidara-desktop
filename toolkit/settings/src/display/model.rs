// SPDX-License-Identifier: LGPL-3.0-or-later
//! Display1 wire records; independent client declarations, checked over a private bus.
use serde::{Deserialize, Serialize};
use zbus::zvariant::Type;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Mode {
    pub id: String,
    pub width: i32,
    pub height: i32,
    pub refresh_mhz: i32,
    pub preferred: bool,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Output {
    pub id: String,
    pub identity: String,
    pub connector: String,
    pub internal: bool,
    pub enabled: bool,
    pub powered: bool,
    pub make: String,
    pub model: String,
    pub serial: String,
    pub physical_width_mm: i32,
    pub physical_height_mm: i32,
    pub modes: Vec<Mode>,
    pub current_mode: String,
    pub scale: f64,
    pub transform: String,
    pub x: i32,
    pub y: i32,
    pub vrr_supported: bool,
    pub vrr: String,
    pub vrr_enabled: bool,
    pub number: u32,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(deny_unknown_fields)]
pub struct Setting {
    pub id: String,
    pub enabled: bool,
    pub mode: String,
    pub scale: f64,
    pub transform: String,
    pub x: i32,
    pub y: i32,
    pub vrr: String,
}
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, Type)]
#[serde(deny_unknown_fields)]
pub struct Layout {
    pub primary: String,
    pub outputs: Vec<Setting>,
    /// Ordered groups: the first output supplies the logical scene; the rest follow it.
    pub mirror_groups: Vec<Vec<String>>,
}
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Pending {
    pub token: String,
    pub phase: String,
    /// CLOCK_MONOTONIC microseconds; zero until all required outputs have presented.
    pub deadline_us: u64,
}
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Type)]
pub struct Snapshot {
    pub epoch: u64,
    pub revision: u64,
    pub capabilities: Vec<String>,
    pub outputs: Vec<Output>,
    pub layout: Layout,
    pub pending: Pending,
    pub last_error: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Device {
    pub id: String,
    pub output_id: String,
    pub provider: String,
    pub min: u32,
    pub max: u32,
    pub current: u32,
    pub available: bool,
    pub writable: bool,
    pub epoch: u64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Brightness {
    pub generation: u64,
    pub revision: u64,
    pub devices: Vec<Device>,
}
/// Both the visual countdown and its accessible label use the compositor's
/// CLOCK_MONOTONIC deadline; receipt time never starts a new lease.
pub fn seconds(deadline: u64, now: u64) -> u64 {
    deadline.saturating_sub(now).div_ceil(1_000_000)
}
pub fn now_us() -> u64 {
    let mut time = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: a valid writable timespec, no aliasing or retained pointer.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut time) } != 0 {
        return u64::MAX;
    }
    (time.tv_sec as u64).saturating_mul(1_000_000) + time.tv_nsec as u64 / 1000
}
pub fn dimensions(s: &Setting, output: &Output) -> Option<(i32, i32)> {
    let mode = output.modes.iter().find(|m| m.id == s.mode)?;
    if !s.scale.is_finite() || !(0.25..=4.0).contains(&s.scale) {
        return None;
    }
    let (w, h) = if matches!(
        s.transform.as_str(),
        "90" | "270" | "flipped-90" | "flipped-270"
    ) {
        (mode.height, mode.width)
    } else {
        (mode.width, mode.height)
    };
    Some((
        (w as f64 / s.scale).round() as i32,
        (h as f64 / s.scale).round() as i32,
    ))
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Preset {
    Internal,
    External,
    Extend,
    Mirror,
}
pub fn current_preset(snapshot: &Snapshot) -> Preset {
    if !snapshot.layout.mirror_groups.is_empty() {
        return Preset::Mirror;
    }
    let enabled: Vec<_> = snapshot
        .outputs
        .iter()
        .filter(|o| {
            snapshot
                .layout
                .outputs
                .iter()
                .any(|s| s.id == o.id && s.enabled)
        })
        .collect();
    if enabled.iter().all(|o| o.internal) {
        Preset::Internal
    } else if enabled.iter().all(|o| !o.internal) {
        Preset::External
    } else {
        Preset::Extend
    }
}
/// Presets are drafts only. Display1.Validate remains the authority and no client
/// fallback changes the hardware after a refusal.
pub fn preset(snapshot: &Snapshot, choice: Preset) -> Result<Layout, String> {
    if choice == Preset::Mirror && !snapshot.capabilities.iter().any(|c| c == "mirror") {
        return Err("mirror capability unavailable".into());
    }
    let mut outputs: Vec<_> = snapshot.outputs.iter().collect();
    outputs.sort_by_key(|o| (!o.internal, &o.identity, &o.id));
    let mut layout = Layout::default();
    let mut x = 0;
    for output in outputs {
        let enabled = match choice {
            Preset::Internal => output.internal,
            Preset::External => !output.internal,
            _ => true,
        };
        let mode = output
            .modes
            .iter()
            .find(|m| m.preferred)
            .or(output.modes.first());
        let mut setting = Setting {
            id: output.id.clone(),
            enabled: enabled && mode.is_some(),
            mode: mode.map(|m| m.id.clone()).unwrap_or_default(),
            scale: 1.,
            transform: "normal".into(),
            x,
            y: 0,
            vrr: "off".into(),
        };
        if setting.enabled {
            // Keep a valid observed scale. This client does not invent another DPI policy.
            setting.scale = if output.scale.is_finite() && (0.25..=4.0).contains(&output.scale) {
                output.scale
            } else {
                1.
            };
            if layout.primary.is_empty() {
                layout.primary = output.id.clone();
            }
            if choice != Preset::Mirror {
                x += dimensions(&setting, output).ok_or("invalid mode")?.0;
            }
        }
        layout.outputs.push(setting);
    }
    if layout.primary.is_empty() {
        return Err("preset has no usable output".into());
    }
    if choice == Preset::Mirror {
        let ids: Vec<_> = layout
            .outputs
            .iter()
            .filter(|o| o.enabled)
            .map(|o| o.id.clone())
            .collect();
        if ids.len() < 2 {
            return Err("mirror needs two outputs".into());
        }
        layout.mirror_groups.push(ids);
    }
    Ok(layout)
}
/// Keyboard order changes and pointer placement both leave a draft. Server
/// Validate/Preview perform full connectivity/resource validation before mutation.
pub fn reorder(layout: &mut Layout, outputs: &[Output], selected: &str, delta: isize) {
    let mut order: Vec<_> = layout
        .outputs
        .iter()
        .filter(|s| s.enabled)
        .map(|s| s.id.clone())
        .collect();
    order.sort_by_key(|id| {
        let s = layout.outputs.iter().find(|s| &s.id == id).unwrap();
        (s.x, s.y)
    });
    if let Some(i) = order.iter().position(|id| id == selected) {
        let j = (i as isize + delta).clamp(0, order.len() as isize - 1) as usize;
        order.swap(i, j);
    }
    layout.mirror_groups.clear();
    let mut x = 0;
    for id in order {
        if let Some(s) = layout.outputs.iter_mut().find(|s| s.id == id) {
            s.x = x;
            s.y = 0;
            if let Some(o) = outputs.iter().find(|o| o.id == id) {
                x += dimensions(s, o).map(|v| v.0).unwrap_or(0);
            }
        }
    }
}

/// Disabling a physical mirror member removes it from the group and promotes a
/// surviving source. It never leaves a primary pointing at a follower/disabled
/// output, and it refuses the last enabled output before changing the draft.
pub fn set_enabled(
    layout: &mut Layout,
    outputs: &[Output],
    id: &str,
    enabled: bool,
) -> Result<(), String> {
    if !enabled
        && layout.outputs.iter().filter(|s| s.enabled).count() <= 1
        && layout.outputs.iter().any(|s| s.id == id && s.enabled)
    {
        return Err("last output cannot be disabled".into());
    }
    let output = outputs.iter().find(|o| o.id == id).ok_or("output lost")?;
    let setting = layout
        .outputs
        .iter_mut()
        .find(|s| s.id == id)
        .ok_or("setting lost")?;
    if enabled && !output.modes.iter().any(|m| m.id == setting.mode) {
        setting.mode = output
            .modes
            .iter()
            .find(|m| m.preferred)
            .or(output.modes.first())
            .ok_or("no advertised mode")?
            .id
            .clone();
    }
    setting.enabled = enabled;
    if !enabled {
        for group in &mut layout.mirror_groups {
            group.retain(|member| member != id);
        }
        layout.mirror_groups.retain(|group| group.len() >= 2);
    }
    let logical = |id: &str| {
        !layout
            .mirror_groups
            .iter()
            .any(|group| group.iter().skip(1).any(|f| f == id))
    };
    if !layout
        .outputs
        .iter()
        .any(|s| s.id == layout.primary && s.enabled && logical(&s.id))
    {
        layout.primary = layout
            .outputs
            .iter()
            .find(|s| s.enabled && logical(&s.id))
            .map(|s| s.id.clone())
            .unwrap_or_default();
    }
    Ok(())
}
