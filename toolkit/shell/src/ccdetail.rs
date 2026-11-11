// SPDX-License-Identifier: LGPL-3.0-or-later
//! Same-surface detail views. Row identities follow backend paths, never list positions.
use super::*;
use crate::menu::Label;
use serde_json::Value;

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    WiredPower(String, bool),
    Deactivate(String),
    ClipboardList,
    ClipboardConfirm(bool),
    Clipboard {
        id: Option<String>,
        revision: u64,
        remove: bool,
        wipe: bool,
    },
    Call {
        owner: String,
        action: Box<Action>,
    },
    Back,
    SecretFocus(usize),
    SecretSubmit,
    SecretCancel,
    Number(&'static str, i32),
    Time(&'static str, i32),
    Brightness {
        device: String,
        epoch: u64,
        min: u32,
        max: u32,
        percent: f64,
    },
    WifiPower(bool),
    Scan(String),
    Connect {
        device: String,
        ap: String,
        uuid: String,
    },
    Disconnect(String),
    Activate(String),
    Bluetooth {
        device: String,
        connect: bool,
    },
    AudioDefault(String),
    AudioVolume(String, f64),
    AudioMute(String, bool),
    Player(String),
    Media(&'static str),
    Seek {
        player: String,
        revision: u64,
        seconds: f64,
    },
    BluetoothPower(String, bool),
    Pref(&'static str, crate::menu::PrefValue),
    SetMode(&'static str),
    ToggleAudio,
    Capture {
        mode: &'static str,
        copy: bool,
    },
    Record {
        mode: &'static str,
        audio: bool,
    },
    StopRecording,
}
impl Action {
    pub fn coalescing_key(&self) -> Option<String> {
        Some(match self {
            Self::Call { owner, action } => format!("{owner}:{}", action.coalescing_key()?),
            Self::AudioVolume(path, _) => format!("volume:{path}"),
            Self::Number(key, _) | Self::Time(key, _) => format!("config:{key}"),
            Self::Brightness { device, epoch, .. } => format!("brightness:{device}:{epoch}"),
            Self::Seek {
                player, revision, ..
            } => format!("seek:{player}:{revision}"),
            _ => return None,
        })
    }
    pub fn connects(&self) -> bool {
        match self {
            Self::Connect { .. } | Self::Activate(_) => true,
            Self::Call { action, .. } => action.connects(),
            _ => false,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Row {
    key: String,
    label: Label,
    description: String,
    pub action: Option<Action>,
    pub value: Option<(f64, f64, f64)>,
    checked: Option<bool>,
    /// Whether `checked` is shown as a switch at the row's end (VIEW.md §12.6) rather than as
    /// a choice's mark at its start.
    switch: bool,
    prefix: Option<&'static str>,
    max_write: Option<f64>,
    owner: String,
    pub id: u64,
    thumbnail: Option<(u64, String)>,
}
impl Row {
    fn new(key: impl Into<String>, label: Label, action: Option<Action>) -> Self {
        Self {
            key: key.into(),
            label,
            description: String::new(),
            action,
            value: None,
            checked: None,
            switch: false,
            prefix: None,
            max_write: None,
            owner: String::new(),
            id: 0,
            thumbnail: None,
        }
    }
    fn button(key: impl Into<String>, label: impl Into<String>, action: Action) -> Self {
        Self::new(key, Label::Text(label.into()), Some(action))
    }
    fn key(key: &'static str, action: Action) -> Self {
        Self::new(key, Label::Key(key), Some(action))
    }
    fn owner(mut self, owner: &str) -> Self {
        self.owner = owner.to_owned();
        self
    }
    fn max_write(mut self, value: f64) -> Self {
        self.max_write = Some(value);
        self
    }
    fn prefix(mut self, key: &'static str) -> Self {
        self.prefix = Some(key);
        self
    }
    fn label(&self, look: Option<&Look>) -> String {
        let text = |label: &Label| {
            look.map_or_else(
                || match label {
                    Label::Key(k) => k.to_string(),
                    Label::Text(t) => t.clone(),
                },
                |l| l.text_of(label),
            )
        };
        let label = text(&self.label);
        self.prefix.map_or(label.clone(), |key| {
            format!("{} · {}", text(&Label::Key(key)), label)
        })
    }
    /// A choice among several: a mark at the row's start.
    fn toggle(mut self, checked: bool) -> Self {
        self.checked = Some(checked);
        self
    }
    /// A setting that is on or off: a switch at the row's end, where TS had a `Gtk.Switch`.
    fn switch(mut self, on: bool) -> Self {
        self.checked = Some(on);
        self.switch = true;
        self
    }
    fn slider(mut self, min: f64, max: f64, current: f64) -> Self {
        self.value = Some((min, max, current.clamp(min, max)));
        self
    }
}

pub struct Detail {
    pub page: &'static str,
    pub rows: Vec<Row>,
    pub panel: [f64; 4],
    ids: HashMap<String, u64>,
    next_id: u64,
    pub mode: &'static str,
    pub audio: bool,
    pub clipboard_confirm: bool,
    pub error: String,
    pub max_height: f64,
    /// The output's scale, for crisp edges.
    pub scale: f64,
    pub auth_ready: bool,
    pub form: Option<crate::ccauth::Form>,
    /// The rows' layout, hover, press, focus, held slider and scroll: nk-view's (#1048).
    pub state: nk_view::ViewState,
    pub tokens: Option<nk_view::Tokens>,
    appearance: Option<nk_platform::portal::Appearance>,
    /// What the last painted frame declared: `states` reads it after `paint`.
    last: nk_view::Frame,
}
/// The view's scroll region: the rows past the output's height scroll.
const LIST: &str = "list";
/// Ids for the view's few regions, under the CC's other washes.
const REGIONS: u32 = 100000;
fn row_key(id: u64) -> nk_view::Key {
    nk_view::Key::from(format!("r{id}"))
}
fn row_of(key: &nk_view::Key) -> Option<u64> {
    key.0.strip_prefix('r')?.split('/').next()?.parse().ok()
}
/// A row's slider value as it reads: a time of day as hours and minutes.
fn value_text(action: &Option<Action>, v: f64) -> String {
    if matches!(action, Some(Action::Time(..))) {
        format!("{:02}:{:02}", v as i32 / 60, v as i32 % 60)
    } else {
        format!("{v:.0}")
    }
}
fn sized(base: &TextStyle, size: f32) -> TextStyle {
    TextStyle {
        size,
        line_height: 1.3,
        ..base.clone()
    }
}
impl Detail {
    pub fn new(page: &'static str, generation: u64) -> Self {
        Self {
            page,
            rows: vec![],
            panel: [0.; 4],
            ids: HashMap::new(),
            next_id: generation * 10000,
            mode: if page == "screenshot" {
                "area"
            } else {
                "screen"
            },
            audio: false,
            clipboard_confirm: false,
            error: String::new(),
            max_height: 1080.,
            scale: 1.,
            auth_ready: false,
            form: None,
            state: nk_view::ViewState::new(REGIONS),
            tokens: None,
            appearance: None,
            last: nk_view::Frame::default(),
        }
    }
    /// The rows for `status`, laid out in `panel` when the look is there (without it, as in
    /// tests that lay out themselves, only the model changes).
    pub fn refresh(&mut self, status: &Status, panel: [f64; 4], look: Option<&mut Look>) {
        self.model(status);
        self.panel = panel;
        let Some(look) = look else {
            return;
        };
        if self.appearance.as_ref() != Some(&look.appearance) {
            self.appearance = Some(look.appearance.clone());
            self.tokens = crate::nc_view::tokens(&look.exports, &look.appearance)
                .map_err(|e| eprintln!("nidara-shell: the CC detail has no tokens: {e}"))
                .ok();
            self.state
                .set_reduced_motion(look.appearance.reduced_motion);
        }
        let labels: Vec<String> = self.rows.iter().map(|r| r.label(Some(look))).collect();
        let remove = super::edit::Editor::action_label("Remove", Some(look));
        let style = look.styles.text.clone();
        self.lay(&mut look.text, &style, &labels, &remove, panel);
    }
    fn model(&mut self, status: &Status) {
        let mut rows = if let Some(form) = &self.form {
            let mut fields: Vec<_> = form
                .fields
                .iter()
                .enumerate()
                .map(|(i, f)| {
                    let label = match f.key.as_str() {
                        "private-key-password" => Label::Key("cc.detail.certificate-password"),
                        "phase2-private-key-password" => {
                            Label::Key("cc.detail.inner-certificate-password")
                        }
                        "pin" => Label::Text("PIN".into()),
                        _ => Label::Key("settings.users.password"),
                    };
                    Row::new(
                        format!("secret:{}:{}", form.id, f.key),
                        label,
                        Some(Action::SecretFocus(i)),
                    )
                })
                .collect();
            if !form.name.is_empty() {
                let mut prompt = Row::new("prompt-name", Label::Text(form.name.clone()), None);
                prompt.description = form.identity.clone();
                fields.insert(0, prompt);
            }
            if form.retry {
                fields.insert(
                    0,
                    Row::new("retry", Label::Key("settings.network.ap.failed"), None),
                );
            }
            fields.push(Row::key(
                "settings.network.ap.connect",
                Action::SecretSubmit,
            ));
            fields.push(Row::key("settings.native.cancel", Action::SecretCancel));
            fields
        } else {
            rows(self.page, status, self.mode, self.audio)
        };
        if self.page == "clipboard" && self.clipboard_confirm {
            rows.retain(|r| !matches!(r.action, Some(Action::ClipboardConfirm(_))));
            rows.push(Row::key(
                "widget.clipboard.clear.cancel",
                Action::ClipboardConfirm(false),
            ));
            rows.push(Row::key(
                "widget.clipboard.clear.confirm",
                Action::Clipboard {
                    id: None,
                    revision: status.aux.clip_revision,
                    remove: false,
                    wipe: true,
                },
            ));
        }
        if self.page == "wifi" && !self.auth_ready {
            for r in &mut rows {
                if matches!(r.action, Some(Action::Connect { .. } | Action::Activate(_))) {
                    r.action = None;
                }
            }
        }
        if !self.error.is_empty() {
            rows.insert(0, Row::new("error", Label::Text(self.error.clone()), None));
        }
        let mut back = Row::key("cc.detail.back", Action::Back);
        back.prefix = Some(name_key(self.page));
        rows.insert(0, back);
        for row in &mut rows {
            let identity = format!("{}:{}", row.owner, row.key);
            row.id = *self.ids.entry(identity).or_insert_with(|| {
                self.next_id += 1;
                self.next_id
            });
        }
        self.rows = rows;
    }

    /// The view: one control per row, in a region that scrolls when the output is short.
    fn view(&self, style: &TextStyle, labels: &[String], remove: &str) -> nk_view::Node {
        use nk_view::{Corner, Ink, Node, Padding, Radius, Role, Space};
        let body = sized(style, TEXT);
        let small = sized(style, SMALL);
        let rows = self
            .rows
            .iter()
            .zip(labels)
            .map(|(row, label)| {
                let key = row_key(row.id);
                let id = row.id;
                let k = move |part: &str| format!("r{id}/{part}");
                let enabled = row.action.is_some();
                let title = Node::text(k("label"), label.clone(), body.clone()).lines(1);
                if let Some((min, max, current)) = row.value {
                    // A slider row: its name and value over its track; the track is the control.
                    let step = if matches!(
                        row.action,
                        Some(Action::Number("nightlight.temperature", _))
                    ) {
                        100.
                    } else {
                        1.
                    };
                    let head = Node::row(
                        k("head"),
                        vec![
                            title.grow(),
                            Node::text(k("value"), value_text(&row.action, current), small.clone())
                                .ink(Ink::Secondary),
                        ],
                    )
                    .gap(Space::S2);
                    let slider = Node::slider(
                        key,
                        label.clone(),
                        "row",
                        nk_view::Slider::new(min, max, step, current),
                    )
                    .enabled(enabled)
                    .description(row.description.clone());
                    return Node::column(k("slot"), vec![head, slider])
                        .gap(Space::S1)
                        .padding(Padding::symmetric(Space::S2, Space::S2));
                }
                if let Some(Action::SecretFocus(index)) = row.action {
                    // A secret field: its bullets only (VIEW.md §12.2).
                    let (shown, caret, anchor) = self
                        .form
                        .as_ref()
                        .and_then(|f| f.fields.get(index))
                        .map(|f| {
                            let count = |end: usize| f.text[..end].chars().count().min(32);
                            let dot = '•'.len_utf8();
                            (
                                "•".repeat(count(f.text.len())),
                                count(f.caret) * dot,
                                count(f.anchor.min(f.text.len())) * dot,
                            )
                        })
                        .unwrap_or_default();
                    let field = Node::field(
                        k("field"),
                        label.clone(),
                        "submit",
                        nk_view::Field {
                            shown,
                            caret,
                            anchor,
                            secret: true,
                        },
                        small.clone(),
                    );
                    return Node::column(k("slot"), vec![title, field])
                        .gap(Space::S1)
                        .padding(Padding::symmetric(Space::S2, Space::S3));
                }
                let mut line = vec![];
                if row.checked.is_some() && !row.switch {
                    line.push(Node::slot(k("check"), 10.));
                }
                if row.thumbnail.is_some() {
                    line.push(Node::slot(k("thumb"), 32.));
                }
                let mut text = vec![title];
                if !row.description.is_empty() {
                    text.push(
                        Node::text(k("sub"), row.description.clone(), small.clone())
                            .lines(1)
                            .ink(Ink::Secondary),
                    );
                }
                line.push(Node::column(k("text"), text).grow());
                let clip_row = matches!(
                    row.action,
                    Some(Action::Clipboard {
                        wipe: false,
                        remove: false,
                        ..
                    })
                );
                if let (true, Some(on)) = (row.switch, row.checked) {
                    line.push(Node::switch(k("switch"), on));
                }
                if clip_row {
                    line.push(
                        Node::control(
                            k("remove"),
                            remove,
                            "remove",
                            Node::text(k("x"), "×", body.clone()),
                        )
                        .corner(Corner::Pill),
                    );
                }
                let control = Node::control(
                    key,
                    label.clone(),
                    "row",
                    Node::row(k("line"), line)
                        .gap(Space::S2)
                        .align(nk_view::Align::Center)
                        .padding(Padding::symmetric(Space::S3, Space::S2)),
                )
                .corner(Corner::Token(Radius::Md))
                .enabled(enabled)
                .description(row.description.clone());
                match row.checked {
                    Some(on) => control.role(Role::Toggle).marked(on),
                    None => control,
                }
            })
            .collect();
        Node::scroll(
            LIST,
            Node::column("rows", rows).padding(Padding::all(Space::S4)),
        )
    }

    /// Lays the rows out in `panel`: as tall as they are, up to the output's bottom, where
    /// they scroll.
    fn lay(
        &mut self,
        text: &mut dyn nk_text::TextBackend,
        style: &TextStyle,
        labels: &[String],
        remove: &str,
        panel: [f64; 4],
    ) {
        let Some(tokens) = self.tokens.clone() else {
            return;
        };
        let view = self.view(style, labels, remove);
        let room = (self.max_height - panel[1]).max(ROW_MIN);
        let now = std::time::Instant::now();
        let mut bounds = [panel[0], panel[1], panel[2], room];
        self.state
            .layout_in(&view, bounds, self.scale, &tokens, text, now);
        let content = self.state.rect(&"rows".into()).map_or(room, |r| r[3]);
        if content < room {
            bounds[3] = content;
            self.state
                .layout_in(&view, bounds, self.scale, &tokens, text, now);
        }
        self.panel = bounds;
        if self.form.is_some()
            && self.focused().is_none_or(|id| self.row(id).is_none())
            && let Some(first) = self
                .rows
                .iter()
                .find(|r| matches!(r.action, Some(Action::SecretFocus(_))))
                .map(|r| r.id)
        {
            // A question for a secret takes the focus to its first field.
            self.focus_row(first);
        }
        self.sync_form();
    }
    /// Back to the first row, as a new question arrives.
    pub fn to_top(&mut self) {
        self.state.key(nk_view::KeyInput::Home);
    }

    /// The secret field nk-view focused is the form's.
    fn sync_form(&mut self) {
        if let Some(index) = self.focused_field()
            && let Some(form) = &mut self.form
        {
            form.focus(index);
        }
    }

    /// The row the focus is on.
    pub fn focused(&self) -> Option<u64> {
        self.state.focus().and_then(row_of)
    }
    fn row(&self, id: u64) -> Option<&Row> {
        self.rows.iter().find(|r| r.id == id)
    }
    /// The control a row's focus lands on: a secret row's field, else the row.
    fn focus_key(&self, id: u64) -> Option<nk_view::Key> {
        let row = self.row(id)?;
        Some(match row.action {
            Some(Action::SecretFocus(_)) => nk_view::Key::from(format!("r{id}/field")),
            _ => row_key(id),
        })
    }

    pub fn key(&mut self, key: &nk_wayland::Key) -> Option<Action> {
        use nk_view::KeyInput as K;
        let input = match key.sym {
            0xff09 if key.shift => K::ShiftTab,
            0xff09 | 0xff54 => K::Tab,
            0xfe20 | 0xff52 => K::ShiftTab,
            0xff51 => K::Left,
            0xff53 => K::Right,
            0xff0d | 0xff8d | 0x20 => K::Activate,
            0xff55 => K::PageUp,
            0xff56 => K::PageDown,
            0xff50 if key.ctrl => K::Home,
            0xff57 if key.ctrl => K::End,
            0xff50 => K::LineStart,
            0xff57 => K::LineEnd,
            0xffff => return self.focused().and_then(|id| self.named(id, "Remove")),
            _ => return None,
        };
        if self.state.focus().is_none() && matches!(input, K::Tab | K::ShiftTab) {
            // The first Tab lands on the first row that does something, as before.
            let first = self
                .rows
                .iter()
                .find(|r| r.action.is_some())
                .map(|r| r.id)?;
            self.focus_row(first);
            return None;
        }
        let a = self.state.key(input);
        self.sync_form();
        a.and_then(|a| self.activated(&a))
    }
    pub fn focus_row(&mut self, id: u64) {
        let Some(key) = self.focus_key(id) else {
            return;
        };
        self.state.request(&key, false);
        self.sync_form();
    }
    pub fn focused_field(&self) -> Option<usize> {
        let id = row_of(self.state.editing()?)?;
        match self.row(id)?.action {
            Some(Action::SecretFocus(index)) => Some(index),
            _ => None,
        }
    }
    pub fn text_input(&self) -> nk_wayland::TextInput {
        let Some(key) = self.state.editing() else {
            return Default::default();
        };
        let Some(r) = self.state.caret(key) else {
            return Default::default();
        };
        nk_wayland::TextInput {
            focused: true,
            password: true,
            text: String::new(),
            cursor: 0,
            anchor: 0,
            rect: [r[0] as i32, r[1] as i32, 1, r[3].ceil() as i32],
        }
    }
    /// Whether something in the page still moves (a switch sliding, the scroll bar fading):
    /// the bar keeps calling `tick` while it does.
    pub fn animating(&self) -> bool {
        self.state.animating()
    }
    /// A frame of motion; true when anything changed and the page must be drawn again.
    pub fn tick(&mut self, text: &mut dyn nk_text::TextBackend) -> bool {
        self.tick_at(text, std::time::Instant::now())
    }
    fn tick_at(&mut self, text: &mut dyn nk_text::TextBackend, now: std::time::Instant) -> bool {
        let Some(tokens) = self.tokens.as_ref() else {
            return false;
        };
        if !self.state.animating() {
            return false;
        }
        self.state.tick(tokens, text, now);
        true
    }
    pub fn scroll(&mut self, by: nk_view::ScrollBy) -> bool {
        self.state.scroll(by)
    }
    /// The list's offset into its rows.
    pub fn offset(&self) -> f64 {
        self.state.window(&LIST.into()).map_or(0., |w| w.0)
    }
    /// The row a semantic target or the pointer names, at `p`.
    pub fn target(&self, p: (f64, f64)) -> Option<u64> {
        self.state
            .placed()
            .iter()
            .rev()
            .filter(|pl| matches!(pl.what, nk_view::What::Control(_)) && pl.alpha > 0.)
            .find(|pl| pl.visible().is_some_and(|v| inside(v, p)))
            .and_then(|pl| row_of(&pl.key))
    }
    /// The pointer moved: whether the hover changed, and what a held slider asks.
    pub fn motion(&mut self, p: (f64, f64)) -> (bool, Option<Action>) {
        let changed = self.state.pointer_motion(p.0, p.1);
        let slid = self.state.slid();
        (changed, slid.and_then(|a| self.activated(&a)))
    }
    pub fn leave(&mut self) -> bool {
        self.state.pointer_leave()
    }
    /// A press: a slider takes the value under the pointer; a field takes the focus.
    pub fn press(&mut self) -> Option<Action> {
        let a = self.state.button(true, std::time::Instant::now());
        self.sync_form();
        a.and_then(|a| self.activated(&a))
    }
    /// A release: a row activates when released over itself; a slider reports its last value.
    pub fn release(&mut self) -> Option<Action> {
        let a = self.state.button(false, std::time::Instant::now());
        a.and_then(|a| self.activated(&a))
    }
    /// What an activation of the view asks for.
    fn activated(&mut self, a: &nk_view::Activated) -> Option<Action> {
        let id = row_of(&a.key)?;
        match a.action.as_str() {
            "remove" => self.named(id, "Remove"),
            "submit" => Some(Action::SecretSubmit),
            _ => {
                let value = self.state.value(&row_key(id));
                self.action(id, value)
            }
        }
    }
    pub fn action(&mut self, id: u64, value: Option<f64>) -> Option<Action> {
        if value.is_some_and(|v| !v.is_finite()) {
            return None;
        }
        let row = self.rows.iter().find(|r| r.id == id)?;
        let mut a = row.action.clone()?;
        let owner = row.owner.clone();
        if let Some((min, max, current)) = row.value {
            let v = value.unwrap_or(current).clamp(min, max);
            a = match a {
                Action::Seek {
                    player, revision, ..
                } => Action::Seek {
                    player,
                    revision,
                    seconds: v,
                },
                Action::AudioVolume(path, _) => {
                    Action::AudioVolume(path, v.min(row.max_write.unwrap_or(100.)) / 100.)
                }
                Action::Number(key, _) => Action::Number(key, v.round() as i32),
                Action::Time(key, _) => Action::Time(key, v.round() as i32),
                Action::Brightness {
                    device,
                    epoch,
                    min,
                    max,
                    ..
                } => Action::Brightness {
                    device,
                    epoch,
                    min,
                    max,
                    percent: v,
                },
                other => other,
            };
        }
        match a {
            Action::ClipboardConfirm(on) => {
                self.clipboard_confirm = on;
                None
            }
            Action::Clipboard { wipe: true, .. } => {
                self.clipboard_confirm = false;
                Some(a)
            }
            Action::SecretFocus(index) => {
                if let Some(form) = &mut self.form {
                    form.focus(index);
                }
                None
            }
            Action::SetMode(mode) => {
                self.mode = mode;
                None
            }
            Action::ToggleAudio => {
                self.audio = !self.audio;
                None
            }
            other => Some(if owner.is_empty() {
                other
            } else {
                Action::Call {
                    owner,
                    action: Box::new(other),
                }
            }),
        }
    }
    pub fn named(&mut self, id: u64, name: &str) -> Option<Action> {
        let row = self.rows.iter().find(|r| r.id == id)?;
        match (&row.action, name) {
            (Some(Action::Clipboard { id, revision, .. }), "Remove") => Some(Action::Clipboard {
                id: id.clone(),
                revision: *revision,
                remove: true,
                wipe: false,
            }),
            _ => None,
        }
    }
    /// The rows, then what nk-view leaves to the surface: a toggle row's mark and a clipboard
    /// entry's picture, in their slots (VIEW.md §12.3).
    pub fn paint(
        &mut self,
        c: &mut Canvas,
        look: &mut Look,
        fallback: Option<Color>,
    ) -> nk_wayland::Result<()> {
        let Some(tokens) = self.tokens.as_ref() else {
            return Ok(());
        };
        if let Some(base) = fallback {
            c.rounded_rect(rect(self.panel), SQUARE_RADIUS, base);
        }
        self.last = self.state.frame(tokens, std::time::Instant::now());
        if let Err(e) = self.state.paint(
            c,
            tokens,
            &mut |_, _| None,
            fallback.is_some().then_some(&self.last),
        ) {
            eprintln!("nidara-shell: the CC detail cannot be drawn: {e}");
        }
        for p in self.state.placed() {
            let Some(id) = row_of(&p.key) else {
                continue;
            };
            let (Some(visible), Some(row)) = (p.visible(), self.row(id)) else {
                continue;
            };
            if p.alpha <= 0. {
                continue;
            }
            c.push_opacity(p.alpha);
            c.clip(rect(visible));
            if p.key.0.ends_with("/check")
                && let Some(on) = row.checked
            {
                let b = rect(p.rect);
                if on {
                    c.rounded_rect(b, 5., look.styles.palette.accent);
                } else {
                    c.rounded_ring(b, 5., 1., ink(DIM));
                }
            }
            if p.key.0.ends_with("/thumb")
                && let Some((revision, thumb)) = &row.thumbnail
                && let Some(image) = crate::ccaux::thumbnail(*revision, thumb)
            {
                c.image(&image, rect(p.rect), ImageFit::Contain);
            }
            c.pop_clip();
            c.pop_opacity();
        }
        Ok(())
    }
    /// The washes the last painted frame declared.
    pub fn states(&self) -> Vec<StateRegion> {
        self.last.states.clone()
    }
    pub fn nodes(&self, first: u64, look: Option<&Look>) -> Vec<(nk_a11y::Node, Target)> {
        use nk_a11y::{Action as A, Bounds, Node, Role, ValueInfo};
        let window = self.state.rect(&LIST.into()).unwrap_or(self.panel);
        self.rows
            .iter()
            .map(|row| {
                let r = self
                    .state
                    .rect(&row_key(row.id))
                    .or_else(|| self.state.rect(&format!("r{}/slot", row.id).into()))
                    .unwrap_or([self.panel[0], self.panel[1], self.panel[2], 0.]);
                let label = row.label(look);
                let role = if matches!(row.action, Some(Action::SecretFocus(_))) {
                    Role::Password
                } else if row.value.is_some() {
                    Role::Slider
                } else if row.checked.is_some() {
                    Role::ToggleButton
                } else {
                    Role::Button
                };
                let mut n = Node::new(first + 10000 + row.id, role, label);
                n.bounds = Bounds {
                    x: r[0],
                    y: r[1],
                    width: r[2],
                    height: r[3],
                };
                n.description = row.description.clone();
                n.states.checked = row.checked == Some(true);
                n.states.offscreen = r[1] + r[3] <= window[1] || r[1] >= window[1] + window[3];
                n.states.focused = self.focused() == Some(row.id);
                n.states.disabled = row.action.is_none();
                if let Some(Action::SecretFocus(_)) = row.action {
                    n.text = Some(Default::default());
                }
                n.actions = if role == Role::Password {
                    vec![A::Focus, A::SetText]
                } else if row.action.is_none() {
                    vec![]
                } else if row.value.is_some() {
                    vec![A::Focus, A::SetValue]
                } else {
                    vec![A::Focus, A::Activate]
                };
                n.value = row.value.map(|(min, max, current)| {
                    let current = self.state.value(&row_key(row.id)).unwrap_or(current);
                    ValueInfo {
                        min,
                        max,
                        current,
                        step: 1.,
                        text: value_text(&row.action, current),
                    }
                });
                if matches!(
                    row.action,
                    Some(Action::Clipboard {
                        wipe: false,
                        remove: false,
                        ..
                    })
                ) {
                    n.actions.push(nk_a11y::Action::Named("Remove"));
                    n.action_labels.insert(
                        "Remove".into(),
                        super::edit::Editor::action_label("Remove", look),
                    );
                }
                (n, Target::Detail(row.id))
            })
            .collect()
    }
}
/// The least room a detail gets, on an output too short for it.
const ROW_MIN: f64 = 48.;
fn text(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap_or("").to_owned()
}
fn array<'a>(v: &'a Value, k: &str) -> impl Iterator<Item = &'a Value> {
    v[k].as_array().into_iter().flatten()
}
fn rows(page: &str, s: &Status, mode: &'static str, audio: bool) -> Vec<Row> {
    let mut out = vec![];
    match page {
        "battery" => {
            if let Some(b) = s.battery {
                out.push(Row::new(
                    "battery-value",
                    Label::Text(format!("{:.0}%", b.fraction * 100.)),
                    None,
                ));
                let state = match s.battery_state {
                    1 | 5 => "Charging",
                    2 | 6 => "Discharging",
                    4 => "Fully charged",
                    3 => "Empty",
                    _ => "Unknown",
                };
                let time = s
                    .battery_time
                    .map(|seconds| format!(" · {}h {:02}m", seconds / 3600, seconds % 3600 / 60))
                    .unwrap_or_default();
                out.push(Row::new(
                    "battery-state",
                    Label::Text(format!("{state}{time}")),
                    None,
                ));
            }
        }
        "clipboard" => {
            out.push(Row::key("cc.detail.refresh", Action::ClipboardList));
            for entry in s.aux.clips.iter() {
                let mut row = Row::button(
                    format!("clip:{}:{}", s.aux.clip_revision, entry.id),
                    if entry.image {
                        format!("Image · {}", entry.label)
                    } else {
                        entry.label.clone()
                    },
                    Action::Clipboard {
                        id: Some(entry.id.clone()),
                        revision: s.aux.clip_revision,
                        remove: false,
                        wipe: false,
                    },
                );
                if entry.image {
                    row.thumbnail = Some((s.aux.clip_revision, entry.id.clone()));
                }
                out.push(row);
            }
            if s.aux.clips.is_empty() {
                out.push(Row::new(
                    "clipboard-empty",
                    Label::Key("widget.clipboard.empty"),
                    None,
                ));
            } else {
                out.push(Row::key(
                    "widget.clipboard.clear",
                    Action::ClipboardConfirm(true),
                ));
            }
        }
        "ethernet" => {
            if let Some(d) = wired(s) {
                out.push(
                    Row::key(
                        "cc.ethernet.name",
                        Action::WiredPower(text(d, "path"), d["wiredEnabled"] != true),
                    )
                    .switch(d["wiredEnabled"] == true),
                );
                for (key, value) in [
                    (
                        "Status",
                        if d["state"] == 100 {
                            "Connected".into()
                        } else {
                            "Disconnected".into()
                        },
                    ),
                    ("Interface", text(d, "interface")),
                    (
                        "IP",
                        d["ip4"]["addresses"][0]["address"]
                            .as_str()
                            .unwrap_or("—")
                            .into(),
                    ),
                    (
                        "Gateway",
                        d["ip4"]["gateway"].as_str().unwrap_or("—").into(),
                    ),
                ] {
                    out.push(Row::new(key, Label::Text(format!("{key} · {value}")), None));
                }
            }
        }
        "vpn" => {
            for p in vpn_profiles(s) {
                let uuid = text(p, "uuid");
                let active = vpn_active(s).find(|a| a["uuid"] == uuid);
                let action = active.map_or_else(
                    || Action::Activate(uuid.clone()),
                    |a| Action::Deactivate(text(a, "path")),
                );
                out.push(
                    Row::button(format!("vpn:{uuid}"), text(p, "name"), action)
                        .toggle(active.is_some()),
                );
            }
        }
        "wifi" => {
            if let Some(n) = &s.details.network {
                out.push(
                    Row::key(
                        "cc.wifi.name",
                        Action::WifiPower(!n["wirelessEnabled"].as_bool().unwrap_or(false)),
                    )
                    .switch(n["wirelessEnabled"] == true),
                );
                let profiles: Vec<_> = array(n, "profiles").collect();
                let mut networks: std::collections::BTreeMap<String, (&Value, &Value)> =
                    Default::default();
                for d in array(n, "devices").filter(|d| d["kind"] == 2) {
                    let device = text(d, "path");
                    out.push(Row::key(
                        "settings.network.ap.scan",
                        Action::Scan(device.clone()),
                    ));
                    for ap in array(d, "accessPoints").filter(|a| !text(a, "label").is_empty()) {
                        let Some(ssid) = ap["ssid"].as_array() else {
                            continue;
                        };
                        if ssid.is_empty()
                            || ssid.iter().any(|v| v.as_u64().is_none_or(|n| n > 255))
                        {
                            continue;
                        }
                        let key = ap["ssid"].to_string();
                        if networks.get(&key).is_none_or(|(old_device, old)| {
                            d["activeAp"] == ap["path"]
                                || (old_device["activeAp"] != old["path"]
                                    && old["strength"].as_u64() < ap["strength"].as_u64())
                        }) {
                            networks.insert(key, (d, ap));
                        }
                    }
                }
                let mut networks: Vec<_> = networks.into_values().collect();
                networks.sort_by_key(|(d, ap)| {
                    (
                        d["activeAp"] != ap["path"],
                        std::cmp::Reverse(ap["strength"].as_u64().unwrap_or(0)),
                        text(ap, "label"),
                    )
                });
                for (d, ap) in networks.into_iter().take(128) {
                    let current = d["activeAp"] == ap["path"];
                    let connected = current && d["state"] == 100;
                    let saved = profiles.iter().find(|p| p["ssid"] == ap["ssid"]);
                    let action = if !n["wirelessEnabled"].as_bool().unwrap_or(false) {
                        None
                    } else if current {
                        Some(Action::Disconnect(text(d, "path")))
                    } else if ap["needsEnterprise"] == true && saved.is_none() {
                        None
                    } else {
                        Some(Action::Connect {
                            device: text(d, "path"),
                            ap: text(ap, "path"),
                            uuid: saved.map(|p| text(p, "uuid")).unwrap_or_default(),
                        })
                    };
                    let mut row = Row::new(
                        format!(
                            "wifi:{}:{}:{}",
                            text(d, "path"),
                            ap["ssid"],
                            saved.map(|p| text(p, "uuid")).unwrap_or_default()
                        ),
                        Label::Text(text(ap, "label")),
                        action,
                    )
                    .toggle(connected);
                    row.description = format!("{}%", ap["strength"].as_u64().unwrap_or(0));
                    if current {
                        row.prefix = Some(if connected {
                            "settings.network.ap.disconnect"
                        } else {
                            "settings.network.ap.connecting"
                        });
                    }
                    out.push(row);
                }
                for p in profiles
                    .into_iter()
                    .filter(|p| p["hidden"] == true)
                    .take(32)
                {
                    out.push(Row::button(
                        format!("hidden:{}", text(p, "uuid")),
                        text(p, "name"),
                        Action::Activate(text(p, "uuid")),
                    ));
                }
            }
        }
        "bt" => {
            if let Some(b) = &s.bluetooth {
                out.push(
                    Row::key(
                        "widget.bluetooth.name",
                        Action::BluetoothPower(b.adapter.clone(), !b.powered),
                    )
                    .switch(b.powered),
                );
                if let Some(snapshot) = &s.details.bluetooth {
                    for d in array(snapshot, "devices")
                        .filter(|d| d["adapter"] == b.adapter && d["paired"] == true && b.powered)
                        .take(128)
                    {
                        let connected = d["connected"] == true;
                        out.push(
                            Row::button(
                                format!("bt:{}", text(d, "path")),
                                text(d, "alias"),
                                Action::Bluetooth {
                                    device: text(d, "path"),
                                    connect: !connected,
                                },
                            )
                            .toggle(connected),
                        );
                    }
                }
            }
        }
        "volume" => {
            for n in s
                .details
                .audio
                .iter()
                .filter(|n| matches!(n.kind.as_str(), "output" | "playback"))
                .take(128)
            {
                if n.kind == "output" {
                    out.push(
                        Row::button(
                            format!("default:{}", n.path),
                            n.name.clone(),
                            Action::AudioDefault(n.path.clone()),
                        )
                        .owner(&n.owner)
                        .prefix("settings.audio.btn.set-default")
                        .toggle(n.path == s.details.default_output),
                    );
                }
                if n.capabilities.iter().any(|c| c == "volume") {
                    out.push(
                        Row::button(
                            format!("volume:{}", n.path),
                            n.name.clone(),
                            Action::AudioVolume(n.path.clone(), n.volume),
                        )
                        .owner(&n.owner)
                        .prefix("cc.volume.name")
                        .max_write(n.volume_limit * 100.)
                        .slider(
                            0.,
                            n.volume_limit.max(n.volume) * 100.,
                            n.volume * 100.,
                        ),
                    );
                }
                if n.capabilities.iter().any(|c| c == "mute") {
                    out.push(
                        Row::button(
                            format!("mute:{}", n.path),
                            n.name.clone(),
                            Action::AudioMute(n.path.clone(), !n.muted),
                        )
                        .owner(&n.owner)
                        .prefix("cc.detail.mute")
                        .toggle(n.muted),
                    );
                }
            }
        }
        "media" => {
            if s.media.is_none() {
                return vec![Row::new(
                    "unavailable",
                    Label::Key("cc.detail.unavailable"),
                    None,
                )];
            }
            out.push(
                Row::key("cc.media.source.auto", Action::Player(String::new()))
                    .toggle(s.details.pinned.is_empty()),
            );
            for p in s.details.players.iter().take(128) {
                out.push(
                    Row::button(
                        format!("player:{}", p.path),
                        p.name.clone(),
                        Action::Player(p.bus.clone()),
                    )
                    .toggle(p.path == s.details.selected),
                );
            }
            if let Some(m) = &s.media {
                if !m.title.is_empty() {
                    let mut track = Row::new("track", Label::Text(m.title.clone()), None);
                    track.description = m.artist.clone();
                    out.push(track);
                }
                if m.can_previous {
                    out.push(Row::key(
                        "cc.detail.previous",
                        Action::Media("SelectedPrevious"),
                    ));
                }
                if m.can_control {
                    out.push(Row::key(
                        "cc.detail.play-pause",
                        Action::Media("SelectedPlayPause"),
                    ));
                }
                if m.can_next {
                    out.push(Row::key("cc.detail.next", Action::Media("SelectedNext")));
                }
                if let Some(p) = s
                    .details
                    .players
                    .iter()
                    .find(|p| p.path == s.details.selected && p.seek && p.length > 0)
                {
                    let now = glib::monotonic_time().max(0) as u64;
                    let elapsed = if p.playing {
                        now.saturating_sub(p.anchor) as f64 * p.rate
                    } else {
                        0.
                    };
                    let seconds = (p.position as f64 + elapsed) / 1e6;
                    out.push(
                        Row::key(
                            "cc.detail.position",
                            Action::Seek {
                                player: p.path.clone(),
                                revision: p.track_revision,
                                seconds,
                            },
                        )
                        .slider(0., p.length as f64 / 1e6, seconds),
                    );
                }
            }
        }
        "brightness" => {
            if let Some(b) = &s.brightness {
                out.push(
                    Row::key(
                        "widget.brightness.name",
                        Action::Brightness {
                            device: b.device.clone(),
                            epoch: b.epoch,
                            min: b.min,
                            max: b.max,
                            percent: b.fraction() * 100.,
                        },
                    )
                    .slider(0., 100., b.fraction() * 100.),
                );
            }
        }
        "night_light" => {
            if let Some(n) = s.night {
                out.push(
                    Row::key(
                        "settings.appearance.night-light",
                        Action::Pref(
                            "nightlight.enabled",
                            crate::menu::PrefValue::Bool(!n.enabled),
                        ),
                    )
                    .switch(n.enabled),
                );
                // The schedule acts only when it crosses a boundary, so the switch stays
                // usable while it is on: a change by hand lasts until the next one (#957).
                out.push(
                    Row::key(
                        "settings.appearance.night-light-temp",
                        Action::Number("nightlight.temperature", n.temperature),
                    )
                    .slider(2700., 6500., n.temperature as f64),
                );
                out.push(
                    Row::key(
                        "settings.appearance.night-light-schedule",
                        Action::Pref(
                            "nightlight.scheduleEnabled",
                            crate::menu::PrefValue::Bool(!s.night_schedule.0),
                        ),
                    )
                    .switch(s.night_schedule.0),
                );
                if s.night_schedule.0 {
                    for (value, key, pref) in [
                        (
                            &s.night_schedule.1,
                            "settings.appearance.night-light-from",
                            "nightlight.scheduleFrom",
                        ),
                        (
                            &s.night_schedule.2,
                            "settings.appearance.night-light-to",
                            "nightlight.scheduleTo",
                        ),
                    ] {
                        let minutes = value
                            .split_once(':')
                            .and_then(|(h, m)| {
                                Some(h.parse::<i32>().ok()? * 60 + m.parse::<i32>().ok()?)
                            })
                            .unwrap_or(0);
                        out.push(Row::key(key, Action::Time(pref, minutes)).slider(
                            0.,
                            1439.,
                            minutes as f64,
                        ));
                    }
                }
            }
        }
        "screenshot" => {
            if !s.capture.screenshot.error.is_empty() {
                out.push(Row::new(
                    "screenshot-error",
                    Label::Text(s.capture.screenshot.error.clone()),
                    None,
                ));
            }
            if !s.capture.screenshot.path.is_empty() {
                let mut saved = Row::new(
                    "screenshot-saved",
                    Label::Key("widget.screenshot.saved"),
                    None,
                );
                saved.description = s.capture.screenshot.path.clone();
                out.push(saved);
            }
            if s.capture.screenshot.busy {
                out.push(Row::new(
                    "screenshot-busy",
                    Label::Key("settings.native.loading"),
                    None,
                ));
                return out;
            }
            for (m, key) in [
                ("area", "widget.screenshot.mode.area"),
                ("screen", "widget.screenshot.mode.screen"),
                ("window", "widget.screenshot.mode.window"),
            ] {
                out.push(Row::key(key, Action::SetMode(m)).toggle(mode == m));
            }
            out.push(Row::key(
                "widget.screenshot.action.copy",
                Action::Capture { mode, copy: true },
            ));
            out.push(Row::key(
                "widget.screenshot.action.save",
                Action::Capture { mode, copy: false },
            ));
        }
        "screenrecord" => {
            if let Some(key) = s.capture.notice {
                out.push(Row::new("recording-notice", Label::Key(key), None));
            }
            if s.capture.starting {
                out.push(Row::new(
                    "recording-starting",
                    Label::Key("settings.native.loading"),
                    None,
                ));
                return out;
            }
            if !s.capture.error.is_empty() {
                out.push(Row::new(
                    "capture-error",
                    Label::Text(s.capture.error.clone()),
                    None,
                ));
            }
            if s.capture.running {
                out.push(Row::key("widget.screenrecord.stop", Action::StopRecording));
                return out;
            }
            for (m, key) in [
                ("screen", "widget.screenrecord.mode.screen"),
                ("region", "widget.screenrecord.mode.region"),
            ] {
                out.push(Row::key(key, Action::SetMode(m)).toggle(mode == m));
            }
            out.push(Row::key("widget.screenrecord.audio", Action::ToggleAudio).switch(audio));
            out.push(Row::key(
                "widget.screenrecord.start",
                Action::Record { mode, audio },
            ));
        }
        _ => {}
    }
    let owner = match page {
        "wifi" | "ethernet" | "vpn" => s.details.network.as_ref().map(|n| text(n, "_serviceOwner")),
        "bt" => s
            .details
            .bluetooth
            .as_ref()
            .map(|n| text(n, "_serviceOwner")),
        "media" => s.media.as_ref().map(|m| m.owner.clone()),
        "brightness" => Some(s.details.brightness_owner.clone()),
        _ => None,
    };
    if let Some(owner) = owner {
        let epoch = match page {
            "wifi" | "ethernet" | "vpn" => s
                .details
                .network
                .as_ref()
                .map(|v| v["_serviceEpoch"].to_string()),
            "bt" => s
                .details
                .bluetooth
                .as_ref()
                .map(|v| v["_serviceEpoch"].to_string()),
            _ => None,
        };
        for row in &mut out {
            row.owner = owner.clone();
            if let Some(epoch) = &epoch {
                row.key = format!("{epoch}:{}", row.key);
            }
            if let Some(Action::Seek {
                player, revision, ..
            }) = &row.action
            {
                row.key = format!("seek:{player}:{revision}");
            }
            if let Some(Action::Brightness { device, epoch, .. }) = &row.action {
                row.key = format!("brightness:{device}:{epoch}");
            }
        }
    }
    if out.is_empty() {
        out.push(Row::new(
            "unavailable",
            Label::Key("cc.detail.unavailable"),
            None,
        ));
    }
    out
}

pub(crate) fn write(conn: &zbus::blocking::Connection, action: &Action) -> Result<(), String> {
    write_to(conn, action, None)
}
fn write_to(
    conn: &zbus::blocking::Connection,
    action: &Action,
    owner: Option<&str>,
) -> Result<(), String> {
    let dest = |default| owner.unwrap_or(default);
    use zbus::zvariant::{ObjectPath, Value as Variant};
    let path = |s: &str| ObjectPath::try_from(s.to_owned()).map_err(|e| e.to_string());
    match action {
        Action::Call { owner, action } => {
            if !owner.starts_with(':') {
                return Err("invalid snapshot service owner".into());
            }
            write_to(conn, action, Some(owner))
        }
        Action::ClipboardList => crate::ccaux::refresh_clipboard(),
        Action::Clipboard {
            id,
            revision,
            remove,
            wipe,
        } => crate::ccaux::clipboard(id.as_deref(), *revision, *remove, *wipe),
        Action::WiredPower(device, on) => call(
            conn,
            dest("org.nidara.Network"),
            "/org/nidara/Network",
            "org.nidara.Network1",
            "SetWiredEnabled",
            &(path(device)?, *on),
        ),
        Action::Deactivate(active) => call(
            conn,
            dest("org.nidara.Network"),
            "/org/nidara/Network",
            "org.nidara.Network1",
            "Deactivate",
            &(path(active)?,),
        ),
        Action::WifiPower(on) => call(
            conn,
            dest("org.nidara.Network"),
            "/org/nidara/Network",
            "org.nidara.Network1",
            "SetWifiEnabled",
            on,
        ),
        Action::Scan(device) => call(
            conn,
            dest("org.nidara.Network"),
            "/org/nidara/Network",
            "org.nidara.Network1",
            "Scan",
            &(path(device)?,),
        ),
        Action::Connect { device, ap, uuid } => call(
            conn,
            dest("org.nidara.Network"),
            "/org/nidara/Network",
            "org.nidara.Network1",
            "ConnectDefault",
            &(path(device)?, path(ap)?, uuid.as_str()),
        ),
        Action::Disconnect(device) => call(
            conn,
            dest("org.nidara.Network"),
            "/org/nidara/Network",
            "org.nidara.Network1",
            "Disconnect",
            &(path(device)?,),
        ),
        Action::Activate(uuid) => call(
            conn,
            dest("org.nidara.Network"),
            "/org/nidara/Network",
            "org.nidara.Network1",
            "Activate",
            &(uuid.as_str(), path("/")?),
        ),
        Action::Bluetooth { device, connect } => call(
            conn,
            dest("org.nidara.Bluetooth"),
            "/org/nidara/Bluetooth",
            "org.nidara.Bluetooth1",
            if *connect { "Connect" } else { "Disconnect" },
            &(path(device)?,),
        ),
        Action::AudioDefault(p) => call(
            conn,
            dest(crate::status::SESSION),
            "/org/nidara/Audio",
            "org.nidara.Audio1",
            "SetDefault",
            &(path(p)?,),
        ),
        Action::AudioVolume(p, v) => call(
            conn,
            dest(crate::status::SESSION),
            "/org/nidara/Audio",
            "org.nidara.Audio1",
            "SetVolume",
            &(path(p)?, *v),
        ),
        Action::AudioMute(p, on) => call(
            conn,
            dest(crate::status::SESSION),
            "/org/nidara/Audio",
            "org.nidara.Audio1",
            "SetMuted",
            &(path(p)?, *on),
        ),
        Action::BluetoothPower(adapter, on) => call(
            conn,
            dest("org.nidara.Bluetooth"),
            "/org/nidara/Bluetooth",
            "org.nidara.Bluetooth1",
            "SetPowered",
            &(path(adapter)?, *on),
        ),
        Action::Media(method) => call(
            conn,
            dest(crate::status::SESSION),
            crate::status::MEDIA_PATH,
            crate::status::MEDIA_IFACE,
            method,
            &(),
        ),
        Action::Seek {
            player,
            revision,
            seconds,
        } => call(
            conn,
            dest(crate::status::SESSION),
            crate::status::MEDIA_PATH,
            crate::status::MEDIA_IFACE,
            "SelectedSeekTo",
            &(path(player)?, *revision, (seconds * 1e6).round() as i64),
        ),
        Action::Player(bus) => call(
            conn,
            dest(crate::status::SESSION),
            crate::status::MEDIA_PATH,
            crate::status::MEDIA_IFACE,
            "SetSelection",
            &(bus.as_str(),),
        ),
        Action::Pref(key, value) => crate::prefs::apply(conn, key, value),
        Action::Brightness {
            device,
            epoch,
            min,
            max,
            percent,
        } => call(
            conn,
            dest(crate::status::SESSION),
            "/org/nidara/DisplayBrightness",
            "org.nidara.DisplayBrightness1",
            "SetBrightness",
            &(
                device.as_str(),
                *epoch,
                min + ((max - min) as f64 * percent / 100.).round() as u32,
            ),
        ),
        Action::Time(key, minutes) => call(
            conn,
            "org.nidara.Config",
            "/org/nidara/Config",
            "org.nidara.Config1",
            "Apply",
            &(
                key,
                Variant::from(format!("{:02}:{:02}", minutes / 60, minutes % 60)),
            ),
        ),
        Action::Number(key, value) => call(
            conn,
            "org.nidara.Config",
            "/org/nidara/Config",
            "org.nidara.Config1",
            "Apply",
            &(key, Variant::from(*value)),
        ),
        Action::Capture { .. } | Action::Record { .. } | Action::StopRecording => {
            Err("capture requires its current bar surface".into())
        }
        Action::Back
        | Action::ClipboardConfirm(_)
        | Action::SetMode(_)
        | Action::ToggleAudio
        | Action::SecretFocus(_)
        | Action::SecretSubmit
        | Action::SecretCancel => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    /// Lays `d` out as the bar would, with the exported tokens; false (skipped) without them.
    fn laid(d: &mut Detail, s: &Status, panel: [f64; 4]) -> bool {
        let Some(tokens) = crate::nc_view::exported_tokens() else {
            return false;
        };
        d.tokens = Some(tokens);
        d.refresh(s, panel, None);
        let labels: Vec<_> = d.rows.iter().map(|r| r.label(None)).collect();
        let mut text =
            nk_text::ParleyBackend::new(Arc::new(nk_text::FontSet::discover_required().unwrap()))
                .unwrap();
        d.lay(&mut text, &TextStyle::default(), &labels, "Remove", panel);
        true
    }
    fn status() -> Status {
        let mut s = Status::default();
        s.apply(crate::status::Update::Network(Arc::new(json!({"wirelessEnabled":true,"profiles":[],"devices":[{"path":"/wifi/1","kind":2,"state":30,"activeAp":"/","accessPoints":[
            {"path":"/ap/weak","label":"Home","ssid":[72],"strength":20},
            {"path":"/ap/strong","label":"Home","ssid":[72],"strength":90},
            {"path":"/ap/other","label":"Other","ssid":[79],"strength":40},
            {"path":"/ap/enterprise","label":"Enterprise","ssid":[69],"strength":100,"needsEnterprise":true}]}]}))));
        s
    }
    #[test]
    fn network_rows_keep_the_strongest_ap_and_never_invent_enterprise_credentials() {
        let rows = rows("wifi", &status(), "screen", false);
        let home: Vec<_> = rows
            .iter()
            .filter(|r| matches!(&r.label,Label::Text(t) if t=="Home"))
            .collect();
        assert_eq!(home.len(), 1);
        assert!(
            matches!(&home[0].action,Some(Action::Connect {device,ap,..}) if device=="/wifi/1" && ap=="/ap/strong")
        );
        assert!(rows.iter().any(|r|matches!(&r.label,Label::Text(t) if t=="Enterprise") && r.action.is_none()));
    }
    #[test]
    fn an_active_ap_during_activation_is_pending_until_nm_reports_connected() {
        let mut state = status();
        let mut network = (**state.details.network.as_ref().unwrap()).clone();
        network["devices"][0]["activeAp"] = json!("/ap/strong");
        network["devices"][0]["state"] = json!(50);
        state.apply(crate::status::Update::Network(Arc::new(network.clone())));
        let pending = rows("wifi", &state, "screen", false);
        let row = pending
            .iter()
            .find(|r| matches!(&r.label, Label::Text(t) if t=="Home"))
            .unwrap();
        assert_eq!(row.checked, Some(false));
        assert_eq!(row.prefix, Some("settings.network.ap.connecting"));
        assert!(matches!(row.action, Some(Action::Disconnect(_))));
        network["devices"][0]["state"] = json!(100);
        state.apply(crate::status::Update::Network(Arc::new(network)));
        let connected = rows("wifi", &state, "screen", false);
        assert_eq!(
            connected
                .iter()
                .find(|r| matches!(&r.label, Label::Text(t) if t=="Home"))
                .unwrap()
                .checked,
            Some(true)
        );
    }
    #[test]
    fn a11y_targets_keep_identity_after_service_reorder_and_disappear_on_owner_loss() {
        let mut s = status();
        let mut d = Detail::new("wifi", 1);
        d.auth_ready = true;
        d.refresh(&s, [0., 50., 396., 400.], None);
        let home = d
            .rows
            .iter()
            .find(|r| matches!(&r.label,Label::Text(t) if t=="Home"))
            .unwrap()
            .id;
        let other = d
            .rows
            .iter()
            .find(|r| matches!(&r.label,Label::Text(t) if t=="Other"))
            .unwrap()
            .id;
        let mut data = (**s.details.network.as_ref().unwrap()).clone();
        data["devices"][0]["accessPoints"]
            .as_array_mut()
            .unwrap()
            .reverse();
        s.apply(crate::status::Update::Network(Arc::new(data)));
        d.refresh(&s, d.panel, None);
        assert!(matches!(d.action(home,None),Some(Action::Connect {ap,..}) if ap=="/ap/strong"));
        assert!(matches!(d.action(other,None),Some(Action::Connect {ap,..}) if ap=="/ap/other"));
        s.apply(crate::status::Update::Wifi(None, String::new()));
        d.refresh(&s, d.panel, None);
        assert!(d.action(home, None).is_none());
    }
    #[test]
    fn credentials_are_not_readable_in_the_semantic_tree_and_close_with_the_view() {
        let mut d = Detail::new("wifi", 1);
        let mut form = crate::ccauth::Form::new(
            7,
            &json!({"setting":"802-11-wireless-security","hints":["psk"]}),
        )
        .unwrap();
        form.replace(0, "private日本password");
        d.form = Some(form);
        d.refresh(&status(), [0., 50., 396., 400.], None);
        let nodes = d.nodes(901, None);
        let password = &nodes
            .iter()
            .find(|(n, _)| n.role == nk_a11y::Role::Password)
            .unwrap()
            .0;
        assert!(password.actions.contains(&nk_a11y::Action::SetText));
        assert_eq!(password.text.as_ref().unwrap().text, "");
        assert!(!format!("{nodes:?}").contains("private日本password"));
    }
    #[test]
    fn secret_keyboard_navigation_reaches_buttons_and_disables_text_input_there() {
        let mut detail = Detail::new("wifi", 1);
        detail.form =
            crate::ccauth::Form::new(1, &json!({"setting":"802-1x","hints":["password"]}));
        if !laid(&mut detail, &status(), [0., 50., 396., 400.]) {
            return;
        }
        assert_eq!(detail.focused_field(), Some(0));
        assert!(detail.text_input().focused);
        assert!(detail.text_input().password);
        assert!(detail.text_input().text.is_empty());
        let tab = nk_wayland::Key {
            serial: None,
            sym: 0xff09,
            text: String::new(),
            shift: false,
            ctrl: false,
            alt: false,
        };
        let mut reached_submit = false;
        for _ in 0..detail.rows.len() {
            detail.key(&tab);
            if detail
                .rows
                .iter()
                .any(|r| Some(r.id) == detail.focused() && r.action == Some(Action::SecretSubmit))
            {
                reached_submit = true;
                assert!(!detail.text_input().focused);
                assert_eq!(
                    detail.key(&nk_wayland::Key {
                        sym: 0x20,
                        ..tab.clone()
                    }),
                    Some(Action::SecretSubmit)
                );
                break;
            }
        }
        assert!(reached_submit);
    }
    #[test]
    fn short_outputs_scroll_and_every_detail_exposes_a_back_action() {
        let s = status();
        for page in [
            "wifi",
            "bt",
            "volume",
            "media",
            "brightness",
            "night_light",
            "screenshot",
            "screenrecord",
        ] {
            let mut d = Detail::new(page, 1);
            d.max_height = 230.;
            if !laid(&mut d, &s, [0., 50., 396., 400.]) {
                return;
            }
            assert!(d.panel[1] + d.panel[3] <= 230.);
            let back = d.rows[0].id;
            assert_eq!(d.action(back, None), Some(Action::Back));
            if page == "screenshot" {
                d.key(&nk_wayland::Key {
                    serial: None,
                    sym: 0xff09,
                    text: String::new(),
                    shift: false,
                    ctrl: false,
                    alt: false,
                });
                assert!(d.focused().is_some());
                // The wheel scrolls the list under the pointer.
                d.motion((100., 100.));
                assert!(d.scroll(nk_view::ScrollBy::Steps(1.)));
                assert!(d.offset() > 0.);
            }
        }
    }
    #[test]
    fn a_switch_the_service_turned_on_slides_there_as_the_page_is_ticked() {
        let mut d = Detail::new("night_light", 1);
        let mut s = status();
        s.night = Some(crate::status::Night {
            enabled: false,
            temperature: 4000,
        });
        if !laid(&mut d, &s, [0., 50., 396., 400.]) {
            return;
        }
        let id = d.rows[1].id;
        let progress = |d: &Detail| {
            let key = format!("r{id}/switch").into();
            match d
                .state
                .placed()
                .iter()
                .find(|p| p.key == key)
                .map(|p| &p.what)
            {
                Some(nk_view::What::Switch { progress, .. }) => *progress,
                w => panic!("no switch: {w:?}"),
            }
        };
        assert_eq!(progress(&d), 0.);
        assert!(!d.animating());
        s.night = Some(crate::status::Night {
            enabled: true,
            temperature: 4000,
        });
        laid(&mut d, &s, [0., 50., 396., 400.]);
        assert!(d.animating(), "the bar must keep ticking the page");
        let mut text =
            nk_text::ParleyBackend::new(Arc::new(nk_text::FontSet::discover_required().unwrap()))
                .unwrap();
        let later = std::time::Instant::now() + std::time::Duration::from_secs(1);
        assert!(d.tick_at(&mut text, later), "a frame to draw");
        assert_eq!(progress(&d), 1., "on, once ticked");
        assert!(!d.animating());
        assert!(!d.tick_at(&mut text, later), "nothing left to draw");
    }
    #[test]
    fn the_night_light_switch_stays_usable_while_the_schedule_is_on() {
        let mut s = status();
        s.night = Some(crate::status::Night {
            enabled: true,
            temperature: 4000,
        });
        s.night_schedule = (true, "22:00".into(), "07:00".into());
        let rows = rows("night_light", &s, "screen", false);
        let master = rows
            .iter()
            .find(|r| matches!(r.label, Label::Key("settings.appearance.night-light")))
            .unwrap();
        assert!(master.switch && master.checked == Some(true));
        assert_eq!(
            master.action,
            Some(Action::Pref(
                "nightlight.enabled",
                crate::menu::PrefValue::Bool(false)
            )),
            "turned off by hand until the next boundary"
        );
    }
    #[test]
    fn a_slider_action_is_explicit_and_clamped_and_mode_changes_have_no_effect() {
        let mut d = Detail::new("night_light", 1);
        let mut s = status();
        s.night = Some(crate::status::Night {
            enabled: false,
            temperature: 4000,
        });
        d.refresh(&s, [0., 50., 396., 400.], None);
        let id = d.rows.iter().find(|r| r.value.is_some()).unwrap().id;
        assert_eq!(
            d.action(id, Some(9000.)),
            Some(Action::Number("nightlight.temperature", 6500))
        );
        let mut d = Detail::new("screenshot", 2);
        d.refresh(&s, d.panel, None);
        let id = d
            .rows
            .iter()
            .find(|r| matches!(r.action, Some(Action::SetMode("window"))))
            .unwrap()
            .id;
        assert_eq!(d.action(id, None), None);
        assert_eq!(d.mode, "window");
    }
    #[test]
    fn a_secret_reaches_the_view_only_as_its_bullets() {
        let mut d = Detail::new("wifi", 1);
        let mut form = crate::ccauth::Form::new(
            7,
            &json!({"setting":"802-11-wireless-security","hints":["psk"]}),
        )
        .unwrap();
        form.replace(0, "private日本password");
        d.form = Some(form);
        if !laid(&mut d, &status(), [0., 50., 396., 400.]) {
            return;
        }
        let placed = format!("{:?}", d.state.placed());
        assert!(!placed.contains("private"), "the view holds no secret");
        assert!(placed.contains(&"•".repeat(17)), "one per character");
        // Its caret stands at the end of the bullets, for the input method.
        let caret = d.text_input().rect;
        let field = d
            .state
            .rect(&d.focus_key(d.focused().unwrap()).unwrap())
            .unwrap();
        assert!(f64::from(caret[0]) > field[0] + 20., "{caret:?} {field:?}");
    }
    #[test]
    fn a_setting_that_is_on_or_off_ends_with_a_switch_and_a_choice_keeps_its_mark() {
        let mut d = Detail::new("screenrecord", 1);
        if !laid(&mut d, &status(), [0., 50., 396., 400.]) {
            return;
        }
        let id = |a: Action| {
            d.rows
                .iter()
                .find(|r| r.action == Some(a.clone()))
                .unwrap()
                .id
        };
        let (audio, region) = (id(Action::ToggleAudio), id(Action::SetMode("region")));
        let at = |key: String| d.state.rect(&key.into());
        let row = d.state.rect(&row_key(audio)).unwrap();
        let switch = at(format!("r{audio}/switch")).expect("the audio row's switch");
        assert!(at(format!("r{audio}/check")).is_none(), "no mark beside it");
        assert!(
            (row[0] + row[2]) - (switch[0] + switch[2]) < 20.,
            "at the row's end: {row:?} {switch:?}"
        );
        assert!(
            at(format!("r{region}/check")).is_some(),
            "a mode keeps its mark"
        );
        assert!(at(format!("r{region}/switch")).is_none());
        // Said as GTK says a switch: one toggle button, the whole row, with its state.
        let nodes = d.nodes(1, None);
        let said: Vec<_> = nodes
            .iter()
            .filter(|(n, _)| n.bounds.y == row[1] && n.bounds.height == row[3])
            .collect();
        assert_eq!(said.len(), 1, "one node for the row and its switch");
        assert_eq!(said[0].0.role, nk_a11y::Role::ToggleButton);
    }
    #[test]
    fn a_row_acts_when_released_over_itself_and_not_elsewhere() {
        let mut d = Detail::new("screenshot", 1);
        if !laid(&mut d, &status(), [0., 50., 396., 400.]) {
            return;
        }
        let window = d
            .rows
            .iter()
            .find(|r| matches!(r.action, Some(Action::SetMode("window"))))
            .unwrap()
            .id;
        let r = d.state.rect(&row_key(window)).unwrap();
        d.motion((r[0] + 20., r[1] + r[3] / 2.));
        assert_eq!(d.target((r[0] + 20., r[1] + r[3] / 2.)), Some(window));
        assert_eq!(d.press(), None, "a press alone does nothing");
        assert_eq!(d.release(), None, "the mode is the view's own");
        assert_eq!(d.mode, "window");
        // Pressed, then released off the row: nothing.
        let back = d.rows[0].id;
        let b = d.state.rect(&row_key(back)).unwrap();
        d.motion((b[0] + 20., b[1] + b[3] / 2.));
        d.press();
        d.motion((r[0] + 20., r[1] + r[3] / 2.));
        assert_eq!(d.release(), None);
        d.motion((b[0] + 20., b[1] + b[3] / 2.));
        d.press();
        assert_eq!(d.release(), Some(Action::Back));
    }
    #[test]
    fn a_slider_row_reports_its_value_while_dragged_and_on_release() {
        let mut d = Detail::new("night_light", 1);
        let mut s = status();
        s.night = Some(crate::status::Night {
            enabled: true,
            temperature: 4000,
        });
        if !laid(&mut d, &s, [0., 50., 396., 400.]) {
            return;
        }
        let row = d.rows.iter().find(|r| r.value.is_some()).unwrap();
        let (min, max, _) = row.value.unwrap();
        let t = d.state.rect(&row_key(row.id)).unwrap();
        let y = t[1] + t[3] / 2.;
        d.motion((t[0] + 1., y));
        assert_eq!(
            d.press(),
            Some(Action::Number("nightlight.temperature", min as i32))
        );
        let (_, slid) = d.motion((t[0] + t[2] + 50., y));
        assert_eq!(
            slid,
            Some(Action::Number("nightlight.temperature", max as i32))
        );
        assert_eq!(
            d.release(),
            Some(Action::Number("nightlight.temperature", max as i32))
        );
        // A key steps it by its own step.
        let left = nk_wayland::Key {
            serial: None,
            sym: 0xff51,
            text: String::new(),
            shift: false,
            ctrl: false,
            alt: false,
        };
        assert_eq!(
            d.key(&left),
            Some(Action::Number("nightlight.temperature", max as i32 - 100))
        );
    }
}
