// SPDX-License-Identifier: LGPL-3.0-or-later
use super::{
    Error, Request, cancelled,
    conversation::{self, Event},
    plain,
};
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

const LOCK_ICON: &str = "nd-system-lock-screen";

enum Step {
    Waiting,
    Input(String),
    Retry,
}

#[derive(Default)]
struct Feedback {
    previous: Vec<String>,
    current: Vec<String>,
    failed: bool,
}

impl Feedback {
    /// A single PAM callback may contain several lines. Preserve their order
    /// together with any lines already received in the conversation.
    fn observe(&mut self, event: &Event) -> Option<String> {
        match event {
            Event::Info(text) | Event::Error(text) => {
                let message = text
                    .lines()
                    .map(|line| plain(line, 320))
                    .filter(|line| !line.trim().is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if message.is_empty() {
                    return None;
                }
                self.current.push(message.clone());
                Some(message)
            }
            Event::Completed(false) => {
                if !self.current.is_empty() {
                    self.previous = std::mem::take(&mut self.current);
                }
                self.failed = true;
                None
            }
            _ => None,
        }
    }

    fn lines(&self) -> impl Iterator<Item = &str> {
        self.previous
            .iter()
            .chain(&self.current)
            .map(String::as_str)
    }

    fn acknowledge(&mut self) {
        self.previous.clear();
        self.failed = false;
    }
}

struct View<'a> {
    request: Request,
    status: &'a Status,
    context: &'a glib::MainContext,
    library: &'a conversation::Library,
    session: Option<conversation::Session<'a>>,
    exports: Exports,
    locale_generation: u64,
    portal: Portal,
    names: Vec<String>,
    user: usize,
    answered: bool,
    prompt: usize,
    step: Step,
    value: Option<nk::Secret>,
    feedback: Feedback,
    expanded: bool,
    withdrawn: bool,
    granted: bool,
}

impl View<'_> {
    fn text(&self, key: &str) -> String {
        crate::i18n::text_for(&self.exports, key)
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
        self.answered = false;
        self.step = Step::Waiting;
        self.session = Some(
            conversation::Session::start(self.library, uid, &self.request.ticket.cookie)
                .ok_or("polkit could not start the PAM conversation")?,
        );
        Ok(())
    }
}

impl DialogContent for View<'_> {
    fn opened(&mut self) -> Result<()> {
        if self.session.is_none() && matches!(self.step, Step::Waiting) {
            self.start_attempt()?;
        }
        Ok(())
    }

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
        for (index, line) in self.feedback.lines().flat_map(str::lines).enumerate() {
            fields.push(label(&format!("polkit/status/{index}"), line.into()));
        }
        if self.feedback.failed {
            fields.push(label(
                "polkit/retry",
                self.text("shell.prompt.polkit.retry"),
            ));
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
                enabled: matches!(self.step, Step::Input(_) | Step::Retry),
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
                self.user = index;
                self.feedback = Feedback::default();
                self.start_attempt()?;
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
        if matches!(self.step, Step::Retry) {
            self.feedback.acknowledge();
            self.start_attempt()?;
        } else if matches!(self.step, Step::Input(_))
            && let Some(session) = &self.session
        {
            session.respond(self.value.take());
            self.answered = true;
            self.step = Step::Waiting;
            self.feedback.acknowledge();
        }
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
        let mut announcements = Vec::new();
        while let Some(event) = self.session.as_mut().and_then(conversation::Session::pop) {
            update.content_changed = true;
            if let Some(message) = self.feedback.observe(&event) {
                announcements.push(message);
            }
            match event {
                Event::Request(text, _echo_on) => {
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
                Event::Info(_) | Event::Error(_) => {}
                Event::Completed(granted) => {
                    self.session = None;
                    self.value = None;
                    if granted {
                        self.granted = true;
                        self.withdrawn = true;
                    } else {
                        announcements.push(self.text("shell.prompt.polkit.retry"));
                        if self.answered {
                            self.start_attempt()?;
                        } else {
                            // A preauth refusal may finish without a prompt.
                            // Let the user choose when to check again.
                            self.step = Step::Retry;
                        }
                    }
                    break;
                }
            }
        }
        let generation = crate::i18n::generation();
        if self.locale_generation != generation {
            self.locale_generation = generation;
            update.title = Some(self.text("shell.prompt.polkit.title"));
            update.close_label = Some(self.text("settings.window.close"));
            update.content_changed = true;
        }
        if !announcements.is_empty() {
            update.announcement = Some(announcements.join("\n"));
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
        if let Some((login, real_name)) = conversation::account_name(*uid) {
            let login = plain(&login, 100);
            let real_name = plain(&real_name, 100);
            if real_name.trim().is_empty() || real_name == login {
                names.push(login);
            } else {
                names.push(format!("{real_name} ({login})"));
            }
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
    let title = crate::i18n::text_for(&exports, "shell.prompt.polkit.title");
    let close_label = crate::i18n::text_for(&exports, "settings.window.close");
    let look = WindowLook::load(&exports, &appearance)?;
    let host = dialog_host(look, &title, appearance.reduced_motion)?;
    let mut view = View {
        request,
        status,
        context,
        library,
        session: None,
        exports,
        locale_generation: crate::i18n::generation(),
        portal,
        names,
        user,
        answered: false,
        prompt: 0,
        step: Step::Waiting,
        value: None,
        feedback: Feedback::default(),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polkit_feedback_preserves_lockout_lines_across_a_failed_conversation() {
        let mut feedback = Feedback::default();
        let events = [
            Event::Error("The account is locked due to failed logins.".into()),
            Event::Info("(7 minutes left to unlock)".into()),
            Event::Request("Password:".into(), false),
        ];
        let spoken: Vec<_> = events
            .iter()
            .filter_map(|event| feedback.observe(event))
            .collect();
        assert_eq!(
            spoken,
            [
                "The account is locked due to failed logins.",
                "(7 minutes left to unlock)"
            ]
        );
        // Submitting input must not remove any lines from the current attempt.
        feedback.acknowledge();
        assert!(feedback.observe(&Event::Completed(false)).is_none());
        assert!(feedback.failed);
        assert_eq!(feedback.lines().collect::<Vec<_>>(), spoken);
    }
}
