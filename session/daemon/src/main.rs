// SPDX-License-Identifier: GPL-3.0-or-later
// The server outlives shell reloads. DnD and the user's banner timeout remain UI
// policy. expire_timeout is presentation metadata; only explicit close/action removes history.
mod applications;
mod audio;
mod bluetooth;
mod config;
mod hyalo;
mod media;
mod model;
mod network;
mod options;
mod power;
mod store;
mod tray;

use model::{CAPABILITIES, MAX_ID, Notification, actions, allocate, now, scalar_hints, truthy};
use std::{collections::HashMap, sync::Arc, time::Duration};
use tokio::{sync::Mutex, task::AbortHandle};
use zbus::{Connection, zvariant::OwnedValue};

const PUBLIC_PATH: &str = "/org/freedesktop/Notifications";
const PUBLIC_IFACE: &str = "org.freedesktop.Notifications";
const PRIVATE_PATH: &str = "/org/nidara/Notifications";
const PRIVATE_IFACE: &str = "org.nidara.Notifications1";

type Shared = Arc<Mutex<State>>;
struct State {
    notifications: Vec<Notification>,
    next: u32,

    senders: HashMap<u32, String>,
    revisions: HashMap<u32, u64>,
    next_revision: u64,
    gone_logged: std::collections::HashSet<u32>,
    flush: Option<AbortHandle>,
    store: store::Store,
}
impl State {
    fn persist(&self) {
        if let Err(e) = self.store.flush(&self.notifications) {
            eprintln!("[notifd] could not write the store: {e}");
        }
    }
}
fn queue_flush(state: &Shared, locked: &mut State) {
    if let Some(handle) = locked.flush.take() {
        handle.abort();
    }
    let shared = state.clone();
    locked.flush = Some(
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(100)).await;
            let mut state = shared.lock().await;
            state.flush = None;
            state.persist();
        })
        .abort_handle(),
    );
}
async fn resolve(
    state: &Shared,
    locked: &mut State,
    conn: &Connection,
    id: u32,
    reason: u32,
) -> zbus::Result<()> {
    let Some(index) = locked.notifications.iter().position(|n| n.id == id) else {
        return Ok(());
    };
    locked.notifications.remove(index);
    locked.senders.remove(&id);
    locked.revisions.remove(&id);
    locked.gone_logged.remove(&id);

    queue_flush(state, locked);
    conn.emit_signal(
        None::<&str>,
        PUBLIC_PATH,
        PUBLIC_IFACE,
        "NotificationClosed",
        &(id, reason),
    )
    .await?;
    conn.emit_signal(
        None::<&str>,
        PRIVATE_PATH,
        PRIVATE_IFACE,
        "Resolved",
        &(id, reason),
    )
    .await
}

struct Notifications(Shared);
#[zbus::interface(name = "org.freedesktop.Notifications")]
impl Notifications {
    fn get_capabilities(&self) -> Vec<&str> {
        CAPABILITIES.to_vec()
    }
    fn get_server_information(&self) -> (&str, &str, &str, &str) {
        ("nidara", "nidara-project", "1.0", "1.2")
    }

    #[allow(clippy::too_many_arguments)] // The freedesktop method signature.
    async fn notify(
        &self,
        app_name: String,
        replaces_id: u32,
        app_icon: String,
        summary: String,
        body: String,
        actions_flat: Vec<String>,
        hints: HashMap<String, OwnedValue>,
        expire_timeout: i32,
        #[zbus(connection)] conn: &Connection,
        #[zbus(header)] header: zbus::message::Header<'_>,
    ) -> zbus::fdo::Result<u32> {
        let mut state = self.0.lock().await;
        let mut unpacked = scalar_hints(&hints);
        if let Some(path) = state.store.image(&hints) {
            unpacked.insert("image-path".into(), path.into());
        }
        let replaced = replaces_id > 0 && state.notifications.iter().any(|n| n.id == replaces_id);
        let State {
            notifications,
            next,
            ..
        } = &mut *state;
        let id = allocate(notifications, next, replaces_id);
        let n = Notification {
            id,
            app_name,
            app_icon,
            summary,
            body,
            expire_timeout,
            time: now(),
            hints: unpacked,
            actions: actions(actions_flat),
        };
        state.next_revision = state
            .next_revision
            .checked_add(1)
            .ok_or_else(|| failed("notification revision exhausted"))?;
        let revision = state.next_revision;
        state.revisions.insert(id, revision);
        state.gone_logged.remove(&id);
        let mut event = serde_json::to_value(&n).map_err(failed)?;
        event["revision"] = revision.into();
        let json = serde_json::to_string(&event).map_err(failed)?;
        if let Some(sender) = header.sender() {
            state.senders.insert(id, sender.to_string());
        }
        // Replacements keep their position, like Map.set on an existing JS key.
        if let Some(index) = state.notifications.iter().position(|old| old.id == id) {
            state.notifications[index] = n;
        } else {
            state.notifications.push(n);
        }
        queue_flush(&self.0, &mut state);
        conn.emit_signal(
            None::<&str>,
            PRIVATE_PATH,
            PRIVATE_IFACE,
            "Notified",
            &(id, replaced, json),
        )
        .await
        .map_err(failed)?;
        // Positive milliseconds, zero (never), and negative (user default) are
        // banner metadata. Expiry/hover/DND never removes notification history.
        Ok(id)
    }
    async fn close_notification(
        &self,
        id: u32,
        #[zbus(connection)] conn: &Connection,
    ) -> zbus::fdo::Result<()> {
        resolve(&self.0, &mut *self.0.lock().await, conn, id, 3)
            .await
            .map_err(failed)
    }
    #[zbus(signal)]
    async fn activation_token(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        id: u32,
        activation_token: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn notification_closed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        id: u32,
        reason: u32,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn action_invoked(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        id: u32,
        action_key: &str,
    ) -> zbus::Result<()>;
}
struct ShellNotifications(Shared);
#[zbus::interface(name = "org.nidara.Notifications1")]
impl ShellNotifications {
    /// Additive to InvokeAction: the token is directed only to the original sender.
    async fn invoke_action_with_token(
        &self,
        id: u32,
        action_key: String,
        token: String,
        revision: u64,
        #[zbus(connection)] conn: &Connection,
    ) -> zbus::fdo::Result<()> {
        let mut state = self.0.lock().await;
        if state.revisions.get(&id) != Some(&revision) {
            return Err(failed("notification was replaced"));
        }
        let n = state
            .notifications
            .iter()
            .find(|n| n.id == id)
            .ok_or_else(|| failed("notification no longer exists"))?;
        if !n.actions.iter().any(|a| a.id == action_key) || token.is_empty() || token.len() > 4096 {
            return Err(failed("invalid action or activation token"));
        }
        let resident = truthy(n.hints.get("resident"));
        let sender = state
            .senders
            .get(&id)
            .ok_or_else(|| failed("notification sender is gone"))?;
        let bus = zbus::fdo::DBusProxy::new(conn).await.map_err(failed)?;
        let name = zbus::names::BusName::try_from(sender.as_str()).map_err(failed)?;
        if bus.name_has_owner(name).await.map_err(failed)? {
            conn.emit_signal(
                Some(sender.as_str()),
                PUBLIC_PATH,
                PUBLIC_IFACE,
                "ActivationToken",
                &(id, token),
            )
            .await
            .map_err(failed)?;
            conn.emit_signal(
                Some(sender.as_str()),
                PUBLIC_PATH,
                PUBLIC_IFACE,
                "ActionInvoked",
                &(id, action_key),
            )
            .await
            .map_err(failed)?;
        } else if state.gone_logged.insert(id) {
            eprintln!("[notifd] action {id}: notification sender disconnected");
        }
        if !resident {
            resolve(&self.0, &mut state, conn, id, 3)
                .await
                .map_err(failed)?;
        }
        Ok(())
    }
    /// Revision-checked equivalent of Dismiss for a freshly rendered banner.
    async fn dismiss_banner(
        &self,
        id: u32,
        revision: u64,
        #[zbus(connection)] conn: &Connection,
    ) -> zbus::fdo::Result<()> {
        let mut state = self.0.lock().await;
        if state.revisions.get(&id) != Some(&revision) {
            return Err(failed("notification was replaced"));
        }
        resolve(&self.0, &mut state, conn, id, 2)
            .await
            .map_err(failed)
    }
    async fn list(&self) -> zbus::fdo::Result<String> {
        serde_json::to_string(&self.0.lock().await.notifications).map_err(failed)
    }
    async fn dismiss(
        &self,
        id: u32,
        #[zbus(connection)] conn: &Connection,
    ) -> zbus::fdo::Result<()> {
        resolve(&self.0, &mut *self.0.lock().await, conn, id, 2)
            .await
            .map_err(failed)
    }
    async fn invoke_action(
        &self,
        id: u32,
        action_key: String,
        #[zbus(connection)] conn: &Connection,
    ) -> zbus::fdo::Result<()> {
        let mut state = self.0.lock().await;
        let Some(n) = state.notifications.iter().find(|n| n.id == id) else {
            return Ok(());
        };
        let resident = truthy(n.hints.get("resident"));
        conn.emit_signal(
            None::<&str>,
            PUBLIC_PATH,
            PUBLIC_IFACE,
            "ActionInvoked",
            &(id, action_key),
        )
        .await
        .map_err(failed)?;
        if !resident {
            resolve(&self.0, &mut state, conn, id, 3)
                .await
                .map_err(failed)?;
        }
        Ok(())
    }
    #[zbus(signal)]
    async fn notified(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        id: u32,
        replaced: bool,
        json: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn resolved(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        id: u32,
        reason: u32,
    ) -> zbus::Result<()>;
}
fn failed(e: impl std::fmt::Display) -> zbus::fdo::Error {
    zbus::fdo::Error::Failed(e.to_string())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let options = options::Options::parse(std::env::args().skip(1).collect())?;
    let store = store::Store::new()?;
    let notifications = store.restore();
    let next = notifications
        .iter()
        .map(|n| n.id)
        .max()
        .filter(|n| *n < MAX_ID)
        .map_or(1, |n| n + 1);
    let shared = Arc::new(Mutex::new(State {
        notifications,
        next,

        senders: HashMap::new(),
        revisions: HashMap::new(),
        next_revision: 0,
        gone_logged: Default::default(),
        flush: None,
        store,
    }));
    // Install both objects before claiming names. Never queue behind somebody
    // else's notification server or replace it. No D-Bus activation in other DEs.
    let conn = zbus::connection::Builder::session()?
        .serve_at(PUBLIC_PATH, Notifications(shared.clone()))?
        .serve_at(PRIVATE_PATH, ShellNotifications(shared.clone()))?
        .build()
        .await?;
    // Refuse a second notification server before initializing other services.
    conn.request_name_with_flags(PUBLIC_IFACE, zbus::fdo::RequestNameFlags::DoNotQueue.into())
        .await?;
    eprintln!("[notifd] serving {PUBLIC_IFACE}");
    // All services by default; explicit flags select an isolated subset.
    if options.has("--config") {
        config::serve(&conn).await?;
    }
    if options.has("--applications") {
        applications::serve(&conn).await?;
    }
    let read_only = options.has("--network-read-only");
    if read_only || options.has("--network") {
        network::serve(&conn, read_only).await?;
    }
    let read_only = options.has("--bluetooth-read-only");
    if read_only || options.has("--bluetooth") {
        bluetooth::serve(&conn, read_only).await?;
    }
    if options.has("--audio") {
        audio::serve(&conn).await?;
    }
    if options.has("--media") {
        media::serve(&conn).await?;
    }
    if options.has("--tray") {
        tray::serve(&conn).await?;
    }
    let power_read_only = options.has("--power-read-only");
    if power_read_only || options.has("--power") {
        power::serve(&conn, power_read_only).await?;
    }
    // Type=dbus readiness means every selected service has finished registering.
    conn.request_name_with_flags(
        "org.nidara.Session",
        zbus::fdo::RequestNameFlags::DoNotQueue.into(),
    )
    .await?;
    eprintln!("[sessiond] ready");
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
    // systemd's SIGTERM must not lose the last 100 ms of a burst.
    shared.lock().await.persist();
    Ok(())
}
