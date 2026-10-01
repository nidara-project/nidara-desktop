//! hyprland-focus-grab-v1: the shell's panels (Control Center, Prism, menus) take the keyboard
//! through it and are dismissed by a click outside. The shell treats it as a hard requirement.
//!
//! One grab is active at a time. While it is, the keyboard sits on a whitelisted surface; a
//! press outside the whitelist clears it (`cleared`) and the click goes through as usual.

use std::sync::Mutex;

use smithay::{
    reexports::wayland_server::{
        Client, DataInit, DisplayHandle, New, Resource,
        backend::ClientId,
        protocol::wl_surface::WlSurface,
    },
    utils::SERIAL_COUNTER,
    wayland::{Dispatch2, GlobalDispatch2},
};

use crate::{
    Hyalo,
    protocols::gen_focus_grab::{
        hyprland_focus_grab_manager_v1::{self, HyprlandFocusGrabManagerV1},
        hyprland_focus_grab_v1::{self, HyprlandFocusGrabV1},
    },
};

pub struct ActiveGrab {
    pub grab: HyprlandFocusGrabV1,
    pub surfaces: Vec<WlSurface>,
    /// Where the keyboard was before the grab took it; given back when the grab ends.
    pub previous_focus: Option<WlSurface>,
}

pub struct FocusGrabGlobal;

#[derive(Default)]
pub struct GrabData {
    pending: Mutex<Vec<WlSurface>>,
}

pub fn init(dh: &DisplayHandle) {
    dh.create_global::<Hyalo, HyprlandFocusGrabManagerV1, _>(1, FocusGrabGlobal);
}

impl GlobalDispatch2<HyprlandFocusGrabManagerV1, Hyalo> for FocusGrabGlobal {
    fn bind(
        &self,
        _state: &mut Hyalo,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<HyprlandFocusGrabManagerV1>,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        data_init.init(resource, FocusGrabGlobal);
    }
}

impl Dispatch2<HyprlandFocusGrabManagerV1, Hyalo> for FocusGrabGlobal {
    fn request(
        &self,
        _state: &mut Hyalo,
        _client: &Client,
        _resource: &HyprlandFocusGrabManagerV1,
        request: hyprland_focus_grab_manager_v1::Request,
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        if let hyprland_focus_grab_manager_v1::Request::CreateGrab { grab } = request {
            data_init.init(grab, GrabData::default());
        }
    }
}

impl Dispatch2<HyprlandFocusGrabV1, Hyalo> for GrabData {
    fn request(
        &self,
        state: &mut Hyalo,
        _client: &Client,
        resource: &HyprlandFocusGrabV1,
        request: hyprland_focus_grab_v1::Request,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, Hyalo>,
    ) {
        use hyprland_focus_grab_v1::Request;
        match request {
            Request::AddSurface { surface } => {
                let mut pending = self.pending.lock().unwrap();
                if !pending.contains(&surface) {
                    pending.push(surface);
                }
            }
            Request::RemoveSurface { surface } => self.pending.lock().unwrap().retain(|s| s != &surface),
            Request::Commit => {
                let surfaces: Vec<WlSurface> =
                    self.pending.lock().unwrap().iter().filter(|s| s.is_alive()).cloned().collect();
                state.commit_focus_grab(resource, surfaces);
            }
            Request::Destroy => {}
        }
    }

    fn destroyed(&self, state: &mut Hyalo, _client: ClientId, resource: &HyprlandFocusGrabV1) {
        if state.focus_grab.as_ref().is_some_and(|a| &a.grab == resource) {
            state.end_focus_grab(false);
        }
    }
}

impl Hyalo {
    fn commit_focus_grab(&mut self, grab: &HyprlandFocusGrabV1, surfaces: Vec<WlSurface>) {
        let is_active = self.focus_grab.as_ref().is_some_and(|a| &a.grab == grab);
        if surfaces.is_empty() {
            if is_active {
                self.end_focus_grab(false);
            }
            return;
        }
        let keyboard = self.seat.get_keyboard().unwrap();
        let current = keyboard.current_focus();
        let previous_focus = if is_active {
            self.focus_grab.take().unwrap().previous_focus
        } else {
            // Another client's grab gives way to this one.
            if self.focus_grab.is_some() {
                self.end_focus_grab(true);
            }
            current.clone()
        };
        if !current.as_ref().is_some_and(|c| surfaces.contains(c)) {
            keyboard.set_focus(self, Some(surfaces[0].clone()), SERIAL_COUNTER.next_serial());
        }
        self.focus_grab = Some(ActiveGrab { grab: grab.clone(), surfaces, previous_focus });
    }

    /// Ends the active grab, telling its client when the compositor is the one ending it.
    pub fn end_focus_grab(&mut self, send_cleared: bool) {
        let Some(active) = self.focus_grab.take() else { return };
        if send_cleared && active.grab.is_alive() {
            active.grab.cleared();
        }
        let keyboard = self.seat.get_keyboard().unwrap();
        if keyboard.current_focus().is_some_and(|f| active.surfaces.contains(&f)) {
            let back = active.previous_focus.filter(|s| s.is_alive());
            keyboard.set_focus(self, back, SERIAL_COUNTER.next_serial());
        }
    }

    /// A press lands on `surface` (None = on nothing): outside the whitelist, the grab ends.
    pub fn focus_grab_press(&mut self, surface: Option<&WlSurface>) {
        let Some(active) = &self.focus_grab else { return };
        let inside = surface.map(|s| crate::shell::root_surface(self, s)).is_some_and(|root| active.surfaces.contains(&root));
        if !inside {
            self.end_focus_grab(true);
        }
    }
}
