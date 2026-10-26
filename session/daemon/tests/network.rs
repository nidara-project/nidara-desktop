// SPDX-License-Identifier: GPL-3.0-or-later
//! Reuses the sessiond job's existing Python/Gio dependencies; no extra CI step.
#[test]
fn network_manager_and_keyring_on_private_buses() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/ci/sessiond-network-test.py");
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_nidara-sessiond"))
        .status()
        .expect("python3 with Gio and dbus-daemon (existing sessiond test dependencies)");
    assert!(status.success(), "Network1 private-bus integration");
}
