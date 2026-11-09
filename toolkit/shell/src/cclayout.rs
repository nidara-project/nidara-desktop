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
//! Edit operations below are pure: preview and commit share displacement, and only
//! the host persists a successful operation (B2.3, #1016).
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
    pub default_in_bar: bool,
}

const TOGGLE: &[Size] = &[Size::Single, Size::Wide, Size::Square];
const SLIDER: &[Size] = &[Size::Single, Size::Tall, Size::FullWidth];

/// The registry (`widgets/index.ts`), in its order — the order a member that the default
/// layout does not list arrives in.
pub const REGISTRY: &[Meta] = &[
    meta("battery", Size::Single, TOGGLE, false, false, true),
    meta("bt", Size::Single, TOGGLE, true, true, false),
    meta("brightness", Size::FullWidth, SLIDER, true, true, false),
    meta("clipboard", Size::Wide, TOGGLE, false, false, false),
    meta("cpu_memory", Size::Wide, TOGGLE, false, false, false),
    meta("dark_mode", Size::Single, TOGGLE, false, true, false),
    meta("ethernet", Size::Wide, TOGGLE, false, false, false),
    meta("focus", Size::Wide, TOGGLE, true, true, true),
    meta("media", Size::Square, TOGGLE, true, true, false),
    meta("night_light", Size::Single, TOGGLE, true, true, false),
    meta("screenrecord", Size::Wide, TOGGLE, false, true, false),
    meta("screenshot", Size::Wide, TOGGLE, false, true, false),
    meta("volume", Size::FullWidth, SLIDER, true, true, true),
    meta("vpn", Size::Wide, TOGGLE, false, false, false),
    meta("wifi", Size::Wide, TOGGLE, true, true, true),
];

const fn meta(
    id: &'static str,
    default_size: Size,
    supported: &'static [Size],
    fixed: bool,
    default_in_cc: bool,
    default_in_bar: bool,
) -> Meta {
    Meta {
        id,
        default_size,
        supported,
        fixed,
        default_in_cc,
        default_in_bar,
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

/// GSettings spelling, shared with TS (never the Rust Debug representation).
impl Size {
    pub fn stored(self) -> &'static str {
        match self {
            Self::Single => "1x1",
            Self::Wide => "2x1",
            Self::Tall => "1x2",
            Self::Square => "2x2",
            Self::FullWidth => "4x1",
        }
    }
}
pub fn same_view(a: &Stored, b: &Stored) -> bool {
    a.positions == b.positions
        && a.sizes == b.sizes
        && REGISTRY.iter().all(|m| {
            let member =
                |s: &Stored| m.fixed || s.placement.get(m.id).map_or(m.default_in_cc, |p| p.1);
            member(a) == member(b)
        })
}
pub(super) fn occupancy(tiles: &[Tile], ignore: &[&str]) -> Grid {
    let mut grid = Grid::default();
    for t in tiles.iter().filter(|t| !ignore.contains(&t.id)) {
        grid.mark(t.x, t.y, t.size);
    }
    grid
}
fn overlaps(a: &Tile, b: &Tile) -> bool {
    let (aw, ah) = a.size.cells();
    let (bw, bh) = b.size.cells();
    a.x < b.x + bw && a.x + aw > b.x && a.y < b.y + bh && a.y + ah > b.y
}
/// Spatial displacement (owner 2026-06-09): only directly covered tiles move.
pub fn in_bounds(x: i32, y: i32, size: Size) -> bool {
    let (w, h) = size.cells();
    x >= 0 && y >= 0 && x <= COLS - w && y <= ROWS - h
}

/// Equal footprints swap; otherwise gravity below beats same row, then above.
fn resolve(tiles: &[Tile], target: Tile) -> Option<Vec<Tile>> {
    if !Grid::default().free(target.x, target.y, target.size) {
        return None;
    }
    let origin = tiles.iter().find(|t| t.id == target.id)?;
    let mut conflicts: Vec<_> = tiles
        .iter()
        .filter(|t| t.id != target.id && overlaps(t, &target))
        .copied()
        .collect();
    conflicts.sort_by_key(|t| (t.y, t.x));
    let mut ignore: Vec<_> = conflicts.iter().map(|t| t.id).collect();
    ignore.push(target.id);
    let mut occ = occupancy(tiles, &ignore);
    occ.mark(target.x, target.y, target.size);
    let mut result = tiles.to_vec();
    *result.iter_mut().find(|t| t.id == target.id)? = target;
    // SWAP is deliberately distinct from nearest-free gravity.
    if conflicts.len() == 1
        && conflicts[0].size.cells() == target.size.cells()
        && occ.free(origin.x, origin.y, target.size)
    {
        let other = result.iter_mut().find(|t| t.id == conflicts[0].id)?;
        (other.x, other.y) = (origin.x, origin.y);
        return Some(result);
    }
    for conflict in conflicts {
        let (w, h) = conflict.size.cells();
        let cell = (0..=ROWS - h)
            .flat_map(|y| (0..=COLS - w).map(move |x| (x, y)))
            .filter(|(x, y)| occ.free(*x, *y, conflict.size))
            .min_by_key(|(x, y)| {
                (
                    if *y > conflict.y {
                        0
                    } else if *y == conflict.y {
                        1
                    } else {
                        2
                    },
                    (y - conflict.y).abs() * (COLS + 1) + (x - conflict.x).abs(),
                    *y,
                    *x,
                )
            })?;
        let moved = result.iter_mut().find(|t| t.id == conflict.id)?;
        (moved.x, moved.y) = cell;
        occ.mark(cell.0, cell.1, conflict.size);
    }
    Some(result)
}
/// Shrink/remove gravity (owner 2026-09-28): only freed columns, never sideways
/// or above the freed top row. A gap higher up remains the person's gap.
fn lift_into(tiles: &mut [Tile], freed: Tile) {
    let (w, _) = freed.size.cells();
    let mut columns: HashSet<_> = (freed.x..freed.x + w).collect();
    let mut order: Vec<_> = tiles.iter().map(|t| (t.y, t.x, t.id)).collect();
    order.sort();
    for (_, _, id) in order {
        let i = tiles.iter().position(|t| t.id == id).unwrap();
        let t = tiles[i];
        let (w, _) = t.size.cells();
        if t.y <= freed.y || !(t.x..t.x + w).any(|x| columns.contains(&x)) {
            continue;
        }
        let occ = occupancy(tiles, &[id]);
        let mut y = t.y;
        while y > freed.y && occ.free(t.x, y - 1, t.size) {
            y -= 1;
        }
        if y != t.y {
            tiles[i].y = y;
            columns.extend(t.x..t.x + w);
        }
    }
}
fn personal(stored: &Stored, tiles: &[Tile]) -> Stored {
    let mut out = stored.clone();
    // Retain absent hardware's stored cells and every widget's bar placement.
    for t in tiles {
        out.positions.insert(t.id.into(), (t.x, t.y));
        out.sizes.insert(t.id.into(), t.size.stored().into());
    }
    out
}
pub fn move_tile(
    stored: &Stored,
    available: &dyn Fn(&str) -> bool,
    id: &str,
    x: i32,
    y: i32,
) -> Option<Stored> {
    let tiles = layout(stored, available);
    let mut target = *tiles.iter().find(|t| t.id == id)?;
    (target.x, target.y) = (x, y);
    Some(personal(stored, &resolve(&tiles, target)?))
}
pub fn resize(
    stored: &Stored,
    available: &dyn Fn(&str) -> bool,
    id: &str,
    size: Size,
) -> Option<Stored> {
    if !meta_of(id)?.supported.contains(&size) {
        return None;
    }
    let tiles = layout(stored, available);
    let before = *tiles.iter().find(|t| t.id == id)?;
    let (w, h) = size.cells();
    let target = Tile {
        size,
        x: before.x.min(COLS - w),
        y: before.y.min(ROWS - h),
        ..before
    };
    let mut changed = resolve(&tiles, target)?;
    lift_into(&mut changed, before);
    Some(personal(stored, &changed))
}
pub fn remove(stored: &Stored, available: &dyn Fn(&str) -> bool, id: &str) -> Option<Stored> {
    if meta_of(id)?.fixed {
        return None;
    }
    let mut tiles = layout(stored, available);
    let i = tiles.iter().position(|t| t.id == id)?;
    let freed = tiles.remove(i);
    let mut out = stored.clone();
    if !stored.positions.is_empty() {
        lift_into(&mut tiles, freed);
        out = personal(stored, &tiles);
    }
    out.positions.remove(id);
    out.sizes.remove(id);
    let placement = out
        .placement
        .entry(id.into())
        .or_insert((meta_of(id).is_some_and(|m| m.default_in_bar), false));
    placement.1 = false;
    Some(out)
}
pub fn add(
    stored: &Stored,
    available: &dyn Fn(&str) -> bool,
    id: &str,
    cell: Option<(i32, i32)>,
) -> Option<Stored> {
    let meta = meta_of(id)?;
    if !available(id) || members(stored, available).contains(&id) {
        return None;
    }
    let mut out = stored.clone();
    out.placement
        .entry(id.into())
        .or_insert((meta_of(id).is_some_and(|m| m.default_in_bar), false))
        .1 = true;
    if stored.positions.is_empty() && cell.is_none() {
        return layout(&out, available)
            .iter()
            .any(|t| t.id == id)
            .then_some(out);
    }
    let mut tiles = layout(stored, available);
    let (x, y) = occupancy(&tiles, &[]).first_free(meta.default_size)?;
    tiles.push(Tile {
        id: meta.id,
        x,
        y,
        size: meta.default_size,
    });
    if let Some((x, y)) = cell {
        let target = Tile {
            id: meta.id,
            x,
            y,
            size: meta.default_size,
        };
        tiles = resolve(&tiles, target)?;
    }
    Some(personal(&out, &tiles))
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
pub(super) struct Grid(HashSet<(i32, i32)>);

impl Grid {
    pub(super) fn free(&self, x: i32, y: i32, size: Size) -> bool {
        let (w, h) = size.cells();
        if !in_bounds(x, y, size) {
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

/// Ordered per-schema states. This is also the plan executed by the GSettings writer.
pub fn write_phases(
    before: &Stored,
    after: &Stored,
    current: &Stored,
) -> Result<Vec<Stored>, String> {
    if !same_view(before, current) {
        return Err("Control Center layout changed; retry the edit".into());
    }
    let mut final_state = current.clone();
    final_state.positions = after.positions.clone();
    final_state.sizes = after.sizes.clone();
    for m in REGISTRY {
        let cc = |s: &Stored| s.placement.get(m.id).map_or(m.default_in_cc, |p| p.1) || m.fixed;
        if cc(before) != cc(after) {
            final_state
                .placement
                .entry(m.id.into())
                .or_insert((m.default_in_bar, m.default_in_cc))
                .1 = cc(after);
        }
    }
    let removing = REGISTRY.iter().any(|m| {
        current.placement.get(m.id).map_or(m.default_in_cc, |p| p.1)
            && !final_state
                .placement
                .get(m.id)
                .map_or(m.default_in_cc, |p| p.1)
    });
    let mut intermediate = current.clone();
    if removing {
        intermediate.placement = final_state.placement.clone();
    } else {
        intermediate.positions = final_state.positions.clone();
        intermediate.sizes = final_state.sizes.clone();
    }
    let mut phases = Vec::new();
    if intermediate != *current {
        phases.push(intermediate.clone());
    }
    if final_state != intermediate {
        phases.push(final_state);
    }
    Ok(phases)
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

    fn saved(entries: &[(&str, i32, i32, Size)]) -> Stored {
        let mut s = Stored::default();
        for (id, x, y, size) in entries {
            s.positions.insert((*id).into(), (*x, *y));
            s.sizes.insert((*id).into(), size.stored().into());
        }
        s
    }
    fn selected(s: &Stored, ids: &[&str]) -> Vec<Tile> {
        layout(s, &|id| ids.contains(&id))
    }
    fn at(s: &Stored, id: &str) -> (i32, i32) {
        s.positions[id]
    }
    #[test]
    fn actual_write_plan_keeps_every_intermediate_valid_and_the_latest_bar_flag() {
        let ids = ["screenshot", "screenrecord"];
        let before = saved(&[(ids[0], 0, 2, Size::Single), (ids[1], 0, 4, Size::Single)]);
        let available = |id: &str| ids.contains(&id);
        let after = remove(&before, &available, ids[0]).unwrap();
        let mut current = before.clone();
        current.placement.insert(ids[0].into(), (true, true));
        let phases = write_phases(&before, &after, &current).unwrap();
        assert_eq!(phases.len(), 2);
        assert_eq!(at(&phases[0], ids[1]), (0, 4));
        assert_eq!(at(&phases[1], ids[1]), (0, 2));
        for state in &phases {
            let tiles = layout(state, &available);
            let mut grid = Grid::default();
            for t in tiles {
                assert!(grid.free(t.x, t.y, t.size));
                grid.mark(t.x, t.y, t.size);
            }
            assert_eq!(state.placement[ids[0]], (true, false));
        }
        let final_state = phases.last().unwrap();
        let added = add(final_state, &available, ids[0], Some((1, 2))).unwrap();
        let phases = write_phases(final_state, &added, final_state).unwrap();
        assert_eq!(phases.len(), 2);
        assert!(!phases[0].placement[ids[0]].1);
        assert!(phases[1].placement[ids[0]].1);
        assert!(phases[1].placement[ids[0]].0);
        let moved = move_tile(&added, &available, ids[0], 2, 2).unwrap();
        assert_eq!(write_phases(&added, &moved, &added).unwrap().len(), 1);
        let mut changed = added.clone();
        changed.positions.insert(ids[0].into(), (3, 3));
        assert!(write_phases(&added, &moved, &changed).is_err());
    }

    #[test]
    fn equal_footprints_swap_without_moving_an_uncovered_tile() {
        let ids = ["screenshot", "screenrecord", "dark_mode"];
        let s = saved(&[
            (ids[0], 0, 0, Size::Single),
            (ids[1], 1, 0, Size::Single),
            (ids[2], 3, 3, Size::Single),
        ]);
        let out = move_tile(&s, &|id| ids.contains(&id), ids[0], 1, 0).unwrap();
        assert_eq!(at(&out, ids[1]), (0, 0));
        assert_eq!(at(&out, ids[2]), (3, 3));
    }
    #[test]
    fn gravity_down_beats_nearer_sideways_and_full_displacement_refuses() {
        let ids = ["media", "screenshot"];
        let s = saved(&[
            ("media", 0, 0, Size::Square),
            ("screenshot", 2, 0, Size::Single),
        ]);
        let out = move_tile(&s, &|id| ids.contains(&id), "media", 2, 0).unwrap();
        assert_eq!(at(&out, "screenshot"), (1, 1));
        let mut tiles = vec![
            Tile {
                id: "media",
                x: 0,
                y: 0,
                size: Size::Square,
            },
            Tile {
                id: "wifi",
                x: 2,
                y: 0,
                size: Size::Wide,
            },
            Tile {
                id: "bt",
                x: 2,
                y: 1,
                size: Size::Wide,
            },
        ];
        for (id, y) in [
            "volume",
            "brightness",
            "focus",
            "night_light",
            "dark_mode",
            "screenrecord",
        ]
        .into_iter()
        .zip(2..=7)
        {
            tiles.push(Tile {
                id,
                x: 0,
                y,
                size: Size::FullWidth,
            });
        }
        let before = tiles.clone();
        assert!(
            resolve(
                &tiles,
                Tile {
                    id: "media",
                    x: 2,
                    y: 6,
                    size: Size::Square
                }
            )
            .is_none()
        );
        assert_eq!(tiles, before);
    }
    #[test]
    fn growth_stays_put_pushes_and_shrink_lifts_only_freed_columns() {
        let ids = ["media", "screenshot", "screenrecord"];
        let s = saved(&[
            ("media", 0, 0, Size::Single),
            ("screenshot", 1, 1, Size::Single),
            ("screenrecord", 3, 3, Size::Single),
        ]);
        let out = resize(&s, &|id| ids.contains(&id), "media", Size::Square).unwrap();
        assert_eq!(at(&out, "media"), (0, 0));
        assert_eq!(at(&out, "screenshot"), (1, 2));
        let out = resize(&out, &|id| ids.contains(&id), "media", Size::Single).unwrap();
        assert_eq!(at(&out, "screenshot"), (1, 0));
        assert_eq!(at(&out, "screenrecord"), (3, 3));
    }
    #[test]
    fn removal_keeps_higher_gap_and_default_remove_repacks() {
        let ids = ["screenshot", "screenrecord"];
        let s = saved(&[(ids[0], 0, 2, Size::Single), (ids[1], 0, 4, Size::Single)]);
        let out = remove(&s, &|id| ids.contains(&id), ids[0]).unwrap();
        assert_eq!(at(&out, ids[1]), (0, 2));
        assert!(!out.placement[ids[0]].1);
        let out = remove(&Stored::default(), &|id| ids.contains(&id), ids[0]).unwrap();
        assert!(out.positions.is_empty());
        let t = selected(&out, &ids);
        assert_eq!((t[0].x, t[0].y), (0, 0));
        assert!(remove(&Stored::default(), &all, "media").is_none());
    }
    #[test]
    fn add_preserves_effective_bar_flag_and_absent_hardware_placement() {
        let mut s = Stored::default();
        s.placement.insert("vpn".into(), (true, false));
        let out = add(&s, &all, "battery", None).unwrap();
        assert_eq!(out.placement["battery"], (true, true));
        assert_eq!(out.placement["vpn"], (true, false));
        assert!(out.positions.is_empty());
        let out = add(&out, &all, "vpn", Some((2, 6))).unwrap();
        assert_eq!(out.placement["vpn"], (true, true));
        let available = |id: &str| id != "battery";
        let moved = move_tile(&out, &available, "vpn", 2, 6).unwrap();
        assert_eq!(moved.placement["battery"], (true, true));
        for size in [
            Size::Single,
            Size::Wide,
            Size::Tall,
            Size::Square,
            Size::FullWidth,
        ] {
            assert_eq!(Size::parse(size.stored()), Some(size));
        }
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
