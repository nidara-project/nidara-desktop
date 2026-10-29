// SPDX-License-Identifier: GPL-3.0-or-later
#[test]
fn tray_on_a_private_session_bus() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/ci/sessiond-tray-test.py");
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_nidara-sessiond"))
        .status()
        .expect("Python/Gio and private dbus-daemon");
    assert!(status.success(), "Tray1 private-bus integration");
}
