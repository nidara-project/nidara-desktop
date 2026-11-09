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
    fn toggle(mut self, checked: bool) -> Self {
        self.checked = Some(checked);
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
    pub hover: Option<u64>,
    pub focus: Option<u64>,
    pub held: Option<(u64, f64)>,
    pub offset: usize,
    pub mode: &'static str,
    pub audio: bool,
    pub clipboard_confirm: bool,
    pub error: String,
    pub max_height: f64,
    limit: usize,
    pub auth_ready: bool,
    pub form: Option<crate::ccauth::Form>,
}
const ROW: f64 = 48.;
impl Detail {
    pub fn new(page: &'static str, generation: u64) -> Self {
        Self {
            page,
            rows: vec![],
            panel: [0.; 4],
            ids: HashMap::new(),
            next_id: generation * 10000,
            hover: None,
            focus: None,
            held: None,
            offset: 0,
            mode: if page == "screenshot" {
                "area"
            } else {
                "screen"
            },
            audio: false,
            clipboard_confirm: false,
            error: String::new(),
            max_height: 1080.,
            limit: 8,
            auth_ready: false,
            form: None,
        }
    }
    pub fn refresh(&mut self, status: &Status, panel: [f64; 4]) {
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
        if let Some((id, value)) = self.held
            && let Some(row) = rows.iter_mut().find(|r| r.id == id)
            && let Some((min, max, _)) = row.value
        {
            row.value = Some((min, max, value.clamp(min, max)));
        }
        self.rows = rows;
        if self.form.is_some()
            && !self.rows.iter().any(|r| Some(r.id) == self.focus)
            && let Some(id) = self
                .rows
                .iter()
                .find(|r| matches!(r.action, Some(Action::SecretFocus(_))))
                .map(|r| r.id)
        {
            self.focus_row(id);
        }
        self.offset = self.offset.min(self.rows.len().saturating_sub(self.limit));
        self.limit = (((self.max_height - panel[1] - 2. * PAD) / ROW).floor() as usize).clamp(1, 8);
        self.panel = [
            panel[0],
            panel[1],
            panel[2],
            self.rows.len().min(self.limit) as f64 * ROW + 2. * PAD,
        ];
    }
    pub fn key(&mut self, key: &nk_wayland::Key) -> Option<Action> {
        let mut index = self
            .rows
            .iter()
            .position(|r| Some(r.id) == self.focus)
            .unwrap_or(0);
        if [0xff09, 0xfe20, 0xff52, 0xff54].contains(&key.sym) {
            let backward =
                key.sym == 0xfe20 || key.sym == 0xff52 || (key.sym == 0xff09 && key.shift);
            for _ in 0..self.rows.len() {
                index = if backward {
                    (index + self.rows.len() - 1) % self.rows.len()
                } else {
                    (index + 1) % self.rows.len()
                };
                if self.rows[index].action.is_some() {
                    break;
                }
            }
            self.focus_row(self.rows[index].id);
            if index < self.offset {
                self.offset = index;
            } else if index >= self.offset + self.limit {
                self.offset = index + 1 - self.limit;
            }
            return None;
        }
        let row = &self.rows[index];
        if [0xff51, 0xff53].contains(&key.sym)
            && let Some((_, _, value)) = row.value
        {
            let step = if matches!(
                row.action,
                Some(Action::Number("nightlight.temperature", _))
            ) {
                100.
            } else {
                1.
            };
            return self.action(
                row.id,
                Some(value + if key.sym == 0xff51 { -step } else { step }),
            );
        }
        if key.sym == 0xffff {
            return self.named(row.id, "Remove");
        }
        if [0xff0d, 0x20].contains(&key.sym) {
            return self.action(row.id, None);
        }
        None
    }
    pub fn focus_row(&mut self, id: u64) {
        let Some(index) = self.rows.iter().position(|r| r.id == id) else {
            return;
        };
        self.focus = Some(id);
        if let Some(Action::SecretFocus(field)) = self.rows[index].action
            && let Some(form) = &mut self.form
        {
            form.focus(field);
        }
        if index < self.offset {
            self.offset = index;
        } else if index >= self.offset + self.limit {
            self.offset = index + 1 - self.limit;
        }
    }
    pub fn focused_field(&self) -> Option<usize> {
        let row = self.rows.iter().find(|r| Some(r.id) == self.focus)?;
        match row.action {
            Some(Action::SecretFocus(index)) => Some(index),
            _ => None,
        }
    }
    pub fn text_input(&self, look: Option<&mut Look>) -> nk_wayland::TextInput {
        let Some(index) = self.focused_field() else {
            return Default::default();
        };
        let Some((_, r)) = self.visible().find(|(row, _)| Some(row.id) == self.focus) else {
            return Default::default();
        };
        let count = self
            .form
            .as_ref()
            .map(|f| {
                f.fields[index].text[..f.fields[index].caret]
                    .chars()
                    .count()
                    .min(32)
            })
            .unwrap_or(0);
        let advance = look
            .and_then(|look| {
                let style = style_small(look);
                lay_out(look, &"•".repeat(count), &style, f32::MAX)
                    .ok()
                    .map(|layout| f64::from(layout.measured_size().width))
            })
            .unwrap_or(0.);
        nk_wayland::TextInput {
            focused: true,
            password: true,
            text: String::new(),
            cursor: 0,
            anchor: 0,
            rect: [
                (r[0] + 8. + advance.min(r[2] - 16.)) as i32,
                (r[1] + 27.) as i32,
                1,
                14,
            ],
        }
    }
    pub fn scroll(&mut self, delta: f64) {
        let max = self.rows.len().saturating_sub(self.limit);
        self.offset = (self.offset as isize + if delta > 0. { 1 } else { -1 })
            .clamp(0, max as isize) as usize;
    }
    fn visible(&self) -> impl Iterator<Item = (&Row, [f64; 4])> {
        self.rows
            .iter()
            .skip(self.offset)
            .take(self.limit)
            .enumerate()
            .map(|(i, row)| {
                (
                    row,
                    [
                        self.panel[0] + PAD,
                        self.panel[1] + PAD + i as f64 * ROW,
                        self.panel[2] - 2. * PAD,
                        ROW,
                    ],
                )
            })
    }
    pub fn target(&self, p: (f64, f64)) -> Option<u64> {
        self.visible()
            .find(|(_, r)| inside(*r, p))
            .map(|(row, _)| row.id)
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
    pub fn pointer_action(&mut self, id: u64, p: (f64, f64)) -> Option<Action> {
        let (row, r) = self.visible().find(|(row, _)| row.id == id)?;
        if let Some(Action::Clipboard {
            id,
            revision,
            remove: false,
            wipe: false,
        }) = &row.action
            && p.0 > r[0] + r[2] - 32.
        {
            return Some(Action::Clipboard {
                id: id.clone(),
                revision: *revision,
                remove: true,
                wipe: false,
            });
        }
        let value = row
            .value
            .map(|(min, max, _)| min + (max - min) * ((p.0 - r[0]) / r[2]).clamp(0., 1.));
        self.focus = Some(id);
        self.held = value.map(|v| (id, v));
        self.action(id, value)
    }
    pub fn paint(
        &self,
        c: &mut Canvas,
        look: &mut Look,
        fallback: Option<Color>,
    ) -> nk_wayland::Result<()> {
        if let Some(base) = fallback {
            c.rounded_rect(rect(self.panel), SQUARE_RADIUS, base);
            for state in self.states() {
                c.rounded_rect(
                    rect([
                        state.bounds.x,
                        state.bounds.y,
                        state.bounds.width,
                        state.bounds.height,
                    ]),
                    state.radius,
                    Color::new(state.wash.map(|v| v as f32)),
                );
            }
        }
        let style = style(look, TEXT, 400.);
        for (row, r) in self.visible() {
            let label = row.label(Some(look));
            let image_row = row.thumbnail.is_some();
            if let Some((revision, id)) = &row.thumbnail
                && let Some(image) = crate::ccaux::thumbnail(*revision, id)
            {
                c.image(
                    &image,
                    rect([r[0] + 8., r[1] + 4., 32., 32.]),
                    ImageFit::Contain,
                );
            }
            let clip_row = matches!(
                row.action,
                Some(Action::Clipboard {
                    wipe: false,
                    remove: false,
                    ..
                })
            );
            if matches!(
                row.action,
                Some(Action::Clipboard {
                    wipe: false,
                    remove: false,
                    ..
                })
            ) {
                crate::notification_card::text(
                    c,
                    look,
                    "×",
                    &style,
                    [r[0] + r[2] - 28., r[1] + 12., 20., 24.],
                    1,
                    1.,
                )?;
            }
            if let Some(checked) = row.checked {
                let b = rect([r[0] + 8., r[1] + 13., 10., 10.]);
                if checked {
                    c.rounded_rect(b, 5., look.styles.palette.accent);
                } else {
                    c.rounded_ring(b, 5., 1., ink(DIM));
                }
            }
            let text = fit(
                look,
                &label,
                &style,
                r[2] - if clip_row {
                    if image_row { 86. } else { 46. }
                } else if row.value.is_some() {
                    80.
                } else if row.checked.is_some() {
                    34.
                } else {
                    16.
                },
            );
            let layout = lay_out(look, &text, &style, r[2] as f32)?;
            c.layout(
                &layout,
                (
                    (r[0]
                        + if image_row {
                            48.
                        } else if row.checked.is_some() {
                            26.
                        } else {
                            8.
                        }) as f32,
                    (r[1] + 8.) as f32,
                ),
                ink(1.),
            )?;
            let sub = row
                .value
                .map(|(_, _, v)| {
                    if matches!(row.action, Some(Action::Time(..))) {
                        format!("{:02}:{:02}", v as i32 / 60, v as i32 % 60)
                    } else {
                        format!("{v:.0}")
                    }
                })
                .unwrap_or_else(|| {
                    if let Some(Action::SecretFocus(index)) = &row.action {
                        self.form
                            .as_ref()
                            .and_then(|f| f.fields.get(*index))
                            .map(|f| "•".repeat(f.text.chars().count().min(32)))
                            .unwrap_or_default()
                    } else {
                        row.description.clone()
                    }
                });
            if let Some((min, max, value)) = row.value {
                let track = [r[0] + 8., r[1] + ROW - 10., r[2] - 16., 4.];
                let at = track[0] + track[2] * ((value - min) / (max - min).max(1.)).clamp(0., 1.);
                c.rounded_rect(rect(track), 2., ink(0.18));
                c.rounded_rect(rect([track[0], track[1], at - track[0], 4.]), 2., ink(0.9));
                c.rounded_rect(rect([at - 5., track[1] - 3., 10., 10.]), 5., ink(0.95));
            }
            if !sub.is_empty() {
                let small = style_small(look);
                let sub = fit(look, &sub, &small, r[2] - 16.);
                let layout = lay_out(look, &sub, &small, r[2] as f32)?;
                let (x, y) = if row.value.is_some() {
                    (
                        r[0] + r[2] - f64::from(layout.measured_size().width) - 8.,
                        r[1] + 8.,
                    )
                } else {
                    (r[0] + 8., r[1] + 27.)
                };
                c.layout(&layout, (x as f32, y as f32), ink(SECONDARY))?;
            }
            if let Some(Action::SecretFocus(index)) = row.action
                && let Some(form) = &self.form
                && self.focus == Some(row.id)
                && form.focused == index
            {
                let field = &form.fields[index];
                let bullets = "•".repeat(field.text[..field.caret].chars().count().min(32));
                let small = style_small(look);
                let echo = lay_out(look, &bullets, &small, f32::MAX)?;
                let caret =
                    (r[0] + 8. + f64::from(echo.measured_size().width)).min(r[0] + r[2] - 8.);
                c.rect(rect([caret, r[1] + 27., 1., 14.]), ink(1.));
            }
        }
        Ok(())
    }
    pub fn states(&self) -> Vec<StateRegion> {
        self.visible()
            .map(|(row, r)| StateRegion {
                id: 100000 + row.id as u32,
                bounds: MaterialRect {
                    x: r[0],
                    y: r[1],
                    width: r[2],
                    height: r[3],
                },
                radius: 12.,
                wash: [
                    1.,
                    1.,
                    1.,
                    if self.hover == Some(row.id) || self.focus == Some(row.id) {
                        HOVER
                    } else {
                        0.
                    },
                ],
                fade_ms: FADE_MS,
            })
            .collect()
    }
    pub fn nodes(&self, first: u64, look: Option<&Look>) -> Vec<(nk_a11y::Node, Target)> {
        use nk_a11y::{Action as A, Bounds, Node, Role, ValueInfo};
        self.rows
            .iter()
            .enumerate()
            .map(|(index, row)| {
                let r = [
                    self.panel[0] + PAD,
                    self.panel[1] + PAD + (index as f64 - self.offset as f64) * ROW,
                    self.panel[2] - 2. * PAD,
                    ROW,
                ];
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
                n.states.offscreen = index < self.offset || index >= self.offset + self.limit;
                n.states.focused = self.focus == Some(row.id);
                n.states.disabled = row.action.is_none();
                if let Some(Action::SecretFocus(_)) = row.action {
                    n.text = Some(Default::default());
                    n.states.focused = self.focus == Some(row.id);
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
                n.value = row.value.map(|(min, max, current)| ValueInfo {
                    min,
                    max,
                    current,
                    step: 1.,
                    text: if matches!(row.action, Some(Action::Time(..))) {
                        format!("{:02}:{:02}", current as i32 / 60, current as i32 % 60)
                    } else {
                        format!("{current:.0}")
                    },
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
fn style_small(look: &Look) -> TextStyle {
    style(look, SMALL, 400.)
}
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
                    .toggle(d["wiredEnabled"] == true),
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
                    .toggle(n["wirelessEnabled"] == true),
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
                    .toggle(b.powered),
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
                    .toggle(n.enabled),
                );
                if s.night_schedule.0
                    && let Some(row) = out.last_mut()
                {
                    row.action = None;
                }
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
                    .toggle(s.night_schedule.0),
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
            out.push(Row::key("widget.screenrecord.audio", Action::ToggleAudio).toggle(audio));
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
        d.refresh(&s, [0., 50., 396., 400.]);
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
        d.refresh(&s, d.panel);
        assert!(matches!(d.action(home,None),Some(Action::Connect {ap,..}) if ap=="/ap/strong"));
        assert!(matches!(d.action(other,None),Some(Action::Connect {ap,..}) if ap=="/ap/other"));
        s.apply(crate::status::Update::Wifi(None, String::new()));
        d.refresh(&s, d.panel);
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
        d.refresh(&status(), [0., 50., 396., 400.]);
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
        detail.refresh(&status(), [0., 50., 396., 400.]);
        assert_eq!(detail.focused_field(), Some(0));
        assert!(detail.text_input(None).focused);
        assert!(detail.text_input(None).password);
        assert!(detail.text_input(None).text.is_empty());
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
                .any(|r| Some(r.id) == detail.focus && r.action == Some(Action::SecretSubmit))
            {
                reached_submit = true;
                assert!(!detail.text_input(None).focused);
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
            d.refresh(&s, [0., 50., 396., 400.]);
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
                assert!(d.focus.is_some());
                d.scroll(1.);
                assert!(d.offset > 0);
            }
        }
    }
    #[test]
    fn a_slider_action_is_explicit_and_clamped_and_mode_changes_have_no_effect() {
        let mut d = Detail::new("night_light", 1);
        let mut s = status();
        s.night = Some(crate::status::Night {
            enabled: false,
            temperature: 4000,
        });
        d.refresh(&s, [0., 50., 396., 400.]);
        let id = d.rows.iter().find(|r| r.value.is_some()).unwrap().id;
        assert_eq!(
            d.action(id, Some(9000.)),
            Some(Action::Number("nightlight.temperature", 6500))
        );
        let mut d = Detail::new("screenshot", 2);
        d.refresh(&s, d.panel);
        let id = d
            .rows
            .iter()
            .find(|r| matches!(r.action, Some(Action::SetMode("window"))))
            .unwrap()
            .id;
        assert_eq!(d.action(id, None), None);
        assert_eq!(d.mode, "window");
    }
}
