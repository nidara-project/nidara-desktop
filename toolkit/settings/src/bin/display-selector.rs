// SPDX-License-Identifier: LGPL-3.0-or-later
fn main() {
    if let Err(error) = nk_settings::display::selector::run() {
        eprintln!("DISPLAY_SELECTOR_ERROR {error}");
        std::process::exit(1);
    }
}
