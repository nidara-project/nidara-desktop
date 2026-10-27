// SPDX-License-Identifier: GPL-3.0-or-later
//! Pure battery policy. No timers, buses or destructive critical-battery action.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq)]
pub struct Preferences {
    pub automatic_saver: bool,
    pub show_percentage: bool,
    pub power_button: String,
    pub lid_battery: String,
    pub lid_ac: String,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            automatic_saver: true,
            show_percentage: true,
            power_button: "menu".into(),
            lid_battery: "suspend".into(),
            lid_ac: "suspend".into(),
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Battery {
    pub present: bool,
    pub on_battery: Option<bool>,
    pub percentage: Option<f64>,
    pub warning: u32,
    pub charging: bool,
}
#[derive(Clone, Debug, PartialEq)]
pub enum Effect {
    Low,
    Critical,
    Hook(u32),
    HoldSaver,
    ReleaseSaver,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Policy {
    pub low: bool,
    pub critical: bool,
    pub episode: u64,
    pub overridden: bool,
    #[serde(skip)]
    pub initialized: bool,
    #[serde(skip)]
    hook_armed: bool,
    #[serde(skip)]
    last_on_battery: Option<bool>,
    #[serde(skip)]
    wants_hold: bool,
}
impl Policy {
    pub fn manual_override(&mut self) {
        self.overridden = true;
        self.wants_hold = false;
    }
    pub fn update(&mut self, b: &Battery, enabled: bool) -> Vec<Effect> {
        let mut out = vec![];
        // Loss of telemetry cannot establish a new episode or erase a persisted
        // manual choice. Nor is an unavailable startup snapshot a hook baseline.
        if !b.present || b.on_battery.is_none() {
            if std::mem::take(&mut self.wants_hold) {
                out.push(Effect::ReleaseSaver);
            }
            return out;
        }
        let draining = b.present && b.on_battery == Some(true);
        let pct = b
            .percentage
            .filter(|p| p.is_finite() && (0.0..=100.0).contains(p));
        let low = draining && pct.map_or(matches!(b.warning, 3..=5), |p| p <= 20.0);
        let critical = draining && pct.map_or(matches!(b.warning, 4 | 5), |p| p <= 5.0);
        if !self.initialized {
            self.hook_armed = pct.is_some_and(|p| p > 20.0) || b.on_battery == Some(false);
        } else if b.on_battery == Some(false) {
            self.hook_armed = true;
            self.overridden = false;
        } else if self.last_on_battery == Some(false) && b.on_battery == Some(true) {
            self.episode = self.episode.saturating_add(1);
            self.overridden = false;
        }
        if pct.is_some_and(|p| p >= 25.0)
            || b.on_battery == Some(false)
            || (pct.is_none() && b.warning < 3)
        {
            if pct.is_some_and(|p| p >= 25.) || b.on_battery == Some(false) {
                self.hook_armed = true;
            }
            self.low = false;
        }
        if !draining {
            self.low = false;
            self.critical = false;
        }
        if low && !self.low {
            if self.initialized {
                self.overridden = false;
            }
            self.low = true;
            self.episode = self.episode.saturating_add(1);
            out.push(Effect::Low);
        }
        if critical && !self.critical {
            self.critical = true;
            out.push(Effect::Critical);
        }
        if pct.is_some_and(|p| p > 7.0) || !draining || (pct.is_none() && b.warning < 4) {
            self.critical = false;
        }
        if self.initialized
            && low
            && self.hook_armed
            && let Some(p) = pct
        {
            self.hook_armed = false;
            out.push(Effect::Hook(p.round() as u32));
        }
        let hold = enabled && draining && self.low && !self.overridden;
        if hold && !self.wants_hold {
            out.push(Effect::HoldSaver);
        }
        if !hold && self.wants_hold {
            out.push(Effect::ReleaseSaver);
        }
        self.wants_hold = hold;
        self.initialized = true;
        self.last_on_battery = b.on_battery;
        out
    }
    pub fn hold_failed(&mut self) {
        self.wants_hold = false;
    }
}
pub fn effective_button(preference: &str, menu_registered: bool, locked: bool) -> &str {
    if locked {
        "wake"
    } else if preference == "menu" && !menu_registered {
        "suspend"
    } else {
        preference
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn battery(p: f64, ac: bool) -> Battery {
        Battery {
            present: true,
            on_battery: Some(!ac),
            percentage: Some(p),
            ..Default::default()
        }
    }
    #[test]
    fn coarse_telemetry_and_restart_do_not_fabricate_crossings() {
        let mut policy = Policy::default();
        policy.update(
            &Battery {
                present: true,
                on_battery: Some(true),
                warning: 1,
                ..Default::default()
            },
            true,
        );
        assert!(
            !policy
                .update(&battery(10., false), true)
                .contains(&Effect::Hook(10))
        );
        policy.manual_override();
        let saved = serde_json::to_string(&policy).unwrap();
        let mut restarted: Policy = serde_json::from_str(&saved).unwrap();
        let effects = restarted.update(&battery(2., false), true);
        assert!(!effects.contains(&Effect::Low));
        assert!(!effects.contains(&Effect::HoldSaver));
        assert!(restarted.overridden);
        restarted.update(&battery(26., false), true);
        assert!(
            restarted
                .update(&battery(20., false), true)
                .contains(&Effect::HoldSaver)
        );
        let b = Battery {
            present: true,
            on_battery: Some(true),
            warning: 5,
            ..Default::default()
        };
        let mut policy = Policy::default();
        let e = policy.update(&b, true);
        assert!(e.contains(&Effect::Critical));
        assert!(!e.iter().any(|e| matches!(e, Effect::Hook(_))));
        policy.update(&Battery { warning: 1, ..b }, true);
        assert!(!policy.low && !policy.critical);
    }
    #[test]
    fn hysteresis_hook_baseline_and_critical_have_no_shutdown() {
        let mut p = Policy::default();
        let e = p.update(&battery(4.0, false), true);
        assert!(e.contains(&Effect::Critical));
        assert!(!e.iter().any(|e| matches!(e, Effect::Hook(_))));
        assert!(p.critical);
        p.update(&battery(6.0, false), true);
        assert!(p.critical);
        p.update(&battery(8.0, false), true);
        assert!(!p.critical);
        p.update(&battery(26.0, false), true);
        let e = p.update(&battery(20.0, false), true);
        assert!(e.contains(&Effect::Hook(20)));
        assert!(
            !p.update(&battery(19.0, false), true)
                .contains(&Effect::Hook(19))
        );
        p.update(&battery(80.0, true), true);
        assert!(!p.low);
    }
    #[test]
    fn manual_profile_choice_lasts_until_new_episode() {
        let mut p = Policy::default();
        p.update(&battery(30.0, false), true);
        assert!(
            p.update(&battery(20.0, false), true)
                .contains(&Effect::HoldSaver)
        );
        p.manual_override();
        assert!(
            !p.update(&battery(10.0, false), true)
                .contains(&Effect::HoldSaver)
        );
        p.update(&battery(10.0, true), true);
        assert!(
            p.update(&battery(10.0, false), true)
                .contains(&Effect::HoldSaver)
        );
    }
    #[test]
    fn unknown_power_is_not_ac_and_menu_absence_is_explicit() {
        let mut p = Policy::default();
        assert!(p.update(&Battery::default(), true).is_empty());
        assert_eq!(effective_button("menu", false, false), "suspend");
        assert_eq!(effective_button("menu", true, false), "menu");
        assert_eq!(effective_button("poweroff", false, true), "wake");
    }
}
