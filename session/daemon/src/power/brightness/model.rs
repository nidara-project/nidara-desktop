// SPDX-License-Identifier: GPL-3.0-or-later
use serde::{Deserialize, Serialize};
use zbus::zvariant::Type;
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
pub struct Snapshot {
    pub generation: u64,
    pub revision: u64,
    pub devices: Vec<Device>,
}
pub fn step(value: u32, max: u32, direction: i32) -> Option<u32> {
    if ![-1, 1].contains(&direction) || max == 0 {
        return None;
    }
    let amount = max.div_ceil(20).max(1);
    let floor = max.div_ceil(100).max(1);
    Some(if direction > 0 {
        value.saturating_add(amount).min(max)
    } else {
        value.saturating_sub(amount).max(floor)
    })
}
pub fn vcp(text: &str) -> Option<(u32, u32)> {
    let lines: Vec<_> = text.lines().filter(|s| s.starts_with("VCP ")).collect();
    if lines.len() != 1 {
        return None;
    }
    let fields: Vec<_> = lines[0].split_whitespace().collect();
    if fields.len() != 5 || fields[..3] != ["VCP", "10", "C"] {
        return None;
    }
    let value = fields[3].parse().ok()?;
    let max = fields[4].parse().ok()?;
    (max > 0 && value <= max && max <= 65535).then_some((value, max))
}

/// A finite read-only recovery budget. Healthy channels have no deadline.
#[derive(Clone, Debug, Default)]
pub struct Recovery {
    next: usize,
    due: Option<std::time::Instant>,
}
impl Recovery {
    pub fn failed(&mut self, now: std::time::Instant) {
        const DELAYS: [u64; 3] = [2, 10, 60];
        if self.due.is_none()
            && let Some(seconds) = DELAYS.get(self.next)
        {
            self.due = Some(now + std::time::Duration::from_secs(*seconds));
            self.next += 1;
        }
    }
    pub fn recovered(&mut self) {
        *self = Self::default();
    }
    pub fn deadline(&self) -> Option<std::time::Instant> {
        self.due
    }
    pub fn take_due(&mut self, now: std::time::Instant) -> bool {
        if self.due.is_some_and(|d| d <= now) {
            self.due = None;
            true
        } else {
            false
        }
    }
}
