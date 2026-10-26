// SPDX-License-Identifier: GPL-3.0-or-later
// The server outlives shell reloads. DnD and the user's banner timeout remain UI
// policy; only the sender's positive expire_timeout belongs here (#819).
mod config;
mod model;
mod store;

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
    timers: HashMap<u32, AbortHandle>,
    flush: Option<AbortHandle>,
    store: store::Store,
}
impl State {
    fn clear_timer(&mut self, id: u32) {
        if let Some(handle) = self.timers.remove(&id) {
            handle.abort();
        }
    }
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
    locked.clear_timer(id);
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
        let json = serde_json::to_string(&n).map_err(failed)?;
        state.clear_timer(id);
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
        // 0 = never, negative = server decides: keep it in the NC. The user's
        // popup timeout lives only in the shell. Replacing cancels the old timer.
        if expire_timeout > 0 {
            let shared = self.0.clone();
            let connection = conn.clone();
            let task = tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(expire_timeout as u64)).await;
                let mut state = shared.lock().await;
                state.timers.remove(&id); // Don't abort this task inside resolve.
                if let Err(e) = resolve(&shared, &mut state, &connection, id, 1).await {
                    eprintln!("[notifd] expire: {e}");
                }
            });
            state.timers.insert(id, task.abort_handle());
        }
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
        timers: HashMap::new(),
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
    // Explicit flags: zbus builder defaults must not put a second daemon in a
    // name queue (or claim readiness without actually owning either name).
    for name in [PUBLIC_IFACE, "org.nidara.Session"] {
        conn.request_name_with_flags(name, zbus::fdo::RequestNameFlags::DoNotQueue.into())
            .await?;
    }
    eprintln!("[notifd] serving {PUBLIC_IFACE} and org.nidara.Session");
    // The settings service, where this session asks for it (the Rust session): elsewhere the
    // TypeScript shell serves it, and the daemon leaves it alone.
    if std::env::args().any(|a| a == "--config") {
        config::serve(&conn).await?;
    }
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
    // systemd's SIGTERM must not lose the last 100 ms of a burst.
    shared.lock().await.persist();
    Ok(())
}
