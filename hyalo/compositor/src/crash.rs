//! A compositor that dies takes the session with it; it must not take the reason too.
//!
//! On a panic (or a startup that fails) Hyalo writes a report to
//! `$XDG_STATE_HOME/nidara/hyalo/crash-<unix time>.txt` — a place that survives the logout,
//! unlike `$XDG_RUNTIME_DIR` — and `nidara-doctor` lists the latest one. The session then
//! ends and greetd brings the greeter back; the user's apps are lost with the compositor
//! (that is what a crash means for every Wayland session), but never silently.

use std::{io::Write, path::PathBuf};

pub fn crash_dir() -> PathBuf {
    let base = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(".local/state"));
    base.join("nidara").join("hyalo")
}

/// Writes a report and returns where. Keeps the newest ten.
pub fn write_report(what: &str) -> Option<PathBuf> {
    let dir = crash_dir();
    std::fs::create_dir_all(&dir).ok()?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = dir.join(format!("crash-{now}.txt"));
    let mut f = std::fs::File::create(&path).ok()?;
    let _ = writeln!(f, "nidara-hyalo {} crashed at unix time {now}", env!("CARGO_PKG_VERSION"));
    let _ = writeln!(f, "{what}");
    let _ = writeln!(f, "\nbacktrace:\n{}", std::backtrace::Backtrace::force_capture());

    // Old reports go; ten is plenty to see a pattern.
    if let Ok(entries) = std::fs::read_dir(&dir) {
        let mut reports: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.file_name().is_some_and(|n| n.to_string_lossy().starts_with("crash-")))
            .collect();
        reports.sort();
        let excess = reports.len().saturating_sub(10);
        for old in &reports[..excess] {
            let _ = std::fs::remove_file(old);
        }
    }
    Some(path)
}

pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let path = write_report(&info.to_string());
        tracing::error!(report = ?path, "Hyalo panicked: {info}");
        default(info);
    }));
}
