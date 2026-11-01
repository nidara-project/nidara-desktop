// SPDX-License-Identifier: LGPL-3.0-or-later
//! Where every slot goes, and how far the dock shrinks to fit (DOCK.md §5,
//! APPLICATIONS1-DOCK.md §8 "Fit"). Measures are the TS dock's (DockPhysics.ts), so
//! the two look alike: a fixed padding of 10 and gap of 4 at every icon size, a capsule
//! whose radius is half its cross size. Everything scales by ONE factor; nothing has a
//! minimum size.

/// From the dock's glass to the screen edge: the desktop's one edge gap (the TS dock's
/// `DOCK_SCREEN_GAP`, Hyalo's `gaps_out`, the bar's margin).
pub const SCREEN_GAP: f64 = 4.;
/// The top bar's region a side dock must stay below while no Rust bar reports its real
/// reservation (APPLICATIONS1-DOCK.md §8): the TS bar's exclusive zone (`BAR_H`), which
/// already holds its own top margin. The hub owns this value and passes it in.
pub const BAR_RESERVATION: f64 = 36.;
/// The air round the icons and the gap between two, the same at every icon size (owner,
/// 2026-11-01, after the reference dock: 84 tall at icon 64). They were 0.22 and 0.16 of
/// the icon until then.
pub const PAD: f64 = 10.;
pub const GAP: f64 = 4.;
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
    /// The capsule's glass in surface coordinates: the whole surface at rest, a part of it
    /// once the surface has room for magnification (`envelope`).
    pub glass: [f64; 4],
    /// How far icons may grow, when magnification is on and there is room for it.
    pub mag: Option<Mag>,
}

/// Magnification's bounds (APPLICATIONS1-DOCK.md §8 "Fit and magnification"): the TS
/// dock's bell (DockPhysics.ts: a gaussian of the pointer's distance, sigma 1.1 slots),
/// up to the configured largest icon, cut down where the output or the bar leave less
/// room. The resting dock never moves for it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Mag {
    /// The largest icon over the resting one (the configured maximum, in logical px).
    pub k: f64,
    /// The share of that growth there is room for, 0 < amp <= 1.
    pub amp: f64,
    pub sigma: f64,
}
/// The TS dock's bell width, in slots, and how much a separator widens at its peak.
pub const SIGMA_SLOTS: f64 = 1.1;
const SEPARATOR_GROWTH: f64 = 0.4;
/// How far past each end of the glass the pointer already magnifies, in sigmas: where the
/// bell has fallen to about 1 %. The TS dock took the pointer 250 px past each end, so its
/// icons start growing as the pointer comes in from a side, before it reaches one.
const REACH_SIGMAS: f64 = 3.;

/// `output` is the output's logical size; `reserved_top` what a side dock must stay below.
pub fn layout(
    slots: &[Slot],
    icon_size: u32,
    position: Position,
    output: (u32, u32),
    reserved_top: f64,
) -> Layout {
    let i = icon_size as f64;
    let (pad, gap) = (PAD, GAP);
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
        glass: [0., 0., size.0 as f64, size.1 as f64],
        mag: None,
    }
}

/// Each slot's widening factor along the main axis for a pointer at `p` (main axis),
/// `presence` 0..1 of the way in.
fn growth(l: &Layout, slots: &[Slot], m: &Mag, p: f64, presence: f64) -> Vec<f64> {
    let h = l.position.horizontal();
    l.hits
        .iter()
        .zip(slots)
        .map(|(hit, s)| {
            let c = if h {
                hit[0] + hit[2] / 2.
            } else {
                hit[1] + hit[3] / 2.
            };
            let bell = presence * (-0.5 * ((p - c) / m.sigma).powi(2)).exp();
            1. + bell
                * m.amp
                * match s {
                    Slot::Icon => m.k - 1.,
                    Slot::Separator => SEPARATOR_GROWTH,
                }
        })
        .collect()
}

/// The resting layout given room to magnify in: headroom away from the screen edge and
/// slack at both ends of the main axis, as much as the output (and, for a side dock,
/// the bar) allow; the growth is cut down to what fits. The capsule, its exclusive zone
/// and every resting position stay where they were, only offset inside a larger surface.
pub fn envelope(
    mut l: Layout,
    slots: &[Slot],
    max_icon: u32,
    output: (u32, u32),
    reserved_top: f64,
) -> Layout {
    let k = max_icon as f64 / l.icon;
    let Some(first) = slots.iter().position(|s| *s == Slot::Icon) else {
        return l;
    };
    if k <= 1. + 1e-9 {
        return l;
    }
    let h = l.position.horizontal();
    let (main, cross) = if h {
        (l.size.0 as f64, l.size.1 as f64)
    } else {
        (l.size.1 as f64, l.size.0 as f64)
    };
    let slot = if h {
        l.hits[first][2]
    } else {
        l.hits[first][3]
    };
    let mut m = Mag {
        k,
        amp: 1.,
        sigma: slot * SIGMA_SLOTS,
    };
    // The most the strip lengthens: the pointer at its middle, all the way in.
    let extra: f64 = growth(&l, slots, &m, main / 2., 1.)
        .iter()
        .zip(&l.hits)
        .map(|(g, hit)| (g - 1.) * if h { hit[2] } else { hit[3] })
        .sum();
    let room_main = if h {
        output.0 as f64 - 2. * SCREEN_GAP
    } else {
        output.1 as f64 - 2. * SCREEN_GAP - reserved_top
    };
    // Headroom: never more than a third of the output across.
    let room_cross = (if h { output.1 } else { output.0 }) as f64 / 3. - cross;
    let slack = ((room_main - main) / 2.).max(0.);
    if extra / 2. > slack {
        m.amp = m.amp.min(2. * slack / extra);
    }
    let grow = (k - 1.) * l.icon;
    if grow * m.amp > room_cross {
        m.amp = m.amp.min((room_cross / grow).max(0.));
    }
    if m.amp < 1e-3 {
        return l;
    }
    // Room for the growth, and for the reach the pointer magnifies from beside the glass.
    let ext = (extra / 2. * m.amp + REACH_SIGMAS * m.sigma)
        .min(slack)
        .ceil();
    let head = (grow * m.amp).ceil();
    let (ox, oy) = match l.position {
        Position::Bottom => (ext, head),
        Position::Left => (0., ext),
        Position::Right => (head, ext),
    };
    let shift = |r: &mut [f64; 4]| {
        r[0] += ox;
        r[1] += oy;
    };
    l.rects.iter_mut().for_each(shift);
    l.hits.iter_mut().for_each(shift);
    shift(&mut l.glass);
    l.size = if h {
        ((main + 2. * ext) as u32, (cross + head) as u32)
    } else {
        ((cross + head) as u32, (main + 2. * ext) as u32)
    };
    l.mag = Some(m);
    l
}

impl Layout {
    /// What is drawn and hit now: the resting layout magnified around the pointer `p`
    /// (surface coordinates), `presence` 0..1 of the way in. The slot under the pointer
    /// keeps the pointer where it is in it; its neighbours make room on both sides, inside
    /// the surface. Icons grow from their edge-side base. Order never changes.
    pub fn magnify(&self, slots: &[Slot], p: (f64, f64), presence: f64) -> Layout {
        let Some(m) = self.mag.filter(|_| presence > 0.) else {
            return self.clone();
        };
        let h = self.position.horizontal();
        let along = |r: &[f64; 4]| if h { (r[0], r[2]) } else { (r[1], r[3]) };
        let pm = if h { p.0 } else { p.1 };
        let g = growth(self, slots, &m, pm, presence.min(1.));
        let lens: Vec<f64> = self.hits.iter().map(|r| along(r).1).collect();
        let grown: Vec<f64> = lens.iter().zip(&g).map(|(l, g)| l * g).collect();
        // The slot under the pointer keeps the pointer where it is in it. Off the strip (its
        // end padding, or the reach past it) the nearer end stays where it rests: anchored
        // at the pointer, the strip followed it out by a side and then jumped back to the
        // middle once the magnification was gone.
        let last = lens.len() - 1;
        let first_start = along(&self.hits[0]).0;
        let (sl, ll) = along(&self.hits[last]);
        let pa = pm.clamp(first_start, sl + ll);
        let k = self
            .hits
            .iter()
            .position(|r| {
                let (s, l) = along(r);
                pa < s + l
            })
            .unwrap_or(last);
        let (sk, lk) = along(&self.hits[k]);
        let f = ((pa - sk) / lk).clamp(0., 1.);
        let mut starts = vec![0.; lens.len()];
        starts[k] = pa - f * grown[k];
        for n in (0..k).rev() {
            starts[n] = starts[n + 1] - grown[n];
        }
        for n in k + 1..lens.len() {
            starts[n] = starts[n - 1] + grown[n - 1];
        }
        let (g0, glen) = along(&self.glass);
        let end_pad = along(&self.hits[0]).0 - g0;
        let mut glass_start = starts[0] - end_pad;
        let glass_end = starts[lens.len() - 1] + grown[lens.len() - 1] + end_pad;
        // Inside the surface, never past its ends.
        let size = if h { self.size.0 } else { self.size.1 } as f64;
        let mut shift = 0.;
        if glass_end > size {
            shift = size - glass_end;
        }
        if glass_start + shift < 0. {
            shift = -glass_start;
        }
        glass_start += shift;
        let glass_len = (glass_end - (glass_start - shift)).max(glen);
        let cross_size = if h { self.size.1 } else { self.size.0 } as f64;
        let mut out = self.clone();
        for n in 0..lens.len() {
            let start = starts[n] + shift;
            let rest = self.rects[n];
            let r = match slots[n] {
                Slot::Icon => {
                    let side = if h { rest[2] } else { rest[3] } * g[n];
                    let m0 = start + (grown[n] - side) / 2.;
                    match self.position {
                        Position::Bottom => [m0, rest[1] + rest[3] - side, side, side],
                        Position::Left => [rest[0], m0, side, side],
                        Position::Right => [rest[0] + rest[2] - side, m0, side, side],
                    }
                }
                Slot::Separator => {
                    let c = start + grown[n] / 2. - 0.5;
                    if h {
                        [c, rest[1], rest[2], rest[3]]
                    } else {
                        [rest[0], c, rest[2], rest[3]]
                    }
                }
            };
            out.rects[n] = r;
            out.hits[n] = if h {
                [start, 0., grown[n], cross_size]
            } else {
                [0., start, cross_size, grown[n]]
            };
        }
        out.glass = if h {
            [glass_start, self.glass[1], glass_len, self.glass[3]]
        } else {
            [self.glass[0], glass_start, self.glass[2], glass_len]
        };
        out
    }

    /// Where the dock takes input: its glass and whatever icon grew out of it.
    pub fn input(&self, slots: &[Slot]) -> Vec<[i32; 4]> {
        let px = |r: &[f64; 4]| {
            let (x0, y0) = (r[0].floor(), r[1].floor());
            [
                x0 as i32,
                y0 as i32,
                (r[0] + r[2]).ceil() as i32 - x0 as i32,
                (r[1] + r[3]).ceil() as i32 - y0 as i32,
            ]
        };
        let mut out = vec![px(&self.glass)];
        out.extend(
            self.rects
                .iter()
                .zip(slots)
                .filter(|(_, s)| **s == Slot::Icon)
                .map(|(r, _)| px(r)),
        );
        out
    }

    /// Beside the resting glass, at its height: where the pointer, coming in from a side,
    /// already magnifies (`REACH_SIGMAS`). Inside the surface; none without magnification.
    pub fn reach(&self) -> Option<[i32; 4]> {
        let m = self.mag?;
        let r = REACH_SIGMAS * m.sigma;
        let [x, y, w, h] = self.glass;
        let (sw, sh) = (self.size.0 as f64, self.size.1 as f64);
        let (x0, y0, x1, y1) = if self.position.horizontal() {
            ((x - r).max(0.), y, (x + w + r).min(sw), y + h)
        } else {
            (x, (y - r).max(0.), x + w, (y + h + r).min(sh))
        };
        let (x0, y0) = (x0.floor(), y0.floor());
        Some([
            x0 as i32,
            y0 as i32,
            x1.ceil() as i32 - x0 as i32,
            y1.ceil() as i32 - y0 as i32,
        ])
    }

    /// The slot under a surface point, if any.
    pub fn hit(&self, x: f64, y: f64) -> Option<usize> {
        self.hits
            .iter()
            .position(|[hx, hy, w, h]| x >= *hx && x < hx + w && y >= *hy && y < hy + h)
    }
    /// The running dot's centre for an icon slot: between the icon and the screen edge.
    pub fn dot(&self, slot: usize) -> (f64, f64) {
        let [x, y, w, h] = self.rects[slot];
        let [gx, gy, gw, gh] = self.glass;
        match self.position {
            Position::Bottom => (x + w / 2., (y + h + gy + gh) / 2.),
            Position::Left => ((gx + x) / 2., y + h / 2.),
            Position::Right => ((x + w + gx + gw) / 2., y + h / 2.),
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
        // pad 10, gap 4: 2×(10−2) + 3×68 + 8 = 228 wide, 64 + 20 = 84 high.
        assert_eq!((l.scale, l.size), (1., (228, 84)));
        assert_eq!(l.rects[0], [10., 10., 64., 64.]);
        assert_eq!(l.rects[1], [78., 10., 64., 64.]);
        assert_eq!(l.rects[2], [147.5, 10.5, 1., 63.]);
        assert_eq!(l.rects[3], [154., 10., 64., 64.]);
        assert_eq!(l.exclusive_zone, 88);
        // A side dock is the same strip, turned.
        let v = layout(&ICONS, 64, Position::Left, (1920, 1080), BAR_RESERVATION);
        assert_eq!(v.size, (84, 228));
        assert_eq!(v.rects[1], [10., 78., 64., 64.]);
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
        assert_eq!(l.hit(148., 5.), Some(2));
        // The end padding is capsule, not an item.
        assert_eq!(l.hit(225., 50.), None);
        assert_eq!(l.hit(218., 83.), Some(3));
        assert_eq!(l.hit(228., 50.), None);
        assert_eq!(l.dot(0), (42., 79.));
        let r = layout(&ICONS, 64, Position::Right, (1920, 1080), 0.);
        assert_eq!(r.dot(0).0, 79.);
        let left = layout(&ICONS, 64, Position::Left, (1920, 1080), 0.);
        assert_eq!(left.dot(0).0, 5.);
    }

    #[test]
    fn the_envelope_offsets_the_rest_and_keeps_the_capsule() {
        let rest = layout(&ICONS, 64, Position::Bottom, (1920, 1080), 0.);
        let e = envelope(rest.clone(), &ICONS, 128, (1920, 1080), 0.);
        let m = e.mag.expect("room to magnify");
        assert_eq!((m.k, m.amp), (2., 1.));
        // Headroom for a 128 px icon above a 64 px one; the exclusive zone is the capsule's.
        let head = e.glass[1];
        assert_eq!(head, 64.);
        assert_eq!(e.size.1 as f64, 84. + head);
        assert_eq!(e.exclusive_zone, rest.exclusive_zone);
        assert_eq!([e.glass[2], e.glass[3]], [228., 84.]);
        assert_eq!(e.rects[0], [10. + e.glass[0], 10. + head, 64., 64.]);
        // At presence 0, nothing moves.
        assert_eq!(e.magnify(&ICONS, (100., 100.), 0.), e);
        // No room (a 64 px maximum), or no magnification: the resting layout itself.
        assert_eq!(envelope(rest.clone(), &ICONS, 64, (1920, 1080), 0.), rest);
        // A narrow output cuts the growth instead of overflowing.
        let tight = envelope(rest.clone(), &ICONS, 128, (300, 1080), 0.);
        assert!(tight.mag.is_none_or(|m| m.amp < 1.) && tight.size.0 <= 292);
    }

    #[test]
    fn magnified_icons_grow_from_the_edge_in_order_inside_the_surface() {
        let slots = vec![Slot::Icon; 8];
        for pos in [Position::Bottom, Position::Left, Position::Right] {
            let rest = layout(&slots, 64, pos, (1920, 1080), BAR_RESERVATION);
            let e = envelope(rest, &slots, 128, (1920, 1080), BAR_RESERVATION);
            let h = pos.horizontal();
            for at in [3usize, 0, 7] {
                let hit = e.hits[at];
                let p = (hit[0] + hit[2] / 2., hit[1] + hit[3] / 2.);
                let m = e.magnify(&slots, p, 1.);
                // The pointer is still over the same slot, and it is the largest.
                assert_eq!(m.hit(p.0, p.1), Some(at), "{pos:?} {at}");
                let side = |n: usize| m.rects[n][2];
                assert!((0..8).all(|n| side(n) <= side(at) + 1e-9));
                assert!(side(at) <= 128. + 1e-9 && side(at) > 64.);
                // In order, never overlapping, all inside the surface.
                let start = |r: [f64; 4]| if h { (r[0], r[2]) } else { (r[1], r[3]) };
                for n in 1..8 {
                    let (a, al) = start(m.rects[n - 1]);
                    assert!(a + al <= start(m.rects[n]).0 + 1e-9, "{pos:?} {at} {n}");
                }
                let (w, hh) = (m.size.0 as f64, m.size.1 as f64);
                assert!(
                    m.rects.iter().chain([&m.glass]).all(|r| r[0] >= -1e-9
                        && r[1] >= -1e-9
                        && r[0] + r[2] <= w + 1e-9
                        && r[1] + r[3] <= hh + 1e-9),
                    "{pos:?} {at}"
                );
                // Each icon keeps its edge-side base.
                for n in 0..8 {
                    let (r, s) = (m.rects[n], e.rects[n]);
                    match pos {
                        Position::Bottom => assert!((r[1] + r[3] - s[1] - s[3]).abs() < 1e-9),
                        Position::Left => assert_eq!(r[0], s[0]),
                        Position::Right => assert!((r[0] + r[2] - s[0] - s[2]).abs() < 1e-9),
                    }
                }
            }
        }
    }

    #[test]
    fn off_the_strip_its_nearer_end_stays_and_the_reach_magnifies() {
        let slots = vec![Slot::Icon; 8];
        for pos in [Position::Bottom, Position::Left, Position::Right] {
            let rest = layout(&slots, 64, pos, (1920, 1080), BAR_RESERVATION);
            let e = envelope(rest, &slots, 128, (1920, 1080), BAR_RESERVATION);
            let h = pos.horizontal();
            let along = |r: [f64; 4]| if h { (r[0], r[2]) } else { (r[1], r[3]) };
            let (gs, gl) = along(e.glass);
            let (first, _) = along(e.hits[0]);
            let (ls, ll) = along(e.hits[7]);
            let sigma = e.mag.unwrap().sigma;
            let at = |m: f64| {
                let c = if h { e.glass[1] } else { e.glass[0] } + 1.;
                if h { (m, c) } else { (c, m) }
            };
            // The reach: beside the glass, inside the surface, at its height.
            let [rx, ry, rw, rh] = e.reach().unwrap().map(f64::from);
            let (r0, rl) = if h { (rx, rw) } else { (ry, rh) };
            assert!(r0 < gs - sigma && r0 + rl > gs + gl + sigma, "{pos:?}");
            assert!(
                rx >= 0. && ry >= 0. && rx + rw <= e.size.0 as f64 && ry + rh <= e.size.1 as f64
            );
            for p in [
                ls + ll + 3.,
                gs + gl - 1.,
                gs + gl + sigma,
                gs + gl + 2. * sigma,
            ] {
                for presence in [1., 0.5, 1e-9] {
                    let m = e.magnify(&slots, at(p), presence);
                    // The far end stays where it rests: leaving by a side does not drag it.
                    let (s, l) = along(m.hits[7]);
                    assert!((s + l - ls - ll).abs() < 1e-6, "{pos:?} {p} {presence}");
                }
                // And as it settles, every item is back where it rests: no jump at the end.
                let m = e.magnify(&slots, at(p), 1e-9);
                for n in 0..8 {
                    let (a, b) = (m.rects[n], e.rects[n]);
                    assert!(
                        (0..4).all(|i| (a[i] - b[i]).abs() < 1e-6),
                        "{pos:?} {p} {n}"
                    );
                }
            }
            // From the other side the near end stays, and a sigma out the first icon grows.
            let m = e.magnify(&slots, at(gs - sigma), 1.);
            assert!((along(m.hits[0]).0 - first).abs() < 1e-6, "{pos:?}");
            assert!(m.rects[0][2] > 64. + 1., "{pos:?}");
        }
    }
}
