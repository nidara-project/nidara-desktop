// SPDX-License-Identifier: LGPL-3.0-or-later
//! The client against a `Config1` on a private bus (a `dbus-daemon` of its own, never the
//! session's): what `session.rs`'s unit tests take as given — that the signals, the owner and
//! the replies arrive as `Raw` — is checked here on a real bus, through a server restart.

use nk_settings::Value;
use nk_settings::client::Client;
use nk_settings::session::{ApplyError, Notice};
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zbus::blocking::Connection;
use zbus::object_server::SignalEmitter;
use zbus::zvariant::OwnedValue;

struct Bus {
    daemon: Child,
    address: String,
    directory: std::path::PathBuf,
}

impl Bus {
    fn new() -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("target")
            .join(format!(
                "cb-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
        std::fs::create_dir_all(&directory).unwrap();
        let mut daemon = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address"])
            .arg(format!("--address=unix:path={}/bus", directory.display()))
            .stdout(Stdio::piped())
            .spawn()
            .expect("dbus-daemon (the test needs one; it is in the toolkit job's packages)");
        let mut address = String::new();
        BufReader::new(daemon.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        Self {
            daemon,
            address: address.trim().to_owned(),
            directory,
        }
    }

    fn connect(&self) -> Connection {
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

#[derive(Clone)]
struct State {
    epoch: u64,
    revision: u64,
    dark: bool,
    temperature: f64,
}

struct Config(Arc<Mutex<State>>);

fn schema(s: &State) -> String {
    serde_json::json!({
        "schemaVersion": 1,
        "keys": {
            "appearance.darkMode": {"type": "boolean", "value": s.dark, "writable": true, "available": true},
            "nightlight.temperature": {"type": "number", "value": s.temperature, "writable": true, "available": true},
            "slow.key": {"type": "boolean", "value": false, "writable": true, "available": true},
        }
    })
    .to_string()
}

#[zbus::interface(name = "org.nidara.Config1")]
impl Config {
    fn snapshot(&self) -> (u64, u64, String) {
        let s = self.0.lock().unwrap();
        (s.epoch, s.revision, schema(&s))
    }

    async fn apply(
        &self,
        key: String,
        value: OwnedValue,
        #[zbus(signal_emitter)] emitter: SignalEmitter<'_>,
    ) -> zbus::fdo::Result<(u64, OwnedValue)> {
        if key == "slow.key" {
            // Never answers: the owner goes away first.
            std::future::pending::<()>().await;
        }
        let (epoch, revision, canonical) = {
            let mut s = self.0.lock().unwrap();
            let canonical = match (key.as_str(), Value::from_variant(&value)) {
                ("appearance.darkMode", Some(Value::Bool(b))) => {
                    s.dark = b;
                    Value::Bool(b)
                }
                ("nightlight.temperature", Some(Value::Number(n)))
                    if (1000.0..=10000.0).contains(&n) =>
                {
                    // The service rounds: the canonical value is not the one sent.
                    s.temperature = n.round();
                    Value::Number(s.temperature)
                }
                _ => return Err(zbus::fdo::Error::Failed("unused".into())),
            };
            s.revision += 1;
            (s.epoch, s.revision, canonical)
        };
        Self::updated(
            &emitter,
            epoch,
            revision,
            [(key.as_str(), canonical.to_variant())].into(),
        )
        .await?;
        Ok((revision, canonical.to_variant()))
    }

    #[zbus(signal)]
    async fn updated(
        emitter: &SignalEmitter<'_>,
        epoch: u64,
        revision: u64,
        values: std::collections::HashMap<&str, OwnedValue>,
    ) -> zbus::Result<()>;
}

/// The registry's refusal, by its own error name.
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.Config1.Error")]
enum ConfigError {
    Invalid(String),
}

struct Strict;

#[zbus::interface(name = "org.nidara.Config1")]
impl Strict {
    fn snapshot(&self) -> (u64, u64, String) {
        let s = State {
            epoch: 7,
            revision: 0,
            dark: true,
            temperature: 4500.0,
        };
        (s.epoch, s.revision, schema(&s))
    }

    fn apply(&self, _key: String, _value: OwnedValue) -> Result<(u64, OwnedValue), ConfigError> {
        Err(ConfigError::Invalid("out of range".into()))
    }
}

fn serve(bus: &Bus, iface: impl zbus::object_server::Interface) -> Connection {
    let c = bus.connect();
    c.object_server().at("/org/nidara/Config", iface).unwrap();
    c.request_name("org.nidara.Config").unwrap();
    c
}

/// Feeds the client until `want` is among what it was told, or fails after a deadline (the
/// notices seen are in the message).
fn until(client: &mut Client, what: &str, want: impl Fn(&Notice) -> bool) -> Vec<Notice> {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        let n = client.wait(deadline);
        let hit = n.iter().any(&want);
        seen.extend(n);
        if hit {
            return seen;
        }
    }
    panic!("never told {what}; told {seen:?}");
}

fn temperature(client: &Client) -> Option<f64> {
    client
        .session()
        .shown("nightlight.temperature")?
        .as_number()
}

#[test]
fn follows_the_service_through_a_restart() {
    let bus = Bus::new();
    // The client comes up first: no service yet is an error said, then the owner's arrival
    // reads it.
    let mut client = Client::start(bus.connect()).unwrap();
    until(&mut client, "the missing service", |n| {
        matches!(n, Notice::Error(_))
    });
    assert!(!client.session().available());

    let state = Arc::new(Mutex::new(State {
        epoch: 1,
        revision: 4,
        dark: true,
        temperature: 4500.0,
    }));
    let server = serve(&bus, Config(state.clone()));
    until(&mut client, "ready", |n| *n == Notice::Ready);
    assert_eq!(client.session().store().unwrap().revision, 4);

    // A write answers its canonical value (rounded).
    client
        .apply("nightlight.temperature", Value::Number(3333.4))
        .unwrap();
    until(&mut client, "the answer", |n| {
        *n == Notice::Changed(vec!["nightlight.temperature".into()])
    });
    assert_eq!(temperature(&client), Some(3333.0));
    assert!(!client.session().pending("nightlight.temperature"));

    // Another writer: the announcement reaches the client.
    {
        let mut s = state.lock().unwrap();
        s.revision += 1;
        s.dark = false;
    }
    let (epoch, revision) = {
        let s = state.lock().unwrap();
        (s.epoch, s.revision)
    };
    let iface = server
        .object_server()
        .interface::<_, Config>("/org/nidara/Config")
        .unwrap();
    zbus::block_on(Config::updated(
        iface.signal_emitter(),
        epoch,
        revision,
        [("appearance.darkMode", Value::Bool(false).to_variant())].into(),
    ))
    .unwrap();
    until(&mut client, "another writer's change", |n| {
        *n == Notice::Changed(vec!["appearance.darkMode".into()])
    });

    // The owner goes away with a write in flight: reported failed, controls unavailable.
    client.apply("slow.key", Value::Bool(true)).unwrap();
    std::thread::sleep(Duration::from_millis(100));
    // The name goes as a dying shell's would. (Dropping the connection is not enough: the
    // object server's executor keeps it open while the slow call is pending.)
    drop(iface);
    server.release_name("org.nidara.Config").unwrap();
    let told = until(&mut client, "unavailable", |n| *n == Notice::Unavailable);
    assert!(
        told.contains(&Notice::Failed {
            key: "slow.key".into(),
            error: ApplyError::NoReply
        }),
        "the write in flight was not reported failed: {told:?}"
    );
    assert!(!client.session().available());
    assert_eq!(
        client.apply("appearance.darkMode", Value::Bool(true)),
        Err(ApplyError::Unavailable)
    );

    // Back, as a new instance with other values: read afresh, nothing replayed.
    let state = Arc::new(Mutex::new(State {
        epoch: 2,
        revision: 0,
        dark: true,
        temperature: 5000.0,
    }));
    let _again = serve(&bus, Config(state));
    until(&mut client, "ready again", |n| *n == Notice::Ready);
    assert!(client.session().available());
    assert_eq!(client.session().store().unwrap().epoch, 2);
    assert_eq!(temperature(&client), Some(5000.0));
}

#[test]
fn a_refusal_comes_back_by_its_name() {
    let bus = Bus::new();
    let _server = serve(&bus, Strict);
    let mut client = Client::start(bus.connect()).unwrap();
    until(&mut client, "ready", |n| *n == Notice::Ready);
    client
        .apply("nightlight.temperature", Value::Number(1.0))
        .unwrap();
    let told = until(&mut client, "the refusal", |n| {
        matches!(n, Notice::Failed { .. })
    });
    assert!(
        told.contains(&Notice::Failed {
            key: "nightlight.temperature".into(),
            error: ApplyError::Invalid("out of range".into())
        }),
        "{told:?}"
    );
    assert_eq!(temperature(&client), Some(4500.0));
}

struct EnumConfig(Arc<Mutex<(String, usize)>>);
#[zbus::interface(name = "org.nidara.Config1")]
impl EnumConfig {
    fn snapshot(&self) -> (u64, u64, String) {
        let state = self.0.lock().unwrap();
        (31, state.1 as u64, serde_json::json!({"schemaVersion":1,"keys":{
            "appearance.cursorTheme":{"type":"enum","available":true,"writable":true,
                "value":state.0,"values":["Adwaita","Qogir"],
                "ui":{"control":"dropdown","title":"Cursor","subtitle":"Choose cursor",
                    "options":[{"value":"Adwaita","label":"Adwaita"},{"value":"Qogir","label":"Brisa 日本語"}]}}
        }}).to_string())
    }
    fn apply(&self, key: String, value: OwnedValue) -> Result<(u64, OwnedValue), ConfigError> {
        let mut state = self.0.lock().unwrap();
        state.1 += 1;
        if key != "appearance.cursorTheme"
            || Value::from_variant(&value) != Some(Value::Text("Qogir".into()))
        {
            return Err(ConfigError::Invalid("fixture rejects this cursor".into()));
        }
        state.0 = "Qogir".into();
        Ok((state.1 as u64, Value::Text(state.0.clone()).to_variant()))
    }
}

#[test]
fn real_dropdown_builder_writes_config1_and_keeps_canonical_value_on_bus_refusal() {
    use nk_settings::{
        exports::Exports,
        portal::Appearance,
        render::{Builders, Editor, Host, Rendered},
        styles::Styles,
    };
    use nk_widgets::{Command as WidgetCommand, Kind, Tree};
    let data = std::env::var_os("NK_SETTINGS_DATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
        });
    if !data.join("manifest.json").exists() {
        assert!(
            std::env::var_os("NK_REQUIRE_EXPORT").is_none(),
            "real settings-data required"
        );
        return;
    }
    let exports = Exports::load(&data).unwrap();
    let styles = Styles::new(
        &exports,
        &Appearance {
            accent: [0., 136. / 255., 1.],
            dark: true,
            reduce_transparency: false,
            window_background: "tinted".into(),
            reduced_motion: false,
            font: "Inter Variable 11".into(),
            text_scale: 1.,
        },
    )
    .unwrap();
    let bus = Bus::new();
    let state = Arc::new(Mutex::new(("Adwaita".into(), 0)));
    let _server = serve(&bus, EnumConfig(state.clone()));
    let mut client = Client::start(bus.connect()).unwrap();
    until(&mut client, "initial enum snapshot", |n| {
        matches!(n, Notice::Ready)
    });
    let page = nk_settings::manifest::parse(&serde_json::json!([{"id":"test","kind":"preference",
        "label":"settings.appearance.title","groups":[{"items":["appearance.cursorTheme"]}]}]))
    .unwrap()
    .remove(0);
    let mut tree = Tree::new("Bus dropdown", styles.metrics, styles.text.clone()).unwrap();
    styles.apply(&mut tree).unwrap();
    let scroll = tree.append(tree.root(), Kind::Scroll, "Content").unwrap();
    let mut builders = Builders::default();
    nk_settings::dropdown_builder::register(&mut builders);
    let mut rendered = Rendered::build(
        Host {
            tree: &mut tree,
            editor: &mut client,
            exports: &exports,
            styles: &styles,
            window: None,
            modal: None,
        },
        &page,
        &mut builders,
        scroll,
        1,
    )
    .unwrap();
    let combo = tree
        .semantics()
        .nodes
        .values()
        .find(|n| n.role == nk_a11y::Role::ComboBox)
        .unwrap()
        .id;
    let options = tree.node(combo).unwrap().children().to_vec();
    assert_eq!(
        state.lock().unwrap().1,
        0,
        "reading the schema must not Apply"
    );
    for (index, expected_calls) in [(1, 1), (0, 2)] {
        let effect = tree
            .dispatch(tree.target(options[index]), WidgetCommand::Activate)
            .unwrap();
        rendered
            .effect(
                Host {
                    tree: &mut tree,
                    editor: &mut client,
                    exports: &exports,
                    styles: &styles,
                    window: None,
                    modal: None,
                },
                effect,
            )
            .unwrap();
        // Completion is the pending request ending, independent of expected value/call count.
        let deadline = Instant::now() + Duration::from_secs(5);
        while client.session().pending("appearance.cursorTheme") && Instant::now() < deadline {
            let notices = <Client as Editor>::poll(&mut client);
            rendered
                .notices(
                    Host {
                        tree: &mut tree,
                        editor: &mut client,
                        exports: &exports,
                        styles: &styles,
                        window: None,
                        modal: None,
                    },
                    &notices,
                )
                .unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(
            !client.session().pending("appearance.cursorTheme"),
            "Apply did not complete"
        );
        assert_eq!(state.lock().unwrap().1, expected_calls);
        assert_eq!(state.lock().unwrap().0, "Qogir");
        assert_eq!(tree.node(combo).unwrap().name(), "Brisa 日本語");
    }
    assert!(
        tree.semantics()
            .nodes
            .values()
            .any(|n| n.name == "fixture rejects this cursor")
    );
}

struct FontState {
    values: std::collections::BTreeMap<String, String>,
    calls: usize,
}
struct FontConfig(Arc<Mutex<FontState>>);
#[zbus::interface(name = "org.nidara.Config1")]
impl FontConfig {
    fn snapshot(&self) -> (u64, u64, String) {
        let state = self.0.lock().unwrap();
        let keys: serde_json::Map<String, serde_json::Value> = state.values.iter().map(|(key,value)|
            (key.clone(),serde_json::json!({"type":"string","available":true,"writable":true,"value":value}))).collect();
        (
            83,
            state.calls as u64,
            serde_json::json!({"schemaVersion":1,"keys":keys}).to_string(),
        )
    }
    fn apply(&self, key: String, value: OwnedValue) -> Result<(u64, OwnedValue), ConfigError> {
        let mut state = self.0.lock().unwrap();
        state.calls += 1;
        let Some(Value::Text(value)) = Value::from_variant(&value) else {
            return Err(ConfigError::Invalid("not a font string".into()));
        };
        if key == "appearance.monoFont" {
            return Err(ConfigError::Invalid("denied-by-font-fixture".into()));
        }
        if !state.values.contains_key(&key) {
            return Err(ConfigError::Invalid("wrong font key".into()));
        }
        let value = if value == "Noto Sans Bold 13" {
            "Noto Sans Bold 13.0".to_owned()
        } else {
            value
        };
        state.values.insert(key, value.clone());
        Ok((state.calls as u64, Value::Text(value).to_variant()))
    }
}

/// Test-only modal decision seam: no Window/provider/chooser is fabricated. It
/// exercises the real renderer/builder/client/Config1 path after a modal decision.
struct FontDecisions {
    choices: std::collections::VecDeque<Option<nk_settings::font_chooser::Selection>>,
    operations: Vec<nk_settings::font_catalog::Operation>,
    release_owner: Option<Connection>,
    notices: Vec<Notice>,
}
impl nk_settings::render::Modal for FontDecisions {
    fn dropdown(
        &mut self,
        _: &mut nk_widgets::Tree,
        _: &mut nk_wayland::Window,
        _: &nk_settings::styles::Styles,
        _: &mut dyn nk_settings::render::Editor,
        _: nk_widgets::NodeId,
    ) -> Result<nk_widgets::Effect, String> {
        Err("not a dropdown fixture".into())
    }
    fn font(
        &mut self,
        tree: &mut nk_widgets::Tree,
        window: Option<&mut nk_wayland::Window>,
        _: &nk_settings::styles::Styles,
        editor: &mut dyn nk_settings::render::Editor,
        request: nk_settings::font_chooser::Request,
    ) -> Result<Option<nk_settings::font_chooser::Selection>, String> {
        assert!(
            window.is_none(),
            "decision fixture is headless, not native evidence"
        );
        assert_eq!(request.operation.mount, 17);
        assert_eq!(
            request.title,
            tree.semantics().nodes[&request.launcher].name
        );
        assert!(
            self.operations
                .iter()
                .all(|old| old.request != request.operation.request)
        );
        self.operations.push(request.operation);
        if let Some(owner) = self.release_owner.take() {
            owner.release_name("org.nidara.Config").unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                if !nk_settings::render::stage_modal_notices(
                    editor,
                    &mut self.notices,
                    &mut || Ok(true),
                )? {
                    break;
                }
                assert!(
                    Instant::now() < deadline,
                    "owner loss notice did not arrive"
                );
                std::thread::sleep(Duration::from_millis(2));
            }
            assert!(!self.notices.is_empty());
            return Ok(None);
        }
        Ok(self
            .choices
            .pop_front()
            .expect("one decision per activation"))
    }
}

#[test]
fn real_font_builders_apply_once_and_keep_canonical_refusals_on_private_bus() {
    use nk_settings::{
        exports::Exports,
        font_chooser::Selection,
        portal::Appearance,
        render::{Builders, Editor, Host, Rendered},
        styles::Styles,
    };
    use nk_widgets::{Command as WidgetCommand, Effect, Kind, Tree};
    let data = std::env::var_os("NK_SETTINGS_DATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../build/settings-data")
        });
    if !data.join("manifest.json").exists() {
        assert!(
            std::env::var_os("NK_REQUIRE_EXPORT").is_none(),
            "real exports required"
        );
        return;
    }
    let exports = Exports::load(&data).unwrap();
    let appearance = Appearance {
        accent: [0., 136. / 255., 1.],
        dark: true,
        reduce_transparency: false,
        window_background: "tinted".into(),
        reduced_motion: false,
        font: "Inter Variable 11".into(),
        text_scale: 1.25,
    };
    let styles = Styles::new(&exports, &appearance).unwrap();
    let bus = Bus::new();
    let state = Arc::new(Mutex::new(FontState {
        values: [
            (
                "appearance.interfaceFont".into(),
                "Noto Sans Regular 11".into(),
            ),
            ("appearance.monoFont".into(), "Unmapped family 11".into()),
        ]
        .into(),
        calls: 0,
    }));
    let server = serve(&bus, FontConfig(state.clone()));
    let mut client = Client::start(bus.connect()).unwrap();
    until(&mut client, "font snapshot", |n| matches!(n, Notice::Ready));
    let mut page = exports
        .pages
        .iter()
        .find(|page| page.id == "appearance")
        .unwrap()
        .clone();
    page.groups.retain(|group| group.items.iter().any(|item| matches!(item,nk_settings::manifest::Item::Custom{name,..} if name=="interfaceFont" || name=="monoFont")));
    assert_eq!(page.groups.len(), 1, "actual exported fonts group");
    assert_eq!(page.groups[0].items.len(), 2);
    let mut tree = Tree::new("Fonts", styles.metrics, styles.text.clone()).unwrap();
    styles.apply(&mut tree).unwrap();
    let content = tree.append(tree.root(), Kind::Scroll, "Content").unwrap();
    let mut builders = Builders::default();
    nk_settings::font_builder::register(&mut builders);
    let mut rendered = Rendered::build(
        Host {
            tree: &mut tree,
            editor: &mut client,
            exports: &exports,
            styles: &styles,
            window: None,
            modal: None,
        },
        &page,
        &mut builders,
        content,
        17,
    )
    .unwrap();
    let interface = tree
        .semantics()
        .nodes
        .values()
        .find(|n| {
            n.role == nk_a11y::Role::Button
                && n.name == exports.text("settings.appearance.interface-font").unwrap()
        })
        .unwrap()
        .id;
    let mono = tree
        .semantics()
        .nodes
        .values()
        .find(|n| {
            n.role == nk_a11y::Role::Button
                && n.name == exports.text("settings.appearance.mono-font").unwrap()
        })
        .unwrap()
        .id;
    assert_eq!(tree.node(mono).unwrap().name(), "Unmapped family 11");
    assert!(
        tree.semantics().nodes[&mono]
            .description
            .contains("Unmapped family 11")
    );
    assert_eq!(
        state.lock().unwrap().calls,
        0,
        "build/canonical/unknown reads cannot Apply"
    );
    let accepted = Selection::parse("Noto Sans Bold 13").unwrap();
    let mut decisions = FontDecisions {
        choices: vec![
            Some(Selection::parse("Noto Sans 11").unwrap()),
            Some(accepted.clone()),
            Some(Selection::parse("Noto Sans Italic 14").unwrap()),
            None,
            Some(accepted),
        ]
        .into(),
        operations: vec![],
        release_owner: None,
        notices: vec![],
    };
    for (button, calls) in [
        (interface, 0),
        (interface, 1),
        (mono, 2),
        (interface, 2),
        (interface, 2),
    ] {
        let effect = tree
            .dispatch(tree.target(button), WidgetCommand::Activate)
            .unwrap();
        assert_eq!(effect, Effect::Activated(button));
        rendered
            .effect(
                Host {
                    tree: &mut tree,
                    editor: &mut client,
                    exports: &exports,
                    styles: &styles,
                    window: None,
                    modal: Some(&mut decisions),
                },
                effect,
            )
            .unwrap();
        let key = if button == interface {
            "appearance.interfaceFont"
        } else {
            "appearance.monoFont"
        };
        let deadline = Instant::now() + Duration::from_secs(5);
        while client.session().pending(key) && Instant::now() < deadline {
            let notices = <Client as Editor>::poll(&mut client);
            rendered
                .notices(
                    Host {
                        tree: &mut tree,
                        editor: &mut client,
                        exports: &exports,
                        styles: &styles,
                        window: None,
                        modal: None,
                    },
                    &notices,
                )
                .unwrap();
            std::thread::sleep(Duration::from_millis(2));
        }
        assert!(
            !client.session().pending(key),
            "font Apply did not complete"
        );
        assert_eq!(
            state.lock().unwrap().calls,
            calls,
            "one Apply per changed accepted font, none for cancel/same"
        );
    }
    assert_eq!(tree.node(interface).unwrap().name(), "Noto Sans Bold 13.0");
    assert_eq!(tree.node(mono).unwrap().name(), "Unmapped family 11");
    assert!(
        tree.semantics().nodes[&mono]
            .description
            .contains("denied-by-font-fixture"),
        "refusal error must survive canonical Changed notices"
    );
    let mut text = nk_text::ParleyBackend::with_system_fonts(Arc::new(
        nk_text::FontSet::discover_required().unwrap(),
    ))
    .unwrap();
    tree.layout(
        nk_text::Size {
            width: 640.,
            height: 480.,
        },
        false,
        &mut text,
    )
    .unwrap();
    let caption = tree.node(interface).unwrap().text_layout().unwrap();
    assert_eq!(caption.style().family, "Noto Sans");
    assert_eq!(caption.style().weight, 700.);
    assert_eq!(caption.style().size, 13. * (96. / 72.) * 1.25);
    let mut changed_appearance = appearance.clone();
    changed_appearance.text_scale = 1.5;
    let changed_styles = Styles::new(&exports, &changed_appearance).unwrap();
    changed_styles.apply(&mut tree).unwrap();
    rendered
        .idle(Host {
            tree: &mut tree,
            editor: &mut client,
            exports: &exports,
            styles: &changed_styles,
            window: None,
            modal: None,
        })
        .unwrap();
    tree.layout(
        nk_text::Size {
            width: 640.,
            height: 480.,
        },
        false,
        &mut text,
    )
    .unwrap();
    assert_eq!(
        tree.node(interface)
            .unwrap()
            .text_layout()
            .unwrap()
            .style()
            .size,
        13. * (96. / 72.) * 1.5,
        "mounted font caption must follow the actual portal scale source"
    );
    assert_eq!(
        state.lock().unwrap().calls,
        2,
        "appearance changes cannot Apply font settings"
    );
    tree.acknowledge();
    rendered
        .idle(Host {
            tree: &mut tree,
            editor: &mut client,
            exports: &exports,
            styles: &changed_styles,
            window: None,
            modal: None,
        })
        .unwrap();
    assert!(
        !tree.invalidation().paint,
        "unchanged appearance must not keep repainting"
    );
    let styles = changed_styles;
    assert!(decisions.choices.is_empty());
    // Stale activation while hidden cannot even ask the modal.
    let row = tree
        .semantics()
        .nodes
        .values()
        .find(|node| node.children.contains(&interface))
        .unwrap()
        .id;
    tree.set_hidden(row, true).unwrap();
    rendered
        .effect(
            Host {
                tree: &mut tree,
                editor: &mut client,
                exports: &exports,
                styles: &styles,
                window: None,
                modal: Some(&mut decisions),
            },
            Effect::Activated(interface),
        )
        .unwrap();
    assert_eq!(decisions.operations.len(), 5);
    tree.set_hidden(row, false).unwrap();
    // Production staging predicate consumes a real Config1 owner-loss notice.
    decisions.release_owner = Some(server);
    rendered
        .effect(
            Host {
                tree: &mut tree,
                editor: &mut client,
                exports: &exports,
                styles: &styles,
                window: None,
                modal: Some(&mut decisions),
            },
            Effect::Activated(interface),
        )
        .unwrap();
    rendered
        .notices(
            Host {
                tree: &mut tree,
                editor: &mut client,
                exports: &exports,
                styles: &styles,
                window: None,
                modal: None,
            },
            &decisions.notices,
        )
        .unwrap();
    assert!(!client.session().available());
    assert_eq!(state.lock().unwrap().calls, 2);
    assert!(tree.semantics().nodes[&interface].states.disabled);
    rendered
        .unmount(Host {
            tree: &mut tree,
            editor: &mut client,
            exports: &exports,
            styles: &styles,
            window: None,
            modal: None,
        })
        .unwrap();
    tree.remove(content).unwrap(); // Renderer unmount stops callbacks; host removes nodes.
    assert!(tree.node(interface).is_none());
}
