// SPDX-License-Identifier: LGPL-3.0-or-later
//! Retained component tests; synthetic events are not native IME/Orca acceptance.
use nk_a11y::{Action, Request, Role};
use nk_text::{Affinity, Caret, Editor, FontSet, ParleyBackend, Point, Size, TextStyle};
use nk_wayland::{Event, ImeBatch, Key};
use nk_widgets::{Effect, Kind, Metrics, SearchStyle, Tree, window::Composition};
use std::sync::Arc;
fn backend() -> ParleyBackend {
    ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap()
}
fn style() -> SearchStyle {
    let c = |v| nk_render::rgba(v, v, v, 255);
    SearchStyle {
        padding_x: 12.,
        border: 1.,
        min_height: 32.,
        radius: 999.,
        icon_size: 15.,
        icon_gap: 8.,
        icon: "nd-system-search".into(),
        background: c(30),
        border_color: c(60),
        focus_border: c(100),
        text: c(240),
        dim: c(150),
        selection: nk_render::rgba(0, 136, 255, 77),
        selection_text: c(240),
    }
}
fn fixture() -> (Tree, u64, u64) {
    let mut tree = Tree::new(
        "Search",
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
    tree.set_search_style(style()).unwrap();
    let scroll = tree.append(tree.root(), Kind::Scroll, "Content").unwrap();
    let input = tree
        .search_input(scroll, "Font family", "Search fonts", Box::new(backend()))
        .unwrap();
    let (_, button) = tree.row(scroll, "Following control", Kind::Button).unwrap();
    tree.set_active(true);
    layout(&mut tree);
    (tree, input, button)
}
fn layout(tree: &mut Tree) {
    tree.layout(
        Size {
            width: 640.,
            height: 480.,
        },
        false,
        &mut backend(),
    )
    .unwrap();
}
fn key(c: &mut Composition, t: &mut Tree, sym: u32, text: &str, ctrl: bool, shift: bool) -> Effect {
    c.event(
        t,
        &Event::Key(Key {
            serial: Some(1),
            sym,
            text: text.into(),
            ctrl,
            shift,
            alt: false,
        }),
    )
    .unwrap()
}
#[test]
fn input_has_separate_name_placeholder_text_and_one_tab_stop_and_space_types() {
    let (mut t, id, next) = fixture();
    let mut c = Composition::default();
    let s = t.semantics();
    let n = &s.nodes[&id];
    assert_eq!(n.role, Role::TextInput);
    assert_eq!(n.name, "Font family");
    assert_eq!(n.description, "Search fonts");
    assert_eq!(n.text.as_ref().unwrap().text, "");
    assert!(n.actions.contains(&Action::SetText));
    t.focus(id).unwrap();
    assert_eq!(
        key(&mut c, &mut t, 0x20, " ", false, false),
        Effect::Changed(id)
    );
    assert_eq!(
        key(&mut c, &mut t, 0xff0d, "", false, false),
        Effect::Activated(id)
    );
    key(&mut c, &mut t, 0xff09, "", false, false);
    assert_eq!(t.focused(), Some(next));
    t.focus(id).unwrap();
    key(&mut c, &mut t, 0xff1b, "", false, false);
    assert_eq!(t.search_text(id).unwrap(), "");
}
#[test]
fn unicode_edit_selection_undo_and_canonical_updates_share_one_editor() {
    let (mut t, id, _) = fixture();
    let mut c = Composition::default();
    t.focus(id).unwrap();
    assert_eq!(
        key(&mut c, &mut t, 0, "A👩‍💻e\u{301}", false, false),
        Effect::Changed(id)
    );
    assert_eq!(
        key(&mut c, &mut t, 0xff08, "", false, false),
        Effect::Changed(id)
    );
    assert_eq!(t.search_text(id).unwrap(), "A👩‍💻");
    assert_eq!(
        key(&mut c, &mut t, 0x7a, "", true, false),
        Effect::Changed(id)
    );
    assert_eq!(t.search_text(id).unwrap(), "A👩‍💻e\u{301}");
    assert_eq!(key(&mut c, &mut t, 0x61, "", true, false), Effect::None);
    assert_eq!(
        t.search_request(t.target(id), Request::SetSelection(id, 0..1))
            .unwrap(),
        Effect::None
    );
    assert_eq!(
        t.search_request(t.target(id), Request::SetText(id, "日本語".into()))
            .unwrap(),
        Effect::Changed(id)
    );
    assert_eq!(
        t.search_request(t.target(id), Request::SetText(id, "日本語".into()))
            .unwrap(),
        Effect::None
    );
    assert!(
        t.search_request(t.target(id), Request::SetSelection(id, 1..3))
            .is_err()
    );
    let before = t.semantics().nodes[&id].text.clone();
    assert!(t.set_search_text(id, "invalid\nquery").is_err());
    assert_eq!(t.semantics().nodes[&id].text, before);
    t.set_search_text(id, "alpha beta").unwrap();
    assert_eq!(
        key(&mut c, &mut t, 0xff08, "", true, false),
        Effect::Changed(id)
    );
    assert_eq!(t.search_text(id).unwrap(), "alpha ");
    key(&mut c, &mut t, 0x7a, "", true, false);
    assert_eq!(t.search_text(id).unwrap(), "alpha beta");
}
#[test]
fn hidden_disabled_and_stale_targets_cannot_edit_and_removal_retires_editor() {
    let (mut t, id, _) = fixture();
    let target = t.target(id);
    t.set_disabled(id, true).unwrap();
    assert!(t.search_paste(target, "wrong").is_err());
    t.set_disabled(id, false).unwrap();
    assert!(
        t.search_request(target, Request::SetText(id, "wrong".into()))
            .is_err()
    );
    t.set_hidden(id, true).unwrap();
    assert!(t.search_paste(t.target(id), "wrong").is_err());
    assert!(!t.semantics().nodes.contains_key(&id));
    t.set_hidden(id, false).unwrap();
    t.remove(id).unwrap();
    assert!(t.search_text(id).is_err());
}
#[test]
fn ime_preedit_is_not_committed_text_and_invalid_batches_do_not_mutate() {
    let (mut t, id, next) = fixture();
    let mut c = Composition::default();
    t.focus(id).unwrap();
    t.set_search_text(id, "A").unwrap();
    assert_eq!(
        c.event(
            &mut t,
            &Event::Ime(ImeBatch {
                preedit: Some(("日本".into(), 3, 3)),
                ..Default::default()
            })
        )
        .unwrap(),
        Effect::None
    );
    assert!(t.search_composing(id).unwrap());
    assert!(t.search_composing(next).is_err());
    assert_eq!(t.search_text(id).unwrap(), "A");
    t.semantics().nodes[&id]
        .text
        .as_ref()
        .unwrap()
        .characters()
        .unwrap();
    assert!(
        t.semantics().nodes[&id]
            .text
            .as_ref()
            .unwrap()
            .geometry
            .is_none()
    );
    assert!(
        c.event(
            &mut t,
            &Event::Ime(ImeBatch {
                commit: Some("x\n".into()),
                ..Default::default()
            })
        )
        .is_err()
    );
    assert_eq!(t.search_text(id).unwrap(), "A");
    assert_eq!(
        c.event(
            &mut t,
            &Event::Ime(ImeBatch {
                commit: Some("日本".into()),
                ..Default::default()
            })
        )
        .unwrap(),
        Effect::Changed(id)
    );
    assert_eq!(t.search_text(id).unwrap(), "A日本");
    assert!(
        c.event(
            &mut t,
            &Event::Ime(ImeBatch {
                delete: Some((1, 0)),
                ..Default::default()
            })
        )
        .is_err()
    );
    assert_eq!(t.search_text(id).unwrap(), "A日本");
    c.event(
        &mut t,
        &Event::Ime(ImeBatch {
            preedit: Some(("語".into(), -1, -1)),
            ..Default::default()
        }),
    )
    .unwrap();
    t.focus(next).unwrap();
    assert!(
        t.semantics().nodes[&id]
            .text
            .as_ref()
            .unwrap()
            .geometry
            .is_some()
    );
}
#[test]
fn geometry_scrolls_caret_inside_input_and_pointer_hit_uses_same_layout() {
    let (mut t, id, _) = fixture();
    t.focus(id).unwrap();
    t.set_search_text(id, &"日本語".repeat(100)).unwrap();
    layout(&mut t);
    let input = t.node(id).unwrap().bounds();
    let state = t.search_text_input();
    assert!(state.rect[0] as f32 >= input.x && (state.rect[0] as f32) < input.x + input.width);
    let semantic = t.semantics();
    let geometry = semantic.nodes[&id]
        .text
        .as_ref()
        .unwrap()
        .geometry
        .as_ref()
        .unwrap();
    assert!((geometry.end_caret.x - state.rect[0] as f64).abs() < 1.);
    let click = Point {
        x: input.x + 40.,
        y: input.y + input.height / 2.,
    };
    t.pointer_press(click).unwrap();
    assert_eq!(t.pointer_release(click).unwrap(), Effect::None);
    assert!(t.semantics().nodes[&id].text.as_ref().unwrap().caret < state.cursor);
}
#[test]
fn editor_font_reflow_keeps_preedit_selection_and_undo_and_rejects_invalid_style_atomically() {
    let mut editor = Editor::new(Box::new(backend()), "日本", TextStyle::default(), 500.).unwrap();
    editor.set_caret(6, Affinity::Upstream, false).unwrap();
    editor.insert("語").unwrap();
    editor
        .set_selection(
            Caret::default(),
            Caret {
                offset: 3,
                affinity: Affinity::Upstream,
            },
        )
        .unwrap();
    editor.set_preedit(0..3, "漢", 3).unwrap();
    let text = editor.text().to_owned();
    let selection = editor.selection();
    let preedit = editor.preedit().cloned();
    editor
        .set_style(TextStyle {
            size: 32.,
            ..Default::default()
        })
        .unwrap();
    assert_eq!(editor.text(), text);
    assert_eq!(editor.selection(), selection);
    assert_eq!(editor.preedit().cloned(), preedit);
    let height = editor.layout().measured_size().height;
    assert!(
        editor
            .set_style(TextStyle {
                size: -1.,
                ..Default::default()
            })
            .is_err()
    );
    assert_eq!(editor.layout().measured_size().height, height);
    editor.cancel_preedit().unwrap();
    assert!(editor.undo().unwrap());
    assert_eq!(editor.text(), "日本");
}

#[test]
fn actual_paint_uses_source_background_focus_border_icon_and_selection_without_size_jump() {
    let (mut tree, id, _) = fixture();
    let reference = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../ui/shell/assets/icons/nidara");
    tree.set_icon_theme(nk_icons::Icons::new("", &[], &reference).unwrap());
    let c = |v| nk_render::rgba(v, v, v, 255);
    let paint = |tree: &Tree| {
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
            },
        )
        .unwrap()
    };
    let pixel = |image: &[u8], x: f32, y: f32| {
        let at = (y.floor() as usize * 640 + x.floor() as usize) * 4;
        [image[at + 2], image[at + 1], image[at]]
    };
    let r = tree.node(id).unwrap().bounds();
    let idle = paint(&tree);
    assert_eq!(pixel(&idle, r.x + r.width / 2., r.y), [60; 3]);
    assert_eq!(
        pixel(&idle, r.x + r.width - 25., r.y + r.height / 2.),
        [30; 3]
    );
    assert!(
        (r.x as usize + 13..r.x as usize + 28).any(|x| (r.y as usize..(r.y + r.height) as usize)
            .any(|y| pixel(&idle, x as f32, y as f32) == [150; 3])),
        "missing themed magnifier"
    );
    tree.focus(id).unwrap();
    assert_eq!(pixel(&paint(&tree), r.x + r.width / 2., r.y), [100; 3]);
    tree.set_search_text(id, "Text").unwrap();
    layout(&mut tree);
    tree.search_request(tree.target(id), Request::SetSelection(id, 0..4))
        .unwrap();
    let selected = paint(&tree);
    assert_ne!(selected, idle);
    assert!(
        selected
            .as_chunks::<4>()
            .0
            .iter()
            .any(|p| p[0] > p[1] && p[1] > p[2]),
        "selection accent absent"
    );
    assert_eq!(tree.node(id).unwrap().bounds(), r);
    tree.acknowledge();
    tree.set_active(false);
    assert!(
        tree.invalidation().paint,
        "inactive caret would remain painted"
    );
    assert_ne!(paint(&tree), selected);
    tree.set_active(true);
    let old = tree.node(id).unwrap().bounds();
    let mut invalid = style();
    invalid.min_height = 0.;
    assert!(tree.set_search_style(invalid).is_err());
    layout(&mut tree);
    assert_eq!(tree.node(id).unwrap().bounds(), old);
    tree.set_text_style(TextStyle {
        size: 32.,
        ..Default::default()
    });
    layout(&mut tree);
    assert!(tree.node(id).unwrap().bounds().height > old.height);
    assert_eq!(tree.search_text(id).unwrap(), "Text");
}

#[test]
fn rtl_and_mixed_text_keep_finite_visible_caret_and_valid_committed_geometry() {
    let (mut t, id, _) = fixture();
    t.focus(id).unwrap();
    for value in ["שלום", "مرحبا بالعالم", "abc שלום 日本語"] {
        t.set_search_text(id, value).unwrap();
        layout(&mut t);
        let n = t.node(id).unwrap().bounds();
        let input = t.search_text_input();
        assert!(
            (input.rect[0] as f32) >= n.x && (input.rect[0] as f32) < n.x + n.width,
            "RTL caret outside input"
        );
        let semantics = t.semantics();
        let text = semantics.nodes[&id].text.as_ref().unwrap();
        text.characters().unwrap();
        assert!(
            text.geometry
                .as_ref()
                .unwrap()
                .spans
                .iter()
                .all(|s| s.bounds.x.is_finite() && s.bounds.x.abs() < 10000.)
        );
    }
}
