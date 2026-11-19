// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::components::LongList;
use crate::{components::*, *};
use std::{cell::RefCell, time::Instant};
#[derive(Default)]
struct Source {
    built: RefCell<Vec<usize>>,
    metadata: RefCell<Vec<usize>>,
    generation: usize,
}
impl ListSource for Source {
    fn item(&self, i: usize) -> RowInfo {
        self.metadata.borrow_mut().push(i);
        RowInfo {
            key: format!("record-{i}").into(),
            name: format!("Row {i} generation {}", self.generation),
        }
    }
    fn build(&self, i: usize, key: &Key) -> Node {
        self.built.borrow_mut().push(i);
        Node::text(
            format!("{}/label", key.0),
            format!("Row {i}"),
            Default::default(),
        )
    }
}
fn lay(
    s: &mut ViewState,
    source: &Source,
    count: usize,
    selected: usize,
    enabled: bool,
) -> Vec<ReplyTarget> {
    let mut list = LongList::new(count, selected, 32.);
    list.activate = Some("open".into());
    let n = list
        .node(
            "list",
            "Records",
            "select",
            s.window(&LongList::scroll_key(&"list".into())),
            source,
        )
        .enabled(enabled);
    s.layout(
        &n,
        (320., 256.),
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
    s.take_host_requests()
        .into_iter()
        .filter_map(|r| match r {
            HostRequest::Rebuild { target } => Some(target),
            _ => None,
        })
        .collect()
}
fn settle(s: &mut ViewState, source: &Source, count: usize, selected: usize, enabled: bool) {
    for _ in 0..5 {
        if lay(s, source, count, selected, enabled).is_empty() {
            return;
        }
    }
    panic!("range rebuild did not converge");
}
fn fixture(count: usize, selected: usize) -> (ViewState, Source) {
    let mut s = ViewState::new(100);
    let source = Source::default();
    settle(&mut s, &source, count, selected, true);
    s.request(&"list".into(), false);
    (s, source)
}
fn tree(s: &mut ViewState) -> nk_a11y::Tree {
    s.semantics(nk_a11y::Node::new(1, nk_a11y::Role::Window, "Test"), 2)
}
#[test]
fn long_list_builds_only_viewport_and_overscan_for_five_thousand_rows() {
    let (mut s, source) = fixture(5000, 0);
    assert!(source.built.borrow().len() < 24);
    assert_eq!(
        s.rect(&"list/item/record-0/label".into()).unwrap()[0],
        crate::tests::tokens().list.inset + crate::tests::tokens().spacing.px(Space::S2)
    );
    let count = s.placed().len();
    assert!(count < 80, "{count} nodes");
    assert!(s.rect(&"list/item/record-0".into()).is_some());
    source.built.borrow_mut().clear();
    assert!(s.scroll_region(
        &LongList::scroll_key(&"list".into()),
        ScrollBy::Pixels(32. * 2000.)
    ));
    settle(&mut s, &source, 5000, 0, true);
    assert!(source.built.borrow().len() < 24);
    assert!(
        source
            .built
            .borrow()
            .iter()
            .all(|i| (1999..2010).contains(i))
    );
    assert!(s.placed().len() <= count + 8);
    let t = tree(&mut s);
    assert_eq!(
        t.nodes
            .values()
            .find(|n| n.role == nk_a11y::Role::ListBox)
            .unwrap()
            .attributes["setsize"],
        "5000"
    );
    let options: Vec<_> = t
        .nodes
        .values()
        .filter(|n| n.role == nk_a11y::Role::Option)
        .collect();
    assert_eq!(options.iter().filter(|n| n.states.selected).count(), 1);
    assert!(
        options
            .iter()
            .any(|n| n.states.selected && n.states.offscreen)
    );
    assert!(options.iter().all(|n| n.attributes["setsize"] == "5000"));
}
#[test]
fn long_list_end_home_and_pages_select_and_reveal_before_rebuild() {
    let (mut s, source) = fixture(5000, 0);
    let a = s.key(KeyInput::End).unwrap();
    assert_eq!(a.value, Some(Value::Index(4999)));
    assert_eq!(a.action, "select");
    assert_eq!(
        s.scroll_offset(&LongList::scroll_key(&"list".into())),
        Some(160000. - 256.)
    );
    settle(&mut s, &source, 5000, 4999, true);
    assert!(s.rect(&"list/item/record-4999".into()).is_some());
    assert!(s.key(KeyInput::End).is_none());
    assert_eq!(
        s.key(KeyInput::PageUp).unwrap().value,
        Some(Value::Index(4991))
    );
    settle(&mut s, &source, 5000, 4991, true);
    assert_eq!(s.key(KeyInput::Home).unwrap().value, Some(Value::Index(0)));
    settle(&mut s, &source, 5000, 0, true);
    assert_eq!(
        s.scroll_offset(&LongList::scroll_key(&"list".into())),
        Some(0.)
    );
    assert!(s.key(KeyInput::Up).is_none());
    assert_eq!(
        s.key(KeyInput::PageDown).unwrap().value,
        Some(Value::Index(8))
    );
}
#[test]
fn long_list_open_is_distinct_from_selection_and_space_does_not_open() {
    let (mut s, _) = fixture(100, 0);
    assert_eq!(s.key(KeyInput::Activate).unwrap().action, "open");
    assert!(
        s.key_event(&nk_wayland::Key {
            serial: None,
            sym: 0x20,
            text: " ".into(),
            ctrl: false,
            shift: false,
            alt: false
        })
        .1
        .is_none()
    );
    assert_eq!(
        s.respond(&"list".into(), Request::Set(Value::Index(20)))
            .unwrap()
            .action,
        "select"
    );
    assert!(
        s.respond(&"list".into(), Request::Set(Value::Index(100)))
            .is_none()
    );
}
#[test]
fn long_list_offscreen_selection_metadata_is_fresh_without_building_content() {
    let (mut s, mut source) = fixture(5000, 0);
    s.scroll_region(
        &LongList::scroll_key(&"list".into()),
        ScrollBy::Pixels(32000.),
    );
    settle(&mut s, &source, 5000, 0, true);
    source.generation = 1;
    source.built.borrow_mut().clear();
    source.metadata.borrow_mut().clear();
    settle(&mut s, &source, 5000, 0, true);
    assert!(!source.built.borrow().contains(&0));
    assert_eq!(
        source.metadata.borrow().iter().filter(|i| **i == 0).count(),
        1
    );
    let t = tree(&mut s);
    let selected = t
        .nodes
        .values()
        .find(|n| n.role == nk_a11y::Role::Option && n.states.selected)
        .unwrap();
    assert_eq!(selected.name, "Row 0 generation 1");
    assert_eq!(selected.attributes["posinset"], "1");
}
#[test]
fn long_list_disabled_still_materializes_and_stale_range_replies_are_retired() {
    let mut s = ViewState::new(100);
    let source = Source::default();
    let targets = lay(&mut s, &source, 5000, 0, false);
    assert!(!targets.is_empty());
    assert!(s.retained_target(&targets[0]));
    assert!(!s.accepts_target(&targets[0]));
    settle(&mut s, &source, 5000, 0, false);
    assert!(!s.retained_target(&targets[0]));
    assert!(s.placed().len() > 20);
    assert!(s.request(&"list".into(), true).is_none());
    assert!(lay(&mut s, &source, 5000, 0, false).is_empty());
}
#[test]
fn long_list_empty_and_shrunk_models_have_no_invalid_selection() {
    let (mut s, source) = fixture(5000, 4999);
    settle(&mut s, &source, 3, 4999, true);
    assert_eq!(s.typed_value(&"list".into()), Some(Value::Index(2)));
    assert!(s.rect(&"list/item/record-2".into()).is_some());
    settle(&mut s, &source, 0, 0, true);
    assert_eq!(s.typed_value(&"list".into()), None);
    assert!(
        !tree(&mut s)
            .nodes
            .values()
            .any(|n| n.role == nk_a11y::Role::Option)
    );
    assert!(s.key(KeyInput::End).is_none());
}
#[test]
fn long_list_rejects_interactive_rows_and_invalid_extent() {
    struct Bad;
    impl ListSource for Bad {
        fn item(&self, i: usize) -> RowInfo {
            RowInfo {
                key: format!("{i}").into(),
                name: "Bad".into(),
            }
        }
        fn build(&self, _: usize, k: &Key) -> Node {
            Node::control(k.clone(), "Bad", "bad", Node::spacer("body"))
        }
    }
    for height in [32., 0., f64::INFINITY] {
        let n = LongList::new(100, 0, height).node("list", "Records", "select", None, &Bad);
        let mut s = ViewState::new(0);
        s.layout(
            &n,
            (320., 256.),
            1.,
            crate::tests::tokens().with_types(&crate::tests::types()),
            &mut crate::tests::backend(),
            Instant::now(),
        );
        assert!(!s.component_errors().is_empty());
    }
}
#[test]
fn long_list_pointer_selects_on_press_and_double_click_opens_only_same_record() {
    let (mut s, source) = fixture(100, 0);
    s.set_double_click_ms(500);
    let now = Instant::now();
    s.pointer_motion(30., 48.);
    let a = s.button(true, now).unwrap();
    assert_eq!(a.value, Some(Value::Index(1)));
    assert_eq!(a.action, "select");
    assert!(s.button(false, now).is_none());
    settle(&mut s, &source, 100, 1, true);
    let a = s
        .button(true, now + std::time::Duration::from_millis(100))
        .unwrap();
    assert_eq!(a.action, "open");
    assert_eq!(
        a.value,
        Some(Value::Index(1)),
        "double-click opens the previously selected new row"
    );
    s.button(false, now + std::time::Duration::from_millis(110));
    s.pointer_motion(30., 80.);
    let a = s
        .button(true, now + std::time::Duration::from_millis(200))
        .unwrap();
    assert_eq!(a.action, "select");
    assert_eq!(a.value, Some(Value::Index(2)));
}
#[test]
fn long_list_removal_and_type_replacement_invalidate_a_pending_callback() {
    let source = Source::default();
    let mut s = ViewState::new(100);
    let target = lay(&mut s, &source, 5000, 0, true).pop().unwrap();
    let n = Node::spacer("empty");
    s.layout(
        &n,
        (320., 256.),
        1.,
        crate::tests::tokens().with_types(&crate::tests::types()),
        &mut crate::tests::backend(),
        Instant::now(),
    );
    assert!(!s.retained_target(&target));
    lay(&mut s, &source, 5000, 0, true);
    assert!(
        !s.retained_target(&target),
        "instance from removed list must not return"
    );
    let n = Node::control("list", "Replacement", "click", Node::spacer("child"));
    s.layout(
        &n,
        (320., 256.),
        1.,
        crate::tests::tokens().with_types(&crate::tests::types()),
        &mut crate::tests::backend(),
        Instant::now(),
    );
    assert!(!s.retained_target(&target));
}
#[test]
fn long_list_serializes_its_materialized_rows_without_the_application_source() {
    let source = Source::default();
    let n = LongList::new(5000, 0, 32.).node(
        "list",
        "Records",
        "select",
        Some((32000., 256.)),
        &source,
    );
    let encoded = serde_json::to_string(&n).unwrap();
    assert!(encoded.len() < 10000);
    assert_eq!(serde_json::from_str::<Node>(&encoded).unwrap(), n);
    assert!(!encoded.contains("Record 4999"));
}
#[test]
fn long_list_hover_selection_focus_and_disabled_are_painted_from_the_component() {
    fn pixels(s: &ViewState) -> Vec<u8> {
        let mut canvas = nk_render::Canvas::new(320, 256, 1.);
        s.paint(
            &mut canvas,
            crate::tests::tokens().with_types(&crate::tests::types()),
            &mut |_, _| None,
            None,
        )
        .unwrap();
        canvas.finish()
    }
    let (mut s, source) = fixture(100, 0);
    let normal = pixels(&s);
    s.pointer_motion(30., 48.);
    let hover = pixels(&s);
    assert!(normal != hover, "hover paints");
    s.pointer_motion(30., 80.);
    assert!(hover != pixels(&s), "hover follows the row");
    s.pointer_motion(500., 500.);
    assert!(normal == pixels(&s), "leaving clears hover");
    s.key(KeyInput::Down);
    settle(&mut s, &source, 100, 1, true);
    assert!(normal != pixels(&s), "selection or disabled paint changes");
    let keyboard = pixels(&s);
    s.blur();
    assert!(keyboard != pixels(&s), "blur removes the row focus ring");
    settle(&mut s, &source, 100, 1, false);
    assert!(normal != pixels(&s), "selection or disabled paint changes");
}
#[test]
fn long_list_selection_inside_the_viewport_reuses_shaped_text() {
    let (mut s, source) = fixture(5000, 0);
    let before = s.text().shaped;
    s.key(KeyInput::Down);
    settle(&mut s, &source, 5000, 1, true);
    assert_eq!(s.text().shaped, before);
    s.key(KeyInput::Down);
    settle(&mut s, &source, 5000, 2, true);
    assert_eq!(s.text().shaped, before);
}
#[test]
fn long_list_hidden_range_retires_callback_and_showing_requests_a_fresh_range() {
    let source = Source::default();
    let mut s = ViewState::new(100);
    s.set_reduced_motion(true);
    let target = lay(&mut s, &source, 5000, 0, true).pop().unwrap();
    let node = LongList::new(5000, 0, 32.).node("list", "Records", "select", None, &source);
    let hidden = Node::reveal("reveal", false, node);
    s.layout(
        &hidden,
        (320., 256.),
        1.,
        crate::tests::tokens().with_types(&crate::tests::types()),
        &mut crate::tests::backend(),
        Instant::now(),
    );
    assert!(!s.retained_target(&target));
    assert!(s.take_host_requests().is_empty());
    assert!(!lay(&mut s, &source, 5000, 0, true).is_empty());
    settle(&mut s, &source, 5000, 0, true);
}
#[test]
fn long_list_decorative_panes_do_not_add_automatic_reader_containers() {
    struct Panes;
    impl ListSource for Panes {
        fn item(&self, i: usize) -> RowInfo {
            RowInfo {
                key: format!("{i}").into(),
                name: format!("Item {i}"),
            }
        }
        fn build(&self, _: usize, k: &Key) -> Node {
            Node::pane(
                format!("{}/pane", k.0),
                Corner::Pill,
                Node::text(format!("{}/label", k.0), "Decorative", Default::default()),
            )
        }
    }
    let n = LongList::new(3, 0, 32.).node("list", "Records", "select", Some((0., 256.)), &Panes);
    let mut s = ViewState::new(0);
    s.layout(
        &n,
        (320., 256.),
        1.,
        crate::tests::tokens().with_types(&crate::tests::types()),
        &mut crate::tests::backend(),
        Instant::now(),
    );
    assert!(s.component_errors().is_empty());
    let t = tree(&mut s);
    assert_eq!(t.nodes.len(), 5, "window, list, three options only");
}
#[test]
fn long_list_model_keys_with_slashes_or_percent_do_not_alias_content_namespaces() {
    struct Paths;
    impl ListSource for Paths {
        fn item(&self, i: usize) -> RowInfo {
            RowInfo {
                key: ["a", "a/label", "a%2Flabel"][i].into(),
                name: format!("Path {i}"),
            }
        }
        fn build(&self, _: usize, k: &Key) -> Node {
            Node::text(format!("{}/label", k.0), "File", Default::default())
        }
    }
    let n = LongList::new(3, 1, 32.).node("list", "Paths", "select", Some((0., 256.)), &Paths);
    let mut s = ViewState::new(0);
    s.layout(
        &n,
        (320., 256.),
        1.,
        crate::tests::tokens().with_types(&crate::tests::types()),
        &mut crate::tests::backend(),
        Instant::now(),
    );
    let mut keys = std::collections::HashSet::new();
    assert!(
        s.placed().iter().all(|p| keys.insert(&p.key)),
        "row/content namespace collision"
    );
    assert!(s.rect(&"list/item/a%2Flabel".into()).is_some());
    assert!(s.rect(&"list/item/a%252Flabel".into()).is_some());
    assert_eq!(
        tree(&mut s)
            .nodes
            .values()
            .filter(|n| n.states.selected)
            .count(),
        1
    );
}
#[test]
fn long_list_range_uses_its_scroll_extent_when_an_outer_viewport_clips_it() {
    let source = Source::default();
    let mut s = ViewState::new(0);
    let mut target = None;
    for pass in 0..5 {
        let list = LongList::new(5000, 0, 32.)
            .node(
                "list",
                "Records",
                "select",
                s.window(&LongList::scroll_key(&"list".into())),
                &source,
            )
            .height(256.);
        let n = Node::scroll(
            "outer",
            Node::column(
                "outer/body",
                vec![Node::row("before", vec![]).height(160.), list],
            ),
        );
        s.layout(
            &n,
            (320., 256.),
            1.,
            crate::tests::tokens().with_types(&crate::tests::types()),
            &mut crate::tests::backend(),
            Instant::now(),
        );
        let requests = s.take_host_requests();
        if requests.is_empty() {
            assert!(pass > 0);
            assert!(
                !s.retained_target(&target.unwrap()),
                "range callback must be acknowledged despite outer clip"
            );
            return;
        }
        target = requests.into_iter().find_map(|r| {
            if let HostRequest::Rebuild { target } = r {
                Some(target)
            } else {
                None
            }
        });
    }
    panic!("nested clipping prevented range convergence");
}
#[test]
fn long_list_style_reads_exported_geometry_and_rejects_invalid_values() {
    let value = serde_json::json!({"highlight":{"inset":7,"hoverOpacity":0.12}});
    let style = crate::list_from(&value).unwrap();
    assert_eq!((style.inset, style.hover_opacity), (7., 0.12));
    for (path, bad) in [
        ("/highlight/inset", serde_json::json!(-1)),
        ("/highlight/hoverOpacity", serde_json::json!(2)),
    ] {
        let mut broken = value.clone();
        *broken.pointer_mut(path).unwrap() = bad;
        assert!(crate::list_from(&broken).is_err());
    }
    assert!(crate::list_from(&serde_json::json!({})).is_err());
}

#[test]
fn long_list_host_keeps_unacknowledged_requests_and_retires_acknowledged_or_stale_ones() {
    let mut s = ViewState::new(0);
    let source = Source::default();
    let target = lay(&mut s, &source, 5000, 0, true).pop().unwrap();
    let mut requests = vec![target.clone(), target.clone()];
    assert!(crate::window::retain_rebuilds(&s, &mut requests));
    assert_eq!(
        requests.len(),
        1,
        "coalesce one host rebuild without losing its acknowledgement"
    );
    // A bad app rebuilds the same bootstrap data instead of consulting the scroll window.
    let n = LongList::new(5000, 0, 32.).node("list", "Records", "select", None, &source);
    s.layout(
        &n,
        (320., 256.),
        1.,
        crate::tests::tokens().with_types(&crate::tests::types()),
        &mut crate::tests::backend(),
        Instant::now(),
    );
    assert!(
        crate::window::retain_rebuilds(&s, &mut requests),
        "unhandled callback must retry, not disappear"
    );
    settle(&mut s, &source, 5000, 0, true);
    assert!(!crate::window::retain_rebuilds(&s, &mut requests));
    requests.push(target);
    assert!(!crate::window::retain_rebuilds(&s, &mut requests));
}
#[test]
fn reveal_offset_is_minimal_for_visible_taller_and_outside_rows() {
    for (offset, viewport, top, height, wanted) in [
        (100., 80., 110., 20., 100.),
        (100., 80., 80., 20., 80.),
        (100., 80., 170., 20., 110.),
        (100., 80., 110., 100., 110.),
        (0., 256., 159968., 32., 159744.),
    ] {
        assert_eq!(
            crate::layout::reveal_offset(offset, viewport, top, height),
            wanted
        );
    }
}

/// #1148: a grid's tile is its own size at any window width (its wash was the column's,
/// stretching with the window), and a header row stands over the rows without scrolling.
#[test]
fn grid_tiles_keep_their_width_and_a_header_stays_over_the_rows() {
    let source = Source::default();
    let mut widths = Vec::new();
    for width in [400., 640.] {
        let mut s = ViewState::new(0);
        let mut list = LongList::new(6, 0, 100.);
        list.columns = 3;
        list.tile_width = Some(100.);
        let n = list.node("grid", "Files", "select", None, &source);
        s.layout(
            &n,
            (width, 400.),
            1.,
            crate::tests::tokens().with_types(&crate::tests::types()),
            &mut crate::tests::backend(),
            Instant::now(),
        );
        let tile = s.rect(&"grid/item/record-0".into()).unwrap();
        widths.push(tile[2]);
    }
    assert_eq!(widths, [100., 100.]);

    let mut s = ViewState::new(0);
    let mut list = LongList::new(40, 0, 32.);
    list.header = Some(Box::new(Node::text("title", "Name", Default::default())));
    let n = list.node("list", "Files", "select", None, &source);
    s.layout(
        &n,
        (320., 256.),
        1.,
        crate::tests::tokens().with_types(&crate::tests::types()),
        &mut crate::tests::backend(),
        Instant::now(),
    );
    let header = s.rect(&"title".into()).unwrap();
    let first = s.rect(&"list/item/record-0".into()).unwrap();
    assert!(
        header[1] + header[3] <= first[1],
        "{header:?} over {first:?}"
    );
}
