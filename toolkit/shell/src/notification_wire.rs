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
    Snapshot(String, Vec<Notice>),
    Removed(String, Vec<u32>),
    Notified(String, Notice),
}
pub fn watch(conn: Connection, emit: impl Fn(Update)) -> Result<(), String> {
    let result = watch_inner(conn, &emit);
    if result.is_err() {
        emit(Update::Reset(None));
    }
    result
}
fn watch_inner(conn: Connection, emit: &impl Fn(Update)) -> Result<(), String> {
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
    let mut sequence = 0;
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
                        xml.contains("name=\"Snapshot\"")
                            && xml.contains("name=\"Changed\"")
                            && xml.contains("name=\"ExpireTransient\"")
                            && xml.contains("name=\"DismissBanner\"")
                            && xml.contains("name=\"InvokeActionWithToken\"")
                    });
                    if supported {
                        let p = Proxy::new(&conn, owner.as_str(), PATH, IFACE).map_err(err)?;
                        let (seq, json): (u64, String) = p.call("Snapshot", &()).map_err(err)?;
                        let values: Vec<serde_json::Value> =
                            serde_json::from_str(&json).map_err(err)?;
                        let notices = values
                            .into_iter()
                            .filter_map(|v| match Notice::parse(&v.to_string()) {
                                Ok(n) => Some(n),
                                Err(e) => {
                                    eprintln!("nidara-shell: ignored invalid history record: {e}");
                                    None
                                }
                            })
                            .collect();
                        sequence = seq;
                        known = Some(owner.clone());
                        emit(Update::Reset(Some(owner.clone())));
                        emit(Update::Snapshot(owner.clone(), notices));
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
                if h.member().is_some_and(|m| m.as_str() == "Changed") {
                    let (seq, json) = m.body().deserialize::<(u64, String)>().map_err(err)?;
                    if seq <= sequence {
                        continue;
                    }
                    if seq != sequence + 1 {
                        eprintln!("nidara-shell: notification change gap; rehydrating");
                        attempted = None;
                        reconnect = true;
                        continue;
                    }
                    sequence = seq;
                    let event: serde_json::Value = serde_json::from_str(&json).map_err(err)?;
                    if let Some(n) = event.get("put") {
                        match Notice::parse(&n.to_string()) {
                            Ok(n) => emit(Update::Notified(sender, n)),
                            Err(e) => eprintln!("nidara-shell: ignored invalid notification: {e}"),
                        };
                    } else if let Some(ids) = event.get("removed") {
                        let ids = serde_json::from_value(ids.clone()).map_err(err)?;
                        emit(Update::Removed(sender, ids));
                    }
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
pub fn expire_transient(
    conn: &Connection,
    owner: &str,
    id: u32,
    revision: u64,
) -> Result<(), String> {
    Proxy::new(conn, owner, PATH, IFACE)
        .map_err(err)?
        .call::<_, _, ()>("ExpireTransient", &(id, revision))
        .map_err(err)
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

pub fn bulk(conn: &Connection, owner: &str, group: Option<&str>) -> Result<(), String> {
    let p = Proxy::new(conn, owner, PATH, IFACE).map_err(err)?;
    match group {
        Some(group) => p.call::<_, _, ()>("DismissGroup", &(group,)),
        None => p.call::<_, _, ()>("DismissAll", &()),
    }
    .map_err(err)
}
