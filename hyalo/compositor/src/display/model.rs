// SPDX-License-Identifier: GPL-3.0-or-later
//! Display1's wire model and geometry. No DRM, D-Bus connection or wall clock.
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
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

pub fn internal(connector: &str) -> bool {
    ["eDP-", "LVDS-", "DSI-"].iter().any(|p| connector.starts_with(p))
}
pub fn observed(outputs: &[Output], primary: &str) -> Layout {
    Layout {
        primary: outputs
            .iter()
            .find(|o| o.id == primary && o.enabled)
            .or_else(|| outputs.iter().find(|o| o.enabled && o.internal))
            .or_else(|| outputs.iter().find(|o| o.enabled))
            .map(|o| o.id.clone())
            .unwrap_or_default(),
        outputs: outputs
            .iter()
            .map(|o| Setting {
                id: o.id.clone(),
                enabled: o.enabled,
                mode: o.current_mode.clone(),
                scale: o.scale,
                transform: o.transform.clone(),
                x: o.x,
                y: o.y,
                vrr: o.vrr.clone(),
            })
            .collect(),
        mirror_groups: Vec::new(),
    }
}
/// The profile key is a multiset (not a set): identical monitors must not collapse.
pub fn profile_key(outputs: &[Output]) -> String {
    let mut ids: Vec<_> = outputs.iter().map(|o| &o.identity).collect();
    ids.sort();
    serde_json::to_string(&ids).expect("strings serialize")
}

pub fn dimensions(s: &Setting, o: &Output) -> Result<(i32, i32), String> {
    if !s.scale.is_finite() || !(0.25..=4.0).contains(&s.scale) {
        return Err("scale outside 0.25..4".into());
    }
    let mode = o
        .modes
        .iter()
        .find(|m| m.id == s.mode)
        .ok_or("mode is not advertised")?;
    let swapped = match s.transform.as_str() {
        "normal" | "180" | "flipped" | "flipped-180" => false,
        "90" | "270" | "flipped-90" | "flipped-270" => true,
        _ => return Err("unknown transform".into()),
    };
    let (w, h) = if swapped {
        (mode.height, mode.width)
    } else {
        (mode.width, mode.height)
    };
    if w <= 0 || h <= 0 || mode.refresh_mhz <= 0 {
        return Err("invalid mode dimensions".into());
    }
    Ok((
        (f64::from(w) / s.scale).round() as i32,
        (f64::from(h) / s.scale).round() as i32,
    ))
}

pub fn validate(mut layout: Layout, outputs: &[Output]) -> Result<Layout, String> {
    let mut followers = BTreeMap::new();
    let mut members = BTreeSet::new();
    for group in &layout.mirror_groups {
        if group.len() < 2 {
            return Err("a mirror group needs a source and a follower".into());
        }
        for id in group {
            if !members.insert(id.clone()) {
                return Err("mirror groups must be disjoint".into());
            }
            let setting = layout
                .outputs
                .iter()
                .find(|s| &s.id == id && s.enabled)
                .ok_or("mirror member must be connected and enabled")?;
            if setting.vrr != "off" {
                return Err("VRR must be off within a mirror group".into());
            }
        }
        for id in group.iter().skip(1) {
            followers.insert(id.clone(), group[0].clone());
        }
    }
    if followers.contains_key(&layout.primary) {
        return Err("primary must be a logical source, not a mirror follower".into());
    }
    if outputs.len() > 64 || layout.outputs.len() != outputs.len() {
        return Err("layout must name every connected output once".into());
    }
    let mut seen = BTreeSet::new();
    let mut boxes = Vec::new();
    for s in &layout.outputs {
        if !seen.insert(&s.id) {
            return Err("duplicate output".into());
        }
        let o = outputs.iter().find(|o| o.id == s.id).ok_or("obsolete output")?;
        // Validate disabled settings too; they must remain safe to enable later.
        let (w, h) = if !s.enabled
            && s.mode.is_empty()
            && o.modes.is_empty()
            && s.scale.is_finite()
            && (0.25..=4.0).contains(&s.scale)
            && matches!(
                s.transform.as_str(),
                "normal" | "90" | "180" | "270" | "flipped" | "flipped-90" | "flipped-180" | "flipped-270"
            ) {
            (0, 0)
        } else {
            dimensions(s, o)?
        };
        if !matches!(s.vrr.as_str(), "off" | "on" | "games") || (s.enabled && s.vrr != "off" && !o.vrr_supported) {
            return Err("VRR is not supported".into());
        }
        if s.enabled && !followers.contains_key(&s.id) {
            // Leave headroom for renderer arithmetic and union rectangles, as well as i32.
            if s.x.abs_diff(0) > 1_000_000 || s.y.abs_diff(0) > 1_000_000 {
                return Err("position outside supported desktop".into());
            }
            boxes.push((s.x as i64, s.y as i64, s.x as i64 + w as i64, s.y as i64 + h as i64));
        }
    }
    if boxes.is_empty() {
        return Err("cannot disable the last output".into());
    }
    if !layout.outputs.iter().any(|s| s.id == layout.primary && s.enabled) {
        return Err("primary must be enabled".into());
    }
    let mut edges = vec![Vec::new(); boxes.len()];
    for (i, &(l, t, r, b)) in boxes.iter().enumerate() {
        for (j, &(ll, tt, rr, bb)) in boxes.iter().enumerate().take(i) {
            let x = r.min(rr) - l.max(ll);
            let y = b.min(bb) - t.max(tt);
            if x > 0 && y > 0 {
                return Err("outputs overlap".into());
            }
            if (x == 0 && y > 0) || (y == 0 && x > 0) {
                edges[i].push(j);
                edges[j].push(i);
            }
        }
    }
    let mut reached = BTreeSet::new();
    let mut stack = vec![0];
    while let Some(i) = stack.pop() {
        if reached.insert(i) {
            stack.extend(&edges[i]);
        }
    }
    if reached.len() != boxes.len() {
        return Err("outputs must touch along an edge".into());
    }
    let locations: BTreeMap<_, _> = layout
        .outputs
        .iter()
        .map(|s| (s.id.clone(), (s.x, s.y)))
        .collect();
    for setting in &mut layout.outputs {
        if let Some(source) = followers.get(&setting.id) {
            let (x, y) = locations[source];
            setting.x = x;
            setting.y = y;
        }
    }
    layout.outputs.sort_by(|a, b| a.id.cmp(&b.id));
    for group in &mut layout.mirror_groups {
        group[1..].sort();
    }
    layout.mirror_groups.sort_by(|a, b| a[0].cmp(&b[0]));
    Ok(layout)
}

pub fn default_layout(outputs: &[Output]) -> Layout {
    let mut sorted: Vec<_> = outputs.iter().collect();
    sorted.sort_by_key(|o| (!o.internal, &o.identity, &o.id));
    let mut layout = Layout::default();
    let mut x = 0;
    for o in sorted {
        let Some(mode) = o.modes.iter().find(|m| m.preferred).or(o.modes.first()) else {
            layout.outputs.push(Setting {
                id: o.id.clone(),
                enabled: false,
                mode: String::new(),
                scale: 1.0,
                transform: "normal".into(),
                x: 0,
                y: 0,
                vrr: "off".into(),
            });
            continue;
        };
        let dpi = if o.physical_width_mm >= 100 && o.physical_width_mm <= 3000 {
            mode.width as f64 * 25.4 / o.physical_width_mm as f64
        } else {
            96.0
        };
        // Down to the quarter step, never up: the density alone must ask for the larger size.
        // The epsilon keeps an exact step (192 dpi = 2.0) from flooring a step below.
        let scale = if dpi.is_finite() && (50.0..=400.0).contains(&dpi) {
            ((dpi / 96.0 * 4.0 + 1e-9).floor() / 4.0).clamp(1.0, 3.0)
        } else {
            1.0
        };
        let s = Setting {
            id: o.id.clone(),
            enabled: true,
            mode: mode.id.clone(),
            scale,
            transform: "normal".into(),
            x,
            y: 0,
            vrr: "off".into(),
        };
        x += dimensions(&s, o).map(|d| d.0).unwrap_or(0);
        if layout.primary.is_empty() {
            layout.primary = o.id.clone();
        }
        layout.outputs.push(s);
    }
    layout
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Profiles {
    pub version: u32,
    pub sets: BTreeMap<String, Layout>,
}
impl Profiles {
    pub fn remember(&mut self, outputs: &[Output], layout: &Layout) {
        // Persist stable identities; the bus ids are scoped to a connection epoch.
        let mut layout = layout.clone();
        for id in layout.mirror_groups.iter_mut().flatten() {
            if let Some(o) = outputs.iter().find(|o| o.id == *id) {
                *id = o.identity.clone();
            }
        }
        for s in &mut layout.outputs {
            if let Some(o) = outputs.iter().find(|o| o.id == s.id) {
                if layout.primary == s.id {
                    layout.primary = o.identity.clone();
                }
                s.id = o.identity.clone();
            }
        }
        self.version = 1;
        self.sets.insert(profile_key(outputs), layout);
    }
    pub fn recall(&self, outputs: &[Output]) -> Option<Layout> {
        let mut l = self.sets.get(&profile_key(outputs))?.clone();
        for id in l.mirror_groups.iter_mut().flatten() {
            *id = outputs.iter().find(|o| o.identity == *id)?.id.clone();
        }
        for s in &mut l.outputs {
            let o = outputs.iter().find(|o| o.identity == s.id)?;
            if l.primary == s.id {
                l.primary = o.id.clone();
            }
            s.id = o.id.clone();
        }
        validate(l, outputs).ok()
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub fn output(id: &str, internal: bool, w: i32, h: i32) -> Output {
        Output {
            id: id.into(),
            identity: format!("identity-{id}"),
            connector: id.into(),
            internal,
            enabled: true,
            powered: true,
            make: "Test".into(),
            model: "Panel".into(),
            serial: id.into(),
            physical_width_mm: 0,
            physical_height_mm: 0,
            modes: vec![Mode {
                id: format!("{w}x{h}@60000"),
                width: w,
                height: h,
                refresh_mhz: 60000,
                preferred: true,
            }],
            current_mode: format!("{w}x{h}@60000"),
            scale: 1.0,
            transform: "normal".into(),
            x: 0,
            y: 0,
            vrr_supported: false,
            vrr: "off".into(),
            vrr_enabled: false,
            number: 1,
        }
    }
    #[test]
    fn defaults_are_internal_first_top_aligned_and_order_independent() {
        let outputs = vec![output("z", false, 1920, 1080), output("a", true, 1600, 900)];
        let l = default_layout(&outputs);
        assert_eq!(l.primary, "a");
        assert_eq!(l.outputs[0].x, 0);
        assert_eq!(l.outputs[1].x, 1600);
        assert!(l.outputs.iter().all(|s| s.y == 0));
        assert!(validate(l.clone(), &outputs).is_ok());
        assert_eq!(l, default_layout(&[outputs[1].clone(), outputs[0].clone()]));
    }
    #[test]
    fn overlap_gap_and_corner_only_contact_are_rejected() {
        let outputs = vec![output("a", true, 100, 100), output("b", false, 100, 100)];
        for (x, y) in [(99, 0), (101, 0), (100, 100)] {
            let mut l = default_layout(&outputs);
            l.outputs[1].x = x;
            l.outputs[1].y = y;
            assert!(validate(l, &outputs).is_err(), "accepted ({x},{y})");
        }
    }
    #[test]
    fn different_heights_and_negative_origins_need_no_filled_bounding_box() {
        let outputs = vec![output("a", true, 100, 100), output("b", false, 100, 200)];
        let mut l = default_layout(&outputs);
        l.outputs[0].x = -100;
        l.outputs[1].x = 0;
        assert!(validate(l, &outputs).is_ok());
    }
    #[test]
    fn scaling_and_rotation_use_logical_extents() {
        let outputs = vec![output("a", true, 200, 100), output("b", false, 100, 100)];
        let mut l = default_layout(&outputs);
        l.outputs[0].scale = 2.0;
        l.outputs[0].transform = "90".into();
        l.outputs[1].x = 50;
        assert!(validate(l.clone(), &outputs).is_ok());
        l.outputs[1].x = 51;
        assert!(validate(l, &outputs).is_err());
    }
    #[test]
    fn last_output_and_disabled_primary_are_rejected() {
        let outputs = vec![output("a", true, 100, 100), output("b", false, 100, 100)];
        let mut l = default_layout(&outputs);
        l.outputs[0].enabled = false;
        assert!(validate(l.clone(), &outputs).is_err());
        l.primary = "b".into();
        assert!(validate(l.clone(), &outputs).is_ok());
        l.outputs[1].enabled = false;
        assert!(validate(l, &outputs).is_err());
    }
    #[test]
    fn complete_current_inventory_is_required() {
        let outputs = vec![output("a", true, 100, 100), output("b", false, 100, 100)];
        let l = default_layout(&outputs);
        let mut missing = l.clone();
        missing.outputs.pop();
        assert!(validate(missing, &outputs).is_err());
        let mut duplicate = l.clone();
        duplicate.outputs[1] = duplicate.outputs[0].clone();
        assert!(validate(duplicate, &outputs).is_err());
        let mut stale = l;
        stale.outputs[0].id = "old-epoch".into();
        assert!(validate(stale, &outputs).is_err());
    }
    #[test]
    fn invalid_numeric_values_modes_vrr_and_mirror_fail_before_application() {
        let outputs = vec![output("a", true, 100, 100)];
        let base = default_layout(&outputs);
        for scale in [f64::NAN, f64::INFINITY, 0.0, 4.1] {
            let mut l = base.clone();
            l.outputs[0].scale = scale;
            assert!(validate(l, &outputs).is_err());
        }
        let mut l = base.clone();
        l.outputs[0].x = i32::MIN;
        assert!(validate(l, &outputs).is_err());
        let mut l = base.clone();
        l.outputs[0].mode = "not-advertised".into();
        assert!(validate(l, &outputs).is_err());
        let mut l = base.clone();
        l.outputs[0].vrr = "on".into();
        assert!(validate(l, &outputs).is_err());
        let mut l = base;
        l.mirror_groups = vec![vec!["a".into()]];
        assert!(validate(l, &outputs).is_err());
    }
    #[test]
    fn mirror_uses_one_logical_rectangle_and_keeps_native_modes() {
        let outputs = vec![
            output("a", true, 1920, 1080),
            output("b", false, 1024, 768),
            output("c", false, 800, 600),
        ];
        let mut layout = default_layout(&outputs);
        layout.mirror_groups = vec![vec!["a".into(), "b".into()]];
        layout.outputs[1].scale = 1.25;
        layout.outputs[1].transform = "90".into();
        layout.outputs[2].x = 1920;
        let l = validate(layout.clone(), &outputs).unwrap();
        assert_eq!(l.outputs[1].mode, "1024x768@60000");
        assert_eq!((l.outputs[1].x, l.outputs[1].y), (0, 0));
        assert_eq!(l.outputs[1].scale, 1.25);
        layout.primary = "b".into();
        assert!(validate(layout.clone(), &outputs).is_err());
        layout.primary = "a".into();
        layout.outputs[1].enabled = false;
        assert!(validate(layout.clone(), &outputs).is_err());
        layout.outputs[1].enabled = true;
        layout.outputs[1].vrr = "on".into();
        assert!(validate(layout.clone(), &outputs).is_err());
        layout.outputs[1].vrr = "off".into();
        layout.mirror_groups.push(vec!["c".into(), "b".into()]);
        assert!(validate(layout, &outputs).is_err());
    }
    #[test]
    fn mirror_profile_preserves_source_and_follows_stable_identities() {
        let outputs = vec![
            output("a", true, 1920, 1080),
            output("b", false, 1024, 768),
            output("c", false, 800, 600),
        ];
        let mut layout = default_layout(&outputs);
        layout.primary = "b".into();
        layout.mirror_groups = vec![vec!["b".into(), "c".into(), "a".into()]];
        let layout = validate(layout, &outputs).unwrap();
        let mut profiles = Profiles::default();
        profiles.remember(&outputs, &layout);
        let mut reconnected = outputs.clone();
        for o in &mut reconnected {
            o.id = format!("epoch2-{}", o.id);
        }
        reconnected.reverse();
        let restored = profiles.recall(&reconnected).unwrap();
        assert_eq!(restored.primary, "epoch2-b");
        assert_eq!(
            restored.mirror_groups,
            vec![vec!["epoch2-b", "epoch2-a", "epoch2-c"]]
        );
        assert_eq!(restored.outputs.len(), 3);
        assert!(!serde_json::to_string(&profiles).unwrap().contains("epoch2"));
    }
    #[test]
    fn profile_roundtrip_survives_epoch_and_connector_order_changes() {
        let outputs = vec![output("a", true, 100, 100), output("b", false, 100, 100)];
        let mut l = default_layout(&outputs);
        l.primary = "b".into();
        l.outputs[0].enabled = false;
        let mut p = Profiles::default();
        p.remember(&outputs, &l);
        let mut reconnected = outputs.clone();
        reconnected[0].id = "epoch2-a".into();
        reconnected[1].id = "epoch2-b".into();
        reconnected.reverse();
        let restored = p.recall(&reconnected).unwrap();
        assert_eq!(restored.primary, "epoch2-b");
        assert!(!restored.outputs.iter().find(|s| s.id == "epoch2-a").unwrap().enabled);
        assert_eq!(p.sets.len(), 1);
        assert!(!serde_json::to_string(&p).unwrap().contains("epoch2"));
    }
    #[test]
    fn disabled_connected_outputs_belong_to_profile_key() {
        let mut outputs = vec![output("a", true, 100, 100), output("b", false, 100, 100)];
        let key = profile_key(&outputs);
        outputs[1].enabled = false;
        assert_eq!(key, profile_key(&outputs));
        assert_ne!(key, profile_key(&outputs[..1]));
        outputs[1].identity = outputs[0].identity.clone();
        assert_ne!(profile_key(&outputs), profile_key(&outputs[..1]));
    }
    #[test]
    fn obsolete_mode_profile_is_not_reapplied() {
        let mut outputs = vec![output("a", true, 100, 100)];
        let mut p = Profiles::default();
        p.remember(&outputs, &default_layout(&outputs));
        outputs[0].modes.clear();
        assert!(p.recall(&outputs).is_none());
    }
    #[test]
    fn connected_output_without_modes_stays_in_inventory_but_cannot_be_enabled() {
        let mut outputs = vec![output("a", true, 100, 100), output("b", false, 100, 100)];
        outputs[1].modes.clear();
        outputs[1].enabled = false;
        outputs[1].current_mode.clear();
        let l = default_layout(&outputs);
        assert_eq!(l.outputs.len(), 2);
        assert!(validate(l.clone(), &outputs).is_ok());
        let mut bad = l;
        bad.outputs[1].enabled = true;
        assert!(validate(bad, &outputs).is_err());
    }
    #[test]
    fn dpi_unknown_or_implausible_is_conservative() {
        let mut outputs = vec![output("a", true, 3840, 2160)];
        assert_eq!(default_layout(&outputs).outputs[0].scale, 1.0);
        outputs[0].physical_width_mm = 200;
        assert_eq!(default_layout(&outputs).outputs[0].scale, 1.0);
        outputs[0].physical_width_mm = 330;
        assert_eq!(default_layout(&outputs).outputs[0].scale, 3.0);
    }
    #[test]
    fn dpi_scale_rounds_down_to_the_quarter_step() {
        // (panel, width px, height px, width mm, scale)
        for (name, w, h, mm, want) in [
            ("24in 1080p", 1920, 1080, 531, 1.0),
            ("27in 1440p", 2560, 1440, 600, 1.0),
            ("32in 4K", 3840, 2160, 708, 1.25),
            ("27in 4K", 3840, 2160, 597, 1.5),
            ("27in 5K", 5120, 2880, 597, 2.25),
            ("14in 1080p laptop", 1920, 1080, 310, 1.5),
            ("exactly 192 dpi", 1920, 1080, 254, 2.0),
        ] {
            let mut outputs = vec![output("a", false, w, h)];
            outputs[0].physical_width_mm = mm;
            assert_eq!(default_layout(&outputs).outputs[0].scale, want, "{name}");
        }
    }
}
