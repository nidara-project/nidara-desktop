// SPDX-License-Identifier: LGPL-3.0-or-later
//! What is playing, and its controls (#1195 D5), from the session's media service: the
//! player `org.nidara.Media1` has selected, the one the bar and the Control Center show.
//!
//! The user can turn the lock screen's controls off (`media.lock-screen-controls`, Media1's
//! `LockScreenControls`); then, or with nothing selected, there is nothing to show. Nothing
//! here reveals more than the speakers already play: the title, the artist and the three
//! transport buttons, no cover and no other player.
use crate::Msg;
use std::sync::mpsc::{Sender, channel};
use zbus::MatchRule;
use zbus::blocking::{Connection, MessageIterator, Proxy};
use zbus::message::Type;
use zbus::zvariant::OwnedObjectPath;

const SERVICE: &str = "org.nidara.Session";
const PATH: &str = "/org/nidara/Media";
const ROOT: &str = "org.nidara.Media1";
const PLAYER: &str = "org.nidara.MediaPlayer1";

/// The selected player, as the lock screen shows it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Now {
    pub title: String,
    pub artist: String,
    pub playing: bool,
    pub can_control: bool,
    pub can_next: bool,
    pub can_previous: bool,
}

/// Watch Media1 on a thread of its own; every change goes to the lock's thread as
/// `Msg::Media`. Without a session bus or the service there is simply nothing playing.
pub fn watch(tx: Sender<Msg>) {
    let _ = std::thread::Builder::new()
        .name("lock-media".into())
        .spawn(move || {
            if let Err(e) = run(&tx) {
                eprintln!("nidara-lock: no media controls: {e}");
                let _ = tx.send(Msg::Media(None));
            }
        });
}

fn run(tx: &Sender<Msg>) -> Result<(), String> {
    let conn = Connection::session().map_err(|e| e.to_string())?;
    let (poke, poked) = channel::<()>();
    // Every watch exists before the first read, so nothing between is missed.
    for rule in rules()? {
        let it =
            MessageIterator::for_match_rule(rule, &conn, Some(64)).map_err(|e| e.to_string())?;
        let poke = poke.clone();
        std::thread::spawn(move || {
            for _ in it.flatten() {
                if poke.send(()).is_err() {
                    return;
                }
            }
        });
    }
    let mut last = None;
    loop {
        let now = read(&conn).unwrap_or(None);
        if Some(&now) != last.as_ref() {
            if tx.send(Msg::Media(now.clone())).is_err() {
                return Ok(());
            }
            last = Some(now);
        }
        if poked.recv().is_err() {
            return Ok(());
        }
        // A track change comes as a burst of property changes: read once for all of them.
        while poked.try_recv().is_ok() {}
    }
}

fn rules() -> Result<Vec<MatchRule<'static>>, String> {
    let e = |e: zbus::Error| e.to_string();
    Ok(vec![
        MatchRule::builder()
            .msg_type(Type::Signal)
            .sender(SERVICE)
            .map_err(e)?
            .interface("org.freedesktop.DBus.Properties")
            .map_err(e)?
            .member("PropertiesChanged")
            .map_err(e)?
            .path_namespace(PATH)
            .map_err(e)?
            .build(),
        MatchRule::builder()
            .msg_type(Type::Signal)
            .sender("org.freedesktop.DBus")
            .map_err(e)?
            .interface("org.freedesktop.DBus")
            .map_err(e)?
            .member("NameOwnerChanged")
            .map_err(e)?
            .arg(0, SERVICE)
            .map_err(e)?
            .build(),
    ])
}

/// The selected player, or None when the controls are off or nothing is selected.
fn read(conn: &Connection) -> Result<Option<Now>, String> {
    let e = |e: zbus::Error| e.to_string();
    let root = Proxy::new(conn, SERVICE, PATH, ROOT).map_err(e)?;
    let allowed: bool = root.get_property("LockScreenControls").map_err(e)?;
    let selected: OwnedObjectPath = root.get_property("Selected").map_err(e)?;
    if !allowed || selected.as_str() == "/" {
        return Ok(None);
    }
    let p = Proxy::new(conn, SERVICE, selected.as_str(), PLAYER).map_err(e)?;
    let text = |name: &str| -> Result<String, String> { p.get_property(name).map_err(e) };
    let flag = |name: &str| -> Result<bool, String> { p.get_property(name).map_err(e) };
    let artists: Vec<String> = p.get_property("Artists").map_err(e)?;
    let now = Now {
        title: text("Title")?,
        artist: artists.join(", "),
        playing: text("PlaybackStatus")? == "Playing",
        can_control: flag("CanControl")?,
        can_next: flag("CanGoNext")?,
        can_previous: flag("CanGoPrevious")?,
    };
    // A player with nothing to say and nothing to press is not shown.
    Ok((now.can_control || !now.title.is_empty()).then_some(now))
}

/// One of Media1's transport calls on the selected player: `SelectedPrevious`,
/// `SelectedPlayPause`, `SelectedNext`. Off the lock's thread; a failure is only logged.
pub fn press(method: &'static str) {
    std::thread::spawn(move || {
        let call = || -> zbus::Result<()> {
            Connection::session()?.call_method(Some(SERVICE), PATH, Some(ROOT), method, &())?;
            Ok(())
        };
        if let Err(e) = call() {
            eprintln!("nidara-lock: {method}: {e}");
        }
    });
}
