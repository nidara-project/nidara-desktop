// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{
    Affinity, Caret, Layout, Point, Rect, Result, TextBackend, TextStyle, grapheme_boundaries,
    validate_offset, validate_range,
};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Movement {
    Left,
    Right,
    WordLeft,
    WordRight,
    Up,
    Down,
    LineStart,
    LineEnd,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Preedit {
    /// Replacement in the committed buffer; caret is a byte offset in text.
    pub range: Range<usize>,
    pub text: String,
    pub caret: Caret,
}
#[derive(Clone)]
struct State {
    text: String,
    caret: Caret,
    anchor: Caret,
}
/// Backend-independent editing model. Text changes build one new native Layout;
/// reads and drawing share that object. Preedit has its own buffer and byte caret.
pub struct Editor {
    backend: Box<dyn TextBackend>,
    style: TextStyle,
    width: f32,
    state: State,
    layout: Layout,
    undo: Vec<State>,
    redo: Vec<State>,
    preedit: Option<Preedit>,
    preferred_x: Option<f32>,
}
impl Editor {
    pub fn new(
        mut backend: Box<dyn TextBackend>,
        text: &str,
        style: TextStyle,
        max_width: f32,
    ) -> Result<Self> {
        let layout = backend.layout(text, &style, max_width)?;
        let caret = Caret::default();
        Ok(Self {
            backend,
            style,
            width: max_width,
            state: State {
                text: text.into(),
                caret,
                anchor: caret,
            },
            layout,
            undo: Vec::new(),
            redo: Vec::new(),
            preedit: None,
            preferred_x: None,
        })
    }
    pub fn text(&self) -> &str {
        &self.state.text
    }
    pub fn caret(&self) -> Caret {
        self.state.caret
    }
    pub fn anchor(&self) -> Caret {
        self.state.anchor
    }
    pub fn selection(&self) -> Range<usize> {
        self.state.anchor.offset.min(self.state.caret.offset)
            ..self.state.anchor.offset.max(self.state.caret.offset)
    }
    pub fn selected_text(&self) -> &str {
        &self.text()[self.selection()]
    }
    pub fn layout(&self) -> &Layout {
        &self.layout
    }
    pub fn display_text(&self) -> &str {
        self.layout.text()
    }
    pub fn preedit(&self) -> Option<&Preedit> {
        self.preedit.as_ref()
    }
    pub fn display_caret(&self) -> Caret {
        self.preedit.as_ref().map_or(self.caret(), |p| Caret {
            offset: p.range.start + p.caret.offset,
            affinity: p.caret.affinity,
        })
    }
    pub fn caret_rect(&self) -> Result<Rect> {
        let c = self.display_caret();
        self.layout.caret_rect(c.offset, c.affinity)
    }
    pub fn selection_rects(&self) -> Result<Vec<Rect>> {
        if self.preedit.is_some() {
            return Ok(Vec::new());
        }
        self.layout.selection_rects(self.selection())
    }
    pub fn set_caret(&mut self, offset: usize, affinity: Affinity, extend: bool) -> Result<()> {
        valid_grapheme(self.text(), offset)?;
        self.cancel_preedit()?;
        self.state.caret = Caret { offset, affinity };
        if !extend {
            self.state.anchor = self.state.caret;
        }
        self.preferred_x = None;
        Ok(())
    }
    pub fn set_selection(&mut self, anchor: Caret, focus: Caret) -> Result<()> {
        valid_grapheme(self.text(), anchor.offset)?;
        valid_grapheme(self.text(), focus.offset)?;
        self.cancel_preedit()?;
        self.state.anchor = anchor;
        self.state.caret = focus;
        self.preferred_x = None;
        Ok(())
    }
    pub fn select_between(&mut self, anchor: Point, focus: Point) -> Result<()> {
        self.cancel_preedit()?;
        self.set_selection(self.layout.hit_test(anchor)?, self.layout.hit_test(focus)?)
    }
    pub fn select_word_at(&mut self, point: Point) -> Result<()> {
        self.cancel_preedit()?;
        let c = self.layout.hit_test(point)?;
        if let Some((start, word)) = self
            .text()
            .unicode_word_indices()
            .find(|(start, word)| c.offset >= *start && c.offset < *start + word.len())
        {
            self.set_selection(
                Caret {
                    offset: start,
                    affinity: Affinity::Downstream,
                },
                Caret {
                    offset: start + word.len(),
                    affinity: Affinity::Upstream,
                },
            )
        } else {
            self.set_caret(c.offset, c.affinity, false)
        }
    }
    pub fn move_caret(&mut self, movement: Movement, extend: bool) -> Result<()> {
        let current = self.display_caret();
        let next = match movement {
            Movement::Left | Movement::Right | Movement::WordLeft | Movement::WordRight => {
                let right = matches!(movement, Movement::Right | Movement::WordRight);
                let word = matches!(movement, Movement::WordLeft | Movement::WordRight);
                let boundaries = grapheme_boundaries(self.display_text());
                let word_boundaries: Vec<_> = self
                    .display_text()
                    .unicode_word_indices()
                    .flat_map(|(i, word)| [i, i + word.len()])
                    .chain([0, self.display_text().len()])
                    .collect();
                let mut next = current;
                // Movement is supplied by the native engine, never by sorting a
                // home-grown bidi map. Filter only to the editor's grapheme/word policy.
                for _ in 0..self.display_text().len().saturating_mul(2) + 4 {
                    let candidate = self.layout.move_visual(next, right)?;
                    if candidate == next {
                        break;
                    }
                    next = candidate;
                    if boundaries.contains(&next.offset)
                        && (!word || word_boundaries.contains(&next.offset))
                    {
                        break;
                    }
                }
                self.preferred_x = None;
                next
            }
            Movement::Up | Movement::Down => {
                let rect = self.caret_rect()?;
                let x = *self.preferred_x.get_or_insert(rect.x);
                let line = self
                    .layout
                    .lines()
                    .iter()
                    .position(|line| (line.bounds.y - rect.y).abs() < 1.0)
                    .unwrap_or(0);
                let target = if movement == Movement::Up {
                    line.saturating_sub(1)
                } else {
                    (line + 1).min(self.layout.lines().len().saturating_sub(1))
                };
                let y = self
                    .layout
                    .lines()
                    .get(target)
                    .map_or(rect.y, |line| line.bounds.center().y);
                self.layout.hit_test(Point { x, y })?
            }
            Movement::LineStart | Movement::LineEnd => {
                let rect = self.caret_rect()?;
                let line = self
                    .layout
                    .lines()
                    .iter()
                    .find(|line| (line.bounds.y - rect.y).abs() < 1.0);
                self.preferred_x = None;
                Caret {
                    offset: line.map_or(current.offset, |line| {
                        if movement == Movement::LineStart {
                            line.range.start
                        } else {
                            line.range.end
                        }
                    }),
                    affinity: if movement == Movement::LineStart {
                        Affinity::Downstream
                    } else {
                        Affinity::Upstream
                    },
                }
            }
        };
        if let Some(preedit) = &mut self.preedit {
            let offset = next.offset.clamp(
                preedit.range.start,
                preedit.range.start + preedit.text.len(),
            ) - preedit.range.start;
            valid_grapheme(&preedit.text, offset)?;
            preedit.caret = Caret {
                offset,
                affinity: next.affinity,
            };
        } else {
            valid_grapheme(self.text(), next.offset)?;
            self.state.caret = next;
            if !extend {
                self.state.anchor = next;
            }
        }
        Ok(())
    }
    pub fn insert(&mut self, text: &str) -> Result<()> {
        self.replace_range(self.selection(), text)
    }
    pub fn paste(&mut self, text: &str) -> Result<()> {
        self.insert(text)
    }
    pub fn cut(&mut self) -> Result<String> {
        let text = self.selected_text().to_string();
        self.insert("")?;
        Ok(text)
    }
    pub fn replace_range(&mut self, range: Range<usize>, replacement: &str) -> Result<()> {
        validate_range(self.text(), &range)?;
        let mut text = self.text().to_string();
        text.replace_range(range.clone(), replacement);
        let offset = range.start + replacement.len();
        // A replacement may merge with a following combining mark. Keep the caret
        // at the next grapheme boundary rather than splitting that new grapheme.
        let offset = grapheme_boundaries(&text)
            .into_iter()
            .find(|n| *n >= offset)
            .unwrap_or(text.len());
        let caret = Caret {
            offset,
            affinity: Affinity::Upstream,
        };
        let next = State {
            text,
            caret,
            anchor: caret,
        };
        let layout = self.backend.layout(&next.text, &self.style, self.width)?;
        self.undo.push(self.state.clone());
        self.redo.clear();
        self.state = next;
        self.layout = layout;
        self.preedit = None;
        self.preferred_x = None;
        Ok(())
    }
    pub fn backspace(&mut self) -> Result<()> {
        if let Some(mut p) = self.preedit.clone() {
            let offset = p.caret.offset;
            if offset == 0 {
                return Ok(());
            }
            let previous = previous_grapheme(&p.text, offset);
            p.text.replace_range(previous..offset, "");
            return self.set_preedit(p.range, &p.text, previous);
        }
        let range = self.selection();
        if !range.is_empty() {
            return self.replace_range(range, "");
        }
        let offset = self.caret().offset;
        if offset == 0 {
            return Ok(());
        }
        self.replace_range(previous_grapheme(self.text(), offset)..offset, "")
    }
    pub fn delete(&mut self) -> Result<()> {
        if let Some(mut p) = self.preedit.clone() {
            let offset = p.caret.offset;
            if offset == p.text.len() {
                return Ok(());
            }
            let next = grapheme_boundaries(&p.text)
                .into_iter()
                .find(|n| *n > offset)
                .unwrap_or(p.text.len());
            p.text.replace_range(offset..next, "");
            return self.set_preedit(p.range, &p.text, offset);
        }
        let range = self.selection();
        if !range.is_empty() {
            return self.replace_range(range, "");
        }
        let offset = self.caret().offset;
        if offset == self.text().len() {
            return Ok(());
        }
        let next = grapheme_boundaries(self.text())
            .into_iter()
            .find(|n| *n > offset)
            .unwrap_or(self.text().len());
        self.replace_range(offset..next, "")
    }
    pub fn undo(&mut self) -> Result<bool> {
        self.cancel_preedit()?;
        let Some(state) = self.undo.last().cloned() else {
            return Ok(false);
        };
        let layout = self.backend.layout(&state.text, &self.style, self.width)?;
        self.undo.pop();
        self.redo.push(self.state.clone());
        self.state = state;
        self.layout = layout;
        self.preferred_x = None;
        Ok(true)
    }
    pub fn redo(&mut self) -> Result<bool> {
        self.cancel_preedit()?;
        let Some(state) = self.redo.last().cloned() else {
            return Ok(false);
        };
        let layout = self.backend.layout(&state.text, &self.style, self.width)?;
        self.redo.pop();
        self.undo.push(self.state.clone());
        self.state = state;
        self.layout = layout;
        self.preferred_x = None;
        Ok(true)
    }
    pub fn set_preedit(&mut self, range: Range<usize>, text: &str, caret: usize) -> Result<()> {
        validate_range(self.text(), &range)?;
        valid_grapheme(text, caret)?;
        let mut display = self.text().to_string();
        display.replace_range(range.clone(), text);
        let layout = self.backend.layout(&display, &self.style, self.width)?;
        self.preedit = Some(Preedit {
            range,
            text: text.into(),
            caret: Caret {
                offset: caret,
                affinity: Affinity::Downstream,
            },
        });
        self.layout = layout;
        self.preferred_x = None;
        Ok(())
    }
    pub fn cancel_preedit(&mut self) -> Result<()> {
        if self.preedit.is_some() {
            let layout = self
                .backend
                .layout(&self.state.text, &self.style, self.width)?;
            self.layout = layout;
            self.preedit = None;
            self.preferred_x = None;
        }
        Ok(())
    }
    pub fn commit_preedit(&mut self) -> Result<()> {
        if let Some(p) = self.preedit.clone() {
            self.replace_range(p.range, &p.text)?;
        }
        Ok(())
    }
    pub fn set_max_width(&mut self, max_width: f32) -> Result<()> {
        self.layout.size(max_width)?;
        self.width = max_width;
        Ok(())
    }
}
fn valid_grapheme(text: &str, offset: usize) -> Result<()> {
    validate_offset(text, offset)?;
    if !grapheme_boundaries(text).contains(&offset) {
        return Err(format!("caret byte offset {offset} splits a grapheme"));
    }
    Ok(())
}
fn previous_grapheme(text: &str, offset: usize) -> usize {
    text[..offset]
        .grapheme_indices(true)
        .next_back()
        .map_or(0, |(index, _)| index)
}
