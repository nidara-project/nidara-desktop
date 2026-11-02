// SPDX-License-Identifier: LGPL-3.0-or-later
//! The continuous corner as it is DEFINED: from a straight edge, curvature growing from nothing
//! to that of a circle of radius `ρ` (a ramp, [`RAMP_ARCS`] circular arcs of growing curvature),
//! along that circle, and back to nothing on the other edge — iOS's continuous corners and
//! Figma's corner smoothing, at [`SMOOTHING`]. Exact, and too heavy for a shader that runs it
//! in nested loops (llvmpipe could not compile Hyalo's glass with it).
//!
//! It is what the crate's cheap curve ([`crate::sdf`]) is fitted to and checked against.
use std::f64::consts::{FRAC_PI_2, FRAC_PI_4};

/// How much of each 90° corner is ramp: 0.6, as iOS's continuous corners and Figma's corner
/// smoothing. Chosen, not measured (the owner's decision of 2026-11-02 was on drawings of it).
pub const SMOOTHING: f64 = 0.6;
/// The angle each ramp turns.
pub const RAMP: f64 = FRAC_PI_4 * SMOOTHING;
/// Circular arcs per ramp: the curvature grows in this many steps.
pub const RAMP_ARCS: usize = 3;
/// The arcs of one corner: a ramp, the circle, a ramp.
pub const ARCS: usize = 2 * RAMP_ARCS + 1;

/// One circular arc of a corner. Its points are `c + r·(sin φ, cos φ)` for `φ` from `from` to
/// `from + sweep`, in a frame with y up.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Arc {
    pub cx: f64,
    pub cy: f64,
    pub r: f64,
    pub from: f64,
    pub sweep: f64,
}

impl Arc {
    pub fn at(&self, phi: f64) -> [f64; 2] {
        [self.cx + self.r * phi.sin(), self.cy + self.r * phi.cos()]
    }
}

/// The chain of arcs for an arc radius `rho` and ramps `a` (first edge) and `b` (second),
/// leaving the origin along +x and turning clockwise (y up) until it heads straight down.
/// Returns the arcs and where the chain ends.
pub fn chain(rho: f64, a: f64, b: f64) -> ([Arc; ARCS], [f64; 2]) {
    let n = RAMP_ARCS as f64;
    let mut arcs = [Arc::default(); ARCS];
    let (mut p, mut th): ([f64; 2], f64) = ([0., 0.], 0.);
    for (k, arc) in arcs.iter_mut().enumerate() {
        // Ramp in: curvature (i + ½)/n of the circle's; the circle; ramp out, the reverse.
        let (f, sweep) = if k < RAMP_ARCS {
            let f = (k as f64 + 0.5) / n;
            (f, f * 2. * a / n)
        } else if k == RAMP_ARCS {
            (1., FRAC_PI_2 - a - b)
        } else {
            let f = (n - (k - RAMP_ARCS) as f64 + 0.5) / n;
            (f, f * 2. * b / n)
        };
        let r = rho / f;
        let c = [p[0] - r * th.sin(), p[1] - r * th.cos()];
        *arc = Arc {
            cx: c[0],
            cy: c[1],
            r,
            from: th,
            sweep,
        };
        th += sweep;
        p = arc.at(th);
    }
    (arcs, p)
}

/// How far the whole symmetric corner reaches along each edge, in arc radii (≈ 1.50).
pub fn reach() -> f64 {
    chain(1., RAMP, RAMP).1[0]
}

/// One corner of a box of half size `(hx, hy)` and corner radius `r`, in the box's first
/// quadrant (centre at the origin, y up): its arcs, and where it leaves the top edge (`x0`)
/// and meets the right one (`y0`). None: no corner (r ≤ 0, or an empty box).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Corner {
    pub arcs: [Arc; ARCS],
    pub x0: f64,
    pub y0: f64,
}

pub fn corner(hx: f64, hy: f64, r: f64) -> Option<Corner> {
    let (mut arcs, mut x0, mut y0) = canonical(hx.max(hy), hx.min(hy), r)?;
    if hy > hx {
        // A tall box: the long edge is the right one. Mirror across the diagonal.
        for arc in &mut arcs {
            (arc.cx, arc.cy) = (arc.cy, arc.cx);
            arc.from = FRAC_PI_2 - (arc.from + arc.sweep);
        }
        (x0, y0) = (y0, x0);
    }
    Some(Corner { arcs, x0, y0 })
}

/// The corner of a WIDE box, half sizes `l` ≥ `s`: its arcs, `x0` and `y0`.
fn canonical(l: f64, s: f64, r: f64) -> Option<([Arc; ARCS], f64, f64)> {
    if r <= 1e-6 || s <= 1e-6 {
        return None;
    }
    let e = reach();
    // The ramps (`a` on the long edge, `b` on the short) and the circle's radius.
    let (mut a, mut b, rho) = (RAMP, RAMP, r);
    let rho = if r * e <= s {
        rho
    } else {
        b = RAMP * ((s - r) / (s - s / e)).clamp(0., 1.);
        let end = chain(1., a, b).1;
        let mut rho = s / -end[1];
        if end[0] * rho > l {
            // Not room on the long edge either: its ramp shrinks too, to none at a square.
            let need = end[0] / -end[1];
            a = if need > 1. {
                RAMP * ((l - s) / (s * (need - 1.))).clamp(0., 1.)
            } else {
                0.
            };
            rho = s / -chain(1., a, b).1[1];
        }
        rho
    };
    let (mut arcs, end) = chain(rho, a, b);
    // Placed on the box: leaving the long edge at `l - reach`, `s` above the centre line.
    let (dx, dy) = (l - end[0], s);
    for arc in &mut arcs {
        arc.cx += dx;
        arc.cy += dy;
    }
    Some((arcs, dx, s + end[1]))
}

fn hypot(x: f64, y: f64) -> f64 {
    (x * x + y * y).sqrt()
}

fn arc_distance(arc: &Arc, q: [f64; 2]) -> f64 {
    let v = [q[0] - arc.cx, q[1] - arc.cy];
    let phi = v[0].atan2(v[1]);
    if phi >= arc.from && phi <= arc.from + arc.sweep {
        return (hypot(v[0], v[1]) - arc.r).abs();
    }
    let (s, e) = (arc.at(arc.from), arc.at(arc.from + arc.sweep));
    hypot(q[0] - s[0], q[1] - s[1]).min(hypot(q[0] - e[0], q[1] - e[1]))
}

/// Which side of the line a→b the point p is on.
fn side(a: [f64; 2], b: [f64; 2], p: [f64; 2]) -> f64 {
    (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
}

/// The signed distance from `p` (relative to the box's centre, either y direction) to a box
/// of half size `h` with this corner: negative inside. A tall box is measured as the wide one
/// it is turned, with the point turned too.
pub fn sdf(p: [f64; 2], h: [f64; 2], r: f64) -> f64 {
    let q = [p[0].abs(), p[1].abs()];
    let d_box = (q[0] - h[0]).max(q[1] - h[1]);
    let (q, l, s) = if h[1] > h[0] {
        ([q[1], q[0]], h[1], h[0])
    } else {
        (q, h[0], h[1])
    };
    // Where the curve can be nearer than the edges: within its corner, or (inside) within
    // the point's own depth of it. First the cheap bound, then the corner itself.
    let k = (-d_box).max(0.);
    let m = crate::MAX_REACH * r.min(s);
    if q[0] <= l - m - k || q[1] <= s - m - k {
        return d_box;
    }
    let Some((arcs, x0, y0)) = canonical(l, s, r) else {
        return d_box;
    };
    if q[0] <= x0 - k || q[1] <= y0 - k || (d_box >= 0. && (q[0] <= x0 || q[1] <= y0)) {
        return d_box;
    }
    // The straight edges on either side of the corner, then each arc. Inside: in the box and
    // short of the corner, or in the (convex, clockwise) polygon of the arcs' ends and the
    // corner's inner point, or in an arc's bulge past its chord.
    let mut u = hypot((q[0] - x0).max(0.), q[1] - s).min(hypot(q[0] - l, (q[1] - y0).max(0.)));
    let corner_pt = [l, s];
    let mut prev = [x0, s];
    let inner = [x0, y0];
    let (mut in_poly, mut in_bulge) = (true, false);
    for arc in &arcs {
        let end = arc.at(arc.from + arc.sweep);
        if arc.sweep > 0. {
            u = u.min(arc_distance(arc, q));
            in_poly &= side(prev, end, q) <= 1e-12;
            // The bulge is the circular segment: in the disk, past the chord, and within the
            // arc's own wedge (a flat ramp arc's disk reaches far past its segment).
            let phi = (q[0] - arc.cx).atan2(q[1] - arc.cy);
            in_bulge |= hypot(q[0] - arc.cx, q[1] - arc.cy) < arc.r
                && phi >= arc.from
                && phi <= arc.from + arc.sweep
                && side(prev, end, q) * side(prev, end, corner_pt) > 0.;
            prev = end;
        }
    }
    in_poly &= side(prev, inner, q) <= 1e-12 && side(inner, [x0, s], q) <= 1e-12;
    let inside = q[0] <= l && q[1] <= s && (q[0] <= x0 || q[1] <= y0 || in_poly || in_bulge);
    if inside { -u } else { u }
}

/// The outline of a `w`×`h` box with corner radius `r`, from its top-left, y down, clockwise
/// from the top edge's start: points no further than `step` apart along the curves.
pub fn outline(w: f64, h: f64, r: f64, step: f64) -> Vec<[f64; 2]> {
    let (hx, hy) = (w / 2., h / 2.);
    let tall = hy > hx;
    let (l, s) = (hx.max(hy), hx.min(hy));
    let Some((arcs, x0, _)) = canonical(l, s, r) else {
        return vec![[0., 0.], [w, 0.], [w, h], [0., h]];
    };
    // The first quadrant's curve, from the top edge to the right one (y up), made for the
    // wide box and turned for a tall one.
    let mut quarter = vec![[x0, s]];
    for arc in arcs.iter().filter(|a| a.sweep > 0.) {
        let n = ((arc.r * arc.sweep / step.max(1e-3)).ceil() as usize).max(1);
        for i in 1..=n {
            quarter.push(arc.at(arc.from + arc.sweep * i as f64 / n as f64));
        }
    }
    if tall {
        quarter = quarter.iter().rev().map(|p| [p[1], p[0]]).collect();
    }
    // The four corners, clockwise on screen (y down): top-right, bottom-right, bottom-left,
    // top-left, each from the quarter by mirroring.
    let mut out = Vec::with_capacity(quarter.len() * 4);
    let to_screen = |x: f64, y: f64| [hx + x, hy - y];
    out.extend(quarter.iter().map(|p| to_screen(p[0], p[1])));
    out.extend(quarter.iter().rev().map(|p| to_screen(p[0], -p[1])));
    out.extend(quarter.iter().map(|p| to_screen(-p[0], -p[1])));
    out.extend(quarter.iter().rev().map(|p| to_screen(-p[0], p[1])));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn close(a: f64, b: f64, eps: f64) -> bool {
        (a - b).abs() <= eps
    }

    #[test]
    fn the_symmetric_corner_reaches_one_and_a_half_radii() {
        let e = reach();
        assert!(e > 1.45 && e < 1.55, "{e}");
        let end = chain(1., RAMP, RAMP).1;
        assert!(close(end[0], -end[1], 1e-9), "{end:?}");
    }

    #[test]
    fn the_chain_is_tangent_where_its_arcs_meet() {
        let (arcs, _) = chain(10., RAMP, RAMP);
        for w in arcs.windows(2) {
            let (a, b) = (w[0], w[1]);
            let p = a.at(a.from + a.sweep);
            let q = b.at(b.from);
            assert!(close(p[0], q[0], 1e-9) && close(p[1], q[1], 1e-9));
            assert!(close(a.from + a.sweep, b.from, 1e-12));
        }
        let total: f64 = arcs.iter().map(|a| a.sweep).sum();
        assert!(close(total, FRAC_PI_2, 1e-12));
    }

    #[test]
    fn a_square_with_a_half_radius_is_a_circle() {
        for (x, y) in [
            (10., 0.),
            (0., 10.),
            (7.0710678, 7.0710678),
            (3., 4.),
            (12., 9.),
        ] {
            let d = sdf([x, y], [10., 10.], 10.);
            assert!(close(d, hypot(x, y) - 10., 1e-6), "{x},{y}: {d}");
        }
    }

    #[test]
    fn a_capsule_has_a_round_tip_and_straight_sides() {
        // 120×40: the tip's middle and the sides' middles are on the outline.
        let h = [60., 20.];
        assert!(close(sdf([60., 0.], h, 20.), 0., 1e-6));
        assert!(close(sdf([0., 20.], h, 20.), 0., 1e-9));
        assert!(close(sdf([0., 0.], h, 20.), -20., 1e-9));
        // The tip is an arc: its last arc is the circle, meeting the middle head on.
        let c = corner(60., 20., 20.).unwrap();
        let last = c.arcs.iter().rev().find(|a| a.sweep > 0.).unwrap();
        assert!(close(last.cy, 0., 1e-9), "{last:?}");
    }

    #[test]
    fn the_corner_changes_continuously_with_its_radius() {
        // Across both changes of regime (r = s/E and r = s), the outline moves a little for
        // a little change of r.
        let h = [80., 30.];
        let probe = [70., 25.];
        let mut last = sdf(probe, h, 1.);
        let mut r = 1.;
        while r < 40. {
            r += 0.05;
            let d = sdf(probe, h, r);
            assert!((d - last).abs() < 0.2, "r {r}: {last} → {d}");
            last = d;
        }
    }

    #[test]
    fn inside_and_outside_are_told_apart_round_the_corner() {
        let h = [86., 86.];
        let r = 38.;
        let c = corner(h[0], h[1], r).unwrap();
        for arc in &c.arcs {
            for t in [0.1, 0.5, 0.9] {
                let p = arc.at(arc.from + arc.sweep * t);
                let n = [p[0] - arc.cx, p[1] - arc.cy];
                let l = hypot(n[0], n[1]);
                let out = [p[0] + n[0] / l, p[1] + n[1] / l];
                let inn = [p[0] - n[0] / l, p[1] - n[1] / l];
                assert!(close(sdf(p, h, r), 0., 1e-6));
                assert!(close(sdf(out, h, r), 1., 1e-6), "{:?}", sdf(out, h, r));
                assert!(close(sdf(inn, h, r), -1., 1e-3), "{:?}", sdf(inn, h, r));
            }
        }
    }

    #[test]
    fn a_tall_box_is_a_wide_one_turned() {
        for (x, y) in [(5., 50.), (18., 55.), (19.9, 30.), (0., 59.), (12., 58.)] {
            let a = sdf([x, y], [20., 60.], 20.);
            let b = sdf([y, x], [60., 20.], 20.);
            assert!(close(a, b, 1e-9), "{x},{y}: {a} vs {b}");
        }
    }

    #[test]
    fn the_outline_runs_round_the_box() {
        let pts = outline(172., 172., 38., 1.);
        assert!(pts.iter().all(|p| p[0] >= -1e-9 && p[0] <= 172. + 1e-9));
        assert!(pts.iter().all(|p| close(
            sdf([p[0] - 86., p[1] - 86.], [86., 86.], 38.),
            0.,
            1e-6
        )));
    }
    /// Against brute force: the distance to a dense outline, and inside by winding, on a grid
    /// over several boxes — a pill, a tall pill, a square, a near-square, a small corner.
    #[test]
    fn the_distance_matches_brute_force() {
        for (w, h, r) in [
            (120., 40., 20.),
            (40., 120., 30.),
            (172., 172., 38.),
            (90., 80., 40.),
            (200., 60., 8.),
            (109., 32., 16.),
        ] {
            let pts = outline(w, h, r, 0.05);
            let (hx, hy) = (w / 2., h / 2.);
            let mut y = -6.;
            while y <= h + 6. {
                let mut x = -6.;
                while x <= w + 6. {
                    let mut best = f64::MAX;
                    let mut wind = false;
                    for i in 0..pts.len() {
                        let (a, b) = (pts[i], pts[(i + 1) % pts.len()]);
                        let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
                        let t = (((x - a[0]) * ex + (y - a[1]) * ey)
                            / (ex * ex + ey * ey).max(1e-18))
                        .clamp(0., 1.);
                        best = best.min(hypot(x - a[0] - ex * t, y - a[1] - ey * t));
                        if (a[1] > y) != (b[1] > y) && x < a[0] + (y - a[1]) / (b[1] - a[1]) * ex {
                            wind = !wind;
                        }
                    }
                    let want = if wind { -best } else { best };
                    let got = sdf([x - hx, y - hy], [hx, hy], r);
                    assert!(
                        (got - want).abs() < 0.02,
                        "{w}x{h} r{r} at ({x},{y}): {got} vs {want}"
                    );
                    x += 1.7;
                }
                y += 1.3;
            }
        }
    }
}
