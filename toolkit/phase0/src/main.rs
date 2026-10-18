// SPDX-License-Identifier: LGPL-3.0-or-later
//! Phase 0's retained tree: root -> field + corpus labels. IDs are allocated once,
//! measure and place are separate, focus and pointer capture name one node.
mod form;
mod material;
mod motion;
mod palette;
use nk_render::{Canvas, offset};
use nk_text::{
    Affinity, Caret, Editor, FontSet, Layout, Movement, ParleyBackend, Point, Rect, Size,
    TextBackend, TextStyle, corpus, grapheme_boundaries,
};
use nk_wayland::{Application, Event, Frame, ImeBatch, Key, Material, TextInput, Window};
use std::{io::Write, sync::Arc, time::Instant};
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
    ime_evidence: bool,
    evidence_file: Option<std::fs::File>,
    fault_file: Option<String>,
    barrier_file: Option<String>,
    barrier: String,
    faults: Vec<String>,
    repeat_count: usize,
    key_count: usize,
    ime_count: usize,
    focus_count: usize,
    paste_count: usize,
    wrong_ime_cursor: bool,
    evidence_start: Instant,
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
            ime_evidence: args.iter().any(|s| s == "--ime-evidence"),
            evidence_file: std::env::var("NK_IME_STATE_LOG")
                .ok()
                .map(|p| {
                    std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(p)
                })
                .transpose()
                .map_err(|e| e.to_string())?,
            fault_file: std::env::var("NK_IME_FAULT_FILE").ok(),
            barrier_file: std::env::var("NK_IME_BARRIER_FILE").ok(),
            barrier: String::new(),
            faults: vec![],
            repeat_count: 0,
            key_count: 0,
            ime_count: 0,
            focus_count: 0,
            paste_count: 0,
            wrong_ime_cursor: args.iter().any(|s| s == "--control-ime-cursor"),
            evidence_start: Instant::now(),
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
        if let Some(name) = self.initial_case.as_ref()
            && let Some(l) = self.labels.iter().find(|l| l.name == *name)
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
    fn fault(&self) -> String {
        self.fault_file
            .as_ref()
            .and_then(|p| std::fs::read_to_string(p).ok())
            .unwrap_or_default()
            .trim()
            .into()
    }
    fn applied(&mut self, fault: &str) {
        if !self.faults.iter().any(|s| s == fault) {
            self.faults.push(fault.into());
        }
    }
    fn sync(&mut self, w: &mut Window) -> Result<()> {
        self.layout()?;
        self.caret_visible()?;
        let r = offset(self.field.editor.caret_rect()?, self.text_origin());
        // Cursor rectangle is in logical surface coordinates, after both scrolls.
        // The compositor handles fractional scale; do not multiply it here.
        let fault = self.fault();
        if matches!(
            fault.as_str(),
            "surrounding" | "field-cursor" | "document-cursor"
        ) {
            self.applied(&fault);
        }
        w.set_text_input(TextInput {
            focused: self.active && self.focused == Some(FIELD),
            password: false,
            text: self.field.editor.text().into(),
            cursor: if fault == "surrounding" {
                0
            } else {
                self.field.editor.caret().offset
            },
            anchor: if fault == "surrounding" {
                0
            } else {
                self.field.editor.anchor().offset
            },
            rect: [
                r.x.floor() as i32 + if self.wrong_ime_cursor { 80 } else { 0 },
                (r.y + if fault == "field-cursor" {
                    self.field.scroll
                } else if fault == "document-cursor" {
                    self.scroll
                } else {
                    0.
                })
                .floor() as i32,
                r.width.ceil().max(1.) as i32,
                r.height.ceil() as i32,
            ],
        });
        if self.ime_evidence {
            let e = &self.field.editor;
            let underlines = if let Some(p) = e.preedit() {
                e.layout()
                    .selection_rects(p.range.start..p.range.start + p.text.len())?
                    .into_iter()
                    .map(|r| {
                        let r = offset(r, self.text_origin());
                        [r.x, r.y + r.height - 2., r.width, 1.]
                    })
                    .collect::<Vec<_>>()
            } else {
                vec![]
            };
            let record = serde_json::json!({
                "ms": self.evidence_start.elapsed().as_secs_f64() * 1000.,
                "text": e.text(), "display": e.display_text(),
                "cursor": e.caret().offset, "anchor": e.anchor().offset,
                "preedit": e.preedit().map(|p| &p.text),
                "active": self.active, "focused": self.focused == Some(FIELD),
                "rect": [r.x, r.y, r.width, r.height], "underlines": underlines,
                "faults": self.faults, "key_count": self.key_count,
                "ime_count": self.ime_count, "focus_count": self.focus_count,
                "paste_count": self.paste_count,
                "barrier": self.barrier,
                "field_scroll": self.field.scroll, "document_scroll": self.scroll,
            });
            let line = format!("IME_STATE {record}\n");
            if let Some(file) = &mut self.evidence_file {
                file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            } else {
                eprint!("{line}");
            }
        }
        if self.invalid.paint {
            w.redraw();
            self.invalid.paint = false;
        }
        // Phase 0 has no a11y adapter yet; preserve the distinct invalidation.
        self.invalid.semantics = false;
        Ok(())
    }
    fn key(&mut self, mut k: Key, w: &mut Window) -> Result<()> {
        if self.ime_evidence {
            eprintln!("IME_KEY {k:?}");
        }
        let fault = self.fault();
        if (fault == "undo" && k.ctrl && k.sym == 0x7a)
            || (fault == "backspace-repeat" && k.sym == 0xff08)
            || (fault == "cancel" && k.sym == 0xff1b)
        {
            self.applied(&fault);
            return Ok(());
        }
        if fault == "compose" && k.text == "é" {
            self.applied(&fault);
            k.text = "e".into();
        }
        if k.text == "a" {
            if fault == "repeat-delay" {
                self.applied(&fault);
                k.text = "aa".into();
            }
            if fault == "repeat-rate" {
                self.repeat_count += 1;
                if self.repeat_count > 2 && !(self.repeat_count - 2).is_multiple_of(4) {
                    self.applied(&fault);
                    return Ok(());
                }
            }
        }
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
        let fault = self.fault();
        if fault == "preedit-update"
            || fault == "cancel"
            || (fault == "drop-commit" && b.commit.is_some())
        {
            self.applied(&fault);
            return Ok(());
        }
        if b.commit.is_some() && matches!(fault.as_str(), "append-commit" | "keep-selection") {
            self.applied(&fault);
        }
        if !self.active || self.focused != Some(FIELD) {
            return Ok(());
        }
        if self.no_preedit
            && b.preedit
                .as_ref()
                .is_some_and(|(text, _, _)| !text.is_empty())
        {
            self.applied("no-preedit");
        }
        let e = &mut self.field.editor;
        // done order: remove old preedit, delete around selection, commit, then
        // display the new preedit. A preedit never enters the committed buffer.
        e.cancel_preedit()?;
        let selected = if fault == "append-commit" {
            e.text().len()..e.text().len()
        } else if fault == "keep-selection" {
            e.caret().offset..e.caret().offset
        } else {
            e.selection()
        };
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
    fn poll_interval_ms(&self) -> u32 {
        if self.fault_file.is_some() { 50 } else { 1000 }
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        let fault = self.fault();
        let mutated = fault == "repeat-release" || (fault == "repeat-focus-loss" && !self.active);
        if mutated {
            self.applied(&fault);
            self.field.editor.insert("a")?;
            self.invalid.paint = true;
        }
        // An evidence-only nonce acknowledges that the preceding event queue
        // has reached the app. It never injects an event or changes Editor.
        let barrier = self
            .barrier_file
            .as_ref()
            .and_then(|path| std::fs::read_to_string(path).ok())
            .unwrap_or_default();
        let requested = barrier != self.barrier;
        if requested {
            self.barrier = barrier;
        }
        if mutated || requested {
            self.sync(w)?;
        }
        Ok(())
    }

    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        // Hyalo can constrain a floating window after its first buffer maps.
        // Keep --case anchored through that resize; user input takes ownership
        // of scrolling/focus and ends the initial anchor.
        if matches!(
            &event,
            Event::Scroll(_) | Event::Key(_) | Event::Button { .. }
        ) {
            self.initial_case = None;
        }
        match event {
            Event::Configure => {
                let (width, height) = w.size();
                self.width = width as f32;
                self.height = height as f32;
                self.invalid.layout = true;
            }
            Event::Focus(active) => {
                self.focus_count += 1;
                let fault = self.fault();
                if (!active && fault == "focus-loss") || (active && fault == "focus-return") {
                    self.applied(&fault);
                    if active {
                        self.active = false;
                    }
                    return self.sync(w);
                }
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
            Event::Key(k) => {
                self.key_count += 1;
                self.key(k, w)?;
            }
            Event::Ime(b) => {
                self.ime_count += 1;
                self.ime(b)?;
            }
            Event::Paste(text) if self.focused == Some(FIELD) => {
                self.paste_count += 1;
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
    fn material(&self) -> Option<Material> {
        Some(material::panel(self.width, self.height))
    }
}
fn contains(r: Rect, p: Point) -> bool {
    p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height
}
fn options(material: bool, map: bool) -> nk_wayland::Options {
    nk_wayland::Options {
        material,
        map,
        app_id: "nk-phase0",
        title: "Nidara toolkit — phase 0",
        size: (960, 720),
        require_material: Some("nk-phase0 needs Hyalo (nidara-material-v1)"),
    }
}
fn main() {
    let start = Instant::now();
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.iter().any(|s| s == "--test5") {
        let result = motion::MotionApp::new(&args)
            .and_then(|app| nk_wayland::run(app, options(true, true), start));
        if let Err(e) = result {
            eprintln!("nk-phase0: {e}");
            std::process::exit(1);
        }
        return;
    }
    let backend = args
        .windows(2)
        .find(|a| a[0] == "--a11y")
        .map(|a| a[1].as_str());
    if let Some(backend) = backend {
        let result = form::Form::new(&args, backend)
            .and_then(|app| nk_wayland::run(app, options(true, true), start));
        if let Err(e) = result {
            eprintln!("nk-phase0: {e}");
            std::process::exit(1);
        }
        return;
    }
    let result = App::new(&args).and_then(|app| {
        nk_wayland::run(
            app,
            options(
                !args.iter().any(|s| s == "--control-no-material"),
                !args.iter().any(|s| s == "--control-unmapped"),
            ),
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
    fn last_case_survives_the_post_map_viewport_constraint() {
        let mut app = App::new(&["--case".into(), "zwj-rainbow".into()]).unwrap();
        app.paint(Frame {
            width: 960,
            height: 720,
            pixel_width: 960,
            pixel_height: 720,
            scale: 1.,
            material: true,
        })
        .unwrap();
        app.height = 400.;
        app.invalid.layout = true;
        app.layout().unwrap();
        let last = app.labels.last().unwrap();
        assert_eq!(last.name, "zwj-rainbow");
        assert!(
            last.bounds.y - app.scroll + last.measured.height <= app.height - 16.,
            "last case clipped after initial resize"
        );
    }
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
