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
        "--nidara-text-dim": "rgba(255, 255, 255, 0.6)", "--nidara-accent": "#0088FF"}});
    Tokens {
        spacing: Spacing::from_static(&statics()).unwrap(),
        radii: Radii::from_static(&statics()).unwrap(),
        motion: Motion::from_static(&statics()).unwrap(),
        look: Look::from_colors(&set).unwrap(),
        washes: Washes::from_glass(&glass(), true, false).unwrap(),
    }
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

/// The acceptance check of VIEW.md §8: on every card, the icon's centre and the title's
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
    let s = laid(&card("n", LONG, Align::FirstLine), (360., 400.), 1.);
    let body = s.text().get(&Key::from("n/body")).unwrap();
    assert!(body.shown.ends_with('…'), "{:?}", body.shown);
    assert!(body.layout.lines().len() <= 3);
    let tree = s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Window, "NC"), 2);
    // The body is inside the card's control: the control's name speaks for it. A text outside
    // any control is a label with its whole text.
    let s = laid(&Node::text("t", LONG, style(12.)).lines(1), (120., 40.), 1.);
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
    s.button(true);
    assert_eq!(
        s.button(false),
        Some(Activated {
            key: Key::from("n/close"),
            action: "close".into()
        })
    );
    s.button(true);
    s.pointer_motion(pane[0] + 40., pane[1] + 4.);
    assert_eq!(s.button(false), None, "released over another control");
    s.pointer_motion(-10., -10.);
    s.button(true);
    assert_eq!(s.button(false), None);
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
    s.button(true);
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
    assert!(f.panes.iter().all(|(_, p)| p.y < 200.));
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
    assert!(s.tick(&t, &mut text, half));
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
    let a = placed(&s, "a/pane");
    assert!(a.alpha > 0. && a.alpha < 1.);
    let f = s.frame(&t, half);
    let cards = rect(&s, "cards");
    assert!(
        f.panes.iter().all(
            |(_, p)| p.y + p.height <= cards[1] + cards[3] + 1e-9 || p.y >= cards[1] + cards[3]
        )
    );
    assert!(!s.tick(&t, &mut text, t0 + t.motion.slow));
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
    assert!(!s.tick(&t, &mut text, t1 + t.motion.base));
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
    assert!(!s.tick(&t, &mut text, t0 + t.motion.base));
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
