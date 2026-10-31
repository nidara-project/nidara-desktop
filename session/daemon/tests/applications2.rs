// SPDX-License-Identifier: GPL-3.0-or-later
#[test]
fn launch_on_private_services() {
    // Cargo only supplies CARGO_BIN_EXE for this package. Build the sibling CLI
    // explicitly so this test also works alone, with a fresh target directory.
    let daemon = std::path::Path::new(env!("CARGO_BIN_EXE_nidara-sessiond"));
    let bin_dir = daemon.parent().expect("daemon profile directory");
    let profile = bin_dir.file_name().unwrap().to_str().unwrap();
    let mut build = std::process::Command::new(env!("CARGO"));
    build
        .args([
            "build",
            "--locked",
            "--package",
            "nidara-ipc",
            "--manifest-path",
        ])
        .arg(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../Cargo.toml"))
        .arg("--target-dir")
        .arg(bin_dir.parent().expect("target directory"));
    if profile != "debug" {
        build.args(["--profile", profile]);
    }
    assert!(
        build.status().expect("build sibling nidara-ipc").success(),
        "A2 CLI fixture build"
    );
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/dev/applications2-check.py");
    let status = std::process::Command::new("/usr/bin/python3")
        .arg(script)
        .arg(daemon)
        .status()
        .expect("A2 private fixture");
    assert!(status.success(), "A2 integration");
}
