// SPDX-License-Identifier: LGPL-3.0-or-later
//! Compiled only for the acceptance binary. A private file arms a fault after setup.
pub fn active(name: &str) -> bool {
    std::env::var_os("NK_SETTINGS_GATE_CONTROL")
        .and_then(|p| std::fs::read_to_string(p).ok())
        .is_some_and(|s| s.trim() == name)
}
pub fn applied(name: &str, target: &str) {
    eprintln!("SETTINGS_GATE_CONTROL_APPLIED {name} target={target}");
}
