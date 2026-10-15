// SPDX-License-Identifier: LGPL-3.0-or-later
//! One thread owns the connection, input and buffers. All sizes and input are
//! logical pixels; only Frame's buffer dimensions are physical pixels.
mod ime;
mod keyboard;
mod protocol;
pub use ime::{ImeBatch, TextInput};
pub use keyboard::Key;
use keyboard::Keyboard;
use memmap2::MmapMut;
use protocol::material::{nidara_material_manager_v1, nidara_material_v1};
use std::{
    fs::File,
    io::{Read, Write},
    os::{fd::AsFd, unix::fs::FileExt},
    time::Instant,
};
use wayland_client::{
    Connection, Dispatch, Proxy, QueueHandle, WEnum, delegate_noop,
    protocol::{
        wl_buffer, wl_callback, wl_compositor, wl_data_device, wl_data_device_manager,
        wl_data_offer, wl_data_source, wl_keyboard, wl_pointer, wl_registry, wl_seat, wl_shm,
        wl_surface,
    },
};
use wayland_protocols::{
    wp::{
        fractional_scale::v1::client::{wp_fractional_scale_manager_v1, wp_fractional_scale_v1},
        presentation_time::client::{wp_presentation, wp_presentation_feedback},
        text_input::zv3::client::{zwp_text_input_manager_v3, zwp_text_input_v3},
        viewporter::client::{wp_viewport, wp_viewporter},
    },
    xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base},
};
pub type Result<T> = std::result::Result<T, String>;
const MIME: &str = "text/plain;charset=utf-8";
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub pixel_width: u16,
    pub pixel_height: u16,
    pub scale: f64,
}
#[derive(Clone, Debug)]
pub enum Event {
    Configure,
    FrameDone,
    Focus(bool),
    Key(Key),
    Motion(f64, f64),
    Button { button: u32, pressed: bool },
    Scroll(f64),
    Ime(ImeBatch),
    Paste(String),
    Presented { seconds: u64, nanoseconds: u32 },
    Error(String),
}
/// App callbacks run on the connection's thread; no callbacks survive run().
pub trait Application {
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()>;
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>>;
    fn panes(&self) -> Vec<Pane>;
}
#[derive(Clone, Copy, Debug)]
pub struct Pane {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
}
struct Buffer {
    proxy: wl_buffer::WlBuffer,
    map: MmapMut,
    width: u16,
    height: u16,
    busy: bool,
}
struct Offer {
    proxy: wl_data_offer::WlDataOffer,
    utf8: bool,
    plain: bool,
}
struct Transfer {
    file: File,
    bytes: Vec<u8>,
}
struct Send {
    file: File,
    bytes: Vec<u8>,
    written: usize,
}
/// Small phase-0 window host, not a general widget library.
pub struct Window {
    globals: Vec<(u32, String, u32)>,
    surface: Option<wl_surface::WlSurface>,
    xdg: Option<xdg_surface::XdgSurface>,
    toplevel: Option<xdg_toplevel::XdgToplevel>,
    shm: Option<wl_shm::WlShm>,
    seat: Option<wl_seat::WlSeat>,
    keyboard_proxy: Option<wl_keyboard::WlKeyboard>,
    pointer: Option<wl_pointer::WlPointer>,
    text_manager: Option<zwp_text_input_manager_v3::ZwpTextInputManagerV3>,
    text: Option<zwp_text_input_v3::ZwpTextInputV3>,
    material: Option<nidara_material_v1::NidaraMaterialV1>,
    viewport: Option<wp_viewport::WpViewport>,
    presentation: Option<wp_presentation::WpPresentation>,
    data_manager: Option<wl_data_device_manager::WlDataDeviceManager>,
    data: Option<wl_data_device::WlDataDevice>,
    offers: Vec<Offer>,
    selection: Option<wl_data_offer::WlDataOffer>,
    sources: Vec<(wl_data_source::WlDataSource, String)>,
    receive: Option<Transfer>,
    sends: Vec<Send>,
    buffers: Vec<Buffer>,
    events: Vec<Event>,
    keyboard: Keyboard,
    qh: QueueHandle<Self>,
    width: u32,
    height: u32,
    pending_size: Option<(u32, u32)>,
    scale: u32,
    configured: bool,
    dirty: bool,
    frame_pending: bool,
    closed: bool,
    serial: u32,
    ime_serial: u32,
    ime_entered: bool,
    ime_enabled: bool,
    ime_sync: bool,
    input: TextInput,
    sent_input: Option<TextInput>,
    ime_pending: ImeBatch,
    skip_material: bool,
}
impl Window {
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }
    pub fn redraw(&mut self) {
        self.dirty = true;
    }
    pub fn set_text_input(&mut self, input: TextInput) {
        self.input = input;
        self.sync_ime();
    }
    fn sync_ime(&mut self) {
        let Some(t) = self.text.as_ref() else { return };
        // enable resets the compositor's previous surrounding context. Switching
        // purpose must do that too; merely omitting a password's text would
        // otherwise leave the preceding normal field's context at the IME.
        if self.ime_enabled
            && self
                .sent_input
                .as_ref()
                .is_some_and(|old| old.password != self.input.password)
        {
            t.disable();
            t.commit();
            self.ime_serial = self.ime_serial.wrapping_add(1);
            self.ime_enabled = false;
        }
        let enabled = self.ime_entered && self.input.focused;
        if enabled != self.ime_enabled {
            if enabled {
                t.enable();
            } else {
                t.disable();
            }
            self.ime_enabled = enabled;
            self.sent_input = None;
            self.ime_pending = ImeBatch::default();
            self.ime_sync = true;
            if !enabled {
                t.commit();
                self.ime_serial = self.ime_serial.wrapping_add(1);
                return;
            }
        }
        if !enabled || !self.ime_sync || self.sent_input.as_ref() == Some(&self.input) {
            return;
        }
        use zwp_text_input_v3::{ChangeCause, ContentHint, ContentPurpose};
        t.set_content_type(
            if self.input.password {
                ContentHint::HiddenText | ContentHint::SensitiveData
            } else {
                ContentHint::None
            },
            if self.input.password {
                ContentPurpose::Password
            } else {
                ContentPurpose::Normal
            },
        );
        if let Some((text, c, a)) = ime::surrounding(&self.input) {
            t.set_surrounding_text(text, c, a);
        } else if !self.input.password {
            t.set_surrounding_text(String::new(), 0, 0);
        }
        t.set_text_change_cause(ChangeCause::Other);
        let [x, y, w, h] = self.input.rect;
        t.set_cursor_rectangle(x, y, w.max(1), h.max(1));
        t.commit();
        self.ime_serial = self.ime_serial.wrapping_add(1);
        self.sent_input = Some(self.input.clone());
    }
    /// Reset the IME's composition after a local pointer/caret edit.
    pub fn reset_ime(&mut self) {
        if self.ime_enabled
            && let Some(t) = &self.text
        {
            t.disable();
            t.commit();
            self.ime_serial = self.ime_serial.wrapping_add(1);
            self.ime_enabled = false;
        }
        self.sent_input = None;
        self.ime_pending = ImeBatch::default();
        self.sync_ime();
    }
    pub fn copy(&mut self, text: String) {
        let (Some(m), Some(d)) = (&self.data_manager, &self.data) else {
            return;
        };
        let source = m.create_data_source(&self.qh, ());
        source.offer(MIME.into());
        source.offer("text/plain".into());
        d.set_selection(Some(&source), self.serial);
        self.sources.push((source, text));
    }
    pub fn paste(&mut self) -> Result<()> {
        let Some(selection) = self.selection.as_ref() else {
            return Ok(());
        };
        let Some(offer) = self.offers.iter().find(|o| o.proxy == *selection) else {
            return Ok(());
        };
        let mime = if offer.utf8 {
            MIME
        } else if offer.plain {
            "text/plain"
        } else {
            return Ok(());
        };
        let (read, write) = rustix::pipe::pipe().map_err(err)?;
        rustix::fs::fcntl_setfl(&read, rustix::fs::OFlags::NONBLOCK).map_err(err)?;
        selection.receive(mime.into(), write.as_fd());
        drop(write);
        self.receive = Some(Transfer {
            file: read.into(),
            bytes: Vec::new(),
        });
        Ok(())
    }
    fn transfers(&mut self) -> Result<()> {
        if let Some(t) = &mut self.receive {
            let mut buf = [0; 8192];
            loop {
                match t.file.read(&mut buf) {
                    Ok(0) => {
                        let t = self.receive.take().unwrap();
                        self.events
                            .push(Event::Paste(String::from_utf8(t.bytes).map_err(err)?));
                        break;
                    }
                    Ok(n) => {
                        t.bytes.extend_from_slice(&buf[..n]);
                        if t.bytes.len() > 16 * 1024 * 1024 {
                            self.receive = None;
                            return Err("clipboard exceeds 16 MiB".into());
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(e) => return Err(err(e)),
                }
            }
        }
        self.sends.retain_mut(|s| {
            loop {
                match s.file.write(&s.bytes[s.written..]) {
                    Ok(0) => return false,
                    Ok(n) => {
                        s.written += n;
                        if s.written == s.bytes.len() {
                            return false;
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return true,
                    Err(_) => return false,
                }
            }
        });
        Ok(())
    }
    fn frame(&self) -> Result<Frame> {
        let scale = self.scale as f64 / 120.;
        let pw = (self.width as f64 * scale).ceil();
        let ph = (self.height as f64 * scale).ceil();
        if pw > 8192. || ph > 8192. || pw * ph > 32_000_000. {
            return Err("configured buffer exceeds phase-0 limit".into());
        }
        Ok(Frame {
            width: self.width,
            height: self.height,
            pixel_width: pw as u16,
            pixel_height: ph as u16,
            scale,
        })
    }
    fn paint(&mut self, app: &mut impl Application) -> Result<()> {
        if !self.configured || !self.dirty || self.frame_pending {
            return Ok(());
        }
        let frame = self.frame()?;
        // Old busy buffers survive a resize until release. Never write into a
        // buffer the compositor still owns, including during configure storms.
        self.buffers.retain(|b| {
            let keep = b.busy || (b.width == frame.pixel_width && b.height == frame.pixel_height);
            if !keep {
                b.proxy.destroy();
            }
            keep
        });
        let slot = self.buffers.iter().position(|b| !b.busy);
        let slot = if let Some(i) = slot {
            i
        } else if self.buffers.len() < 2 {
            self.buffers.push(self.new_buffer(frame)?);
            self.buffers.len() - 1
        } else {
            return Ok(());
        };
        let bytes = app.paint(frame)?;
        let b = &mut self.buffers[slot];
        if b.map.len() != bytes.len() {
            return Err("renderer returned a buffer of the wrong length".into());
        }
        b.map.copy_from_slice(&bytes);
        b.busy = true;
        let surface = self.surface.as_ref().unwrap();
        if let Some(v) = &self.viewport {
            v.set_destination(self.width as i32, self.height as i32);
        }
        surface.set_buffer_scale(1);
        if let Some(m) = &self.material {
            m.clear_shapes();
            if !self.skip_material {
                // Measured panel material: glass-material.ts TONES.panel.dark.
                m.set_glass(0., 0., 0., 0., 0., 0., 40., 0.5, 0.);
                m.set_lensing(0.);
                m.set_tone(1.3, 0.35, 0.125, 1.125, 0., 0., 0., 0., 0.8, 0.125, 0.5);
                m.set_shadow(0.013, 0.175, 2., 17., 8.);
                for p in app.panes() {
                    m.add_shape(p.x, p.y, p.width, p.height, p.radius, 2.);
                }
            }
        }
        surface.attach(Some(&b.proxy), 0, 0);
        surface.damage_buffer(0, 0, frame.pixel_width as i32, frame.pixel_height as i32);
        surface.frame(&self.qh, ());
        self.frame_pending = true;
        if let Some(p) = &self.presentation {
            p.feedback(surface, &self.qh, ());
        }
        surface.commit();
        self.dirty = false;
        Ok(())
    }
    fn new_buffer(&self, frame: Frame) -> Result<Buffer> {
        let size = frame.pixel_width as usize * frame.pixel_height as usize * 4;
        let fd =
            rustix::fs::memfd_create("nk-frame", rustix::fs::MemfdFlags::CLOEXEC).map_err(err)?;
        let file = File::from(fd);
        file.set_len(size as u64).map_err(err)?;
        // SAFETY: private memfd, fixed size for this buffer's lifetime. This
        // mapping is written only after wl_buffer.release (busy=false).
        let map = unsafe { MmapMut::map_mut(&file) }.map_err(err)?;
        let pool = self
            .shm
            .as_ref()
            .unwrap()
            .create_pool(file.as_fd(), size as i32, &self.qh, ());
        let proxy = pool.create_buffer(
            0,
            frame.pixel_width as i32,
            frame.pixel_height as i32,
            frame.pixel_width as i32 * 4,
            wl_shm::Format::Argb8888,
            &self.qh,
            (),
        );
        pool.destroy();
        Ok(Buffer {
            proxy,
            map,
            width: frame.pixel_width,
            height: frame.pixel_height,
            busy: false,
        })
    }
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Clone, Copy)]
pub struct Options {
    pub material: bool,
    pub map: bool,
}
pub fn run(mut app: impl Application, options: Options, start: Instant) -> Result<()> {
    let conn = Connection::connect_to_env().map_err(err)?;
    let mut queue = conn.new_event_queue::<Window>();
    let qh = queue.handle();
    let registry = conn.display().get_registry(&qh, ());
    let mut w = Window {
        globals: Vec::new(),
        surface: None,
        xdg: None,
        toplevel: None,
        shm: None,
        seat: None,
        keyboard_proxy: None,
        pointer: None,
        text_manager: None,
        text: None,
        material: None,
        viewport: None,
        presentation: None,
        data_manager: None,
        data: None,
        offers: Vec::new(),
        selection: None,
        sources: Vec::new(),
        receive: None,
        sends: Vec::new(),
        buffers: Vec::new(),
        events: Vec::new(),
        keyboard: Keyboard::new(),
        qh: qh.clone(),
        width: 960,
        height: 720,
        pending_size: None,
        scale: 120,
        configured: false,
        dirty: true,
        frame_pending: false,
        closed: false,
        serial: 0,
        ime_serial: 0,
        ime_entered: false,
        ime_enabled: false,
        ime_sync: true,
        input: TextInput::default(),
        sent_input: None,
        ime_pending: ImeBatch::default(),
        skip_material: !options.material,
    };
    queue.roundtrip(&mut w).map_err(err)?;
    macro_rules! bind {
        ($ty:ty,$version:expr) => {{
            w.globals
                .iter()
                .find(|(_, name, _)| name == <$ty>::interface().name)
                .map(|(id, _, v)| registry.bind::<$ty, _, _>(*id, (*v).min($version), &qh, ()))
        }};
    }
    let compositor = bind!(wl_compositor::WlCompositor, 4).ok_or("missing wl_compositor")?;
    let base = bind!(xdg_wm_base::XdgWmBase, 1).ok_or("missing xdg-shell")?;
    let materials = bind!(nidara_material_manager_v1::NidaraMaterialManagerV1, 1)
        .ok_or("nk-phase0 needs Hyalo (nidara-material-v1)")?;
    let viewporter = bind!(wp_viewporter::WpViewporter, 1).ok_or("missing viewporter")?;
    let fraction = bind!(
        wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1,
        1
    )
    .ok_or("missing fractional-scale-v1")?;
    w.shm = bind!(wl_shm::WlShm, 1);
    if w.shm.is_none() {
        return Err("missing wl_shm".into());
    }
    w.seat = bind!(wl_seat::WlSeat, 7);
    w.text_manager = bind!(zwp_text_input_manager_v3::ZwpTextInputManagerV3, 1);
    w.data_manager = bind!(wl_data_device_manager::WlDataDeviceManager, 3);
    w.presentation = bind!(wp_presentation::WpPresentation, 1);
    let surface = compositor.create_surface(&qh, ());
    let xdg = base.get_xdg_surface(&surface, &qh, ());
    let top = xdg.get_toplevel(&qh, ());
    top.set_app_id("nk-phase0".into());
    top.set_title("Nidara toolkit — phase 0".into());
    top.set_min_size(400, 300);
    w.material = Some(materials.get_material(&surface, &qh, ()));
    w.viewport = Some(viewporter.get_viewport(&surface, &qh, ()));
    let _fraction = fraction.get_fractional_scale(&surface, &qh, ());
    w.surface = Some(surface);
    w.xdg = Some(xdg);
    w.toplevel = Some(top);
    // Seat and manager order in registry is unspecified.
    if let (Some(m), Some(s)) = (&w.text_manager, &w.seat) {
        w.text = Some(m.get_text_input(s, &qh, ()));
    }
    if let (Some(m), Some(s)) = (&w.data_manager, &w.seat) {
        w.data = Some(m.get_data_device(s, &qh, ()));
    }
    if options.map {
        w.surface.as_ref().unwrap().commit();
    }
    let mut first = true;
    let mut first_callback = true;
    while !w.closed {
        queue.dispatch_pending(&mut w).map_err(err)?;
        w.transfers()?;
        if let Some(k) = w.keyboard.tick() {
            w.events.push(Event::Key(k));
        }
        for event in std::mem::take(&mut w.events) {
            if let Event::Error(e) = event {
                return Err(e);
            }
            if first && let Event::Presented { .. } = event {
                let rss = std::fs::read_to_string("/proc/self/status")
                    .unwrap_or_default()
                    .lines()
                    .find(|s| s.starts_with("VmRSS:"))
                    .unwrap_or("")
                    .to_string();
                eprintln!(
                    "FIRST_FRAME_MS={:.3} {rss}",
                    start.elapsed().as_secs_f64() * 1000.
                );
                first = false;
            }
            if first_callback && matches!(event, Event::FrameDone) {
                let rss = std::fs::read_to_string("/proc/self/status")
                    .unwrap_or_default()
                    .lines()
                    .find(|s| s.starts_with("VmRSS:"))
                    .unwrap_or("")
                    .to_string();
                eprintln!(
                    "FIRST_FRAME_CALLBACK_MS={:.3} {rss}",
                    start.elapsed().as_secs_f64() * 1000.
                );
                first_callback = false;
            }
            app.event(event, &mut w)?;
        }
        w.paint(&mut app)?;
        conn.flush().map_err(err)?;
        if let Some(guard) = queue.prepare_read() {
            use rustix::event::{PollFd, PollFlags, Timespec, poll};
            let fd = guard.connection_fd();
            let mut fds = [PollFd::new(&fd, PollFlags::IN)];
            let ms = if w.keyboard.repeat.is_some() || w.receive.is_some() || !w.sends.is_empty() {
                8
            } else {
                1000
            };
            let timeout = Timespec {
                tv_sec: ms / 1000,
                tv_nsec: (ms % 1000) * 1_000_000,
            };
            match poll(&mut fds, Some(&timeout)) {
                Ok(_) if fds[0].revents().intersects(PollFlags::IN) => {
                    guard.read().map_err(err)?;
                }
                Ok(_) => {
                    drop(guard);
                }
                Err(e) if e == rustix::io::Errno::INTR => {
                    drop(guard);
                }
                Err(e) => return Err(err(e)),
            }
        }
    }
    Ok(())
}

impl Dispatch<wl_registry::WlRegistry, ()> for Window {
    fn event(
        w: &mut Self,
        _: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            w.globals.push((name, interface, version));
        }
    }
}
impl Dispatch<xdg_wm_base::XdgWmBase, ()> for Window {
    fn event(
        _: &mut Self,
        p: &xdg_wm_base::XdgWmBase,
        e: xdg_wm_base::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_wm_base::Event::Ping { serial } = e {
            p.pong(serial);
        }
    }
}
impl Dispatch<xdg_surface::XdgSurface, ()> for Window {
    fn event(
        w: &mut Self,
        p: &xdg_surface::XdgSurface,
        e: xdg_surface::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_surface::Event::Configure { serial } = e {
            p.ack_configure(serial);
            if let Some((x, y)) = w.pending_size.take() {
                w.width = x;
                w.height = y;
            }
            w.configured = true;
            w.dirty = true;
            w.events.push(Event::Configure);
        }
    }
}
impl Dispatch<xdg_toplevel::XdgToplevel, ()> for Window {
    fn event(
        w: &mut Self,
        _: &xdg_toplevel::XdgToplevel,
        e: xdg_toplevel::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            xdg_toplevel::Event::Configure { width, height, .. } => {
                w.pending_size = Some((
                    if width > 0 { width as u32 } else { w.width },
                    if height > 0 { height as u32 } else { w.height },
                ));
            }
            xdg_toplevel::Event::Close => w.closed = true,
            _ => {}
        }
    }
}
impl Dispatch<wl_buffer::WlBuffer, ()> for Window {
    fn event(
        w: &mut Self,
        p: &wl_buffer::WlBuffer,
        e: wl_buffer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_buffer::Event::Release = e
            && let Some(b) = w.buffers.iter_mut().find(|b| b.proxy == *p)
        {
            b.busy = false;
        }
    }
}
impl Dispatch<wl_callback::WlCallback, ()> for Window {
    fn event(
        w: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        w.frame_pending = false;
        w.events.push(Event::FrameDone);
    }
}
impl Dispatch<wp_fractional_scale_v1::WpFractionalScaleV1, ()> for Window {
    fn event(
        w: &mut Self,
        _: &wp_fractional_scale_v1::WpFractionalScaleV1,
        e: wp_fractional_scale_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wp_fractional_scale_v1::Event::PreferredScale { scale } = e {
            w.scale = scale.max(1);
            w.dirty = true;
            w.events.push(Event::Configure);
        }
    }
}
impl Dispatch<wp_presentation_feedback::WpPresentationFeedback, ()> for Window {
    fn event(
        w: &mut Self,
        _: &wp_presentation_feedback::WpPresentationFeedback,
        e: wp_presentation_feedback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wp_presentation_feedback::Event::Presented {
            tv_sec_hi,
            tv_sec_lo,
            tv_nsec,
            ..
        } = e
        {
            w.events.push(Event::Presented {
                seconds: ((tv_sec_hi as u64) << 32) | tv_sec_lo as u64,
                nanoseconds: tv_nsec,
            });
        }
    }
}
impl Dispatch<wl_seat::WlSeat, ()> for Window {
    fn event(
        w: &mut Self,
        p: &wl_seat::WlSeat,
        e: wl_seat::Event,
        _: &(),
        _: &Connection,
        q: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Capabilities {
            capabilities: WEnum::Value(c),
        } = e
        {
            if c.contains(wl_seat::Capability::Keyboard) {
                if w.keyboard_proxy.is_none() {
                    w.keyboard_proxy = Some(p.get_keyboard(q, ()));
                }
            } else if let Some(k) = w.keyboard_proxy.take() {
                k.release();
                w.keyboard.reset();
                w.events.push(Event::Focus(false));
            }
            if c.contains(wl_seat::Capability::Pointer) {
                if w.pointer.is_none() {
                    w.pointer = Some(p.get_pointer(q, ()));
                }
            } else if let Some(p) = w.pointer.take() {
                p.release();
            }
        }
    }
}
impl Dispatch<wl_keyboard::WlKeyboard, ()> for Window {
    fn event(
        w: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        e: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            wl_keyboard::Event::Keymap {
                format: WEnum::Value(wl_keyboard::KeymapFormat::XkbV1),
                fd,
                size,
            } => {
                // A compositor may send dup()s of the same keymap fd to many
                // clients. Positioned reads MUST leave its shared offset alone.
                let file = File::from(fd);
                let mut bytes = vec![0; size.min(16 * 1024 * 1024) as usize];
                let read = file.read_exact_at(&mut bytes, 0);
                let map = read
                    .ok()
                    .and_then(|_| String::from_utf8(bytes).ok())
                    .and_then(|s| {
                        xkbcommon::xkb::Keymap::new_from_string(
                            &w.keyboard.context,
                            s,
                            xkbcommon::xkb::KEYMAP_FORMAT_TEXT_V1,
                            xkbcommon::xkb::KEYMAP_COMPILE_NO_FLAGS,
                        )
                    });
                if let Some(m) = map {
                    w.keyboard.state = Some(xkbcommon::xkb::State::new(&m));
                    w.keyboard.reset();
                } else {
                    w.events.push(Event::Error("invalid XKB keymap".into()));
                }
            }
            wl_keyboard::Event::Enter { serial, .. } => {
                w.serial = serial;
                w.events.push(Event::Focus(true));
            }
            wl_keyboard::Event::Leave { .. } => {
                w.keyboard.reset();
                w.events.push(Event::Focus(false));
            }
            wl_keyboard::Event::Modifiers {
                mods_depressed,
                mods_latched,
                mods_locked,
                group,
                serial,
            } => {
                w.serial = serial;
                if let Some(s) = &mut w.keyboard.state {
                    s.update_mask(mods_depressed, mods_latched, mods_locked, 0, 0, group);
                }
                // Modifiers change the repeated symbol without ending the hold.
                w.keyboard.refresh_repeat();
            }
            wl_keyboard::Event::Key {
                serial, key, state, ..
            } => {
                w.serial = serial;
                if state == WEnum::Value(wl_keyboard::KeyState::Pressed) {
                    if let Some(k) = w.keyboard.press(key) {
                        w.events.push(Event::Key(k));
                    }
                } else if w
                    .keyboard
                    .repeat
                    .as_ref()
                    .is_some_and(|(c, _, _)| *c == key)
                {
                    w.keyboard.repeat = None;
                }
            }
            wl_keyboard::Event::RepeatInfo { rate, delay } => {
                w.keyboard.rate = rate;
                w.keyboard.delay = delay;
                if rate <= 0 {
                    w.keyboard.repeat = None;
                }
            }
            _ => {}
        }
    }
}
impl Dispatch<wl_pointer::WlPointer, ()> for Window {
    fn event(
        w: &mut Self,
        _p: &wl_pointer::WlPointer,
        e: wl_pointer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            wl_pointer::Event::Enter {
                serial,
                surface_x,
                surface_y,
                ..
            } => {
                w.serial = serial;
                w.events.push(Event::Motion(surface_x, surface_y));
            }
            wl_pointer::Event::Motion {
                surface_x,
                surface_y,
                ..
            } => w.events.push(Event::Motion(surface_x, surface_y)),
            wl_pointer::Event::Button {
                serial,
                button,
                state,
                ..
            } => {
                w.serial = serial;
                w.events.push(Event::Button {
                    button,
                    pressed: state == WEnum::Value(wl_pointer::ButtonState::Pressed),
                });
            }
            wl_pointer::Event::Axis {
                axis: WEnum::Value(wl_pointer::Axis::VerticalScroll),
                value,
                ..
            } => w.events.push(Event::Scroll(value)),
            _ => {}
        }
    }
}
impl Dispatch<zwp_text_input_v3::ZwpTextInputV3, ()> for Window {
    fn event(
        w: &mut Self,
        _: &zwp_text_input_v3::ZwpTextInputV3,
        e: zwp_text_input_v3::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        use zwp_text_input_v3::Event as E;
        match e {
            E::Enter { surface } if w.surface.as_ref() == Some(&surface) => {
                w.ime_entered = true;
                w.sync_ime();
            }
            E::Leave { .. } => {
                w.ime_entered = false;
                w.sync_ime();
                w.sent_input = None;
                w.ime_pending = ImeBatch::default();
                w.events.push(Event::Ime(ImeBatch::default()));
            }
            E::PreeditString {
                text,
                cursor_begin,
                cursor_end,
            } => w.ime_pending.preedit = Some((text.unwrap_or_default(), cursor_begin, cursor_end)),
            E::CommitString { text } => w.ime_pending.commit = text,
            E::DeleteSurroundingText {
                before_length,
                after_length,
            } => w.ime_pending.delete = Some((before_length, after_length)),
            E::Done { serial } => {
                let mut b = std::mem::take(&mut w.ime_pending);
                b.serial = serial;
                // Even a stale done applies edits. Only state requests wait for
                // the matching serial (text-input-v3's done contract).
                w.ime_sync = serial == w.ime_serial;
                w.events.push(Event::Ime(b));
            }
            _ => {}
        }
    }
}
impl Dispatch<wl_data_device::WlDataDevice, ()> for Window {
    fn event(
        w: &mut Self,
        _: &wl_data_device::WlDataDevice,
        e: wl_data_device::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            wl_data_device::Event::DataOffer { id } => w.offers.push(Offer {
                proxy: id,
                utf8: false,
                plain: false,
            }),
            wl_data_device::Event::Selection { id } => {
                w.selection = id;
                w.offers.retain(|o| {
                    let keep = Some(&o.proxy) == w.selection.as_ref();
                    if !keep {
                        o.proxy.destroy();
                    }
                    keep
                });
            }
            _ => {}
        }
    }
    wayland_client::event_created_child!(Window,wl_data_device::WlDataDevice,[0=>(wl_data_offer::WlDataOffer,())]);
}
impl Dispatch<wl_data_offer::WlDataOffer, ()> for Window {
    fn event(
        w: &mut Self,
        p: &wl_data_offer::WlDataOffer,
        e: wl_data_offer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_data_offer::Event::Offer { mime_type } = e
            && let Some(o) = w.offers.iter_mut().find(|o| o.proxy == *p)
        {
            if mime_type == MIME {
                o.utf8 = true;
            }
            if mime_type == "text/plain" {
                o.plain = true;
            }
        }
    }
}
impl Dispatch<wl_data_source::WlDataSource, ()> for Window {
    fn event(
        w: &mut Self,
        p: &wl_data_source::WlDataSource,
        e: wl_data_source::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            wl_data_source::Event::Send { mime_type, fd }
                if mime_type == MIME || mime_type == "text/plain" =>
            {
                if let Some((_, s)) = w.sources.iter().find(|(proxy, _)| proxy == p)
                    && rustix::fs::fcntl_setfl(&fd, rustix::fs::OFlags::NONBLOCK).is_ok()
                {
                    w.sends.push(Send {
                        file: fd.into(),
                        bytes: s.as_bytes().to_vec(),
                        written: 0,
                    });
                }
            }
            wl_data_source::Event::Cancelled => {
                w.sources.retain(|(proxy, _)| proxy != p);
                p.destroy();
            }
            _ => {}
        }
    }
}
delegate_noop!(Window: ignore wl_compositor::WlCompositor);
delegate_noop!(Window: ignore wl_surface::WlSurface);
delegate_noop!(Window: ignore wl_shm::WlShm);
delegate_noop!(Window: ignore wayland_client::protocol::wl_shm_pool::WlShmPool);
delegate_noop!(Window: ignore wp_viewporter::WpViewporter);
delegate_noop!(Window: ignore wp_viewport::WpViewport);
delegate_noop!(Window: ignore wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1);
delegate_noop!(Window: ignore wp_presentation::WpPresentation);
delegate_noop!(Window: ignore zwp_text_input_manager_v3::ZwpTextInputManagerV3);
delegate_noop!(Window: ignore nidara_material_manager_v1::NidaraMaterialManagerV1);
delegate_noop!(Window: ignore nidara_material_v1::NidaraMaterialV1);
delegate_noop!(Window: ignore wl_data_device_manager::WlDataDeviceManager);
