// SPDX-License-Identifier: LGPL-3.0-or-later
//! Real exported styles and CPU paint; no foreign-compositor or live acceptance claim.
use nk_settings::{exports::Exports, portal::Appearance, styles::Styles};
use nk_text::{FontSet, ParleyBackend, Size};
use nk_widgets::{Surface, Tree};
use std::sync::Arc;

#[test]
fn menus_used_by_dropdown_and_suggestions_have_an_opaque_d5_base() {
    let capabilities =
        nk_wayland::capabilities(["wl_compositor", "wl_shm", "xdg_wm_base", "wl_seat"]).unwrap();
    assert!(!capabilities.material && !capabilities.layers);
    for dark in [false, true] {
        let exports = Exports::load(&Exports::root()).unwrap();
        let styles = Styles::new(
            &exports,
            &Appearance {
                accent: [0., 136. / 255., 1.],
                dark,
                reduce_transparency: false,
                reduced_motion: false,
                window_background: "translucent".into(),
                font: "Inter Variable 11".into(),
                text_scale: 1.,
            },
        )
        .unwrap();
        let mut menu_style = styles.menu.clone();
        menu_style.background.components[3] = 0.1;
        let (mut menu, _) = Tree::menu_list(
            "Options",
            styles.metrics,
            styles.text.clone(),
            menu_style,
            &["Option"],
            0,
        )
        .unwrap();
        let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
        menu.layout(
            Size {
                width: 320.,
                height: 100.,
            },
            false,
            &mut text,
        )
        .unwrap();
        let frame = nk_wayland::Frame {
            width: 320,
            height: 100,
            pixel_width: 320,
            pixel_height: 100,
            scale: 1.,
            material: capabilities.material,
        };
        let pixels = menu.paint(frame, Surface::Content, styles.palette).unwrap();
        // Interior whitespace avoids the rounded transparent corners and actual glyphs.
        for y in 40..60 {
            for x in 240..280 {
                assert_eq!(pixels[(y * 320 + x) * 4 + 3], 255, "dark={dark}");
            }
        }
    }
}
