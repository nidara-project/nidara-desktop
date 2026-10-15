// SPDX-License-Identifier: LGPL-3.0-or-later
//! The test-3 form, deliberately concrete rather than a widget library.
use crate::{Invalid, Result, material, palette};
use nk_a11y::{
    A11yBackend, Action, Bounds, Callback, Node, NodeId, Request, Role, States, TextInfo, Tree,
};
use nk_render::{Canvas, offset};
use nk_text::{
    Affinity, Caret, Editor, FontSet, Layout, Movement, ParleyBackend, Point, Rect, TextBackend,
    TextStyle, grapheme_boundaries,
};
use nk_wayland::{Application, Event, Frame, ImeBatch, Key, Material, TextInput, Window};
use std::{
    collections::BTreeMap,
    sync::{Arc, mpsc},
    time::Instant,
};
use unicode_segmentation::UnicodeSegmentation;
const ROOT: NodeId = 1;
const NAME: NodeId = 2;
const PASSWORD: NodeId = 3;
const DROPDOWN: NodeId = 4;
const CHECK: NodeId = 5;
const OPEN: NodeId = 6;
const DIALOG: NodeId = 7;
const ERROR: NodeId = 8;
const CLOSE: NodeId = 9;
const ITEM: NodeId = 20;
const OPTIONS: [&str; 3] = ["Japanese", "Chinese", "Korean"];
struct Field {
    editor: Editor,
    bounds: Rect,
    password: bool,
    mask: Layout,
    hide_preedit_caret: bool,
}
struct Control {
    id: NodeId,
    role: Role,
    name: String,
    bounds: Rect,
    label: Layout,
}
pub struct Form {
    fields: BTreeMap<NodeId, Field>,
    labels: Vec<crate::Label>,
    corpus_scroll: f32,
    controls: BTreeMap<NodeId, Control>,
    backend: Option<Box<dyn A11yBackend>>,
    requests: mpsc::Receiver<Request>,
    fonts: Arc<FontSet>,
    palette: palette::Palette,
    focused: NodeId,
    active: bool,
    dialog: bool,
    expanded: bool,
    chosen: usize,
    checked: bool,
    capture: Option<NodeId>,
    pointer: Point,
    width: f32,
    height: f32,
    main_size: (f32, f32),
    invalid: Invalid,
    control: Option<String>,
    last_tree: Option<Tree>,
    backend_name: String,
}
impl Form {
    pub fn new(args: &[String], backend_name: &str) -> Result<Self> {
        let fonts = Arc::new(FontSet::discover_required()?);
        let mut text = ParleyBackend::new(fonts.clone())?;
        let (tx, requests) = mpsc::channel();
        let callback: Callback = Arc::new(move |r| {
            let _ = tx.send(r);
        });
        let mut fields = BTreeMap::new();
        for id in [NAME, PASSWORD, ERROR] {
            fields.insert(
                id,
                Field {
                    editor: Editor::new(
                        Box::new(ParleyBackend::new(fonts.clone())?),
                        if id == ERROR { "wrong" } else { "" },
                        TextStyle {
                            size: 22.,
                            ..Default::default()
                        },
                        800.,
                    )?,
                    bounds: Rect::default(),
                    password: id == PASSWORD,
                    hide_preedit_caret: false,
                    mask: text.layout(
                        "",
                        &TextStyle {
                            size: 22.,
                            ..Default::default()
                        },
                        800.,
                    )?,
                },
            );
        }
        let mut controls = BTreeMap::new();
        for (id, role, name) in [
            (NAME, Role::TextInput, "Name"),
            (PASSWORD, Role::Password, "Password"),
            (DROPDOWN, Role::ComboBox, "Language"),
            (CHECK, Role::CheckBox, "Remember me"),
            (OPEN, Role::Button, "Review"),
            (ERROR, Role::TextInput, "Confirmation"),
            (CLOSE, Role::Button, "Save"),
        ] {
            controls.insert(
                id,
                Control {
                    id,
                    role,
                    name: name.into(),
                    bounds: Rect::default(),
                    label: text.layout(
                        name,
                        &TextStyle {
                            size: 16.,
                            ..Default::default()
                        },
                        800.,
                    )?,
                },
            );
        }
        let mut labels = Vec::new();
        for (i, case) in nk_text::corpus::cases()?.into_iter().enumerate() {
            labels.push(crate::Label {
                id: 100 + i as u64,
                name: case.id.clone(),
                title: text.layout(
                    &case.id,
                    &TextStyle {
                        size: 14.,
                        ..Default::default()
                    },
                    800.,
                )?,
                body: text.layout(
                    &case.text,
                    &nk_text::corpus::style(&case, &fonts),
                    case.widths[0],
                )?,
                measured: Default::default(),
                bounds: Default::default(),
                width: case.widths[0],
            });
        }
        let mut form = Self {
            labels,
            corpus_scroll: 0.,
            fields,
            controls,
            backend: None,
            requests,
            fonts,
            palette: palette::Palette::startup()?,
            focused: NAME,
            active: false,
            dialog: false,
            expanded: false,
            chosen: 0,
            checked: false,
            capture: None,
            pointer: Point::default(),
            width: 960.,
            height: 720.,
            main_size: (960., 720.),
            invalid: Invalid {
                layout: true,
                paint: true,
                semantics: true,
            },
            control: args
                .iter()
                .find_map(|a| a.strip_prefix("--control-a11y=").map(String::from)),
            last_tree: None,
            backend_name: backend_name.into(),
        };
        form.layout()?;
        let start = Instant::now();
        let tree = form.tree();
        let build_us = start.elapsed().as_micros();
        let rss = || {
            std::fs::read_to_string("/proc/self/status")
                .unwrap_or_default()
                .lines()
                .find_map(|l| {
                    l.strip_prefix("VmRSS:")
                        .and_then(|s| s.split_whitespace().next())
                        .and_then(|s| s.parse::<i64>().ok())
                })
                .unwrap_or(0)
        };
        let before = rss();
        let backend_start = Instant::now();
        form.backend = Some(match backend_name {
            "accesskit" => Box::new(nk_a11y::accesskit_backend::Backend::new(tree, callback)?)
                as Box<dyn A11yBackend>,
            "atspi" => Box::new(nk_a11y::atspi_backend::Backend::new(tree, callback)?)
                as Box<dyn A11yBackend>,
            "none" => Box::new(NoBackend),
            _ => return Err("--a11y must be accesskit, atspi or none (measurement)".into()),
        });
        eprintln!(
            "A11Y_INIT backend={backend_name} tree_build_us={build_us} rss_before_kib={before} rss_after_kib={} backend_init_us={}",
            rss(),
            backend_start.elapsed().as_micros()
        );
        Ok(form)
    }
    fn order(&self) -> Vec<NodeId> {
        if self.dialog {
            vec![ERROR, CLOSE]
        } else {
            vec![NAME, PASSWORD, DROPDOWN, CHECK, OPEN]
        }
    }
    fn layout(&mut self) -> Result<()> {
        if !self.invalid.layout {
            return Ok(());
        }
        let width = (self.width - 88.).max(180.);
        // Measure first, including the field's actual retained layout.
        for c in self.controls.values_mut() {
            c.label.size(width)?;
        }
        for f in self.fields.values_mut() {
            f.editor.set_max_width(width - 24.)?;
        }
        // Then place the controls. Main-window boxes survive a modal resize.
        for (i, id) in self.order().iter().enumerate() {
            let bounds = Rect {
                x: 44.,
                y: 56. + i as f32 * 100.,
                width,
                height: 54.,
            };
            self.controls.get_mut(id).unwrap().bounds = bounds;
            if let Some(f) = self.fields.get_mut(id) {
                f.bounds = bounds;
            }
        }
        if !self.dialog {
            let mut y = 570.;
            for label in &mut self.labels {
                let body = label.body.size(label.width.min(width))?;
                let title = label.title.size(width)?;
                label.measured = nk_text::Size {
                    width,
                    height: body.height + title.height + 24.,
                };
                label.bounds = Rect {
                    x: 44.,
                    y,
                    width,
                    height: label.measured.height,
                };
                y += label.measured.height;
            }
        }
        self.invalid.layout = false;
        self.invalid.semantics = true;
        Ok(())
    }
    fn focus(&mut self, id: NodeId) -> Result<()> {
        if !self.order().contains(&id) {
            return Ok(());
        }
        if let Some(f) = self.fields.get_mut(&self.focused) {
            f.editor.cancel_preedit()?;
            f.hide_preedit_caret = false;
        }
        self.focused = id;
        self.capture = None;
        Ok(())
    }
    fn option_bounds(&self, i: usize) -> Rect {
        let r = self.controls[&DROPDOWN].bounds;
        let width = (r.width - 24.).min(200.);
        Rect {
            x: r.x + r.width - width,
            y: r.y + 54. + i as f32 * 32.,
            width,
            height: 32.,
        }
    }
    fn tree(&self) -> Tree {
        let mut nodes = BTreeMap::new();
        let mut root = Node::new(ROOT, Role::Window, "Nidara accessibility form");
        root.bounds = Bounds {
            x: 0.,
            y: 0.,
            width: self.main_size.0 as f64,
            height: self.main_size.1 as f64,
        };
        let main = [NAME, PASSWORD, DROPDOWN, CHECK, OPEN];
        root.children = main.to_vec();
        root.children.extend(self.labels.iter().map(|l| l.id));
        if self.dialog {
            root.children.push(DIALOG);
        }
        for id in main.into_iter().chain(if self.dialog {
            vec![ERROR, CLOSE]
        } else {
            vec![]
        }) {
            let c = &self.controls[&id];
            let mut n = Node::new(id, c.role, &c.name);
            n.bounds = Bounds {
                x: c.bounds.x as f64,
                y: c.bounds.y as f64,
                width: c.bounds.width as f64,
                height: c.bounds.height as f64,
            };
            n.states = States {
                focused: self.active && id == self.focused,
                disabled: self.dialog && main.contains(&id),
                checked: id == CHECK && self.checked,
                expanded: id == DROPDOWN && self.expanded,
                invalid: id == ERROR && self.fields[&ERROR].editor.text() != "correct",
                ..Default::default()
            };
            n.actions = vec![Action::Focus];
            if let Some(f) = self.fields.get(&id) {
                if !f.password {
                    let e = &f.editor;
                    n.actions.extend([Action::SetText, Action::SetSelection]);
                    n.text = Some(TextInfo {
                        text: e.text().into(),
                        caret: e.caret().offset,
                        anchor: e.anchor().offset,
                        words: e
                            .text()
                            .unicode_word_indices()
                            .map(|(i, w)| i..i + w.len())
                            .collect(),
                        lines: e.layout().lines().iter().map(|l| l.range.clone()).collect(),
                    });
                }
                if id == ERROR {
                    n.description = "Enter correct to fix this error".into();
                }
            } else {
                n.actions.push(Action::Activate);
            }
            if id == DROPDOWN {
                n.description = OPTIONS[self.chosen].into();
                if self.expanded {
                    n.children = (0..3).map(|i| ITEM + i).collect();
                }
            }
            if self.control.as_deref() == Some("geometry") && id == NAME {
                n.bounds.x = 0.;
            }
            if self.control.as_deref() == Some("role") && id == CHECK {
                n.role = Role::Button;
            }
            if self.control.as_deref() == Some("focus") && id == PASSWORD {
                n.states.focused = false;
            }
            if self.control.as_deref() == Some("name") && id == NAME {
                n.name = "Broken".into();
            }
            if self.control.as_deref() == Some("state") && id == CHECK {
                n.states.checked = false;
            }
            if self.control.as_deref() == Some("password") && id == PASSWORD {
                n.role = Role::TextInput;
                n.text = Some(TextInfo {
                    text: self.fields[&PASSWORD].editor.text().into(),
                    ..Default::default()
                });
            }
            if id == NAME {
                if self.control.as_deref() == Some("text") {
                    n.text = Some(TextInfo::default());
                }
                if let Some(t) = n.text.as_mut() {
                    if self.control.as_deref() == Some("caret") {
                        t.caret = 0;
                    }
                    if self.control.as_deref() == Some("selection") {
                        t.anchor = t.caret;
                    }
                }
            }
            if self.control.as_deref() == Some("expanded") && id == DROPDOWN {
                n.states.expanded = false;
            }
            if self.control.as_deref() == Some("error") && id == ERROR {
                n.states.invalid = false;
            }
            nodes.insert(id, n);
        }
        if self.expanded {
            for (i, name) in OPTIONS.iter().enumerate() {
                let mut n = Node::new(ITEM + i as u64, Role::Option, *name);
                n.states.selected = i == self.chosen;
                let r = self.option_bounds(i);
                n.bounds = Bounds {
                    x: r.x as f64,
                    y: r.y as f64,
                    width: r.width as f64,
                    height: r.height as f64,
                };
                n.actions = vec![Action::Activate];
                nodes.insert(n.id, n);
            }
        }
        if self.dialog {
            let mut n = Node::new(DIALOG, Role::Dialog, "Correct error");
            n.description = "Enter correct to fix this error".into();
            n.bounds = Bounds {
                x: 0.,
                y: 0.,
                width: self.width as f64,
                height: self.height as f64,
            };
            n.children = vec![ERROR, CLOSE];
            nodes.insert(DIALOG, n);
        }
        if self.control.as_deref() == Some("tree") {
            root.name = "Broken form".into();
        }
        for label in &self.labels {
            let mut n = Node::new(label.id, Role::Label, &label.name);
            let r = offset(label.bounds, (0., -self.corpus_scroll));
            n.bounds = Bounds {
                x: r.x as f64,
                y: r.y as f64,
                width: r.width as f64,
                height: r.height as f64,
            };
            n.description = label.body.text().into();
            n.states.hidden = self.dialog || r.y + r.height < 570. || r.y > self.height;
            nodes.insert(n.id, n);
        }
        nodes.insert(ROOT, root);
        Tree { root: ROOT, nodes }
    }
    fn sync(&mut self, w: &mut Window) -> Result<()> {
        self.layout()?;
        if let Some(f) = self.fields.get(&self.focused) {
            let r = f.editor.caret_rect()?;
            w.set_text_input(TextInput {
                focused: self.active,
                password: f.password,
                text: if f.password {
                    String::new()
                } else {
                    f.editor.text().into()
                },
                cursor: if f.password {
                    0
                } else {
                    f.editor.caret().offset
                },
                anchor: if f.password {
                    0
                } else {
                    f.editor.anchor().offset
                },
                rect: [
                    (f.bounds.x + 12. + r.x) as i32,
                    (f.bounds.y + 12. + r.y) as i32,
                    1,
                    r.height.ceil() as i32,
                ],
            });
        } else {
            w.set_text_input(TextInput::default());
        }
        if self.invalid.semantics {
            let tree = self.tree();
            let events = nk_a11y::diff(self.last_tree.as_ref(), &tree)?.len();
            self.backend.as_mut().unwrap().update(tree.clone())?;
            self.last_tree = Some(tree);
            self.invalid.semantics = false;
            eprintln!(
                "A11Y_UPDATE backend={} semantic_events={events}",
                self.backend_name
            );
        }
        if self.invalid.paint {
            w.redraw();
            self.invalid.paint = false;
        }
        Ok(())
    }
    fn changed(&mut self) {
        self.invalid.paint = true;
        self.invalid.semantics = true;
    }
    fn activate(&mut self, id: NodeId, w: &mut Window) -> Result<()> {
        if self.dialog {
            if id == CLOSE && self.fields[&ERROR].editor.text() == "correct" {
                w.close();
            }
            return Ok(());
        }
        match id {
            id if (ITEM..ITEM + 3).contains(&id) && self.expanded => {
                self.chosen = (id - ITEM) as usize;
                self.expanded = false;
            }
            DROPDOWN => self.expanded = !self.expanded,
            CHECK => self.checked = !self.checked,
            OPEN => {
                if self.control.as_deref() == Some("dialog") {
                    return Ok(());
                }
                self.expanded = false;
                self.dialog = true;
                self.focused = ERROR;
                self.capture = None;
                self.active = false;
                self.width = 500.;
                self.height = 300.;
                self.invalid.layout = true;
                self.changed();
                nk_wayland::run_dialog(Dialog(self), w)?;
                self.dialog = false;
                self.active = true;
                self.focused = if self.control.as_deref() == Some("restore") {
                    NAME
                } else {
                    OPEN
                };
                let (width, height) = w.size();
                self.width = width as f32;
                self.height = height as f32;
                if !self.dialog {
                    self.main_size = (self.width, self.height);
                }
                self.invalid.layout = true;
            }
            _ => {}
        }
        Ok(())
    }
    fn request(&mut self, r: Request, w: &mut Window) -> Result<()> {
        if self.control.as_deref() == Some("action") {
            return Ok(());
        }
        match r {
            Request::Focus(id) => self.focus(id)?,
            Request::Activate(id) if (ITEM..ITEM + 3).contains(&id) && self.expanded => {
                self.chosen = (id - ITEM) as usize;
                self.expanded = false;
            }
            Request::Activate(id) if self.order().contains(&id) => self.activate(id, w)?,
            Request::SetText(id, text) if self.order().contains(&id) && id != PASSWORD => {
                if let Some(f) = self.fields.get_mut(&id) {
                    let len = f.editor.text().len();
                    f.editor.replace_range(0..len, &text)?;
                }
            }
            Request::SetSelection(id, range) if self.order().contains(&id) && id != PASSWORD => {
                if let Some(f) = self.fields.get_mut(&id) {
                    let _ = f.editor.set_selection(
                        Caret {
                            offset: range.start,
                            affinity: Affinity::Downstream,
                        },
                        Caret {
                            offset: range.end,
                            affinity: Affinity::Upstream,
                        },
                    );
                }
            }
            _ => {}
        }
        self.changed();
        self.sync(w)
    }
    fn key(&mut self, k: Key, w: &mut Window) -> Result<()> {
        if k.sym == 0xff1b {
            if self.expanded {
                self.expanded = false;
            } else if self.dialog {
                w.close();
            } else if let Some(f) = self.fields.get_mut(&self.focused) {
                f.editor.cancel_preedit()?;
            }
            return Ok(());
        }
        if k.sym == 0xff09 || k.sym == 0xfe20 {
            self.expanded = false;
            let order = self.order();
            let i = order.iter().position(|id| *id == self.focused).unwrap_or(0);
            self.focus(
                order[(i + if k.shift || k.sym == 0xfe20 {
                    order.len() - 1
                } else {
                    1
                }) % order.len()],
            )?;
            w.reset_ime();
            return Ok(());
        }
        if self.focused == DROPDOWN {
            match k.sym {
                0x20 | 0xff0d => {
                    if k.sym != 0xff0d || self.control.as_deref() != Some("collapse") {
                        self.expanded = !self.expanded;
                    }
                }
                0xff52 | 0xff54 if self.expanded && self.control.as_deref() != Some("dropdown") => {
                    self.chosen = (self.chosen + if k.sym == 0xff54 { 1 } else { 2 }) % 3
                }
                _ => {}
            }
            return Ok(());
        }
        if !self.fields.contains_key(&self.focused) {
            if k.sym == 0x20 || k.sym == 0xff0d {
                self.activate(self.focused, w)?;
            }
            return Ok(());
        }
        let f = self.fields.get_mut(&self.focused).unwrap();
        let e = &mut f.editor;
        if k.ctrl {
            match k.sym {
                0x61 | 0x41 => e.set_selection(
                    Caret::default(),
                    Caret {
                        offset: e.text().len(),
                        affinity: Affinity::Upstream,
                    },
                )?,
                0x63 | 0x43 if !f.password => w.copy(e.selected_text().into()),
                0x78 | 0x58 if !f.password => w.copy(e.cut()?),
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
                0xff50 => e.move_caret(Movement::LineStart, k.shift)?,
                0xff57 => e.move_caret(Movement::LineEnd, k.shift)?,
                0xff08 => e.backspace()?,
                0xffff => e.delete()?,
                _ if !k.alt && !k.text.is_empty() && !k.text.chars().any(char::is_control) => {
                    e.insert(&k.text)?
                }
                _ => {}
            }
        }
        Ok(())
    }
    fn ime(&mut self, b: ImeBatch) -> Result<()> {
        if !self.active {
            return Ok(());
        }
        if let Some(f) = self.fields.get_mut(&self.focused) {
            let e = &mut f.editor;
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
                e.replace_range(deletion.unwrap_or(selected), &text)?;
            } else if let Some(r) = deletion {
                let kept = e.selected_text().to_string();
                let start = r.start;
                e.replace_range(r, &kept)?;
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
            f.hide_preedit_caret = false;
            if let Some((text, begin, _)) = b.preedit
                && !text.is_empty()
            {
                let caret = grapheme_boundaries(&text)
                    .into_iter()
                    .take_while(|p| *p <= begin.max(0) as usize)
                    .last()
                    .unwrap_or(0);
                f.hide_preedit_caret = begin < 0;
                e.set_preedit(e.selection(), &text, caret)?;
            }
        }
        Ok(())
    }
    fn event_inner(&mut self, event: Event, w: &mut Window) -> Result<()> {
        match event {
            Event::Configure => {
                let (width, height) = w.size();
                self.width = width as f32;
                self.height = height as f32;
                if !self.dialog {
                    self.main_size = (self.width, self.height);
                }
                self.invalid.layout = true;
            }
            Event::Focus(active) => {
                self.active = active;
                if !active {
                    self.capture = None;
                    for f in self.fields.values_mut() {
                        f.editor.cancel_preedit()?;
                        f.hide_preedit_caret = false;
                    }
                }
            }
            Event::Scroll(delta) if !self.dialog => {
                let last = self
                    .labels
                    .last()
                    .map_or(570., |l| l.bounds.y + l.bounds.height);
                self.corpus_scroll = (self.corpus_scroll + delta as f32 * 3.)
                    .clamp(0., (last - self.height + 16.).max(0.));
            }
            Event::Key(k) => self.key(k, w)?,
            Event::Ime(b) => self.ime(b)?,
            Event::Paste(text) => {
                if let Some(f) = self.fields.get_mut(&self.focused) {
                    f.editor.paste(&text)?;
                }
            }
            Event::Motion(x, y) => {
                self.pointer = Point {
                    x: x as f32,
                    y: y as f32,
                };
                if let Some(id) = self.capture
                    && let Some(f) = self.fields.get_mut(&id)
                {
                    let c = f.editor.layout().hit_test(Point {
                        x: self.pointer.x - f.bounds.x - 12.,
                        y: self.pointer.y - f.bounds.y - 12.,
                    })?;
                    f.editor.set_caret(c.offset, c.affinity, true)?;
                } else {
                    return Ok(());
                }
            }
            Event::Button {
                button: 0x110,
                pressed,
            } => {
                if pressed {
                    let option = if self.expanded {
                        (0..3)
                            .find(|i| crate::contains(self.option_bounds(*i), self.pointer))
                            .map(|i| ITEM + i as u64)
                    } else {
                        None
                    };
                    let hit = option.or_else(|| {
                        self.order()
                            .into_iter()
                            .find(|id| crate::contains(self.controls[id].bounds, self.pointer))
                    });
                    if let Some(id) = hit {
                        self.focus(id)?;
                        self.capture = Some(id);
                        if let Some(f) = self.fields.get_mut(&id) {
                            let c = f.editor.layout().hit_test(Point {
                                x: self.pointer.x - f.bounds.x - 12.,
                                y: self.pointer.y - f.bounds.y - 12.,
                            })?;
                            f.editor.set_caret(c.offset, c.affinity, false)?;
                        }
                        w.reset_ime();
                    }
                } else if let Some(id) = self.capture.take()
                    && crate::contains(
                        if (ITEM..ITEM + 3).contains(&id) {
                            self.option_bounds((id - ITEM) as usize)
                        } else {
                            self.controls[&id].bounds
                        },
                        self.pointer,
                    )
                    && !self.fields.contains_key(&id)
                {
                    self.activate(id, w)?;
                }
            }
            _ => return Ok(()),
        }
        self.changed();
        self.sync(w)
    }
    fn paint_inner(&mut self, f: Frame) -> Result<Vec<u8>> {
        self.layout()?;
        let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
        for id in self.order() {
            let control = &self.controls[&id];
            debug_assert_eq!(id, control.id);
            let r = control.bounds;
            c.layout(&control.label, (r.x, r.y - 25.), self.palette.ink)?;
            c.rounded_rect(
                r,
                10.,
                if id == self.focused && self.active {
                    self.palette.selection
                } else {
                    self.palette.field
                },
            );
            if let Some(field) = self.fields.get_mut(&id) {
                let origin = (r.x + 12., r.y + 12.);
                c.clip(r);
                if field.password {
                    let value = "•".repeat(field.editor.display_text().graphemes(true).count());
                    let mut text = ParleyBackend::new(self.fonts.clone())?;
                    field.mask = text.layout(
                        &value,
                        &TextStyle {
                            size: 22.,
                            ..Default::default()
                        },
                        r.width - 24.,
                    )?;
                    c.layout(&field.mask, origin, self.palette.ink)?;
                } else {
                    c.selection(
                        &field.editor.selection_rects()?,
                        origin,
                        self.palette.selection,
                    );
                    c.layout(field.editor.layout(), origin, self.palette.ink)?;
                }
                if id == self.focused && self.active && !field.hide_preedit_caret {
                    let caret = if field.password {
                        field.mask.caret_rect(
                            field.editor.display_text()[..field.editor.display_caret().offset]
                                .graphemes(true)
                                .count()
                                * "•".len(),
                            Affinity::Upstream,
                        )?
                    } else {
                        field.editor.caret_rect()?
                    };
                    c.caret(offset(caret, origin), self.palette.ink);
                }
                c.pop_clip();
            } else {
                let value = match id {
                    DROPDOWN => format!(
                        "{}{}",
                        OPTIONS[self.chosen],
                        if self.expanded { " (open)" } else { "" }
                    ),
                    CHECK => {
                        if self.checked {
                            "Selected".into()
                        } else {
                            "Unselected".into()
                        }
                    }
                    _ => control.name.clone(),
                };
                let mut text = ParleyBackend::new(self.fonts.clone())?;
                let label = text.layout(
                    &value,
                    &TextStyle {
                        size: 20.,
                        ..Default::default()
                    },
                    r.width - 24.,
                )?;
                c.layout(&label, (r.x + 12., r.y + 12.), self.palette.ink)?;
            }
        }
        if !self.dialog && self.height > 570. {
            c.clip(Rect {
                x: 32.,
                y: 570.,
                width: self.width - 64.,
                height: self.height - 586.,
            });
            for label in &self.labels {
                let r = offset(label.bounds, (0., -self.corpus_scroll));
                if r.y + r.height < 570. || r.y > self.height {
                    continue;
                }
                c.layout(&label.title, (r.x, r.y), self.palette.secondary)?;
                c.layout(&label.body, (r.x, r.y + 24.), self.palette.ink)?;
            }
            c.pop_clip();
        }
        if self.expanded {
            let mut text = ParleyBackend::new(self.fonts.clone())?;
            for (i, value) in OPTIONS.iter().enumerate() {
                let row = self.option_bounds(i);
                c.rounded_rect(
                    row,
                    6.,
                    if i == self.chosen {
                        self.palette.selection
                    } else {
                        self.palette.field
                    },
                );
                let label = text.layout(
                    value,
                    &TextStyle {
                        size: 16.,
                        ..Default::default()
                    },
                    180.,
                )?;
                c.layout(&label, (row.x + 8., row.y + 4.), self.palette.ink)?;
            }
        }
        if self.dialog && self.fields[&ERROR].editor.text() != "correct" {
            let mut text = ParleyBackend::new(self.fonts.clone())?;
            let label = text.layout(
                "Error: enter correct, then Save",
                &TextStyle {
                    size: 16.,
                    ..Default::default()
                },
                400.,
            )?;
            c.layout(&label, (44., 230.), self.palette.ink)?;
        }
        Ok(c.finish())
    }
}
impl Application for Form {
    fn event(&mut self, e: Event, w: &mut Window) -> Result<()> {
        self.event_inner(e, w)
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        while let Ok(r) = self.requests.try_recv() {
            self.request(r, w)?;
        }
        self.sync(w)
    }
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        self.paint_inner(f)
    }
    fn material(&self) -> Option<Material> {
        Some(material::panel(self.width, self.height))
    }
}
struct Dialog<'a>(&'a mut Form);
impl Application for Dialog<'_> {
    fn event(&mut self, e: Event, w: &mut Window) -> Result<()> {
        self.0.event_inner(e, w)
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        self.0.idle(w)
    }
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        self.0.paint_inner(f)
    }
    fn material(&self) -> Option<Material> {
        self.0.material()
    }
}

struct NoBackend;
impl A11yBackend for NoBackend {
    fn update(&mut self, _: Tree) -> Result<()> {
        Ok(())
    }
}
