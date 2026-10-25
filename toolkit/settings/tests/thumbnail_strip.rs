// SPDX-License-Identifier: LGPL-3.0-or-later
//! Actual retained Choice/Image/layout/paint with synthetic gallery data; no native claim.
use nk_render::{ImageFit, Raster, rgba};
use nk_settings::{exports::Exports, portal::Appearance, styles::Styles};
use nk_text::{FontSet, ParleyBackend, Point, Size};
use nk_widgets::{
    Command, Effect, ImageStyle, Kind, Surface, ThumbnailStyle, Tree, window::Composition,
};
use std::sync::Arc;
fn fixture() -> (
    Tree,
    ParleyBackend,
    u64,
    u64,
    Vec<u64>,
    Styles,
    ThumbnailStyle,
) {
    let exports = Exports::load(&Exports::root()).unwrap();
    let styles = Styles::new(
        &exports,
        &Appearance {
            accent: [0., 136. / 255., 1.],
            dark: true,
            reduce_transparency: false,
            window_background: "opaque".into(),
            reduced_motion: false,
            font: "Inter Variable 11".into(),
            text_scale: 1.,
        },
    )
    .unwrap();
    let mut t = Tree::new("Settings", styles.metrics, styles.text.clone()).unwrap();
    styles.apply(&mut t).unwrap();
    let scroll = t.append(t.root(), Kind::Scroll, "Content").unwrap();
    let group = t.group(scroll, "").unwrap();
    let style = ThumbnailStyle {
        picture: Size {
            width: 80.,
            height: 45.,
        },
        image: ImageStyle {
            fit: ImageFit::Cover,
            radius: styles.metrics.radius,
            border_width: 1.,
            border: styles.palette.separator,
            background: styles.palette.surface,
        },
        padding: 2.,
        border: 2.,
        radius: styles.metrics.radius,
        gap: 8.,
        background: styles.palette.surface,
        idle_border: rgba(0, 0, 0, 0),
        hover_border: styles.palette.separator,
        selected_border: styles.palette.accent,
    };
    let strip = t
        .thumbnail_strip(group, "Wallpaper gallery", style)
        .unwrap();
    let ids = (0..6)
        .map(|i| {
            t.thumbnail_option(strip, &format!("wallpaper-{i}.png"), false)
                .unwrap()
        })
        .collect::<Vec<_>>();
    let raster = Arc::new(Raster::from_rgba(4, 4, [0, 255, 0, 255].repeat(16)).unwrap());
    for id in &ids {
        t.set_image(*id, Some(raster.clone())).unwrap();
    }
    let text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    (t, text, scroll, strip, ids, styles, style)
}
#[test]
fn viewport_shared_pixels_pointer_keyboard_and_semantics_agree() {
    let (mut t, mut text, scroll, strip, ids, styles, _) = fixture();
    t.layout(
        Size {
            width: 260.,
            height: 240.,
        },
        false,
        &mut text,
    )
    .unwrap();
    let semantics = t.semantics();
    assert_eq!(semantics.nodes[&strip].role, nk_a11y::Role::Panel);
    assert!(
        ids.iter()
            .all(|id| semantics.nodes[id].role == nk_a11y::Role::RadioButton)
    );
    assert!(
        ids.iter().all(|id| !semantics.nodes[id].states.checked),
        "unknown canonical file selects none"
    );
    assert!(semantics.nodes[ids.last().unwrap()].states.offscreen);
    let viewport = t.node(strip).unwrap().bounds();
    let first = t.node(ids[0]).unwrap().bounds();
    let pixels = t
        .paint(
            nk_wayland::Frame {
                width: 260,
                height: 240,
                pixel_width: 260,
                pixel_height: 240,
                scale: 1.,
                material: false,
            },
            Surface::Content,
            styles.palette,
        )
        .unwrap();
    let at = |x: f32, y: f32| ((y as usize) * 260 + x as usize) * 4;
    let middle = at(first.x + first.width / 2., first.y + first.height / 2.);
    assert_eq!(&pixels[middle..middle + 4], &[0, 255, 0, 255]);
    let outside = at(
        viewport.x + viewport.width + 1.,
        first.y + first.height / 2.,
    );
    assert_ne!(
        &pixels[outside..outside + 4],
        &[0, 255, 0, 255],
        "strip leaked image pixels beyond its viewport"
    );
    let last = t.node(*ids.last().unwrap()).unwrap().bounds();
    let offscreen = Point {
        x: last.x + last.width / 2.,
        y: last.y + last.height / 2.,
    };
    t.pointer_press(offscreen).unwrap();
    assert_eq!(t.pointer_release(offscreen).unwrap(), Effect::None);
    t.dispatch(t.target(ids[0]), Command::Focus).unwrap();
    t.set_disabled(ids[5], true).unwrap();
    assert_eq!(
        t.control_key(0xff57).unwrap(),
        Some(Effect::Activated(ids[4]))
    );
    assert!(
        t.node(strip).unwrap().scroll().x > 0.,
        "keyboard focus must scroll its own thumbnail viewport"
    );
    assert_eq!(t.node(scroll).unwrap().scroll().x, 0.);
    let semantics = t.semantics();
    assert!(semantics.nodes[&ids[4]].states.checked);
    assert!(!semantics.nodes[&ids[4]].states.offscreen);
    assert!(semantics.nodes[&ids[0]].states.offscreen);
    assert_eq!(semantics.nodes[&strip].children, ids);
    let active = t.node(ids[4]).unwrap().bounds();
    t.pointer_motion(Point {
        x: active.x + active.width / 2.,
        y: active.y + active.height / 2.,
    });
    let painted = t
        .paint(
            nk_wayland::Frame {
                width: 260,
                height: 240,
                pixel_width: 260,
                pixel_height: 240,
                scale: 1.,
                material: false,
            },
            Surface::Content,
            styles.palette,
        )
        .unwrap();
    let edge = at(active.x + 1., active.y + active.height / 2.);
    assert!(
        painted[edge] > 200
            && painted[edge + 1] > 100
            && painted[edge + 1] < 200
            && painted[edge + 2] < 20,
        "chosen border must keep accent even under pointer hover: {:?}",
        &painted[edge..edge + 4]
    );
    t.scroll_to(strip, Point::default()).unwrap();
    let mut c = Composition::default();
    c.event(
        &mut t,
        &nk_wayland::Event::Motion(
            (viewport.x + viewport.width / 2.) as f64,
            (viewport.y + viewport.height / 2.) as f64,
        ),
    )
    .unwrap();
    c.event(&mut t, &nk_wayland::Event::HorizontalScroll(1000.))
        .unwrap();
    assert!(t.node(strip).unwrap().scroll().x > 0.);
    assert_eq!(t.node(scroll).unwrap().scroll().x, 0.);
    c.event(&mut t, &nk_wayland::Event::Scroll(-10000.))
        .unwrap();
    assert_eq!(t.node(strip).unwrap().scroll().x, 0.);
}
#[test]
fn canonical_none_style_reflow_and_removal_preserve_other_options() {
    let (mut t, mut text, _, strip, ids, _, mut style) = fixture();
    t.set_thumbnail_selected(strip, Some(ids[2])).unwrap();
    t.layout(
        Size {
            width: 260.,
            height: 240.,
        },
        false,
        &mut text,
    )
    .unwrap();
    let before = t.semantics().nodes[&strip].children.clone();
    assert!(t.set_thumbnail_selected(strip, Some(t.root())).is_err());
    assert!(t.semantics().nodes[&ids[2]].states.checked);
    t.scroll_to(strip, Point { x: 10000., y: 0. }).unwrap();
    style.picture = Size {
        width: 12.,
        height: 8.,
    };
    t.set_thumbnail_style(strip, style).unwrap();
    t.layout(
        Size {
            width: 600.,
            height: 240.,
        },
        false,
        &mut text,
    )
    .unwrap();
    assert_eq!(t.semantics().nodes[&strip].children, before);
    assert_eq!(t.node(strip).unwrap().scroll().x, 0.);
    assert!(t.semantics().nodes[&ids[2]].states.checked);
    let stale = t.target(ids[2]);
    let mut reversed = ids.clone();
    reversed.reverse();
    assert!(t.reorder_thumbnails(strip, &[ids[0]; 6]).is_err());
    assert_eq!(t.semantics().nodes[&strip].children, ids);
    t.reorder_thumbnails(strip, &reversed).unwrap();
    assert_eq!(t.semantics().nodes[&strip].children, reversed);
    assert!(t.semantics().nodes[&ids[2]].states.checked);
    assert!(t.dispatch(stale, Command::Activate).is_err());
    t.set_thumbnail_selected(strip, None).unwrap();
    assert!(ids.iter().all(|id| !t.semantics().nodes[id].states.checked));
    t.remove(ids[0]).unwrap();
    assert!(t.node(ids[1]).is_some());
    t.set_thumbnail_selected(strip, Some(ids[1])).unwrap();
    t.remove(strip).unwrap();
    assert!(t.set_image(ids[1], None).is_err());
}
