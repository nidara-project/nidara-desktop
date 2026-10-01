//! Tiling layouts: how the tiled windows of one workspace share its area.
//!
//! A layout only knows window ids and rectangles — no Wayland, no Smithay state — so each one
//! is tested on its own, and a new one is a new file here plus a line in `new`. Floating,
//! fullscreen and maximized windows are not the layout's business: the window manager takes
//! a window out of the layout when it stops being tiled and puts it back when it is tiled
//! again. Dwindle is the only layout today (the owner's call, #682); the trait is how others
//! join it.

pub mod dwindle;

use smithay::utils::{Logical, Point, Rectangle};

use super::WindowId;

pub type Rect = Rectangle<i32, Logical>;

/// One side of a window, for resizing by its edge.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Edge {
    Left,
    Right,
    Top,
    Bottom,
}

pub trait Layout: std::fmt::Debug {
    /// The name the configuration uses (`[layout] tiling = "dwindle"`).
    fn name(&self) -> &'static str;
    fn contains(&self, id: WindowId) -> bool;
    /// Every window in the layout, in its own order (what `cycle` walks).
    fn windows(&self) -> Vec<WindowId>;
    /// Adds a window. `near` is the window it should go next to (the focused one), `cursor`
    /// where the pointer is, for layouts whose split follows the mouse.
    fn insert(&mut self, id: WindowId, area: Rect, near: Option<WindowId>, cursor: Option<Point<f64, Logical>>);
    fn remove(&mut self, id: WindowId) -> bool;
    /// Each window's box inside `area`, `gaps_in` kept on every side two windows share.
    fn arrange(&self, area: Rect, gaps_in: i32) -> Vec<(WindowId, Rect)>;
    /// Moves one edge of a window by `delta` logical pixels (positive = right or down).
    /// False when that edge is the area's border and cannot move.
    fn resize_edge(&mut self, id: WindowId, edge: Edge, delta: i32, area: Rect) -> bool;
    /// A tiled window dropped on another: it leaves its place and goes next to `target`, on
    /// the side the cursor is on.
    fn move_next_to(&mut self, id: WindowId, target: WindowId, area: Rect, cursor: Point<f64, Logical>);
    fn swap(&mut self, a: WindowId, b: WindowId);
}

/// The layouts by name.
pub fn new(name: &str) -> Option<Box<dyn Layout>> {
    match name {
        "dwindle" => Some(Box::new(dwindle::Dwindle::default())),
        _ => None,
    }
}

pub const NAMES: &[&str] = &["dwindle"];

/// Grows a window by (dx, dy) whichever way it can: its right/bottom edge if that moves, its
/// left/top edge otherwise. What the keyboard resize does to a tiled window.
pub fn grow(layout: &mut dyn Layout, id: WindowId, dx: i32, dy: i32, area: Rect) {
    if dx != 0 && !layout.resize_edge(id, Edge::Right, dx, area) {
        layout.resize_edge(id, Edge::Left, -dx, area);
    }
    if dy != 0 && !layout.resize_edge(id, Edge::Bottom, dy, area) {
        layout.resize_edge(id, Edge::Top, -dy, area);
    }
}

/// `inner` shrunk by `gap` on each side that does not touch `outer`'s border: the space two
/// neighbours leave between them (`gaps_in` each, so twice that between two windows, as in
/// Hyprland).
pub fn inset_inner_edges(inner: Rect, outer: Rect, gap: i32) -> Rect {
    let mut r = inner;
    let (ox2, oy2) = (outer.loc.x + outer.size.w, outer.loc.y + outer.size.h);
    let (x2, y2) = (r.loc.x + r.size.w, r.loc.y + r.size.h);
    let left = if r.loc.x > outer.loc.x { gap } else { 0 };
    let top = if r.loc.y > outer.loc.y { gap } else { 0 };
    let right = if x2 < ox2 { gap } else { 0 };
    let bottom = if y2 < oy2 { gap } else { 0 };
    r.loc.x += left;
    r.loc.y += top;
    r.size.w = (r.size.w - left - right).max(1);
    r.size.h = (r.size.h - top - bottom).max(1);
    r
}
