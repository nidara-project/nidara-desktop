// SPDX-License-Identifier: LGPL-3.0-or-later
//! Which outputs exist, on a small connection of its own (SHELL-SURFACES.md §2). The
//! shell starts one `run_layer` per output it reports, naming it by `OutputId`.
use crate::{LayerOutput, OutputId, Result, err};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};
use wayland_client::{
    Connection, Dispatch, EventQueue, Proxy, QueueHandle,
    protocol::{wl_callback, wl_output, wl_registry},
};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};

#[derive(Clone, Debug, PartialEq)]
pub struct OutputInfo {
    pub id: OutputId,
    /// `wl_output.name`, e.g. "DP-1": for people and settings, not identity.
    pub name: String,
    pub description: String,
    pub scale: i32,
    /// Logical x, y, width, height (xdg-output), when the compositor offers it.
    pub logical: Option<[i32; 4]>,
}
#[derive(Clone, Debug, PartialEq)]
pub enum OutputEvent {
    Added(OutputInfo),
    Changed(OutputInfo),
    Removed(OutputId),
    /// The connection to the compositor is gone: every OutputId handed out so far is
    /// invalid (a restarted compositor may reuse the numbers). Start over.
    Lost(String),
}

struct Entry {
    info: OutputInfo,
    proxy: wl_output::WlOutput,
    xdg: Option<zxdg_output_v1::ZxdgOutputV1>,
    announced: bool,
    xdg_pending: bool,
}
struct State {
    xdg_manager: Option<zxdg_output_manager_v1::ZxdgOutputManagerV1>,
    entries: Vec<Entry>,
    events: Vec<OutputEvent>,
}
pub struct OutputWatch {
    connection: Connection,
    queue: EventQueue<State>,
    state: State,
    lost: bool,
    /// `Lost` has been returned by `next` (it may be found earlier by `bind_output`).
    reported_lost: bool,
}

/// Never repeated in this process, across watches (a new watch after `Lost` included).
static GENERATION: AtomicU64 = AtomicU64::new(1);

/// Why `OutputWatch::bind_output` gave no dock connection. Nothing partial is returned:
/// the dock's connection is closed in every case.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BindFailure {
    /// That instance is gone (removed, possibly re-added under the same number).
    Gone,
    /// The compositor did not answer in time.
    Timeout,
    /// The dock's connection failed.
    Connection(String),
    /// The watcher's connection failed; `next` reports `Lost`.
    Lost,
}

/// Connect and report the outputs present now as `Added`, or fail after `timeout`.
pub fn outputs(timeout: Duration) -> Result<OutputWatch> {
    watch(Connection::connect_to_env().map_err(err)?, timeout)
}
fn watch(connection: Connection, timeout: Duration) -> Result<OutputWatch> {
    let mut queue = connection.new_event_queue::<State>();
    let qh = queue.handle();
    let display = connection.display();
    display.get_registry(&qh, ());
    let mut state = State {
        xdg_manager: None,
        entries: Vec::new(),
        events: Vec::new(),
    };
    // Globals, then each output's initial burst (and its xdg-output) up to `done`.
    let deadline = Instant::now() + timeout;
    for _ in 0..3 {
        sync(&connection, &mut queue, &mut state, deadline).map_err(|e| match e {
            SyncError::Timeout => "the compositor did not list its outputs in time".to_string(),
            SyncError::Failed(e) => e,
        })?;
    }
    // The initial outputs are reported once, complete (xdg-output may finish after
    // wl_output.done when its manager was bound later in registry order).
    state.events = state
        .entries
        .iter()
        .filter(|e| e.announced)
        .map(|e| OutputEvent::Added(e.info.clone()))
        .collect();
    Ok(OutputWatch {
        connection,
        queue,
        state,
        lost: false,
        reported_lost: false,
    })
}

impl OutputWatch {
    /// A dock's own connection with `id`'s exact instance bound on it (SHELL-SURFACES.md
    /// §2), for `LayerSpec.output`; None when that instance is gone. The dock connection
    /// binds the number and syncs; only then does this watcher sync. A removal before
    /// the bind was processed is therefore in the watcher's events by its sync, even when
    /// a re-added output reused the number. Call it on the watcher's thread; the events
    /// it reads stay queued for `next`.
    pub fn bind_output(
        &mut self,
        id: OutputId,
        timeout: Duration,
    ) -> std::result::Result<LayerOutput, BindFailure> {
        let connection =
            Connection::connect_to_env().map_err(|e| BindFailure::Connection(e.to_string()))?;
        self.bind_output_with(connection, id, Instant::now() + timeout, || {})
    }
    fn bind_output_with(
        &mut self,
        connection: Connection,
        id: OutputId,
        deadline: Instant,
        after_bind: impl FnOnce(),
    ) -> std::result::Result<LayerOutput, BindFailure> {
        if self.lost {
            return Err(BindFailure::Lost);
        }
        if !self.announced(id) {
            return Err(BindFailure::Gone);
        }
        let dock = |e: SyncError| match e {
            SyncError::Timeout => BindFailure::Timeout,
            SyncError::Failed(e) => BindFailure::Connection(e),
        };
        let mut queue = connection.new_event_queue::<Globals>();
        let qh = queue.handle();
        let registry = connection.display().get_registry(&qh, ());
        let mut globals = Globals::default();
        sync(&connection, &mut queue, &mut globals, deadline).map_err(dock)?;
        let version = globals
            .0
            .iter()
            .find(|(name, (interface, _))| *name == id.global && interface == "wl_output")
            .map(|(_, (_, version))| *version)
            .ok_or(BindFailure::Gone)?;
        let proxy: wl_output::WlOutput = registry.bind(id.global, version.min(4), &qh, ());
        // syncA: the compositor has processed the bind.
        sync(&connection, &mut queue, &mut globals, deadline).map_err(dock)?;
        after_bind();
        // syncB, sent after syncA returned: every removal before the bind is now read.
        match sync(&self.connection, &mut self.queue, &mut self.state, deadline) {
            Ok(()) => {}
            Err(SyncError::Timeout) => return Err(BindFailure::Timeout),
            Err(SyncError::Failed(e)) => {
                self.lost = true;
                self.state.events.push(OutputEvent::Lost(e));
                self.reported_lost = false;
                return Err(BindFailure::Lost);
            }
        }
        if !self.announced(id) {
            return Err(BindFailure::Gone);
        }
        Ok(LayerOutput {
            id,
            connection,
            proxy,
        })
    }
    fn announced(&self, id: OutputId) -> bool {
        self.state
            .entries
            .iter()
            .any(|e| e.announced && e.info.id == id)
    }
    pub fn current(&self) -> Vec<OutputInfo> {
        self.state
            .entries
            .iter()
            .filter(|e| e.announced)
            .map(|e| e.info.clone())
            .collect()
    }
    /// Events so far, waiting up to `timeout` (None: forever) for the first one; empty
    /// only when the timeout passed. After `Lost` it only returns an error.
    pub fn next(&mut self, timeout: Option<Duration>) -> Result<Vec<OutputEvent>> {
        if self.lost {
            // A Lost found by bind_output is delivered here once, after what preceded it.
            if !self.reported_lost {
                self.reported_lost = true;
                return Ok(std::mem::take(&mut self.state.events));
            }
            return Err("output watch lost its compositor".into());
        }
        // One read may carry only part of an output's burst (its `done` comes later).
        let deadline = timeout.map(|t| std::time::Instant::now() + t);
        while self.state.events.is_empty() {
            let left = deadline.map(|d| d.saturating_duration_since(std::time::Instant::now()));
            if left.is_some_and(|l| l.is_zero()) {
                break;
            }
            if let Err(e) = self.wait(left) {
                self.lost = true;
                self.reported_lost = true;
                self.state.events.push(OutputEvent::Lost(e));
                break;
            }
        }
        Ok(std::mem::take(&mut self.state.events))
    }
    fn wait(&mut self, timeout: Option<Duration>) -> Result<()> {
        self.queue.dispatch_pending(&mut self.state).map_err(err)?;
        if !self.state.events.is_empty() {
            return Ok(());
        }
        read_once(&self.connection, &mut self.queue, &mut self.state, timeout)
    }
}

/// Flush, wait up to `timeout` for the socket, read and dispatch what came.
fn read_once<S: 'static>(
    connection: &Connection,
    queue: &mut EventQueue<S>,
    state: &mut S,
    timeout: Option<Duration>,
) -> Result<()> {
    connection.flush().map_err(err)?;
    let Some(guard) = queue.prepare_read() else {
        return queue.dispatch_pending(state).map(|_| ()).map_err(err);
    };
    use rustix::event::{PollFd, PollFlags, Timespec, poll};
    let fd = guard.connection_fd();
    let mut fds = [PollFd::new(&fd, PollFlags::IN)];
    let timeout = timeout.map(|t| Timespec {
        tv_sec: t.as_secs() as i64,
        tv_nsec: i64::from(t.subsec_nanos()),
    });
    match poll(&mut fds, timeout.as_ref()) {
        Ok(_)
            if fds[0]
                .revents()
                .intersects(PollFlags::IN | PollFlags::HUP | PollFlags::ERR) =>
        {
            match guard.read() {
                Ok(_) => {}
                Err(wayland_client::backend::WaylandError::Io(e))
                    if e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => return Err(err(e)),
            }
        }
        Ok(_) => drop(guard),
        Err(e) if e == rustix::io::Errno::INTR => drop(guard),
        Err(e) => return Err(err(e)),
    }
    queue.dispatch_pending(state).map(|_| ()).map_err(err)
}

enum SyncError {
    Timeout,
    Failed(String),
}
/// A roundtrip that gives up at `deadline`: a compositor that stops answering must not
/// hang the shell's thread. Events read meanwhile stay dispatched into `state`.
fn sync<S>(
    connection: &Connection,
    queue: &mut EventQueue<S>,
    state: &mut S,
    deadline: Instant,
) -> std::result::Result<(), SyncError>
where
    S: Dispatch<wl_callback::WlCallback, Arc<AtomicBool>> + 'static,
{
    let done = Arc::new(AtomicBool::new(false));
    connection.display().sync(&queue.handle(), done.clone());
    loop {
        queue
            .dispatch_pending(state)
            .map_err(|e| SyncError::Failed(e.to_string()))?;
        if done.load(Ordering::Acquire) {
            return Ok(());
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return Err(SyncError::Timeout);
        }
        read_once(connection, queue, state, Some(left)).map_err(SyncError::Failed)?;
    }
}
fn callback_done(done: &AtomicBool, e: wl_callback::Event) {
    if let wl_callback::Event::Done { .. } = e {
        done.store(true, Ordering::Release);
    }
}
impl Dispatch<wl_callback::WlCallback, Arc<AtomicBool>> for State {
    fn event(
        _: &mut Self,
        _: &wl_callback::WlCallback,
        e: wl_callback::Event,
        done: &Arc<AtomicBool>,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        callback_done(done, e);
    }
}
impl Dispatch<wl_callback::WlCallback, Arc<AtomicBool>> for Globals {
    fn event(
        _: &mut Self,
        _: &wl_callback::WlCallback,
        e: wl_callback::Event,
        done: &Arc<AtomicBool>,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        callback_done(done, e);
    }
}

impl State {
    fn entry(&mut self, proxy: &wl_output::WlOutput) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|e| e.proxy == *proxy)
    }
    fn complete(&mut self, at: usize) {
        let e = &mut self.entries[at];
        if e.xdg_pending {
            return;
        }
        let info = e.info.clone();
        self.events.push(if e.announced {
            OutputEvent::Changed(info)
        } else {
            OutputEvent::Added(info)
        });
        e.announced = true;
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for State {
    fn event(
        s: &mut Self,
        r: &wl_registry::WlRegistry,
        e: wl_registry::Event,
        _: &(),
        _: &Connection,
        qh: &QueueHandle<Self>,
    ) {
        match e {
            wl_registry::Event::Global {
                name,
                interface,
                version,
            } => {
                if interface == zxdg_output_manager_v1::ZxdgOutputManagerV1::interface().name {
                    let m: zxdg_output_manager_v1::ZxdgOutputManagerV1 =
                        r.bind(name, version.min(3), qh, ());
                    for e in &mut s.entries {
                        e.xdg = Some(m.get_xdg_output(&e.proxy, qh, name));
                    }
                    s.xdg_manager = Some(m);
                } else if interface == "wl_output" {
                    let proxy: wl_output::WlOutput = r.bind(name, version.min(4), qh, ());
                    let xdg = s
                        .xdg_manager
                        .as_ref()
                        .map(|m| m.get_xdg_output(&proxy, qh, name));
                    s.entries.push(Entry {
                        info: OutputInfo {
                            id: OutputId {
                                global: name,
                                generation: GENERATION.fetch_add(1, Ordering::Relaxed),
                            },
                            name: String::new(),
                            description: String::new(),
                            scale: 1,
                            logical: None,
                        },
                        // xdg-output v3 ends its batch with wl_output.done; older
                        // versions send their own done, which we wait for.
                        xdg_pending: xdg.as_ref().is_some_and(|x| x.version() < 3),
                        proxy,
                        xdg,
                        announced: false,
                    });
                }
            }
            wl_registry::Event::GlobalRemove { name } => {
                if let Some(at) = s.entries.iter().position(|e| e.info.id.global == name) {
                    let e = s.entries.remove(at);
                    if let Some(x) = e.xdg {
                        x.destroy();
                    }
                    if e.proxy.version() >= 3 {
                        e.proxy.release();
                    }
                    if e.announced {
                        s.events.push(OutputEvent::Removed(e.info.id));
                    }
                }
            }
            _ => {}
        }
    }
}
/// The registry of a dock's connection while `bind_output` checks it: name → (interface,
/// version).
#[derive(Default)]
struct Globals(Vec<(u32, (String, u32))>);
impl Dispatch<wl_registry::WlRegistry, ()> for Globals {
    fn event(
        g: &mut Self,
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
            } => g.0.push((name, (interface, version))),
            wl_registry::Event::GlobalRemove { name } => g.0.retain(|(n, _)| *n != name),
            _ => {}
        }
    }
}
wayland_client::delegate_noop!(Globals: ignore wl_output::WlOutput);
impl Dispatch<wl_output::WlOutput, ()> for State {
    fn event(
        s: &mut Self,
        p: &wl_output::WlOutput,
        e: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(entry) = s.entry(p) else { return };
        match e {
            wl_output::Event::Name { name } => entry.info.name = name,
            wl_output::Event::Description { description } => entry.info.description = description,
            wl_output::Event::Scale { factor } => entry.info.scale = factor.max(1),
            wl_output::Event::Done => {
                let at = s.entries.iter().position(|e| e.proxy == *p).unwrap();
                s.complete(at);
            }
            _ => {}
        }
    }
}
impl Dispatch<zxdg_output_v1::ZxdgOutputV1, u32> for State {
    fn event(
        s: &mut Self,
        _: &zxdg_output_v1::ZxdgOutputV1,
        e: zxdg_output_v1::Event,
        global: &u32,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let Some(at) = s.entries.iter().position(|e| e.info.id.global == *global) else {
            return;
        };
        let entry = &mut s.entries[at];
        let rect = entry.info.logical.get_or_insert([0; 4]);
        match e {
            zxdg_output_v1::Event::LogicalPosition { x, y } => (rect[0], rect[1]) = (x, y),
            zxdg_output_v1::Event::LogicalSize { width, height } => {
                (rect[2], rect[3]) = (width, height)
            }
            // v3: wl_output.done ends the batch; before v3, xdg_output.done does.
            zxdg_output_v1::Event::Done if entry.xdg_pending => {
                entry.xdg_pending = false;
                s.complete(at);
            }
            _ => {}
        }
    }
}
wayland_client::delegate_noop!(State: ignore zxdg_output_manager_v1::ZxdgOutputManagerV1);

#[cfg(test)]
mod tests {
    //! Against the same Rust server backend Hyalo uses (no `server_system`).
    use super::*;
    use std::os::unix::net::UnixStream;
    use std::sync::{Arc, Mutex, mpsc};
    use wayland_server::{
        Client, DataInit, Display, DisplayHandle, GlobalDispatch, New,
        backend::{ClientData, GlobalId},
        protocol::wl_output as server_output,
    };
    /// Each global is one output INSTANCE, numbered in creation order; a released
    /// wl_output reports which instance it was bound to.
    struct Server {
        released: Arc<Mutex<Vec<u32>>>,
    }
    impl GlobalDispatch<server_output::WlOutput, (&'static str, u32)> for Server {
        fn bind(
            _: &mut Self,
            _: &DisplayHandle,
            _: &Client,
            resource: New<server_output::WlOutput>,
            (name, instance): &(&'static str, u32),
            init: &mut DataInit<'_, Self>,
        ) {
            let o = init.init(resource, *instance);
            o.name(name.to_string());
            o.scale(2);
            o.done();
        }
    }
    impl wayland_server::Dispatch<server_output::WlOutput, u32> for Server {
        fn request(
            s: &mut Self,
            _: &Client,
            _: &server_output::WlOutput,
            request: server_output::Request,
            instance: &u32,
            _: &DisplayHandle,
            _: &mut DataInit<'_, Self>,
        ) {
            if let server_output::Request::Release = request {
                s.released.lock().unwrap().push(*instance);
            }
        }
    }
    struct Data(Arc<std::sync::atomic::AtomicUsize>);
    impl ClientData for Data {
        fn disconnected(
            &self,
            _: wayland_server::backend::ClientId,
            _: wayland_server::backend::DisconnectReason,
        ) {
            self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
    enum Do {
        Add(&'static str),
        /// Remove the n-th output still present, oldest first.
        Remove(usize),
        /// Another client (a dock's connection).
        Connect(UnixStream),
        /// Stop answering for a while (after replying).
        Freeze(Duration),
        Stop,
    }
    /// A compositor on its own thread; each command is applied before the reply.
    type Released = Arc<Mutex<Vec<u32>>>;
    struct Mock {
        tx: mpsc::Sender<Do>,
        done: mpsc::Receiver<()>,
        released: Released,
        disconnects: Arc<std::sync::atomic::AtomicUsize>,
    }
    impl Mock {
        fn run(&self, what: Do) {
            self.tx.send(what).unwrap();
            self.done.recv().unwrap();
        }
        /// A connection to nothing, for calls that must refuse before using it.
        fn connection_or_none(&self) -> Connection {
            let (ours, _) = UnixStream::pair().unwrap();
            Connection::from_socket(ours).unwrap()
        }
        fn connection(&self) -> Connection {
            let (ours, theirs) = UnixStream::pair().unwrap();
            self.run(Do::Connect(theirs));
            Connection::from_socket(ours).unwrap()
        }
    }
    fn mock(outputs: &[&'static str]) -> (OutputWatch, Mock) {
        let (watch, tx, done, released, disconnects) = server_with(outputs);
        (
            watch,
            Mock {
                tx,
                done,
                released,
                disconnects,
            },
        )
    }
    fn server(
        outputs: &[&'static str],
    ) -> (OutputWatch, mpsc::Sender<Do>, mpsc::Receiver<()>, Released) {
        let (watch, tx, done, released, _) = server_with(outputs);
        (watch, tx, done, released)
    }
    #[allow(clippy::type_complexity)]
    fn server_with(
        outputs: &[&'static str],
    ) -> (
        OutputWatch,
        mpsc::Sender<Do>,
        mpsc::Receiver<()>,
        Released,
        Arc<std::sync::atomic::AtomicUsize>,
    ) {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let (tx, rx) = mpsc::channel::<Do>();
        let (done_tx, done_rx) = mpsc::channel();
        let initial = outputs.to_vec();
        let released = Released::default();
        let disconnects = Arc::<std::sync::atomic::AtomicUsize>::default();
        let counted = disconnects.clone();
        let mut state = Server {
            released: released.clone(),
        };
        std::thread::spawn(move || {
            let mut display = Display::<Server>::new().unwrap();
            let mut dh = display.handle();
            let mut instance = 0;
            let mut create = |dh: &mut DisplayHandle, n| {
                instance += 1;
                dh.create_global::<Server, server_output::WlOutput, _>(4, (n, instance))
            };
            let mut globals: Vec<GlobalId> =
                initial.into_iter().map(|n| create(&mut dh, n)).collect();
            dh.insert_client(theirs, Arc::new(Data(counted.clone())))
                .unwrap();
            loop {
                display.dispatch_clients(&mut state).unwrap();
                display.flush_clients().unwrap();
                match rx.try_recv() {
                    Ok(Do::Add(n)) => globals.push(create(&mut dh, n)),
                    Ok(Do::Remove(at)) => dh.remove_global::<Server>(globals.remove(at)),
                    Ok(Do::Connect(socket)) => {
                        dh.insert_client(socket, Arc::new(Data(counted.clone())))
                            .unwrap();
                    }
                    Ok(Do::Freeze(time)) => {
                        done_tx.send(()).unwrap();
                        std::thread::sleep(time);
                        continue;
                    }
                    Ok(Do::Stop) | Err(mpsc::TryRecvError::Disconnected) => return,
                    Err(mpsc::TryRecvError::Empty) => {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                }
                display.flush_clients().unwrap();
                done_tx.send(()).unwrap();
            }
        });
        let watch = watch(
            Connection::from_socket(ours).unwrap(),
            Duration::from_secs(5),
        )
        .unwrap();
        (watch, tx, done_rx, released, disconnects)
    }
    fn added(e: &OutputEvent) -> &OutputInfo {
        match e {
            OutputEvent::Added(i) => i,
            e => panic!("expected Added, got {e:?}"),
        }
    }
    const WAIT: Option<Duration> = Some(Duration::from_secs(5));
    fn soon() -> std::time::Instant {
        std::time::Instant::now() + Duration::from_secs(5)
    }

    #[test]
    fn initial_outputs_are_added_complete() {
        let (mut w, _tx, _done, _) = server(&["DP-1", "HDMI-A-1"]);
        let first = w.next(WAIT).unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(added(&first[0]).name, "DP-1");
        assert_eq!(added(&first[0]).scale, 2);
        assert_eq!(added(&first[1]).name, "HDMI-A-1");
        assert_eq!(w.current().len(), 2);
    }
    /// The server reuses a freed global slot: a same-name output plugged back in gets
    /// the SAME number, but never the same OutputId.
    #[test]
    fn re_added_output_reuses_the_number_but_never_the_identity() {
        let (mut w, m) = mock(&["DP-1"]);
        let old = added(&w.next(WAIT).unwrap()[0]).id;
        m.run(Do::Remove(0));
        m.run(Do::Add("DP-1"));
        let mut events = Vec::new();
        while events.len() < 2 {
            events.extend(w.next(WAIT).unwrap());
        }
        assert_eq!(events[0], OutputEvent::Removed(old));
        let new = added(&events[1]).clone();
        assert_eq!((new.id.global(), new.name.as_str()), (old.global(), "DP-1"));
        assert_ne!(new.id, old);
    }
    /// The race the two syncs close: the output is removed and re-added with the same
    /// number after the dock's connection bound it. The bind is refused, and the watcher
    /// still reports what happened.
    #[test]
    fn bind_output_refuses_an_instance_replaced_during_the_bind() {
        let (mut w, m) = mock(&["DP-1"]);
        let old = added(&w.next(WAIT).unwrap()[0]).id;
        let dock = m.connection();
        let got = w.bind_output_with(dock, old, soon(), || {
            m.run(Do::Remove(0));
            m.run(Do::Add("DP-1"));
        });
        assert_eq!(
            got.err(),
            Some(BindFailure::Gone),
            "bound the newer output that reused the number"
        );
        let events = w.next(WAIT).unwrap();
        assert_eq!(events[0], OutputEvent::Removed(old));
        let new = added(&events[1]).id;
        assert_eq!(new.global(), old.global());
        // The new instance binds, and it is the server's instance 2.
        let fresh = w
            .bind_output_with(m.connection(), new, soon(), || {})
            .unwrap();
        assert_eq!(fresh.id(), new);
        fresh.proxy.release();
        fresh.connection.roundtrip().unwrap();
        assert!(m.released.lock().unwrap().contains(&2));
    }
    /// A removed id is not bound at all.
    #[test]
    fn bind_output_of_a_removed_id_is_none() {
        let (mut w, m) = mock(&["DP-1"]);
        let old = added(&w.next(WAIT).unwrap()[0]).id;
        m.run(Do::Remove(0));
        assert_eq!(w.next(WAIT).unwrap(), vec![OutputEvent::Removed(old)]);
        assert_eq!(
            w.bind_output_with(m.connection(), old, soon(), || {}).err(),
            Some(BindFailure::Gone)
        );
    }
    /// A compositor that stops answering fails the bind at its deadline; nothing the
    /// watcher read is lost, and a later bind works.
    #[test]
    fn bind_output_gives_up_at_its_deadline() {
        let (mut w, m) = mock(&["DP-1"]);
        let id = added(&w.next(WAIT).unwrap()[0]).id;
        let dock = m.connection();
        m.run(Do::Freeze(Duration::from_millis(500)));
        let started = std::time::Instant::now();
        let got = w.bind_output_with(dock, id, started + Duration::from_millis(100), || {});
        assert_eq!(got.err(), Some(BindFailure::Timeout));
        assert!(started.elapsed() < Duration::from_millis(400));
        m.run(Do::Add("HDMI-A-1"));
        assert_eq!(added(&w.next(WAIT).unwrap()[0]).name, "HDMI-A-1");
        assert!(
            w.bind_output_with(m.connection(), id, soon(), || {})
                .is_ok()
        );
    }
    /// The watcher's connection dies during a bind: the bind says Lost, and next()
    /// still reports Lost once, after the events read before it.
    #[test]
    fn losing_the_compositor_during_a_bind_is_reported_once() {
        let (mut w, m) = mock(&["DP-1"]);
        let id = added(&w.next(WAIT).unwrap()[0]).id;
        let got = w.bind_output_with(m.connection(), id, soon(), || {
            m.run(Do::Remove(0));
            m.tx.send(Do::Stop).unwrap();
        });
        assert_eq!(got.err(), Some(BindFailure::Lost));
        let events = w.next(WAIT).unwrap();
        assert!(
            matches!(events.last(), Some(OutputEvent::Lost(_))),
            "{events:?}"
        );
        assert!(w.next(WAIT).is_err());
        assert_eq!(
            w.bind_output_with(m.connection_or_none(), id, soon(), || {})
                .err(),
            Some(BindFailure::Lost)
        );
    }
    /// Every dock connection ends with its LayerOutput: nothing piles up across docks.
    #[test]
    fn dock_connections_close_when_dropped() {
        let (mut w, m) = mock(&["DP-1"]);
        let id = added(&w.next(WAIT).unwrap()[0]).id;
        for _ in 0..100 {
            let output = w
                .bind_output_with(m.connection(), id, soon(), || {})
                .unwrap();
            drop(output);
        }
        let end = std::time::Instant::now() + Duration::from_secs(5);
        let closed = || m.disconnects.load(std::sync::atomic::Ordering::SeqCst);
        while closed() < 100 && std::time::Instant::now() < end {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(closed(), 100);
    }
    #[test]
    fn a_silent_compositor_fails_the_watch_in_time() {
        let (ours, _silent) = UnixStream::pair().unwrap();
        let started = std::time::Instant::now();
        let r = watch(
            Connection::from_socket(ours).unwrap(),
            Duration::from_millis(100),
        );
        assert!(r.is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }
    #[test]
    fn ordinary_hotplug() {
        let (mut w, tx, done, _) = server(&["DP-1"]);
        let dp = added(&w.next(WAIT).unwrap()[0]).id;
        tx.send(Do::Add("HDMI-A-1")).unwrap();
        done.recv().unwrap();
        let hdmi = added(&w.next(WAIT).unwrap()[0]).id;
        assert_ne!(dp, hdmi);
        assert_eq!(w.current().len(), 2);
        tx.send(Do::Remove(1)).unwrap();
        done.recv().unwrap();
        assert_eq!(w.next(WAIT).unwrap(), vec![OutputEvent::Removed(hdmi)]);
        assert_eq!(
            w.current().iter().map(|o| o.id).collect::<Vec<_>>(),
            vec![dp]
        );
    }
    #[test]
    fn losing_the_compositor_is_reported_once() {
        let (mut w, tx, _done, _) = server(&["DP-1"]);
        w.next(WAIT).unwrap();
        tx.send(Do::Stop).unwrap();
        let events = w.next(WAIT).unwrap();
        assert!(
            matches!(events.as_slice(), [OutputEvent::Lost(_)]),
            "{events:?}"
        );
        assert!(w.next(WAIT).is_err());
    }
}
