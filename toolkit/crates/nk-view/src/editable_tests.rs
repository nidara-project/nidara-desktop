// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{components::*, *};
use std::time::{Duration, Instant};
fn view(text: &str) -> Node {
    let mut f = EditableField::new(text);
    f.placeholder = "Find text".into();
    f.submit = Some("submit".into());
    f.node("edit", "Query", "changed")
}
fn lay(s: &mut ViewState, n: &Node, width: f64) {
    s.layout(
        n,
        (width, 120.),
        1.,
        crate::tests::tokens().with_types(&crate::tests::types()),
        &mut crate::tests::backend(),
        Instant::now(),
    );
    assert!(
        s.component_errors().is_empty(),
        "{:?}",
        s.component_errors()
    );
}
fn fixture(text: &str) -> ViewState {
    let mut s = ViewState::new(100);
    lay(&mut s, &view(text), 180.);
    s.request(&"edit".into(), false);
    s
}
fn key(s: &mut ViewState, sym: u32, text: &str, ctrl: bool, shift: bool) -> Option<Activated> {
    s.key_event(&nk_wayland::Key {
        serial: None,
        sym,
        text: text.into(),
        ctrl,
        shift,
        alt: false,
    })
    .1
}
fn text(s: &ViewState) -> String {
    match s.typed_value(&"edit".into()).unwrap() {
        Value::Text(s) => s,
        _ => panic!("text"),
    }
}
fn tree(s: &mut ViewState) -> nk_a11y::Tree {
    s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Window, "W"), 2)
}
fn editor_node(s: &mut ViewState) -> nk_a11y::Node {
    tree(s)
        .nodes
        .into_values()
        .find(|n| n.name == "Query")
        .unwrap()
}
fn paste_target(s: &mut ViewState) -> ReplyTarget {
    key(s, 0x76, "", true, false);
    s.take_host_requests()
        .into_iter()
        .find_map(|r| {
            if let HostRequest::Paste { target } = r {
                Some(target)
            } else {
                None
            }
        })
        .unwrap()
}
#[test]
fn editor_keeps_name_placeholder_text_and_space_types_while_enter_submits() {
    let mut s = fixture("");
    let n = editor_node(&mut s);
    assert_eq!(n.role, nk_a11y::Role::TextInput);
    assert_eq!(n.description, "Find text");
    assert!(n.actions.contains(&nk_a11y::Action::SetText));
    let a = key(&mut s, 0x20, " ", false, false).unwrap();
    assert_eq!(
        (a.action, a.value),
        ("changed".into(), Some(Value::Text(" ".into())))
    );
    let a = key(&mut s, 0xff0d, "", false, false).unwrap();
    assert_eq!(a.action, "submit");
    assert_eq!(text(&s), " ");
}
#[test]
fn editor_unicode_selection_word_movement_and_undo_redo_use_one_retained_editor() {
    let mut s = fixture("");
    key(&mut s, 0, "A👩‍💻e\u{301}", false, false);
    key(&mut s, 0xff08, "", false, false);
    assert_eq!(text(&s), "A👩‍💻");
    key(&mut s, 0x7a, "", true, false);
    assert_eq!(text(&s), "A👩‍💻e\u{301}");
    key(&mut s, 0x7a, "", true, true);
    assert_eq!(text(&s), "A👩‍💻");
    s.respond(&"edit".into(), Request::SetText("alpha beta".into()));
    key(&mut s, 0xff57, "", false, false);
    key(&mut s, 0xff08, "", true, false);
    assert_eq!(text(&s), "alpha ");
    key(&mut s, 0x7a, "", true, false);
    key(&mut s, 0xff51, "", true, true);
    let n = editor_node(&mut s);
    assert_ne!(
        n.text.as_ref().unwrap().caret,
        n.text.as_ref().unwrap().anchor
    );
}
#[test]
fn editor_ack_rebuild_preserves_selection_composition_and_undo_but_external_text_replaces() {
    let mut s = fixture("");
    key(&mut s, 0, "alpha", false, false);
    key(&mut s, 0xff51, "", false, true);
    let before = editor_node(&mut s).text.unwrap();
    lay(&mut s, &view("alpha"), 180.);
    let after = editor_node(&mut s).text.unwrap();
    assert_eq!((before.caret, before.anchor), (after.caret, after.anchor));
    s.ime(&nk_wayland::ImeBatch {
        preedit: Some(("語".into(), 3, 3)),
        ..Default::default()
    });
    let input = s.text_input();
    lay(&mut s, &view("alpha"), 180.);
    assert_eq!(s.text_input(), input);
    assert!(editor_node(&mut s).text.unwrap().geometry.is_none());
    lay(&mut s, &view("external"), 180.);
    assert_eq!(text(&s), "external");
    assert!(editor_node(&mut s).text.unwrap().geometry.is_some());
    lay(&mut s, &view("alpha"), 180.);
    assert_eq!(
        text(&s),
        "alpha",
        "a previously acknowledged value is a fresh external replacement"
    );
    key(&mut s, 0x7a, "", true, false);
    assert_eq!(text(&s), "external");
    key(&mut s, 0x7a, "", true, false);
    assert_eq!(text(&s), "alpha");
}
#[test]
fn editor_external_replacement_retires_an_unacknowledged_report() {
    let mut s = fixture("");
    key(&mut s, 0, "alpha", false, false);
    // An app may replace the input without first echoing its reported value.
    lay(&mut s, &view("external"), 180.);
    assert_eq!(text(&s), "external");
    lay(&mut s, &view("alpha"), 180.);
    assert_eq!(text(&s), "alpha");
}
#[test]
fn editor_noop_and_invalid_selections_do_not_activate_or_mutate() {
    let mut s = fixture("日本語");
    assert!(
        s.respond(&"edit".into(), Request::SetText("日本語".into()))
            .is_none()
    );
    assert!(
        s.respond(&"edit".into(), Request::SetSelection(1..3))
            .is_none()
    );
    assert_eq!(text(&s), "日本語");
    let n = editor_node(&mut s);
    assert_eq!(n.text.unwrap().caret, 0);
    s.respond(&"edit".into(), Request::SetSelection(0..3));
    let n = editor_node(&mut s);
    assert_eq!(
        (
            n.text.as_ref().unwrap().anchor,
            n.text.as_ref().unwrap().caret
        ),
        (0, 3)
    );
}
#[test]
fn editor_normalizes_paste_without_losing_unicode_or_undo() {
    for (raw, expected) in [
        ("terminal\n", "terminal"),
        ("日本\r\n語\t👩‍💻\r\n", "日本 語 👩‍💻"),
        ("a\u{85}b\u{2028}c\u{2029}", "a b c"),
        ("a\0b\u{7f}\u{1b}c", "abc"),
        ("a\n\n", "a "),
        (" a  \t", " a   "),
    ] {
        let mut s = fixture("kept");
        s.respond(&"edit".into(), Request::SetSelection(0..4));
        let target = paste_target(&mut s);
        let a = s.reply(&target, Request::Paste(raw.into())).unwrap();
        assert_eq!(a.value, Some(Value::Text(expected.into())), "{raw:?}");
        assert_eq!(text(&s), expected);
        key(&mut s, 0x7a, "", true, false);
        assert_eq!(text(&s), "kept");
    }
}
#[test]
fn editor_normalizes_reader_text_and_reports_only_canonical_changes() {
    let mut s = fixture("old");
    let a = s
        .respond(&"edit".into(), Request::SetText("日本\t語\r\n".into()))
        .unwrap();
    assert_eq!(a.value, Some(Value::Text("日本 語".into())));
    assert!(
        s.respond(
            &"edit".into(),
            Request::Set(Value::Text("日本\t語\n".into()))
        )
        .is_none()
    );
    assert_eq!(text(&s), "日本 語");
    assert_eq!(editor_node(&mut s).text.unwrap().text, "日本 語");
}
#[test]
fn editor_normalizes_model_and_placeholder_without_preparation_errors_or_echo_reset() {
    let mut s = fixture("old");
    let mut f = EditableField::new("日本\r\n語\0\n");
    f.placeholder = "Find\ttext\n".into();
    let node = f.node("edit", "Query", "changed");
    lay(&mut s, &node, 180.);
    assert_eq!(text(&s), "日本 語");
    assert_eq!(editor_node(&mut s).description, "Find text");
    s.respond(&"edit".into(), Request::SetSelection(0..3));
    s.ime(&nk_wayland::ImeBatch {
        preedit: Some(("語".into(), 3, 3)),
        ..Default::default()
    });
    let before = s.text_input();
    lay(&mut s, &node, 180.);
    assert_eq!(s.text_input(), before);
    assert!(editor_node(&mut s).text.unwrap().geometry.is_none());
}
#[test]
fn editor_normalizes_ime_commit_without_changing_preedit_offset_validation() {
    let mut s = fixture("日本");
    key(&mut s, 0xff57, "", false, false);
    s.ime(&nk_wayland::ImeBatch {
        preedit: Some(("仮".into(), 3, 3)),
        ..Default::default()
    });
    let a = s
        .ime(&nk_wayland::ImeBatch {
            commit: Some("語\t終\0\r\n".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(a.value, Some(Value::Text("日本語 終".into())));
    assert!(editor_node(&mut s).text.unwrap().geometry.is_some());
    key(&mut s, 0x7a, "", true, false);
    assert_eq!(text(&s), "日本");
}
#[test]
fn search_normalizes_its_clear_control_visibility_with_the_entry() {
    let mut s = ViewState::new(100);
    lay(
        &mut s,
        &Search {
            field: EditableField::new("\n"),
            name: "Search".into(),
            changed: "search".into(),
            clear_label: "Clear".into(),
            disabled: false,
        }
        .node("search"),
        180.,
    );
    assert_eq!(
        s.typed_value(&"search/input".into()),
        Some(Value::Text(String::new()))
    );
    assert!(s.rect(&"search/clear".into()).is_none());
}
#[test]
fn editor_ime_preedit_cancel_commit_delete_and_invalid_batch_keep_committed_state_separate() {
    let mut s = fixture("alpha");
    key(&mut s, 0xff57, "", false, false);
    assert!(
        s.ime(&nk_wayland::ImeBatch {
            preedit: Some(("語".into(), 3, 3)),
            ..Default::default()
        })
        .is_none()
    );
    assert_eq!(text(&s), "alpha");
    assert!(editor_node(&mut s).text.unwrap().geometry.is_none());
    lay(&mut s, &view("alpha"), 180.);
    assert!(editor_node(&mut s).text.unwrap().geometry.is_none());
    assert!(
        s.ime(&nk_wayland::ImeBatch {
            preedit: Some(("bad\n".into(), 0, 0)),
            commit: Some("X".into()),
            ..Default::default()
        })
        .is_none()
    );
    assert_eq!(text(&s), "alpha");
    assert!(editor_node(&mut s).text.unwrap().geometry.is_none());
    s.ime(&Default::default());
    assert!(editor_node(&mut s).text.unwrap().geometry.is_some());
    assert_eq!(text(&s), "alpha");
    let a = s
        .ime(&nk_wayland::ImeBatch {
            commit: Some("語".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(a.value, Some(Value::Text("alpha語".into())));
    s.ime(&nk_wayland::ImeBatch {
        delete: Some((3, 0)),
        ..Default::default()
    });
    assert_eq!(text(&s), "alpha");
    assert!(
        s.ime(&nk_wayland::ImeBatch {
            delete: Some((99, 0)),
            commit: Some("wrong".into()),
            ..Default::default()
        })
        .is_none()
    );
    assert_eq!(text(&s), "alpha");
}
#[test]
fn editor_copy_cut_paste_are_host_requests_with_the_current_selection() {
    let mut s = fixture("alpha");
    key(&mut s, 0x61, "", true, false);
    assert!(key(&mut s, 0x63, "", true, false).is_none());
    assert!(matches!(s.take_host_requests().as_slice(),[HostRequest::Copy{text}] if text=="alpha"));
    let a = key(&mut s, 0x78, "", true, false).unwrap();
    assert_eq!(a.value, Some(Value::Text(String::new())));
    assert_eq!(text(&s), "");
    s.take_host_requests();
    let target = paste_target(&mut s);
    let a = s.reply(&target, Request::Paste("beta".into())).unwrap();
    assert_eq!(a.value, Some(Value::Text("beta".into())));
    key(&mut s, 0x7a, "", true, false);
    assert_eq!(text(&s), "");
}
#[test]
fn editor_stale_clipboard_replies_cannot_retarget_changed_hidden_disabled_or_recreated_fields() {
    for change in 0..7 {
        let mut s = fixture("alpha");
        let target = paste_target(&mut s);
        match change {
            0 => {
                key(&mut s, 0, "X", false, false);
            }
            1 => lay(&mut s, &view("external"), 180.),
            2 => lay(&mut s, &view("alpha").enabled(false), 180.),
            3 => {
                lay(&mut s, &Node::spacer("gone"), 180.);
                lay(&mut s, &view("alpha"), 180.);
                s.request(&"edit".into(), false);
            }
            4 => {
                lay(
                    &mut s,
                    &Node::button("edit", "Other", "other", nk_text::TextStyle::default()),
                    180.,
                );
            }
            5 => s.blur(),
            _ => {
                lay(&mut s, &Node::reveal("hidden", false, view("alpha")), 180.);
            }
        }
        assert!(
            s.reply(&target, Request::Paste("wrong".into())).is_none(),
            "case {change}"
        );
        assert_ne!(
            s.typed_value(&"edit".into()),
            Some(Value::Text("wrong".into()))
        );
    }
}
#[test]
fn editor_pointer_uses_retained_layout_and_captures_drag_and_double_press_selects_word() {
    let mut s = fixture("alpha beta");
    s.set_double_click_ms(400);
    let r = s.rect(&"edit/viewport".into()).unwrap();
    let pt = (r[0] + 10., r[1] + r[3] / 2.);
    let now = Instant::now();
    s.pointer_motion(pt.0, pt.1);
    s.button(true, now);
    assert_eq!(s.captured(), Some(&Key::from("edit")));
    s.pointer_motion(pt.0 + 25., pt.1);
    s.button(false, now);
    assert!(s.captured().is_none());
    let n = editor_node(&mut s);
    assert_ne!(
        n.text.as_ref().unwrap().anchor,
        n.text.as_ref().unwrap().caret
    );
    s.pointer_motion(pt.0, pt.1);
    s.button(true, now + Duration::from_millis(80));
    s.button(false, now + Duration::from_millis(80));
    let t = editor_node(&mut s).text.unwrap();
    assert_eq!(
        &t.text[t.caret.min(t.anchor)..t.caret.max(t.anchor)],
        "alpha"
    );
}
#[test]
fn editor_scroll_and_rtl_geometry_keep_caret_inside_the_own_viewport() {
    for content in [
        "alpha beta gamma delta epsilon zeta",
        "مرحبا بالعالم שלום abc",
    ] {
        let mut s = fixture(content);
        lay(&mut s, &view(content), 80.);
        key(&mut s, 0xff57, "", false, false);
        let input = s.text_input();
        let r = s.rect(&"edit/viewport".into()).unwrap();
        assert!(input.rect[0] >= r[0].floor() as i32 - 1);
        assert!(input.rect[0] <= (r[0] + r[2]).ceil() as i32);
        let tree = tree(&mut s);
        assert!(tree.validate().is_ok());
        let g = editor_node(&mut s).text.unwrap().geometry.unwrap();
        assert!(
            g.spans
                .iter()
                .all(|p| p.bounds.x.is_finite() && p.bounds.y.is_finite())
        );
    }
}
#[test]
fn editor_font_change_reflows_without_losing_selection_preedit_or_undo() {
    let mut s = fixture("");
    key(&mut s, 0, "alpha", false, false);
    key(&mut s, 0xff51, "", false, true);
    s.ime(&nk_wayland::ImeBatch {
        preedit: Some(("語".into(), 3, 3)),
        ..Default::default()
    });
    let before = editor_node(&mut s).text.unwrap();
    let height = s.text_input().rect[3];
    let t = crate::tests::tokens();
    let ty = crate::tests::types_with(28.);
    s.layout(
        &view("alpha"),
        (180., 120.),
        1.,
        t.with_types(&ty),
        &mut crate::tests::backend(),
        Instant::now(),
    );
    let after = editor_node(&mut s).text.unwrap();
    assert_eq!((before.caret, before.anchor), (after.caret, after.anchor));
    assert!(after.geometry.is_none());
    assert!(s.text_input().rect[3] > height);
    s.ime(&Default::default());
    key(&mut s, 0x7a, "", true, false);
    assert_eq!(text(&s), "");
}
#[test]
fn editor_search_escape_boundary_and_clear_are_composed_through_the_host() {
    let search = |value: &str| {
        Search {
            field: EditableField::new(value),
            name: "Search".into(),
            changed: "search".into(),
            clear_label: "Clear search".into(),
            disabled: false,
        }
        .node("search")
    };
    let mut s = ViewState::new(100);
    lay(&mut s, &search("alpha"), 240.);
    s.request(&"search/input".into(), false);
    s.ime(&nk_wayland::ImeBatch {
        preedit: Some(("語".into(), 3, 3)),
        ..Default::default()
    });
    s.ime(&nk_wayland::ImeBatch {
        commit: Some("語".into()),
        ..Default::default()
    });
    let before = s.typed_value(&"search/input".into());
    assert!(key(&mut s, 0xff1b, "", false, false).is_none());
    assert_eq!(s.typed_value(&"search/input".into()), before);
    let clear = s.rect(&"search/clear".into()).unwrap();
    s.pointer_motion(clear[0] + clear[2] / 2., clear[1] + clear[3] / 2.);
    s.button(true, Instant::now());
    assert!(s.button(false, Instant::now()).is_none());
    for r in s.take_host_requests() {
        match r {
            HostRequest::Respond { owner, request } => {
                let a = s.respond(&owner, request).unwrap();
                assert_eq!(a.action, "search");
                assert_eq!(a.value, Some(Value::Text(String::new())));
            }
            HostRequest::Focus { owner } => {
                s.request(&owner, false);
            }
            _ => {}
        }
    }
    assert_eq!(
        s.typed_value(&"search/input".into()),
        Some(Value::Text(String::new()))
    );
    assert_eq!(s.focus(), Some(&Key::from("search/input")));
    assert!(
        !s.key_event(&nk_wayland::Key {
            serial: None,
            sym: 0xff1b,
            text: String::new(),
            ctrl: false,
            shift: false,
            alt: false
        })
        .0
    );
}
#[test]
fn owner_edited_secret_field_cannot_enter_the_retained_editor_or_input_method() {
    let n = Node::field(
        "secret",
        "Password",
        "secret-edit",
        Field {
            shown: "•••".into(),
            caret: 9,
            anchor: 9,
            secret: true,
        },
        nk_text::TextStyle::default(),
    );
    let mut s = ViewState::new(100);
    lay(&mut s, &n, 180.);
    s.request(&"secret".into(), false);
    assert!(!s.text_input().focused);
    s.ime(&nk_wayland::ImeBatch {
        commit: Some("wrong".into()),
        ..Default::default()
    });
    let n = tree(&mut s)
        .nodes
        .into_values()
        .find(|n| n.name == "Password")
        .unwrap();
    assert_eq!(n.role, nk_a11y::Role::Password);
    assert!(n.text.unwrap().text.is_empty());
}

fn pixels(s: &ViewState) -> Vec<u8> {
    let t = crate::tests::tokens();
    let mut c = nk_render::Canvas::new(180, 120, 1.);
    s.paint(
        &mut c,
        t.with_types(&crate::tests::types()),
        &mut |_: &str, _: f64| None,
        None,
    )
    .unwrap();
    c.finish()
}
#[test]
fn editor_paints_source_chrome_focus_text_selection_and_disabled_ink() {
    let mut s = ViewState::new(100);
    let n = EditableField::new("").node("edit", "Query", "changed");
    lay(&mut s, &n, 180.);
    let rest = pixels(&s);
    assert!(rest.as_chunks::<4>().0.iter().any(|p| p[3] > 0));
    let top = (90 * 4) + 3;
    let alpha = rest[top];
    s.request(&"edit".into(), false);
    let focused = pixels(&s);
    assert!(focused[top] > alpha, "focused source border");
    s.respond(&"edit".into(), Request::SetText("alpha".into()));
    let plain = pixels(&s);
    assert_ne!(focused, plain);
    s.respond(&"edit".into(), Request::SetSelection(0..5));
    let selected = pixels(&s);
    assert!(
        plain.iter().zip(&selected).filter(|(a, b)| a != b).count() > 50,
        "selection is actually painted"
    );
    lay(
        &mut s,
        &EditableField::new("alpha")
            .node("edit", "Query", "changed")
            .enabled(false),
        180.,
    );
    let disabled = pixels(&s);
    assert_ne!(disabled, plain);
}
#[test]
fn disclosure_setting_its_existing_value_is_not_an_activation() {
    let n = Disclosure {
        label: "More".into(),
        expanded: false,
    }
    .header("d", "toggle");
    let mut s = ViewState::new(100);
    lay(&mut s, &n, 180.);
    assert!(s.respond(&"d".into(), Request::Expanded(false)).is_none());
    assert!(
        s.respond(&"d".into(), Request::Set(Value::Bool(false)))
            .is_none()
    );
}

#[test]
fn editor_focus_loss_including_disable_ends_the_finished_composition_boundary() {
    for disable in [false, true] {
        let mut field = EditableField::new("alpha");
        field.escape_clears = true;
        let n = field.node("edit", "Query", "changed");
        let mut s = ViewState::new(100);
        lay(&mut s, &n, 180.);
        s.request(&"edit".into(), false);
        s.ime(&nk_wayland::ImeBatch {
            preedit: Some(("語".into(), 3, 3)),
            ..Default::default()
        });
        s.ime(&nk_wayland::ImeBatch {
            commit: Some("語".into()),
            ..Default::default()
        });
        let current = text(&s);
        if disable {
            let mut field = EditableField::new(current.clone());
            field.escape_clears = true;
            lay(
                &mut s,
                &field.node("edit", "Query", "changed").enabled(false),
                180.,
            );
        } else {
            s.blur();
        }
        let mut field = EditableField::new(current);
        field.escape_clears = true;
        lay(&mut s, &field.node("edit", "Query", "changed"), 180.);
        s.request(&"edit".into(), false);
        assert!(key(&mut s, 0xff1b, "", false, false).is_some());
        assert_eq!(text(&s), "");
    }
}

#[test]
fn editor_reports_unsupported_backend_preparation_and_can_recover() {
    struct NoFork(nk_text::ParleyBackend);
    impl nk_text::TextBackend for NoFork {
        fn name(&self) -> &'static str {
            "no-editor"
        }
        fn layout(
            &mut self,
            text: &str,
            style: &nk_text::TextStyle,
            width: f32,
        ) -> nk_text::Result<nk_text::Layout> {
            self.0.layout(text, style, width)
        }
    }
    let mut s = ViewState::new(100);
    s.layout(
        &view("alpha"),
        (180., 120.),
        1.,
        crate::tests::tokens().with_types(&crate::tests::types()),
        &mut NoFork(crate::tests::backend()),
        Instant::now(),
    );
    assert_eq!(s.component_errors().len(), 1);
    assert_eq!(s.component_errors()[0].0, Key::from("edit"));
    lay(&mut s, &view("alpha"), 180.);
    assert!(s.component_errors().is_empty());
    assert_eq!(text(&s), "alpha");
}

#[test]
fn editor_latest_paste_intent_wins_and_targets_cannot_cross_view_instances() {
    let mut s = fixture("alpha");
    let old = paste_target(&mut s);
    let current = paste_target(&mut s);
    assert!(s.reply(&old, Request::Paste("wrong".into())).is_none());
    assert!(s.reply(&current, Request::Paste("right".into())).is_some());
    let mut other = fixture("alpha");
    let own = paste_target(&mut other);
    assert_eq!(own.revision, old.revision);
    assert_ne!(own.instance, old.instance);
    assert!(other.reply(&old, Request::Paste("wrong".into())).is_none());
    assert!(other.reply(&own, Request::Paste("right".into())).is_some());
}

#[test]
fn search_composes_exactly_one_source_chrome_around_its_entry() {
    let search = Search {
        field: EditableField::new(""),
        name: "Search".into(),
        changed: "changed".into(),
        clear_label: "Clear".into(),
        disabled: false,
    }
    .node("search");
    let mut s = ViewState::new(100);
    lay(&mut s, &search, 180.);
    let r = s.rect(&"search/input/viewport".into()).unwrap();
    let p = pixels(&s);
    let i = (((r[1] + r[3] / 2.) as usize) * 180 + (r[0] + r[2] / 2.) as usize) * 4;
    let alpha = (crate::tests::tokens().entry.background.components[3] * 255.).round() as u8;
    assert_eq!(
        p[i + 3],
        alpha,
        "only the outer search supplies chrome; the retained editor is a composition child"
    );
}

#[test]
fn editor_finishing_a_close_animation_retires_focus_and_cannot_take_hidden_input() {
    let t = crate::tests::tokens();
    let ty = crate::tests::types();
    let mut backend = crate::tests::backend();
    let now = Instant::now();
    let mut s = ViewState::new(100);
    s.layout(
        &Node::reveal("reveal", true, view("alpha")),
        (180., 120.),
        1.,
        t.with_types(&ty),
        &mut backend,
        now,
    );
    s.request(&"edit".into(), false);
    s.ime(&nk_wayland::ImeBatch {
        preedit: Some(("語".into(), 3, 3)),
        ..Default::default()
    });
    s.layout(
        &Node::reveal("reveal", false, view("alpha")),
        (180., 120.),
        1.,
        t.with_types(&ty),
        &mut backend,
        now,
    );
    s.tick(t.with_types(&ty), &mut backend, now + t.motion.base);
    assert!(s.focus().is_none());
    assert!(!s.text_input().focused);
    assert!(key(&mut s, 0x78, "x", false, false).is_none());
    assert!(
        s.ime(&nk_wayland::ImeBatch {
            commit: Some("wrong".into()),
            ..Default::default()
        })
        .is_none()
    );
    assert_eq!(text(&s), "alpha");
}
