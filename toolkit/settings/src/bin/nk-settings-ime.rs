// SPDX-License-Identifier: LGPL-3.0-or-later
fn main() {
    if let Err(error) = nk_settings::font_chooser::run_ime_probe() {
        eprintln!("IME_PROBE_ERROR {error}");
        std::process::exit(1);
    }
}
