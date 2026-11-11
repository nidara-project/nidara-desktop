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
/// The dim ink tier of the dark skin.
const DIM: f32 = 0.55;
/// `--nidara-surface`: a badge at rest.
const SURFACE: f64 = 0.08;

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

/// Where the grid's state regions start: past the detail's and the editor's.
const REGIONS: u32 = 200_000;

pub struct Cc {
    pub editor: edit::Editor,
    tiles: Vec<Placed>,
    pub detail: Option<detail::Detail>,
    pub detail_height: f64,
    /// The output's scale, which the grid and the detail lay out for.
    pub detail_scale: f64,
    detail_generation: u64,
    panel: [f64; 4],
    /// The grid as an nk-view view: layout, hover, press, focus, keys and washes (VIEW.md
    /// §12.4). The editor still places the tiles and scrolls them (edit mode is step 4).
    state: nk_view::ViewState,
    tokens: Option<nk_view::Tokens>,
    appearance: Option<nk_platform::portal::Appearance>,
    /// The frame last painted: the washes Hyalo is given.
    last: nk_view::Frame,
    /// The tile to focus once the grid is laid out again (back from a detail), and whether
    /// it shows the ring: only when the keyboard went back.
    refocus: Option<(Target, bool)>,
    icons: Option<nk_icons::Icons>,
    glyphs: HashMap<(String, u32), Option<Arc<nk_icons::Icon>>>,
    /// The cover being shown and its picture.
    art: Option<(String, Option<Arc<Raster>>)>,
    /// Each edit layer's own view: a tile drawn alone, on its own surface.
    layers: HashMap<&'static str, nk_view::ViewState>,
}

impl Default for Cc {
    fn default() -> Self {
        Self::new()
    }
}

impl Cc {
    pub fn new() -> Self {
        let mut state = nk_view::ViewState::new(REGIONS);
        // The editor places the tiles' glass and scrolls it; the content goes with it.
        state.set_slides(false);
        Self {
            editor: Default::default(),
            tiles: vec![],
            detail: None,
            detail_height: 1080.,
            detail_scale: 1.,
            detail_generation: 0,
            panel: [0.; 4],
            state,
            tokens: None,
            appearance: None,
            last: Default::default(),
            refocus: None,
            icons: nk_icons::Icons::new("", &[], &crate::paths::icon_reference())
                .map_err(|e| eprintln!("nidara-shell: no icons for the Control Center: {e}"))
                .ok(),
            glyphs: HashMap::new(),
            art: None,
            layers: HashMap::new(),
        }
    }

    /// The tiles for this frame, under the right group's glass ending at `right`.
    pub fn place(
        &mut self,
        right: f64,
        top: f64,
        status: &Status,
        stored: &layout::Stored,
        look: Option<&mut Look>,
    ) {
        self.tiles = self
            .editor
            .sync(stored, status, right, top, self.detail_height);
        self.panel = self.editor.panel;
        if let Some(detail) = &mut self.detail {
            detail.max_height = self.detail_height;
            detail.scale = self.detail_scale;
            detail.refresh(status, self.panel, look);
            self.panel = detail.panel;
        } else if let Some(look) = look {
            self.lay(status, look);
        }
    }

    /// The grid laid out where the editor puts it: from the viewport's left, scrolled by the
    /// editor's offset, as tall as the rows the tiles reach.
    fn lay(&mut self, status: &Status, look: &mut Look) {
        if self.appearance.as_ref() != Some(&look.appearance) {
            self.appearance = Some(look.appearance.clone());
            self.tokens = crate::nc_view::tokens(&look.exports, &look.appearance)
                .map_err(|e| eprintln!("nidara-shell: the CC grid has no tokens: {e}"))
                .ok();
            self.state
                .set_reduced_motion(look.appearance.reduced_motion);
        }
        let Some(tokens) = self.tokens.clone() else {
            return;
        };
        let base = look.styles.text.clone();
        let view = grid_view(&self.tiles, status, Some(look), &base);
        self.lay_view(&view, &tokens, &mut look.text);
    }
    fn lay_view(
        &mut self,
        view: &nk_view::Node,
        tokens: &nk_view::Tokens,
        text: &mut dyn TextBackend,
    ) {
        let rows = self
            .tiles
            .iter()
            .map(|p| (p.tile.y + p.tile.size.cells().1) as usize)
            .max()
            .unwrap_or(0);
        let (x, y) = self.editor.origin;
        let bounds = [
            x,
            y,
            layout::GRID_WIDTH,
            rows as f64 * (layout::UNIT + layout::GAP) - layout::GAP,
        ];
        self.state.layout_in(
            view,
            bounds,
            self.detail_scale,
            tokens,
            text,
            std::time::Instant::now(),
        );
        if let Some((t, ring)) = self.refocus.take() {
            self.focus(t);
            if !ring {
                self.state.hide_ring();
            }
        }
    }

    pub fn open_detail(&mut self, page: &'static str, status: &Status, look: Option<&mut Look>) {
        if self.editor.active {
            return;
        }
        self.detail_generation += 1;
        let mut detail = detail::Detail::new(page, self.detail_generation);
        detail.max_height = self.detail_height;
        detail.scale = self.detail_scale;
        detail.refresh(status, self.panel, look);
        self.panel = detail.panel;
        self.detail = Some(detail);
        self.state.pointer_leave();
    }
    pub fn view_id(&self) -> u64 {
        self.detail_generation
    }
    /// Back from a detail or edit mode, the ring on the tile it returns to as its page's own
    /// focus had it: a Back row pressed with the keyboard shows it, with the pointer not.
    pub fn back(&mut self) -> bool {
        let keyboard = self
            .detail
            .as_ref()
            .is_some_and(|d| d.state.focus_visible());
        self.back_by(keyboard)
    }
    /// Back, `keyboard` saying whether a key asked (Escape) or not (the panel closing).
    pub fn back_by(&mut self, keyboard: bool) -> bool {
        if self.editor.active {
            self.state.blur();
            self.editor.toggle();
            return true;
        }
        let detail = self.detail.take();
        if let Some(detail) = detail {
            self.detail_generation += 1;
            self.editor.focus = None;
            self.refocus = Some((Target::OpenDetail(detail.page), keyboard));
            true
        } else {
            false
        }
    }
    pub fn focus(&mut self, target: Target) {
        if let Target::Edit(t) = target {
            self.state.blur();
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
            if let Some(key) = key_of(target) {
                self.state.request(&key, false);
            }
            if let Target::Tile(id)
            | Target::OpenDetail(id)
            | Target::Slider(id)
            | Target::Badge(id) = target
            {
                self.editor.reveal(edit::Target::Tile(id));
            }
        }
    }
    /// The grid's focus, as a target.
    fn focused(&self) -> Option<Target> {
        self.state.focus().and_then(target_of)
    }
    pub fn key(&mut self, key: &nk_wayland::Key, status: &Status) -> Option<Act> {
        if self.editor.active {
            return self.editor.key(key, status);
        }
        if let Some(d) = &mut self.detail {
            return d.key(key).map(Act::Detail);
        }
        use nk_view::KeyInput as K;
        if [0xff09, 0xfe20].contains(&key.sym) {
            // The Tab order is the readers': the editor's button, then the tiles.
            let choices: Vec<_> = self
                .nodes(0, status, None)
                .into_iter()
                .filter(|(n, _)| !n.actions.is_empty())
                .map(|(_, t)| t)
                .collect();
            if choices.is_empty() {
                return None;
            }
            let current = self
                .editor
                .focus
                .map(Target::Edit)
                .or_else(|| self.focused())
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
        let input = match key.sym {
            0xff51 => K::Left,
            0xff53 => K::Right,
            0xff52 => K::Up,
            0xff54 => K::Down,
            0xff0d | 0x20 => K::Activate,
            _ => return None,
        };
        if input == K::Activate {
            let target = self.focused()?;
            return self.action(target, status, None);
        }
        let a = self.state.key(input)?;
        self.activated(a, status)
    }
    pub fn action(&mut self, target: Target, status: &Status, value: Option<f64>) -> Option<Act> {
        match target {
            Target::Edit(t) => {
                self.state.blur();
                self.editor.action(t, status)
            }
            Target::Detail(id) => self.detail.as_mut()?.action(id, value).map(Act::Detail),
            other => act_of(other, status),
        }
    }
    /// What a control the view reports asks of the services.
    fn activated(&mut self, a: nk_view::Activated, status: &Status) -> Option<Act> {
        match target_of(&a.key)? {
            Target::Slider(id) => set_value(id, self.state.value(&a.key)? / 100., status),
            t => act_of(t, status),
        }
    }
    pub fn scroll_detail(&mut self, amount: nk_wayland::ScrollAmount, status: &Status) -> bool {
        let delta = amount.pixels;
        if self.editor.active {
            return self.editor.scroll(delta * 32., status);
        }
        let Some(d) = &mut self.detail else {
            return self.editor.scroll(delta * 32., status);
        };
        d.scroll(amount.into());
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

    /// A slider is held by the pointer, or a tile by the editor.
    pub fn dragging(&self) -> bool {
        self.holding() || self.editor.dragging()
    }
    fn holding(&self) -> bool {
        self.detail.is_none()
            && self
                .state
                .press()
                .and_then(target_of)
                .is_some_and(|t| matches!(t, Target::Slider(_)))
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
        // The innermost control the pointer reaches, as the view hit-tests.
        self.state
            .placed()
            .iter()
            .rfind(|n| match &n.what {
                nk_view::What::Control(c) => {
                    c.enabled && c.pointer && n.visible().is_some_and(|r| inside(r, p))
                }
                _ => false,
            })
            .and_then(|n| target_of(&n.key))
    }

    /// The pointer moved: the hover, and a held slider's value.
    pub fn motion(&mut self, p: (f64, f64), status: &Status) -> (bool, Option<Act>) {
        if self.editor.active {
            return (self.editor.motion(p, status), None);
        }
        if let Some(detail) = &mut self.detail {
            let (changed, act) = detail.motion(p);
            return (changed || act.is_some(), act.map(Act::Detail));
        }
        // The grid is seen through the viewport; a held slider follows the pointer anywhere.
        if !inside(self.editor.viewport, p) && !self.holding() {
            return (self.state.pointer_leave(), None);
        }
        let changed = self.state.pointer_motion(p.0, p.1);
        let act = self.state.slid().and_then(|a| self.activated(a, status));
        (changed || act.is_some(), act)
    }

    pub fn leave(&mut self) -> bool {
        if let Some(d) = &mut self.detail {
            return d.leave();
        }
        self.state.pointer_leave()
    }

    /// A press on `p`: what it asks for at once (a slider's value); a button acts on release.
    pub fn press(&mut self, p: (f64, f64), status: &Status) -> Option<Act> {
        if self.detail.is_none() && (self.editor.active || self.editor.target(p).is_some()) {
            self.state.blur();
            return self.editor.press(p, status);
        }
        if let Some(d) = &mut self.detail {
            d.motion(p);
            return d.press().map(Act::Detail);
        }
        if !inside(self.editor.viewport, p) {
            return None;
        }
        self.editor.focus = None;
        self.state.pointer_motion(p.0, p.1);
        let a = self.state.button(true, std::time::Instant::now())?;
        self.activated(a, status)
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
    /// The primary button went up: whether anything changed, and what the release asks (a
    /// button released over itself, a slider's last value, a detail's row).
    pub fn release(&mut self, status: &Status) -> (bool, Option<Act>) {
        if let Some(d) = &mut self.detail {
            // A row the page acts on itself (recording audio, a mode) asks for nothing, yet
            // the page must be built again to show it: any held row's release rebuilds.
            let held = d.held();
            let act = d.release().map(Act::Detail);
            return (held || act.is_some(), act);
        }
        let held = self.holding() || self.state.press().is_some();
        let act = self
            .state
            .button(false, std::time::Instant::now())
            .and_then(|a| self.activated(a, status));
        (held || act.is_some(), act)
    }

    /// The panel closed under a held pointer: nothing it held acts.
    pub fn cancel(&mut self) {
        self.state.pointer_leave();
        let _ = self.state.button(false, std::time::Instant::now());
    }

    /// The value a slider shows: the held one while it is held.
    fn shown(&self, id: &'static str, status: &Status) -> f64 {
        key_of(Target::Slider(id))
            .and_then(|k| self.state.value(&k))
            .map_or_else(|| value_of(id, status), |v| v / 100.)
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

    /// The washes over the glass the last painted frame declared: badges at rest, what is
    /// on, the hover and the press (nk-view's, VIEW.md §12.4).
    pub fn states(&self, _status: &Status) -> Vec<StateRegion> {
        if let Some(d) = &self.detail {
            return d.states();
        }
        if self.editor.active {
            return self.editor.states();
        }
        self.last.states.clone()
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
        if let Some(d) = &mut self.detail {
            return d.paint(c, look, fallback);
        }
        self.editor.paint_under(c, fallback);
        c.clip(rect(self.editor.viewport));
        if !self.editor.layered
            && let Some(tokens) = self.tokens.clone()
        {
            if let Some(base) = fallback {
                for p in &self.tiles {
                    c.rounded_rect(rect(p.rect), radius_of(p), base);
                }
            }
            self.last = self.state.frame(&tokens, std::time::Instant::now());
            let cover = self.cover(status);
            let (icons, glyphs) = (&mut self.icons, &mut self.glyphs);
            let mut glyph = |name: &str, size: f64| glyph(icons, glyphs, name, size);
            if let Err(e) = self.state.paint(
                c,
                &tokens,
                &mut glyph,
                fallback.is_some().then_some(&self.last),
            ) {
                eprintln!("nidara-shell: the CC grid cannot be drawn: {e}");
            }
            paint_slots(c, look, &self.state, status, cover.as_deref(), &mut glyph)?;
        }
        c.pop_clip();
        self.editor.paint(c, look, fallback)?;
        Ok(())
    }

    pub fn edit_tiles(&self) -> Vec<(&'static str, [f64; 4], Size)> {
        self.tiles
            .iter()
            .map(|p| (p.tile.id, p.rect, p.tile.size))
            .collect()
    }
    /// One tile drawn alone on its edit layer, 6 in from the layer's corner, as the grid
    /// draws it, with its Remove mark when it can be removed.
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
        let Some(tokens) = self.tokens.clone() else {
            return Ok(());
        };
        placed.rect[0] = 6.;
        placed.rect[1] = 6.;
        let base = look.styles.text.clone();
        let view = tile_view(&placed, status, Some(look), &base);
        let state = self.layers.entry(id).or_insert_with(|| {
            let mut s = nk_view::ViewState::new(REGIONS);
            s.set_slides(false);
            s
        });
        state.layout_in(
            &view,
            placed.rect,
            self.detail_scale,
            &tokens,
            &mut look.text,
            std::time::Instant::now(),
        );
        let cover = {
            let path = status.media.as_ref().and_then(|m| m.art.clone());
            self.art
                .as_ref()
                .filter(|(p, _)| Some(p) == path.as_ref())
                .and_then(|(_, a)| a.clone())
        };
        let state = &self.layers[id];
        let (icons, glyphs) = (&mut self.icons, &mut self.glyphs);
        let mut glyph = |name: &str, size: f64| glyph(icons, glyphs, name, size);
        state.paint(c, &tokens, &mut glyph, None)?;
        paint_slots(c, look, state, status, cover.as_deref(), &mut glyph)?;
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

    /// What a reader is told: a node per tile, ids from `first` on, bounds and focus from
    /// the view.
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
        let focus = self.focused().filter(|_| self.editor.focus.is_none());
        let bounds = |r: [f64; 4]| Bounds {
            x: r[0],
            y: r[1],
            width: r[2],
            height: r[3],
        };
        for (i, p) in self.tiles.iter().enumerate() {
            let id = p.tile.id;
            let semantic = layout::REGISTRY
                .iter()
                .position(|meta| meta.id == id)
                .unwrap_or(i);
            let nid = first + semantic as nk_a11y::NodeId * 8;
            let (title, sub) =
                look.map_or((id.to_string(), String::new()), |l| texts(id, status, l));
            let target = primary(id, p.tile.size);
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
            node.bounds = bounds(p.rect);
            node.id += match node.role {
                Role::ToggleButton => 1,
                Role::Slider => 2,
                _ => 0,
            };
            node.states.focused = focus == Some(target);
            node.states.offscreen = !(p.rect[0]
                < self.editor.viewport[0] + self.editor.viewport[2]
                && p.rect[0] + p.rect[2] > self.editor.viewport[0]
                && p.rect[1] < self.editor.viewport[1] + self.editor.viewport[3]
                && p.rect[1] + p.rect[3] > self.editor.viewport[1]);
            if !node.actions.is_empty() && !node.actions.contains(&Action::Focus) {
                node.actions.push(Action::Focus);
            }
            out.push((node, target));
            if id == "media" && p.tile.size != Size::Single {
                let controls: &[Target] = if p.tile.size == Size::Square {
                    &[Target::Previous, Target::PlayPause, Target::Next]
                } else {
                    &[Target::PlayPause]
                };
                for (j, &target) in controls.iter().enumerate() {
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
                    let enabled = enabled(target, status);
                    let r = key_of(target)
                        .and_then(|k| self.state.rect(&k))
                        .unwrap_or(p.rect);
                    control.bounds = bounds(r);
                    control.states.disabled = !enabled;
                    control.states.focused = focus == Some(target);
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
                detail.bounds = bounds(p.rect);
                detail.actions = vec![Action::Activate, Action::Focus];
                detail.states.focused = focus == Some(Target::OpenDetail(id));
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

/// A glyph by name, looked up once per size; the empty name of a slot is nothing.
fn glyph(
    icons: &mut Option<nk_icons::Icons>,
    glyphs: &mut HashMap<(String, u32), Option<Arc<nk_icons::Icon>>>,
    name: &str,
    size: f64,
) -> Option<Arc<nk_icons::Icon>> {
    if name.is_empty() {
        return None;
    }
    let px = size.round() as u32;
    glyphs
        .entry((name.to_string(), px))
        .or_insert_with(|| {
            icons.as_mut().and_then(|i| {
                i.get(name, px)
                    .map_err(|e| eprintln!("nidara-shell: no {name}: {e}"))
                    .ok()
            })
        })
        .clone()
}

/// A tile's controls by key: `t:` the whole tile, `d:` its detail, `b:` its badge, `s:` its
/// slider, `m:` the player's buttons.
fn key_of(t: Target) -> Option<nk_view::Key> {
    Some(nk_view::Key(match t {
        Target::Tile(id) => format!("t:{id}"),
        Target::OpenDetail(id) => format!("d:{id}"),
        Target::Badge(id) => format!("b:{id}"),
        Target::Slider(id) => format!("s:{id}"),
        Target::Previous => "m:previous".into(),
        Target::PlayPause => "m:play".into(),
        Target::Next => "m:next".into(),
        Target::Edit(_) | Target::Detail(_) => return None,
    }))
}
fn target_of(k: &nk_view::Key) -> Option<Target> {
    let (kind, rest) = k.0.split_once(':')?;
    let id = || layout::REGISTRY.iter().find(|m| m.id == rest).map(|m| m.id);
    Some(match kind {
        "t" => Target::Tile(id()?),
        "d" => Target::OpenDetail(id()?),
        "b" => Target::Badge(id()?),
        "s" => Target::Slider(id()?),
        "m" => match rest {
            "previous" => Target::Previous,
            "play" => Target::PlayPause,
            "next" => Target::Next,
            _ => return None,
        },
        _ => return None,
    })
}

/// What a tile is first, for a reader: its slider, its toggle, its badge, else its detail.
fn primary(id: &'static str, size: Size) -> Target {
    match (id, size) {
        ("volume" | "brightness", Size::FullWidth | Size::Tall) => Target::Slider(id),
        ("media", _) => Target::OpenDetail(id),
        (id, Size::Single) if toggles(id) => Target::Tile(id),
        ("dark_mode" | "focus", _) => Target::Tile(id),
        ("night_light" | "bt" | "ethernet", Size::Wide | Size::Square) => Target::Badge(id),
        (id, _) if has_detail(id) => Target::OpenDetail(id),
        _ => Target::Tile(id),
    }
}

/// A tile's corner, as `radius_of` gives its glass: a 2×2 takes its 1×1's, the 4×1 the
/// dock's, the rest are capsules and circles.
fn corner_of(size: Size) -> nk_view::Corner {
    match size {
        Size::Square => nk_view::Corner::Fixed(SQUARE_RADIUS as u32),
        Size::FullWidth => nk_view::Corner::Fixed(wide_radius().round() as u32),
        _ => nk_view::Corner::Pill,
    }
}

/// Whether a player's button can act now.
fn enabled(t: Target, s: &Status) -> bool {
    s.media.as_ref().is_some_and(|m| match t {
        Target::Previous => m.can_control && m.can_previous,
        Target::Next => m.can_control && m.can_next,
        _ => m.can_control,
    })
}

/// The grid: each tile on its cells, the editor's placement (VIEW.md §12.4).
fn grid_view(
    tiles: &[Placed],
    status: &Status,
    look: Option<&Look>,
    base: &TextStyle,
) -> nk_view::Node {
    let cells = tiles
        .iter()
        .map(|p| nk_view::Cell {
            at: (p.tile.x as usize, p.tile.y as usize),
            span: (
                p.tile.size.cells().0 as usize,
                p.tile.size.cells().1 as usize,
            ),
            child: tile_view(p, status, look, base),
        })
        .collect();
    nk_view::Node::grid(
        "grid",
        layout::COLS as usize,
        layout::UNIT,
        layout::GAP,
        cells,
    )
}

/// Room of `px`, for a measure of the tiles' own the spacing scale has no step for.
fn strut(key: String, px: f64) -> nk_view::Node {
    nk_view::Node::slot(key, px)
}

/// A glyph of `size` centred in a box of `room`.
fn boxed(key: String, name: &str, size: f64, room: f64, ink: nk_view::Ink) -> nk_view::Node {
    use nk_view::{Align, Node, Padding};
    Node::overlay(format!("{key}/box"), strut(format!("{key}/room"), room)).layer(
        Align::Center,
        Align::Center,
        Padding::default(),
        Node::icon(key, name, size).ink(ink),
    )
}

/// `child` laid in the middle of the tile, both ways.
fn centred_in(key: String, child: nk_view::Node) -> nk_view::Node {
    use nk_view::{Align, Justify, Node};
    Node::column(key, vec![child])
        .justify(Justify::Center)
        .align(Align::Center)
}

/// One tile: a pane of the CC's glass in its size's corner, holding its controls and what
/// they show, as the TS tiles laid them (`tile.ts`, `BaseIsland.tsx`).
fn tile_view(p: &Placed, status: &Status, look: Option<&Look>, base: &TextStyle) -> nk_view::Node {
    use nk_view::{Align, Ink, Justify, Node, Padding, Role, Slider};
    let id = p.tile.id;
    let size = p.tile.size;
    let k = |part: &str| format!("{id}/{part}");
    let on = active(id, status);
    let corner = corner_of(size);
    let (title, sub) = look.map_or((id.to_string(), String::new()), |l| texts(id, status, l));
    let text = |part: &str, t: String, size: f32, weight: f32| {
        Node::text(k(part), t, sized(base, size, weight))
    };
    let whole = |key: Option<nk_view::Key>, name: String, child: Node| {
        Node::control(key.unwrap(), name, "", child).corner(corner)
    };
    // A detail under the tile's own control: keys and readers only.
    let detail_layer = |base: Node| {
        if has_detail(id) {
            Node::overlay(k("layers"), base).layer(
                Align::Stretch,
                Align::Stretch,
                Padding::default(),
                Node::control(
                    key_of(Target::OpenDetail(id)).unwrap(),
                    "",
                    "",
                    Node::spacer(k("d")),
                )
                .corner(corner)
                .keys_only(),
            )
        } else {
            base
        }
    };
    let titles = |title: String, sub: String| {
        let lines = if sub.is_empty() { 2 } else { 1 };
        let mut col = vec![text("title", title, TEXT, BOLD).lines(lines)];
        if !sub.is_empty() {
            col.push(text("sub", sub, TEXT, 400.).lines(1).ink(Ink::Secondary));
        }
        Node::column(k("titles"), col)
            .justify(Justify::Center)
            .grow()
    };
    let content = match (id, size) {
        ("cpu_memory", _) => {
            let large = size == Size::Square;
            let ring = if large { 56. } else { 34. };
            let names: &[&str] = if size == Size::Single {
                &["CPU"]
            } else {
                &["CPU", "RAM"]
            };
            let mut row = vec![];
            for (n, name) in names.iter().enumerate() {
                if n > 0 {
                    row.push(strut(k("between"), 96. - ring));
                }
                row.push(
                    Node::column(
                        k(&format!("gauge{n}")),
                        vec![
                            Node::slot(k(&format!("ring{n}")), ring),
                            strut(k(&format!("under{n}")), 3.),
                            text(&format!("name{n}"), (*name).into(), SMALL, 400.)
                                .ink(Ink::Secondary),
                        ],
                    )
                    .align(Align::Center),
                );
            }
            centred_in(k("centre"), Node::row(k("gauges"), row).align(Align::Start))
        }
        ("battery", size) => {
            let percent = status
                .battery
                .map_or(String::new(), |b| format!("{:.0}%", b.fraction * 100.));
            let state = battery_text(status, look);
            let body = match size {
                Size::Single => centred_in(
                    k("centre"),
                    Node::column(
                        k("stack"),
                        vec![
                            Node::slot(k("glyph"), 28.),
                            strut(k("under"), 3.),
                            text("percent", percent, TEXT, 400.),
                        ],
                    )
                    .align(Align::Center),
                ),
                Size::Square => {
                    let mut centre = sized(base, SMALL, 400.);
                    centre.alignment = nk_text::Alignment::Center;
                    Node::column(
                        k("stack"),
                        vec![
                            Node::slot(k("glyph"), 56.),
                            strut(k("under"), 3.),
                            text("percent", percent, TEXT, 400.),
                            Node::row(
                                k("state-row"),
                                vec![
                                    strut(k("state-l"), 12.),
                                    Node::text(k("state"), state, centre)
                                        .lines(2)
                                        .ink(Ink::Dim)
                                        .grow(),
                                    strut(k("state-r"), 12.),
                                ],
                            ),
                        ],
                    )
                    .justify(Justify::Center)
                    .align(Align::Center)
                }
                _ => Node::row(
                    k("row"),
                    vec![
                        strut(k("lead"), 18.),
                        Node::slot(k("glyph"), 28.),
                        strut(k("gap"), 16.),
                        Node::column(
                            k("texts"),
                            vec![
                                text("percent", percent, TEXT, 400.),
                                text("state", state, SMALL, 400.).lines(2).ink(Ink::Dim),
                            ],
                        )
                        .justify(Justify::Center)
                        .grow(),
                        strut(k("end"), 14.),
                    ],
                )
                .align(Align::Center),
            };
            whole(key_of(Target::OpenDetail(id)), title, body)
        }
        ("media", size) => {
            let media = status.media.clone().unwrap_or_default();
            let button = |t: Target, icon: &str, room: f64| {
                let ink = if enabled(t, status) {
                    Ink::Primary
                } else {
                    Ink::Dim
                };
                let key = key_of(t).unwrap();
                Node::control(
                    key.clone(),
                    "",
                    "",
                    boxed(format!("{}/glyph", key.0), icon, 18., room, ink),
                )
                .enabled(enabled(t, status))
            };
            let play = if media.playing {
                "nd-media-playback-pause"
            } else {
                "nd-media-playback-start"
            };
            let body = match size {
                Size::Single => Node::slot(k("cover"), layout::UNIT),
                Size::Wide => Node::row(
                    k("row"),
                    vec![
                        strut(k("lead"), 14.),
                        Node::slot(k("cover"), 44.),
                        strut(k("gap"), 12.),
                        titles(title.clone(), media.artist.clone()),
                        strut(k("before"), 12.),
                        button(Target::PlayPause, play, 32.),
                        strut(k("end"), 14.),
                    ],
                )
                .align(Align::Center),
                _ => {
                    let mut centre = sized(base, TEXT, BOLD);
                    centre.alignment = nk_text::Alignment::Center;
                    let mut artist = sized(base, TEXT, 400.);
                    artist.alignment = nk_text::Alignment::Center;
                    let line = |part: &str, child: Node| {
                        Node::row(
                            k(part),
                            vec![
                                strut(k(&format!("{part}-l")), 16.),
                                child.grow(),
                                strut(k(&format!("{part}-r")), 16.),
                            ],
                        )
                    };
                    Node::column(
                        k("stack"),
                        vec![
                            Node::row(k("art"), vec![Node::slot(k("cover"), 62.)])
                                .justify(Justify::Center),
                            strut(k("under-art"), 4.),
                            line(
                                "title-line",
                                Node::text(k("title"), title.clone(), centre).lines(2),
                            ),
                            line(
                                "artist-line",
                                Node::text(k("artist"), media.artist.clone(), artist)
                                    .lines(1)
                                    .ink(Ink::Secondary),
                            ),
                            strut(k("above-controls"), 4.),
                            Node::row(
                                k("controls"),
                                vec![
                                    button(Target::Previous, "nd-media-skip-backward", 24.),
                                    button(Target::PlayPause, play, 24.),
                                    button(Target::Next, "nd-media-skip-forward", 24.),
                                ],
                            )
                            .gap(nk_view::Space::S4)
                            .justify(Justify::Center),
                        ],
                    )
                    .justify(Justify::Center)
                }
            };
            whole(key_of(Target::OpenDetail(id)), title, body)
        }
        ("volume" | "brightness", Size::FullWidth) => {
            let (low, low_size, high) = if id == "brightness" {
                ("nd-display-brightness-low", 14., "nd-display-brightness")
            } else {
                ("nd-audio-volume-low", 16., "nd-audio-volume-high")
            };
            let slider = Node::slider(
                key_of(Target::Slider(id)).unwrap(),
                "",
                "",
                Slider::new(0., 100., 5., (value_of(id, status) * 100.).round()),
            )
            .grow();
            let row = Node::row(
                k("row"),
                vec![
                    strut(k("lead"), 14.),
                    boxed(k("low"), low, low_size, 16., Ink::Dim),
                    strut(k("before"), 12.),
                    slider,
                    strut(k("after"), 12.),
                    boxed(k("high"), high, 16., 16., Ink::Dim),
                    strut(k("gap"), 12.),
                    Node::slot(k("value"), VALUE_W),
                    strut(k("end"), 14.),
                ],
            )
            .align(Align::Center);
            Node::overlay(
                k("layers"),
                whole(
                    key_of(Target::OpenDetail(id)),
                    title,
                    Node::spacer(k("body")),
                ),
            )
            .layer(Align::Stretch, Align::Center, Padding::default(), row)
        }
        ("volume" | "brightness", Size::Tall) => {
            let icon = if id == "brightness" {
                "nd-display-brightness"
            } else {
                status
                    .volume
                    .map_or("nd-audio-volume-high", crate::status::volume_icon)
            };
            let fill = Node::column(
                k("fill"),
                vec![
                    strut(k("top"), 12.),
                    Node::slot(k("value"), 24.),
                    Node::spacer(k("middle")),
                    Node::icon(k("icon"), icon, ICON),
                    strut(k("bottom"), 24.),
                ],
            )
            .align(Align::Center);
            let mut slider = Node::slider(
                key_of(Target::Slider(id)).unwrap(),
                "",
                "",
                Slider::new(0., 100., 5., (value_of(id, status) * 100.).round()).fill(),
            )
            .corner(nk_view::Corner::Pill);
            if let nk_view::Kind::Control(c) = &mut slider.kind {
                *c.child = fill;
            }
            // The fill reaches 2 from the glass.
            let inset = Node::row(
                k("inset-row"),
                vec![
                    strut(k("inset-l"), TALL_PAD),
                    Node::column(
                        k("inset"),
                        vec![
                            strut(k("inset-t"), TALL_PAD),
                            slider.grow(),
                            strut(k("inset-b"), TALL_PAD),
                        ],
                    )
                    .grow(),
                    strut(k("inset-r"), TALL_PAD),
                ],
            );
            detail_layer(inset)
        }
        (_, Size::Single) => {
            let glyph = centred_in(
                k("centre"),
                Node::icon(k("icon"), icon_of(id, status), ICON),
            );
            if toggles(id) {
                detail_layer(
                    whole(key_of(Target::Tile(id)), title, glyph)
                        .role(Role::Toggle)
                        .on(on),
                )
            } else {
                whole(key_of(primary(id, size)), title, glyph)
            }
        }
        _ => {
            // A capsule: the badge, then the title over its subtitle.
            let lit = on && has_state(id);
            let face = boxed(k("icon"), icon_of(id, status), ICON, BADGE, Ink::Primary);
            let badge = match primary(id, size) {
                Target::Badge(_) => Node::control(key_of(Target::Badge(id)).unwrap(), "", "", face)
                    .role(Role::Toggle),
                // A badge that is only a picture of the state: no pointer, no Tab stop.
                _ => Node::control(k("well"), "", "", face).enabled(false),
            }
            .surface()
            .on(lit);
            let row = Node::row(
                k("row"),
                vec![
                    strut(k("lead"), TILE_PAD + BADGE_IN),
                    badge,
                    strut(k("gap"), BADGE_GAP),
                    titles(title.clone(), sub),
                    strut(k("end"), TILE_PAD),
                ],
            )
            .align(Align::Center);
            let key = match primary(id, size) {
                Target::Tile(_) => key_of(Target::Tile(id)),
                _ => key_of(Target::OpenDetail(id)),
            };
            let control = whole(key, title, row);
            if toggles(id) && primary(id, size) == Target::Tile(id) {
                control.role(Role::Toggle)
            } else {
                control
            }
        }
    };
    Node::pane(format!("p:{id}"), corner, content)
}

/// What the surface paints itself in the view's slots: covers, the battery's glyph, the
/// resource rings and their numbers, a slider's value as it moves.
fn paint_slots(
    c: &mut Canvas,
    look: &mut Look,
    state: &nk_view::ViewState,
    status: &Status,
    cover: Option<&Raster>,
    glyph: &mut dyn FnMut(&str, f64) -> Option<Arc<nk_icons::Icon>>,
) -> nk_wayland::Result<()> {
    for n in state.placed() {
        let (Some((id, part)), Some(visible)) = (n.key.0.split_once('/'), n.visible()) else {
            continue;
        };
        if n.alpha <= 0. || !matches!(n.what, nk_view::What::Icon(ref i) if i.name.is_empty()) {
            continue;
        }
        let r = n.rect;
        c.push_opacity(n.alpha);
        c.clip(rect(visible));
        match (id, part) {
            ("media", "cover") => {
                let radius = if r[2] >= layout::UNIT {
                    r[2] / 2.
                } else if r[2] > 50. {
                    15.
                } else {
                    10.
                };
                match cover {
                    Some(art) => {
                        c.clip_rounded_rect(rect(r), radius);
                        c.image(art, rect(r), ImageFit::Cover);
                        c.pop_clip();
                    }
                    None if r[2] >= layout::UNIT => {
                        if let Some(i) = glyph("nd-media-playback-start", 22.) {
                            c.icon(&i, centred(r, 22.), ink(1.));
                        }
                    }
                    None => c.rounded_rect(rect(r), radius, ink(SURFACE as f32)),
                }
            }
            ("battery", "glyph") => {
                if let Some(b) = status.battery {
                    crate::bar::paint_battery(c, rect(r), b);
                }
            }
            ("cpu_memory", ring) if ring.starts_with("ring") => {
                let (cpu, ram) = status.aux.resources.unwrap_or((0., 0.));
                let value = if ring == "ring0" { cpu } else { ram };
                let large = r[2] > 40.;
                let (cx, cy) = (r[0] + r[2] / 2., r[1] + r[3] / 2.);
                let width = if large { 5. } else { 4. };
                c.progress_arc((cx, cy), r[2] / 2. - 3., width, 1., ink(0.18));
                c.progress_arc((cx, cy), r[2] / 2. - 3., width, value, ink(1.));
                let number = if status.aux.resources.is_some() {
                    format!("{:.0}", value * 100.)
                } else {
                    "—".into()
                };
                let style = TextStyle {
                    size: if large { 18. } else { 12. },
                    ..look.styles.text.clone()
                };
                let l = lay_out(look, &number, &style, f32::MAX)?;
                let m = l.measured_size();
                c.layout(
                    &l,
                    (
                        (cx - f64::from(m.width) / 2.) as f32,
                        (cy - f64::from(m.height) / 2.) as f32,
                    ),
                    ink(1.),
                )?;
            }
            ("volume" | "brightness", "value") => {
                let key = key_of(Target::Slider(if id == "volume" {
                    "volume"
                } else {
                    "brightness"
                }))
                .unwrap();
                let value = state.value(&key).unwrap_or(0.);
                let label = format!("{value}%");
                let tall = state.rect(&key).is_some_and(|s| s[3] > s[2]);
                let style = if tall {
                    style(look, TEXT, BOLD)
                } else {
                    style(look, SMALL, 400.)
                };
                let l = lay_out(look, &label, &style, f32::MAX)?;
                let m = l.measured_size();
                let (w, h) = (f64::from(m.width), f64::from(m.height));
                let y = r[1] + (r[3] - h) / 2.;
                if tall {
                    // Over the fill it turns dark, as nk-view's own content does.
                    let s = state.rect(&key).unwrap_or(r);
                    let top = s[1] + s[3] * (1. - value / 100.);
                    let colour = if y + h / 2. >= top {
                        Color::new([0., 0., 0., 0.85])
                    } else {
                        ink(1.)
                    };
                    c.layout(&l, ((r[0] + (r[2] - w) / 2.) as f32, y as f32), colour)?;
                } else {
                    c.layout(&l, ((r[0] + r[2] - w) as f32, y as f32), ink(DIM))?;
                }
            }
            _ => {}
        }
        c.pop_clip();
        c.pop_opacity();
    }
    Ok(())
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

/// The value's room: five digits at the small size (`width_chars: 5`).
const VALUE_W: f64 = 36.;

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

/// A 4×1's corner: not a capsule but the dock's shape, its corner at the dock's default
/// icon (owner, 2026-11-03). The notification cards take it too (owner, 2026-11-10).
pub(crate) fn wide_radius() -> f64 {
    crate::geometry::capsule_radius(64.)
}

/// A 1×1 is a circle, a 2×1 or 1×2 a capsule, a 2×2 the corner; a 4×1 is `wide_radius`.
fn radius_of(p: &Placed) -> f64 {
    let r = p.rect;
    match p.tile.size {
        Size::Square => SQUARE_RADIUS,
        Size::FullWidth => wide_radius(),
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
    sized(&look.styles.text, size, weight)
}
fn sized(base: &TextStyle, size: f32, weight: f32) -> TextStyle {
    let mut s = base.clone();
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
                    cc.open_detail("screenshot", &status, None);
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
            cc.place(900., 36., &status, &stored, None);
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
            cc.place(900., 36., &status, &stored, None);
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
        cc.place(1916., 36., &status(), &Default::default(), None);
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

    /// The grid laid out as the bar lays it, with the exported tokens; None (skipped)
    /// without them.
    fn laid(s: &Status, stored: &layout::Stored) -> Option<(Cc, nk_view::Tokens)> {
        let mut cc = Cc::new();
        cc.place(1916., 36., s, stored, None);
        relaid(&mut cc, s).map(|t| (cc, t))
    }
    fn relaid(cc: &mut Cc, s: &Status) -> Option<nk_view::Tokens> {
        let tokens = crate::nc_view::exported_tokens()?;
        cc.tokens = Some(tokens.clone());
        let view = grid_view(&cc.tiles, s, None, &TextStyle::default());
        let mut text =
            nk_text::ParleyBackend::new(Arc::new(nk_text::FontSet::discover_required().unwrap()))
                .unwrap();
        cc.lay_view(&view, &tokens, &mut text);
        Some(tokens)
    }
    fn centre(r: [f64; 4]) -> (f64, f64) {
        (r[0] + r[2] / 2., r[1] + r[3] / 2.)
    }
    fn rect_of(cc: &Cc, t: Target) -> [f64; 4] {
        cc.state.rect(&key_of(t).unwrap()).unwrap()
    }
    /// A press and its release where it went down: what either asked.
    fn click(cc: &mut Cc, p: (f64, f64), s: &Status) -> Option<Act> {
        let pressed = cc.press(p, s);
        cc.release(s).1.or(pressed)
    }

    #[test]
    fn clicks_land_on_what_acts() {
        let mut s = status();
        let Some((mut cc, _)) = laid(&s, &Default::default()) else {
            return;
        };
        // Appearance at 2×1: the whole capsule.
        let dark = placed(&cc, "dark_mode");
        assert_eq!(click(&mut cc, centre(dark.rect), &s), Some(Act::Dark(true)));
        // Night Light at 2×1: only its badge; the body is its detail's (B2.2).
        let night = placed(&cc, "night_light");
        let badge = rect_of(&cc, Target::Badge("night_light"));
        assert_eq!(
            badge,
            [
                night.rect[0] + TILE_PAD + BADGE_IN,
                night.rect[1] + (night.rect[3] - BADGE) / 2.,
                BADGE,
                BADGE
            ]
        );
        assert_eq!(click(&mut cc, centre(badge), &s), Some(Act::Night(true)));
        assert_eq!(
            click(&mut cc, centre(night.rect), &s),
            Some(Act::OpenDetail("night_light"))
        );
        // A screenshot at 1×1 is a real detail entry.
        let shot = placed(&cc, "screenshot").rect;
        assert_eq!(
            click(&mut cc, centre(shot), &s),
            Some(Act::OpenDetail("screenshot"))
        );
        // A press that leaves its button before it is released does nothing.
        assert_eq!(cc.press(centre(shot), &s), None);
        cc.motion((shot[0] - 30., shot[1] - 30.), &s);
        assert_eq!(cc.release(&s).1, None);
        // The volume's track: the value under the pointer, held while dragged.
        let t = rect_of(&cc, Target::Slider("volume"));
        let v = placed(&cc, "volume").rect;
        assert!(t[0] > v[0] + 40. && t[0] + t[2] < v[0] + v[2] - 80.);
        assert_eq!(
            cc.press((t[0] + t[2] - 1., t[1] + t[3] / 2.), &s),
            Some(Act::Volume(1.))
        );
        assert!(cc.dragging());
        let (_, act) = cc.motion((t[0] - 50., t[1]), &s);
        assert_eq!(act, Some(Act::Volume(0.)));
        assert_eq!(cc.shown("volume", &s), 0.);
        assert!(cc.release(&s).0);
        assert!(!cc.dragging());
        // Released, it shows where it was let go until the service's value is laid out.
        assert_eq!(cc.shown("volume", &s), 0.);
        relaid(&mut cc, &s);
        assert_eq!(cc.shown("volume", &s), 0.4);
        // Brightness: the device's raw range.
        s.brightness = Some(Brightness {
            device: "panel".into(),
            epoch: 3,
            min: 0,
            max: 400,
            current: 100,
        });
        cc.place(1916., 36., &s, &Default::default(), None);
        relaid(&mut cc, &s);
        let t = rect_of(&cc, Target::Slider("brightness"));
        assert_eq!(
            cc.press((t[0] + t[2] - 1., t[1] + t[3] / 2.), &s),
            Some(Act::Brightness {
                device: "panel".into(),
                epoch: 3,
                raw: 400
            })
        );
    }

    #[test]
    fn the_keyboard_walks_the_readers_order_and_moves_a_slider_by_its_step() {
        let s = status();
        let Some((mut cc, _)) = laid(&s, &Default::default()) else {
            return;
        };
        let key = |sym: u32| nk_wayland::Key {
            serial: None,
            sym,
            text: String::new(),
            shift: false,
            ctrl: false,
            alt: false,
        };
        let order: Vec<_> = cc
            .nodes(0, &s, None)
            .into_iter()
            .filter(|(n, _)| !n.actions.is_empty())
            .map(|(_, t)| t)
            .collect();
        for t in &order {
            cc.key(&key(0xff09), &s);
            assert_eq!(
                cc.editor.focus.map(Target::Edit).or_else(|| cc.focused()),
                Some(*t)
            );
            let focused: Vec<_> = cc
                .nodes(0, &s, None)
                .into_iter()
                .filter(|(n, _)| n.states.focused)
                .map(|(_, t)| t)
                .collect();
            if !matches!(t, Target::Edit(_)) {
                assert_eq!(focused, vec![*t]);
            }
        }
        // Focus on the volume: the arrows move it by its step from what the service says.
        cc.focus(Target::Slider("volume"));
        assert_eq!(cc.key(&key(0xff53), &s), Some(Act::Volume(0.45)));
        // Enter on a toggle toggles it.
        cc.focus(Target::Tile("dark_mode"));
        assert_eq!(cc.key(&key(0xff0d), &s), Some(Act::Dark(true)));
    }

    #[test]
    fn back_from_a_detail_focuses_the_tile_that_opened_it() {
        let s = status();
        let Some((mut cc, _)) = laid(&s, &Default::default()) else {
            return;
        };
        // The pointer pressed Back: the tile has the focus, without its ring.
        cc.open_detail("screenshot", &s, None);
        assert!(cc.back());
        cc.place(1916., 36., &s, &Default::default(), None);
        relaid(&mut cc, &s);
        assert_eq!(cc.focused(), Some(Target::OpenDetail("screenshot")));
        assert!(!cc.state.focus_visible());
        // Escape: with it.
        cc.open_detail("screenshot", &s, None);
        assert!(cc.back_by(true));
        cc.place(1916., 36., &s, &Default::default(), None);
        relaid(&mut cc, &s);
        assert_eq!(cc.focused(), Some(Target::OpenDetail("screenshot")));
        assert!(cc.state.focus_visible());
    }

    #[test]
    fn what_is_on_is_white_and_the_hover_is_one_wash() {
        let mut s = status();
        s.dnd = true;
        let mut stored = layout::Stored::default();
        stored.positions.insert("focus".into(), (0, 0));
        stored.sizes.insert("focus".into(), "1x1".into());
        stored.positions.insert("dark_mode".into(), (1, 0));
        stored.sizes.insert("dark_mode".into(), "2x1".into());
        let Some((mut cc, tokens)) = laid(&s, &stored) else {
            return;
        };
        let washes = |cc: &mut Cc| {
            cc.last = cc.state.frame(&tokens, std::time::Instant::now());
            cc.states(&s)
        };
        let at = |w: &[StateRegion], r: [f64; 4]| {
            w.iter()
                .filter(|x| [x.bounds.x, x.bounds.y, x.bounds.width, x.bounds.height] == r)
                .map(|x| x.wash)
                .collect::<Vec<_>>()
        };
        let w = washes(&mut cc);
        // A 1×1 that is on: its whole tile white.
        let focus = placed(&cc, "focus");
        assert_eq!(at(&w, focus.rect), vec![[1., 1., 1., 1.]]);
        // Appearance (light) at 2×1: its badge at rest in the surface, its tile clear.
        let dark = placed(&cc, "dark_mode");
        assert!(at(&w, dark.rect).iter().all(|x| x[3] == 0.));
        let badge = [
            dark.rect[0] + TILE_PAD + BADGE_IN,
            dark.rect[1] + (dark.rect[3] - BADGE) / 2.,
            BADGE,
            BADGE,
        ];
        let rest = at(&w, badge);
        assert_eq!(rest.len(), 1);
        assert!((rest[0][3] - SURFACE).abs() < 0.005);
        // Hovered: the one hover wash over the tile, nothing else lit.
        cc.motion((dark.rect[0] + 100., dark.rect[1] + 30.), &s);
        let w = washes(&mut cc);
        assert_eq!(at(&w, dark.rect), vec![tokens.washes.hover]);
        assert_eq!(
            w.iter().filter(|x| x.wash == tokens.washes.hover).count(),
            1
        );
    }

    #[test]
    fn a_tile_past_the_viewport_takes_no_hover_and_no_press() {
        let s = status();
        let Some((mut cc, tokens)) = laid(&s, &Default::default()) else {
            return;
        };
        // An output short enough that the last row lies past the viewport.
        cc.detail_height = 300.;
        cc.place(1916., 36., &s, &Default::default(), None);
        relaid(&mut cc, &s);
        let v = cc.editor.viewport;
        let bottom = v[1] + v[3];
        let hidden = cc
            .tiles
            .iter()
            .find(|p| p.rect[1] + p.rect[3] > bottom + 10.)
            .copied()
            .expect("a row past the viewport");
        let p = (
            hidden.rect[0] + hidden.rect[2] / 2.,
            bottom.max(hidden.rect[1]) + 5.,
        );
        cc.motion(p, &s);
        cc.last = cc.state.frame(&tokens, std::time::Instant::now());
        assert!(cc.states(&s).iter().all(|x| x.wash != tokens.washes.hover));
        assert_eq!(click(&mut cc, p, &s), None);
    }
}
