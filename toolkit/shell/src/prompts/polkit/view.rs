// SPDX-License-Identifier: LGPL-3.0-or-later
use super::{Error, Request, cancelled, conversation, plain};
use crate::{
    prompts::surface::{dialog_host, dialog_options},
    shell1::Status,
};
use nk::{
    Activated, AppWindow, Column, Dialog, DialogAnswer, DialogButton, DialogContent, DialogUpdate,
    DropDown, Expander, Image, Label, Node, PasswordEntry, Row, Space, Type, Value, Weight,
    WindowLook,
};
use nk_platform::{POLKIT_PROMPT_APP_ID, exports::Exports, portal::Portal};
use nk_wayland::Result;
use zbus::blocking::Connection;

const RETRIES: u8 = 3;
const LOCK_ICON: &str = "nd-system-lock-screen";

enum Step {
    Confirm,
    Waiting,
    Input(String),
    Retry,
}

struct View<'a> {
    request: Request,
    status: &'a Status,
    context: &'a glib::MainContext,
    library: &'a conversation::Library,
    session: Option<conversation::Session<'a>>,
    exports: Exports,
    portal: Portal,
    names: Vec<String>,
    user: usize,
    attempts: u8,
    prompt: usize,
    step: Step,
    value: Option<nk::Secret>,
    notice: Option<String>,
    expanded: bool,
    withdrawn: bool,
    granted: bool,
}

impl View<'_> {
    fn text(&self, key: &str) -> String {
        self.exports.text(key).unwrap_or("").into()
    }

    fn valid(&self) -> bool {
        self.request
            .ticket
            .valid(self.status, self.request.generation)
    }

    fn start_attempt(&mut self) -> Result<()> {
        if !self.valid() {
            self.withdrawn = true;
            return Ok(());
        }
        let uid = self.request.identities[self.user];
        self.value = None;
        self.notice = None;
        self.attempts += 1;
        self.step = Step::Waiting;
        self.session = Some(
            conversation::Session::start(self.library, uid, &self.request.ticket.cookie)
                .ok_or("polkit could not start the PAM conversation")?,
        );
        Ok(())
    }

    fn submit(&mut self) -> Result<()> {
        match &self.step {
            Step::Confirm | Step::Retry if self.attempts < RETRIES => self.start_attempt()?,
            Step::Input(_) if self.valid() => {
                if let Some(session) = &self.session {
                    session.respond(self.value.take());
                    self.step = Step::Waiting;
                    self.notice = None;
                }
            }
            _ => {}
        }
        Ok(())
    }
}

impl DialogContent for View<'_> {
    fn content(&mut self, host: &AppWindow) -> Node {
        let body = host.look().types.style(Type::Body, Weight::Regular);
        let label = |key: &str, text: String| -> Node {
            Label::new(key, text, body.clone()).lines(3).into()
        };
        let icon = &self.request.icon;
        let icon = if !icon.is_empty()
            && icon.len() <= 96
            && icon
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
        {
            Image::new("polkit/icon", icon, host.look().frame.icon).app_theme(LOCK_ICON)
        } else {
            Image::new("polkit/icon", LOCK_ICON, host.look().frame.icon)
        };
        let mut fields = vec![
            Row::new(
                "polkit/intro",
                vec![
                    icon.into(),
                    label("polkit/message", self.request.message.clone()),
                ],
            )
            .gap(Space::S2)
            .into(),
        ];
        let user_label = self.text("shell.prompt.polkit.account");
        if self.names.len() > 1 {
            fields.push(
                DropDown::new(
                    "polkit/account",
                    user_label,
                    "account",
                    self.names.clone(),
                    self.user,
                )
                .enabled(self.attempts < RETRIES)
                .into(),
            );
        } else {
            fields.push(label(
                "polkit/account",
                format!("{user_label} · {}", self.names[self.user]),
            ));
        }
        if let Step::Input(prompt) = &self.step {
            fields.push(label("polkit/question", prompt.clone()));
            fields.push(
                PasswordEntry::new(format!("polkit/input/{}", self.prompt), prompt, "response")
                    .into(),
            );
        }
        if let Some(notice) = &self.notice {
            fields.push(label("polkit/status", notice.clone()));
        }
        let mut details = vec![label("polkit/action", self.request.action.clone())];
        for (i, (key, value)) in self.request.details.iter().enumerate() {
            details.push(label(
                &format!("polkit/detail/{i}"),
                format!("{key} · {value}"),
            ));
        }
        fields.push(
            Expander::new(
                "polkit/details",
                self.text("shell.prompt.polkit.details"),
                "details",
                self.expanded,
            )
            .child(Column::new("polkit/details/body", details).gap(Space::S1))
            .into(),
        );
        Column::new("polkit/body", fields).gap(Space::S3).into()
    }

    fn buttons(&self) -> Option<Vec<DialogButton>> {
        Some(vec![
            DialogButton {
                id: "cancel".into(),
                label: self.text("settings.native.cancel"),
                default: false,
                cancel: true,
                destructive: false,
                enabled: true,
            },
            DialogButton {
                id: "authenticate".into(),
                label: self.text("shell.prompt.polkit.authenticate"),
                default: true,
                cancel: false,
                destructive: false,
                enabled: match self.step {
                    Step::Confirm | Step::Retry => self.attempts < RETRIES,
                    Step::Input(_) => true,
                    Step::Waiting => false,
                },
            },
        ])
    }

    fn activated(&mut self, action: Activated) -> Result<()> {
        match (action.action.as_str(), action.value) {
            ("response", Some(Value::Secret(secret))) if matches!(self.step, Step::Input(_)) => {
                self.value = Some(secret);
            }
            ("details", Some(Value::Bool(open))) => self.expanded = open,
            ("account", Some(Value::Index(index)))
                if index < self.names.len() && index != self.user =>
            {
                self.session = None;
                self.value = None;
                self.notice = None;
                self.user = index;
                self.step = Step::Confirm;
            }
            _ => {}
        }
        Ok(())
    }

    fn respond(&mut self, answer: &DialogAnswer, _: Option<&str>) -> Result<bool> {
        if !self.valid() {
            self.withdrawn = true;
            return Ok(true);
        }
        if answer == &DialogAnswer::Cancel {
            self.session = None;
            self.value = None;
            return Ok(true);
        }
        self.submit()?;
        Ok(false)
    }

    fn withdrawn(&self) -> bool {
        self.withdrawn
    }

    fn poll(&mut self) -> Result<DialogUpdate> {
        let mut update = DialogUpdate::default();
        if !self.valid() {
            self.withdrawn = true;
            self.value = None;
            self.session = None;
            return Ok(update);
        }

        // Dispatch PAM callbacks, on the same context as initiate/response/cancel.
        for _ in 0..16 {
            if !self.context.iteration(false) {
                break;
            }
        }
        while let Some(event) = self.session.as_mut().and_then(conversation::Session::pop) {
            update.content_changed = true;
            match event {
                conversation::Event::Request(text, _echo_on) => {
                    // Keep PAM input out of the text layout and assistive-technology
                    // tree even when a module enables terminal echo.
                    self.value = None;
                    self.prompt += 1;
                    let text = plain(&text, 240);
                    self.step = Step::Input(if text.is_empty() {
                        self.text("settings.users.password")
                    } else {
                        text
                    });
                    update.focus = Some(format!("polkit/input/{}", self.prompt).into());
                }
                conversation::Event::Info(text) | conversation::Event::Error(text) => {
                    let notice = plain(&text, 320);
                    update.announcement = Some(notice.clone());
                    self.notice = Some(notice);
                }
                conversation::Event::Completed(granted) => {
                    self.session = None;
                    self.value = None;
                    if granted {
                        self.granted = true;
                        self.withdrawn = true;
                    } else {
                        self.step = Step::Retry;
                        let notice = self.text(if self.attempts < RETRIES {
                            "shell.prompt.polkit.retry"
                        } else {
                            "shell.prompt.polkit.failed"
                        });
                        update.announcement = Some(notice.clone());
                        self.notice = Some(notice);
                    }
                }
            }
        }
        if !self.withdrawn && self.portal.changed() {
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

pub(super) fn run(
    status: &Status,
    bus: &Connection,
    context: &glib::MainContext,
    library: &conversation::Library,
    mut request: Request,
) -> Result<std::result::Result<(), Error>> {
    let mut names = Vec::new();
    request.identities.retain(|uid| {
        if let Some(name) = conversation::account_name(*uid) {
            names.push(plain(&name, 100));
            true
        } else {
            false
        }
    });
    if names.is_empty() {
        return Ok(Err(Error::Failed(
            "No authentication identity is available".into(),
        )));
    }
    // SAFETY: getuid has no arguments or preconditions.
    let current = unsafe { libc::getuid() };
    let user = request
        .identities
        .iter()
        .position(|uid| *uid == current)
        .unwrap_or(0);
    let exports = Exports::load(&Exports::root())?;
    let portal = Portal::watch(bus)?;
    let mut appearance = portal.read()?;
    appearance.dark = true;
    let title = exports.text("shell.prompt.polkit.title")?.to_owned();
    let close_label = exports.text("settings.window.close")?.to_owned();
    let look = WindowLook::load(&exports, &appearance)?;
    let host = dialog_host(look, &title, appearance.reduced_motion)?;
    let mut view = View {
        request,
        status,
        context,
        library,
        session: None,
        exports,
        portal,
        names,
        user,
        attempts: 0,
        prompt: 0,
        step: Step::Confirm,
        value: None,
        notice: None,
        expanded: false,
        withdrawn: false,
        granted: false,
    };
    if !view.valid() {
        return Ok(Err(cancelled()));
    }
    Dialog {
        title,
        close_label,
        buttons: Vec::new(),
    }
    .run_parentless(
        host,
        nk_wayland::Options {
            app_id: POLKIT_PROMPT_APP_ID,
            ..dialog_options()
        },
        None,
        &mut view,
    )?;
    Ok(if view.granted && view.valid() {
        Ok(())
    } else {
        Err(cancelled())
    })
}
