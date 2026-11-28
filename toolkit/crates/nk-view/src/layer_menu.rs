// SPDX-License-Identifier: LGPL-3.0-or-later
//! An owner's list on a layer of its own surface (VIEW.md §13.9), for a surface that cannot
//! open popups: a lock surface has no `xdg_popup` (ext-session-lock), so the login and lock
//! screens' menus open here. The list is a synchronized subsurface over the surface, its
//! glass Hyalo's (`nidara-layers-v1`), so it sits on the content and never under it, as a
//! popup would.
//!
//! It is what `AppWindow`'s popup is, without the popup: the same rows, the same keys (the
//! arrows, Home and End move; Enter and Space choose; Escape closes; Tab closes and moves
//! on), the same panel glass by its short side, the same size (as wide as the owner and its
//! rows, as tall as its rows, never past the surface). What differs is only what a popup has
//! for free: where it goes (below the owner, above it when there is no room, kept inside the
//! surface) and the click outside it that closes it, which the surface's host reports.
//!
//! The host keeps one and routes to it: the layer's pointer events (`event`), the surface's
//! keys while it is open (`key`), a press elsewhere (`close`). A row chosen comes back as its
//! index, which `choose` hands to the owner as the popup's choice is.
use crate::components::{ListSpec, Request as ComponentRequest};
use crate::host::Glyphs;
use crate::state::{Activated, ViewState};
use crate::view::Key;
use crate::window::WindowLook;
use nk_text::TextBackend;
use nk_wayland::{LayerEvent, LayerId, Material, Pane, Result, Window};
use std::time::Instant;

/// Where the list's region ids start, clear of the surface's own view.
const MENU_ROOT: u32 = 2_000_000;
/// Between the owner and its list.
const GAP: f64 = 4.;

/// What a key did to the open list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuKey {
    /// Not the list's: the surface handles it.
    Ignored,
    /// The lit row moved; repaint.
    Moved,
    /// Row `n` was chosen.
    Choose(usize),
    /// Escape: close it.
    Close,
    /// Tab (`false`) or Shift+Tab (`true`): close it, and move the focus on from its owner.
    Tab(bool),
}

/// The row a key moves to, from row `at` of `n`: the arrows wrap, Home and End go to the ends.
pub(crate) fn step(sym: u32, at: usize, n: usize) -> Option<usize> {
    if n == 0 {
        return None;
    }
    match sym {
        0xff52 => Some((at + n - 1) % n),
        0xff54 => Some((at + 1) % n),
        0xff50 => Some(0),
        0xff57 => Some(n - 1),
        _ => None,
    }
}

/// The list's rows laid out in `view` at `width`, and how big they ask to be: at least
/// `width` wide (the owner's), as wide as the widest row, as tall as the rows, inside `room`.
pub(crate) fn measure(
    view: &mut ViewState,
    list: &ListSpec,
    width: f64,
    room: (f64, f64),
    scale: f64,
    look: &WindowLook,
    text: &mut dyn TextBackend,
) -> (f64, f64) {
    let edge = list.edge;
    let tokens = look.tokens.with_types(&look.types);
    let lay = |view: &mut ViewState, text: &mut dyn TextBackend, w: f64| {
        view.layout_in(
            &list.node,
            [edge, edge, (w - 2. * edge).max(1.), room.1.max(1.)],
            scale,
            tokens,
            text,
            Instant::now(),
        );
    };
    lay(view, text, width.max(2. * edge + 1.));
    let natural = view.natural_size(text).0 + 2. * edge;
    let width = width.max(natural).min(room.0).max(2. * edge + 1.);
    lay(view, text, width);
    let rows = view
        .placed()
        .iter()
        .find_map(|p| match p.what {
            crate::layout::What::Scroll { content, .. } if p.key == list.scroll => Some(content),
            _ => None,
        })
        .unwrap_or(0.);
    (width, (rows + 2. * edge).min(room.1).max(1.))
}

/// Row `n` of `owner`'s list chosen: the owner hears it as the popup's choice.
pub fn choose(state: &mut ViewState, owner: &Key, n: usize) -> Option<Activated> {
    let value = state.list(owner)?.items.get(n)?.value.clone();
    state.respond(owner, ComponentRequest::Set(value))
}

pub struct LayerMenu {
    id: LayerId,
    owner: Key,
    list: ListSpec,
    view: ViewState,
    /// Where it is on the surface, and its size.
    rect: [f64; 4],
    material: Option<Material>,
    dirty: bool,
}

impl LayerMenu {
    /// Opens `owner`'s list on a new layer of `window`: below the owner, or above it when
    /// there is no room below, kept inside `surface` (the surface's size). Opened from the
    /// keyboard (`keys`), its chosen row is lit from the start. `None` when the owner is not
    /// laid out, its list is empty or the compositor has no layers.
    #[allow(clippy::too_many_arguments)]
    pub fn open(
        window: &mut Window,
        state: &mut ViewState,
        owner: Key,
        list: &ListSpec,
        keys: bool,
        surface: (f64, f64),
        scale: f64,
        look: &WindowLook,
        text: &mut dyn TextBackend,
    ) -> Result<Option<Self>> {
        if !window.supports_layers() {
            return Ok(None);
        }
        let (Some(list), Some(r)) = (state.resolve_list(&owner, list), state.rect(&owner)) else {
            return Ok(None);
        };
        if list.items.is_empty() {
            return Ok(None);
        }
        let mut view = ViewState::new(MENU_ROOT);
        let below = surface.1 - (r[1] + r[3] + GAP);
        let above = r[1] - GAP;
        let (w, h) = measure(
            &mut view,
            &list,
            r[2],
            (surface.0, below.max(above).max(1.)),
            scale,
            look,
            text,
        );
        let y = if h <= below || below >= above {
            r[1] + r[3] + GAP
        } else {
            r[1] - GAP - h
        };
        // Its left edge on the owner's, or its right edge on the owner's when that keeps it
        // on the surface (a bar's menu at the right of the screen).
        let x = if r[0] + w <= surface.0 {
            r[0]
        } else {
            (r[0] + r[2] - w).max(0.)
        };
        let id = window.create_layer((w.ceil() as u32, h.ceil() as u32))?;
        window.set_position(id, x.round(), y.round())?;
        window.set_layer_input_region(id, None)?;
        let row = list.items[list.selected].key.clone();
        view.request(&row, false);
        if !keys {
            view.hide_ring();
        }
        state.set_expanded(Some(owner.clone()));
        let material = look.panel.at(w.min(h)).ok().map(|mut g| {
            g.shapes = vec![Pane {
                x: 0.,
                y: 0.,
                width: w.ceil(),
                height: h.ceil(),
                radius: list.radius,
                exponent: 2.,
                pointer: None,
            }];
            g
        });
        window.set_layer_material(id, material.as_ref())?;
        Ok(Some(Self {
            id,
            owner,
            list,
            view,
            rect: [x.round(), y.round(), w.ceil(), h.ceil()],
            material,
            dirty: true,
        }))
    }

    pub fn owner(&self) -> &Key {
        &self.owner
    }

    /// The layer it is on, to route `Event::Layer` by.
    pub fn layer(&self) -> LayerId {
        self.id
    }

    /// Whether a point of the surface falls on the list.
    pub fn contains(&self, x: f64, y: f64) -> bool {
        let [rx, ry, w, h] = self.rect;
        x >= rx && y >= ry && x < rx + w && y < ry + h
    }

    /// The pointer on the list: a row under it lit, a row released on chosen.
    pub fn event(&mut self, event: LayerEvent) -> Option<usize> {
        match event {
            LayerEvent::Motion(x, y) => self.dirty |= self.view.pointer_motion(x, y),
            LayerEvent::Leave => self.dirty |= self.view.pointer_leave(),
            LayerEvent::Button { pressed, .. } => {
                let a = self.view.button(pressed, Instant::now());
                self.dirty = true;
                return a.and_then(|a| self.list.items.iter().position(|i| i.key == a.key));
            }
            LayerEvent::Scroll(amount) => self.dirty |= self.view.scroll(amount.into()),
            _ => {}
        }
        None
    }

    /// A key while it is open.
    pub fn key(&mut self, sym: u32) -> MenuKey {
        let n = self.list.items.len();
        let at = self
            .view
            .focus()
            .and_then(|key| self.list.items.iter().position(|i| &i.key == key))
            .unwrap_or(self.list.selected)
            .min(n.saturating_sub(1));
        if let Some(to) = step(sym, at, n) {
            // The keyboard takes over from the pointer: only its row is lit.
            self.view.pointer_leave();
            self.view.request(&self.list.items[to].key, false);
            self.dirty = true;
            return MenuKey::Moved;
        }
        match sym {
            0xff0d | 0xff8d | 0x20 => MenuKey::Choose(at),
            0xff1b => MenuKey::Close,
            0xff09 => MenuKey::Tab(false),
            0xfe20 => MenuKey::Tab(true),
            _ => MenuKey::Ignored,
        }
    }

    /// Whether its rows are still moving (a press fading), so the host keeps painting.
    pub fn animating(&self) -> bool {
        self.view.animating()
    }

    /// Paints the list when anything of it changed: its rows on the panel glass, its border
    /// drawn, and without the compositor's glass (D5) its own opaque ground. Called before the
    /// surface's redraw, which stages the layer with it.
    pub fn paint(
        &mut self,
        window: &mut Window,
        look: &WindowLook,
        text: &mut dyn TextBackend,
        glyphs: Option<&mut Glyphs>,
    ) -> Result<()> {
        let tokens = look.tokens.with_types(&look.types);
        if self.view.animating() {
            self.view.tick(tokens, text, Instant::now());
            self.dirty = true;
        }
        if !self.dirty {
            return Ok(());
        }
        let style = self.list.clone();
        let view = &self.view;
        let has_glass = self.material.is_some();
        let painted = window.paint_layer(self.id, |frame| {
            let mut c = nk_render::Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
            let whole = nk_text::Rect {
                x: 0.,
                y: 0.,
                width: frame.width as f32,
                height: frame.height as f32,
            };
            if !frame.material || !has_glass {
                let mut ground = style.background;
                ground.components[3] = 1.;
                c.rounded_rect(whole, style.radius, ground);
            }
            match glyphs {
                Some(g) => view.paint_with_glyphs(&mut c, tokens, g, None, false)?,
                None => view.paint(&mut c, tokens, &mut |_, _| None, None)?,
            }
            c.rounded_ring(whole, style.radius, style.border, style.border_color);
            Ok(c.finish())
        })?;
        if painted {
            self.dirty = false;
        }
        Ok(())
    }

    /// Closes it: the layer gone, the owner no longer expanded and the focus back on it,
    /// its ring shown only when the list was worked from the keyboard (`keys`).
    pub fn close(self, window: &mut Window, state: &mut ViewState, keys: bool) {
        let _ = window.destroy_layer(self.id);
        state.set_expanded(None);
        state.request(&self.owner, false);
        if !keys {
            state.hide_ring();
        }
    }
}
