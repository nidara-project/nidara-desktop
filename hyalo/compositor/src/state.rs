//! The compositor's state: the Wayland globals, the space windows live in, the seat, and the
//! backend that turns all of it into frames.

use std::{ffi::OsString, sync::Arc, time::Instant};

use smithay::{
    desktop::{PopupManager, Space, Window, WindowSurfaceType},
    input::{Seat, SeatState, keyboard::XkbConfig, pointer::CursorImageStatus},
    output::Output,
    reexports::{
        calloop::{Interest, LoopHandle, LoopSignal, Mode, PostAction, generic::Generic},
        wayland_server::{
            Display, DisplayHandle,
            backend::{ClientData, ClientId, DisconnectReason},
            protocol::wl_surface::WlSurface,
        },
    },
    utils::{Clock, Logical, Monotonic, Point},
    wayland::{
        compositor::{CompositorClientState, CompositorState},
        cursor_shape::CursorShapeManagerState,
        output::OutputManagerState,
        pointer_constraints::PointerConstraintsState,
        presentation::PresentationState,
        relative_pointer::RelativePointerManagerState,
        selection::{data_device::DataDeviceState, primary_selection::PrimarySelectionState},
        shell::{wlr_layer::WlrLayerShellState, xdg::XdgShellState},
        shm::ShmState,
        socket::ListeningSocketSource,
    },
};

use crate::{
    backend::Backend,
    config::Config,
    ipc::server::IpcState,
    protocols::{focus_grab, material},
};

pub struct Hyalo {
    pub start_time: Instant,
    pub clock: Clock<Monotonic>,
    pub socket_name: OsString,
    pub display_handle: DisplayHandle,
    pub loop_handle: LoopHandle<'static, Hyalo>,
    pub loop_signal: LoopSignal,

    pub backend: Backend,
    pub config: Config,
    /// The config layers' modification times as of the last (re)load: the watcher reloads when
    /// they differ, and a reload Hyalo did itself (`settings`) does not happen twice.
    pub config_stamps: Vec<Option<std::time::SystemTime>>,

    pub space: Space<Window>,
    pub popups: PopupManager,

    pub compositor_state: CompositorState,
    pub xdg_shell_state: XdgShellState,
    pub layer_shell_state: WlrLayerShellState,
    pub shm_state: ShmState,
    pub output_manager_state: OutputManagerState,
    pub seat_state: SeatState<Hyalo>,
    pub data_device_state: DataDeviceState,
    pub primary_selection_state: PrimarySelectionState,
    pub presentation_state: PresentationState,

    pub seat: Seat<Self>,
    pub cursor_status: CursorImageStatus,
    pub focus_grab: Option<focus_grab::ActiveGrab>,
    /// Set when a frame has to be drawn on some output soon (see `queue_redraw`).
    pub redraw_idle_queued: bool,
    pub ipc: IpcState,
    /// Workspaces and windows (wm/).
    pub wm: crate::wm::Wm,
    pub binds: Vec<crate::binds::Binding>,
    /// Window capture for thumbnails (capture.rs).
    pub foreign_toplevel_list: smithay::wayland::foreign_toplevel_list::ForeignToplevelListState,
    pub toplevel_capture_source: smithay::wayland::image_capture_source::ToplevelCaptureSourceState,
    pub image_copy_capture: smithay::wayland::image_copy_capture::ImageCopyCaptureState,
    /// Capture sessions a client holds open (capture.rs: dropping one stops it).
    pub capture_sessions: Vec<smithay::wayland::image_copy_capture::Session>,
    /// The window rules in force (wm/rules.rs).
    pub rules: Vec<crate::wm::rules::Rule>,
    pub keys: crate::input::KeyTracking,
}

impl Hyalo {
    pub fn new(
        display: Display<Self>,
        loop_handle: LoopHandle<'static, Hyalo>,
        loop_signal: LoopSignal,
        backend: Backend,
        config: Config,
    ) -> Self {
        let dh = display.handle();
        let clock = Clock::new();

        let compositor_state = CompositorState::new_v6::<Self>(&dh);
        let xdg_shell_state = XdgShellState::new::<Self>(&dh);
        let layer_shell_state = WlrLayerShellState::new::<Self>(&dh);
        let shm_state = ShmState::new::<Self>(&dh, vec![]);
        let output_manager_state = OutputManagerState::new_with_xdg_output::<Self>(&dh);
        let data_device_state = DataDeviceState::new::<Self>(&dh);
        let primary_selection_state = PrimarySelectionState::new::<Self>(&dh);
        let presentation_state = PresentationState::new::<Self>(&dh, clock.id() as u32);
        // What every GTK client expects: smallvil leaves them out, and awww-daemon panics
        // without a viewporter.
        smithay::wayland::viewporter::ViewporterState::new::<Self>(&dh);
        smithay::wayland::fractional_scale::FractionalScaleManagerState::new::<Self>(&dh);
        smithay::wayland::single_pixel_buffer::SinglePixelBufferState::new::<Self>(&dh);
        CursorShapeManagerState::new::<Self>(&dh);
        RelativePointerManagerState::new::<Self>(&dh);
        PointerConstraintsState::new::<Self>(&dh);
        // Ours (protocols/ at the repo root).
        focus_grab::init(&dh);
        // Window capture for the shell's thumbnails (capture.rs).
        let foreign_toplevel_list = smithay::wayland::foreign_toplevel_list::ForeignToplevelListState::new::<Self>(&dh);
        let toplevel_capture_source = smithay::wayland::image_capture_source::ToplevelCaptureSourceState::new::<Self>(&dh);
        let image_copy_capture = smithay::wayland::image_copy_capture::ImageCopyCaptureState::new::<Self>(&dh);
        material::init(&dh);

        let mut seat_state = SeatState::new();
        let mut seat: Seat<Self> = seat_state.new_wl_seat(&dh, backend.seat_name());
        let kb = &config.input.keyboard.with_system_defaults();
        let xkb = XkbConfig {
            rules: &kb.rules,
            model: &kb.model,
            layout: &kb.layout,
            variant: &kb.variant,
            options: (!kb.options.is_empty()).then(|| kb.options.clone()),
        };
        let keyboard = match seat.add_keyboard(xkb, kb.repeat_delay, kb.repeat_rate) {
            Ok(k) => k,
            Err(err) => {
                tracing::warn!(?err, "keyboard config refused, falling back to the default keymap");
                seat.add_keyboard(Default::default(), kb.repeat_delay, kb.repeat_rate)
                    .expect("default keymap")
            }
        };
        if kb.numlock {
            crate::config::set_numlock(&keyboard);
        }
        seat.add_pointer();

        let socket_name = Self::init_wayland_listener(display, &loop_handle);
        let rules_config = config.rules.clone();
        let binds = crate::binds::parse_binds(&config.binds).unwrap_or_else(|err| {
            tracing::error!("key bindings not loaded: {err}");
            Vec::new()
        });

        Self {
            start_time: Instant::now(),
            clock,
            socket_name,
            display_handle: dh,
            loop_handle,
            loop_signal,
            backend,
            config,
            config_stamps: crate::config::stamps(),
            space: Space::default(),
            popups: PopupManager::default(),
            compositor_state,
            xdg_shell_state,
            layer_shell_state,
            shm_state,
            output_manager_state,
            seat_state,
            data_device_state,
            primary_selection_state,
            presentation_state,
            seat,
            cursor_status: CursorImageStatus::default_named(),
            focus_grab: None,
            redraw_idle_queued: false,
            ipc: IpcState::default(),
            wm: crate::wm::Wm::default(),
            binds,
            foreign_toplevel_list,
            toplevel_capture_source,
            image_copy_capture,
            capture_sessions: Vec::new(),
            rules: crate::wm::rules::compile(&rules_config).unwrap_or_else(|err| {
                tracing::error!("window rules not loaded: {err}");
                Vec::new()
            }),
            keys: Default::default(),
        }
    }

    fn init_wayland_listener(display: Display<Hyalo>, loop_handle: &LoopHandle<'static, Hyalo>) -> OsString {
        let listening_socket = ListeningSocketSource::new_auto().expect("a Wayland socket");
        let socket_name = listening_socket.socket_name().to_os_string();

        loop_handle
            .insert_source(listening_socket, move |client_stream, _, state| {
                if let Err(err) = state
                    .display_handle
                    .insert_client(client_stream, Arc::new(ClientState::default()))
                {
                    tracing::warn!(?err, "could not accept a client");
                }
            })
            .expect("the Wayland socket's event source");

        loop_handle
            .insert_source(Generic::new(display, Interest::READ, Mode::Level), |_, display, state| {
                // Safety: the display is never dropped while the loop runs.
                unsafe {
                    display.get_mut().dispatch_clients(state).unwrap();
                }
                Ok(PostAction::Continue)
            })
            .expect("the display's event source");

        socket_name
    }

    /// Something on `output` changed: draw it on its next opportunity. `None` = every output.
    pub fn queue_redraw(&mut self, output: Option<&Output>) {
        match output {
            Some(o) => self.backend.queue_redraw(o),
            None => {
                for o in self.space.outputs().cloned().collect::<Vec<_>>() {
                    self.backend.queue_redraw(&o);
                }
            }
        }
        if !self.redraw_idle_queued {
            self.redraw_idle_queued = true;
            self.loop_handle.insert_idle(|state| {
                state.redraw_idle_queued = false;
                crate::backend::redraw_queued(state);
            });
        }
    }

    /// The outputs a surface is shown on, for redrawing after its commit.
    pub fn outputs_for_surface(&self, surface: &WlSurface) -> Vec<Output> {
        let root = crate::shell::root_surface(self, surface);
        if let Some(window) = self.window_for_surface(&root) {
            return self.space.outputs_for_element(&window);
        }
        for output in self.space.outputs() {
            let map = smithay::desktop::layer_map_for_output(output);
            if map.layer_for_surface(&root, WindowSurfaceType::ALL).is_some() {
                return vec![output.clone()];
            }
        }
        Vec::new()
    }

    /// A window known to the window manager, shown or not.
    pub fn window_for_surface(&self, surface: &WlSurface) -> Option<Window> {
        self.wm.by_surface(surface).map(|m| m.window.clone())
    }

    /// What the pointer is over, in the order things are drawn: overlay layers, a fullscreen
    /// window (and whatever is shown above it), top layers, the other windows, then bottom
    /// and background layers.
    pub fn surface_under(&self, pos: Point<f64, Logical>) -> Option<(WlSurface, Point<f64, Logical>)> {
        use smithay::wayland::shell::wlr_layer::Layer;
        if let Some((_, s, p)) = self.layer_under(&[Layer::Overlay], pos) {
            return Some((s, p));
        }
        let output = self.space.output_under(pos).next().cloned();
        let (above, below) = match &output {
            Some(o) => crate::render::windows_front_to_back(&self.space, &self.wm, o),
            None => (Vec::new(), Vec::new()),
        };
        let hit = |windows: &[Window]| {
            windows.iter().find_map(|window| {
                // Where the surface is drawn: the geometry's origin less the decorations.
                let location = self.space.element_location(window)? - window.geometry().loc;
                window
                    .surface_under(pos - location.to_f64(), WindowSurfaceType::ALL)
                    .map(|(s, p)| (s, (p + location).to_f64()))
            })
        };
        if let Some(h) = hit(&above) {
            return Some(h);
        }
        if let Some((_, s, p)) = self.layer_under(&[Layer::Top], pos) {
            return Some((s, p));
        }
        if let Some(h) = hit(&below) {
            return Some(h);
        }
        self.layer_under(&[Layer::Bottom, Layer::Background], pos)
            .map(|(_, s, p)| (s, p))
    }
}

/// Per-client data.
#[derive(Default)]
pub struct ClientState {
    pub compositor_state: CompositorClientState,
}

impl ClientData for ClientState {
    fn initialized(&self, _client_id: ClientId) {}
    fn disconnected(&self, _client_id: ClientId, _reason: DisconnectReason) {}
}
