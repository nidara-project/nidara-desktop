// SPDX-License-Identifier: LGPL-3.0-or-later
//! Decision seam after real activation: no fake Window/portal is constructed here.
use super::*;
use crate::{
    exports::Exports,
    portal::Appearance,
    render::{Editor, Host, Rendered},
    session::{ApplyError, Command, Raw, Session},
    styles::Styles,
};
use nk_text::{FontSet, ParleyBackend, Size};
use nk_widgets::{Command as WidgetCommand, Tree};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
type Decision = Rc<RefCell<Option<(Operation, Result<Option<PathBuf>>)>>>;
struct Probe {
    picker: Rc<RefCell<Picker>>,
    decision: Decision,
    native_idle: Rc<Cell<bool>>,
}
impl Builder for Probe {
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, item: &Item) -> Result<Built> {
        self.picker.borrow_mut().build(cx, group, item)
    }
    fn notice(&mut self, cx: &mut Cx<'_>, notice: &Notice) -> Result<()> {
        self.picker.borrow_mut().notice(cx, notice)
    }
    fn effect(&mut self, cx: &mut Cx<'_>, effect: Effect) -> Result<()> {
        self.picker.borrow_mut().effect(cx, effect)
    }
    fn idle(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        if let Some((op, result)) = self.decision.borrow_mut().take() {
            self.picker.borrow_mut().finish(cx, op, result)
        } else if self.native_idle.get() {
            self.picker.borrow_mut().idle(cx)
        } else {
            Ok(())
        }
    }
    fn shown(&mut self, cx: &mut Cx<'_>, shown: bool) -> Result<()> {
        self.picker.borrow_mut().shown(cx, shown)
    }
    fn external_modal_active(&self) -> bool {
        self.picker.borrow().external_modal_active()
    }
    fn unmount(&mut self, cx: &mut Cx<'_>) -> Result<()> {
        self.picker.borrow_mut().unmount(cx)
    }
}
fn schema(value: &str) -> String {
    serde_json::json!({"schemaVersion":1,"keys":{KEY:{"type":"string","value":value,"available":true,"writable":true}}}).to_string()
}
struct Editing {
    session: Session,
    calls: usize,
    queued: Vec<Raw>,
}
impl Editing {
    fn new() -> Self {
        let (mut session, _) = Session::start();
        session.handle(Raw::Snapshot(Ok((7, 1, schema("/initial.png")))));
        Self {
            session,
            calls: 0,
            queued: vec![],
        }
    }
}
impl Editor for Editing {
    fn session(&self) -> &Session {
        &self.session
    }
    fn apply(&mut self, key: &str, value: Value) -> std::result::Result<(), ApplyError> {
        self.calls += 1;
        assert!(matches!(
            self.session.apply(key, value)?,
            Some(Command::Apply { .. })
        ));
        Ok(())
    }
    fn poll(&mut self) -> Vec<Notice> {
        let mut notices = vec![];
        for raw in std::mem::take(&mut self.queued) {
            notices.extend(self.session.handle(raw).0);
        }
        notices
    }
}
struct Fixture<E> {
    exports: Exports,
    styles: Styles,
    tree: Tree,
    editor: E,
    rendered: Option<Rendered>,
    picker: Rc<RefCell<Picker>>,
    decision: Decision,
    native_idle: Rc<Cell<bool>>,
}
impl<E: Editor> Fixture<E> {
    fn new(editor: E) -> Self {
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
        let mut page = exports.page("appearance").unwrap().clone();
        page.groups.retain(|g| {
            g.items
                .iter()
                .any(|i| matches!(i,Item::Custom{name,..}if name=="wallpaperPicker"))
        });
        for g in &mut page.groups {
            g.items
                .retain(|i| matches!(i,Item::Custom{name,..}if name=="wallpaperPicker"));
        }
        let picker = Rc::new(RefCell::new(Picker::default()));
        let decision = Rc::new(RefCell::new(None));
        let native_idle = Rc::new(Cell::new(false));
        let native = native_idle.clone();
        let mut builders = Builders::default();
        let (p, d) = (picker.clone(), decision.clone());
        builders.register("wallpaperPicker", move || {
            Box::new(Probe {
                picker: p.clone(),
                decision: d.clone(),
                native_idle: native.clone(),
            })
        });
        let mut f = Self {
            exports,
            styles,
            tree,
            editor,
            rendered: None,
            picker,
            decision,
            native_idle,
        };
        f.rendered = Some(Rendered::build(f.host(), &page, &mut builders, content, 17).unwrap());
        f.tree
            .layout(
                Size {
                    width: 900.,
                    height: 720.,
                },
                false,
                &mut ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap(),
            )
            .unwrap();
        f
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
    fn idle(&mut self) -> Vec<Notice> {
        let mut r = self.rendered.take().unwrap();
        let n = r.idle(self.host()).unwrap();
        self.rendered = Some(r);
        n
    }
    fn activate(&mut self) -> Operation {
        let button = self.picker.borrow().button;
        let e = self
            .tree
            .dispatch(self.tree.target(button), WidgetCommand::Activate)
            .unwrap();
        let mut r = self.rendered.take().unwrap();
        assert!(r.effect(self.host(), e).unwrap());
        assert!(r.external_modal_active());
        self.rendered = Some(r);
        self.picker.borrow().pending.as_ref().unwrap().operation
    }
    fn choose(&mut self, op: Operation, result: Result<Option<PathBuf>>) {
        *self.decision.borrow_mut() = Some((op, result));
        self.idle();
    }
    fn name_contains(&self, text: &str) -> bool {
        self.tree
            .semantics()
            .nodes
            .values()
            .any(|n| n.name.contains(text) || n.description.contains(text))
    }
    fn unmount(&mut self) {
        let r = self.rendered.take().unwrap();
        r.unmount(self.host()).unwrap();
    }
}
#[test]
fn decisions_guard_same_cancel_changed_and_fresh_notices_before_acceptance() {
    let mut f = Fixture::new(Editing::new());
    let button = f.picker.borrow().button;
    let op = f.activate();
    f.choose(op, Ok(None));
    assert_eq!(f.editor.calls, 0, "cancel must not Apply");
    assert_eq!(f.tree.focused(), Some(button));
    let op = f.activate();
    f.choose(op, Ok(Some("/initial.png".into())));
    assert_eq!(f.editor.calls, 0);
    let op = f.activate();
    f.choose(
        Operation {
            mount: op.mount,
            request: op.request + 1,
        },
        Ok(Some("/wrong-operation.png".into())),
    );
    assert_eq!(f.editor.calls, 0);
    assert!(f.rendered.as_ref().unwrap().external_modal_active());
    f.choose(op, Ok(Some("/chosen.png".into())));
    assert_eq!(f.editor.calls, 1);
    assert!(f.editor.session.pending(KEY));
    assert!(!f.rendered.as_ref().unwrap().external_modal_active());
    f.editor.queued.push(Raw::Reply {
        key: KEY.into(),
        epoch: 7,
        result: Err(ApplyError::Invalid("fixture refusal".into())),
    });
    let notices = f.idle();
    assert!(notices.iter().any(|n| matches!(n, Notice::Failed { .. })));
    assert_eq!(
        f.editor.session.shown(KEY).and_then(Value::as_text),
        Some("/initial.png")
    );
    assert!(f.name_contains("fixture refusal"));
    let op = f.activate();
    f.choose(op, Ok(None));
    assert_eq!(f.editor.calls, 1);
    assert!(
        f.name_contains("fixture refusal"),
        "cancel erased a canonical refusal without a new answer"
    );
    let op = f.activate();
    f.editor.queued.push(Raw::Updated {
        epoch: 7,
        revision: 2,
        values: vec![(KEY.into(), Value::Text("/external.png".into()))],
    });
    *f.decision.borrow_mut() = Some((op, Ok(Some("/stale.png".into()))));
    let notices = f.idle();
    assert!(!notices.is_empty());
    assert_eq!(
        f.editor.calls, 1,
        "queued Config1 change must retire selection before accepting"
    );
    assert!(!f.rendered.as_ref().unwrap().external_modal_active());
    assert_ne!(
        f.tree.focused(),
        Some(button),
        "invalidated dialog restored launcher focus"
    );
    let op = f.activate();
    f.tree.set_hidden(f.picker.borrow().row, true).unwrap();
    f.choose(op, Ok(Some("/hidden.png".into())));
    assert_eq!(f.editor.calls, 1);
}
#[test]
fn no_window_is_an_explicit_row_error_and_unmount_cancels() {
    let mut f = Fixture::new(Editing::new());
    f.native_idle.set(true);
    f.activate();
    f.idle();
    assert!(f.name_contains("real parent Window"));
    assert_eq!(f.editor.calls, 0);
    assert!(!f.rendered.as_ref().unwrap().external_modal_active());
    f.activate();
    f.unmount();
    assert!(!f.picker.borrow().alive);
    assert!(f.picker.borrow().pending.is_none());
    assert_eq!(f.editor.calls, 0);
}
#[test]
fn full_exported_appearance_mounts_with_only_real_builders() {
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
    let (mut session, _) = Session::start();
    session.handle(Raw::Snapshot(Ok((
        7,
        1,
        include_str!("../../tests/fixtures/appearance-snapshot.json").into(),
    ))));
    let mut editor = Editing {
        session,
        calls: 0,
        queued: vec![],
    };
    let mut tree = Tree::new("Settings", styles.metrics, styles.text.clone()).unwrap();
    styles.apply(&mut tree).unwrap();
    let icons =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara");
    tree.set_icon_theme(nk_icons::Icons::new("", &[], &icons).unwrap());
    let content = tree.append(tree.root(), Kind::Scroll, "Content").unwrap();
    let mut builders = Builders::default();
    crate::builders::register(&mut builders);
    crate::dropdown_builder::register(&mut builders);
    crate::font_builder::register(&mut builders);
    crate::wallpaper::register(
        &mut builders,
        crate::image_load::Budget {
            encoded_bytes: 4 * 1024 * 1024,
            decoded_bytes: 64 * 1024 * 1024,
        },
    );
    register(&mut builders);
    let h = Host {
        tree: &mut tree,
        editor: &mut editor,
        exports: &exports,
        styles: &styles,
        window: None,
        modal: None,
    };
    let rendered = Rendered::build(
        h,
        exports.page("appearance").unwrap(),
        &mut builders,
        content,
        21,
    )
    .unwrap();
    tree.layout(
        Size {
            width: 1000.,
            height: 1200.,
        },
        false,
        &mut ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap(),
    )
    .unwrap();
    assert_eq!(editor.calls, 0);
    assert!(!rendered.external_modal_active());
    let semantics = tree.semantics();
    let browse = semantics
        .nodes
        .keys()
        .find(|id| {
            tree.node(**id).is_some_and(|n| {
                n.kind() == Kind::Button
                    && n.name() == exports.text("settings.appearance.browse").unwrap()
            })
        })
        .expect("full Appearance must include the real Browse caption");
    assert_eq!(
        semantics.nodes[browse].name,
        exports.text("settings.appearance.image").unwrap(),
        "launcher keeps the existing row label relation"
    );
    assert!(
        semantics
            .nodes
            .values()
            .any(|n| n.role == nk_a11y::Role::Image)
    );
    rendered
        .unmount(Host {
            tree: &mut tree,
            editor: &mut editor,
            exports: &exports,
            styles: &styles,
            window: None,
            modal: None,
        })
        .unwrap();
}

struct Bus {
    daemon: std::process::Child,
    directory: PathBuf,
    address: String,
}
impl Bus {
    fn new() -> Self {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("target")
            .join(format!("wp-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let config = directory.join("bus.conf");
        std::fs::write(&config,format!(r#"<busconfig><type>session</type><listen>unix:path={}</listen><auth>EXTERNAL</auth><policy context="default"><allow own="*"/><allow send_destination="*"/><allow eavesdrop="true"/></policy></busconfig>"#,directory.join("bus").display())).unwrap();
        let mut daemon = Command::new("dbus-daemon")
            .arg(format!("--config-file={}", config.display()))
            .args(["--nofork", "--print-address"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut address = String::new();
        assert!(
            BufReader::new(daemon.stdout.take().unwrap())
                .read_line(&mut address)
                .unwrap()
                > 0
        );
        Self {
            daemon,
            directory,
            address: address.trim().into(),
        }
    }
    fn connection(&self) -> zbus::blocking::Connection {
        zbus::blocking::connection::Builder::address(self.address.as_str())
            .unwrap()
            .method_timeout(Duration::from_secs(3))
            .build()
            .unwrap()
    }
}
impl Drop for Bus {
    fn drop(&mut self) {
        let _ = self.daemon.kill();
        let _ = self.daemon.wait();
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}
#[derive(zbus::DBusError, Debug)]
#[zbus(prefix = "org.nidara.Config1.Error")]
enum ConfigError {
    Invalid(String),
    Denied(String),
}
struct ConfigState {
    value: String,
    calls: usize,
    revision: u64,
}
struct Config(Arc<Mutex<ConfigState>>);
#[zbus::interface(name = "org.nidara.Config1")]
impl Config {
    fn snapshot(&self) -> (u64, u64, String) {
        let s = self.0.lock().unwrap();
        (7, s.revision, schema(&s.value))
    }
    async fn apply(
        &self,
        key: String,
        value: zbus::zvariant::OwnedValue,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> std::result::Result<(u64, zbus::zvariant::OwnedValue), ConfigError> {
        let owner = zbus::fdo::DBusProxy::new(connection)
            .await
            .unwrap()
            .get_name_owner("org.nidara.SettingsNative".try_into().unwrap())
            .await
            .unwrap();
        if header
            .sender()
            .is_none_or(|sender| sender.as_str() != owner.as_str())
        {
            return Err(ConfigError::Denied(
                "not the SettingsNative connection".into(),
            ));
        }
        let Some(Value::Text(value)) = Value::from_variant(&value) else {
            return Err(ConfigError::Invalid("not a path string".into()));
        };
        if key != KEY {
            return Err(ConfigError::Invalid("wrong key".into()));
        }
        let mut s = self.0.lock().unwrap();
        s.calls += 1;
        if value == "/refused.png" {
            return Err(ConfigError::Invalid("fixture wallpaper refusal".into()));
        }
        s.value = "/canonical.png".into();
        s.revision += 1;
        Ok((s.revision, Value::Text(s.value.clone()).to_variant()))
    }
}
#[test]
fn real_config1_client_applies_once_and_stages_owner_loss_before_decision() {
    let bus = Bus::new();
    let service = bus.connection();
    let state = Arc::new(Mutex::new(ConfigState {
        value: "/initial.png".into(),
        calls: 0,
        revision: 1,
    }));
    service
        .object_server()
        .at(crate::client::PATH, Config(state.clone()))
        .unwrap();
    service.request_name(crate::client::NAME).unwrap();
    let connection = bus.connection();
    connection
        .request_name("org.nidara.SettingsNative")
        .unwrap();
    let mut client = crate::client::Client::start(connection).unwrap();
    let limit = Instant::now() + Duration::from_secs(5);
    while !client.session().available() {
        assert!(Instant::now() < limit);
        client.wait(limit);
    }
    let mut f = Fixture::new(client);
    let op = f.activate();
    f.choose(op, Ok(None));
    assert_eq!(state.lock().unwrap().calls, 0);
    let op = f.activate();
    f.choose(op, Ok(Some("/initial.png".into())));
    assert_eq!(state.lock().unwrap().calls, 0);
    let op = f.activate();
    f.choose(op, Ok(Some("/chosen.png".into())));
    let limit = Instant::now() + Duration::from_secs(5);
    while f.editor.session().pending(KEY) {
        assert!(Instant::now() < limit);
        f.idle();
        std::thread::yield_now();
    }
    assert_eq!(state.lock().unwrap().calls, 1);
    assert_eq!(
        f.editor.session().shown(KEY).and_then(Value::as_text),
        Some("/canonical.png")
    );
    assert!(f.name_contains("/canonical.png"));
    let op = f.activate();
    f.choose(op, Ok(Some("/refused.png".into())));
    let limit = Instant::now() + Duration::from_secs(5);
    while f.editor.session().pending(KEY) {
        assert!(Instant::now() < limit);
        f.idle();
        std::thread::yield_now();
    }
    assert_eq!(state.lock().unwrap().calls, 2);
    assert_eq!(
        f.editor.session().shown(KEY).and_then(Value::as_text),
        Some("/canonical.png")
    );
    assert!(f.name_contains("fixture wallpaper refusal"));
    let op = f.activate();
    f.choose(op, Ok(None));
    assert_eq!(state.lock().unwrap().calls, 2);
    assert!(f.name_contains("fixture wallpaper refusal"));
    let op = f.activate();
    service.release_name(crate::client::NAME).unwrap();
    let limit = Instant::now() + Duration::from_secs(5);
    let mut noticed = false;
    while f.editor.session().available() {
        assert!(Instant::now() < limit);
        noticed |= !f.idle().is_empty();
        std::thread::yield_now();
    }
    assert!(noticed);
    f.choose(op, Ok(Some("/after-owner-loss.png".into())));
    assert_eq!(state.lock().unwrap().calls, 2);
    assert!(!f.rendered.as_ref().unwrap().external_modal_active());
    assert!(!f.picker.borrow().chooser.pending());
    f.unmount();
}

#[test]
fn queued_config_change_precedes_async_decision_and_is_returned_to_host() {
    let mut f = Fixture::new(Editing::new());
    let operation = f.activate();
    f.editor.queued.push(Raw::Updated {
        epoch: 7,
        revision: 2,
        values: vec![(KEY.into(), Value::Text("/external.png".into()))],
    });
    *f.decision.borrow_mut() = Some((operation, Ok(Some("/stale.png".into()))));
    let notices = f.idle();
    assert_eq!(
        f.editor.calls, 0,
        "queued Config1 notice was ignored before picker acceptance"
    );
    assert_eq!(
        f.editor.session.shown(KEY).and_then(Value::as_text),
        Some("/external.png")
    );
    assert!(
        notices
            .iter()
            .any(|n| matches!(n,Notice::Changed(keys)if keys.iter().any(|key|key==KEY)))
    );
    assert!(!f.rendered.as_ref().unwrap().external_modal_active());
}
