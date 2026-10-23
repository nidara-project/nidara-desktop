// SPDX-License-Identifier: LGPL-3.0-or-later
//! ComboBox's retained model, not acceptance of popup rendering or Orca speech.
use nk_a11y::{Action, Relation, Role};
use nk_text::{FontSet, ParleyBackend, Point, Size, TextStyle};
use nk_widgets::{Command, DropdownStyle, Effect, Kind, Metrics, Tree};
use std::sync::Arc;

fn style() -> DropdownStyle {
    let color = |v| nk_render::rgba(v, v, v, 255);
    DropdownStyle {
        padding_x: 14.,
        padding_y: 4.,
        border: 2.,
        min_content_height: 20.,
        radius: 10.,
        text_scale: 0.93,
        weight: 500.,
        label_margin: 8.,
        arrow_size: 16.,
        arrow_gap: 6.,
        arrow: "nd-pan-down".into(),
        background: color(30),
        hover: color(60),
        pressed: color(90),
        text: color(240),
        arrow_color: color(160),
        focus: nk_render::rgba(0, 100, 255, 255),
        disabled_opacity: 0.45,
    }
}

fn metrics() -> Metrics {
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
    }
}

fn fixture() -> (Tree, u64, u64, u64) {
    fixture_with_style(true)
}

fn fixture_with_style(with_style: bool) -> (Tree, u64, u64, u64) {
    let mut tree = Tree::new(
        "Window",
        metrics(),
        TextStyle {
            size: 14.,
            ..Default::default()
        },
    )
    .unwrap();
    if with_style {
        tree.set_dropdown_style(style()).unwrap();
    }
    let scroll = tree.append(tree.root(), Kind::Scroll, "Content").unwrap();
    let group = tree.append(scroll, Kind::Group, "Options").unwrap();
    let (row, combo) = tree
        .dropdown(group, "Language", &["English", "Español", "日本語"], 1)
        .unwrap();
    (tree, group, row, combo)
}

#[test]
fn collapsed_selection_remains_named_and_has_one_tab_stop_and_no_hit_area_for_options() {
    let (mut tree, _, row, combo) = fixture();
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    tree.layout(
        Size {
            width: 640.,
            height: 480.,
        },
        false,
        &mut text,
    )
    .unwrap();
    let semantics = tree.semantics();
    semantics.validate().unwrap();
    let model = &semantics.nodes[&combo];
    assert_eq!(model.role, Role::ComboBox);
    assert_eq!(model.name, "Language");
    assert!(model.states.expandable && !model.states.expanded);
    let label = tree.node(row).unwrap().children()[0];
    assert!(model.relations.contains(&Relation::LabelledBy(label)));
    let ids = tree.node(combo).unwrap().children().to_vec();
    assert_eq!(semantics.selected_children(combo), vec![ids[1]]);
    assert_eq!(semantics.nodes[&ids[1]].name, "Español");
    assert_eq!(tree.focus_order(), vec![combo]);
    for id in &ids {
        let option = &semantics.nodes[id];
        assert_eq!(option.role, Role::Option);
        assert_eq!(option.actions, vec![Action::Activate]);
        assert!(option.states.offscreen);
        assert_eq!(tree.node(*id).unwrap().bounds().width, 0.);
        assert!(tree.focus(*id).is_err());
    }
    let bounds = tree.node(combo).unwrap().bounds();
    let point = Point {
        x: bounds.x + bounds.width / 2.,
        y: bounds.y + bounds.height / 2.,
    };
    assert_eq!(tree.hit_test(point), Some(combo));
    tree.pointer_press(point).unwrap();
    assert_eq!(
        tree.pointer_release(point).unwrap(),
        Effect::Activated(combo)
    );
    assert_eq!(
        tree.dropdown_selected(combo).unwrap(),
        1,
        "opening must not change the choice"
    );
}

#[test]
fn selecting_through_the_same_action_path_changes_once_and_cancel_preserves_it() {
    let (mut tree, _, _, combo) = fixture();
    let target = tree.node(combo).unwrap().children()[2];
    tree.set_dropdown_expanded(combo, true).unwrap();
    let before = tree.semantics();
    assert_eq!(
        tree.dispatch(tree.target(target), Command::Activate)
            .unwrap(),
        Effect::Changed(combo)
    );
    assert_eq!(tree.dropdown_selected(combo).unwrap(), 2);
    assert_eq!(tree.node(combo).unwrap().name(), "日本語");
    let after = tree.semantics();
    assert_eq!(
        nk_a11y::diff(Some(&before), &after)
            .unwrap()
            .iter()
            .filter(|e| **e == nk_a11y::Event::SelectionChanged(combo))
            .count(),
        1
    );
    assert!(
        !nk_a11y::diff(Some(&after), &after)
            .unwrap()
            .contains(&nk_a11y::Event::SelectionChanged(combo))
    );

    assert_eq!(
        tree.dispatch(tree.target(target), Command::Activate)
            .unwrap(),
        Effect::None
    );
    tree.set_dropdown_expanded(combo, false).unwrap();
    assert_eq!(tree.dropdown_selected(combo).unwrap(), 2);
    assert!(!tree.semantics().nodes[&combo].states.expanded);
    // Selection remains actionable while collapsed; no popup is opened.
    assert_eq!(
        tree.dispatch(
            tree.target(tree.node(combo).unwrap().children()[1]),
            Command::Activate
        )
        .unwrap(),
        Effect::Changed(combo)
    );
    assert!(!tree.semantics().nodes[&combo].states.expanded);
    tree.set_dropdown_selected(combo, 0).unwrap();
    assert_eq!(tree.dropdown_selected(combo).unwrap(), 0);
    assert_eq!(
        tree.semantics().selected_children(combo),
        vec![tree.node(combo).unwrap().children()[0]]
    );
}

#[test]
fn invalid_arguments_are_atomic_and_unavailable_or_stale_options_cannot_edit() {
    let (mut tree, group, row, combo) = fixture();
    let before = tree.semantics();
    for options in [vec![], vec!["one"]] {
        assert!(tree.dropdown(group, "Bad", &options, 1).is_err());
    }
    assert_eq!(tree.semantics().nodes.len(), before.nodes.len());
    assert_eq!(tree.focus_order(), vec![combo]);
    assert!(
        tree.append(combo, Kind::DropdownOption { selected: true }, "Duplicate")
            .is_err()
    );
    assert!(tree.set_dropdown_selected(combo, 3).is_err());
    assert_eq!(tree.dropdown_selected(combo).unwrap(), 1);
    let option = tree.node(combo).unwrap().children()[2];
    let old = tree.target(option);
    tree.set_disabled(row, true).unwrap();
    assert!(
        tree.dispatch(tree.target(option), Command::Activate)
            .is_err()
    );
    tree.set_disabled(row, false).unwrap();
    assert!(tree.dispatch(old, Command::Activate).is_err());
    tree.set_hidden(row, true).unwrap();
    assert!(
        tree.dispatch(tree.target(option), Command::Activate)
            .is_err()
    );
    tree.set_hidden(row, false).unwrap();
    tree.remove(row).unwrap();
    assert!(tree.dispatch(old, Command::Activate).is_err());
}

fn palette() -> nk_widgets::Palette {
    let c = |v| nk_render::rgba(v, v, v, 255);
    nk_widgets::Palette {
        background: c(20),
        surface: c(100),
        text: c(240),
        disabled: c(120),
        selected: c(60),
        accent: c(200),
        track: c(40),
        thumb: c(255),
        focus: c(200),
        separator: c(90),
    }
}
fn paint(tree: &Tree) -> Vec<u8> {
    tree.paint(
        nk_wayland::Frame {
            width: 640,
            height: 480,
            pixel_width: 640,
            pixel_height: 480,
            scale: 1.,
            material: false,
        },
        nk_widgets::Surface::Content,
        palette(),
    )
    .unwrap()
}
fn pixel(image: &[u8], x: f32, y: f32) -> [u8; 3] {
    let at = (y.floor() as usize * 640 + x.floor() as usize) * 4;
    [image[at + 2], image[at + 1], image[at]]
}
#[test]
fn trigger_uses_exported_geometry_arrow_and_states_without_a_hover_or_focus_size_jump() {
    let (mut tree, _, _, combo) = fixture();
    let reference = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../ui/shell/assets/icons/nidara");
    tree.set_icon_theme(nk_icons::Icons::new("", &[], &reference).unwrap());
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    tree.layout(
        Size {
            width: 640.,
            height: 480.,
        },
        false,
        &mut text,
    )
    .unwrap();
    let r = tree.node(combo).unwrap().bounds();
    assert_eq!(r.height, 32., "20 content + twice(4 padding + 2 border)");
    let point = Point {
        x: r.x + r.width / 2.,
        y: r.y + r.height / 2.,
    };
    let sample = (r.x + r.width / 2., r.y + r.height - 3.);
    let idle = paint(&tree);
    assert_eq!(pixel(&idle, sample.0, sample.1), [30; 3]);
    // Shared vector chevron, in the exported arrow ink, inside its reserved box.
    let left = r.x + r.width - 2. - 14. - 16.;
    assert!((left as usize..(left + 16.) as usize).any(|x| {
        (r.y as usize..(r.y + r.height) as usize)
            .any(|y| pixel(&idle, x as f32, y as f32) == [160; 3])
    }));
    tree.pointer_motion(point);
    assert_eq!(pixel(&paint(&tree), sample.0, sample.1), [60; 3]);
    tree.pointer_press(point).unwrap();
    assert_eq!(pixel(&paint(&tree), sample.0, sample.1), [90; 3]);
    tree.pointer_release(point).unwrap();
    tree.tab(false).unwrap();
    assert_eq!(pixel(&paint(&tree), r.x + r.width / 2., r.y), [0, 100, 255]);
    assert_eq!(tree.node(combo).unwrap().bounds(), r);
    tree.set_disabled(combo, true).unwrap();
    let disabled = pixel(&paint(&tree), sample.0, sample.1);
    assert!(
        disabled[0] > 30 && disabled[0] < 100,
        "disabled opacity must blend the control with its backing card"
    );
    assert_eq!(disabled, [disabled[0]; 3]);
    tree.set_disabled(combo, false).unwrap();
    tree.set_text_style(TextStyle {
        size: 28.,
        ..Default::default()
    });
    tree.layout(
        Size {
            width: 640.,
            height: 480.,
        },
        false,
        &mut text,
    )
    .unwrap();
    assert!(
        tree.node(combo).unwrap().bounds().height > r.height,
        "text scale must remeasure the trigger"
    );
}
#[test]
fn missing_or_invalid_trigger_style_is_an_error_instead_of_button_fallback() {
    let (mut tree, _, _, _) = fixture_with_style(false);
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    assert!(
        tree.layout(
            Size {
                width: 640.,
                height: 480.
            },
            false,
            &mut text
        )
        .unwrap_err()
        .contains("dropdown style")
    );
    let mut invalid = style();
    invalid.border = f32::NAN;
    assert!(tree.set_dropdown_style(invalid).is_err());
    let mut invalid = style();
    invalid.disabled_opacity = 2.;
    assert!(tree.set_dropdown_style(invalid).is_err());
    let mut invalid = style();
    invalid.arrow.clear();
    assert!(tree.set_dropdown_style(invalid).is_err());
}

fn menu_style() -> nk_widgets::MenuStyle {
    let c = |v| nk_render::rgba(v, v, v, 255);
    nk_widgets::MenuStyle {
        border: 1.,
        radius: 16.,
        inset: 6.,
        padding_x: 9.,
        padding_y: 6.,
        row_radius: 10.,
        text_scale: 0.93,
        weight: 400.,
        check_size: 14.,
        check_gap: 8.,
        check_stroke: 2.2,
        background: c(30),
        border_color: c(90),
        text: c(240),
        accent: nk_render::rgba(0, 100, 255, 255),
        accent_text: c(240),
        pressed_black: 0.15,
    }
}
fn menu_fixture(height: f32) -> (Tree, Vec<u64>, ParleyBackend) {
    let (mut tree, ids) = Tree::menu_list(
        "Language",
        metrics(),
        TextStyle {
            size: 14.,
            ..Default::default()
        },
        menu_style(),
        &["English", "Español", "日本語", "Arabic"],
        0,
    )
    .unwrap();
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    tree.layout(
        Size {
            width: 640.,
            height,
        },
        false,
        &mut text,
    )
    .unwrap();
    (tree, ids, text)
}
#[test]
fn menu_layout_uses_one_inset_and_keyboard_focus_reveals_without_changing_the_choice() {
    let (mut tree, ids, _) = menu_fixture(80.);
    let viewport = tree.content_viewport();
    assert_eq!(viewport.x, 1.);
    assert_eq!(viewport.width, 638.);
    let first = tree.node(ids[0]).unwrap().bounds();
    assert_eq!((first.x, first.y, first.width), (7., 7., 626.));
    assert!(
        ids.iter()
            .all(|id| tree.semantics().nodes[id].role == Role::Option)
    );
    tree.focus(ids[0]).unwrap();
    tree.set_disabled(ids[3], true).unwrap();
    assert_eq!(
        tree.control_key(0xff57).unwrap(),
        Some(Effect::Focused(ids[2]))
    );
    assert!(
        tree.node(tree.node(tree.root()).unwrap().children()[0])
            .unwrap()
            .scroll()
            .y
            > 0.
    );
    assert!(tree.semantics().nodes[&ids[2]].states.focused);
    assert_eq!(
        tree.node(ids[0]).unwrap().kind(),
        Kind::MenuOption { selected: true }
    );
    assert_eq!(
        tree.node(ids[2]).unwrap().kind(),
        Kind::MenuOption { selected: false }
    );
    assert_eq!(
        tree.dispatch(tree.target(ids[2]), Command::Activate)
            .unwrap(),
        Effect::Activated(ids[2])
    );
    assert_eq!(
        tree.node(ids[0]).unwrap().kind(),
        Kind::MenuOption { selected: true }
    );
    tree.control_key(0xff50).unwrap();
    assert_eq!(tree.focused(), Some(ids[0]));
    tree.control_key(0xff52).unwrap();
    assert_eq!(
        tree.focused(),
        Some(ids[2]),
        "wrap must skip disabled options"
    );
}
#[test]
fn menu_highlight_and_chosen_check_remain_independent_in_pixels_and_semantics() {
    let (mut tree, ids, _) = menu_fixture(480.);
    let r = |tree: &Tree, id| tree.node(id).unwrap().bounds();
    let selected = r(&tree, ids[0]);
    let other = r(&tree, ids[1]);
    tree.pointer_motion(Point {
        x: other.x + other.width / 2.,
        y: other.y + other.height / 2.,
    });
    let hover = paint(&tree);
    assert_eq!(
        pixel(&hover, 300., other.y + other.height / 2.),
        [0, 100, 255]
    );
    assert_eq!(
        pixel(&hover, 300., selected.y + selected.height / 2.),
        [30; 3]
    );
    let check_x = selected.x + selected.width - 9. - 14.;
    let bright_in_check = |image: &[u8], row: nk_text::Rect| {
        (check_x as usize..(check_x + 14.) as usize).any(|x| {
            (row.y as usize..(row.y + row.height) as usize).any(|y| {
                let p = pixel(image, x as f32, y as f32);
                p[0] > 180 && p[0] == p[1] && p[1] == p[2]
            })
        })
    };
    assert!(bright_in_check(&hover, selected));
    assert!(!bright_in_check(&hover, other));
    assert!(tree.semantics().nodes[&ids[0]].states.selected);
    assert!(!tree.semantics().nodes[&ids[1]].states.selected);
    tree.focus(ids[0]).unwrap();
    tree.control_key(0xff54).unwrap();
    tree.pointer_motion(Point {
        x: r(&tree, ids[2]).x + 300.,
        y: r(&tree, ids[2]).y + 5.,
    });
    assert_eq!(
        pixel(&paint(&tree), 300., other.y + other.height / 2.),
        [30; 3],
        "pointer mode must not leave a second focused fill behind"
    );
}

#[test]
fn menu_style_update_keeps_focus_and_chosen_ids_and_refuses_invalid_or_wrong_tree() {
    let (mut tree, ids, mut text) = menu_fixture(80.);
    tree.focus(ids[1]).unwrap();
    let old = tree.node(ids[1]).unwrap().bounds().height;
    let mut changed = menu_style();
    changed.padding_y += 4.;
    tree.set_menu_style(changed).unwrap();
    tree.layout(
        Size {
            width: 640.,
            height: 80.,
        },
        false,
        &mut text,
    )
    .unwrap();
    assert_eq!(tree.focused(), Some(ids[1]));
    assert_eq!(tree.node(ids[1]).unwrap().bounds().height, old + 8.);
    assert_eq!(
        tree.node(ids[0]).unwrap().kind(),
        Kind::MenuOption { selected: true }
    );
    let mut invalid = menu_style();
    invalid.check_size = f32::NAN;
    assert!(tree.set_menu_style(invalid).is_err());
    let (mut ordinary, _, _, _) = fixture();
    assert!(ordinary.set_menu_style(menu_style()).is_err());
}
