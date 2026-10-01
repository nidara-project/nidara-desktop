//! Sandboxed clients (wp-security-context-v1): what a Flatpak app may not see.
//!
//! A sandbox engine (Flatpak's bwrap) asks the compositor for a socket of its own and hands
//! only that one to the app. Every client that connects through it carries the context
//! (`ClientState::security_context`), and the globals that would let an app act as the user
//! or watch the desktop are not advertised to it at all — the app cannot bind what it never
//! sees:
//!
//! - synthetic input: the virtual pointer and keyboard (the Assistant's computer use);
//! - watching: the window list and window capture (the shell's thumbnails);
//! - the shell's own surfaces: layer-shell, the focus grab, the glass material;
//! - this protocol itself — a sandboxed client must not mint a less restricted context.
//!
//! Everything a normal application needs (a window, input, the clipboard, outputs, dmabuf…)
//! stays. The list is `restricted_globals_hidden` in the CI probe
//! (`scripts/ci/hyalo-sandbox-probe.c`), which compares what a client sees from inside a
//! context with what it sees from outside.

use std::sync::Arc;

use smithay::{
    reexports::wayland_server::Client,
    wayland::security_context::{SecurityContext, SecurityContextHandler, SecurityContextListenerSource},
};

use crate::state::{ClientState, Hyalo};

/// Whether `client` may see the privileged globals: it did not come through a security context.
pub fn unrestricted(client: &Client) -> bool {
    client.get_data::<ClientState>().is_none_or(|d| d.security_context.is_none())
}

impl SecurityContextHandler for Hyalo {
    fn context_created(&mut self, source: SecurityContextListenerSource, context: SecurityContext) {
        tracing::info!(
            engine = ?context.sandbox_engine, app = ?context.app_id, instance = ?context.instance_id,
            "a sandboxed client socket"
        );
        // The source ends by itself when the engine closes the context's close_fd.
        let res = self.loop_handle.insert_source(source, move |stream, _, state| {
            let data = ClientState { security_context: Some(context.clone()), ..Default::default() };
            if let Err(err) = state.display_handle.insert_client(stream, Arc::new(data)) {
                tracing::warn!(?err, "could not accept a sandboxed client");
            }
        });
        if let Err(err) = res {
            tracing::warn!(?err, "could not listen on a sandboxed client socket");
        }
    }
}
