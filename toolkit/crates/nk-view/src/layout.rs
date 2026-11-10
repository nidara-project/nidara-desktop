// SPDX-License-Identifier: LGPL-3.0-or-later
//! Two passes, as in `nk-widgets` (VIEW.md §3): each node is measured under a width, keeping
//! the text layout paint will use; then it is placed. The placed rectangles feed paint,
//! hit-testing, semantics and the material, so nothing computes a position twice.
use crate::tokens::Spacing;
use crate::view::{Align, Axis, Control, Corner, Icon, Ink, Justify, Key, Kind, Node, Stack};
use nk_text::{Layout, TextBackend, TextStyle};
use std::collections::HashMap;
use unicode_segmentation::UnicodeSegmentation;

/// Wide enough that a text never breaks: its natural, one-line width.
const UNBOUNDED: f32 = 100_000.;

/// A rectangle in logical pixels: x, y, width, height. Every edge is on the output's
/// device-pixel grid.
pub type Rect = [f64; 4];

/// A text's layout, as measured and as painted.
pub struct Fitted {
    /// What is drawn: the text, or its cut ending in an ellipsis.
    pub shown: String,
    pub layout: Layout,
}
#[derive(Default)]
struct CachedText {
    natural: Option<(String, TextStyle, f64)>,
    fitted: Option<(String, TextStyle, Option<usize>, f32, Fitted)>,
}
/// Text layouts by key. A text keeps its layout while its string, style, line limit and width
/// are unchanged, and is dropped when its key leaves the view.
#[derive(Default)]
pub struct TextCache {
    entries: HashMap<Key, CachedText>,
    /// How many layouts were made since the cache was created (tests and the cost check).
    pub shaped: usize,
}
impl TextCache {
    fn natural(
        &mut self,
        backend: &mut dyn TextBackend,
        key: &Key,
        text: &str,
        style: &TextStyle,
    ) -> f64 {
        let e = self.entries.entry(key.clone()).or_default();
        if let Some((t, s, w)) = &e.natural
            && t == text
            && s == style
        {
            return *w;
        }
        let w = match backend.layout(&one_line(text), style, UNBOUNDED) {
            Ok(l) => {
                self.shaped += 1;
                natural_width(&l)
            }
            Err(_) => 0.,
        };
        e.natural = Some((text.into(), style.clone(), w));
        w
    }
    fn fit(
        &mut self,
        backend: &mut dyn TextBackend,
        key: &Key,
        text: &str,
        style: &TextStyle,
        lines: Option<usize>,
        width: f32,
    ) -> Option<&Fitted> {
        let e = self.entries.entry(key.clone()).or_default();
        let fresh = matches!(&e.fitted, Some((t, s, n, w, _)) if t == text && s == style && *n == lines && *w == width);
        if !fresh {
            let (fitted, shaped) = fit(backend, text, style, lines, width)?;
            self.shaped += shaped;
            e.fitted = Some((text.into(), style.clone(), lines, width, fitted));
        }
        e.fitted.as_ref().map(|f| &f.4)
    }
    pub fn get(&self, key: &Key) -> Option<&Fitted> {
        self.entries
            .get(key)
            .and_then(|e| e.fitted.as_ref())
            .map(|f| &f.4)
    }
    fn retain(&mut self, live: &std::collections::HashSet<Key>) {
        self.entries.retain(|k, _| live.contains(k));
    }
}

fn one_line(s: &str) -> String {
    s.replace(['\r', '\n'], " ")
}
fn natural_width(l: &Layout) -> f64 {
    l.lines()
        .iter()
        .map(|line| (line.bounds.x + line.bounds.width) as f64)
        .fold(0., f64::max)
}

/// A text laid out to `width`. An interface label is one line, whole. A text with a line
/// limit wraps, and if it needs more lines it is cut at a grapheme and ends in an ellipsis.
fn fit(
    backend: &mut dyn TextBackend,
    text: &str,
    style: &TextStyle,
    lines: Option<usize>,
    width: f32,
) -> Option<(Fitted, usize)> {
    let width = width.max(1.);
    let Some(n) = lines else {
        let s = one_line(text);
        let layout = backend.layout(&s, style, UNBOUNDED).ok()?;
        return Some((Fitted { shown: s, layout }, 1));
    };
    let s = if n == 1 {
        one_line(text)
    } else {
        text.to_string()
    };
    let mut shaped = 1;
    let layout = backend.layout(&s, style, width).ok()?;
    if layout.lines().len() <= n && natural_width(&layout) <= width as f64 + 0.5 {
        return Some((Fitted { shown: s, layout }, shaped));
    }
    let cuts: Vec<usize> = s
        .grapheme_indices(true)
        .map(|(i, _)| i)
        .chain([s.len()])
        .collect();
    let candidate = |i: usize| format!("{}…", s[..cuts[i]].trim_end());
    let (mut lo, mut hi) = (0, cuts.len().saturating_sub(1));
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        shaped += 1;
        let fits = backend
            .layout(&candidate(mid), style, width)
            .is_ok_and(|l| l.lines().len() <= n && natural_width(&l) <= width as f64 + 0.5);
        if fits {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    let shown = candidate(lo);
    shaped += 1;
    let layout = backend.layout(&shown, style, width).ok()?;
    Some((Fitted { shown, layout }, shaped))
}

/// A measured node: its size, the smallest width it can take, where its first text line's
/// centre lies below its top, and its children's measures.
struct Measure {
    w: f64,
    h: f64,
    first_line: Option<f64>,
    children: Vec<Measure>,
    /// A horizontal stack with `FirstLine`: each child's offset from the top.
    cross: Vec<f64>,
}

/// One placed node, in tree order.
#[derive(Clone, Debug)]
pub struct Placed {
    pub key: Key,
    pub rect: Rect,
    pub what: What,
    pub parent: Option<usize>,
    /// The nearest pane this node lies in.
    pub pane: Option<usize>,
    /// The nearest control this node lies in (itself for a control).
    pub control: Option<usize>,
}
#[derive(Clone, Debug)]
pub enum What {
    Stack,
    Pane(Corner),
    Text { full: String, ink: Ink },
    Icon(Icon),
    Spacer,
    Control(Control),
}

pub struct Layouter<'a> {
    pub spacing: &'a Spacing,
    pub text: &'a mut dyn TextBackend,
    pub cache: &'a mut TextCache,
    pub scale: f64,
}

impl Layouter<'_> {
    /// Lays the view out in a `size` box at the origin; returns every node placed, in tree
    /// order. Texts whose key left the view are dropped from the cache.
    pub fn run(&mut self, root: &Node, size: (f64, f64)) -> Vec<Placed> {
        let m = self.measure(root, size.0);
        let mut out = Vec::new();
        self.place(
            root,
            &m,
            [0., 0., size.0, size.1],
            None,
            None,
            None,
            &mut out,
        );
        let live: std::collections::HashSet<Key> = out.iter().map(|p| p.key.clone()).collect();
        self.cache.retain(&live);
        out
    }

    fn natural(&mut self, n: &Node) -> f64 {
        match &n.kind {
            Kind::Text(t) => self.cache.natural(self.text, &n.key, &t.text, &t.style),
            Kind::Icon(i) => i.size,
            Kind::Spacer => 0.,
            Kind::Pane(p) => self.natural(&p.child),
            Kind::Control(c) => self.natural(&c.child),
            Kind::Stack(s) => {
                let pad = self.spacing.of(s.padding.left) + self.spacing.of(s.padding.right);
                let ws: Vec<f64> = s.children.iter().map(|c| self.natural(c)).collect();
                pad + self.combine(s, &ws)
            }
        }
    }
    fn min(&mut self, n: &Node) -> f64 {
        match &n.kind {
            Kind::Text(t) if t.lines.is_some() => 0.,
            Kind::Text(_) | Kind::Icon(_) => self.natural(n),
            Kind::Spacer => 0.,
            Kind::Pane(p) => self.min(&p.child),
            Kind::Control(c) => self.min(&c.child),
            Kind::Stack(s) => {
                let pad = self.spacing.of(s.padding.left) + self.spacing.of(s.padding.right);
                let ws: Vec<f64> = s.children.iter().map(|c| self.min(c)).collect();
                pad + self.combine(s, &ws)
            }
        }
    }
    /// Children's widths combined along a stack's axis: summed with gaps, or the widest.
    fn combine(&self, s: &Stack, ws: &[f64]) -> f64 {
        match s.axis {
            Axis::Horizontal => {
                ws.iter().sum::<f64>() + self.spacing.of(s.gap) * ws.len().saturating_sub(1) as f64
            }
            Axis::Vertical => ws.iter().copied().fold(0., f64::max),
        }
    }

    fn measure(&mut self, n: &Node, width: f64) -> Measure {
        let leaf = |w, h, first_line| Measure {
            w,
            h,
            first_line,
            children: vec![],
            cross: vec![],
        };
        match &n.kind {
            Kind::Spacer => leaf(0., 0., None),
            Kind::Icon(i) => leaf(i.size, i.size, None),
            Kind::Text(t) => {
                let (w, h, first) = match self.cache.fit(
                    self.text,
                    &n.key,
                    &t.text,
                    &t.style,
                    t.lines,
                    width as f32,
                ) {
                    Some(f) => {
                        let size = f.layout.measured_size();
                        let first = f
                            .layout
                            .lines()
                            .first()
                            .map(|l| (l.bounds.y + l.bounds.height / 2.) as f64);
                        (natural_width(&f.layout).max(0.), size.height as f64, first)
                    }
                    None => (0., 0., None),
                };
                leaf(if t.lines.is_some() { w.min(width) } else { w }, h, first)
            }
            Kind::Pane(p) => {
                let c = self.measure(&p.child, width);
                Measure {
                    w: c.w,
                    h: c.h,
                    first_line: c.first_line,
                    children: vec![c],
                    cross: vec![],
                }
            }
            Kind::Control(ctl) => {
                let c = self.measure(&ctl.child, width);
                Measure {
                    w: c.w,
                    h: c.h,
                    first_line: c.first_line,
                    children: vec![c],
                    cross: vec![],
                }
            }
            Kind::Stack(s) => self.measure_stack(s, width),
        }
    }

    fn measure_stack(&mut self, s: &Stack, width: f64) -> Measure {
        let sp = self.spacing;
        let (pt, pr, pb, pl) = (
            sp.of(s.padding.top),
            sp.of(s.padding.right),
            sp.of(s.padding.bottom),
            sp.of(s.padding.left),
        );
        let gap = sp.of(s.gap);
        let inner = (width - pl - pr).max(0.);
        let gaps = gap * s.children.len().saturating_sub(1) as f64;
        match s.axis {
            Axis::Horizontal => {
                // Each child starts at its natural width; if the row is short, those that can
                // shrink give up width in proportion to how much they can give.
                let nat: Vec<f64> = s.children.iter().map(|c| self.natural(c)).collect();
                let min: Vec<f64> = s.children.iter().map(|c| self.min(c)).collect();
                let total: f64 = nat.iter().sum::<f64>() + gaps;
                let give: f64 = nat.iter().zip(&min).map(|(n, m)| n - m).sum();
                let deficit = (total - inner).max(0.);
                let widths: Vec<f64> = nat
                    .iter()
                    .zip(&min)
                    .map(|(n, m)| {
                        if deficit > 0. && give > 0. {
                            n - (n - m) * (deficit / give).min(1.)
                        } else {
                            *n
                        }
                    })
                    .collect();
                let children: Vec<Measure> = s
                    .children
                    .iter()
                    .zip(&widths)
                    .map(|(c, w)| self.measure(c, *w))
                    .collect();
                let w = children.iter().map(|c| c.w).sum::<f64>() + gaps + pl + pr;
                let (h, cross, first_line) = if s.align == Align::FirstLine {
                    // The reference is the lowest first line; a child with text puts its
                    // first line on it, one without is centred on it.
                    let reference = children
                        .iter()
                        .filter_map(|c| c.first_line)
                        .fold(f64::NAN, f64::max);
                    if reference.is_nan() {
                        let h = children.iter().map(|c| c.h).fold(0., f64::max);
                        (h, children.iter().map(|c| (h - c.h) / 2.).collect(), None)
                    } else {
                        let ys: Vec<f64> = children
                            .iter()
                            .map(|c| reference - c.first_line.unwrap_or(c.h / 2.))
                            .collect();
                        let top = ys.iter().copied().fold(0., f64::min);
                        let ys: Vec<f64> = ys.iter().map(|y| y - top).collect();
                        let h = children
                            .iter()
                            .zip(&ys)
                            .map(|(c, y)| y + c.h)
                            .fold(0., f64::max);
                        (h, ys, Some(reference - top + pt))
                    }
                } else {
                    let h = children.iter().map(|c| c.h).fold(0., f64::max);
                    let first = children.iter().find_map(|c| {
                        c.first_line.map(|f| {
                            pt + f
                                + match s.align {
                                    Align::Center => (h - c.h) / 2.,
                                    Align::End => h - c.h,
                                    _ => 0.,
                                }
                        })
                    });
                    (h, vec![], first)
                };
                Measure {
                    w,
                    h: h + pt + pb,
                    first_line,
                    children,
                    cross,
                }
            }
            Axis::Vertical => {
                let mut children = Vec::with_capacity(s.children.len());
                for c in &s.children {
                    let w = if s.align == Align::Stretch {
                        inner
                    } else {
                        self.natural(c).min(inner)
                    };
                    children.push(self.measure(c, w));
                }
                let mut first_line = None;
                let mut y = pt;
                for c in &children {
                    if first_line.is_none() {
                        first_line = c.first_line.map(|f| y + f);
                    }
                    y += c.h + gap;
                }
                let w = children.iter().map(|c| c.w).fold(0., f64::max) + pl + pr;
                Measure {
                    w: if s.align == Align::Stretch {
                        width.max(w)
                    } else {
                        w
                    },
                    h: children.iter().map(|c| c.h).sum::<f64>() + gaps + pt + pb,
                    first_line,
                    children,
                    cross: vec![],
                }
            }
        }
    }

    fn snap(&self, r: Rect) -> Rect {
        let s = self.scale.max(f64::MIN_POSITIVE);
        let edge = |v: f64| (v * s).round() / s;
        let (x0, y0, x1, y1) = (edge(r[0]), edge(r[1]), edge(r[0] + r[2]), edge(r[1] + r[3]));
        [x0, y0, (x1 - x0).max(0.), (y1 - y0).max(0.)]
    }

    #[allow(clippy::too_many_arguments)]
    fn place(
        &mut self,
        n: &Node,
        m: &Measure,
        r: Rect,
        parent: Option<usize>,
        pane: Option<usize>,
        control: Option<usize>,
        out: &mut Vec<Placed>,
    ) {
        let index = out.len();
        let what = match &n.kind {
            Kind::Stack(_) => What::Stack,
            Kind::Pane(p) => What::Pane(p.corner),
            Kind::Text(t) => What::Text {
                full: t.text.clone(),
                ink: t.ink,
            },
            Kind::Icon(i) => What::Icon(i.clone()),
            Kind::Spacer => What::Spacer,
            Kind::Control(c) => What::Control(Control {
                child: Box::new(Node::spacer("")),
                ..c.clone()
            }),
        };
        let (own_pane, own_control) = match &n.kind {
            Kind::Pane(_) => (Some(index), control),
            Kind::Control(_) => (pane, Some(index)),
            _ => (pane, control),
        };
        out.push(Placed {
            key: n.key.clone(),
            rect: self.snap(r),
            what,
            parent,
            pane,
            control: own_control,
        });
        match &n.kind {
            Kind::Pane(p) => self.place(
                &p.child,
                &m.children[0],
                r,
                Some(index),
                own_pane,
                own_control,
                out,
            ),
            Kind::Control(c) => self.place(
                &c.child,
                &m.children[0],
                r,
                Some(index),
                own_pane,
                own_control,
                out,
            ),
            Kind::Stack(s) => self.place_stack(s, m, r, index, own_pane, own_control, out),
            _ => {}
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn place_stack(
        &mut self,
        s: &Stack,
        m: &Measure,
        r: Rect,
        index: usize,
        pane: Option<usize>,
        control: Option<usize>,
        out: &mut Vec<Placed>,
    ) {
        let sp = self.spacing;
        let (pt, pr, pb, pl) = (
            sp.of(s.padding.top),
            sp.of(s.padding.right),
            sp.of(s.padding.bottom),
            sp.of(s.padding.left),
        );
        let gap = sp.of(s.gap);
        let inner = [
            r[0] + pl,
            r[1] + pt,
            (r[2] - pl - pr).max(0.),
            (r[3] - pt - pb).max(0.),
        ];
        let horizontal = s.axis == Axis::Horizontal;
        let (main, cross) = if horizontal {
            (inner[2], inner[3])
        } else {
            (inner[3], inner[2])
        };
        let sizes: Vec<f64> = m
            .children
            .iter()
            .map(|c| if horizontal { c.w } else { c.h })
            .collect();
        let used = sizes.iter().sum::<f64>() + gap * sizes.len().saturating_sub(1) as f64;
        let left = (main - used).max(0.);
        let spacers = s
            .children
            .iter()
            .filter(|c| matches!(c.kind, Kind::Spacer))
            .count();
        let growers = s.children.iter().filter(|c| c.grow).count();
        let mut extra = vec![0.; sizes.len()];
        let mut start = 0.;
        if left > 0. {
            if spacers > 0 {
                for (i, c) in s.children.iter().enumerate() {
                    if matches!(c.kind, Kind::Spacer) {
                        extra[i] = left / spacers as f64;
                    }
                }
            } else if growers > 0 {
                for (i, c) in s.children.iter().enumerate() {
                    if c.grow {
                        extra[i] = left / growers as f64;
                    }
                }
            } else {
                start = match s.justify {
                    Justify::Start => 0.,
                    Justify::Center => left / 2.,
                    Justify::End => left,
                };
            }
        }
        let mut at = start;
        for (i, (c, cm)) in s.children.iter().zip(&m.children).enumerate() {
            let len = sizes[i] + extra[i];
            let size = if horizontal { cm.h } else { cm.w };
            let (offset, across) = match s.align {
                Align::Stretch => (0., cross),
                Align::Start => (0., size),
                Align::Center => ((cross - size) / 2., size),
                Align::End => (cross - size, size),
                Align::FirstLine if horizontal => (m.cross.get(i).copied().unwrap_or(0.), size),
                Align::FirstLine => (0., size),
            };
            let rect = if horizontal {
                [inner[0] + at, inner[1] + offset, len, across]
            } else {
                [inner[0] + offset, inner[1] + at, across, len]
            };
            self.place(c, cm, rect, Some(index), pane, control, out);
            at += len + gap;
        }
    }
}

/// The first line's centre of a placed text, for checks: its layout's first line, in the
/// text's rect.
pub fn first_line_centre(cache: &TextCache, p: &Placed) -> Option<f64> {
    let f = cache.get(&p.key)?;
    let l = f.layout.lines().first()?;
    Some(p.rect[1] + (l.bounds.y + l.bounds.height / 2.) as f64)
}
