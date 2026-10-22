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
}

impl Bus {
    fn new() -> Self {
        let mut daemon = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address"])
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
