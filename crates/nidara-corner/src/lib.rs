// SPDX-License-Identifier: LGPL-3.0-or-later
//! The desktop's one corner (owner, 2026-11-02): every rounded shape — a capsule, a tile, a
//! menu, the dock, a window — is a rectangle whose corners are this curve, so nothing is drawn
//! one way and something else another.
//!
//! The corner is CONTINUOUS ([`reference`] defines it): from a straight edge its curvature
//! grows from nothing to a circle's and back, so the eye sees no jump where curve meets edge —
//! a plain circular arc has that jump. It reads as a circle of radius `r` from a distance, and
//! it leaves the edge about 1.5 radii from the box's corner.
//!
//! What is drawn is a quadrant of `(x/a)^p + (y/b)^q = 1` in each corner ([`Quadrant`]),
//! fitted to the reference: cheap enough for a shader to run in nested loops, within 0.2 % of
//! the radius of the exact curve. An exponent above 2 meets its edge with no curvature; an
//! exponent of 2 at a pill's tip keeps the tip round (a single exponent above 2 flattens it —
//! the dock's old squircle).
//!
//! How a radius becomes a corner, with `s` and `l` the box's short and long half-sizes:
//! - `K_SYM·r ≤ s`: the whole corner, [`K_SYM`] radii along each edge, exponent [`N_SYM`].
//! - `r` from `s/K_SYM` to `s` and beyond (a pill): toward a pill's end — [`K_PILL`] short
//!   half-sizes along the long edge, exponent [`N_PILL`] there and 2 at the round tip.
//! - A box too short for that (near a square) goes toward a circle instead, reached at a
//!   square with `r ≥ s`.
//!
//! [`sdf`] is the reference for the shaders' twin, `corner.glsl` ([`glsl`]); [`outline`] is
//! the path for whoever paints the shape itself.
pub mod reference;

/// The whole corner: how many radii it reaches along each edge, and its exponent. Fitted to
/// [`reference`] (smoothing 0.6): within 0.14 % of the radius.
pub const K_SYM: f64 = 1.516;
pub const N_SYM: f64 = 2.76;
/// A pill's end: how many short half-sizes it reaches along the long edge, and the exponent
/// there (2 at the tip). Fitted to [`reference`]: within 0.17 % of the short half-size.
pub const K_PILL: f64 = 1.38;
pub const N_PILL: f64 = 2.71;
/// The furthest a corner reaches along either edge, in `min(r, s)`: what a shader may test
/// before working the corner out.
pub const MAX_REACH: f64 = 1.52;

const GLSL: &str = include_str!("corner.glsl");

/// The GLSL twin of [`sdf`], `float corner_sdf(vec2 p, vec2 h, float r)`, to put in a shader
/// before its first use.
pub fn glsl() -> String {
    GLSL.replace("@NC_K_SYM@", &format!("{K_SYM:?}"))
        .replace("@NC_N_SYM@", &format!("{N_SYM:?}"))
        .replace("@NC_K_PILL@", &format!("{K_PILL:?}"))
        .replace("@NC_N_PILL@", &format!("{N_PILL:?}"))
        .replace("@NC_MAX_REACH@", &format!("{MAX_REACH:?}"))
}

/// One corner of a WIDE box: `(x/a)^p + (y/b)^q = 1`, `x` along the long edge from `l - a`,
/// `y` along the short one from `s - b`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Quadrant {
    pub a: f64,
    pub b: f64,
    pub p: f64,
    pub q: f64,
}

fn mix(x: f64, y: f64, t: f64) -> f64 {
    x + (y - x) * t
}

/// The corner of a wide box of half sizes `l` ≥ `s` and radius `r`. None: no corner.
pub fn quadrant(l: f64, s: f64, r: f64) -> Option<Quadrant> {
    if r <= 1e-6 || s <= 1e-6 {
        return None;
    }
    if r * K_SYM <= s {
        let a = K_SYM * r;
        return Some(Quadrant {
            a,
            b: a,
            p: N_SYM,
            q: N_SYM,
        });
    }
    // From the whole corner (at r = s/K_SYM) to a pill's end (at r = s) — on a box long
    // enough for one; on a square, to a circle; in between, as far as the box allows.
    let t = ((r - s / K_SYM) / (s - s / K_SYM)).clamp(0., 1.);
    let room = ((l - s) / ((K_PILL - 1.) * s)).clamp(0., 1.);
    Some(Quadrant {
        a: s + room * t * (K_PILL - 1.) * s,
        b: s,
        p: mix(mix(N_SYM, 2., t), mix(N_SYM, N_PILL, t), room),
        q: mix(N_SYM, 2., t),
    })
}

/// How far the corner of a `w`×`h` box of radius `r` reaches along its edges from the box's
/// corner: the square in each corner outside which the box is a plain rectangle — what a
/// renderer must leave out of an opaque region, or not skip. At most `MAX_REACH·r`.
pub fn reach(w: f64, h: f64, r: f64) -> f64 {
    let (l, s) = (w.max(h) / 2., w.min(h) / 2.);
    quadrant(l, s, r).map_or(0., |c| c.a.max(c.b))
}

/// The signed distance from `p` (relative to the box's centre, either y direction) to a box
/// of half size `h` with this corner: negative inside. Exact along the straight edges; round
/// the corner, the curve's value over its gradient — exact on the outline, close near it.
pub fn sdf(p: [f64; 2], h: [f64; 2], r: f64) -> f64 {
    let q = [p[0].abs(), p[1].abs()];
    let d_box = (q[0] - h[0]).max(q[1] - h[1]);
    // A tall box is measured as the wide one it is turned, with the point turned too.
    let (q, l, s) = if h[1] > h[0] {
        ([q[1], q[0]], h[1], h[0])
    } else {
        (q, h[0], h[1])
    };
    let Some(c) = quadrant(l, s, r) else {
        return d_box;
    };
    let o = [l - c.a, s - c.b];
    if q[0] <= o[0] || q[1] <= o[1] {
        return d_box;
    }
    let k = [(q[0] - o[0]) / c.a, (q[1] - o[1]) / c.b];
    let f = k[0].powf(c.p) + k[1].powf(c.q);
    // f^(1/m) grows like the distance, so the estimate holds away from the outline too.
    let m = c.p.max(c.q);
    let g = f.powf(1. / m);
    let grad = [
        c.p * k[0].powf(c.p - 1.) / c.a,
        c.q * k[1].powf(c.q - 1.) / c.b,
    ];
    let grad_g = g / (m * f.max(1e-12)) * (grad[0] * grad[0] + grad[1] * grad[1]).sqrt();
    (g - 1.) / grad_g.max(1e-9)
}

/// The outline of a `w`×`h` box with corner radius `r`, from its top-left, y down, clockwise
/// from the top edge's start: points no further than about `step` apart along the curves.
pub fn outline(w: f64, h: f64, r: f64, step: f64) -> Vec<[f64; 2]> {
    let (hx, hy) = (w / 2., h / 2.);
    let tall = hy > hx;
    let (l, s) = (hx.max(hy), hx.min(hy));
    let Some(c) = quadrant(l, s, r) else {
        return vec![[0., 0.], [w, 0.], [w, h], [0., h]];
    };
    // The first quadrant's curve, from the long edge to the short one (y up), made for the
    // wide box and turned for a tall one. Sampled by angle, finely: the curve is steep near
    // its ends in this parameter.
    let n = (((c.a + c.b) * 2. / step.max(1e-3)).ceil() as usize).max(8);
    let mut quarter: Vec<[f64; 2]> = (0..=n)
        .map(|i| {
            let t = i as f64 / n as f64 * std::f64::consts::FRAC_PI_2;
            [
                l - c.a + c.a * t.sin().powf(2. / c.p),
                s - c.b + c.b * t.cos().powf(2. / c.q),
            ]
        })
        .collect();
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

    /// The largest distance from the drawn outline to the reference outline, over a box.
    fn deviation(w: f64, h: f64, r: f64) -> f64 {
        outline(w, h, r, 0.05)
            .iter()
            .map(|p| reference::sdf([p[0] - w / 2., p[1] - h / 2.], [w / 2., h / 2.], r).abs())
            .fold(0., f64::max)
    }

    #[test]
    fn the_drawn_corner_follows_the_reference() {
        // A corner, a pill, a tall pill, a short pill: within 0.2 % of the radius.
        for (w, h, r) in [
            (400f64, 400., 20f64),
            (172., 172., 38.),
            (300., 40., 20.),
            (32., 109., 16.),
        ] {
            let m = r.min(w.min(h) / 2.);
            let d = deviation(w, h, r);
            assert!(d <= 0.002 * m, "{w}x{h} r{r}: {d}");
        }
    }

    #[test]
    fn between_the_fitted_shapes_it_stays_near_the_reference() {
        // Radii between the whole corner and a pill's, and boxes between a square and a pill:
        // not fitted, interpolated; still within 2.5 % of the short half-size.
        for (w, h, r) in [
            (300f64, 60., 22f64),
            (300., 60., 26.),
            (90., 80., 40.),
            (100., 80., 30.),
        ] {
            let d = deviation(w, h, r);
            assert!(d <= 0.025 * w.min(h) / 2., "{w}x{h} r{r}: {d}");
        }
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
            assert!(close(d, f64::hypot(x, y) - 10., 1e-6), "{x},{y}: {d}");
        }
    }

    #[test]
    fn a_pill_meets_its_edges_flat_and_its_tip_round() {
        let c = quadrant(60., 20., 20.).unwrap();
        // Above 2 where it leaves the long edge (no curvature there), 2 at the tip.
        assert!(c.p > 2.5 && close(c.q, 2., 1e-12), "{c:?}");
        assert!(close(sdf([60., 0.], [60., 20.], 20.), 0., 1e-9));
        assert!(close(sdf([0., 20.], [60., 20.], 20.), 0., 1e-9));
    }

    #[test]
    fn the_corner_changes_continuously() {
        // With the radius, across both changes of rule, and with the box's length.
        let probe = [70., 25.];
        let mut last = sdf(probe, [80., 30.], 1.);
        let mut r = 1.;
        while r < 40. {
            r += 0.05;
            let d = sdf(probe, [80., 30.], r);
            assert!((d - last).abs() < 0.2, "r {r}: {last} → {d}");
            last = d;
        }
        let probe = [28., 25.];
        let mut last = sdf(probe, [30., 30.], 25.);
        let mut l = 30.;
        while l < 60. {
            l += 0.05;
            let d = sdf([probe[0] + l - 30., probe[1]], [l, 30.], 25.);
            assert!((d - last).abs() < 0.2, "l {l}: {last} → {d}");
            last = d;
        }
    }

    #[test]
    fn inside_and_outside_match_the_reference_off_the_outline() {
        // The sign everywhere a pixel's width from the outline, and the distance near it.
        for (w, h, r) in [
            (172f64, 172., 38f64),
            (120., 40., 20.),
            (40., 120., 30.),
            (200., 60., 8.),
        ] {
            let (hx, hy) = (w / 2., h / 2.);
            let mut y = -6.;
            while y <= h + 6. {
                let mut x = -6.;
                while x <= w + 6. {
                    let p = [x - hx, y - hy];
                    let want = reference::sdf(p, [hx, hy], r);
                    let got = sdf(p, [hx, hy], r);
                    if want.abs() > 1. {
                        assert_eq!(got < 0., want < 0., "{w}x{h} r{r} at ({x},{y})");
                    }
                    if want.abs() < 3. {
                        assert!(
                            (got - want).abs() < 0.25,
                            "{w}x{h} r{r} ({x},{y}): {got} {want}"
                        );
                    }
                    x += 1.7;
                }
                y += 1.3;
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
    fn no_corner_reaches_further_than_max_reach() {
        let mut l = 1.;
        while l < 120. {
            let mut s = 0.5;
            while s <= l {
                let mut r = 0.25;
                while r < 150. {
                    if let Some(c) = quadrant(l, s, r) {
                        let m = MAX_REACH * r.min(s);
                        assert!(c.a <= m + 1e-9 && c.b <= m + 1e-9, "{l} {s} {r}: {c:?}");
                        assert!(c.a <= l + 1e-9 && c.b <= s + 1e-9, "{l} {s} {r}: {c:?}");
                    }
                    r *= 1.07;
                }
                s *= 1.13;
            }
            l *= 1.11;
        }
    }

    #[test]
    fn outside_the_reach_the_box_is_a_rectangle() {
        for (w, h, r) in [
            (400f64, 400., 20f64),
            (300., 40., 20.),
            (32., 109., 16.),
            (90., 80., 40.),
        ] {
            let k = reach(w, h, r);
            for p in outline(w, h, r, 0.5) {
                let (dx, dy) = (p[0].min(w - p[0]), p[1].min(h - p[1]));
                // Off the box's edge, the point is inside one corner's reach square.
                if dx > 1e-6 && dy > 1e-6 {
                    assert!(
                        dx <= k + 1e-6 && dy <= k + 1e-6,
                        "{w}x{h} r{r} {p:?} reach {k}"
                    );
                }
            }
        }
    }

    #[test]
    fn the_glsl_twin_has_the_rusts_numbers() {
        let g = glsl();
        assert!(!g.contains('@'));
        for (name, v) in [
            ("NC_K_SYM", K_SYM),
            ("NC_N_SYM", N_SYM),
            ("NC_K_PILL", K_PILL),
            ("NC_N_PILL", N_PILL),
            ("NC_MAX_REACH", MAX_REACH),
        ] {
            assert!(g.contains(&format!("#define {name} {v:?}\n")), "{name}");
        }
    }

    #[test]
    fn the_outline_lies_on_the_zero_of_the_distance() {
        for (w, h, r) in [(172f64, 172., 38f64), (109., 32., 16.), (40., 120., 30.)] {
            for p in outline(w, h, r, 1.) {
                let d = sdf([p[0] - w / 2., p[1] - h / 2.], [w / 2., h / 2.], r);
                assert!(close(d, 0., 1e-6), "{w}x{h} r{r} {p:?}: {d}");
            }
        }
    }
}
