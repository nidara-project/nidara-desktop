// SPDX-License-Identifier: LGPL-3.0-or-later
//! Consume a real initiator's token; only the compositor decides whether focus changes.
use crate::{Result, Window};
use wayland_client::delegate_noop;
pub(crate) use wayland_protocols::xdg::activation::v1::client::xdg_activation_v1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Activation {
    /// Request sent, without an acknowledgement or focus guarantee.
    Requested,
    /// The compositor did not advertise xdg_activation_v1.
    Unsupported,
}
fn dispatch(
    token: &str,
    toplevel: bool,
    supported: bool,
    painted: bool,
    send: impl FnOnce(),
) -> Result<Activation> {
    if token.is_empty() || token.contains('\0') {
        return Err("invalid activation token".into());
    }
    if !toplevel {
        return Err("activation requires a live xdg toplevel".into());
    }
    if !supported {
        return Ok(Activation::Unsupported);
    }
    if !painted {
        return Err("activation requires the first painted buffer".into());
    }
    send();
    Ok(Activation::Requested)
}
impl Window {
    /// Consume one opaque caller token. Requested is not a focus/raise acknowledgement.
    pub fn activate(&mut self, token: String) -> Result<Activation> {
        dispatch(
            &token,
            self.toplevel.is_some() && self.surface.is_some() && self.popup.is_none(),
            self.activation.is_some(),
            self.configured && !self.buffers.is_empty(),
            || {
                // dispatch calls this only after the corresponding live-proxy checks.
                self.activation
                    .as_ref()
                    .unwrap()
                    .activate(token.clone(), self.surface.as_ref().unwrap());
            },
        )
    }
}
delegate_noop!(Window: ignore xdg_activation_v1::XdgActivationV1);

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    #[test]
    fn supported_mapped_toplevel_sends_once_and_opaque_token_is_not_normalized() {
        let token = " opaque 日本語 token ";
        let sent = Cell::new(0);
        assert_eq!(
            dispatch(token, true, true, true, || {
                assert_eq!(token, " opaque 日本語 token ");
                sent.set(sent.get() + 1);
            })
            .unwrap(),
            Activation::Requested
        );
        assert_eq!(sent.get(), 1);
    }
    #[test]
    fn unpainted_target_is_rejected_after_a_valid_send() {
        let sent = Cell::new(0);
        let send = || sent.set(sent.get() + 1);
        assert_eq!(
            dispatch("real-token", true, true, true, send).unwrap(),
            Activation::Requested
        );
        assert_eq!(sent.get(), 1);
        let result = dispatch("real-token", true, true, false, send);
        assert!(result.is_err(), "unpainted target activated");
        assert_eq!(sent.get(), 1, "unpainted target sent activation");
    }
    #[test]
    fn unsupported_and_invalid_targets_never_send() {
        let send = || panic!("ineligible activation reached protocol send");
        assert_eq!(
            dispatch("real-token", true, false, false, send).unwrap(),
            Activation::Unsupported
        );
        assert!(
            dispatch("real-token", true, true, false, send).is_err(),
            "unpainted target activated"
        );
        assert!(dispatch("real-token", false, true, true, send).is_err());
        for token in ["", "bad\0token"] {
            assert!(dispatch(token, true, true, true, send).is_err());
        }
    }
}
