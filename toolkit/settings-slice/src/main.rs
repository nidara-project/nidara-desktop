// SPDX-License-Identifier: LGPL-3.0-or-later
mod data;
mod host;
mod semantics;
mod view;
use std::time::Instant;
type Result<T> = std::result::Result<T, String>;
fn timing(name: &str, start: Instant) {
    eprintln!("TIMING {name}={:.3}", start.elapsed().as_secs_f64() * 1000.);
}
fn run(start: Instant) -> Result<()> {
    let rx = data::start();
    // Resolving the real system font collection overlaps connection + Snapshot.
    let fonts = view::Fonts::new();
    let exports = data::Exports::load()?;
    let services = rx
        .recv_timeout(data::DEADLINE.saturating_sub(start.elapsed()))
        .map_err(|e| format!("initial data deadline: {e}"))??;
    eprintln!(
        "SNAPSHOT epoch={} revision={}",
        services.epoch, services.revision
    );
    let control = std::env::args().any(|s| s == "--control-default-values");
    let view = view::View::new(exports, &services, control)?;
    host::run(fonts, view, rx, control, start)
}
fn main() {
    let start = Instant::now();
    // /proc starttime and CLOCK_BOOTTIME share the kernel boot clock. Read
    // CLK_TCK rather than assuming the architecture's value.
    if let Ok(stat) = std::fs::read_to_string("/proc/self/stat")
        && let Some(ticks) = stat
            .rsplit_once(')')
            .and_then(|(_, s)| s.split_whitespace().nth(19))
            .and_then(|s| s.parse::<f64>().ok())
    {
        let now = rustix::time::clock_gettime(rustix::time::ClockId::Boottime);
        let hz = rustix::param::clock_ticks_per_second() as f64;
        eprintln!(
            "TIMING process_start_to_main={:.3}",
            ((now.tv_sec as f64 + now.tv_nsec as f64 / 1e9) - ticks / hz).max(0.) * 1000.
        );
    }
    if let Err(e) = run(start) {
        eprintln!("SLICE_ERROR {e}");
        std::process::exit(1)
    }
}

#[cfg(test)]
mod tests;
