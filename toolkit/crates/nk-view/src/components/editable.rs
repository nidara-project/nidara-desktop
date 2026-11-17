// SPDX-License-Identifier: LGPL-3.0-or-later
//! The retained single-line editor. Secrets remain in their existing owner-edited field.
use super::*;
use nk_text::{Affinity, Caret, Editor, Layout, Movement, Point};
use std::borrow::Cow;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct EditableField {
    pub text: String,
    pub placeholder: String,
    pub submit: Option<String>,
    pub chrome: bool,
    pub escape_clears: bool,
}
impl EditableField {
    pub fn new(text: impl Into<String>) -> Self {
        Self {
            text: text.into(),
            placeholder: String::new(),
            submit: None,
            chrome: true,
            escape_clears: false,
        }
    }
    pub fn node(
        self,
        key: impl Into<Key>,
        name: impl Into<String>,
        changed: impl Into<String>,
    ) -> Node {
        let key = key.into();
        let mut n = Node::control(
            key.clone(),
            name,
            changed,
            Node::spacer(format!("{}/body", key.0)),
        )
        .role(crate::Role::Field);
        if let Kind::Control(c) = &mut n.kind {
            c.part = Some(Box::new(Part::Editable(self)));
        }
        n
    }
    fn viewport(&self, cx: &Read<'_>) -> Rect {
        cx.part("viewport").map_or(cx.rect, |p| p.rect)
    }
    fn origin(&self, cx: &Read<'_>, s: &State) -> (f32, f32) {
        let r = self.viewport(cx);
        let e = s.editor.as_ref().expect("prepared editor");
        (
            (r[0] as f32) - s.scroll,
            (r[1] as f32) + (r[3] as f32 - e.layout().measured_size().height) / 2.,
        )
    }
    fn finish(&self, cx: &mut Input<'_>, before: Snapshot, result: Result<(), String>) {
        cx.effects.handled = true;
        let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        else {
            return;
        };
        if let Err(e) = result {
            eprintln!("single-line input rejected: {e}");
            return;
        }
        if let Some(e) = &s.editor {
            let after = Snapshot::of(e);
            if before != after {
                s.revision = s
                    .revision
                    .checked_add(1)
                    .expect("editor revision exhausted");
                cx.effects.redraw = true;
            }
            if before.text != after.text {
                s.reported = Some(after.text.clone());
                cx.effects.activate = true;
                cx.effects.value = Some(Value::Text(after.text));
            }
        }
        self.arrange(cx);
    }
    fn edit(&self, cx: &mut Input<'_>, op: impl FnOnce(&mut State) -> Result<(), String>) {
        let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        else {
            return;
        };
        let Some(e) = &s.editor else { return };
        let before = Snapshot::of(e);
        let result = op(s);
        self.finish(cx, before, result);
    }
}
#[derive(Default)]
struct State {
    editor: Option<Editor>,
    placeholder: Option<Layout>,
    style: Option<nk_text::TextStyle>,
    reported: Option<String>,
    revision: u64,
    scroll: f32,
    dragging: bool,
    hide_preedit_caret: bool,
    finished_composition: bool,
}
#[derive(PartialEq)]
struct Snapshot {
    text: String,
    caret: Caret,
    anchor: Caret,
    preedit: Option<nk_text::Preedit>,
}
impl Snapshot {
    fn of(e: &Editor) -> Self {
        Self {
            text: e.text().into(),
            caret: e.caret(),
            anchor: e.anchor(),
            preedit: e.preedit().cloned(),
        }
    }
}
fn single_line(text: &str) -> Result<(), String> {
    if text
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        Err("one line without control characters required".into())
    } else {
        Ok(())
    }
}
/// External single-line data keeps content, folding logical breaks rather than refusing it.
/// CRLF is one break; remove exactly one final break, preserving ordinary whitespace.
pub(super) fn normalize_single_line(text: &str) -> Cow<'_, str> {
    if single_line(text).is_ok() {
        return Cow::Borrowed(text);
    }
    let text = text
        .strip_suffix("\r\n")
        .or_else(|| text.strip_suffix(['\n', '\r', '\u{85}', '\u{2028}', '\u{2029}']))
        .unwrap_or(text);
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push(' ');
            }
            '\n' | '\u{85}' | '\u{2028}' | '\u{2029}' | '\t' => out.push(' '),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    Cow::Owned(out)
}
impl Component for EditableField {
    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        let mut bounds = self.silhouette(cx);
        // Search lends its chrome to the retained editor; its glyph and clear
        // button stay inside the one outline. This does not change the hit target.
        if !self.chrome {
            let owner = cx.key.0.rsplit_once('/')?.0;
            bounds = cx.placed.iter().find(|p| p.key.0 == owner)?.rect;
        }
        Some(FocusOutline::rounded(
            bounds,
            cx.look.tokens.entry.radius.min(bounds[3] / 2.),
        ))
    }
    fn state(&self) -> Option<Box<dyn Any>> {
        Some(Box::<State>::default())
    }
    fn prepare(&self, cx: &mut Prepare<'_>) -> Result<(), String> {
        let text = normalize_single_line(&self.text);
        let placeholder = normalize_single_line(&self.placeholder);
        let s = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
            .ok_or("missing editor state")?;
        let mut style = cx
            .look
            .types
            .style(crate::Type::Body, crate::Weight::Regular);
        style.alignment = nk_text::Alignment::Left;
        if s.editor.is_none() {
            s.editor = Some(Editor::new(
                cx.text.fork()?,
                &text,
                style.clone(),
                f32::MAX,
            )?);
        }
        let e = s.editor.as_mut().unwrap();
        if e.text() == text {
            // The model has acknowledged the edit. A later occurrence of this value is
            // a fresh model replacement, not an indefinitely replayable echo.
            s.reported = None;
        } else if s.reported.as_deref() != Some(text.as_ref()) {
            e.cancel_preedit()?;
            e.replace_range(0..e.text().len(), &text)?;
            s.reported = None;
            s.finished_composition = false;
            s.hide_preedit_caret = false;
            s.revision = s
                .revision
                .checked_add(1)
                .expect("editor revision exhausted");
        }
        if s.style.as_ref() != Some(&style) {
            e.set_style(style.clone())?;
            s.style = Some(style.clone());
            s.revision = s
                .revision
                .checked_add(1)
                .expect("editor revision exhausted");
        }
        if s.placeholder
            .as_ref()
            .is_none_or(|p| p.text() != placeholder || p.style() != &style)
        {
            s.placeholder = Some(cx.text.layout(&placeholder, &style, f32::MAX)?);
        }
        Ok(())
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let h = cx
            .state
            .and_then(|s| s.downcast_ref::<State>())
            .and_then(|s| s.editor.as_ref())
            .map_or(0., |e| e.layout().measured_size().height as f64);
        Node::row(cx.key("viewport"), vec![]).height(h)
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let s = &look.tokens.entry;
        let pad = if self.chrome {
            s.padding_x + s.border
        } else {
            0.
        };
        FrameSpec {
            inset: (pad, if self.chrome { s.border } else { 0. }),
            least: (
                0.,
                if self.chrome {
                    s.min_height
                } else {
                    (s.min_height - 2. * s.border).max(0.)
                },
            ),
            body: BodyPlacement::FillWidth,
        }
    }
    fn arrange(&self, cx: &mut Input<'_>) {
        let Some(read) = cx.context else { return };
        let width = self.viewport(&read)[2] as f32;
        let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        else {
            return;
        };
        let Some(e) = &s.editor else { return };
        let Ok(caret) = e.caret_rect() else { return };
        let before = s.scroll;
        if caret.x < s.scroll {
            s.scroll = caret.x;
        }
        if caret.x + caret.width > s.scroll + width {
            s.scroll = caret.x + caret.width - width;
        }
        s.scroll = s.scroll.max(0.);
        cx.effects.redraw |= before != s.scroll;
    }
    fn revision(&self, state: Option<&dyn Any>) -> Option<u64> {
        Some(state?.downcast_ref::<State>()?.revision)
    }
    fn value(&self, state: Option<&dyn Any>) -> Option<Value> {
        Some(Value::Text(
            state?
                .downcast_ref::<State>()?
                .editor
                .as_ref()?
                .text()
                .into(),
        ))
    }
    fn cancel(&self, state: Option<&mut dyn Any>) {
        if let Some(s) = state.and_then(|s| s.downcast_mut::<State>()) {
            s.dragging = false;
            s.finished_composition = false;
            if let Some(e) = &mut s.editor {
                let _ = e.cancel_preedit();
            }
            s.revision = s
                .revision
                .checked_add(1)
                .expect("editor revision exhausted");
        }
    }
    fn blur(&self, state: Option<&mut dyn Any>) {
        self.cancel(state);
    }
    fn press(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        let Some(read) = cx.context else { return };
        let Some(s) = cx.state.as_deref().and_then(|s| s.downcast_ref::<State>()) else {
            return;
        };
        let xy = self.origin(&read, s);
        let point = Point {
            x: at.0 as f32 - xy.0,
            y: at.1 as f32 - xy.1,
        };
        let double = read.clicks == 2;
        self.edit(cx, |s| {
            let e = s.editor.as_mut().unwrap();
            s.dragging = true;
            s.finished_composition = false;
            if double {
                e.select_word_at(point)
            } else {
                let c = e.layout().hit_test(point)?;
                e.set_caret(c.offset, c.affinity, false)
            }
        });
        cx.effects.capture = Capture::Take;
        cx.effects.focus = true;
    }
    fn drag(&self, cx: &mut Input<'_>, at: (f64, f64)) {
        let Some(read) = cx.context else { return };
        let Some(s) = cx.state.as_deref().and_then(|s| s.downcast_ref::<State>()) else {
            return;
        };
        if !s.dragging {
            return;
        }
        let xy = self.origin(&read, s);
        let point = Point {
            x: at.0 as f32 - xy.0,
            y: at.1 as f32 - xy.1,
        };
        self.edit(cx, |s| {
            let e = s.editor.as_mut().unwrap();
            let c = e.layout().hit_test(point)?;
            e.set_caret(c.offset, c.affinity, true)
        });
    }
    fn release(&self, cx: &mut Input<'_>, _at: (f64, f64)) {
        if let Some(s) = cx
            .state
            .as_deref_mut()
            .and_then(|s| s.downcast_mut::<State>())
        {
            s.dragging = false;
        }
        cx.effects.capture = Capture::Release;
        cx.effects.handled = true;
    }
    fn key(&self, cx: &mut Input<'_>, key: crate::KeyInput) {
        if key == crate::KeyInput::Activate {
            cx.effects.handled = true;
        }
    }
    fn enter(&self, cx: &mut Input<'_>) {
        let Some(s) = cx.state.as_deref().and_then(|s| s.downcast_ref::<State>()) else {
            return;
        };
        let Some(e) = &s.editor else { return };
        if e.preedit().is_some() || s.finished_composition {
            cx.effects.handled = true;
        } else if let Some(action) = &self.submit {
            cx.effects.handled = true;
            cx.effects.activate = true;
            cx.effects.action = Some(action.clone());
            cx.effects.value = Some(Value::Text(e.text().into()));
        }
    }
    fn key_event(&self, cx: &mut Input<'_>, key: &nk_wayland::Key) {
        if matches!(key.sym, 0xff09 | 0xfe20) {
            return;
        }
        let Some(s) = cx.state.as_deref().and_then(|s| s.downcast_ref::<State>()) else {
            return;
        };
        let Some(e) = &s.editor else { return };
        if key.ctrl && matches!(key.sym, 0x63 | 0x43 | 0x78 | 0x58 | 0x76 | 0x56) {
            cx.effects.handled = true;
            if matches!(key.sym, 0x76 | 0x56) {
                if let Some(read) = cx.context {
                    let s = cx
                        .state
                        .as_deref_mut()
                        .and_then(|s| s.downcast_mut::<State>())
                        .unwrap();
                    s.revision = s
                        .revision
                        .checked_add(1)
                        .expect("editor revision exhausted");
                    cx.effects.host.push(HostRequest::Paste {
                        target: read.reply_target(self.type_id(), s.revision),
                    });
                }
                return;
            }
            let text = e.selected_text().to_owned();
            cx.effects.host.push(HostRequest::Copy { text });
            if matches!(key.sym, 0x78 | 0x58) {
                self.edit(cx, |s| s.editor.as_mut().unwrap().cut().map(|_| ()));
            }
            return;
        }
        if key.sym == 0xff0d || key.sym == 0xff8d {
            cx.effects.handled = true;
            if let Some(action) = &self.submit {
                cx.effects.activate = true;
                cx.effects.action = Some(action.clone());
                cx.effects.value = Some(Value::Text(e.text().into()));
            }
            return;
        }
        if key.sym == 0xff1b
            && e.preedit().is_none()
            && !s.finished_composition
            && (!self.escape_clears || e.text().is_empty())
        {
            return;
        }
        let supported = if key.ctrl {
            matches!(
                key.sym,
                0x61 | 0x41
                    | 0x7a
                    | 0x5a
                    | 0x79
                    | 0x59
                    | 0xff51
                    | 0xff53
                    | 0xff50
                    | 0xff57
                    | 0xff08
                    | 0xffff
            )
        } else {
            matches!(
                key.sym,
                0xff1b | 0xff51 | 0xff53 | 0xff50 | 0xff57 | 0xff08 | 0xffff
            ) || !key.alt && !key.text.is_empty()
        };
        if !supported {
            return;
        }
        self.edit(cx, |s| {
            let finished = std::mem::take(&mut s.finished_composition);
            let e = s.editor.as_mut().unwrap();
            if key.sym == 0xff1b && finished {
                return Ok(());
            }
            if key.ctrl {
                match key.sym {
                    0x61 | 0x41 => e.set_selection(
                        Caret::default(),
                        Caret {
                            offset: e.text().len(),
                            affinity: Affinity::Upstream,
                        },
                    )?,
                    0x7a | 0x5a if key.shift => {
                        e.redo()?;
                    }
                    0x7a | 0x5a => {
                        e.undo()?;
                    }
                    0x79 | 0x59 => {
                        e.redo()?;
                    }
                    0xff51 => e.move_caret(Movement::WordLeft, key.shift)?,
                    0xff53 => e.move_caret(Movement::WordRight, key.shift)?,
                    0xff50 => e.move_caret(Movement::LineStart, key.shift)?,
                    0xff57 => e.move_caret(Movement::LineEnd, key.shift)?,
                    0xff08 => {
                        if e.selection().is_empty() {
                            e.move_caret(Movement::WordLeft, true)?;
                        }
                        e.backspace()?;
                    }
                    0xffff => {
                        if e.selection().is_empty() {
                            e.move_caret(Movement::WordRight, true)?;
                        }
                        e.delete()?;
                    }
                    _ => {}
                }
            } else {
                match key.sym {
                    0xff1b if e.preedit().is_some() => e.cancel_preedit()?,
                    0xff1b => e.replace_range(0..e.text().len(), "")?,
                    0xff51 => e.move_caret(Movement::Left, key.shift)?,
                    0xff53 => e.move_caret(Movement::Right, key.shift)?,
                    0xff50 => e.move_caret(Movement::LineStart, key.shift)?,
                    0xff57 => e.move_caret(Movement::LineEnd, key.shift)?,
                    0xff08 => e.backspace()?,
                    0xffff => e.delete()?,
                    _ => {
                        single_line(&key.text)?;
                        e.insert(&key.text)?;
                    }
                }
            }
            Ok(())
        });
    }
    fn request(&self, cx: &mut Input<'_>, request: Request) {
        match request {
            Request::Paste(text) => self.edit(cx, |s| {
                s.editor
                    .as_mut()
                    .unwrap()
                    .paste(&normalize_single_line(&text))
            }),
            Request::SetText(text) | Request::Set(Value::Text(text)) => self.edit(cx, |s| {
                let text = normalize_single_line(&text);
                let e = s.editor.as_mut().unwrap();
                if e.text() == text {
                    return Ok(());
                }
                e.replace_range(0..e.text().len(), &text)
            }),
            Request::SetSelection(range) => self.edit(cx, |s| {
                s.editor.as_mut().unwrap().set_selection(
                    Caret {
                        offset: range.start,
                        affinity: Affinity::Downstream,
                    },
                    Caret {
                        offset: range.end,
                        affinity: Affinity::Upstream,
                    },
                )
            }),
            _ => {}
        }
    }
    fn ime(&self, cx: &mut Input<'_>, batch: &nk_wayland::ImeBatch) {
        self.edit(cx, |s| {
            let commit = batch.commit.as_deref().map(normalize_single_line);
            if let Some((text, _, _)) = &batch.preedit {
                single_line(text)?;
            }
            let e = s.editor.as_mut().unwrap();
            let selected = e.selection();
            let deletion = if let Some((before, after)) = batch.delete {
                let start = selected
                    .start
                    .checked_sub(before as usize)
                    .ok_or("IME delete before document")?;
                let end = selected
                    .end
                    .checked_add(after as usize)
                    .ok_or("IME delete overflow")?;
                if end > e.text().len()
                    || !e.text().is_char_boundary(start)
                    || !e.text().is_char_boundary(end)
                {
                    return Err("IME deletion splits UTF-8 or exceeds document".into());
                }
                Some(start..end)
            } else {
                None
            };
            let was = e.preedit().is_some();
            e.cancel_preedit()?;
            if let Some(text) = commit.as_deref() {
                e.replace_range(deletion.unwrap_or(selected), text)?;
            } else if let Some(range) = deletion {
                let kept = e.selected_text().to_owned();
                let start = range.start;
                e.replace_range(range, &kept)?;
                e.set_selection(
                    Caret {
                        offset: start,
                        affinity: Affinity::Downstream,
                    },
                    Caret {
                        offset: start + kept.len(),
                        affinity: Affinity::Upstream,
                    },
                )?;
            }
            if was && batch.preedit.as_ref().is_none_or(|p| p.0.is_empty()) {
                s.finished_composition = true;
            }
            s.hide_preedit_caret = false;
            if let Some((text, begin, _)) = &batch.preedit
                && !text.is_empty()
            {
                let caret = nk_text::grapheme_boundaries(text)
                    .into_iter()
                    .take_while(|p| *p <= (*begin).max(0) as usize)
                    .last()
                    .unwrap_or(0);
                s.finished_composition = false;
                e.set_preedit(e.selection(), text, caret)?;
                s.hide_preedit_caret = *begin < 0;
            }
            Ok(())
        });
    }
    fn text_input(&self, cx: &Read<'_>) -> Option<nk_wayland::TextInput> {
        let s = cx.state?.downcast_ref::<State>()?;
        let e = s.editor.as_ref()?;
        let xy = self.origin(cx, s);
        let r = e.caret_rect().ok()?;
        Some(nk_wayland::TextInput {
            focused: true,
            password: false,
            text: e.text().into(),
            cursor: e.caret().offset,
            anchor: e.anchor().offset,
            rect: [
                (xy.0 + r.x).floor() as i32,
                (xy.1 + r.y).floor() as i32,
                r.width.ceil().max(1.) as i32,
                r.height.ceil() as i32,
            ],
        })
    }
    fn semantics(&self, cx: &Read<'_>, n: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        let Some(s) = cx.state.and_then(|s| s.downcast_ref::<State>()) else {
            return;
        };
        let Some(e) = &s.editor else { return };
        n.role = nk_a11y::Role::TextInput;
        n.description = normalize_single_line(&self.placeholder).into_owned();
        n.actions = vec![
            nk_a11y::Action::Focus,
            nk_a11y::Action::SetText,
            nk_a11y::Action::SetSelection,
        ];
        let xy = self.origin(cx, s);
        let bounds = |r: nk_text::Rect| nk_a11y::Bounds {
            x: (xy.0 + r.x) as f64,
            y: (xy.1 + r.y) as f64,
            width: r.width as f64,
            height: r.height as f64,
        };
        n.text = Some(nk_a11y::TextInfo {
            text: e.text().into(),
            caret: e.caret().offset,
            anchor: e.anchor().offset,
            words: e
                .text()
                .unicode_word_indices()
                .map(|(i, w)| i..i + w.len())
                .collect(),
            lines: std::iter::once(0..e.text().len()).collect(),
            geometry: e.preedit().is_none().then(|| nk_a11y::TextGeometry {
                spans: e
                    .layout()
                    .cluster_boxes()
                    .iter()
                    .map(|b| nk_a11y::TextSpan {
                        range: b.range.clone(),
                        bounds: bounds(b.bounds),
                        caret: bounds(b.caret),
                    })
                    .collect(),
                end_caret: bounds(
                    e.layout()
                        .caret_rect(e.text().len(), Affinity::Upstream)
                        .expect("document end"),
                ),
            }),
        });
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        let Some(s) = cx.state.and_then(|s| s.downcast_ref::<State>()) else {
            return;
        };
        let Some(e) = &s.editor else { return };
        let t = &cx.look.tokens.entry;
        let focus = cx.read.focused || cx.interaction.focus_ring;
        let color = if cx.interaction.enabled {
            t.text
        } else {
            cx.look.tokens.look.disabled
        };
        if self.chrome {
            chrome(cx);
        }
        let viewport = self.viewport(&cx.read);
        let Some(clip) = intersection(viewport, cx.visible) else {
            return;
        };
        let xy = self.origin(&cx.read, s);
        cx.canvas.clip(rect(&clip));
        if e.display_text().is_empty() {
            if let Some(p) = &s.placeholder {
                let _ = cx
                    .canvas
                    .layout(p, (viewport[0] as f32, xy.1), cx.ink(t.dim));
            }
        } else {
            let _ = cx.canvas.layout(e.layout(), xy, cx.ink(color));
        }
        if focus {
            for r in e.selection_rects().unwrap_or_default() {
                let r = nk_render::offset(r, xy);
                cx.canvas.rect(r, cx.ink(t.selection));
                cx.canvas.clip(r);
                let _ = cx.canvas.layout(e.layout(), xy, cx.ink(t.selection_text));
                cx.canvas.pop_clip();
            }
            if (!s.hide_preedit_caret || e.preedit().is_none())
                && let Ok(r) = e.caret_rect()
            {
                cx.canvas.caret(nk_render::offset(r, xy), cx.ink(color));
            }
        }
        cx.canvas.pop_clip();
    }
}
pub(super) fn chrome(cx: &mut Paint<'_>) {
    let t = &cx.look.tokens.entry;
    let r = cx.rect;
    let radius = t.radius.min(r[3] / 2.);
    cx.canvas
        .rounded_rect(rect(&r), radius, cx.ink(t.background));
    cx.canvas
        .rounded_ring(rect(&r), radius, t.border, cx.ink(t.border_color));
}
fn intersection(a: Rect, b: Rect) -> Option<Rect> {
    let (x, y) = (a[0].max(b[0]), a[1].max(b[1]));
    let (w, h) = (
        (a[0] + a[2]).min(b[0] + b[2]) - x,
        (a[1] + a[3]).min(b[1] + b[3]) - y,
    );
    (w > 0. && h > 0.).then_some([x, y, w, h])
}
