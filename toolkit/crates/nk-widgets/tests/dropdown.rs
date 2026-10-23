// SPDX-License-Identifier: LGPL-3.0-or-later
//! ComboBox's retained model, not acceptance of popup rendering or Orca speech.
use nk_a11y::{Action, Relation, Role};
use nk_text::{FontSet, ParleyBackend, Point, Size, TextStyle};
use nk_widgets::{Command, Effect, Kind, Metrics, Tree};
use std::sync::Arc;

fn fixture() -> (Tree, u64, u64, u64) {
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
