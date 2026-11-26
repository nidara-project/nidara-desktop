// SPDX-License-Identifier: LGPL-3.0-or-later
//! The shell's service models for the kit's independent dialog and alert windows.
use super::{Answer, Event, Request, Service, Ticket};
use crate::ccauth;
use nk::{
    Activated, Alert, AppWindow, Column, Dialog, DialogAnswer, DialogButton, DialogContent,
    DialogUpdate, Glyphs, Label, Labels, Node, PasswordEntry, Space, Type, Value, Weight,
    WindowLook,
};
use nk_platform::{exports::Exports, portal::Portal};
use nk_text::{FontSet, ParleyBackend};
use nk_wayland::{Options, Result};
use serde_json::Value as Json;
use std::sync::{Arc, mpsc};
use zbus::blocking::Connection;

use nk_platform::SESSION_PROMPT_APP_ID;

pub(super) enum Change {
    Metadata(Json),
    Failed,
    Stop,
}

pub(super) struct Running {
    pub serial: u64,
    pub ticket: Ticket,
    pub stopping: bool,
    input: mpsc::Sender<Change>,
}

impl Running {
    pub fn send(&self, change: Change) {
        let _ = self.input.send(change);
    }

    pub fn stop(&mut self) {
        if !self.stopping {
            self.stopping = true;
            self.send(Change::Stop);
        }
    }
}

pub(super) fn supports(ticket: &Ticket, meta: &Json) -> bool {
    Body::new(ticket.service, meta).is_some()
}

pub(super) fn start(
    serial: u64,
    request: &Request,
    bus: Connection,
    output: &mpsc::Sender<Event>,
) -> Option<Running> {
    let (tx, rx) = mpsc::channel();
    let ticket = request.ticket.clone();
    let meta = request.meta.clone();
    let events = output.clone();
    let target = ticket.clone();
    std::thread::Builder::new()
        .name("session-prompt".into())
        .spawn(move || {
            let result = run(serial, target.clone(), &meta, bus, rx, events.clone());
            if let Err(error) = result {
                eprintln!("nidara-shell: could not show the session prompt: {error}");
            }
            let _ = events.send(Event::Ended(serial, target));
        })
        .ok()?;
    Some(Running {
        serial,
        ticket,
        stopping: false,
        input: tx,
    })
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum BluetoothKind {
    Pin,
    Passkey,
    Confirm,
    DisplayPin,
    DisplayPasskey,
    Authorize,
    IncomingFile,
}

impl BluetoothKind {
    fn instruction(self) -> &'static str {
        match self {
            Self::Pin => "settings.bluetooth.pairing.enter-pin",
            Self::Passkey => "settings.bluetooth.pairing.enter-passkey",
            Self::Confirm => "settings.bluetooth.pairing.confirm-code",
            Self::DisplayPin | Self::DisplayPasskey => "settings.bluetooth.pairing.enter-on-device",
            Self::Authorize => "settings.bluetooth.pairing.authorize",
            Self::IncomingFile => "shell.prompt.bluetooth.receive",
        }
    }

    fn field(self) -> Option<&'static str> {
        match self {
            Self::Pin => Some("PIN"),
            Self::Passkey => Some("shell.prompt.bluetooth.passkey"),
            _ => None,
        }
    }

    fn consent(self) -> bool {
        matches!(self, Self::Confirm | Self::Authorize | Self::IncomingFile)
    }

    fn display(self) -> bool {
        matches!(self, Self::DisplayPin | Self::DisplayPasskey)
    }
}

struct Bluetooth {
    kind: BluetoothKind,
    meta: Json,
    value: Option<nk::Secret>,
}

impl Bluetooth {
    fn new(meta: &Json) -> Option<Self> {
        let kind = match meta["kind"].as_str()? {
            "enter-pin" => BluetoothKind::Pin,
            "enter-passkey" => BluetoothKind::Passkey,
            "confirm" => BluetoothKind::Confirm,
            "display-pin" => BluetoothKind::DisplayPin,
            "display-passkey" => BluetoothKind::DisplayPasskey,
            "authorize" | "authorize-service" => BluetoothKind::Authorize,
            "incoming-file" => BluetoothKind::IncomingFile,
            _ => return None,
        };
        if (kind.display() || kind == BluetoothKind::Confirm)
            && meta["code"].as_str().is_none_or(str::is_empty)
        {
            return None;
        }
        if kind == BluetoothKind::IncomingFile && meta["name"].as_str().is_none_or(str::is_empty) {
            return None;
        }
        Some(Self {
            kind,
            meta: meta.clone(),
            value: None,
        })
    }

    fn answer(&self) -> Option<&str> {
        let value = self.value.as_ref().map_or("", nk::Secret::as_str);
        match self.kind {
            BluetoothKind::Pin if (1..=16).contains(&value.chars().count()) => Some(value),
            BluetoothKind::Passkey
                if (1..=6).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_digit()) =>
            {
                Some(value)
            }
            BluetoothKind::Confirm | BluetoothKind::Authorize | BluetoothKind::IncomingFile => {
                Some("")
            }
            _ => None,
        }
    }

    fn update(&mut self, meta: &Json) {
        // The only update in Bluetooth1 is DisplayPasskey's entered-digit progress.
        if self.kind == BluetoothKind::DisplayPasskey
            && meta["kind"] == "display-passkey"
            && meta["code"] == self.meta["code"]
            && let Some(entered) = meta["entered"].as_u64().filter(|n| *n <= 6)
        {
            self.meta["entered"] = entered.into();
        }
    }
}

enum Body {
    Wifi(ccauth::Form),
    Bluetooth(Bluetooth),
}

impl Body {
    fn new(service: Service, meta: &Json) -> Option<Self> {
        match service {
            Service::Wifi => ccauth::Form::new(meta).map(Self::Wifi),
            Service::Bluetooth => Bluetooth::new(meta).map(Self::Bluetooth),
        }
    }

    fn title(&self) -> &str {
        match self {
            Self::Wifi(_) => "shell.prompt.wifi.title",
            Self::Bluetooth(_) => "settings.bluetooth.title",
        }
    }

    fn edit(&mut self, id: &str, value: &Value) {
        let Value::Secret(value) = value else {
            return;
        };
        match self {
            Self::Wifi(form) => {
                if let Some(field) = form.fields.iter_mut().find(|field| field.key == id) {
                    field.value = Some(value.clone());
                }
            }
            Self::Bluetooth(form) if id == "code" && form.kind.field().is_some() => {
                form.value = Some(value.clone());
            }
            _ => {}
        }
    }

    fn ready(&self) -> bool {
        match self {
            Self::Wifi(form) => form.ready(),
            Self::Bluetooth(form) => form.answer().is_some(),
        }
    }

    fn answer(&self) -> Option<Answer> {
        match self {
            Self::Wifi(form) if form.ready() => Some(Answer::Wifi(form.values())),
            Self::Bluetooth(form) => form.answer().map(|v| Answer::Bluetooth(v.to_owned())),
            _ => None,
        }
    }

    fn content(&self, host: &AppWindow, exports: &Exports, busy: bool, failed: bool) -> Node {
        let text = |key: &str| exports.text(key).unwrap_or("").to_owned();
        let types = &host.look().types;
        let body = types.style(Type::Body, Weight::Regular);
        let label = |key: &str, value: String| -> Node {
            Label::new(key, value, body.clone()).lines(2).into()
        };
        let field = |id: &str, name: String| -> Node {
            Column::new(
                format!("field/{id}"),
                vec![
                    label(&format!("label/{id}"), name.clone()),
                    PasswordEntry::new(format!("input/{id}"), name, format!("edit/{id}"))
                        .enabled(!busy)
                        .into(),
                ],
            )
            .gap(Space::S1)
            .into()
        };
        let mut fields = Vec::new();
        match self {
            Self::Wifi(form) => {
                if !form.name.is_empty() {
                    fields.push(label("network", form.name.clone()));
                }
                if !form.identity.is_empty() {
                    fields.push(label("identity", form.identity.clone()));
                }
                if form.retry {
                    fields.push(label("retry", text("settings.network.ap.failed")));
                }
                for entry in &form.fields {
                    let name = match entry.key.as_str() {
                        "private-key-password" => text("cc.detail.certificate-password"),
                        "phase2-private-key-password" => {
                            text("cc.detail.inner-certificate-password")
                        }
                        "pin" => "PIN".into(),
                        _ => text("settings.users.password"),
                    };
                    fields.push(field(&entry.key, name));
                }
            }
            Self::Bluetooth(form) => {
                let meta = &form.meta;
                let device = meta["deviceName"]
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .or(meta["address"].as_str())
                    .unwrap_or("");
                fields.push(label("device", device.into()));
                if !form.kind.consent() {
                    fields.push(label("instruction", text(form.kind.instruction())));
                }
                if let Some(code) = meta["code"]
                    .as_str()
                    .filter(|_| form.kind.display() || form.kind == BluetoothKind::Confirm)
                {
                    fields.push(
                        Label::new("code", code, types.style(Type::Title2, Weight::Regular)).into(),
                    );
                }
                if let Some(entered) = meta["entered"]
                    .as_u64()
                    .filter(|_| form.kind == BluetoothKind::DisplayPasskey)
                {
                    fields.push(label(
                        "progress",
                        text("shell.prompt.bluetooth.progress")
                            .replace("{entered}", &entered.to_string()),
                    ));
                }
                if let Some(name) = form.kind.field() {
                    fields.push(field(
                        "code",
                        if name == "PIN" {
                            name.into()
                        } else {
                            text(name)
                        },
                    ));
                }
                if form.kind == BluetoothKind::IncomingFile {
                    fields.push(label(
                        "filename",
                        meta["name"].as_str().unwrap_or("").into(),
                    ));
                    let size = meta["size"].as_u64().map_or_else(
                        || text("shell.prompt.bluetooth.unknown-size"),
                        |bytes| {
                            text("shell.prompt.bluetooth.file-size")
                                .replace("{bytes}", &bytes.to_string())
                        },
                    );
                    fields.push(label("size", size));
                }
            }
        }
        if failed {
            fields.push(label("error", text("shell.prompt.error")));
        }
        Column::new("prompt/fields", fields).gap(Space::S3).into()
    }

    fn submit_label(&self) -> Option<&'static str> {
        match self {
            Self::Wifi(_) => Some("settings.network.ap.connect"),
            Self::Bluetooth(form) if form.kind.display() => None,
            Self::Bluetooth(form) if form.kind == BluetoothKind::IncomingFile => {
                Some("shell.prompt.bluetooth.accept-file")
            }
            Self::Bluetooth(_) => Some("settings.bluetooth.pairing.confirm"),
        }
    }

    fn alert_message(&self) -> Option<&'static str> {
        match self {
            Self::Bluetooth(form) if form.kind.consent() => Some(form.kind.instruction()),
            _ => None,
        }
    }
}

struct Prompt {
    serial: u64,
    ticket: Ticket,
    input: mpsc::Receiver<Change>,
    events: mpsc::Sender<Event>,
    exports: Exports,
    portal: Portal,
    body: Body,
    busy: bool,
    failed: bool,
    withdrawn: bool,
}

impl DialogContent for Prompt {
    fn content(&mut self, host: &AppWindow) -> Node {
        self.body
            .content(host, &self.exports, self.busy, self.failed)
    }

    fn buttons(&self) -> Option<Vec<DialogButton>> {
        let (id, label) = if self.body.alert_message().is_some() {
            ("reject", "shell.prompt.bluetooth.reject")
        } else {
            ("cancel", "settings.native.cancel")
        };
        let mut buttons = vec![DialogButton {
            id: id.into(),
            label: self.exports.text(label).unwrap_or("").into(),
            default: false,
            cancel: true,
            destructive: false,
            enabled: !self.busy,
        }];
        if let Some(key) = self.body.submit_label() {
            buttons.push(DialogButton {
                id: "submit".into(),
                label: self.exports.text(key).unwrap_or("").into(),
                default: true,
                cancel: false,
                destructive: false,
                enabled: !self.busy && self.body.ready(),
            });
        }
        Some(buttons)
    }

    fn activated(&mut self, action: Activated) -> Result<()> {
        if !self.busy
            && let Some(id) = action.action.strip_prefix("edit/")
            && let Some(value) = &action.value
        {
            self.body.edit(id, value);
            self.failed = false;
        }
        Ok(())
    }

    fn respond(&mut self, answer: &DialogAnswer, button: Option<&str>) -> Result<bool> {
        if self.busy {
            return Ok(false);
        }
        let answer = match answer {
            DialogAnswer::Cancel if button == Some("reject") => Some(Answer::Reject),
            DialogAnswer::Cancel => Some(Answer::Cancel),
            DialogAnswer::Button(id) if id == "submit" => self.body.answer(),
            DialogAnswer::Button(_) => None,
        };
        if let Some(answer) = answer {
            self.events
                .send(Event::Answer(self.serial, self.ticket.clone(), answer))
                .map_err(|_| "the session prompt owner disconnected")?;
            self.busy = true;
            self.failed = false;
        }
        // Service close owns withdrawal. A failed reply restores the form.
        Ok(false)
    }

    fn withdrawn(&self) -> bool {
        self.withdrawn
    }

    fn poll(&mut self) -> Result<DialogUpdate> {
        let mut update = DialogUpdate::default();
        for change in self.input.try_iter() {
            match change {
                Change::Metadata(meta) => {
                    if let Body::Bluetooth(bluetooth) = &mut self.body {
                        bluetooth.update(&meta);
                        update.content_changed = true;
                    }
                }
                Change::Failed => {
                    self.busy = false;
                    self.failed = true;
                    update.content_changed = true;
                }
                Change::Stop => {
                    self.withdrawn = true;
                    return Ok(update);
                }
            }
        }
        if self.portal.changed() {
            let mut appearance = self.portal.read()?;
            appearance.dark = true;
            update.appearance = Some((
                WindowLook::load(&self.exports, &appearance)?,
                appearance.reduced_motion,
            ));
        }
        Ok(update)
    }
}

fn run(
    serial: u64,
    ticket: Ticket,
    meta: &Json,
    bus: Connection,
    input: mpsc::Receiver<Change>,
    events: mpsc::Sender<Event>,
) -> Result<()> {
    let body = Body::new(ticket.service, meta).ok_or("unsupported session prompt")?;
    let exports = Exports::load(&Exports::root())?;
    let portal = Portal::watch(&bus)?;
    let mut appearance = portal.read()?;
    appearance.dark = true;
    let look = WindowLook::load(&exports, &appearance)?;
    let title = exports.text(body.title())?.to_owned();
    let labels = Labels {
        show_sidebar: String::new(),
        hide_sidebar: String::new(),
        back: String::new(),
        forward: String::new(),
    };
    let alert_message = body
        .alert_message()
        .map(|key| exports.text(key).map(str::to_owned))
        .transpose()?;
    let close_label = exports.text("settings.window.close")?.to_owned();
    let host = AppWindow::new(
        look,
        labels,
        &title,
        Box::new(ParleyBackend::new(Arc::new(FontSet::discover_required()?))?),
        Glyphs::new(nk_icons::Icons::new(
            "",
            &[],
            &crate::paths::icon_reference(),
        )?),
        appearance.reduced_motion,
    );
    let mut app = Prompt {
        serial,
        ticket,
        input,
        events,
        exports,
        portal,
        body,
        busy: false,
        failed: false,
        withdrawn: false,
    };
    let activation = meta["activationToken"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_owned);
    let options = Options {
        material: true,
        map: true,
        app_id: SESSION_PROMPT_APP_ID,
        title: "",
        size: (440, 385),
        require_material: None,
    };
    if let Some(message) = alert_message {
        Alert {
            title,
            message,
            detail: None,
            buttons: Vec::new(),
        }
        .run_parentless(host, options, activation, &mut app)?;
    } else {
        Dialog {
            title,
            close_label,
            buttons: Vec::new(),
        }
        .run_parentless(host, options, activation, &mut app)?;
    }
    Ok(())
}
