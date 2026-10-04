//! The Smithay handler traits that are only wiring: the commit path, the seat, selections,
//! dmabuf, outputs.

use smithay::{
    backend::{allocator::dmabuf::Dmabuf, renderer::utils::on_commit_buffer_handler},
    input::{
        Seat, SeatHandler, SeatState,
        dnd::{DnDGrab, DndGrabHandler, GrabType, Source},
        keyboard::LedState,
        pointer::{CursorImageStatus, Focus, PointerHandle},
    },
    reexports::wayland_server::{
        Client, Resource,
        protocol::{wl_buffer, wl_surface::WlSurface},
    },
    utils::{Logical, Point, Serial},
    wayland::{
        buffer::BufferHandler,
        compositor::{CompositorClientState, CompositorHandler, CompositorState, get_parent, is_sync_subsurface},
        dmabuf::{DmabufGlobal, DmabufHandler, DmabufState, ImportNotifier},
        fractional_scale::FractionalScaleHandler,
        output::OutputHandler,
        pointer_constraints::{PointerConstraintsHandler, with_pointer_constraint},
        selection::{
            SelectionHandler,
            data_device::{DataDeviceHandler, DataDeviceState, WaylandDndGrabHandler, set_data_device_focus},
            primary_selection::{PrimarySelectionHandler, PrimarySelectionState, set_primary_focus},
        },
        shm::{ShmHandler, ShmState},
    },
};

use crate::{
    protocols::material,
    state::{ClientState, Hyalo},
};

impl CompositorHandler for Hyalo {
    fn compositor_state(&mut self) -> &mut CompositorState {
        &mut self.compositor_state
    }

    fn client_compositor_state<'a>(&self, client: &'a Client) -> &'a CompositorClientState {
        &client.get_data::<ClientState>().unwrap().compositor_state
    }

    fn commit(&mut self, surface: &WlSurface) {
        on_commit_buffer_handler::<Self>(surface);
        self.backend.early_import(surface);
        if !is_sync_subsurface(surface) {
            let mut root = surface.clone();
            while let Some(parent) = get_parent(&root) {
                root = parent;
            }
            if let Some(window) = self.window_for_surface(&root) {
                window.on_commit();
            }
        }
        material::on_commit(surface);
        crate::protocols::window_controls::on_commit(self, surface);
        self.xdg_commit(surface);
        self.layer_commit(surface);

        let outputs = self.outputs_for_surface(surface);
        if outputs.is_empty() {
            // A cursor or drag icon, or a surface not placed yet: cheap to redraw everything.
            self.queue_redraw(None);
        }
        for o in &outputs {
            self.queue_redraw(Some(o));
        }
    }

    fn destroyed(&mut self, surface: &WlSurface) {
        // A client that quits without destroying its window first (or is killed) has its
        // objects destroyed in the order it made them: the surface before its toplevel. The
        // closing picture is taken while the surface still holds its last frame (wm/motion.rs).
        if let Some(id) = self.wm.by_surface(surface).map(|m| m.id) {
            self.start_closing(id);
        }
    }
}

impl BufferHandler for Hyalo {
    fn buffer_destroyed(&mut self, _buffer: &wl_buffer::WlBuffer) {}
}

impl ShmHandler for Hyalo {
    fn shm_state(&self) -> &ShmState {
        &self.shm_state
    }
}

impl SeatHandler for Hyalo {
    type KeyboardFocus = WlSurface;
    type PointerFocus = WlSurface;
    type TouchFocus = WlSurface;

    fn seat_state(&mut self) -> &mut SeatState<Hyalo> {
        &mut self.seat_state
    }

    fn cursor_image(&mut self, _seat: &Seat<Self>, image: CursorImageStatus) {
        self.cursor_status = image;
        self.queue_redraw(None);
    }

    fn focus_changed(&mut self, seat: &Seat<Self>, focused: Option<&WlSurface>) {
        let dh = &self.display_handle;
        let client = focused.and_then(|s| dh.get_client(s.id()).ok());
        set_data_device_focus(dh, seat, client.clone());
        set_primary_focus(dh, seat, client);
    }

    fn led_state_changed(&mut self, _seat: &Seat<Self>, led_state: LedState) {
        self.backend.update_led_state(led_state);
    }
}

// Tablets are #683's; cursor-shape-v1 needs the trait to exist for its tool cursors.
impl smithay::input::tablet::TabletSeatHandler for Hyalo {
    type ToolFocus = WlSurface;
}

impl SelectionHandler for Hyalo {
    type SelectionUserData = ();
}

impl DataDeviceHandler for Hyalo {
    fn data_device_state(&mut self) -> &mut DataDeviceState {
        &mut self.data_device_state
    }
}

impl PrimarySelectionHandler for Hyalo {
    fn primary_selection_state(&mut self) -> &mut PrimarySelectionState {
        &mut self.primary_selection_state
    }
}

impl DndGrabHandler for Hyalo {}
impl WaylandDndGrabHandler for Hyalo {
    fn dnd_requested<S: Source>(
        &mut self,
        source: S,
        _icon: Option<WlSurface>,
        seat: Seat<Self>,
        serial: Serial,
        type_: GrabType,
    ) {
        match type_ {
            GrabType::Pointer => {
                let ptr = seat.get_pointer().unwrap();
                let Some(start_data) = ptr.grab_start_data() else {
                    source.cancel();
                    return;
                };
                let grab = DnDGrab::new_pointer(&self.display_handle, start_data, source, seat);
                ptr.set_grab(self, grab, serial, Focus::Keep);
            }
            // Touch input is #683's.
            GrabType::Touch => source.cancel(),
        }
    }
}

impl OutputHandler for Hyalo {}

impl smithay::wayland::selection::ext_data_control::DataControlHandler for Hyalo {
    fn data_control_state(&mut self) -> &mut smithay::wayland::selection::ext_data_control::DataControlState {
        &mut self.ext_data_control
    }
}

impl smithay::wayland::selection::wlr_data_control::DataControlHandler for Hyalo {
    fn data_control_state(&mut self) -> &mut smithay::wayland::selection::wlr_data_control::DataControlState {
        &mut self.wlr_data_control
    }
}
// The hint itself is all wm::focus_window reads; nothing to do when it changes.
impl smithay::wayland::shell::xdg::dialog::XdgDialogHandler for Hyalo {}
impl FractionalScaleHandler for Hyalo {}

impl PointerConstraintsHandler for Hyalo {
    fn new_constraint(&mut self, surface: &WlSurface, pointer: &PointerHandle<Self>) {
        // Activate it at once when the surface already has the pointer.
        if pointer.current_focus().as_ref() == Some(surface) {
            with_pointer_constraint(surface, pointer, |constraint| {
                if let Some(c) = constraint {
                    c.activate();
                }
            });
        }
    }

    fn cursor_position_hint(
        &mut self,
        _surface: &WlSurface,
        _pointer: &PointerHandle<Self>,
        _location: Point<f64, Logical>,
    ) {
    }
}

impl DmabufHandler for Hyalo {
    fn dmabuf_state(&mut self) -> &mut DmabufState {
        self.backend.dmabuf_state()
    }

    fn dmabuf_imported(&mut self, _global: &DmabufGlobal, dmabuf: Dmabuf, notifier: ImportNotifier) {
        if self.backend.import_dmabuf(&dmabuf) {
            let _ = notifier.successful::<Hyalo>();
        } else {
            notifier.failed();
        }
    }
}

smithay::delegate_dispatch2!(Hyalo);

// ── Input methods (text-input-v3 + input-method-v2) ──────────────────────────────────────────
//
// fcitx5 is an input-method-v2 client; applications speak text-input-v3 (GTK4 natively). Smithay
// moves the text-input focus with the keyboard focus (`wayland/seat/keyboard.rs`), and every
// keyboard focus change in Hyalo goes through `set_keyboard_focus` — so a layer surface that took
// the keyboard through a focus grab (the shell's search) gets the input method too. On Hyprland
// it did not: its grab path never emitted the focus event the IME relay listens to (#679 #10,
// #503). The input method's candidate window is a popup of the surface being typed into, drawn
// with that surface's popups (render/mod.rs).
impl smithay::wayland::input_method::InputMethodHandler for Hyalo {
    fn new_popup(&mut self, surface: smithay::wayland::input_method::PopupSurface) {
        if let Err(err) = self.popups.track_popup(smithay::desktop::PopupKind::from(surface)) {
            tracing::warn!(?err, "input method popup not tracked");
        }
    }

    fn popup_repositioned(&mut self, _surface: smithay::wayland::input_method::PopupSurface) {}

    fn dismiss_popup(&mut self, surface: smithay::wayland::input_method::PopupSurface) {
        if let Some(parent) = surface.get_parent().map(|p| p.surface.clone()) {
            let _ = smithay::desktop::PopupManager::dismiss_popup(&parent, &smithay::desktop::PopupKind::from(surface));
        }
    }

    /// Where the text being typed sits: a window's geometry, or a layer surface's whole area.
    fn parent_geometry(&self, parent: &WlSurface) -> smithay::utils::Rectangle<i32, Logical> {
        if let Some(window) = self.window_for_surface(parent) {
            return window.geometry();
        }
        self.space
            .outputs()
            .find_map(|o| {
                let map = smithay::desktop::layer_map_for_output(o);
                map.layers()
                    .find(|l| l.wl_surface() == parent)
                    .map(|l| smithay::utils::Rectangle::from_size(l.bbox().size))
            })
            .unwrap_or_default()
    }
}
