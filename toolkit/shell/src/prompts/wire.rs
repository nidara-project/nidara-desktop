// SPDX-License-Identifier: LGPL-3.0-or-later
//! One durable registration connection per service. Method calls never run on Wayland.
use super::{Event, Service, Ticket};
use std::{
    sync::mpsc::{self, Receiver, Sender},
    time::Duration,
};
use zbus::{
    MatchRule, Message,
    blocking::{Connection, MessageIterator},
    message::Type,
};

pub(super) enum Answer {
    Cancel,
    Reject,
    Wifi(super::Secrets),
    Bluetooth(String),
}

enum Input {
    Bus(u64, Message),
    Reply(Ticket, Answer),
    Disconnected(u64),
}

pub(super) struct Wire(Sender<Input>);

impl Wire {
    pub fn start(service: Service, events: Sender<Event>) -> Self {
        let (tx, rx) = mpsc::channel();
        let input = tx.clone();
        std::thread::spawn(move || {
            for connection in 0.. {
                watch(service, connection, &events, &input, &rx);
                if events.send(Event::Reset(service)).is_err() {
                    return;
                }
                std::thread::sleep(Duration::from_secs(2));
            }
        });
        Self(tx)
    }

    pub fn reply(&self, ticket: Ticket, answer: Answer) {
        let _ = self.0.send(Input::Reply(ticket, answer));
    }
}

struct Close(Connection);
impl Drop for Close {
    fn drop(&mut self) {
        let _ = self.0.clone().close();
    }
}

fn watch(
    service: Service,
    connection: u64,
    events: &Sender<Event>,
    input: &Sender<Input>,
    rx: &Receiver<Input>,
) {
    let start = || -> zbus::Result<_> {
        let bus = zbus::blocking::connection::Builder::session()?
            .method_timeout(Duration::from_secs(5))
            .build()?;
        let close = Close(bus.clone());
        let (name, path, interface, _) = service.endpoint();
        let signals = MessageIterator::for_match_rule(
            MatchRule::builder()
                .msg_type(Type::Signal)
                .sender(name)?
                .path(path)?
                .interface(interface)?
                .build(),
            &bus,
            Some(32),
        )?;
        let owners = MessageIterator::for_match_rule(
            MatchRule::builder()
                .msg_type(Type::Signal)
                .sender("org.freedesktop.DBus")?
                .interface("org.freedesktop.DBus")?
                .member("NameOwnerChanged")?
                .add_arg(name)?
                .build(),
            &bus,
            Some(8),
        )?;
        for mut stream in [signals, owners] {
            let input = input.clone();
            std::thread::spawn(move || {
                while let Some(Ok(message)) = stream.next() {
                    if input.send(Input::Bus(connection, message)).is_err() {
                        return;
                    }
                }
                let _ = input.send(Input::Disconnected(connection));
            });
        }
        Ok(close)
    };
    let Ok(close) = start() else {
        return;
    };
    let bus = &close.0;
    let (name, path, interface, register) = service.endpoint();
    let current_owner = || -> Option<String> {
        bus.call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "GetNameOwner",
            &(name,),
        )
        .ok()?
        .body()
        .deserialize()
        .ok()
    };

    let mut observed = None;
    let mut owner = None;
    let mut pending = None;
    let mut check_owner = true;
    loop {
        if check_owner {
            check_owner = false;
            let current = current_owner();
            if current != observed {
                observed.clone_from(&current);
                owner = None;
                pending = None;
                if events.send(Event::Reset(service)).is_err() {
                    return;
                }
                if let Some(new) = current {
                    if bus
                        .call_method(Some(new.as_str()), path, Some(interface), register, &())
                        .is_ok()
                    {
                        owner = Some(new);
                    } else {
                        // A competing live renderer owns the slot. Keep it undisturbed.
                        eprintln!("nidara-shell: could not register the {name} prompt renderer");
                    }
                }
            }
        }
        match rx.recv() {
            Ok(Input::Bus(source, message)) if source == connection => {
                let header = message.header();
                if header
                    .sender()
                    .is_some_and(|s| s.as_str() == "org.freedesktop.DBus")
                    && header
                        .member()
                        .is_some_and(|m| m.as_str() == "NameOwnerChanged")
                {
                    check_owner = true;
                    continue;
                }
                let Some(owner) = owner.as_ref().filter(|o| {
                    header.sender().is_some_and(|s| s.as_str() == *o)
                        && header.path().is_some_and(|p| p.as_str() == path)
                        && header.interface().is_some_and(|i| i.as_str() == interface)
                }) else {
                    continue;
                };
                if let Some(event) = signal(service, owner, connection, &message, &mut pending)
                    && events.send(event).is_err()
                {
                    return;
                }
            }
            Ok(Input::Reply(ticket, answer)) => {
                if (pending.as_ref() != Some(&ticket) || reply(bus, &ticket, answer).is_err())
                    && events.send(Event::Failed(ticket)).is_err()
                {
                    return;
                }
            }
            Ok(Input::Disconnected(source)) if source == connection => return,
            Ok(_) => {}
            Err(_) => return,
        }
    }
}

fn signal(
    service: Service,
    owner: &str,
    connection: u64,
    message: &Message,
    pending: &mut Option<Ticket>,
) -> Option<Event> {
    let header = message.header();
    let member = header.member()?.as_str();
    let (epoch, id, data) = match (service, member) {
        (Service::Wifi, "SecretsRequested" | "SecretsClosed") => {
            let (id, data) = message.body().deserialize::<(u64, String)>().ok()?;
            (0, id, data)
        }
        (Service::Bluetooth, "Request" | "RequestUpdated" | "RequestClosed") => {
            message.body().deserialize::<(u64, u64, String)>().ok()?
        }
        _ => return None,
    };
    let ticket = Ticket {
        service,
        owner: owner.into(),
        connection,
        epoch,
        id,
    };
    match member {
        "SecretsRequested" | "Request" => {
            let metadata = serde_json::from_str(&data).ok()?;
            *pending = Some(ticket.clone());
            Some(Event::Prompt(ticket, metadata))
        }
        "RequestUpdated" if pending.as_ref() == Some(&ticket) => {
            Some(Event::Update(ticket, serde_json::from_str(&data).ok()?))
        }
        "SecretsClosed" | "RequestClosed" if pending.as_ref() == Some(&ticket) => {
            *pending = None;
            Some(Event::Closed(ticket))
        }
        _ => None,
    }
}

fn reply(bus: &Connection, ticket: &Ticket, answer: Answer) -> Result<(), ()> {
    let (_, path, interface, _) = ticket.service.endpoint();
    let target = Some(ticket.owner.as_str());
    let interface = Some(interface);
    let id = ticket.id;
    let epoch = ticket.epoch;
    let result = match (ticket.service, answer) {
        (Service::Wifi, Answer::Cancel) => {
            bus.call_method(target, path, interface, "CancelSecrets", &(id,))
        }
        (Service::Wifi, Answer::Wifi(values)) => {
            bus.call_method(target, path, interface, "SubmitSecrets", &(id, values))
        }
        (Service::Bluetooth, Answer::Cancel) => {
            bus.call_method(target, path, interface, "CancelRequest", &(epoch, id))
        }
        (Service::Bluetooth, Answer::Reject) => bus.call_method(
            target,
            path,
            interface,
            "ReplyRequest",
            &(epoch, id, false, ""),
        ),
        (Service::Bluetooth, Answer::Bluetooth(value)) => bus.call_method(
            target,
            path,
            interface,
            "ReplyRequest",
            &(epoch, id, true, value),
        ),
        _ => return Err(()),
    };
    result.map(|_| ()).map_err(|_| ())
}
