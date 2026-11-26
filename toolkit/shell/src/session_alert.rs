// SPDX-License-Identifier: LGPL-3.0-or-later
//! Trusted system alert toplevels. The lease connection and display effects stay with Display1
//! and its initiating Settings worker. Power actions remain in the shell menu's effect path.
use crate::menu::System;
use crate::prompts::{
    SlotKind,
    surface::{dialog_host, dialog_options},
};
use crate::shell1::Status;
use nk::{
    Activated, Alert, AlertCountdown, AppWindow, DialogAnswer, DialogButton, DialogContent,
    DialogUpdate, Node, WindowLook,
};
use nk_platform::{exports::Exports, portal::Portal};
use nk_wayland::Result;
use std::{
    sync::{Arc, atomic::Ordering},
    time::{Duration, Instant},
};
use zbus::blocking::Connection;

pub(crate) enum Kind {
    Display { deadline: Instant },
    Power(System),
}

struct Slot(Arc<Status>);

impl Slot {
    fn take(status: Arc<Status>) -> Result<Self> {
        if !status.alert_unlocked.load(Ordering::Acquire)
            || status
                .system_alert
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_err()
        {
            return Err("a system alert is already open or the session is locked".into());
        }
        Ok(Self(status))
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        self.0.system_alert.store(false, Ordering::Release);
    }
}

struct Content<'a> {
    exports: &'a Exports,
    portal: &'a Portal,
    status: &'a Status,
    lock_generation: usize,
    answer: &'a async_channel::Sender<bool>,
    revoked: bool,
}

impl DialogContent for Content<'_> {
    fn content(&mut self, _: &AppWindow) -> Node {
        nk::Spacer::new("system-alert/content").into()
    }

    fn activated(&mut self, _: Activated) -> Result<()> {
        Ok(())
    }

    fn withdrawn(&self) -> bool {
        self.revoked
    }

    fn poll(&mut self) -> Result<DialogUpdate> {
        self.revoked = !self.still_unlocked() || self.answer.is_closed();
        if self.portal.changed() && !self.revoked {
            let mut appearance = self.portal.read()?;
            appearance.dark = true;
            return Ok(DialogUpdate {
                appearance: Some((
                    WindowLook::load(self.exports, &appearance)?,
                    appearance.reduced_motion,
                )),
                ..Default::default()
            });
        }
        Ok(DialogUpdate::default())
    }
}

impl Content<'_> {
    fn still_unlocked(&self) -> bool {
        self.status.alert_unlocked.load(Ordering::Acquire)
            && self.status.lock_generation.load(Ordering::Acquire) == self.lock_generation
    }
}

fn alert(exports: &Exports, kind: Kind) -> Result<Alert> {
    let (title, cancel, accept, deadline, text, response) = match kind {
        Kind::Display { deadline } => (
            "settings.display.confirm.title",
            "settings.display.confirm.revert",
            "settings.display.confirm.keep",
            deadline,
            "settings.display.confirm.body",
            None,
        ),
        Kind::Power(action) => {
            let (title, accept) = action.alert_labels().ok_or("invalid power alert")?;
            (
                title,
                "bar.system-menu.confirm.cancel",
                accept,
                Instant::now() + Duration::from_secs(60),
                "bar.system-menu.confirm.countdown",
                Some("accept".into()),
            )
        }
    };
    Ok(Alert {
        title: exports.text(title)?.into(),
        message: String::new(),
        detail: None,
        buttons: vec![
            DialogButton {
                id: "cancel".into(),
                label: exports.text(cancel)?.into(),
                default: false,
                cancel: true,
                destructive: false,
                enabled: true,
            },
            DialogButton {
                id: "accept".into(),
                label: exports.text(accept)?.into(),
                default: true,
                cancel: false,
                destructive: false,
                enabled: true,
            },
        ],
        countdown: Some(AlertCountdown {
            deadline,
            text: exports.text(text)?.into(),
            response,
        }),
    })
}

/// Spawn from the shell's trusted application identity, on its own Wayland connection.
pub(crate) fn open(
    status: Arc<Status>,
    kind: Kind,
    activation: Option<String>,
) -> Result<async_channel::Receiver<bool>> {
    let generation = status
        .unlocked_generation()
        .ok_or("the session is locked")?;
    let (answer, result) = async_channel::bounded(1);
    let prompt_slot = crate::prompts::Slot::take(&status, SlotKind::Other);
    // A display preview cannot wait behind authentication. Tell Settings
    // to cancel its lease now instead of leaving the display at the preview mode.
    if prompt_slot.is_none() && matches!(kind, Kind::Display { .. }) {
        let _ = answer.try_send(false);
        return Ok(result);
    }
    let slot = Slot::take(status)?;
    std::thread::Builder::new()
        .name("system-alert".into())
        .spawn(move || {
            let prompt_slot = prompt_slot.or_else(|| {
                crate::prompts::Slot::wait(&slot.0, SlotKind::Other, || {
                    slot.0.unlocked_generation() == Some(generation)
                })
            });
            let run = || -> Result<bool> {
                if prompt_slot.is_none() || slot.0.unlocked_generation() != Some(generation) {
                    return Ok(false);
                }
                let bus = Connection::session().map_err(|error| error.to_string())?;
                let portal = Portal::watch(&bus)?;
                let exports = Exports::load(&Exports::root())?;
                let mut appearance = portal.read()?;
                appearance.dark = true;
                let alert = alert(&exports, kind)?;
                let host = dialog_host(
                    WindowLook::load(&exports, &appearance)?,
                    &alert.title,
                    appearance.reduced_motion,
                )?;
                let mut model = Content {
                    exports: &exports,
                    portal: &portal,
                    status: &slot.0,
                    lock_generation: generation,
                    answer: &answer,
                    revoked: false,
                };
                if !model.still_unlocked() {
                    return Ok(false);
                }
                let response =
                    alert.run_parentless(host, dialog_options(), activation, &mut model)?;
                Ok(model.still_unlocked() && response == DialogAnswer::Button("accept".into()))
            };
            let accepted = run().unwrap_or_else(|error| {
                eprintln!("nidara-shell: system alert: {error}");
                false
            });
            drop(prompt_slot);
            let _ = answer.try_send(accepted);
        })
        .map_err(|error| error.to_string())?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polkit_declines_display_preview_and_defers_power_until_lock() {
        let status = Arc::new(Status::default());
        status.update_alert_lock(false);
        let _polkit = crate::prompts::Slot::take(&status, SlotKind::Polkit).unwrap();

        let display = open(
            status.clone(),
            Kind::Display {
                deadline: Instant::now() + Duration::from_secs(15),
            },
            None,
        )
        .unwrap();
        assert!(!display.try_recv().unwrap());

        let power = open(status.clone(), Kind::Power(System::Shutdown), None).unwrap();
        assert_eq!(power.try_recv(), Err(async_channel::TryRecvError::Empty));

        status.update_alert_lock(true);
        let result =
            futures_lite::future::block_on(futures_lite::future::race(power.recv(), async {
                async_io::Timer::after(Duration::from_secs(2)).await;
                panic!("queued alert did not wake");
            }));
        assert_eq!(
            result,
            Ok(false),
            "locking discards the queued power action"
        );
    }
}
