// SPDX-License-Identifier: GPL-3.0-or-later
// The server outlives shell reloads. DnD and the user's banner timeout remain UI
// policy. Ordinary history survives presentation expiry; transient records do not.
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
use tokio::sync::Mutex;
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
    sequence: u64,
    image_refs: HashMap<std::path::PathBuf, usize>,
    store: store::Store,
}
impl State {
    fn list(&self) -> Result<serde_json::Value, serde_json::Error> {
        self.notifications
            .iter()
            .map(|n| {
                let mut value = serde_json::to_value(n)?;
                value["revision"] = self
                    .revisions
                    .get(&n.id)
                    .copied()
                    .unwrap_or_default()
                    .into();
                Ok(value)
            })
            .collect::<Result<Vec<_>, _>>()
            .map(serde_json::Value::from)
    }
    fn image_ref(&mut self, n: &Notification, add: bool) {
        if let Some(path) = self.store.owned_image(n) {
            if add {
                *self.image_refs.entry(path).or_default() += 1;
            } else if let Some(count) = self.image_refs.get_mut(&path) {
                *count -= 1;
                if *count == 0 {
                    self.image_refs.remove(&path);
                    if let Err(e) = std::fs::remove_file(&path) {
                        eprintln!("[notifd] image retirement: {e}");
                    }
                }
            }
        }
    }
}
async fn changed(
    state: &mut State,
    conn: &Connection,
    value: serde_json::Value,
) -> zbus::Result<()> {
    state.sequence += 1;
    conn.emit_signal(
        None::<&str>,
        PRIVATE_PATH,
        PRIVATE_IFACE,
        "Changed",
        &(state.sequence, value.to_string()),
    )
    .await
}
async fn remove_ids(
    locked: &mut State,
    conn: &Connection,
    ids: Vec<u32>,
    reason: u32,
    batch: bool,
) -> zbus::fdo::Result<()> {
    let ids: std::collections::HashSet<_> = ids.into_iter().collect();
    let removing: Vec<_> = locked
        .notifications
        .iter()
        .filter(|n| ids.contains(&n.id))
        .cloned()
        .collect();
    if removing.is_empty() {
        return Ok(());
    }
    let persisted: Vec<_> = removing
        .iter()
        .filter(|n| !truthy(n.hints.get("transient")))
        .map(|n| n.id)
        .collect();
    if !persisted.is_empty() {
        locked
            .store
            .append(
                &store::Change::Remove { ids: persisted },
                &locked.notifications,
            )
            .map_err(failed)?;
    }
    locked.notifications.retain(|n| !ids.contains(&n.id));
    let removed: Vec<_> = removing.iter().map(|n| n.id).collect();
    // Publish one canonical UI change before per-sender delivery/GC. A large
    // history must not delay the renderer's fixed-time clear animation.
    let mut error = None;
    if batch {
        if let Err(e) = conn
            .emit_signal(
                None::<&str>,
                PRIVATE_PATH,
                PRIVATE_IFACE,
                "ResolvedBatch",
                &(removed.clone(), reason),
            )
            .await
        {
            error = Some(e);
        }
        if let Err(e) = changed(
            locked,
            conn,
            serde_json::json!({"removed":removed,"reason":reason}),
        )
        .await
        {
            error.get_or_insert(e);
        }
    }
    for n in &removing {
        locked.image_ref(n, false);
        let sender = locked.senders.remove(&n.id);
        locked.revisions.remove(&n.id);
        locked.gone_logged.remove(&n.id);
        if let Err(e) = conn
            .emit_signal(
                sender.as_deref(),
                PUBLIC_PATH,
                PUBLIC_IFACE,
                "NotificationClosed",
                &(n.id, reason),
            )
            .await
        {
            error.get_or_insert(e);
        }
        if !batch
            && let Err(e) = conn
                .emit_signal(
                    None::<&str>,
                    PRIVATE_PATH,
                    PRIVATE_IFACE,
                    "Resolved",
                    &(n.id, reason),
                )
                .await
        {
            error.get_or_insert(e);
        }
    }
    if !batch
        && let Err(e) = changed(
            locked,
            conn,
            serde_json::json!({"removed":removed,"reason":reason}),
        )
        .await
    {
        error.get_or_insert(e);
    }
    match error {
        Some(e) => Err(failed(e)),
        None => Ok(()),
    }
}

async fn resolve(
    _state: &Shared,
    locked: &mut State,
    conn: &Connection,
    id: u32,
    reason: u32,
) -> zbus::fdo::Result<()> {
    remove_ids(locked, conn, vec![id], reason, false).await
}
async fn maintain(locked: &mut State, conn: &Connection) -> zbus::fdo::Result<()> {
    let now = now();
    let ids = model::retention(&locked.notifications, now, model::today_start(now));
    remove_ids(locked, conn, ids, 1, true).await
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
        let mut event = serde_json::to_value(&n).map_err(failed)?;
        event["revision"] = revision.into();
        let json = serde_json::to_string(&event).map_err(failed)?;
        // Commit the operation before making it visible; ephemeral replacements remove any persisted predecessor.
        if truthy(n.hints.get("transient")) {
            if state
                .notifications
                .iter()
                .any(|old| old.id == id && !truthy(old.hints.get("transient")))
            {
                state
                    .store
                    .append(
                        &store::Change::Remove { ids: vec![id] },
                        &state.notifications,
                    )
                    .map_err(failed)?;
            }
        } else {
            state
                .store
                .append(
                    &store::Change::Put {
                        notification: n.clone(),
                    },
                    &state.notifications,
                )
                .map_err(failed)?;
        }
        state.revisions.insert(id, revision);
        state.gone_logged.remove(&id);
        if let Some(sender) = header.sender() {
            state.senders.insert(id, sender.to_string());
        }
        state.image_ref(&n, true);
        if let Some(index) = state.notifications.iter().position(|old| old.id == id) {
            let old = std::mem::replace(&mut state.notifications[index], n);
            state.image_ref(&old, false);
        } else {
            state.notifications.push(n);
        }
        changed(&mut state, conn, serde_json::json!({"put":event}))
            .await
            .map_err(failed)?;
        conn.emit_signal(
            None::<&str>,
            PRIVATE_PATH,
            PRIVATE_IFACE,
            "Notified",
            &(id, replaced, json),
        )
        .await
        .map_err(failed)?;
        maintain(&mut state, conn).await?;
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
        let sender = state.senders.get(&id).cloned();
        let alive = if let Some(sender) = &sender {
            let bus = zbus::fdo::DBusProxy::new(conn).await.map_err(failed)?;
            bus.name_has_owner(zbus::names::BusName::try_from(sender.as_str()).map_err(failed)?)
                .await
                .map_err(failed)?
        } else {
            false
        };
        if alive {
            conn.emit_signal(
                sender.as_deref(),
                PUBLIC_PATH,
                PUBLIC_IFACE,
                "ActivationToken",
                &(id, token),
            )
            .await
            .map_err(failed)?;
            conn.emit_signal(
                sender.as_deref(),
                PUBLIC_PATH,
                PUBLIC_IFACE,
                "ActionInvoked",
                &(id, action_key),
            )
            .await
            .map_err(failed)?;
        } else if state.gone_logged.insert(id) {
            eprintln!("[notifd] action {id}: notification sender unknown or disconnected");
        }
        if !resident || !alive {
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
    /// Only a current transient record can expire with its presentation.
    async fn expire_transient(
        &self,
        id: u32,
        revision: u64,
        #[zbus(connection)] conn: &Connection,
    ) -> zbus::fdo::Result<()> {
        let mut state = self.0.lock().await;
        if state.revisions.get(&id) != Some(&revision) {
            return Err(failed("notification was replaced"));
        }
        if !state
            .notifications
            .iter()
            .any(|n| n.id == id && truthy(n.hints.get("transient")))
        {
            return Err(failed("notification is not transient"));
        }
        resolve(&self.0, &mut state, conn, id, 1)
            .await
            .map_err(failed)
    }
    async fn list(&self) -> zbus::fdo::Result<String> {
        self.0
            .lock()
            .await
            .list()
            .and_then(|v| serde_json::to_string(&v))
            .map_err(failed)
    }
    async fn snapshot(&self) -> zbus::fdo::Result<(u64, String)> {
        let state = self.0.lock().await;
        Ok((
            state.sequence,
            state
                .list()
                .and_then(|v| serde_json::to_string(&v))
                .map_err(failed)?,
        ))
    }
    async fn dismiss_group(
        &self,
        group: String,
        #[zbus(connection)] conn: &Connection,
    ) -> zbus::fdo::Result<()> {
        let mut state = self.0.lock().await;
        let ids = state
            .notifications
            .iter()
            .filter(|n| model::app_group(n) == group && !truthy(n.hints.get("transient")))
            .map(|n| n.id)
            .collect();
        remove_ids(&mut state, conn, ids, 2, true).await
    }
    async fn dismiss_all(&self, #[zbus(connection)] conn: &Connection) -> zbus::fdo::Result<()> {
        let mut state = self.0.lock().await;
        let ids = state
            .notifications
            .iter()
            .filter(|n| !truthy(n.hints.get("transient")))
            .map(|n| n.id)
            .collect();
        remove_ids(&mut state, conn, ids, 2, true).await
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
    async fn changed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        sequence: u64,
        json: &str,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn resolved_batch(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        ids: Vec<u32>,
        reason: u32,
    ) -> zbus::Result<()>;
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
    let mut notifications = store.restore()?;
    let removed: std::collections::HashSet<_> =
        model::retention(&notifications, now(), model::today_start(now()))
            .into_iter()
            .collect();
    notifications.retain(|n| !removed.contains(&n.id));
    store.compact(&notifications)?;
    store.clean_images(&notifications)?;
    let revisions: HashMap<_, _> = notifications
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id, i as u64 + 1))
        .collect();
    let next_revision = revisions.len() as u64;
    let mut image_refs = HashMap::new();
    for n in &notifications {
        if let Some(p) = store.owned_image(n) {
            *image_refs.entry(p).or_insert(0) += 1;
        }
    }
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
        revisions,
        next_revision,
        gone_logged: Default::default(),
        sequence: 0,
        image_refs,
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
    let maintenance_state = shared.clone();
    let maintenance_conn = conn.clone();
    let maintenance = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            if let Err(e) = maintain(&mut *maintenance_state.lock().await, &maintenance_conn).await
            {
                eprintln!("[notifd] retention: {e}");
            }
        }
    });
    let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?;
    tokio::select! { _ = term.recv() => {}, _ = tokio::signal::ctrl_c() => {} }
    maintenance.abort(); // Every operation was already durably appended before reply.
    Ok(())
}
