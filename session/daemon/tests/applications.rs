// SPDX-License-Identifier: GPL-3.0-or-later
#[test]
fn applications_on_a_private_bus() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/dev/applications1-check.py");
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_nidara-sessiond"))
        .status()
        .expect("Python/Gio private-bus fixture");
    assert!(status.success(), "Applications1 integration");
}
