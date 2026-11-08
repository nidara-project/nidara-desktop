// SPDX-License-Identifier: LGPL-3.0-or-later
//! Fresh events only: history is not replayed as banners after reconnect or reload.
use crate::notifications::Notice;
use std::sync::mpsc::channel;
use zbus::{
    MatchRule,
    blocking::{Connection, MessageIterator, Proxy},
    message::Type,
};
pub const DEST: &str = "org.freedesktop.Notifications";
pub const PATH: &str = "/org/nidara/Notifications";
pub const IFACE: &str = "org.nidara.Notifications1";
#[derive(Debug)]
pub enum Update {
    Reset(Option<String>),
    Notified(String, Notice),
    Resolved(String, u32),
}
pub fn watch(conn: Connection, emit: impl Fn(Update)) -> Result<(), String> {
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .path(PATH)
        .map_err(err)?
        .interface(IFACE)
        .map_err(err)?
        .build();
    let notices = MessageIterator::for_match_rule(rule, &conn, Some(128)).map_err(err)?;
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender("org.freedesktop.DBus")
        .map_err(err)?
        .interface("org.freedesktop.DBus")
        .map_err(err)?
        .member("NameOwnerChanged")
        .map_err(err)?
        .add_arg(DEST)
        .map_err(err)?
        .build();
    let owners = MessageIterator::for_match_rule(rule, &conn, Some(16)).map_err(err)?;
    let (tx, rx) = channel();
    let t = tx.clone();
    std::thread::Builder::new()
        .name("notifications-events".into())
        .spawn(move || {
            for m in notices.flatten() {
                if t.send(Some(m)).is_err() {
                    break;
                }
            }
        })
        .map_err(err)?;
    let t = tx.clone();
    std::thread::Builder::new()
        .name("notifications-owner".into())
        .spawn(move || {
            for _ in owners {
                if t.send(None).is_err() {
                    break;
                }
            }
        })
        .map_err(err)?;
    // Only the subscription workers keep senders. Bus loss must disconnect the
    // inbox, so a blocking receive cannot retain stale visible banners forever.
    drop(tx);
    let mut known = None;
    let mut attempted = None;
    let mut reconnect = true;
    loop {
        if reconnect {
            let owner = owner(&conn).ok();
            if owner != attempted {
                attempted = owner.clone();
                known = None;
                emit(Update::Reset(None));
                if let Some(owner) = owner {
                    let supported = Proxy::new(
                        &conn,
                        owner.as_str(),
                        PATH,
                        "org.freedesktop.DBus.Introspectable",
                    )
                    .and_then(|p| p.call::<_, _, String>("Introspect", &()))
                    .is_ok_and(|xml| {
                        xml.contains("name=\"DismissBanner\"")
                            && xml.contains("name=\"InvokeActionWithToken\"")
                    });
                    if supported {
                        known = Some(owner.clone());
                        emit(Update::Reset(Some(owner)));
                    } else {
                        eprintln!(
                            "nidara-shell: notification banners need a matching session daemon"
                        );
                    }
                }
            }
        }
        // NameOwnerChanged was subscribed before the initial owner read. Waiting
        // for it avoids periodic GetNameOwner calls while the desktop is idle.
        match rx.recv() {
            Ok(None) => reconnect = true,
            Ok(Some(m)) => {
                reconnect = false;
                let h = m.header();
                let Some(sender) = h
                    .sender()
                    .map(ToString::to_string)
                    .filter(|s| Some(s) == known.as_ref())
                else {
                    continue;
                };
                match h.member().map(|s| s.as_str()) {
                    Some("Notified") => {
                        if let Ok((_, _, json)) = m.body().deserialize::<(u32, bool, String)>() {
                            match Notice::parse(&json) {
                                Ok(n) => emit(Update::Notified(sender, n)),
                                Err(e) => eprintln!("nidara-shell: invalid notification: {e}"),
                            }
                        }
                    }
                    Some("Resolved") => {
                        if let Ok((id, _)) = m.body().deserialize::<(u32, u32)>() {
                            emit(Update::Resolved(sender, id));
                        }
                    }
                    _ => {}
                }
            }
            Err(_) => {
                emit(Update::Reset(None));
                return Err("notification bus disconnected".into());
            }
        }
    }
}
fn owner(conn: &Connection) -> Result<String, String> {
    Proxy::new(
        conn,
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        "org.freedesktop.DBus",
    )
    .map_err(err)?
    .call("GetNameOwner", &(DEST,))
    .map_err(err)
}
pub fn act(
    conn: &Connection,
    owner: &str,
    id: u32,
    revision: u64,
    key: Option<&str>,
    token: Option<&str>,
) -> Result<(), String> {
    let p = Proxy::new(conn, owner, PATH, IFACE).map_err(err)?;
    if let Some(key) = key {
        p.call::<_, _, ()>(
            "InvokeActionWithToken",
            &(id, key, token.ok_or("activation token missing")?, revision),
        )
        .map_err(err)
    } else {
        p.call::<_, _, ()>("DismissBanner", &(id, revision))
            .map_err(err)
    }
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
