// SPDX-License-Identifier: LGPL-3.0-or-later
mod application;
fn main() {
    let activation = std::env::var_os("XDG_ACTIVATION_TOKEN");
    // SAFETY: this is the binary entry, before any bus, font, portal or worker
    // initialization. No application thread exists yet; tests never mutate env.
    unsafe {
        std::env::remove_var("XDG_ACTIVATION_TOKEN");
    }
    let activation = activation
        .map(|value| {
            value
                .into_string()
                .map_err(|_| "activation token is not UTF-8".to_owned())
        })
        .transpose();
    if let Err(error) = activation.and_then(application::run) {
        eprintln!("SETTINGS_ERROR {error}");
        std::process::exit(1);
    }
}
