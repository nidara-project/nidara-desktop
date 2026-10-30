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
    /// The window was closed, by the compositor (a layer root's output went away) or by
    /// `Window::close`.
    Closed,
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

/// What a pending request owns on the wire; a fake in tests.
pub(crate) trait Handle {
    fn destroy(&self);
}
impl Handle for xdg_activation_token_v1::XdgActivationTokenV1 {
    fn destroy(&self) {
        xdg_activation_token_v1::XdgActivationTokenV1::destroy(self);
    }
}
struct Pending<P> {
    request: TokenRequest,
    proxy: P,
    deadline: Instant,
}
/// Every request ends exactly once: token, deadline, cancel or closed. Its protocol
/// object is destroyed at that moment, and anything arriving later is dropped.
pub(crate) struct Tokens<P = xdg_activation_token_v1::XdgActivationTokenV1> {
    delivered: VecDeque<u32>,
    pending: Vec<Pending<P>>,
    next: u64,
}
impl<P> Default for Tokens<P> {
    fn default() -> Self {
        Self {
            delivered: VecDeque::new(),
            pending: Vec::new(),
            next: 0,
        }
    }
}
impl<P: Handle> Tokens<P> {
    /// Every physical input serial handed to the app passes through here.
    pub(crate) fn delivered(&mut self, serial: u32) {
        if self.delivered.len() == DELIVERED {
            self.delivered.pop_front();
        }
        self.delivered.push_back(serial);
    }
    /// Checked BEFORE any protocol object is created.
    fn admit(&mut self, serial: u32) -> Result<TokenRequest, TokenFailure> {
        if !self.delivered.contains(&serial) {
            return Err(TokenFailure::UndeliveredSerial);
        }
        if self.pending.len() >= MAX_PENDING {
            return Err(TokenFailure::Busy);
        }
        self.next += 1;
        Ok(TokenRequest(self.next))
    }
    fn insert(&mut self, request: TokenRequest, proxy: P, deadline: Instant) {
        self.pending.push(Pending {
            request,
            proxy,
            deadline,
        });
    }
    /// Time until the next deadline, for the event loop's poll timeout.
    pub(crate) fn wait(&self, now: Instant) -> Option<Duration> {
        self.pending
            .iter()
            .map(|p| p.deadline.saturating_duration_since(now))
            .min()
    }
    /// Remove one request, destroying its object; its deadline, or None if it already ended.
    fn finish(&mut self, request: TokenRequest) -> Option<Instant> {
        let at = self.pending.iter().position(|p| p.request == request)?;
        let p = self.pending.swap_remove(at);
        p.proxy.destroy();
        Some(p.deadline)
    }
    /// The compositor's answer. Past its deadline it is a Deadline, never a token.
    fn done(
        &mut self,
        request: TokenRequest,
        token: String,
        now: Instant,
        events: &mut Vec<Event>,
    ) {
        let Some(deadline) = self.finish(request) else {
            return;
        };
        events.push(if now < deadline {
            Event::ActivationToken {
                request,
                token: ActivationToken(token),
            }
        } else {
            Event::ActivationTokenFailed {
                request,
                reason: TokenFailure::Deadline,
            }
        });
    }
    fn fail(&mut self, request: TokenRequest, reason: TokenFailure, events: &mut Vec<Event>) {
        if self.finish(request).is_some() {
            events.push(Event::ActivationTokenFailed { request, reason });
        }
    }
    pub(crate) fn expire(&mut self, now: Instant, events: &mut Vec<Event>) {
        let late: Vec<_> = self
            .pending
            .iter()
            .filter(|p| p.deadline <= now)
            .map(|p| p.request)
            .collect();
        for request in late {
            self.fail(request, TokenFailure::Deadline, events);
        }
    }
    /// The surface is going away: every pending request ends `Closed` now, before the
    /// close itself is published, so no token can follow it.
    pub(crate) fn close_all(&mut self, events: &mut Vec<Event>) {
        let all: Vec<_> = self.pending.iter().map(|p| p.request).collect();
        for request in all {
            self.fail(request, TokenFailure::Closed, events);
        }
    }
    /// Teardown after the loop: objects destroyed, nothing left to publish to.
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
        if self.closed {
            return Err(TokenFailure::Closed);
        }
        let request = self.tokens.admit(serial)?;
        let proxy = activation.get_activation_token(&self.qh, request);
        proxy.set_serial(serial, seat);
        proxy.set_surface(surface);
        if let Some(id) = app_id.filter(|id| !id.is_empty() && !id.contains('\0')) {
            proxy.set_app_id(id.into());
        }
        proxy.commit();
        self.tokens
            .insert(request, proxy, Instant::now() + DEADLINE);
        let _ = self.connection.flush();
        Ok(request)
    }
    /// Cancel a pending request; its one terminal event is `Cancelled`.
    pub fn cancel_activation_token(&mut self, request: TokenRequest) {
        self.tokens
            .fail(request, TokenFailure::Cancelled, &mut self.events);
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
        if let xdg_activation_token_v1::Event::Done { token } = e {
            w.tokens
                .done(*request, token, Instant::now(), &mut w.events);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;
    struct Fake(Rc<Cell<u32>>);
    impl Handle for Fake {
        fn destroy(&self) {
            self.0.set(self.0.get() + 1);
        }
    }
    fn setup() -> (Tokens<Fake>, Rc<Cell<u32>>, Instant) {
        let mut t = Tokens::<Fake>::default();
        t.delivered(5);
        (t, Rc::new(Cell::new(0)), Instant::now())
    }
    fn add(t: &mut Tokens<Fake>, d: &Rc<Cell<u32>>, now: Instant) -> TokenRequest {
        let r = t.admit(5).unwrap();
        t.insert(r, Fake(d.clone()), now + DEADLINE);
        r
    }
    fn terminals(events: &[Event], r: TokenRequest) -> usize {
        events
            .iter()
            .filter(|e| {
                matches!(e, Event::ActivationToken { request, .. }
                    | Event::ActivationTokenFailed { request, .. } if *request == r)
            })
            .count()
    }
    #[test]
    fn fifth_request_is_busy_before_any_object_exists() {
        let (mut t, d, now) = setup();
        for _ in 0..MAX_PENDING {
            add(&mut t, &d, now);
        }
        assert_eq!(t.admit(5), Err(TokenFailure::Busy));
        assert_eq!(t.pending.len(), MAX_PENDING);
    }
    #[test]
    fn cancel_then_late_done_publishes_once() {
        let (mut t, d, now) = setup();
        let r = add(&mut t, &d, now);
        let mut ev = vec![];
        t.fail(r, TokenFailure::Cancelled, &mut ev);
        t.done(r, "late".into(), now, &mut ev);
        assert_eq!(terminals(&ev, r), 1);
        assert!(matches!(
            ev[0],
            Event::ActivationTokenFailed {
                reason: TokenFailure::Cancelled,
                ..
            }
        ));
        assert_eq!(d.get(), 1, "object destroyed exactly once");
    }
    #[test]
    fn deadline_then_late_done_never_yields_a_token() {
        let (mut t, d, now) = setup();
        let r = add(&mut t, &d, now);
        let mut ev = vec![];
        // A done processed after the deadline, before expire() ran, is a Deadline.
        t.done(r, "late".into(), now + DEADLINE, &mut ev);
        t.expire(now + DEADLINE * 2, &mut ev);
        assert_eq!(terminals(&ev, r), 1);
        assert!(matches!(
            ev[0],
            Event::ActivationTokenFailed {
                reason: TokenFailure::Deadline,
                ..
            }
        ));
        let r2 = add(&mut t, &d, now);
        t.expire(now + DEADLINE, &mut ev);
        t.done(r2, "later".into(), now, &mut ev);
        assert_eq!(terminals(&ev, r2), 1);
        assert_eq!(d.get(), 2);
    }
    #[test]
    fn closed_before_done_in_the_same_batch_wins() {
        let (mut t, d, now) = setup();
        let a = add(&mut t, &d, now);
        let b = add(&mut t, &d, now);
        let mut ev = vec![];
        t.close_all(&mut ev);
        t.done(a, "after-close".into(), now, &mut ev);
        assert_eq!((terminals(&ev, a), terminals(&ev, b)), (1, 1));
        assert!(
            ev.iter()
                .all(|e| !matches!(e, Event::ActivationToken { .. }))
        );
        assert_eq!(d.get(), 2);
        assert!(t.pending.is_empty());
    }
    #[test]
    fn in_time_done_is_the_token() {
        let (mut t, d, now) = setup();
        let r = add(&mut t, &d, now);
        let mut ev = vec![];
        t.done(r, "tok".into(), now, &mut ev);
        assert!(matches!(&ev[0], Event::ActivationToken { token, .. } if token.as_str() == "tok"));
        assert_eq!(d.get(), 1);
    }
    #[test]
    fn only_delivered_serials_are_admitted() {
        let mut t = Tokens::<Fake>::default();
        assert_eq!(t.admit(7), Err(TokenFailure::UndeliveredSerial));
        t.delivered(7);
        assert!(t.admit(7).is_ok());
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
