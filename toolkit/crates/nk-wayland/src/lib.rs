// SPDX-License-Identifier: LGPL-3.0-or-later
//! One thread owns the connection, input and buffers. All sizes and input are
//! logical pixels; only Frame's buffer dimensions are physical pixels.
mod activation;
pub use activation::Activation;
mod control_material;
pub use control_material::{ControlMaterial, InkCoverage, MaterialRect, Response, StateRegion};
mod controls;
pub use controls::{ControlsLayout, ControlsSide, WindowAction};
mod foreign;
mod ime;
mod keyboard;
pub use foreign::ForeignParent;
mod bounded_popup;
mod popup;
mod popup_overlay;
pub use bounded_popup::{MenuPopupPlacement, PopupSide};
pub use popup::{PopupPlacement, run_popup};
pub use popup_overlay::{PopupEvent, PopupId};
mod layer_shell;
pub use layer_shell::{Edges, KeyboardMode, LayerLevel, LayerPlacement, LayerSpec, OutputId};
mod layers;
pub use layers::{Curve, LayerEvent, LayerId, Property};
mod material;
mod protocol;
pub use ime::{ImeBatch, TextInput};
pub use keyboard::Key;
use keyboard::Keyboard;
pub use material::{
    Blur, Glass, GradedPane, Material, Pane, Shadow, Tone, WindowBackground, WindowLevel,
};
use material::{send_background, send_material};
use memmap2::MmapMut;
use protocol::layers::{nidara_layer_v1, nidara_layers_manager_v1};
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
        wl_data_offer, wl_data_source, wl_keyboard, wl_output, wl_pointer, wl_registry, wl_seat,
        wl_shm, wl_subcompositor, wl_subsurface, wl_surface,
    },
};
use wayland_protocols::{
    wp::{
        fractional_scale::v1::client::{wp_fractional_scale_manager_v1, wp_fractional_scale_v1},
        presentation_time::client::{wp_presentation, wp_presentation_feedback},
        text_input::zv3::client::{zwp_text_input_manager_v3, zwp_text_input_v3},
        viewporter::client::{wp_viewport, wp_viewporter},
    },
    xdg::shell::client::{xdg_popup, xdg_positioner, xdg_surface, xdg_toplevel, xdg_wm_base},
};
pub type Result<T> = std::result::Result<T, String>;
/// `run_layer`'s error when its output instance vanished before the surface existed.
pub const OUTPUT_GONE: &str = "layer output is gone";
const MIME: &str = "text/plain;charset=utf-8";
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub pixel_width: u16,
    pub pixel_height: u16,
    pub scale: f64,
    /// The compositor draws the window's background and glass (`nidara-material-v1`).
    /// Without it the app paints an opaque base itself (PHASE1.md D5).
    pub material: bool,
}
#[derive(Clone, Debug)]
pub enum Event {
    Configure,
    /// A layer root was closed by the compositor (its output went away). The run
    /// loop ends after the app has seen this; a new output gets a new surface.
    Closed,
    PopupDone,
    PopupOverlay {
        id: PopupId,
        event: PopupEvent,
    },
    PopupRepositioned(u32),
    /// Server consumed earlier requests on this connection; not presentation evidence.
    ProtocolBarrier(u32),
    ControlsLayout(ControlsLayout),
    Layer {
        id: LayerId,
        event: LayerEvent,
    },
    FrameDone,
    Focus(bool),
    Key(Key),
    Motion(f64, f64),
    PointerLeave,
    Button {
        button: u32,
        pressed: bool,
        /// wl_pointer serial and millisecond timestamp of this exact event.
        serial: u32,
        time: u32,
    },
    Scroll(f64),
    HorizontalScroll(f64),
    Ime(ImeBatch),
    Paste(String),
    /// Told every time, also when unchanged; a change also sends Configure.
    PreferredScale(f64),
    /// `commit` numbers the root surface's commits, the initial empty one being 1.
    Presented {
        commit: u64,
        seconds: u64,
        nanoseconds: u32,
    },
    Error(String),
}
/// App callbacks run on the connection's thread; no callbacks survive run().
pub trait Application {
    /// Request server control layout before the first configure (fallback if absent).
    fn window_controls(&self) -> bool {
        false
    }
    fn idle(&mut self, _window: &mut Window) -> Result<()> {
        Ok(())
    }
    fn poll_interval_ms(&self) -> u32 {
        1000
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()>;
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>>;
    fn material(&self) -> Option<Material>;
    /// The window's own background (D6), sent with every frame. Hyalo paints it.
    fn window_background(&self) -> Option<WindowBackground> {
        None
    }
    /// After a painted frame's root commit has been flushed to the compositor.
    fn committed(&mut self, _commit: u64) {}
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
    connection: Connection,
    foreign: foreign::Foreign,
    activation: Option<activation::xdg_activation_v1::XdgActivationV1>,
    controls: controls::Controls,
    maximized: bool,
    wm: Option<xdg_wm_base::XdgWmBase>,
    fractional_manager: Option<wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1>,
    materials: Option<nidara_material_manager_v1::NidaraMaterialManagerV1>,
    compositor: Option<wl_compositor::WlCompositor>,
    subcompositor: Option<wl_subcompositor::WlSubcompositor>,
    layers_manager: Option<nidara_layers_manager_v1::NidaraLayersManagerV1>,
    viewporter: Option<wp_viewporter::WpViewporter>,
    layers: Vec<layers::Layer>,
    pointer_layer: Option<LayerId>,
    pointer_popup: Option<PopupId>,
    overlay: Vec<popup_overlay::Overlay>,
    block_popup_release: bool,
    block_popup_repeat: bool,
    pointer_inside: bool,
    pointer_position: (f64, f64),
    ignore_input_before: Option<u32>,
    globals: Vec<(u32, String, u32)>,
    surface: Option<wl_surface::WlSurface>,
    xdg: Option<xdg_surface::XdgSurface>,
    toplevel: Option<xdg_toplevel::XdgToplevel>,
    layer_shell: Option<layer_shell::zwlr_layer_shell_v1::ZwlrLayerShellV1>,
    layer_surface: Option<layer_shell::zwlr_layer_surface_v1::ZwlrLayerSurfaceV1>,
    popup: Option<xdg_popup::XdgPopup>,
    positioner: Option<xdg_positioner::XdgPositioner>,
    shm: Option<wl_shm::WlShm>,
    seat: Option<wl_seat::WlSeat>,
    keyboard_proxy: Option<wl_keyboard::WlKeyboard>,
    pointer: Option<wl_pointer::WlPointer>,
    text_manager: Option<zwp_text_input_manager_v3::ZwpTextInputManagerV3>,
    text: Option<zwp_text_input_v3::ZwpTextInputV3>,
    material: Option<nidara_material_v1::NidaraMaterialV1>,
    viewport: Option<wp_viewport::WpViewport>,
    fractional: Option<wp_fractional_scale_v1::WpFractionalScaleV1>,
    /// Integer scale (without viewporter + fractional-scale): preferred_buffer_scale,
    /// else the largest scale of the outputs the surface is on.
    outputs: std::collections::HashMap<wayland_client::backend::ObjectId, i32>,
    entered: std::collections::HashSet<wayland_client::backend::ObjectId>,
    commits: u64,
    app_id: &'static str,
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
    popup_geometry: popup::Geometry,
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
    input_from_ime: bool,
    input: TextInput,
    sent_input: Option<TextInput>,
    ime_pending: ImeBatch,
    input_layer: Option<LayerId>,
    cursor_pending: bool,
    skip_material: bool,
    capabilities: Capabilities,
}
impl Window {
    /// Update the caller's translated title on an existing xdg toplevel.
    pub fn set_title(&mut self, title: &str) -> Result<()> {
        if title.contains('\0') {
            return Err("window title contains NUL".into());
        }
        self.toplevel
            .as_ref()
            .ok_or("title requires an xdg toplevel")?
            .set_title(title.into());
        Ok(())
    }
    pub fn capabilities(&self) -> Capabilities {
        self.capabilities
    }
    pub fn close(&mut self) {
        self.closed = true;
    }
    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }
    /// Physical pixels per logical pixel on the window's current output.
    pub fn scale(&self) -> f64 {
        f64::from(self.scale) / 120.
    }
    /// Root surface commits so far, the initial empty one included.
    pub fn commits(&self) -> u64 {
        self.commits
    }
    pub fn redraw(&mut self) {
        self.dirty = true;
    }
    pub fn set_text_input(&mut self, input: TextInput) {
        self.clear_layer_cursor();
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
        t.set_text_change_cause(if self.input_from_ime {
            ChangeCause::InputMethod
        } else {
            ChangeCause::Other
        });
        let [x, y, w, h] = self.input.rect;
        // The standard protocol remains root-local. Hyalo receives a layer's
        // local rectangle through its explicit, parent-committed association.
        if self.input_layer.is_none() {
            t.set_cursor_rectangle(x, y, w.max(1), h.max(1));
        }
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
            material: self.material.is_some() && !self.skip_material,
        })
    }
    fn preferred_scale(&mut self, scale: u32) {
        let scale = scale.max(1);
        self.events
            .push(Event::PreferredScale(f64::from(scale) / 120.));
        if scale != self.scale {
            self.scale = scale;
            self.dirty = true;
            self.events.push(Event::Configure);
        }
    }
    fn output_scale(&mut self) {
        if self.fractional.is_some() {
            return;
        }
        let scale = self
            .entered
            .iter()
            .filter_map(|id| self.outputs.get(id))
            .copied()
            .max()
            .unwrap_or(1);
        self.preferred_scale(scale as u32 * 120);
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
        let surface = self.surface.as_ref().unwrap().clone();
        if let Some(v) = &self.viewport {
            v.set_destination(self.width as i32, self.height as i32);
            surface.set_buffer_scale(1);
        } else {
            surface.set_buffer_scale((self.scale / 120) as i32);
        }
        if let Some(m) = &self.material {
            let material = if self.skip_material {
                None
            } else {
                app.material()
            };
            send_material(m, material.as_ref());
            if let Some(b) = app.window_background() {
                send_background(m, b);
            }
        }
        surface.attach(Some(&b.proxy), 0, 0);
        surface.damage_buffer(0, 0, frame.pixel_width as i32, frame.pixel_height as i32);
        surface.frame(&self.qh, ());
        self.frame_pending = true;
        self.commits += 1;
        if let Some(p) = &self.presentation {
            p.feedback(&surface, &self.qh, self.commits);
        }
        self.stage_layers();
        surface.commit();
        self.dirty = false;
        self.connection.flush().map_err(err)?;
        app.committed(self.commits);
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
    pub app_id: &'static str,
    pub title: &'static str,
    /// Logical size until the compositor configures one.
    pub size: (u32, u32),
    /// Refuse to start without `nidara-material-v1` (Hyalo), with this message.
    pub require_material: Option<&'static str>,
}
/// What the compositor offers, from its globals (PHASE1.md D5). The four required
/// protocols refuse the start; every other one has a fallback.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Capabilities {
    /// viewporter AND fractional-scale-v1; otherwise integer buffer scale.
    pub fractional: bool,
    /// nidara-material-v1; otherwise the app paints an opaque base.
    pub material: bool,
    /// nidara-layers-v1 (+ subcompositor, viewporter, material); otherwise the app animates.
    pub layers: bool,
    /// text-input-v3; otherwise typing works and composition does not.
    pub text_input: bool,
    /// wp_presentation; otherwise frame callbacks only.
    pub presentation: bool,
    /// zxdg_exporter_v2; otherwise portal dialogs may be unparented.
    pub foreign_parent: bool,
    /// xdg_activation_v1; consumes caller tokens without guaranteeing focus.
    pub activation: bool,
}
const REQUIRED: [&str; 4] = ["wl_compositor", "wl_shm", "xdg_wm_base", "wl_seat"];
pub fn capabilities<'a>(globals: impl IntoIterator<Item = &'a str>) -> Result<Capabilities> {
    let names: std::collections::HashSet<&str> = globals.into_iter().collect();
    if let Some(missing) = REQUIRED.iter().find(|n| !names.contains(*n)) {
        return Err(format!("required Wayland protocol missing: {missing}"));
    }
    let has = |n: &str| names.contains(n);
    let material = has("nidara_material_manager_v1");
    Ok(Capabilities {
        fractional: has("wp_viewporter") && has("wp_fractional_scale_manager_v1"),
        material,
        layers: material
            && has("wp_viewporter")
            && has("wl_subcompositor")
            && has("nidara_layers_manager_v1"),
        text_input: has("zwp_text_input_manager_v3"),
        presentation: has("wp_presentation"),
        foreign_parent: has("zxdg_exporter_v2"),
        activation: has("xdg_activation_v1"),
    })
}
pub fn run(app: impl Application, options: Options, start: Instant) -> Result<()> {
    run_inner(app, options, start, None, None, None).map(|_| ())
}
/// A layer-shell root (SHELL-SURFACES.md §1) on its own connection. `options.size`
/// is the initial logical size; `options.title` is unused. Ends on `Event::Closed`.
pub fn run_layer(
    app: impl Application,
    options: Options,
    layer: LayerSpec,
    start: Instant,
) -> Result<()> {
    layer.placement.validate()?;
    if layer.namespace.is_empty() || layer.namespace.contains('\0') {
        return Err("layer namespace must be nonempty text".into());
    }
    run_inner(app, options, start, None, None, Some(layer)).map(|_| ())
}
/// A modal xdg toplevel on the SAME connection; set_parent cannot name a
/// surface from another connection. The parent event queue resumes on close.
pub fn run_dialog(app: impl Application, parent: &mut Window) -> Result<()> {
    run_dialog_with_options(
        app,
        parent,
        Options {
            material: true,
            map: true,
            app_id: parent.app_id,
            title: "Correct error",
            size: (500, 300),
            require_material: None,
        },
    )
}
/// Caller-sized modal dialog on the parent's connection and application identity.
pub fn run_dialog_with_options(
    app: impl Application,
    parent: &mut Window,
    mut options: Options,
) -> Result<()> {
    if options.size.0 == 0 || options.size.1 == 0 {
        return Err("dialog needs a nonempty size".into());
    }
    options.app_id = parent.app_id;
    let last_serial = run_inner(app, options, Instant::now(), Some(parent), None, None)?;
    parent.ignore_input_before = Some(last_serial);
    parent.keyboard.reset();
    Ok(())
}

fn run_inner(
    mut app: impl Application,
    options: Options,
    start: Instant,
    parent: Option<&Window>,
    popup_options: Option<(PopupPlacement, Option<u32>)>,
    layer: Option<LayerSpec>,
) -> Result<u32> {
    let conn = if let Some(parent) = parent {
        parent.connection.clone()
    } else {
        Connection::connect_to_env().map_err(err)?
    };
    let mut queue = conn.new_event_queue::<Window>();
    let qh = queue.handle();
    let registry = conn.display().get_registry(&qh, ());
    let mut w = Window {
        connection: conn.clone(),
        foreign: foreign::Foreign::default(),
        activation: None,
        controls: controls::Controls::default(),
        maximized: false,
        wm: None,
        fractional_manager: None,
        materials: None,
        compositor: None,
        subcompositor: None,
        layers_manager: None,
        viewporter: None,
        layers: Vec::new(),
        pointer_layer: None,
        pointer_popup: None,
        overlay: Vec::new(),
        block_popup_release: false,
        block_popup_repeat: false,
        pointer_inside: false,
        pointer_position: (0., 0.),
        ignore_input_before: None,
        globals: Vec::new(),
        surface: None,
        xdg: None,
        toplevel: None,
        layer_shell: None,
        layer_surface: None,
        popup: None,
        positioner: None,
        shm: None,
        seat: None,
        keyboard_proxy: None,
        pointer: None,
        text_manager: None,
        text: None,
        material: None,
        viewport: None,
        fractional: None,
        outputs: Default::default(),
        entered: Default::default(),
        commits: 0,
        app_id: options.app_id,
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
        width: options.size.0,
        height: options.size.1,
        pending_size: None,
        popup_geometry: Default::default(),
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
        input_from_ime: false,
        input: TextInput::default(),
        sent_input: None,
        ime_pending: ImeBatch::default(),
        input_layer: None,
        cursor_pending: false,
        skip_material: !options.material,
        capabilities: Capabilities::default(),
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
    let caps = capabilities(w.globals.iter().map(|(_, n, _)| n.as_str()))?;
    w.capabilities = caps;
    w.capabilities.material &= options.material;
    w.capabilities.layers &= w.capabilities.material;
    if let (Some(message), false) = (options.require_material, caps.material) {
        return Err(message.into());
    }
    // v6: preferred_buffer_scale, the integer fallback's source.
    let compositor = bind!(wl_compositor::WlCompositor, 6).unwrap();
    let base = bind!(xdg_wm_base::XdgWmBase, 3).unwrap();
    let materials = bind!(nidara_material_manager_v1::NidaraMaterialManagerV1, 1);
    let viewporter = bind!(wp_viewporter::WpViewporter, 1);
    let fraction = bind!(
        wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1,
        1
    );
    w.subcompositor = bind!(wl_subcompositor::WlSubcompositor, 1);
    w.layers_manager = bind!(nidara_layers_manager_v1::NidaraLayersManagerV1, 1);
    w.controls.manager = bind!(
        controls::nidara_window_controls_manager_v1::NidaraWindowControlsManagerV1,
        1
    );
    w.wm = Some(base.clone());
    w.fractional_manager = fraction.clone();
    w.compositor = Some(compositor.clone());
    w.viewporter = viewporter.clone();
    w.shm = bind!(wl_shm::WlShm, 1);
    w.seat = bind!(wl_seat::WlSeat, 7);
    for (id, _, v) in w.globals.iter().filter(|(_, n, _)| n == "wl_output") {
        let output: wl_output::WlOutput = registry.bind(*id, (*v).min(4), &qh, ());
        w.outputs.insert(output.id(), 1);
    }
    if layer.is_some() {
        w.layer_shell = bind!(layer_shell::zwlr_layer_shell_v1::ZwlrLayerShellV1, 4);
        if w.layer_shell.is_none() {
            return Err("required Wayland protocol missing: zwlr_layer_shell_v1".into());
        }
    }
    w.text_manager = bind!(zwp_text_input_manager_v3::ZwpTextInputManagerV3, 1);
    w.data_manager = bind!(wl_data_device_manager::WlDataDeviceManager, 3);
    w.presentation = bind!(wp_presentation::WpPresentation, 1);
    w.activation = bind!(activation::xdg_activation_v1::XdgActivationV1, 1);
    w.foreign.exporter = bind!(
        wayland_protocols::xdg::foreign::zv2::client::zxdg_exporter_v2::ZxdgExporterV2,
        1
    );
    let surface = compositor.create_surface(&qh, ());
    let mut xdg = None;
    if let Some(spec) = layer {
        // The registry's global name is the compositor's identity for this output
        // instance, the same on every connection; a re-added output gets a new one.
        let output = match spec.output {
            None => None,
            Some(OutputId(global)) => Some(
                w.globals
                    .iter()
                    .find(|(id, n, _)| *id == global && n == "wl_output")
                    .map(|(id, _, v)| {
                        registry.bind::<wl_output::WlOutput, _, _>(*id, (*v).min(4), &qh, ())
                    })
                    .ok_or(OUTPUT_GONE)?,
            ),
        };
        let s = w.layer_shell.as_ref().unwrap().get_layer_surface(
            &surface,
            output.as_ref(),
            layer_shell::level(spec.layer),
            spec.namespace.into(),
            &qh,
            (),
        );
        spec.placement.send(&s);
        w.layer_surface = Some(s);
    } else if let Some((placement, grab_serial)) = popup_options {
        let xdg = xdg.insert(base.get_xdg_surface(&surface, &qh, ()));
        let parent = parent.ok_or("popup requires a parent")?;
        let parent_xdg = parent
            .xdg
            .as_ref()
            .ok_or("popup parent has no xdg surface")?;
        let positioner = base.create_positioner(&qh, ());
        placement.apply(&positioner)?;
        let popup = xdg.get_popup(Some(parent_xdg), &positioner, &qh, ());
        if let Some(serial) = grab_serial {
            popup.grab(
                parent.seat.as_ref().ok_or("popup grab requires a seat")?,
                serial,
            );
        }
        w.popup = Some(popup);
        w.positioner = Some(positioner);
    } else {
        let xdg = xdg.insert(base.get_xdg_surface(&surface, &qh, ()));
        let top = xdg.get_toplevel(&qh, ());
        top.set_app_id(options.app_id.into());
        top.set_title(options.title.into());
        top.set_min_size(400, 300);
        if let Some(parent) = parent {
            top.set_parent(parent.toplevel.as_ref());
        }
        w.toplevel = Some(top);
    }
    w.material = materials
        .as_ref()
        .map(|m| m.get_material(&surface, &qh, ()));
    w.materials = materials;
    // Both or neither: a fractional scale needs the viewport to say the logical size.
    if let (Some(viewporter), Some(fraction)) = (&viewporter, &fraction) {
        w.viewport = Some(viewporter.get_viewport(&surface, &qh, ()));
        w.fractional = Some(fraction.get_fractional_scale(&surface, &qh, ()));
    }
    w.surface = Some(surface);
    w.xdg = xdg;
    if w.toplevel.is_some() && app.window_controls() {
        w.request_window_controls();
    }
    // Seat and manager order in registry is unspecified.
    if let (Some(m), Some(s)) = (&w.text_manager, &w.seat) {
        w.text = Some(m.get_text_input(s, &qh, ()));
    }
    if let (Some(m), Some(s)) = (&w.data_manager, &w.seat) {
        w.data = Some(m.get_data_device(s, &qh, ()));
    }
    if options.map {
        w.surface.as_ref().unwrap().commit();
        w.commits = 1;
    }
    let mut first = true;
    let mut first_callback = true;
    while !w.closed {
        queue.dispatch_pending(&mut w).map_err(err)?;
        w.transfers()?;
        if let Some(k) = w.keyboard.tick() {
            w.push_key(k);
        }
        for mut event in std::mem::take(&mut w.events) {
            if let Event::PopupOverlay { id, .. } = &event
                && !w.overlay.iter().any(|p| p.id == *id)
            {
                continue;
            }
            if let Event::Key(key) = &event {
                if key.serial.is_none() && w.block_popup_repeat {
                    continue;
                }
                if let Some(id) = w.active_menu_popup() {
                    event = Event::PopupOverlay {
                        id,
                        event: PopupEvent::Key(key.clone()),
                    };
                }
            }
            if let Event::Button {
                pressed, serial, ..
            } = &event
                && let Some(id) = w.active_menu_popup()
            {
                if !pressed {
                    continue;
                }
                w.serial = *serial;
                event = Event::PopupOverlay {
                    id,
                    event: PopupEvent::Done,
                };
            }
            if w.active_menu_popup().is_some()
                && matches!(
                    event,
                    Event::Motion(..)
                        | Event::PointerLeave
                        | Event::Scroll(_)
                        | Event::HorizontalScroll(_)
                )
            {
                continue;
            }
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
            // An IME's own edit/caret echo must not look like an external
            // change: fcitx5 uses this cause to decide whether to reset preedit.
            w.input_from_ime = matches!(&event, Event::Ime(_));
            let closed = matches!(event, Event::Closed);
            app.event(event, &mut w)?;
            w.input_from_ime = false;
            if closed {
                w.closed = true;
            }
            if w.closed {
                break;
            }
        }
        if w.closed {
            break;
        }
        app.idle(&mut w)?;
        if w.closed {
            break;
        }
        w.paint(&mut app)?;
        if !w.dirty && (w.cursor_pending || w.layers.iter().any(|l| l.pending)) {
            w.commit()?;
        }
        conn.flush().map_err(|e| format!("Wayland flush: {e}"))?;
        if let Some(guard) = queue.prepare_read() {
            use rustix::event::{PollFd, PollFlags, Timespec, poll};
            let fd = guard.connection_fd();
            let mut fds = [PollFd::new(&fd, PollFlags::IN)];
            let ms = if w.keyboard.repeat.is_some() || w.receive.is_some() || !w.sends.is_empty() {
                8
            } else {
                i64::from(app.poll_interval_ms().clamp(1, 1000))
            };
            let timeout = Timespec {
                tv_sec: ms / 1000,
                tv_nsec: (ms % 1000) * 1_000_000,
            };
            match poll(&mut fds, Some(&timeout)) {
                Ok(_) if fds[0].revents().intersects(PollFlags::IN) => match guard.read() {
                    Ok(_) => {}
                    Err(wayland_client::backend::WaylandError::Io(e))
                        if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(format!("Wayland read: {e}")),
                },
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
    w.destroy_surfaces();
    conn.flush().map_err(|e| format!("Wayland flush: {e}"))?;
    Ok(w.serial)
}

impl Window {
    // Child windows share the parent's connection. Rust proxies alone do not send
    // destructors; close roles even when a callback or transport operation fails.
    fn destroy_surfaces(&mut self) {
        self.close_popup_overlay();
        self.foreign.destroy();
        if let Some(activation) = self.activation.take() {
            activation.destroy();
        }
        for layer in self.layers.drain(..) {
            layer.destroy();
        }
        if let Some(t) = self.text.take() {
            t.destroy();
        }
        if let Some(k) = self.keyboard_proxy.take() {
            k.release();
        }
        if let Some(p) = self.pointer.take() {
            p.release();
        }
        if let Some(d) = self.data.take() {
            d.release();
        }
        if let Some(m) = self.material.take() {
            m.destroy();
        }
        if let Some(v) = self.viewport.take() {
            v.destroy();
        }
        if let Some(f) = self.fractional.take() {
            f.destroy();
        }
        if let Some(p) = self.popup.take() {
            p.destroy();
        }
        if let Some(p) = self.positioner.take() {
            p.destroy();
        }
        if let Some(t) = self.toplevel.take() {
            t.destroy();
        }
        if let Some(l) = self.layer_surface.take() {
            l.destroy();
        }
        if let Some(l) = self.layer_shell.take() {
            l.destroy();
        }
        if let Some(x) = self.xdg.take() {
            x.destroy();
        }
        if let Some(s) = self.surface.take() {
            s.destroy();
        }
    }
}
impl Drop for Window {
    fn drop(&mut self) {
        self.destroy_surfaces();
        let _ = self.connection.flush();
    }
}

impl Dispatch<wl_registry::WlRegistry, ()> for Window {
    fn event(
        w: &mut Self,
        r: &wl_registry::WlRegistry,
        event: wl_registry::Event,
        _: &(),
        _: &Connection,
        q: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = event
        {
            // An output plugged in later still counts for the integer scale.
            if interface == "wl_output" && w.surface.is_some() {
                let output: wl_output::WlOutput = r.bind(name, version.min(4), q, ());
                w.outputs.insert(output.id(), 1);
            }
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
            w.popup_geometry.commit();
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
            xdg_toplevel::Event::Configure {
                width,
                height,
                states,
            } => {
                w.maximized = states.as_chunks::<4>().0.iter().any(|value| {
                    u32::from_ne_bytes(*value) == xdg_toplevel::State::Maximized as u32
                });
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
        if let wl_buffer::Event::Release = e {
            for b in w
                .buffers
                .iter_mut()
                .chain(w.layers.iter_mut().flat_map(|l| l.buffers.iter_mut()))
                .chain(w.overlay.iter_mut().flat_map(|p| p.buffers.iter_mut()))
            {
                if b.proxy == *p {
                    b.busy = false;
                }
            }
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
        // A scale it already draws at (re-sent, or the first one told) is no reason to repaint.
        if let wp_fractional_scale_v1::Event::PreferredScale { scale } = e {
            w.preferred_scale(scale);
        }
    }
}
impl Dispatch<wp_presentation_feedback::WpPresentationFeedback, u64> for Window {
    fn event(
        w: &mut Self,
        _: &wp_presentation_feedback::WpPresentationFeedback,
        e: wp_presentation_feedback::Event,
        commit: &u64,
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
                commit: *commit,
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
                if w.ignore_input_before
                    .is_some_and(|before| serial.wrapping_sub(before) as i32 <= 0)
                {
                    return;
                }
                w.serial = serial;
                if state == WEnum::Value(wl_keyboard::KeyState::Pressed) {
                    if let Some(mut k) = w.keyboard.press(key) {
                        k.serial = Some(serial);
                        w.block_popup_repeat = false;
                        w.push_key(k);
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
impl Window {
    fn push_key(&mut self, key: Key) {
        if let Some(id) = self.active_menu_popup() {
            self.events.push(Event::PopupOverlay {
                id,
                event: PopupEvent::Key(key),
            });
        } else {
            self.events.push(Event::Key(key));
        }
    }
    fn pointer_motion(&mut self, x: f64, y: f64) {
        self.pointer_position = (x, y);
        if !self.pointer_inside {
            return;
        }
        if let Some(id) = self.pointer_popup {
            self.events.push(Event::PopupOverlay {
                id,
                event: PopupEvent::Input(LayerEvent::Motion(x, y)),
            });
        } else if let Some(id) = self.pointer_layer {
            self.events.push(Event::Layer {
                id,
                event: LayerEvent::Motion(x, y),
            });
        } else {
            self.events.push(Event::Motion(x, y));
        }
    }
}
impl Dispatch<wl_pointer::WlPointer, ()> for Window {
    fn event(
        w: &mut Self,
        _: &wl_pointer::WlPointer,
        e: wl_pointer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            wl_pointer::Event::Enter {
                serial,
                surface,
                surface_x,
                surface_y,
            } => {
                w.serial = serial;
                w.pointer_popup = w
                    .overlay
                    .iter()
                    .find(|p| p.surface == surface)
                    .map(|p| p.id);
                w.pointer_layer = w.layers.iter().find(|l| l.surface == surface).map(|l| l.id);
                w.pointer_inside = w.pointer_popup.is_some()
                    || w.pointer_layer.is_some()
                    || w.surface.as_ref() == Some(&surface);
                w.pointer_motion(surface_x, surface_y);
            }
            wl_pointer::Event::Leave { .. } => {
                if let Some(id) = w.pointer_popup.take() {
                    w.events.push(Event::PopupOverlay {
                        id,
                        event: PopupEvent::Input(LayerEvent::Leave),
                    });
                }
                if let Some(id) = w.pointer_layer.take() {
                    w.events.push(Event::Layer {
                        id,
                        event: LayerEvent::Leave,
                    });
                }
                w.pointer_inside = false;
                w.events.push(Event::PointerLeave);
            }
            wl_pointer::Event::Motion {
                surface_x,
                surface_y,
                ..
            } => w.pointer_motion(surface_x, surface_y),
            wl_pointer::Event::Button {
                serial,
                time,
                button,
                state,
            } => {
                if !w.pointer_inside
                    || w.ignore_input_before
                        .is_some_and(|before| serial.wrapping_sub(before) as i32 <= 0)
                {
                    return;
                }
                w.serial = serial;
                let pressed = state == WEnum::Value(wl_pointer::ButtonState::Pressed);
                if !pressed && w.block_popup_release {
                    w.block_popup_release = false;
                    return;
                }
                if pressed {
                    w.block_popup_release = false;
                }
                if w.pointer_popup.is_none()
                    && let Some(id) = w.active_menu_popup()
                {
                    if pressed {
                        w.events.push(Event::PopupOverlay {
                            id,
                            event: PopupEvent::Done,
                        });
                    }
                    return;
                }
                if let Some(id) = w.pointer_popup {
                    let (x, y) = w.pointer_position;
                    w.events.push(Event::PopupOverlay {
                        id,
                        event: PopupEvent::Input(LayerEvent::Button {
                            button,
                            pressed,
                            serial,
                            time,
                            x,
                            y,
                        }),
                    });
                } else if let Some(id) = w.pointer_layer {
                    let (x, y) = w.pointer_position;
                    w.events.push(Event::Layer {
                        id,
                        event: LayerEvent::Button {
                            button,
                            pressed,
                            serial,
                            time,
                            x,
                            y,
                        },
                    });
                } else {
                    w.events.push(Event::Button {
                        button,
                        pressed,
                        serial,
                        time,
                    });
                }
            }
            wl_pointer::Event::Axis {
                axis: WEnum::Value(wl_pointer::Axis::HorizontalScroll),
                value,
                ..
            } => {
                if let Some(id) = w.pointer_popup {
                    w.events.push(Event::PopupOverlay {
                        id,
                        event: PopupEvent::Input(LayerEvent::HorizontalScroll(value)),
                    });
                } else if let Some(id) = w.pointer_layer {
                    w.events.push(Event::Layer {
                        id,
                        event: LayerEvent::HorizontalScroll(value),
                    });
                } else if w.pointer_inside {
                    w.events.push(Event::HorizontalScroll(value));
                }
            }
            wl_pointer::Event::Axis {
                axis: WEnum::Value(wl_pointer::Axis::VerticalScroll),
                value,
                ..
            } => {
                if let Some(id) = w.pointer_popup {
                    w.events.push(Event::PopupOverlay {
                        id,
                        event: PopupEvent::Input(LayerEvent::Scroll(value)),
                    });
                } else if let Some(id) = w.pointer_layer {
                    w.events.push(Event::Layer {
                        id,
                        event: LayerEvent::Scroll(value),
                    });
                } else if w.pointer_inside {
                    w.events.push(Event::Scroll(value));
                }
            }
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
impl Dispatch<wl_surface::WlSurface, ()> for Window {
    fn event(
        w: &mut Self,
        s: &wl_surface::WlSurface,
        e: wl_surface::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // Only the root's scale counts; the fractional protocol, when bound, decides it.
        if w.fractional.is_some() || w.surface.as_ref() != Some(s) {
            return;
        }
        match e {
            wl_surface::Event::PreferredBufferScale { factor } => {
                w.preferred_scale(factor.max(1) as u32 * 120)
            }
            wl_surface::Event::Enter { output } => {
                w.entered.insert(output.id());
                w.output_scale();
            }
            wl_surface::Event::Leave { output } => {
                w.entered.remove(&output.id());
                w.output_scale();
            }
            _ => {}
        }
    }
}
impl Dispatch<wl_output::WlOutput, ()> for Window {
    fn event(
        w: &mut Self,
        output: &wl_output::WlOutput,
        e: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Scale { factor } = e {
            w.outputs.insert(output.id(), factor.max(1));
            w.output_scale();
        }
    }
}
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

#[cfg(test)]
mod tests {
    use super::*;
    const ALL: [&str; 11] = [
        "wl_compositor",
        "wl_shm",
        "xdg_wm_base",
        "wl_seat",
        "wp_viewporter",
        "wp_fractional_scale_manager_v1",
        "nidara_material_manager_v1",
        "wl_subcompositor",
        "nidara_layers_manager_v1",
        "zwp_text_input_manager_v3",
        "wp_presentation",
    ];
    fn without(missing: &str) -> Result<Capabilities> {
        capabilities(ALL.iter().copied().filter(|n| *n != missing))
    }
    #[test]
    fn every_protocol_on_hyalo() {
        let c = capabilities(ALL).unwrap();
        assert!(c.fractional && c.material && c.layers && c.text_input && c.presentation);
    }
    #[test]
    fn a_required_protocol_missing_refuses_and_names_it() {
        for name in REQUIRED {
            assert_eq!(
                without(name),
                Err(format!("required Wayland protocol missing: {name}"))
            );
        }
    }
    #[test]
    fn activation_is_optional_and_uses_the_exact_global() {
        assert!(!capabilities(ALL).unwrap().activation);
        assert!(
            capabilities(ALL.into_iter().chain(["xdg_activation_v1"]))
                .unwrap()
                .activation
        );
        assert!(
            !capabilities(ALL.into_iter().chain(["xdg_activation_token_v1"]))
                .unwrap()
                .activation
        );
    }
    #[test]
    fn foreign_parent_capability_requires_the_exact_optional_global() {
        assert!(!capabilities(ALL).unwrap().foreign_parent);
        assert!(
            capabilities(ALL.into_iter().chain(["zxdg_exporter_v2"]))
                .unwrap()
                .foreign_parent
        );
        assert!(
            !capabilities(ALL.into_iter().chain(["zxdg_exporter_v1"]))
                .unwrap()
                .foreign_parent
        );
    }
    #[test]
    fn each_optional_protocol_missing_takes_its_fallback() {
        let c = without("wp_viewporter").unwrap();
        assert!(!c.fractional && !c.layers && c.material);
        let c = without("wp_fractional_scale_manager_v1").unwrap();
        assert!(!c.fractional && c.layers);
        let c = without("nidara_material_manager_v1").unwrap();
        assert!(!c.material && !c.layers && c.fractional);
        let c = without("nidara_layers_manager_v1").unwrap();
        assert!(!c.layers && c.material);
        let c = without("wl_subcompositor").unwrap();
        assert!(!c.layers);
        let c = without("zwp_text_input_manager_v3").unwrap();
        assert!(!c.text_input && c.material);
        let c = without("zxdg_exporter_v2").unwrap();
        assert!(!c.foreign_parent && c.material);
        let c = without("wp_presentation").unwrap();
        assert!(!c.presentation && c.material);
    }
}
