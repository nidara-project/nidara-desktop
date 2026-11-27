// SPDX-License-Identifier: LGPL-3.0-or-later
//! The lock screen's role, ext-session-lock-v1 (#1195): one lock object and one lock
//! surface per output, all on ONE connection, because the protocol ties the surfaces to
//! the client that holds the lock.
//!
//! `lock_session` connects and asks for the lock. `SessionLock::bind_output` binds an
//! output the `OutputWatch` reported on that same connection, checked against the watcher
//! as a dock's is (SHELL-SURFACES.md §2). `run_lock_surface` then runs one surface on its
//! own event queue, on any thread: the connection is shared, the queues are not.
//!
//! The compositor says `Locked` only once every output shows a lock surface, so the
//! surfaces are started before waiting for it. `Finished` means the compositor refused the
//! lock (another client holds it) or took it back: the client stops drawing and exits.
//! `unlock` is the only way out, and only the holder may call it.
use crate::{BindFailure, LayerOutput, OutputId, OutputWatch, Result, err};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use wayland_client::{
    Connection, Dispatch, EventQueue, Proxy, QueueHandle,
    protocol::{wl_registry, wl_surface},
};
pub(crate) use wayland_protocols::ext::session_lock::v1::client::{
    ext_session_lock_manager_v1, ext_session_lock_surface_v1, ext_session_lock_v1,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LockStatus {
    /// Asked for; the compositor has not answered yet.
    Pending,
    /// Every output shows a lock surface: the session is hidden.
    Locked,
    /// Refused or ended by the compositor. Nothing more will happen on this lock.
    Finished,
}

#[derive(Default)]
struct State {
    globals: Vec<(u32, String, u32)>,
    status: Option<LockStatus>,
}

/// The lock, held by this client until `unlock`. Dropping it without unlocking leaves
/// the session locked, as the protocol requires (the compositor keeps it hidden).
pub struct SessionLock {
    connection: Connection,
    queue: EventQueue<State>,
    state: State,
    lock: ext_session_lock_v1::ExtSessionLockV1,
    status: Arc<Mutex<LockStatus>>,
}

/// One output bound on the lock's connection, for `run_lock_surface`.
#[derive(Debug)]
pub struct LockOutput {
    pub(crate) output: LayerOutput,
    pub(crate) lock: ext_session_lock_v1::ExtSessionLockV1,
}
impl LockOutput {
    pub fn id(&self) -> OutputId {
        self.output.id
    }
}

/// Connect and ask for the lock. Fails when the compositor has no ext-session-lock-v1 or
/// does not answer the registry within `timeout`; the answer to the lock itself comes
/// later, through `status` and `wait`.
pub fn lock_session(timeout: Duration) -> Result<SessionLock> {
    let deadline = Instant::now() + timeout;
    let connection = crate::connect::connect_within(deadline)?;
    let mut queue = connection.new_event_queue::<State>();
    let qh = queue.handle();
    let registry = connection.display().get_registry(&qh, ());
    let mut state = State::default();
    queue.roundtrip(&mut state).map_err(err)?;
    let name = ext_session_lock_manager_v1::ExtSessionLockManagerV1::interface().name;
    let (id, _, _) = state
        .globals
        .iter()
        .find(|(_, n, _)| n == name)
        .cloned()
        .ok_or("required Wayland protocol missing: ext_session_lock_manager_v1")?;
    let manager: ext_session_lock_manager_v1::ExtSessionLockManagerV1 =
        registry.bind(id, 1, &qh, ());
    let lock = manager.lock(&qh, ());
    // The lock object outlives its manager.
    manager.destroy();
    connection.flush().map_err(err)?;
    Ok(SessionLock {
        connection,
        queue,
        state,
        lock,
        status: Arc::new(Mutex::new(LockStatus::Pending)),
    })
}

impl SessionLock {
    /// `id`'s exact instance bound on this lock's connection, or why not. Call it on the
    /// watcher's thread, as `OutputWatch::bind_output`.
    pub fn bind_output(
        &self,
        watch: &mut OutputWatch,
        id: OutputId,
        timeout: Duration,
    ) -> std::result::Result<LockOutput, BindFailure> {
        let output =
            watch.bind_output_with(self.connection.clone(), id, Instant::now() + timeout, || {})?;
        Ok(LockOutput {
            output,
            lock: self.lock.clone(),
        })
    }
    /// What the compositor has said so far, without waiting.
    pub fn status(&mut self) -> Result<LockStatus> {
        self.wait(Some(Duration::ZERO))
    }
    /// Wait up to `timeout` (None: forever) for the status to move on from `Pending`, or
    /// from `Locked` to `Finished`; returns it as it is when the time is up.
    pub fn wait(&mut self, timeout: Option<Duration>) -> Result<LockStatus> {
        let start = *self.status.lock().unwrap();
        let deadline = timeout.map(|t| Instant::now() + t);
        loop {
            self.queue.dispatch_pending(&mut self.state).map_err(err)?;
            if let Some(status) = self.state.status.take() {
                *self.status.lock().unwrap() = status;
            }
            let now = *self.status.lock().unwrap();
            if now != start || now == LockStatus::Finished {
                return Ok(now);
            }
            let left = deadline.map(|d| d.saturating_duration_since(Instant::now()));
            if left.is_some_and(|l| l.is_zero()) {
                return Ok(now);
            }
            crate::outputs::read_once(&self.connection, &mut self.queue, &mut self.state, left)?;
        }
    }
    /// Unlock the session and give the lock back. The compositor shows the session again;
    /// the lock surfaces are then the caller's to close (their loops, through a `Waker`).
    /// Refused unless the compositor said `Locked`: unlocking a lock it never confirmed is
    /// a protocol error, and a `Finished` lock is no longer ours to end.
    pub fn unlock(mut self) -> Result<()> {
        match self.status()? {
            LockStatus::Locked => {}
            LockStatus::Pending => return Err("the session is not locked yet".into()),
            LockStatus::Finished => return Err("the compositor ended this lock".into()),
        }
        self.lock.unlock_and_destroy();
        // The compositor has processed the unlock before the surfaces go.
        self.queue.roundtrip(&mut self.state).map_err(err)?;
        Ok(())
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        s: &mut Self,
        _: &wl_registry::WlRegistry,
        e: wl_registry::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => s.globals.push((name, interface, version)),
            wl_registry::Event::GlobalRemove { name } => s.globals.retain(|(n, ..)| *n != name),
            _ => {}
        }
    }
}
impl Dispatch<ext_session_lock_v1::ExtSessionLockV1, ()> for State {
    fn event(
        s: &mut Self,
        _: &ext_session_lock_v1::ExtSessionLockV1,
        e: ext_session_lock_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            ext_session_lock_v1::Event::Locked => s.status = Some(LockStatus::Locked),
            ext_session_lock_v1::Event::Finished => s.status = Some(LockStatus::Finished),
            _ => {}
        }
    }
}
wayland_client::delegate_noop!(State: ignore ext_session_lock_manager_v1::ExtSessionLockManagerV1);

impl crate::Window {
    /// The lock surface for `output`, on this window's queue. Its first configure comes
    /// unasked, so the surface is not committed before it (an unconfigured buffer is a
    /// protocol error).
    pub(crate) fn make_lock_surface(
        &mut self,
        surface: &wl_surface::WlSurface,
        output: &LockOutput,
    ) {
        let s = output
            .lock
            .get_lock_surface(surface, &output.output.proxy, &self.qh, ());
        self.lock_surface = Some(s);
    }
    pub fn is_lock_surface(&self) -> bool {
        self.lock_surface.is_some()
    }
}

impl Dispatch<ext_session_lock_surface_v1::ExtSessionLockSurfaceV1, ()> for crate::Window {
    fn event(
        w: &mut Self,
        s: &ext_session_lock_surface_v1::ExtSessionLockSurfaceV1,
        e: ext_session_lock_surface_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let ext_session_lock_surface_v1::Event::Configure {
            serial,
            width,
            height,
        } = e
        {
            s.ack_configure(serial);
            // The output's size; the protocol forbids any other.
            if width > 0 && height > 0 {
                w.width = width;
                w.height = height;
            }
            w.configured = true;
            w.dirty = true;
            w.events.push(crate::Event::Configure);
        }
    }
}
