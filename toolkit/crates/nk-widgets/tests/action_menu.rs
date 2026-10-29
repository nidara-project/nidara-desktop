// SPDX-License-Identifier: LGPL-3.0-or-later
use nk_a11y::Role;
use nk_text::{FontSet, ParleyBackend, Point, Size, TextStyle};
use nk_widgets::{
    ActionMenuRow, ActionMenuStyle, Command, Effect, MenuActionKind, Metrics, Tree,
    action_menu_snapshot,
};
use std::sync::Arc;
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
fn action_style() -> ActionMenuStyle {
    let icon=nk_icons::Icon::parse(br#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M4 8L12 16L20 8" fill="none" stroke="currentColor" stroke-width="2"/></svg>"#).unwrap();
    ActionMenuStyle {
        row: menu_style(),
        band_height: 20.,
        up: icon.clone(),
        down: icon.clone(),
        submenu: icon,
    }
}
fn rows(count: usize) -> Vec<ActionMenuRow> {
    (0..count)
        .map(|i| ActionMenuRow {
            label: format!("Action {i}"),
            kind: match i {
                1 => MenuActionKind::Check(true),
                2 => MenuActionKind::Radio(true),
                3 => MenuActionKind::Separator,
                4 => MenuActionKind::Submenu { expanded: false },
                _ => MenuActionKind::Action,
            },
            enabled: i != 5,
            icon: None,
        })
        .collect()
}
fn backend() -> ParleyBackend {
    ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap()
}
#[test]
fn thousand_action_rows_clip_reveal_and_keep_controlled_semantics() {
    let (mut menu, ids) = Tree::action_menu(
        "Menu",
        metrics(),
        TextStyle::default(),
        action_style(),
        &rows(1000),
        ["Scroll up", "Scroll down"],
    )
    .unwrap();
    let mut backend = backend();
    menu.layout(
        Size {
            width: 250.,
            height: 150.,
        },
        false,
        &mut backend,
    )
    .unwrap();
    let semantics = menu.semantics();
    assert_eq!(semantics.nodes[&ids[0]].role, Role::MenuItem);
    assert_eq!(semantics.nodes[&ids[1]].role, Role::CheckMenuItem);
    assert!(semantics.nodes[&ids[1]].states.checked);
    assert_eq!(semantics.nodes[&ids[2]].role, Role::RadioMenuItem);
    assert_eq!(semantics.nodes[&ids[3]].role, Role::Separator);
    assert!(semantics.nodes[&ids[4]].states.expandable);
    assert!(semantics.nodes[&ids[999]].states.offscreen);
    assert!(!semantics.nodes[&ids[1]].states.selected);
    menu.focus(ids[0]).unwrap();
    menu.control_key(0xff57).unwrap();
    assert_eq!(menu.focused(), Some(ids[999]));
    let node = &menu.semantics().nodes[&ids[999]];
    assert!(!node.states.offscreen);
    let viewport = menu.content_viewport();
    let last = menu.node(ids[999]).unwrap().bounds();
    assert!(last.y >= viewport.y && last.y + last.height <= viewport.y + viewport.height + 0.01);
    assert_eq!(
        menu.hit_test(Point {
            x: last.x + 5.,
            y: last.y + last.height / 2.
        }),
        Some(ids[999])
    );
    let top = menu.menu_scroll_bands().unwrap()[0];
    let band = menu.node(top).unwrap().bounds();
    assert_eq!(
        menu.hit_test(Point {
            x: band.x + band.width / 2.,
            y: band.y + band.height / 2.
        }),
        Some(top)
    );
    assert_eq!(
        menu.dispatch(menu.target(top), Command::Activate).unwrap(),
        Effect::None
    );
    assert!(menu.semantics().nodes[&ids[999]].states.offscreen);
    menu.focus(ids[999]).unwrap();
    menu.control_key(0xff55).unwrap();
    assert_ne!(menu.focused(), Some(ids[999]));
    let focused = menu.focused().unwrap();
    menu.layout(
        Size {
            width: 240.,
            height: 90.,
        },
        false,
        &mut backend,
    )
    .unwrap();
    assert!(!menu.semantics().nodes[&focused].states.offscreen);
    menu.control_key(0xff50).unwrap();
    menu.control_key(0xff54).unwrap();
    assert_eq!(menu.focused(), Some(ids[1]));
    assert_eq!(
        menu.dispatch(menu.target(ids[1]), Command::Activate)
            .unwrap(),
        Effect::Activated(ids[1])
    );
    assert_eq!(
        menu.menu_action_kind(ids[1]),
        Some(MenuActionKind::Check(true))
    );
    menu.set_menu_action_kind(ids[1], MenuActionKind::Check(false))
        .unwrap();
    assert!(!menu.semantics().nodes[&ids[1]].states.checked);
    let stale = menu.target(ids[1]);
    menu.set_hidden(ids[1], true).unwrap();
    assert!(menu.dispatch(stale, Command::Activate).is_err());
}
#[test]
fn projection_uses_real_origins_and_rejects_overlapping_namespaces() {
    let mut parent = Tree::new("Parent", metrics(), TextStyle::default()).unwrap();
    let (mut menu, ids) = parent
        .action_menu_child(
            "Menu",
            action_style(),
            &rows(20),
            ["Scroll up", "Scroll down"],
        )
        .unwrap();
    menu.layout(
        Size {
            width: 250.,
            height: 150.,
        },
        false,
        &mut backend(),
    )
    .unwrap();
    menu.focus(ids[0]).unwrap();
    assert!(
        menu.action_menu_child("Bad child", action_style(), &rows(1), ["Up", "Down"])
            .is_err()
    );
    let snapshot = action_menu_snapshot(&parent, &[(&menu, Point { x: -50., y: 80. })]).unwrap();
    assert_eq!(
        snapshot.tree.nodes[&ids[0]].bounds.x,
        menu.semantics().nodes[&ids[0]].bounds.x - 50.
    );
    assert!(snapshot.tree.nodes[&ids[0]].states.focused);
    assert!(snapshot.tree.nodes.values().any(|n| n.role == Role::Menu));
    let (duplicate, _) = Tree::action_menu(
        "Bad",
        metrics(),
        TextStyle::default(),
        action_style(),
        &rows(2),
        ["Up", "Down"],
    )
    .unwrap();
    assert!(action_menu_snapshot(&parent, &[(&duplicate, Point::default())]).is_err());
}
