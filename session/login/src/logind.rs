//! What the manager asks logind: whether a user already has a session, and switching to it
//! (#1195 L3: logging in as someone with an open session switches to that session).

use zbus::{Connection, zvariant::OwnedObjectPath};

const DEST: &str = "org.freedesktop.login1";
const MANAGER: &str = "org.freedesktop.login1.Manager";
const SESSION: &str = "org.freedesktop.login1.Session";

/// The id of a graphical session of `uid` on seat0 that is still open, if there is one.
pub async fn open_session(bus: &Connection, uid: u32) -> Option<String> {
    let manager = zbus::Proxy::new(bus, DEST, "/org/freedesktop/login1", MANAGER)
        .await
        .ok()?;
    let sessions: Vec<(String, u32, String, String, OwnedObjectPath)> =
        manager.call("ListSessions", &()).await.ok()?;
    for (id, owner, _user, seat, path) in sessions {
        if owner != uid || seat != "seat0" {
            continue;
        }
        let Ok(session) = zbus::Proxy::new(bus, DEST, path, SESSION).await else {
            continue;
        };
        let class: String = session.get_property("Class").await.unwrap_or_default();
        let kind: String = session.get_property("Type").await.unwrap_or_default();
        let state: String = session.get_property("State").await.unwrap_or_default();
        if class == "user" && kind == "wayland" && state != "closing" {
            return Some(id);
        }
    }
    None
}

pub async fn activate(bus: &Connection, id: &str) -> zbus::Result<()> {
    let manager = zbus::Proxy::new(bus, DEST, "/org/freedesktop/login1", MANAGER).await?;
    manager.call::<_, _, ()>("ActivateSession", &(id,)).await
}
