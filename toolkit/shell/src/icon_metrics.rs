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

/// Opt-in elapsed stage time; disabled spans do not read the clock or log.
pub struct Span(Option<(i64, &'static str, serde_json::Value)>);
pub fn span(event: &'static str, data: serde_json::Value) -> Span {
    Span(enabled().then(|| (glib::monotonic_time(), event, data)))
}
impl Drop for Span {
    fn drop(&mut self) {
        if let Some((start, event, mut data)) = self.0.take() {
            data["start_us"] = start.into();
            data["elapsed_us"] = (glib::monotonic_time() - start).into();
            emit(event, data);
        }
    }
}
