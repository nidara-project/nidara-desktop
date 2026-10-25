// SPDX-License-Identifier: LGPL-3.0-or-later
//! Real renderer/Tree lifecycle with deterministic failing builder callbacks.
//! No Window, provider or Config1 integration is claimed by these fixtures.
use nk_settings::{
    Value,
    exports::Exports,
    manifest,
    page::Mounted,
    portal::Appearance,
    render::{Builder, Builders, Built, Cx, Editor, Host, Result},
    session::{ApplyError, Raw, Session},
    styles::Styles,
};
use nk_widgets::{Effect, Kind, NodeId, Tree};
use std::sync::{Arc, Mutex};
struct Editing(Session);
impl Editor for Editing {
    fn session(&self) -> &Session {
        &self.0
    }
    fn apply(&mut self, _: &str, _: Value) -> std::result::Result<(), ApplyError> {
        panic!("mount lifecycle must not Apply")
    }
}
struct Traced {
    name: &'static str,
    trace: Arc<Mutex<Vec<String>>>,
    build_error: bool,
    unmount_error: bool,
    node: Option<NodeId>,
}
impl Builder for Traced {
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, _: &manifest::Item) -> Result<Built> {
        self.trace
            .lock()
            .unwrap()
            .push(format!("build {}", self.name));
        let (row, node) = cx.tree.row(group, self.name, Kind::Button)?;
        cx.own(row);
        cx.own(node);
        self.node = Some(node);
        if self.build_error {
            return Err(format!("{} build refused", self.name));
        }
        Ok(Built {
            rows: vec![node],
            keys: vec![],
        })
    }
    fn notice(&mut self, _: &mut Cx<'_>, _: &nk_settings::session::Notice) -> Result<()> {
        Ok(())
    }
    fn effect(&mut self, _: &mut Cx<'_>, _: Effect) -> Result<()> {
        Ok(())
    }
    fn unmount(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        assert!(
            cx.tree.node(self.node.unwrap()).is_some(),
            "unmount precedes removal"
        );
        self.trace
            .lock()
            .unwrap()
            .push(format!("unmount {}", self.name));
        if self.unmount_error {
            Err(format!("{} cleanup refused", self.name))
        } else {
            Ok(())
        }
    }
}
struct Fixture {
    exports: Exports,
    styles: Styles,
    tree: Tree,
    editor: Editing,
    content: NodeId,
}
impl Fixture {
    fn new() -> Self {
        let exports = Exports::load(&Exports::root()).unwrap();
        let styles = Styles::new(
            &exports,
            &Appearance {
                accent: [0., 136. / 255., 1.],
                dark: true,
                reduce_transparency: false,
                window_background: "opaque".into(),
                reduced_motion: false,
                font: "Inter Variable 11".into(),
                text_scale: 1.,
            },
        )
        .unwrap();
        let mut tree = Tree::new("Settings", styles.metrics, styles.text.clone()).unwrap();
        styles.apply(&mut tree).unwrap();
        let content = tree.append(tree.root(), Kind::Scroll, "Content").unwrap();
        let (mut session, _) = Session::start();
        session.handle(Raw::Snapshot(Ok((
            7,
            1,
            r#"{"schemaVersion":1,"keys":{}}"#.into(),
        ))));
        Self {
            exports,
            styles,
            tree,
            editor: Editing(session),
            content,
        }
    }
    fn host(&mut self) -> Host<'_> {
        Host {
            tree: &mut self.tree,
            editor: &mut self.editor,
            exports: &self.exports,
            styles: &self.styles,
            window: None,
            modal: None,
        }
    }
}
fn register(
    builders: &mut Builders,
    trace: &Arc<Mutex<Vec<String>>>,
    name: &'static str,
    build_error: bool,
    unmount_error: bool,
) {
    let trace = trace.clone();
    builders.register(name, move || {
        Box::new(Traced {
            name,
            trace: trace.clone(),
            build_error,
            unmount_error,
            node: None,
        })
    });
}
fn page(names: &[&str]) -> manifest::Page {
    manifest::parse(&serde_json::json!([{"id":"appearance","kind":"preference",
        "label":"settings.appearance.title","groups":[{"items":names.iter()
        .map(|n|serde_json::json!({"decoration":n})).collect::<Vec<_>>()}]}]))
    .unwrap()
    .remove(0)
}
#[test]
fn failed_replacement_retires_new_work_and_preserves_old_mount() {
    let mut f = Fixture::new();
    let trace = Arc::new(Mutex::new(Vec::new()));
    let mut builders = Builders::default();
    register(&mut builders, &trace, "old", false, false);
    register(&mut builders, &trace, "new", false, false);
    register(&mut builders, &trace, "bad", true, false);
    let content = f.content;
    let old = Mounted::build(f.host(), &page(&["old"]), &mut builders, content, 1).unwrap();
    let old_roots = f.tree.node(content).unwrap().children().to_vec();
    let old_ids: Vec<_> = f.tree.semantics().nodes.keys().copied().collect();
    let failed = Mounted::build(f.host(), &page(&["new", "bad"]), &mut builders, content, 2);
    assert!(matches!(failed,Err(ref e) if e=="bad build refused"));
    assert_eq!(
        *trace.lock().unwrap(),
        [
            "build old",
            "build new",
            "build bad",
            "unmount bad",
            "unmount new"
        ]
    );
    assert_eq!(
        f.tree.node(content).unwrap().children(),
        old_roots,
        "failed replacement leaked roots"
    );
    assert_eq!(
        f.tree.semantics().nodes.keys().copied().collect::<Vec<_>>(),
        old_ids
    );
    old.unmount(f.host()).unwrap();
    assert!(f.tree.node(content).unwrap().children().is_empty());
    assert_eq!(trace.lock().unwrap().last().unwrap(), "unmount old");
}
#[test]
fn unmount_failure_still_retires_all_builders_and_nodes() {
    let mut f = Fixture::new();
    let trace = Arc::new(Mutex::new(Vec::new()));
    let mut builders = Builders::default();
    register(&mut builders, &trace, "first", false, true);
    register(&mut builders, &trace, "second", false, false);
    let content = f.content;
    let mounted = Mounted::build(
        f.host(),
        &page(&["first", "second"]),
        &mut builders,
        content,
        1,
    )
    .unwrap();
    assert_eq!(
        mounted.unmount(f.host()).unwrap_err(),
        "first cleanup refused"
    );
    assert_eq!(
        *trace.lock().unwrap(),
        [
            "build first",
            "build second",
            "unmount first",
            "unmount second"
        ]
    );
    assert!(f.tree.node(content).unwrap().children().is_empty());
}
