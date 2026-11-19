// SPDX-License-Identifier: LGPL-3.0-or-later
//! The kit's criticals: a program asked the kit for something it does not do, and the kit
//! dropped it. GTK's `g_critical` for the same mistake (a property a widget does not have, a
//! signal it never emits): the program still runs, and the line in the journal names what was
//! lost. Without it the only trace is a control that does nothing when clicked (#1148: a path
//! bar's crumbs and a switch reported their action with no value, and the app ignored it).
//!
//! Fatal, like `G_DEBUG=fatal-criticals`, under `cargo test` and when `NK_DEBUG` names
//! `fatal-criticals`: a kit test, a gallery check or an app's own test that builds such a view
//! fails at the line that built it, instead of needing a test for each control.
use std::{
    collections::HashSet,
    sync::{Mutex, OnceLock},
};

fn fatal() -> bool {
    cfg!(test)
        || std::env::var("NK_DEBUG")
            .is_ok_and(|v| v.split(',').any(|w| w.trim() == "fatal-criticals"))
}

/// Report `message` once per process (a view rebuilt every frame says it once).
pub fn critical(message: String) {
    if fatal() {
        panic!("nk-CRITICAL: {message}");
    }
    static SAID: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    let said = SAID.get_or_init(Default::default);
    if said
        .lock()
        .map(|mut s| s.insert(message.clone()))
        .unwrap_or(true)
    {
        eprintln!("nk-CRITICAL: {message}");
    }
}
