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
                    .layout_controls(size, side, styles.metrics, layered, &mut text)
                    .unwrap();
                let r = shell.tree.node(shell.controls).unwrap().bounds();
                let expected_x = match side {
                    ControlsSide::Left => styles.metrics.padding,
                    ControlsSide::Right => width - styles.metrics.padding - r.width,
                };
                assert_eq!(
                    r.x, expected_x,
                    "window controls ignored the requested side"
                );
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
