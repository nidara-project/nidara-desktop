// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
use crate::components::{Disclosure, EditableField, Search};
use crate::tests::{backend, tokens, types};
use crate::{Corner, Node, Padding, Radius, Shown, Space, Type, Weight, view::Slider};
fn cases() -> Vec<(&'static str, Node, &'static str)> {
    let style = types().style(Type::Body, Weight::Regular);
    vec![
        (
            "button",
            Node::button("c", "Button", "noop", style.clone()),
            "c",
        ),
        (
            "surface",
            Node::control("c", "Capsule", "noop", Node::spacer("body").height(32.)),
            "c",
        ),
        (
            "switch",
            Node::switch_control("c", "Switch", "noop", true),
            "c",
        ),
        (
            "check",
            Node::check_control("c", "Check", "noop", true),
            "c",
        ),
        (
            "radio",
            Node::radio_control("c", "Radio", "noop", true),
            "c",
        ),
        (
            "dropdown",
            Node::dropdown(
                "c",
                crate::view::Dropdown {
                    options: vec!["One".into()],
                    chosen: 0,
                    disabled: false,
                    action: "noop".into(),
                    name: "Dropdown".into(),
                },
            ),
            "c",
        ),
        (
            "segment",
            Node::segmented(
                "c",
                crate::view::Segmented {
                    options: vec!["A".into(), "B".into(), "C".into()],
                    chosen: 0,
                    disabled: false,
                    action: "noop".into(),
                    name: "Segment".into(),
                },
            )
            .sample_state(1, Shown::Focus),
            "c/1",
        ),
        (
            "swatch",
            Node::swatches(
                "c",
                crate::view::Swatches {
                    colors: vec![("Blue".into(), nk_render::rgba(0, 136, 255, 255))],
                    chosen: 0,
                    disabled: false,
                    action: "noop".into(),
                    name: "Swatch".into(),
                },
            )
            .sample_state(0, Shown::Focus),
            "c/0",
        ),
        (
            "slider",
            Node::slider("c", "Slider", "noop", Slider::new(0., 100., 1., 50.)),
            "c",
        ),
        (
            "display",
            Node::field(
                "c",
                "Display",
                "noop",
                crate::view::Field {
                    shown: "Text".into(),
                    caret: 0,
                    anchor: 0,
                    secret: false,
                },
                style,
            ),
            "c",
        ),
        (
            "disclosure",
            Disclosure {
                label: "Disclosure".into(),
                expanded: false,
            }
            .header("c", "noop"),
            "c",
        ),
        (
            "editable",
            EditableField::new("Text").node("c", "Editable", "noop"),
            "c",
        ),
        (
            "search",
            Search {
                field: EditableField::new("Text"),
                name: "Search".into(),
                changed: "noop".into(),
                clear_label: "Clear".into(),
                disabled: false,
                shown: None,
            }
            .node("c")
            .sample_state(0, Shown::Focus),
            "c/input",
        ),
        (
            "selected-list",
            crate::components::LongList::new(3, 1, 32.)
                .node("c", "List", "noop", Some((0., 96.)), &Records)
                .height(96.),
            "c",
        ),
        (
            "search-clear",
            Search {
                field: EditableField::new("Text"),
                name: "Search clear".into(),
                changed: "noop".into(),
                clear_label: "Clear".into(),
                disabled: false,
                shown: None,
            }
            .node("c")
            .sample_state(1, Shown::Focus),
            "c/clear",
        ),
        (
            "empty-list",
            crate::components::LongList::new(0, 0, 32.)
                .node("c", "List", "noop", None, &Empty)
                .height(40.),
            "c",
        ),
    ]
}
struct Records;
impl crate::ListSource for Records {
    fn item(&self, index: usize) -> crate::RowInfo {
        crate::RowInfo {
            key: format!("row{index}").into(),
            name: format!("Row {index}"),
        }
    }
    fn build(&self, _: usize, key: &crate::Key) -> Node {
        Node::spacer(key.clone()).height(32.)
    }
}
struct Empty;
impl crate::ListSource for Empty {
    fn item(&self, _: usize) -> crate::RowInfo {
        unreachable!()
    }
    fn build(&self, _: usize, _: &crate::Key) -> Node {
        unreachable!()
    }
}
fn scene(node: Node, scale: f64) -> ViewState {
    let t = tokens();
    let ts = types();
    let mut s = ViewState::new(1000);
    let tree = Node::column("root", vec![node]).padding(Padding::all(Space::S4));
    s.layout(
        &tree,
        (240., 140.),
        scale,
        t.with_types(&ts),
        &mut backend(),
        Instant::now(),
    );
    s
}
fn pixels(s: &ViewState, scale: f64) -> Vec<u8> {
    let t = tokens();
    let ts = types();
    let mut c = Canvas::new((240. * scale) as u16, (140. * scale) as u16, scale);
    s.paint_focus(&mut c, t.with_types(&ts), &|_| true);
    c.finish()
}
#[test]
fn every_component_ring_moves_with_its_geometry_at_both_scales() {
    for scale in [1., 1.25] {
        for (name, node, key) in cases() {
            let mut s = scene(node, scale);
            s.request(&key.into(), false);
            assert_eq!(s.focus(), Some(&key.into()), "{name}");
            let before = pixels(&s, scale);
            assert!(before.iter().any(|v| *v != 0), "{name}");
            // Per-component geometry mutation includes marks, composite chrome and clips.
            for p in &mut s.placed {
                p.rect[0] += 8.;
                p.rect[1] += 8.;
                if let Some(c) = &mut p.clip {
                    c[0] += 8.;
                    c[1] += 8.;
                }
            }
            let after = pixels(&s, scale);
            let w = (240. * scale) as usize;
            let h = (140. * scale) as usize;
            let d = (8. * scale) as usize;
            for y in 0..h - d {
                for x in 0..w - d {
                    let a = (y * w + x) * 4;
                    let b = ((y + d) * w + x + d) * 4;
                    assert!(
                        before[a..a + 4]
                            .iter()
                            .zip(&after[b..b + 4])
                            .all(|(a, b)| a.abs_diff(*b) <= 1),
                        "{name}/{scale}/{x}/{y}"
                    );
                }
            }
        }
    }
}
#[test]
fn width_gap_and_reader_focus_are_independent() {
    let mut s = scene(
        Node::control("c", "Capsule", "noop", Node::spacer("body").height(32.))
            .corner(Corner::Fixed(0)),
        1.,
    );
    s.request(&"c".into(), false);
    let i = s.index(&"c".into()).unwrap();
    let r = s.placed[i].rect;
    let px = pixels(&s, 1.);
    let x = (r[0] + r[2] / 2.) as usize;
    let y = r[1] as usize;
    let alpha = |y| px[(y * 240 + x) * 4 + 3];
    assert_eq!(
        (
            alpha(y - 4),
            alpha(y - 3),
            alpha(y - 2),
            alpha(y - 1),
            alpha(y)
        ),
        (255, 255, 0, 0, 0)
    );
    let tree = s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Window, "Focus"), 2);
    assert!(
        tree.nodes
            .values()
            .any(|n| n.name == "Capsule" && n.states.focused)
    );
    s.hide_ring();
    assert!(pixels(&s, 1.).iter().all(|v| *v == 0));
    assert_eq!(s.focus(), Some(&"c".into()));
}
#[test]
fn disabled_and_menu_controls_have_no_extra_ring() {
    let mut menu = Node::control("c", "Option", "noop", Node::spacer("body").height(32.));
    if let crate::Kind::Control(c) = &mut menu.kind {
        c.part = Some(Box::new(crate::Part::MenuRow(crate::components::MenuRow {
            label: "Option".into(),
            selected: false,
        })));
    }
    for node in [
        menu.shown(Shown::Focus),
        Node::check_control("c", "Check", "noop", true)
            .enabled(false)
            .shown(Shown::Focus),
    ] {
        assert!(pixels(&scene(node, 1.), 1.).iter().all(|v| *v == 0));
    }
}
#[test]
fn shapes_match_marks_joins_and_search_chrome() {
    let t = tokens();
    let ts = types();
    for (name, node, key) in cases() {
        let s = scene(node, 1.);
        let i = s.index(&key.into()).unwrap();
        let p = &s.placed[i];
        let shape = p
            .part()
            .unwrap()
            .component()
            .focus_outline(&Read {
                look: t.with_types(&ts),
                ..s.context(i)
            })
            .unwrap();
        match name {
            "segment" => assert_eq!(shape.corners, [0.; 4]),
            "check" => {
                assert_eq!(shape.bounds[2], t.check.size);
                assert_eq!(shape.corners, [t.check.radius; 4]);
            }
            "radio" => assert_eq!(shape.corners, [shape.bounds[2] / 2.; 4]),
            "switch" => assert_eq!(
                (shape.bounds[2], shape.bounds[3]),
                (t.switch.width, t.switch.height)
            ),
            "search" => assert_eq!(shape.bounds, s.rect(&"c".into()).unwrap()),
            "editable" => assert_eq!(shape.corners, [t.entry.radius.min(shape.bounds[3] / 2.); 4]),
            // The corner of an activatable list row, as its hover (#1156, owner 16-11).
            "disclosure" => assert_eq!(shape.corners, [t.radii.px(Radius::Sm); 4]),
            "empty-list" => assert_eq!(
                shape.clip, None,
                "the empty ring must not be clipped to its inside"
            ),
            "selected-list" => assert!(shape.clip.is_some()),
            _ => {}
        }
    }
}
#[test]
fn focus_tokens_are_shared_and_private_painters_stay_removed() {
    let record =
        serde_json::from_str::<serde_json::Value>(include_str!("../../../tokens/focus.json"))
            .unwrap()["default"]
            .clone();
    let set = serde_json::json!({"tokens":{"--nidara-accent":"#0088ff"}});
    let style = crate::focus_from(&record, &set).unwrap();
    assert_eq!((style.width, style.gap), (2., 2.));
    for (key, bad) in [
        ("width", serde_json::json!(0)),
        ("gap", serde_json::json!(-1)),
        ("color", serde_json::json!("missing")),
    ] {
        let mut v = record.clone();
        v[key] = bad;
        assert!(crate::focus_from(&v, &set).is_err());
    }
    for raw in [
        include_str!("../../../tokens/button.json"),
        include_str!("../../../tokens/choices.json"),
        include_str!("../../../tokens/dropdown.json"),
        include_str!("../../../tokens/search.json"),
    ] {
        assert!(!raw.contains("\"focus\""));
        assert!(!raw.contains("\"focusBorder\""));
    }
    for source in [
        include_str!("components/button.rs"),
        include_str!("components/surface.rs"),
        include_str!("components/segment.rs"),
        include_str!("components/swatch.rs"),
        include_str!("components/disclosure.rs"),
        include_str!("components/dropdown.rs"),
        include_str!("components/long_list.rs"),
        include_str!("components/editable.rs"),
        include_str!("components/search.rs"),
        include_str!("components/slider.rs"),
        include_str!("components/field.rs"),
        include_str!("components/check.rs"),
        include_str!("components/switch.rs"),
    ] {
        if let Some((_, tail)) = source.split_once("fn paint(") {
            let body = &tail[tail.find('{').unwrap() + 1..];
            let mut depth = 1;
            let mut end = 0;
            for (i, c) in body.char_indices() {
                depth += i32::from(c == '{') - i32::from(c == '}');
                if depth == 0 {
                    end = i;
                    break;
                }
            }
            let body = &body[..end];
            assert!(
                !(body.contains("focus_ring") && body.contains("rounded_ring")),
                "private focus painter"
            );
        }
        assert!(!source.contains("tokens.focus"));
        assert!(!source.contains("focus_width"));
        assert!(!source.contains("look.focus"));
        assert!(!source.contains("if cx.interaction.focus_ring {"));
    }
}

#[test]
fn ancestor_clipping_cuts_the_true_outline_without_creating_a_new_edge() {
    for (name, node, key) in cases() {
        let mut s = scene(node, 1.);
        s.request(&key.into(), false);
        let before = pixels(&s, 1.);
        let i = s.index(&key.into()).unwrap();
        s.placed[i].clip = Some([0., 28., 240., 48.]);
        let after = pixels(&s, 1.);
        for y in 0..140 {
            for x in 0..240 {
                let at = (y * 240 + x) * 4;
                let expected = if (28..76).contains(&y) {
                    &before[at..at + 4]
                } else {
                    &[0u8; 4]
                };
                assert_eq!(expected, &after[at..at + 4], "{name}/{x}/{y}");
            }
        }
    }
}

#[test]
fn keyboard_and_reader_scroll_reveal_the_external_ring_not_only_the_input_box() {
    for scale in [1., 1.25] {
        for (name, node, key) in cases() {
            let tree = Node::scroll(
                "scroll",
                Node::column(
                    "rows",
                    vec![
                        Node::spacer("before").height(150.),
                        node,
                        Node::spacer("after").height(100.),
                    ],
                )
                .padding(Padding::all(Space::S4)),
            )
            .width(220.)
            .height(64.);
            let t = tokens();
            let ts = types();
            let mut s = ViewState::new(1000);
            let mut text = backend();
            s.layout(
                &tree,
                (240., 140.),
                scale,
                t.with_types(&ts),
                &mut text,
                Instant::now(),
            );
            s.request(&key.into(), false);
            s.layout(
                &tree,
                (240., 140.),
                scale,
                t.with_types(&ts),
                &mut text,
                Instant::now(),
            );
            let i = s.index(&key.into()).unwrap();
            let p = &s.placed[i];
            let outline = p
                .part()
                .unwrap()
                .component()
                .focus_outline(&Read {
                    look: t.with_types(&ts),
                    ..s.context(i)
                })
                .unwrap();
            let outside = t.focus.outside(outline.bounds);
            let viewport = s.rect(&"scroll".into()).unwrap();
            assert!(
                outside[1] >= viewport[1] && outside[1] + outside[3] <= viewport[1] + viewport[3],
                "{name}/{scale}: {outside:?} in {viewport:?}"
            );
            assert!(
                s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Window, "Focus"), 2)
                    .nodes
                    .values()
                    .any(|n| n.states.focused)
            );
        }
    }
}

#[test]
fn clear_uses_the_existing_navigation_icon_pattern_and_ring_fits_inside_search() {
    let t = tokens();
    let ts = types();
    let node = Search {
        field: EditableField::new("Text"),
        name: "Search".into(),
        changed: "noop".into(),
        clear_label: "Clear".into(),
        disabled: false,
        shown: None,
    }
    .node("c")
    .width(240.);
    for scale in [1., 1.25] {
        let s = scene(node.clone(), scale);
        let i = s.index(&"c/clear".into()).unwrap();
        let p = &s.placed[i];
        let shape = p
            .part()
            .unwrap()
            .component()
            .focus_outline(&Read {
                look: t.with_types(&ts),
                ..s.context(i)
            })
            .unwrap();
        assert_eq!((shape.bounds[2], shape.bounds[3]), (24., 24.));
        assert!(
            (p.rect[3] - (30. * scale).ceil() / scale).abs() < 1e-8,
            "existing hit area preserved on the device grid"
        );
        let outer = t.focus.outside(shape.bounds);
        let field = s.rect(&"c".into()).unwrap();
        assert!(
            outer[0] >= field[0]
                && outer[1] >= field[1]
                && outer[0] + outer[2] <= field[0] + field[2]
                && outer[1] + outer[3] <= field[1] + field[3]
        );
        let edge = shape.bounds[1] - field[1];
        assert!(edge >= t.entry.clear_edge && edge < t.entry.clear_edge + 1. / scale);
    }
}

#[test]
fn frameless_field_focus_uses_the_entry_box_and_never_crosses_text_or_caret() {
    let t = tokens();
    let ts = types();
    for scale in [1., 1.25] {
        let (_, node, key) = cases()
            .into_iter()
            .find(|(name, _, _)| *name == "display")
            .unwrap();
        let mut s = scene(node, scale);
        let before = s.rect(&key.into()).unwrap();
        s.request(&key.into(), false);
        assert_eq!(s.rect(&key.into()), Some(before));
        let i = s.index(&key.into()).unwrap();
        let cx = Read {
            look: t.with_types(&ts),
            ..s.context(i)
        };
        let part = s.placed[i].part().unwrap().component();
        let outline = part.focus_outline(&cx).unwrap();
        let (text, _) = cx.text("text").unwrap();
        assert!(outline.bounds[2] >= text.rect[2] + 2. * (t.entry.padding_x + t.entry.border));
        assert!(outline.bounds[3] >= t.entry.min_height);
        let caret = part.caret(&cx).unwrap();
        let pixels = pixels(&s, scale);
        for area in [text.rect, caret] {
            for y in
                (area[1] * scale).floor() as usize..((area[1] + area[3]) * scale).ceil() as usize
            {
                for x in (area[0] * scale).floor() as usize
                    ..((area[0] + area[2]) * scale).ceil() as usize
                {
                    assert_eq!(
                        pixels[(y * (240. * scale) as usize + x) * 4 + 3],
                        0,
                        "ring intersects text/caret at scale {scale}"
                    );
                }
            }
        }
    }
}
