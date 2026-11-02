// SPDX-License-Identifier: LGPL-3.0-or-later
//! The bar's pure parts (B1, #959): what it says and where each piece goes, measured on the
//! TS bar it replaces (`ui/shell/surfaces/bar/capsule.ts`, the "B" bar of 2026-10-06):
//! 4 above the glass, 32 of capsule, 4 at the screen's ends; inside a group one 4 px
//! rhythm, an icon item 7 + 18 + 7, a text item 12 + text + 12. Three pieces of glass:
//! the left group (system menu, the app's name), the island's capsule (the workspace
//! dots), the right group (tray, widgets, Control Center, clock).
use crate::hyalo::Workspace;

/// The strip the bar reserves: 4 above the capsule and the capsule.
pub const BAR_H: f64 = 36.;
pub const TOP: f64 = 4.;
pub const CAPSULE_H: f64 = 32.;
/// From the screen's ends to the glass: Hyalo's gaps_out.
pub const MARGIN: f64 = 4.;
/// Inside a group: from the glass to the first item, and between two items.
pub const EDGE: f64 = 4.;
pub const ICON: f64 = 18.;
pub const ICON_PAD: f64 = 7.;
pub const TEXT_PAD: f64 = 12.;
/// The island's capsule: its content's air, the dots' spacing, a dot and the active one.
pub const PILL_PAD: f64 = 14.;
pub const DOT_GAP: f64 = 12.;
pub const DOT: f64 = 6.;
pub const DOT_ACTIVE: f64 = 18.;
/// The workspaces the dots stand for (the TS bar's `WS_COUNT`).
pub const WORKSPACES: i32 = 5;
/// The least room between a flank and the island.
pub const ISLAND_GAP: f64 = 20.;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Dot {
    Active,
    Occupied,
    Empty,
}

/// The dots of one output: its shown workspace is the active one, a workspace holding a
/// window is occupied. Numbered workspaces only; a special one (the scratchpad, the
/// game's) is never a dot.
pub fn dots(workspaces: &[Workspace], output: &str) -> Vec<Dot> {
    (1..=WORKSPACES)
        .map(|id| {
            let w = workspaces.iter().find(|w| w.id == id && !w.special);
            match w {
                Some(w) if w.active && w.output == output => Dot::Active,
                Some(w) if w.windows > 0 => Dot::Occupied,
                _ => Dot::Empty,
            }
        })
        .collect()
}

/// The island's capsule width for `dots`.
pub fn island_width(dots: &[Dot]) -> f64 {
    let content: f64 = dots
        .iter()
        .map(|d| if *d == Dot::Active { DOT_ACTIVE } else { DOT })
        .sum::<f64>()
        + DOT_GAP * dots.len().saturating_sub(1) as f64;
    content + 2. * PILL_PAD
}

/// What the left group's text says with no window focused on this output: the desktop by
/// its number (the one place the bar spells it out), or a named one by its name.
pub fn desktop_title(workspaces: &[Workspace], output: &str, word: &str) -> String {
    match workspaces
        .iter()
        .find(|w| w.active && !w.special && w.output == output)
    {
        Some(w) if w.id > 0 => format!("{word} {}", w.id),
        Some(w) if !w.name.is_empty() => w.name.clone(),
        _ => word.to_string(),
    }
}

/// One item of a group, by what it holds: its width follows.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Content {
    Icon,
    /// Text of this measured width.
    Text(f64),
}

pub fn item_width(c: Content) -> f64 {
    match c {
        Content::Icon => ICON + 2. * ICON_PAD,
        Content::Text(w) => w.ceil() + 2. * TEXT_PAD,
    }
}

/// A group's items laid out from `x`: each item's box (the full capsule height, as its
/// hover pill is inset from it), and the glass round them.
pub fn group(x: f64, items: &[Content]) -> ([f64; 4], Vec<[f64; 4]>) {
    let mut at = x + EDGE;
    let mut boxes = vec![];
    for (n, c) in items.iter().enumerate() {
        if n > 0 {
            at += EDGE;
        }
        let w = item_width(*c);
        boxes.push([at, TOP, w, CAPSULE_H]);
        at += w;
    }
    let glass = [x, TOP, at + EDGE - x, CAPSULE_H];
    (glass, boxes)
}

/// The hover/open pill of an item's box: 4 in from the glass above and below, its ends
/// half-circles.
pub fn pill(b: [f64; 4]) -> [f64; 4] {
    [b[0], b[1] + EDGE, b[2], b[3] - 2. * EDGE]
}

/// The widest the left group's text may be on an output `width` wide, beside an island
/// `island` wide and a left group whose other items take `others`: it stops
/// `ISLAND_GAP` short of the island.
pub fn title_room(width: f64, island: f64, others: &[Content]) -> f64 {
    let flank = width / 2. - island / 2. - MARGIN - ISLAND_GAP;
    let used: f64 = others.iter().map(|c| item_width(*c) + EDGE).sum::<f64>() + 2. * EDGE;
    (flank - used - 2. * TEXT_PAD).max(0.)
}

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

    fn ws(id: i32, output: &str, windows: usize, active: bool) -> Workspace {
        Workspace {
            id,
            name: String::new(),
            output: output.into(),
            special: false,
            windows,
            active,
            focused: false,
        }
    }

    #[test]
    fn the_dots_are_this_outputs_five_workspaces() {
        let all = [
            ws(1, "A", 2, false),
            ws(2, "A", 0, true),
            ws(3, "B", 1, true),
            Workspace {
                special: true,
                ..ws(4, "A", 1, false)
            },
        ];
        use Dot::*;
        assert_eq!(dots(&all, "A"), [Occupied, Active, Occupied, Empty, Empty]);
        assert_eq!(dots(&all, "B"), [Occupied, Empty, Active, Empty, Empty]);
        // 14 + 6·4 + 18 + 12·4 + 14
        assert_eq!(island_width(&dots(&all, "A")), 118.);
    }

    #[test]
    fn a_desktop_without_a_window_is_named_by_its_number() {
        let all = [ws(3, "A", 0, true)];
        assert_eq!(desktop_title(&all, "A", "Desktop"), "Desktop 3");
        assert_eq!(desktop_title(&all, "B", "Desktop"), "Desktop");
    }

    #[test]
    fn a_group_keeps_one_four_pixel_rhythm() {
        let (glass, boxes) = group(4., &[Content::Icon, Content::Text(40.2)]);
        assert_eq!(boxes, [[8., 4., 32., 32.], [44., 4., 65., 32.]]);
        assert_eq!(glass, [4., 4., 109., 32.]);
        assert_eq!(pill(boxes[0]), [8., 8., 32., 24.]);
    }

    #[test]
    fn the_title_stops_short_of_the_island() {
        let room = title_room(1000., 118., &[Content::Icon]);
        // flank 500 − 59 − 4 − 20 = 417; logo 32 + 4, ends 8; text pads 24
        assert_eq!(room, 417. - 36. - 8. - 24.);
        assert_eq!(title_room(100., 118., &[Content::Icon]), 0.);
    }

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
