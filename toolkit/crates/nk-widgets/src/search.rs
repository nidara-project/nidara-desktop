// SPDX-License-Identifier: LGPL-3.0-or-later
//! One retained text editor shared by Settings search and FontChooser filtering.
use crate::*;
use nk_render::{Canvas, Color, offset};
use nk_text::{Affinity, Caret, Editor, Movement};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug)]
pub struct SearchStyle {
    pub padding_x: f32,
    pub border: f32,
    pub min_height: f32,
    pub radius: f32,
    pub icon_size: f32,
    pub icon_gap: f32,
    pub icon: String,
    pub background: Color,
    pub border_color: Color,
    pub focus_border: Color,
    pub text: Color,
    pub dim: Color,
    pub selection: Color,
    pub selection_text: Color,
}
pub(crate) struct Search {
    pub editor: Editor,
    placeholder: String,
    placeholder_layout: Option<Layout>,
    style: TextStyle,
    scroll: f32,
    hide_preedit_caret: bool,
}
fn single_line(text: &str) -> Result<()> {
    if text
        .chars()
        .any(|c| c.is_control() || matches!(c, '\u{2028}' | '\u{2029}'))
    {
        return Err("SearchInput accepts one line without control characters".into());
    }
    Ok(())
}
impl Tree {
    pub fn set_search_style(&mut self, style: SearchStyle) -> Result<()> {
        if ![
            style.padding_x,
            style.border,
            style.min_height,
            style.radius,
            style.icon_size,
            style.icon_gap,
        ]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.)
            || style.min_height <= 0.
            || style.icon.is_empty()
        {
            return Err("invalid SearchInput style".into());
        }
        self.search_style = Some(style);
        for search in self.searches.values_mut() {
            search.placeholder_layout = None;
        }
        for id in self.searches.keys().copied().collect::<Vec<_>>() {
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub fn search_input(
        &mut self,
        parent: NodeId,
        name: &str,
        placeholder: &str,
        backend: Box<dyn TextBackend>,
    ) -> Result<NodeId> {
        self.search_style
            .as_ref()
            .ok_or("SearchInput style not supplied")?;
        single_line(placeholder)?;
        let mut text_style = self.style.clone();
        text_style.alignment = nk_text::Alignment::Left;
        let editor = Editor::new(backend, "", text_style, f32::MAX)?;
        let id = self.append(parent, Kind::SearchInput, name)?;
        self.searches.insert(
            id,
            Search {
                editor,
                placeholder: placeholder.into(),
                placeholder_layout: None,
                style: self.style.clone(),
                scroll: 0.,
                hide_preedit_caret: false,
            },
        );
        Ok(id)
    }
    pub fn search_text(&self, id: NodeId) -> Result<&str> {
        Ok(self
            .searches
            .get(&id)
            .ok_or("unknown SearchInput")?
            .editor
            .text())
    }
    /// Canonical update; no Changed effect. All validation happens before mutation.
    pub fn set_search_text(&mut self, id: NodeId, text: &str) -> Result<()> {
        single_line(text)?;
        let search = self.searches.get_mut(&id).ok_or("unknown SearchInput")?;
        if search.editor.text() != text {
            search
                .editor
                .replace_range(0..search.editor.text().len(), text)?;
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }
    fn search_authorized(&self, target: Target) -> Result<()> {
        if target.generation != self.generation
            || !self.available(target.id)
            || !self.searches.contains_key(&target.id)
        {
            return Err("stale, hidden, disabled or missing SearchInput".into());
        }
        Ok(())
    }
    pub fn search_request(&mut self, target: Target, request: nk_a11y::Request) -> Result<Effect> {
        self.search_authorized(target)?;
        let id = target.id;
        let before = self.search_text(id)?.to_owned();
        match request {
            nk_a11y::Request::SetText(who, text) if who == id => self.set_search_text(id, &text)?,
            nk_a11y::Request::SetSelection(who, range) if who == id => {
                self.searches.get_mut(&id).unwrap().editor.set_selection(
                    Caret {
                        offset: range.start,
                        affinity: Affinity::Downstream,
                    },
                    Caret {
                        offset: range.end,
                        affinity: Affinity::Upstream,
                    },
                )?;
            }
            _ => return Err("request does not target this SearchInput".into()),
        }
        self.search_changed(id, &before)
    }
    fn search_changed(&mut self, id: NodeId, before: &str) -> Result<Effect> {
        let changed = before != self.search_text(id)?;
        self.invalidate(id, Invalid::LAYOUT);
        Ok(if changed {
            Effect::Changed(id)
        } else {
            Effect::None
        })
    }
    pub(crate) fn search_key(&mut self, key: &nk_wayland::Key) -> Result<Option<Effect>> {
        let Some(id) = self
            .focused
            .filter(|id| self.searches.contains_key(id) && self.available(*id))
        else {
            return Ok(None);
        };
        if key.sym == 0xff09 || key.sym == 0xfe20 {
            return Ok(None);
        }
        let before = self.search_text(id)?.to_owned();
        let editor = &mut self.searches.get_mut(&id).unwrap().editor;
        if key.ctrl {
            match key.sym {
                0x61 | 0x41 => editor.set_selection(
                    Caret::default(),
                    Caret {
                        offset: editor.text().len(),
                        affinity: Affinity::Upstream,
                    },
                )?,
                0x7a | 0x5a if key.shift => {
                    editor.redo()?;
                }
                0x7a | 0x5a => {
                    editor.undo()?;
                }
                0x79 | 0x59 => {
                    editor.redo()?;
                }
                0xff51 => editor.move_caret(Movement::WordLeft, key.shift)?,
                0xff53 => editor.move_caret(Movement::WordRight, key.shift)?,
                0xff50 => editor.move_caret(Movement::LineStart, key.shift)?,
                0xff57 => editor.move_caret(Movement::LineEnd, key.shift)?,
                0xff08 => {
                    if editor.selection().is_empty() {
                        editor.move_caret(Movement::WordLeft, true)?;
                    }
                    editor.backspace()?;
                }
                0xffff => {
                    if editor.selection().is_empty() {
                        editor.move_caret(Movement::WordRight, true)?;
                    }
                    editor.delete()?;
                }
                _ => return Ok(None),
            }
        } else {
            match key.sym {
                0xff0d => return Ok(Some(Effect::Activated(id))),
                0xff1b if editor.preedit().is_some() => editor.cancel_preedit()?,
                0xff1b => editor.replace_range(0..editor.text().len(), "")?,
                0xff51 => editor.move_caret(Movement::Left, key.shift)?,
                0xff53 => editor.move_caret(Movement::Right, key.shift)?,
                0xff50 => editor.move_caret(Movement::LineStart, key.shift)?,
                0xff57 => editor.move_caret(Movement::LineEnd, key.shift)?,
                0xff08 => editor.backspace()?,
                0xffff => editor.delete()?,
                _ if !key.alt && !key.text.is_empty() => {
                    single_line(&key.text)?;
                    editor.insert(&key.text)?;
                }
                _ => return Ok(None),
            }
        }
        Ok(Some(self.search_changed(id, &before)?))
    }
    pub fn search_paste(&mut self, target: Target, text: &str) -> Result<Effect> {
        self.search_authorized(target)?;
        single_line(text)?;
        let before = self.search_text(target.id)?.to_owned();
        self.searches
            .get_mut(&target.id)
            .unwrap()
            .editor
            .paste(text)?;
        self.search_changed(target.id, &before)
    }
    pub(crate) fn search_ime(&mut self, batch: &nk_wayland::ImeBatch) -> Result<Effect> {
        let Some(id) = self
            .focused
            .filter(|id| self.active && self.available(*id) && self.searches.contains_key(id))
        else {
            return Ok(Effect::None);
        };
        if let Some(text) = &batch.commit {
            single_line(text)?;
        }
        if let Some((text, _, _)) = &batch.preedit {
            single_line(text)?;
        }
        let before = self.search_text(id)?.to_owned();
        let search = self.searches.get_mut(&id).unwrap();
        let editor = &mut search.editor;
        let selected = editor.selection();
        let deletion = if let Some((before, after)) = batch.delete {
            let start = selected
                .start
                .checked_sub(before as usize)
                .ok_or("IME delete before document")?;
            let end = selected
                .end
                .checked_add(after as usize)
                .ok_or("IME delete overflow")?;
            if end > editor.text().len()
                || !editor.text().is_char_boundary(start)
                || !editor.text().is_char_boundary(end)
            {
                return Err("IME deletion splits UTF-8 or exceeds document".into());
            }
            Some(start..end)
        } else {
            None
        };
        editor.cancel_preedit()?;
        if let Some(text) = &batch.commit {
            editor.replace_range(deletion.unwrap_or(selected), text)?;
        } else if let Some(range) = deletion {
            let kept = editor.selected_text().to_owned();
            let start = range.start;
            editor.replace_range(range, &kept)?;
            editor.set_selection(
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
        search.hide_preedit_caret = false;
        if let Some((text, begin, _)) = &batch.preedit
            && !text.is_empty()
        {
            let caret = nk_text::grapheme_boundaries(text)
                .into_iter()
                .take_while(|p| *p <= (*begin).max(0) as usize)
                .last()
                .unwrap_or(0);
            editor.set_preedit(editor.selection(), text, caret)?;
            search.hide_preedit_caret = *begin < 0;
        }
        self.search_changed(id, &before)
    }
    pub fn search_text_input(&self) -> nk_wayland::TextInput {
        let Some(id) = self
            .focused
            .filter(|id| self.active && self.available(*id) && self.searches.contains_key(id))
        else {
            return Default::default();
        };
        let editor = &self.searches[&id].editor;
        let origin = self.search_origin(id, self.nodes[&id].bounds);
        let r = editor.caret_rect().expect("retained caret is valid");
        nk_wayland::TextInput {
            focused: true,
            password: false,
            text: editor.text().into(),
            cursor: editor.caret().offset,
            anchor: editor.anchor().offset,
            rect: [
                (origin.x + r.x).floor() as i32,
                (origin.y + r.y).floor() as i32,
                r.width.ceil().max(1.) as i32,
                r.height.ceil().max(1.) as i32,
            ],
        }
    }
    pub(crate) fn search_clipboard(&mut self, cut: bool) -> Result<Option<(String, Effect)>> {
        let Some(id) = self
            .focused
            .filter(|id| self.available(*id) && self.searches.contains_key(id))
        else {
            return Ok(None);
        };
        let before = self.search_text(id)?.to_owned();
        let editor = &mut self.searches.get_mut(&id).unwrap().editor;
        let text = if cut {
            editor.cut()?
        } else {
            editor.selected_text().to_owned()
        };
        Ok(Some((text, self.search_changed(id, &before)?)))
    }
    pub(crate) fn cancel_search_preedit(&mut self, id: NodeId) -> Result<()> {
        if let Some(search) = self.searches.get_mut(&id)
            && search.editor.preedit().is_some()
        {
            search.editor.cancel_preedit()?;
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub(crate) fn search_pointer(&mut self, id: NodeId, point: Point, extend: bool) -> Result<()> {
        if !self.available(id) || !self.searches.contains_key(&id) {
            return Ok(());
        }
        let origin = self.search_origin(id, self.nodes[&id].bounds);
        let editor = &mut self.searches.get_mut(&id).unwrap().editor;
        let caret = editor.layout().hit_test(Point {
            x: point.x - origin.x,
            y: point.y - origin.y,
        })?;
        editor.set_caret(caret.offset, caret.affinity, extend)?;
        self.invalidate(id, Invalid::LAYOUT);
        Ok(())
    }
    pub(crate) fn measure_search(
        &mut self,
        id: NodeId,
        width: f32,
        backend: &mut dyn TextBackend,
    ) -> Result<Size> {
        let style = self
            .search_style
            .as_ref()
            .ok_or("SearchInput style not supplied")?;
        let search = self
            .searches
            .get_mut(&id)
            .ok_or("SearchInput editor missing")?;
        if search.style != self.style {
            let mut text_style = self.style.clone();
            text_style.alignment = nk_text::Alignment::Left;
            search.editor.set_style(text_style)?;
            search.style = self.style.clone();
            search.placeholder_layout = None;
        }
        if search.placeholder_layout.is_none() {
            let mut text_style = self.style.clone();
            text_style.alignment = nk_text::Alignment::Left;
            search.placeholder_layout =
                Some(backend.layout(&search.placeholder, &text_style, f32::MAX)?);
        }
        let height = search.editor.layout().measured_size().height.max(
            search
                .placeholder_layout
                .as_ref()
                .unwrap()
                .measured_size()
                .height,
        );
        let visible =
            (width - 2. * (style.padding_x + style.border) - style.icon_size - style.icon_gap)
                .max(1.);
        let caret = search.editor.caret_rect()?;
        if caret.x < search.scroll {
            search.scroll = caret.x;
        }
        if caret.x + caret.width > search.scroll + visible {
            search.scroll = caret.x + caret.width - visible;
        }
        search.scroll = search.scroll.max(0.);
        let size = Size {
            width,
            height: style.min_height.max(height + 2. * style.border),
        };
        self.nodes.get_mut(&id).unwrap().measured = size;
        Ok(size)
    }
    fn search_origin(&self, id: NodeId, r: Rect) -> Point {
        let s = self.search_style.as_ref().unwrap();
        let search = &self.searches[&id];
        Point {
            x: r.x + s.border + s.padding_x + s.icon_size + s.icon_gap - search.scroll,
            y: r.y + (r.height - search.editor.layout().measured_size().height) / 2.,
        }
    }
    pub(crate) fn paint_search(
        &self,
        id: NodeId,
        r: Rect,
        canvas: &mut Canvas,
        disabled: Color,
    ) -> Result<()> {
        let s = self
            .search_style
            .as_ref()
            .ok_or("SearchInput style not supplied")?;
        let search = &self.searches[&id];
        let focused = self.focused == Some(id) && self.active;
        let radius = s.radius.min(r.height / 2.);
        canvas.rounded_rect(r, radius as f64, s.background);
        canvas.rounded_ring(
            r,
            radius as f64,
            s.border as f64,
            if focused {
                s.focus_border
            } else {
                s.border_color
            },
        );
        let icon = self.icon(&s.icon, s.icon_size)?;
        canvas.icon(
            &icon,
            Rect {
                x: r.x + s.border + s.padding_x,
                y: r.y + (r.height - s.icon_size) / 2.,
                width: s.icon_size,
                height: s.icon_size,
            },
            if self.available(id) { s.dim } else { disabled },
        );
        let clip = Rect {
            x: r.x + s.border + s.padding_x + s.icon_size + s.icon_gap,
            y: r.y + s.border,
            width: (r.width - 2. * (s.border + s.padding_x) - s.icon_size - s.icon_gap).max(0.),
            height: (r.height - 2. * s.border).max(0.),
        };
        canvas.clip(clip);
        let origin = self.search_origin(id, r);
        let xy = (origin.x, origin.y);
        let ink = if self.available(id) { s.text } else { disabled };
        if search.editor.display_text().is_empty() {
            if let Some(layout) = &search.placeholder_layout {
                canvas.layout(
                    layout,
                    (
                        clip.x,
                        r.y + (r.height - layout.measured_size().height) / 2.,
                    ),
                    s.dim,
                )?;
            }
        } else {
            canvas.layout(search.editor.layout(), xy, ink)?;
        }
        if focused {
            for rect in search.editor.selection_rects()? {
                let rect = offset(rect, xy);
                canvas.rect(rect, s.selection);
                canvas.clip(rect);
                canvas.layout(search.editor.layout(), xy, s.selection_text)?;
                canvas.pop_clip();
            }
            if !search.hide_preedit_caret || search.editor.preedit().is_none() {
                canvas.caret(offset(search.editor.caret_rect()?, xy), ink);
            }
        }
        canvas.pop_clip();
        Ok(())
    }
    pub(crate) fn search_semantics(&self, id: NodeId, node: &mut nk_a11y::Node) {
        use nk_a11y::{Action, Bounds, TextGeometry, TextInfo, TextSpan};
        let search = &self.searches[&id];
        let editor = &search.editor;
        node.actions = vec![Action::Focus, Action::SetText, Action::SetSelection];
        node.description = search.placeholder.clone();
        let origin = self.search_origin(id, self.nodes[&id].bounds);
        let bounds = |r: Rect| {
            let r = offset(r, (origin.x, origin.y));
            Bounds {
                x: r.x as f64,
                y: r.y as f64,
                width: r.width as f64,
                height: r.height as f64,
            }
        };
        node.text = Some(TextInfo {
            text: editor.text().into(),
            caret: editor.caret().offset,
            anchor: editor.anchor().offset,
            words: editor
                .text()
                .unicode_word_indices()
                .map(|(i, w)| i..i + w.len())
                .collect(),
            // Search is a single committed line; preedit has a separate display buffer.
            lines: std::iter::once(0..editor.text().len()).collect(),
            geometry: editor.preedit().is_none().then(|| TextGeometry {
                spans: editor
                    .layout()
                    .cluster_boxes()
                    .iter()
                    .map(|b| TextSpan {
                        range: b.range.clone(),
                        bounds: bounds(b.bounds),
                        caret: bounds(b.caret),
                    })
                    .collect(),
                end_caret: bounds(
                    editor
                        .layout()
                        .caret_rect(editor.text().len(), Affinity::Upstream)
                        .expect("valid document end"),
                ),
            }),
        });
    }
}
