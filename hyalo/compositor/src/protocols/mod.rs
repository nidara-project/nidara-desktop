//! Server code generated from protocol XML that Smithay does not implement. The XML lives at
//! the repository root, in `protocols/`, which is where the client side (lib/nidara-wl) reads
//! it too — one file per protocol, for both ends.

pub mod focus_grab;
pub mod material;
pub mod virtual_pointer;

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
