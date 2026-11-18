// SPDX-License-Identifier: LGPL-3.0-or-later
//! The ordinary renderer's Config1 binding and all-or-nothing page admission.
use nk::Activated;
use nk_settings::{
    Value,
    client::Editor,
    exports::Exports,
    manifest,
    session::{ApplyError, Command, Raw, Session},
    view_settings::{Model, ordinary},
};
use serde_json::json;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
struct Fake {
    session: Session,
    sent: Vec<(String, Value)>,
}
impl Editor for Fake {
    fn session(&self) -> &Session {
        &self.session
    }
    fn apply(&mut self, key: &str, value: Value) -> Result<(), ApplyError> {
        if let Some(Command::Apply { key, value, .. }) = self.session.apply(key, value)? {
            self.sent.push((key, value));
        }
        Ok(())
    }
}
fn fixture(release: bool) -> (Fake, Exports, Model) {
    let root = std::env::var_os("NK_SETTINGS_DATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
        });
    let mut e = Exports::load(&root).expect("generate settings-data before running Settings tests");
    e.pages=manifest::parse(&json!([
        {"id":"one","kind":"preference","label":"settings.native.application","groups":[{"items":["switch","segment","slider","dropdown"]}]},
        {"id":"two","kind":"preference","label":"settings.native.application","groups":[{"items":["switch"]}]}
    ])).unwrap();
    let (mut session, _) = Session::start();
    session.handle(Raw::Snapshot(Ok((7,1,json!({"schemaVersion":1,"keys":{
        "switch":{"type":"boolean","value":false,"available":true,"writable":true,"ui":{"control":"toggle","title":"Toggle"}},
        "segment":{"type":"string","value":"a","available":true,"writable":true,"ui":{"control":"segmented","title":"Segment","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}},
        "slider":{"type":"number","value":0.2,"min":0,"max":1,"available":true,"writable":true,"ui":{"control":"slider","title":"Slider","slider":{"pct":true,"commitOnRelease":release,"debounce":32}}},
        "dropdown":{"type":"string","value":"unknown","available":true,"writable":true,"ui":{"control":"dropdown","title":"Dropdown","options":[{"value":"a","label":"A"},{"value":"b","label":"B"}]}}
    }}).to_string()))));
    let mut model = Model::default();
    model.reconcile(&e, &session);
    (
        Fake {
            session,
            sent: vec![],
        },
        e,
        model,
    )
}
fn action(name: &str, value: Option<nk::Value>) -> Activated {
    Activated {
        key: "test".into(),
        action: name.into(),
        value,
    }
}
#[test]
fn page_admission_is_recursive_and_does_not_hide_unsupported_items() {
    let (f, e, _) = fixture(false);
    assert!(ordinary(&e.pages[0], &f.session));
    for patch in [
        json!({"custom":"unknown"}),
        json!({"items":[{"custom":"unknown"}]}),
        json!({"items":[{"decoration":"unknown"}]}),
        json!({"items":[{"disclosure":"settings.native.application","items":[{"custom":"unknown"}]}]}),
    ] {
        let pages=manifest::parse(&json!([{"id":"mixed","kind":"preference","label":"settings.native.application","groups":[{"items":["switch"]},patch]}])).unwrap();
        assert!(!ordinary(&pages[0], &f.session));
    }
    let mut p = e.pages[0].clone();
    p.kind = "browser".into();
    assert!(!ordinary(&p, &f.session));
    p.kind = "preference".into();
    p.header = Some("custom".into());
    assert!(!ordinary(&p, &f.session));
    p.header = None;
    p.builder = Some("custom".into());
    assert!(!ordinary(&p, &f.session));
    p.builder = None;
    p.groups[0].items = vec![manifest::Item::Key {
        key: "missing".into(),
        visible_when: None,
        sensitive_when: None,
    }];
    assert!(!ordinary(&p, &f.session));
}
#[test]
fn switch_segment_and_dropdown_use_the_same_session_and_keep_unknown_values() {
    let (mut f, e, mut m) = fixture(false);
    let now = Instant::now();
    m.activate(action("set:switch", None), false, &mut f, &e, now)
        .unwrap();
    m.activate(
        action("set:segment:1", Some(nk::Value::Index(1))),
        false,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    m.activate(
        action("set:dropdown", Some(nk::Value::Index(1))),
        false,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    assert_eq!(
        f.sent,
        vec![
            ("switch".into(), Value::Bool(true)),
            ("segment".into(), Value::Text("b".into())),
            ("dropdown".into(), Value::Text("b".into()))
        ]
    );
}
#[test]
fn release_slider_never_writes_a_drag_and_commits_the_final_scaled_value() {
    let (mut f, e, mut m) = fixture(true);
    let now = Instant::now();
    m.activate(
        action("set:slider", Some(nk::Value::Number(30.))),
        true,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    m.activate(
        action("set:slider", Some(nk::Value::Number(70.))),
        true,
        &mut f,
        &e,
        now + Duration::from_millis(20),
    )
    .unwrap();
    m.flush(&mut f, &e, now + Duration::from_secs(10)).unwrap();
    assert!(f.sent.is_empty());
    m.activate(
        action("set:slider", Some(nk::Value::Number(70.))),
        false,
        &mut f,
        &e,
        now + Duration::from_millis(30),
    )
    .unwrap();
    assert_eq!(f.sent, vec![("slider".into(), Value::Number(0.7))]);
}
#[test]
fn debounce_sends_only_the_latest_value_and_navigation_cancels_held_work() {
    let (mut f, e, mut m) = fixture(false);
    let now = Instant::now();
    for (ms, n) in [(0, 30.), (20, 70.)] {
        m.activate(
            action("set:slider", Some(nk::Value::Number(n))),
            true,
            &mut f,
            &e,
            now + Duration::from_millis(ms),
        )
        .unwrap();
    }
    m.flush(&mut f, &e, now + Duration::from_millis(50))
        .unwrap();
    assert!(f.sent.is_empty());
    m.flush(&mut f, &e, now + Duration::from_millis(53))
        .unwrap();
    assert_eq!(f.sent, vec![("slider".into(), Value::Number(0.7))]);
    let (mut f, e, mut m) = fixture(false);
    m.activate(
        action("set:slider", Some(nk::Value::Number(70.))),
        true,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    assert!(
        m.activate(action("page:two", None), false, &mut f, &e, now)
            .unwrap()
    );
    m.flush(&mut f, &e, now + Duration::from_secs(1)).unwrap();
    assert!(f.sent.is_empty());
    assert!(
        m.activate(action(nk::BACK, None), false, &mut f, &e, now)
            .unwrap()
    );
    assert_eq!(m.selected(), Some("one"));
    assert!(
        m.activate(action(nk::FORWARD, None), false, &mut f, &e, now)
            .unwrap()
    );
    assert_eq!(m.selected(), Some("two"));
}
#[test]
fn owner_loss_and_hidden_or_insensitive_rows_never_send_pending_values() {
    let (mut f, mut e, mut m) = fixture(false);
    let now = Instant::now();
    let predicate = manifest::Predicate {
        key: "switch".into(),
        any_of: vec!["true".into()],
    };
    if let manifest::Item::Key { sensitive_when, .. } = &mut e.pages[0].groups[0].items[2] {
        *sensitive_when = Some(predicate);
    }
    m.activate(
        action("set:slider", Some(nk::Value::Number(70.))),
        false,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    m.flush(&mut f, &e, now + Duration::from_secs(1)).unwrap();
    assert!(f.sent.is_empty());
    let (mut f, e, mut m) = fixture(false);
    m.activate(
        action("set:slider", Some(nk::Value::Number(70.))),
        true,
        &mut f,
        &e,
        now,
    )
    .unwrap();
    let (notices, _) = f.session.handle(Raw::Owner(false));
    m.notices(&notices, &e).unwrap();
    m.flush(&mut f, &e, now + Duration::from_secs(1)).unwrap();
    assert!(f.sent.is_empty());
}
