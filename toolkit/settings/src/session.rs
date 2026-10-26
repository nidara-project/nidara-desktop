// SPDX-License-Identifier: LGPL-3.0-or-later
//! What the app knows of the settings, and the rules that keep it right (PHASE1.md [A3]).
//!
//! No D-Bus here: the transport (`client.rs`) reports what arrived, in the order it arrived,
//! as [`Raw`], and carries out the [`Command`]s this answers. Every ordering rule of the
//! contract lives in this file, so it is tested without a bus:
//!
//! - subscribe to `Updated`, then `Snapshot`; an `Updated` that arrives before the snapshot
//!   answers is held, and kept only if its revision is above the snapshot's;
//! - revisions move by one per announcement: an `Updated` at or below the store's revision is
//!   old, one past the next is a gap (a signal lost) and takes a fresh snapshot;
//! - an event or a reply of another epoch is never applied: the server restarted, and only a
//!   fresh snapshot tells what is true now;
//! - owner lost: every control insensitive, every write in flight reported failed, nothing
//!   replayed; owner back: a fresh snapshot;
//! - at most one `Apply` in flight per key; the latest value asked meanwhile waits, and is sent
//!   when the reply comes, so the last value a slider was released on always reaches the service.

use crate::value::Value;
use std::collections::{BTreeMap, HashMap};

/// The schema version this build draws (`Snapshot`'s `schemaVersion`); another one is an
/// error shown, never a page drawn from fields it may not mean (PHASE1.md D2).
pub const SCHEMA_VERSION: u64 = 1;

/// Updated signals held while the snapshot is asked: past this, the snapshot is asked again
/// (a server that announces faster than it answers cannot grow the client).
const MAX_EARLY: usize = 256;

/// One key of the registry, as the last snapshot or announcement left it.
#[derive(Clone, Debug)]
pub struct Key {
    /// The schema entry (`type`, `values`, `min`/`max`, `ui`, `catalogue`, `writable`…) — read
    /// by the renderer; the session itself only reads `value` and `available`.
    pub entry: serde_json::Value,
    /// None: the service sent no value for it (an unavailable key may have none).
    pub value: Option<Value>,
    /// `available: false` — listed, not omitted, so the row can hide deliberately.
    pub available: bool,
    /// The revision the value is from: a reply of an older one does not overwrite it.
    revision: u64,
}

impl Key {
    pub fn writable(&self) -> bool {
        self.entry["writable"].as_bool().unwrap_or(false)
    }
}

/// The settings at one revision of one epoch.
#[derive(Clone, Debug)]
pub struct Store {
    pub epoch: u64,
    pub revision: u64,
    keys: BTreeMap<String, Key>,
}

/// Turns an i18n key into the app's text (its own catalogue, D4): set once by the app.
pub type Translate = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;
static TRANSLATE: std::sync::OnceLock<Translate> = std::sync::OnceLock::new();

/// Labels a schema leaves to the client — `ui.i18n` without a `title`, an option with an
/// `i18n` and no `label`, as the Rust `Config1` serves them — come from `translate`. A server
/// that sends its labels (the TypeScript shell's) is left as it is.
pub fn set_translator(translate: Translate) {
    let _ = TRANSLATE.set(translate);
}
fn localize(entry: &mut serde_json::Value) {
    let Some(t) = TRANSLATE.get() else { return };
    let ui = &mut entry["ui"];
    let Some(i18n) = ui["i18n"].as_str().map(str::to_owned) else {
        return;
    };
    if ui["title"].is_null()
        && let Some(title) = t(&i18n)
    {
        ui["title"] = title.into();
    }
    if ui["subtitle"].is_null()
        && let Some(subtitle) = t(&format!("{i18n}.desc"))
    {
        ui["subtitle"] = subtitle.into();
    }
    if let Some(options) = ui["options"].as_array_mut() {
        for o in options {
            if o["label"].is_null()
                && let Some(label) = o["i18n"].as_str().and_then(t)
            {
                o["label"] = label.into();
            }
        }
    }
}

impl Store {
    /// `Snapshot`'s answer.
    pub fn parse(epoch: u64, revision: u64, schema: &str) -> Result<Self, String> {
        let schema: serde_json::Value =
            serde_json::from_str(schema).map_err(|e| format!("Config1 snapshot: {e}"))?;
        match schema["schemaVersion"].as_u64() {
            Some(SCHEMA_VERSION) => {}
            v => {
                return Err(format!(
                    "Config1 schemaVersion {v:?}, this build reads {SCHEMA_VERSION}"
                ));
            }
        }
        let entries = schema["keys"]
            .as_object()
            .ok_or("Config1 snapshot has no keys")?;
        let keys = entries
            .iter()
            .map(|(name, entry)| {
                let mut entry = entry.clone();
                localize(&mut entry);
                let key = Key {
                    value: Value::from_json(&entry["value"]),
                    available: entry["available"].as_bool().unwrap_or(true),
                    entry,
                    revision,
                };
                (name.clone(), key)
            })
            .collect();
        Ok(Self {
            epoch,
            revision,
            keys,
        })
    }

    pub fn key(&self, name: &str) -> Option<&Key> {
        self.keys.get(name)
    }

    pub fn value(&self, name: &str) -> Option<&Value> {
        self.keys.get(name)?.value.as_ref()
    }

    pub fn keys(&self) -> impl Iterator<Item = (&str, &Key)> {
        self.keys.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// Sets what an announcement or a reply says; whether the value changed.
    fn set(&mut self, name: &str, value: Value, revision: u64) -> bool {
        let Some(key) = self.keys.get_mut(name) else {
            // A key the snapshot did not list: the registry does not grow at run time, so this
            // is a server newer than its schema — not drawn, not invented.
            return false;
        };
        if revision < key.revision {
            return false;
        }
        key.revision = revision;
        let changed = key.value.as_ref() != Some(&value);
        key.value = Some(value);
        changed
    }
}

/// Why a write did not land. The row goes back to the value in force and says so.
#[derive(Clone, Debug, PartialEq)]
pub enum ApplyError {
    /// The registry refused the value (`org.nidara.Config1.Error.Invalid`).
    Invalid(String),
    /// The gate refused the writer (`…Denied`): this process does not own
    /// `org.nidara.SettingsNative`.
    Denied(String),
    /// The service threw while applying it (`…Failed`), or the call failed on the bus.
    Failed(String),
    /// No reply came: the owner went away, or the call timed out. Never retried.
    NoReply,
    /// Not sent: the service is not there, or the key is unavailable or read-only.
    Unavailable,
}

/// What the transport reports, in the order it arrived.
#[derive(Debug)]
pub enum Raw {
    Updated {
        epoch: u64,
        revision: u64,
        values: Vec<(String, Value)>,
    },
    /// `Snapshot`'s answer: (epoch, revision, schema JSON), or the call's error.
    Snapshot(Result<(u64, u64, String), String>),
    /// `org.nidara.Config` has an owner (true) or lost it (false).
    Owner(bool),
    /// `Apply`'s answer for a write sent at `epoch`.
    Reply {
        key: String,
        epoch: u64,
        result: Result<(u64, Value), ApplyError>,
    },
}

/// What the transport is to do.
#[derive(Debug, PartialEq)]
pub enum Command {
    Snapshot,
    Apply {
        key: String,
        value: Value,
        epoch: u64,
    },
}

/// What the app is told.
#[derive(Debug, PartialEq)]
pub enum Notice {
    /// A fresh store (the first snapshot, or one after a restart or a gap): redraw everything,
    /// controls sensitive again.
    Ready,
    /// These keys show something else now (an announcement, or a write's answer).
    Changed(Vec<String>),
    /// The service is gone, or restarted and not yet re-read: every control insensitive.
    Unavailable,
    /// A write that did not land; the key shows the value in force again.
    Failed { key: String, error: ApplyError },
    /// The snapshot could not be read (the error said, never a silent default).
    Error(String),
}

/// An `Updated` held while the snapshot is asked: epoch, revision, values.
type Announcement = (u64, u64, Vec<(String, Value)>);

struct Write {
    epoch: u64,
    sent: Value,
    waiting: Option<Value>,
}

/// The rules of [A3] over one store.
#[derive(Default)]
pub struct Session {
    store: Option<Store>,
    /// A snapshot was asked and has not answered: announcements are held meanwhile.
    asking: bool,
    /// The store is the service's present state: false while the owner is gone, or a new epoch
    /// was seen and not yet re-read.
    current: bool,
    early: Vec<Announcement>,
    writes: HashMap<String, Write>,
}

impl Session {
    /// The transport has subscribed to `Updated` and the owner; this asks the snapshot.
    pub fn start() -> (Self, Command) {
        let session = Self {
            asking: true,
            ..Self::default()
        };
        (session, Command::Snapshot)
    }

    /// The store, current or not (a store kept while the owner is gone is shown insensitive).
    pub fn store(&self) -> Option<&Store> {
        self.store.as_ref()
    }

    /// Whether controls may be operated: a store that is the service's present state.
    pub fn available(&self) -> bool {
        self.current && self.store.is_some()
    }

    /// What a key's control shows: the value asked and not yet answered, else the value in
    /// force.
    pub fn shown(&self, key: &str) -> Option<&Value> {
        match self.writes.get(key) {
            Some(w) => Some(w.waiting.as_ref().unwrap_or(&w.sent)),
            None => self.store.as_ref()?.value(key),
        }
    }

    /// Whether a write of this key is waiting for its answer.
    pub fn pending(&self, key: &str) -> bool {
        self.writes.contains_key(key)
    }

    /// The app changes a key. Sent now when no write of it is in flight; otherwise it replaces
    /// the value waiting, which goes when the reply comes.
    pub fn apply(&mut self, key: &str, value: Value) -> Result<Option<Command>, ApplyError> {
        if !self.available() {
            return Err(ApplyError::Unavailable);
        }
        let store = self.store.as_ref().expect("available() holds a store");
        match store.key(key) {
            Some(k) if k.available && k.writable() => {}
            _ => return Err(ApplyError::Unavailable),
        }
        if let Some(w) = self.writes.get_mut(key) {
            w.waiting = Some(value);
            return Ok(None);
        }
        let epoch = store.epoch;
        self.writes.insert(
            key.to_owned(),
            Write {
                epoch,
                sent: value.clone(),
                waiting: None,
            },
        );
        Ok(Some(Command::Apply {
            key: key.to_owned(),
            value,
            epoch,
        }))
    }

    /// One report of the transport.
    pub fn handle(&mut self, raw: Raw) -> (Vec<Notice>, Vec<Command>) {
        let mut out = Out::default();
        match raw {
            Raw::Updated {
                epoch,
                revision,
                values,
            } => self.updated(epoch, revision, values, &mut out),
            Raw::Snapshot(Ok((epoch, revision, schema))) => {
                self.snapshot(epoch, revision, &schema, &mut out)
            }
            Raw::Snapshot(Err(e)) => {
                self.asking = false;
                self.current = false;
                out.notices.push(Notice::Error(e));
            }
            Raw::Owner(true) => self.resnapshot(&mut out),
            Raw::Owner(false) => {
                self.asking = false;
                self.early.clear();
                self.lose(&mut out);
            }
            Raw::Reply { key, epoch, result } => self.reply(key, epoch, result, &mut out),
        }
        (out.notices, out.commands)
    }

    fn updated(&mut self, epoch: u64, revision: u64, values: Vec<(String, Value)>, out: &mut Out) {
        if self.asking {
            if self.early.len() >= MAX_EARLY {
                self.early.clear();
                out.commands.push(Command::Snapshot);
            } else {
                self.early.push((epoch, revision, values));
            }
            return;
        }
        let Some(store) = &self.store else { return };
        if !self.current {
            // The owner is gone: nothing it said before going is replayed, and a new owner is
            // read afresh when its name comes back.
            return;
        }
        if epoch != store.epoch {
            // A restart whose owner change was not seen first: the same as one that was.
            self.lose(out);
            self.resnapshot(out);
            return;
        }
        if revision <= store.revision {
            return;
        }
        if revision > store.revision + 1 {
            self.resnapshot(out);
            return;
        }
        self.announce(revision, values, out);
    }

    fn announce(&mut self, revision: u64, values: Vec<(String, Value)>, out: &mut Out) {
        let store = self.store.as_mut().expect("announce follows a store");
        store.revision = revision;
        let changed: Vec<String> = values
            .into_iter()
            .filter_map(|(k, v)| store.set(&k, v, revision).then_some(k))
            // A key with a write in flight keeps showing the value asked: its answer is the
            // announcement that counts for it.
            .filter(|k| !self.writes.contains_key(k))
            .collect();
        if !changed.is_empty() {
            out.notices.push(Notice::Changed(changed));
        }
    }

    fn snapshot(&mut self, epoch: u64, revision: u64, schema: &str, out: &mut Out) {
        self.asking = false;
        let store = match Store::parse(epoch, revision, schema) {
            Ok(s) => s,
            Err(e) => {
                self.current = false;
                out.notices.push(Notice::Error(e));
                return;
            }
        };
        if self.store.as_ref().is_some_and(|s| s.epoch != epoch) {
            // Writes sent to the previous instance have no answer coming that counts.
            self.fail_writes(out);
        }
        self.store = Some(store);
        self.current = true;
        out.notices.push(Notice::Ready);
        for (e, r, values) in std::mem::take(&mut self.early) {
            let store = self.store.as_ref().unwrap();
            if e != store.epoch || r <= store.revision {
                continue;
            }
            if r > store.revision + 1 {
                self.resnapshot(out);
                return;
            }
            self.announce(r, values, out);
        }
    }

    fn reply(
        &mut self,
        key: String,
        epoch: u64,
        result: Result<(u64, Value), ApplyError>,
        out: &mut Out,
    ) {
        match self.writes.get(&key) {
            Some(w) if w.epoch == epoch => {}
            // Already reported failed (owner lost, a restart): an answer from before does not
            // count.
            _ => return,
        }
        let write = self.writes.remove(&key).unwrap();
        match result {
            Ok((revision, canonical)) => {
                if let Some(store) = self.store.as_mut().filter(|s| s.epoch == epoch) {
                    store.set(&key, canonical, revision);
                }
            }
            Err(error) => out.notices.push(Notice::Failed {
                key: key.clone(),
                error,
            }),
        }
        if let Some(value) = write.waiting {
            self.writes.insert(
                key.clone(),
                Write {
                    epoch,
                    sent: value.clone(),
                    waiting: None,
                },
            );
            out.commands.push(Command::Apply {
                key: key.clone(),
                value,
                epoch,
            });
        }
        out.notices.push(Notice::Changed(vec![key]));
    }

    fn resnapshot(&mut self, out: &mut Out) {
        self.early.clear();
        if !self.asking {
            self.asking = true;
            out.commands.push(Command::Snapshot);
        }
    }

    fn lose(&mut self, out: &mut Out) {
        let was = self.current;
        self.current = false;
        self.fail_writes(out);
        if was {
            out.notices.push(Notice::Unavailable);
        }
    }

    fn fail_writes(&mut self, out: &mut Out) {
        let mut keys: Vec<String> = self.writes.drain().map(|(k, _)| k).collect();
        keys.sort();
        for key in keys {
            out.notices.push(Notice::Failed {
                key,
                error: ApplyError::NoReply,
            });
        }
    }
}

#[derive(Default)]
struct Out {
    notices: Vec<Notice>,
    commands: Vec<Command>,
}

#[cfg(test)]
mod tests {

    #[test]
    fn labels_a_schema_leaves_to_the_client_come_from_its_catalogue() {
        super::set_translator(Box::new(|k| match k {
            "settings.x" => Some("Equis".into()),
            "settings.x.desc" => Some("Una equis".into()),
            "settings.x.a" => Some("A grande".into()),
            _ => None,
        }));
        let schema = serde_json::json!({"schemaVersion": 1, "keys": {
            "k": {"type": "enum", "value": "a", "writable": true,
                "ui": {"i18n": "settings.x", "control": "segmented",
                    "options": [{"value": "a", "i18n": "settings.x.a"}, {"value": "b", "label": "b"}]}},
            "served": {"type": "boolean", "value": true, "writable": true,
                "ui": {"i18n": "settings.x", "title": "Del servidor"}}}});
        let store = Store::parse(1, 0, &schema.to_string()).unwrap();
        let k = &store.key("k").unwrap().entry["ui"];
        assert_eq!(k["title"], "Equis");
        assert_eq!(k["subtitle"], "Una equis");
        assert_eq!(k["options"][0]["label"], "A grande");
        assert_eq!(k["options"][1]["label"], "b");
        assert_eq!(
            store.key("served").unwrap().entry["ui"]["title"],
            "Del servidor"
        );
    }

    use super::*;

    const EPOCH: u64 = 1000;

    fn schema(dark: bool, temperature: f64) -> String {
        serde_json::json!({
            "schemaVersion": 1,
            "keys": {
                "appearance.darkMode": {"type": "boolean", "value": dark, "writable": true, "available": true},
                "nightlight.temperature": {"type": "number", "value": temperature, "writable": true, "available": true},
                "ai.allowConfigWrite": {"type": "boolean", "value": false, "writable": false, "available": true},
                "appearance.windowControls": {"type": "enum", "available": false, "writable": true},
            }
        })
        .to_string()
    }

    fn ready(revision: u64) -> Session {
        let (mut s, c) = Session::start();
        assert_eq!(c, Command::Snapshot);
        let (n, _) = s.handle(Raw::Snapshot(Ok((EPOCH, revision, schema(true, 4500.0)))));
        assert_eq!(n, vec![Notice::Ready]);
        s
    }

    fn updated(epoch: u64, revision: u64, key: &str, v: Value) -> Raw {
        Raw::Updated {
            epoch,
            revision,
            values: vec![(key.into(), v)],
        }
    }

    fn dark(s: &Session) -> Option<bool> {
        s.store()?.value("appearance.darkMode")?.as_bool()
    }

    #[test]
    fn an_update_before_the_snapshot_counts_only_above_its_revision() {
        let (mut s, _) = Session::start();
        // Revision 5 is inside the snapshot (taken at 5); 6 is after it.
        s.handle(updated(EPOCH, 5, "appearance.darkMode", Value::Bool(false)));
        s.handle(updated(
            EPOCH,
            6,
            "nightlight.temperature",
            Value::Number(3000.0),
        ));
        let (n, c) = s.handle(Raw::Snapshot(Ok((EPOCH, 5, schema(true, 4500.0)))));
        assert!(c.is_empty());
        assert_eq!(
            n,
            vec![
                Notice::Ready,
                Notice::Changed(vec!["nightlight.temperature".into()])
            ]
        );
        assert_eq!(
            dark(&s),
            Some(true),
            "revision 5 was replayed over the snapshot"
        );
        assert_eq!(s.store().unwrap().revision, 6);
    }

    #[test]
    fn old_and_repeated_revisions_are_dropped() {
        let mut s = ready(10);
        let (n, _) = s.handle(updated(
            EPOCH,
            10,
            "appearance.darkMode",
            Value::Bool(false),
        ));
        assert!(n.is_empty());
        let (n, _) = s.handle(updated(
            EPOCH,
            11,
            "appearance.darkMode",
            Value::Bool(false),
        ));
        assert_eq!(n, vec![Notice::Changed(vec!["appearance.darkMode".into()])]);
        let (n, _) = s.handle(updated(EPOCH, 11, "appearance.darkMode", Value::Bool(true)));
        assert!(n.is_empty());
        assert_eq!(dark(&s), Some(false));
    }

    #[test]
    fn a_gap_takes_a_fresh_snapshot() {
        let mut s = ready(10);
        let (n, c) = s.handle(updated(
            EPOCH,
            12,
            "appearance.darkMode",
            Value::Bool(false),
        ));
        assert!(n.is_empty());
        assert_eq!(c, vec![Command::Snapshot]);
        assert_eq!(dark(&s), Some(true), "a value past a gap was applied");
    }

    #[test]
    fn another_epoch_is_never_applied() {
        let mut s = ready(10);
        assert!(
            s.apply("appearance.darkMode", Value::Bool(false))
                .unwrap()
                .is_some()
        );
        let (n, c) = s.handle(updated(
            EPOCH + 1,
            1,
            "appearance.darkMode",
            Value::Bool(false),
        ));
        assert_eq!(c, vec![Command::Snapshot]);
        assert_eq!(
            n,
            vec![
                Notice::Failed {
                    key: "appearance.darkMode".into(),
                    error: ApplyError::NoReply
                },
                Notice::Unavailable
            ]
        );
        assert!(!s.available());
        // The old instance's answer comes late: it does not count.
        let (n, _) = s.handle(Raw::Reply {
            key: "appearance.darkMode".into(),
            epoch: EPOCH,
            result: Ok((11, Value::Bool(false))),
        });
        assert!(n.is_empty());
        let (n, _) = s.handle(Raw::Snapshot(Ok((EPOCH + 1, 1, schema(true, 4500.0)))));
        assert_eq!(n, vec![Notice::Ready]);
        assert_eq!(dark(&s), Some(true));
    }

    #[test]
    fn owner_lost_fails_writes_and_owner_back_reads_afresh() {
        let mut s = ready(10);
        s.apply("nightlight.temperature", Value::Number(3000.0))
            .unwrap();
        let (n, c) = s.handle(Raw::Owner(false));
        assert!(c.is_empty(), "something was replayed or retried");
        assert_eq!(
            n,
            vec![
                Notice::Failed {
                    key: "nightlight.temperature".into(),
                    error: ApplyError::NoReply
                },
                Notice::Unavailable
            ]
        );
        assert_eq!(
            s.apply("appearance.darkMode", Value::Bool(false)),
            Err(ApplyError::Unavailable)
        );
        // Nothing the gone owner announced is applied.
        let (n, _) = s.handle(updated(
            EPOCH,
            11,
            "appearance.darkMode",
            Value::Bool(false),
        ));
        assert!(n.is_empty());
        assert_eq!(
            s.shown("nightlight.temperature"),
            Some(&Value::Number(4500.0))
        );
        let (_, c) = s.handle(Raw::Owner(true));
        assert_eq!(c, vec![Command::Snapshot]);
        let (n, _) = s.handle(Raw::Snapshot(Ok((EPOCH + 1, 0, schema(false, 4500.0)))));
        assert_eq!(n, vec![Notice::Ready]);
        assert!(s.available());
        assert_eq!(dark(&s), Some(false));
    }

    #[test]
    fn one_write_in_flight_per_key_and_the_last_value_always_goes() {
        let mut s = ready(10);
        let k = "nightlight.temperature";
        assert_eq!(
            s.apply(k, Value::Number(4000.0)).unwrap(),
            Some(Command::Apply {
                key: k.into(),
                value: Value::Number(4000.0),
                epoch: EPOCH
            })
        );
        assert_eq!(s.apply(k, Value::Number(3800.0)).unwrap(), None);
        assert_eq!(s.apply(k, Value::Number(3500.4)).unwrap(), None);
        assert_eq!(s.shown(k), Some(&Value::Number(3500.4)));
        // Another key is not held behind it.
        assert!(
            s.apply("appearance.darkMode", Value::Bool(false))
                .unwrap()
                .is_some()
        );
        let (n, c) = s.handle(Raw::Reply {
            key: k.into(),
            epoch: EPOCH,
            result: Ok((11, Value::Number(4000.0))),
        });
        assert_eq!(
            c,
            vec![Command::Apply {
                key: k.into(),
                value: Value::Number(3500.4),
                epoch: EPOCH
            }]
        );
        assert_eq!(n, vec![Notice::Changed(vec![k.into()])]);
        // The canonical answer (rounded) is what shows once nothing is in flight.
        let (_, c) = s.handle(Raw::Reply {
            key: k.into(),
            epoch: EPOCH,
            result: Ok((12, Value::Number(3500.0))),
        });
        assert!(c.is_empty());
        assert!(!s.pending(k));
        assert_eq!(s.shown(k), Some(&Value::Number(3500.0)));
    }

    #[test]
    fn a_refused_write_shows_the_value_in_force() {
        let mut s = ready(10);
        s.apply("nightlight.temperature", Value::Number(99999.0))
            .unwrap();
        let (n, _) = s.handle(Raw::Reply {
            key: "nightlight.temperature".into(),
            epoch: EPOCH,
            result: Err(ApplyError::Invalid("out of range".into())),
        });
        assert_eq!(
            n[0],
            Notice::Failed {
                key: "nightlight.temperature".into(),
                error: ApplyError::Invalid("out of range".into())
            }
        );
        assert_eq!(
            s.shown("nightlight.temperature"),
            Some(&Value::Number(4500.0))
        );
    }

    #[test]
    fn an_older_answer_does_not_overwrite_a_newer_announcement() {
        let mut s = ready(10);
        s.apply("appearance.darkMode", Value::Bool(false)).unwrap();
        // Another writer, after our write, announced at 12; our answer says 11.
        s.handle(updated(
            EPOCH,
            11,
            "appearance.darkMode",
            Value::Bool(false),
        ));
        s.handle(updated(EPOCH, 12, "appearance.darkMode", Value::Bool(true)));
        s.handle(Raw::Reply {
            key: "appearance.darkMode".into(),
            epoch: EPOCH,
            result: Ok((11, Value::Bool(false))),
        });
        assert_eq!(dark(&s), Some(true));
    }

    #[test]
    fn unavailable_and_read_only_keys_are_not_sent() {
        let mut s = ready(10);
        assert_eq!(
            s.apply("ai.allowConfigWrite", Value::Bool(true)),
            Err(ApplyError::Unavailable)
        );
        assert_eq!(
            s.apply("appearance.windowControls", Value::Text("left".into())),
            Err(ApplyError::Unavailable)
        );
        assert_eq!(
            s.apply("no.such.key", Value::Bool(true)),
            Err(ApplyError::Unavailable)
        );
        let k = s.store().unwrap().key("appearance.windowControls").unwrap();
        assert!(!k.available && k.value.is_none());
    }

    #[test]
    fn another_schema_version_is_an_error() {
        let (mut s, _) = Session::start();
        let (n, _) = s.handle(Raw::Snapshot(Ok((
            EPOCH,
            0,
            r#"{"schemaVersion":2,"keys":{}}"#.into(),
        ))));
        assert!(matches!(&n[..], [Notice::Error(e)] if e.contains("schemaVersion")));
        assert!(!s.available());
    }

    #[test]
    fn a_flood_before_the_snapshot_asks_again() {
        let (mut s, _) = Session::start();
        let mut asked = 0;
        for r in 0..=MAX_EARLY as u64 {
            let (_, c) = s.handle(updated(
                EPOCH,
                r + 1,
                "appearance.darkMode",
                Value::Bool(false),
            ));
            asked += c.len();
        }
        assert_eq!(asked, 1);
    }
}
