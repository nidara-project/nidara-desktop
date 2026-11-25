// SPDX-License-Identifier: LGPL-3.0-or-later
//! The shared prompt's layer and kit components. A retired layer drops all input.
use super::{Answer, Event, Request, Service, Ticket};
use crate::ccauth;
use nk::Widget;
use nk::{
    Activated, AppWindow, Button, Column, Corner, Glyphs, Label, Labels, Node, Padding, Page, Pane,
    PasswordEntry, Radius, Row, Scroll, Space, Type, Value, Weight, WindowLook,
};
use nk_platform::{exports::Exports, portal::Portal};
use nk_text::{FontSet, ParleyBackend};
use nk_wayland::{
    Application, ControlsButtons, Event as Wayland, Frame, Material, Options, Result, Window,
};
use serde_json::Value as Json;
use std::{
    sync::{Arc, mpsc},
    time::Instant,
};
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

    fn has_input(&self) -> bool {
        match self {
            Self::Wifi(_) => true,
            Self::Bluetooth(form) => form.kind.field().is_some(),
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

    fn page(
        &self,
        host: &AppWindow,
        exports: &Exports,
        busy: bool,
        failed: bool,
        controls: Option<nk_wayland::ControlsLayout>,
    ) -> Page {
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
        let submit = match self {
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
                Some("settings.network.ap.connect")
            }
            Self::Bluetooth(form) => {
                let meta = &form.meta;
                let device = meta["deviceName"]
                    .as_str()
                    .filter(|n| !n.is_empty())
                    .or(meta["address"].as_str())
                    .unwrap_or("");
                fields.push(label("device", device.into()));
                fields.push(label("instruction", text(form.kind.instruction())));
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
                    Some("shell.prompt.bluetooth.accept-file")
                } else if form.kind.display() {
                    None
                } else {
                    Some("settings.bluetooth.pairing.confirm")
                }
            }
        };
        if failed {
            fields.push(label("error", text("shell.prompt.error")));
        }
        let (dismiss, action) = match self {
            Self::Bluetooth(form) if form.kind.consent() => {
                ("shell.prompt.bluetooth.reject", "reject")
            }
            _ => ("settings.native.cancel", "cancel"),
        };
        let mut buttons = vec![
            Button::new("cancel", text(dismiss), action, body.clone())
                .enabled(!busy)
                .into(),
        ];
        if let Some(key) = submit {
            buttons.push(
                Button::new("submit", text(key), "submit", body)
                    .enabled(!busy && self.ready())
                    .into(),
            );
        }
        let title = text(self.title());
        let mut header = vec![
            Label::new(
                "title",
                title.clone(),
                types.style(Type::Subtitle, Weight::Semibold),
            )
            .grow()
            .into(),
        ];
        if let Some(controls) = controls {
            let index = if controls.side == nk_wayland::ControlsSide::Left {
                0
            } else {
                1
            };
            header.insert(index, nk::Slot::new("controls/room", controls.width).into());
        }
        let content = Column::new(
            "layout",
            vec![
                Row::new("header", header).gap(Space::S2).into(),
                Scroll::new(
                    "fields",
                    Column::new("prompt/fields", fields).gap(Space::S3),
                )
                .grow()
                .into(),
                Row::new("actions", buttons)
                    .gap(Space::S2)
                    .justify(nk::Justify::End)
                    .into(),
            ],
        )
        .gap(Space::S3)
        .padding(Padding::all(Space::S4));
        Page {
            title,
            sidebar: Column::new("sidebar", vec![]).into(),
            content: Pane::new("pane", Corner::Token(Radius::Md), content).into(),
            can_back: false,
            can_forward: false,
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
    host: AppWindow,
    busy: bool,
    failed: bool,
    initial_focus: bool,
    activation: Option<String>,
    controls: Option<nk_wayland::ControlsLayout>,
}

impl Prompt {
    fn show(&mut self) {
        self.host.show(self.body.page(
            &self.host,
            &self.exports,
            self.busy,
            self.failed,
            self.controls,
        ));
    }

    fn changes(&mut self, window: &mut Window) -> Result<()> {
        let mut dirty = false;
        for update in self.input.try_iter() {
            match update {
                Change::Metadata(meta) => {
                    if let Body::Bluetooth(bluetooth) = &mut self.body {
                        bluetooth.update(&meta);
                        dirty = true;
                    }
                }
                Change::Failed => {
                    self.busy = false;
                    self.failed = true;
                    dirty = true;
                }
                Change::Stop => {
                    window.close();
                    return Ok(());
                }
            }
        }
        if self.portal.changed() {
            let mut appearance = self.portal.read()?;
            appearance.dark = true;
            self.host.set_look(
                WindowLook::load(&self.exports, &appearance)?,
                appearance.reduced_motion,
            );
        }
        if dirty {
            self.show();
        }
        Ok(())
    }

    fn answer(&mut self, answer: Answer) {
        if !self.busy
            && self
                .events
                .send(Event::Answer(self.serial, self.ticket.clone(), answer))
                .is_ok()
        {
            self.busy = true;
            self.failed = false;
            self.show();
        }
    }

    fn submit(&mut self) {
        if !self.busy
            && let Some(answer) = self.body.answer()
        {
            self.answer(answer);
        }
    }

    fn actions(&mut self, actions: Vec<Activated>) {
        for action in actions {
            if self.busy {
                break;
            }
            match action.action.as_str() {
                "submit" => self.submit(),
                "cancel" => self.answer(Answer::Cancel),
                "reject" => self.answer(Answer::Reject),
                name if let Some(id) = name.strip_prefix("edit/")
                    && let Some(value) = &action.value =>
                {
                    self.body.edit(id, value);
                    self.failed = false;
                    self.show();
                }
                _ => {}
            }
        }
    }

    fn commit(&mut self, window: &mut Window) -> Result<()> {
        self.host.commit(window, |host| {
            self.body
                .page(host, &self.exports, self.busy, self.failed, self.controls)
        })
    }
}

impl Application for Prompt {
    fn window_controls(&self) -> bool {
        true
    }
    fn window_control_buttons(&self) -> ControlsButtons {
        ControlsButtons::Close
    }

    fn poll_interval_ms(&self) -> u32 {
        self.host.poll_interval_ms()
    }

    fn idle(&mut self, window: &mut Window) -> Result<()> {
        self.changes(window)?;
        if !window.is_closed() {
            if window.commits() > 1
                && let Some(token) = self.activation.take()
            {
                let _ = window.activate(token);
            }
            let actions = self.host.idle()?;
            self.actions(actions);
            self.commit(window)?;
        }
        Ok(())
    }

    fn event(&mut self, event: Wayland, window: &mut Window) -> Result<()> {
        self.changes(window)?;
        if window.is_closed() || matches!(event, Wayland::Closed) {
            return Ok(());
        }
        let gets_focus = matches!(event, Wayland::Focus(true));
        match event {
            Wayland::CloseRequested => self.answer(Answer::Cancel),
            Wayland::ControlsLayout(controls) => {
                self.controls = Some(controls);
                self.host.event(Wayland::ControlsLayout(controls), window)?;
                self.show();
            }
            Wayland::Key(ref key) if key.sym == 0xff1b => self.answer(Answer::Cancel),
            Wayland::Key(ref key) if matches!(key.sym, 0xff0d | 0xff8d) => {
                if let Some((handled, actions)) = self.host.dialog_enter(key) {
                    self.actions(actions);
                    if !handled && self.body.has_input() {
                        self.submit();
                    }
                }
            }
            event => {
                let (_, actions) = self.host.event(event, window)?;
                self.actions(actions);
            }
        }
        if self.initial_focus && gets_focus {
            if self.body.has_input() {
                self.host.focus_first_under("prompt/fields");
            }
            self.initial_focus = false;
        }
        self.commit(window)
    }

    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        self.host.paint(frame)
    }

    fn material(&self) -> Option<Material> {
        self.host.material()
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
    let mut host = AppWindow::new(
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
    host.set_standalone_dialog();
    let mut app = Prompt {
        serial,
        ticket,
        input,
        events,
        exports,
        portal,
        body,
        host,
        busy: false,
        failed: false,
        initial_focus: true,
        controls: None,
        activation: meta["activationToken"]
            .as_str()
            .filter(|t| !t.is_empty())
            .map(str::to_owned),
    };
    app.show();
    let size = (440, 385);
    nk_wayland::run(
        app,
        Options {
            material: true,
            map: true,
            app_id: SESSION_PROMPT_APP_ID,
            title: &title,
            size,
            require_material: None,
        },
        Instant::now(),
    )
}
