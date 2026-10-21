// SPDX-License-Identifier: LGPL-3.0-or-later
//! Range controls (#882), with no compositor: the value clamped and stepped from every source,
//! the keys, the pointer, the spoken value, and the pixels.
use nk_a11y::{Action, Relation, Role};
use nk_render::rgba;
use nk_text::{FontSet, ParleyBackend, Point, Size, TextStyle};
use nk_widgets::{Effect, Kind, Metrics, Palette, RangeStyle, Surface, Tree, ValueRange};
use std::sync::Arc;

fn style() -> RangeStyle {
    RangeStyle {
        slider_width: 140.,
        slider_track: 6.,
        slider_thumb_radius: 9.,
        slider_value_gap: 12.,
        slider_fill_opacity: 0.9,
        slider_page_steps: 10.,
        spin_height: 32.,
        spin_text_width: 28.,
        spin_button_width: 18.,
        spin_border: 1.,
        spin_border_color: rgba(90, 90, 90, 255),
        spin_gap: 4.,
    }
}
fn kelvin() -> ValueRange {
    ValueRange {
        min: 1000.,
        max: 6500.,
        step: 100.,
        wrap: false,
        digits: 0,
        decimals: 0,
        unit: " K".into(),
    }
}
fn clock(max: f32) -> ValueRange {
    ValueRange {
        min: 0.,
        max,
        step: 1.,
        wrap: true,
        digits: 2,
        decimals: 0,
        unit: String::new(),
    }
}
struct Fixture {
    tree: Tree,
    text: ParleyBackend,
    slider: u64,
    fields: u64,
    spins: Vec<u64>,
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
        tree.set_range_style(style()).unwrap();
    }
    let root = tree.root();
    tree.append(root, Kind::TitleBar, "Title").unwrap();
    let scroll = tree.append(root, Kind::Scroll, "Content").unwrap();
    let group = tree.group(scroll, "Night light").unwrap();
    let (_, slider) = tree.slider(group, "Temperature", kelvin(), 4500.).unwrap();
    let (_, fields, spins) = tree
        .fields(
            group,
            "From",
            vec![
                ("From hour", clock(23.), 22.),
                ("From minute", clock(59.), 5.),
            ],
        )
        .unwrap();
    Fixture {
        tree,
        text,
        slider,
        fields,
        spins,
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
const LEFT: u32 = 0xff51;
const UP: u32 = 0xff52;
const RIGHT: u32 = 0xff53;
const DOWN: u32 = 0xff54;
const PAGE_UP: u32 = 0xff55;
const PAGE_DOWN: u32 = 0xff56;
const HOME: u32 = 0xff50;
const END: u32 = 0xff57;

#[test]
fn a_range_is_measured_only_with_its_exported_style_and_refuses_a_bad_range() {
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
    assert!(err.contains("range style"), "{err}");
    let mut bad = kelvin();
    bad.step = 0.;
    let scroll = f.tree.node(f.tree.root()).unwrap().children()[1];
    let g = f.tree.group(scroll, "Bad").unwrap();
    assert!(f.tree.slider(g, "Bad", bad, 1.).is_err());
}

#[test]
fn every_source_of_a_value_is_clamped_and_stepped() {
    let mut f = fixture(true);
    layout(&mut f);
    let s = f.slider;
    assert_eq!(f.tree.value(s), Some(4500.));
    // The model.
    assert!(
        !f.tree.set_value(s, 4549.).unwrap(),
        "4549 steps back to 4500: no change"
    );
    assert_eq!(f.tree.value(s), Some(4500.));
    f.tree.set_value(s, 4551.).unwrap();
    assert_eq!(f.tree.value(s), Some(4600.));
    f.tree.set_value(s, 99999.).unwrap();
    assert_eq!(f.tree.value(s), Some(6500.));
    assert!(f.tree.set_value(s, f32::NAN).is_err());
    // An assistive technology, like a key: on this generation only.
    let target = f.tree.target(s);
    assert_eq!(
        f.tree.request_value(target, 1234.).unwrap(),
        Effect::Changed(s)
    );
    assert_eq!(f.tree.value(s), Some(1200.));
    assert_eq!(f.tree.request_value(target, 1200.).unwrap(), Effect::None);
    f.tree.set_disabled(s, true).unwrap();
    assert!(f.tree.request_value(f.tree.target(s), 3000.).is_err());
}

#[test]
fn the_slider_keys_step_page_and_reach_its_ends_without_wrapping() {
    let mut f = fixture(true);
    layout(&mut f);
    let s = f.slider;
    f.tree.focus(s).unwrap();
    let mut key = |sym| f.tree.control_key(sym).unwrap();
    assert_eq!(key(RIGHT), Some(Effect::Changed(s)));
    assert_eq!(key(UP), Some(Effect::Changed(s)));
    assert_eq!(key(LEFT), Some(Effect::Changed(s)));
    assert_eq!(key(DOWN), Some(Effect::Changed(s)));
    assert_eq!(f.tree.value(s), Some(4500.));
    f.tree.control_key(PAGE_UP).unwrap();
    assert_eq!(f.tree.value(s), Some(5500.));
    f.tree.control_key(PAGE_DOWN).unwrap();
    assert_eq!(f.tree.value(s), Some(4500.));
    f.tree.control_key(END).unwrap();
    assert_eq!(f.tree.value(s), Some(6500.));
    // At its end a slider stays; the key is still taken.
    assert_eq!(f.tree.control_key(RIGHT).unwrap(), Some(Effect::None));
    assert_eq!(f.tree.value(s), Some(6500.));
    f.tree.control_key(HOME).unwrap();
    assert_eq!(f.tree.value(s), Some(1000.));
    assert_eq!(f.tree.control_key(0x61).unwrap(), None);
}

#[test]
fn a_spin_button_steps_with_up_and_down_and_its_clock_wraps() {
    let mut f = fixture(true);
    layout(&mut f);
    let hour = f.spins[0];
    f.tree.focus(hour).unwrap();
    f.tree.control_key(UP).unwrap();
    assert_eq!(f.tree.value(hour), Some(23.));
    f.tree.control_key(UP).unwrap();
    assert_eq!(f.tree.value(hour), Some(0.), "23 + 1 h wraps to 00");
    f.tree.control_key(DOWN).unwrap();
    assert_eq!(f.tree.value(hour), Some(23.));
    // Left and Right are not a spin button's: the field's own caret will want them.
    assert_eq!(f.tree.control_key(LEFT).unwrap(), None);
    // Both fields are Tab stops, in order.
    let order = f.tree.focus_order();
    let at = |id| order.iter().position(|o| *o == id).unwrap();
    assert!(at(f.spins[0]) + 1 == at(f.spins[1]));
}

#[test]
fn a_press_and_a_drag_put_the_slider_under_the_pointer_and_a_click_steps_a_spin() {
    let mut f = fixture(true);
    layout(&mut f);
    let s = f.slider;
    let r = f.tree.node(s).unwrap().bounds();
    let (x0, x1) = (r.x + 9., r.x + 140. - 9.);
    let y = r.y + r.height / 2.;
    f.tree.pointer_press(Point { x: x0, y }).unwrap();
    assert_eq!(
        f.tree.range_drag(Point { x: x0, y }).unwrap(),
        Some(s),
        "a press at the track's start"
    );
    assert_eq!(f.tree.value(s), Some(1000.));
    f.tree.range_drag(Point { x: x1 + 50., y }).unwrap();
    assert_eq!(f.tree.value(s), Some(6500.), "dragged past the end");
    f.tree
        .range_drag(Point {
            x: (x0 + x1) / 2.,
            y,
        })
        .unwrap();
    assert_eq!(
        f.tree.value(s),
        Some(3800.),
        "the middle: 3750 stepped to 3800"
    );
    assert_eq!(
        f.tree.pointer_release(Point { x: x1, y }).unwrap(),
        Effect::None
    );
    assert_eq!(
        f.tree.range_drag(Point { x: x0, y }).unwrap(),
        None,
        "no capture"
    );
    // A spin's plus and minus.
    let minute = f.spins[1];
    let b = f.tree.node(minute).unwrap().bounds();
    let plus = Point {
        x: b.x + b.width - 4.,
        y: b.y + b.height / 2.,
    };
    f.tree.pointer_press(plus).unwrap();
    assert_eq!(
        f.tree.pointer_release(plus).unwrap(),
        Effect::Changed(minute)
    );
    assert_eq!(f.tree.value(minute), Some(6.));
    let minus = Point {
        x: b.x + b.width - 18. - 4.,
        ..plus
    };
    f.tree.pointer_press(minus).unwrap();
    f.tree.pointer_release(minus).unwrap();
    assert_eq!(f.tree.value(minute), Some(5.));
}

#[test]
fn a_slider_says_its_value_and_the_fields_are_a_panel_of_named_spin_buttons() {
    let mut f = fixture(true);
    layout(&mut f);
    let s = f.tree.semantics();
    s.validate().unwrap();
    let slider = &s.nodes[&f.slider];
    assert_eq!(
        (slider.role, slider.name.as_str()),
        (Role::Slider, "Temperature")
    );
    let v = slider.value.as_ref().unwrap();
    assert_eq!(
        (v.min, v.max, v.current, v.step, v.text.as_str()),
        (1000., 6500., 4500., 100., "4500 K")
    );
    assert!(
        slider.actions.contains(&Action::SetValue) && !slider.actions.contains(&Action::Activate)
    );
    let fields = &s.nodes[&f.fields];
    assert_eq!((fields.role, fields.name.as_str()), (Role::Panel, "From"));
    assert!(
        fields
            .relations
            .iter()
            .any(|r| matches!(r, Relation::LabelledBy(_)))
    );
    assert_eq!(fields.children, f.spins);
    let hour = &s.nodes[&f.spins[0]];
    assert_eq!(
        (hour.role, hour.name.as_str()),
        (Role::SpinButton, "From hour")
    );
    assert_eq!(hour.value.as_ref().unwrap().text, "22");
    assert_eq!(s.nodes[&f.spins[1]].value.as_ref().unwrap().text, "05");
}

#[test]
fn a_new_value_keeps_the_row_still_and_the_fill_reaches_the_thumb() {
    let mut f = fixture(true);
    layout(&mut f);
    let before = f.tree.node(f.slider).unwrap().bounds();
    f.tree.set_value(f.slider, 1000.).unwrap();
    layout(&mut f);
    assert_eq!(f.tree.node(f.slider).unwrap().bounds(), before);
    f.tree.set_value(f.slider, 3750.).unwrap();
    layout(&mut f);
    let accent = (0, 100, 255);
    let palette = Palette {
        background: rgba(20, 20, 20, 255),
        surface: rgba(50, 50, 50, 255),
        text: rgba(255, 255, 255, 255),
        disabled: rgba(120, 120, 120, 255),
        selected: rgba(30, 50, 70, 255),
        accent: rgba(accent.0, accent.1, accent.2, 255),
        track: rgba(80, 80, 80, 255),
        thumb: rgba(250, 250, 250, 255),
        focus: rgba(accent.0, accent.1, accent.2, 255),
        separator: rgba(90, 90, 90, 255),
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
    let px = |x: f32, y: f32| {
        let at = ((y as u32 * 600 + x as u32) * 4) as usize;
        (pixels[at + 2], pixels[at + 1], pixels[at])
    };
    let r = f.tree.node(f.slider).unwrap().bounds();
    let y = r.y + r.height / 2.;
    let (x0, x1) = (r.x + 9., r.x + 131.);
    let thumb = x0 + (x1 - x0) * (3800. - 1000.) / 5500.;
    let fill = px(x0 + 10., y);
    let track = px(x1 - 3., y);
    // Before the thumb, the accent at its opacity over the track; after it, the track.
    assert!(fill.2 > 200 && fill.0 < 40, "fill {fill:?}");
    assert!(
        track.0.abs_diff(80) <= 3 && track.2.abs_diff(80) <= 3,
        "track {track:?}"
    );
    let centre = px(thumb, y);
    assert!(centre.0 > 240 && centre.1 > 240, "thumb {centre:?}");
}
