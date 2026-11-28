// SPDX-License-Identifier: LGPL-3.0-or-later
//! Whose session is already open on this seat (#1195 L3), for the login screen's marks.
//!
//! logind says it to anyone on the system bus: the Wayland sessions on seat0 of class `user`
//! that are not closing. Asked once, then again whenever logind says a session came or went, so a mark
//! never outlives the session it stood for. Logging in to an open session switches to it;
//! that is `nidara-login`'s to decide, never this screen's: the mark only tells.
use std::collections::BTreeSet;
use std::sync::mpsc::Sender;

use crate::Msg;

const DEST: &str = "org.freedesktop.login1";
const PATH: &str = "/org/freedesktop/login1";
const MANAGER: &str = "org.freedesktop.login1.Manager";
const SESSION: &str = "org.freedesktop.login1.Session";

/// Watches on a thread of its own; each answer goes to the main thread as `Msg::Open`.
pub fn watch(tx: Sender<Msg>) {
    std::thread::Builder::new()
        .name("lock-sessions".into())
        .spawn(move || {
            if let Err(e) = run(&tx) {
                eprintln!("nidara-lock: open sessions are not marked: {e}");
            }
        })
        .ok();
}

fn run(tx: &Sender<Msg>) -> zbus::Result<()> {
    let bus = zbus::blocking::Connection::system()?;
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender(DEST)?
        .interface(MANAGER)?
        .build();
    // Subscribed before the first answer, so a session that comes between the two is seen.
    let signals = zbus::blocking::MessageIterator::for_match_rule(rule, &bus, Some(16))?;
    if tx.send(Msg::Open(open(&bus)?)).is_err() {
        return Ok(());
    }
    for msg in signals {
        let msg = msg?;
        let member = msg.header().member().map(|m| m.to_string());
        if matches!(member.as_deref(), Some("SessionNew" | "SessionRemoved"))
            && tx.send(Msg::Open(open(&bus)?)).is_err()
        {
            return Ok(());
        }
    }
    Ok(())
}

/// The logins with a session open on seat0.
fn open(bus: &zbus::blocking::Connection) -> zbus::Result<BTreeSet<String>> {
    let reply = bus.call_method(Some(DEST), PATH, Some(MANAGER), "ListSessions", &())?;
    let sessions: Vec<(String, u32, String, String, zbus::zvariant::OwnedObjectPath)> =
        reply.body().deserialize()?;
    let mut out = BTreeSet::new();
    for (_, _, user, seat, path) in sessions {
        if seat != "seat0" {
            continue;
        }
        let prop = |name: &str| -> zbus::Result<String> {
            let reply = bus.call_method(
                Some(DEST),
                path.as_str(),
                Some("org.freedesktop.DBus.Properties"),
                "Get",
                &(SESSION, name),
            )?;
            let v: zbus::zvariant::OwnedValue = reply.body().deserialize()?;
            Ok(String::try_from(v).unwrap_or_default())
        };
        // The manager's own test (session/login/src/logind.rs), so the mark says what logging
        // in will do. One that cannot be read is left unmarked: the switch happens anyway.
        if prop("Class").ok().as_deref() == Some("user")
            && prop("Type").ok().as_deref() == Some("wayland")
            && prop("State").ok().as_deref() != Some("closing")
        {
            out.insert(user);
        }
    }
    Ok(out)
}
