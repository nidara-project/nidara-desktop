// SPDX-License-Identifier: LGPL-3.0-or-later
//! Radio groups (#882), with no compositor: one choice kept, the arrows, one Tab stop, the
//! AT-SPI shape, and their pixels.
use nk_a11y::{Relation, Role};
use nk_render::{Color, rgba};
use nk_text::{FontSet, ParleyBackend, Size, TextStyle};
use nk_widgets::{ChoiceKind, ChoiceStyle, Effect, Kind, Metrics, Palette, Surface, Tree};
use std::sync::Arc;

const ACCENT: (u8, u8, u8) = (0, 100, 255);
const BLUE: (u8, u8, u8) = (10, 132, 255);
fn style() -> ChoiceStyle {
    ChoiceStyle {
        segment_padding_x: 14.,
        segment_padding_y: 5.,
        segment_border: 1.,
        segment_text_scale: 0.93,
        segment_border_color: rgba(90, 90, 90, 255),
        segment_selected: rgba(ACCENT.0, ACCENT.1, ACCENT.2, 255),
        segment_selected_text: rgba(255, 255, 255, 255),
        swatch_diameter: 30.,
        swatch_border: 3.,
        swatch_ring: 2.,
        swatch_gap: 8.,
        swatch_selected: rgba(240, 240, 240, 255),
        swatch_hover: rgba(160, 160, 160, 255),
    }
}
struct Fixture {
    tree: Tree,
    text: ParleyBackend,
    segmented: (u64, Vec<u64>),
    swatches: (u64, Vec<u64>),
    after: u64,
}
fn fixture(with_style: bool) -> Fixture {
    let text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    let mut tree = Tree::new(
        "Window",
        Metrics {
            sidebar: 120.,
            content: 480.,
            form_width: 480.,
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
        tree.set_choice_style(style()).unwrap();
    }
    // The row after the group is a switch: it paints with its own style.
    let grey = |v| nk_render::rgba(v, v, v, 255);
    tree.set_switch_style(nk_widgets::SwitchStyle {
        border: 1.,
        border_color: grey(90),
        checked_border_color: grey(0),
        track: grey(40),
        checked: grey(200),
        thumb: grey(255),
        thumb_margin: 3.,
        disabled_opacity: 0.45,
    })
    .unwrap();
    let root = tree.root();
    tree.append(root, Kind::TitleBar, "Title").unwrap();
    let scroll = tree.append(root, Kind::Scroll, "Content").unwrap();
    let group = tree.group(scroll, "Appearance").unwrap();
    let (_, seg, seg_ids) = tree
        .choices(
            group,
            "Window controls",
            ChoiceKind::Segmented,
            &["Left", "Right", "Hidden"],
            1,
        )
        .unwrap();
    let (_, sw, sw_ids) = tree
        .choices(
            group,
            "Accent colour",
            ChoiceKind::Swatch,
            &["Blue", "Green", "Pink"],
            0,
        )
        .unwrap();
    for (id, c) in sw_ids.iter().zip([BLUE, (40, 200, 80), (255, 60, 150)]) {
        tree.set_swatch(*id, rgba(c.0, c.1, c.2, 255)).unwrap();
    }
    let (_, after) = tree
        .row(group, "After", Kind::Switch { checked: false })
        .unwrap();
    Fixture {
        tree,
        text,
        segmented: (seg, seg_ids),
        swatches: (sw, sw_ids),
        after,
    }
}
fn layout(f: &mut Fixture) {
    f.tree
        .layout(
            Size {
                width: 600.,
                height: 400.,
            },
            true,
            &mut f.text,
        )
        .unwrap();
}
fn chosen(t: &Tree, ids: &[u64]) -> Vec<u64> {
    let s = t.semantics();
    ids.iter()
        .copied()
        .filter(|id| s.nodes[id].states.checked)
        .collect()
}
const LEFT: u32 = 0xff51;
const RIGHT: u32 = 0xff53;
const DOWN: u32 = 0xff54;
const HOME: u32 = 0xff50;
const END: u32 = 0xff57;

#[test]
fn a_group_is_measured_only_with_its_exported_style() {
    let mut f = fixture(false);
    let err = f
        .tree
        .layout(
            Size {
                width: 600.,
                height: 400.,
            },
            true,
            &mut f.text,
        )
        .unwrap_err();
    assert!(err.contains("choice style"), "{err}");
    let mut bad = style();
    bad.swatch_diameter = 4.;
    assert!(f.tree.set_choice_style(bad).is_err());
}

#[test]
fn the_arrows_move_the_choice_and_wrap_and_one_option_is_always_chosen() {
    let mut f = fixture(true);
    layout(&mut f);
    let ids = f.segmented.1.clone();
    f.tree.focus(ids[1]).unwrap();
    assert_eq!(
        f.tree.control_key(RIGHT).unwrap(),
        Some(Effect::Activated(ids[2]))
    );
    assert_eq!(
        (f.tree.focused(), chosen(&f.tree, &ids)),
        (Some(ids[2]), vec![ids[2]])
    );
    // Past the end it wraps; Down is Right, Up is Left.
    f.tree.control_key(DOWN).unwrap();
    assert_eq!(chosen(&f.tree, &ids), vec![ids[0]]);
    f.tree.control_key(LEFT).unwrap();
    assert_eq!(chosen(&f.tree, &ids), vec![ids[2]]);
    f.tree.control_key(HOME).unwrap();
    assert_eq!(chosen(&f.tree, &ids), vec![ids[0]]);
    f.tree.control_key(END).unwrap();
    assert_eq!(
        (f.tree.focused(), chosen(&f.tree, &ids)),
        (Some(ids[2]), vec![ids[2]])
    );
    // A disabled option is passed over.
    f.tree.set_disabled(ids[0], true).unwrap();
    f.tree.control_key(RIGHT).unwrap();
    assert_eq!(chosen(&f.tree, &ids), vec![ids[1]]);
    // A key that is not the group's is not taken.
    assert_eq!(f.tree.control_key(0x61).unwrap(), None);
    // Nor any key on another control.
    f.tree.focus(f.after).unwrap();
    assert_eq!(f.tree.control_key(RIGHT).unwrap(), None);
}

#[test]
fn tab_stops_once_per_group_on_its_chosen_option() {
    let mut f = fixture(true);
    layout(&mut f);
    let order = f.tree.focus_order();
    let (seg, sw) = (&f.segmented.1, &f.swatches.1);
    assert_eq!(
        order
            .iter()
            .filter(|id| seg.contains(id) || sw.contains(id))
            .copied()
            .collect::<Vec<_>>(),
        vec![seg[1], sw[0]]
    );
    f.tree.set_choice(sw[2]).unwrap();
    assert!(f.tree.focus_order().contains(&sw[2]) && !f.tree.focus_order().contains(&sw[0]));
}

#[test]
fn a_click_chooses_and_the_model_can_choose_without_activating() {
    let mut f = fixture(true);
    layout(&mut f);
    let ids = f.swatches.1.clone();
    let p = f.tree.node(ids[1]).unwrap().bounds().center();
    f.tree.pointer_press(p).unwrap();
    assert_eq!(
        f.tree.pointer_release(p).unwrap(),
        Effect::Activated(ids[1])
    );
    assert_eq!(chosen(&f.tree, &ids), vec![ids[1]]);
    f.tree.set_choice(ids[0]).unwrap();
    assert_eq!(chosen(&f.tree, &ids), vec![ids[0]]);
}

#[test]
fn a_group_is_a_panel_named_by_its_row_and_its_options_are_radio_buttons() {
    let mut f = fixture(true);
    layout(&mut f);
    let s = f.tree.semantics();
    s.validate().unwrap();
    for (group, ids, name) in [
        (f.segmented.0, &f.segmented.1, "Window controls"),
        (f.swatches.0, &f.swatches.1, "Accent colour"),
    ] {
        let g = &s.nodes[&group];
        assert_eq!((g.role, g.name.as_str()), (Role::Panel, name));
        let label = g
            .relations
            .iter()
            .find_map(|r| match r {
                Relation::LabelledBy(l) => Some(*l),
                _ => None,
            })
            .unwrap();
        assert_eq!(s.nodes[&label].name, name);
        assert_eq!(g.children, *ids);
        for id in ids {
            assert_eq!(s.nodes[id].role, Role::RadioButton);
        }
        assert_eq!(
            ids.iter().filter(|id| s.nodes[id].states.checked).count(),
            1
        );
    }
    assert_eq!(s.nodes[&f.swatches.1[0]].name, "Blue");
}

#[test]
fn segments_sit_side_by_side_and_samples_keep_their_gap() {
    let mut f = fixture(true);
    layout(&mut f);
    let b = |id: u64| f.tree.node(id).unwrap().bounds();
    let seg = &f.segmented.1;
    assert!((b(seg[0]).x + b(seg[0]).width - b(seg[1]).x).abs() < 0.01);
    assert!(b(seg[0]).width > 2. * style().segment_padding_x);
    let sw = &f.swatches.1;
    let side = style().swatch_diameter + 2. * style().swatch_ring;
    assert_eq!((b(sw[0]).width, b(sw[0]).height), (side, side));
    assert!((b(sw[1]).x - b(sw[0]).x - side - style().swatch_gap).abs() < 0.01);
    // The group sits at the row's trailing edge, beside its label.
    let group = b(f.swatches.0);
    assert!((group.x + group.width - (b(sw[2]).x + b(sw[2]).width)).abs() < 0.01);
}

fn pixel(pixels: &[u8], width: u32, x: f32, y: f32) -> (u8, u8, u8) {
    let at = ((y as u32 * width + x as u32) * 4) as usize;
    (pixels[at + 2], pixels[at + 1], pixels[at])
}
fn close(a: (u8, u8, u8), b: (u8, u8, u8)) -> bool {
    [(a.0, b.0), (a.1, b.1), (a.2, b.2)]
        .iter()
        .all(|(x, y)| x.abs_diff(*y) <= 3)
}
#[test]
fn the_chosen_segment_is_the_accent_and_a_sample_shows_its_colour() {
    let mut f = fixture(true);
    layout(&mut f);
    let opaque = |c: (u8, u8, u8)| -> Color { rgba(c.0, c.1, c.2, 255) };
    let palette = Palette {
        background: opaque((20, 20, 20)),
        surface: opaque((50, 50, 50)),
        text: opaque((255, 255, 255)),
        disabled: opaque((120, 120, 120)),
        selected: opaque((30, 50, 70)),
        accent: opaque(ACCENT),
        track: opaque((40, 40, 40)),
        thumb: opaque((255, 255, 255)),
        focus: opaque(ACCENT),
        separator: opaque((90, 90, 90)),
    };
    let frame = nk_wayland::Frame {
        width: 600,
        height: 400,
        pixel_width: 600,
        pixel_height: 400,
        scale: 1.,
        material: false,
    };
    let pixels = f.tree.paint(frame, Surface::Content, palette).unwrap();
    let b = |id: u64| f.tree.node(id).unwrap().bounds();
    // Inside the chosen segment, clear of its text: the accent; the others: the surface.
    let chosen = b(f.segmented.1[1]);
    assert!(close(
        pixel(&pixels, 600, chosen.x + 3., chosen.y + chosen.height / 2.),
        ACCENT
    ));
    let other = b(f.segmented.1[0]);
    assert!(close(
        pixel(&pixels, 600, other.x + 3., other.y + other.height / 2.),
        (50, 50, 50)
    ));
    // A sample's centre is its colour.
    let blue = b(f.swatches.1[0]).center();
    assert!(close(pixel(&pixels, 600, blue.x, blue.y), BLUE));
    // The keyboard's ring on the chosen segment shows: OUTSIDE it, where it is not the accent
    // segment it surrounds (focus colour = the accent here, as in the export).
    f.tree.tab(false).unwrap();
    assert_eq!(f.tree.focused(), Some(f.segmented.1[1]));
    let pixels = f.tree.paint(frame, Surface::Content, palette).unwrap();
    let fw = 2.; // the fixture's focus_width
    let above = (chosen.x + chosen.width / 2., chosen.y - 1.5 * fw);
    assert!(
        close(pixel(&pixels, 600, above.0, above.1), ACCENT),
        "no ring outside the chosen segment: {:?}",
        pixel(&pixels, 600, above.0, above.1)
    );
}
