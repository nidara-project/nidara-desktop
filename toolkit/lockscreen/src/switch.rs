// SPDX-License-Identifier: LGPL-3.0-or-later
//! Switching user from the lock screen (#1195 D8): the session stays locked and the login
//! manager puts a login screen on a VT of its own, where somebody else logs in, or this
//! person comes back to their session (L3). The button is offered only while `nidara-login`
//! is the login manager; under greetd there is nobody to ask.
use std::sync::mpsc::Sender;

use crate::Msg;

const LOGIN: &str = "org.nidara.Login";
const SEAT0: &str = "/org/freedesktop/DisplayManager/Seat0";
const SEAT: &str = "org.freedesktop.DisplayManager.Seat";

/// Asks once, on a thread of its own, whether the login manager is there: `Msg::CanSwitch`.
pub fn ask(tx: Sender<Msg>) {
    std::thread::Builder::new()
        .name("lock-switch".into())
        .spawn(move || {
            let there = zbus::blocking::Connection::system()
                .and_then(|bus| {
                    let dbus = zbus::blocking::fdo::DBusProxy::new(&bus)?;
                    Ok(dbus.name_has_owner(LOGIN.try_into()?)?)
                })
                .unwrap_or(false);
            let _ = tx.send(Msg::CanSwitch(there));
        })
        .ok();
}

/// Asks the login manager for a login screen, on a thread of its own; a refusal is said in
/// the journal and the lock screen stays.
pub fn switch() {
    std::thread::spawn(|| {
        let call = || -> zbus::Result<()> {
            let bus = zbus::blocking::Connection::system()?;
            bus.call_method(Some(LOGIN), SEAT0, Some(SEAT), "SwitchToGreeter", &())?;
            Ok(())
        };
        if let Err(e) = call() {
            eprintln!("nidara-lock: switching user refused: {e}");
        }
    });
}
