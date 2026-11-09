// SPDX-License-Identifier: LGPL-3.0-or-later
//! The Control Center (B2.1, #959): a panel on the bar's own surface (#708: the bar is the
//! one surface every panel hangs from), hanging below the right group's glass, its tiles
//! laid out as the TS shell's grid (cclayout.rs) and drawn with the TS tiles' vocabulary
//! (`ui/shell/common/widget-kit/tile.ts`, `BaseIsland.tsx`): a 1×1 is a circle, a 2×1 a
//! capsule, a 2×2 a square with the Control Center's corner, a 4×1 a pill.
//!
//! Each tile is a pane of glass in the `controlCenter` tone, and the panel lies on its
//! fixed veil; what is ON (a tile's white, its badge's white) and the one hover are washes
//! Hyalo draws over that glass (commandment 12). The content is ours, in white ink, the
//! icon of something on in the accent.
//!
//! What a tile does here: the toggles toggle (Appearance, Night Light, Focus, Bluetooth),
//! the sliders move (volume, brightness), the player plays. A tile whose action is its
//! detail panel (Wi-Fi's body, screenshot, recording) opens it in B2.2.
#[path = "ccdetail.rs"]
pub mod detail;
#[path = "ccedit.rs"]
pub mod edit;

use crate::cclayout::{self as layout, Size, Tile};
use crate::popup::Look;
use crate::status::Status;
use nk_render::{Canvas, Color, ImageFit, Raster};
use nk_text::{Rect, TextBackend, TextStyle};
use nk_wayland::{Group, MaterialRect, Pane, StateRegion, Veil};
use std::collections::HashMap;
use std::sync::Arc;

/// The panel's content inset from its edge (`CC_PANEL_PAD`).
pub const PAD: f64 = 16.;
/// Below the bar's glass (`PANEL_HANG`).
pub const HANG: f64 = 8.;
/// A tile's content inset from its glass; a 1×2's fill reaches 2 from it.
const TILE_PAD: f64 = 10.;
const TALL_PAD: f64 = 2.;
/// The Control Center's corner: a 2×2's (owner, 2026-11-03: it stays 38).
pub const SQUARE_RADIUS: f64 = 38.;
/// The capsule's badge and its gap to the text (`CAPSULE_ICON_SIZE`, `_GAP`), from 4 in.
const BADGE: f64 = 44.;
const BADGE_GAP: f64 = 8.;
const BADGE_IN: f64 = 4.;
const ICON: f64 = 28.;
const TEXT: f32 = 14.;
const SMALL: f32 = 12.;
const BOLD: f32 = 700.;
/// Ink tiers of the dark skin: text, secondary, dim.
const SECONDARY: f32 = 0.8;
const DIM: f32 = 0.55;
/// `--nidara-surface`: a badge at rest.
const SURFACE: f64 = 0.08;
/// The one hover, 8 % ink (owner, 2026-10-06).
const HOVER: f64 = 0.08;
/// How long a wash eases to a new state.
const FADE_MS: u32 = 150;
/// The slider (kit `slider.ts`): track, thumb, the fill's opacity.
const TRACK: f64 = 6.;
const THUMB: f64 = 9.;

/// What a click can land on.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Target {
    Edit(edit::Target),
    Detail(u64),
    OpenDetail(&'static str),
    /// The whole tile: a toggle that is only a toggle.
    Tile(&'static str),
    /// A capsule's badge: the quick toggle of a tile whose body opens its detail.
    Badge(&'static str),
    Previous,
    PlayPause,
    Next,
    Slider(&'static str),
}

/// What the Control Center asks a service to do.
#[derive(Clone, Debug, PartialEq)]
pub enum Act {
    Layout(layout::Stored, layout::Stored),
    OpenDetail(&'static str),
    Detail(detail::Action),
    Dark(bool),
    Night(bool),
    Dnd(bool),
    Bluetooth {
        adapter: String,
        powered: bool,
    },
    /// `SelectedPrevious`, `SelectedPlayPause`, `SelectedNext` on Media1.
    Media(&'static str),
    /// 0..1.
    Volume(f64),
    Brightness {
        device: String,
        epoch: u64,
        raw: u32,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Placed {
    tile: Tile,
    /// Its glass, surface-local.
    rect: [f64; 4],
}

/// A slider held by the pointer: its tile and the value shown until the service says.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Drag {
    id: &'static str,
    value: f64,
}

pub struct Cc {
    pub editor: edit::Editor,
    tiles: Vec<Placed>,
    pub detail: Option<detail::Detail>,
    pub detail_height: f64,
    detail_generation: u64,
    detail_drag: Option<u64>,
    panel: [f64; 4],
    hover: Option<Target>,
    keyboard_focus: Option<Target>,
    drag: Option<Drag>,
    icons: Option<nk_icons::Icons>,
    glyphs: HashMap<(&'static str, u32), Option<Arc<nk_icons::Icon>>>,
    /// The cover being shown and its picture.
    art: Option<(String, Option<Arc<Raster>>)>,
}

impl Default for Cc {
    fn default() -> Self {
        Self::new()
    }
}

impl Cc {
    pub fn new() -> Self {
        Self {
            editor: Default::default(),
            tiles: vec![],
            detail: None,
            detail_height: 1080.,
            detail_generation: 0,
            detail_drag: None,
            panel: [0.; 4],
            hover: None,
            keyboard_focus: None,
            drag: None,
            icons: nk_icons::Icons::new("", &[], &crate::paths::icon_reference())
                .map_err(|e| eprintln!("nidara-shell: no icons for the Control Center: {e}"))
                .ok(),
            glyphs: HashMap::new(),
            art: None,
        }
    }

    /// The tiles for this frame, under the right group's glass ending at `right`.
    pub fn place(&mut self, right: f64, top: f64, status: &Status, stored: &layout::Stored) {
        self.tiles = self
            .editor
            .sync(stored, status, right, top, self.detail_height);
        self.panel = self.editor.panel;
        if let Some(detail) = &mut self.detail {
            detail.max_height = self.detail_height;
            detail.refresh(status, self.panel);
            self.panel = detail.panel;
        }
        if self
            .drag
            .is_some_and(|d| !self.tiles.iter().any(|p| p.tile.id == d.id))
        {
            self.drag = None;
        }
    }

    pub fn open_detail(&mut self, page: &'static str, status: &Status) {
        if self.editor.active {
            return;
        }
        self.detail_generation += 1;
        let mut detail = detail::Detail::new(page, self.detail_generation);
        detail.max_height = self.detail_height;
        detail.refresh(status, self.panel);
        self.panel = detail.panel;
        self.detail = Some(detail);
        self.drag = None;
    }
    pub fn view_id(&self) -> u64 {
        self.detail_generation
    }
    pub fn back(&mut self) -> bool {
        if self.editor.active {
            self.keyboard_focus = None;
            self.editor.toggle();
            return true;
        }
        self.detail_drag = None;
        let detail = self.detail.take();
        if let Some(detail) = detail {
            self.detail_generation += 1;
            self.editor.focus = None;
            self.keyboard_focus = Some(Target::OpenDetail(detail.page));
            true
        } else {
            false
        }
    }
    pub fn focus(&mut self, target: Target) {
        if let Target::Edit(t) = target {
            self.keyboard_focus = None;
            self.editor.focus = Some(t);
            self.editor.reveal(t);
            return;
        }
        if let Target::Detail(id) = target {
            if let Some(d) = &mut self.detail {
                d.focus_row(id);
                if d.rows
                    .iter()
                    .any(|r| r.id == id && matches!(r.action, Some(detail::Action::SecretFocus(_))))
                {
                    let _ = d.action(id, None);
                }
            }
        } else {
            self.editor.focus = None;
            self.keyboard_focus = Some(target);
            if let Target::Tile(id)
            | Target::OpenDetail(id)
            | Target::Slider(id)
            | Target::Badge(id) = target
            {
                self.editor.reveal(edit::Target::Tile(id));
            }
        }
    }
    pub fn key(&mut self, key: &nk_wayland::Key, status: &Status) -> Option<Act> {
        if self.editor.active {
            return self.editor.key(key, status);
        }
        if let Some(d) = &mut self.detail {
            return d.key(key).map(Act::Detail);
        }
        let choices: Vec<_> = self
            .nodes(0, status, None)
            .into_iter()
            .filter(|(n, _)| !n.actions.is_empty())
            .map(|(_, t)| t)
            .collect();
        if choices.is_empty() {
            return None;
        }
        if [0xff09, 0xfe20].contains(&key.sym) {
            let current = self
                .keyboard_focus
                .and_then(|f| choices.iter().position(|t| *t == f));
            let index = match current {
                Some(i) if key.shift || key.sym == 0xfe20 => {
                    (i + choices.len() - 1) % choices.len()
                }
                Some(i) => (i + 1) % choices.len(),
                None => 0,
            };
            self.focus(choices[index]);
            return None;
        }
        let target = self.keyboard_focus?;
        if let Target::Slider(id) = target
            && [0xff51, 0xff53, 0xff52, 0xff54].contains(&key.sym)
        {
            return set_value(
                id,
                (self.shown(id, status)
                    + if [0xff51, 0xff54].contains(&key.sym) {
                        -0.05
                    } else {
                        0.05
                    })
                .clamp(0., 1.),
                status,
            );
        }
        if [0xff0d, 0x20].contains(&key.sym) {
            return self.action(target, status, None);
        }
        None
    }
    pub fn action(&mut self, target: Target, status: &Status, value: Option<f64>) -> Option<Act> {
        match target {
            Target::Edit(t) => {
                self.keyboard_focus = None;
                self.editor.action(t, status)
            }
            Target::Detail(id) => self.detail.as_mut()?.action(id, value).map(Act::Detail),
            other => act_of(other, status),
        }
    }
    pub fn scroll_detail(&mut self, delta: f64, status: &Status) -> bool {
        if self.editor.active {
            return self.editor.scroll(delta * 32., status);
        }
        let Some(d) = &mut self.detail else {
            return self.editor.scroll(delta * 32., status);
        };
        d.scroll(delta);
        true
    }
    pub fn detail_at(&self, p: (f64, f64)) -> Option<&'static str> {
        if self.editor.active {
            return None;
        }
        if self.detail.is_none() && !inside(self.editor.viewport, p) {
            return None;
        }
        if let Some(d) = &self.detail {
            return Some(d.page);
        }
        if !inside(self.editor.viewport, p) {
            return None;
        }
        self.tiles
            .iter()
            .find(|t| inside(t.rect, p))
            .map(|t| t.tile.id)
            .filter(|id| has_detail(id))
    }
    pub fn panel(&self) -> [f64; 4] {
        self.panel
    }

    pub fn contains(&self, (x, y): (f64, f64)) -> bool {
        let p = self.panel;
        x >= p[0] && x < p[0] + p[2] && y >= p[1] && y < p[1] + p[3]
    }

    pub fn dragging(&self) -> bool {
        self.drag.is_some() || self.editor.dragging()
    }

    /// What is under `p`, when it does something.
    pub fn target_at(&self, p: (f64, f64)) -> Option<Target> {
        if self.detail.is_none()
            && let Some(t) = self.editor.target(p)
        {
            return Some(Target::Edit(t));
        }
        if self.editor.active {
            return None;
        }
        if let Some(d) = &self.detail {
            return d.target(p).map(Target::Detail);
        }
        if !inside(self.editor.viewport, p) {
            return None;
        }
        let placed = self.tiles.iter().find(|t| inside(t.rect, p))?;
        targets(placed)
            .into_iter()
            .find(|(_, r)| inside(*r, p))
            .map(|(t, _)| t)
    }

    /// The pointer moved: the hover, and a held slider's value.
    pub fn motion(&mut self, p: (f64, f64), status: &Status) -> (bool, Option<Act>) {
        if self.editor.active {
            return (self.editor.motion(p, status), None);
        }
        if let Some(detail) = &mut self.detail {
            let hover = detail.target(p);
            let changed = detail.hover != hover;
            detail.hover = hover;
            let act = self
                .detail_drag
                .and_then(|id| detail.pointer_action(id, p))
                .map(Act::Detail);
            return (changed || self.detail_drag.is_some(), act);
        }
        if let Some(d) = self.drag {
            let act = self.slide(d.id, p, status);
            return (true, act);
        }
        let hover = self.target_at(p);
        let changed = hover != self.hover;
        self.hover = hover;
        (changed, None)
    }

    pub fn leave(&mut self) -> bool {
        if let Some(d) = &mut self.detail {
            return d.hover.take().is_some();
        }
        self.hover.take().is_some()
    }

    /// A press on `p`: what it asks for.
    pub fn press(&mut self, p: (f64, f64), status: &Status) -> Option<Act> {
        if self.detail.is_none() && (self.editor.active || self.editor.target(p).is_some()) {
            self.keyboard_focus = None;
            return self.editor.press(p, status);
        }
        let target = self.target_at(p)?;
        match target {
            Target::Detail(id) => {
                let d = self.detail.as_mut()?;
                if d.rows.iter().any(|r| r.id == id && r.value.is_some()) {
                    self.detail_drag = Some(id);
                }
                d.pointer_action(id, p).map(Act::Detail)
            }
            Target::Slider(id) => {
                self.drag = Some(Drag {
                    id,
                    value: value_of(id, status),
                });
                self.slide(id, p, status)
            }
            other => act_of(other, status),
        }
    }

    pub fn release_edit(&mut self, status: &Status) -> Option<Act> {
        self.editor.release(status)
    }
    pub fn named(&mut self, target: Target, name: &str, status: &Status) -> Option<Act> {
        if let Target::Edit(edit::Target::Tile(id)) = target {
            self.editor.named(id, name, status)
        } else if let Target::Detail(id) = target {
            self.detail.as_mut()?.named(id, name).map(Act::Detail)
        } else {
            None
        }
    }
    pub fn context(&mut self, p: (f64, f64), _status: &Status) -> Option<Act> {
        if self.editor.active {
            if let Some(edit::Target::Tile(id)) = self.editor.target(p) {
                self.editor.menu = Some(id);
                self.editor.focus = Some(edit::Target::Tile(id));
            }
            None
        } else {
            self.detail_at(p).map(Act::OpenDetail)
        }
    }
    pub fn release(&mut self) -> bool {
        if let Some(d) = &mut self.detail {
            d.held = None;
        }
        self.detail_drag.take().is_some() | self.drag.take().is_some()
    }

    /// The slider's value under `p`, asked of its service.
    fn slide(&mut self, id: &'static str, p: (f64, f64), status: &Status) -> Option<Act> {
        let placed = *self.tiles.iter().find(|t| t.tile.id == id)?;
        let value = slider_value(&placed, p);
        if let Some(d) = self.drag.as_mut() {
            d.value = value;
        }
        set_value(id, value, status)
    }

    /// The value a slider shows: the held one while it is held.
    fn shown(&self, id: &str, status: &Status) -> f64 {
        match self.drag {
            Some(d) if d.id == id => d.value,
            _ => value_of(id, status),
        }
    }

    /// The tiles' glass, each a pane of the `controlCenter` piece stepped by its short
    /// side, and the veil under them.
    pub fn glass(
        &self,
        tokens: &serde_json::Value,
        reduce_transparency: bool,
    ) -> (Vec<Group>, Vec<Veil>) {
        if let Some(d) = &self.detail {
            let pane = Pane {
                x: d.panel[0],
                y: d.panel[1],
                width: d.panel[2],
                height: d.panel[3],
                radius: SQUARE_RADIUS,
                exponent: 2.,
                pointer: None,
            };
            let groups =
                crate::material::piece(tokens, "controlCenter", true, reduce_transparency, pane)
                    .map(|m| Group {
                        clip: None,
                        opacity: 1.,
                        tone: m.tone,
                        shadow: m.shadow,
                        shapes: vec![pane],
                    })
                    .into_iter()
                    .collect();
            return (
                groups,
                self.veil(tokens, reduce_transparency).into_iter().collect(),
            );
        }
        let mut groups: Vec<Group> = self
            .tiles
            .iter()
            .filter(|_| !self.editor.layered)
            .filter_map(|p| {
                let pane = pane_of(p);
                let m = crate::material::piece(
                    tokens,
                    "controlCenter",
                    true,
                    reduce_transparency,
                    pane,
                )?;
                Some(Group {
                    clip: Some(MaterialRect {
                        x: self.editor.viewport[0],
                        y: self.editor.viewport[1],
                        width: self.editor.viewport[2],
                        height: self.editor.viewport[3],
                    }),
                    opacity: 1.,
                    tone: m.tone,
                    shadow: m.shadow,
                    shapes: vec![pane],
                })
            })
            .collect();
        groups.extend(self.editor.glass(tokens, reduce_transparency));
        (
            groups,
            self.veil(tokens, reduce_transparency).into_iter().collect(),
        )
    }

    /// The fixed veil: the tiles' box, `inset` inside it.
    fn veil(&self, tokens: &serde_json::Value, reduce_transparency: bool) -> Option<Veil> {
        let v = tokens["variants"].as_array()?.iter().find(|v| {
            v["dark"].as_bool() == Some(true)
                && v["reduceTransparency"].as_bool() == Some(reduce_transparency)
        })?["veil"]
            .clone();
        let n = |k: &str| v[k].as_f64();
        let inset = n("inset")?;
        let x0 = self
            .tiles
            .iter()
            .map(|t| t.rect[0])
            .fold(f64::MAX, f64::min)
            + inset;
        let y0 = self
            .tiles
            .iter()
            .map(|t| t.rect[1])
            .fold(f64::MAX, f64::min)
            + inset;
        let x1 = self
            .tiles
            .iter()
            .map(|t| t.rect[0] + t.rect[2])
            .fold(f64::MIN, f64::max)
            - inset;
        let y1 = self
            .tiles
            .iter()
            .map(|t| t.rect[1] + t.rect[3])
            .fold(f64::MIN, f64::max)
            - inset;
        let (x0, y0, x1, y1) = if self.detail.is_some() || self.editor.active {
            let p = self.panel;
            (
                p[0] + inset,
                p[1] + inset,
                p[0] + p[2] - inset,
                p[1] + p[3] - inset,
            )
        } else {
            (x0, y0, x1, y1)
        };
        (x1 > x0 && y1 > y0 && n("strength")? > 0.).then(|| Veil {
            x: x0,
            y: y0,
            width: x1 - x0,
            height: y1 - y0,
            falloff: n("falloff").unwrap_or(0.),
            strength: n("strength").unwrap_or(0.),
            exponent: n("exponent").unwrap_or(1.),
        })
    }

    /// The washes over the glass: badges at rest, what is on, the hover. Every id is
    /// declared every time, so a change eases.
    pub fn states(&self, status: &Status) -> Vec<StateRegion> {
        if let Some(d) = &self.detail {
            return d.states();
        }
        if self.editor.active {
            return self.editor.states();
        }
        let mut out = vec![];
        for (i, p) in self.tiles.iter().enumerate() {
            let base = 1000 + i as u32 * 8;
            let id = p.tile.id;
            let on = active(id, status);
            let r = p.rect;
            let wash = |n: u32, b: [f64; 4], radius: f64, a: f64| StateRegion {
                id: base + n,
                bounds: MaterialRect {
                    x: b[0],
                    y: b[1],
                    width: b[2],
                    height: b[3],
                },
                radius,
                wash: [1., 1., 1., a],
                fade_ms: FADE_MS,
            };
            // The tile: white when a 1×1 toggle is on; else the hover of a whole-tile one.
            let whole = p.tile.size == Size::Single && toggles(id);
            let tile_hover = self.hover == Some(Target::Tile(id))
                || self.keyboard_focus == Some(Target::Tile(id))
                || self.keyboard_focus == Some(Target::OpenDetail(id));
            let a = if whole && on {
                1.
            } else if tile_hover {
                HOVER
            } else {
                0.
            };
            out.push(wash(0, r, radius_of(p), a));
            // The badge: the surface at rest, white when on.
            if let Some(b) = badge(p) {
                let a = if on && has_state(id) { 1. } else { SURFACE };
                out.push(wash(1, b, BADGE / 2., a));
                let lit = self.hover == Some(Target::Badge(id))
                    || self.keyboard_focus == Some(Target::Badge(id));
                out.push(wash(2, b, BADGE / 2., if lit { HOVER } else { 0. }));
            }
            // The player's buttons.
            for (n, (t, b)) in targets(p).into_iter().enumerate() {
                if matches!(t, Target::Previous | Target::PlayPause | Target::Next) {
                    let lit = self.hover == Some(t) || self.keyboard_focus == Some(t);
                    out.push(wash(
                        3 + n as u32,
                        b,
                        b[3] / 2.,
                        if lit { HOVER } else { 0. },
                    ));
                }
            }
        }
        out
    }

    fn icon(&mut self, name: &'static str, size: f64) -> Option<Arc<nk_icons::Icon>> {
        let px = size.round() as u32;
        let icons = &mut self.icons;
        self.glyphs
            .entry((name, px))
            .or_insert_with(|| {
                icons.as_mut().and_then(|i| {
                    i.get(name, px)
                        .map_err(|e| eprintln!("nidara-shell: no {name}: {e}"))
                        .ok()
                })
            })
            .clone()
    }

    /// The selected player's cover, decoded once per file.
    fn cover(&mut self, status: &Status) -> Option<Arc<Raster>> {
        let path = status.media.as_ref()?.art.clone()?;
        if self.art.as_ref().map(|(p, _)| p) != Some(&path) {
            let picture = decode(&path)
                .and_then(|(w, h, px)| Raster::from_rgba(w, h, px))
                .map_err(|e| eprintln!("nidara-shell: the cover {path}: {e}"))
                .ok()
                .map(Arc::new);
            self.art = Some((path, picture));
        }
        self.art.as_ref()?.1.clone()
    }

    /// Everything inside the panel. Without the compositor's glass, `fallback` is the
    /// tiles' own opaque base and the washes, painted here (D5).
    pub fn paint(
        &mut self,
        c: &mut Canvas,
        look: &mut Look,
        status: &Status,
        fallback: Option<Color>,
    ) -> nk_wayland::Result<()> {
        if let Some(d) = &self.detail {
            return d.paint(c, look, fallback);
        }
        self.editor.paint_under(c, fallback);
        c.clip(rect(self.editor.viewport));
        if let Some(base) = fallback.filter(|_| !self.editor.layered) {
            for p in self.tiles.clone() {
                c.rounded_rect(rect(p.rect), radius_of(&p), base);
            }
            for s in self.states(status) {
                let b = s.bounds;
                let w = s.wash;
                if w[3] > 0. {
                    c.rounded_rect(
                        rect([b.x, b.y, b.width, b.height]),
                        s.radius,
                        Color::new([w[0] as f32, w[1] as f32, w[2] as f32, w[3] as f32]),
                    );
                }
            }
        }
        if !self.editor.layered {
            for p in self.tiles.clone() {
                self.paint_one(c, look, p, status)?;
            }
        }
        c.pop_clip();
        self.editor.paint(c, look, fallback)?;
        Ok(())
    }

    fn paint_one(
        &mut self,
        c: &mut Canvas,
        look: &mut Look,
        p: Placed,
        status: &Status,
    ) -> nk_wayland::Result<()> {
        let accent = look.styles.palette.accent;
        let id = p.tile.id;
        let on = active(id, status);
        // On white, the icon is the accent; elsewhere white.
        let glyph = |whole_on: bool| if whole_on { accent } else { ink(1.) };
        match (id, p.tile.size) {
            ("cpu_memory", _) => {
                self.paint_resources(c, look, &p, status)?;
            }
            ("battery", _) => {
                self.paint_battery(c, look, &p, status)?;
            }
            ("media", size) => self.paint_media(c, look, &p, size, status)?,
            ("volume" | "brightness", Size::FullWidth) => self.paint_slider(c, look, &p, status)?,
            ("volume" | "brightness", Size::Tall) => self.paint_gauge(c, look, &p, status)?,
            (_, Size::Single) => {
                let whole_on = on && toggles(id);
                if let Some(i) = self.icon(icon_of(id, status), ICON) {
                    c.icon(&i, centred(p.rect, ICON), glyph(whole_on));
                }
            }
            _ => {
                let b = badge(&p).unwrap_or(p.rect);
                if let Some(i) = self.icon(icon_of(id, status), ICON) {
                    let lit = on && has_state(id);
                    c.icon(&i, centred(b, ICON), glyph(lit));
                }
                let (title, sub) = texts(id, status, look);
                let x = b[0] + BADGE + BADGE_GAP;
                let column = p.rect[0] + p.rect[2] - TILE_PAD - x;
                paint_titles(c, look, [x, p.rect[1], column, p.rect[3]], &title, &sub)?;
            }
        }
        Ok(())
    }
    pub fn edit_tiles(&self) -> Vec<(&'static str, [f64; 4], Size)> {
        self.tiles
            .iter()
            .map(|p| (p.tile.id, p.rect, p.tile.size))
            .collect()
    }
    pub fn paint_edit_layer(
        &mut self,
        id: &'static str,
        c: &mut Canvas,
        look: &mut Look,
        status: &Status,
    ) -> nk_wayland::Result<()> {
        let Some(mut placed) = self.tiles.iter().find(|p| p.tile.id == id).copied() else {
            return Ok(());
        };
        placed.rect[0] = 6.;
        placed.rect[1] = 6.;
        self.paint_one(c, look, placed, status)?;
        if !layout::meta_of(id).unwrap().fixed {
            crate::notification_card::text(
                c,
                look,
                "×",
                &TextStyle {
                    size: 16.,
                    ..look.styles.text.clone()
                },
                [placed.rect[2] - 14., 6., 20., 24.],
                1,
                1.,
            )?;
        }
        Ok(())
    }
    fn paint_media(
        &mut self,
        c: &mut Canvas,
        look: &mut Look,
        p: &Placed,
        size: Size,
        status: &Status,
    ) -> nk_wayland::Result<()> {
        let media = status.media.clone().unwrap_or_default();
        let title = if media.title.is_empty() {
            look.text_of(&crate::menu::Label::Key("cc.media.no-media"))
        } else {
            media.title.clone()
        };
        let cover = self.cover(status);
        let play = if media.playing {
            "nd-media-playback-pause"
        } else {
            "nd-media-playback-start"
        };
        let r = p.rect;
        let buttons = targets(p);
        let button = |t: Target| buttons.iter().find(|(x, _)| *x == t).map(|(_, b)| *b);
        let enabled = |t: Target| match t {
            Target::Previous => media.can_control && media.can_previous,
            Target::Next => media.can_control && media.can_next,
            _ => media.can_control,
        };
        let glyph = |c: &mut Canvas, me: &mut Self, t: Target, name: &'static str| {
            if let (Some(b), Some(i)) = (button(t), me.icon(name, 18.)) {
                let alpha = if enabled(t) { 1. } else { DIM };
                c.icon(&i, centred(b, 18.), ink(alpha));
            }
        };
        match size {
            Size::Single => match cover {
                Some(art) => {
                    let b = [r[0], r[1], r[2], r[3]];
                    c.clip_rounded_rect(rect(b), r[2] / 2.);
                    c.image(&art, rect(b), ImageFit::Cover);
                    c.pop_clip();
                }
                None => {
                    if let Some(i) = self.icon("nd-media-playback-start", 22.) {
                        c.icon(&i, centred(r, 22.), ink(1.));
                    }
                }
            },
            Size::Wide => {
                let art = [r[0] + TILE_PAD + 4., r[1] + (r[3] - 44.) / 2., 44., 44.];
                paint_cover(c, cover.as_deref(), art, 10.);
                let x = art[0] + 44. + 12.;
                let right = r[0] + r[2] - TILE_PAD - 4. - 32. - 12.;
                paint_titles(c, look, [x, r[1], right - x, r[3]], &title, &media.artist)?;
                glyph(c, self, Target::PlayPause, play);
            }
            _ => {
                let [art, title_box, artist_row, _] = square_media(r);
                let artist_y = artist_row[1];
                paint_cover(c, cover.as_deref(), art, 15.);
                let mut bold = style(look, TEXT, BOLD);
                bold.alignment = nk_text::Alignment::Center;
                let layout = lay_out(look, &title, &bold, title_box[2] as f32)?;
                let lines = layout.lines().len();
                let text = if lines > 2 {
                    fit(look, &title, &bold, title_box[2])
                } else {
                    title.clone()
                };
                let layout = lay_out(look, &text, &bold, title_box[2] as f32)?;
                let h = f64::from(layout.measured_size().height);
                let y = title_box[1] + (title_box[3] - h) / 2.;
                c.layout(&layout, (title_box[0] as f32, y as f32), ink(1.))?;
                let regular = style(look, TEXT, 400.);
                let artist = fit(look, &media.artist, &regular, title_box[2]);
                if !artist.is_empty() {
                    let l = lay_out(look, &artist, &regular, f32::MAX)?;
                    let w = f64::from(l.measured_size().width);
                    let x = r[0] + (r[2] - w) / 2.;
                    c.layout(&l, (x as f32, artist_y as f32), ink(SECONDARY))?;
                }
                glyph(c, self, Target::Previous, "nd-media-skip-backward");
                glyph(c, self, Target::PlayPause, play);
                glyph(c, self, Target::Next, "nd-media-skip-forward");
            }
        }
        Ok(())
    }

    /// A 4×1: low icon, the slider, high icon, the value.
    fn paint_slider(
        &mut self,
        c: &mut Canvas,
        look: &mut Look,
        p: &Placed,
        status: &Status,
    ) -> nk_wayland::Result<()> {
        let id = p.tile.id;
        let value = self.shown(id, status);
        let s = slider_parts(look, p);
        let (low, low_size, low_alpha, high) = if id == "brightness" {
            (
                "nd-display-brightness-low",
                14.,
                0.5,
                "nd-display-brightness",
            )
        } else {
            ("nd-audio-volume-low", 16., 0.6, "nd-audio-volume-high")
        };
        if let Some(i) = self.icon(low, low_size) {
            c.icon(&i, centred(s.low, low_size), ink(low_alpha));
        }
        if let Some(i) = self.icon(high, 16.) {
            c.icon(&i, centred(s.high, 16.), ink(0.6));
        }
        let t = s.track;
        let cy = t[1] + t[3] / 2.;
        let x0 = t[0] + THUMB;
        let x1 = t[0] + t[2] - THUMB;
        let at = x0 + (x1 - x0) * value;
        let bar = |a: f64, b: f64| rect([a - TRACK / 2., cy - TRACK / 2., b - a + TRACK, TRACK]);
        c.rounded_rect(bar(x0, x1), TRACK / 2., ink(0.18));
        c.rounded_rect(bar(x0, at), TRACK / 2., ink(0.9));
        let thumb = THUMB - 1.;
        let disc = |y: f64| rect([at - thumb, y - thumb, 2. * thumb, 2. * thumb]);
        c.rounded_rect(disc(cy + 1.), thumb, Color::new([0., 0., 0., 0.25]));
        let alpha = if self.drag.is_some_and(|d| d.id == id) {
            0.55
        } else {
            0.95
        };
        c.rounded_rect(disc(cy), thumb, ink(alpha));
        let label = format!("{}%", (value * 100.).round());
        let small = style(look, SMALL, 400.);
        let l = lay_out(look, &label, &small, f32::MAX)?;
        let size = l.measured_size();
        let x = s.value[0] + s.value[2] - f64::from(size.width);
        let y = s.value[1] + (s.value[3] - f64::from(size.height)) / 2.;
        c.layout(&l, (x as f32, y as f32), ink(DIM))?;
        Ok(())
    }

    /// A 1×2: the fill rises from the bottom; the value on top, the icon below, each dark
    /// where the white has reached it.
    fn paint_gauge(
        &mut self,
        c: &mut Canvas,
        look: &mut Look,
        p: &Placed,
        status: &Status,
    ) -> nk_wayland::Result<()> {
        let id = p.tile.id;
        let value = self.shown(id, status);
        let inner = inset(p.rect, TALL_PAD);
        let top = inner[1] + inner[3] * (1. - value);
        c.clip_rounded_rect(rect(inner), inner[2] / 2.);
        c.rect(
            rect([inner[0], top, inner[2], inner[1] + inner[3] - top]),
            ink(0.9),
        );
        c.pop_clip();
        let over = |y: f64| y >= top;
        let dark = Color::new([0., 0., 0., 0.85]);
        let label = format!("{}%", (value * 100.).round());
        let bold = style(look, TEXT, BOLD);
        let l = lay_out(look, &label, &bold, f32::MAX)?;
        let size = l.measured_size();
        let (lx, ly) = (
            p.rect[0] + (p.rect[2] - f64::from(size.width)) / 2.,
            inner[1] + 12.,
        );
        let ink_at = |y: f64| if over(y) { dark } else { ink(1.) };
        c.layout(
            &l,
            (lx as f32, ly as f32),
            ink_at(ly + f64::from(size.height) / 2.),
        )?;
        let name = if id == "brightness" {
            "nd-display-brightness"
        } else {
            status
                .volume
                .map_or("nd-audio-volume-high", crate::status::volume_icon)
        };
        let iy = inner[1] + inner[3] - 24. - ICON;
        if let Some(i) = self.icon(name, ICON) {
            let b = [p.rect[0] + (p.rect[2] - ICON) / 2., iy, ICON, ICON];
            c.icon(&i, rect(b), ink_at(iy + ICON / 2.));
        }
        Ok(())
    }

    /// What a reader is told: a panel holding a node per tile, ids from `first` on.
    fn paint_resources(
        &mut self,
        c: &mut Canvas,
        look: &mut Look,
        p: &Placed,
        s: &Status,
    ) -> nk_wayland::Result<()> {
        let (cpu, ram) = s.aux.resources.unwrap_or((0., 0.));
        let large = p.tile.size == Size::Square;
        let ring = if large { 56. } else { 34. };
        let single = p.tile.size == Size::Single;
        let cy = p.rect[1] + p.rect[3] / 2. - 10.;
        let cx = p.rect[0] + p.rect[2] / 2.;
        for (x, name, value) in if single {
            vec![(cx, "CPU", cpu)]
        } else {
            vec![(cx - 48., "CPU", cpu), (cx + 48., "RAM", ram)]
        } {
            c.progress_arc(
                (x, cy),
                ring / 2. - 3.,
                if large { 5. } else { 4. },
                1.,
                ink(0.18),
            );
            c.progress_arc(
                (x, cy),
                ring / 2. - 3.,
                if large { 5. } else { 4. },
                value,
                ink(1.),
            );
            let number = if s.aux.resources.is_some() {
                format!("{:.0}", value * 100.)
            } else {
                "—".into()
            };
            let number_style = TextStyle {
                size: if large { 18. } else { 12. },
                ..look.styles.text.clone()
            };
            let number_layout = lay_out(look, &number, &number_style, f32::MAX)?;
            let measured = number_layout.measured_size();
            c.layout(
                &number_layout,
                (
                    (x - f64::from(measured.width) / 2.) as f32,
                    (cy - f64::from(measured.height) / 2.) as f32,
                ),
                ink(1.),
            )?;
            crate::notification_card::text(
                c,
                look,
                name,
                &TextStyle {
                    size: 12.,
                    ..look.styles.text.clone()
                },
                [x - 18., cy + ring / 2. + 3., 40., 20.],
                1,
                0.8,
            )?;
        }
        Ok(())
    }
    fn paint_battery(
        &mut self,
        c: &mut Canvas,
        look: &mut Look,
        p: &Placed,
        s: &Status,
    ) -> nk_wayland::Result<()> {
        let Some(b) = s.battery else {
            return Ok(());
        };
        let single = p.tile.size == Size::Single;
        let glyph = if p.tile.size == Size::Square {
            56.
        } else {
            28.
        };
        let x = if single || p.tile.size == Size::Square {
            p.rect[0] + (p.rect[2] - glyph) / 2.
        } else {
            p.rect[0] + 18.
        };
        let y = p.rect[1] + (p.rect[3] - glyph) / 2.
            - if single {
                10.
            } else if p.tile.size == Size::Square {
                24.
            } else {
                0.
            };
        crate::bar::paint_battery(c, rect([x, y, glyph, glyph]), b);
        let text = if single || p.tile.size == Size::Square {
            [p.rect[0] + 14., y + glyph + 3., p.rect[2] - 28., 22.]
        } else {
            [
                x + glyph + 16.,
                p.rect[1] + 22.,
                p.rect[2] - glyph - 48.,
                24.,
            ]
        };
        crate::notification_card::text(
            c,
            look,
            &format!("{:.0}%", b.fraction * 100.),
            &TextStyle {
                size: 14.,
                ..look.styles.text.clone()
            },
            text,
            1,
            1.,
        )?;
        if !single {
            let b = if p.tile.size == Size::Square {
                [p.rect[0] + 12., text[1] + 25., p.rect[2] - 24., 40.]
            } else {
                [text[0], text[1] + 23., text[2], 32.]
            };
            let state = battery_text(s, Some(look));
            crate::notification_card::text(
                c,
                look,
                &state,
                &TextStyle {
                    size: 12.,
                    ..look.styles.text.clone()
                },
                b,
                2,
                0.65,
            )?;
        }
        Ok(())
    }
    pub fn nodes(
        &self,
        first: nk_a11y::NodeId,
        status: &Status,
        look: Option<&Look>,
    ) -> Vec<(nk_a11y::Node, Target)> {
        if let Some(d) = &self.detail {
            return d.nodes(first, look);
        }
        use nk_a11y::{Action, Bounds, Node, Role, ValueInfo};
        let text = |k: &'static str| {
            look.map_or(k.to_string(), |l| l.text_of(&crate::menu::Label::Key(k)))
        };
        let mut out = self.editor.controls_nodes(first, look);
        if self.editor.active {
            return out;
        }
        for (i, p) in self.tiles.iter().enumerate() {
            let id = p.tile.id;
            let semantic = layout::REGISTRY
                .iter()
                .position(|meta| meta.id == id)
                .unwrap_or(i);
            let nid = first + semantic as nk_a11y::NodeId * 8;
            let (title, sub) =
                look.map_or((id.to_string(), String::new()), |l| texts(id, status, l));
            let target = if id == "media" {
                Target::OpenDetail(id)
            } else {
                targets(p).first().map_or(Target::Tile(id), |(t, _)| *t)
            };
            let mut node = match target {
                Target::Slider(_) => {
                    let v = self.shown(id, status);
                    let mut n = Node::new(nid, Role::Slider, text(name_key(id)));
                    n.value = Some(ValueInfo {
                        min: 0.,
                        max: 100.,
                        current: (v * 100.).round(),
                        step: 5.,
                        text: format!("{}%", (v * 100.).round()),
                    });
                    n.actions = vec![Action::SetValue];
                    n
                }
                Target::Tile(_) | Target::Badge(_) if toggles(id) => {
                    let mut n = Node::new(nid, Role::ToggleButton, &title);
                    n.states.checked = active(id, status);
                    n.description = sub;
                    n.actions = vec![Action::Activate];
                    n
                }
                Target::PlayPause | Target::Previous | Target::Next => {
                    let mut n = Node::new(nid, Role::Button, &title);
                    n.description = status
                        .media
                        .as_ref()
                        .map_or(String::new(), |m| m.artist.clone());
                    n.actions = vec![Action::Activate];
                    n
                }
                // Its action is its detail panel (B2.2).
                _ => {
                    let mut n = Node::new(nid, Role::Button, &title);
                    n.description = sub;
                    n.actions = vec![Action::Activate];
                    n
                }
            };
            if id == "cpu_memory" {
                node.role = Role::Panel;
                node.actions.clear();
                node.description = status
                    .aux
                    .resources
                    .map_or("CPU / RAM".into(), |(cpu, ram)| {
                        format!("CPU {:.0}% · RAM {:.0}%", cpu * 100., ram * 100.)
                    });
            }
            node.bounds = Bounds {
                x: p.rect[0],
                y: p.rect[1],
                width: p.rect[2],
                height: p.rect[3],
            };
            node.id += match node.role {
                Role::ToggleButton => 1,
                Role::Slider => 2,
                _ => 0,
            };
            node.states.focused = self.keyboard_focus == Some(target);
            node.states.offscreen = !(p.rect[0]
                < self.editor.viewport[0] + self.editor.viewport[2]
                && p.rect[0] + p.rect[2] > self.editor.viewport[0]
                && p.rect[1] < self.editor.viewport[1] + self.editor.viewport[3]
                && p.rect[1] + p.rect[3] > self.editor.viewport[1]);
            if !node.actions.is_empty() && !node.actions.contains(&Action::Focus) {
                node.actions.push(Action::Focus);
            }
            out.push((node, target));
            if id == "media" {
                for (j, (target, bounds)) in targets(p)
                    .into_iter()
                    .filter(|(t, _)| {
                        matches!(t, Target::Previous | Target::PlayPause | Target::Next)
                    })
                    .enumerate()
                {
                    let key = match target {
                        Target::Previous => "cc.detail.previous",
                        Target::Next => "cc.detail.next",
                        _ => "cc.detail.play-pause",
                    };
                    let mut control = Node::new(
                        first + 2000 + semantic as u64 * 4 + j as u64,
                        Role::Button,
                        text(key),
                    );
                    let media = status.media.as_ref();
                    let enabled = media.is_some_and(|m| match target {
                        Target::Previous => m.can_previous,
                        Target::Next => m.can_next,
                        _ => m.can_control,
                    });
                    control.bounds = Bounds {
                        x: bounds[0],
                        y: bounds[1],
                        width: bounds[2],
                        height: bounds[3],
                    };
                    control.states.disabled = !enabled;
                    control.states.focused = self.keyboard_focus == Some(target);
                    if enabled {
                        control.actions = vec![Action::Activate, Action::Focus];
                    }
                    out.push((control, target));
                }
            }
            if has_detail(id) && target != Target::OpenDetail(id) {
                let mut detail = Node::new(
                    first + 1000 + semantic as u64 * 8,
                    Role::Button,
                    format!("{} · {}", text(name_key(id)), text("cc.detail.open")),
                );
                detail.bounds = Bounds {
                    x: p.rect[0],
                    y: p.rect[1],
                    width: p.rect[2],
                    height: p.rect[3],
                };
                detail.actions = vec![Action::Activate, Action::Focus];
                detail.states.focused = self.keyboard_focus == Some(Target::OpenDetail(id));
                out.push((detail, Target::OpenDetail(id)));
            }
        }
        out
    }

    /// A reader's value for a slider, 0..100.
    pub fn set_from_reader(
        &mut self,
        id: &'static str,
        percent: f64,
        status: &Status,
    ) -> Option<Act> {
        set_value(id, (percent / 100.).clamp(0., 1.), status)
    }
}

/// Whether a tile can be shown: its service there, its hardware present. A widget the
/// Rust shell does not draw yet (B2.3) is left out.
pub fn available(id: &str, s: &Status) -> bool {
    match id {
        "battery" => s.battery.is_some(),
        "clipboard" => crate::ccaux::clipboard_available(),
        "cpu_memory" => {
            std::path::Path::new("/proc/stat").exists()
                && std::path::Path::new("/proc/meminfo").exists()
        }
        "ethernet" => wired(s).is_some(),
        "vpn" => vpn_profiles(s).next().is_some(),
        "wifi" => s.wifi.is_some(),
        "bt" => s.bluetooth.is_some(),
        "brightness" => s.brightness.is_some(),
        "media" | "volume" | "screenshot" | "screenrecord" | "dark_mode" | "night_light"
        | "focus" => true,
        _ => false,
    }
}

/// On: what the tile's white (or its badge's) says.
pub fn active(id: &str, s: &Status) -> bool {
    use crate::status::Wifi;
    match id {
        "wifi" => matches!(s.wifi, Some(Wifi::Connected(_) | Wifi::Connecting)),
        "ethernet" => wired(s).is_some_and(|d| d["wiredEnabled"] == true),
        "vpn" => vpn_active(s).next().is_some(),
        "bt" => s.bluetooth.as_ref().is_some_and(|b| b.powered),
        "dark_mode" => s.dark,
        "night_light" => s.night.is_some_and(|n| n.enabled),
        "focus" => s.dnd,
        "screenrecord" => s.capture.running,
        _ => false,
    }
}

/// A tile with an on and an off: its badge (or its 1×1) wears it.
fn has_state(id: &str) -> bool {
    matches!(
        id,
        "wifi" | "bt" | "ethernet" | "dark_mode" | "night_light" | "focus"
    )
}

/// A tile that is a toggle: at 1×1 the whole tile is the button.
fn toggles(id: &str) -> bool {
    matches!(
        id,
        "bt" | "ethernet" | "dark_mode" | "night_light" | "focus"
    )
}

pub fn act_of(t: Target, s: &Status) -> Option<Act> {
    let id = match t {
        Target::Edit(_) => return None,
        Target::OpenDetail(id) => return Some(Act::OpenDetail(id)),
        Target::Detail(_) => return None,
        Target::Tile(id) | Target::Badge(id) => id,
        Target::Previous => return Some(Act::Media("SelectedPrevious")),
        Target::PlayPause => return Some(Act::Media("SelectedPlayPause")),
        Target::Next => return Some(Act::Media("SelectedNext")),
        Target::Slider(_) => return None,
    };
    Some(match id {
        "ethernet" => {
            let device = wired(s)?;
            let owner = s.details.network.as_ref()?.get("_serviceOwner")?.as_str()?;
            Act::Detail(detail::Action::Call {
                owner: owner.into(),
                action: Box::new(detail::Action::WiredPower(
                    device["path"].as_str()?.into(),
                    device["wiredEnabled"] != true,
                )),
            })
        }
        "dark_mode" => Act::Dark(!s.dark),
        "focus" => Act::Dnd(!s.dnd),
        "night_light" => Act::Night(!s.night?.enabled),
        "bt" => {
            let b = s.bluetooth.as_ref()?;
            Act::Bluetooth {
                adapter: b.adapter.clone(),
                powered: !b.powered,
            }
        }
        id if has_detail(id) => Act::OpenDetail(id),
        _ => return None,
    })
}

fn has_detail(id: &str) -> bool {
    matches!(
        id,
        "battery"
            | "clipboard"
            | "ethernet"
            | "vpn"
            | "wifi"
            | "bt"
            | "volume"
            | "media"
            | "brightness"
            | "night_light"
            | "screenshot"
            | "screenrecord"
    )
}

fn value_of(id: &str, s: &Status) -> f64 {
    match id {
        "volume" => s.volume.map_or(0., |v| v.level.clamp(0., 1.)),
        "brightness" => s.brightness.as_ref().map_or(0., |b| b.fraction()),
        _ => 0.,
    }
}

fn set_value(id: &str, value: f64, s: &Status) -> Option<Act> {
    match id {
        "volume" => Some(Act::Volume(value)),
        "brightness" => {
            let b = s.brightness.as_ref()?;
            Some(Act::Brightness {
                device: b.device.clone(),
                epoch: b.epoch,
                raw: b.raw(value),
            })
        }
        _ => None,
    }
}

/// The value under `p` on a placed slider: along its track (4×1) or up its fill (1×2).
fn slider_value(p: &Placed, (x, y): (f64, f64)) -> f64 {
    if p.tile.size == Size::Tall {
        let inner = inset(p.rect, TALL_PAD);
        return (1. - (y - inner[1]) / inner[3]).clamp(0., 1.);
    }
    let t = slider_track(p.rect, 0.);
    let (x0, x1) = (t[0] + THUMB, t[0] + t[2] - THUMB);
    ((x - x0) / (x1 - x0).max(1.)).clamp(0., 1.)
}

/// The pieces of a 4×1, left to right: low icon, track, high icon, the value's room.
struct SliderParts {
    low: [f64; 4],
    track: [f64; 4],
    high: [f64; 4],
    value: [f64; 4],
}

/// The value's room: five digits at the small size (`width_chars: 5`).
const VALUE_W: f64 = 36.;

fn slider_track(r: [f64; 4], value_w: f64) -> [f64; 4] {
    let x0 = r[0] + TILE_PAD + 4. + 16. + 12.;
    let x1 = r[0] + r[2] - TILE_PAD - 4. - value_w.max(VALUE_W) - 12. - 16. - 12.;
    [x0, r[1] + (r[3] - 2. * THUMB) / 2., x1 - x0, 2. * THUMB]
}

fn slider_parts(_look: &mut Look, p: &Placed) -> SliderParts {
    let r = p.rect;
    let cy = r[1] + r[3] / 2.;
    let icon = |x: f64| [x, cy - 8., 16., 16.];
    let track = slider_track(r, VALUE_W);
    let right = r[0] + r[2] - TILE_PAD - 4.;
    SliderParts {
        low: icon(r[0] + TILE_PAD + 4.),
        track,
        high: icon(track[0] + track[2] + 12.),
        value: [right - VALUE_W, r[1], VALUE_W, r[3]],
    }
}

/// What a tile's clicks land on, and where.
fn targets(p: &Placed) -> Vec<(Target, [f64; 4])> {
    let (id, size, r) = (p.tile.id, p.tile.size, p.rect);
    let mut out = match (id, size) {
        ("volume" | "brightness", Size::FullWidth) => {
            let t = slider_track(r, VALUE_W);
            vec![(Target::Slider(id), [t[0], r[1], t[2], r[3]])]
        }
        ("volume" | "brightness", Size::Tall) => vec![(Target::Slider(id), r)],
        ("media", Size::Wide) => {
            let b = [
                r[0] + r[2] - TILE_PAD - 4. - 32.,
                r[1] + (r[3] - 32.) / 2.,
                32.,
                32.,
            ];
            vec![(Target::PlayPause, b)]
        }
        ("media", Size::Square) => {
            let [_, _, _, controls] = square_media(r);
            let cx = r[0] + r[2] / 2.;
            let at = |dx: f64| [cx + dx - 12., controls[1], 24., 24.];
            vec![
                (Target::Previous, at(-40.)),
                (Target::PlayPause, at(0.)),
                (Target::Next, at(40.)),
            ]
        }
        (id, Size::Single) if toggles(id) => vec![(Target::Tile(id), r)],
        ("dark_mode" | "focus", _) => vec![(Target::Tile(id), r)],
        ("night_light" | "bt" | "ethernet", _) => {
            badge(p).map_or(vec![], |b| vec![(Target::Badge(id), b)])
        }
        _ => vec![],
    };
    if has_detail(id) {
        out.push((Target::OpenDetail(id), r));
    }
    out
}

/// A 2×2 player's parts: the cover, the title's box, the artist's top, the controls'
/// row — one group centred in the tile (`buildSquareContent`).
fn square_media(r: [f64; 4]) -> [[f64; 4]; 4] {
    const ART: f64 = 62.;
    const TITLE_W: f64 = 140.;
    const TITLE_H: f64 = 36.;
    const LINE: f64 = 18.;
    let h = ART + 2. + 2. + TITLE_H + 2. + LINE + 4. + 24.;
    let top = r[1] + (r[3] - h) / 2.;
    let cx = r[0] + r[2] / 2.;
    let art = [cx - ART / 2., top, ART, ART];
    let title = [cx - TITLE_W / 2., top + ART + 4., TITLE_W, TITLE_H];
    let artist_y = title[1] + TITLE_H + 2.;
    let controls = [r[0], artist_y + LINE + 4., r[2], 24.];
    [art, title, [0., artist_y, 0., 0.], controls]
}

/// A capsule's badge, for the sizes that have one.
fn badge(p: &Placed) -> Option<[f64; 4]> {
    let (id, size, r) = (p.tile.id, p.tile.size, p.rect);
    if matches!(id, "media" | "volume" | "brightness") || !matches!(size, Size::Wide | Size::Square)
    {
        return None;
    }
    Some([
        r[0] + TILE_PAD + BADGE_IN,
        r[1] + (r[3] - BADGE) / 2.,
        BADGE,
        BADGE,
    ])
}

pub(super) fn wired(s: &Status) -> Option<&serde_json::Value> {
    s.details.network.as_ref()?["devices"]
        .as_array()?
        .iter()
        .filter(|d| d["kind"] == 1)
        .max_by_key(|d| d["state"] == 100)
}
pub(super) fn vpn_profiles(s: &Status) -> impl Iterator<Item = &serde_json::Value> {
    s.details
        .network
        .as_ref()
        .and_then(|n| n["profiles"].as_array())
        .into_iter()
        .flatten()
        .filter(|p| matches!(p["type"].as_str(), Some("vpn" | "wireguard")))
}
pub(super) fn vpn_active(s: &Status) -> impl Iterator<Item = &serde_json::Value> {
    s.details
        .network
        .as_ref()
        .and_then(|n| n["active"].as_array())
        .into_iter()
        .flatten()
        .filter(|p| p["vpn"] == true || matches!(p["type"].as_str(), Some("vpn" | "wireguard")))
}
fn pane_of(p: &Placed) -> Pane {
    let r = p.rect;
    Pane {
        x: r[0],
        y: r[1],
        width: r[2],
        height: r[3],
        radius: radius_of(p),
        exponent: 2.,
        pointer: None,
    }
}

/// A 1×1 is a circle, a 2×1 or 1×2 a capsule, a 2×2 the corner; a 4×1 is not a capsule
/// but the dock's shape, its corner at the dock's default icon (owner, 2026-11-03).
fn radius_of(p: &Placed) -> f64 {
    let r = p.rect;
    match p.tile.size {
        Size::Square => SQUARE_RADIUS,
        Size::FullWidth => crate::geometry::capsule_radius(64.),
        _ => r[2].min(r[3]) / 2.,
    }
}

fn icon_of(id: &str, s: &Status) -> &'static str {
    match id {
        "battery" => "nd-battery",
        "cpu_memory" => "nd-cpu",
        "clipboard" => "nd-clipboard",
        "ethernet" => "nd-network-wired",
        "vpn" => {
            if vpn_active(s).next().is_some() {
                "nd-network-vpn"
            } else {
                "nd-network-vpn-disconnected"
            }
        }
        "wifi" => s
            .wifi
            .map_or("nd-network-wireless-disabled", crate::status::wifi_icon),
        "bt" => {
            if s.bluetooth.as_ref().is_some_and(|b| b.powered) {
                "nd-bluetooth-active"
            } else {
                "nd-bluetooth-disabled"
            }
        }
        "dark_mode" => {
            if s.dark {
                "nd-dark-mode"
            } else {
                "nd-light-mode"
            }
        }
        "night_light" => "nd-night-light",
        "focus" => {
            if s.dnd {
                "nd-notifications-disabled"
            } else {
                "nd-notifications"
            }
        }
        "screenshot" => "nd-screenshot",
        "screenrecord" => "nd-media-record",
        "volume" => s
            .volume
            .map_or("nd-audio-volume-high", crate::status::volume_icon),
        "brightness" => "nd-display-brightness",
        _ => "nd-media-playback-start",
    }
}

fn name_key(id: &str) -> &'static str {
    match id {
        "battery" => "widget.battery.name",
        "cpu_memory" => "widget.cpu-memory.name",
        "clipboard" => "widget.clipboard.name",
        "ethernet" => "cc.ethernet.name",
        "vpn" => "widget.vpn.name",
        "volume" => "cc.volume.name",
        "brightness" => "widget.brightness.name",
        "media" => "cc.media.name",
        "screenshot" => "widget.screenshot.name",
        "screenrecord" => "widget.screenrecord.name",
        "wifi" => "cc.wifi.name",
        "bt" => "widget.bluetooth.name",
        "dark_mode" => "widget.dark-mode.name",
        "night_light" => "widget.night-light.name",
        _ => "widget.focus.name",
    }
}

/// A capsule's title and subtitle, as the TS tiles word them.
fn texts(id: &str, s: &Status, look: &Look) -> (String, String) {
    use crate::status::Wifi;
    let t = |k: &'static str| look.text_of(&crate::menu::Label::Key(k));
    match id {
        "battery" => (
            t(name_key(id)),
            s.battery
                .map_or(String::new(), |b| format!("{:.0}%", b.fraction * 100.)),
        ),
        "clipboard" => (t(name_key(id)), format!("{}", s.aux.clips.len())),
        "cpu_memory" => (
            t(name_key(id)),
            s.aux.resources.map_or("—".into(), |(cpu, ram)| {
                format!("CPU {:.0}% · RAM {:.0}%", cpu * 100., ram * 100.)
            }),
        ),
        "ethernet" => (
            t(name_key(id)),
            wired(s).map_or("—".into(), |d| {
                format!(
                    "{} · {}",
                    d["interface"].as_str().unwrap_or(""),
                    if d["state"] == 100 {
                        "Connected"
                    } else if d["wiredEnabled"] != true {
                        "Off"
                    } else {
                        "Disconnected"
                    }
                )
            }),
        ),
        "vpn" => (
            t(name_key(id)),
            vpn_active(s)
                .next()
                .and_then(|a| a["uuid"].as_str())
                .and_then(|uuid| vpn_profiles(s).find(|p| p["uuid"] == uuid))
                .and_then(|p| p["name"].as_str())
                .unwrap_or("Disconnected")
                .into(),
        ),
        "wifi" => (
            t("cc.wifi.name"),
            match s.wifi {
                Some(Wifi::Connected(_)) => s.wifi_name.clone(),
                Some(Wifi::Connecting) if !s.wifi_name.is_empty() => s.wifi_name.clone(),
                Some(Wifi::Connecting) => t("settings.network.ap.connecting"),
                Some(Wifi::Disconnected) => t("cc.wifi.sub.disconnected"),
                _ => t("cc.wifi.sub.off"),
            },
        ),
        "bt" => (
            t("widget.bluetooth.name"),
            if active(id, s) {
                t("widget.bluetooth.sub.active")
            } else {
                t("widget.bluetooth.sub.inactive")
            },
        ),
        "dark_mode" => (
            t("widget.dark-mode.name"),
            if s.dark {
                t("widget.dark-mode.sub.dark")
            } else {
                t("widget.dark-mode.sub.light")
            },
        ),
        "night_light" => (
            t("widget.night-light.name"),
            match s.night {
                Some(n) if n.enabled => format!("{}K", n.temperature),
                _ => t("widget.night-light.sub.off"),
            },
        ),
        "focus" => {
            if s.dnd {
                (t("cc.focus.title.on"), t("cc.focus.sub.on"))
            } else {
                (t("cc.focus.title.off"), String::new())
            }
        }
        "media" => (
            s.media
                .as_ref()
                .filter(|m| !m.title.is_empty())
                .map_or_else(|| t("cc.media.no-media"), |m| m.title.clone()),
            String::new(),
        ),
        other => (t(name_key(other)), String::new()),
    }
}

fn style(look: &Look, size: f32, weight: f32) -> TextStyle {
    let mut s = look.styles.text.clone();
    s.size = size;
    s.weight = weight;
    s
}

/// A text laid out; a weight its font has no face for falls back to the regular one
/// (the text backend refuses synthetic bold).
pub(crate) fn lay_out(
    look: &mut Look,
    text: &str,
    style: &TextStyle,
    max_width: f32,
) -> nk_text::Result<nk_text::Layout> {
    look.text.layout(text, style, max_width).or_else(|e| {
        if style.weight == 400. {
            return Err(e);
        }
        let mut regular = style.clone();
        regular.weight = 400.;
        look.text.layout(text, &regular, max_width)
    })
}

/// `text` cut to `room` on one line, an ellipsis where it is cut.
fn fit(look: &mut Look, text: &str, style: &TextStyle, room: f64) -> String {
    use unicode_segmentation::UnicodeSegmentation;
    let width = |look: &mut Look, t: &str| {
        lay_out(look, t, style, f32::MAX).map_or(0., |l| f64::from(l.measured_size().width))
    };
    if width(look, text) <= room {
        return text.to_string();
    }
    let mut cut = text.to_string();
    while let Some((at, _)) = cut.grapheme_indices(true).next_back() {
        cut.truncate(at);
        let candidate = format!("{}…", cut.trim_end());
        if width(look, &candidate) <= room || cut.is_empty() {
            return candidate;
        }
    }
    String::new()
}

/// A capsule's text column in `b`: the title in bold over its subtitle, both centred on
/// the tile's middle. Without a subtitle the title may take two lines, when its longest
/// word fits the column (`makeCapsuleInner`); else one, cut.
pub(super) fn battery_text(s: &Status, look: Option<&Look>) -> String {
    let (key, fallback) = match s.battery_state {
        1 | 5 => ("widget.battery.state.charging", "Charging"),
        2 | 6 => ("widget.battery.state.discharging", "Discharging"),
        4 => ("widget.battery.state.charged", "Fully charged"),
        _ => ("cc.detail.unavailable", "Unknown"),
    };
    let state = look.map_or_else(
        || fallback.into(),
        |l| l.text_of(&crate::menu::Label::Key(key)),
    );
    if let Some(seconds) = s.battery_time.filter(|seconds| *seconds > 0) {
        format!("{state} · {}h {:02}m", seconds / 3600, seconds % 3600 / 60)
    } else {
        state
    }
}

fn paint_titles(
    c: &mut Canvas,
    look: &mut Look,
    b: [f64; 4],
    title: &str,
    sub: &str,
) -> nk_wayland::Result<()> {
    let bold = style(look, TEXT, BOLD);
    let regular = style(look, TEXT, 400.);
    let room = b[2].max(0.);
    let title_layout = if sub.is_empty() {
        let wrapped = lay_out(look, title, &bold, room as f32)?;
        let fits =
            wrapped.lines().len() <= 2 && f64::from(wrapped.measured_size().width) <= room + 0.5;
        if fits {
            wrapped
        } else {
            let one = fit(look, title, &bold, room);
            lay_out(look, &one, &bold, f32::MAX)?
        }
    } else {
        let one = fit(look, title, &bold, room);
        lay_out(look, &one, &bold, f32::MAX)?
    };
    let sub_layout = if sub.is_empty() {
        None
    } else {
        let one = fit(look, sub, &regular, room);
        Some(lay_out(look, &one, &regular, f32::MAX)?)
    };
    let th = f64::from(title_layout.measured_size().height);
    let sh = sub_layout
        .as_ref()
        .map_or(0., |l| f64::from(l.measured_size().height));
    let y = (b[1] + (b[3] - th - sh) / 2.).round();
    c.layout(&title_layout, (b[0] as f32, y as f32), ink(1.))?;
    if let Some(l) = sub_layout {
        c.layout(&l, (b[0] as f32, (y + th) as f32), ink(SECONDARY))?;
    }
    Ok(())
}

fn paint_cover(c: &mut Canvas, cover: Option<&Raster>, b: [f64; 4], radius: f64) {
    match cover {
        Some(art) => {
            c.clip_rounded_rect(rect(b), radius);
            c.image(art, rect(b), ImageFit::Cover);
            c.pop_clip();
        }
        None => c.rounded_rect(rect(b), radius, ink(SURFACE as f32)),
    }
}

/// A cover file as a picture: its format read from its bytes (Media1 caches them as
/// `.img`), at most 256 a side.
fn decode(path: &str) -> Result<(u16, u16, Vec<u8>), String> {
    let i = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?
        .decode()
        .map_err(|e| e.to_string())?
        .thumbnail(256, 256)
        .to_rgba8();
    Ok((i.width() as u16, i.height() as u16, i.into_raw()))
}

fn inside(r: [f64; 4], (x, y): (f64, f64)) -> bool {
    x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]
}

fn inset(r: [f64; 4], d: f64) -> [f64; 4] {
    [r[0] + d, r[1] + d, r[2] - 2. * d, r[3] - 2. * d]
}

fn centred(r: [f64; 4], size: f64) -> Rect {
    rect([
        r[0] + (r[2] - size) / 2.,
        r[1] + (r[3] - size) / 2.,
        size,
        size,
    ])
}

fn ink(alpha: f32) -> Color {
    Color::new([1., 1., 1., alpha])
}

fn rect(r: [f64; 4]) -> Rect {
    Rect {
        x: r[0] as f32,
        y: r[1] as f32,
        width: r[2] as f32,
        height: r[3] as f32,
    }
}

/// The writes, on a thread of their own: a slider's drag is a burst, and only its latest
/// value of each kind is sent.
pub struct Writer {
    jobs: std::sync::mpsc::Sender<(u64, Act)>,
    pub replies: std::sync::mpsc::Receiver<(u64, Result<(), String>)>,
}

impl Writer {
    pub fn new(conn: zbus::blocking::Connection, waker: nk_wayland::Waker) -> Self {
        let (tx, rx) = std::sync::mpsc::channel::<(u64, Act)>();
        let (results, replies) = std::sync::mpsc::channel();
        let connecting = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let clipboard_busy = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let _ = std::thread::Builder::new()
            .name("cc-writes".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let mut batch = vec![first];
                    batch.extend(rx.try_iter());
                    let key = |act: &Act| match act {
                        Act::Volume(_) => Some("default-volume".to_owned()),
                        Act::Brightness { device, epoch, .. } => {
                            Some(format!("brightness:{device}:{epoch}"))
                        }
                        Act::Detail(action) => action.coalescing_key(),
                        _ => None,
                    };
                    let last: HashMap<String, usize> = batch
                        .iter()
                        .enumerate()
                        .filter_map(|(i, (_, act))| key(act).map(|key| (key, i)))
                        .collect();
                    for (i, (version, act)) in batch.into_iter().enumerate() {
                        let stale = key(&act).is_some_and(|key| last.get(&key) != Some(&i));
                        if !stale {
                            // Bounded clipboard children still belong on a separate lane:
                            // a stalled decode must not hold layout or hardware writes.
                            if let Act::Detail(
                                action @ (detail::Action::ClipboardList
                                | detail::Action::Clipboard { .. }),
                            ) = &act
                            {
                                if clipboard_busy.swap(true, std::sync::atomic::Ordering::AcqRel) {
                                    let _ = results
                                        .send((version, Err("clipboard operation pending".into())));
                                    let _ = waker.wake();
                                    continue;
                                }
                                let (action, conn, busy, clip_results, clip_waker) = (
                                    action.clone(),
                                    conn.clone(),
                                    clipboard_busy.clone(),
                                    results.clone(),
                                    waker.clone(),
                                );
                                let failed = std::thread::Builder::new()
                                    .name("cc-clipboard".into())
                                    .spawn(move || {
                                        let result = detail::write(&conn, &action);
                                        busy.store(false, std::sync::atomic::Ordering::Release);
                                        let _ = clip_results.send((version, result));
                                        let _ = clip_waker.wake();
                                    });
                                if let Err(error) = failed {
                                    clipboard_busy
                                        .store(false, std::sync::atomic::Ordering::Release);
                                    let _ = results.send((version, Err(error.to_string())));
                                    let _ = waker.wake();
                                }
                            // Connecting may await a password; never block the reply/control lane.
                            } else if matches!(&act,Act::Detail(action) if action.connects()) {
                                if connecting.swap(true, std::sync::atomic::Ordering::AcqRel) {
                                    let _ = results
                                        .send((version, Err("network connection pending".into())));
                                    let _ = waker.wake();
                                    continue;
                                }
                                let connecting = connecting.clone();
                                let (results, waker) = (results.clone(), waker.clone());
                                let _ = std::thread::Builder::new()
                                    .name("cc-connect".into())
                                    .spawn(move || {
                                        let result = zbus::blocking::connection::Builder::session()
                                            .map_err(|e| e.to_string())
                                            .and_then(|builder| {
                                                builder
                                                    .method_timeout(std::time::Duration::from_secs(
                                                        180,
                                                    ))
                                                    .build()
                                                    .map_err(|e| e.to_string())
                                            })
                                            .and_then(|connection| write(&connection, &act));
                                        connecting
                                            .store(false, std::sync::atomic::Ordering::Release);
                                        let _ = results.send((version, result));
                                        let _ = waker.wake();
                                    });
                            } else {
                                let _ = results.send((version, write(&conn, &act)));
                                let _ = waker.wake();
                            }
                        }
                    }
                }
            });
        Self { jobs: tx, replies }
    }

    pub fn send(&self, version: u64, act: Act) {
        let _ = self.jobs.send((version, act));
    }
}

fn layout_write_error(raw: String) -> String {
    eprintln!("nidara-shell: Control Center layout write failed: {raw}");
    match raw.as_str() {
        "Control Center layout is read-only" => "cc.grid.write-read-only",
        "Control Center layout changed; retry the edit" => "cc.grid.write-changed",
        _ => "cc.grid.write-failed",
    }
    .into()
}

fn write(conn: &zbus::blocking::Connection, act: &Act) -> Result<(), String> {
    use zbus::zvariant::{ObjectPath, OwnedObjectPath};
    const SESSION: &str = crate::status::SESSION;
    match act {
        Act::Layout(before, after) => {
            crate::prefs::write_cc(before, after).map_err(layout_write_error)
        }
        Act::OpenDetail(_) => Ok(()),
        Act::Detail(action) => detail::write(conn, action),
        Act::Dark(on) => crate::prefs::apply(
            conn,
            "appearance.darkMode",
            &crate::menu::PrefValue::Bool(*on),
        ),
        Act::Night(on) => crate::prefs::apply(
            conn,
            "nightlight.enabled",
            &crate::menu::PrefValue::Bool(*on),
        ),
        Act::Dnd(on) => crate::prefs::set_dnd(*on),
        Act::Bluetooth { adapter, powered } => {
            let adapter = ObjectPath::try_from(adapter.as_str()).map_err(|e| e.to_string())?;
            call(
                conn,
                "org.nidara.Bluetooth",
                "/org/nidara/Bluetooth",
                "org.nidara.Bluetooth1",
                "SetPowered",
                &(adapter, *powered),
            )
        }
        Act::Media(method) => call(
            conn,
            SESSION,
            crate::status::MEDIA_PATH,
            crate::status::MEDIA_IFACE,
            method,
            &(),
        ),
        Act::Volume(v) => {
            let root =
                zbus::blocking::Proxy::new(conn, SESSION, "/org/nidara/Audio", "org.nidara.Audio1")
                    .map_err(|e| e.to_string())?;
            let out: OwnedObjectPath = root
                .get_property("DefaultOutput")
                .map_err(|e| e.to_string())?;
            if out.as_str() == "/" {
                return Err("no default output".into());
            }
            call(
                conn,
                SESSION,
                "/org/nidara/Audio",
                "org.nidara.Audio1",
                "SetVolume",
                &(out, v.clamp(0., 1.)),
            )
        }
        Act::Brightness { device, epoch, raw } => call(
            conn,
            SESSION,
            "/org/nidara/DisplayBrightness",
            "org.nidara.DisplayBrightness1",
            "SetBrightness",
            &(device.as_str(), *epoch, *raw),
        ),
    }
}

fn call<B: serde::Serialize + zbus::zvariant::DynamicType>(
    conn: &zbus::blocking::Connection,
    dest: &str,
    path: &str,
    iface: &str,
    method: &str,
    body: &B,
) -> Result<(), String> {
    conn.call_method(Some(dest), path, Some(iface), method, body)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::status::{Brightness, Night, Volume};

    fn status() -> Status {
        Status {
            volume: Some(Volume {
                level: 0.4,
                muted: false,
            }),
            night: Some(Night {
                enabled: false,
                temperature: 4000,
            }),
            ..Default::default()
        }
    }

    fn placed(cc: &Cc, id: &str) -> Placed {
        *cc.tiles.iter().find(|p| p.tile.id == id).unwrap()
    }

    #[test]
    fn layout_write_diagnostics_map_to_translatable_keys_not_raw_backend_text() {
        for (raw, key) in [
            (
                "Control Center layout is read-only",
                "cc.grid.write-read-only",
            ),
            (
                "Control Center layout changed; retry the edit",
                "cc.grid.write-changed",
            ),
            ("GSettings backend diagnostic", "cc.grid.write-failed"),
            ("no control-center schema", "cc.grid.write-failed"),
        ] {
            assert_eq!(layout_write_error(raw.into()), key);
        }
    }

    #[test]
    fn edit_detail_back_and_refocus_never_publish_two_focused_nodes() {
        use nk_a11y::{Node, Role, Tree};
        let mut cc = Cc::new();
        let status = status();
        let stored = layout::Stored::default();
        let mut snapshot = nk_a11y::Snapshot::default();
        for step in 0..6 {
            match step {
                0 => {
                    cc.editor.toggle();
                    cc.focus(Target::Edit(edit::Target::Tile("screenshot")));
                }
                1 => {
                    cc.back();
                }
                2 => {
                    cc.open_detail("screenshot", &status);
                }
                3 => {
                    cc.back();
                }
                4 => {
                    cc.focus(Target::Edit(edit::Target::Toggle));
                }
                _ => {
                    cc.editor.toggle();
                    cc.focus(Target::Edit(edit::Target::Tile("media")));
                }
            }
            cc.place(900., 36., &status, &stored);
            let mut root = Node::new(1, Role::Panel, "Control Center");
            let mut nodes = std::collections::BTreeMap::new();
            for (node, _) in cc.nodes(100, &status, None) {
                root.children.push(node.id);
                nodes.insert(node.id, node);
            }
            nodes.insert(1, root);
            snapshot.accept(Tree { root: 1, nodes }).unwrap();
        }
    }

    #[test]
    fn semantic_ids_survive_hardware_arrival_and_a_slider_becoming_a_detail_button() {
        use nk_a11y::{Node, Role, Tree};
        let mut cc = Cc::new();
        let mut status = status();
        let mut stored = layout::Stored::default();
        let mut snapshot = nk_a11y::Snapshot::default();
        for step in 0..3 {
            if step == 1 {
                status.bluetooth = Some(crate::status::Bluetooth {
                    adapter: "/adapter/1".into(),
                    powered: true,
                });
            }
            if step == 2 {
                stored.sizes.insert("volume".into(), "1x1".into());
            }
            cc.place(900., 36., &status, &stored);
            let mut root = Node::new(1, Role::Panel, "Control Center");
            let mut nodes = std::collections::BTreeMap::new();
            for (node, _) in cc.nodes(100, &status, None) {
                root.children.push(node.id);
                nodes.insert(node.id, node);
            }
            nodes.insert(1, root);
            snapshot.accept(Tree { root: 1, nodes }).unwrap();
        }
    }

    #[test]
    fn a_cover_is_read_by_its_bytes_not_its_name() {
        let dir = std::env::temp_dir().join(format!("nk-cc-cover-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("cover.img");
        image::RgbaImage::from_pixel(512, 300, image::Rgba([255, 0, 0, 255]))
            .save_with_format(&path, image::ImageFormat::Png)
            .unwrap();
        let (w, h, px) = decode(path.to_str().unwrap()).unwrap();
        assert_eq!((w, h, &px[..4]), (256, 150, &[255, 0, 0, 255][..]));
        std::fs::write(&path, b"not a picture").unwrap();
        assert!(decode(path.to_str().unwrap()).is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_panel_hangs_under_the_right_group_and_holds_the_grid() {
        let mut cc = Cc::new();
        cc.place(1916., 36., &status(), &Default::default());
        // Without Wi-Fi, Bluetooth and a backlight: four rows.
        assert_eq!(
            cc.panel,
            [1916. - 396., 44., 396., 4. * 96. - 20. + 32. + 48.]
        );
        let media = placed(&cc, "media");
        assert_eq!(media.rect, [1520. + 16., 60., 172., 172.]);
        assert_eq!(radius_of(&media), 38.);
        let volume = placed(&cc, "volume");
        // The 4×1 is the dock's shape, not a capsule.
        assert_eq!(radius_of(&volume), 24.);
        assert_eq!(volume.rect[2], 364.);
        let shot = placed(&cc, "screenshot");
        assert_eq!(radius_of(&shot), 38.);
    }

    #[test]
    fn clicks_land_on_what_acts() {
        let mut cc = Cc::new();
        let mut s = status();
        cc.place(1916., 36., &s, &Default::default());
        let centre = |r: [f64; 4]| (r[0] + r[2] / 2., r[1] + r[3] / 2.);
        // Appearance at 2×1: the whole capsule.
        let dark = placed(&cc, "dark_mode");
        assert_eq!(cc.press(centre(dark.rect), &s), Some(Act::Dark(true)));
        // Night Light at 2×1: only its badge; the body is its detail's (B2.2).
        let night = placed(&cc, "night_light");
        assert_eq!(
            cc.press(centre(badge(&night).unwrap()), &s),
            Some(Act::Night(true))
        );
        assert_eq!(
            cc.press(centre(night.rect), &s),
            Some(Act::OpenDetail("night_light"))
        );
        // A screenshot at 1×1 is a real detail entry.
        assert_eq!(
            cc.press(centre(placed(&cc, "screenshot").rect), &s),
            Some(Act::OpenDetail("screenshot"))
        );
        // The volume's track: the value under the pointer, held while dragged.
        let v = placed(&cc, "volume");
        let t = slider_track(v.rect, VALUE_W);
        let x = t[0] + THUMB + (t[2] - 2. * THUMB) * 0.75;
        assert_eq!(cc.press((x, t[1] + 9.), &s), Some(Act::Volume(0.75)));
        assert!(cc.dragging());
        let (_, act) = cc.motion((t[0] - 50., t[1]), &s);
        assert_eq!(act, Some(Act::Volume(0.)));
        assert_eq!(cc.shown("volume", &s), 0.);
        assert!(cc.release());
        assert_eq!(cc.shown("volume", &s), 0.4);
        // Brightness: the device's raw range.
        s.brightness = Some(Brightness {
            device: "panel".into(),
            epoch: 3,
            min: 0,
            max: 400,
            current: 100,
        });
        cc.place(1916., 36., &s, &Default::default());
        let b = placed(&cc, "brightness");
        let t = slider_track(b.rect, VALUE_W);
        assert_eq!(
            cc.press((t[0] + t[2] - THUMB, t[1]), &s),
            Some(Act::Brightness {
                device: "panel".into(),
                epoch: 3,
                raw: 400
            })
        );
    }

    #[test]
    fn what_is_on_is_white_and_the_hover_is_one_wash() {
        let mut cc = Cc::new();
        let mut s = status();
        s.dnd = true;
        let mut stored = layout::Stored::default();
        stored.positions.insert("focus".into(), (0, 0));
        stored.sizes.insert("focus".into(), "1x1".into());
        stored.positions.insert("dark_mode".into(), (1, 0));
        stored.sizes.insert("dark_mode".into(), "2x1".into());
        cc.place(1916., 36., &s, &stored);
        let washes = cc.states(&s);
        let focus = cc.tiles.iter().position(|p| p.tile.id == "focus").unwrap();
        let tile = |i: usize| washes.iter().find(|w| w.id == 1000 + i as u32 * 8).unwrap();
        // A 1×1 that is on: its whole tile white.
        assert_eq!(tile(focus).wash, [1., 1., 1., 1.]);
        // Appearance (light) at 2×1: its badge at rest, its tile clear.
        let dark = cc
            .tiles
            .iter()
            .position(|p| p.tile.id == "dark_mode")
            .unwrap();
        assert_eq!(tile(dark).wash[3], 0.);
        let rest = washes
            .iter()
            .find(|w| w.id == 1000 + dark as u32 * 8 + 1)
            .unwrap();
        assert_eq!(rest.wash[3], SURFACE);
        // Hovered: the 8 % over it.
        let r = placed(&cc, "dark_mode").rect;
        cc.motion((r[0] + 100., r[1] + 30.), &s);
        let washes = cc.states(&s);
        let tile = washes
            .iter()
            .find(|w| w.id == 1000 + dark as u32 * 8)
            .unwrap();
        assert_eq!(tile.wash[3], HOVER);
    }
}
