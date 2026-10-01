//! Windows (xdg-shell) and their popups. Layer surfaces — the shell's bar, dock and panels —
//! are in `layer.rs`.

pub mod grabs;
pub mod layer;

use smithay::{
    desktop::{
        PopupKind, Window, WindowSurfaceType, find_popup_root_surface, get_popup_toplevel_coords,
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
    utils::{Logical, Point, Rectangle, Serial},
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
    shell::grabs::{MoveSurfaceGrab, ResizeSurfaceGrab},
};

impl XdgShellHandler for Hyalo {
    fn xdg_shell_state(&mut self) -> &mut XdgShellState {
        &mut self.xdg_shell_state
    }

    fn new_toplevel(&mut self, surface: ToplevelSurface) {
        let window = Window::new_wayland_window(surface);
        // Placed for real on its first commit, once its size is known (`place_new_window`).
        self.space.map_element(window, (0, 0), true);
    }

    fn toplevel_destroyed(&mut self, surface: ToplevelSurface) {
        if let Some(window) = self.window_for_surface(surface.wl_surface()) {
            let outputs = self.space.outputs_for_element(&window);
            self.space.unmap_elem(&window);
            for o in &outputs {
                self.queue_redraw(Some(o));
            }
        }
        // The keyboard goes to whatever window is now on top.
        let next = self.space.elements().last().cloned();
        let serial = smithay::utils::SERIAL_COUNTER.next_serial();
        if let (Some(window), Some(keyboard)) = (next, self.seat.get_keyboard())
            && keyboard.current_focus().is_none_or(|f| !f.is_alive())
                && let Some(t) = window.toplevel() {
                    keyboard.set_focus(self, Some(t.wl_surface().clone()), serial);
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
        let wl_surface = surface.wl_surface();
        let Some(start_data) = check_grab(&seat, wl_surface, serial) else { return };
        let Some(window) = self.window_for_surface(wl_surface) else { return };
        let initial_window_location = self.space.element_location(&window).unwrap();
        let grab = MoveSurfaceGrab { start_data, window, initial_window_location };
        seat.get_pointer().unwrap().set_grab(self, grab, serial, Focus::Clear);
    }

    fn resize_request(
        &mut self,
        surface: ToplevelSurface,
        seat: wl_seat::WlSeat,
        serial: Serial,
        edges: xdg_toplevel::ResizeEdge,
    ) {
        let seat = Seat::from_resource(&seat).unwrap();
        let wl_surface = surface.wl_surface();
        let Some(start_data) = check_grab(&seat, wl_surface, serial) else { return };
        let Some(window) = self.window_for_surface(wl_surface) else { return };
        let initial_window_location = self.space.element_location(&window).unwrap();
        let initial_window_size = window.geometry().size;
        surface.with_pending_state(|state| {
            state.states.set(xdg_toplevel::State::Resizing);
        });
        surface.send_pending_configure();
        let grab = ResizeSurfaceGrab::start(
            start_data,
            window,
            edges.into(),
            Rectangle::new(initial_window_location, initial_window_size),
        );
        seat.get_pointer().unwrap().set_grab(self, grab, serial, Focus::Clear);
    }

    fn grab(&mut self, _surface: PopupSurface, _seat: wl_seat::WlSeat, _serial: Serial) {
        // Popup grabs (menus that close on an outside click) are #682's; the shell's own
        // panels close through hyprland-focus-grab-v1, which is ours already.
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
            let (initial_configure_sent, placed) = with_states(surface, |states| {
                let sent = states
                    .data_map
                    .get::<XdgToplevelSurfaceData>()
                    .unwrap()
                    .lock()
                    .unwrap()
                    .initial_configure_sent;
                (sent, states.data_map.get::<Placed>().is_some())
            });
            if !initial_configure_sent {
                window.toplevel().unwrap().send_configure();
            } else if !placed && window.geometry().size.w > 0 {
                with_states(surface, |states| states.data_map.insert_if_missing(|| Placed));
                self.place_new_window(&window);
            }
        }

        self.popups.commit(surface);
        if let Some(PopupKind::Xdg(xdg)) = self.popups.find_popup(surface)
            && !xdg.is_initial_configure_sent() {
                // The initial configure is always allowed.
                xdg.send_configure().expect("initial configure failed");
            }
    }

    /// A new window goes to the middle of the usable area (outside the bar and dock's
    /// exclusive zones) of the output under the pointer, and takes the keyboard.
    fn place_new_window(&mut self, window: &Window) {
        let pointer = self.seat.get_pointer().unwrap().current_location();
        let output = self
            .space
            .output_under(pointer)
            .next()
            .or_else(|| self.space.outputs().next())
            .cloned();
        let Some(output) = output else { return };
        let Some(out_geo) = self.space.output_geometry(&output) else { return };
        let zone = layer_map_for_output(&output).non_exclusive_zone();
        let area = Rectangle::new(out_geo.loc + zone.loc, zone.size);
        let size = window.geometry().size;
        let loc: Point<i32, Logical> = (
            area.loc.x + ((area.size.w - size.w) / 2).max(0),
            area.loc.y + ((area.size.h - size.h) / 2).max(0),
        )
            .into();
        self.space.map_element(window.clone(), loc - window.geometry().loc, true);
        if let (Some(keyboard), Some(t)) = (self.seat.get_keyboard(), window.toplevel()) {
            keyboard.set_focus(self, Some(t.wl_surface().clone()), smithay::utils::SERIAL_COUNTER.next_serial());
        }
        self.space.elements().for_each(|w| {
            w.set_activated(w == window);
            if let Some(t) = w.toplevel() {
                t.send_pending_configure();
            }
        });
    }

    pub(crate) fn unconstrain_popup(&self, popup: &PopupSurface) {
        let Ok(root) = find_popup_root_surface(&PopupKind::Xdg(popup.clone())) else {
            return;
        };
        // The popup's parent is a window or a layer surface; either way it must stay on the
        // output its root is on.
        let (root_loc, output) = if let Some(window) = self.window_for_surface(&root) {
            let Some(geo) = self.space.element_geometry(&window) else { return };
            let output = self.space.outputs_for_element(&window).into_iter().next();
            (geo.loc, output)
        } else {
            let found = self.space.outputs().find_map(|o| {
                let map = layer_map_for_output(o);
                let layer = map.layer_for_surface(&root, WindowSurfaceType::TOPLEVEL)?;
                let geo = map.layer_geometry(layer)?;
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

/// Marks a window that has had its first placement.
struct Placed;
