// SPDX-License-Identifier: LGPL-3.0-or-later
//! The switch's pixels from its exported look (`SwitchStyle`), with no compositor.
use nk_render::{Color, rgba};
use nk_text::{FontSet, ParleyBackend, Size, TextStyle};
use nk_widgets::{Kind, Metrics, Palette, Surface, SwitchStyle, Tree};
use std::sync::Arc;

const SURFACE: (u8, u8, u8) = (50, 50, 50);
const TRACK: (u8, u8, u8) = (70, 70, 70);
const CHECKED: (u8, u8, u8) = (0, 100, 255);
const THUMB: (u8, u8, u8) = (255, 255, 255);
const EDGE: (u8, u8, u8) = (200, 0, 0);

fn opaque(c: (u8, u8, u8)) -> Color {
    rgba(c.0, c.1, c.2, 255)
}

fn style() -> SwitchStyle {
    SwitchStyle {
        border: 1.,
        border_color: opaque(EDGE),
        checked_border_color: opaque(EDGE),
        track: opaque(TRACK),
        checked: opaque(CHECKED),
        thumb: opaque(THUMB),
        thumb_margin: 3.,
        disabled_opacity: 0.45,
    }
}

struct Fixture {
    tree: Tree,
    text: ParleyBackend,
    off: u64,
    on: u64,
    disabled: u64,
}

fn fixture(with_style: bool) -> Fixture {
    let text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    let mut tree = Tree::new(
        "Window",
        Metrics {
            sidebar: 0.,
            content: 600.,
            form_width: 600.,
            content_floor: 280.,
            titlebar: 48.,
            padding: 8.,
            gap: 4.,
            row: 48.,
            control: 24.,
            switch_width: 44.,
            radius: 8.,
            group_radius: 12.,
            focus_width: 2.,
            highlight_inset: 4.,
            hover_opacity: 0.08,
            separator_width: 1.,
        },
        TextStyle {
            size: 14.,
            ..Default::default()
        },
    )
    .unwrap();
    if with_style {
        tree.set_switch_style(style()).unwrap();
    }
    let root = tree.root();
    tree.append(root, Kind::TitleBar, "Title").unwrap();
    let scroll = tree.append(root, Kind::Scroll, "Content").unwrap();
    let group = tree.group(scroll, "Switches").unwrap();
    let (_, off) = tree
        .row(group, "Off", Kind::Switch { checked: false })
        .unwrap();
    let (_, on) = tree
        .row(group, "On", Kind::Switch { checked: true })
        .unwrap();
    let (_, disabled) = tree
        .row(group, "Disabled", Kind::Switch { checked: true })
        .unwrap();
    tree.set_disabled(disabled, true).unwrap();
    Fixture {
        tree,
        text,
        off,
        on,
        disabled,
    }
}

fn paint(f: &mut Fixture) -> Result<Vec<u8>, String> {
    f.tree.layout(
        Size {
            width: 600.,
            height: 400.,
        },
        true,
        &mut f.text,
    )?;
    let c = |v| opaque((v, v, v));
    let palette = Palette {
        background: c(20),
        surface: opaque(SURFACE),
        text: c(255),
        disabled: c(120),
        selected: c(60),
        accent: c(1),
        track: c(2),
        thumb: c(3),
        focus: c(4),
        separator: c(90),
    };
    let frame = nk_wayland::Frame {
        width: 600,
        height: 400,
        pixel_width: 600,
        pixel_height: 400,
        scale: 1.,
        material: false,
    };
    f.tree.paint(frame, Surface::Content, palette)
}

fn pixel(pixels: &[u8], x: f32, y: f32) -> (u8, u8, u8) {
    let at = ((y as u32 * 600 + x as u32) * 4) as usize;
    (pixels[at + 2], pixels[at + 1], pixels[at])
}

fn close(a: (u8, u8, u8), b: (u8, u8, u8)) -> bool {
    [(a.0, b.0), (a.1, b.1), (a.2, b.2)]
        .iter()
        .all(|(x, y)| x.abs_diff(*y) <= 3)
}

#[test]
fn the_switch_paints_its_exported_look() {
    let mut f = fixture(true);
    let px = paint(&mut f).unwrap();
    let b = |id: u64| f.tree.node(id).unwrap().bounds();
    for (id, fill, thumb_left) in [(f.off, TRACK, true), (f.on, CHECKED, false)] {
        let r = b(id);
        assert_eq!((r.width, r.height), (44., 24.));
        let mid = r.y + r.height / 2.;
        // The thumb is 3 px in from its end; the track shows at the other end.
        let (thumb_x, track_x) = if thumb_left {
            (r.x + 3. + 9., r.x + r.width - 6.)
        } else {
            (r.x + r.width - 3. - 9., r.x + 6.)
        };
        assert!(close(pixel(&px, thumb_x, mid), THUMB), "thumb of {id}");
        assert!(close(pixel(&px, track_x, mid), fill), "track of {id}");
        // The 1 px edge, at the middle of the top side.
        assert!(
            close(pixel(&px, r.x + r.width / 2., r.y), EDGE),
            "edge of {id}"
        );
    }
    // Disabled: the whole switch at 0.45 over what is behind it (the group's surface).
    let r = b(f.disabled);
    let faded = |c: u8, under: u8| (c as f32 * 0.45 + under as f32 * 0.55).round() as u8;
    let want = (
        faded(CHECKED.0, SURFACE.0),
        faded(CHECKED.1, SURFACE.1),
        faded(CHECKED.2, SURFACE.2),
    );
    let got = pixel(&px, r.x + 6., r.y + r.height / 2.);
    assert!(close(got, want), "disabled track {got:?}, want {want:?}");
}

#[test]
fn a_switch_without_its_style_is_an_error() {
    let mut f = fixture(false);
    assert!(paint(&mut f).unwrap_err().contains("switch style"));
    let mut bad = style();
    bad.disabled_opacity = 1.5;
    assert!(f.tree.set_switch_style(bad).is_err());
    let mut bad = style();
    bad.thumb_margin = 12.;
    assert!(f.tree.set_switch_style(bad).is_err());
}
