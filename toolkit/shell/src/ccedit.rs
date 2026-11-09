// SPDX-License-Identifier: LGPL-3.0-or-later
//! B2.3 view-local editing; pure layout preview, no writes until commit.
use super::*;
const SEMANTIC_BASE: u64 = 1 << 48;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Toggle,
    Tile(&'static str),
    Remove(&'static str),
    Add(&'static str),
    Size(&'static str, Size),
}
#[derive(Clone, Debug)]
pub struct Control {
    pub target: Target,
    pub label: String,
    pub rect: [f64; 4],
    pub disabled: bool,
    pub checked: bool,
}
struct Hold {
    id: &'static str,
    offset: (f64, f64),
    start: (f64, f64),
    snapshot: layout::Stored,
    added: bool,
    preview: Option<layout::Stored>,
    moved: bool,
    pointer: (f64, f64),
    size: Size,
    target_in_bounds: bool,
}
pub struct Editor {
    pub active: bool,
    pub layered: bool,
    pub menu_layered: bool,
    pub settling: Option<std::time::Instant>,
    pub stored: layout::Stored,
    pub pending: bool,
    pub write_serial: u64,
    pub error: String,
    hold: Option<Hold>,
    pub menu: Option<&'static str>,
    pub focus: Option<Target>,
    pub hover: Option<Target>,
    pub panel: [f64; 4],
    pub viewport: [f64; 4],
    pub origin: (f64, f64),
    pub offset: f64,
    pub controls: Vec<Control>,
    pub(super) tiles: Vec<Placed>,
    pub accent: [f64; 4],
    height: f64,
}
impl Default for Editor {
    fn default() -> Self {
        Self {
            active: false,
            layered: false,
            menu_layered: false,
            settling: None,
            stored: Default::default(),
            pending: false,
            write_serial: 0,
            error: String::new(),
            hold: None,
            menu: None,
            focus: None,
            hover: None,
            panel: [0.; 4],
            viewport: [0.; 4],
            origin: (0., 0.),
            offset: 0.,
            controls: vec![],
            tiles: vec![],
            accent: [1., 1., 1., 0.2],
            height: 0.,
        }
    }
}
impl Editor {
    pub(super) fn sync(
        &mut self,
        stored: &layout::Stored,
        status: &Status,
        right: f64,
        top: f64,
        height: f64,
    ) -> Vec<Placed> {
        if self.pending && layout::same_view(stored, &self.stored) {
            self.pending = false;
            self.stored = stored.clone();
        }
        if !self.pending && self.hold.is_none() {
            self.stored = stored.clone();
        }
        let current = self
            .hold
            .as_ref()
            .and_then(|h| h.preview.as_ref())
            .unwrap_or(&self.stored);
        let tiles = layout::layout(current, &|id| available(id, status));
        let rows = if self.active {
            layout::ROWS
        } else {
            layout::rows(&tiles).max(1)
        };
        let grid = rows as f64 * (layout::UNIT + layout::GAP) - layout::GAP;
        let extra = if self.active {
            layout::REGISTRY
                .iter()
                .filter(|m| {
                    available(m.id, status)
                        && !layout::members(current, &|id| available(id, status)).contains(&m.id)
                })
                .count() as f64
                * 36.
                + 32.
        } else {
            0.
        };
        let width = layout::GRID_WIDTH + 2. * PAD;
        let total = grid + extra;
        let footer = if self.error.is_empty() { 48. } else { 80. };
        let visible = total.min((height - top - HANG - 2. * PAD - footer).max(76.));
        self.offset = self.offset.clamp(0., (total - visible).max(0.));
        self.panel = [
            right - width,
            top + HANG,
            width,
            visible + 2. * PAD + footer,
        ];
        self.viewport = [
            self.panel[0] + PAD,
            self.panel[1] + PAD,
            layout::GRID_WIDTH,
            visible,
        ];
        self.origin = (self.viewport[0], self.viewport[1] - self.offset);
        self.height = total;
        self.tiles = tiles
            .into_iter()
            .map(|tile| {
                let r = tile.rect();
                Placed {
                    tile,
                    rect: [self.origin.0 + r[0], self.origin.1 + r[1], r[2], r[3]],
                }
            })
            .collect();
        if let Some(h) = &self.hold
            && h.moved
            && let Some(p) = self.tiles.iter_mut().find(|p| p.tile.id == h.id)
        {
            p.rect[0] = h.pointer.0 - h.offset.0;
            p.rect[1] = h.pointer.1 - h.offset.1;
        }
        self.controls.clear();
        self.controls.push(Control {
            target: Target::Toggle,
            label: if self.active { "Done" } else { "Edit" }.into(),
            rect: [
                self.panel[0] + PAD,
                self.panel[1] + self.panel[3] - 44.,
                width - 2. * PAD,
                32.,
            ],
            disabled: self.pending,
            checked: self.active,
        });
        if self.active {
            for p in &self.tiles {
                if !layout::meta_of(p.tile.id).is_some_and(|m| m.fixed) {
                    self.controls.push(Control {
                        target: Target::Remove(p.tile.id),
                        label: "×".into(),
                        rect: [p.rect[0] + p.rect[2] - 25., p.rect[1] - 3., 28., 28.],
                        disabled: self.pending,
                        checked: false,
                    });
                }
            }
            let members = layout::members(current, &|id| available(id, status));
            let mut y = self.origin.1 + grid + 24.;
            for m in layout::REGISTRY
                .iter()
                .filter(|m| available(m.id, status) && !members.contains(&m.id))
            {
                self.controls.push(Control {
                    target: Target::Add(m.id),
                    label: format!("Add {}", m.id),
                    rect: [self.origin.0, y, layout::GRID_WIDTH, 32.],
                    disabled: layout::add(&self.stored, &|id| available(id, status), m.id, None)
                        .is_none()
                        || self.pending,
                    checked: false,
                });
                y += 36.;
            }
            if let Some(id) = self.menu {
                self.controls.retain(|c| c.target == Target::Toggle);
                let supported = layout::meta_of(id).unwrap().supported;
                let p = self
                    .tiles
                    .iter()
                    .find(|p| p.tile.id == id)
                    .map(|p| p.rect)
                    .unwrap_or(self.viewport);
                let x = p[0].clamp(self.viewport[0], self.viewport[0] + self.viewport[2] - 180.);
                let y = (p[1] + 28.).clamp(
                    self.viewport[1],
                    (self.viewport[1] + self.viewport[3] - 144.).max(self.viewport[1]),
                );
                for (i, size) in supported.iter().enumerate() {
                    self.controls.push(Control {
                        target: Target::Size(id, *size),
                        label: ["Small", "Medium", "Large"][i].into(),
                        rect: [x, y + i as f64 * 34., 180., 32.],
                        disabled: self.pending
                            || layout::resize(&self.stored, &|id| available(id, status), id, *size)
                                .is_none(),
                        checked: self
                            .tiles
                            .iter()
                            .any(|p| p.tile.id == id && p.tile.size == *size),
                    });
                }
                if !layout::meta_of(id).unwrap().fixed {
                    self.controls.push(Control {
                        target: Target::Remove(id),
                        label: "Remove".into(),
                        rect: [x, y + 102., 180., 32.],
                        disabled: self.pending,
                        checked: false,
                    });
                }
            }
        }
        self.tiles.clone()
    }
    pub fn current(&self) -> &layout::Stored {
        self.hold
            .as_ref()
            .and_then(|h| h.preview.as_ref())
            .unwrap_or(&self.stored)
    }
    pub fn toggle(&mut self) {
        if !self.pending {
            self.active = !self.active;
            self.menu = None;
            self.hold = None;
            self.offset = 0.;
            self.focus = Some(Target::Toggle);
        }
    }
    pub fn close(&mut self) {
        self.active = false;
        self.menu = None;
        self.hold = None;
        self.focus = None;
        self.offset = 0.;
    }
    pub fn accept(&mut self, next: Option<layout::Stored>) -> Option<Act> {
        let Some(next) = next else {
            self.error = "cc.menu.size-full".into();
            return None;
        };
        self.error.clear();
        if next == self.stored {
            return None;
        }
        self.write_serial = self
            .write_serial
            .checked_add(1)
            .filter(|v| *v < (1 << 63))?;
        let before = self.stored.clone();
        self.stored = next.clone();
        self.pending = true;
        Some(Act::Layout(before, next))
    }
    pub fn action(&mut self, target: Target, status: &Status) -> Option<Act> {
        if self.pending {
            return None;
        }
        match target {
            Target::Toggle => {
                self.toggle();
                None
            }
            Target::Tile(id) => {
                self.menu = Some(id);
                self.focus = Some(target);
                None
            }
            Target::Remove(id) => {
                if layout::meta_of(id).is_some_and(|m| m.fixed) {
                    return None;
                }
                self.menu = None;
                self.accept(layout::remove(
                    &self.stored,
                    &|id| available(id, status),
                    id,
                ))
            }
            Target::Add(id) => self.accept(layout::add(
                &self.stored,
                &|id| available(id, status),
                id,
                None,
            )),
            Target::Size(id, size) => {
                self.menu = None;
                self.accept(layout::resize(
                    &self.stored,
                    &|id| available(id, status),
                    id,
                    size,
                ))
            }
        }
    }
    pub fn named(&mut self, id: &'static str, name: &str, status: &Status) -> Option<Act> {
        if !self.active || self.pending {
            return None;
        }
        match name {
            "Resize" => {
                self.menu = Some(id);
                None
            }
            "Remove" => self.action(Target::Remove(id), status),
            "Move up" | "Move down" | "Move left" | "Move right" => {
                let p = self.tiles.iter().find(|p| p.tile.id == id)?.tile;
                let (dx, dy) = match name {
                    "Move up" => (0, -1),
                    "Move down" => (0, 1),
                    "Move left" => (-1, 0),
                    _ => (1, 0),
                };
                if !layout::in_bounds(p.x + dx, p.y + dy, p.size) {
                    self.error.clear();
                    return None;
                }
                self.accept(layout::move_tile(
                    &self.stored,
                    &|id| available(id, status),
                    id,
                    p.x + dx,
                    p.y + dy,
                ))
            }
            _ => None,
        }
    }
    pub fn target(&self, p: (f64, f64)) -> Option<Target> {
        let in_view = inside(self.viewport, p);
        self.controls
            .iter()
            .rev()
            .find(|c| inside(c.rect, p) && (c.target == Target::Toggle || in_view) && !c.disabled)
            .map(|c| c.target)
            .or_else(|| {
                if self.active && self.menu.is_none() && in_view {
                    self.tiles
                        .iter()
                        .find(|t| inside(t.rect, p))
                        .map(|t| Target::Tile(t.tile.id))
                } else {
                    None
                }
            })
    }
    pub fn press(&mut self, p: (f64, f64), status: &Status) -> Option<Act> {
        let target = match self.target(p) {
            Some(target) => target,
            None => {
                self.menu = None;
                return None;
            }
        };
        if target != Target::Toggle && self.settling.is_some_and(|t| std::time::Instant::now() < t)
        {
            return None;
        }
        self.focus = Some(target);
        if let Target::Tile(id) | Target::Add(id) = target
            && self.active
            && self.menu.is_none()
            && !self.pending
        {
            let added = matches!(target, Target::Add(_));
            let r = if added {
                self.controls.iter().find(|c| c.target == target)?.rect
            } else {
                self.tiles.iter().find(|t| t.tile.id == id)?.rect
            };
            let size = if added {
                layout::meta_of(id).unwrap().default_size
            } else {
                self.tiles.iter().find(|t| t.tile.id == id)?.tile.size
            };
            self.hold = Some(Hold {
                id,
                size,
                target_in_bounds: false,
                offset: if added {
                    let (w, h) = layout::meta_of(id).unwrap().default_size.cells();
                    (
                        (w as f64 * (layout::UNIT + layout::GAP) - layout::GAP) / 2.,
                        (h as f64 * (layout::UNIT + layout::GAP) - layout::GAP) / 2.,
                    )
                } else {
                    (p.0 - r[0], p.1 - r[1])
                },
                start: p,
                snapshot: self.stored.clone(),
                added,
                preview: None,
                moved: false,
                pointer: p,
            });
            return None;
        }
        self.action(target, status)
    }
    pub fn motion(&mut self, p: (f64, f64), status: &Status) -> bool {
        if self.hold.is_none() {
            let target = self.target(p);
            let changed = self.hover != target;
            self.hover = target;
            return changed;
        }
        let Some(h) = &mut self.hold else {
            return false;
        };
        h.pointer = p;
        h.moved |= (p.0 - h.start.0).hypot(p.1 - h.start.1) > 4.;
        if h.moved {
            let x =
                ((p.0 - h.offset.0 - self.origin.0) / (layout::UNIT + layout::GAP)).round() as i32;
            let y =
                ((p.1 - h.offset.1 - self.origin.1) / (layout::UNIT + layout::GAP)).round() as i32;
            h.target_in_bounds = inside(self.viewport, p) && layout::in_bounds(x, y, h.size);
            h.preview = if h.target_in_bounds {
                if h.added {
                    layout::add(&h.snapshot, &|id| available(id, status), h.id, Some((x, y)))
                } else {
                    layout::move_tile(&h.snapshot, &|id| available(id, status), h.id, x, y)
                }
            } else {
                None
            };
        }
        true
    }
    pub fn release(&mut self, status: &Status) -> Option<Act> {
        let h = self.hold.take()?;
        if !h.moved {
            if h.added {
                return self.action(Target::Add(h.id), status);
            }
            return None;
        }
        if !h.target_in_bounds {
            self.error.clear();
            return None;
        }
        self.accept(h.preview)
    }
    pub fn held(&self) -> Option<&'static str> {
        self.hold.as_ref().filter(|h| h.moved).map(|h| h.id)
    }
    pub fn dragging(&self) -> bool {
        self.hold.is_some()
    }
    pub fn scroll(&mut self, delta: f64, status: &Status) -> bool {
        if self.height <= self.viewport[3] {
            return false;
        }
        let old = self.offset;
        self.offset = (self.offset + delta).clamp(0., (self.height - self.viewport[3]).max(0.));
        self.origin.1 -= self.offset - old;
        if let Some(pointer) = self.hold.as_ref().filter(|h| h.moved).map(|h| h.pointer) {
            self.motion(pointer, status);
        }
        true
    }
    pub fn key(&mut self, key: &nk_wayland::Key, status: &Status) -> Option<Act> {
        if key.sym == 0xff1b {
            if self.menu.take().is_none() {
                self.toggle();
            }
            self.focus = Some(Target::Toggle);
            return None;
        }
        if key.sym == 0xff09 || key.sym == 0xfe20 {
            let mut choices = vec![Target::Toggle];
            choices.extend(self.tiles.iter().map(|p| Target::Tile(p.tile.id)));
            choices.extend(
                self.controls
                    .iter()
                    .filter(|c| {
                        !c.disabled && matches!(c.target, Target::Add(_) | Target::Size(..))
                    })
                    .map(|c| c.target),
            );
            let index = self
                .focus
                .and_then(|t| choices.iter().position(|c| *c == t));
            let i = match index {
                Some(i) if key.shift || key.sym == 0xfe20 => {
                    (i + choices.len() - 1) % choices.len()
                }
                Some(i) => (i + 1) % choices.len(),
                None => 0,
            };
            self.focus = Some(choices[i]);
            self.reveal(choices[i]);
            return None;
        }
        let target = self.focus?;
        if let Target::Tile(id) = target {
            if key.ctrl && [0xff51, 0xff52, 0xff53, 0xff54].contains(&key.sym) {
                return self.named(
                    id,
                    match key.sym {
                        0xff51 => "Move left",
                        0xff52 => "Move up",
                        0xff53 => "Move right",
                        _ => "Move down",
                    },
                    status,
                );
            }
            if key.sym == 0xffff {
                return self.named(id, "Remove", status);
            }
            if key.sym == 0xff67 || (key.shift && key.sym == 0xffc7) {
                return self.named(id, "Resize", status);
            }
        }
        if [0xff0d, 0x20].contains(&key.sym) {
            return self.action(target, status);
        }
        None
    }
    pub fn reveal(&mut self, target: Target) {
        let r = match target {
            Target::Tile(id) => self.tiles.iter().find(|p| p.tile.id == id).map(|p| p.rect),
            _ => self
                .controls
                .iter()
                .find(|c| c.target == target)
                .map(|c| c.rect),
        };
        if let Some(r) = r {
            if target == Target::Toggle {
                return;
            }
            if r[1] < self.viewport[1] {
                self.offset -= (self.viewport[1] - r[1]).min(self.offset);
            } else if r[1] + r[3] > self.viewport[1] + self.viewport[3] {
                self.offset += r[1] + r[3] - self.viewport[1] - self.viewport[3];
            }
        }
    }
    pub fn label(&self, c: &Control, look: Option<&Look>) -> String {
        let tr = |k: &'static str, fallback: &str| {
            look.map_or_else(
                || fallback.to_owned(),
                |l| {
                    let s = l.text_of(&crate::menu::Label::Key(k));
                    if s == k { fallback.to_owned() } else { s }
                },
            )
        };
        match c.target {
            Target::Toggle => {
                if self.active {
                    tr("cc.grid.done", "Done")
                } else {
                    tr("cc.grid.edit", "Edit")
                }
            }
            Target::Add(id) => format!("{} {}", tr("cc.grid.add", "Add"), tr(name_key(id), id)),
            Target::Remove(id) if c.label != "×" => format!(
                "{} {}",
                tr("cc.menu.remove", "Remove"),
                tr(name_key(id), id)
            ),
            Target::Size(_, size) => {
                let key = match size {
                    Size::Single => "cc.menu.size.small",
                    Size::Wide | Size::Tall => "cc.menu.size.medium",
                    _ => "cc.menu.size.large",
                };
                tr(key, &c.label)
            }
            _ => c.label.clone(),
        }
    }
    pub fn full_text(look: Option<&Look>) -> String {
        look.map(|l| l.text_of(&crate::menu::Label::Key("cc.menu.size-full")))
            .filter(|v| v != "cc.menu.size-full")
            .unwrap_or_else(|| "Grid is full".into())
    }
    fn error_text(&self, look: Option<&Look>) -> String {
        if self.error == "cc.menu.size-full" {
            Self::full_text(look)
        } else {
            let fallback = match self.error.as_str() {
                "cc.grid.write-read-only" => "Control Center layout is read-only",
                "cc.grid.write-changed" => "Control Center layout changed; retry the edit",
                "cc.grid.write-failed" => "Could not save the Control Center layout",
                _ => return self.error.clone(),
            };
            translate(look, &self.error, fallback)
        }
    }
    pub fn description(&self, look: Option<&Look>) -> String {
        let mode = translate(look, "cc.grid.mode", "Edit mode");
        let message = self.error_text(look);
        if message.is_empty() {
            mode
        } else {
            format!("{mode}. {message}")
        }
    }
    /// Stable names stay on the wire; only reader-facing labels are translated.
    pub(super) fn action_label(name: &str, look: Option<&Look>) -> String {
        let key = match name {
            "Move up" => "cc.action.move-up",
            "Move down" => "cc.action.move-down",
            "Move left" => "cc.action.move-left",
            "Move right" => "cc.action.move-right",
            "Resize" => "cc.action.resize",
            "Remove" => "cc.menu.remove",
            _ => return name.into(),
        };
        translate(look, key, name)
    }
    pub fn write_finished(&mut self, serial: u64, result: Result<(), String>) -> bool {
        if serial != self.write_serial {
            return false;
        }
        self.pending = false;
        self.error = result.err().unwrap_or_default();
        true
    }
    pub fn controls_nodes(
        &self,
        first: u64,
        look: Option<&Look>,
    ) -> Vec<(nk_a11y::Node, super::Target)> {
        use nk_a11y::{Action, Bounds, Node, Role};
        let mut out = vec![];
        if self.active {
            for p in &self.tiles {
                let i = layout::REGISTRY
                    .iter()
                    .position(|m| m.id == p.tile.id)
                    .unwrap();
                let mut n = Node::new(
                    first + SEMANTIC_BASE + 10000 + i as u64 * 16,
                    Role::Button,
                    look.map_or(p.tile.id.to_owned(), |l| {
                        l.text_of(&crate::menu::Label::Key(name_key(p.tile.id)))
                    }),
                );
                n.bounds = Bounds {
                    x: p.rect[0],
                    y: p.rect[1],
                    width: p.rect[2],
                    height: p.rect[3],
                };
                n.states.disabled = self.pending;
                n.actions = if self.pending {
                    vec![Action::Focus]
                } else {
                    vec![Action::Activate, Action::Focus]
                };
                for name in ["Move up", "Move down", "Move left", "Move right", "Resize"] {
                    if !self.pending {
                        n.actions.push(Action::Named(name));
                    }
                }
                if !layout::meta_of(p.tile.id).unwrap().fixed && !self.pending {
                    n.actions.push(Action::Named("Remove"));
                }
                for action in &n.actions {
                    if let Action::Named(name) = action {
                        n.action_labels
                            .insert((*name).into(), Self::action_label(name, look));
                    }
                }
                n.states.focused = self.focus == Some(Target::Tile(p.tile.id));
                n.states.offscreen = !intersects(p.rect, self.viewport);
                out.push((n, super::Target::Edit(Target::Tile(p.tile.id))));
            }
        }
        for c in &self.controls {
            let ordinal = match c.target {
                Target::Toggle => 0,
                Target::Tile(_) => continue,
                Target::Remove(id) => 100 + index(id),
                Target::Add(id) => 200 + index(id),
                Target::Size(id, size) => {
                    300 + index(id) * 4
                        + layout::meta_of(id)
                            .unwrap()
                            .supported
                            .iter()
                            .position(|s| *s == size)
                            .unwrap() as u64
                }
            };
            let mut n = Node::new(
                first + SEMANTIC_BASE + 20000 + ordinal,
                if c.target == Target::Toggle {
                    Role::ToggleButton
                } else {
                    Role::Button
                },
                self.label(c, look),
            );
            n.bounds = Bounds {
                x: c.rect[0],
                y: c.rect[1],
                width: c.rect[2],
                height: c.rect[3],
            };
            n.states.disabled = c.disabled;
            n.states.checked = c.checked;
            n.states.focused = self.focus == Some(c.target);
            n.states.offscreen = c.target != Target::Toggle && !intersects(c.rect, self.viewport);
            if !c.disabled {
                n.actions = vec![Action::Activate, Action::Focus];
            }
            n.description = if c.disabled {
                Self::full_text(look)
            } else if self.active && c.target == Target::Toggle {
                look.map(|l| l.text_of(&crate::menu::Label::Key("cc.grid.mode")))
                    .filter(|v| v != "cc.grid.mode")
                    .unwrap_or_else(|| "Edit mode".into())
            } else {
                self.error_text(look)
            };
            out.push((n, super::Target::Edit(c.target)));
        }
        if !self.error.is_empty() {
            let mut n = Node::new(
                first + SEMANTIC_BASE + 25000,
                Role::Alert,
                self.error_text(look),
            );
            n.bounds = Bounds {
                x: self.panel[0] + PAD,
                y: self.panel[1] + self.panel[3] - 88.,
                width: self.panel[2] - 2. * PAD,
                height: 40.,
            };
            out.push((n, super::Target::Edit(Target::Toggle)));
        }
        out
    }
}
fn translate(look: Option<&Look>, key: &str, fallback: &str) -> String {
    look.and_then(|l| l.exports.text(key).ok())
        .map(str::to_owned)
        .unwrap_or_else(|| fallback.into())
}
fn index(id: &str) -> u64 {
    layout::REGISTRY.iter().position(|m| m.id == id).unwrap() as u64
}
fn intersects(a: [f64; 4], b: [f64; 4]) -> bool {
    a[0] < b[0] + b[2] && a[0] + a[2] > b[0] && a[1] < b[1] + b[3] && a[1] + a[3] > b[1]
}
impl Editor {
    fn slots(&self) -> Vec<[f64; 4]> {
        if !self.active {
            return vec![];
        }
        let occ = layout::occupancy(&self.tiles.iter().map(|p| p.tile).collect::<Vec<_>>(), &[]);
        (0..layout::ROWS)
            .flat_map(|y| (0..layout::COLS).map(move |x| (x, y)))
            .filter(|(x, y)| occ.free(*x, *y, Size::Single))
            .map(|(x, y)| {
                [
                    self.origin.0 + x as f64 * (layout::UNIT + layout::GAP),
                    self.origin.1 + y as f64 * (layout::UNIT + layout::GAP),
                    layout::UNIT,
                    layout::UNIT,
                ]
            })
            .collect()
    }
    pub fn glass(&self, tokens: &serde_json::Value, reduce: bool) -> Vec<Group> {
        let mut boxes: Vec<_> = self
            .slots()
            .into_iter()
            .map(|r| (r, 38., Some(self.viewport), 0.16))
            .collect();
        for c in &self.controls {
            if self.layered && matches!(c.target, Target::Remove(_)) && self.menu.is_none() {
                continue;
            }
            if self.menu_layered && self.menu.is_some() && c.target != Target::Toggle {
                continue;
            }
            if c.target != Target::Toggle && !intersects(c.rect, self.viewport) {
                continue;
            }
            boxes.push((
                c.rect,
                c.rect[3] / 2.,
                if c.target == Target::Toggle {
                    None
                } else {
                    Some(self.viewport)
                },
                1.,
            ));
        }
        boxes
            .into_iter()
            .filter_map(|(r, radius, clip, opacity)| {
                let pane = Pane {
                    x: r[0],
                    y: r[1],
                    width: r[2],
                    height: r[3],
                    radius,
                    exponent: 2.,
                    pointer: None,
                };
                let m = crate::material::piece(tokens, "controlCenter", true, reduce, pane)?;
                Some(Group {
                    tone: m.tone,
                    shadow: m.shadow,
                    shapes: vec![pane],
                    clip: clip.map(|r| MaterialRect {
                        x: r[0],
                        y: r[1],
                        width: r[2],
                        height: r[3],
                    }),
                    opacity,
                })
            })
            .collect()
    }
    pub fn paint_under(&self, c: &mut Canvas, base: Option<Color>) {
        if let Some(base) = base {
            c.clip(rect(self.viewport));
            for r in self.slots() {
                c.rounded_rect(rect(r), 38., base.multiply_alpha(0.16));
            }
            c.pop_clip();
        }
    }
    pub fn paint(
        &mut self,
        c: &mut Canvas,
        look: &mut Look,
        base: Option<Color>,
    ) -> nk_wayland::Result<()> {
        self.accent = look.styles.palette.accent.components.map(f64::from);
        self.accent[3] = 0.2;
        let style = TextStyle {
            size: 13.,
            ..look.styles.text.clone()
        };
        for item in &self.controls {
            if self.layered && matches!(item.target, Target::Remove(_)) && self.menu.is_none() {
                continue;
            }
            if self.menu_layered && self.menu.is_some() && item.target != Target::Toggle {
                continue;
            }
            if item.target != Target::Toggle {
                c.clip(rect(self.viewport));
            }
            if let Some(base) = base {
                c.rounded_rect(rect(item.rect), item.rect[3] / 2., base);
            }
            let label = self.label(item, Some(look));
            let value = if item.checked && matches!(item.target, Target::Size(..)) {
                format!("✓ {label}")
            } else {
                label
            };
            crate::notification_card::text(
                c,
                look,
                &value,
                &style,
                [
                    item.rect[0] + 8.,
                    item.rect[1] + 6.,
                    item.rect[2] - 16.,
                    item.rect[3] - 8.,
                ],
                1,
                if item.disabled { 0.4 } else { 1. },
            )?;
            if item.target != Target::Toggle {
                c.pop_clip();
            }
        }
        if !self.error.is_empty() {
            crate::notification_card::text(
                c,
                look,
                &self.error_text(Some(look)),
                &style,
                [
                    self.panel[0] + PAD,
                    self.panel[1] + self.panel[3] - 88.,
                    self.panel[2] - 2. * PAD,
                    40.,
                ],
                2,
                1.,
            )?;
        }
        Ok(())
    }
    pub fn states(&self) -> Vec<StateRegion> {
        let mut out = vec![];
        if let Some(h) = &self.hold
            && let Some(preview) = &h.preview
            && let Some(&(x, y)) = preview.positions.get(h.id)
            && let Some(size) = preview.sizes.get(h.id).and_then(|s| Size::parse(s))
        {
            let r = layout::Tile {
                id: h.id,
                x,
                y,
                size,
            }
            .rect();
            let b = [self.origin.0 + r[0], self.origin.1 + r[1], r[2], r[3]];
            out.push(StateRegion {
                id: 45000,
                bounds: MaterialRect {
                    x: b[0],
                    y: b[1],
                    width: b[2],
                    height: b[3],
                },
                radius: if size == Size::Square {
                    38.
                } else {
                    b[2].min(b[3]) / 2.
                },
                wash: self.accent,
                fade_ms: 150,
            });
        }
        for (i, c) in self.controls.iter().enumerate() {
            if self.focus == Some(c.target) || self.hover == Some(c.target) {
                out.push(StateRegion {
                    id: 46000 + i as u32,
                    bounds: MaterialRect {
                        x: c.rect[0],
                        y: c.rect[1],
                        width: c.rect[2],
                        height: c.rect[3],
                    },
                    radius: c.rect[3] / 2.,
                    wash: [1., 1., 1., 0.12],
                    fade_ms: 150,
                });
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ready() -> (Editor, Status) {
        let mut editor = Editor::default();
        let status = Status::default();
        editor.active = true;
        editor.sync(&Default::default(), &status, 900., 36., 1080.);
        (editor, status)
    }
    #[test]
    fn translated_write_errors_have_two_lines_above_done_without_covering_the_grid() {
        let (mut editor, status) = ready();
        let stored = editor.stored.clone();
        editor.error = "cc.grid.write-changed".into();
        editor.sync(&stored, &status, 900., 36., 688.);
        let nodes = editor.controls_nodes(100, None);
        let alert = nodes
            .iter()
            .find(|(n, _)| n.role == nk_a11y::Role::Alert)
            .unwrap()
            .0
            .clone();
        let done = editor
            .controls
            .iter()
            .find(|c| c.target == Target::Toggle)
            .unwrap();
        assert!(alert.bounds.height >= 40.);
        assert!(alert.bounds.y >= editor.viewport[1] + editor.viewport[3]);
        assert!(alert.bounds.y + alert.bounds.height <= done.rect[1]);
        assert_eq!(alert.name, "Control Center layout changed; retry the edit");
        assert!(!editor.description(None).contains("cc.grid."));
    }

    #[test]
    fn arrows_at_the_grid_edge_are_silent_and_do_not_write() {
        let (mut editor, status) = ready();
        let before = editor.stored.clone();
        for (id, action) in [
            ("screenshot", "Move up"),
            ("media", "Move left"),
            ("volume", "Move right"),
        ] {
            assert!(editor.named(id, action, &status).is_none());
            assert!(editor.error.is_empty());
            assert!(!editor.pending);
            assert_eq!(editor.stored, before);
        }
    }
    #[test]
    fn a_wide_drop_past_the_cell_boundary_rolls_back_even_with_pointer_in_viewport() {
        let (mut editor, status) = ready();
        let before = editor.stored.clone();
        let tile = editor
            .tiles
            .iter()
            .find(|p| p.tile.id == "volume")
            .unwrap()
            .rect;
        let start = (tile[0] + 20., tile[1] + 20.);
        editor.press(start, &status);
        let point = (start.0 + 96., start.1);
        assert!(inside(editor.viewport, point));
        editor.motion(point, &status);
        assert!(!editor.hold.as_ref().unwrap().target_in_bounds);
        assert!(editor.release(&status).is_none());
        editor.sync(&before, &status, 900., 36., 1080.);
        assert_eq!(
            editor
                .tiles
                .iter()
                .find(|p| p.tile.id == "volume")
                .unwrap()
                .rect,
            tile
        );
        assert_eq!(editor.stored, before);
        assert!(editor.error.is_empty());
        assert!(!editor.pending);
        // A capacity refusal still explains itself instead of silently swallowing every None.
        assert!(editor.accept(None).is_none());
        assert_eq!(editor.error, "cc.menu.size-full");
    }
    #[test]
    fn success_unblocks_a_concurrent_echo_and_stale_replies_cannot_unlock_a_new_edit() {
        let (mut editor, status) = ready();
        let before = editor.stored.clone();
        let next = layout::remove(&before, &|id| available(id, &status), "screenshot").unwrap();
        editor.accept(Some(next.clone()));
        let serial = editor.write_serial;
        let mut rival = next.clone();
        rival.sizes.insert("media".into(), "1x1".into());
        editor.sync(&rival, &status, 900., 36., 1080.);
        assert!(editor.pending);
        assert!(editor.write_finished(serial, Ok(())));
        editor.sync(&rival, &status, 900., 36., 1080.);
        assert!(!editor.pending);
        assert_eq!(editor.stored, rival);
        assert!(
            !editor
                .controls
                .iter()
                .find(|c| c.target == Target::Toggle)
                .unwrap()
                .disabled
        );
        assert!(editor.action(Target::Add("screenshot"), &status).is_some());
        assert!(!editor.write_finished(serial, Ok(())));
        assert!(editor.pending);
        assert!(editor.write_finished(editor.write_serial, Err("cc.grid.write-failed".into())));
        assert!(!editor.pending);
    }

    #[test]
    fn scrolling_during_a_drag_retargets_the_cell_without_a_pointer_move_or_a_write() {
        let (mut editor, status) = ready();
        let before = editor.stored.clone();
        editor.sync(&before, &status, 900., 36., 688.);
        let tile = editor
            .tiles
            .iter()
            .find(|p| p.tile.id == "screenshot")
            .unwrap()
            .rect;
        let pointer = (tile[0] + 20., tile[1] + 30.);
        editor.press(pointer, &status);
        editor.motion((pointer.0, pointer.1 + 96.), &status);
        let first = editor
            .hold
            .as_ref()
            .unwrap()
            .preview
            .as_ref()
            .unwrap()
            .positions["screenshot"];
        assert!(editor.scroll(96., &status));
        let next = editor
            .hold
            .as_ref()
            .unwrap()
            .preview
            .as_ref()
            .unwrap()
            .positions["screenshot"];
        assert_eq!(next, (first.0, first.1 + 1));
        assert_eq!(editor.stored, before);
        assert!(!editor.pending);
    }

    #[test]
    fn dragging_is_preview_only_and_leaving_rolls_back_without_an_error() {
        let (mut editor, status) = ready();
        let tile = editor
            .tiles
            .iter()
            .find(|p| p.tile.id == "screenshot")
            .unwrap()
            .rect;
        let start = (tile[0] + 20., tile[1] + 30.);
        let before = editor.stored.clone();
        assert!(editor.press(start, &status).is_none());
        editor.motion((start.0 - 96., start.1 + 96.), &status);
        assert_eq!(editor.stored, before);
        assert!(!editor.pending);
        editor.sync(&before, &status, 900., 36., 1080.);
        let shown = editor
            .tiles
            .iter()
            .find(|p| p.tile.id == "screenshot")
            .unwrap();
        assert_eq!(
            (shown.rect[0], shown.rect[1]),
            (tile[0] - 96., tile[1] + 96.)
        );
        editor.motion((0., 0.), &status);
        assert!(editor.release(&status).is_none());
        editor.sync(&before, &status, 900., 36., 1080.);
        assert_eq!(
            editor
                .tiles
                .iter()
                .find(|p| p.tile.id == "screenshot")
                .unwrap()
                .rect,
            tile
        );
        assert!(editor.error.is_empty());
        assert!(!editor.pending);
    }
    #[test]
    fn final_echo_unlocks_editing_and_keeps_concurrent_bar_changes() {
        let (mut editor, status) = ready();
        let before = editor.stored.clone();
        let mut next = layout::remove(&before, &|id| available(id, &status), "screenshot").unwrap();
        assert!(matches!(
            editor.accept(Some(next.clone())),
            Some(Act::Layout(..))
        ));
        assert!(editor.action(Target::Add("screenshot"), &status).is_none());
        editor.sync(&before, &status, 900., 36., 1080.);
        assert!(editor.pending);
        next.placement.get_mut("screenshot").unwrap().0 = true;
        editor.sync(&next, &status, 900., 36., 1080.);
        assert!(!editor.pending);
        assert!(editor.stored.placement["screenshot"].0);
        assert_eq!(editor.write_serial, 1);
    }
}
