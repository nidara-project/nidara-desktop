// SPDX-License-Identifier: LGPL-3.0-or-later
//! B2.3 edit mode on nk-view (VIEW.md §12.7). The editor keeps the model: the stored layout,
//! the hold and its preview (pure `cclayout` rules, no writes until commit), the write
//! barrier and the reader's named actions. Two views show it: the panel (a scroll region with
//! the grid and the widgets to add, the error, Edit/Done) and the size menu. They place,
//! hit-test, focus, wash and paint what the editor did by hand.
use super::*;
use nk_view::{Corner, Ink, Key, Node, Padding, Role, ScrollBy, Space, Wash};

const SEMANTIC_BASE: u64 = 1 << 48;
/// Where the panel's and the menu's washes start: past the detail's, the grid's and the
/// preview's.
const VIEW_REGIONS: u32 = 300_000;
const MENU_REGIONS: u32 = 310_000;
/// The held tile's drop cell.
const PREVIEW_REGION: u32 = 45000;
const MENU_W: f64 = 180.;
/// A menu row's pitch, as the hand-placed menu had it.
const MENU_ROW: f64 = 34.;
/// The remove badge: a circle over the tile's top-right corner, 25 in and 3 above.
const BADGE: f64 = 28.;
const SCROLL: &str = "e:s";
const GRID: &str = "e:g";
const DONE: &str = "e:done";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Toggle,
    Tile(&'static str),
    Remove(&'static str),
    Add(&'static str),
    Size(&'static str, Size),
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
    pub panel: [f64; 4],
    /// The scroll region's rect: what of the grid and the rows to add shows.
    pub viewport: [f64; 4],
    /// The grid's top-left, scrolled.
    pub origin: (f64, f64),
    pub(super) tiles: Vec<Placed>,
    pub accent: [f64; 4],
    /// The scroll region's offset, as last laid out or asked.
    offset: f64,
    view: nk_view::ViewState,
    menu_view: nk_view::ViewState,
    /// The menu on the panel's surface; its view is laid out `menu_shift` up and left of it
    /// (its own layer's origin in Hyalo, nothing without layers).
    menu_rect: Option<[f64; 4]>,
    menu_shift: (f64, f64),
    tokens: Option<nk_view::Tokens>,
    last: nk_view::Frame,
    menu_last: nk_view::Frame,
    /// A focus asked for before its control was laid out, and whether it shows its ring.
    want: Option<(Target, bool)>,
    /// The button the pointer pressed, acting on release over itself.
    pressed: Option<Target>,
}
impl Default for Editor {
    fn default() -> Self {
        let mut view = nk_view::ViewState::new(VIEW_REGIONS);
        // The editor places the tiles' glass; the view's panes stay where they are laid.
        view.set_slides(false);
        let mut menu_view = nk_view::ViewState::new(MENU_REGIONS);
        menu_view.set_slides(false);
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
            panel: [0.; 4],
            viewport: [0.; 4],
            origin: (0., 0.),
            tiles: vec![],
            accent: [1., 1., 1., 0.2],
            offset: 0.,
            view,
            menu_view,
            menu_rect: None,
            menu_shift: (0., 0.),
            tokens: None,
            last: Default::default(),
            menu_last: Default::default(),
            want: None,
            pressed: None,
        }
    }
}

/// A target's control: whether the menu holds it, and its key.
fn key_of(t: Target, open: Option<&'static str>) -> (bool, Key) {
    match t {
        Target::Toggle => (false, DONE.into()),
        Target::Tile(id) => (false, format!("e:t:{id}").into()),
        Target::Remove(id) if open == Some(id) => (true, "e:zx".into()),
        Target::Remove(id) => (false, format!("e:x:{id}").into()),
        Target::Add(id) => (false, format!("e:a:{id}").into()),
        Target::Size(_, size) => (true, format!("e:z:{}", size.stored()).into()),
    }
}
/// The target a control of the panel (`menu` false) or of the menu stands for.
fn target_of(key: &Key, menu: bool, open: Option<&'static str>) -> Option<Target> {
    let k = key.0.as_str();
    if menu {
        let id = open?;
        if k == "e:zx" {
            return Some(Target::Remove(id));
        }
        let size = Size::parse(k.strip_prefix("e:z:")?)?;
        return Some(Target::Size(id, size));
    }
    if k == DONE {
        return Some(Target::Toggle);
    }
    let (kind, id) = k.strip_prefix("e:")?.split_once(':')?;
    let id = layout::meta_of(id)?.id;
    Some(match kind {
        "t" => Target::Tile(id),
        "x" => Target::Remove(id),
        "a" => Target::Add(id),
        _ => return None,
    })
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
        let current = self.current().clone();
        let tiles = layout::layout(&current, &|id| available(id, status));
        let grid = self.grid_height(&tiles);
        let extra = if self.active {
            self.addable(status).len() as f64 * 36. + 32.
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
        self.place(tiles);
        self.tiles.clone()
    }
    fn grid_height(&self, tiles: &[layout::Tile]) -> f64 {
        let rows = if self.active {
            layout::ROWS
        } else {
            layout::rows(tiles).max(1)
        };
        rows as f64 * (layout::UNIT + layout::GAP) - layout::GAP
    }
    /// The widgets that can be added: present, and not in the grid.
    fn addable(&self, status: &Status) -> Vec<&'static layout::Meta> {
        let members = layout::members(self.current(), &|id| available(id, status));
        layout::REGISTRY
            .iter()
            .filter(|m| available(m.id, status) && !members.contains(&m.id))
            .collect()
    }
    /// The tiles on their cells from `origin`; the held one where the pointer has it.
    fn place(&mut self, tiles: Vec<layout::Tile>) {
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
    }
    fn replace(&mut self) {
        let tiles = self.tiles.iter().map(|p| p.tile).collect();
        self.place(tiles);
    }
    pub fn current(&self) -> &layout::Stored {
        self.hold
            .as_ref()
            .and_then(|h| h.preview.as_ref())
            .unwrap_or(&self.stored)
    }

    /// The panel's view and, while it is open, the menu's.
    pub(super) fn build(
        &self,
        status: &Status,
        look: Option<&Look>,
        base: &TextStyle,
    ) -> (Node, Option<Node>) {
        let style = TextStyle {
            size: 13.,
            ..base.clone()
        };
        let label = |key: &str, t: String| {
            Node::row(
                format!("{key}/row"),
                vec![Node::text(format!("{key}/t"), t, style.clone()).lines(1)],
            )
            .padding(Padding::symmetric(Space::S2, Space::S2))
        };
        let tiles: Vec<layout::Tile> = self.tiles.iter().map(|p| p.tile).collect();
        let content = if self.active {
            let mut cells = vec![];
            let occ = layout::occupancy(&tiles, &[]);
            for y in 0..layout::ROWS {
                for x in 0..layout::COLS {
                    if occ.free(x, y, Size::Single) {
                        cells.push(nk_view::Cell {
                            at: (x as usize, y as usize),
                            span: (1, 1),
                            child: Node::pane(
                                format!("e:f:{x}:{y}"),
                                Corner::Pill,
                                Node::spacer(format!("e:f:{x}:{y}/s")),
                            )
                            .opacity(0.16),
                        });
                    }
                }
            }
            for t in &tiles {
                let (w, h) = t.size.cells();
                cells.push(nk_view::Cell {
                    at: (t.x as usize, t.y as usize),
                    span: (w as usize, h as usize),
                    child: Node::control(
                        format!("e:t:{}", t.id),
                        translate(look, name_key(t.id), t.id),
                        "tile",
                        Node::spacer(format!("e:t:{}/s", t.id)),
                    )
                    // In Hyalo the tile's own layer draws it and its focus (§12.7).
                    .wash(Wash::None)
                    .corner(corner_of(t.size)),
                });
            }
            let grid = Node::grid(
                GRID,
                layout::COLS as usize,
                layout::UNIT,
                layout::GAP,
                cells,
            );
            let mut over = Node::overlay("e:o", grid);
            if self.menu.is_none() {
                for t in tiles
                    .iter()
                    .filter(|t| !layout::meta_of(t.id).is_some_and(|m| m.fixed))
                {
                    let r = t.rect();
                    let key = format!("e:x:{}", t.id);
                    over = over.layer_at(
                        r[0] + r[2] - 25.,
                        r[1] - 3.,
                        Node::pane(
                            format!("{key}/pane"),
                            Corner::Pill,
                            Node::control(
                                key.clone(),
                                "×",
                                "remove",
                                Node::slot(format!("{key}/s"), BADGE),
                            )
                            .enabled(!self.pending),
                        ),
                    );
                }
            }
            let rows: Vec<Node> = self
                .addable(status)
                .into_iter()
                .map(|m| {
                    let key = format!("e:a:{}", m.id);
                    if self.menu.is_some() {
                        // While the menu is open it and Done are the only controls; the rows
                        // keep their room so nothing under them moves.
                        let h = self.view.rect(&key.as_str().into()).map_or(32., |r| r[3]);
                        return Node::placeholder(key, h);
                    }
                    let fits = layout::add(&self.stored, &|id| available(id, status), m.id, None)
                        .is_some();
                    let text = format!(
                        "{} {}",
                        translate(look, "cc.grid.add", "Add"),
                        translate(look, name_key(m.id), m.id)
                    );
                    Node::pane(
                        format!("{key}/pane"),
                        Corner::Pill,
                        Node::control(key.clone(), text.clone(), "add", label(&key, text))
                            .enabled(fits && !self.pending),
                    )
                })
                .collect();
            Node::column(
                "e:c",
                vec![over, Node::column("e:add", rows).gap(Space::S1)],
            )
            .gap(Space::S6)
        } else {
            Node::placeholder(GRID, self.grid_height(&tiles))
        };
        let toggle = if self.active {
            translate(look, "cc.grid.done", "Done")
        } else {
            translate(look, "cc.grid.edit", "Edit")
        };
        let mut column = vec![Node::scroll(SCROLL, content).grow()];
        if !self.error.is_empty() {
            column.push(
                Node::text("e:err", self.error_text(look), style.clone())
                    .lines(2)
                    .reserve(2),
            );
        }
        column.push(Node::pane(
            "e:done/pane",
            Corner::Pill,
            Node::control(DONE, toggle.clone(), "toggle", label(DONE, toggle))
                .role(Role::Toggle)
                .marked(self.active)
                .enabled(!self.pending),
        ));
        let panel = Node::column("e", column).gap(Space::S3);
        let menu = self.menu.and_then(|id| {
            let meta = layout::meta_of(id)?;
            let mut rows = vec![];
            for size in meta.supported {
                let key = format!("e:z:{}", size.stored());
                let name = self.label(Target::Size(id, *size), look);
                let checked = tiles.iter().any(|t| t.id == id && t.size == *size);
                let fits = !self.pending
                    && layout::resize(&self.stored, &|id| available(id, status), id, *size)
                        .is_some();
                let shown = if checked {
                    format!("✓ {name}")
                } else {
                    name.clone()
                };
                let mut lines = vec![Node::text(format!("{key}/t"), shown, style.clone()).lines(1)];
                if !fits {
                    lines.push(
                        Node::text(
                            format!("{key}/why"),
                            Self::full_text(look),
                            TextStyle {
                                size: 10.,
                                ..base.clone()
                            },
                        )
                        .lines(1)
                        .ink(Ink::Dim),
                    );
                }
                rows.push(
                    Node::control(
                        key.clone(),
                        name,
                        "size",
                        Node::column(format!("{key}/c"), lines)
                            .padding(Padding::symmetric(Space::S1, Space::S2)),
                    )
                    .marked(checked)
                    .enabled(fits),
                );
            }
            if !meta.fixed {
                let name = translate(look, "cc.menu.remove", "Remove");
                rows.push(Node::control(
                    "e:zx",
                    name.clone(),
                    "remove",
                    label("e:zx", name),
                ));
            }
            Some(Node::pane(
                "e:menu",
                Corner::Fixed(16),
                Node::column("e:m", rows),
            ))
        });
        (panel, menu)
    }

    /// Lays the views out: the panel in its rect, the menu under its tile, kept in the
    /// viewport. The scroll region's offset may have moved (a wheel, a focus brought into
    /// view): the grid and the tiles follow it.
    pub(super) fn lay_out(
        &mut self,
        views: (Node, Option<Node>),
        tokens: &nk_view::Tokens,
        text: &mut dyn TextBackend,
        scale: f64,
    ) {
        let now = std::time::Instant::now();
        self.tokens = Some(tokens.clone());
        let inner = [
            self.panel[0] + PAD,
            self.panel[1] + PAD,
            layout::GRID_WIDTH,
            (self.panel[3] - PAD - 12.).max(0.),
        ];
        self.view
            .layout_in(&views.0, inner, scale, tokens, text, now);
        if let Some(r) = self.view.rect(&SCROLL.into()) {
            self.viewport = r;
        }
        self.offset = self.view.scroll_offset(&SCROLL.into()).unwrap_or(0.);
        if let Some(g) = self.view.rect(&GRID.into())
            && (g[0], g[1]) != self.origin
        {
            self.origin = (g[0], g[1]);
            self.replace();
        }
        self.menu_rect = None;
        if let (Some(menu), Some(id)) = (views.1, self.menu) {
            let rows = layout::meta_of(id).map_or(0, |m| m.supported.len() + usize::from(!m.fixed));
            let tile = self
                .tiles
                .iter()
                .find(|p| p.tile.id == id)
                .map_or(self.viewport, |p| p.rect);
            let v = self.viewport;
            let h = rows as f64 * MENU_ROW;
            let x = tile[0].clamp(v[0], (v[0] + v[2] - MENU_W).max(v[0]));
            let y = (tile[1] + 28.).clamp(v[1], (v[1] + v[3] - 144.).max(v[1]));
            // In Hyalo the menu is drawn on its own layer, over the tiles' layers.
            self.menu_shift = if self.layered { (x, y) } else { (0., 0.) };
            let at = [x - self.menu_shift.0, y - self.menu_shift.1, MENU_W, h];
            self.menu_view
                .layout_in(&menu, at, scale, tokens, text, now);
            self.menu_rect = Some([x, y, MENU_W, h]);
        } else {
            self.menu_view.blur();
            self.menu_view.pointer_leave();
        }
        if let Some((t, ring)) = self.want
            && self.request(t, ring)
        {
            self.want = None;
        }
        self.last = self.view.frame(tokens, now);
        if self.menu_rect.is_some() {
            self.menu_last = self.menu_view.frame(tokens, now);
        }
    }

    /// Focus on a control of either view; false when it is not laid out (yet).
    fn request(&mut self, t: Target, ring: bool) -> bool {
        let (in_menu, key) = key_of(t, self.menu);
        let (on, off) = if in_menu {
            (&mut self.menu_view, &mut self.view)
        } else {
            (&mut self.view, &mut self.menu_view)
        };
        on.request(&key, false);
        if on.focus() != Some(&key) {
            return false;
        }
        off.blur();
        if !ring {
            on.hide_ring();
        }
        true
    }
    /// The focused control, of either view.
    pub fn focus(&self) -> Option<Target> {
        self.menu_view
            .focus()
            .and_then(|k| target_of(k, true, self.menu))
            .or_else(|| {
                self.view
                    .focus()
                    .and_then(|k| target_of(k, false, self.menu))
            })
    }
    /// Focus moves to `t` (its ring shown when a key moved it), or leaves the editor.
    pub fn set_focus(&mut self, t: Option<Target>, ring: bool) {
        match t {
            None => {
                self.view.blur();
                self.menu_view.blur();
                self.want = None;
            }
            Some(t) => {
                if !self.request(t, ring) {
                    self.want = Some((t, ring));
                }
            }
        }
    }
    fn unscroll(&mut self) {
        self.view
            .scroll_region(&SCROLL.into(), ScrollBy::Pixels(-self.offset));
        self.offset = 0.;
    }

    pub fn toggle(&mut self) {
        if !self.pending {
            self.active = !self.active;
            self.menu = None;
            self.hold = None;
            self.pressed = None;
            self.unscroll();
            self.set_focus(Some(Target::Toggle), true);
        }
    }
    pub fn close(&mut self) {
        self.active = false;
        self.menu = None;
        self.hold = None;
        self.pressed = None;
        self.set_focus(None, false);
        self.unscroll();
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
                self.set_focus(Some(target), false);
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

    /// The control under `p` that acts: the menu's over everything while it is open, else
    /// the panel's innermost; a tile only in edit mode with no menu open.
    pub fn target(&self, p: (f64, f64)) -> Option<Target> {
        if let Some(r) = self.menu_rect
            && inside(r, p)
        {
            let q = (p.0 - self.menu_shift.0, p.1 - self.menu_shift.1);
            return hit(&self.menu_view, q).and_then(|k| target_of(&k, true, self.menu));
        }
        let t = hit(&self.view, p).and_then(|k| target_of(&k, false, self.menu))?;
        match t {
            Target::Toggle => Some(t),
            Target::Tile(_) if !self.active => None,
            _ if self.menu.is_some() => None,
            _ => Some(t),
        }
    }
    pub fn press(&mut self, p: (f64, f64), status: &Status) -> Option<Act> {
        let _ = status;
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
        self.set_focus(Some(target), false);
        if let Target::Tile(id) | Target::Add(id) = target
            && self.active
            && self.menu.is_none()
            && !self.pending
        {
            let added = matches!(target, Target::Add(_));
            let r = if added {
                self.view.rect(&key_of(target, None).1)?
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
        // A button: pressed in its view, it acts on release over itself.
        let now = std::time::Instant::now();
        if key_of(target, self.menu).0 {
            self.menu_view
                .pointer_motion(p.0 - self.menu_shift.0, p.1 - self.menu_shift.1);
            self.menu_view.button(true, now);
        } else {
            self.view.pointer_motion(p.0, p.1);
            self.view.button(true, now);
        }
        self.pressed = Some(target);
        None
    }
    pub fn motion(&mut self, p: (f64, f64), status: &Status) -> bool {
        if self.hold.is_none() {
            let mut changed = self.view.pointer_motion(p.0, p.1);
            changed |= if self.menu_rect.is_some() {
                self.menu_view
                    .pointer_motion(p.0 - self.menu_shift.0, p.1 - self.menu_shift.1)
            } else {
                self.menu_view.pointer_leave()
            };
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
    pub fn leave(&mut self) -> bool {
        self.view.pointer_leave() | self.menu_view.pointer_leave()
    }
    pub fn release(&mut self, status: &Status) -> Option<Act> {
        let now = std::time::Instant::now();
        if let Some(pressed) = self.pressed.take() {
            let in_menu = key_of(pressed, self.menu).0;
            let released = if in_menu {
                self.menu_view
                    .button(false, now)
                    .and_then(|a| target_of(&a.key, true, self.menu))
            } else {
                self.view
                    .button(false, now)
                    .and_then(|a| target_of(&a.key, false, self.menu))
            };
            return released
                .filter(|t| *t == pressed)
                .and_then(|t| self.action(t, status));
        }
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
    /// The scroll region moved by `delta` now: the grid and the tiles follow it.
    fn scroll_now(&mut self, delta: f64) -> bool {
        if !self
            .view
            .scroll_region(&SCROLL.into(), ScrollBy::Pixels(delta))
        {
            return false;
        }
        let to = self
            .view
            .scroll_offset(&SCROLL.into())
            .unwrap_or(self.offset);
        self.origin.1 -= to - self.offset;
        self.offset = to;
        self.replace();
        true
    }
    /// The wheel over the panel. A held tile is retargeted from where the grid is after it,
    /// without a pointer move or a write.
    pub fn scroll(&mut self, delta: f64, status: &Status) -> bool {
        if !self.scroll_now(delta) {
            return false;
        }
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
            self.set_focus(Some(Target::Toggle), true);
            return None;
        }
        if key.sym == 0xff09 || key.sym == 0xfe20 {
            let mut choices = vec![Target::Toggle];
            choices.extend(self.tiles.iter().map(|p| Target::Tile(p.tile.id)));
            choices.extend(
                self.enabled()
                    .into_iter()
                    .filter(|t| matches!(t, Target::Add(_) | Target::Size(..))),
            );
            let index = self
                .focus()
                .and_then(|t| choices.iter().position(|c| *c == t));
            let i = match index {
                Some(i) if key.shift || key.sym == 0xfe20 => {
                    (i + choices.len() - 1) % choices.len()
                }
                Some(i) => (i + 1) % choices.len(),
                None => 0,
            };
            self.reveal(choices[i]);
            self.set_focus(Some(choices[i]), true);
            return None;
        }
        let target = self.focus()?;
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
    /// The controls laid out and enabled, in the order they are laid: the panel's, then the
    /// menu's.
    fn enabled(&self) -> Vec<Target> {
        let of = |s: &nk_view::ViewState, menu: bool| -> Vec<Target> {
            s.placed()
                .iter()
                .filter(|n| matches!(&n.what, nk_view::What::Control(c) if c.enabled))
                .filter_map(|n| target_of(&n.key, menu, self.menu))
                .collect()
        };
        let mut out = of(&self.view, false);
        if self.menu_rect.is_some() {
            out.extend(of(&self.menu_view, true));
        }
        out
    }
    /// A tile focused from outside the view (the grid's Tab, a reader) is scrolled into the
    /// viewport; the view's own controls are brought in by their focus.
    pub fn reveal(&mut self, target: Target) {
        let Target::Tile(id) = target else {
            return;
        };
        let Some(r) = self.tiles.iter().find(|p| p.tile.id == id).map(|p| p.rect) else {
            return;
        };
        let v = self.viewport;
        let delta = if r[1] < v[1] {
            -(v[1] - r[1]).min(self.offset)
        } else if r[1] + r[3] > v[1] + v[3] {
            r[1] + r[3] - v[1] - v[3]
        } else {
            return;
        };
        self.scroll_now(delta);
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
    /// A control's rect on the panel's surface.
    fn rect_of(&self, t: Target) -> Option<[f64; 4]> {
        if let Target::Tile(id) = t {
            return self.tiles.iter().find(|p| p.tile.id == id).map(|p| p.rect);
        }
        let (in_menu, key) = key_of(t, self.menu);
        if !in_menu {
            return self.view.rect(&key);
        }
        let r = self.menu_view.rect(&key)?;
        Some([
            r[0] + self.menu_shift.0,
            r[1] + self.menu_shift.1,
            r[2],
            r[3],
        ])
    }
    pub fn controls_nodes(
        &self,
        first: u64,
        look: Option<&Look>,
    ) -> Vec<(nk_a11y::Node, super::Target)> {
        use nk_a11y::{Action, Bounds, Node, Role};
        let bounds = |r: [f64; 4]| Bounds {
            x: r[0],
            y: r[1],
            width: r[2],
            height: r[3],
        };
        let focus = self.focus();
        let mut out = vec![];
        if self.active {
            for p in &self.tiles {
                let i = index(p.tile.id);
                let mut n = Node::new(
                    first + SEMANTIC_BASE + 10000 + i * 16,
                    Role::Button,
                    translate(look, name_key(p.tile.id), p.tile.id),
                );
                n.bounds = bounds(p.rect);
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
                n.states.focused = focus == Some(Target::Tile(p.tile.id));
                n.states.offscreen = !intersects(p.rect, self.viewport);
                out.push((n, super::Target::Edit(Target::Tile(p.tile.id))));
            }
        }
        // Each control of either view, as laid out.
        let mut controls: Vec<(Target, bool, bool)> = vec![];
        let mut collect = |s: &nk_view::ViewState, menu: bool| {
            for n in s.placed() {
                if let nk_view::What::Control(c) = &n.what
                    && let Some(t) = target_of(&n.key, menu, self.menu)
                    && !matches!(t, Target::Tile(_))
                {
                    controls.push((t, c.enabled, c.marked));
                }
            }
        };
        collect(&self.view, false);
        if self.menu_rect.is_some() {
            collect(&self.menu_view, true);
        }
        for (target, enabled, checked) in controls {
            let ordinal = match target {
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
            let Some(r) = self.rect_of(target) else {
                continue;
            };
            let mut n = Node::new(
                first + SEMANTIC_BASE + 20000 + ordinal,
                if target == Target::Toggle {
                    Role::ToggleButton
                } else {
                    Role::Button
                },
                self.label(target, look),
            );
            n.bounds = bounds(r);
            n.states.disabled = !enabled;
            n.states.checked = checked;
            n.states.focused = focus == Some(target);
            n.states.offscreen = target != Target::Toggle
                && !key_of(target, self.menu).0
                && !intersects(r, self.viewport);
            if enabled {
                n.actions = vec![Action::Activate, Action::Focus];
            }
            n.description = if !enabled {
                Self::full_text(look)
            } else if self.active && target == Target::Toggle {
                translate(look, "cc.grid.mode", "Edit mode")
            } else {
                self.error_text(look)
            };
            out.push((n, super::Target::Edit(target)));
        }
        if !self.error.is_empty() {
            let mut n = Node::new(
                first + SEMANTIC_BASE + 25000,
                Role::Alert,
                self.error_text(look),
            );
            n.bounds = bounds(self.view.rect(&"e:err".into()).unwrap_or([
                self.panel[0] + PAD,
                self.panel[1] + self.panel[3] - 88.,
                self.panel[2] - 2. * PAD,
                40.,
            ]));
            out.push((n, super::Target::Edit(Target::Toggle)));
        }
        out
    }
    /// What a reader is told a control is called.
    fn label(&self, t: Target, look: Option<&Look>) -> String {
        match t {
            Target::Toggle => {
                if self.active {
                    translate(look, "cc.grid.done", "Done")
                } else {
                    translate(look, "cc.grid.edit", "Edit")
                }
            }
            Target::Add(id) => format!(
                "{} {}",
                translate(look, "cc.grid.add", "Add"),
                translate(look, name_key(id), id)
            ),
            Target::Remove(id) if self.menu == Some(id) => format!(
                "{} {}",
                translate(look, "cc.menu.remove", "Remove"),
                translate(look, name_key(id), id)
            ),
            Target::Remove(_) => "×".into(),
            Target::Size(_, size) => {
                let (key, fallback) = match size {
                    Size::Single => ("cc.menu.size.small", "Small"),
                    Size::Wide | Size::Tall => ("cc.menu.size.medium", "Medium"),
                    _ => ("cc.menu.size.large", "Large"),
                };
                translate(look, key, fallback)
            }
            Target::Tile(id) => translate(look, name_key(id), id),
        }
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
/// The innermost enabled control a view has under `p`, as it hit-tests.
fn hit(s: &nk_view::ViewState, p: (f64, f64)) -> Option<Key> {
    s.placed()
        .iter()
        .rfind(|n| match &n.what {
            nk_view::What::Control(c) => {
                c.enabled && c.pointer && n.visible().is_some_and(|r| inside(r, p))
            }
            _ => false,
        })
        .map(|n| n.key.clone())
}
fn base_rect(c: &mut Canvas, p: &nk_view::FramePane, base: Color) {
    if let Some(clip) = p.clip {
        c.clip(rect(clip));
    }
    c.rounded_rect(
        rect([p.pane.x, p.pane.y, p.pane.width, p.pane.height]),
        p.pane.radius,
        base.multiply_alpha(p.opacity as f32),
    );
    if p.clip.is_some() {
        c.pop_clip();
    }
}
impl Editor {
    /// A frame's panes as the CC's glass. In Hyalo the badges are on the tiles' own layers.
    fn groups(
        &self,
        frame: &nk_view::Frame,
        tokens: &serde_json::Value,
        reduce: bool,
    ) -> Vec<Group> {
        let Some(first) = frame.panes.first() else {
            return vec![];
        };
        let Some(m) = crate::material::piece(tokens, "controlCenter", true, reduce, first.pane)
        else {
            return vec![];
        };
        let panes = frame
            .panes
            .iter()
            .filter(|p| !(self.layered && p.key.0.starts_with("e:x:")))
            .cloned()
            .collect();
        nk_view::Frame {
            panes,
            states: vec![],
        }
        .groups(m.tone, m.shadow)
    }
    pub fn glass(&self, tokens: &serde_json::Value, reduce: bool) -> Vec<Group> {
        let mut out = self.groups(&self.last, tokens, reduce);
        if self.menu_rect.is_some() && !self.menu_layered {
            out.extend(self.groups(&self.menu_last, tokens, reduce));
        }
        out
    }
    /// Without the compositor's glass: the free cells' bases, under the tiles.
    pub fn paint_under(&self, c: &mut Canvas, base: Option<Color>) {
        let Some(base) = base else {
            return;
        };
        for p in self
            .last
            .panes
            .iter()
            .filter(|p| p.key.0.starts_with("e:f:"))
        {
            base_rect(c, p, base);
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
        let Some(tokens) = self.tokens.clone() else {
            return Ok(());
        };
        self.last = self.view.frame(&tokens, std::time::Instant::now());
        if let Some(base) = base {
            for p in self.last.panes.iter().filter(|p| {
                !p.key.0.starts_with("e:f:") && !(self.layered && p.key.0.starts_with("e:x:"))
            }) {
                base_rect(c, p, base);
            }
        }
        if let Err(e) = self.view.paint(
            c,
            &tokens,
            &mut |_, _| None,
            base.is_some().then_some(&self.last),
        ) {
            eprintln!("nidara-shell: the CC editor cannot be drawn: {e}");
        }
        if !self.layered {
            let badges: Vec<_> = self
                .view
                .placed()
                .iter()
                .filter(|n| n.key.0.starts_with("e:x:") && n.key.0.ends_with("/s"))
                .filter_map(|n| n.visible().map(|v| (n.rect, v, n.alpha)))
                .collect();
            for (r, visible, alpha) in badges {
                c.push_opacity(alpha);
                c.clip(rect(visible));
                crate::notification_card::text(
                    c,
                    look,
                    "×",
                    &TextStyle {
                        size: 16.,
                        ..look.styles.text.clone()
                    },
                    [r[0] + 8., r[1] + 2., 20., 24.],
                    1,
                    1.,
                )?;
                c.pop_clip();
                c.pop_opacity();
            }
        }
        if self.menu_rect.is_some() && !self.menu_layered {
            self.paint_menu(c, base);
        }
        Ok(())
    }
    /// The size menu, on its own layer in Hyalo or on the panel without layers.
    pub fn paint_menu(&mut self, c: &mut Canvas, base: Option<Color>) {
        let Some(tokens) = self.tokens.clone() else {
            return;
        };
        self.menu_last = self.menu_view.frame(&tokens, std::time::Instant::now());
        if let Some(base) = base {
            for p in &self.menu_last.panes {
                base_rect(c, p, base);
            }
        }
        if let Err(e) = self.menu_view.paint(
            c,
            &tokens,
            &mut |_, _| None,
            base.is_some().then_some(&self.menu_last),
        ) {
            eprintln!("nidara-shell: the CC size menu cannot be drawn: {e}");
        }
    }
    /// The menu on the panel's surface, while it is open.
    pub fn menu_rect(&self) -> Option<[f64; 4]> {
        self.menu_rect
    }
    /// The menu's washes, in its own layer's space.
    pub fn menu_states(&self) -> Vec<StateRegion> {
        self.menu_last.states.clone()
    }
    pub fn states(&self) -> Vec<StateRegion> {
        let mut out = self.last.states.clone();
        if self.menu_rect.is_some() && !self.menu_layered {
            out.extend(self.menu_last.states.iter().cloned());
        }
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
                id: PREVIEW_REGION,
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
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    /// The editor in edit mode, laid out as the panel lays it, with the exported tokens.
    fn ready() -> Option<(Editor, Status)> {
        let mut editor = Editor::default();
        let status = Status::default();
        editor.active = true;
        editor.sync(&Default::default(), &status, 900., 36., 1080.);
        relay(&mut editor, &status)?;
        Some((editor, status))
    }
    fn relay(editor: &mut Editor, status: &Status) -> Option<()> {
        let tokens = crate::nc_view::exported_tokens()?;
        let mut text =
            nk_text::ParleyBackend::new(Arc::new(nk_text::FontSet::discover_required().unwrap()))
                .unwrap();
        let views = editor.build(status, None, &TextStyle::default());
        editor.lay_out(views, &tokens, &mut text, 1.);
        Some(())
    }
    fn resync(editor: &mut Editor, stored: &layout::Stored, status: &Status, height: f64) {
        editor.sync(stored, status, 900., 36., height);
        relay(editor, status);
    }
    fn tile(editor: &Editor, id: &str) -> [f64; 4] {
        editor.tiles.iter().find(|p| p.tile.id == id).unwrap().rect
    }
    fn centre(r: [f64; 4]) -> (f64, f64) {
        (r[0] + r[2] / 2., r[1] + r[3] / 2.)
    }

    #[test]
    fn translated_write_errors_have_two_lines_above_done_without_covering_the_grid() {
        let Some((mut editor, status)) = ready() else {
            return;
        };
        let stored = editor.stored.clone();
        editor.error = "cc.grid.write-changed".into();
        resync(&mut editor, &stored, &status, 688.);
        let nodes = editor.controls_nodes(100, None);
        let alert = nodes
            .iter()
            .find(|(n, _)| n.role == nk_a11y::Role::Alert)
            .unwrap()
            .0
            .clone();
        let done = editor.view.rect(&DONE.into()).unwrap();
        assert!(alert.bounds.height >= 30., "two lines: {:?}", alert.bounds);
        assert!(alert.bounds.y >= editor.viewport[1] + editor.viewport[3]);
        assert!(alert.bounds.y + alert.bounds.height <= done[1]);
        assert_eq!(alert.name, "Control Center layout changed; retry the edit");
        assert!(!editor.description(None).contains("cc.grid."));
    }

    #[test]
    fn arrows_at_the_grid_edge_are_silent_and_do_not_write() {
        let Some((mut editor, status)) = ready() else {
            return;
        };
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
        let Some((mut editor, status)) = ready() else {
            return;
        };
        let before = editor.stored.clone();
        let r = tile(&editor, "volume");
        let start = (r[0] + 20., r[1] + 20.);
        editor.press(start, &status);
        let point = (start.0 + 96., start.1);
        assert!(inside(editor.viewport, point));
        editor.motion(point, &status);
        assert!(!editor.hold.as_ref().unwrap().target_in_bounds);
        assert!(editor.release(&status).is_none());
        resync(&mut editor, &before, &status, 1080.);
        assert_eq!(tile(&editor, "volume"), r);
        assert_eq!(editor.stored, before);
        assert!(editor.error.is_empty());
        assert!(!editor.pending);
        // A capacity refusal still explains itself instead of silently swallowing every None.
        assert!(editor.accept(None).is_none());
        assert_eq!(editor.error, "cc.menu.size-full");
    }
    #[test]
    fn success_unblocks_a_concurrent_echo_and_stale_replies_cannot_unlock_a_new_edit() {
        let Some((mut editor, status)) = ready() else {
            return;
        };
        let before = editor.stored.clone();
        let next = layout::remove(&before, &|id| available(id, &status), "screenshot").unwrap();
        editor.accept(Some(next.clone()));
        let serial = editor.write_serial;
        let mut rival = next.clone();
        rival.sizes.insert("media".into(), "1x1".into());
        resync(&mut editor, &rival, &status, 1080.);
        assert!(editor.pending);
        assert!(
            !editor.enabled().contains(&Target::Toggle),
            "Done waits for the write"
        );
        assert!(editor.write_finished(serial, Ok(())));
        resync(&mut editor, &rival, &status, 1080.);
        assert!(!editor.pending);
        assert_eq!(editor.stored, rival);
        assert!(
            editor.enabled().contains(&Target::Toggle),
            "and is usable again"
        );
        assert!(editor.action(Target::Add("screenshot"), &status).is_some());
        assert!(!editor.write_finished(serial, Ok(())));
        assert!(editor.pending);
        assert!(editor.write_finished(editor.write_serial, Err("cc.grid.write-failed".into())));
        assert!(!editor.pending);
    }

    #[test]
    fn scrolling_during_a_drag_retargets_the_cell_without_a_pointer_move_or_a_write() {
        let Some((mut editor, status)) = ready() else {
            return;
        };
        let before = editor.stored.clone();
        resync(&mut editor, &before, &status, 688.);
        let r = tile(&editor, "screenshot");
        let pointer = (r[0] + 20., r[1] + 30.);
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
        // The view lays the scrolled grid where the editor already has it.
        relay(&mut editor, &status);
        let g = editor.view.rect(&GRID.into()).unwrap();
        assert_eq!((g[0], g[1]), editor.origin);
    }

    #[test]
    fn dragging_is_preview_only_and_leaving_rolls_back_without_an_error() {
        let Some((mut editor, status)) = ready() else {
            return;
        };
        let r = tile(&editor, "screenshot");
        let start = (r[0] + 20., r[1] + 30.);
        let before = editor.stored.clone();
        assert!(editor.press(start, &status).is_none());
        editor.motion((start.0 - 96., start.1 + 96.), &status);
        assert_eq!(editor.stored, before);
        assert!(!editor.pending);
        resync(&mut editor, &before, &status, 1080.);
        let shown = tile(&editor, "screenshot");
        assert_eq!((shown[0], shown[1]), (r[0] - 96., r[1] + 96.));
        editor.motion((0., 0.), &status);
        assert!(editor.release(&status).is_none());
        resync(&mut editor, &before, &status, 1080.);
        assert_eq!(tile(&editor, "screenshot"), r);
        assert!(editor.error.is_empty());
        assert!(!editor.pending);
    }
    #[test]
    fn final_echo_unlocks_editing_and_keeps_concurrent_bar_changes() {
        let Some((mut editor, status)) = ready() else {
            return;
        };
        let before = editor.stored.clone();
        let mut next = layout::remove(&before, &|id| available(id, &status), "screenshot").unwrap();
        assert!(matches!(
            editor.accept(Some(next.clone())),
            Some(Act::Layout(..))
        ));
        assert!(editor.action(Target::Add("screenshot"), &status).is_none());
        resync(&mut editor, &before, &status, 1080.);
        assert!(editor.pending);
        next.placement.get_mut("screenshot").unwrap().0 = true;
        resync(&mut editor, &next, &status, 1080.);
        assert!(!editor.pending);
        assert!(editor.stored.placement["screenshot"].0);
        assert_eq!(editor.write_serial, 1);
    }

    #[test]
    fn the_panel_is_one_view_its_free_cells_glass_at_016_and_badges_on_removable_tiles() {
        let Some((editor, _)) = ready() else {
            return;
        };
        let g = editor.view.rect(&GRID.into()).unwrap();
        assert_eq!(
            editor.origin,
            (g[0], g[1]),
            "the tiles go where the view laid the grid"
        );
        assert_eq!(g[3], 8. * layout::UNIT + 7. * layout::GAP, "all eight rows");
        let free: Vec<_> = editor
            .last
            .panes
            .iter()
            .filter(|p| p.key.0.starts_with("e:f:"))
            .collect();
        assert!(!free.is_empty());
        assert!(free.iter().all(|p| p.opacity == 0.16));
        for p in &editor.tiles {
            let badge = editor
                .view
                .rect(&format!("e:x:{}", p.tile.id).as_str().into());
            if layout::meta_of(p.tile.id).unwrap().fixed {
                assert!(badge.is_none(), "{} is fixed", p.tile.id);
            } else {
                assert_eq!(
                    badge,
                    Some([p.rect[0] + p.rect[2] - 25., p.rect[1] - 3., BADGE, BADGE]),
                    "{}'s badge over its top-right corner",
                    p.tile.id
                );
            }
        }
        let done = editor.view.rect(&DONE.into()).unwrap();
        assert!(
            done[1] >= editor.viewport[1] + editor.viewport[3],
            "Done below the scroll"
        );
    }

    #[test]
    fn a_button_acts_on_release_over_itself_and_tab_walks_done_then_the_tiles() {
        let Some((mut editor, status)) = ready() else {
            return;
        };
        let done = editor.view.rect(&DONE.into()).unwrap();
        assert!(editor.press(centre(done), &status).is_none());
        assert!(editor.active, "nothing on the press");
        editor.motion((done[0] - 40., done[1] - 40.), &status);
        assert!(editor.release(&status).is_none());
        assert!(editor.active, "a release elsewhere does nothing");
        editor.motion(centre(done), &status);
        editor.press(centre(done), &status);
        editor.release(&status);
        assert!(!editor.active, "a release over Done leaves edit mode");
        editor.active = true;
        resync(&mut editor, &Default::default(), &status, 1080.);
        let tab = nk_wayland::Key {
            serial: None,
            sym: 0xff09,
            text: String::new(),
            shift: false,
            ctrl: false,
            alt: false,
        };
        editor.set_focus(None, false);
        editor.key(&tab, &status);
        assert_eq!(editor.focus(), Some(Target::Toggle));
        editor.key(&tab, &status);
        assert_eq!(editor.focus(), Some(Target::Tile(editor.tiles[0].tile.id)));
    }

    #[test]
    fn the_size_menu_is_its_own_view_under_its_tile_and_its_rows_act() {
        let Some((mut editor, status)) = ready() else {
            return;
        };
        let id = "media";
        assert!(editor.action(Target::Tile(id), &status).is_none());
        assert_eq!(editor.menu, Some(id));
        resync(&mut editor, &Default::default(), &status, 1080.);
        let menu = editor.menu_rect().unwrap();
        let t = tile(&editor, id);
        assert_eq!(menu[1], t[1] + 28., "under its tile");
        let v = editor.viewport;
        assert!(menu[0] >= v[0] && menu[0] + menu[2] <= v[0] + v[2]);
        // While it is open, it and Done are the only controls the pointer reaches.
        assert!(
            editor
                .view
                .rect(&format!("e:x:{id}").as_str().into())
                .is_none()
        );
        assert_eq!(
            editor.target((t[0] + 10., t[1] + 10.)),
            None,
            "a tile above it"
        );
        let small = editor.rect_of(Target::Size(id, Size::Single)).unwrap();
        assert_eq!(
            editor.target(centre(small)),
            Some(Target::Size(id, Size::Single))
        );
        editor.press(centre(small), &status);
        let act = editor.release(&status);
        assert!(matches!(act, Some(Act::Layout(..))), "{act:?}");
        assert_eq!(editor.menu, None);
    }
}
