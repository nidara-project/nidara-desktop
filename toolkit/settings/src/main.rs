// SPDX-License-Identifier: LGPL-3.0-or-later
mod application;
fn main() {
    if let Err(error) = application::run() {
        eprintln!("SETTINGS_ERROR {error}");
        std::process::exit(1);
    }
}
