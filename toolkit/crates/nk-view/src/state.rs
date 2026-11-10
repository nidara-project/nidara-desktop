// SPDX-License-Identifier: LGPL-3.0-or-later
//! The interaction state the toolkit derives (VIEW.md §4): hover, press and focus, kept by key
//! across rebuilds; the panes and state regions a frame declares to Hyalo, within its budget;
//! the semantics; and the content paint (texts, icons, the focus ring, and the D5 washes).
use crate::layout::{Layouter, Placed, Rect, TextCache, What};
use crate::motion::{MotionState, SWIPE_CLAIM};
use crate::tokens::Tokens;
use crate::view::{Key, Node, Role, Wash};
use nk_a11y::{Action, Bounds, NodeId, Tree};
use nk_render::Canvas;
use nk_wayland::{Group, MaterialRect, Pane, Shadow, StateRegion, Tone};
use nk_widgets::{BarGeometry, ScrollBar};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// Hyalo lays at most this many washes over one shape (`render/glass_gl.rs`, `STATE_MAX`).
pub const BUDGET: usize = 8;

/// What the surface receives when a control is activated, by pointer or keyboard.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Activated {
    pub key: Key,
    pub action: String,
}

/// The keys that move focus, activate or scroll.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyInput {
    Tab,
    ShiftTab,
    /// Enter or Space on the focused control.
    Activate,
    /// Page Up and Page Down: the scroll region holding the focus (else the one under the
    /// pointer, else the first) moves by most of a page.
    PageUp,
    PageDown,
    /// Ctrl+Home and Ctrl+End: that region goes to its start or its end.
    Home,
    End,
}

/// How far a wheel or a touchpad scrolled: in logical pixels (a touchpad), or in wheel
/// detents, each a step that grows with the viewport (VIEW.md §8).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ScrollBy {
    Pixels(f64),
    Steps(f64),
}

impl From<nk_wayland::ScrollAmount> for ScrollBy {
    /// A wheel's scroll goes by its detents; any other by its pixels.
    fn from(a: nk_wayland::ScrollAmount) -> Self {
        a.detents.map_or(Self::Pixels(a.pixels), Self::Steps)
    }
}

/// What of a page Page Up and Page Down move, and a wheel detent's step: the viewport's
/// height to this power. Both are GTK's (`GtkViewport`, `GtkScrolledWindow`), which the TS
/// shell scrolled with.
const PAGE: f64 = 0.9;
const STEP_POWER: f64 = 2. / 3.;

/// What one frame declares to Hyalo: a shape per visible pane, and the state regions.
#[derive(Clone, Debug, Default)]
pub struct Frame {
    pub panes: Vec<FramePane>,
    pub states: Vec<StateRegion>,
}
/// One pane's shape at its whole size, what of it may show (cut straight where a reveal
/// ends), and how formed its glass is (its content's opacity, so glass and content come and
/// go together).
#[derive(Clone, Debug)]
pub struct FramePane {
    pub key: Key,
    pub pane: Pane,
    pub clip: Option<Rect>,
    pub opacity: f64,
}
impl Frame {
    /// The panes as material groups in the surface's tone and shadow, in order: one group
    /// per run of panes that share a clip and an opacity (`add_shape_clipped`).
    pub fn groups(&self, tone: Tone, shadow: Shadow) -> Vec<Group> {
        let mut out: Vec<(Option<Rect>, f64, Vec<Pane>)> = vec![];
        for p in &self.panes {
            match out.last_mut() {
                Some((clip, opacity, shapes)) if *clip == p.clip && *opacity == p.opacity => {
                    shapes.push(p.pane)
                }
                _ => out.push((p.clip, p.opacity, vec![p.pane])),
            }
        }
        out.into_iter()
            .map(|(clip, opacity, shapes)| Group {
                clip: clip.map(|c| MaterialRect {
                    x: c[0],
                    y: c[1],
                    width: c[2],
                    height: c[3],
                }),
                opacity,
                tone,
                shadow,
                shapes,
            })
            .collect()
    }
}

/// What `tick` reports: whether something still moves, and the controls swiped away whose
/// fling just ended.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Ticked {
    pub animating: bool,
    pub activated: Vec<Activated>,
}

/// A press on a swipeable control, until it is released.
struct Drag {
    key: Key,
    origin: (f64, f64),
    dx: f64,
    claimed: bool,
}

pub struct ViewState {
    placed: Vec<Placed>,
    /// The placement before swipes move it; what a rebuild compares panes against.
    laid: Vec<Placed>,
    now: Instant,
    drag: Option<Drag>,
    /// The tokens of the last layout, for input between frames.
    tokens: Option<Tokens>,
    /// Each scroll region's offset by key, as last clamped, or as input asked since.
    offsets: HashMap<Key, f64>,
    /// An offset changed since the last layout; the next `tick` lays the view out.
    pending: bool,
    bars: HashMap<Key, ScrollBar>,
    /// A bar is showing, fading or waiting to hide.
    bars_busy: bool,
    view: Option<Node>,
    /// Where the view lies on the surface: the root takes this whole rect.
    bounds: Rect,
    scale: f64,
    motion: MotionState,
    text: TextCache,
    pointer: Option<(f64, f64)>,
    hover: Option<Key>,
    press: Option<Key>,
    focus: Option<Key>,
    focus_visible: bool,
    ids: HashMap<Key, u32>,
    id_base: u32,
    /// Each semantic node's id, by key and kind, for the view's life: a reader holds ids
    /// across updates, and nk-a11y refuses an id that comes back as another role.
    semantic_ids: HashMap<(Key, nk_a11y::Role), NodeId>,
    next_semantic: NodeId,
    /// The regions that showed a wash in the last frame.
    lit: HashSet<Key>,
    /// Regions fading out, until when (they still take a place in Hyalo's eight).
    fading: HashMap<Key, Instant>,
    overflow_logged: bool,
}

impl ViewState {
    /// `id_base`: where this view's region ids start, so they never meet the surface's
    /// others on the same material.
    pub fn new(id_base: u32) -> Self {
        Self {
            placed: vec![],
            laid: vec![],
            now: Instant::now(),
            drag: None,
            tokens: None,
            offsets: HashMap::new(),
            pending: false,
            bars: HashMap::new(),
            bars_busy: false,
            view: None,
            bounds: [0.; 4],
            scale: 1.,
            motion: MotionState::default(),
            text: TextCache::default(),
            pointer: None,
            hover: None,
            press: None,
            focus: None,
            focus_visible: false,
            ids: HashMap::new(),
            id_base,
            semantic_ids: HashMap::new(),
            next_semantic: 0,
            lit: HashSet::new(),
            fading: HashMap::new(),
            overflow_logged: false,
        }
    }

    /// Lays a rebuilt view out at `now`. A reveal whose `open` changed starts to ease, and a
    /// pane the rebuild moved slides from where it was drawn (VIEW.md §6). States whose control
    /// left, or was disabled, are cleared; hover is recomputed under the pointer, since the
    /// layout may have moved under it.
    pub fn layout(
        &mut self,
        view: &Node,
        size: (f64, f64),
        scale: f64,
        tokens: &Tokens,
        text: &mut dyn nk_text::TextBackend,
        now: Instant,
    ) {
        self.layout_in(view, [0., 0., size.0, size.1], scale, tokens, text, now);
    }

    /// `layout` for a view that takes only `bounds` of its surface (a panel along one edge):
    /// everything it gives back, from hit-testing to the regions, is in surface coordinates.
    pub fn layout_in(
        &mut self,
        view: &Node,
        bounds: Rect,
        scale: f64,
        tokens: &Tokens,
        text: &mut dyn nk_text::TextBackend,
        now: Instant,
    ) {
        let before: HashMap<Key, Rect> = self
            .laid
            .iter()
            .filter(|p| matches!(p.what, What::Pane(_)))
            .map(|p| (p.key.clone(), p.rect))
            .collect();
        self.motion.view(view, now, &tokens.motion);
        self.tokens = Some(tokens.clone());
        self.view = Some(view.clone());
        self.bounds = bounds;
        self.scale = scale;
        self.relayout(tokens, text, now, Some(&before));
        let live: HashSet<Key> = self
            .controls()
            .filter(|&i| self.enabled(i))
            .map(|i| self.placed[i].key.clone())
            .collect();
        for state in [&mut self.press, &mut self.focus] {
            if state.as_ref().is_some_and(|k| !live.contains(k)) {
                *state = None;
            }
        }
        self.ids.retain(|k, _| live.contains(k));
        if self.drag.as_ref().is_some_and(|d| !live.contains(&d.key)) {
            self.drag = None;
        }
        self.rehover();
    }

    /// Advances the motion to `now` and lays the view out again if anything moved. Reports
    /// whether something still moves, so the surface asks for another frame, and each control
    /// whose swipe took it off the surface, with its swipe action: the surface drops it from
    /// its model, and the panes below slide up.
    pub fn tick(
        &mut self,
        tokens: &Tokens,
        text: &mut dyn nk_text::TextBackend,
        now: Instant,
    ) -> Ticked {
        if !self.animating() {
            return Ticked::default();
        }
        let moving = self.motion.animating() || self.pending;
        let activated = self
            .motion
            .finished(now)
            .into_iter()
            .map(|(key, action)| Activated { key, action })
            .collect();
        if moving {
            self.relayout(tokens, text, now, None);
            self.rehover();
        }
        self.bars_busy = false;
        for bar in self.bars.values_mut() {
            self.bars_busy |= bar.tick(&tokens.scrollbar, now).1;
        }
        Ticked {
            animating: self.animating(),
            activated,
        }
    }

    /// Whether a reveal eases, a pane slides, a scroll waits to be laid out, or a scroll bar
    /// shows: the surface keeps calling `tick`.
    pub fn animating(&self) -> bool {
        self.motion.animating() || self.pending || self.bars_busy
    }

    /// Reduced motion: reveals and slides land at once.
    pub fn set_reduced_motion(&mut self, on: bool) {
        self.motion.reduced = on;
    }

    fn relayout(
        &mut self,
        tokens: &Tokens,
        text: &mut dyn nk_text::TextBackend,
        now: Instant,
        rebuilt: Option<&HashMap<Key, Rect>>,
    ) {
        let Some(view) = &self.view else {
            return;
        };
        let reveals = self.motion.progress(now);
        let anchors = if rebuilt.is_some() {
            self.anchors()
        } else {
            vec![]
        };
        let mut placed = Layouter {
            spacing: &tokens.spacing,
            reveals: &reveals,
            offsets: &self.offsets,
            text: &mut *text,
            cache: &mut self.text,
            scale: self.scale,
        }
        .run(view, self.bounds);
        // A rebuild keeps what the reader was looking at in place: each scrolled region's
        // first pane in view stays where it was drawn, whatever changed above it.
        let mut anchored = false;
        for (region, pane, was) in anchors {
            let at = |k: &Key| placed.iter().position(|p| &p.key == k);
            if let (Some(r), Some(p)) = (at(&region), at(&pane)) {
                let moved = placed[p].rect[1] - placed[r].rect[1] - was;
                if moved.abs() > 1e-6 {
                    *self.offsets.entry(region).or_default() += moved;
                    anchored = true;
                }
            }
        }
        if anchored {
            placed = Layouter {
                spacing: &tokens.spacing,
                reveals: &reveals,
                offsets: &self.offsets,
                text,
                cache: &mut self.text,
                scale: self.scale,
            }
            .run(view, self.bounds);
        }
        self.offsets = placed
            .iter()
            .filter_map(|p| match p.what {
                What::Scroll { offset, .. } => Some((p.key.clone(), offset)),
                _ => None,
            })
            .collect();
        self.bars.retain(|k, _| self.offsets.contains_key(k));
        self.pending = false;
        if let Some(before) = rebuilt {
            self.motion.moved(before, &placed, now);
        }
        self.motion
            .slide(&mut placed, now, &tokens.motion, self.scale);
        self.now = now;
        self.laid = placed;
        self.reswipe();
    }

    /// Each scrolled region's first pane in view, and how far below the region's top it is.
    fn anchors(&self) -> Vec<(Key, Key, f64)> {
        let laid = &self.laid;
        laid.iter()
            .enumerate()
            .filter_map(|(s, p)| {
                let What::Scroll { offset, .. } = p.what else {
                    return None;
                };
                let viewport = p.visible().filter(|_| offset > 0.)?;
                let a = laid.iter().find(|q| {
                    q.scroll == Some(s)
                        && matches!(q.what, What::Pane(_))
                        && q.visible().is_some_and(|v| overlaps(v, viewport))
                })?;
                Some((p.key.clone(), a.key.clone(), a.rect[1] - p.rect[1]))
            })
            .collect()
    }

    /// The placement with the swipes in force at the last instant laid out.
    fn reswipe(&mut self) {
        let mut placed = self.laid.clone();
        self.motion.swipe(
            &mut placed,
            self.now,
            self.bounds[0] + self.bounds[2],
            self.scale,
        );
        self.placed = placed;
    }

    pub fn placed(&self) -> &[Placed] {
        &self.placed
    }
    pub fn text(&self) -> &TextCache {
        &self.text
    }
    pub fn hover(&self) -> Option<&Key> {
        self.hover.as_ref()
    }
    pub fn press(&self) -> Option<&Key> {
        self.press.as_ref()
    }
    pub fn focus(&self) -> Option<&Key> {
        self.focus.as_ref()
    }
    pub fn rect(&self, key: &Key) -> Option<Rect> {
        self.placed.iter().find(|p| &p.key == key).map(|p| p.rect)
    }

    fn controls(&self) -> impl Iterator<Item = usize> + '_ {
        self.placed
            .iter()
            .enumerate()
            .filter(|(_, p)| matches!(p.what, What::Control(_)) && p.alpha > 0.)
            .map(|(i, _)| i)
    }
    fn control(&self, i: usize) -> &crate::view::Control {
        match &self.placed[i].what {
            What::Control(c) => c,
            _ => unreachable!("not a control"),
        }
    }
    fn enabled(&self, i: usize) -> bool {
        self.control(i).enabled
    }
    fn index(&self, key: &Key) -> Option<usize> {
        self.placed.iter().position(|p| &p.key == key)
    }
    /// The panes a node lies in, innermost first.
    fn panes_of(&self, i: usize) -> impl Iterator<Item = usize> + '_ {
        std::iter::successors(self.placed[i].pane, |&p| self.placed[p].pane)
    }

    /// Whether a control is drawn: always, or while its pane is under the pointer or holds
    /// the focus.
    pub fn shown(&self, i: usize) -> bool {
        if self.placed[i].visible().is_none() {
            return false;
        }
        let Some(pane) = &self.control(i).revealed_with else {
            return true;
        };
        let Some(p) = self.index(pane) else {
            return false;
        };
        let pointer = self
            .pointer
            .is_some_and(|pt| inside(self.placed[p].rect, pt));
        let focus = self
            .focus
            .as_ref()
            .and_then(|k| self.index(k))
            .is_some_and(|f| self.panes_of(f).any(|q| q == p));
        pointer || focus
    }

    /// The innermost shown, enabled control under a point; a shown scroll bar's lane takes
    /// the point from what lies under it.
    fn hit(&self, pt: (f64, f64)) -> Option<usize> {
        if self.on_bar(pt).is_some() {
            return None;
        }
        self.controls()
            .filter(|&i| {
                self.enabled(i)
                    && self.shown(i)
                    && self.placed[i].visible().is_some_and(|r| inside(r, pt))
            })
            .last()
    }

    fn rehover(&mut self) -> bool {
        let before = self.hover.clone();
        self.hover = self
            .pointer
            .and_then(|pt| self.hit(pt))
            .map(|i| self.placed[i].key.clone());
        self.hover != before
    }

    /// The pointer moved; whether anything shown changed (a hover, a revealed control, a
    /// card being swiped). A press on a swipeable control that has gone further across than
    /// down, past the claim distance, becomes a swipe: the press is cancelled, so its release
    /// activates nothing, and the card follows the pointer across (VIEW.md §7).
    pub fn pointer_motion(&mut self, x: f64, y: f64) -> bool {
        let revealed = self.revealed();
        self.pointer = Some((x, y));
        if self.bar_motion((x, y)) {
            return true;
        }
        let mut swiped = false;
        if let Some(d) = &mut self.drag {
            let (dx, dy) = (x - d.origin.0, y - d.origin.1);
            if !d.claimed && dx.abs() > SWIPE_CLAIM && dx.abs() > dy.abs() {
                d.claimed = true;
                self.press = None;
            }
            if d.claimed {
                d.dx = dx;
                self.motion.swipe_follow(&d.key, dx);
                swiped = true;
            }
        }
        if swiped {
            self.reswipe();
        }
        self.rehover() | (revealed != self.revealed()) | swiped
    }
    /// The pointer left the surface: hover clears and its wash fades, and a swipe in progress
    /// settles back.
    pub fn pointer_leave(&mut self) -> bool {
        let revealed = self.revealed();
        self.pointer = None;
        self.press = None;
        for bar in self.bars.values_mut().filter(|b| !b.dragging()) {
            bar.set_in_lane(false);
        }
        let swiped = self.end_swipe(0., self.now).is_some();
        self.rehover() | (revealed != self.revealed()) | swiped
    }

    /// Ends the drag. A claimed swipe is released `dx` across (0 settles it back), and with
    /// reduced motion a fling reports at once. None: there was no swipe.
    fn end_swipe(&mut self, dx: f64, now: Instant) -> Option<Option<Activated>> {
        let d = self.drag.take().filter(|d| d.claimed)?;
        let motion = self.tokens.as_ref()?.motion;
        let action = self
            .index(&d.key)
            .and_then(|i| self.control(i).swipe.clone())
            .unwrap_or_default();
        let out = self.motion.swipe_release(
            &d.key,
            dx,
            self.bounds[0] + self.bounds[2],
            action,
            now,
            &motion,
        );
        self.reswipe();
        Some(out.map(|action| Activated { key: d.key, action }))
    }
    /// A modal menu closed: hover is recomputed from where the pointer was sampled before
    /// the popup went (`Window::root_pointer_position`, #1030).
    pub fn reconcile_pointer(&mut self, pointer: Option<(f64, f64)>) -> bool {
        match pointer {
            Some((x, y)) => self.pointer_motion(x, y),
            None => self.pointer_leave(),
        }
    }
    fn revealed(&self) -> Vec<bool> {
        self.controls().map(|i| self.shown(i)).collect()
    }

    /// The primary button went down or up, at `now`. A release over the pressed control
    /// activates it; a release elsewhere cancels. A release that ends a swipe flings the card
    /// off past the dismiss distance or settles it back, and activates nothing then (`tick`
    /// reports the fling), except with reduced motion, where the fling lands at once.
    pub fn button(&mut self, pressed: bool, now: Instant) -> Option<Activated> {
        if pressed && let Some((s, g)) = self.pointer.and_then(|pt| self.on_bar(pt)) {
            // The bar's: a press on the empty track jumps there, then drags.
            let key = self.placed[s].key.clone();
            let offset = self.offset(s);
            let y = self.pointer.map_or(0., |p| p.1) as f32;
            let to = self
                .bars
                .entry(key)
                .or_default()
                .press(&g, y, offset as f32);
            self.scroll_by(s, to as f64 - offset);
            self.press = None;
            self.drag = None;
            return None;
        }
        if !pressed && self.bars.values_mut().any(|b| b.release()) {
            self.bars_busy = true;
            return None;
        }
        if pressed {
            self.press = self.hover.clone();
            self.focus_visible = false;
            self.drag = self
                .hover
                .as_ref()
                .zip(self.pointer)
                .filter(|(k, _)| {
                    self.index(k)
                        .is_some_and(|i| self.control(i).swipe.is_some())
                })
                .map(|(k, origin)| Drag {
                    key: k.clone(),
                    origin,
                    dx: 0.,
                    claimed: false,
                });
            return None;
        }
        let dx = self.drag.as_ref().map_or(0., |d| d.dx);
        if let Some(flung) = self.end_swipe(dx, now) {
            return flung;
        }
        self.drag = None;
        let pressed = self.press.take()?;
        let i = self.pointer.and_then(|pt| self.hit(pt))?;
        (self.placed[i].key == pressed).then(|| Activated {
            key: pressed,
            action: self.control(i).action.clone(),
        })
    }

    /// Tab and Shift+Tab move focus through every enabled control in tree order, revealed or
    /// not; Enter or Space activates the focused one.
    pub fn key(&mut self, k: KeyInput) -> Option<Activated> {
        if matches!(
            k,
            KeyInput::PageUp | KeyInput::PageDown | KeyInput::Home | KeyInput::End
        ) {
            let s = self.key_region()?;
            let (offset, h) = (self.offset(s), self.placed[s].rect[3]);
            let delta = match k {
                KeyInput::PageUp => -PAGE * h,
                KeyInput::PageDown => PAGE * h,
                KeyInput::Home => -offset,
                _ => f64::INFINITY,
            };
            self.scroll_by(s, delta);
            return None;
        }
        let order: Vec<usize> = self.controls().filter(|&i| self.enabled(i)).collect();
        if order.is_empty() {
            return None;
        }
        let at = self
            .focus
            .as_ref()
            .and_then(|f| order.iter().position(|&i| &self.placed[i].key == f));
        match k {
            KeyInput::Tab | KeyInput::ShiftTab => {
                let n = order.len();
                let next = match (at, k) {
                    (None, KeyInput::Tab) => 0,
                    (None, _) => n - 1,
                    (Some(a), KeyInput::Tab) => (a + 1) % n,
                    (Some(a), _) => (a + n - 1) % n,
                };
                self.focus = Some(self.placed[order[next]].key.clone());
                self.focus_visible = true;
                self.scroll_to_focus(order[next]);
                None
            }
            KeyInput::Activate => {
                let i = order[at?];
                Some(Activated {
                    key: self.placed[i].key.clone(),
                    action: self.control(i).action.clone(),
                })
            }
            _ => None,
        }
    }

    /// The wheel or the touchpad scrolled the innermost region under the pointer. False when
    /// it could not move (nothing under the pointer scrolls, or it is at that end). The new
    /// offset is laid out at the next `tick`.
    pub fn scroll(&mut self, by: ScrollBy) -> bool {
        let Some(pt) = self.pointer else {
            return false;
        };
        let Some(s) = self.regions().filter(|&s| self.over(s, pt)).last() else {
            return false;
        };
        let delta = match by {
            ScrollBy::Pixels(d) => d,
            ScrollBy::Steps(n) => n * self.placed[s].rect[3].powf(STEP_POWER),
        };
        self.scroll_by(s, delta)
    }

    /// What of a scroll region's content shows: its offset and its viewport's height. The
    /// surface builds the rows inside it and leaves placeholders for the rest (VIEW.md §8).
    pub fn window(&self, key: &Key) -> Option<(f64, f64)> {
        let s = self.index(key)?;
        matches!(self.placed[s].what, What::Scroll { .. })
            .then(|| (self.offset(s), self.placed[s].rect[3]))
    }

    fn regions(&self) -> impl Iterator<Item = usize> + '_ {
        self.placed
            .iter()
            .enumerate()
            .filter(|(_, p)| matches!(p.what, What::Scroll { .. }) && p.alpha > 0.)
            .map(|(i, _)| i)
    }
    fn over(&self, s: usize, pt: (f64, f64)) -> bool {
        self.placed[s].visible().is_some_and(|r| inside(r, pt))
    }
    /// A region's offset: what input asked for since the last layout, or what was laid out.
    fn offset(&self, s: usize) -> f64 {
        let p = &self.placed[s];
        self.offsets.get(&p.key).copied().unwrap_or(match p.what {
            What::Scroll { offset, .. } => offset,
            _ => 0.,
        })
    }
    /// Moves region `s` by `delta`, within its content and on the device grid. False when it
    /// could not move. Its bar shows.
    fn scroll_by(&mut self, s: usize, delta: f64) -> bool {
        let What::Scroll { content, .. } = self.placed[s].what else {
            return false;
        };
        let old = self.offset(s);
        let max = (content - self.placed[s].rect[3]).max(0.);
        let to = ((old + delta).clamp(0., max) * self.scale).round() / self.scale;
        if to == old {
            return false;
        }
        let key = self.placed[s].key.clone();
        self.offsets.insert(key.clone(), to);
        self.pending = true;
        self.bars.entry(key).or_default().reveal();
        self.bars_busy = true;
        true
    }
    /// The region the scroll keys act on: the focus's, else the pointer's, else the first.
    fn key_region(&self) -> Option<usize> {
        let focus = self.focus.as_ref().and_then(|k| self.index(k));
        focus
            .and_then(|f| self.placed[f].scroll)
            .or_else(|| {
                let pt = self.pointer?;
                self.regions().filter(|&s| self.over(s, pt)).last()
            })
            .or_else(|| self.regions().next())
    }
    /// Keyboard focus that lands on a control out of its region's view scrolls it in, by as
    /// little as shows it (GTK's viewport did the same).
    fn scroll_to_focus(&mut self, i: usize) {
        let Some(s) = self.placed[i].scroll else {
            return;
        };
        let (r, v) = (self.placed[i].rect, self.placed[s].rect);
        let delta = if r[1] < v[1] {
            r[1] - v[1]
        } else if r[1] + r[3] > v[1] + v[3] {
            (r[1] + r[3] - v[1] - v[3]).min(r[1] - v[1])
        } else {
            0.
        };
        if delta != 0. {
            self.scroll_by(s, delta);
        }
    }

    /// A region's bar, where it sits: its viewport at the region's visible rect, with the
    /// curve of its pane's corner at an end the region shares with that pane.
    fn bar_geometry(&self, s: usize) -> Option<BarGeometry> {
        let t = self.tokens.as_ref()?;
        let p = &self.placed[s];
        let What::Scroll { content, .. } = p.what else {
            return None;
        };
        let v = p.visible()?;
        let (mut top, mut bottom) = (0., 0.);
        if let Some(q) = p.pane {
            let pane = &self.placed[q];
            if let What::Pane(c) = &pane.what {
                let r = c.of(pane.rect[2], pane.rect[3], &t.radii) as f32;
                let (y0, y1) = (pane.rect[1], pane.rect[1] + pane.rect[3]);
                if (v[1] - y0).abs() < 0.5 {
                    top = r;
                }
                if (v[1] + v[3] - y1).abs() < 0.5 {
                    bottom = r;
                }
            }
        }
        t.scrollbar
            .geometry(rect(&v), content as f32, self.offset(s) as f32, top, bottom)
    }
    /// The innermost region whose shown bar's lane holds a point, and where its bar sits.
    fn on_bar(&self, pt: (f64, f64)) -> Option<(usize, BarGeometry)> {
        let regions: Vec<usize> = self.regions().collect();
        regions.into_iter().rev().find_map(|s| {
            let shown = self
                .bars
                .get(&self.placed[s].key)
                .is_some_and(|b| b.shown());
            let g = self.bar_geometry(s).filter(|_| shown)?;
            in_lane(&g, pt).then_some((s, g))
        })
    }
    /// The pointer moved: a bar being dragged takes it (true); otherwise the regions under it
    /// show their bars, and each bar learns whether the pointer is on its lane.
    fn bar_motion(&mut self, pt: (f64, f64)) -> bool {
        let regions: Vec<usize> = self.regions().collect();
        for &s in &regions {
            let key = self.placed[s].key.clone();
            let Some(g) = self.bar_geometry(s) else {
                continue;
            };
            if let Some(to) = self.bars.get(&key).and_then(|b| b.drag_to(&g, pt.1 as f32)) {
                let offset = self.offset(s);
                self.scroll_by(s, to as f64 - offset);
                return true;
            }
        }
        for s in regions {
            let key = self.placed[s].key.clone();
            let lane = self.bar_geometry(s).is_some_and(|g| in_lane(&g, pt));
            let over = self.over(s, pt);
            let bar = self.bars.entry(key).or_default();
            bar.set_in_lane(lane);
            if over {
                bar.reveal();
                self.bars_busy = true;
            }
        }
        false
    }

    fn id(&mut self, key: &Key) -> u32 {
        let next = self.id_base + self.ids.len() as u32;
        let used: HashSet<u32> = self.ids.values().copied().collect();
        *self
            .ids
            .entry(key.clone())
            .or_insert_with(|| (next..).find(|n| !used.contains(n)).unwrap_or(next))
    }

    /// The panes inside the viewport, and the state regions in Hyalo's order: per pane, the
    /// shown washes by priority (press, hover, fading, markers), never more than eight, then
    /// every other control at rest (alpha 0, so a hover fades in).
    pub fn frame(&mut self, tokens: &Tokens, now: Instant) -> Frame {
        let washes = &tokens.washes;
        let fade = Duration::from_millis(washes.fade_ms as u64);
        self.fading.retain(|_, until| *until > now);
        let viewport = self.bounds;
        let panes = self
            .placed
            .iter()
            .filter_map(|p| match (&p.what, p.visible()) {
                (What::Pane(c), Some(v)) if p.alpha > 0. && overlaps(v, viewport) => {
                    let r = p.rect;
                    Some(FramePane {
                        key: p.key.clone(),
                        pane: Pane {
                            x: r[0],
                            y: r[1],
                            width: r[2],
                            height: r[3],
                            radius: c.of(r[2], r[3], &tokens.radii),
                            exponent: 2.,
                            pointer: None,
                        },
                        clip: p.clip.filter(|_| v != r),
                        opacity: p.alpha,
                    })
                }
                _ => None,
            })
            .collect();
        // (priority, pane, control, wash); priority 4 is rest.
        let mut regions: Vec<(u8, Option<usize>, usize, [f64; 4])> = vec![];
        for i in self.controls().collect::<Vec<_>>() {
            let c = self.control(i);
            if c.wash == Wash::None
                || !self.shown(i)
                || !self.placed[i]
                    .visible()
                    .is_some_and(|r| overlaps(r, viewport))
            {
                continue;
            }
            let key = &self.placed[i].key;
            let destructive = c.wash == Wash::Destructive;
            let (hover, press) = if destructive {
                (washes.destructive_hover, washes.destructive_press)
            } else {
                (washes.hover, washes.press)
            };
            let rest = [hover[0], hover[1], hover[2], 0.];
            let (priority, wash) =
                if self.press.as_ref() == Some(key) && self.hover.as_ref() == Some(key) {
                    (0, press)
                } else if self.hover.as_ref() == Some(key) {
                    (1, hover)
                } else if self.fading.contains_key(key) {
                    (2, rest)
                } else if c.marked {
                    (3, washes.hover)
                } else {
                    (4, rest)
                };
            regions.push((priority, self.placed[i].pane, i, wash));
        }
        regions.sort_by_key(|r| r.0);
        let mut spent: HashMap<Option<usize>, usize> = HashMap::new();
        let mut dropped = 0;
        for r in regions.iter_mut().filter(|r| r.0 < 4) {
            let n = spent.entry(r.1).or_default();
            if *n >= BUDGET {
                r.3[3] = 0.;
                dropped += 1;
            } else {
                *n += 1;
            }
        }
        if dropped > 0 && !self.overflow_logged {
            eprintln!(
                "nk-view: {dropped} state washes over the budget of {BUDGET} per pane were dropped"
            );
            self.overflow_logged = true;
        }
        let mut states = vec![];
        let mut lit = HashSet::new();
        for (_, _, i, wash) in regions {
            let key = self.placed[i].key.clone();
            if wash[3] > 0. {
                lit.insert(key.clone());
            } else if self.lit.contains(&key) {
                self.fading.insert(key.clone(), now + fade);
            }
            let Some(r) = self.placed[i].visible() else {
                continue;
            };
            let corner = self.control(i).corner;
            states.push(StateRegion {
                id: self.id(&key),
                bounds: MaterialRect {
                    x: r[0],
                    y: r[1],
                    width: r[2],
                    height: r[3],
                },
                radius: corner.of(r[2], r[3], &tokens.radii),
                wash,
                fade_ms: washes.fade_ms,
            });
        }
        self.lit = lit;
        Frame { panes, states }
    }

    /// The semantic tree: `root` holds a panel per pane and, in tree order, each control (by
    /// its name) and each text outside a control (by its whole text, never its cut). Ids
    /// start at `first_id` and stay with their node's key and role while the view lives, so
    /// a rebuild that moves, adds or drops nodes never hands a reader's id to another node.
    pub fn semantics(&mut self, root: nk_a11y::Node, first_id: NodeId) -> Tree {
        let mut nodes = std::collections::BTreeMap::new();
        let root_id = root.id;
        nodes.insert(root_id, root);
        let mut ids: HashMap<usize, NodeId> = HashMap::new();
        self.next_semantic = self.next_semantic.max(first_id);
        for i in 0..self.placed.len() {
            if !self.in_semantics(i) {
                continue;
            }
            let p = &self.placed[i];
            let mut node = match &p.what {
                What::Pane(_) => nk_a11y::Node::new(0, nk_a11y::Role::Panel, ""),
                What::Scroll { .. } => nk_a11y::Node::new(0, nk_a11y::Role::ScrollPane, ""),
                What::Control(c) => {
                    let mut n = nk_a11y::Node::new(
                        0,
                        match c.role {
                            Role::Button => nk_a11y::Role::Button,
                            Role::Toggle => nk_a11y::Role::ToggleButton,
                        },
                        c.name.clone(),
                    );
                    n.states.disabled = !c.enabled;
                    n.states.checked = c.role == Role::Toggle && c.marked;
                    n.states.focused = self.focus.as_ref() == Some(&p.key);
                    n.actions = vec![Action::Focus, Action::Activate];
                    n
                }
                What::Text { full, .. } if p.control.is_none() => {
                    nk_a11y::Node::new(0, nk_a11y::Role::Label, full.clone())
                }
                _ => continue,
            };
            let next_semantic = &mut self.next_semantic;
            let id = *self
                .semantic_ids
                .entry((p.key.clone(), node.role))
                .or_insert_with(|| {
                    *next_semantic += 1;
                    *next_semantic - 1
                });
            node.id = id;
            node.bounds = Bounds {
                x: p.rect[0],
                y: p.rect[1],
                width: p.rect[2],
                height: p.rect[3],
            };
            let parent = std::iter::successors(p.parent, |&q| self.placed[q].parent)
                .filter(|&q| matches!(self.placed[q].what, What::Pane(_) | What::Scroll { .. }))
                .find_map(|q| ids.get(&q).copied())
                .unwrap_or(root_id);
            nodes
                .get_mut(&parent)
                .expect("parent is placed first")
                .children
                .push(id);
            nodes.insert(id, node);
            ids.insert(i, id);
        }
        Tree {
            root: root_id,
            nodes,
        }
    }

    /// Whether a placed node is a node of the semantic tree: a pane, a scroll region, a
    /// control, or a text outside a control, while it shows at all.
    fn in_semantics(&self, i: usize) -> bool {
        let p = &self.placed[i];
        p.alpha > 0.
            && match &p.what {
                What::Pane(_) | What::Scroll { .. } | What::Control(_) => true,
                What::Text { .. } => p.control.is_none(),
                _ => false,
            }
    }

    /// Which control each id `semantics` gave is, for the controls placed now: what a
    /// reader's request names.
    pub fn semantic_keys(&self) -> HashMap<NodeId, Key> {
        (0..self.placed.len())
            .filter(|&i| self.in_semantics(i))
            .map(|i| &self.placed[i])
            .filter_map(|p| match &p.what {
                What::Control(c) => {
                    let role = match c.role {
                        Role::Button => nk_a11y::Role::Button,
                        Role::Toggle => nk_a11y::Role::ToggleButton,
                    };
                    let id = self.semantic_ids.get(&(p.key.clone(), role))?;
                    Some((*id, p.key.clone()))
                }
                _ => None,
            })
            .collect()
    }

    /// A reader's request on a control: focus moves to it (scrolled into view, its ring
    /// shown), or it is activated. A disabled or absent control does nothing.
    pub fn request(&mut self, key: &Key, activate: bool) -> Option<Activated> {
        let i = self
            .index(key)
            .filter(|&i| matches!(self.placed[i].what, What::Control(_)) && self.enabled(i))?;
        if activate {
            return Some(Activated {
                key: key.clone(),
                action: self.control(i).action.clone(),
            });
        }
        self.focus = Some(key.clone());
        self.focus_visible = true;
        self.scroll_to_focus(i);
        None
    }

    /// Paints the content: texts, icons, and the focus ring of the focused control when
    /// focus came from the keyboard. Glass and washes are Hyalo's; without the material
    /// protocol (D5), `fallback` paints the frame's washes too, from the same regions.
    pub fn paint(
        &self,
        canvas: &mut Canvas,
        tokens: &Tokens,
        icons: &mut dyn FnMut(&str, f64) -> Option<std::sync::Arc<nk_icons::Icon>>,
        fallback: Option<&Frame>,
    ) -> Result<(), String> {
        if let Some(frame) = fallback {
            for s in frame.states.iter().filter(|s| s.wash[3] > 0.) {
                let c = nk_render::Color::new([
                    s.wash[0] as f32,
                    s.wash[1] as f32,
                    s.wash[2] as f32,
                    s.wash[3] as f32,
                ]);
                canvas.rounded_rect(
                    rect(&[s.bounds.x, s.bounds.y, s.bounds.width, s.bounds.height]),
                    s.radius,
                    c,
                );
            }
        }
        for p in &self.placed {
            if p.control.is_some_and(|c| !self.shown(c)) {
                continue;
            }
            let Some(visible) = p.visible().filter(|_| p.alpha > 0.) else {
                continue;
            };
            let ink = |c: nk_render::Color| c.with_alpha(c.components[3] * p.alpha as f32);
            match &p.what {
                What::Text { ink: tier, .. } => {
                    if let Some(f) = self.text.get(&p.key) {
                        canvas.clip(rect(&visible));
                        let r = canvas.layout(
                            &f.layout,
                            (p.rect[0] as f32, p.rect[1] as f32),
                            ink(tokens.look.ink(*tier)),
                        );
                        canvas.pop_clip();
                        r?;
                    }
                }
                What::Icon(icon) => {
                    if let Some(glyph) = icons(&icon.name, icon.size) {
                        canvas.clip(rect(&visible));
                        canvas.icon(&glyph, rect(&p.rect), ink(tokens.look.ink(icon.ink)));
                        canvas.pop_clip();
                    }
                }
                What::Control(c) if self.focus_visible && self.focus.as_ref() == Some(&p.key) => {
                    let r = visible;
                    canvas.rounded_ring(
                        rect(&r),
                        c.corner.of(r[2], r[3], &tokens.radii),
                        tokens.look.focus_width,
                        ink(tokens.look.focus),
                    );
                }
                _ => {}
            }
        }
        for s in self.regions() {
            if let (Some(bar), Some(g)) = (self.bars.get(&self.placed[s].key), self.bar_geometry(s))
            {
                bar.paint(
                    &tokens.scrollbar,
                    &g,
                    nk_text::Point { x: 0., y: 0. },
                    canvas,
                );
            }
        }
        Ok(())
    }
}

fn rect(r: &Rect) -> nk_text::Rect {
    nk_text::Rect {
        x: r[0] as f32,
        y: r[1] as f32,
        width: r[2] as f32,
        height: r[3] as f32,
    }
}
fn in_lane(g: &BarGeometry, p: (f64, f64)) -> bool {
    let l = g.lane;
    let (x, y) = (p.0 as f32, p.1 as f32);
    x >= l.x && y >= l.y && x < l.x + l.width && y < l.y + l.height
}
fn inside(r: Rect, p: (f64, f64)) -> bool {
    p.0 >= r[0] && p.1 >= r[1] && p.0 < r[0] + r[2] && p.1 < r[1] + r[3]
}
fn overlaps(a: Rect, b: Rect) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}
