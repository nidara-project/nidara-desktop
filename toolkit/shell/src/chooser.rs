// SPDX-License-Identifier: LGPL-3.0-or-later
//! The window chooser (APPLICATIONS1-DOCK.md §8): a primary click on an app with two or
//! more visible windows shows them, each as its picture with its title, on a popup of the
//! dock's own surface (the same bounded placement as the menus). One is chosen with the
//! pointer, the arrows and Enter, or a screen reader; Escape or a click elsewhere closes
//! it. Only visible windows are offered: minimized ones keep their own slots.
//!
//! It is bounded: at most `COLUMNS` across, and when Hyalo gives it less height than its
//! rows need it scrolls with the wheel, never growing past the output. Pictures are taken
//! when it opens and refreshed at `REFRESH` while it stays open; a window with no picture
//! shows its app's icon, never an older frame.
use crate::popup::{Look, Outcome};
use nk_a11y::{Action, Bounds, Node, NodeId, Role, Tree};
use nk_render::{Canvas, ImageFit, Raster};
use nk_text::{Rect, TextBackend};
use nk_wayland::{
    LayerEvent, Material, MenuPopupPlacement, Pane, PopupEvent, PopupId, PopupPlacement, PopupSide,
    Window,
};
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const COLUMNS: usize = 4;
/// A picture's box, logical pixels (16:10).
pub const PICTURE: (f64, f64) = (192., 120.);
pub const PAD: f64 = 8.;
pub const TITLE: f64 = 20.;
pub const GAP: f64 = 4.;
pub const REFRESH: Duration = Duration::from_millis(500);
const LEFT_BUTTON: u32 = 0x110;

#[derive(Clone, Debug, PartialEq)]
pub struct Candidate {
    pub window: u64,
    pub title: String,
}

/// The grid: tile size, columns, rows, and the size it asks for.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Grid {
    pub columns: usize,
    pub rows: usize,
    pub tile: (f64, f64),
}
impl Grid {
    pub fn new(n: usize) -> Self {
        let columns = n.clamp(1, COLUMNS);
        Self {
            columns,
            rows: n.div_ceil(columns).max(1),
            tile: (PICTURE.0 + 2. * PAD, PICTURE.1 + GAP + TITLE + 2. * PAD),
        }
    }
    pub fn size(&self) -> (u32, u32) {
        (
            (self.columns as f64 * self.tile.0 + 2. * PAD).ceil() as u32,
            (self.rows as f64 * self.tile.1 + 2. * PAD).ceil() as u32,
        )
    }
    /// Tile `n`'s rectangle, before scrolling.
    pub fn tile(&self, n: usize) -> [f64; 4] {
        let (c, r) = (n % self.columns, n / self.columns);
        [
            PAD + c as f64 * self.tile.0,
            PAD + r as f64 * self.tile.1,
            self.tile.0,
            self.tile.1,
        ]
    }
    /// Which tile is at (x, y) of the content (scroll applied by the caller).
    pub fn hit(&self, n: usize, x: f64, y: f64) -> Option<usize> {
        (0..n).find(|&i| {
            let [tx, ty, tw, th] = self.tile(i);
            x >= tx && x < tx + tw && y >= ty && y < ty + th
        })
    }
    /// The arrows move along the grid, stopping at its edges; Home/End jump.
    pub fn moved(&self, n: usize, from: Option<usize>, sym: u32) -> Option<usize> {
        let last = n.checked_sub(1)?;
        let Some(at) = from else {
            return Some(0);
        };
        Some(match sym {
            LEFT => at.saturating_sub(1),
            RIGHT => (at + 1).min(last),
            UP => at.checked_sub(self.columns).unwrap_or(at),
            DOWN => (at + self.columns).min(last).max(at),
            HOME => 0,
            END => last,
            _ => return None,
        })
    }
}

const LEFT: u32 = 0xff51;
const UP: u32 = 0xff52;
const RIGHT: u32 = 0xff53;
const DOWN: u32 = 0xff54;
const HOME: u32 = 0xff50;
const END: u32 = 0xff57;
const RETURN: u32 = 0xff0d;
const KP_ENTER: u32 = 0xff8d;
const SPACE: u32 = 0x20;
const ESCAPE: u32 = 0xff1b;

pub struct Chooser {
    pub id: PopupId,
    pub anchor: Option<String>,
    pub side: PopupSide,
    pub rect: [i32; 4],
    app: String,
    candidates: Vec<Candidate>,
    grid: Grid,
    size: (u32, u32),
    /// Pictures by window, and the capture each one is waiting for.
    pictures: HashMap<u64, Arc<Raster>>,
    pub captures: HashMap<nk_wayland::CaptureId, u64>,
    asked: Instant,
    icon: Option<Arc<Raster>>,
    hover: Option<usize>,
    focus: Option<usize>,
    pressed: Option<usize>,
    scroll: f64,
    /// Where it was placed, and for which anchor: the body and its pointer follow both.
    placed: Option<([i32; 4], [i32; 4])>,
    /// The tiles' place in the popup, beside the pointer's room (bubble.rs).
    body: [f64; 4],
    material: Option<Material>,
    dirty: bool,
    first_id: NodeId,
}

pub struct Request {
    pub app: String,
    pub icon: Option<Arc<Raster>>,
    pub candidates: Vec<Candidate>,
    pub anchor: String,
    pub rect: [i32; 4],
    pub side: PopupSide,
    pub serial: Option<u32>,
    pub keyboard: bool,
    pub first_id: NodeId,
}

impl Chooser {
    pub fn open(w: &mut Window, r: Request) -> Result<Self, String> {
        let grid = Grid::new(r.candidates.len());
        let natural = grid.size();
        let size = crate::bubble::with_pointer(natural, r.side);
        let id = w.open_menu_popup(MenuPopupPlacement {
            placement: PopupPlacement {
                anchor: r.rect,
                size,
            },
            workarea: None,
            side: r.side,
            parent: None,
            grab_serial: r.serial,
        })?;
        let mut c = Self {
            id,
            anchor: Some(r.anchor),
            side: r.side,
            rect: r.rect,
            app: r.app,
            candidates: r.candidates,
            grid,
            size,
            pictures: HashMap::new(),
            captures: HashMap::new(),
            asked: Instant::now(),
            icon: r.icon,
            hover: None,
            focus: r.keyboard.then_some(0),
            pressed: None,
            scroll: 0.,
            placed: None,
            body: [0., 0., natural.0 as f64, natural.1 as f64],
            material: None,
            dirty: true,
            first_id: r.first_id,
        };
        c.capture(w);
        Ok(c)
    }

    /// While it stays open, fresh pictures at most every `REFRESH`, one round at a time.
    pub fn refresh(&mut self, w: &mut Window) {
        if self.captures.is_empty() && self.asked.elapsed() >= REFRESH {
            self.capture(w);
        }
    }

    /// Ask for every candidate's picture that is not already on its way.
    pub fn capture(&mut self, w: &mut Window) {
        self.asked = Instant::now();
        for c in &self.candidates {
            if self.captures.values().any(|w| *w == c.window) {
                continue;
            }
            match w.capture_window(
                &format!("{:x}", c.window),
                (crate::dock::THUMB_SIDE, crate::dock::THUMB_SIDE),
            ) {
                Ok(id) => {
                    self.captures.insert(id, c.window);
                }
                Err(e) => {
                    eprintln!("nidara-shell: no picture of window {:x}: {e:?}", c.window);
                    self.pictures.remove(&c.window);
                }
            }
        }
    }

    /// A capture's answer: true when it was this chooser's.
    pub fn captured(&mut self, id: nk_wayland::CaptureId, picture: Option<Raster>) -> bool {
        let Some(window) = self.captures.remove(&id) else {
            return false;
        };
        match picture {
            Some(p) => {
                self.pictures.insert(window, Arc::new(p));
            }
            // A failed frame shows the icon and title, never the previous picture.
            None => {
                self.pictures.remove(&window);
            }
        }
        self.dirty = true;
        true
    }

    /// The windows changed: drop the ones that went; with fewer than two left it closes.
    pub fn retain(&mut self, live: &[u64]) -> bool {
        let before = self.candidates.len();
        self.candidates.retain(|c| live.contains(&c.window));
        if self.candidates.len() != before {
            self.pictures.retain(|w, _| live.contains(w));
            self.focus = self
                .focus
                .map(|f| f.min(self.candidates.len().saturating_sub(1)));
            self.hover = None;
            self.dirty = true;
        }
        self.candidates.len() >= 2
    }

    pub fn follow(
        &mut self,
        w: &mut Window,
        rect: [i32; 4],
        side: PopupSide,
    ) -> Result<(), String> {
        if rect == self.rect && side == self.side {
            return Ok(());
        }
        (self.rect, self.side) = (rect, side);
        self.size = crate::bubble::with_pointer(self.grid.size(), side);
        w.reposition_popup_overlay(
            self.id,
            PopupPlacement {
                anchor: rect,
                size: self.size,
            },
            0,
        )
    }

    pub fn close(self, w: &mut Window) {
        w.close_menu_popup(self.id);
    }

    fn choose(&self, n: usize, serial: Option<u32>) -> Outcome {
        match self.candidates.get(n) {
            Some(c) => Outcome::Chosen(
                crate::menu::Command::Window {
                    verb: "focus-window",
                    id: c.window,
                },
                serial,
            ),
            None => Outcome::None,
        }
    }

    fn view_height(&self) -> f64 {
        self.body[3]
    }

    fn max_scroll(&self) -> f64 {
        (self.grid.size().1 as f64 - self.view_height()).max(0.)
    }

    /// Keep tile `n` in view.
    fn reveal(&mut self, n: usize) {
        let [_, y, _, h] = self.grid.tile(n);
        let view = self.view_height();
        if y - PAD < self.scroll {
            self.scroll = (y - PAD).max(0.);
        } else if y + h + PAD > self.scroll + view {
            self.scroll = (y + h + PAD - view).min(self.max_scroll());
        }
    }

    pub fn event(&mut self, event: PopupEvent) -> Result<Outcome, String> {
        Ok(self.handle(event))
    }

    fn handle(&mut self, event: PopupEvent) -> Outcome {
        let n = self.candidates.len();
        match event {
            PopupEvent::Done => return Outcome::Closed,
            PopupEvent::Configure => self.dirty = true,
            PopupEvent::FrameDone | PopupEvent::Repositioned(_) => {}
            PopupEvent::Key(key) => match key.sym {
                ESCAPE => return Outcome::Closed,
                RETURN | KP_ENTER | SPACE => {
                    if let Some(f) = self.focus {
                        return self.choose(f, key.serial);
                    }
                }
                sym => {
                    if let Some(to) = self.grid.moved(n, self.focus, sym) {
                        self.focus = Some(to);
                        self.reveal(to);
                        self.dirty = true;
                    }
                }
            },
            // The tiles sit in the body, beside the pointer's room.
            PopupEvent::Input(input) => match input {
                LayerEvent::Motion(x, y) => {
                    let (x, y) = (x - self.body[0], y - self.body[1]);
                    let hover = self.grid.hit(n, x, y + self.scroll);
                    if hover != self.hover {
                        self.hover = hover;
                        self.dirty = true;
                    }
                }
                LayerEvent::Leave => {
                    self.hover = None;
                    self.pressed = None;
                    self.dirty = true;
                }
                LayerEvent::Scroll(d) => {
                    let to = (self.scroll + d * 4.).clamp(0., self.max_scroll());
                    if to != self.scroll {
                        self.scroll = to;
                        self.hover = None;
                        self.dirty = true;
                    }
                }
                LayerEvent::Button {
                    button: LEFT_BUTTON,
                    pressed,
                    serial,
                    x,
                    y,
                    ..
                } => {
                    let (x, y) = (x - self.body[0], y - self.body[1]);
                    let at = self.grid.hit(n, x, y + self.scroll);
                    if pressed {
                        self.pressed = at;
                    } else if let Some(t) = self.pressed.take().filter(|t| Some(*t) == at) {
                        return self.choose(t, Some(serial));
                    }
                }
                _ => {}
            },
        }
        Outcome::None
    }

    pub fn owns(&self, id: NodeId) -> bool {
        id >= self.first_id && id < self.button(self.candidates.len())
    }

    pub fn request(&mut self, id: NodeId, activate: bool) -> Result<Outcome, String> {
        Ok(self.act(id, activate))
    }

    fn act(&mut self, id: NodeId, activate: bool) -> Outcome {
        let Some(n) = id.checked_sub(self.button(0)).map(|n| n as usize) else {
            return Outcome::None;
        };
        if n >= self.candidates.len() {
            return Outcome::None;
        }
        if activate {
            return self.choose(n, None);
        }
        self.focus = Some(n);
        self.reveal(n);
        self.dirty = true;
        Outcome::None
    }

    pub fn sync(&mut self, w: &mut Window, look: &mut Look) -> Result<bool, String> {
        let Some(geometry) = w.popup_overlay_geometry(self.id) else {
            return Ok(false);
        };
        if self.placed != Some((geometry, self.rect)) {
            self.placed = Some((geometry, self.rect));
            let (width, height) = (geometry[2].max(1) as f64, geometry[3].max(1) as f64);
            let radius = f64::from(look.styles.menu.radius);
            let (body, pane) = crate::bubble::place(geometry, self.rect, radius, 2.).unwrap_or((
                [0., 0., width, height],
                Pane {
                    x: 0.,
                    y: 0.,
                    width,
                    height,
                    radius,
                    exponent: 2.,
                    pointer: None,
                },
            ));
            self.body = body;
            self.scroll = self.scroll.min(self.max_scroll());
            self.material = look
                .panel
                .as_ref()
                .and_then(|p| p.at(pane.width.min(pane.height)).ok())
                .map(|mut m| {
                    m.shapes = vec![pane];
                    m
                });
            self.dirty = true;
        }
        if !self.dirty {
            return Ok(false);
        }
        let Some(frame) = w.popup_overlay_frame(self.id)? else {
            return Ok(false);
        };
        // The tiles fill the body; the pointer's room beside it stays clear.
        let (inner, at) = crate::bubble::inset(frame, self.body);
        let bytes = self.paint(inner, look)?;
        let bytes = crate::bubble::blit(frame, inner, at, &bytes);
        if w.paint_popup_overlay(self.id, frame, &bytes, self.material.as_ref())? {
            self.dirty = false;
            return Ok(true);
        }
        Ok(false)
    }

    fn paint(&self, f: nk_wayland::Frame, look: &mut Look) -> Result<Vec<u8>, String> {
        let menu = look.style.row.clone();
        let radius = f64::from(look.styles.menu.radius);
        let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
        let (width, height) = (f.width as f32, f.height as f32);
        if !(f.material && self.material.is_some()) {
            // No compositor glass: the menu's own opaque base (D5).
            c.rounded_rect(
                Rect {
                    x: 0.,
                    y: 0.,
                    width,
                    height,
                },
                radius,
                menu.background,
            );
        }
        let mut text = look.styles.text.clone();
        text.size *= menu.text_scale;
        text.weight = menu.weight;
        c.clip(Rect {
            x: 0.,
            y: 0.,
            width,
            height,
        });
        for (n, cand) in self.candidates.iter().enumerate() {
            let [x, y, tw, th] = self.grid.tile(n);
            let y = y - self.scroll;
            if y + th < 0. || y > height as f64 {
                continue;
            }
            let tile = Rect {
                x: x as f32,
                y: y as f32,
                width: tw as f32,
                height: th as f32,
            };
            let lit = self.hover == Some(n) || self.focus == Some(n);
            // The shell's menus fill the row under the pointer with the accent.
            if lit {
                c.rounded_rect(tile, f64::from(menu.row_radius), menu.accent);
            }
            let picture = Rect {
                x: (x + PAD) as f32,
                y: (y + PAD) as f32,
                width: PICTURE.0 as f32,
                height: PICTURE.1 as f32,
            };
            match self.pictures.get(&cand.window).or(self.icon.as_ref()) {
                Some(p) if self.pictures.contains_key(&cand.window) => {
                    c.image(p, picture, ImageFit::Contain)
                }
                Some(icon) => {
                    let side = (PICTURE.1 * 0.5) as f32;
                    c.image(
                        icon,
                        Rect {
                            x: picture.x + (picture.width - side) / 2.,
                            y: picture.y + (picture.height - side) / 2.,
                            width: side,
                            height: side,
                        },
                        ImageFit::Contain,
                    );
                }
                // No picture and no icon: a quiet placeholder, as the dock draws one.
                None => c.rounded_rect(picture, 8., menu.border_color),
            }
            let title = self.title(cand);
            let layout = look.text.layout(title, &text, PICTURE.0 as f32)?;
            let size = layout.measured_size();
            let tx = x + PAD + ((PICTURE.0 - size.width as f64) / 2.).max(0.);
            let ty = y + PAD + PICTURE.1 + GAP + ((TITLE - size.height as f64) / 2.).max(0.);
            c.clip(Rect {
                x: (x + PAD) as f32,
                y: (y + PAD + PICTURE.1) as f32,
                width: PICTURE.0 as f32,
                height: (GAP + TITLE) as f32,
            });
            c.layout(
                &layout,
                (tx as f32, ty as f32),
                if lit { menu.accent_text } else { menu.text },
            )?;
            c.pop_clip();
        }
        c.pop_clip();
        Ok(c.finish())
    }

    /// A list of buttons, one per window, for the dock's tree at the popup's place.
    pub fn semantics(&self, w: &Window) -> Option<Tree> {
        let (ox, oy) = w.menu_popup_origin(self.id)?;
        let (ox, oy) = (f64::from(ox) + self.body[0], f64::from(oy) + self.body[1]);
        let view = self.view_height();
        let mut list = Node::new(self.first_id + 1, Role::List, self.app.clone());
        list.bounds = Bounds {
            x: ox,
            y: oy,
            width: self.body[2],
            height: view,
        };
        let mut nodes = BTreeMap::new();
        for (n, cand) in self.candidates.iter().enumerate() {
            let id = self.button(n);
            let mut b = Node::new(id, Role::Button, self.title(cand).to_string());
            let [x, y, tw, th] = self.grid.tile(n);
            let y = y - self.scroll;
            b.bounds = Bounds {
                x: ox + x,
                y: oy + y,
                width: tw,
                height: th,
            };
            b.states.focused = self.focus == Some(n);
            b.states.offscreen = y + th <= 0. || y >= view;
            b.actions = vec![Action::Activate, Action::Focus];
            list.children.push(id);
            nodes.insert(id, b);
        }
        // The tree's root only carries the list into the dock's tree (dock.rs splices its
        // children under the dock's own root, as it does a menu's).
        let mut root = Node::new(self.first_id, Role::Panel, self.app.clone());
        root.children.push(list.id);
        nodes.insert(list.id, list);
        nodes.insert(self.first_id, root);
        Some(Tree {
            root: self.first_id,
            nodes,
        })
    }

    /// Node IDs: the root, the list, then one button per window.
    fn button(&self, n: usize) -> NodeId {
        self.first_id + 2 + n as NodeId
    }

    fn title<'a>(&'a self, c: &'a Candidate) -> &'a str {
        if c.title.trim().is_empty() {
            &self.app
        } else {
            &c.title
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_grid_is_bounded_across_and_grows_in_rows() {
        let g = Grid::new(2);
        assert_eq!((g.columns, g.rows), (2, 1));
        let g = Grid::new(9);
        assert_eq!((g.columns, g.rows), (COLUMNS, 3));
        let (w, h) = g.size();
        assert_eq!(w, (4. * (PICTURE.0 + 2. * PAD) + 2. * PAD) as u32);
        assert!(h > 3 * PICTURE.1 as u32);
        // Tile 5 is the second of the second row.
        let [x, y, _, _] = g.tile(5);
        assert_eq!((x, y), (PAD + g.tile.0, PAD + g.tile.1));
        assert_eq!(g.hit(9, x + 1., y + 1.), Some(5));
        assert_eq!(
            g.hit(9, 0., 0.),
            None,
            "the frame around the grid is no tile"
        );
    }

    #[test]
    fn arrows_move_on_the_grid_and_stop_at_its_edges() {
        let g = Grid::new(6); // 4 + 2
        assert_eq!(
            g.moved(6, None, RIGHT),
            Some(0),
            "the first key lands on the first"
        );
        assert_eq!(g.moved(6, Some(0), LEFT), Some(0));
        assert_eq!(g.moved(6, Some(3), RIGHT), Some(4));
        assert_eq!(g.moved(6, Some(1), DOWN), Some(5));
        assert_eq!(
            g.moved(6, Some(3), DOWN),
            Some(5),
            "down to a short row: its last"
        );
        assert_eq!(g.moved(6, Some(5), DOWN), Some(5));
        assert_eq!(g.moved(6, Some(5), UP), Some(1));
        assert_eq!(g.moved(6, Some(2), UP), Some(2));
        assert_eq!(g.moved(6, Some(2), END), Some(5));
        assert_eq!(g.moved(6, Some(4), HOME), Some(0));
        assert_eq!(g.moved(6, Some(4), 0x61), None);
        assert_eq!(g.moved(0, None, RIGHT), None);
    }
}
