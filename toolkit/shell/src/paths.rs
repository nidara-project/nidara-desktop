// SPDX-License-Identifier: LGPL-3.0-or-later
//! Where the shell's installed data is, or the source tree's in development.
use std::path::PathBuf;

/// Nidara's reference icon theme (the `nd-` interface icons).
pub fn icon_reference() -> PathBuf {
    std::env::var_os("NK_ICON_REFERENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let installed = PathBuf::from("/usr/share/nidara/ui/shell/assets/icons/nidara");
            if installed.is_dir() {
                installed
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara")
            }
        })
}

/// Nidara's mark, the bar's system-menu icon (the TS bar's `nidara` launcher preset).
pub fn logo() -> PathBuf {
    let installed =
        PathBuf::from("/usr/share/nidara/ui/shell/assets/nidara/assets/nidara-symbolic.svg");
    if installed.is_file() {
        installed
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../ui/shell/assets/nidara/assets/nidara-symbolic.svg")
    }
}
