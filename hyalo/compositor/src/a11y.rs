//! The screen reader's keyboard: `org.freedesktop.a11y.KeyboardMonitor` on the session bus (#835).
//!
//! On Wayland no client sees another client's keys, so a screen reader cannot learn that the
//! person pressed Tab, typed a letter or held its own modifier (Insert, Caps Lock) — Orca then
//! hears a text change with no cause and stays silent. libatspi asks the compositor instead,
//! over the interface Mutter defined: `WatchKeyboard` (every key, still delivered), `GrabKeyboard`
//! (every key, consumed), `SetKeyGrabs` (the reader's own modifiers and keystrokes, consumed), and
//! a `KeyEvent` signal sent to that caller alone.
//!
//! **Who may call it** is the whole security question: whoever watches the keyboard sees every
//! password typed. As in Mutter, only the current owner of an allowed well-known name may call,
//! and Orca is the one name (`ALLOWED`); a sandboxed app cannot own it. A caller that leaves the
//! bus loses its watch and its grabs at once, so a crashed reader cannot keep keys swallowed.
//!
//! **What is consumed** is Mutter's rule, ported as it is: a grabbed key is not delivered, its
//! release neither (paired by keycode, not keysym — Shift may be let go in between), and the
//! reader's modifier pressed TWICE within the repeat delay goes through as itself (so Caps Lock
//! still toggles when it is Orca's key). A consumed first press of that modifier does not even
//! reach the keymap state.
//!
//! Served in a real session, or with `HYALO_A11Y_MANAGER=1` (the headless checks, on a private
//! bus): a development Hyalo must not take the live session's name.

use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex, mpsc},
};

/// Well-known names whose owner may watch the keyboard: `<app-id>.KeyboardMonitor`, which
/// libatspi requests for the reader. Mutter allows exactly this one.
const ALLOWED: &[&str] = &["org.gnome.Orca.KeyboardMonitor"];
const PATH: &str = "/org/freedesktop/a11y/Manager";
const INTERFACE: &str = "org.freedesktop.a11y.KeyboardMonitor";

#[derive(Default, Debug)]
struct Client {
    watch_all: bool,
    grab_all: bool,
    /// Keysyms of the reader's own modifiers.
    modifiers: Vec<u32>,
    /// (keysym, modifier mask) pairs.
    keystrokes: Vec<(u32, u32)>,
}

/// One key, as the readers are told it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub keycode: u32,
    pub keysym: u32,
    pub unichar: u32,
    /// Depressed | latched | locked, in the core X bit order (Shift 1, Lock 2, Control 4…).
    pub mask: u32,
    pub pressed: bool,
    pub time_ms: u32,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Outcome {
    /// The key does not reach the focused client.
    pub consume: bool,
    /// Nor the keymap state (the first press/release of the reader's modifier).
    pub skip_xkb: bool,
}

#[derive(Default, Debug)]
pub struct Monitor {
    clients: HashMap<String, Client>,
    /// Keys whose press was consumed: keycode → keysym at press.
    held: HashMap<u32, u32>,
    /// The reader's modifiers let through by a double press, until released.
    passed_modifiers: HashSet<u32>,
    last_keysym: u32,
    last_time: u32,
    saw_first_release: bool,
}

impl Monitor {
    /// Some reader listens, or a consumed press still waits for its release.
    pub fn active(&self) -> bool {
        !self.clients.is_empty() || !self.held.is_empty()
    }

    fn grabbed_modifier(&self, keysym: u32) -> bool {
        self.clients.values().any(|c| c.modifiers.contains(&keysym))
    }

    fn grabs(&self, c: &Client, key: &Key) -> bool {
        c.grab_all
            || c.modifiers.contains(&key.keysym)
            || self.held.values().any(|s| c.modifiers.contains(s))
            || c.keystrokes.contains(&(key.keysym, key.mask))
    }

    /// Mutter's `is_a11y_modifier_first_click`.
    fn first_click(&mut self, key: &Key, repeat_delay: u32) -> bool {
        let same = key.keysym == self.last_keysym;
        let soon = key.time_ms.wrapping_sub(self.last_time) < repeat_delay;
        self.last_keysym = key.keysym;
        self.last_time = key.time_ms;
        if !self.grabbed_modifier(key.keysym) {
            return false;
        }
        if !key.pressed && self.passed_modifiers.remove(&key.keysym) {
            return false;
        }
        if same && soon {
            if key.pressed && self.saw_first_release {
                self.saw_first_release = false;
                self.passed_modifiers.insert(key.keysym);
                return false;
            }
            self.saw_first_release = true;
            return true;
        }
        self.saw_first_release = false;
        true
    }

    /// Who hears `key`, and whether it is consumed (Mutter's `notify_clients`).
    pub fn key(&mut self, key: &Key, repeat_delay: u32) -> (Vec<String>, Outcome) {
        let first = self.first_click(key, repeat_delay);
        let listeners = self
            .clients
            .iter()
            .filter(|(_, c)| c.watch_all || self.grabs(c, key))
            .map(|(n, _)| n.clone())
            .collect();
        let consume = if self.grabbed_modifier(key.keysym) && !first {
            false
        } else if key.pressed {
            let grabbed = self.held.contains_key(&key.keycode) || self.clients.values().any(|c| self.grabs(c, key));
            if grabbed {
                self.held.insert(key.keycode, key.keysym);
            }
            grabbed
        } else {
            self.held.remove(&key.keycode).is_some()
        };
        (listeners, Outcome { consume, skip_xkb: first && consume })
    }

    fn gone(&mut self, name: &str) {
        self.clients.remove(name);
    }
}

/// What the compositor holds: the shared state and the way to the bus.
pub struct A11y {
    pub monitor: Arc<Mutex<Monitor>>,
    events: mpsc::Sender<(String, Key)>,
}

impl A11y {
    pub fn send(&self, to: Vec<String>, key: Key) {
        for name in to {
            let _ = self.events.send((name, key));
        }
    }
}

struct Service(Arc<Mutex<Monitor>>);

impl Service {
    /// The caller's unique name, if it owns an allowed name.
    async fn caller(conn: &zbus::Connection, header: &zbus::message::Header<'_>) -> zbus::fdo::Result<String> {
        let sender = header.sender().map(|s| s.to_string()).ok_or_else(denied)?;
        let dbus = zbus::fdo::DBusProxy::new(conn).await?;
        for name in ALLOWED {
            let Ok(name) = zbus::names::BusName::try_from(*name) else { continue };
            if dbus.get_name_owner(name).await.is_ok_and(|owner| owner.as_str() == sender) {
                return Ok(sender);
            }
        }
        tracing::warn!(%sender, "a11y: keyboard monitor refused (not a screen reader)");
        Err(denied())
    }

    fn with(&self, name: String, f: impl FnOnce(&mut Client)) {
        let mut m = self.0.lock().unwrap();
        f(m.clients.entry(name).or_default());
    }
}

fn denied() -> zbus::fdo::Error {
    zbus::fdo::Error::AccessDenied("only a screen reader may watch the keyboard".into())
}

#[zbus::interface(name = "org.freedesktop.a11y.KeyboardMonitor")]
impl Service {
    async fn grab_keyboard(
        &self,
        #[zbus(connection)] conn: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<()> {
        let name = Self::caller(conn, &header).await?;
        self.with(name, |c| c.grab_all = true);
        Ok(())
    }

    async fn ungrab_keyboard(
        &self,
        #[zbus(connection)] conn: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<()> {
        let name = Self::caller(conn, &header).await?;
        self.with(name, |c| c.grab_all = false);
        Ok(())
    }

    async fn watch_keyboard(
        &self,
        #[zbus(connection)] conn: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<()> {
        let name = Self::caller(conn, &header).await?;
        tracing::info!(%name, "a11y: a screen reader watches the keyboard");
        self.with(name, |c| c.watch_all = true);
        Ok(())
    }

    async fn unwatch_keyboard(
        &self,
        #[zbus(connection)] conn: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<()> {
        let name = Self::caller(conn, &header).await?;
        self.with(name, |c| c.watch_all = false);
        Ok(())
    }

    async fn set_key_grabs(
        &self,
        #[zbus(connection)] conn: &zbus::Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
        modifiers: Vec<u32>,
        keystrokes: Vec<(u32, u32)>,
    ) -> zbus::fdo::Result<()> {
        let name = Self::caller(conn, &header).await?;
        self.with(name, |c| {
            c.modifiers = modifiers;
            c.keystrokes = keystrokes;
        });
        Ok(())
    }
}

/// Serves the monitor when this is a session, or the checks ask for it.
pub fn start(session: bool) -> Option<A11y> {
    if !session && std::env::var_os("HYALO_A11Y_MANAGER").is_none_or(|v| v != "1") {
        return None;
    }
    let monitor = Arc::new(Mutex::new(Monitor::default()));
    let (events, rx) = mpsc::channel::<(String, Key)>();
    let shared = monitor.clone();
    std::thread::Builder::new()
        .name("hyalo-a11y".into())
        .spawn(move || {
            if let Err(err) = serve(shared, rx) {
                tracing::warn!(%err, "org.freedesktop.a11y.Manager not served; a screen reader hears no keys");
            }
        })
        .ok()?;
    Some(A11y { monitor, events })
}

fn serve(monitor: Arc<Mutex<Monitor>>, rx: mpsc::Receiver<(String, Key)>) -> zbus::Result<()> {
    let conn = zbus::blocking::connection::Builder::session()?
        .name("org.freedesktop.a11y.Manager")?
        .serve_at(PATH, Service(monitor.clone()))?
        .build()?;
    // The signal goes from THIS connection, the name's owner: libatspi's proxy drops a signal
    // from anyone else.
    let emitter = conn.clone();
    std::thread::Builder::new()
        .name("hyalo-a11y-keys".into())
        .spawn(move || {
            for (to, k) in rx {
                let args = (!k.pressed, k.mask, k.keysym, k.unichar, k.keycode as u16);
                if let Err(err) = emitter.emit_signal(Some(to.as_str()), PATH, INTERFACE, "KeyEvent", &args) {
                    tracing::debug!(%err, "a11y: KeyEvent not sent");
                }
            }
        })
        .map_err(|e| zbus::Error::Failure(e.to_string()))?;
    let dbus = zbus::blocking::fdo::DBusProxy::new(&conn)?;
    for change in dbus.receive_name_owner_changed()? {
        let Ok(args) = change.args() else { continue };
        if args.new_owner().is_none() {
            monitor.lock().unwrap().gone(args.name().as_str());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    const INSERT: u32 = 0xff63;
    const H: u32 = 0x68;
    const DELAY: u32 = 600;

    fn key(keycode: u32, keysym: u32, pressed: bool, time_ms: u32) -> Key {
        Key { keycode, keysym, unichar: 0, mask: 0, pressed, time_ms }
    }
    fn orca() -> Monitor {
        let mut m = Monitor::default();
        m.clients.insert(
            ":1.7".into(),
            Client { watch_all: true, modifiers: vec![INSERT], ..Default::default() },
        );
        m
    }

    #[test]
    fn watched_keys_are_heard_and_still_delivered() {
        let mut m = orca();
        let (to, out) = m.key(&key(43, H, true, 0), DELAY);
        assert_eq!(to, vec![":1.7".to_string()]);
        assert_eq!(out, Outcome::default());
    }

    #[test]
    fn the_readers_modifier_and_what_it_chords_are_consumed_in_pairs() {
        let mut m = orca();
        assert_eq!(m.key(&key(118, INSERT, true, 0), DELAY).1, Outcome { consume: true, skip_xkb: true });
        // H while Insert is held: Orca's command, not the app's letter.
        assert!(m.key(&key(43, H, true, 50), DELAY).1.consume);
        assert!(m.key(&key(43, H, false, 60), DELAY).1.consume);
        assert!(m.key(&key(118, INSERT, false, 2000), DELAY).1.consume);
        // Insert is up: H is the app's again.
        assert!(!m.key(&key(43, H, true, 2100), DELAY).1.consume);
        assert!(!m.key(&key(43, H, false, 2110), DELAY).1.consume);
    }

    #[test]
    fn a_double_press_of_the_modifier_goes_through() {
        let mut m = orca();
        assert!(m.key(&key(118, INSERT, true, 0), DELAY).1.consume);
        assert!(m.key(&key(118, INSERT, false, 100), DELAY).1.consume);
        assert_eq!(m.key(&key(118, INSERT, true, 200), DELAY).1, Outcome::default());
        assert_eq!(m.key(&key(118, INSERT, false, 300), DELAY).1, Outcome::default());
    }

    #[test]
    fn a_key_pressed_before_the_grab_is_released_to_the_app() {
        let mut m = Monitor::default();
        assert!(!m.key(&key(43, H, true, 0), DELAY).1.consume);
        m.clients.insert(":1.7".into(), Client { grab_all: true, ..Default::default() });
        assert!(!m.key(&key(43, H, false, 10), DELAY).1.consume);
    }

    #[test]
    fn a_reader_that_leaves_takes_its_grabs_with_it() {
        let mut m = orca();
        m.clients.get_mut(":1.7").unwrap().grab_all = true;
        assert!(m.key(&key(43, H, true, 0), DELAY).1.consume);
        m.gone(":1.7");
        assert!(m.active(), "the held press still needs its release");
        // The release of a consumed press stays consumed, so the app never sees half a key.
        assert!(m.key(&key(43, H, false, 10), DELAY).1.consume);
        assert!(!m.active());
        assert!(!m.key(&key(43, H, true, 20), DELAY).1.consume);
    }
}
