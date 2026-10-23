// SPDX-License-Identifier: LGPL-3.0-or-later
//! Real exported styles/Tree/CPU paint; synthetic image pixels, no native/provider claim.
use nk_render::{ImageFit, Raster};
use nk_settings::{exports::Exports, portal::Appearance, styles::Styles};
use nk_text::{FontSet, ParleyBackend, Size};
use nk_widgets::{ImageStyle, Kind, Surface, Tree};
use std::sync::Arc;
#[test]
fn image_has_one_retained_identity_clipped_pixels_and_scoped_ownership() {
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
    let style = ImageStyle {
        fit: ImageFit::Cover,
        radius: 8.,
        border_width: 2.,
        border: styles.palette.separator,
        background: styles.palette.surface,
    };
    let id = t
        .image(
            group,
            "Loading",
            Size {
                width: 160.,
                height: 90.,
            },
            style,
        )
        .unwrap();
    let pixels = Arc::new(Raster::from_rgba(8, 4, [255, 0, 255, 255].repeat(32)).unwrap());
    let weak = Arc::downgrade(&pixels);
    t.set_image(id, Some(pixels.clone())).unwrap();
    drop(pixels);
    t.set_name(id, "/wallpapers/example.png").unwrap();
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    t.layout(
        Size {
            width: 800.,
            height: 500.,
        },
        false,
        &mut text,
    )
    .unwrap();
    let semantic = t.semantics();
    let image = &semantic.nodes[&id];
    assert_eq!(image.role, nk_a11y::Role::Image);
    assert!(image.actions.is_empty());
    assert_eq!(image.name, "/wallpapers/example.png");
    let r = t.node(id).unwrap().bounds();
    assert_eq!(r.width / r.height, 160. / 90.);
    let frame = nk_wayland::Frame {
        width: 800,
        height: 500,
        pixel_width: 800,
        pixel_height: 500,
        scale: 1.,
        material: false,
    };
    let actual = t.paint(frame, Surface::Content, styles.palette).unwrap();
    let center = (((r.y + r.height / 2.) as usize) * 800 + (r.x + r.width / 2.) as usize) * 4;
    assert_eq!(
        &actual[center..center + 4],
        &[255, 0, 255, 255],
        "retained image must paint decoded pixels"
    );
    let corner = ((r.y as usize) * 800 + r.x as usize) * 4;
    assert_ne!(
        &actual[corner..corner + 4],
        &[255, 0, 255, 255],
        "rounded clip excludes picture corners"
    );
    t.layout(
        Size {
            width: 800.,
            height: 10.,
        },
        false,
        &mut text,
    )
    .unwrap();
    assert!(
        t.semantics().nodes[&id].states.offscreen,
        "offscreen Image remains retained without SHOWING"
    );
    t.layout(
        Size {
            width: 800.,
            height: 500.,
        },
        false,
        &mut text,
    )
    .unwrap();
    let before = t.node(id).unwrap().bounds();
    assert!(
        t.set_image_size(
            id,
            Size {
                width: f32::NAN,
                height: 2.
            }
        )
        .is_err()
    );
    t.layout(
        Size {
            width: 800.,
            height: 500.,
        },
        false,
        &mut text,
    )
    .unwrap();
    assert_eq!(t.node(id).unwrap().bounds(), before);
    t.acknowledge();
    let held = weak.upgrade().unwrap();
    t.set_image(id, Some(held.clone())).unwrap();
    assert!(!t.invalidation().paint, "same raster does not repaint");
    drop(held);
    t.set_hidden(id, true).unwrap();
    assert!(!t.semantics().nodes.contains_key(&id));
    t.set_hidden(id, false).unwrap();
    assert!(t.semantics().nodes.contains_key(&id));
    t.remove(id).unwrap();
    assert!(weak.upgrade().is_none(), "removal releases image pixels");
    assert!(t.set_image(id, None).is_err());
}
