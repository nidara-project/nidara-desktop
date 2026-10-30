// SPDX-License-Identifier: LGPL-3.0-or-later
//! Make an xdg-activation token from a real input event this window received, for an
//! app the user is launching (SHELL-SURFACES.md §4). Only the compositor decides
//! whether the token is honoured; a token is never a promise of focus.
use crate::{Event, Window};
use std::collections::VecDeque;
use std::time::{Duration, Instant};
use wayland_client::{Connection, Dispatch, QueueHandle};
use wayland_protocols::xdg::activation::v1::client::xdg_activation_token_v1;

/// Requests waiting for the compositor, per window.
pub const MAX_PENDING: usize = 4;
/// One roundtrip is enough; a token is only good for 10 s anyway.
pub const DEADLINE: Duration = Duration::from_secs(2);
/// Input serials remembered as "delivered to this window".
const DELIVERED: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TokenRequest(pub u64);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TokenFailure {
    /// No xdg_activation_v1, or no seat/root surface.
    Unsupported,
    /// The serial did not come from an input event this window received.
    UndeliveredSerial,
    /// MAX_PENDING requests are already waiting.
    Busy,
    /// No answer within DEADLINE.
    Deadline,
    Cancelled,
}
/// Opaque and private: `Debug` never shows it; pass it on untouched.
#[derive(Clone, PartialEq, Eq)]
pub struct ActivationToken(String);
impl ActivationToken {
    pub fn into_string(self) -> String {
        self.0
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}
impl std::fmt::Debug for ActivationToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ActivationToken(<private>)")
    }
}

struct Pending {
    request: TokenRequest,
    proxy: xdg_activation_token_v1::XdgActivationTokenV1,
    deadline: Instant,
}
#[derive(Default)]
pub(crate) struct Tokens {
    delivered: VecDeque<u32>,
    pending: Vec<Pending>,
    next: u64,
}
impl Tokens {
    /// Every physical input serial handed to the app passes through here.
    pub(crate) fn delivered(&mut self, serial: u32) {
        if self.delivered.len() == DELIVERED {
            self.delivered.pop_front();
        }
        self.delivered.push_back(serial);
    }
    fn admit(&self, serial: u32) -> Result<(), TokenFailure> {
        if !self.delivered.contains(&serial) {
            return Err(TokenFailure::UndeliveredSerial);
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(TokenFailure::Busy);
        }
        Ok(())
    }
    /// Time until the next deadline, for the event loop's poll timeout.
    pub(crate) fn wait(&self, now: Instant) -> Option<Duration> {
        self.pending
            .iter()
            .map(|p| p.deadline.saturating_duration_since(now))
            .min()
    }
    /// Remove one request, destroying its protocol object; None if already finished.
    fn finish(&mut self, request: TokenRequest) -> Option<()> {
        let at = self.pending.iter().position(|p| p.request == request)?;
        self.pending.swap_remove(at).proxy.destroy();
        Some(())
    }
    pub(crate) fn expire(&mut self, now: Instant, events: &mut Vec<Event>) {
        let late: Vec<_> = self
            .pending
            .iter()
            .filter(|p| p.deadline <= now)
            .map(|p| p.request)
            .collect();
        for request in late {
            self.finish(request);
            events.push(Event::ActivationTokenFailed {
                request,
                reason: TokenFailure::Deadline,
            });
        }
    }
    /// Surface teardown: objects destroyed, nothing published after the loop ends.
    pub(crate) fn destroy(&mut self) {
        for p in self.pending.drain(..) {
            p.proxy.destroy();
        }
    }
}

impl Window {
    /// Ask for a token tied to `serial`, which must be from a `Button` or `Key` event
    /// this window delivered. `app_id` is the launched app's id (DesktopId without
    /// `.desktop`). The answer is exactly one `ActivationToken` or
    /// `ActivationTokenFailed` event for the returned request.
    pub fn request_activation_token(
        &mut self,
        serial: u32,
        app_id: Option<&str>,
    ) -> Result<TokenRequest, TokenFailure> {
        let (Some(activation), Some(seat), Some(surface)) =
            (&self.activation, &self.seat, &self.surface)
        else {
            return Err(TokenFailure::Unsupported);
        };
        self.tokens.admit(serial)?;
        self.tokens.next += 1;
        let request = TokenRequest(self.tokens.next);
        let proxy = activation.get_activation_token(&self.qh, request);
        proxy.set_serial(serial, seat);
        proxy.set_surface(surface);
        if let Some(id) = app_id.filter(|id| !id.is_empty() && !id.contains('\0')) {
            proxy.set_app_id(id.into());
        }
        proxy.commit();
        self.tokens.pending.push(Pending {
            request,
            proxy,
            deadline: Instant::now() + DEADLINE,
        });
        let _ = self.connection.flush();
        Ok(request)
    }
    /// Cancel a pending request; its one terminal event is `Cancelled`.
    pub fn cancel_activation_token(&mut self, request: TokenRequest) {
        if self.tokens.finish(request).is_some() {
            self.events.push(Event::ActivationTokenFailed {
                request,
                reason: TokenFailure::Cancelled,
            });
        }
    }
}

impl Dispatch<xdg_activation_token_v1::XdgActivationTokenV1, TokenRequest> for Window {
    fn event(
        w: &mut Self,
        _: &xdg_activation_token_v1::XdgActivationTokenV1,
        e: xdg_activation_token_v1::Event,
        request: &TokenRequest,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_activation_token_v1::Event::Done { token } = e
            // A late answer for a request that already ended is dropped.
            && w.tokens.finish(*request).is_some()
        {
            w.events.push(Event::ActivationToken {
                request: *request,
                token: ActivationToken(token),
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_delivered_serials_are_admitted() {
        let mut t = Tokens::default();
        assert_eq!(t.admit(7), Err(TokenFailure::UndeliveredSerial));
        t.delivered(7);
        assert_eq!(t.admit(7), Ok(()));
        for s in 100..100 + DELIVERED as u32 {
            t.delivered(s);
        }
        assert_eq!(
            t.admit(7),
            Err(TokenFailure::UndeliveredSerial),
            "old serial kept"
        );
    }
    #[test]
    fn token_is_private_in_debug() {
        let t = ActivationToken("secret-123".into());
        assert!(!format!("{t:?}").contains("secret"));
        assert_eq!(t.as_str(), "secret-123");
    }
}
