//! What the keyboard can be given: a Wayland surface, or an X11 window (xwayland.rs).
//!
//! An X11 window is not focused by a `wl_keyboard.enter` alone: the X server routes keys to its
//! own input focus, which the window manager sets — `SetInputFocus`, or `WM_TAKE_FOCUS` for a
//! window that takes it itself (Smithay's `X11Surface` does both, then enters its surface). Given
//! only its `wl_surface`, an X11 game or Steam got the enter and no key (the X focus stayed where
//! it was). Everything in Hyalo still names a focus by its surface (`set_keyboard_focus`); the X11
//! window is looked up there.

use std::borrow::Cow;

use smithay::{
    backend::input::{InputTime, KeyState},
    input::{
        Seat,
        keyboard::{KeyboardTarget, KeysymHandle, ModifiersState},
    },
    reexports::wayland_server::{backend::ObjectId, protocol::wl_surface::WlSurface},
    utils::{IsAlive, Serial},
    wayland::seat::WaylandFocus,
    xwayland::X11Surface,
};

use crate::Hyalo;

#[derive(Debug, Clone, PartialEq)]
pub enum KeyboardFocus {
    Surface(WlSurface),
    /// Boxed: an X11Surface is some 430 bytes, and the focus is copied on every key.
    X11(Box<X11Surface>),
}

impl KeyboardFocus {
    /// The surface it is, or the X11 window's (none until Xwayland has associated one).
    pub fn surface(&self) -> Option<WlSurface> {
        match self {
            Self::Surface(s) => Some(s.clone()),
            Self::X11(x) => x.wl_surface(),
        }
    }
}

impl From<WlSurface> for KeyboardFocus {
    fn from(s: WlSurface) -> Self {
        Self::Surface(s)
    }
}

impl From<smithay::desktop::PopupKind> for KeyboardFocus {
    fn from(p: smithay::desktop::PopupKind) -> Self {
        Self::Surface(p.wl_surface().clone())
    }
}

/// The pointer's focus is always a surface: what a popup grab hands the pointer when it hands
/// the keyboard. An X11 window is only ever given the keyboard once its surface is known
/// (`Hyalo::keyboard_target`), and keeps it.
impl From<KeyboardFocus> for WlSurface {
    fn from(f: KeyboardFocus) -> Self {
        match f {
            KeyboardFocus::Surface(s) => s,
            KeyboardFocus::X11(x) => x.wl_surface().expect("an X11 window is focused only with its surface"),
        }
    }
}

impl Hyalo {
    /// What the keyboard is given for `surface`: the X11 window it belongs to, if any.
    pub fn keyboard_target(&self, surface: WlSurface) -> KeyboardFocus {
        let x11 = self.wm.by_surface(&surface).and_then(|m| m.window.x11_surface().cloned());
        match x11 {
            Some(x) if x.wl_surface().as_ref() == Some(&surface) => KeyboardFocus::X11(Box::new(x)),
            _ => KeyboardFocus::Surface(surface),
        }
    }
}

impl IsAlive for KeyboardFocus {
    fn alive(&self) -> bool {
        match self {
            Self::Surface(s) => s.alive(),
            Self::X11(x) => x.alive(),
        }
    }
}

impl WaylandFocus for KeyboardFocus {
    fn wl_surface(&self) -> Option<Cow<'_, WlSurface>> {
        match self {
            Self::Surface(s) => Some(Cow::Borrowed(s)),
            Self::X11(x) => x.wl_surface().map(Cow::Owned),
        }
    }

    fn same_client_as(&self, object_id: &ObjectId) -> bool {
        match self {
            Self::Surface(s) => s.same_client_as(object_id),
            Self::X11(x) => x.same_client_as(object_id),
        }
    }
}

impl KeyboardTarget<Hyalo> for KeyboardFocus {
    fn enter(&self, seat: &Seat<Hyalo>, data: &mut Hyalo, keys: Vec<KeysymHandle<'_>>, serial: Serial) {
        match self {
            Self::Surface(s) => KeyboardTarget::enter(s, seat, data, keys, serial),
            Self::X11(x) => KeyboardTarget::enter(&**x, seat, data, keys, serial),
        }
    }

    fn leave(&self, seat: &Seat<Hyalo>, data: &mut Hyalo, serial: Serial) {
        match self {
            Self::Surface(s) => KeyboardTarget::leave(s, seat, data, serial),
            Self::X11(x) => KeyboardTarget::leave(&**x, seat, data, serial),
        }
    }

    fn key(
        &self,
        seat: &Seat<Hyalo>,
        data: &mut Hyalo,
        key: KeysymHandle<'_>,
        state: KeyState,
        serial: Serial,
        time: InputTime,
    ) {
        match self {
            Self::Surface(s) => KeyboardTarget::key(s, seat, data, key, state, serial, time),
            Self::X11(x) => KeyboardTarget::key(&**x, seat, data, key, state, serial, time),
        }
    }

    fn modifiers(&self, seat: &Seat<Hyalo>, data: &mut Hyalo, modifiers: ModifiersState, serial: Serial) {
        match self {
            Self::Surface(s) => KeyboardTarget::modifiers(s, seat, data, modifiers, serial),
            Self::X11(x) => KeyboardTarget::modifiers(&**x, seat, data, modifiers, serial),
        }
    }

    fn replace(
        &self,
        replaced: KeyboardFocus,
        seat: &Seat<Hyalo>,
        data: &mut Hyalo,
        keys: Vec<KeysymHandle<'_>>,
        modifiers: ModifiersState,
        serial: Serial,
    ) {
        match self {
            Self::Surface(s) => KeyboardTarget::replace(s, replaced, seat, data, keys, modifiers, serial),
            Self::X11(x) => KeyboardTarget::replace(&**x, replaced, seat, data, keys, modifiers, serial),
        }
    }
}
