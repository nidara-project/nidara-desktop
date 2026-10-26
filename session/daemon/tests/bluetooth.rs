// SPDX-License-Identifier: GPL-3.0-or-later
#[test]
fn bluetooth_and_obex_on_private_buses() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/ci/sessiond-bluetooth-test.py");
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_nidara-sessiond"))
        .status()
        .expect("existing Python/Gio and private dbus-daemon test dependencies");
    assert!(status.success(), "Bluetooth1 private-bus integration");
}
