// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
use nk_text::{FontSet, ParleyBackend, TextStyle};
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn backend() -> ParleyBackend {
    ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap()
}
fn statics() -> serde_json::Value {
    json!({"scss": {"space-1": "4px", "space-2": "8px", "space-3": "12px", "space-4": "16px",
        "space-5": "20px", "space-6": "24px", "space-8": "32px", "space-10": "40px",
        "ease": "cubic-bezier(0.4, 0, 0.2, 1)", "ease-emphasized": "cubic-bezier(0.2, 0, 0, 1)",
        "dur-fast": "100ms", "dur-base": "180ms", "dur-slow": "260ms"},
        "ts": {"RADIUS": {"xs": 6, "sm": 10, "md": 16, "lg": 24, "xl": 32}}})
}
fn glass() -> serde_json::Value {
    let states = |a: f64| {
        json!({"fadeMs": 150,
            "hover": {"wash": {"r": 1, "g": 1, "b": 1, "a": a}},
            "press": {"wash": {"r": 1, "g": 1, "b": 1, "a": 0.2}},
            "destructiveHover": {"wash": {"r": 0.82, "g": 0.2, "b": 0.22, "a": 0.9}},
            "destructivePress": {"wash": {"r": 0.69, "g": 0.16, "b": 0.18, "a": 0.9}}})
    };
    json!({"variants": [
        {"dark": true, "reduceTransparency": false, "pieces": {"control": [{"states": states(0.08)}]}},
        {"dark": false, "reduceTransparency": false, "pieces": {"control": [{"states": states(0.06)}]}},
    ]})
}
fn tokens() -> Tokens {
    let set = json!({"tokens": {"--nidara-text": "#ffffff", "--nidara-text-secondary": "rgba(255, 255, 255, 0.8)",
        "--nidara-text-dim": "rgba(255, 255, 255, 0.6)", "--nidara-accent": "#0088FF",
        "--nidara-surface-raised": "rgba(255, 255, 255, 0.24)"}});
    Tokens {
        spacing: Spacing::from_static(&statics()).unwrap(),
        radii: Radii::from_static(&statics()).unwrap(),
        motion: Motion::from_static(&statics()).unwrap(),
        look: Look::from_colors(&set).unwrap(),
        washes: Washes::from_glass(&glass(), true, false).unwrap(),
        scrollbar: scrollbar_from(&scrollbar(), &set).unwrap(),
        slider: slider_from(
            &json!({"slider": {"width": 140, "track": 6, "thumbRadius": 9,
            "valueGap": 12, "fillOpacity": 0.9, "pageSteps": 10}}),
        )
        .unwrap(),
    }
}
/// `components.json` `scrollbar`, as `toolkit/tokens/scrollbar.json` exports it.
fn scrollbar() -> serde_json::Value {
    json!({"lane": 12, "thumbRest": 4, "thumbHover": 8, "thumbMin": 28, "edgeClear": 4,
        "cornerClear": 4, "hideMs": 1100, "fadeMs": 250, "widthTauMs": 45, "trackOpacity": 0.18,
        "color": "--nidara-surface-raised", "active": "--nidara-text-dim"})
}
fn style(size: f32) -> TextStyle {
    TextStyle {
        size,
        line_height: 1.3,
        ..TextStyle::default()
    }
}
fn laid(view: &Node, size: (f64, f64), scale: f64) -> ViewState {
    let mut s = ViewState::new(1000);
    s.layout(view, size, scale, &tokens(), &mut backend(), Instant::now());
    s
}
fn rect(s: &ViewState, k: &str) -> Rect {
    s.rect(&Key::from(k))
        .unwrap_or_else(|| panic!("{k} not placed"))
}
fn placed<'a>(s: &'a ViewState, k: &str) -> &'a Placed {
    s.placed().iter().find(|p| p.key == Key::from(k)).unwrap()
}

/// A notification card as the NC pilot will build it: an icon beside a title and a body
/// that wraps, a close button revealed with the card, the whole card a control without wash.
fn card(id: &str, body: &str, align: Align) -> Node {
    let content = Node::row(
        format!("{id}/row"),
        vec![
            Node::icon(format!("{id}/icon"), "nd-app", 32.),
            Node::column(
                format!("{id}/text"),
                vec![
                    Node::text(format!("{id}/title"), "Title", style(14.)),
                    Node::text(format!("{id}/body"), body, style(12.))
                        .lines(3)
                        .ink(Ink::Secondary),
                ],
            )
            .gap(Space::S1)
            .grow(),
            Node::control(
                format!("{id}/close"),
                "Close",
                "close",
                Node::icon(format!("{id}/x"), "nd-window-close", 16.),
            )
            .revealed_with(format!("{id}/pane"))
            .wash(Wash::Destructive),
        ],
    )
    .gap(Space::S3)
    .padding(Padding::symmetric(Space::S3, Space::S4))
    .align(align);
    Node::pane(
        format!("{id}/pane"),
        Corner::Token(Radius::Xl),
        Node::control(format!("{id}/card"), "Open", "open", content)
            .wash(Wash::None)
            .corner(Corner::Token(Radius::Xl)),
    )
}
const LONG: &str = "A body long enough to wrap onto a second and a third line in a card of this width, \
    and then some more words so that it has to be cut with an ellipsis at the end.";

#[test]
fn the_spacing_scale_is_read_whole_and_a_missing_step_is_an_error() {
    let s = Spacing::from_static(&statics()).unwrap();
    assert_eq!(
        Space::ALL.map(|x| s.px(x)),
        [4., 8., 12., 16., 20., 24., 32., 40.]
    );
    let mut v = statics();
    v["scss"].as_object_mut().unwrap().remove("space-8");
    assert!(Spacing::from_static(&v).unwrap_err().contains("space-8"));
    v = statics();
    v["scss"]["space-2"] = json!("0.5rem");
    assert!(Spacing::from_static(&v).is_err());
}

#[test]
fn washes_and_colours_come_from_their_exports() {
    let w = Washes::from_glass(&glass(), true, false).unwrap();
    assert_eq!(w.hover, [1., 1., 1., 0.08]);
    assert_eq!(w.fade_ms, 150);
    assert_eq!(
        Washes::from_glass(&glass(), false, false).unwrap().hover[3],
        0.06
    );
    assert!(
        Washes::from_glass(&glass(), true, true).is_err(),
        "no such variant"
    );
    assert_eq!(
        parse_color("rgba(255, 255, 255, 0.8)").unwrap(),
        nk_render::rgba(255, 255, 255, 204)
    );
    assert_eq!(
        parse_color("#0088FF").unwrap(),
        nk_render::rgba(0, 0x88, 0xff, 255)
    );
    assert!(parse_color("blue").is_err());
}

#[test]
fn a_stack_places_by_gap_padding_justify_spacer_and_grow() {
    let row = |children| {
        Node::row("row", children)
            .gap(Space::S2)
            .padding(Padding::all(Space::S3))
    };
    let s = laid(
        &row(vec![
            Node::icon("a", "nd-a", 16.),
            Node::icon("b", "nd-b", 16.),
        ]),
        (200., 40.),
        1.,
    );
    assert_eq!(rect(&s, "a"), [12., 12., 16., 16.]);
    assert_eq!(rect(&s, "b"), [36., 12., 16., 16.], "a + 16 + gap 8");
    let s = laid(
        &row(vec![
            Node::icon("a", "nd-a", 16.),
            Node::spacer("sp"),
            Node::icon("b", "nd-b", 16.),
        ]),
        (200., 40.),
        1.,
    );
    assert_eq!(
        rect(&s, "b")[0],
        200. - 12. - 16.,
        "the spacer takes what is left"
    );
    let s = laid(
        &row(vec![
            Node::icon("a", "nd-a", 16.),
            Node::icon("b", "nd-b", 16.),
        ])
        .justify(Justify::End),
        (200., 40.),
        1.,
    );
    assert_eq!(rect(&s, "b")[0], 200. - 12. - 16.);
    let s = laid(
        &row(vec![
            Node::icon("a", "nd-a", 16.).grow(),
            Node::icon("b", "nd-b", 16.),
        ]),
        (200., 40.),
        1.,
    );
    assert_eq!(
        rect(&s, "a")[2],
        200. - 24. - 8. - 16.,
        "a grower takes the rest"
    );
    let s = laid(
        &Node::column(
            "col",
            vec![Node::icon("a", "nd-a", 16.), Node::icon("b", "nd-b", 16.)],
        )
        .gap(Space::S4)
        .align(Align::Center),
        (100., 100.),
        1.,
    );
    assert_eq!(rect(&s, "a"), [42., 0., 16., 16.]);
    assert_eq!(rect(&s, "b"), [42., 32., 16., 16.]);
}

/// The acceptance check of VIEW.md §11: on every card, the icon's centre and the title's
/// first line agree to one device pixel, at scale 1 and 1.25. Its control: `Center`.
#[test]
fn first_line_puts_the_icon_level_with_the_title_and_center_does_not() {
    for scale in [1., 1.25] {
        for (align, holds) in [(Align::FirstLine, true), (Align::Center, false)] {
            let s = laid(&card("n", LONG, align), (360., 400.), scale);
            let icon = rect(&s, "n/icon");
            let line = first_line_centre(s.text(), placed(&s, "n/title")).unwrap();
            let off = (icon[1] + icon[3] / 2. - line).abs() * scale;
            assert_eq!(
                off <= 1.,
                holds,
                "scale {scale}, {align:?}: off by {off} device px"
            );
        }
    }
}

#[test]
fn edges_land_on_device_pixels_so_equal_cards_end_on_the_same_pixel() {
    let scale = 1.25;
    let view = Node::column(
        "list",
        vec![
            card("a", "One", Align::FirstLine),
            card("b", "One", Align::FirstLine),
        ],
    )
    .gap(Space::S2)
    .align(Align::Stretch);
    let s = laid(&view, (333.3, 600.), scale);
    for p in s.placed() {
        for v in [
            p.rect[0],
            p.rect[1],
            p.rect[0] + p.rect[2],
            p.rect[1] + p.rect[3],
        ] {
            assert!(
                ((v * scale) - (v * scale).round()).abs() < 1e-6,
                "{:?} edge {v} is off the grid",
                p.key
            );
        }
    }
    let (a, b) = (rect(&s, "a/pane"), rect(&s, "b/pane"));
    assert_eq!((a[0], a[2], a[3]), (b[0], b[2], b[3]));
}

#[test]
fn outside_text_wraps_to_its_lines_and_ends_in_an_ellipsis_keeping_its_whole_text_for_readers() {
    let mut s = laid(&card("n", LONG, Align::FirstLine), (360., 400.), 1.);
    let body = s.text().get(&Key::from("n/body")).unwrap();
    assert!(body.shown.ends_with('…'), "{:?}", body.shown);
    assert!(body.layout.lines().len() <= 3);
    let tree = s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Window, "NC"), 2);
    // The body is inside the card's control: the control's name speaks for it. A text outside
    // any control is a label with its whole text.
    let mut s = laid(&Node::text("t", LONG, style(12.)).lines(1), (120., 40.), 1.);
    assert!(s.text().get(&Key::from("t")).unwrap().shown.ends_with('…'));
    let tree2 = s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Window, "x"), 2);
    assert!(tree2.nodes.values().any(|n| n.name == LONG));
    assert!(
        tree.nodes
            .values()
            .any(|n| n.role == nk_a11y::Role::Button && n.name == "Close")
    );
    assert!(tree.nodes.values().any(|n| n.role == nk_a11y::Role::Panel));
}

#[test]
fn a_text_keeps_its_layout_until_its_string_style_or_width_changes() {
    let mut s = ViewState::new(0);
    let mut text = backend();
    let t = tokens();
    s.layout(
        &card("n", LONG, Align::FirstLine),
        (360., 400.),
        1.,
        &t,
        &mut text,
        Instant::now(),
    );
    let after_first = s.text().shaped;
    s.layout(
        &card("n", LONG, Align::FirstLine),
        (360., 400.),
        1.,
        &t,
        &mut text,
        Instant::now(),
    );
    assert_eq!(
        s.text().shaped,
        after_first,
        "an unchanged view shapes nothing"
    );
    s.layout(
        &card("n", "Short", Align::FirstLine),
        (360., 400.),
        1.,
        &t,
        &mut text,
        Instant::now(),
    );
    assert!(s.text().shaped > after_first, "a new string is shaped");
}

#[test]
fn hover_is_the_innermost_control_and_a_release_outside_cancels() {
    let mut s = laid(&card("n", "Body", Align::FirstLine), (360., 400.), 1.);
    let close = rect(&s, "n/close");
    let pane = rect(&s, "n/pane");
    // Over the card but away from the close: the card.
    s.pointer_motion(pane[0] + 40., pane[1] + 4.);
    assert_eq!(s.hover(), Some(&Key::from("n/card")));
    // The close is revealed now, and it is innermost.
    s.pointer_motion(close[0] + 2., close[1] + 2.);
    assert_eq!(s.hover(), Some(&Key::from("n/close")));
    s.button(true, Instant::now());
    assert_eq!(
        s.button(false, Instant::now()),
        Some(Activated {
            key: Key::from("n/close"),
            action: "close".into()
        })
    );
    s.button(true, Instant::now());
    s.pointer_motion(pane[0] + 40., pane[1] + 4.);
    assert_eq!(
        s.button(false, Instant::now()),
        None,
        "released over another control"
    );
    s.pointer_motion(-10., -10.);
    s.button(true, Instant::now());
    assert_eq!(s.button(false, Instant::now()), None);
}

#[test]
fn a_revealed_control_shows_only_with_its_pane_or_its_focus_and_is_always_in_tab_order() {
    // In a list, so the card is its measured height and the surface goes on below it.
    let mut s = laid(
        &Node::column("list", vec![card("n", "Body", Align::FirstLine)]),
        (360., 400.),
        1.,
    );
    let close = rect(&s, "n/close");
    let i = s
        .placed()
        .iter()
        .position(|p| p.key == Key::from("n/close"))
        .unwrap();
    assert!(!s.shown(i));
    // Below the card: outside its pane, so not shown.
    s.pointer_motion(close[0] + 2., 399.);
    assert!(!s.shown(i));
    s.pointer_motion(close[0] + 2., close[1] + 2.);
    assert!(s.shown(i));
    s.pointer_leave();
    assert!(!s.shown(i));
    assert_eq!(s.hover(), None);
    // Tab reaches it while hidden, and focus reveals it.
    s.key(KeyInput::Tab);
    s.key(KeyInput::Tab);
    assert_eq!(s.focus(), Some(&Key::from("n/close")));
    assert!(s.shown(i));
    assert_eq!(s.key(KeyInput::Activate).unwrap().action, "close");
    s.key(KeyInput::Tab);
    assert_eq!(s.focus(), Some(&Key::from("n/card")), "it wraps");
    s.key(KeyInput::ShiftTab);
    assert_eq!(s.focus(), Some(&Key::from("n/close")));
}

#[test]
fn a_disabled_control_takes_no_hover_and_leaves_the_tab_order() {
    let view = Node::row(
        "r",
        vec![
            Node::control("a", "A", "a", Node::icon("ai", "nd-a", 16.)).enabled(false),
            Node::control("b", "B", "b", Node::icon("bi", "nd-b", 16.)),
        ],
    );
    let mut s = laid(&view, (100., 20.), 1.);
    s.pointer_motion(2., 2.);
    assert_eq!(s.hover(), None);
    s.key(KeyInput::Tab);
    assert_eq!(s.focus(), Some(&Key::from("b")));
    s.key(KeyInput::Tab);
    assert_eq!(s.focus(), Some(&Key::from("b")));
}

#[test]
fn a_card_without_wash_declares_nothing_and_its_close_declares_the_destructive_hover() {
    let mut s = laid(&card("n", "Body", Align::FirstLine), (360., 400.), 1.);
    let tk = tokens();
    let w = tk.washes;
    let f = s.frame(&tk, Instant::now());
    assert_eq!(f.panes.len(), 1);
    assert!(
        f.states.is_empty(),
        "the card has no wash and the close is hidden"
    );
    let pane = rect(&s, "n/pane");
    s.pointer_motion(pane[0] + 40., pane[1] + 4.);
    let f = s.frame(&tk, Instant::now());
    assert_eq!(f.states.len(), 1, "the revealed close, at rest");
    assert_eq!(f.states[0].wash[3], 0.);
    let close = rect(&s, "n/close");
    s.pointer_motion(close[0] + 2., close[1] + 2.);
    let f = s.frame(&tk, Instant::now());
    assert_eq!(f.states[0].wash, w.destructive_hover);
    s.button(true, Instant::now());
    assert_eq!(
        s.frame(&tk, Instant::now()).states[0].wash,
        w.destructive_press
    );
}

#[test]
fn a_pane_never_declares_more_than_eight_washes_and_the_hover_wins_over_markers() {
    let days: Vec<Node> = (0..9)
        .map(|d| {
            Node::control(
                format!("d{d}"),
                format!("{d}"),
                "day",
                Node::icon(format!("i{d}"), "nd-a", 16.),
            )
            .marked(true)
        })
        .collect();
    let view = Node::pane("p", Corner::Token(Radius::Md), Node::row("r", days));
    let mut s = laid(&view, (400., 40.), 1.);
    let tk = tokens();
    let w = tk.washes;
    let lit = |f: &Frame| f.states.iter().filter(|r| r.wash[3] > 0.).count();
    let f = s.frame(&tk, Instant::now());
    assert_eq!(lit(&f), BUDGET, "nine markers, eight shown");
    let last = rect(&s, "d8");
    s.pointer_motion(last[0] + 2., last[1] + 2.);
    let f = s.frame(&tk, Instant::now());
    assert_eq!(lit(&f), BUDGET);
    assert_eq!(f.states[0].wash, w.hover, "the hover is declared first");
    // Hyalo takes the first eight lit regions in order: every lit one precedes every rest one.
    let first_rest = f
        .states
        .iter()
        .position(|r| r.wash[3] == 0.)
        .unwrap_or(f.states.len());
    assert!(f.states[first_rest..].iter().all(|r| r.wash[3] == 0.));
}

#[test]
fn a_hover_that_left_still_counts_while_it_fades() {
    let view = Node::pane(
        "p",
        Corner::Token(Radius::Md),
        Node::row(
            "r",
            (0..9)
                .map(|d| {
                    Node::control(
                        format!("d{d}"),
                        "d",
                        "d",
                        Node::icon(format!("i{d}"), "nd-a", 16.),
                    )
                })
                .collect(),
        ),
    );
    let mut s = laid(&view, (400., 40.), 1.);
    let tk = tokens();
    let t0 = Instant::now();
    let r0 = rect(&s, "d0");
    s.pointer_motion(r0[0] + 2., r0[1] + 2.);
    let lit = s.frame(&tk, t0).states[0].id;
    s.pointer_leave();
    let f = s.frame(&tk, t0);
    assert!(
        f.states.iter().all(|r| r.wash[3] == 0.),
        "it fades in Hyalo, declared at rest"
    );
    // While it fades it is ordered before the rest: it holds one of Hyalo's eight.
    assert_eq!(f.states[0].id, lit);
    let ids = s
        .frame(&tk, t0 + Duration::from_millis(100))
        .states
        .iter()
        .map(|r| r.id)
        .collect::<Vec<_>>();
    assert_eq!(ids[0], lit, "still fading at 100 ms of 150");
    // Once faded, it is at rest like the others, in tree order (d0 is first anyway): check
    // through a later hover on d8 that it no longer takes a place.
    let r8 = rect(&s, "d8");
    s.pointer_motion(r8[0] + 2., r8[1] + 2.);
    let later = s.frame(&tk, t0 + Duration::from_millis(200));
    assert_eq!(later.states.iter().filter(|r| r.wash[3] > 0.).count(), 1);
    assert_eq!(later.states.len(), 9);
}

#[test]
fn region_ids_follow_keys_across_rebuilds_and_states_clear_when_the_control_goes() {
    let mut s = ViewState::new(500);
    let mut text = backend();
    let t = tokens();
    let two = Node::row(
        "r",
        vec![
            Node::control("a", "A", "a", Node::icon("ai", "nd-a", 16.)),
            Node::control("b", "B", "b", Node::icon("bi", "nd-b", 16.)),
        ],
    );
    s.layout(&two, (100., 20.), 1., &t, &mut text, Instant::now());
    let ids = |s: &mut ViewState| {
        s.frame(&t, Instant::now())
            .states
            .iter()
            .map(|r| r.id)
            .collect::<Vec<_>>()
    };
    let before = ids(&mut s);
    assert!(before.iter().all(|&id| id >= 500));
    s.key(KeyInput::Tab);
    s.key(KeyInput::Tab);
    assert_eq!(s.focus(), Some(&Key::from("b")));
    let swapped = Node::row(
        "r",
        vec![
            Node::control("b", "B", "b", Node::icon("bi", "nd-b", 16.)),
            Node::control("a", "A", "a", Node::icon("ai", "nd-a", 16.)),
        ],
    );
    s.layout(&swapped, (100., 20.), 1., &t, &mut text, Instant::now());
    let after = ids(&mut s);
    assert_eq!(before, [after[1], after[0]], "each key kept its id");
    assert_eq!(s.focus(), Some(&Key::from("b")), "focus followed the key");
    s.layout(
        &Node::row(
            "r",
            vec![Node::control("a", "A", "a", Node::icon("ai", "nd-a", 16.))],
        ),
        (100., 20.),
        1.,
        &t,
        &mut text,
        Instant::now(),
    );
    assert_eq!(s.focus(), None);
}

#[test]
fn only_panes_in_the_viewport_are_declared() {
    let view = Node::column(
        "list",
        (0..10)
            .map(|i| card(&format!("c{i}"), "Body", Align::FirstLine))
            .collect(),
    )
    .gap(Space::S2);
    let mut s = laid(&view, (360., 200.), 1.);
    let f = s.frame(&tokens(), Instant::now());
    assert!(
        !f.panes.is_empty() && f.panes.len() < 10,
        "{} panes",
        f.panes.len()
    );
    assert!(f.panes.iter().all(|p| p.pane.y < 200.));
}

#[test]
fn a_view_is_serializable() {
    let v = card("n", "Body", Align::FirstLine);
    let back: Node = serde_json::from_str(&serde_json::to_string(&v).unwrap()).unwrap();
    assert_eq!(back, v);
}

#[test]
fn the_focus_ring_is_painted_only_after_keyboard_focus_and_the_fallback_paints_washes() {
    let view = Node::control("a", "A", "a", Node::icon("ai", "nd-a", 16.)).corner(Corner::Pill);
    let mut s = laid(&view, (40., 40.), 1.);
    let t = tokens();
    let mut none = |_: &str, _: f64| None;
    let paint = |s: &ViewState,
                 fallback: Option<&Frame>,
                 none: &mut dyn FnMut(&str, f64) -> Option<Arc<nk_icons::Icon>>| {
        let mut c = nk_render::Canvas::new(40, 40, 1.);
        s.paint(&mut c, &t, none, fallback).unwrap();
        c.finish().chunks(4).filter(|p| p[3] > 0).count()
    };
    assert_eq!(paint(&s, None, &mut none), 0);
    s.key(KeyInput::Tab);
    assert!(paint(&s, None, &mut none) > 0, "the ring");
    let mut s = laid(&view, (40., 40.), 1.);
    s.pointer_motion(5., 5.);
    let f = s.frame(&t, Instant::now());
    assert_eq!(paint(&s, None, &mut none), 0, "Hyalo draws the hover");
    assert!(
        paint(&s, Some(&f), &mut none) > 0,
        "the D5 fallback draws it"
    );
}

#[test]
fn motion_and_radius_tokens_are_read_from_their_exports() {
    let m = Motion::from_static(&statics()).unwrap();
    assert_eq!(m.base, Duration::from_millis(180));
    assert_eq!(m.slow, Duration::from_millis(260));
    assert_eq!(m.ease.at(0.), 0.);
    assert!((m.ease.at(1.) - 1.).abs() < 1e-9);
    let path: Vec<f64> = (0..=20).map(|i| m.ease.at(i as f64 / 20.)).collect();
    assert!(path.windows(2).all(|w| w[1] >= w[0]), "monotonic");
    assert!(m.ease.at(0.5) > 0.6, "decelerates: {}", m.ease.at(0.5));
    let mut v = statics();
    v["scss"]["dur-base"] = json!("0.18s");
    assert!(Motion::from_static(&v).is_err());
    assert!(Bezier::parse("ease-in").is_err());
    assert_eq!(Radii::from_static(&statics()).unwrap().px(Radius::Xl), 32.);
    assert_eq!(
        Corner::Token(Radius::Xl).of(100., 40., &tokens().radii),
        20.,
        "never past half the side"
    );
}

/// A group: its header, and its cards in a reveal; another card below it.
fn group(open: bool) -> Node {
    Node::column(
        "list",
        vec![
            Node::control(
                "head",
                "Group",
                "toggle",
                Node::text("head/t", "Group", style(13.)),
            ),
            Node::reveal(
                "cards",
                open,
                Node::column(
                    "cards/list",
                    vec![
                        card("a", "One", Align::FirstLine),
                        card("b", "Two", Align::FirstLine),
                    ],
                )
                .gap(Space::S2),
            ),
            card("below", "Three", Align::FirstLine),
        ],
    )
    .gap(Space::S2)
}

#[test]
fn a_reveal_first_seen_takes_its_state_at_once_and_closed_it_hides_its_controls() {
    let t = tokens();
    let mut s = laid(&group(false), (360., 800.), 1.);
    assert!(!s.animating());
    assert_eq!(rect(&s, "cards")[3], 0.);
    let tree = s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Window, "NC"), 2);
    assert_eq!(
        tree.nodes
            .values()
            .filter(|n| n.role == nk_a11y::Role::Panel)
            .count(),
        1,
        "only the card below"
    );
    let f = s.frame(&t, Instant::now());
    assert_eq!(f.panes.len(), 1);
    s.key(KeyInput::Tab);
    s.key(KeyInput::Tab);
    assert_eq!(
        s.focus(),
        Some(&Key::from("below/card")),
        "the hidden cards are not in Tab order"
    );
    let s = laid(&group(true), (360., 800.), 1.);
    assert!(!s.animating());
    assert!(rect(&s, "cards")[3] > 100.);
}

#[test]
fn a_reveal_unrolls_with_the_tokens_and_what_is_below_follows_without_sliding() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(&group(false), (360., 800.), 1., &t, &mut text, t0);
    let below0 = rect(&s, "below/pane")[1];
    s.layout(&group(true), (360., 800.), 1., &t, &mut text, t0);
    assert!(s.animating());
    assert_eq!(rect(&s, "cards")[3], 0., "it starts closed");
    let half = t0 + t.motion.slow / 2;
    assert!(s.tick(&t, &mut text, half).animating);
    let mid = rect(&s, "cards")[3];
    let full = rect(&s, "cards/list")[3];
    assert!(mid > 0. && mid < full, "{mid} of {full}");
    assert!(
        mid > full / 2.,
        "ease-emphasized is past half at half time: {mid} of {full}"
    );
    // The card below follows the reveal, frame by frame: it is the reveal's height lower.
    assert_eq!(rect(&s, "below/pane")[1], below0 + mid);
    // Content is clipped and fading: a pane cut by the reveal is declared cut.
    let a = placed(&s, "a/pane").alpha;
    assert!(a > 0. && a < 1.);
    let f = s.frame(&t, half);
    // Declared whole, cut straight where the reveal ends, its glass as formed as its content.
    let cards = rect(&s, "cards");
    let b = rect(&s, "b/pane");
    assert!(
        b[1] < cards[1] + cards[3] && b[1] + b[3] > cards[1] + cards[3],
        "b is cut"
    );
    let fb = f
        .panes
        .iter()
        .find(|p| p.key == Key::from("b/pane"))
        .unwrap();
    assert_eq!(fb.pane.height, b[3]);
    assert_eq!(fb.opacity, a);
    let cut = fb
        .clip
        .expect("a pane cut by the reveal is declared with its clip");
    assert_eq!(cut[1] + cut[3], cards[1] + cards[3]);
    let below = f
        .panes
        .iter()
        .find(|p| p.key == Key::from("below/pane"))
        .unwrap();
    assert_eq!((below.clip, below.opacity), (None, 1.));
    assert!(!s.tick(&t, &mut text, t0 + t.motion.slow).animating);
    assert_eq!(rect(&s, "cards")[3], full);
    assert_eq!(placed(&s, "a/pane").alpha, 1.);
}

#[test]
fn a_reveal_turned_back_midway_eases_from_where_it_is() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(&group(false), (360., 800.), 1., &t, &mut text, t0);
    s.layout(&group(true), (360., 800.), 1., &t, &mut text, t0);
    let t1 = t0 + t.motion.slow / 2;
    s.tick(&t, &mut text, t1);
    let mid = rect(&s, "cards")[3];
    s.layout(&group(false), (360., 800.), 1., &t, &mut text, t1);
    assert_eq!(rect(&s, "cards")[3], mid, "no jump");
    s.tick(&t, &mut text, t1 + t.motion.base / 2);
    let closing = rect(&s, "cards")[3];
    assert!(closing < mid && closing > 0.);
    assert!(!s.tick(&t, &mut text, t1 + t.motion.base).animating);
    assert_eq!(rect(&s, "cards")[3], 0.);
}

#[test]
fn a_pane_the_model_moved_slides_from_where_it_was_drawn() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    let list = |ids: &[&str]| {
        Node::column(
            "list",
            ids.iter()
                .map(|i| card(i, "Body", Align::FirstLine))
                .collect(),
        )
        .gap(Space::S2)
    };
    s.layout(&list(&["a", "b"]), (360., 800.), 1., &t, &mut text, t0);
    let was = rect(&s, "b/pane");
    let close_was = rect(&s, "b/close");
    s.layout(&list(&["b"]), (360., 800.), 1., &t, &mut text, t0);
    assert_eq!(rect(&s, "b/pane"), was, "drawn where it was");
    assert_eq!(rect(&s, "b/close"), close_was, "with what is in it");
    s.tick(&t, &mut text, t0 + t.motion.base / 2);
    let mid = rect(&s, "b/pane")[1];
    assert!(mid > 0. && mid < was[1], "{mid}");
    assert!(!s.tick(&t, &mut text, t0 + t.motion.base).animating);
    assert_eq!(rect(&s, "b/pane")[1], 0.);
}

#[test]
fn with_reduced_motion_everything_lands_at_once() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    s.set_reduced_motion(true);
    let t0 = Instant::now();
    s.layout(&group(false), (360., 800.), 1., &t, &mut text, t0);
    s.layout(&group(true), (360., 800.), 1., &t, &mut text, t0);
    assert!(!s.animating());
    assert!(rect(&s, "cards")[3] > 100.);
}

fn swipeable(id: &str) -> Node {
    let mut n = card(id, "Body", Align::FirstLine);
    if let Kind::Pane(p) = &mut n.kind {
        let c = std::mem::replace(&mut *p.child, Node::spacer("_"));
        *p.child = c.swipe("dismiss");
    }
    n
}
fn swipe_list(ids: &[&str]) -> Node {
    Node::column("list", ids.iter().map(|i| swipeable(i)).collect()).gap(Space::S2)
}
/// A point on the card's body, away from its close button.
fn on_card(s: &ViewState, id: &str) -> (f64, f64) {
    let r = rect(s, &format!("{id}/pane"));
    (r[0] + 60., r[1] + r[3] / 2.)
}

#[test]
fn a_card_swiped_past_the_threshold_leaves_and_is_reported_when_gone() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(
        &swipe_list(&["a", "b"]),
        (360., 800.),
        1.,
        &t,
        &mut text,
        t0,
    );
    let (a0, b0) = (rect(&s, "a/pane"), rect(&s, "b/pane"));
    let placed_before_title = rect(&s, "a/title")[0];
    let (x, y) = on_card(&s, "a");
    s.pointer_motion(x, y);
    s.button(true, t0);
    assert_eq!(s.press(), Some(&Key::from("a/card")));
    s.pointer_motion(x + 5., y);
    assert_eq!(rect(&s, "a/pane"), a0, "not a swipe yet");
    assert!(s.pointer_motion(x + 60., y + 2.));
    assert_eq!(s.press(), None, "the swipe cancels the press");
    assert_eq!(rect(&s, "a/pane")[0], a0[0] + 60.);
    assert_eq!(
        rect(&s, "a/title")[0],
        placed_before_title + 60.,
        "with all it holds"
    );
    let alpha = placed(&s, "a/title").alpha;
    assert!(alpha < 1. && alpha > 0.5, "{alpha}");
    assert_eq!(rect(&s, "b/pane"), b0, "the others stay");
    s.pointer_motion(x + 120., y);
    assert_eq!(s.button(false, t0), None, "the release opens nothing");
    assert!(s.animating());
    let mid = s.tick(&t, &mut text, t0 + t.motion.base / 2);
    assert!(mid.animating && mid.activated.is_empty());
    let xm = rect(&s, "a/pane")[0];
    assert!(xm > a0[0] + 120. && xm < 360., "{xm}");
    let end = s.tick(&t, &mut text, t0 + t.motion.base);
    assert_eq!(
        end.activated,
        vec![Activated {
            key: Key::from("a/card"),
            action: "dismiss".into()
        }]
    );
    assert_eq!(
        placed(&s, "a/pane").alpha,
        0.,
        "gone until the model drops it"
    );
    let f = s.frame(&t, t0 + t.motion.base);
    assert!(f.panes.iter().all(|p| p.key != Key::from("a/pane")));
    // The model drops it: the card below slides up from where it was drawn.
    let t1 = t0 + t.motion.base;
    s.layout(&swipe_list(&["b"]), (360., 800.), 1., &t, &mut text, t1);
    assert_eq!(rect(&s, "b/pane"), b0);
    assert!(!s.tick(&t, &mut text, t1 + t.motion.base).animating);
    assert_eq!(rect(&s, "b/pane")[1], a0[1]);
}

#[test]
fn a_swipe_short_of_the_threshold_settles_back() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(&swipe_list(&["a"]), (360., 800.), 1., &t, &mut text, t0);
    let a0 = rect(&s, "a/pane");
    let (x, y) = on_card(&s, "a");
    s.pointer_motion(x, y);
    s.button(true, t0);
    s.pointer_motion(x - 50., y);
    assert_eq!(rect(&s, "a/pane")[0], a0[0] - 50.);
    assert_eq!(s.button(false, t0), None);
    let end = s.tick(&t, &mut text, t0 + t.motion.base);
    assert!(!end.animating && end.activated.is_empty());
    assert_eq!(rect(&s, "a/pane"), a0);
    assert_eq!(placed(&s, "a/title").alpha, 1.);
}

#[test]
fn a_drag_more_down_than_across_stays_a_press() {
    let mut s = laid(&swipe_list(&["a"]), (360., 800.), 1.);
    let a0 = rect(&s, "a/pane");
    let (x, y) = on_card(&s, "a");
    s.pointer_motion(x, y);
    s.button(true, Instant::now());
    s.pointer_motion(x + 10., y + 20.);
    assert_eq!(rect(&s, "a/pane"), a0);
    assert_eq!(
        s.button(false, Instant::now()),
        Some(Activated {
            key: Key::from("a/card"),
            action: "open".into()
        })
    );
}

#[test]
fn a_press_on_a_button_inside_the_card_never_swipes() {
    let mut s = laid(&swipe_list(&["a"]), (360., 800.), 1.);
    let a0 = rect(&s, "a/pane");
    let (x, y) = on_card(&s, "a");
    s.pointer_motion(x, y);
    let c = rect(&s, "a/close");
    let (cx, cy) = (c[0] + c[2] / 2., c[1] + c[3] / 2.);
    s.pointer_motion(cx, cy);
    assert_eq!(s.hover(), Some(&Key::from("a/close")));
    s.button(true, Instant::now());
    s.pointer_motion(cx - 100., cy);
    assert_eq!(rect(&s, "a/pane"), a0);
    assert_eq!(s.button(false, Instant::now()), None);
}

#[test]
fn the_drag_resists_past_its_free_travel() {
    let mut s = laid(&swipe_list(&["a"]), (360., 800.), 1.);
    let a0 = rect(&s, "a/pane");
    let (x, y) = on_card(&s, "a");
    s.pointer_motion(x, y);
    s.button(true, Instant::now());
    s.pointer_motion(x + 300., y);
    // 140 px follow freely, then 15 % of the other 160: 164, on the pixel grid.
    assert_eq!(rect(&s, "a/pane")[0], a0[0] + 164.);
    let alpha = placed(&s, "a/title").alpha;
    assert!((alpha - (1. - 164. / 320.)).abs() < 1e-9, "{alpha}");
}

#[test]
fn with_reduced_motion_a_fling_is_reported_on_release() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    s.set_reduced_motion(true);
    let t0 = Instant::now();
    s.layout(&swipe_list(&["a"]), (360., 800.), 1., &t, &mut text, t0);
    let (x, y) = on_card(&s, "a");
    s.pointer_motion(x, y);
    s.button(true, t0);
    s.pointer_motion(x + 100., y);
    assert_eq!(
        s.button(false, t0),
        Some(Activated {
            key: Key::from("a/card"),
            action: "dismiss".into()
        })
    );
    assert!(!s.animating());
    assert_eq!(placed(&s, "a/pane").alpha, 0.);
}

#[test]
fn frame_groups_share_a_group_per_clip_and_opacity() {
    let t = tokens();
    let mut s = laid(&swipe_list(&["a", "b"]), (360., 800.), 1.);
    let f = s.frame(&t, Instant::now());
    let tone = nk_wayland::Tone {
        saturation: 1.,
        ceiling: 1.,
        lift: 0.,
        gain: 1.,
        wash: [0.; 4],
        ambient: 0.,
        ambient_lift: 0.,
        ambient_gain: 0.,
    };
    let shadow = nk_wayland::Shadow {
        opacity_small: 0.,
        opacity_large: 0.,
        blur_small: 0.,
        blur_large: 0.,
        offset: 0.,
    };
    let g = f.groups(tone, shadow);
    assert_eq!(g.len(), 1);
    assert_eq!(g[0].shapes.len(), 2);
    assert!(g[0].clip.is_none() && g[0].opacity == 1.);
}

fn feed_of(rows: Vec<Node>) -> Node {
    Node::column(
        "page",
        vec![
            Node::text("head", "Notifications", style(14.)),
            Node::scroll("feed", Node::column("list", rows).gap(Space::S2)),
        ],
    )
    .gap(Space::S2)
}
fn feed(n: usize) -> Node {
    feed_of(
        (0..n)
            .map(|i| card(&format!("c{i}"), "Body", Align::FirstLine))
            .collect(),
    )
}
/// Ticks every 16 ms from `from` until nothing moves (at most 3 s); returns when it stopped.
fn settle(s: &mut ViewState, t: &Tokens, text: &mut ParleyBackend, from: Instant) -> Instant {
    let mut now = from;
    while s.animating() && now < from + Duration::from_secs(3) {
        now += Duration::from_millis(16);
        s.tick(t, text, now);
    }
    now
}
fn offset(s: &ViewState) -> f64 {
    s.window(&Key::from("feed")).unwrap().0
}

#[test]
fn a_scroll_region_takes_its_content_height_and_gives_it_up_when_its_column_runs_short() {
    let roomy = laid(&feed(10), (360., 2000.), 1.);
    let content = 10. * rect(&roomy, "c0/pane")[3] + 9. * 8.;
    assert_eq!(
        rect(&roomy, "feed")[3],
        content,
        "with room, as tall as its content"
    );
    let s = laid(&feed(10), (360., 400.), 1.);
    let feed = rect(&s, "feed");
    assert_eq!(
        feed[1] + feed[3],
        400.,
        "short of room, it takes what the column leaves"
    );
    assert_eq!(rect(&s, "head")[1], 0., "and the rest keeps its place");
    assert_eq!(s.window(&Key::from("feed")), Some((0., feed[3])));
    assert!(matches!(placed(&s, "feed").what, What::Scroll { content: c, .. } if c == content));
    // What lies past the viewport is cut away: not declared, not hit.
    let mut s = s;
    let f = s.frame(&tokens(), Instant::now());
    assert!(f.panes.iter().all(|p| p.pane.y < 400.));
    let last = f.panes.last().unwrap();
    assert_eq!(
        last.clip.map(|c| c[1] + c[3]),
        Some(400.),
        "a card the viewport cuts is cut straight"
    );
}

#[test]
fn the_wheel_scrolls_the_region_under_the_pointer_within_its_content() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(&feed(10), (360., 400.), 1., &t, &mut text, t0);
    let (h, c0) = (rect(&s, "feed")[3], rect(&s, "c0/pane"));
    let content = match placed(&s, "feed").what {
        What::Scroll { content, .. } => content,
        _ => unreachable!(),
    };
    assert!(
        !s.scroll(ScrollBy::Pixels(100.)),
        "no pointer, nothing scrolls"
    );
    s.pointer_motion(5., 5.);
    assert!(
        !s.scroll(ScrollBy::Pixels(100.)),
        "the header does not scroll"
    );
    s.pointer_motion(60., 200.);
    assert!(!s.scroll(ScrollBy::Pixels(-100.)), "already at the top");
    assert!(s.scroll(ScrollBy::Pixels(100.)));
    assert!(s.animating(), "laid out at the next tick");
    s.tick(&t, &mut text, t0 + Duration::from_millis(16));
    assert_eq!(rect(&s, "c0/pane")[1], c0[1] - 100.);
    assert_eq!(offset(&s), 100.);
    // A detent is the viewport's height to the 2/3, as GTK's.
    assert!(s.scroll(ScrollBy::Steps(1.)));
    s.tick(&t, &mut text, t0 + Duration::from_millis(32));
    assert_eq!(offset(&s), (100. + h.powf(2. / 3.)).round());
    assert!(s.scroll(ScrollBy::Pixels(1e6)));
    s.tick(&t, &mut text, t0 + Duration::from_millis(48));
    assert_eq!(offset(&s), content - h, "never past its content");
    assert!(!s.scroll(ScrollBy::Pixels(10.)), "already at the end");
    // Hover follows what moved under the pointer.
    let under = s
        .placed()
        .iter()
        .filter(|p| matches!(p.what, What::Control(_)) && p.key.0.ends_with("/card"))
        .find(|p| {
            p.visible()
                .is_some_and(|r| r[1] <= 200. && 200. < r[1] + r[3])
        })
        .map(|p| p.key.clone());
    assert_eq!(s.hover().cloned(), under);
}

#[test]
fn page_keys_move_the_focused_region_and_tab_scrolls_the_focus_into_view() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(&feed(10), (360., 400.), 1., &t, &mut text, t0);
    let feed = rect(&s, "feed");
    // Tab walks card, close, card, close...: the ninth stop is c4's card, below the view.
    for _ in 0..9 {
        s.key(KeyInput::Tab);
    }
    assert_eq!(s.focus(), Some(&Key::from("c4/card")));
    let now = settle(&mut s, &t, &mut text, t0);
    let r = rect(&s, "c4/card");
    assert_eq!(
        r[1] + r[3],
        feed[1] + feed[3],
        "scrolled by as little as shows it"
    );
    let at = offset(&s);
    s.key(KeyInput::PageDown);
    let now = settle(&mut s, &t, &mut text, now);
    assert_eq!(offset(&s), (at + 0.9 * feed[3]).round());
    s.key(KeyInput::End);
    let now = settle(&mut s, &t, &mut text, now);
    let content = match placed(&s, "feed").what {
        What::Scroll { content, .. } => content,
        _ => unreachable!(),
    };
    assert_eq!(offset(&s), content - feed[3]);
    s.key(KeyInput::PageUp);
    let now = settle(&mut s, &t, &mut text, now);
    assert_eq!(offset(&s), (content - feed[3] - 0.9 * feed[3]).round());
    s.key(KeyInput::Home);
    settle(&mut s, &t, &mut text, now);
    assert_eq!(offset(&s), 0.);
    // Shift+Tab back to c0's card: already in view, nothing moves.
    s.key(KeyInput::Tab);
    assert_eq!(offset(&s), 0.);
}

#[test]
fn the_bar_shows_on_scroll_hides_after_its_delay_and_its_lane_takes_presses_and_drags() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(&feed(20), (360., 400.), 1., &t, &mut text, t0);
    let feed = rect(&s, "feed");
    let lane = (feed[0] + feed[2] - 6., feed[1] + feed[3] - 20.);
    // Hidden, the lane is the content's: a press there presses the card under it.
    s.pointer_leave();
    let now = settle(&mut s, &t, &mut text, t0);
    s.pointer_motion(lane.0, lane.1);
    let now = settle(&mut s, &t, &mut text, now);
    s.pointer_leave();
    let now = settle(&mut s, &t, &mut text, now);
    s.pointer_motion(lane.0, lane.1);
    s.button(true, now);
    assert!(
        s.press().is_some(),
        "motion over the region reveals it from the next tick only"
    );
    s.button(false, now);
    // Shown (motion over the region revealed it), the lane takes the press: it jumps there
    // and presses nothing below.
    s.tick(&t, &mut text, now + Duration::from_millis(16));
    let now = now + Duration::from_millis(16);
    s.button(true, now);
    assert_eq!(s.press(), None);
    let now = now + Duration::from_millis(16);
    s.tick(&t, &mut text, now);
    let jumped = offset(&s);
    assert!(jumped > 0., "a press low on the track jumps down");
    // It drags from there, the thumb following the pointer.
    s.pointer_motion(lane.0, lane.1 - 50.);
    let now = now + Duration::from_millis(16);
    s.tick(&t, &mut text, now);
    assert!(offset(&s) < jumped, "dragging up scrolls up");
    assert_eq!(s.hover(), None, "the lane keeps its hover from the content");
    assert_eq!(s.button(false, now), None);
    // Off the region, it fades after its delay; then the lane is the content's again.
    s.pointer_leave();
    let gone = settle(&mut s, &t, &mut text, now);
    assert!(
        gone - now >= Duration::from_millis(1100),
        "{:?}",
        gone - now
    );
    assert!(gone - now < Duration::from_millis(1100 + 250 + 64));
    let y = s
        .placed()
        .iter()
        .filter(|p| p.key.0.ends_with("/card"))
        .find_map(|p| {
            p.visible()
                .filter(|r| r[3] == p.rect[3])
                .map(|r| r[1] + r[3] / 2.)
        })
        .unwrap();
    s.pointer_motion(lane.0, y);
    s.button(true, gone);
    assert!(s.press().is_some());
}

#[test]
fn a_rebuild_keeps_the_first_card_in_view_where_it_was() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(&feed(10), (360., 400.), 1., &t, &mut text, t0);
    s.pointer_motion(60., 200.);
    s.scroll(ScrollBy::Pixels(200.));
    let now = settle(&mut s, &t, &mut text, t0);
    let first = s
        .placed()
        .iter()
        .filter(|p| matches!(p.what, What::Pane(_)))
        .find(|p| p.visible().is_some())
        .map(|p| (p.key.clone(), p.rect))
        .unwrap();
    // A notification arrives at the top while the reader is down the list.
    let mut rows = vec![card("new", "Body", Align::FirstLine)];
    rows.extend((0..10).map(|i| card(&format!("c{i}"), "Body", Align::FirstLine)));
    s.layout(&feed_of(rows), (360., 400.), 1., &t, &mut text, now);
    assert_eq!(s.rect(&first.0), Some(first.1), "what was read stays put");
    assert_eq!(offset(&s), 200. + rect(&s, "new/pane")[3] + 8.);
    s.tick(&t, &mut text, now + t.motion.base / 2);
    assert_eq!(s.rect(&first.0), Some(first.1), "and nothing slides");
    // At the top, a new card pushes the list down as it always did.
    let mut s = ViewState::new(0);
    s.layout(&feed(3), (360., 400.), 1., &t, &mut text, now);
    let c0 = rect(&s, "c0/pane");
    let mut rows = vec![card("new", "Body", Align::FirstLine)];
    rows.extend((0..3).map(|i| card(&format!("c{i}"), "Body", Align::FirstLine)));
    s.layout(&feed_of(rows), (360., 400.), 1., &t, &mut text, now);
    assert_eq!(offset(&s), 0.);
    let later = settle(&mut s, &t, &mut text, now);
    assert!(later > now);
    assert!(rect(&s, "c0/pane")[1] > c0[1]);
}

#[test]
fn placeholders_stand_in_for_rows_outside_the_window_at_the_height_they_had() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(&feed(30), (360., 400.), 1., &t, &mut text, t0);
    let whole = placed(&s, "feed").what.clone();
    let heights: Vec<f64> = (0..30)
        .map(|i| rect(&s, &format!("c{i}/pane"))[3])
        .collect();
    // The surface builds what its window shows and keeps the rest's heights.
    let (top, h) = s.window(&Key::from("feed")).unwrap();
    let mut y = 0.;
    let rows: Vec<Node> = (0..30)
        .map(|i| {
            let shown = y < top + h && y + heights[i] > top;
            y += heights[i] + 8.;
            if shown {
                card(&format!("c{i}"), "Body", Align::FirstLine)
            } else {
                Node::placeholder(format!("c{i}/pane"), heights[i])
            }
        })
        .collect();
    let built = rows
        .iter()
        .filter(|n| matches!(n.kind, Kind::Pane(_)))
        .count();
    assert!(built < 10, "{built} built");
    s.layout(&feed_of(rows), (360., 400.), 1., &t, &mut text, t0);
    assert!(
        matches!((placed(&s, "feed").what.clone(), whole), (What::Scroll { content: a, .. }, What::Scroll { content: b, .. }) if a == b),
        "the content keeps its height"
    );
    assert_eq!(rect(&s, "c29/pane")[3], heights[29]);
    assert!(
        s.text().get(&Key::from("c29/title")).is_none(),
        "nothing unbuilt is shaped"
    );
}

#[test]
fn a_scroll_region_is_a_scroll_pane_holding_its_cards() {
    let mut s = laid(&feed(3), (360., 400.), 1.);
    let tree = s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Panel, "NC"), 2);
    let (&pane_id, _) = tree
        .nodes
        .iter()
        .find(|(_, n)| n.role == nk_a11y::Role::ScrollPane)
        .expect("a scroll pane");
    let held = &tree.nodes[&pane_id].children;
    assert_eq!(held.len(), 3);
    assert!(
        held.iter()
            .all(|id| tree.nodes[id].role == nk_a11y::Role::Panel)
    );
}

/// A card as TS built it: its content, and over it the close at its top-left corner and an
/// action column at its right edge, centred, as `Gtk.Overlay` layers.
fn floating(id: &str, layers: bool) -> Node {
    let content = Node::row(
        format!("{id}/row"),
        vec![
            // Under the close, as the app's icon was in TS.
            Node::control(
                format!("{id}/app"),
                "App",
                "app",
                Node::icon(format!("{id}/icon"), "nd-app", 32.),
            ),
            Node::text(format!("{id}/title"), "Title", style(14.)).grow(),
        ],
    )
    .gap(Space::S3)
    .padding(Padding::symmetric(Space::S3, Space::S4))
    .align(Align::FirstLine);
    let mut body = Node::overlay(format!("{id}/over"), content);
    if layers {
        body = body
            .layer(
                Align::Start,
                Align::Start,
                Padding::all(Space::S1),
                Node::control(
                    format!("{id}/close"),
                    "Close",
                    "close",
                    Node::icon(format!("{id}/x"), "nd-window-close", 16.),
                )
                .revealed_with(format!("{id}/pane"))
                .wash(Wash::Destructive),
            )
            .layer(
                Align::End,
                Align::Center,
                Padding {
                    right: Some(Space::S3),
                    ..Padding::default()
                },
                Node::control(
                    format!("{id}/reply"),
                    "Reply",
                    "reply",
                    Node::text(format!("{id}/reply-label"), "Reply", style(12.)),
                ),
            )
            .layer(
                Align::Stretch,
                Align::End,
                Padding::default(),
                Node::text(format!("{id}/strip"), "", style(1.)),
            );
    }
    // In a list, so the card takes the height it measures.
    Node::column(
        "list",
        vec![Node::pane(
            format!("{id}/pane"),
            Corner::Token(Radius::Xl),
            Node::control(format!("{id}/card"), "Open", "open", body).wash(Wash::None),
        )],
    )
}

#[test]
fn an_overlay_is_the_size_of_its_base_and_places_each_layer_by_its_alignment_and_inset() {
    let plain = laid(&floating("n", false), (360., 400.), 1.);
    let s = laid(&floating("n", true), (360., 400.), 1.);
    let pane = rect(&s, "n/pane");
    assert!(pane[3] < 400., "measured, not the surface's height");
    assert_eq!(pane, rect(&plain, "n/pane"), "layers never add to the size");
    assert_eq!(
        rect(&s, "n/row"),
        rect(&plain, "n/row"),
        "nor move the base"
    );
    let close = rect(&s, "n/close");
    assert_eq!(
        [close[0], close[1]],
        [pane[0] + 4., pane[1] + 4.],
        "the close over the top-left corner"
    );
    assert_eq!(close[2], 16.);
    let reply = rect(&s, "n/reply");
    assert_eq!(
        reply[0] + reply[2],
        pane[0] + pane[2] - 12.,
        "at the right edge"
    );
    assert!(
        ((reply[1] + reply[3] / 2.) - (pane[1] + pane[3] / 2.)).abs() <= 0.5,
        "centred down"
    );
    let strip = rect(&s, "n/strip");
    assert_eq!(
        [strip[0], strip[2], strip[1] + strip[3]],
        [pane[0], pane[2], pane[1] + pane[3]],
        "stretched across, at the bottom"
    );
}

#[test]
fn a_layer_is_over_its_base_for_the_pointer_and_after_it_in_the_tab_order() {
    let mut s = laid(&floating("n", true), (360., 400.), 1.);
    let (close, app) = (rect(&s, "n/close"), rect(&s, "n/app"));
    let both = crate::layout::intersect(close, app).expect("the close overlaps the icon");
    s.pointer_motion(both[0] + both[2] / 2., both[1] + both[3] / 2.);
    assert_eq!(
        s.hover(),
        Some(&Key::from("n/close")),
        "the close, not the app's icon under it"
    );
    let pane = rect(&s, "n/pane");
    s.pointer_motion(pane[0] + 100., pane[1] + pane[3] / 2.);
    assert_eq!(s.hover(), Some(&Key::from("n/card")));
    let order: Vec<Key> = (0..4)
        .filter_map(|_| {
            s.key(KeyInput::Tab);
            s.focus().cloned()
        })
        .collect();
    assert_eq!(
        order,
        ["n/card", "n/app", "n/close", "n/reply"]
            .map(Key::from)
            .to_vec(),
        "base first, then the layers in order"
    );
    let v = floating("n", true);
    let back: Node = serde_json::from_str(&serde_json::to_string(&v).unwrap()).unwrap();
    assert_eq!(back, v);
}

#[test]
fn a_wheel_scrolls_by_its_detents_and_a_touchpad_by_its_pixels() {
    use nk_wayland::ScrollAmount;
    // Hyalo's wheel: 15 px and one detent (axis_value120 of 120) per notch.
    let wheel = ScrollAmount {
        pixels: 15.,
        detents: Some(1.),
    };
    assert_eq!(ScrollBy::from(wheel), ScrollBy::Steps(1.));
    assert_eq!(
        ScrollBy::from(ScrollAmount::pixels(15.)),
        ScrollBy::Pixels(15.)
    );
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(&feed(10), (360., 400.), 1., &t, &mut text, t0);
    let h = rect(&s, "feed")[3];
    s.pointer_motion(60., 200.);
    s.scroll(wheel.into());
    s.tick(&t, &mut text, t0 + Duration::from_millis(16));
    assert_eq!(
        offset(&s),
        h.powf(2. / 3.).round(),
        "a notch is GTK's step, not 15 px"
    );
}

#[test]
fn a_view_laid_in_bounds_answers_in_surface_coordinates() {
    let view = Node::column("list", vec![card("a", "Body", Align::FirstLine)]);
    let t = tokens();
    let mut s = ViewState::new(1000);
    s.layout_in(
        &view,
        [600., 40., 360., 400.],
        1.,
        &t,
        &mut backend(),
        Instant::now(),
    );
    let pane = rect(&s, "a/pane");
    assert_eq!((pane[0], pane[1], pane[2]), (600., 40., 360.));
    // The pointer is in surface coordinates: the card is under it there, not at the origin.
    s.pointer_motion(620., 60.);
    assert_eq!(s.hover(), Some(&Key::from("a/card")));
    s.pointer_motion(20., 20.);
    assert_eq!(s.hover(), None);
    // The regions are declared where the view lies.
    let f = s.frame(&t, Instant::now());
    assert_eq!(f.panes.len(), 1);
    assert_eq!((f.panes[0].pane.x, f.panes[0].pane.y), (600., 40.));
}

#[test]
fn a_readers_request_finds_its_control_by_semantic_id() {
    let view = Node::column(
        "list",
        vec![
            card("a", "Body", Align::FirstLine),
            card("b", "Body", Align::FirstLine),
        ],
    )
    .gap(Space::S2);
    let mut s = laid(&view, (360., 600.), 1.);
    let root = nk_a11y::Node::new(1, nk_a11y::Role::Panel, "Centre");
    let tree = s.semantics(root, 100);
    let keys = s.semantic_keys();
    // Every id the map names is a button in the tree, by the same name, and every button is
    // in the map.
    let buttons: Vec<_> = tree
        .nodes
        .values()
        .filter(|n| n.role == nk_a11y::Role::Button)
        .collect();
    assert_eq!(buttons.len(), keys.len());
    for n in buttons {
        let key = &keys[&n.id];
        assert!(
            key.0.ends_with("/card") || key.0.ends_with("/close"),
            "{key:?}"
        );
        assert_eq!(
            n.name,
            if key.0.ends_with("/card") {
                "Open"
            } else {
                "Close"
            }
        );
    }
    let close = keys
        .iter()
        .find(|(_, k)| k.0 == "b/close")
        .map(|(id, _)| *id)
        .unwrap();
    assert_eq!(
        s.request(&keys[&close], true),
        Some(Activated {
            key: Key::from("b/close"),
            action: "close".into()
        })
    );
    assert_eq!(s.request(&Key::from("b/close"), false), None);
    assert_eq!(s.focus(), Some(&Key::from("b/close")));
    assert_eq!(
        s.request(&Key::from("b/pane"), true),
        None,
        "a pane is not a control"
    );
}

#[test]
fn a_weight_without_a_face_falls_back_to_regular_and_is_never_dropped() {
    // The test fonts carry no bold face of Noto Sans: weight 700 cannot be shaped as asked.
    let bold = TextStyle {
        weight: 700.,
        ..style(13.)
    };
    use nk_text::TextBackend;
    assert!(
        backend().layout("Title", &bold, 200.).is_err(),
        "the control needs no bold face"
    );
    let view = Node::row(
        "head",
        vec![
            Node::text("title", "Title", bold.clone()).lines(1).grow(),
            Node::text("label", "Month", bold),
        ],
    );
    let s = laid(&view, (300., 100.), 1.);
    for k in ["title", "label"] {
        let r = rect(&s, k);
        assert!(r[2] > 0. && r[3] > 10., "{k}: {r:?}");
    }
}

#[test]
fn a_semantic_id_stays_with_its_node_when_the_view_changes_around_it() {
    // A reader holds ids between updates, and nk-a11y refuses an id that comes back as
    // another role: a rebuild that drops a card before another must not renumber it.
    let list = |keys: &[&str]| {
        Node::column(
            "list",
            keys.iter()
                .map(|k| card(k, "Body", Align::FirstLine))
                .collect(),
        )
        .gap(Space::S2)
    };
    let mut s = laid(&list(&["a", "b"]), (360., 600.), 1.);
    let root = || nk_a11y::Node::new(1, nk_a11y::Role::Panel, "Centre");
    let first = s.semantics(root(), 100);
    let ids = |s: &ViewState| {
        s.semantic_keys()
            .into_iter()
            .map(|(id, k)| (k, id))
            .collect::<std::collections::HashMap<_, _>>()
    };
    let before = ids(&s);
    s.layout(
        &list(&["b"]),
        (360., 600.),
        1.,
        &tokens(),
        &mut backend(),
        Instant::now(),
    );
    let second = s.semantics(root(), 100);
    let after = ids(&s);
    assert_eq!(after[&Key::from("b/close")], before[&Key::from("b/close")]);
    assert_eq!(after[&Key::from("b/card")], before[&Key::from("b/card")]);
    let mut snapshot = nk_a11y::Snapshot::default();
    snapshot.accept(first).unwrap();
    snapshot.accept(second).expect("no id changes role");
}

#[test]
fn a_cascade_flings_the_shown_cards_top_to_bottom_and_reports_once_when_the_last_is_gone() {
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(
        &swipe_list(&["a", "b", "c"]),
        (360., 800.),
        1.,
        &t,
        &mut text,
        t0,
    );
    let at_rest: Vec<_> = ["a", "b", "c"]
        .iter()
        .map(|k| rect(&s, &format!("{k}/pane")))
        .collect();
    let stagger = Duration::from_millis(45);
    // Named bottom first: the cascade still starts at the top.
    let keys: Vec<Key> = ["c/card", "b/card", "a/card"]
        .iter()
        .map(|k| Key::from(*k))
        .collect();
    assert_eq!(s.cascade(&keys, stagger, "clear-all", t0), None);
    assert!(s.animating());
    let t1 = t0 + stagger / 2;
    let first = s.tick(&t, &mut text, t1);
    assert!(first.activated.is_empty());
    assert!(
        rect(&s, "a/pane")[0] > at_rest[0][0],
        "the top one has left"
    );
    assert_eq!(rect(&s, "b/pane"), at_rest[1], "the next waits its turn");
    assert_eq!(rect(&s, "c/pane"), at_rest[2]);
    let t2 = t0 + t.motion.base;
    assert!(
        s.tick(&t, &mut text, t2).activated.is_empty(),
        "only the last reports"
    );
    assert_eq!(placed(&s, "a/pane").alpha, 0., "and the first stays gone");
    let end = s.tick(&t, &mut text, t0 + stagger * 2 + t.motion.base);
    assert_eq!(
        end.activated,
        vec![Activated {
            key: Key::from("c/card"),
            action: "clear-all".into()
        }]
    );
    for k in ["a", "b", "c"] {
        assert_eq!(placed(&s, &format!("{k}/pane")).alpha, 0., "{k}");
    }
    assert!(!end.animating);
}

#[test]
fn a_cascade_with_nothing_shown_or_reduced_motion_reports_at_once() {
    let t = tokens();
    let mut text = backend();
    let t0 = Instant::now();
    let stagger = Duration::from_millis(45);
    let mut s = ViewState::new(0);
    s.layout(&swipe_list(&["a"]), (360., 800.), 1., &t, &mut text, t0);
    let gone = s.cascade(&[Key::from("nowhere")], stagger, "clear-all", t0);
    assert_eq!(gone.map(|a| a.action), Some("clear-all".into()));
    s.set_reduced_motion(true);
    let at_once = s.cascade(&[Key::from("a/card")], stagger, "clear-all", t0);
    assert_eq!(
        at_once,
        Some(Activated {
            key: Key::from("a/card"),
            action: "clear-all".into()
        })
    );
    assert!(!s.animating());
    assert_eq!(placed(&s, "a/pane").alpha, 0.);
}

#[test]
fn a_reserved_text_is_as_tall_as_its_lines_however_few_it_fills() {
    let body = |id: &str, words: &str| {
        Node::text(format!("{id}/body"), words, style(12.))
            .lines(2)
            .reserve(2)
    };
    let s = laid(
        &Node::column(
            "list",
            vec![
                body("short", "One line"),
                body("long", LONG),
                Node::text("plain/body", "One line", style(12.)).lines(2),
            ],
        ),
        (360., 800.),
        1.,
    );
    let (short, long, plain) = (
        rect(&s, "short/body"),
        rect(&s, "long/body"),
        rect(&s, "plain/body"),
    );
    assert_eq!(short[3], long[3], "one height whatever the text");
    assert!(
        short[3] >= plain[3] * 2. - 1.,
        "two lines: {} vs {}",
        short[3],
        plain[3]
    );
}

#[test]
fn a_text_hidden_with_its_pane_hides_on_hover_and_focus_and_keeps_its_room() {
    let row = |id: &str| {
        let pane = format!("{id}/pane");
        Node::pane(
            pane.clone(),
            Corner::Token(Radius::Xl),
            Node::control(
                format!("{id}/card"),
                "Open",
                "open",
                Node::overlay(
                    format!("{id}/slot"),
                    Node::text(format!("{id}/age"), "12m", style(11.)).hidden_with(pane.clone()),
                )
                .layer(
                    Align::Center,
                    Align::Center,
                    Padding::default(),
                    Node::control(
                        format!("{id}/more"),
                        "Show more",
                        "more",
                        Node::icon(format!("{id}/chevron"), "nd-pan-down", 13.),
                    )
                    .revealed_with(pane),
                ),
            )
            .wash(Wash::None),
        )
    };
    let mut s = laid(&Node::column("list", vec![row("n")]), (360., 400.), 1.);
    let index = |s: &ViewState, k: &str| {
        s.placed()
            .iter()
            .position(|p| p.key == Key::from(k))
            .unwrap()
    };
    let (age, more) = (index(&s, "n/age"), index(&s, "n/more"));
    let room = rect(&s, "n/age");
    assert!(
        s.shown(age) && !s.shown(more),
        "at rest: the age, not the chevron"
    );
    let r = rect(&s, "n/pane");
    assert!(
        s.pointer_motion(r[0] + 2., r[1] + 2.),
        "the swap is a change to draw"
    );
    assert!(
        !s.shown(age) && s.shown(more),
        "hovered: the chevron in its place"
    );
    assert_eq!(rect(&s, "n/age"), room, "and the age keeps its room");
    s.pointer_leave();
    assert!(s.shown(age));
    s.key(KeyInput::Tab);
    assert!(!s.shown(age), "focus inside hides it too");
}

#[test]
fn a_controls_description_reaches_its_reader() {
    let view = Node::column(
        "list",
        vec![
            Node::control(
                "a",
                "Summary",
                "open",
                Node::text("a/t", "Summary", style(13.)),
            )
            .description("2 min, the body"),
        ],
    );
    let mut s = laid(&view, (360., 600.), 1.);
    let tree = s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Panel, "Centre"), 100);
    let button = tree
        .nodes
        .values()
        .find(|n| n.role == nk_a11y::Role::Button)
        .unwrap();
    assert_eq!(
        (button.name.as_str(), button.description.as_str()),
        ("Summary", "2 min, the body")
    );
    // A flung card stays out of a second cascade.
    let t = tokens();
    let mut text = backend();
    let mut s = ViewState::new(0);
    let t0 = Instant::now();
    s.layout(&swipe_list(&["a"]), (360., 800.), 1., &t, &mut text, t0);
    let keys = [Key::from("a/card")];
    let stagger = Duration::from_millis(45);
    assert_eq!(s.cascade(&keys, stagger, "clear", t0), None);
    s.tick(&t, &mut text, t0 + t.motion.base);
    assert_eq!(
        s.cascade(&keys, stagger, "again", t0 + t.motion.base)
            .map(|a| a.action),
        Some("again".into()),
        "nothing left to fling: it reports at once"
    );
    assert!(!s.animating());
}

/// A pane holding a 0–100 slider, 220 wide with a 16 px inset, at `value`.
fn slider_view(value: f64) -> Node {
    Node::pane(
        "p",
        Corner::Token(Radius::Lg),
        Node::column(
            "c",
            vec![
                Node::slider(
                    "vol",
                    "Volume",
                    "volume",
                    Slider::new(0., 100., 1., value).unit(" %"),
                ),
                Node::control("b", "Mute", "mute", Node::text("b/t", "Mute", style(12.))),
            ],
        )
        .padding(Padding::all(Space::S4)),
    )
}
/// The x where a 0–100 slider's thumb centre stands at `value`.
fn slider_x(s: &ViewState, value: f64) -> f64 {
    let r = rect(s, "vol");
    r[0] + 9. + value / 100. * (r[2] - 18.)
}

#[test]
fn a_slider_takes_the_value_under_the_pointer_and_holds_it_until_release() {
    let t = tokens();
    let mut s = laid(&slider_view(20.), (360., 400.), 1.);
    let r = rect(&s, "vol");
    assert_eq!(r[3], 18., "as tall as its thumb");
    let y = r[1] + r[3] / 2.;
    let vol = Key::from("vol");
    s.pointer_motion(slider_x(&s, 60.), y);
    let a = s
        .button(true, Instant::now())
        .expect("the press changes it");
    assert_eq!((a.key.0.as_str(), a.action.as_str()), ("vol", "volume"));
    assert_eq!(s.value(&vol), Some(60.));
    // Dragged, each change is reported; past the end it stops at the end.
    assert!(s.pointer_motion(slider_x(&s, 75.), y + 40.));
    assert_eq!(s.slid().map(|a| a.key), Some(vol.clone()));
    assert_eq!(s.value(&vol), Some(75.));
    assert!(s.slid().is_none(), "asked once");
    s.pointer_motion(r[0] + r[2] + 200., y);
    assert_eq!(s.value(&vol), Some(100.));
    // A rebuild with the model's older value does not move what the pointer holds.
    s.layout(
        &slider_view(20.),
        (360., 400.),
        1.,
        &t,
        &mut backend(),
        Instant::now(),
    );
    assert_eq!(s.value(&vol), Some(100.));
    // Released, it reports once more, and the view's value counts again.
    let a = s
        .button(false, Instant::now())
        .expect("the release reports");
    assert_eq!(a.key, vol);
    s.layout(
        &slider_view(100.),
        (360., 400.),
        1.,
        &t,
        &mut backend(),
        Instant::now(),
    );
    assert_eq!(s.value(&vol), Some(100.));
    s.pointer_motion(slider_x(&s, 10.), y);
    assert!(s.slid().is_none(), "no longer held");
    assert_eq!(s.value(&vol), Some(100.));
}

#[test]
fn a_focused_slider_steps_with_the_keys_and_stops_at_its_ends() {
    // Each key is reported from the view's value, the model's, which the surface writes back
    // before the next key, as ccdetail does today.
    let vol = Key::from("vol");
    let key = |v: f64, k| {
        let mut s = laid(&slider_view(v), (360., 400.), 1.);
        s.key(KeyInput::Tab);
        assert_eq!(s.focus(), Some(&vol));
        let a = s.key(k)?;
        assert_eq!((&a.key, a.action.as_str()), (&vol, "volume"));
        s.value(&vol)
    };
    for (k, to) in [
        (KeyInput::Right, 51.),
        (KeyInput::Up, 51.),
        (KeyInput::Left, 49.),
        (KeyInput::PageUp, 60.),
        (KeyInput::PageDown, 40.),
        (KeyInput::LineStart, 0.),
        (KeyInput::LineEnd, 100.),
    ] {
        assert_eq!(key(50., k), Some(to), "{k:?}");
    }
    // The value a key set holds until the surface rebuilds, so the next key steps from it.
    let mut s = laid(&slider_view(50.), (360., 400.), 1.);
    s.key(KeyInput::Tab);
    s.key(KeyInput::Right);
    s.key(KeyInput::Right);
    assert_eq!(s.value(&vol), Some(52.));
    assert_eq!(key(0., KeyInput::Left), None, "at its start");
    assert_eq!(key(100., KeyInput::LineEnd), None, "at its end");
    // With the button focused, the arrows leave the slider alone.
    let mut s = laid(&slider_view(50.), (360., 400.), 1.);
    s.key(KeyInput::Tab);
    s.key(KeyInput::Tab);
    assert_eq!(s.focus(), Some(&Key::from("b")));
    assert!(s.key(KeyInput::Right).is_none());
}

#[test]
fn a_reader_hears_a_slider_and_sets_its_value() {
    let mut s = laid(&slider_view(40.), (360., 400.), 1.);
    let tree = s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Panel, "root"), 10);
    let n = tree.nodes.values().find(|n| n.name == "Volume").unwrap();
    assert_eq!(n.role, nk_a11y::Role::Slider);
    let v = n.value.as_ref().unwrap();
    assert_eq!((v.min, v.max, v.current, v.step), (0., 100., 40., 1.));
    assert_eq!(v.text, "40 %");
    assert!(n.actions.contains(&nk_a11y::Action::SetValue));
    let vol = Key::from("vol");
    assert_eq!(s.semantic_keys().get(&n.id), Some(&vol));
    assert_eq!(
        s.request_value(&vol, 62.4).map(|a| a.key),
        Some(vol.clone())
    );
    assert_eq!(s.value(&vol), Some(62.), "on a step");
    let s0 = laid(&slider_view(40.), (360., 400.), 1.);
    let mut s = s0;
    assert!(s.request_value(&vol, 40.).is_none(), "its value already");
}

#[test]
fn a_sliders_hover_lights_its_thumb_not_its_track() {
    let t = tokens();
    let mut s = laid(&slider_view(50.), (360., 400.), 1.);
    let r = rect(&s, "vol");
    s.pointer_motion(r[0] + 2., r[1] + r[3] / 2.);
    assert_eq!(
        s.hover(),
        Some(&Key::from("vol")),
        "the whole track takes the pointer"
    );
    let frame = s.frame(&t, Instant::now());
    let lit: Vec<_> = frame.states.iter().filter(|st| st.wash[3] > 0.).collect();
    assert_eq!(lit.len(), 1);
    let b = lit[0].bounds;
    let centre = slider_x(&s, 50.);
    assert_eq!((b.width, b.height), (18., 18.));
    assert!((b.x + 9. - centre).abs() < 1e-9, "{b:?}");
    assert_eq!(lit[0].radius, 9.);
}

fn field_view(shown: &str, caret: usize, anchor: usize, secret: bool) -> Node {
    Node::pane(
        "p",
        Corner::Token(Radius::Lg),
        Node::column(
            "c",
            vec![
                Node::field(
                    "pw",
                    "Password",
                    "join",
                    Field {
                        shown: shown.into(),
                        caret,
                        anchor,
                        secret,
                    },
                    style(13.),
                ),
                Node::control("b", "Join", "join", Node::text("b/t", "Join", style(12.))),
            ],
        )
        .padding(Padding::all(Space::S4)),
    )
}

#[test]
fn a_press_on_a_field_types_into_it_and_activates_nothing() {
    let mut s = laid(&field_view("ab", 2, 2, false), (360., 400.), 1.);
    let r = rect(&s, "pw");
    s.pointer_motion(r[0] + 4., r[1] + r[3] / 2.);
    assert!(s.button(true, Instant::now()).is_none());
    assert!(s.button(false, Instant::now()).is_none(), "a release activates nothing");
    let pw = Key::from("pw");
    assert_eq!(s.editing(), Some(&pw));
    // Enter is its action.
    let a = s.key(KeyInput::Activate).expect("Enter");
    assert_eq!((a.key, a.action.as_str()), (pw.clone(), "join"));
    // A press elsewhere ends the typing.
    let b = rect(&s, "b");
    s.pointer_motion(b[0] + 2., b[1] + b[3] / 2.);
    s.button(true, Instant::now());
    assert!(s.editing().is_none());
}

#[test]
fn a_fields_caret_stands_after_the_text_it_follows() {
    let mut s = laid(&field_view("abc", 0, 0, false), (360., 400.), 1.);
    let pw = Key::from("pw");
    let at0 = s.caret(&pw).expect("a caret");
    let text = rect(&s, "pw/text");
    assert!((at0[0] - text[0]).abs() < 0.5, "{at0:?} {text:?}");
    assert_eq!(at0[2], 1.);
    s = laid(&field_view("abc", 3, 3, false), (360., 400.), 1.);
    let at3 = s.caret(&pw).unwrap();
    assert!(at3[0] > at0[0] + 10., "{at0:?} {at3:?}");
    assert!(s.selection(&pw).is_empty());
    s = laid(&field_view("abc", 3, 1, false), (360., 400.), 1.);
    let sel = s.selection(&pw);
    assert_eq!(sel.len(), 1);
    assert!(sel[0][0] > at0[0] && (sel[0][0] + sel[0][2] - at3[0]).abs() < 0.5);
}

#[test]
fn a_reader_hears_a_secret_field_as_a_password_with_no_text() {
    let mut s = laid(&field_view("•••", 9, 9, true), (360., 400.), 1.);
    let tree = s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Panel, "root"), 10);
    let n = tree.nodes.values().find(|n| n.name == "Password").unwrap();
    assert_eq!(n.role, nk_a11y::Role::Password);
    let t = n.text.as_ref().unwrap();
    assert_eq!((t.text.as_str(), t.caret), ("", 0));
    assert!(n.actions.contains(&nk_a11y::Action::SetText));
    let mut s = laid(&field_view("me", 2, 0, false), (360., 400.), 1.);
    let tree = s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Panel, "root"), 10);
    let n = tree.nodes.values().find(|n| n.name == "Password").unwrap();
    assert_eq!(n.role, nk_a11y::Role::TextInput);
    let t = n.text.as_ref().unwrap();
    assert_eq!((t.text.as_str(), t.caret, t.anchor), ("me", 2, 0));
}
