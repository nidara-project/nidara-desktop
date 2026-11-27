// SPDX-License-Identifier: LGPL-3.0-or-later
//! A password editor whose view, reader tree and input context contain no secret.
use super::*;
use nk_text::Point;
use unicode_segmentation::UnicodeSegmentation;

/// What each character of a password is drawn as: GTK's own choice for its password
/// entries (U+25CF BLACK CIRCLE, `gtk_text` invisible char), large enough to count.
/// U+2022 BULLET, before, is a text-sized dot, hard to tell apart at body size.
pub(crate) const DOT: char = '●';

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct PasswordEntry {
    /// Inside a `PasswordSubmit`, which draws the chrome around it and its button.
    #[serde(default)]
    pub bare: bool,
    /// The characters are drawn as typed instead of as dots (`PasswordEntry::revealed`).
    /// Readers and the input method still get a password with no text.
    #[serde(default)]
    pub revealed: bool,
}

#[derive(Default)]
struct State {
    secret: Secret,
    caret: usize,
    anchor: usize,
    revision: u64,
    rebuild: bool,
}

impl State {
    fn selection(&self) -> std::ops::Range<usize> {
        self.caret.min(self.anchor)..self.caret.max(self.anchor)
    }

    fn move_to(&mut self, offset: usize, extend: bool) {
        self.caret = offset;
        if !extend {
            self.anchor = offset;
        }
    }

    fn boundaries(&self) -> Vec<usize> {
        self.secret
            .as_str()
            .grapheme_indices(true)
            .map(|(at, _)| at)
            .chain(std::iter::once(self.secret.as_str().len()))
            .collect()
    }

    fn first_visible(&self, boundaries: &[usize]) -> usize {
        const VISIBLE: usize = 16;
        let caret = boundaries.partition_point(|boundary| *boundary < self.caret);
        caret
            .saturating_sub(VISIBLE - 1)
            .min(boundaries.len().saturating_sub(VISIBLE + 1))
    }

    /// What each of the graphemes from `first` on is drawn as: a dot each, or itself.
    fn drawn(
        &self,
        boundaries: &[usize],
        first: usize,
        count: usize,
        revealed: bool,
    ) -> Vec<String> {
        (first..first + count)
            .map(|g| {
                if revealed {
                    self.secret.as_str()[boundaries[g]..boundaries[g + 1]].to_string()
                } else {
                    DOT.to_string()
                }
            })
            .collect()
    }

    fn shown(&self, revealed: bool) -> crate::view::Field {
        let boundaries = self.boundaries();
        let first = self.first_visible(&boundaries);
        let count = (boundaries.len() - 1 - first).min(16);
        let drawn = self.drawn(&boundaries, first, count, revealed);
        let offset = |at| {
            let g = boundaries
                .partition_point(|boundary| *boundary < at)
                .saturating_sub(first)
                .min(count);
            drawn[..g].iter().map(String::len).sum()
        };
        crate::view::Field {
            shown: drawn.concat(),
            caret: offset(self.caret),
            anchor: offset(self.anchor),
            secret: true,
        }
    }

    fn replace(&mut self, range: std::ops::Range<usize>, text: &str) -> bool {
        if text.chars().any(char::is_control)
            || self.secret.as_str().len() - range.len() + text.len() > 4096
        {
            return false;
        }
        let end = range.start + text.len();
        self.secret.replace_range(range, text);
        let next = self
            .boundaries()
            .into_iter()
            .find(|offset| *offset >= end)
            .unwrap_or(self.secret.as_str().len());
        self.move_to(next, false);
        true
    }
}

impl PasswordEntry {
    fn update(&self, cx: &mut Input<'_>, edit: impl FnOnce(&mut State) -> bool) {
        let Some(state) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        else {
            return;
        };
        let changed = edit(state);
        state.rebuild = true;
        state.revision += 1;
        cx.effects.handled = true;
        if changed {
            cx.effects.activate = true;
            cx.effects.value = Some(Value::Secret(state.secret.clone()));
        }
        if let Some(read) = cx.context {
            cx.effects.host.push(HostRequest::Rebuild {
                target: read.reply_target(self.type_id(), state.revision),
            });
        }
    }

    fn display(&self, read: &Read<'_>) -> Option<super::field::DisplayField> {
        let state = read.state?.downcast_ref::<State>()?;
        Some(super::field::DisplayField {
            field: state.shown(self.revealed),
            style: read
                .look
                .types
                .style(crate::Type::Body, crate::Weight::Regular),
            surface: Surface::default(),
        })
    }
}

impl Component for PasswordEntry {
    fn state(&self) -> Option<Box<dyn Any>> {
        Some(Box::<State>::default())
    }

    fn revision(&self, state: Option<&dyn Any>) -> Option<u64> {
        Some(state?.downcast_ref::<State>()?.revision)
    }

    fn rebuild_pending(&self, state: Option<&dyn Any>) -> bool {
        state
            .and_then(|s| s.downcast_ref::<State>())
            .is_some_and(|s| s.rebuild)
    }

    fn reconcile(&self, state: Option<&mut dyn Any>) {
        if let Some(state) = state.and_then(|s| s.downcast_mut::<State>()) {
            state.rebuild = false;
        }
    }

    fn body(&self, cx: &Build<'_>) -> Node {
        let text = cx
            .state
            .and_then(|s| s.downcast_ref::<State>())
            .map_or_else(String::new, |state| state.shown(self.revealed).shown);
        let mut style = cx
            .look
            .types
            .style(crate::Type::Body, crate::Weight::Regular);
        style.alignment = nk_text::Alignment::Left;
        Node::text(cx.key("text"), text, style).lines(1)
    }

    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        let mut bounds = self.silhouette(cx);
        // Inside a field with a button, one outline goes round both, as Search's does.
        if self.bare {
            let owner = cx.key.0.rsplit_once('/')?.0;
            bounds = cx.placed.iter().find(|p| p.key.0 == owner)?.rect;
        }
        Some(FocusOutline::rounded(
            bounds,
            cx.look.tokens.entry.radius.min(bounds[3] / 2.),
        ))
    }

    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let style = &look.tokens.entry;
        if self.bare {
            return FrameSpec {
                inset: (0., 0.),
                least: (
                    style.min_height * 4.,
                    (style.min_height - 2. * style.border).max(0.),
                ),
                body: BodyPlacement::FillWidth,
            };
        }
        FrameSpec {
            inset: (style.padding_x + style.border, style.border),
            least: (style.min_height * 5., style.min_height),
            body: BodyPlacement::FillWidth,
        }
    }

    fn press(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        let offset = cx.context.and_then(|read| {
            let (part, text) = read.text("text")?;
            text.layout
                .hit_test(Point {
                    x: (at.0 - part.rect[0]) as f32,
                    y: (at.1 - part.rect[1]) as f32,
                })
                .ok()
                .map(|hit| hit.offset)
        });
        let revealed = self.revealed;
        self.update(cx, |state| {
            let boundaries = state.boundaries();
            let first = state.first_visible(&boundaries);
            let count = (boundaries.len() - 1 - first).min(16);
            // The byte the pointer hit in what is drawn, back to the grapheme it belongs to.
            let at = offset
                .map(|hit| {
                    let mut end = 0;
                    let g = state
                        .drawn(&boundaries, first, count, revealed)
                        .iter()
                        .take_while(|d| {
                            end += d.len();
                            end <= hit
                        })
                        .count();
                    boundaries[first + g]
                })
                .unwrap_or(state.secret.as_str().len());
            state.move_to(at, false);
            false
        });
        cx.effects.focus = true;
    }

    fn key_event(&self, cx: &mut Input<'_>, key: &nk_wayland::Key) {
        if key.ctrl && matches!(key.sym, 0x76 | 0x56) {
            if let Some(read) = cx.context
                && let Some(state) = cx
                    .state
                    .as_deref_mut()
                    .and_then(|s| s.downcast_mut::<State>())
            {
                state.revision += 1;
                cx.effects.host.push(HostRequest::Paste {
                    target: read.reply_target(self.type_id(), state.revision),
                });
            }
            cx.effects.handled = true;
            return;
        }
        if key.ctrl && !matches!(key.sym, 0x61 | 0x41) {
            cx.effects.handled = matches!(key.sym, 0x63 | 0x43 | 0x78 | 0x58);
            return;
        }
        if matches!(key.sym, 0xff09 | 0xfe20 | 0xff0d | 0xff8d | 0xff1b) {
            return;
        }
        self.update(cx, |state| {
            let range = state.selection();
            let boundaries = state.boundaries();
            let previous = boundaries
                .iter()
                .rev()
                .copied()
                .find(|at| *at < state.caret)
                .unwrap_or(0);
            let next = boundaries
                .iter()
                .copied()
                .find(|at| *at > state.caret)
                .unwrap_or(state.secret.as_str().len());
            match key.sym {
                0x61 | 0x41 if key.ctrl => {
                    state.anchor = 0;
                    state.caret = state.secret.as_str().len();
                }
                0xff51 => state.move_to(
                    if !key.shift && !range.is_empty() {
                        range.start
                    } else {
                        previous
                    },
                    key.shift,
                ),
                0xff53 => state.move_to(
                    if !key.shift && !range.is_empty() {
                        range.end
                    } else {
                        next
                    },
                    key.shift,
                ),
                0xff50 => state.move_to(0, key.shift),
                0xff57 => state.move_to(state.secret.as_str().len(), key.shift),
                0xff08 => {
                    return state.replace(
                        if range.is_empty() {
                            previous..state.caret
                        } else {
                            range
                        },
                        "",
                    );
                }
                0xffff => {
                    return state.replace(
                        if range.is_empty() {
                            state.caret..next
                        } else {
                            range
                        },
                        "",
                    );
                }
                _ if !key.text.is_empty() => return state.replace(range, &key.text),
                _ => {}
            }
            false
        });
    }

    fn enter(&self, _cx: &mut Input<'_>) {
        // The single-line field leaves Enter to the dialog's default response.
    }

    fn request(&self, cx: &mut Input<'_>, request: Request) {
        if let Request::Paste(text) = request {
            self.update(cx, |state| state.replace(state.selection(), &text));
        }
    }

    fn ime(&self, cx: &mut Input<'_>, batch: &nk_wayland::ImeBatch) {
        if let Some(text) = &batch.commit {
            self.update(cx, |state| state.replace(state.selection(), text));
        }
    }

    fn text_input(&self, cx: &Read<'_>) -> Option<nk_wayland::TextInput> {
        let rect = self.display(cx)?.caret(cx).unwrap_or_else(|| {
            let entry = &cx.look.tokens.entry;
            [cx.rect[0] + entry.padding_x, cx.rect[1], 1., cx.rect[3]]
        });
        Some(nk_wayland::TextInput {
            focused: true,
            password: true,
            text: String::new(),
            cursor: 0,
            anchor: 0,
            rect: rect.map(|value| value.round() as i32),
        })
    }

    fn blur(&self, state: Option<&mut dyn Any>) {
        if let Some(state) = state.and_then(|s| s.downcast_mut::<State>()) {
            state.revision += 1;
        }
    }

    fn semantics(&self, _cx: &Read<'_>, node: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        node.role = nk_a11y::Role::Password;
        node.actions = vec![nk_a11y::Action::Focus];
    }

    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase == PaintPhase::Under {
            if !self.bare {
                super::editable::chrome(cx);
            }
            if let Some(field) = self.display(&cx.read) {
                field.paint(cx, phase);
            }
        }
    }
}

/// A password field with its submit button inside it, at its end: the pointer's way to do
/// what Enter does (#1195: "Unlock" on the lock screen, "Log in" on the login screen). The
/// field reports `changed` with the secret, as `PasswordEntry`; the button reports `submit`.
/// Enter itself is the host's, as for every single-line field.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PasswordSubmit {
    pub name: String,
    pub changed: String,
    pub submit_label: String,
    pub submit: String,
    pub disabled: bool,
    /// A button before the submit one that shows or hides the characters (GTK's
    /// `show-peek-icon`): its action, and its names for readers while they are hidden and
    /// while they are shown. The app keeps whether they are shown (`revealed`).
    #[serde(default)]
    pub peek: Option<Peek>,
    #[serde(default)]
    pub revealed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Peek {
    pub action: String,
    pub show_label: String,
    pub hide_label: String,
}
impl PasswordSubmit {
    pub(crate) fn node(self, key: impl Into<Key>) -> Node {
        Node::drawing(key, Part::PasswordSubmit(self))
    }
}
impl Component for PasswordSubmit {
    fn contains_controls(&self) -> bool {
        true
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let mut input = Node::control(
            cx.key("input"),
            self.name.clone(),
            self.changed.clone(),
            Node::spacer(cx.key("input/body")),
        )
        .role(crate::Role::Field)
        .enabled(!self.disabled)
        .grow();
        if let Kind::Control(c) = &mut input.kind {
            c.part = Some(Box::new(Part::Password(PasswordEntry {
                bare: true,
                revealed: self.revealed,
            })));
        }
        let peek = self.peek.as_ref().map(|p| {
            let mut peek = Node::control(
                cx.key("peek"),
                if self.revealed {
                    p.hide_label.clone()
                } else {
                    p.show_label.clone()
                },
                p.action.clone(),
                Node::spacer(cx.key("peek/body")),
            )
            .enabled(!self.disabled);
            if let Kind::Control(c) = &mut peek.kind {
                c.part = Some(Box::new(Part::SubmitButton(SubmitButton {
                    glyph: if self.revealed {
                        Glyph::Conceal
                    } else {
                        Glyph::Reveal
                    },
                })));
            }
            peek
        });
        let mut submit = Node::control(
            cx.key("submit"),
            self.submit_label.clone(),
            self.submit.clone(),
            Node::spacer(cx.key("submit/body")),
        )
        .enabled(!self.disabled);
        if let Kind::Control(c) = &mut submit.kind {
            c.part = Some(Box::new(Part::SubmitButton(SubmitButton::default())));
        }
        let children = std::iter::once(input).chain(peek).chain([submit]).collect();
        Node::row(cx.key("body"), children).align(crate::Align::Center)
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let t = &look.tokens.entry;
        FrameSpec {
            // The button sits at the end, as close to the edge as Search's clear button.
            inset: (t.padding_x + t.border, t.border),
            least: (0., t.min_height),
            body: BodyPlacement::FillWidth,
        }
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase == PaintPhase::Under {
            super::editable::chrome(cx);
        }
    }
}

/// A button inside a `PasswordSubmit`: a glyph in a round hover wash, as Search's clear
/// button. Activating it reports its action: the field's submit, or showing or hiding.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct SubmitButton {
    #[serde(default)]
    pub glyph: Glyph,
}

/// What a button inside a password field draws.
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub enum Glyph {
    #[default]
    Submit,
    /// Show the characters: they are hidden now.
    Reveal,
    /// Hide them again.
    Conceal,
}
impl SubmitButton {
    fn visible(&self, cx: &Read<'_>) -> Rect {
        let r = cx.rect;
        let side = cx.look.tokens.entry.clear_button.min(r[2]).min(r[3]);
        [
            r[0] + (r[2] - side) / 2.,
            r[1] + (r[3] - side) / 2.,
            side,
            side,
        ]
    }
}
impl Component for SubmitButton {
    fn silhouette(&self, cx: &Read<'_>) -> Rect {
        self.visible(cx)
    }
    /// On glass (its field made of glass, or in a pane) its hover and press are Hyalo's.
    fn glass(&self, cx: &Read<'_>) -> Glass {
        if !cx.over_glass() {
            return Glass::default();
        }
        let washes = &cx.look.tokens.washes;
        let rest = [washes.hover[0], washes.hover[1], washes.hover[2], 0.];
        let lit = if !cx.interaction.enabled {
            (4, rest)
        } else if cx.interaction.pressed {
            (0, washes.press)
        } else if cx.interaction.hover {
            (1, washes.hover)
        } else if cx.fading {
            (2, rest)
        } else {
            (4, rest)
        };
        Glass { lit: Some(lit) }
    }
    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        let bounds = self.silhouette(cx);
        Some(FocusOutline::rounded(bounds, bounds[3] / 2.))
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let t = &cx.look.tokens.entry;
        let icon = match self.glyph {
            Glyph::Submit => &t.submit_icon,
            Glyph::Reveal => &t.reveal_icon,
            Glyph::Conceal => &t.conceal_icon,
        };
        Node::icon(cx.key("glyph"), icon.clone(), t.icon_size)
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let t = &look.tokens.entry;
        let side = (t.min_height - 2. * t.border).max(t.icon_size);
        FrameSpec {
            inset: (0., 0.),
            least: (side, side),
            body: BodyPlacement::NaturalCentered,
        }
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        if cx.read.over_glass() {
            return;
        }
        let r = self.visible(&cx.read);
        if cx.interaction.enabled && (cx.interaction.hover || cx.interaction.pressed) {
            cx.canvas
                .rounded_rect(rect(&r), r[3] / 2., cx.ink(cx.look.tokens.button.hover));
        }
    }
}
