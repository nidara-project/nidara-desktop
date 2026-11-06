// SPDX-License-Identifier: GPL-3.0-or-later
#[test]
fn default_rust_session_on_private_buses() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/dev/rust-startup-check.py");
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_nidara-sessiond"))
        .status()
        .expect("Python/Gio private-bus startup fixture");
    assert!(status.success(), "Rust session startup integration");
}
