//! xdg-activation-v1: an application asking for one of its windows to come to the front —
//! a link clicked in a terminal raising the browser, a notification's action raising its app.
//!
//! The rule is the one GNOME, KDE and niri use against focus stealing: **a request is honoured
//! only with a token that came from what the user just did.** A token is valid when the client
//! that asked for it is the one the user is working in — it has the keyboard, or the pointer is
//! on it (the dock and the notifications are the shell's layer surfaces, which never take the
//! keyboard: their click is under the pointer) — and its serial is one that client received
//! since it got that focus (niri's test). And it is used within ACTIVATION_TIMEOUT. Anything
//! else changes nothing: a background app does not take the front by asking.
//!
//! (The Hyprland session never honours these at all — `misc:focus_on_activate` is off by
//! default there — so the browser stays behind the terminal whose link opened it.)
//!
//! A window that has not been shown yet needs none of this: Hyalo focuses a new window when it
//! maps, unless a rule sends it elsewhere `silent`ly.

use std::time::Duration;

use smithay::{
    reexports::wayland_server::{Resource, protocol::wl_surface::WlSurface},
    wayland::xdg_activation::{XdgActivationHandler, XdgActivationState, XdgActivationToken, XdgActivationTokenData},
};

use crate::state::Hyalo;

/// How long a token stays good after it was made: a launch takes a moment, a stale token is a
/// request nobody is waiting for any more.
pub const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(10);

/// Attached to a token when it is made: whether the user was in the client that made it.
struct FromTheUser(bool);

impl XdgActivationHandler for Hyalo {
    fn activation_state(&mut self) -> &mut XdgActivationState {
        &mut self.activation_state
    }

    fn token_created(&mut self, _token: XdgActivationToken, data: XdgActivationTokenData) -> bool {
        let dh = &self.display_handle;
        let client_of = |s: Option<WlSurface>| s.and_then(|s| dh.get_client(s.id()).ok()).map(|c| c.id());
        let maker = data.client_id.clone();
        // The serial must be one the client got AFTER it got the keyboard (or the pointer): an
        // old click, from before the user went elsewhere, says nothing about now.
        let since = |focus: Option<WlSurface>, enter: Option<smithay::utils::Serial>| {
            maker.is_some()
                && client_of(focus) == maker
                && matches!((&data.serial, enter), (Some((s, _)), Some(e)) if s.is_no_older_than(&e))
        };
        let keyboard = self.seat.get_keyboard();
        let pointer = self.seat.get_pointer();
        let valid = keyboard.as_ref().is_some_and(|k| since(k.current_focus(), k.last_enter()))
            || pointer.as_ref().is_some_and(|p| since(p.current_focus(), p.last_enter()));
        data.user_data.insert_if_missing(|| FromTheUser(valid));
        // Kept either way: a request with a token we know is refused knowingly, and said so.
        true
    }

    fn request_activation(&mut self, token: XdgActivationToken, token_data: XdgActivationTokenData, surface: WlSurface) {
        let valid = token_data.user_data.get::<FromTheUser>().is_some_and(|v| v.0)
            && token_data.timestamp.elapsed() < ACTIVATION_TIMEOUT;
        self.activation_state.remove_token(&token);
        let Some(m) = self.wm.by_surface(&surface).filter(|m| m.mapped) else { return };
        let id = m.id;
        if valid {
            tracing::debug!(id, "activation honoured");
            self.focus_window(Some(id));
        } else {
            tracing::debug!(id, "activation refused: the token did not come from what the user did");
        }
    }
}
