// SPDX-License-Identifier: LGPL-3.0-or-later
//! Session-wide shell dialogs for Wi-Fi credentials and Bluetooth consent.
mod surface;
mod wire;

use serde_json::Value;
use std::{
    collections::{HashMap, VecDeque},
    sync::mpsc::{self, Sender},
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

#[derive(Clone)]
pub struct Dialogs(Sender<Event>);

impl Dialogs {
    pub fn start(bus: zbus::blocking::Connection) -> Self {
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
            while let Ok(event) = rx.recv() {
                match event {
                    Event::Lock(value) => locked = value,
                    Event::Prompt(ticket, meta) => {
                        requests.retain(|r| r.ticket.service != ticket.service);
                        if surface::supports(&ticket, &meta) {
                            requests.push_back(Request { ticket, meta });
                        }
                    }
                    Event::Update(ticket, meta) => {
                        if let Some(request) = requests.iter_mut().find(|r| r.ticket == ticket) {
                            request.meta = meta.clone();
                            if let Some(view) = running.as_ref().filter(|v| v.ticket == ticket) {
                                view.send(surface::Change::Metadata(meta));
                            }
                        }
                    }
                    Event::Closed(ticket) => requests.retain(|r| r.ticket != ticket),
                    Event::Reset(service) => requests.retain(|r| r.ticket.service != service),
                    Event::Failed(ticket) => {
                        if let Some(view) = running.as_ref().filter(|v| v.ticket == ticket) {
                            view.send(surface::Change::Failed);
                        }
                    }
                    Event::Answer(serial, ticket, answer) => {
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
                    Event::Ended(serial, ticket) => {
                        if let Some(view) = running.take_if(|v| v.serial == serial)
                            && !view.stopping
                        {
                            // An unexpected surface loss does not count as user cancellation.
                            requests.retain(|r| r.ticket != ticket);
                        }
                    }
                }
                let request = requests.front().filter(|_| !locked);
                if let Some(view) = &mut running {
                    if request.is_none_or(|r| r.ticket != view.ticket) {
                        view.stop();
                    }
                } else if let Some(request) = request {
                    next += 1;
                    running = surface::start(next, request, bus.clone(), &events);
                    if running.is_none() {
                        requests.pop_front();
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
