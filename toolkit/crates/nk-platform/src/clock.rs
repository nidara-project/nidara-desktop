// SPDX-License-Identifier: LGPL-3.0-or-later
//! The bar's clock as text (`org.nidara.region`): one writer for the bar and for Settings'
//! preview of it (#1103 8e). The moment comes in already in the locale's words; this only
//! puts them in the order and the length the region asks for.

/// How the clock reads (`org.nidara.region`).
#[derive(Clone, Debug, PartialEq)]
pub struct Region {
    pub twelve_hour: bool,
    pub seconds: bool,
    /// none, short, short-year, long, numeric, iso.
    pub date: String,
}
impl Default for Region {
    fn default() -> Self {
        Self {
            twelve_hour: false,
            seconds: false,
            date: "short".into(),
        }
    }
}

/// The parts of a moment the clock needs, already in the locale's words.
#[derive(Clone, Debug, PartialEq)]
pub struct Moment {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    /// `%H:%M`, `%H:%M:%S`, `%I:%M %p`… as asked: the time is the locale's to write.
    pub time: String,
    pub weekday_short: String,
    pub weekday_long: String,
    pub month_short: String,
    pub month_long: String,
}

/// The order a locale writes a date in: day first (most of Europe), month first (the
/// US), year first (East Asia, ISO).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Order {
    DayFirst,
    MonthFirst,
    YearFirst,
}

/// The clock's text: the date the region asks for, two spaces, the time (the TS bar's
/// `formatClock`).
pub fn clock(r: &Region, m: &Moment, order: Order) -> String {
    let (wa, wl, mb, ml) = (
        m.weekday_short.trim(),
        m.weekday_long.trim(),
        m.month_short.trim(),
        m.month_long.trim(),
    );
    let (d, y) = (m.day, m.year);
    let two = |n: u32| format!("{n:02}");
    let date = match (r.date.as_str(), order) {
        ("none", _) => return m.time.clone(),
        ("short-year", Order::YearFirst) => format!("{y} {mb} {d} {wa}"),
        ("short-year", Order::DayFirst) => format!("{wa}, {d} {mb} {y}"),
        ("short-year", Order::MonthFirst) => format!("{wa}, {mb} {d} {y}"),
        ("long", Order::YearFirst) => format!("{ml} {d} {wl}"),
        ("long", Order::DayFirst) => format!("{wl}, {d} {ml}"),
        ("long", Order::MonthFirst) => format!("{wl}, {ml} {d}"),
        ("numeric", Order::YearFirst) => format!("{y}/{}/{}", two(m.month), two(d)),
        ("numeric", Order::DayFirst) => format!("{}/{}/{y}", two(d), two(m.month)),
        ("numeric", Order::MonthFirst) => format!("{}/{}/{y}", two(m.month), two(d)),
        ("iso", _) => format!("{y}-{}-{}", two(m.month), two(d)),
        (_, Order::YearFirst) => format!("{mb} {d} {wa}"),
        (_, Order::DayFirst) => format!("{wa}, {d} {mb}"),
        (_, Order::MonthFirst) => format!("{wa}, {mb} {d}"),
    };
    format!("{date}  {}", m.time)
}

/// The `strftime` pattern of the time part.
pub fn time_pattern(r: &Region) -> &'static str {
    match (r.twelve_hour, r.seconds) {
        (false, false) => "%H:%M",
        (false, true) => "%H:%M:%S",
        (true, false) => "%I:%M %p",
        (true, true) => "%I:%M:%S %p",
    }
}

/// The order of the locale's `%x`, told from how it writes 2001-02-03.
pub fn order_of(sample: &str) -> Order {
    let at = |s: &str| sample.find(s).unwrap_or(usize::MAX);
    let (y, m, d) = (at("01"), at("02"), at("03"));
    if y < m && y < d {
        Order::YearFirst
    } else if d < m {
        Order::DayFirst
    } else {
        Order::MonthFirst
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn moment() -> Moment {
        Moment {
            year: 2026,
            month: 11,
            day: 2,
            time: "18:05".into(),
            weekday_short: "lun".into(),
            weekday_long: "lunes".into(),
            month_short: "nov".into(),
            month_long: "noviembre".into(),
        }
    }

    #[test]
    fn the_clock_reads_as_the_region_asks() {
        let r = |date: &str| Region {
            date: date.into(),
            ..Default::default()
        };
        let m = moment();
        assert_eq!(clock(&r("short"), &m, Order::DayFirst), "lun, 2 nov  18:05");
        assert_eq!(
            clock(&r("short"), &m, Order::MonthFirst),
            "lun, nov 2  18:05"
        );
        assert_eq!(clock(&r("none"), &m, Order::DayFirst), "18:05");
        assert_eq!(clock(&r("iso"), &m, Order::DayFirst), "2026-11-02  18:05");
        assert_eq!(
            clock(&r("numeric"), &m, Order::DayFirst),
            "02/11/2026  18:05"
        );
        assert_eq!(
            clock(&r("long"), &m, Order::DayFirst),
            "lunes, 2 noviembre  18:05"
        );
        assert_eq!(time_pattern(&Region::default()), "%H:%M");
    }

    #[test]
    fn the_locales_date_order() {
        assert_eq!(order_of("03/02/01"), Order::DayFirst);
        assert_eq!(order_of("02/03/01"), Order::MonthFirst);
        assert_eq!(order_of("2001-02-03"), Order::YearFirst);
    }
}
