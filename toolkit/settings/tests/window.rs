// SPDX-License-Identifier: LGPL-3.0-or-later
//! Settings chrome over the real exports: routing stays explicit, control geometry stays
//! inside the window, and the capsule is one accessible Panel of existing Buttons.
use nk_settings::{
    exports::Exports,
    material::control::capsule_metrics,
    portal::Appearance,
    styles::Styles,
    window::{Action, Labels, Shell},
};
use nk_text::{FontSet, ParleyBackend, Size};
use nk_wayland::{ControlsSide, WindowAction};
use nk_widgets::{Effect, Kind};
use std::sync::Arc;

fn fixture() -> (Exports, Styles, Shell) {
    let exports =
        Exports::load(&Exports::root()).expect("real NK_SETTINGS_DATA export is required");
    let appearance = Appearance {
        accent: [0., 136. / 255., 1.],
        dark: true,
        reduce_transparency: false,
        window_background: "tinted".into(),
        reduced_motion: false,
        font: "Inter Variable 11".into(),
        text_scale: 1.,
    };
    let styles = Styles::new(&exports, &appearance).unwrap();
    let metrics = capsule_metrics(&exports.components, true, false).unwrap();
    let shell = Shell::build(
        &exports,
        &styles,
        Labels {
            application: "Settings",
            sidebar: "Pages",
            sidebar_button: "Toggle sidebar",
            content: "Content",
            controls: "Window controls",
            minimize: "Minimize",
            maximize: "Maximize",
            close: "Close",
        },
        metrics,
        "appearance",
        Arc::new(FontSet::discover_required().unwrap()),
    )
    .unwrap();
    (exports, styles, shell)
}

#[test]
fn capsule_and_navigation_keep_their_semantic_structure() {
    let (exports, _, mut shell) = fixture();
    let panel = shell.tree.node(shell.controls).unwrap();
    assert_eq!(panel.kind(), Kind::ControlCapsule);
    let buttons = panel.children().to_vec();
    assert_eq!(buttons.len(), 3);
    assert!(
        buttons
            .iter()
            .all(|id| shell.tree.node(*id).unwrap().kind() == Kind::Button)
    );
    assert!(matches!(
        shell.action(Effect::Activated(buttons[2])).unwrap(),
        Action::Window(WindowAction::Close)
    ));
    let pages = shell.tree.node(shell.sidebar).unwrap().children().to_vec();
    let target = *pages
        .iter()
        .find(|id| {
            shell.tree.node(**id).unwrap().name()
                != exports
                    .text(&exports.page("appearance").unwrap().label)
                    .unwrap()
        })
        .unwrap();
    // The retained tree normally selects a page before emitting Activated. The shell rolls
    // that back until the Router and page mount explicitly accept the navigation.
    shell.tree.select_page(target).unwrap();
    assert!(matches!(
        shell.action(Effect::Activated(target)).unwrap(),
        Action::Page(_)
    ));
    assert_eq!(
        pages
            .iter()
            .filter(|id| shell.tree.node(**id).unwrap().kind() == Kind::Page { selected: true })
            .count(),
        1
    );
    assert_ne!(
        shell.tree.node(target).unwrap().kind(),
        Kind::Page { selected: true }
    );
    assert!(shell.selected(&exports, "no-such-page").is_err());
}

#[test]
fn both_control_sides_fit_docked_and_narrow_layouts_with_and_without_layers() {
    let (_, styles, mut shell) = fixture();
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    for layered in [false, true] {
        for width in [
            styles.metrics.sidebar + styles.metrics.content,
            styles.metrics.content,
        ] {
            for side in [ControlsSide::Left, ControlsSide::Right] {
                let size = Size {
                    width,
                    height: 600.,
                };
                shell
                    .layout_controls(size, side, layered, &mut text)
                    .unwrap();
                let r = shell.tree.node(shell.controls).unwrap().bounds();
                let expected_x = match side {
                    ControlsSide::Left => 12.,
                    ControlsSide::Right => width - 12. - 72.,
                };
                assert_eq!(
                    r.x, expected_x,
                    "window controls ignored the requested side"
                );
                assert_eq!(r.y, 12., "capsule must be centered on the header line");
                assert_eq!((r.width, r.height), (72., 24.));
                assert!(r.x >= 0. && r.y >= 0. && r.x + r.width <= width);
                assert!(r.height > 0. && r.y + r.height <= styles.metrics.titlebar);
                for button in shell.tree.node(shell.controls).unwrap().children() {
                    let b = shell.tree.node(*button).unwrap().bounds();
                    assert!(b.x >= r.x && b.x + b.width <= r.x + r.width);
                }
            }
        }
    }
}

#[test]
fn header_has_icon_semantics_fixed_geometry_and_stays_clean_when_idle() {
    let (_, styles, mut shell) = fixture();
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    let size = Size {
        width: 1050.,
        height: 600.,
    };
    for side in [ControlsSide::Right, ControlsSide::Left] {
        shell.layout_controls(size, side, true, &mut text).unwrap();
        let toggle = shell
            .tree
            .capsule_ids()
            .find(|id| shell.tree.node(*id).unwrap().name() == "Toggle sidebar")
            .unwrap();
        let toggle_button = shell.tree.node(toggle).unwrap().children()[0];
        let icon = shell.tree.node(toggle_button).unwrap();
        assert_eq!(icon.name(), "Toggle sidebar");
        assert!(
            icon.text_layout().is_none(),
            "accessible label became visible text"
        );
        let r = shell.tree.node(toggle).unwrap().bounds();
        assert_eq!((r.y, r.width, r.height), (8., 32., 32.));
        let nav = shell
            .tree
            .capsule_ids()
            .find(|id| shell.tree.node(*id).unwrap().name() == "Pages")
            .unwrap();
        let r = shell.tree.node(nav).unwrap().bounds();
        assert_eq!((r.y, r.width, r.height), (8., 60., 32.));
        let title = shell.tree.node(shell.titlebar).unwrap().bounds();
        assert_eq!(title.height, 48.);
        let search = shell.tree.node(shell.search).unwrap().bounds();
        assert_eq!((search.y, search.width, search.height), (8., 200., 32.));
        let controls = shell.tree.node(shell.controls).unwrap().bounds();
        assert!(search.x + search.width + 12. <= controls.x || side == ControlsSide::Left);
        shell.tree.acknowledge();
        shell.layout_controls(size, side, true, &mut text).unwrap();
        let invalid = shell.tree.invalidation();
        assert!(
            !invalid.layout && !invalid.paint && !invalid.semantics,
            "unchanged header layout requested idle work: {invalid:?}"
        );
    }
    assert_eq!(styles.header.titlebar.height, 68.);
    assert!(!styles.header.titlebar.opaque);
    assert!(styles.header.titlebar.blur.passes > 0);
}

#[test]
fn header_preserves_content_padding_in_scroll_extent() {
    let (_, _, mut shell) = fixture();
    let group = shell.tree.group(shell.content, "Start of page").unwrap();
    let first = group;
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    shell
        .layout_controls(
            Size {
                width: 1050.,
                height: 600.,
            },
            ControlsSide::Right,
            true,
            &mut text,
        )
        .unwrap();
    assert_eq!(shell.tree.node(first).unwrap().bounds().y, 64.);
}

#[test]
fn header_search_selection_is_excluded_from_adaptive_ink() {
    let (exports, _, mut shell) = fixture();
    shell.tree.set_active(true);
    shell.tree.focus(shell.search).unwrap();
    shell
        .tree
        .set_search_text(shell.search, "Color 日本")
        .unwrap();
    shell
        .tree
        .search_request(
            shell.tree.target(shell.search),
            nk_a11y::Request::SetSelection(shell.search, 0.."Color 日本".len()),
        )
        .unwrap();
    shell
        .layout_controls(
            Size {
                width: 1050.,
                height: 600.,
            },
            ControlsSide::Right,
            true,
            &mut ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap(),
        )
        .unwrap();
    let panel = shell
        .tree
        .capsule_ids()
        .find(|id| {
            shell
                .tree
                .node(*id)
                .unwrap()
                .children()
                .contains(&shell.search)
        })
        .unwrap();
    let pane = shell.tree.node(panel).unwrap().bounds();
    let style = nk_settings::material::control::ControlRecipe::load(&exports.glass, true, false)
        .unwrap()
        .at(32.)
        .unwrap();
    let material = shell.tree.capsule_material(panel, &style, false).unwrap();
    material.validate().unwrap();
    assert!(material.coverage.len() > 1);
    let semantics = shell.tree.semantics();
    let geometry = semantics.nodes[&shell.search]
        .text
        .as_ref()
        .unwrap()
        .geometry
        .as_ref()
        .unwrap();
    for span in &geometry.spans {
        let x = span.bounds.x + span.bounds.width / 2. - f64::from(pane.x);
        let y = span.bounds.y + span.bounds.height / 2. - f64::from(pane.y);
        assert!(
            !material.coverage.iter().any(|r| x >= r.bounds.x
                && x < r.bounds.x + r.bounds.width
                && y >= r.bounds.y
                && y < r.bounds.y + r.bounds.height),
            "selection was recoloured as adaptive ink"
        );
    }
}

#[test]
fn server_controls_replace_the_whole_capsule_and_reserve_announced_geometry() {
    use nk_wayland::{ControlsLayout, Frame};
    use nk_widgets::Command;
    let (_, styles, mut shell) = fixture();
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    let buttons = shell.tree.node(shell.controls).unwrap().children().to_vec();
    shell.tree.set_active(true);
    for layered in [false, true] {
        for width in [1050., 650.] {
            let size = Size {
                width,
                height: 600.,
            };
            shell.tree.set_server_controls(None).unwrap();
            shell
                .layout_controls(size, ControlsSide::Right, layered, &mut text)
                .unwrap();
            shell.tree.focus(buttons[2]).unwrap();
            let r = shell.tree.node(buttons[2]).unwrap().bounds();
            shell
                .tree
                .pointer_press(nk_text::Point {
                    x: r.x + r.width / 2.,
                    y: r.y + r.height / 2.,
                })
                .unwrap();
            assert_eq!(shell.tree.captured(), Some(buttons[2]));
            for (cw, ch) in [(72., 24.), (88., 32.)] {
                for side in [ControlsSide::Left, ControlsSide::Right] {
                    shell
                        .tree
                        .set_server_controls(Some(ControlsLayout {
                            side,
                            width: cw,
                            height: ch,
                        }))
                        .unwrap();
                    // The compositor's announced side wins over the app's stale preference.
                    let stale = if side == ControlsSide::Left {
                        ControlsSide::Right
                    } else {
                        ControlsSide::Left
                    };
                    shell
                        .layout_controls(size, stale, layered, &mut text)
                        .unwrap();
                    assert!(shell.tree.is_hidden(shell.controls));
                    assert_eq!(shell.tree.captured(), None);
                    assert!(!shell.tree.focused().is_some_and(|id| buttons.contains(&id)));
                    let semantics = shell.tree.semantics();
                    assert!(
                        !semantics.nodes.contains_key(&shell.controls),
                        "orphan capsule panel"
                    );
                    for id in &buttons {
                        assert!(!semantics.nodes.contains_key(id));
                        assert!(!shell.tree.focus_order().contains(id));
                        assert!(
                            shell
                                .tree
                                .dispatch(shell.tree.target(*id), Command::Activate)
                                .is_err()
                        );
                    }
                    for node in semantics.nodes.values() {
                        assert!(
                            node.children
                                .iter()
                                .all(|id| semantics.nodes.contains_key(id)),
                            "dangling semantic child"
                        );
                    }
                    let bounds = shell.tree.server_controls_bounds().unwrap();
                    assert_eq!((bounds.width, bounds.height), (cw as f32, ch as f32));
                    assert_eq!(bounds.y, (styles.header.band - ch as f32) / 2.);
                    let toggle_panel = shell
                        .tree
                        .capsule_ids()
                        .find(|id| shell.tree.node(*id).unwrap().name() == "Toggle sidebar")
                        .unwrap();
                    let toggle = shell.tree.node(toggle_panel).unwrap().bounds();
                    let search = shell.tree.node(shell.search).unwrap().bounds();
                    if side == ControlsSide::Left {
                        assert_eq!(bounds.x, styles.controls_inset);
                        assert!(toggle.x >= bounds.x + bounds.width + styles.header.search_gap);
                    } else {
                        assert_eq!(bounds.x, width - styles.controls_inset - cw as f32);
                        if !shell.tree.is_hidden(shell.search) {
                            assert!(search.x + search.width + styles.header.search_gap <= bounds.x);
                        }
                    }
                    // Both layer coverage and root fallback painting consume the hidden panel.
                    let frame = Frame {
                        width: 72,
                        height: 24,
                        pixel_width: 72,
                        pixel_height: 24,
                        scale: 1.,
                        material: true,
                    };
                    let image = shell
                        .tree
                        .paint_capsule_coverage(shell.controls, frame, styles.palette)
                        .unwrap();
                    assert!(
                        image.iter().all(|v| *v == 0),
                        "client capsule still paints beside server controls"
                    );
                    shell.tree.acknowledge();
                    shell
                        .layout_controls(size, stale, layered, &mut text)
                        .unwrap();
                    let invalid = shell.tree.invalidation();
                    assert!(
                        !invalid.layout && !invalid.paint && !invalid.semantics,
                        "idle server header invalidates: {invalid:?}"
                    );
                }
            }
            shell.tree.set_server_controls(None).unwrap();
            shell
                .layout_controls(size, ControlsSide::Right, layered, &mut text)
                .unwrap();
            assert!(shell.tree.server_controls_bounds().is_none());
            assert!(!shell.tree.is_hidden(shell.controls));
            let semantics = shell.tree.semantics();
            assert!(semantics.nodes.contains_key(&shell.controls));
            for id in &buttons {
                assert!(semantics.nodes.contains_key(id));
                assert!(shell.tree.focus_order().contains(id));
                assert!(shell.tree.node(*id).unwrap().text_layout().is_none());
                assert_eq!(
                    shell
                        .tree
                        .dispatch(shell.tree.target(*id), Command::Activate)
                        .unwrap(),
                    Effect::Activated(*id)
                );
            }
        }
    }
}
