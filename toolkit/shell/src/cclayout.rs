// SPDX-License-Identifier: LGPL-3.0-or-later
//! The Control Center's grid (B2.1, #959): which tiles it holds and in which cells, read
//! the way the TS shell keeps them (`ui/shell/surfaces/control-center/CCLayoutManager.ts`,
//! `core/WidgetConfig.ts`, `widgets/index.ts`) — the same GSettings, the same rules, so
//! both shells show one grid.
//!
//! Two modes, decided by `org.nidara.control-center positions`: empty is DEFAULT, the
//! members packed top-left first in `DEFAULT_LAYOUT`'s order at its sizes; anything else
//! is PERSONAL, the stored cells, with overlaps and strays moved to the first free cell.
//! Membership is `org.nidara.widgets placement`'s second flag over the registry's
//! defaults, a fixed widget always in, and a widget whose hardware is absent left out
//! (no hole: the tiles after it move up).
//!
//! The Rust shell only reads here. Writing the layout is edit mode's (B2.3).
use std::collections::{BTreeMap, HashSet};

/// The grid: 4 columns of 76 with gaps of 20, 8 rows at most.
pub const UNIT: f64 = 76.;
pub const GAP: f64 = 20.;
pub const COLS: i32 = 4;
pub const ROWS: i32 = 8;
pub const GRID_WIDTH: f64 = COLS as f64 * UNIT + (COLS - 1) as f64 * GAP;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Size {
    Single,
    Wide,
    Tall,
    Square,
    FullWidth,
}

impl Size {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "1x1" => Size::Single,
            "2x1" => Size::Wide,
            "1x2" => Size::Tall,
            "2x2" => Size::Square,
            "4x1" => Size::FullWidth,
            _ => return None,
        })
    }
    /// Columns and rows.
    pub fn cells(self) -> (i32, i32) {
        match self {
            Size::Single => (1, 1),
            Size::Wide => (2, 1),
            Size::Tall => (1, 2),
            Size::Square => (2, 2),
            Size::FullWidth => (4, 1),
        }
    }
}

/// One registered widget, as far as the grid needs it.
pub struct Meta {
    pub id: &'static str,
    pub default_size: Size,
    pub supported: &'static [Size],
    /// Always in the Control Center, whatever is stored.
    pub fixed: bool,
    /// In it on first run.
    pub default_in_cc: bool,
}

const TOGGLE: &[Size] = &[Size::Single, Size::Wide, Size::Square];
const SLIDER: &[Size] = &[Size::Single, Size::Tall, Size::FullWidth];

/// The registry (`widgets/index.ts`), in its order — the order a member that the default
/// layout does not list arrives in.
pub const REGISTRY: &[Meta] = &[
    meta("battery", Size::Single, TOGGLE, false, false),
    meta("bt", Size::Single, TOGGLE, true, true),
    meta("brightness", Size::FullWidth, SLIDER, true, true),
    meta("clipboard", Size::Wide, TOGGLE, false, false),
    meta("cpu_memory", Size::Wide, TOGGLE, false, false),
    meta("dark_mode", Size::Single, TOGGLE, false, true),
    meta("ethernet", Size::Wide, TOGGLE, false, false),
    meta("focus", Size::Wide, TOGGLE, true, true),
    meta("media", Size::Square, TOGGLE, true, true),
    meta("night_light", Size::Single, TOGGLE, true, true),
    meta("screenrecord", Size::Wide, TOGGLE, false, true),
    meta("screenshot", Size::Wide, TOGGLE, false, true),
    meta("volume", Size::FullWidth, SLIDER, true, true),
    meta("vpn", Size::Wide, TOGGLE, false, false),
    meta("wifi", Size::Wide, TOGGLE, true, true),
];

const fn meta(
    id: &'static str,
    default_size: Size,
    supported: &'static [Size],
    fixed: bool,
    default_in_cc: bool,
) -> Meta {
    Meta {
        id,
        default_size,
        supported,
        fixed,
        default_in_cc,
    }
}

/// `CC_DEFAULT_LAYOUT`: the default grid's order and sizes.
pub const DEFAULT_LAYOUT: &[(&str, Size)] = &[
    ("media", Size::Square),
    ("wifi", Size::Wide),
    ("bt", Size::Wide),
    ("brightness", Size::FullWidth),
    ("volume", Size::FullWidth),
    ("screenshot", Size::Single),
    ("screenrecord", Size::Single),
    ("dark_mode", Size::Wide),
    ("night_light", Size::Wide),
    ("focus", Size::Wide),
];

pub fn meta_of(id: &str) -> Option<&'static Meta> {
    REGISTRY.iter().find(|m| m.id == id)
}

/// What is stored: the three GSettings maps.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Stored {
    /// `org.nidara.control-center positions`.
    pub positions: BTreeMap<String, (i32, i32)>,
    /// `org.nidara.control-center sizes`.
    pub sizes: BTreeMap<String, String>,
    /// `org.nidara.widgets placement`: (in the bar, in the Control Center).
    pub placement: BTreeMap<String, (bool, bool)>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tile {
    pub id: &'static str,
    pub x: i32,
    pub y: i32,
    pub size: Size,
}

impl Tile {
    /// Its box in the grid, from the grid's top left.
    pub fn rect(&self) -> [f64; 4] {
        let (w, h) = self.size.cells();
        let span = |n: i32| n as f64 * UNIT + (n - 1) as f64 * GAP;
        [
            self.x as f64 * (UNIT + GAP),
            self.y as f64 * (UNIT + GAP),
            span(w),
            span(h),
        ]
    }
}

/// The members: in the Control Center by placement (a fixed one always) and present.
pub fn members(stored: &Stored, available: &dyn Fn(&str) -> bool) -> Vec<&'static str> {
    REGISTRY
        .iter()
        .filter(|m| {
            let cc = m.fixed
                || stored
                    .placement
                    .get(m.id)
                    .map_or(m.default_in_cc, |(_, cc)| *cc);
            cc && available(m.id)
        })
        .map(|m| m.id)
        .collect()
}

/// The grid: its tiles in reading order (row, then column).
pub fn layout(stored: &Stored, available: &dyn Fn(&str) -> bool) -> Vec<Tile> {
    let members = members(stored, available);
    let member = |id: &str| members.contains(&id);
    let mut grid = Grid::default();
    let mut tiles = vec![];
    if stored.positions.is_empty() {
        // DEFAULT: the listed members first, at the listed sizes; then the rest, at theirs.
        let listed = DEFAULT_LAYOUT.iter().filter(|(id, _)| member(id));
        let rest = members
            .iter()
            .filter(|id| !DEFAULT_LAYOUT.iter().any(|(l, _)| l == *id))
            .filter_map(|id| meta_of(id).map(|m| (m.id, m.default_size)));
        for (id, size) in listed.copied().chain(rest) {
            let id = meta_of(id).map_or(id, |m| m.id);
            if let Some((x, y)) = grid.first_free(size) {
                grid.mark(x, y, size);
                tiles.push(Tile { id, x, y, size });
            }
        }
    } else {
        // PERSONAL: the stored cells, in reading order; a clash or a cell off the grid
        // goes to the first free one. Members without a cell (a widget switched on, its
        // hardware back) take the first free cell after them.
        let size = |id: &str| {
            let m = meta_of(id);
            stored
                .sizes
                .get(id)
                .and_then(|s| Size::parse(s))
                .filter(|s| m.is_some_and(|m| m.supported.contains(s)))
                .or(m.map(|m| m.default_size))
                .unwrap_or(Size::Single)
        };
        let mut placed: Vec<(&'static str, (i32, i32))> = stored
            .positions
            .iter()
            .filter_map(|(id, cell)| members.iter().find(|m| **m == id).map(|m| (*m, *cell)))
            .collect();
        placed.sort_by_key(|(_, (x, y))| (*y, *x));
        let unplaced = members
            .iter()
            .filter(|m| !stored.positions.contains_key(**m))
            .map(|m| (*m, (-1, -1)));
        for (id, (x, y)) in placed.into_iter().chain(unplaced) {
            let size = size(id);
            let cell = if grid.free(x, y, size) {
                Some((x, y))
            } else {
                grid.first_free(size)
            };
            if let Some((x, y)) = cell {
                grid.mark(x, y, size);
                tiles.push(Tile { id, x, y, size });
            }
        }
    }
    tiles.sort_by_key(|t| (t.y, t.x));
    tiles
}

/// The rows the tiles reach.
pub fn rows(tiles: &[Tile]) -> i32 {
    tiles
        .iter()
        .map(|t| t.y + t.size.cells().1)
        .max()
        .unwrap_or(0)
}

#[derive(Default)]
struct Grid(HashSet<(i32, i32)>);

impl Grid {
    fn free(&self, x: i32, y: i32, size: Size) -> bool {
        let (w, h) = size.cells();
        if x < 0 || y < 0 || x + w > COLS || y + h > ROWS {
            return false;
        }
        (0..h).all(|dy| (0..w).all(|dx| !self.0.contains(&(x + dx, y + dy))))
    }
    fn mark(&mut self, x: i32, y: i32, size: Size) {
        let (w, h) = size.cells();
        for dy in 0..h {
            for dx in 0..w {
                self.0.insert((x + dx, y + dy));
            }
        }
    }
    fn first_free(&self, size: Size) -> Option<(i32, i32)> {
        let (w, h) = size.cells();
        (0..=ROWS - h)
            .flat_map(|y| (0..=COLS - w).map(move |x| (x, y)))
            .find(|(x, y)| self.free(*x, *y, size))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn all(_: &str) -> bool {
        true
    }

    fn cells(tiles: &[Tile]) -> Vec<(&str, i32, i32, Size)> {
        tiles.iter().map(|t| (t.id, t.x, t.y, t.size)).collect()
    }

    #[test]
    fn the_default_grid_packs_the_ten_tiles() {
        let tiles = layout(&Stored::default(), &all);
        use Size::*;
        assert_eq!(
            cells(&tiles),
            [
                ("media", 0, 0, Square),
                ("wifi", 2, 0, Wide),
                ("bt", 2, 1, Wide),
                ("brightness", 0, 2, FullWidth),
                ("volume", 0, 3, FullWidth),
                ("screenshot", 0, 4, Single),
                ("screenrecord", 1, 4, Single),
                ("dark_mode", 2, 4, Wide),
                ("night_light", 0, 5, Wide),
                ("focus", 2, 5, Wide),
            ]
        );
        assert_eq!(rows(&tiles), 6);
    }

    #[test]
    fn absent_hardware_leaves_no_hole() {
        let tiles = layout(&Stored::default(), &|id| {
            !matches!(id, "bt" | "brightness" | "wifi")
        });
        use Size::*;
        // The default grid of a desktop without Wi-Fi, Bluetooth or a backlight is the
        // grid the owner keeps by hand.
        assert_eq!(
            cells(&tiles),
            [
                ("media", 0, 0, Square),
                ("screenshot", 2, 0, Single),
                ("screenrecord", 3, 0, Single),
                ("dark_mode", 2, 1, Wide),
                ("volume", 0, 2, FullWidth),
                ("night_light", 0, 3, Wide),
                ("focus", 2, 3, Wide),
            ]
        );
    }

    #[test]
    fn the_owners_personal_grid() {
        let mut s = Stored::default();
        for (id, cell, size) in [
            ("media", (0, 0), "2x2"),
            ("screenshot", (2, 0), "1x1"),
            ("screenrecord", (3, 0), "1x1"),
            ("dark_mode", (2, 1), "2x1"),
            ("volume", (0, 2), "4x1"),
            ("focus", (2, 3), "2x1"),
            ("night_light", (0, 3), "2x1"),
        ] {
            s.positions.insert(id.into(), cell);
            s.sizes.insert(id.into(), size.into());
        }
        let tiles = layout(&s, &|id| !matches!(id, "bt" | "brightness" | "wifi"));
        use Size::*;
        assert_eq!(
            cells(&tiles),
            [
                ("media", 0, 0, Square),
                ("screenshot", 2, 0, Single),
                ("screenrecord", 3, 0, Single),
                ("dark_mode", 2, 1, Wide),
                ("volume", 0, 2, FullWidth),
                ("night_light", 0, 3, Wide),
                ("focus", 2, 3, Wide),
            ]
        );
    }

    #[test]
    fn a_clash_moves_to_the_first_free_cell_and_placement_rules_membership() {
        let mut s = Stored::default();
        s.positions.insert("media".into(), (0, 0));
        s.positions.insert("volume".into(), (1, 1));
        // Not a member: switched off, not fixed.
        s.positions.insert("screenshot".into(), (2, 0));
        s.placement.insert("screenshot".into(), (true, false));
        // Fixed: in, whatever is stored.
        s.placement.insert("focus".into(), (true, false));
        let tiles = layout(&s, &|id| {
            matches!(id, "media" | "volume" | "screenshot" | "focus")
        });
        use Size::*;
        assert_eq!(
            cells(&tiles),
            [
                ("media", 0, 0, Square),
                ("focus", 2, 0, Wide),
                ("volume", 0, 2, FullWidth),
            ]
        );
        // An unsupported stored size falls back to the default.
        s.sizes.insert("media".into(), "4x1".into());
        assert_eq!(layout(&s, &|id| id == "media")[0].size, Square);
    }

    #[test]
    fn a_tiles_box() {
        let t = Tile {
            id: "media",
            x: 2,
            y: 1,
            size: Size::Square,
        };
        assert_eq!(t.rect(), [192., 96., 172., 172.]);
        assert_eq!(GRID_WIDTH, 364.);
    }
}
