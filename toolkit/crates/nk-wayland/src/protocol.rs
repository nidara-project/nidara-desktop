// SPDX-License-Identifier: LGPL-3.0-or-later
//! Generated from the same XML as Hyalo. No copied protocol declarations.
#[allow(clippy::all)]
pub mod material {
    use wayland_client;
    use wayland_client::protocol::*;
    pub mod __interfaces {
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../../../protocols/nidara-material-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("../../../protocols/nidara-material-v1.xml");
}
