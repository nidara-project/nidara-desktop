// SPDX-License-Identifier: LGPL-3.0-or-later
//! Session-wide shell dialogs for Wi-Fi credentials and Bluetooth consent.
pub mod polkit;
pub(crate) mod surface;
mod wire;

use crate::shell1::Status;
use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        Arc,
        mpsc::{self, Sender},
    },
    time::Duration,
};
use wire::{Answer, Wire};
use zbus::zvariant::OwnedValue;

pub(super) type Secrets = HashMap<String, HashMap<String, OwnedValue>>;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Service {
    Wifi,
    Bluetooth,
}
impl Service {
    fn endpoint(self) -> (&'static str, &'static str, &'static str, &'static str) {
        match self {
            Self::Wifi => (
                "org.nidara.Network",
                "/org/nidara/Network",
                "org.nidara.Network1",
                "RegisterSecretsUi",
            ),
            Self::Bluetooth => (
                "org.nidara.Bluetooth",
                "/org/nidara/Bluetooth",
                "org.nidara.Bluetooth1",
                "RegisterUi",
            ),
        }
    }
}

/// IDs have meaning only within the service, its unique bus owner and its epoch.
#[derive(Clone, PartialEq, Eq)]
struct Ticket {
    service: Service,
    owner: String,
    connection: u64,
    epoch: u64,
    id: u64,
}

struct Request {
    ticket: Ticket,
    meta: Value,
}

enum Event {
    Prompt(Ticket, Value),
    Update(Ticket, Value),
    Closed(Ticket),
    Reset(Service),
    Failed(Ticket),
    Lock(bool),
    Answer(u64, Ticket, Answer),
    Ended(u64, Ticket),
}

/// Independent alerts and service prompts keep their existing policy with one another.
/// Polkit needs exclusive use of their shared dialog slot.
#[derive(Default)]
pub(crate) struct Slots {
    other: usize,
    polkit: bool,
}

#[derive(Clone, Copy)]
pub(crate) enum SlotKind {
    Polkit,
    Other,
}

pub(crate) struct Slot {
    status: Arc<Status>,
    kind: SlotKind,
}

impl Slot {
    pub(crate) fn take(status: &Arc<Status>, kind: SlotKind) -> Option<Self> {
        let mut slots = status.prompt_slots.lock().unwrap();
        if slots.polkit || (matches!(kind, SlotKind::Polkit) && slots.other != 0) {
            return None;
        }
        match kind {
            SlotKind::Polkit => slots.polkit = true,
            SlotKind::Other => slots.other += 1,
        }
        Some(Self {
            status: status.clone(),
            kind,
        })
    }
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut slots = self.status.prompt_slots.lock().unwrap();
        match self.kind {
            SlotKind::Polkit => slots.polkit = false,
            SlotKind::Other => slots.other -= 1,
        }
    }
}

#[derive(Clone)]
pub struct Dialogs(Sender<Event>);

impl Dialogs {
    pub fn start(bus: zbus::blocking::Connection, status: Arc<Status>) -> Self {
        let (tx, rx) = mpsc::channel();
        let events = tx.clone();
        std::thread::spawn(move || {
            let wifi = Wire::start(Service::Wifi, events.clone());
            let bluetooth = Wire::start(Service::Bluetooth, events.clone());
            let mut requests = VecDeque::<Request>::new();
            let mut running: Option<surface::Running> = None;
            let mut next = 0;
            // Preserve pending service requests through lock. Reopening builds a fresh field.
            // Wait for Hyalo's initial state before showing or accepting any request.
            let mut locked = true;
            let mut waiting_for_slot = false;
            loop {
                let next_event = if waiting_for_slot {
                    match rx.recv_timeout(Duration::from_millis(30)) {
                        Ok(event) => Some(event),
                        Err(mpsc::RecvTimeoutError::Timeout) => None,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    }
                } else {
                    match rx.recv() {
                        Ok(event) => Some(event),
                        Err(_) => break,
                    }
                };
                match next_event {
                    Some(Event::Lock(value)) => {
                        locked = value;
                        if locked {
                            for request in &mut requests {
                                if let Some(meta) = request.meta.as_object_mut() {
                                    meta.remove("activationToken");
                                }
                            }
                        }
                    }
                    Some(Event::Prompt(ticket, mut meta)) => {
                        requests.retain(|r| r.ticket.service != ticket.service);
                        if locked && let Some(obj) = meta.as_object_mut() {
                            obj.remove("activationToken");
                        }
                        if surface::supports(&ticket, &meta) {
                            requests.push_back(Request { ticket, meta });
                        }
                    }
                    Some(Event::Update(ticket, mut meta)) => {
                        if let Some(request) = requests.iter_mut().find(|r| r.ticket == ticket) {
                            let activation = request.meta.get("activationToken").cloned();
                            if let Some(document) = meta.as_object_mut() {
                                document.remove("activationToken");
                                if let Some(token) = activation {
                                    document.insert("activationToken".into(), token);
                                }
                            }
                            request.meta = meta.clone();
                            if let Some(view) = running.as_ref().filter(|v| v.ticket == ticket) {
                                view.send(surface::Change::Metadata(meta));
                            }
                        }
                    }
                    Some(Event::Closed(ticket)) => requests.retain(|r| r.ticket != ticket),
                    Some(Event::Reset(service)) => requests.retain(|r| r.ticket.service != service),
                    Some(Event::Failed(ticket)) => {
                        if let Some(view) = running.as_ref().filter(|v| v.ticket == ticket) {
                            view.send(surface::Change::Failed);
                        }
                    }
                    Some(Event::Answer(serial, ticket, answer)) => {
                        if !locked
                            && running
                                .as_ref()
                                .is_some_and(|v| v.serial == serial && !v.stopping)
                            && requests.front().is_some_and(|r| r.ticket == ticket)
                        {
                            match ticket.service {
                                Service::Wifi => wifi.reply(ticket, answer),
                                Service::Bluetooth => bluetooth.reply(ticket, answer),
                            }
                        }
                    }
                    Some(Event::Ended(serial, ticket)) => {
                        if let Some(view) = running.take_if(|v| v.serial == serial)
                            && !view.stopping
                        {
                            // An unexpected surface loss does not count as user cancellation.
                            requests.retain(|r| r.ticket != ticket);
                        }
                    }
                    None => {}
                }
                waiting_for_slot = false;
                let request = requests.front().filter(|_| !locked);
                if let Some(view) = &mut running {
                    if request.is_none_or(|r| r.ticket != view.ticket) {
                        view.stop();
                    }
                } else if let Some(request) = request {
                    if let Some(slot) = Slot::take(&status, SlotKind::Other) {
                        next += 1;
                        running = surface::start(next, request, bus.clone(), &events, slot);
                        if running.is_none() {
                            requests.pop_front();
                        }
                    } else {
                        waiting_for_slot = true;
                    }
                }
            }
        });
        Self(tx)
    }

    pub fn locked(&self, locked: bool) {
        let _ = self.0.send(Event::Lock(locked));
    }
}
