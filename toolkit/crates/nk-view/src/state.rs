// SPDX-License-Identifier: LGPL-3.0-or-later
//! The interaction state the toolkit derives (VIEW.md §4): hover, press and focus, kept by key
//! across rebuilds; the panes and state regions a frame declares to Hyalo, within its budget;
//! the semantics; and the content paint (texts, icons, the focus ring, and the D5 washes).
use crate::components::{
    Capture, ComponentLook, HostRequest, Input, Interaction, ListSpec, Membership, Outcome, Paint,
    PaintPhase, Read, ReplyTarget, Request, SemanticChild, StateStore, Value,
};
use crate::layout::{Layouter, Placed, Rect, TextCache, What};
use crate::motion::{MotionState, SWIPE_CLAIM};
use crate::tokens::Tokens;
use crate::view::{Key, Node, Role, Shown};
use nk_a11y::{Action, Bounds, NodeId, Tree};
use nk_render::Canvas;
use nk_wayland::{Group, MaterialRect, Pane, Shadow, StateRegion, Tone};
use nk_widgets::{BarGeometry, ScrollBar};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

/// Hyalo lays at most this many washes over one shape (`render/glass_gl.rs`, `STATE_MAX`).
pub const BUDGET: usize = 8;

/// What the surface receives when a control is activated, by pointer or keyboard.
#[derive(Clone, Debug, PartialEq)]
pub struct Activated {
    pub key: Key,
    pub action: String,
    pub value: Option<Value>,
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
    /// The arrows, and Home and End without Ctrl: a focused slider's steps and ends
    /// (VIEW.md §12.1). Page Up and Page Down move a focused slider too, before any region.
    Left,
    Right,
    Up,
    Down,
    LineStart,
    LineEnd,
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

/// Opt-in timings for one owner rebuild; absent during normal application use.
#[derive(Clone, Copy, Debug, Default)]
pub struct LayoutMetrics {
    pub expansion: std::time::Duration,
    pub layout: std::time::Duration,
    pub shaped: usize,
}

/// A restoration lease, bound to the same key, component type and instance.
#[derive(Clone)]
pub(crate) struct FocusLease {
    key: Key,
    kind: std::any::TypeId,
    instance: u64,
    visible: bool,
}

pub struct ViewState {
    profile: bool,
    metrics: LayoutMetrics,
    placed: Vec<Placed>,
    /// The placement before swipes move it; what a rebuild compares panes against.
    laid: Vec<Placed>,
    now: Instant,
    drag: Option<Drag>,
    /// The tokens of the last layout, for input between frames.
    tokens: Option<Tokens>,
    types: Option<crate::TypeScale>,
    components: StateStore,
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
    /// The bindings actually published by semantics, after a component resolves its role.
    published_controls: HashMap<NodeId, (Key, std::any::TypeId)>,
    /// The regions that showed a wash in the last frame.
    lit: HashSet<Key>,
    /// The washes of controls that are not on glass, by placed index: Hyalo draws a wash
    /// only where there is glass (`add_state_region`), so the view paints these itself,
    /// under the control's content (VIEW.md §13.2).
    painted: HashMap<usize, (Rect, f64, [f64; 4])>,
    /// Regions fading out, until when (they still take a place in Hyalo's eight).
    fading: HashMap<Key, Instant>,
    overflow_logged: bool,
    /// Off: a rebuild lays panes where they are, for a surface whose glass is placed by
    /// something else (the CC's grid, under its editor's glass and scroll).
    slides: bool,
    /// The view is its whole surface (`layout`): no glass is declared past its edges.
    whole: bool,
    /// A pane drawn on a layer of its own over the surface (`lift`): a window's sidebar,
    /// whose glass must show the page under it.
    lifted: Option<Key>,
    /// Pointer sequence owner and component identity, independent of hover.
    capture: Option<(Key, std::any::TypeId)>,
    host_requests: Vec<HostRequest>,
    clicks: u8,
    last_click: Option<(Key, Instant, (f64, f64))>,
    double_click: Option<Duration>,
    /// Semantic item targets retain their owner key, component identity and value.
    options: HashMap<NodeId, (Key, std::any::TypeId, Value)>,
}

impl ViewState {
    /// `id_base`: where this view's region ids start, so they never meet the surface's
    /// others on the same material.
    pub fn new(id_base: u32) -> Self {
        Self {
            profile: false,
            metrics: LayoutMetrics::default(),
            placed: vec![],
            laid: vec![],
            now: Instant::now(),
            drag: None,
            tokens: None,
            types: None,
            components: StateStore::default(),
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
            published_controls: HashMap::new(),
            lit: HashSet::new(),
            painted: HashMap::new(),
            fading: HashMap::new(),
            overflow_logged: false,
            slides: true,
            whole: false,
            lifted: None,
            capture: None,
            host_requests: Vec::new(),
            clicks: 1,
            last_click: None,
            double_click: None,
            options: HashMap::new(),
        }
    }

    /// Draws the pane `key` on a layer of its own, over the surface (VIEW.md §13.2). A pane's
    /// glass is drawn under its whole surface, so it shows what is behind the window; on a
    /// layer over the surface it shows what is under it, as a window's sidebar over the page
    /// must. The view stays one: hit-testing, focus, Tab and the reader are unchanged. The
    /// surface paints it with `paint_lifted` into a layer at `lifted_rect`, gives the
    /// layer the glass and washes `lift_out` takes out of the frame, and passes the
    /// layer's pointer on in window coordinates.
    pub fn lift(&mut self, key: Option<Key>) {
        self.lifted = key;
    }
    fn lifted_root(&self) -> Option<usize> {
        let key = self.lifted.as_ref()?;
        self.placed
            .iter()
            .position(|p| &p.key == key && matches!(p.what, What::Pane(_)))
    }
    /// Whether node `i` lies in node `root`.
    fn under(&self, i: usize, root: usize) -> bool {
        let mut at = Some(i);
        while let Some(j) = at {
            if j == root {
                return true;
            }
            at = self.placed[j].parent;
        }
        false
    }
    /// Whether the node `key` lies in the lifted pane: a choice in a sidebar open over the
    /// page closes it.
    pub fn lifts(&self, key: &Key) -> bool {
        let Some(root) = self.lifted_root() else {
            return false;
        };
        self.placed
            .iter()
            .position(|p| &p.key == key)
            .is_some_and(|i| self.under(i, root))
    }
    /// The lifted pane's rectangle in the surface, whole pixels: its layer's place and size.
    /// None when it is not laid out (a closed sidebar).
    pub fn lifted_rect(&self) -> Option<Rect> {
        let r = self.placed[self.lifted_root()?].rect;
        Some([r[0].round(), r[1].round(), r[2].round(), r[3].round()])
    }
    /// Takes the lifted pane's glass and washes out of `frame`, the surface's, and gives them
    /// back in the layer's coordinates.
    pub fn lift_out(&self, frame: &mut Frame) -> Option<Frame> {
        let root = self.lifted_root()?;
        let o = self.lifted_rect()?;
        let keys: HashSet<&Key> = (0..self.placed.len())
            .filter(|&i| self.under(i, root))
            .map(|i| &self.placed[i].key)
            .collect();
        let ids: HashSet<u32> = keys
            .iter()
            .filter_map(|k| self.ids.get(*k))
            .copied()
            .collect();
        let shift = |r: Rect| [r[0] - o[0], r[1] - o[1], r[2], r[3]];
        let (panes, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut frame.panes)
            .into_iter()
            .partition(|p| keys.contains(&p.key));
        frame.panes = kept;
        let (states, kept): (Vec<_>, Vec<_>) = std::mem::take(&mut frame.states)
            .into_iter()
            .partition(|s| ids.contains(&s.id));
        frame.states = kept;
        Some(Frame {
            panes: panes
                .into_iter()
                .map(|mut p| {
                    p.pane.x -= o[0];
                    p.pane.y -= o[1];
                    p.clip = p.clip.map(shift);
                    p
                })
                .collect(),
            states: states
                .into_iter()
                .map(|mut s| {
                    s.bounds.x -= o[0];
                    s.bounds.y -= o[1];
                    s
                })
                .collect(),
        })
    }

    /// Enable measurement clocks for explicit CPU probes; normal layout leaves them off.
    pub fn set_profile(&mut self, enabled: bool) {
        self.profile = enabled;
    }
    pub(crate) fn focus_first_under(&mut self, root: &Key) -> bool {
        let Some(root) = self.index(root) else {
            return false;
        };
        let key = self
            .controls()
            .find(|&i| self.enabled(i) && self.shown(i) && self.under(i, root))
            .map(|i| self.placed[i].key.clone());
        if let Some(key) = key {
            self.request(&key, false);
            true
        } else {
            false
        }
    }
    pub(crate) fn focus_lease(&self, key: &Key) -> Option<FocusLease> {
        let i = self.index(key)?;
        if !self.enabled(i) || !self.shown(i) {
            return None;
        }
        Some(FocusLease {
            key: key.clone(),
            kind: self.placed[i].part()?.component().type_id(),
            instance: self.components.instance(key),
            visible: self.focus_visible,
        })
    }
    pub(crate) fn restore_focus(&mut self, lease: &FocusLease) -> bool {
        let Some(i) = self.index(&lease.key) else {
            return false;
        };
        if !self.enabled(i)
            || !self.shown(i)
            || self.components.instance(&lease.key) != lease.instance
            || self.placed[i]
                .part()
                .is_none_or(|p| p.component().type_id() != lease.kind)
        {
            return false;
        }
        self.request(&lease.key, false);
        self.focus_visible = lease.visible;
        true
    }
    /// Ask only the focused component about Enter; no unconditional activation
    /// fallback. A modal/default-action host owns the unhandled case.
    pub(crate) fn enter(&mut self) -> (bool, Option<Activated>) {
        let Some(i) = self
            .focus
            .as_ref()
            .and_then(|key| self.index(key))
            .filter(|&i| self.enabled(i))
        else {
            return (false, None);
        };
        let Some(effects) = self.component_input(i, |c, cx| c.enter(cx)) else {
            return (false, None);
        };
        let handled = effects.handled;
        (handled, self.activated(i, effects))
    }
    /// Natural size of the already expanded view; measuring never reconciles
    /// component state again or invents a second component tree.
    pub(crate) fn natural_size(&mut self, backend: &mut dyn nk_text::TextBackend) -> (f64, f64) {
        let Some(view) = &self.view else {
            return (0., 0.);
        };
        let tokens = self.tokens.as_ref().expect("laid view");
        let reveals = self.motion.progress(Instant::now());
        Layouter {
            spacing: &tokens.spacing,
            reveals: &reveals,
            offsets: &self.offsets,
            text: backend,
            cache: &mut self.text,
            scale: self.scale,
            look: tokens.with_types(self.types.as_ref().expect("laid types")),
            row: tokens.row_height,
        }
        .natural_size(view, self.bounds[2])
    }
    pub fn layout_metrics(&self) -> LayoutMetrics {
        self.metrics
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
        look: ComponentLook<'_>,
        text: &mut dyn nk_text::TextBackend,
        now: Instant,
    ) {
        self.layout_in(view, [0., 0., size.0, size.1], scale, look, text, now);
        self.whole = true;
    }

    /// `layout` for a view that takes only `bounds` of its surface (a panel along one edge):
    /// everything it gives back, from hit-testing to the regions, is in surface coordinates.
    pub fn layout_in(
        &mut self,
        view: &Node,
        bounds: Rect,
        scale: f64,
        look: ComponentLook<'_>,
        text: &mut dyn nk_text::TextBackend,
        now: Instant,
    ) {
        let tokens = look.tokens;
        self.whole = false;
        let before: HashMap<Key, Rect> = self
            .laid
            .iter()
            .filter(|p| matches!(p.what, What::Pane(_)))
            .map(|p| (p.key.clone(), p.rect))
            .collect();
        let start = self.profile.then(Instant::now);
        let shaped_before = self.text.shaped;
        let expanded = self.components.expand(view, look, text);
        let expanded_at = start.map(|_| Instant::now());
        self.motion.view(&expanded, now, &tokens.motion);
        self.tokens = Some(tokens.clone());
        self.types = Some(look.types.clone());
        self.view = Some(expanded);
        self.bounds = bounds;
        self.scale = scale;
        let before = self.slides.then_some(&before);
        self.relayout(tokens, text, now, before);
        let live: HashSet<Key> = self
            .controls()
            .filter(|&i| self.enabled(i))
            .map(|i| self.placed[i].key.clone())
            .collect();
        if self.focus.as_ref().is_some_and(|k| !live.contains(k)) {
            self.blur_key(self.focus.clone());
        }
        for state in [&mut self.press, &mut self.focus] {
            if state.as_ref().is_some_and(|k| !live.contains(k)) {
                *state = None;
            }
        }
        self.ids.retain(|k, _| live.contains(k));
        if self.drag.as_ref().is_some_and(|d| !live.contains(&d.key)) {
            self.drag = None;
        }
        if let Some((key, kind)) = &self.capture {
            let valid = self.index(key).is_some_and(|i| {
                self.enabled(i)
                    && self.placed[i]
                        .part()
                        .is_some_and(|p| p.component().type_id() == *kind)
            });
            if !valid {
                self.components.cancel(key);
                self.press = None;
                self.capture = None;
            }
        }
        self.rehover();
        if let (Some(start), Some(expanded)) = (start, expanded_at) {
            self.metrics = LayoutMetrics {
                expansion: expanded.duration_since(start),
                layout: expanded.elapsed(),
                shaped: self.text.shaped - shaped_before,
            };
        }
    }

    /// Advances the motion to `now` and lays the view out again if anything moved. Reports
    /// whether something still moves, so the surface asks for another frame, and each control
    /// whose swipe took it off the surface, with its swipe action: the surface drops it from
    /// its model, and the panes below slide up.
    pub fn tick(
        &mut self,
        look: ComponentLook<'_>,
        text: &mut dyn nk_text::TextBackend,
        now: Instant,
    ) -> Ticked {
        let tokens = look.tokens;
        if !self.animating() {
            return Ticked::default();
        }
        let moving = self.motion.animating() || self.pending;
        let activated = self
            .motion
            .finished(now)
            .into_iter()
            .map(|(key, action)| Activated {
                key,
                action,
                value: None,
            })
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
    /// Whether a pane a rebuild moved slides from where it was drawn (VIEW.md §6); off for a
    /// view whose glass moves without it.
    pub fn set_slides(&mut self, on: bool) {
        self.slides = on;
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
            look: tokens.with_types(self.types.as_ref().expect("layout supplies types")),
            row: tokens.row_height,
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
                look: tokens.with_types(self.types.as_ref().expect("layout supplies types")),
                row: tokens.row_height,
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
        if self
            .focus
            .as_ref()
            .and_then(|key| self.index(key))
            .is_some_and(|i| self.placed[i].alpha <= 0.)
        {
            self.blur();
        }
        for i in 0..self.placed.len() {
            if self.placed[i].part().is_some() {
                self.component_layout(i);
            }
        }
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

    /// A focused display component whose owner handles its editor.
    pub fn editing(&self) -> Option<&Key> {
        let key = self.focus.as_ref()?;
        self.index(key)
            .filter(|&i| {
                self.placed[i]
                    .part()
                    .is_some_and(|p| p.component().owner_edits())
            })
            .map(|_| key)
    }
    pub fn caret(&self, key: &Key) -> Option<Rect> {
        let i = self.index(key)?;
        self.placed[i].part()?.component().caret(&self.context(i))
    }
    #[cfg(test)]
    pub(crate) fn selection(&self, key: &Key) -> Vec<Rect> {
        self.index(key)
            .and_then(|i| {
                self.placed[i]
                    .part()
                    .map(|p| p.component().selection(&self.context(i)))
            })
            .unwrap_or_default()
    }
    pub fn typed_value(&self, key: &Key) -> Option<Value> {
        let i = self.index(key)?;
        self.placed[i]
            .part()?
            .component()
            .value(self.components.get(key))
    }
    /// The control holding the current pointer sequence, including outside its bounds.
    pub fn captured(&self) -> Option<&Key> {
        self.capture.as_ref().map(|(key, _)| key)
    }
    pub fn value(&self, key: &Key) -> Option<f64> {
        self.typed_value(key)?.number()
    }
    fn context(&self, i: usize) -> Read<'_> {
        let p = &self.placed[i];
        Read {
            key: &p.key,
            look: self
                .tokens
                .as_ref()
                .expect("laid view")
                .with_types(self.types.as_ref().expect("laid type scale")),
            rect: p.rect,
            visible: p.visible().unwrap_or(p.rect),
            interaction: self.interaction(i),
            role: p.control.map(|o| self.control(o).role),
            focused: self.focus.as_ref() == Some(&p.key),
            showing: p.alpha > 0. && p.visible().is_some(),
            focus: self.focus.as_ref(),
            instance: self.components.instance(&p.key),
            clicks: self.clicks,
            owns_mark: self.holds_mark(i),
            fading: self.fading.contains_key(&p.key),
            state: self.components.get(&p.key),
            placed: &self.placed,
            text: &self.text,
        }
    }
    /// Resolve the enclosing control state once, including the gallery fixture.
    fn interaction(&self, i: usize) -> Interaction {
        let Some(owner) = self.placed[i].control else {
            return Interaction {
                enabled: true,
                ..Interaction::default()
            };
        };
        let c = self.control(owner);
        let key = Some(&self.placed[owner].key);
        Interaction {
            hover: self.hover.as_ref() == key || c.shown == Some(Shown::Hover),
            pressed: (self.press.as_ref() == key && self.hover.as_ref() == key)
                || c.shown == Some(Shown::Press),
            focus_ring: (self.focus_visible && self.focus.as_ref() == key)
                || c.shown == Some(Shown::Focus),
            enabled: self.enabled(owner),
            marked: c.selected(),
        }
    }
    fn component_input(
        &mut self,
        i: usize,
        event: impl FnOnce(&dyn crate::components::Component, &mut Input<'_>),
    ) -> Option<Outcome> {
        self.component_event(i, false, event)
    }
    fn component_layout(&mut self, i: usize) -> Option<Outcome> {
        self.component_event(i, true, |c, cx| c.arrange(cx))
    }
    fn component_event(
        &mut self,
        i: usize,
        layout: bool,
        event: impl FnOnce(&dyn crate::components::Component, &mut Input<'_>),
    ) -> Option<Outcome> {
        if !layout
            && matches!(self.placed[i].what, What::Control(_))
            && (!self.enabled(i) || self.placed[i].alpha <= 0.)
        {
            return None;
        }
        let part = self.placed[i].part()?;
        let key = self.placed[i].key.clone();
        let interaction = self.interaction(i);
        let owns_mark = self.holds_mark(i);
        let p = &self.placed[i];
        let read = Read {
            key: &p.key,
            look: self.tokens.as_ref()?.with_types(self.types.as_ref()?),
            rect: p.rect,
            visible: p.visible().unwrap_or(p.rect),
            interaction,
            role: if let What::Control(c) = &p.what {
                Some(c.role)
            } else {
                None
            },
            focused: self.focus.as_ref() == Some(&key),
            showing: p.alpha > 0. && p.visible().is_some(),
            focus: self.focus.as_ref(),
            instance: self.components.instance(&p.key),
            clicks: self.clicks,
            owns_mark,
            fading: self.fading.contains_key(&key),
            state: None,
            placed: &self.placed,
            text: &self.text,
        };
        let mut effects = Outcome::default();
        self.components
            .input_context(&key, &mut effects, read, |cx| event(part.component(), cx));
        self.pending |= effects.redraw;
        match effects.capture {
            Capture::Take => self.capture = Some((key.clone(), part.component().type_id())),
            Capture::Release => self.capture = None,
            Capture::Keep => {}
        }
        if effects.focus {
            if self.focus.as_ref() != Some(&key) {
                self.blur_key(self.focus.clone());
            }
            self.focus = Some(key);
            self.focus_visible = effects.keyboard_focus;
        }
        if let Some(reveal) = effects.reveal.take() {
            self.reveal_rect(&reveal.region, reveal.rect);
        }
        self.host_requests.append(&mut effects.host);
        Some(effects)
    }
    fn activated(&self, i: usize, effects: Outcome) -> Option<Activated> {
        effects.activate.then(|| Activated {
            key: self.placed[i].key.clone(),
            action: effects
                .action
                .unwrap_or_else(|| self.control(i).action.clone()),
            value: effects
                .value
                .or_else(|| self.typed_value(&self.placed[i].key)),
        })
    }
    fn membership(&self, i: usize) -> Membership {
        self.placed[i]
            .part()
            .map(|p| p.component().group(&self.context(i)))
            .unwrap_or(Membership::None)
    }
    pub fn component_errors(&self) -> Vec<(Key, String)> {
        self.components.errors()
    }
    pub fn set_double_click_ms(&mut self, ms: u32) {
        self.double_click = Some(Duration::from_millis(ms.into()));
    }
    pub fn text_input(&self) -> nk_wayland::TextInput {
        self.focus
            .as_ref()
            .and_then(|k| self.index(k))
            .filter(|&i| self.enabled(i) && self.shown(i))
            .and_then(|i| {
                self.placed[i]
                    .part()?
                    .component()
                    .text_input(&self.context(i))
            })
            .unwrap_or_default()
    }
    pub(crate) fn retained_target(&self, target: &ReplyTarget) -> bool {
        self.index(&target.owner).is_some_and(|i| {
            self.placed[i].part().is_some_and(|part| {
                part.component().type_id() == target.kind
                    && self.components.instance(&target.owner) == target.instance
                    && part
                        .component()
                        .revision(self.components.get(&target.owner))
                        == Some(target.revision)
            })
        })
    }
    pub(crate) fn accepts_target(&self, target: &ReplyTarget) -> bool {
        self.retained_target(target)
            && self
                .index(&target.owner)
                .is_some_and(|i| self.enabled(i) && self.shown(i))
    }
    pub fn reply(&mut self, target: &ReplyTarget, request: Request) -> Option<Activated> {
        if self.focus.as_ref() != Some(&target.owner) || !self.accepts_target(target) {
            return None;
        }
        self.respond(&target.owner, request)
    }
    pub fn key_event(&mut self, key: &nk_wayland::Key) -> (bool, Option<Activated>) {
        if let Some(i) = self
            .focus
            .as_ref()
            .and_then(|k| self.index(k))
            .filter(|&i| self.enabled(i))
            && let Some(effects) = self.component_input(i, |c, cx| c.key_event(cx, key))
            && effects.handled
        {
            return (true, self.activated(i, effects));
        }
        match crate::KeyInput::from_key(key) {
            Some(k) => (true, self.key(k)),
            None => (false, None),
        }
    }
    pub fn ime(&mut self, batch: &nk_wayland::ImeBatch) -> Option<Activated> {
        let i = self
            .focus
            .as_ref()
            .and_then(|k| self.index(k))
            .filter(|&i| self.enabled(i))?;
        let effects = self.component_input(i, |c, cx| c.ime(cx, batch))?;
        self.activated(i, effects)
    }
    pub fn take_host_requests(&mut self) -> Vec<HostRequest> {
        std::mem::take(&mut self.host_requests)
    }
    fn holds_mark(&self, i: usize) -> bool {
        self.placed.iter().any(|p| {
            p.control == Some(i) && p.part().is_some_and(|part| part.component().owns_mark())
        })
    }
    fn silhouette(&self, i: usize) -> Option<Rect> {
        let p = &self.placed[i];
        let visible = p.visible()?;
        p.part().map_or(Some(visible), |p| {
            crate::layout::intersect(p.component().silhouette(&self.context(i)), visible)
        })
    }
    pub fn slid(&mut self) -> Option<Activated> {
        for i in self.controls().collect::<Vec<_>>() {
            let key = self.placed[i].key.clone();
            if let Some(value) = self.components.take_changed(&key) {
                return Some(Activated {
                    key,
                    action: self.control(i).action.clone(),
                    value: Some(value),
                });
            }
        }
        None
    }
    pub fn respond(&mut self, key: &Key, request: Request) -> Option<Activated> {
        let i = self
            .index(key)
            .filter(|&i| matches!(self.placed[i].what, What::Control(_)))?;
        let effects = self.component_input(i, |c, cx| c.request(cx, request))?;
        self.activated(i, effects)
    }
    pub fn request_value(&mut self, key: &Key, value: f64) -> Option<Activated> {
        self.respond(key, Request::Set(Value::Number(value)))
    }
    pub fn choose(&mut self, key: &Key, n: usize) -> Option<Activated> {
        self.respond(key, Request::Set(Value::Index(n)))
    }
    pub fn list(&self, key: &Key) -> Option<ListSpec> {
        let i = self
            .index(key)
            .filter(|&i| matches!(self.placed[i].what, What::Control(_)) && self.enabled(i))?;
        self.placed[i].part()?.component().list(&self.context(i))
    }
    /// Revalidate a queued list at the host boundary. Missing, disabled or changed owners
    /// cannot open an old proposal; presentation comes from the current appearance.
    pub fn resolve_list(&self, owner: &Key, proposal: &ListSpec) -> Option<ListSpec> {
        let current = self.list(owner)?;
        (current.items == proposal.items).then_some(current)
    }
    pub fn choice(&self, key: &Key) -> Option<(Vec<String>, usize)> {
        let list = self.list(key)?;
        Some((
            list.items.into_iter().map(|i| i.name).collect(),
            list.selected,
        ))
    }
    pub fn set_expanded(&mut self, key: Option<Key>) {
        for i in self.controls().collect::<Vec<_>>() {
            let expanded = key.as_ref() == Some(&self.placed[i].key);
            self.component_input(i, |c, cx| c.request(cx, Request::Expanded(expanded)));
        }
    }
    /// Which dropdown, and which of its options, a semantic id is.
    pub fn option(&self, id: NodeId) -> Option<(Key, usize)> {
        let (key, kind, value) = self.options.get(&id)?;
        if self.placed[self.index(key)?].part()?.component().type_id() != *kind {
            return None;
        }
        if let Value::Index(n) = value {
            Some((key.clone(), *n))
        } else {
            None
        }
    }
    pub fn option_id(&self, key: &Key, n: usize) -> Option<NodeId> {
        self.semantic_value_id(key, &Value::Index(n))
    }
    pub fn semantic_value_id(&self, key: &Key, value: &Value) -> Option<NodeId> {
        let kind = self.placed[self.index(key)?].part()?.component().type_id();
        self.options
            .iter()
            .find(|(_, (k, t, v))| k == key && *t == kind && v == value)
            .map(|(id, _)| *id)
    }
    fn index(&self, key: &Key) -> Option<usize> {
        self.placed.iter().position(|p| &p.key == key)
    }
    /// The panes a node lies in, innermost first.
    fn panes_of(&self, i: usize) -> impl Iterator<Item = usize> + '_ {
        std::iter::successors(self.placed[i].pane, |&p| self.placed[p].pane)
    }

    /// Whether a node is drawn as far as hover and focus go: a control revealed with a pane
    /// while it is under the pointer or holds the focus, a text hidden with one while it is
    /// not, anything else always; and nothing that does not show.
    pub fn shown(&self, i: usize) -> bool {
        if self.placed[i].visible().is_none() {
            return false;
        }
        match &self.placed[i].what {
            What::Control(c) => c.revealed_with.as_ref().is_none_or(|k| self.hot(k)),
            What::Text { hidden_with, .. } => hidden_with.as_ref().is_none_or(|k| !self.hot(k)),
            _ => true,
        }
    }

    /// Whether a pane is under the pointer or holds the focus: what reveals the controls
    /// `revealed_with` it and hides the texts `hidden_with` it.
    fn hot(&self, pane: &Key) -> bool {
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
                    && self.control(i).pointer
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
        let mut changed = self.hover != before;
        if changed && let Some(i) = before.as_ref().and_then(|key| self.index(key)) {
            changed |= self
                .component_input(i, |c, cx| c.pointer_leave(cx))
                .is_some_and(|e| e.redraw);
        }
        if let Some(at) = self.pointer
            && let Some(i) = self.hover.as_ref().and_then(|key| self.index(key))
        {
            changed |= self
                .component_input(i, |c, cx| c.pointer_motion(cx, at))
                .is_some_and(|e| e.redraw);
        }
        changed
    }

    /// The pointer moved; whether anything shown changed (a hover, a revealed control, a
    /// card being swiped). A press on a swipeable control that has gone further across than
    /// down, past the claim distance, becomes a swipe: the press is cancelled, so its release
    /// activates nothing, and the card follows the pointer across (VIEW.md §7).
    pub fn pointer_motion(&mut self, x: f64, y: f64) -> bool {
        let revealed = self.revealed();
        self.pointer = Some((x, y));
        if self.bar_motion((x, y)) {
            self.rehover();
            return true;
        }
        if let Some((key, _)) = self.capture.clone()
            && let Some(i) = self.index(&key)
        {
            let effects = self.component_input(i, |c, cx| c.drag(cx, (x, y)));
            return self.rehover() | effects.is_some_and(|e| e.redraw);
        }
        if let Some(i) = self.press.as_ref().and_then(|k| self.index(k)) {
            self.component_input(i, |c, cx| c.drag(cx, (x, y)));
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
        Some(out.map(|action| Activated {
            key: d.key,
            action,
            value: None,
        }))
    }
    /// Flings the cards of these swipeable controls off the surface top to bottom, `stagger`
    /// apart, as a clear-all does (VIEW.md §7); controls that do not show, or are already
    /// gone, are left out. The
    /// last one gone reports `action` from `tick`, or this returns it at once when nothing
    /// shows or motion is reduced.
    pub fn cascade(
        &mut self,
        keys: &[Key],
        stagger: Duration,
        action: impl Into<String>,
        now: Instant,
    ) -> Option<Activated> {
        let mut shown: Vec<(f64, Key)> = keys
            .iter()
            .filter_map(|k| {
                let i = self.index(k)?;
                self.control(i).swipe.as_ref()?;
                let v = self.placed[i]
                    .visible()
                    .filter(|_| self.placed[i].alpha > 0.)?;
                Some((v[1], k.clone()))
            })
            .collect();
        shown.sort_by(|a, b| a.0.total_cmp(&b.0));
        let shown: Vec<Key> = shown.into_iter().map(|(_, k)| k).collect();
        let action = action.into();
        let out = match self.tokens.as_ref().map(|t| t.motion) {
            Some(motion) => self.motion.cascade(
                &shown,
                stagger,
                self.bounds[0] + self.bounds[2],
                action,
                now,
                &motion,
            ),
            None => Some(action),
        };
        self.drag = None;
        self.press = None;
        self.reswipe();
        out.map(|action| Activated {
            key: shown.last().cloned().unwrap_or_else(|| Key::from("")),
            action,
            value: None,
        })
    }
    /// A modal menu closed: hover is recomputed from where the pointer was sampled before
    /// the popup went (`Window::root_pointer_position`, #1030).
    pub fn reconcile_pointer(&mut self, pointer: Option<(f64, f64)>) -> bool {
        match pointer {
            Some((x, y)) => self.pointer_motion(x, y),
            None => self.pointer_leave(),
        }
    }
    /// What hover and focus show and hide: compared before and after an event to tell
    /// whether to draw again.
    fn revealed(&self) -> Vec<bool> {
        let hidden = (0..self.placed.len()).filter(|&i| {
            matches!(
                self.placed[i].what,
                What::Text {
                    hidden_with: Some(_),
                    ..
                }
            )
        });
        self.controls()
            .chain(hidden)
            .map(|i| self.shown(i))
            .collect()
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
        if !pressed && let Some((key, _)) = self.capture.clone() {
            self.press = None;
            self.drag = None;
            let i = self.index(&key)?;
            let at = self.pointer.unwrap_or_default();
            let effects = self.component_input(i, |c, cx| c.release(cx, at))?;
            return self.activated(i, effects);
        }
        if pressed {
            let i = self.hover.as_ref().and_then(|k| self.index(k))?;
            let at = self.pointer.unwrap_or_default();
            let key = self.placed[i].key.clone();
            self.clicks = if self.last_click.as_ref().is_some_and(|(k, t, pt)| {
                k == &key
                    && self
                        .double_click
                        .is_some_and(|span| now.saturating_duration_since(*t) <= span)
                    && (pt.0 - at.0).abs() <= 4.
                    && (pt.1 - at.1).abs() <= 4.
            }) {
                2
            } else {
                1
            };
            self.last_click = Some((key.clone(), now, at));
            let effects = self.component_input(i, |c, cx| c.press(cx, at))?;
            self.press = effects.arm.then_some(key.clone());
            self.focus_visible = false;
            if self.editing().is_some() || self.text_input().focused {
                if self.focus.as_ref() != Some(&key) {
                    self.blur_key(self.focus.clone());
                }
                self.focus = Some(key.clone());
            }
            self.drag = self
                .press
                .as_ref()
                .zip(self.pointer)
                .filter(|_| self.control(i).swipe.is_some())
                .map(|(key, origin)| Drag {
                    key: key.clone(),
                    origin,
                    dx: 0.,
                    claimed: false,
                });
            return self.activated(i, effects);
        }
        let dx = self.drag.as_ref().map_or(0., |d| d.dx);
        if let Some(flung) = self.end_swipe(dx, now) {
            return flung;
        }
        self.drag = None;
        let pressed = self.press.take()?;
        let i = self.pointer.and_then(|pt| self.hit(pt))?;
        if self.placed[i].key != pressed {
            return None;
        }
        let at = self.pointer.unwrap_or_default();
        let effects = self.component_input(i, |c, cx| c.release(cx, at))?;
        self.activated(i, effects)
    }

    /// Tab and Shift+Tab move focus through every enabled control in tree order, revealed or
    /// not, with one stop per choice group. Enter or Space activates the focused control.
    /// Arrows choose within radio groups and move focus within lists.
    pub fn key(&mut self, k: KeyInput) -> Option<Activated> {
        let before = self.focus.clone();
        let result = self.key_inner(k);
        if before != self.focus {
            self.blur_key(before);
        }
        result
    }
    fn key_inner(&mut self, k: KeyInput) -> Option<Activated> {
        if let Some(i) = self.focus.as_ref().and_then(|key| self.index(key))
            && let Some(effects) = self.component_input(i, |c, cx| c.key(cx, k))
            && effects.handled
        {
            self.focus_visible |= effects.keyboard_focus;
            return self.activated(i, effects);
        }
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
        // Adjacent radios and named choices each share a single Tab stop.
        let grouped = |j: usize| !matches!(self.membership(order[j]), Membership::None);
        let joined = |j: usize| match (self.membership(order[j]), self.membership(order[j + 1])) {
            (Membership::Adjacent { .. }, Membership::Adjacent { .. }) => true,
            (Membership::Named { key: a, .. }, Membership::Named { key: b, .. })
            | (Membership::List { key: a, .. }, Membership::List { key: b, .. }) => a == b,
            _ => false,
        };
        let run = |j: usize| {
            let (mut a, mut b) = (j, j);
            while a > 0 && grouped(a - 1) && joined(a - 1) {
                a -= 1;
            }
            while b + 1 < order.len() && grouped(b + 1) && joined(b) {
                b += 1;
            }
            a..=b
        };
        match k {
            KeyInput::Left | KeyInput::Right | KeyInput::Up | KeyInput::Down => {
                // A list moves focus. A radio group also changes its choice.
                let a = at.filter(|&a| grouped(a))?;
                let g = run(a);
                if matches!(self.membership(order[a]), Membership::List { .. }) {
                    let next = match k {
                        KeyInput::Up if a > *g.start() => a - 1,
                        KeyInput::Down if a < *g.end() => a + 1,
                        _ => return None,
                    };
                    let i = order[next];
                    self.focus = Some(self.placed[i].key.clone());
                    self.focus_visible = true;
                    self.scroll_to_focus(i);
                    return None;
                }
                let (first, n) = (*g.start(), g.end() - g.start() + 1);
                let step = if matches!(k, KeyInput::Left | KeyInput::Up) {
                    n - 1
                } else {
                    1
                };
                let i = order[first + (a - first + step) % n];
                self.focus = Some(self.placed[i].key.clone());
                self.focus_visible = true;
                self.scroll_to_focus(i);
                Some(Activated {
                    key: self.placed[i].key.clone(),
                    action: self.control(i).action.clone(),
                    value: self.typed_value(&self.placed[i].key),
                })
            }
            KeyInput::Tab | KeyInput::ShiftTab => {
                // A choice group is one stop: its chosen item, else its first.
                let stops: Vec<usize> = (0..order.len())
                    .filter(|&j| {
                        if !grouped(j) {
                            return true;
                        }
                        let g = run(j);
                        match g.clone().find(|&r| {
                            matches!(
                                self.membership(order[r]),
                                Membership::Adjacent { selected: true }
                                    | Membership::Named { selected: true, .. }
                                    | Membership::List { selected: true, .. }
                            )
                        }) {
                            Some(chosen) => chosen == j,
                            None => *g.start() == j,
                        }
                    })
                    .collect();
                let n = stops.len();
                let here = at.map(|a| {
                    let g = if grouped(a) { run(a) } else { a..=a };
                    stops.iter().position(|s| g.contains(s)).unwrap_or(0)
                });
                let next = match (here, k) {
                    (None, KeyInput::Tab) => 0,
                    (None, _) => n - 1,
                    (Some(a), KeyInput::Tab) => (a + 1) % n,
                    (Some(a), _) => (a + n - 1) % n,
                };
                let i = order[stops[next]];
                self.focus = Some(self.placed[i].key.clone());
                self.focus_visible = true;
                self.scroll_to_focus(i);
                None
            }
            KeyInput::Activate => {
                let i = order[at?];
                Some(Activated {
                    key: self.placed[i].key.clone(),
                    action: self.control(i).action.clone(),
                    value: self.typed_value(&self.placed[i].key),
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

    /// Reveal a content-space rectangle with the least vertical scroll, clamped to content.
    pub fn reveal_rect(&mut self, key: &Key, rect: Rect) -> bool {
        let Some(s) = self
            .index(key)
            .filter(|&s| matches!(self.placed[s].what, What::Scroll { .. }))
        else {
            return false;
        };
        if rect.iter().any(|v| !v.is_finite()) || rect[3] < 0. {
            return false;
        }
        let offset = self.offset(s);
        let height = self.placed[s].rect[3];
        let target = crate::layout::reveal_offset(offset, height, rect[1], rect[3]);
        self.scroll_by(s, target - offset)
    }
    /// The surface scrolled the region `key` itself, the pointer anywhere: a panel whose
    /// wheel the surface routes, or one that brings something of its own into view. False
    /// when it could not move. Laid out at the next `tick` or layout, as a wheel's.
    pub fn scroll_region(&mut self, key: &Key, by: ScrollBy) -> bool {
        let Some(s) = self
            .index(key)
            .filter(|&s| matches!(self.placed[s].what, What::Scroll { .. }))
        else {
            return false;
        };
        let delta = match by {
            ScrollBy::Pixels(d) => d,
            ScrollBy::Steps(n) => n * self.placed[s].rect[3].powf(STEP_POWER),
        };
        self.scroll_by(s, delta)
    }
    /// A region's offset: what was asked since the last layout, else what was laid out.
    pub fn scroll_offset(&self, key: &Key) -> Option<f64> {
        let s = self
            .index(key)
            .filter(|&s| matches!(self.placed[s].what, What::Scroll { .. }))?;
        Some(self.offset(s))
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
        let (mut r, v) = (self.placed[i].rect, self.placed[s].rect);
        // Revealing only the input box cuts off an external keyboard outline.
        // Keep the original target (notably a list's viewport), plus any outline
        // outside it. Inner outline clips still apply; ancestor clips must not
        // shrink this reveal request before it has brought the control into view.
        if self.interaction(i).focus_ring
            && let Some(outline) = self.placed[i]
                .part()
                .and_then(|part| part.component().focus_outline(&self.context(i)))
        {
            let style = &self.tokens.as_ref().expect("laid view").focus;
            let outside = style.outside(outline.bounds);
            let outside = outline.clip.map_or(Some(outside), |clip| {
                crate::layout::intersect(outside, clip)
            });
            if let Some(b) = outside {
                let x = r[0].min(b[0]);
                let y = r[1].min(b[1]);
                r = [
                    x,
                    y,
                    (r[0] + r[2]).max(b[0] + b[2]) - x,
                    (r[1] + r[3]).max(b[1] + b[3]) - y,
                ];
            }
        }
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
                        // What shows of it. A view that is its whole surface also cuts it at
                        // the surface's edge: a window's sidebar sliding out draws no glass
                        // past the window. A panel's view does not, so a card swiped off it
                        // leaves with its glass.
                        clip: if self.whole {
                            crate::layout::intersect(v, viewport)
                        } else {
                            Some(v)
                        }
                        .filter(|c| *c != r),
                        opacity: p.alpha,
                    })
                }
                _ => None,
            })
            .collect();
        // (priority, pane, control, wash); priority 4 is rest.
        let mut regions: Vec<(u8, Option<usize>, usize, [f64; 4])> = vec![];
        for i in self.controls().collect::<Vec<_>>() {
            if !self.shown(i)
                || !self.placed[i]
                    .visible()
                    .is_some_and(|r| overlaps(r, viewport))
            {
                continue;
            }
            let Some((priority, wash)) = self.placed[i].part().and_then(|p| {
                let read = self.context(i);
                p.component()
                    .glass(&Read {
                        look: tokens.with_types(read.look.types),
                        ..read
                    })
                    .lit
            }) else {
                continue;
            };
            regions.push((priority, self.placed[i].pane, i, wash));
        }
        regions.sort_by_key(|r| r.0);
        let mut spent: HashMap<Option<usize>, usize> = HashMap::new();
        let mut dropped = 0;
        // Hyalo's budget is per pane of glass; what is off glass the view paints, unbudgeted.
        for r in regions.iter_mut().filter(|r| r.0 < 4 && r.1.is_some()) {
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
        self.painted.clear();
        for (_, pane, i, wash) in regions {
            let key = self.placed[i].key.clone();
            if wash[3] > 0. {
                lit.insert(key.clone());
            } else if self.lit.contains(&key) {
                self.fading.insert(key.clone(), now + fade);
            }
            let Some(r) = self.silhouette(i) else {
                continue;
            };
            let corner = self.placed[i]
                .part()
                .map(|p| p.component().corner())
                .unwrap_or(crate::Corner::Pill);
            if pane.is_none() {
                if wash[3] > 0. {
                    self.painted
                        .insert(i, (r, corner.of(r[2], r[3], &tokens.radii), wash));
                }
                continue;
            }
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
        let mut options = HashMap::new();
        let mut published_controls = HashMap::new();
        self.next_semantic = self.next_semantic.max(first_id);
        for i in 0..self.placed.len() {
            if !self.in_semantics(i) {
                continue;
            }
            let p = &self.placed[i];
            let mut children = Vec::<SemanticChild>::new();
            let mut node = match &p.what {
                What::ListBox(name) => nk_a11y::Node::new(0, nk_a11y::Role::ListBox, name.clone()),
                What::Pane(_) => nk_a11y::Node::new(0, nk_a11y::Role::Panel, ""),
                What::Scroll { .. } => nk_a11y::Node::new(0, nk_a11y::Role::ScrollPane, ""),
                What::Control(c) => {
                    let mut n = nk_a11y::Node::new(0, a11y_role(c.role), c.name.clone());
                    n.description = c.description.clone();
                    n.states.disabled = !c.enabled;
                    n.states.focused = self.focus.as_ref() == Some(&p.key);
                    n.actions = vec![Action::Focus, Action::Activate];
                    if let Some(part) = &c.part {
                        part.component()
                            .semantics(&self.context(i), &mut n, &mut children);
                    }
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
                .filter(|&q| {
                    matches!(
                        self.placed[q].what,
                        What::Pane(_) | What::Scroll { .. } | What::ListBox(_)
                    )
                })
                .find_map(|q| ids.get(&q).copied())
                .unwrap_or(root_id);
            nodes
                .get_mut(&parent)
                .expect("parent is placed first")
                .children
                .push(id);
            nodes.insert(id, node);
            ids.insert(i, id);
            if matches!(p.what, What::Control(_))
                && let Some(part) = p.part()
            {
                published_controls.insert(id, (p.key.clone(), part.component().type_id()));
            }
            for child in children {
                let next_semantic = &mut self.next_semantic;
                let oid = *self
                    .semantic_ids
                    .entry((child.key, child.node.role))
                    .or_insert_with(|| {
                        *next_semantic += 1;
                        *next_semantic - 1
                    });
                let mut node = child.node;
                node.id = oid;
                nodes.get_mut(&id).expect("just placed").children.push(oid);
                nodes.insert(oid, node);
                if let Some(value) = child.value {
                    options.insert(
                        oid,
                        (
                            p.key.clone(),
                            p.part()
                                .expect("semantic children belong to a component")
                                .component()
                                .type_id(),
                            value,
                        ),
                    );
                }
            }
        }
        self.options = options;
        self.published_controls = published_controls;
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
            && !p.presentation
            && match &p.what {
                What::Pane(_) | What::Scroll { .. } | What::Control(_) | What::ListBox(_) => true,
                What::Text { .. } => p.control.is_none(),
                _ => false,
            }
    }

    /// Which control each id `semantics` gave is, for the controls placed now: what a
    /// reader's request names.
    pub fn semantic_keys(&self) -> HashMap<NodeId, Key> {
        let live: HashMap<&Key, std::any::TypeId> = self
            .placed
            .iter()
            .enumerate()
            .filter(|(i, p)| matches!(p.what, What::Control(_)) && self.in_semantics(*i))
            .filter_map(|(_, p)| p.part().map(|part| (&p.key, part.component().type_id())))
            .collect();
        self.published_controls
            .iter()
            .filter(|(_, (key, kind))| live.get(key) == Some(kind))
            .map(|(id, (key, _))| (*id, key.clone()))
            .collect()
    }

    /// Focus leaves the view: the surface moved it to something of its own.
    fn blur_key(&mut self, key: Option<Key>) {
        if let Some(key) = key {
            self.components.blur(&key);
            self.pending = true;
        }
    }
    pub fn blur(&mut self) {
        self.blur_key(self.focus.clone());
        self.focus = None;
        self.focus_visible = false;
    }
    /// Whether the focus shows its ring: it came from the keyboard.
    pub fn focus_visible(&self) -> bool {
        self.focus.is_some() && self.focus_visible
    }
    /// The focus stays where it is without its ring, as when the pointer put it there.
    pub fn hide_ring(&mut self) {
        self.focus_visible = false;
    }

    /// A reader's request on a control: focus moves to it (scrolled into view, its ring
    /// shown), or it is activated. A disabled or absent control does nothing.
    pub fn request(&mut self, key: &Key, activate: bool) -> Option<Activated> {
        let i = self
            .index(key)
            .filter(|&i| matches!(self.placed[i].what, What::Control(_)) && self.enabled(i))?;
        if activate {
            let effects = self.component_input(i, |c, cx| c.request(cx, Request::Activate))?;
            return self.activated(i, effects);
        }
        if self.focus.as_ref() != Some(key) {
            self.blur_key(self.focus.clone());
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
        look: ComponentLook<'_>,
        icons: &mut dyn FnMut(&str, f64) -> Option<std::sync::Arc<nk_icons::Icon>>,
        fallback: Option<&Frame>,
    ) -> Result<(), String> {
        self.paint_part(canvas, look, icons, fallback, false)
    }
    /// What `paint` leaves out: the lifted pane and what it holds, in window coordinates, for
    /// a canvas whose origin is the layer's (`Canvas::at` with `lifted_rect`).
    pub fn paint_lifted(
        &self,
        canvas: &mut Canvas,
        look: ComponentLook<'_>,
        icons: &mut dyn FnMut(&str, f64) -> Option<std::sync::Arc<nk_icons::Icon>>,
    ) -> Result<(), String> {
        self.paint_part(canvas, look, icons, None, true)
    }
    fn paint_focus(
        &self,
        canvas: &mut Canvas,
        look: ComponentLook<'_>,
        part: &dyn Fn(usize) -> bool,
    ) {
        let tokens = look.tokens;
        for (i, p) in self.placed.iter().enumerate() {
            if !part(i)
                || !matches!(p.what, What::Control(_))
                || !self.shown(i)
                || p.alpha <= 0.
                || p.visible().is_none()
            {
                continue;
            }
            let interaction = self.interaction(i);
            if !interaction.enabled || !interaction.focus_ring {
                continue;
            }
            let cx = Read {
                look,
                ..self.context(i)
            };
            let outline = p
                .part()
                .and_then(|part| part.component().focus_outline(&cx));
            if let Some(outline) = outline {
                if let Some(clip) = p.clip {
                    canvas.clip(rect(&clip));
                }
                if let Some(clip) = outline.clip {
                    canvas.clip(rect(&clip));
                }
                let style = &tokens.focus;
                let out = style.gap + style.width;
                let bounds = style.outside(outline.bounds);
                canvas.rounded_ring_corners(
                    rect(&bounds),
                    outline.corners.map(|r| r + out),
                    style.width,
                    style
                        .color
                        .with_alpha(style.color.components[3] * p.alpha as f32),
                );
                if outline.clip.is_some() {
                    canvas.pop_clip();
                }
                if p.clip.is_some() {
                    canvas.pop_clip();
                }
            }
        }
    }
    fn paint_part(
        &self,
        canvas: &mut Canvas,
        look: ComponentLook<'_>,
        icons: &mut dyn FnMut(&str, f64) -> Option<std::sync::Arc<nk_icons::Icon>>,
        fallback: Option<&Frame>,
        lifted: bool,
    ) -> Result<(), String> {
        let tokens = look.tokens;
        let root = self.lifted_root();
        let part = |i: usize| match root {
            Some(r) => self.under(i, r) == lifted,
            None => !lifted,
        };
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
        let interactions: Vec<Option<Interaction>> = self
            .placed
            .iter()
            .enumerate()
            .map(|(i, p)| matches!(p.what, What::Control(_)).then(|| self.interaction(i)))
            .collect();
        let interaction = |p: &Placed| {
            p.control
                .and_then(|o| interactions[o])
                .unwrap_or(Interaction {
                    enabled: true,
                    ..Interaction::default()
                })
        };
        for (i, p) in self.placed.iter().enumerate() {
            if !part(i) || p.control.is_some_and(|c| !self.shown(c)) || !self.shown(i) {
                continue;
            }
            let Some(visible) = p.visible().filter(|_| p.alpha > 0.) else {
                continue;
            };
            let ink = |c: nk_render::Color| c.with_alpha(c.components[3] * p.alpha as f32);
            // What a control holds takes the accent while it is on, and the fill's dark where a
            // tile slider's fill has reached its middle (VIEW.md §12.1, §12.4).
            let content = |c: nk_render::Color| {
                let Some(owner) = p.control.filter(|&o| o != i) else {
                    return ink(c);
                };
                // A disabled control's text and glyphs, in the disabled ink. One without an
                // action is a marker, not a control turned off (the NC's today).
                let o = self.control(owner);
                if !o.enabled && !o.action.is_empty() {
                    return ink(tokens.look.disabled);
                }
                let c = self.placed[owner]
                    .part()
                    .map(|part| {
                        part.component().content_ink(
                            &Read {
                                look,
                                ..self.context(owner)
                            },
                            p.rect,
                            c,
                        )
                    })
                    .unwrap_or(c);
                ink(c)
            };
            if let Some(component) = p.part() {
                let corner = match &p.what {
                    What::Control(_) => p
                        .part()
                        .map(|part| part.component().corner())
                        .unwrap_or(crate::Corner::Pill),
                    _ => crate::Corner::Fixed(0),
                };
                component.component().paint(
                    &mut Paint {
                        canvas,
                        look,
                        rect: p.rect,
                        visible,
                        alpha: p.alpha,
                        interaction: interaction(p),
                        progress: p.progress,
                        corner,
                        state: self.components.get(&p.key),
                        read: Read {
                            look,
                            ..self.context(i)
                        },
                        wash: self.painted.get(&i).copied(),
                    },
                    PaintPhase::Under,
                );
                continue;
            }
            match &p.what {
                What::Group => {
                    // Not glass: the view paints the card itself, under what it holds.
                    canvas.clip(rect(&visible));
                    canvas.rounded_rect(
                        rect(&p.rect),
                        tokens.group_radius.min(p.rect[2].min(p.rect[3]) / 2.),
                        ink(tokens.look.surface),
                    );
                    canvas.pop_clip();
                }
                What::Text { ink: tier, .. } => {
                    if let Some(f) = self.text.get(&p.key) {
                        canvas.clip(rect(&visible));
                        let base = self
                            .component_ink(i, look, interaction(p), false)
                            .unwrap_or_else(|| tokens.look.ink(*tier));
                        let r = canvas.layout(
                            &f.layout,
                            (p.rect[0] as f32, p.rect[1] as f32),
                            content(base),
                        );
                        canvas.pop_clip();
                        r?;
                    }
                }
                What::Icon(icon) => {
                    if let Some(glyph) = icons(&icon.name, icon.size) {
                        canvas.clip(rect(&visible));
                        let c = self
                            .component_ink(i, look, interaction(p), true)
                            .unwrap_or_else(|| tokens.look.ink(icon.ink));
                        let c = c.with_alpha(c.components[3] * icon.alpha as f32);
                        canvas.icon(&glyph, rect(&p.rect), content(c));
                        canvas.pop_clip();
                    }
                }
                _ => {}
            }
        }
        for (i, p) in self.placed.iter().enumerate() {
            if !part(i) || !self.shown(i) || p.control.is_some_and(|c| !self.shown(c)) {
                continue;
            }
            if let (Some(component), Some(visible)) =
                (p.part(), p.visible().filter(|_| p.alpha > 0.))
            {
                let corner = match &p.what {
                    What::Control(_) => p
                        .part()
                        .map(|part| part.component().corner())
                        .unwrap_or(crate::Corner::Pill),
                    _ => crate::Corner::Fixed(0),
                };
                component.component().paint(
                    &mut Paint {
                        canvas,
                        look,
                        rect: p.rect,
                        visible,
                        alpha: p.alpha,
                        interaction: interaction(p),
                        progress: p.progress,
                        corner,
                        state: self.components.get(&p.key),
                        read: Read {
                            look,
                            ..self.context(i)
                        },
                        wash: self.painted.get(&i).copied(),
                    },
                    PaintPhase::Over,
                );
            }
        }
        self.paint_focus(canvas, look, &part);
        for s in self.regions().filter(|&s| part(s)) {
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

impl ViewState {
    fn component_ink(
        &self,
        i: usize,
        look: ComponentLook<'_>,
        interaction: Interaction,
        glyph: bool,
    ) -> Option<nk_render::Color> {
        let owner = self.placed[i].control.filter(|&o| o != i)?;
        self.placed[owner]
            .part()?
            .component()
            .ink(look, interaction, glyph)
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
fn a11y_role(role: Role) -> nk_a11y::Role {
    match role {
        Role::Button => nk_a11y::Role::Button,
        Role::Toggle => nk_a11y::Role::ToggleButton,
        Role::Slider => nk_a11y::Role::Slider,
        Role::Field => nk_a11y::Role::TextInput,
        Role::Check => nk_a11y::Role::CheckBox,
        Role::Radio => nk_a11y::Role::RadioButton,
        Role::Dropdown => nk_a11y::Role::ComboBox,
        Role::Option => nk_a11y::Role::Option,
    }
}
fn inside(r: Rect, p: (f64, f64)) -> bool {
    p.0 >= r[0] && p.1 >= r[1] && p.0 < r[0] + r[2] && p.1 < r[1] + r[3]
}
fn overlaps(a: Rect, b: Rect) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}

#[cfg(test)]
#[path = "focus_tests.rs"]
mod focus_tests;
