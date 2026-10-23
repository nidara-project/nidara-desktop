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

fn fixture() -> (Tree, u64, u64, u64) {
    fixture_with_style(true)
}

fn fixture_with_style(with_style: bool) -> (Tree, u64, u64, u64) {
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
