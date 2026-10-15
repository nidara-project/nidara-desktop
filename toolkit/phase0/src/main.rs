// SPDX-License-Identifier: LGPL-3.0-or-later
//! Phase 0's retained tree: root -> field + corpus labels. IDs are allocated once,
//! measure and place are separate, focus and pointer capture name one node.
mod palette;
use nk_render::{Canvas, offset};
use nk_text::{
    Affinity, Caret, Editor, FontSet, Layout, Movement, ParleyBackend, Point, Rect, Size,
    TextBackend, TextStyle, corpus, grapheme_boundaries,
};
use nk_wayland::{Application, Event, Frame, ImeBatch, Key, Pane, TextInput, Window};
use std::{sync::Arc, time::Instant};
type Result<T> = std::result::Result<T, String>;
type NodeId = u64;
const FIELD: NodeId = 1;
#[derive(Default)]
struct Invalid {
    layout: bool,
    paint: bool,
    semantics: bool,
}
struct Label {
    id: NodeId,
    name: String,
    title: Layout,
    body: Layout,
    measured: Size,
    bounds: Rect,
    width: f32,
}
struct Field {
    id: NodeId,
    editor: Editor,
    bounds: Rect,
    scroll: f32,
    hide_preedit_caret: bool,
}
struct App {
    palette: palette::Palette,
    labels: Vec<Label>,
    heading: Layout,
    hint: Layout,
    field: Field,
    width: f32,
    height: f32,
    content_height: f32,
    heading_height: f32,
    hint_height: f32,
    scroll: f32,
    focused: Option<NodeId>,
    active: bool,
    capture: Option<NodeId>,
    pointer: Point,
    invalid: Invalid,
    no_keyboard: bool,
    no_preedit: bool,
    initial_case: Option<String>,
}
impl App {
    fn new(args: &[String]) -> Result<Self> {
        let fonts = Arc::new(FontSet::discover_required()?);
        let mut backend = ParleyBackend::new(fonts.clone())?;
        let heading = backend.layout(
            "Nidara · toolkit phase 0",
            &TextStyle {
                size: 24.,
                ..Default::default()
            },
            900.,
        )?;
        let hint = backend.layout(
            "Text / IME / Hyalo glass · Scroll for the corpus · Tab changes field focus",
            &TextStyle {
                size: 14.,
                ..Default::default()
            },
            900.,
        )?;
        let editor = Editor::new(
            Box::new(ParleyBackend::new(fonts.clone())?),
            "",
            TextStyle {
                size: 24.,
                ..Default::default()
            },
            860.,
        )?;
        let mut labels = Vec::new();
        for (i, case) in corpus::cases()?.into_iter().enumerate() {
            let title = backend.layout(
                &case.id,
                &TextStyle {
                    size: 14.,
                    ..Default::default()
                },
                900.,
            )?;
            let body = backend.layout(&case.text, &corpus::style(&case, &fonts), case.widths[0])?;
            labels.push(Label {
                id: 10 + i as u64,
                name: case.id,
                title,
                body,
                measured: Size::default(),
                bounds: Rect::default(),
                width: case.widths[0],
            });
        }
        Ok(Self {
            palette: palette::Palette::startup()?,
            labels,
            heading,
            hint,
            field: Field {
                id: FIELD,
                editor,
                bounds: Rect::default(),
                scroll: 0.,
                hide_preedit_caret: false,
            },
            width: 960.,
            height: 720.,
            content_height: 0.,
            heading_height: 36.,
            hint_height: 21.,
            scroll: 0.,
            focused: Some(FIELD),
            active: false,
            capture: None,
            pointer: Point::default(),
            invalid: Invalid {
                layout: true,
                paint: true,
                semantics: true,
            },
            no_keyboard: args.iter().any(|s| s == "--control-no-keyboard"),
            no_preedit: args.iter().any(|s| s == "--control-no-preedit"),
            initial_case: args
                .windows(2)
                .find(|a| a[0] == "--case")
                .map(|a| a[1].clone()),
        })
    }
    fn measure(&mut self) -> Result<()> {
        let available = (self.width - 88.).max(100.);
        self.heading_height = self.heading.size(available)?.height;
        self.hint_height = self.hint.size(available)?.height;
        self.field.editor.set_max_width(available)?;
        for label in &mut self.labels {
            let body = label.body.size(label.width.min(available))?;
            let title = label.title.size(available)?;
            label.measured = Size {
                width: available,
                height: body.height + title.height + 24.,
            };
        }
        Ok(())
    }
    fn place(&mut self) {
        self.field.bounds = Rect {
            x: 32.,
            y: 24. + self.heading_height + 2. + self.hint_height + 11.,
            width: (self.width - 64.).max(100.),
            height: 120.,
        };
        let mut y = self.field.bounds.y + self.field.bounds.height + 28.;
        for label in &mut self.labels {
            label.bounds = Rect {
                x: 44.,
                y,
                width: label.measured.width,
                height: label.measured.height,
            };
            y += label.measured.height;
        }
        self.content_height = y + 32.;
        if let Some(name) = self.initial_case.take()
            && let Some(l) = self.labels.iter().find(|l| l.name == name)
        {
            self.scroll = l.bounds.y - 36.;
        }
        self.scroll = self
            .scroll
            .clamp(0., (self.content_height - self.height).max(0.));
    }
    fn layout(&mut self) -> Result<()> {
        if self.invalid.layout {
            self.measure()?;
            self.place();
            self.invalid.layout = false;
        }
        Ok(())
    }
    fn field_bounds(&self) -> Rect {
        offset(self.field.bounds, (0., -self.scroll))
    }
    fn text_origin(&self) -> (f32, f32) {
        let r = self.field_bounds();
        (r.x + 12., r.y + 12. - self.field.scroll)
    }
    fn local(&self, p: Point) -> Point {
        let (x, y) = self.text_origin();
        Point {
            x: p.x - x,
            y: p.y - y,
        }
    }
    fn caret_visible(&mut self) -> Result<()> {
        let r = self.field.editor.caret_rect()?;
        let available = self.field.bounds.height - 24.;
        if r.y < self.field.scroll {
            self.field.scroll = r.y;
        }
        if r.y + r.height > self.field.scroll + available {
            self.field.scroll = (r.y + r.height - available).max(0.);
        }
        Ok(())
    }
    fn sync(&mut self, w: &mut Window) -> Result<()> {
        self.layout()?;
        self.caret_visible()?;
        let r = offset(self.field.editor.caret_rect()?, self.text_origin());
        // Cursor rectangle is in logical surface coordinates, after both scrolls.
        // The compositor handles fractional scale; do not multiply it here.
        w.set_text_input(TextInput {
            focused: self.active && self.focused == Some(FIELD),
            password: false,
            text: self.field.editor.text().into(),
            cursor: self.field.editor.caret().offset,
            anchor: self.field.editor.anchor().offset,
            rect: [
                r.x.floor() as i32,
                r.y.floor() as i32,
                r.width.ceil().max(1.) as i32,
                r.height.ceil() as i32,
            ],
        });
        if self.invalid.paint {
            w.redraw();
            self.invalid.paint = false;
        }
        // Phase 0 has no a11y adapter yet; preserve the distinct invalidation.
        self.invalid.semantics = false;
        Ok(())
    }
    fn key(&mut self, k: Key, w: &mut Window) -> Result<()> {
        if k.sym == 0xff09 || k.sym == 0xfe20 {
            // Tab / ISO_Left_Tab
            self.field.editor.cancel_preedit()?;
            self.focused = if self.focused.is_some() {
                None
            } else {
                Some(self.field.id)
            };
            self.capture = None;
            return Ok(());
        }
        if self.focused != Some(FIELD) || self.no_keyboard {
            return Ok(());
        }
        let e = &mut self.field.editor;
        if k.ctrl {
            match k.sym {
                0x61 | 0x41 => {
                    let end = e.text().len();
                    e.set_selection(
                        Caret::default(),
                        Caret {
                            offset: end,
                            affinity: Affinity::Upstream,
                        },
                    )?;
                }
                0x63 | 0x43 => w.copy(e.selected_text().into()),
                0x78 | 0x58 => {
                    w.copy(e.cut()?);
                }
                0x76 | 0x56 => w.paste()?,
                0x7a | 0x5a => {
                    if k.shift {
                        e.redo()?;
                    } else {
                        e.undo()?;
                    }
                }
                0x79 | 0x59 => {
                    e.redo()?;
                }
                0xff51 => e.move_caret(Movement::WordLeft, k.shift)?,
                0xff53 => e.move_caret(Movement::WordRight, k.shift)?,
                _ => {}
            }
        } else {
            match k.sym {
                0xff51 => e.move_caret(Movement::Left, k.shift)?,
                0xff53 => e.move_caret(Movement::Right, k.shift)?,
                0xff52 => e.move_caret(Movement::Up, k.shift)?,
                0xff54 => e.move_caret(Movement::Down, k.shift)?,
                0xff50 => e.move_caret(Movement::LineStart, k.shift)?,
                0xff57 => e.move_caret(Movement::LineEnd, k.shift)?,
                0xff08 => e.backspace()?,
                0xffff => e.delete()?,
                0xff1b => e.cancel_preedit()?,
                0xff0d => e.insert("\n")?,
                _ if !k.alt && !k.text.is_empty() && !k.text.chars().any(char::is_control) => {
                    e.insert(&k.text)?
                }
                _ => {}
            }
        }
        if e.preedit().is_none() {
            self.field.hide_preedit_caret = false;
        }
        Ok(())
    }
    fn ime(&mut self, b: ImeBatch) -> Result<()> {
        if !self.active || self.focused != Some(FIELD) {
            return Ok(());
        }
        let e = &mut self.field.editor;
        // done order: remove old preedit, delete around selection, commit, then
        // display the new preedit. A preedit never enters the committed buffer.
        e.cancel_preedit()?;
        let selected = e.selection();
        let deletion = b.delete.and_then(|(before, after)| {
            let start = selected.start.checked_sub(before as usize)?;
            let end = selected.end.checked_add(after as usize)?;
            (end <= e.text().len()
                && e.text().is_char_boundary(start)
                && e.text().is_char_boundary(end))
            .then_some(start..end)
        });
        if let Some(text) = b.commit {
            // One done is one undoable edit, even when it deletes surrounding
            // bytes and replaces a selection at the same time.
            e.replace_range(deletion.unwrap_or(selected), &text)?;
        } else if let Some(range) = deletion {
            let kept = e.selected_text().to_string();
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
        self.field.hide_preedit_caret = false;
        if !self.no_preedit
            && let Some((text, begin, _end)) = b.preedit
            && !text.is_empty()
        {
            // Editor's caret policy is graphemes; preedit cursor byte positions
            // are clamped to that policy without changing the IME's text.
            let caret = grapheme_boundaries(&text)
                .into_iter()
                .take_while(|p| *p <= begin.max(0) as usize)
                .last()
                .unwrap_or(0);
            self.field.hide_preedit_caret = begin < 0;
            e.set_preedit(e.selection(), &text, caret)?;
        }
        Ok(())
    }
}
impl Application for App {
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        match event {
            Event::Configure => {
                let (width, height) = w.size();
                self.width = width as f32;
                self.height = height as f32;
                self.invalid.layout = true;
            }
            Event::Focus(active) => {
                self.active = active;
                if !active {
                    self.field.editor.cancel_preedit()?;
                    self.field.hide_preedit_caret = false;
                    self.capture = None;
                }
            }
            Event::Motion(x, y) => {
                self.pointer = Point {
                    x: x as f32,
                    y: y as f32,
                };
                if self.capture == Some(FIELD) {
                    let c = self
                        .field
                        .editor
                        .layout()
                        .hit_test(self.local(self.pointer))?;
                    self.field.editor.set_caret(c.offset, c.affinity, true)?;
                } else {
                    return Ok(());
                }
            }
            Event::Button {
                button: 0x110,
                pressed,
            } => {
                if pressed {
                    self.field.editor.cancel_preedit()?;
                    self.field.hide_preedit_caret = false;
                    w.reset_ime();
                    if contains(self.field_bounds(), self.pointer) {
                        self.focused = Some(FIELD);
                        self.capture = Some(FIELD);
                        let c = self
                            .field
                            .editor
                            .layout()
                            .hit_test(self.local(self.pointer))?;
                        self.field.editor.set_caret(c.offset, c.affinity, false)?;
                    } else {
                        self.focused = None;
                        self.capture = None;
                    }
                } else {
                    self.capture = None;
                }
            }
            Event::Scroll(delta) => {
                self.scroll = (self.scroll + delta as f32 * 3.)
                    .clamp(0., (self.content_height - self.height).max(0.));
            }
            Event::Key(k) => self.key(k, w)?,
            Event::Ime(b) => self.ime(b)?,
            Event::Paste(text) if self.focused == Some(FIELD) => {
                self.field.editor.paste(&text)?;
            }
            _ => return Ok(()),
        }
        self.invalid.paint = true;
        self.invalid.semantics = true;
        self.sync(w)
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        self.layout()?;
        let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
        let ink = self.palette.ink;
        let muted = self.palette.secondary;
        c.clip(Rect {
            x: 24.,
            y: 16.,
            width: self.width - 48.,
            height: self.height - 32.,
        });
        c.layout(&self.heading, (44., 24. - self.scroll), ink)?;
        c.layout(
            &self.hint,
            (44., 24. + self.heading_height + 2. - self.scroll),
            muted,
        )?;
        let field = self.field_bounds();
        c.rounded_rect(field, 12., self.palette.field);
        c.clip(field);
        let origin = self.text_origin();
        c.selection(
            &self.field.editor.selection_rects()?,
            origin,
            self.palette.selection,
        );
        c.layout(self.field.editor.layout(), origin, ink)?;
        if let Some(p) = self.field.editor.preedit() {
            for r in self
                .field
                .editor
                .layout()
                .selection_rects(p.range.start..p.range.start + p.text.len())?
            {
                c.rect(
                    offset(
                        Rect {
                            y: r.y + r.height - 2.,
                            height: 1.,
                            ..r
                        },
                        origin,
                    ),
                    ink,
                );
            }
        }
        if self.active && self.focused == Some(FIELD) && !self.field.hide_preedit_caret {
            c.caret(offset(self.field.editor.caret_rect()?, origin), ink);
        }
        c.pop_clip();
        for label in &self.labels {
            let r = offset(label.bounds, (0., -self.scroll));
            if r.y + r.height < 0. || r.y > self.height {
                continue;
            }
            debug_assert!(label.id >= 10);
            c.layout(&label.title, (r.x, r.y), muted)?;
            c.layout(&label.body, (r.x, r.y + 28.), ink)?;
        }
        c.pop_clip();
        Ok(c.finish())
    }
    fn panes(&self) -> Vec<Pane> {
        vec![Pane {
            x: 16.,
            y: 8.,
            width: (self.width - 32.) as f64,
            height: (self.height - 16.) as f64,
            radius: 24.,
        }]
    }
}
fn contains(r: Rect, p: Point) -> bool {
    p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
}
fn main() {
    let start = Instant::now();
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result = App::new(&args).and_then(|app| {
        nk_wayland::run(
            app,
            nk_wayland::Options {
                material: !args.iter().any(|s| s == "--control-no-material"),
                map: !args.iter().any(|s| s == "--control-unmapped"),
            },
            start,
        )
    });
    if let Err(e) = result {
        eprintln!("nk-phase0: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ime_replacement_is_atomic_and_cancel_leaves_no_undo() {
        let mut app = App::new(&[]).unwrap();
        app.active = true;
        app.field.editor.insert("ab語cd").unwrap();
        app.field
            .editor
            .set_selection(
                Caret {
                    offset: 2,
                    affinity: Affinity::Downstream,
                },
                Caret {
                    offset: 5,
                    affinity: Affinity::Upstream,
                },
            )
            .unwrap();
        app.ime(ImeBatch {
            preedit: Some(("日本".into(), 6, 6)),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(app.field.editor.text(), "ab語cd");
        assert_eq!(app.field.editor.display_text(), "ab日本cd");
        app.ime(ImeBatch::default()).unwrap();
        assert_eq!(app.field.editor.display_text(), "ab語cd");
        app.ime(ImeBatch {
            delete: Some((1, 1)),
            commit: Some("日".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(app.field.editor.text(), "a日d");
        app.field.editor.undo().unwrap();
        assert_eq!(app.field.editor.text(), "ab語cd");
        app.active = false;
        app.ime(ImeBatch {
            commit: Some("late".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(app.field.editor.text(), "ab語cd");
    }
}
