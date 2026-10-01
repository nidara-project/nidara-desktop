//! Dwindle: the layout the desktop has used on Hyprland. Every new window halves the box of
//! the window it goes next to — side by side when that box is wider than tall, one above the
//! other otherwise — on the side the cursor is on (Hyprland's `force_split = 0`). A split
//! keeps its direction once made, whatever the windows are resized to (`preserve_split`).

use smithay::utils::{Logical, Point, Rectangle};

use super::{Edge, Layout, Rect};
use crate::wm::WindowId;

const MIN_RATIO: f64 = 0.1;
const MAX_RATIO: f64 = 0.9;

#[derive(Debug, Clone)]
enum Node {
    Leaf(WindowId),
    Split {
        /// True: `a` left of `b`. False: `a` above `b`.
        side_by_side: bool,
        /// The share of the box `a` gets.
        ratio: f64,
        a: Box<Node>,
        b: Box<Node>,
    },
}

#[derive(Debug, Default)]
pub struct Dwindle {
    root: Option<Node>,
    /// The window inserted last: where the next one goes when there is no `near`.
    last: Option<WindowId>,
}

/// `area` cut in two by a split.
fn halves(area: Rect, side_by_side: bool, ratio: f64) -> (Rect, Rect) {
    if side_by_side {
        let wa = ((area.size.w as f64) * ratio).round() as i32;
        (
            Rectangle::new(area.loc, (wa, area.size.h).into()),
            Rectangle::new((area.loc.x + wa, area.loc.y).into(), (area.size.w - wa, area.size.h).into()),
        )
    } else {
        let ha = ((area.size.h as f64) * ratio).round() as i32;
        (
            Rectangle::new(area.loc, (area.size.w, ha).into()),
            Rectangle::new((area.loc.x, area.loc.y + ha).into(), (area.size.w, area.size.h - ha).into()),
        )
    }
}

impl Node {
    fn contains(&self, id: WindowId) -> bool {
        match self {
            Node::Leaf(w) => *w == id,
            Node::Split { a, b, .. } => a.contains(id) || b.contains(id),
        }
    }

    fn leaves(&self, out: &mut Vec<WindowId>) {
        match self {
            Node::Leaf(w) => out.push(*w),
            Node::Split { a, b, .. } => {
                a.leaves(out);
                b.leaves(out);
            }
        }
    }

    fn boxes(&self, area: Rect, out: &mut Vec<(WindowId, Rect)>) {
        match self {
            Node::Leaf(w) => out.push((*w, area)),
            Node::Split { side_by_side, ratio, a, b } => {
                let (ra, rb) = halves(area, *side_by_side, *ratio);
                a.boxes(ra, out);
                b.boxes(rb, out);
            }
        }
    }

    /// Replaces the leaf `target` with a split of it and `id`.
    fn split_leaf(&mut self, target: WindowId, id: WindowId, side_by_side: bool, new_first: bool) -> bool {
        match self {
            Node::Leaf(w) if *w == target => {
                let (a, b) = if new_first { (id, target) } else { (target, id) };
                *self = Node::Split {
                    side_by_side,
                    ratio: 0.5,
                    a: Box::new(Node::Leaf(a)),
                    b: Box::new(Node::Leaf(b)),
                };
                true
            }
            Node::Leaf(_) => false,
            Node::Split { a, b, .. } => {
                a.split_leaf(target, id, side_by_side, new_first) || b.split_leaf(target, id, side_by_side, new_first)
            }
        }
    }

    /// Removes the leaf `id`; its sibling takes its parent's place. Returns the node that
    /// should replace `self` when `self` is that leaf.
    fn remove(self, id: WindowId) -> (Option<Node>, bool) {
        match self {
            Node::Leaf(w) if w == id => (None, true),
            leaf @ Node::Leaf(_) => (Some(leaf), false),
            Node::Split { side_by_side, ratio, a, b } => {
                let (na, ra) = a.remove(id);
                if ra {
                    return match na {
                        None => (Some(*b), true),
                        Some(na) => (Some(Node::Split { side_by_side, ratio, a: Box::new(na), b }), true),
                    };
                }
                let (nb, rb) = b.remove(id);
                match nb {
                    None => (na, rb),
                    Some(nb) => (
                        Some(Node::Split { side_by_side, ratio, a: Box::new(na.expect("kept")), b: Box::new(nb) }),
                        rb,
                    ),
                }
            }
        }
    }

    /// Moves the split line that forms `edge` of window `id`, the deepest one there is.
    fn resize_edge(&mut self, id: WindowId, edge: Edge, delta: i32, area: Rect) -> bool {
        let Node::Split { side_by_side, ratio, a, b } = self else { return false };
        let (ra, rb) = halves(area, *side_by_side, *ratio);
        let in_a = a.contains(id);
        // Deeper first: the line closest to the window is the one its edge is on.
        let deeper = if in_a { a.resize_edge(id, edge, delta, ra) } else { b.resize_edge(id, edge, delta, rb) };
        if deeper {
            return true;
        }
        let ours = matches!(
            (edge, *side_by_side, in_a),
            (Edge::Right, true, true) | (Edge::Left, true, false) | (Edge::Bottom, false, true) | (Edge::Top, false, false)
        );
        if !ours {
            return false;
        }
        let span = if *side_by_side { area.size.w } else { area.size.h };
        if span <= 0 {
            return false;
        }
        *ratio = (*ratio + delta as f64 / span as f64).clamp(MIN_RATIO, MAX_RATIO);
        true
    }

    fn rename(&mut self, from: WindowId, to: WindowId) {
        match self {
            Node::Leaf(w) if *w == from => *w = to,
            Node::Leaf(_) => {}
            Node::Split { a, b, .. } => {
                a.rename(from, to);
                b.rename(from, to);
            }
        }
    }
}

impl Layout for Dwindle {
    fn name(&self) -> &'static str {
        "dwindle"
    }

    fn contains(&self, id: WindowId) -> bool {
        self.root.as_ref().is_some_and(|r| r.contains(id))
    }

    fn windows(&self) -> Vec<WindowId> {
        let mut out = Vec::new();
        if let Some(r) = &self.root {
            r.leaves(&mut out);
        }
        out
    }

    fn insert(&mut self, id: WindowId, area: Rect, near: Option<WindowId>, cursor: Option<Point<f64, Logical>>) {
        if self.contains(id) {
            return;
        }
        let Some(root) = &mut self.root else {
            self.root = Some(Node::Leaf(id));
            self.last = Some(id);
            return;
        };
        let target = near
            .filter(|n| root.contains(*n))
            .or(self.last.filter(|l| root.contains(*l)))
            .unwrap_or_else(|| {
                let mut leaves = Vec::new();
                root.leaves(&mut leaves);
                *leaves.last().expect("a root has a leaf")
            });
        let mut boxes = Vec::new();
        root.boxes(area, &mut boxes);
        let tbox = boxes.iter().find(|(w, _)| *w == target).map(|(_, r)| *r).unwrap_or(area);
        let side_by_side = tbox.size.w > tbox.size.h;
        // The new window goes on the half the cursor is in; with no cursor in the box, right
        // or below.
        let new_first = cursor.is_some_and(|c| {
            tbox.to_f64().contains(c)
                && if side_by_side {
                    c.x < tbox.loc.x as f64 + tbox.size.w as f64 / 2.0
                } else {
                    c.y < tbox.loc.y as f64 + tbox.size.h as f64 / 2.0
                }
        });
        root.split_leaf(target, id, side_by_side, new_first);
        self.last = Some(id);
    }

    fn remove(&mut self, id: WindowId) -> bool {
        let Some(root) = self.root.take() else { return false };
        let (rest, removed) = root.remove(id);
        self.root = rest;
        if self.last == Some(id) {
            self.last = None;
        }
        removed
    }

    fn arrange(&self, area: Rect, gaps_in: i32) -> Vec<(WindowId, Rect)> {
        let mut out = Vec::new();
        if let Some(r) = &self.root {
            r.boxes(area, &mut out);
        }
        for (_, b) in &mut out {
            *b = super::inset_inner_edges(*b, area, gaps_in);
        }
        out
    }

    fn resize_edge(&mut self, id: WindowId, edge: Edge, delta: i32, area: Rect) -> bool {
        match &mut self.root {
            Some(r) if r.contains(id) => r.resize_edge(id, edge, delta, area),
            _ => false,
        }
    }

    fn move_next_to(&mut self, id: WindowId, target: WindowId, area: Rect, cursor: Point<f64, Logical>) {
        if id == target || !self.contains(id) || !self.contains(target) {
            return;
        }
        self.remove(id);
        self.insert(id, area, Some(target), Some(cursor));
    }

    fn swap(&mut self, a: WindowId, b: WindowId) {
        if a == b || !self.contains(a) || !self.contains(b) {
            return;
        }
        // Through an id no window has, so the two renames do not undo each other.
        let Some(root) = &mut self.root else { return };
        root.rename(a, WindowId::MAX);
        root.rename(b, a);
        root.rename(WindowId::MAX, b);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> Rect {
        Rectangle::new((0, 0).into(), (2000, 1000).into())
    }

    fn boxes(d: &Dwindle) -> Vec<(WindowId, (i32, i32, i32, i32))> {
        d.arrange(area(), 0)
            .into_iter()
            .map(|(w, r)| (w, (r.loc.x, r.loc.y, r.size.w, r.size.h)))
            .collect()
    }

    #[test]
    fn halves_the_box_of_the_window_it_goes_next_to() {
        let mut d = Dwindle::default();
        d.insert(1, area(), None, None);
        assert_eq!(boxes(&d), vec![(1, (0, 0, 2000, 1000))]);
        d.insert(2, area(), Some(1), None);
        // Wider than tall: side by side, the new one on the right.
        assert_eq!(boxes(&d), vec![(1, (0, 0, 1000, 1000)), (2, (1000, 0, 1000, 1000))]);
        d.insert(3, area(), Some(2), None);
        // 1000x1000 is not wider than tall: one above the other.
        assert_eq!(boxes(&d), vec![(1, (0, 0, 1000, 1000)), (2, (1000, 0, 1000, 500)), (3, (1000, 500, 1000, 500))]);
    }

    #[test]
    fn the_new_window_takes_the_half_the_cursor_is_in() {
        let mut d = Dwindle::default();
        d.insert(1, area(), None, None);
        d.insert(2, area(), Some(1), Some((100.0, 500.0).into()));
        assert_eq!(boxes(&d), vec![(2, (0, 0, 1000, 1000)), (1, (1000, 0, 1000, 1000))]);
    }

    #[test]
    fn a_closed_window_gives_its_space_to_its_sibling() {
        let mut d = Dwindle::default();
        for (id, near) in [(1, None), (2, Some(1)), (3, Some(2))] {
            d.insert(id, area(), near, None);
        }
        assert!(d.remove(2));
        assert_eq!(boxes(&d), vec![(1, (0, 0, 1000, 1000)), (3, (1000, 0, 1000, 1000))]);
        assert!(d.remove(1));
        assert_eq!(boxes(&d), vec![(3, (0, 0, 2000, 1000))]);
        assert!(d.remove(3));
        assert!(d.windows().is_empty());
        assert!(!d.remove(3));
    }

    #[test]
    fn gaps_only_between_windows() {
        let mut d = Dwindle::default();
        d.insert(1, area(), None, None);
        d.insert(2, area(), Some(1), None);
        let b: Vec<_> = d.arrange(area(), 2).into_iter().map(|(_, r)| (r.loc.x, r.loc.y, r.size.w, r.size.h)).collect();
        assert_eq!(b, vec![(0, 0, 998, 1000), (1002, 0, 998, 1000)]);
    }

    #[test]
    fn resizing_moves_the_nearest_split_and_keeps_its_direction() {
        let mut d = Dwindle::default();
        d.insert(1, area(), None, None);
        d.insert(2, area(), Some(1), None);
        // 1's right edge is the split: it moves.
        assert!(d.resize_edge(1, Edge::Right, 200, area()));
        assert_eq!(boxes(&d), vec![(1, (0, 0, 1200, 1000)), (2, (1200, 0, 800, 1000))]);
        // 1's left edge is the screen's: it does not.
        assert!(!d.resize_edge(1, Edge::Left, -50, area()));
        // Growing 2 moves its LEFT edge, since its right one is the screen's.
        super::super::grow(&mut d, 2, 100, 0, area());
        assert_eq!(boxes(&d), vec![(1, (0, 0, 1100, 1000)), (2, (1100, 0, 900, 1000))]);
        // A split never goes past 10/90.
        d.resize_edge(1, Edge::Right, 5000, area());
        assert_eq!(boxes(&d)[0].1 .2, 1800);
        // preserve_split: inserting into 2 (now 200 wide) still follows ITS box, and 1's
        // split stays side by side.
        d.insert(3, area(), Some(2), None);
        assert_eq!(boxes(&d)[0], (1, (0, 0, 1800, 1000)));
    }

    #[test]
    fn dropping_a_window_on_another_and_swapping() {
        let mut d = Dwindle::default();
        for (id, near) in [(1, None), (2, Some(1)), (3, Some(2))] {
            d.insert(id, area(), near, None);
        }
        d.swap(1, 3);
        assert_eq!(d.windows(), vec![3, 2, 1]);
        // 3 leaves, so 2 and 1 share the screen one above the other; dropped on the left
        // half of 1's box, it goes on 1's left.
        d.move_next_to(3, 1, area(), (100.0, 750.0).into());
        assert_eq!(boxes(&d), vec![(2, (0, 0, 2000, 500)), (3, (0, 500, 1000, 500)), (1, (1000, 500, 1000, 500))]);
    }
}
