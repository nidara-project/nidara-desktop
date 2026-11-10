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

/// The keys that move focus or activate.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyInput {
    Tab,
    ShiftTab,
    /// Enter or Space on the focused control.
    Activate,
}

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
    /// The motion tokens of the last layout, for a release between frames.
    motion_tokens: Option<crate::tokens::Motion>,
    view: Option<Node>,
    size: (f64, f64),
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
            motion_tokens: None,
            view: None,
            size: (0., 0.),
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
        let before: HashMap<Key, Rect> = self
            .laid
            .iter()
            .filter(|p| matches!(p.what, What::Pane(_)))
            .map(|p| (p.key.clone(), p.rect))
            .collect();
        self.motion.view(view, now, &tokens.motion);
        self.motion_tokens = Some(tokens.motion);
        self.view = Some(view.clone());
        self.size = size;
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
        if !self.motion.animating() {
            return Ticked::default();
        }
        let activated = self
            .motion
            .finished(now)
            .into_iter()
            .map(|(key, action)| Activated { key, action })
            .collect();
        self.relayout(tokens, text, now, None);
        self.rehover();
        Ticked {
            animating: self.motion.animating(),
            activated,
        }
    }

    /// Whether a reveal eases or a pane slides.
    pub fn animating(&self) -> bool {
        self.motion.animating()
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
        let mut placed = Layouter {
            spacing: &tokens.spacing,
            reveals: &reveals,
            text,
            cache: &mut self.text,
            scale: self.scale,
        }
        .run(view, self.size);
        if let Some(before) = rebuilt {
            self.motion.moved(before, &placed, now);
        }
        self.motion
            .slide(&mut placed, now, &tokens.motion, self.scale);
        self.now = now;
        self.laid = placed;
        self.reswipe();
    }

    /// The placement with the swipes in force at the last instant laid out.
    fn reswipe(&mut self) {
        let mut placed = self.laid.clone();
        self.motion
            .swipe(&mut placed, self.now, self.size.0, self.scale);
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

    /// The innermost shown, enabled control under a point.
    fn hit(&self, pt: (f64, f64)) -> Option<usize> {
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
        let swiped = self.end_swipe(0., self.now).is_some();
        self.rehover() | (revealed != self.revealed()) | swiped
    }

    /// Ends the drag. A claimed swipe is released `dx` across (0 settles it back), and with
    /// reduced motion a fling reports at once. None: there was no swipe.
    fn end_swipe(&mut self, dx: f64, now: Instant) -> Option<Option<Activated>> {
        let d = self.drag.take().filter(|d| d.claimed)?;
        let motion = self.motion_tokens?;
        let action = self
            .index(&d.key)
            .and_then(|i| self.control(i).swipe.clone())
            .unwrap_or_default();
        let out = self
            .motion
            .swipe_release(&d.key, dx, self.size.0, action, now, &motion);
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
                None
            }
            KeyInput::Activate => {
                let i = order[at?];
                Some(Activated {
                    key: self.placed[i].key.clone(),
                    action: self.control(i).action.clone(),
                })
            }
        }
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
        let viewport = [0., 0., self.size.0, self.size.1];
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
    /// its name) and each text outside a control (by its whole text, never its cut).
    pub fn semantics(&self, root: nk_a11y::Node, first_id: NodeId) -> Tree {
        let mut nodes = std::collections::BTreeMap::new();
        let root_id = root.id;
        nodes.insert(root_id, root);
        let mut ids: HashMap<usize, NodeId> = HashMap::new();
        let mut next = first_id;
        for (i, p) in self.placed.iter().enumerate() {
            if p.alpha <= 0. {
                continue;
            }
            let node = match &p.what {
                What::Pane(_) => nk_a11y::Node::new(next, nk_a11y::Role::Panel, ""),
                What::Control(c) => {
                    let mut n = nk_a11y::Node::new(
                        next,
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
                    nk_a11y::Node::new(next, nk_a11y::Role::Label, full.clone())
                }
                _ => continue,
            };
            let mut node = node;
            node.bounds = Bounds {
                x: p.rect[0],
                y: p.rect[1],
                width: p.rect[2],
                height: p.rect[3],
            };
            let parent = p.pane.and_then(|q| ids.get(&q).copied()).unwrap_or(root_id);
            nodes
                .get_mut(&parent)
                .expect("parent is placed first")
                .children
                .push(next);
            nodes.insert(next, node);
            ids.insert(i, next);
            next += 1;
        }
        Tree {
            root: root_id,
            nodes,
        }
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
fn inside(r: Rect, p: (f64, f64)) -> bool {
    p.0 >= r[0] && p.1 >= r[1] && p.0 < r[0] + r[2] && p.1 < r[1] + r[3]
}
fn overlaps(a: Rect, b: Rect) -> bool {
    a[0] < b[0] + b[2] && b[0] < a[0] + a[2] && a[1] < b[1] + b[3] && b[1] < a[1] + a[3]
}
