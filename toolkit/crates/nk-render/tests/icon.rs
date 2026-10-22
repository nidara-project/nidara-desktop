// SPDX-License-Identifier: LGPL-3.0-or-later
//! A symbolic icon painted in its ink, fitted to its box, at 1 and 2.
use nk_render::{Canvas, rgba};
use nk_text::Rect;

const PLUS: &str = r#"<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg>"#;

/// Alpha of a logical point, from the premultiplied ARGB8888 the canvas finishes with.
fn alpha(pixels: &[u8], width: u32, scale: f64, x: f64, y: f64) -> u8 {
    let (x, y) = ((x * scale) as u32, (y * scale) as u32);
    let at = ((y * width + x) * 4) as usize;
    u32::from_ne_bytes(pixels[at..at + 4].try_into().unwrap()).to_be_bytes()[0]
}

fn rect() -> Rect {
    Rect {
        x: 10.,
        y: 10.,
        width: 48.,
        height: 48.,
    }
}

#[test]
fn the_icon_is_inked_where_it_draws_and_nowhere_else() {
    let icon = nk_icons::Icon::parse(PLUS.as_bytes()).unwrap();
    for scale in [1.0, 2.0] {
        let side = (80. * scale) as u16;
        let mut c = Canvas::new(side, side, scale);
        // A 48 px box at (10, 10): the strokes are 4 px wide, the cross's centre (34, 34).
        c.icon(&icon, rect(), rgba(255, 255, 255, 255));
        let px = c.finish();
        let w = side as u32;
        assert_eq!(alpha(&px, w, scale, 34., 34.), 255, "centre at {scale}");
        assert_eq!(alpha(&px, w, scale, 25., 34.), 255, "arm at {scale}");
        assert_eq!(alpha(&px, w, scale, 16., 16.), 0, "corner at {scale}");
        assert_eq!(alpha(&px, w, scale, 4., 34.), 0, "outside at {scale}");
    }
}

#[test]
fn the_ink_alpha_carries_through() {
    let icon = nk_icons::Icon::parse(PLUS.as_bytes()).unwrap();
    let mut c = Canvas::new(80, 80, 1.);
    c.icon(&icon, rect(), rgba(255, 255, 255, 128));
    let px = c.finish();
    // One layer at the ink's alpha: an arm and the crossing are the same.
    for (x, y) in [(25., 34.), (34., 34.)] {
        let a = alpha(&px, 80, 1., x, y);
        assert!((124..=132).contains(&a), "{a} at ({x}, {y})");
    }
}
