//! Windows (xdg-shell) and their popups. Layer surfaces — the shell's bar, dock and panels —
//! are in `layer.rs`.

pub mod layer;

use smithay::{
    desktop::{
        PopupKeyboardGrab, PopupKind, PopupPointerGrab, PopupUngrabStrategy, Window, WindowSurfaceType,
        find_popup_root_surface, get_popup_toplevel_coords,
        layer_map_for_output,
    },
    input::{
        Seat,
        pointer::{Focus, GrabStartData as PointerGrabStartData},
    },
    reexports::{
        wayland_protocols::xdg::shell::server::xdg_toplevel,
        wayland_server::{
            Resource,
            protocol::{wl_seat, wl_surface::WlSurface},
        },
    },
    utils::Serial,
    wayland::{
        compositor::{get_parent, with_states},
        shell::xdg::{
            PopupSurface, PositionerState, ToplevelSurface, XdgShellHandler, XdgShellState,
            XdgToplevelSurfaceData,
        },
    },
};

use crate::{
    Hyalo,
    wm::{Fullscreen, grabs::Kind},
};

impl XdgShellHandler for Hyalo {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        // Known from now on; placed on its first buffer (`window_mapped`).
        self.window_created(Window::new_wayland_window(surface));
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        if let Some(window) = self.window_for_surface(surface.wl_surface()) {
            self.window_destroyed(&window);
        }
    }

    fn new_popup(&mut self, surface: PopupSurface, _positioner: PositionerState) {
        self.unconstrain_popup(&surface);
        let _ = self.popups.track_popup(PopupKind::Xdg(surface));
    }

    fn reposition_request(&mut self, surface: PopupSurface, positioner: PositionerState, token: u32) {
        surface.with_pending_state(|state| {
            state.geometry = positioner.get_geometry();
            state.positioner = positioner;
        });
        self.unconstrain_popup(&surface);
        surface.send_repositioned(token);
    }

    fn popup_destroyed(&mut self, _surface: PopupSurface) {
        self.queue_redraw(None);
    }

    fn move_request(&mut self, surface: ToplevelSurface, seat: wl_seat::WlSeat, serial: Serial) {
        let seat = Seat::from_resource(&seat).unwrap();
        let Some(start_data) = check_grab(&seat, surface.wl_surface(), serial) else { return };
        let Some(id) = self.wm.by_surface(surface.wl_surface()).map(|m| m.id) else { return };
        let button = start_data.button;
        self.start_window_grab(id, Kind::Move, start_data, button);
    }

    fn resize_request(
        &mut self,
        surface: ToplevelSurface,
        seat: wl_seat::WlSeat,
        serial: Serial,
        edges: xdg_toplevel::ResizeEdge,
    ) {
        let seat = Seat::from_resource(&seat).unwrap();
        let Some(start_data) = check_grab(&seat, surface.wl_surface(), serial) else { return };
        let Some(id) = self.wm.by_surface(surface.wl_surface()).map(|m| m.id) else { return };
        let button = start_data.button;
        self.start_window_grab(id, Kind::Resize(edges.into()), start_data, button);
    }

    fn maximize_request(&mut self, surface: ToplevelSurface) {
        // Refused, as on the Hyprland session (`suppress_event = "maximize"`): a double click
        // on a header would otherwise maximize behind the user's back; Super+M maximizes. The
        // client still gets its configure, as the protocol asks.
        if surface.is_initial_configure_sent() {
            surface.send_configure();
        }
    }

    fn fullscreen_request(&mut self, surface: ToplevelSurface, _output: Option<smithay::reexports::wayland_server::protocol::wl_output::WlOutput>) {
        // A video player or a game asking for the whole screen: granted, on the output its
        // workspace is on.
        match self.wm.by_surface(surface.wl_surface()).map(|m| (m.id, m.mapped)) {
            Some((id, true)) => self.set_fullscreen(id, Fullscreen::Fullscreen),
            _ => {
                if surface.is_initial_configure_sent() {
                    surface.send_configure();
                }
            }
        }
    }

    fn unfullscreen_request(&mut self, surface: ToplevelSurface) {
        if let Some(id) = self.wm.by_surface(surface.wl_surface()).map(|m| m.id) {
            self.set_fullscreen(id, Fullscreen::None);
        }
    }

    fn app_id_changed(&mut self, surface: ToplevelSurface) {
        self.wm.dirty_windows = true;
        // A GTK window takes its real app id when it is mapped: a rule naming it applies now.
        if let Some(id) = self.wm.by_surface(surface.wl_surface()).map(|m| m.id) {
            self.relist_window(id);
            self.apply_late_rules(id);
        }
    }

    fn title_changed(&mut self, surface: ToplevelSurface) {
        if let Some(m) = self.wm.by_surface(surface.wl_surface()) {
            let id = m.id;
            let event = crate::ipc::Event::WindowTitleChanged { id, title: crate::wm::title(&m.window) };
            crate::ipc::server::broadcast(self, &event);
            self.relist_window(id);
            self.apply_late_rules(id);
        }
    }

    /// A menu that closes when the user clicks or types outside it: the popup gets the
    /// keyboard and the pointer until it is dismissed. (The shell's own panels close through
    /// hyprland-focus-grab-v1, a different mechanism — protocols/focus_grab.rs.)
    fn grab(&mut self, surface: PopupSurface, seat: wl_seat::WlSeat, serial: Serial) {
        let seat: Seat<Hyalo> = Seat::from_resource(&seat).unwrap();
        let kind = PopupKind::Xdg(surface);
        let Ok(root) = find_popup_root_surface(&kind) else { return };
        // Locked: only the lock screen's own menus may take the input (lock.rs).
        if self.lock.is_locked() && !self.belongs_to_lock(&root) {
            return;
        }
        let Ok(mut grab) = self.popups.grab_popup(root, kind, &seat, serial) else { return };
        if let Some(keyboard) = seat.get_keyboard() {
            // A grab already held by something else (a window being dragged) is not taken over.
            if keyboard.is_grabbed()
                && !(keyboard.has_grab(serial) || keyboard.has_grab(grab.previous_serial().unwrap_or(serial)))
            {
                grab.ungrab(PopupUngrabStrategy::All);
                return;
            }
            self.set_keyboard_focus(grab.current_grab(), serial);
            keyboard.set_grab(self, PopupKeyboardGrab::new(&grab), serial);
        }
        if let Some(pointer) = seat.get_pointer() {
            if pointer.is_grabbed()
                && !(pointer.has_grab(serial) || pointer.has_grab(grab.previous_serial().unwrap_or_else(|| grab.serial())))
            {
                grab.ungrab(PopupUngrabStrategy::All);
                return;
            }
            pointer.set_grab(self, PopupPointerGrab::new(&grab), serial, Focus::Keep);
        }
    }
}

fn check_grab(seat: &Seat<Hyalo>, surface: &WlSurface, serial: Serial) -> Option<PointerGrabStartData<Hyalo>> {
    let pointer = seat.get_pointer()?;
    if !pointer.has_grab(serial) {
        return None;
    }
    let start_data = pointer.grab_start_data()?;
    let (focus, _) = start_data.focus.as_ref()?;
    if !focus.id().same_client_as(&surface.id()) {
        return None;
    }
    Some(start_data)
}

/// The surface a hit belongs to: up through subsurfaces and popups to its toplevel or layer
/// surface, which is what a client names (focus grab whitelist, window lookups).
pub fn root_surface(state: &Hyalo, surface: &WlSurface) -> WlSurface {
    let mut s = surface.clone();
    loop {
        while let Some(parent) = get_parent(&s) {
            s = parent;
        }
        match state.popups.find_popup(&s).and_then(|p| find_popup_root_surface(&p).ok()) {
            Some(root) if root != s => s = root,
            _ => return s,
        }
    }
}

impl Hyalo {
    /// Called on every commit: first configures, popups, the first placement of a window.
    pub fn xdg_commit(&mut self, surface: &WlSurface) {
        if let Some(window) = self.window_for_surface(surface) {
            let initial_configure_sent = with_states(surface, |states| {
                states
                    .data_map
                    .get::<XdgToplevelSurfaceData>()
                    .unwrap()
                    .lock()
                    .unwrap()
                    .initial_configure_sent
            });
            let mapped = self.wm.by_window(&window).is_some_and(|m| m.mapped);
            if !initial_configure_sent {
                self.initial_configure(&window);
            } else if !mapped && window.geometry().size.w > 0 {
                self.window_mapped(&window);
            } else if mapped {
                self.window_committed(&window);
            }
        }

        self.popups.commit(surface);
        if let Some(PopupKind::Xdg(xdg)) = self.popups.find_popup(surface)
            && !xdg.is_initial_configure_sent() {
                // The initial configure is always allowed.
                xdg.send_configure().expect("initial configure failed");
            }
    }

    pub(crate) fn unconstrain_popup(&self, popup: &PopupSurface) {
        let Ok(root) = find_popup_root_surface(&PopupKind::Xdg(popup.clone())) else {
            return;
        };
        // The popup's parent is a window or a layer surface; either way it must stay on the
        // output its root is on.
        let (root_loc, output) = if let Some(m) = self.wm.by_surface(&root) {
            let output = self.wm.workspaces.get(&m.workspace).and_then(|w| self.output_named(&w.output));
            (m.rect.loc, output)
        } else {
            let found = self.space.outputs().find_map(|o| {
                let map = layer_map_for_output(o);
                let layer = map.layer_for_surface(&root, WindowSurfaceType::TOPLEVEL)?;
                let geo = layer::layer_geometry(&map, layer)?;
                Some((geo.loc + self.space.output_geometry(o)?.loc, o.clone()))
            });
            let Some((loc, output)) = found else { return };
            (loc, Some(output))
        };
        let Some(output) = output.or_else(|| self.space.outputs().next().cloned()) else { return };
        let Some(output_geo) = self.space.output_geometry(&output) else { return };

        // The positioner's target is relative to the parent's geometry.
        let mut target = output_geo;
        target.loc -= get_popup_toplevel_coords(&PopupKind::Xdg(popup.clone()));
        target.loc -= root_loc;
        popup.with_pending_state(|state| {
            state.geometry = state.positioner.get_unconstrained_geometry(target);
        });
    }
}
