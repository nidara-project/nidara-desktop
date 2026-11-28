//! What the manager offers on the system bus (#1195 D8): a new login screen, for switching
//! user. The lock screen's "Switch user" asks it; it is LightDM's
//! `org.freedesktop.DisplayManager.Seat.SwitchToGreeter`, so other tools that know that
//! (`dm-tool switch-to-greeter`) work too.
//!
//! Only the active session on seat0 may ask, as only it is in front of the screen: a
//! session somewhere else (ssh, another seat) or in the background would be putting a login
//! screen in front of somebody else. Root may always.

use tokio::sync::mpsc::UnboundedSender;
use zbus::{Connection, fdo, message::Header, zvariant::OwnedObjectPath};

use crate::daemon::Event;

/// Ours, and the one tools that speak LightDM's interface look for.
pub const NAMES: [&str; 2] = ["org.nidara.Login", "org.freedesktop.DisplayManager"];
pub const SEAT0: &str = "/org/freedesktop/DisplayManager/Seat0";

pub struct Seat {
    pub tx: UnboundedSender<Event>,
}

#[zbus::interface(name = "org.freedesktop.DisplayManager.Seat")]
impl Seat {
    async fn switch_to_greeter(
        &self,
        #[zbus(header)] header: Header<'_>,
        #[zbus(connection)] bus: &Connection,
    ) -> fdo::Result<()> {
        let sender = header
            .sender()
            .ok_or_else(|| fdo::Error::AccessDenied("no sender".into()))?;
        let dbus = fdo::DBusProxy::new(bus).await?;
        let name = zbus::names::BusName::from(sender.to_owned());
        let uid = dbus.get_connection_unix_user(name.clone()).await?;
        if uid != 0 {
            let pid = dbus.get_connection_unix_process_id(name).await?;
            if !in_front(bus, pid).await {
                return Err(fdo::Error::AccessDenied(
                    "only the session in front of seat0 may switch user".into(),
                ));
            }
        }
        self.tx
            .send(Event::SwitchToGreeter)
            .map_err(|_| fdo::Error::Failed("the manager is stopping".into()))
    }
}

/// Whether `pid` belongs to the active local session on seat0.
async fn in_front(bus: &Connection, pid: u32) -> bool {
    let check = async {
        let manager = zbus::Proxy::new(
            bus,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .await?;
        let path: OwnedObjectPath = manager.call("GetSessionByPID", &(pid,)).await?;
        let session = zbus::Proxy::new(
            bus,
            "org.freedesktop.login1",
            path,
            "org.freedesktop.login1.Session",
        )
        .await?;
        let (seat, _): (String, OwnedObjectPath) = session.get_property("Seat").await?;
        let active: bool = session.get_property("Active").await?;
        let remote: bool = session.get_property("Remote").await?;
        zbus::Result::Ok(seat == "seat0" && active && !remote)
    };
    check.await.unwrap_or(false)
}

/// Puts the seat on the bus; without it the manager still logs people in.
pub async fn serve(bus: &Connection, tx: UnboundedSender<Event>) -> zbus::Result<()> {
    bus.object_server().at(SEAT0, Seat { tx }).await?;
    for name in NAMES {
        bus.request_name(name).await?;
    }
    Ok(())
}
