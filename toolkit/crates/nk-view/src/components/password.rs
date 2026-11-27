// SPDX-License-Identifier: LGPL-3.0-or-later
//! A password editor whose view, reader tree and input context contain no secret.
use super::*;
use nk_text::Point;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct PasswordEntry;

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

    fn shown(&self) -> crate::view::Field {
        let boundaries = self.boundaries();
        let first = self.first_visible(&boundaries);
        let count = (boundaries.len() - 1 - first).min(16);
        let offset = |at| {
            boundaries
                .partition_point(|boundary| *boundary < at)
                .saturating_sub(first)
                .min(count)
                * '•'.len_utf8()
        };
        crate::view::Field {
            shown: "•".repeat(count),
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

    fn display(read: &Read<'_>) -> Option<super::field::DisplayField> {
        let state = read.state?.downcast_ref::<State>()?;
        Some(super::field::DisplayField {
            field: state.shown(),
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
            .map_or_else(String::new, |state| state.shown().shown);
        let mut style = cx
            .look
            .types
            .style(crate::Type::Body, crate::Weight::Regular);
        style.alignment = nk_text::Alignment::Left;
        Node::text(cx.key("text"), text, style).lines(1)
    }

    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        let bounds = self.silhouette(cx);
        Some(FocusOutline::rounded(
            bounds,
            cx.look.tokens.entry.radius.min(bounds[3] / 2.),
        ))
    }

    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let style = &look.tokens.entry;
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
                .map(|hit| hit.offset / '•'.len_utf8())
        });
        self.update(cx, |state| {
            let boundaries = state.boundaries();
            let first = state.first_visible(&boundaries);
            let at = offset
                .and_then(|at| boundaries.get(first + at).copied())
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
        let rect = Self::display(cx)?.caret(cx).unwrap_or_else(|| {
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
            super::editable::chrome(cx);
            if let Some(field) = Self::display(&cx.read) {
                field.paint(cx, phase);
            }
        }
    }
}
