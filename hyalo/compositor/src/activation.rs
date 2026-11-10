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
//! One more source counts as the user: a DROP. The client a drop landed in may make a token
//! with a serial from that drag, just after it (`DropGrant`) — the dock opening dropped files
//! with an app brings that app to the front.
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

use crate::{ipc::observe::Outcome, state::Hyalo};

/// How long a token stays good after it was made: a launch takes a moment, a stale token is a
/// request nobody is waiting for any more.
pub const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a token is remembered unused: past ACTIVATION_TIMEOUT it is refused, past this
/// it is unknown (and its request ignored, as any made-up token's).
pub const TOKEN_KEPT: Duration = Duration::from_secs(60);

/// Attached to a token when it is made: whether the user was in the client that made it.
struct FromTheUser(bool);
// A token may identify several windows, but grants foreground activation only once.
#[derive(Default)]
struct ActivationConsumed(std::sync::atomic::AtomicBool);
struct IdentityClient(smithay::reexports::wayland_server::backend::ClientId);

fn identity_client(data: &XdgActivationTokenData, client: &smithay::reexports::wayland_server::backend::ClientId) -> bool {
    data.user_data.insert_if_missing(|| IdentityClient(client.clone()));
    data.user_data.get::<IdentityClient>().is_some_and(|first| first.0 == *client)
}

/// How long after a drop the client it landed in may make a token from it: reading the
/// dropped data and asking for the token take a moment, a late one is not the drop's.
pub const DROP_GRANT: Duration = Duration::from_secs(2);

/// A drop the user just made (handlers.rs `dropped`). The client it landed in has neither
/// the keyboard nor, during the drag, the pointer — the source's grab holds it — so the rule
/// above would refuse it; yet a file dropped on the dock's app is the user asking for that
/// app. A token from that client, with a serial from this drag (no older than its start),
/// within DROP_GRANT, is from the user. Once.
pub struct DropGrant {
    pub client: smithay::reexports::wayland_server::backend::ClientId,
    pub since: smithay::utils::Serial,
    pub at: std::time::Instant,
}

impl DropGrant {
    fn covers(&self, maker: Option<&smithay::reexports::wayland_server::backend::ClientId>, serial: Option<smithay::utils::Serial>) -> bool {
        maker == Some(&self.client)
            && serial.is_some_and(|s| s.is_no_older_than(&self.since))
            && self.at.elapsed() < DROP_GRANT
    }
}

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
        let mut valid = keyboard.as_ref().is_some_and(|k| since(k.current_focus().and_then(|f| f.surface()), k.last_enter()))
            || pointer.as_ref().is_some_and(|p| since(p.current_focus(), p.last_enter()));
        if !valid && self.drop_grant.as_ref().is_some_and(|g| g.covers(maker.as_ref(), data.serial.as_ref().map(|s| s.0))) {
            self.drop_grant = None;
            valid = true;
        }
        data.user_data.insert_if_missing(|| FromTheUser(valid));
        // Keep token identity for multiple windows; its foreground grant is single-use.
        // Forget those long past their time. Not
        // at once: a late request must still be known to be refused, and ask for attention.
        self.activation_state.retain_tokens(|_, d| d.timestamp.elapsed() < TOKEN_KEPT);
        // Kept either way: a request with a token we know is refused knowingly, and said so.
        true
    }

    fn request_activation(&mut self, token: XdgActivationToken, token_data: XdgActivationTokenData, surface: WlSurface) {
        let Some((id, mapped, x11)) = self.wm.by_surface(&surface).map(|m| (m.id, m.mapped, m.window.x11_surface().is_some())) else { return };
        use smithay::reexports::wayland_server::Resource;
        let Ok(client) = self.display_handle.get_client(surface.id()) else { return };
        // An inherited token in a child's different Wayland connection is no evidence
        // for the launching app, even while the token remains in time.
        if !identity_client(&token_data, &client.id()) { return; }
        let valid = from_the_user(&token_data);
        let deadline = token_data.timestamp + ACTIVATION_TIMEOUT;
        if x11 { self.activation_state.remove_token(&token); }
        if !mapped {
            // Not shown yet: Hyalo focuses a new window anyway, and its launch is answered when
            // it is shown, if in time (`window_shown_with_token`).
            self.launch_waits_for(token.as_str(), id, valid, deadline);
            return;
        }
        if valid {
            tracing::debug!(id, "activation honoured");
            self.focus_window(Some(id));
            self.launch_used(token.as_str(), Outcome::Activated { window: id }, deadline);
        } else {
            // It does not take the front; it asks for the user instead (the dock shows it).
            tracing::debug!(id, "activation refused: the token did not come from what the user did");
            if self.wm.focused != Some(id) {
                self.set_attention(id, Some(true), None);
            }
            self.launch_used(token.as_str(), Outcome::Refused { window: id }, deadline);
        }
    }
}

/// Whether the token was made from what the user did, and is still in time.
fn from_the_user(data: &XdgActivationTokenData) -> bool {
    data.user_data.insert_if_missing(ActivationConsumed::default);
    let first = !data.user_data.get::<ActivationConsumed>().unwrap().0.swap(true, std::sync::atomic::Ordering::Relaxed);
    first && data.user_data.get::<FromTheUser>().is_some_and(|v| v.0) && data.timestamp.elapsed() < ACTIVATION_TIMEOUT
}

impl Hyalo {
    /// An X11 window shown with a startup id that is a token Hyalo made (`_NET_STARTUP_ID`,
    /// which a launcher sets from the token): the token, used up, and whether it came from the
    /// user, and its deadline. A classic startup-notification id Hyalo did not make is not one.
    pub fn take_x11_startup(&mut self, window: &smithay::desktop::Window) -> Option<(String, bool, std::time::Instant)> {
        let id = window.x11_surface()?.startup_id()?;
        let token = XdgActivationToken::from(id);
        let data = self.activation_state.data_for_token(&token)?;
        // Xwayland shares one Wayland connection between independent X11 clients.
        // Startup IDs remain single-use; never reuse a Wayland app's token here.
        if data.user_data.get::<IdentityClient>().is_some() { return None; }
        let (valid, deadline) = (from_the_user(data), data.timestamp + ACTIVATION_TIMEOUT);
        self.activation_state.remove_token(&token);
        Some((token.into(), valid, deadline))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_identity_never_replays_the_foreground_grant() {
        let data = XdgActivationTokenData {
            client_id: None, serial: None, app_id: None, surface: None,
            timestamp: std::time::Instant::now(), user_data: std::sync::Arc::default(),
        };
        data.user_data.insert_if_missing(|| FromTheUser(true));
        assert!(from_the_user(&data));
        assert!(!from_the_user(&data));
    }
    #[test]
    fn a_second_wayland_client_cannot_inherit_the_first_clients_identity() {
        let display = smithay::reexports::wayland_server::Display::<()>::new().unwrap();
        let mut handle = display.handle();
        let (a, _peer_a) = std::os::unix::net::UnixStream::pair().unwrap();
        let (b, _peer_b) = std::os::unix::net::UnixStream::pair().unwrap();
        let a = handle.insert_client(a, std::sync::Arc::new(())).unwrap();
        let b = handle.insert_client(b, std::sync::Arc::new(())).unwrap();
        let data = XdgActivationTokenData {
            client_id: None, serial: None, app_id: None, surface: None,
            timestamp: std::time::Instant::now(), user_data: std::sync::Arc::default(),
        };
        assert!(identity_client(&data, &a.id()));
        assert!(identity_client(&data, &a.id()));
        assert!(!identity_client(&data, &b.id()));
        assert!(identity_client(&data, &a.id()));
    }
}
