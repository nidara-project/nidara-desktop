// SPDX-License-Identifier: LGPL-3.0-or-later
//! Opt-in committed-frame measurements; no icon identities or pixels in normal logs.
use std::sync::OnceLock;
pub fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| std::env::var_os("NK_ICON_METRICS").is_some())
}
pub fn emit(event: &str, mut data: serde_json::Value) {
    if enabled() {
        data["event"] = event.into();
        data["us"] = glib::monotonic_time().into();
        eprintln!("ICON_METRIC {data}");
    }
}
