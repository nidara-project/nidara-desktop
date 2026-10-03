//! Who draws a window's title bar: always the compositor, as on the Hyprland session — which
//! draws none. An app that asks (kitty, Qt, Chrome, Firefox) gets "server-side" and drops its
//! own bar and its shadow margin, so its surface IS its box: square to its geometry, rounded and
//! blurred like any other window (render/window.rs). Without an answer kitty draws a bar of its
//! own, and its shadow margin keeps the corners square.
//!
//! Hyprland's policy, both protocols (src/protocols/XDGDecoration.cpp, ServerDecorationKDE.cpp):
//! server-side by default, on request and on unset, whatever the client asked for. GTK apps do
//! not speak either and keep their own decorations.
//!
//! What the client ASKED is kept on its surface (`asked`): Hyalo draws its own title bar
//! (render/title_bar.rs) for a window that asked for server-side, or left it unset — never for
//! one that asked for client-side (Chrome without "Use system title bar and borders", GTK 3),
//! which is told server-side, ignores it and keeps its own frame.

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

/// What a client asked of a surface's decorations: `true` server-side (or unset, which is the
/// compositor's choice), `false` client-side. Absent: it never spoke either protocol.
#[derive(Default)]
struct Asked(std::cell::Cell<Option<bool>>);

fn note(surface: &WlSurface, server: bool) {
    smithay::wayland::compositor::with_states(surface, |states| {
        states.data_map.get_or_insert(Asked::default).0.set(Some(server));
    });
}

/// The client dropped its own frame without saying so: it now paints opaque pixels where its
/// shadow margin was (wm/mod.rs `poke_stale_geometry`) — Chrome, when "Use system title bar
/// and borders" is turned on while it runs, asks nothing. From now on it counts as having
/// asked for server-side; whether it gets the bar still waits for its surface to be its box.
pub fn note_dropped_frame(surface: &WlSurface) {
    note(surface, true);
}

/// Whether the client of `surface` asked for server-side decorations (or left the choice to
/// us): `None` when it spoke neither protocol (GTK 4, our own apps).
pub fn asked(surface: &WlSurface) -> Option<bool> {
    smithay::wayland::compositor::with_states(surface, |states| states.data_map.get::<Asked>().and_then(|a| a.0.get()))
}

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
        note(toplevel.wl_surface(), true);
        server_side(&toplevel);
    }

    fn request_mode(&mut self, toplevel: ToplevelSurface, mode: Mode) {
        note(toplevel.wl_surface(), mode != Mode::ClientSide);
        server_side(&toplevel);
    }

    fn unset_mode(&mut self, toplevel: ToplevelSurface) {
        note(toplevel.wl_surface(), true);
        server_side(&toplevel);
    }
}

impl KdeDecorationHandler for Hyalo {
    fn kde_decoration_state(&self) -> &KdeDecorationState {
        &self.kde_decoration_state
    }

    fn new_decoration(&mut self, surface: &WlSurface, decoration: &OrgKdeKwinServerDecoration) {
        note(surface, true);
        decoration.mode(KdeMode::Server);
    }

    /// A request for server-side is acknowledged; one for client-side is not granted, and the
    /// mode stays the one already sent — answering it would start a tug of war with a client
    /// that asks again.
    fn request_mode(&mut self, surface: &WlSurface, decoration: &OrgKdeKwinServerDecoration, mode: WEnum<KdeMode>) {
        note(surface, mode == WEnum::Value(KdeMode::Server));
        if mode == WEnum::Value(KdeMode::Server) {
            decoration.mode(KdeMode::Server);
        }
    }
}
