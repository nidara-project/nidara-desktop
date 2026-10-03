//! Who draws a window's title bar: always the compositor, as on the Hyprland session — which
//! draws none. An app that asks (kitty, Qt, Chrome, Firefox) gets "server-side" and drops its
//! own bar and its shadow margin, so its surface IS its box: square to its geometry, rounded and
//! blurred like any other window (render/window.rs). Without an answer kitty draws a bar of its
//! own, and its shadow margin keeps the corners square.
//!
//! Hyprland's policy, both protocols (src/protocols/XDGDecoration.cpp, ServerDecorationKDE.cpp):
//! server-side by default, on request and on unset, whatever the client asked for. GTK apps do
//! not speak either and keep their own decorations. Nidara's own title bars, drawn here, are a
//! design still to be made (#708 point 5).

use smithay::{
    reexports::{
        wayland_protocols::xdg::decoration::zv1::server::zxdg_toplevel_decoration_v1::Mode,
        wayland_protocols_misc::server_decoration::server::{
            org_kde_kwin_server_decoration::{Mode as KdeMode, OrgKdeKwinServerDecoration},
        },
        wayland_server::{WEnum, protocol::wl_surface::WlSurface},
    },
    wayland::shell::{
        kde::decoration::{KdeDecorationHandler, KdeDecorationState},
        xdg::{ToplevelSurface, decoration::XdgDecorationHandler},
    },
};

use crate::Hyalo;

/// Server-side, and the configure the protocol owes the client — unless the initial configure
/// is still to come, which then carries it (shell/mod.rs).
fn server_side(toplevel: &ToplevelSurface) {
    toplevel.with_pending_state(|state| state.decoration_mode = Some(Mode::ServerSide));
    if toplevel.is_initial_configure_sent() {
        toplevel.send_configure();
    }
}

impl XdgDecorationHandler for Hyalo {
    fn new_decoration(&mut self, toplevel: ToplevelSurface) {
        server_side(&toplevel);
    }

    fn request_mode(&mut self, toplevel: ToplevelSurface, _mode: Mode) {
        server_side(&toplevel);
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        server_side(&toplevel);
    }
}

impl KdeDecorationHandler for Hyalo {
    fn kde_decoration_state(&self) -> &KdeDecorationState {
        &self.kde_decoration_state
    }

    fn new_decoration(&mut self, _surface: &WlSurface, decoration: &OrgKdeKwinServerDecoration) {
        decoration.mode(KdeMode::Server);
    }

    /// A request for server-side is acknowledged; one for client-side is not granted, and the
    /// mode stays the one already sent — answering it would start a tug of war with a client
    /// that asks again.
    fn request_mode(&mut self, _surface: &WlSurface, decoration: &OrgKdeKwinServerDecoration, mode: WEnum<KdeMode>) {
        if mode == WEnum::Value(KdeMode::Server) {
            decoration.mode(KdeMode::Server);
        }
    }
}
