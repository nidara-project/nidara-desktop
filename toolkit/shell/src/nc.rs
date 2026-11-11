// SPDX-License-Identifier: LGPL-3.0-or-later
//! What the notification centre keeps besides its view (`nc_view.rs`): the month its calendar
//! shows, the targets that change it or dismiss in bulk, and how a group and an age are named.
use crate::notifications::Banner;
use std::sync::OnceLock;

/// The centre's panel in the bar's semantic tree; its controls' ids follow it.
pub const PANEL: u64 = 1 << 54;
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Previous,
    Next,
    Today,
    ClearAll,
    ClearGroup(String),
}
/// The month the calendar shows.
pub struct Month {
    pub year: i32,
    pub month: i32,
}
impl Default for Month {
    fn default() -> Self {
        let now = glib::DateTime::now_local().ok();
        Self {
            year: now.as_ref().map_or(2026, |d| d.year()),
            month: now.as_ref().map_or(1, |d| d.month()),
        }
    }
}
pub fn group(b: &Banner) -> String {
    let key = b.notice.hint("desktop-entry");
    if key.is_empty() {
        b.notice.app_name.clone()
    } else {
        key.into()
    }
}
pub fn age(time: u64, now: u64) -> String {
    let seconds = now.saturating_sub(time);
    match seconds {
        0..60 => "now".into(),
        60..3600 => format!("{} min", seconds / 60),
        3600..86400 => format!("{} h", seconds / 3600),
        _ => format!("{} d", seconds / 86400),
    }
}
fn parse_week_start(text: &str) -> Option<usize> {
    let mut values = text.split_whitespace();
    let first: i32 = values.next()?.parse().ok()?;
    let reference: i32 = values.next()?.parse().ok()?;
    if !(1..=7).contains(&first) {
        return None;
    }
    let base = glib::DateTime::from_local(
        reference / 10000,
        reference / 100 % 100,
        reference % 100,
        0,
        0,
        0.,
    )
    .ok()?
    .day_of_week();
    Some(((base + first - 2) % 7 + 1) as usize)
}
fn week_start() -> usize {
    static FIRST: OnceLock<usize> = OnceLock::new();
    // glibc's locale tool exposes both the reference date and relative first
    // weekday. Read once, not on paint; no extra library dependency or FFI.
    *FIRST.get_or_init(|| {
        std::process::Command::new("locale")
            .args(["first_weekday", "week-1stday"])
            .output()
            .ok()
            .filter(|r| r.status.success())
            .and_then(|r| parse_week_start(&String::from_utf8_lossy(&r.stdout)))
            .unwrap_or(1)
    })
}
pub(crate) fn weekday_labels() -> Vec<String> {
    let monday = glib::DateTime::from_local(2024, 1, 1, 0, 0, 0.).unwrap();
    (0..7)
        .map(|i| {
            monday
                .add_days(((week_start() - 1 + i) % 7) as i32)
                .ok()
                .and_then(|d| d.format("%a").ok())
                .map(|s| s.to_string())
                .unwrap_or_default()
        })
        .collect()
}
pub fn calendar(year: i32, month: i32) -> Vec<(i32, usize)> {
    calendar_with_start(year, month, week_start())
}
fn calendar_with_start(year: i32, month: i32, first_weekday: usize) -> Vec<(i32, usize)> {
    let Ok(first) = glib::DateTime::from_local(year, month, 1, 0, 0, 0.) else {
        return vec![];
    };
    let offset = (first.day_of_week() as usize + 7 - first_weekday) % 7;
    (1..=31)
        .take_while(|day| glib::DateTime::from_local(year, month, *day, 0, 0, 0.).is_ok())
        .map(|day| (day, offset + day as usize - 1))
        .collect()
}
impl Month {
    /// Moves the month; a bulk dismissal is returned for the hub (None: every group).
    pub fn change(&mut self, target: &Target) -> Option<Option<String>> {
        match target {
            Target::Previous | Target::Next => {
                if let Ok(d) = glib::DateTime::from_local(self.year, self.month, 1, 0, 0, 0.)
                    .and_then(|d| d.add_months(if *target == Target::Previous { -1 } else { 1 }))
                {
                    self.year = d.year();
                    self.month = d.month();
                }
            }
            Target::Today => {
                if let Ok(d) = glib::DateTime::now_local() {
                    self.year = d.year();
                    self.month = d.month();
                }
            }
            Target::ClearAll => return Some(None),
            Target::ClearGroup(key) => return Some(Some(key.clone())),
        }
        None
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn calendar_leap_year_and_relative_minutes() {
        let leap = calendar_with_start(2024, 2, 1);
        assert_eq!(leap.len(), 29);
        assert_eq!(leap[0], (1, 3));
        assert_eq!(calendar_with_start(2023, 2, 1).len(), 28);
        assert_eq!(calendar_with_start(2024, 3, 1)[0], (1, 4));
        assert_eq!(calendar_with_start(2024, 2, 7)[0], (1, 4));
        assert_eq!(parse_week_start("1\n19971130\n"), Some(7));
        assert_eq!(parse_week_start("2\n19971130\n"), Some(1));
        assert_eq!(parse_week_start("1\n19971201\n"), Some(1));
        assert_eq!(parse_week_start("8\n19971130\n"), None);
        assert_eq!(weekday_labels().len(), 7);
        assert_eq!(age(100, 159), "now");
        assert_eq!(age(100, 160), "1 min");
        assert_eq!(age(500, 100), "now");
    }
    #[test]
    fn the_month_turns_over_the_year_and_clears_go_to_the_hub() {
        let mut m = Month {
            year: 2026,
            month: 12,
        };
        assert_eq!(m.change(&Target::Next), None);
        assert_eq!((m.year, m.month), (2027, 1));
        m.change(&Target::Previous);
        m.change(&Target::Previous);
        assert_eq!((m.year, m.month), (2026, 11));
        assert_eq!(m.change(&Target::ClearAll), Some(None));
        assert_eq!(
            m.change(&Target::ClearGroup("mail".into())),
            Some(Some("mail".into()))
        );
    }
}
