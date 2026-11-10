// SPDX-License-Identifier: LGPL-3.0-or-later
//! The interaction state the toolkit derives (VIEW.md §4): hover, press and focus, kept by key
//! across rebuilds; the panes and state regions a frame declares to Hyalo, within its budget;
//! the semantics; and the content paint (texts, icons, the focus ring, and the D5 washes).
use crate::layout::{Layouter, Placed, Rect, TextCache, What};
use crate::tokens::{Tokens, Washes};
use crate::view::{Key, Node, Role, Wash};
use nk_a11y::{Action, Bounds, NodeId, Tree};
use nk_render::Canvas;
use nk_wayland::{MaterialRect, Pane, StateRegion};
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
    pub panes: Vec<(Key, Pane)>,
    pub states: Vec<StateRegion>,
}

pub struct ViewState {
    placed: Vec<Placed>,
    size: (f64, f64),
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
            size: (0., 0.),
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

    /// Lays a rebuilt view out. States whose control left, or was disabled, are cleared;
    /// hover is recomputed under the pointer, since the layout may have moved under it.
    pub fn layout(
        &mut self,
        view: &Node,
        size: (f64, f64),
        scale: f64,
        tokens: &Tokens,
        text: &mut dyn nk_text::TextBackend,
    ) {
        self.placed = Layouter {
            spacing: &tokens.spacing,
            text,
            cache: &mut self.text,
            scale,
        }
        .run(view, size);
        self.size = size;
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
        self.rehover();
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
            .filter(|(_, p)| matches!(p.what, What::Control(_)))
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
            .filter(|&i| self.enabled(i) && self.shown(i) && inside(self.placed[i].rect, pt))
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

    /// The pointer moved; whether anything shown changed (a hover, a revealed control).
    pub fn pointer_motion(&mut self, x: f64, y: f64) -> bool {
        let revealed = self.revealed();
        self.pointer = Some((x, y));
        self.rehover() | (revealed != self.revealed())
    }
    /// The pointer left the surface: hover clears and its wash fades.
    pub fn pointer_leave(&mut self) -> bool {
        let revealed = self.revealed();
        self.pointer = None;
        self.press = None;
        self.rehover() | (revealed != self.revealed())
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

    /// The primary button went down or up. A release over the pressed control activates
    /// it; a release elsewhere cancels.
    pub fn button(&mut self, pressed: bool) -> Option<Activated> {
        if pressed {
            self.press = self.hover.clone();
            self.focus_visible = false;
            return None;
        }
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
    pub fn frame(&mut self, washes: &Washes, now: Instant) -> Frame {
        let fade = Duration::from_millis(washes.fade_ms as u64);
        self.fading.retain(|_, until| *until > now);
        let viewport = [0., 0., self.size.0, self.size.1];
        let panes = self
            .placed
            .iter()
            .filter_map(|p| match p.what {
                What::Pane(c) if overlaps(p.rect, viewport) => Some((
                    p.key.clone(),
                    Pane {
                        x: p.rect[0],
                        y: p.rect[1],
                        width: p.rect[2],
                        height: p.rect[3],
                        radius: c.of(p.rect[2], p.rect[3]),
                        exponent: 2.,
                        pointer: None,
                    },
                )),
                _ => None,
            })
            .collect();
        // (priority, pane, control, wash); priority 4 is rest.
        let mut regions: Vec<(u8, Option<usize>, usize, [f64; 4])> = vec![];
        for i in self.controls().collect::<Vec<_>>() {
            let c = self.control(i);
            if c.wash == Wash::None || !self.shown(i) || !overlaps(self.placed[i].rect, viewport) {
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
            let r = self.placed[i].rect;
            let corner = self.control(i).corner;
            states.push(StateRegion {
                id: self.id(&key),
                bounds: MaterialRect {
                    x: r[0],
                    y: r[1],
                    width: r[2],
                    height: r[3],
                },
                radius: corner.of(r[2], r[3]),
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
            match &p.what {
                What::Text { ink, .. } => {
                    if let Some(f) = self.text.get(&p.key) {
                        canvas.clip(rect(&p.rect));
                        let r = canvas.layout(
                            &f.layout,
                            (p.rect[0] as f32, p.rect[1] as f32),
                            tokens.look.ink(*ink),
                        );
                        canvas.pop_clip();
                        r?;
                    }
                }
                What::Icon(icon) => {
                    if let Some(glyph) = icons(&icon.name, icon.size) {
                        canvas.icon(&glyph, rect(&p.rect), tokens.look.ink(icon.ink));
                    }
                }
                What::Control(c) if self.focus_visible && self.focus.as_ref() == Some(&p.key) => {
                    let r = p.rect;
                    canvas.rounded_ring(
                        rect(&r),
                        c.corner.of(r[2], r[3]),
                        tokens.look.focus_width,
                        tokens.look.focus,
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
