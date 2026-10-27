// SPDX-License-Identifier: GPL-3.0-or-later
//! Plain state shared by the native backend and D-Bus. No provider IDs survive an epoch.
use super::Error;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Channel {
    pub position: String,
    pub volume: f64,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub path: String,
    pub id: u32,
    pub serial: u64,
    pub kind: String,
    pub name: String,
    pub description: String,
    pub media_name: String,
    pub process_id: u32,
    pub endpoint_kind: String,
    pub application_id: String,
    pub application_name: String,
    pub icon_name: String,
    pub device: String,
    pub device_index: i32,
    pub volume: f64,
    pub muted: bool,
    pub channels: Vec<Channel>,
    pub capabilities: Vec<String>,
    pub state: String,
    pub targets: Vec<String>,
    pub requested_target: String,
    pub capture_kind: String,
    pub routes: Vec<String>,
    pub active_route: String,
    pub internal: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Device {
    pub path: String,
    pub id: u32,
    pub name: String,
    pub description: String,
    pub profiles: Vec<String>,
    pub active_profile: String,
    pub capabilities: Vec<String>,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Profile {
    pub path: String,
    pub device: String,
    pub index: i32,
    pub name: String,
    pub description: String,
    pub availability: String,
    pub priority: i32,
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Route {
    pub path: String,
    pub device: String,
    pub index: i32,
    pub device_index: i32,
    pub direction: String,
    pub name: String,
    pub description: String,
    pub availability: String,
    pub profiles: Vec<String>,
    pub active: bool,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Graph {
    pub generation: u64,
    pub state: String,
    pub error: String,
    pub default_output: String,
    pub default_input: String,
    pub nodes: BTreeMap<String, Node>,
    pub devices: BTreeMap<String, Device>,
    pub profiles: BTreeMap<String, Profile>,
    pub routes: BTreeMap<String, Route>,
    pub switch_policy: bool,
    pub defaults_available: bool,
}
impl Default for Graph {
    fn default() -> Self {
        Self {
            generation: 0,
            state: "unavailable".into(),
            error: String::new(),
            default_output: "/".into(),
            default_input: "/".into(),
            nodes: BTreeMap::new(),
            devices: BTreeMap::new(),
            profiles: BTreeMap::new(),
            routes: BTreeMap::new(),
            switch_policy: false,
            defaults_available: false,
        }
    }
}
impl Graph {
    pub fn node(&self, path: &str, capability: Option<&str>) -> Result<&Node, Error> {
        if !matches!(self.state.as_str(), "ready" | "degraded") {
            return Err(Error::Unavailable(self.error.clone()));
        }
        let n = self.nodes.get(path).ok_or_else(|| {
            Error::NotFound("node removed or belongs to an earlier generation".into())
        })?;
        if let Some(c) = capability
            && !n.capabilities.iter().any(|v| v == c)
        {
            return Err(Error::NotSupported(c.into()));
        }
        Ok(n)
    }
}
pub fn finite(value: f64, min: f64, max: f64) -> Result<f64, Error> {
    if !value.is_finite() || !(min..=max).contains(&value) {
        Err(Error::InvalidArgument(format!(
            "expected finite value in {min}..={max}"
        )))
    } else {
        Ok(value)
    }
}
/// Apply the scalar in cubic UI space, retaining per-channel amplitude ratios.
#[cfg(any(feature = "audio-native", test))]
pub fn scale(channels: &[Channel], target: f64) -> Vec<Channel> {
    let max = channels.iter().map(|c| c.volume).fold(0.0_f64, f64::max);
    channels
        .iter()
        .map(|c| Channel {
            position: c.position.clone(),
            volume: if max == 0.0 {
                target
            } else {
                target * (c.volume / max)
            },
        })
        .collect()
}
fn side(position: &str) -> i8 {
    match position {
        "FL" | "RL" | "SL" | "FLC" => -1,
        "FR" | "RR" | "SR" | "FRC" => 1,
        _ => 0,
    }
}
#[cfg(any(feature = "audio-native", test))]
pub fn can_balance(channels: &[Channel]) -> bool {
    channels.iter().any(|c| side(&c.position) == -1)
        && channels.iter().any(|c| side(&c.position) == 1)
}
pub fn balance(channels: &[Channel]) -> f64 {
    let level = |s| {
        channels
            .iter()
            .filter(|c| side(&c.position) == s)
            .map(|c| c.volume.powi(3))
            .fold(0.0_f64, f64::max)
    };
    let (l, r) = (level(-1), level(1));
    if l == r {
        0.0
    } else if l > r {
        r / l - 1.0
    } else {
        1.0 - l / r
    }
}
#[cfg(any(feature = "audio-native", test))]
pub fn set_balance(channels: &[Channel], value: f64) -> Vec<Channel> {
    let level = |s| {
        channels
            .iter()
            .filter(|c| side(&c.position) == s)
            .map(|c| c.volume)
            .fold(0.0_f64, f64::max)
    };
    let left = level(-1);
    let right = level(1);
    let peak = left.max(right);
    channels
        .iter()
        .map(|c| {
            let group = side(&c.position);
            let (own, other, attenuation) = match group {
                -1 => (left, right, 1.0 - value.max(0.0)),
                1 => (right, left, 1.0 + value.min(0.0)),
                _ => return c.clone(),
            };
            let ratio = if own > 0.0 {
                c.volume / own
            } else if other > 0.0 {
                let opposite = match c.position.as_str() {
                    "FL" => "FR",
                    "FR" => "FL",
                    "RL" => "RR",
                    "RR" => "RL",
                    "SL" => "SR",
                    "SR" => "SL",
                    "FLC" => "FRC",
                    "FRC" => "FLC",
                    _ => "",
                };
                channels
                    .iter()
                    .find(|v| v.position == opposite)
                    .map_or(1.0, |v| v.volume / other)
            } else {
                1.0
            };
            Channel {
                position: c.position.clone(),
                volume: peak * attenuation.cbrt() * ratio,
            }
        })
        .collect()
}
#[derive(Clone, Debug, PartialEq)]
pub struct Preferences {
    pub overamplification: bool,
    pub alerts_enabled: bool,
    pub alert_volume: f64,
    pub volume_feedback: bool,
    pub switch_on_connect: bool,
    pub sound_theme: String,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            overamplification: false,
            alerts_enabled: true,
            alert_volume: 0.5,
            volume_feedback: false,
            switch_on_connect: true,
            sound_theme: "freedesktop".into(),
        }
    }
}
impl Preferences {
    pub fn limit(&self) -> f64 {
        if self.overamplification { 1.5 } else { 1.0 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn stereo(l: f64, r: f64) -> Vec<Channel> {
        vec![
            Channel {
                position: "FL".into(),
                volume: l,
            },
            Channel {
                position: "FR".into(),
                volume: r,
            },
        ]
    }
    #[test]
    fn cubic_balance_roundtrip_and_surround() {
        for b in [-1.0, -0.7, 0.0, 0.3, 1.0] {
            let mut channels = stereo(0.8, 0.2);
            channels.push(Channel {
                position: "LFE".into(),
                volume: 0.4,
            });
            let changed = set_balance(&channels, b);
            assert!((balance(&changed) - b).abs() < 1e-9);
            assert_eq!(changed[2], channels[2]);
            assert!((balance(&scale(&changed, 0.6)) - b).abs() < 1e-9);
        }
        assert!(!can_balance(&[Channel {
            position: "MONO".into(),
            volume: 1.0
        }]));
    }
    #[test]
    fn surround_balance_keeps_front_rear_ratios_even_after_a_side_is_zero() {
        let channels = [
            ("FL", 0.8),
            ("FR", 0.2),
            ("RL", 0.4),
            ("RR", 0.1),
            ("FC", 0.6),
            ("LFE", 0.3),
        ]
        .into_iter()
        .map(|(position, volume)| Channel {
            position: position.into(),
            volume,
        })
        .collect::<Vec<_>>();
        for balance in [-1.0, 0.0, 1.0] {
            let changed = set_balance(&channels, balance);
            let centered = set_balance(&changed, 0.0);
            assert!((centered[2].volume / centered[0].volume - 0.5).abs() < 1e-9);
            assert!((centered[3].volume / centered[1].volume - 0.5).abs() < 1e-9);
            assert_eq!(centered[4], channels[4]);
            assert_eq!(centered[5], channels[5]);
        }
    }
    #[test]
    fn scalar_preserves_ratios_and_zero_recovers() {
        let out = scale(&stereo(0.4, 0.8), 1.5);
        assert_eq!((out[0].volume, out[1].volume), (0.75, 1.5));
        assert_eq!(scale(&stereo(0.0, 0.0), 0.7), stereo(0.7, 0.7));
        for value in [f64::NAN, f64::INFINITY, -0.1, 1.6] {
            assert!(finite(value, 0.0, 1.5).is_err());
        }
    }
    #[test]
    fn stale_identity_never_resolves() {
        let mut graph = Graph {
            state: "ready".into(),
            generation: 2,
            ..Default::default()
        };
        graph.nodes.insert(
            "/g2/n7".into(),
            Node {
                id: 7,
                ..Default::default()
            },
        );
        assert!(matches!(
            graph.node("/g1/n7", None),
            Err(Error::NotFound(_))
        ));
        graph.state = "unavailable".into();
        assert!(matches!(
            graph.node("/g2/n7", None),
            Err(Error::Unavailable(_))
        ));
    }
}
