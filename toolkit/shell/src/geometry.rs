// SPDX-License-Identifier: LGPL-3.0-or-later
//! Where every slot goes, and how far the dock shrinks to fit (DOCK.md §5,
//! APPLICATIONS1-DOCK.md §8 "Fit"). Proportions are the TS dock's (DockPhysics.ts), so
//! the two look alike: padding 0.22 × icon, gap 0.16 × icon, a capsule whose radius is
//! half its cross size. Everything scales by ONE factor; nothing has a minimum size.

/// From the dock's glass to the screen edge: the desktop's one edge gap (the TS dock's
/// `DOCK_SCREEN_GAP`, Hyalo's `gaps_out`, the bar's margin).
pub const SCREEN_GAP: f64 = 4.;
/// The top bar's region a side dock must stay below while no Rust bar reports its real
/// reservation (APPLICATIONS1-DOCK.md §8): the TS bar's exclusive zone (`BAR_H`), which
/// already holds its own top margin. The hub owns this value and passes it in.
pub const BAR_RESERVATION: f64 = 36.;
pub const PAD_RATIO: f64 = 0.22;
pub const GAP_RATIO: f64 = 0.16;
/// The capsule's superellipse exponent (the TS dock's glass shape).
pub const CAPSULE_EXPONENT: f64 = 3.2;
pub const DOT: f64 = 5.;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Position {
    Bottom,
    Left,
    Right,
}
impl Position {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "bottom" => Some(Self::Bottom),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            _ => None,
        }
    }
    pub fn horizontal(self) -> bool {
        self == Self::Bottom
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Slot {
    Icon,
    Separator,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Layout {
    pub position: Position,
    /// The fit factor, 0 < scale <= 1.
    pub scale: f64,
    /// The surface's logical size; the capsule fills it.
    pub size: (u32, u32),
    /// Per slot, in surface coordinates: [x, y, w, h]. An icon's is its icon square; a
    /// separator's is its line.
    pub rects: Vec<[f64; 4]>,
    /// Per slot, its whole share of the main axis: what a click inside it hits.
    pub hits: Vec<[f64; 4]>,
    /// The cross size and screen gap: the dock's exclusive zone.
    pub exclusive_zone: i32,
    pub icon: f64,
}

/// `output` is the output's logical size; `reserved_top` what a side dock must stay below.
pub fn layout(
    slots: &[Slot],
    icon_size: u32,
    position: Position,
    output: (u32, u32),
    reserved_top: f64,
) -> Layout {
    let i = icon_size as f64;
    let pad = (i * PAD_RATIO).round();
    let gap = (i * GAP_RATIO).round();
    let main_of = |s: &Slot| match s {
        Slot::Icon => i + gap,
        Slot::Separator => 2. * gap,
    };
    // Both ends: the padding, less the half gap every slot already carries.
    let whole = 2. * (pad - gap / 2.) + slots.iter().map(main_of).sum::<f64>();
    let cross = i + 2. * pad;
    let room = if position.horizontal() {
        output.0 as f64 - 2. * SCREEN_GAP
    } else {
        output.1 as f64 - 2. * SCREEN_GAP - reserved_top
    };
    let scale = if whole <= room {
        1.
    } else {
        (room / whole).max(f64::MIN_POSITIVE)
    };
    let (main, cross_px) = (whole * scale, cross * scale);
    // Never one pixel more than the room it was fitted into.
    let ceil = |v: f64| (v - 1e-6).ceil().max(1.) as u32;
    let size = if position.horizontal() {
        (ceil(main), ceil(cross_px))
    } else {
        (ceil(cross_px), ceil(main))
    };

    let mut rects = vec![];
    let mut hits = vec![];
    let mut along = (pad - gap / 2.) * scale;
    for s in slots {
        let len = main_of(s) * scale;
        let (m, c, mw, cw) = match s {
            Slot::Icon => (along + gap / 2. * scale, pad * scale, i * scale, i * scale),
            Slot::Separator => (
                along + len / 2. - 0.5,
                cross_px * 0.125,
                1.,
                cross_px * 0.75,
            ),
        };
        let hit = (along, 0., len, cross_px);
        let swap = |(m, c, mw, cw): (f64, f64, f64, f64)| {
            if position.horizontal() {
                [m, c, mw, cw]
            } else {
                [c, m, cw, mw]
            }
        };
        rects.push(swap((m, c, mw, cw)));
        hits.push(swap(hit));
        along += len;
    }
    Layout {
        position,
        scale,
        size,
        rects,
        hits,
        exclusive_zone: (cross_px + SCREEN_GAP).ceil() as i32,
        icon: i * scale,
    }
}

impl Layout {
    /// The slot under a surface point, if any.
    pub fn hit(&self, x: f64, y: f64) -> Option<usize> {
        self.hits
            .iter()
            .position(|[hx, hy, w, h]| x >= *hx && x < hx + w && y >= *hy && y < hy + h)
    }
    /// The running dot's centre for an icon slot: between the icon and the screen edge.
    pub fn dot(&self, slot: usize) -> (f64, f64) {
        let [x, y, w, h] = self.rects[slot];
        let (sw, sh) = (self.size.0 as f64, self.size.1 as f64);
        match self.position {
            Position::Bottom => (x + w / 2., (y + h + sh) / 2.),
            Position::Left => (x / 2., y + h / 2.),
            Position::Right => ((x + w + sw) / 2., y + h / 2.),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ICONS: [Slot; 4] = [Slot::Icon, Slot::Icon, Slot::Separator, Slot::Icon];

    #[test]
    fn at_rest_it_keeps_the_ts_proportions() {
        let l = layout(&ICONS, 64, Position::Bottom, (1920, 1080), 0.);
        // pad 14, gap 10: 2×(14−5) + 3×74 + 20 = 260 wide, 64 + 28 = 92 high.
        assert_eq!((l.scale, l.size), (1., (260, 92)));
        assert_eq!(l.rects[0], [14., 14., 64., 64.]);
        assert_eq!(l.rects[1], [88., 14., 64., 64.]);
        assert_eq!(l.rects[2], [166.5, 11.5, 1., 69.]);
        assert_eq!(l.rects[3], [182., 14., 64., 64.]);
        assert_eq!(l.exclusive_zone, 96);
        // A side dock is the same strip, turned.
        let v = layout(&ICONS, 64, Position::Left, (1920, 1080), BAR_RESERVATION);
        assert_eq!(v.size, (92, 260));
        assert_eq!(v.rects[1], [14., 88., 64., 64.]);
    }

    #[test]
    fn it_shrinks_uniformly_inside_the_margins_with_no_floor() {
        let many = vec![Slot::Icon; 200];
        for (pos, out) in [
            (Position::Bottom, (800, 600)),
            (Position::Left, (800, 600)),
            (Position::Right, (300, 200)),
        ] {
            let l = layout(&many, 64, pos, out, BAR_RESERVATION);
            let room = if pos.horizontal() {
                out.0 as f64 - 8.
            } else {
                out.1 as f64 - 8. - BAR_RESERVATION
            };
            let main = if pos.horizontal() { l.size.0 } else { l.size.1 };
            assert!(
                l.scale < 1. && main as f64 <= room,
                "{pos:?}: {main} > {room}"
            );
            // Every slot keeps the same share: icon and gap shrink together.
            let w0 = l.hits[0][if pos.horizontal() { 2 } else { 3 }];
            assert!(
                l.hits
                    .iter()
                    .all(|h| (h[if pos.horizontal() { 2 } else { 3 }] - w0).abs() < 1e-9)
            );
            // And no item was dropped to get there.
            assert_eq!(l.rects.len(), 200);
        }
        // Far below any "minimum": 10000 icons still fit in 800 px.
        let l = layout(
            &vec![Slot::Icon; 10_000],
            64,
            Position::Bottom,
            (800, 600),
            0.,
        );
        assert!(l.size.0 <= 792 && l.icon < 1.);
    }

    #[test]
    fn hits_cover_the_strip_and_dots_sit_toward_the_edge() {
        let l = layout(&ICONS, 64, Position::Bottom, (1920, 1080), 0.);
        assert_eq!(l.hit(20., 50.), Some(0));
        assert_eq!(l.hit(158., 5.), Some(2));
        // The end padding is capsule, not an item.
        assert_eq!(l.hit(255., 50.), None);
        assert_eq!(l.hit(250., 91.), Some(3));
        assert_eq!(l.hit(260., 50.), None);
        assert_eq!(l.dot(0), (46., 85.));
        let r = layout(&ICONS, 64, Position::Right, (1920, 1080), 0.);
        assert_eq!(r.dot(0).0, 85.);
        let left = layout(&ICONS, 64, Position::Left, (1920, 1080), 0.);
        assert_eq!(left.dot(0).0, 7.);
    }
}
