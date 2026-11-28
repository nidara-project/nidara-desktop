// SPDX-License-Identifier: LGPL-3.0-or-later
//! The login screen's accessibility menu (#1195 B3): large text and the screen reader, so a
//! person who needs either can log in at all.
//!
//! Large text is the screen drawn with its text a quarter larger, GNOME's "Large Text"
//! (`text-scaling-factor` 1.25), from a second look loaded with the first
//! (`surface::Kit`). The screen reader is Orca, started for the login screen's user and
//! stopped when it is turned off or the screen goes; the screen's tree is already on the
//! accessibility bus (nk-a11y), which is what Orca reads. Orca is offered only when it is
//! installed. Neither is saved: the next login screen starts with both off.
//!
//! The on-screen keyboard is not here: Hyalo hides the virtual-keyboard protocol while the
//! session is locked (so nothing can type into the password field), and a keyboard of the
//! kit's own that types into the field directly is its own piece of work.
use std::path::Path;
use std::process::{Child, Command};

/// GNOME's large text.
pub const LARGE_TEXT: f64 = 1.25;

/// The menu's rows, in order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    LargeText,
    ScreenReader,
}

impl Access {
    pub fn key(self) -> &'static str {
        match self {
            Access::LargeText => "lock.large-text",
            Access::ScreenReader => "lock.screen-reader",
        }
    }
}

/// What the menu offers here: large text always, the screen reader when Orca is installed.
pub fn offered() -> Vec<Access> {
    let mut rows = vec![Access::LargeText];
    if installed("orca") {
        rows.push(Access::ScreenReader);
    }
    rows
}

fn installed(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| is_program(&dir.join(program))))
}

fn is_program(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata()
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

/// The screen reader while it is on.
#[derive(Default)]
pub struct ScreenReader(Option<Child>);

impl ScreenReader {
    pub fn on(&self) -> bool {
        self.0.is_some()
    }

    /// Starts Orca, or stops it; whether it is on after.
    pub fn toggle(&mut self) -> bool {
        match self.0.take() {
            Some(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
                false
            }
            None => match Command::new("orca").arg("--replace").spawn() {
                Ok(child) => {
                    self.0 = Some(child);
                    true
                }
                Err(e) => {
                    eprintln!("nidara-lock: the screen reader did not start: {e}");
                    false
                }
            },
        }
    }
}

impl Drop for ScreenReader {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
