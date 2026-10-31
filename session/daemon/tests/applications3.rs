// SPDX-License-Identifier: GPL-3.0-or-later
#[test]
fn observation_usage_and_unity_on_private_services() {
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/dev/applications3-check.py");
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(script)
        .arg(env!("CARGO_BIN_EXE_nidara-sessiond"))
        .status()
        .expect("private A3 fixture");
    assert!(status.success(), "Applications1 A3 integration");
}
