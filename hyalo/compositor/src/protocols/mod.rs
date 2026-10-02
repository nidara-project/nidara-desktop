//! Server code generated from protocol XML that Smithay does not implement. The XML lives at
//! the repository root, in `protocols/`, which is where the client side (lib/nidara-wl) reads
//! it too — one file per protocol, for both ends.

pub mod focus_grab;
pub mod material;
pub mod screencopy;
pub mod virtual_pointer;

// The scanner macros read the XML at compile time, but nothing tells cargo: an edited protocol
// left the server built from the OLD file while lib/nidara-wl was built from the new one, and
// the two ends numbered the requests differently — the shell hung on its first message
// (2026-10-01). `include_bytes!` makes each file a dependency of this crate.
const _: &[u8] = include_bytes!("../../../../protocols/hyprland-focus-grab-v1.xml");
const _: &[u8] = include_bytes!("../../../../protocols/nidara-material-v1.xml");

pub mod gen_focus_grab {
    use wayland_server;
    use wayland_server::protocol::*;
    pub mod __interfaces {
        use wayland_server::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../../protocols/hyprland-focus-grab-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_server_code!("../../protocols/hyprland-focus-grab-v1.xml");
}

pub mod gen_material {
    use wayland_server;
    use wayland_server::protocol::*;
    pub mod __interfaces {
        use wayland_server::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../../protocols/nidara-material-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_server_code!("../../protocols/nidara-material-v1.xml");
}
