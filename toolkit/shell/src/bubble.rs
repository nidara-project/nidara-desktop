// SPDX-License-Identifier: LGPL-3.0-or-later
//! The dock's popups point at their item, as the TS kit's glass bubble does
//! (glass-bubble.ts `bubbleGeometry`): a body and a short rounded pointer, which Hyalo
//! draws as one glass (`Pane::pointer`). The popup is opened `ARROW_H` larger on the side
//! toward its anchor; once the compositor has placed it, the pointer goes on whichever side
//! faces the anchor (it may have flipped it) and slides along that edge to the anchor's
//! centre (it may have slid it), never into the corner arcs.
use nk_wayland::{Frame, Pane, Pointer, PopupSide};

/// The pointer's base width and how far it protrudes: 16:8, about a right angle at the tip.
pub const ARROW_W: f64 = 16.;
pub const ARROW_H: f64 = 8.;
/// How round the tip is, and the concave arc where the pointer meets the body.
const TIP_R: f64 = 4.;
const BASE_R: f64 = 8.;

/// A popup's size with room for its pointer on the side toward the anchor, and even
/// across it: the compositor centres a popup by halving its size in whole pixels, so an
/// odd one came out half a pixel to one side of its pointer's icon.
pub fn with_pointer(size: (u32, u32), side: PopupSide) -> (u32, u32) {
    let h = ARROW_H as u32;
    let even = |v: u32| v + v % 2;
    match side {
        PopupSide::Below | PopupSide::Above | PopupSide::AboveCentered => {
            (even(size.0), size.1 + h)
        }
        PopupSide::Right | PopupSide::Left | PopupSide::RightCentered | PopupSide::LeftCentered => {
            (size.0 + h, even(size.1))
        }
    }
}

/// The body (popup-local `[x, y, w, h]`) and the glass to draw for a popup placed at
/// `geometry` (parent coordinates) for `anchor` (parent coordinates). None when it is too
/// small for a body.
pub fn place(
    geometry: [i32; 4],
    anchor: [i32; 4],
    radius_max: f64,
    exponent: f64,
) -> Option<([f64; 4], Pane)> {
    let [gx, gy, gw, gh] = geometry.map(f64::from);
    let (ax, ay) = (
        f64::from(anchor[0]) + f64::from(anchor[2]) / 2.,
        f64::from(anchor[1]) + f64::from(anchor[3]) / 2.,
    );
    // The side facing the anchor: below it, above it, right of it, left of it.
    let (top, bottom, left, right) = if gy + gh <= ay {
        (false, true, false, false)
    } else if gy >= ay {
        (true, false, false, false)
    } else if gx >= ax {
        (false, false, true, false)
    } else {
        (false, false, false, true)
    };
    let x = if left { ARROW_H } else { 0. };
    let y = if top { ARROW_H } else { 0. };
    let bw = gw - if left || right { ARROW_H } else { 0. };
    let bh = gh - if top || bottom { ARROW_H } else { 0. };
    if bw <= 0. || bh <= 0. {
        return None;
    }
    let along = top || bottom;
    let edge = if along { bw } else { bh };
    let r = (bw.min(bh) / 2.)
        .min(radius_max)
        .min((edge - ARROW_W) / 2. - 2.)
        .max(4.);
    let aw = ARROW_W.min((edge - 2. * r - 4.).max(6.));
    let max_off = ((edge - aw) / 2. - r - 2.).max(0.);
    let off = if along {
        ax - (gx + x + bw / 2.)
    } else {
        ay - (gy + y + bh / 2.)
    }
    .clamp(-max_off, max_off);
    let (cx, cy) = (x + bw / 2. + off, y + bh / 2. + off);
    let (base, tip) = if bottom {
        ((cx, y + bh), (cx, y + bh + ARROW_H))
    } else if top {
        ((cx, y), (cx, y - ARROW_H))
    } else if right {
        ((x + bw, cy), (x + bw + ARROW_H, cy))
    } else {
        ((x, cy), (x - ARROW_H, cy))
    };
    Some((
        [x, y, bw, bh],
        Pane {
            x,
            y,
            width: bw,
            height: bh,
            radius: r,
            exponent,
            pointer: Some(Pointer {
                base,
                tip,
                width: aw,
                tip_radius: TIP_R,
                base_radius: BASE_R,
            }),
        },
    ))
}

/// The frame of the body inside a popup's `frame`, and where its pixels start: content
/// laid out and painted for the body alone, then put in place with [`blit`], so what fills
/// a whole surface (a menu's rows) leaves the pointer's room clear.
pub fn inset(frame: Frame, body: [f64; 4]) -> (Frame, (usize, usize)) {
    let px = |v: f64| (v * frame.scale).round().max(0.) as usize;
    let (x, y) = (
        px(body[0]).min(usize::from(frame.pixel_width)),
        px(body[1]).min(usize::from(frame.pixel_height)),
    );
    let w = px(body[2]).clamp(1, (usize::from(frame.pixel_width) - x).max(1));
    let h = px(body[3]).clamp(1, (usize::from(frame.pixel_height) - y).max(1));
    (
        Frame {
            width: body[2].round().max(1.) as u32,
            height: body[3].round().max(1.) as u32,
            pixel_width: w as u16,
            pixel_height: h as u16,
            ..frame
        },
        (x, y),
    )
}

/// The body's pixels (`inner`, from [`inset`]) at `at` in a transparent `frame`.
pub fn blit(frame: Frame, inner: Frame, at: (usize, usize), pixels: &[u8]) -> Vec<u8> {
    let (fw, fh) = (
        usize::from(frame.pixel_width),
        usize::from(frame.pixel_height),
    );
    let (iw, ih) = (
        usize::from(inner.pixel_width),
        usize::from(inner.pixel_height),
    );
    let mut out = vec![0; fw * fh * 4];
    for row in 0..ih.min(fh.saturating_sub(at.1)) {
        let n = iw.min(fw.saturating_sub(at.0)) * 4;
        let from = row * iw * 4;
        let to = ((at.1 + row) * fw + at.0) * 4;
        if let (Some(src), Some(dst)) = (pixels.get(from..from + n), out.get_mut(to..to + n)) {
            dst.copy_from_slice(src);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn above_its_icon_it_points_down_at_the_icons_centre() {
        // A 100 × 30 popup (22 + the pointer) centred above an icon at x 200..264.
        let anchor = [200, -6, 64, 96];
        let (body, pane) = place([182, -40, 100, 30], anchor, 13., 2.).unwrap();
        assert_eq!(body, [0., 0., 100., 22.]);
        let p = pane.pointer.unwrap();
        assert_eq!(p.base, (50., 22.));
        assert_eq!(p.tip, (50., 30.));
        assert_eq!(p.width, ARROW_W);
        // Slid toward the screen edge by the compositor: the pointer still finds the icon.
        let (_, pane) = place([170, -40, 100, 30], anchor, 13., 2.).unwrap();
        assert_eq!(pane.pointer.unwrap().tip.0, 232. - 170.);
        // Never into the corner arc.
        let (_, pane) = place([0, -40, 100, 30], [900, -6, 64, 96], 13., 2.).unwrap();
        let p = pane.pointer.unwrap();
        assert!(p.base.0 + p.width / 2. <= 100. - pane.radius - 2. + 1e-9);
    }

    #[test]
    fn flipped_or_beside_it_the_pointer_faces_the_anchor() {
        // Below the anchor: the pointer on top.
        let (body, pane) = place([0, 100, 100, 30], [18, 0, 64, 90], 13., 2.).unwrap();
        assert_eq!(body[1], ARROW_H);
        assert_eq!(pane.pointer.unwrap().tip, (50., 0.));
        // Right of a left dock's icon: on the left side, at the icon's height.
        let anchor = [-6, 300, 96, 64];
        let (body, pane) = place([90, 300, 108, 60], anchor, 13., 2.).unwrap();
        assert_eq!(body[0], ARROW_H);
        assert_eq!(pane.pointer.unwrap().tip, (0., 332. - 300.));
        // Left of a right dock's icon: on the right side.
        let (_, pane) = place([-120, 310, 108, 40], [0, 300, 96, 64], 13., 2.).unwrap();
        assert_eq!(pane.pointer.unwrap().tip.0, 108.);
        assert_eq!(with_pointer((100, 22), PopupSide::AboveCentered), (100, 30));
        assert_eq!(with_pointer((100, 32), PopupSide::RightCentered), (108, 32));
        // Odd across: one pixel more, so the compositor halves it exactly.
        assert_eq!(with_pointer((57, 22), PopupSide::AboveCentered), (58, 30));
        assert_eq!(with_pointer((100, 31), PopupSide::LeftCentered), (108, 32));
    }

    #[test]
    fn the_body_is_painted_apart_and_put_beside_the_pointers_room() {
        let frame = Frame {
            width: 100,
            height: 30,
            pixel_width: 125,
            pixel_height: 38,
            scale: 1.25,
            material: true,
        };
        // A pointer on the left: the body starts 8 logical (10 px) in.
        let (inner, at) = inset(frame, [8., 0., 92., 30.]);
        assert_eq!(at, (10, 0));
        assert_eq!((inner.width, inner.height), (92, 30));
        assert_eq!((inner.pixel_width, inner.pixel_height), (115, 38));
        let body = vec![255u8; 115 * 38 * 4];
        let out = blit(frame, inner, at, &body);
        assert_eq!(out.len(), 125 * 38 * 4);
        let px = |x: usize, y: usize| out[(y * 125 + x) * 4];
        // The pointer's room stays clear; the body is all there.
        assert!((0..10).all(|x| (0..38).all(|y| px(x, y) == 0)));
        assert!((10..125).all(|x| (0..38).all(|y| px(x, y) == 255)));
    }
}
