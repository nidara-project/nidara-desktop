// SPDX-License-Identifier: LGPL-3.0-or-later
use nk_a11y::{Relation, Role};
use nk_text::{FontSet, ParleyBackend, Point, Size, TextStyle};
use nk_widgets::{Command, Invalid, Kind, Metrics, Tree};
use std::sync::Arc;
fn fixture() -> (Tree, ParleyBackend, u64, Vec<(u64, u64)>) {
    let backend = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    let mut t = Tree::new(
        "Window",
        Metrics {
            sidebar: 120.,
            content: 400.,
            form_width: 400.,
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
    let grey = |v| nk_render::rgba(v, v, v, 255);
    t.set_switch_style(nk_widgets::SwitchStyle {
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
    let root = t.root();
    let sidebar = t.append(root, Kind::Sidebar, "Pages").unwrap();
    t.append(sidebar, Kind::Page { selected: true }, "Appearance")
        .unwrap();
    t.append(sidebar, Kind::Page { selected: false }, "Other")
        .unwrap();
    t.append(root, Kind::TitleBar, "Title").unwrap();
    let scroll = t.append(root, Kind::Scroll, "Content").unwrap();
    let group = t.group(scroll, "General").unwrap();
    let rows = (0..15)
        .map(|i| {
            t.row(
                group,
                &format!("Row {i}"),
                if i == 0 {
                    Kind::Switch { checked: false }
                } else {
                    Kind::Button
                },
            )
            .unwrap()
        })
        .collect();
    (t, backend, scroll, rows)
}
fn layout(t: &mut Tree, b: &mut ParleyBackend, layered: bool) {
    t.layout(
        Size {
            width: 640.,
            height: 360.,
        },
        layered,
        b,
    )
    .unwrap();
}
#[test]
fn measures_before_placing_and_paints_the_same_retained_layout() {
    let (mut t, mut b, _, rows) = fixture();
    assert_eq!(t.node(rows[0].0).unwrap().bounds().height, 0.);
    layout(&mut t, &mut b, true);
    let row = t.node(rows[0].0).unwrap();
    let label = t.node(row.children()[0]).unwrap();
    let retained = label.text_layout().unwrap();
    assert!(row.measured().height >= retained.measured_size().height);
    assert_eq!(label.bounds().height, retained.measured_size().height);
    let pointer = retained as *const _;
    t.acknowledge();
    t.dispatch(t.target(rows[0].1), Command::Activate).unwrap();
    layout(&mut t, &mut b, true);
    assert_eq!(
        t.node(label_id(&t, rows[0].0))
            .unwrap()
            .text_layout()
            .unwrap() as *const _,
        pointer
    );
}
fn label_id(t: &Tree, row: u64) -> u64 {
    t.node(row).unwrap().children()[0]
}
#[test]
fn invalidation_is_by_kind_and_layout_propagates_to_ancestors() {
    let (mut t, mut b, _, rows) = fixture();
    layout(&mut t, &mut b, true);
    t.acknowledge();
    t.set_active(true);
    assert_eq!(t.invalidation(), Invalid::SEMANTICS);
    t.acknowledge();
    t.dispatch(t.target(rows[0].1), Command::Activate).unwrap();
    assert_eq!(t.invalidation(), Invalid::STATE);
    t.acknowledge();
    t.set_name(label_id(&t, rows[0].0), "long label").unwrap();
    assert!(t.node(t.root()).unwrap().invalidation().layout);
    assert_eq!(t.invalidation(), Invalid::LAYOUT);
}
#[test]
fn tab_wraps_in_both_directions_with_exactly_one_focus() {
    let (mut t, mut b, _, _) = fixture();
    layout(&mut t, &mut b, true);
    let order = t.focus_order();
    for &id in &order {
        t.tab(false).unwrap();
        assert_eq!(t.focused(), Some(id));
        t.semantics().validate().unwrap();
    }
    t.tab(false).unwrap();
    assert_eq!(t.focused(), Some(order[0]));
    t.tab(true).unwrap();
    assert_eq!(t.focused(), order.last().copied());
}
#[test]
fn capture_never_activates_the_release_target_and_unavailable_capture_is_cancelled() {
    let (mut t, mut b, _, rows) = fixture();
    layout(&mut t, &mut b, true);
    let id = rows[0].1;
    let p = t.node(id).unwrap().bounds().center();
    t.pointer_press(p).unwrap();
    assert_eq!(t.captured(), Some(id));
    t.pointer_release(Point { x: 0., y: 0. }).unwrap();
    assert_eq!(t.node(id).unwrap().kind(), Kind::Switch { checked: false });
    assert_eq!(t.captured(), None);
    t.pointer_press(p).unwrap();
    t.set_disabled(id, true).unwrap();
    assert_eq!(t.captured(), None);
    t.pointer_release(p).unwrap();
    assert_eq!(t.node(id).unwrap().kind(), Kind::Switch { checked: false });
}
#[test]
fn hidden_removes_subtree_offscreen_keeps_visible_and_focus_moves_to_next_row() {
    let (mut t, mut b, scroll, rows) = fixture();
    layout(&mut t, &mut b, true);
    t.focus(rows[0].1).unwrap();
    t.set_hidden(rows[0].0, true).unwrap();
    assert_eq!(t.focused(), Some(rows[1].1));
    let semantics = t.semantics();
    assert!(!semantics.nodes.contains_key(&rows[0].1));
    assert!(semantics.nodes[&rows[14].1].states.offscreen);
    assert!(!semantics.nodes[&rows[14].1].states.hidden);
    layout(&mut t, &mut b, true);
    t.focus(rows[14].1).unwrap();
    assert!(t.showing(rows[14].1));
    assert!(t.node(scroll).unwrap().scroll().y > 0.);
    t.semantics().validate().unwrap();
}
#[test]
fn semantics_derive_roles_and_both_directions_of_label_relations() {
    let (mut t, mut b, _, rows) = fixture();
    layout(&mut t, &mut b, true);
    let s = t.semantics();
    s.validate().unwrap();
    assert_eq!(s.nodes[&t.root()].role, Role::Window);
    assert_eq!(s.nodes[&rows[0].1].role, Role::ToggleButton);
    assert_eq!(s.nodes[&rows[1].1].role, Role::Button);
    let label = label_id(&t, rows[0].0);
    assert!(
        s.nodes[&rows[0].1]
            .relations
            .contains(&Relation::LabelledBy(label))
    );
    assert!(
        s.nodes[&label]
            .relations
            .contains(&Relation::LabelFor(rows[0].1))
    );
}
#[test]
fn d7_content_is_full_window_but_both_insets_exclude_showing_and_hit_testing() {
    let (mut t, mut b, scroll, rows) = fixture();
    t.set_min_width(rows[0].0, 1000.).unwrap();
    layout(&mut t, &mut b, true);
    let r = t.node(scroll).unwrap().bounds();
    assert_eq!((r.x, r.y, r.width, r.height), (0., 0., 640., 360.));
    let normal = t.node(rows[1].1).unwrap().bounds();
    assert!(
        normal.x + normal.width <= 640.,
        "one wide row must not force every sibling control offscreen"
    );
    let label = label_id(&t, rows[1].0);
    let before = t.node(label).unwrap().bounds();
    t.scroll_to(scroll, Point { x: 300., y: 0. }).unwrap();
    assert!(t.node(label).unwrap().bounds().x < before.x);
    t.scroll_to(scroll, Point { x: 0., y: 200. }).unwrap();
    assert!(!t.showing(rows[0].1));
    assert!(t.semantics().nodes.contains_key(&rows[0].1));
    t.focus(rows[0].1).unwrap();
    assert!(t.showing(rows[0].1));
    let bounds = t.node(rows[0].1).unwrap().bounds();
    let clip = t.content_viewport();
    assert!(bounds.x >= clip.x && bounds.y >= clip.y);
}
#[test]
fn d5_fallback_reserves_the_same_insets_and_uses_full_sized_root() {
    let (mut t, mut b, scroll, rows) = fixture();
    layout(&mut t, &mut b, true);
    let expected = t.content_viewport();
    let bounds = t.node(rows[0].1).unwrap().bounds();
    layout(&mut t, &mut b, false);
    assert_eq!(t.content_viewport(), expected);
    assert_eq!(t.node(rows[0].1).unwrap().bounds(), bounds);
    assert_eq!(t.node(scroll).unwrap().bounds().width, 640.);
    t.scroll_to(scroll, Point { x: 0., y: 300. }).unwrap();
    assert!(!t.showing(rows[0].1));
}
#[test]
fn changing_fonts_and_scale_keeps_ids_focus_and_scroll_and_remeasures_text() {
    let (mut t, mut b, scroll, rows) = fixture();
    layout(&mut t, &mut b, true);
    t.focus(rows[10].1).unwrap();
    let offset = t.node(scroll).unwrap().scroll();
    let focused = t.focused();
    let ids = t.focus_order();
    let label = label_id(&t, rows[0].0);
    let height = t.node(label).unwrap().measured().height;
    t.set_text_style(TextStyle {
        family: "Noto Sans Hebrew".into(),
        size: 21.,
        ..Default::default()
    });
    assert!(t.invalidation().layout);
    layout(&mut t, &mut b, true);
    assert_eq!(t.focused(), focused);
    assert_eq!(t.focus_order(), ids);
    assert_eq!(t.node(scroll).unwrap().scroll(), offset);
    assert!(t.node(label).unwrap().measured().height > height);
}
#[test]
fn stale_hidden_disabled_and_retired_targets_are_rejected_and_ids_never_reused() {
    let (mut t, mut b, _, rows) = fixture();
    layout(&mut t, &mut b, true);
    let stale = t.target(rows[0].1);
    t.set_hidden(rows[0].0, true).unwrap();
    assert!(t.dispatch(stale, Command::Activate).is_err());
    assert!(t.dispatch(t.target(rows[0].1), Command::Activate).is_err());
    t.set_hidden(rows[0].0, false).unwrap();
    assert!(t.dispatch(stale, Command::Activate).is_err());
    t.set_disabled(rows[0].1, true).unwrap();
    assert!(t.dispatch(t.target(rows[0].1), Command::Activate).is_err());
    let parent = t.node(rows[0].0).unwrap().children()[0];
    t.remove(parent).unwrap();
    let new = t.append(rows[0].0, Kind::Label, "new").unwrap();
    assert!(new > rows[14].1);
}
#[test]
fn d5_paints_opaque_base_and_d7_keeps_pane_buffers_separate() {
    use nk_render::rgba;
    use nk_widgets::{Palette, Surface};
    let palette = Palette {
        background: rgba(10, 20, 30, 80),
        surface: rgba(100, 80, 60, 255),
        text: rgba(255, 255, 255, 255),
        disabled: rgba(120, 120, 120, 255),
        selected: rgba(30, 50, 70, 255),
        accent: rgba(0, 100, 255, 255),
        track: rgba(30, 40, 50, 255),
        thumb: rgba(255, 255, 255, 255),
        focus: rgba(0, 100, 255, 255),
        separator: rgba(99, 88, 77, 255),
    };
    let (mut t, mut b, scroll, _) = fixture();
    layout(&mut t, &mut b, true);
    let frame = nk_wayland::Frame {
        width: 640,
        height: 360,
        pixel_width: 640,
        pixel_height: 360,
        scale: 1.,
        material: true,
    };
    let pixels = t.paint(frame, Surface::Content, palette).unwrap();
    assert_eq!(pixels[3], 0, "D7 root does not paint the sidebar");
    let pane = t
        .paint(
            nk_wayland::Frame {
                width: 120,
                height: 360,
                pixel_width: 120,
                ..frame
            },
            Surface::Sidebar,
            palette,
        )
        .unwrap();
    assert!(
        pane.iter().any(|v| *v != 0),
        "sidebar content is independently painted"
    );
    // Each missing capability independently chooses D5, with identical geometry.
    for (material, layers) in [(false, true), (true, false), (false, false)] {
        layout(&mut t, &mut b, material && layers);
        t.scroll_to(scroll, Point { x: 0., y: 100. }).unwrap();
        let pixels = t
            .paint(
                nk_wayland::Frame { material, ..frame },
                Surface::Content,
                palette,
            )
            .unwrap();
        assert_eq!(
            u32::from_ne_bytes(pixels[0..4].try_into().unwrap()),
            0xff0a141e
        );
        // Content moving below the title is clipped out of the title's buffer.
        let at = (20 * 640 + 400) * 4;
        assert_eq!(
            u32::from_ne_bytes(pixels[at..at + 4].try_into().unwrap()),
            0xff0a141e
        );
        let content_edge = (350 * 640 + 639) * 4 + 3;
        assert_eq!(
            pixels[content_edge],
            if material { 0 } else { 255 },
            "D6 background remains the compositor's when material is available"
        );
    }
}
#[test]
fn a_hidden_subtree_reshapes_when_shown_after_live_font_changes() {
    let (mut t, mut b, _, rows) = fixture();
    layout(&mut t, &mut b, true);
    let label = label_id(&t, rows[0].0);
    t.set_hidden(rows[0].0, true).unwrap();
    t.set_text_style(TextStyle {
        size: 28.,
        ..Default::default()
    });
    layout(&mut t, &mut b, true);
    t.set_hidden(rows[0].0, false).unwrap();
    layout(&mut t, &mut b, true);
    assert_eq!(
        t.node(label).unwrap().text_layout().unwrap().style().size,
        28.
    );
    assert!(t.node(label).unwrap().bounds().height > 28.);
}
#[test]
fn click_and_controlled_model_updates_use_the_same_switch_and_page_state() {
    let (mut t, mut b, _, rows) = fixture();
    layout(&mut t, &mut b, true);
    let switch = rows[0].1;
    let p = t.node(switch).unwrap().bounds().center();
    t.pointer_press(p).unwrap();
    assert_eq!(
        t.pointer_release(p).unwrap(),
        nk_widgets::Effect::Activated(switch)
    );
    assert!(t.semantics().nodes[&switch].states.checked);
    t.set_checked(switch, false).unwrap();
    assert!(!t.semantics().nodes[&switch].states.checked);
    let pages = t.focus_order()[..2].to_vec();
    t.select_page(pages[1]).unwrap();
    let s = t.semantics();
    assert!(!s.nodes[&pages[0]].states.selected && s.nodes[&pages[1]].states.selected);
}
#[test]
fn layer_capture_is_local_and_cannot_be_consumed_by_a_root_release() {
    let (mut t, mut b, _, _) = fixture();
    layout(&mut t, &mut b, true);
    let pages = t.focus_order()[..2].to_vec();
    let sidebar = t.node(t.root()).unwrap().children()[0];
    // Layer input is already inverse-transformed by the compositor.
    let root_bounds = t.node(sidebar).unwrap().bounds();
    let page = t.node(pages[1]).unwrap().bounds();
    let p = Point {
        x: page.center().x - root_bounds.x,
        y: page.center().y - root_bounds.y,
    };
    t.pointer_press_in(sidebar, p).unwrap();
    assert_eq!(t.captured(), Some(pages[1]));
    assert_eq!(
        t.pointer_release_in(sidebar, p).unwrap(),
        nk_widgets::Effect::Activated(pages[1])
    );
    assert!(t.semantics().nodes[&pages[1]].states.selected);
    assert!(t.pointer_press_in(t.root(), p).is_err());
    t.pointer_press_in(sidebar, p).unwrap();
    assert_eq!(
        t.pointer_release(p).unwrap(),
        nk_widgets::Effect::None,
        "root cannot consume a layer's capture"
    );
    let s = t.semantics();
    assert_eq!(
        s.nodes[&pages[1]].attributes["nidara-node-id"],
        pages[1].to_string()
    );
    assert_eq!(
        s.nodes[&pages[1]].attributes["nidara-tree-generation"],
        t.generation().to_string()
    );
}

#[test]
fn container_accessible_names_never_become_visible_labels() {
    use nk_render::rgba;
    use nk_widgets::{Palette, Surface};
    let palette = Palette {
        background: rgba(10, 20, 30, 255),
        surface: rgba(60, 70, 80, 255),
        text: rgba(255, 255, 255, 255),
        disabled: rgba(120, 120, 120, 255),
        selected: rgba(20, 30, 40, 255),
        accent: rgba(0, 100, 255, 255),
        track: rgba(30, 40, 50, 255),
        thumb: rgba(255, 255, 255, 255),
        focus: rgba(0, 100, 255, 255),
        separator: rgba(99, 88, 77, 255),
    };
    for layered in [true, false] {
        let (mut tree, mut backend, scroll, _) = fixture();
        let sidebar = tree.node(tree.root()).unwrap().children()[0];
        let page = tree.node(sidebar).unwrap().children()[0];
        layout(&mut tree, &mut backend, layered);
        let frames = [(Surface::Content, 640), (Surface::Sidebar, 120)];
        for (surface, width) in frames {
            let frame = nk_wayland::Frame {
                width,
                height: 360,
                pixel_width: width as u16,
                pixel_height: 360,
                scale: 1.,
                material: true,
            };
            let before = tree.paint(frame, surface, palette).unwrap();
            tree.set_name(sidebar, "A different semantic sidebar name")
                .unwrap();
            tree.set_name(scroll, "A different semantic scroll name")
                .unwrap();
            layout(&mut tree, &mut backend, layered);
            let after = tree.paint(frame, surface, palette).unwrap();
            assert!(
                before == after,
                "container name painted as text on {surface:?}"
            );
            let semantics = tree.semantics();
            assert_eq!(
                semantics.nodes[&sidebar].name,
                "A different semantic sidebar name"
            );
            assert_eq!(
                semantics.nodes[&scroll].name,
                "A different semantic scroll name"
            );
            // Positive control: changing a visible page label changes sidebar pixels.
            if surface == Surface::Sidebar {
                tree.set_name(page, "Different page").unwrap();
                layout(&mut tree, &mut backend, layered);
                assert!(after != tree.paint(frame, surface, palette).unwrap());
            }
            tree.set_name(sidebar, "Pages").unwrap();
            tree.set_name(scroll, "Content").unwrap();
            layout(&mut tree, &mut backend, layered);
        }
    }
}

#[test]
fn repeated_activation_during_pointer_input_does_not_republish_semantics() {
    let (mut t, mut b, _, rows) = fixture();
    layout(&mut t, &mut b, false);
    t.set_active(true);
    t.dispatch(t.target(rows[0].1), Command::Focus).unwrap();
    assert!(t.semantics().nodes[&t.root()].states.active);
    t.acknowledge();
    for x in 0..1000 {
        // Match the app's physical state staging before ordinary motion.
        t.set_active(true);
        t.pointer_motion(Point {
            x: x as f32 / 4.,
            y: 100.,
        });
        assert!(
            !t.invalidation().semantics,
            "unchanged activation dirtied semantics"
        );
    }
    assert_eq!(t.focused(), Some(rows[0].1));
    t.set_active(false);
    assert!(t.invalidation().semantics);
    assert!(!t.semantics().nodes[&t.root()].states.active);
    t.acknowledge();
    t.set_active(false);
    assert_eq!(t.invalidation(), Invalid::default());
    // No-op staging must not erase a real transition still awaiting publication.
    t.set_active(true);
    t.set_active(true);
    assert!(t.invalidation().semantics);
    assert_eq!(t.focused(), Some(rows[0].1));
}
