// SPDX-License-Identifier: LGPL-3.0-or-later
//! The renderer over the real export's Appearance page and a snapshot of a real session's
//! keys (`fixtures/appearance-snapshot.json`), with no bus and no compositor: which rows it
//! draws, what they show, what they send, and how they follow the session.
use nk_settings::exports::Exports;
use nk_settings::manifest::{self, Item};
use nk_settings::portal::Appearance;
use nk_settings::render::{Builder, Builders, Built, Cx, Editor, Host, Rendered, Result};
use nk_settings::session::{ApplyError, Command, Notice, Raw, Session};
use nk_settings::styles::Styles;
use nk_settings::{Value, builders};
use nk_text::{FontSet, ParleyBackend, Size};
use nk_widgets::{Command as TreeCommand, Effect, Kind, NodeId, Tree};
use std::path::Path;
use std::sync::Arc;

const EPOCH: u64 = 7;

struct Fake {
    session: Session,
    sent: Vec<(String, Value)>,
}

impl Editor for Fake {
    fn session(&self) -> &Session {
        &self.session
    }
    fn apply(&mut self, key: &str, value: Value) -> std::result::Result<(), ApplyError> {
        if let Some(Command::Apply { key, value, .. }) = self.session.apply(key, value)? {
            self.sent.push((key, value));
        }
        Ok(())
    }
}

/// Stands in for Sol's builders: a row with a button, named after the item.
struct Stub;
impl Builder for Stub {
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, item: &Item) -> Result<Built> {
        let name = match item {
            Item::Custom { name, .. } | Item::Decoration { name, .. } => name.clone(),
            Item::Key { key, .. } => key.clone(),
            Item::Disclosure { .. } => unreachable!(),
        };
        let (row, button) = cx.tree.row(group, &name, Kind::Button)?;
        cx.own(row);
        cx.own(button);
        Ok(Built {
            rows: vec![row],
            keys: item.key().map(str::to_owned).into_iter().collect(),
        })
    }
    fn notice(&mut self, _: &mut Cx<'_>, _: &Notice) -> Result<()> {
        Ok(())
    }
    fn effect(&mut self, _: &mut Cx<'_>, _: Effect) -> Result<()> {
        Ok(())
    }
}

fn stubs(b: &mut Builders) {
    for name in [
        "wallpaperPreview",
        "wallpaperGallery",
        "wallpaperPicker",
        "interfaceFont",
        "monoFont",
        "dropdown",
    ] {
        b.register(name, || Box::new(Stub));
    }
}

struct Page {
    tree: Tree,
    text: ParleyBackend,
    editor: Fake,
    exports: Exports,
    styles: Styles,
    rendered: Option<Rendered>,
}

fn root() -> std::path::PathBuf {
    std::env::var_os("NK_SETTINGS_DATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data"))
}

fn exported() -> bool {
    if root().join("version").exists() {
        return true;
    }
    assert!(
        std::env::var_os("NK_REQUIRE_EXPORT").is_none(),
        "NK_REQUIRE_EXPORT set and no build/settings-data"
    );
    eprintln!("skipped: no build/settings-data");
    false
}

fn snapshot(edit: impl FnOnce(&mut serde_json::Value)) -> String {
    let mut s: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/appearance-snapshot.json")).unwrap();
    edit(&mut s);
    s.to_string()
}

fn page_with(
    schema: String,
    page: &nk_settings::manifest::Page,
    builders: &mut Builders,
) -> Result<Page> {
    let exports = Exports::load(&root()).unwrap();
    let appearance = Appearance {
        accent: [0.0, 136.0 / 255.0, 1.0],
        dark: true,
        reduce_transparency: false,
        window_background: "tinted".into(),
        reduced_motion: false,
        font: "Inter Variable 11".into(),
        text_scale: 1.0,
    };
    let styles = Styles::new(&exports, &appearance).unwrap();
    let (mut session, _) = Session::start();
    session.handle(Raw::Snapshot(Ok((EPOCH, 10, schema))));
    let mut tree = Tree::new("Settings", styles.metrics, styles.text.clone()).unwrap();
    styles.apply(&mut tree).unwrap();
    let icons = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara");
    tree.set_icon_theme(nk_icons::Icons::new("", &[], &icons).unwrap());
    let r = tree.root();
    tree.append(r, Kind::TitleBar, "Settings").unwrap();
    let content = tree.append(r, Kind::Scroll, "Content").unwrap();
    let text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    let mut p = Page {
        tree,
        text,
        editor: Fake {
            session,
            sent: Vec::new(),
        },
        exports,
        styles,
        rendered: None,
    };
    let rendered = Rendered::build(
        Host {
            tree: &mut p.tree,
            editor: &mut p.editor,
            exports: &p.exports,
            styles: &p.styles,
            window: None,
            modal: None,
        },
        page,
        builders,
        content,
        1,
    )?;
    p.rendered = Some(rendered);
    p.layout();
    Ok(p)
}

fn appearance(edit: impl FnOnce(&mut serde_json::Value)) -> Page {
    let exports = Exports::load(&root()).unwrap();
    let page = exports.page("appearance").unwrap().clone();
    let mut b = Builders::default();
    builders::register(&mut b);
    stubs(&mut b);
    page_with(snapshot(edit), &page, &mut b).unwrap()
}

impl Page {
    fn layout(&mut self) {
        self.tree
            .layout(
                Size {
                    width: 900.,
                    height: 2000.,
                },
                true,
                &mut self.text,
            )
            .unwrap();
    }
    fn host(&mut self) -> (Host<'_>, &mut Rendered) {
        (
            Host {
                tree: &mut self.tree,
                editor: &mut self.editor,
                exports: &self.exports,
                styles: &self.styles,
                window: None,
                modal: None,
            },
            self.rendered.as_mut().unwrap(),
        )
    }
    fn notices(&mut self, n: &[Notice]) {
        let (h, r) = self.host();
        r.notices(h, n).unwrap();
        self.layout();
    }
    /// Feeds the session, then the page what the session said.
    fn raw(&mut self, raw: Raw) {
        let (n, _) = self.editor.session.handle(raw);
        self.notices(&n);
    }
    fn effect(&mut self, e: Effect) -> bool {
        let (h, r) = self.host();
        let mine = r.effect(h, e).unwrap();
        self.layout();
        mine
    }
    fn activate(&mut self, id: NodeId) {
        let target = self.tree.target(id);
        let e = self.tree.dispatch(target, TreeCommand::Activate).unwrap();
        assert!(self.effect(e), "the page did not take {e:?}");
    }
    /// The row labelled `label` (hidden or not: the widget tree, not AT-SPI's), and its
    /// control.
    fn row(&self, label: &str) -> Option<(NodeId, NodeId)> {
        let mut stack = vec![self.tree.root()];
        while let Some(id) = stack.pop() {
            let n = self.tree.node(id)?;
            stack.extend(n.children().iter().copied());
            if n.kind() != Kind::Row {
                continue;
            }
            let kids: Vec<_> = n.children().to_vec();
            let named = kids.iter().any(|c| {
                let c = self.tree.node(*c).unwrap();
                c.kind() == Kind::Label && c.name() == label
            });
            if named {
                let control = kids.into_iter().find(|c| {
                    !matches!(
                        self.tree.node(*c).unwrap().kind(),
                        Kind::Label | Kind::Subtitle
                    )
                })?;
                return Some((id, control));
            }
        }
        None
    }
    fn title(&self, key: &str) -> String {
        let s = self.editor.session.store().unwrap();
        s.key(key).unwrap().entry["ui"]["title"]
            .as_str()
            .unwrap()
            .to_owned()
    }
    fn disabled(&self, id: NodeId) -> bool {
        self.tree.semantics().nodes[&id].states.disabled
    }
    fn hidden(&self, id: NodeId) -> bool {
        self.tree.is_hidden(id)
    }
}

fn checked(t: &Tree, id: NodeId) -> bool {
    matches!(
        t.node(id).unwrap().kind(),
        Kind::Switch { checked: true } | Kind::Choice { checked: true }
    )
}

#[test]
fn appearance_draws_every_row_with_the_value_in_force() {
    if !exported() {
        return;
    }
    let p = appearance(|_| {});
    let (_, dark) = p.row(&p.title("appearance.darkMode")).unwrap();
    assert!(checked(&p.tree, dark));
    // Segmented: its options, the value in force chosen.
    let (_, style) = p.row(&p.title("appearance.windowBackground")).unwrap();
    let choices = p.tree.node(style).unwrap().children().to_vec();
    assert_eq!(choices.len(), 3);
    let s = p.tree.semantics();
    let chosen: Vec<_> = choices.iter().filter(|c| checked(&p.tree, **c)).collect();
    assert_eq!(chosen.len(), 1);
    assert_eq!(s.nodes[chosen[0]].name, "Tinted");
    // The slider: its value, its unit, its icons.
    let (_, temp) = p.row(&p.title("nightlight.temperature")).unwrap();
    assert_eq!(p.tree.value(temp), Some(3334.));
    assert_eq!(s.nodes[&temp].value.as_ref().unwrap().text, "3334K");
    // The second line from the schema.
    let (row, _) = p.row(&p.title("appearance.darkMode")).unwrap();
    assert!(!s.nodes[&row].description.is_empty());
    // Builders: the accent swatches (named as the current Settings names them), the
    // schedule's two times, and the stubs standing in for Sol's.
    let accent = p
        .exports
        .text("settings.appearance.accent")
        .unwrap()
        .to_owned();
    let (_, swatches) = p.row(&accent).unwrap();
    let names: Vec<_> = p
        .tree
        .node(swatches)
        .unwrap()
        .children()
        .iter()
        .map(|c| s.nodes[c].name.clone())
        .collect();
    assert_eq!(names[0], "Blue");
    assert_eq!(names.len(), 9);
    for stub in ["wallpaperPicker", "interfaceFont", "monoFont"] {
        assert!(p.row(stub).is_some(), "{stub} not drawn");
    }
    assert!(
        p.row(&p.title("appearance.gtkTheme")).is_none(),
        "a dropdown drawn here"
    );
    assert!(
        p.row("appearance.gtkTheme").is_some(),
        "a dropdown not given to its builder"
    );
}

#[test]
fn a_switch_a_segment_and_a_swatch_send_through_the_service() {
    if !exported() {
        return;
    }
    let mut p = appearance(|_| {});
    let (_, dark) = p.row(&p.title("appearance.darkMode")).unwrap();
    p.activate(dark);
    let (_, controls) = p.row(&p.title("appearance.windowControls")).unwrap();
    let left = p.tree.node(controls).unwrap().children()[1];
    p.activate(left);
    let accent = p
        .exports
        .text("settings.appearance.accent")
        .unwrap()
        .to_owned();
    let (_, swatches) = p.row(&accent).unwrap();
    let green = p.tree.node(swatches).unwrap().children()[2];
    p.activate(green);
    assert_eq!(
        p.editor.sent,
        vec![
            ("appearance.darkMode".into(), Value::Bool(false)),
            (
                "appearance.windowControls".into(),
                Value::Text("left".into())
            ),
            ("appearance.accent".into(), Value::Text("green".into())),
        ]
    );
}

#[test]
fn the_schedule_writes_hh_mm_and_follows_its_switch() {
    if !exported() {
        return;
    }
    let mut p = appearance(|_| {});
    let from = p
        .exports
        .text("settings.appearance.night-light-from")
        .unwrap()
        .to_owned();
    let (row, fields) = p.row(&from).unwrap();
    // scheduleEnabled is off: the times are hidden, night light itself sensitive.
    assert!(p.hidden(row));
    let (_, enabled) = p.row(&p.title("nightlight.enabled")).unwrap();
    assert!(!p.disabled(enabled));
    // Another writer turns the schedule on.
    p.raw(Raw::Updated {
        epoch: EPOCH,
        revision: 11,
        values: vec![("nightlight.scheduleEnabled".into(), Value::Bool(true))],
    });
    assert!(!p.hidden(row));
    let to = p
        .exports
        .text("settings.appearance.night-light-to")
        .unwrap()
        .to_owned();
    assert!(
        !p.hidden(p.row(&to).unwrap().0),
        "the second time stayed hidden"
    );
    assert!(p.disabled(enabled), "sensitiveWhen not followed");
    // The minute steps up: 22:01.
    let minute = p.tree.node(fields).unwrap().children()[1];
    p.tree.focus(minute).unwrap();
    let e = p.tree.control_key(0xff52).unwrap().unwrap();
    assert!(p.effect(e));
    assert_eq!(
        p.editor.sent.last(),
        Some(&(
            "nightlight.scheduleFrom".into(),
            Value::Text("22:01".into())
        ))
    );
    // The spoken names carry the part.
    let s = p.tree.semantics();
    assert!(
        s.nodes[&minute].name.starts_with(&from),
        "{}",
        s.nodes[&minute].name
    );
}

#[test]
fn a_refused_write_shows_the_value_in_force_and_says_why() {
    if !exported() {
        return;
    }
    let mut p = appearance(|_| {});
    let (row, dark) = p.row(&p.title("appearance.darkMode")).unwrap();
    let normal = p.tree.semantics().nodes[&row].description.clone();
    p.activate(dark);
    assert!(!checked(&p.tree, dark), "the switch shows what was asked");
    p.raw(Raw::Reply {
        key: "appearance.darkMode".into(),
        epoch: EPOCH,
        result: Err(ApplyError::Denied("config writes are disabled".into())),
    });
    assert!(checked(&p.tree, dark), "back to the value in force");
    assert_eq!(
        p.tree.semantics().nodes[&row].description,
        "config writes are disabled"
    );
    // The next answer for that key: the second line is the schema's again.
    p.activate(dark);
    p.raw(Raw::Reply {
        key: "appearance.darkMode".into(),
        epoch: EPOCH,
        result: Ok((11, Value::Bool(false))),
    });
    assert_eq!(p.tree.semantics().nodes[&row].description, normal);
}

#[test]
fn the_service_gone_disables_every_control_and_back_enables_them() {
    if !exported() {
        return;
    }
    let mut p = appearance(|_| {});
    let (_, dark) = p.row(&p.title("appearance.darkMode")).unwrap();
    let (_, temp) = p.row(&p.title("nightlight.temperature")).unwrap();
    p.raw(Raw::Owner(false));
    assert!(p.disabled(dark) && p.disabled(temp));
    p.raw(Raw::Owner(true));
    p.raw(Raw::Snapshot(Ok((EPOCH + 1, 0, snapshot(|_| {})))));
    assert!(!p.disabled(dark) && !p.disabled(temp));
}

#[test]
fn an_unavailable_key_has_no_row_and_an_unknown_value_is_shown() {
    if !exported() {
        return;
    }
    let p = appearance(|s| {
        s["keys"]["appearance.windowControls"]["available"] = false.into();
        s["keys"]["appearance.windowBackground"]["value"] = "frosted".into();
    });
    let s = p.editor.session.store().unwrap();
    let title = s.key("appearance.windowControls").unwrap().entry["ui"]["title"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(p.row(&title).is_none());
    let (_, style) = p.row(&p.title("appearance.windowBackground")).unwrap();
    let choices = p.tree.node(style).unwrap().children().to_vec();
    assert_eq!(choices.len(), 4);
    let sem = p.tree.semantics();
    assert_eq!(sem.nodes[&choices[3]].name, "frosted");
    assert!(checked(&p.tree, choices[3]));
}

#[test]
fn a_missing_builder_or_key_is_an_error_not_a_skipped_row() {
    if !exported() {
        return;
    }
    let exports = Exports::load(&root()).unwrap();
    let page = exports.page("appearance").unwrap().clone();
    let mut b = Builders::default();
    builders::register(&mut b);
    stubs(&mut b);
    // Gate 1's control: one custom builder removed must fail the page.
    let mut without = Builders::default();
    builders::register(&mut without);
    for name in [
        "wallpaperPreview",
        "wallpaperGallery",
        "wallpaperPicker",
        "monoFont",
        "dropdown",
    ] {
        without.register(name, || Box::new(Stub));
    }
    let err = page_with(snapshot(|_| {}), &page, &mut without)
        .err()
        .unwrap();
    assert!(err.contains("interfaceFont"), "{err}");
    let err = page_with(
        snapshot(|s| {
            s["keys"]
                .as_object_mut()
                .unwrap()
                .remove("appearance.darkMode");
        }),
        &page,
        &mut b,
    )
    .err()
    .unwrap();
    assert!(err.contains("appearance.darkMode"), "{err}");
}

/// A page of this test's own, for what Appearance does not use: a slider that commits on
/// release, a debounced one, a footer with its predicate, a disclosure.
fn own_page() -> nk_settings::manifest::Page {
    manifest::parse(&serde_json::json!([{
        "id": "test", "kind": "preference", "label": "settings.appearance.title",
        "groups": [{
            "i18n": "settings.appearance.group.night-light",
            "footer": "settings.appearance.night-light.desc",
            "footerWhen": {"key": "nightlight.enabled", "in": ["true"]},
            "items": [
                "nightlight.temperature",
                {"disclosure": "settings.appearance.night-light", "items": ["appearance.darkMode"]},
            ],
        }],
    }]))
    .unwrap()
    .remove(0)
}

fn own(edit: impl FnOnce(&mut serde_json::Value)) -> Page {
    let mut b = Builders::default();
    page_with(snapshot(edit), &own_page(), &mut b).unwrap()
}

#[test]
fn a_slider_that_commits_on_release_sends_once_the_pointer_lets_go() {
    if !exported() {
        return;
    }
    let mut p = own(|s| {
        s["keys"]["nightlight.temperature"]["ui"]["slider"]["commitOnRelease"] = true.into();
    });
    let (_, temp) = p.row(&p.title("nightlight.temperature")).unwrap();
    let r = p.tree.node(temp).unwrap().bounds();
    // Past the lesser icon and its gap (28) and the thumb's radius (9): the track's start.
    let y = r.y + r.height / 2.;
    let start = nk_text::Point {
        x: r.x + 28. + 9.,
        y,
    };
    p.tree.pointer_press(start).unwrap();
    let id = p.tree.range_drag(start).unwrap().unwrap();
    assert!(p.effect(Effect::Changed(id)));
    let mid = nk_text::Point {
        x: r.x + 28. + 70.,
        y,
    };
    p.tree.range_drag(mid).unwrap();
    assert!(p.effect(Effect::Changed(id)));
    {
        let (h, rd) = p.host();
        rd.idle(h).unwrap();
    }
    assert!(
        p.editor.sent.is_empty(),
        "sent while dragging: {:?}",
        p.editor.sent
    );
    p.tree.pointer_release(mid).unwrap();
    {
        let (h, rd) = p.host();
        rd.idle(h).unwrap();
    }
    assert_eq!(p.editor.sent.len(), 1, "{:?}", p.editor.sent);
    let (k, v) = &p.editor.sent[0];
    assert_eq!(k, "nightlight.temperature");
    assert_eq!(v.as_number(), p.tree.value(temp).map(|v| v as f64));
}

#[test]
fn a_debounced_slider_sends_its_last_value_after_the_wait() {
    if !exported() {
        return;
    }
    let mut p = own(|s| {
        s["keys"]["nightlight.temperature"]["ui"]["slider"]["debounce"] = 40.into();
    });
    let (_, temp) = p.row(&p.title("nightlight.temperature")).unwrap();
    p.tree.focus(temp).unwrap();
    for _ in 0..3 {
        let e = p.tree.control_key(0xff53).unwrap().unwrap();
        assert!(p.effect(e));
    }
    {
        let (h, rd) = p.host();
        rd.idle(h).unwrap();
    }
    assert!(p.editor.sent.is_empty(), "sent before the debounce");
    std::thread::sleep(std::time::Duration::from_millis(60));
    {
        let (h, rd) = p.host();
        rd.idle(h).unwrap();
    }
    assert_eq!(
        p.editor.sent,
        vec![("nightlight.temperature".into(), Value::Number(3337.))]
    );
}

#[test]
fn a_footer_follows_its_predicate_and_a_disclosure_hides_what_follows_it() {
    if !exported() {
        return;
    }
    let mut p = own(|_| {});
    let group = {
        let (row, _) = p.row(&p.title("nightlight.temperature")).unwrap();
        p.tree
            .semantics()
            .nodes
            .values()
            .find(|n| n.children.contains(&row))
            .unwrap()
            .id
    };
    let footer = p
        .tree
        .node(group)
        .unwrap()
        .children()
        .iter()
        .copied()
        .find(|c| p.tree.node(*c).unwrap().kind() == Kind::Footer)
        .unwrap();
    assert!(p.hidden(footer), "nightlight.enabled is false");
    p.raw(Raw::Updated {
        epoch: EPOCH,
        revision: 11,
        values: vec![("nightlight.enabled".into(), Value::Bool(true))],
    });
    assert!(!p.hidden(footer));
    let disclosure = p
        .tree
        .node(group)
        .unwrap()
        .children()
        .iter()
        .copied()
        .find(|c| matches!(p.tree.node(*c).unwrap().kind(), Kind::Disclosure { .. }))
        .unwrap();
    let (dark_row, _) = p.row(&p.title("appearance.darkMode")).unwrap();
    assert!(
        !p.hidden(dark_row),
        "a disclosure starts open, as the current Settings'"
    );
    p.activate(disclosure);
    assert!(p.hidden(dark_row));
    p.activate(disclosure);
    assert!(!p.hidden(dark_row));
}

fn real_dropdown(edit: impl FnOnce(&mut serde_json::Value)) -> Result<Page> {
    let page = manifest::parse(&serde_json::json!([{
        "id":"test", "kind":"preference", "label":"settings.appearance.title",
        "groups":[{"items":["appearance.cursorTheme"]}]
    }]))
    .unwrap()
    .remove(0);
    let mut builders = Builders::default();
    nk_settings::dropdown_builder::register(&mut builders);
    page_with(snapshot(edit), &page, &mut builders)
}

#[test]
fn real_dropdown_maps_values_applies_once_and_reconciles_canonical_unknowns_and_schema() {
    if !exported() {
        return;
    }
    let mut p = real_dropdown(|_| {}).unwrap();
    let title = p.title("appearance.cursorTheme");
    let (_, combo) = p.row(&title).unwrap();
    let original = p.tree.node(combo).unwrap().children().to_vec();
    assert!(matches!(
        p.tree.node(combo).unwrap().kind(),
        Kind::Dropdown { .. }
    ));
    assert_eq!(p.tree.node(combo).unwrap().name(), "default");
    assert!(p.editor.sent.is_empty());
    p.activate(original[0]);
    assert_eq!(
        p.editor.sent,
        vec![(
            "appearance.cursorTheme".into(),
            Value::Text("Adwaita".into())
        )]
    );
    assert_eq!(p.tree.node(combo).unwrap().name(), "Adwaita");
    assert_eq!(
        p.tree
            .dispatch(p.tree.target(original[0]), TreeCommand::Activate)
            .unwrap(),
        Effect::None
    );
    p.raw(Raw::Reply {
        key: "appearance.cursorTheme".into(),
        epoch: EPOCH,
        result: Err(ApplyError::Denied("denied by fixture".into())),
    });
    assert_eq!(p.tree.node(combo).unwrap().name(), "default");
    assert!(
        p.tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.name == "denied by fixture")
    );
    p.raw(Raw::Updated {
        epoch: EPOCH,
        revision: 11,
        values: vec![(
            "appearance.cursorTheme".into(),
            Value::Text("custom-未知".into()),
        )],
    });
    assert_eq!(p.tree.node(combo).unwrap().name(), "custom-未知");
    assert_eq!(&p.tree.node(combo).unwrap().children()[..4], &original[..4]);
    assert_eq!(p.editor.sent.len(), 1, "canonical notices must never Apply");
    p.raw(Raw::Owner(false));
    assert!(p.disabled(combo));
    p.raw(Raw::Owner(true));
    p.raw(Raw::Snapshot(Ok((
        EPOCH + 1,
        1,
        snapshot(|s| {
            s["keys"]["appearance.cursorTheme"]["value"] = "Qogir".into();
            s["keys"]["appearance.cursorTheme"]["ui"]["options"] = serde_json::json!([
                {"value":"Qogir", "label":"Brisa 日本語"}, {"value":"Adwaita", "label":"Adwaita"}
            ]);
        }),
    ))));
    assert_eq!(p.row(&title).unwrap().1, combo);
    assert_eq!(
        p.tree.node(combo).unwrap().children(),
        &[original[1], original[0]]
    );
    assert_eq!(p.tree.node(combo).unwrap().name(), "Brisa 日本語");
    assert_eq!(p.editor.sent.len(), 1);
}

#[test]
fn real_dropdown_refuses_bad_schema_readonly_hidden_and_missing_native_open_context() {
    if !exported() {
        return;
    }
    assert!(
        real_dropdown(
            |s| s["keys"]["appearance.cursorTheme"]["ui"]["options"] = serde_json::json!([
                {"value":"same","label":"One"}, {"value":"same","label":"Two"}
            ])
        )
        .err()
        .unwrap()
        .contains("duplicate")
    );
    let mut p =
        real_dropdown(|s| s["keys"]["appearance.cursorTheme"]["writable"] = false.into()).unwrap();
    let (_, combo) = p.row(&p.title("appearance.cursorTheme")).unwrap();
    assert!(p.disabled(combo));
    assert!(
        p.tree
            .dispatch(p.tree.target(combo), TreeCommand::Activate)
            .is_err()
    );
    assert!(p.effect(Effect::Changed(combo)));
    assert!(p.editor.sent.is_empty());
    let mut p = real_dropdown(|_| {}).unwrap();
    let (row, combo) = p.row(&p.title("appearance.cursorTheme")).unwrap();
    p.tree.set_hidden(row, true).unwrap();
    assert!(p.effect(Effect::Changed(combo)));
    assert!(p.editor.sent.is_empty());
    let (host, rendered) = p.host();
    assert!(
        rendered
            .effect(host, Effect::Activated(combo))
            .unwrap_err()
            .contains("native modal context")
    );
    assert!(p.editor.sent.is_empty());
}

#[test]
fn real_dropdown_tracks_key_availability_without_writing_and_preserves_combo_identity() {
    if !exported() {
        return;
    }
    let mut p = real_dropdown(|_| {}).unwrap();
    let title = p.title("appearance.cursorTheme");
    let (row, combo) = p.row(&title).unwrap();
    let old_target = p.tree.target(combo);
    p.raw(Raw::Owner(false));
    p.raw(Raw::Owner(true));
    p.raw(Raw::Snapshot(Ok((
        EPOCH + 1,
        1,
        snapshot(|s| {
            s["keys"]["appearance.cursorTheme"]["available"] = false.into();
            s["keys"]["appearance.cursorTheme"]["value"] = serde_json::Value::Null;
        }),
    ))));
    assert!(p.hidden(row));
    assert!(p.tree.dispatch(old_target, TreeCommand::Activate).is_err());
    assert!(p.effect(Effect::Changed(combo)));
    assert!(p.editor.sent.is_empty());
    p.raw(Raw::Owner(false));
    p.raw(Raw::Owner(true));
    p.raw(Raw::Snapshot(Ok((EPOCH + 2, 1, snapshot(|_| {})))));
    assert!(!p.hidden(row));
    assert_eq!(p.row(&title).unwrap().1, combo);
    assert!(!p.disabled(combo));
    assert!(p.editor.sent.is_empty());
}
