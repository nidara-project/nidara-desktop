// SPDX-License-Identifier: LGPL-3.0-or-later
//! Which outputs exist, on a small connection of its own (SHELL-SURFACES.md §2). The
//! shell starts one `run_layer` per output it reports, naming it by `OutputId`.
use crate::{OutputId, Result, err};
use std::time::Duration;
use wayland_client::{
    Connection, Dispatch, EventQueue, Proxy, QueueHandle,
    protocol::{wl_output, wl_registry},
};
use wayland_protocols::xdg::xdg_output::zv1::client::{zxdg_output_manager_v1, zxdg_output_v1};

#[derive(Clone, Debug, Default, PartialEq)]
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
}

/// Connect and report the outputs present now as `Added`.
pub fn outputs() -> Result<OutputWatch> {
    watch(Connection::connect_to_env().map_err(err)?)
}
fn watch(connection: Connection) -> Result<OutputWatch> {
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
    for _ in 0..3 {
        queue.roundtrip(&mut state).map_err(err)?;
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
    })
}

impl OutputWatch {
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
                return Ok(vec![OutputEvent::Lost(e)]);
            }
        }
        Ok(std::mem::take(&mut self.state.events))
    }
    fn wait(&mut self, timeout: Option<Duration>) -> Result<()> {
        self.queue.dispatch_pending(&mut self.state).map_err(err)?;
        if !self.state.events.is_empty() {
            return Ok(());
        }
        self.connection.flush().map_err(err)?;
        let Some(guard) = self.queue.prepare_read() else {
            return self
                .queue
                .dispatch_pending(&mut self.state)
                .map(|_| ())
                .map_err(err);
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
        self.queue.dispatch_pending(&mut self.state).map_err(err)?;
        Ok(())
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
                            id: OutputId(name),
                            scale: 1,
                            ..Default::default()
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
                if let Some(at) = s.entries.iter().position(|e| e.info.id == OutputId(name)) {
                    let e = s.entries.remove(at);
                    if let Some(x) = e.xdg {
                        x.destroy();
                    }
                    if e.proxy.version() >= 3 {
                        e.proxy.release();
                    }
                    if e.announced {
                        s.events.push(OutputEvent::Removed(OutputId(name)));
                    }
                }
            }
            _ => {}
        }
    }
}
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
        let Some(at) = s
            .entries
            .iter()
            .position(|e| e.info.id == OutputId(*global))
        else {
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
    use std::sync::{Arc, mpsc};
    use wayland_server::{
        Client, DataInit, Display, DisplayHandle, GlobalDispatch, New,
        backend::{ClientData, GlobalId},
        protocol::wl_output as server_output,
    };
    struct Server;
    impl GlobalDispatch<server_output::WlOutput, &'static str> for Server {
        fn bind(
            _: &mut Self,
            _: &DisplayHandle,
            _: &Client,
            resource: New<server_output::WlOutput>,
            name: &&'static str,
            init: &mut DataInit<'_, Self>,
        ) {
            let o = init.init(resource, ());
            o.name(name.to_string());
            o.scale(2);
            o.done();
        }
    }
    impl wayland_server::Dispatch<server_output::WlOutput, ()> for Server {
        fn request(
            _: &mut Self,
            _: &Client,
            _: &server_output::WlOutput,
            _: server_output::Request,
            _: &(),
            _: &DisplayHandle,
            _: &mut DataInit<'_, Self>,
        ) {
        }
    }
    struct Data;
    impl ClientData for Data {}
    enum Do {
        Add(&'static str),
        /// Remove the n-th output still present, oldest first.
        Remove(usize),
        Stop,
    }
    /// A compositor on its own thread; each command is applied before the reply.
    fn server(outputs: &[&'static str]) -> (OutputWatch, mpsc::Sender<Do>, mpsc::Receiver<()>) {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let (tx, rx) = mpsc::channel::<Do>();
        let (done_tx, done_rx) = mpsc::channel();
        let initial = outputs.to_vec();
        std::thread::spawn(move || {
            let mut display = Display::<Server>::new().unwrap();
            let mut dh = display.handle();
            let mut globals: Vec<GlobalId> = initial
                .into_iter()
                .map(|n| dh.create_global::<Server, server_output::WlOutput, _>(4, n))
                .collect();
            dh.insert_client(theirs, Arc::new(Data)).unwrap();
            loop {
                display.dispatch_clients(&mut Server).unwrap();
                display.flush_clients().unwrap();
                match rx.try_recv() {
                    Ok(Do::Add(n)) => {
                        globals.push(dh.create_global::<Server, server_output::WlOutput, _>(4, n))
                    }
                    Ok(Do::Remove(at)) => dh.remove_global::<Server>(globals.remove(at)),
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
        let watch = watch(Connection::from_socket(ours).unwrap()).unwrap();
        (watch, tx, done_rx)
    }
    fn added(e: &OutputEvent) -> &OutputInfo {
        match e {
            OutputEvent::Added(i) => i,
            e => panic!("expected Added, got {e:?}"),
        }
    }
    const WAIT: Option<Duration> = Some(Duration::from_secs(5));

    #[test]
    fn initial_outputs_are_added_complete() {
        let (mut w, _tx, _done) = server(&["DP-1", "HDMI-A-1"]);
        let first = w.next(WAIT).unwrap();
        assert_eq!(first.len(), 2);
        assert_eq!(added(&first[0]).name, "DP-1");
        assert_eq!(added(&first[0]).scale, 2);
        assert_eq!(added(&first[1]).name, "HDMI-A-1");
        assert_eq!(w.current().len(), 2);
    }
    /// The server reuses a freed global slot: a same-name output plugged back in gets
    /// the SAME number. Identity therefore rests on event order, not on the number.
    #[test]
    fn re_added_output_can_reuse_the_number_but_removal_comes_first() {
        let (mut w, tx, done) = server(&["DP-1"]);
        let id = added(&w.next(WAIT).unwrap()[0]).id;
        tx.send(Do::Remove(0)).unwrap();
        done.recv().unwrap();
        tx.send(Do::Add("DP-1")).unwrap();
        done.recv().unwrap();
        let mut events = Vec::new();
        while events.len() < 2 {
            events.extend(w.next(WAIT).unwrap());
        }
        assert_eq!(events[0], OutputEvent::Removed(id));
        let back = added(&events[1]);
        assert_eq!((back.id, back.name.as_str()), (id, "DP-1"));
    }
    #[test]
    fn ordinary_hotplug() {
        let (mut w, tx, done) = server(&["DP-1"]);
        let dp = added(&w.next(WAIT).unwrap()[0]).id;
        tx.send(Do::Add("HDMI-A-1")).unwrap();
        done.recv().unwrap();
        let hdmi = added(&w.next(WAIT).unwrap()[0]).id;
        assert_ne!(dp, hdmi);
        assert_eq!(w.current().len(), 2);
        tx.send(Do::Remove(1)).unwrap();
        done.recv().unwrap();
        assert_eq!(w.next(WAIT).unwrap(), vec![OutputEvent::Removed(hdmi)]);
        assert_eq!(w.current().iter().map(|o| o.id).collect::<Vec<_>>(), vec![dp]);
    }
    #[test]
    fn losing_the_compositor_is_reported_once() {
        let (mut w, tx, _done) = server(&["DP-1"]);
        w.next(WAIT).unwrap();
        tx.send(Do::Stop).unwrap();
        let events = w.next(WAIT).unwrap();
        assert!(matches!(events.as_slice(), [OutputEvent::Lost(_)]), "{events:?}");
        assert!(w.next(WAIT).is_err());
    }
}
