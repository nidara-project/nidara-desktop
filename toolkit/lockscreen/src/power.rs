// SPDX-License-Identifier: LGPL-3.0-or-later
//! Power and the battery, from logind and UPower on the system bus.
//!
//! The lock screen offers Suspend only (D3): logind lets the active local session power off
//! without a password, so what it offers anyone at the keyboard can do, and suspending loses
//! nothing. The login screen's bar adds Restart and Power off, as every login screen does:
//! nobody's work is open there. With another person's session open, logind asks for an
//! administrator (`power-off-multiple-sessions`); the call is not interactive, so it is
//! refused and said in the journal, never half done.
//!
//! The battery is UPower's display device, asked once and again whenever its properties
//! change; a machine without one shows none.
use std::sync::mpsc::Sender;

use crate::Msg;

/// What the power menu offers, in its order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Power {
    Suspend,
    Restart,
    ShutDown,
}
impl Power {
    pub const MENU: [Power; 3] = [Power::Suspend, Power::Restart, Power::ShutDown];
    /// Its words, an i18n key.
    pub fn key(self) -> &'static str {
        match self {
            Power::Suspend => "lock.suspend",
            Power::Restart => "lock.restart",
            Power::ShutDown => "lock.power-off",
        }
    }
    fn method(self) -> &'static str {
        match self {
            Power::Suspend => "Suspend",
            Power::Restart => "Reboot",
            Power::ShutDown => "PowerOff",
        }
    }
}

/// Asks logind, on a thread of its own.
pub fn run(what: Power) {
    std::thread::spawn(move || {
        let call = || -> zbus::Result<()> {
            let bus = zbus::blocking::Connection::system()?;
            bus.call_method(
                Some("org.freedesktop.login1"),
                "/org/freedesktop/login1",
                Some("org.freedesktop.login1.Manager"),
                what.method(),
                &(false,),
            )?;
            Ok(())
        };
        if let Err(e) = call() {
            eprintln!("nidara-lock: {} refused: {e}", what.method());
        }
    });
}

/// The battery as the bar shows it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Battery {
    /// 0–100.
    pub percent: f64,
    pub charging: bool,
}

const UPOWER: &str = "org.freedesktop.UPower";
const DISPLAY: &str = "/org/freedesktop/UPower/devices/DisplayDevice";
const DEVICE: &str = "org.freedesktop.UPower.Device";

/// Watches on a thread of its own; each answer goes to the main thread as `Msg::Battery`.
pub fn watch(tx: Sender<Msg>) {
    std::thread::Builder::new()
        .name("lock-battery".into())
        .spawn(move || {
            if let Err(e) = watch_battery(&tx) {
                eprintln!("nidara-lock: the battery is not shown: {e}");
            }
        })
        .ok();
}

fn watch_battery(tx: &Sender<Msg>) -> zbus::Result<()> {
    let bus = zbus::blocking::Connection::system()?;
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .sender(UPOWER)?
        .path(DISPLAY)?
        .interface("org.freedesktop.DBus.Properties")?
        .member("PropertiesChanged")?
        .build();
    // Subscribed before the first answer, so a change between the two is seen.
    let signals = zbus::blocking::MessageIterator::for_match_rule(rule, &bus, Some(16))?;
    let mut last = None;
    let mut send = |b: Option<Battery>| {
        if b != last {
            last = b;
            tx.send(Msg::Battery(b)).is_ok()
        } else {
            true
        }
    };
    if !send(battery(&bus)) {
        return Ok(());
    }
    for msg in signals {
        msg?;
        if !send(battery(&bus)) {
            return Ok(());
        }
    }
    Ok(())
}

fn battery(bus: &zbus::blocking::Connection) -> Option<Battery> {
    let get = |name: &str| -> Option<zbus::zvariant::OwnedValue> {
        let reply = bus
            .call_method(
                Some(UPOWER),
                DISPLAY,
                Some("org.freedesktop.DBus.Properties"),
                "Get",
                &(DEVICE, name),
            )
            .ok()?;
        reply.body().deserialize().ok()
    };
    // Type 2 is a battery; a desktop's display device is present but of no type.
    let kind = get("Type").and_then(|v| u32::try_from(v).ok())?;
    let present = get("IsPresent").and_then(|v| bool::try_from(v).ok())?;
    if kind != 2 || !present {
        return None;
    }
    let percent = get("Percentage").and_then(|v| f64::try_from(v).ok())?;
    // 1 charging, 4 fully charged: on the mains either way.
    let state = get("State")
        .and_then(|v| u32::try_from(v).ok())
        .unwrap_or(0);
    Some(Battery {
        percent: percent.clamp(0., 100.),
        charging: matches!(state, 1 | 4),
    })
}
