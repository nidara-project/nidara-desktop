// SPDX-License-Identifier: LGPL-3.0-or-later
//! The overlay scroll bar of the content pane and the sidebar, the kit's `NidaraScrolled`
//! (`ui/lib/nidara-kit/scrolled.ts`) in the native toolkit: a thin pill PAINTED inside a lane
//! of constant width at the trailing edge. Scrolling or moving over the pane reveals it; it
//! fades out after `hide_ms` unless the pointer sits on the lane or drags it. On the lane the
//! painted pill widens and a faint track appears — the hit lane never grows, which is what
//! kept GTK's bar from eating a row's trailing control. Pressing the empty track jumps there,
//! then drags from that position. Nothing here is laid out: a scroll position only repaints.
use crate::*;
use nk_render::{Canvas, Color};
use std::time::Instant;

/// The exported look (`components.json` `scrollbar`); no geometry, timing or colour defaults.
#[derive(Clone, Debug)]
pub struct ScrollbarStyle {
    /// Hit lane width at the pane's trailing edge.
    pub lane: f32,
    pub thumb_rest: f32,
    pub thumb_hover: f32,
    pub thumb_min: f32,
    /// Gap between the pill and the pane's trailing wall.
    pub edge_clear: f32,
    /// Gap between the pill and a corner's curve (added to what the curve itself takes).
    pub corner_clear: f32,
    pub hide_ms: f32,
    pub fade_ms: f32,
    /// Time constant of the width easing (the kit's ~120 ms settle).
    pub width_tau_ms: f32,
    pub track_opacity: f32,
    pub color: Color,
    pub active: Color,
}
impl ScrollbarStyle {
    fn validate(&self) -> Result<()> {
        let positive = [
            self.lane,
            self.thumb_rest,
            self.thumb_hover,
            self.thumb_min,
            self.hide_ms,
            self.fade_ms,
            self.width_tau_ms,
        ];
        if !positive.iter().all(|v| v.is_finite() && *v > 0.)
            || ![self.edge_clear, self.corner_clear]
                .iter()
                .all(|v| v.is_finite() && *v >= 0.)
            || self.thumb_hover < self.thumb_rest
            // The widened pill must stay inside the lane.
            || self.thumb_hover + self.edge_clear > self.lane
            || !(0. ..=1.).contains(&self.track_opacity)
            || ![self.color, self.active].iter().all(|c| {
                c.components.iter().all(|v| v.is_finite()) && (0. ..=1.).contains(&c.components[3])
            })
        {
            return Err("invalid scrollbar style".into());
        }
        Ok(())
    }
}

/// One scrolling pane's bar: what reveals it and where its animation stands. The kit's
/// one bar: the native Tree uses it for its content Scroll and Sidebar, and `nk-view` for
/// its scroll regions, so both paint, fade and drag alike.
#[derive(Clone, Copy, Debug, Default)]
pub struct ScrollBar {
    /// Something revealed it since the last tick (a scroll, motion over the pane).
    revealed: bool,
    shown_at: Option<Instant>,
    in_lane: bool,
    /// Pointer y and scroll offset when the drag began.
    drag: Option<(f32, f32)>,
    pub(crate) opacity: f32,
    pub(crate) width: f32,
    last: Option<Instant>,
}

/// Where a bar's thumb sits, in the coordinates its viewport was given in.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BarGeometry {
    /// The hit lane at the viewport's trailing edge; it never grows.
    pub lane: Rect,
    pub track: Rect,
    pub thumb_y: f32,
    pub thumb_h: f32,
    /// Scroll range and thumb travel, for converting a pointer delta into an offset.
    pub range: f32,
    pub travel: f32,
}

impl ScrollbarStyle {
    /// The style, if it is valid.
    pub fn checked(self) -> Result<Self> {
        self.validate()?;
        Ok(self)
    }
    /// What a rounded corner of radius `r` at an end of the lane takes from the track: the
    /// pill keeps `corner_clear` from the curve as it keeps `edge_clear` from the wall
    /// (scrolled.ts cornerClearFor). A square end takes `corner_clear`.
    fn corner(&self, r: f32) -> f32 {
        if r <= self.edge_clear {
            self.corner_clear
        } else {
            (r - (r * r - (r - self.edge_clear).powi(2)).sqrt()).ceil() + self.corner_clear
        }
    }
    /// The bar of a `viewport` showing `content` px of height scrolled to `offset`, with
    /// corners of the given radii at its top and bottom ends. None when nothing scrolls.
    pub fn geometry(
        &self,
        viewport: Rect,
        content: f32,
        offset: f32,
        top_radius: f32,
        bottom_radius: f32,
    ) -> Option<BarGeometry> {
        // Half a pixel of slack: a rounding difference must not flash a bar that cannot move.
        let range = content - viewport.height;
        if range <= 0.5 || viewport.height <= 0. {
            return None;
        }
        let lane = Rect {
            x: viewport.x + viewport.width - self.lane,
            y: viewport.y,
            width: self.lane,
            height: viewport.height,
        };
        let (top, bottom) = (self.corner(top_radius), self.corner(bottom_radius));
        let track = Rect {
            y: viewport.y + top,
            height: (viewport.height - top - bottom).max(1.),
            ..lane
        };
        let thumb_h = self
            .thumb_min
            .max((track.height * viewport.height / content).round())
            .min(track.height);
        let travel = (track.height - thumb_h).max(1.);
        let progress = (offset / range).clamp(0., 1.);
        Some(BarGeometry {
            lane,
            track,
            thumb_y: track.y + progress * travel,
            thumb_h,
            range,
            travel,
        })
    }
}

impl ScrollBar {
    /// A scroll, or motion over the pane: the bar shows from the next tick.
    pub fn reveal(&mut self) {
        self.revealed = true;
    }
    /// Whether the pointer is on the lane; true when that changed.
    pub fn set_in_lane(&mut self, on: bool) -> bool {
        std::mem::replace(&mut self.in_lane, on) != on
    }
    /// Whether it is drawn at all (a hidden bar takes no press).
    pub fn shown(&self) -> bool {
        self.opacity > 0.
    }
    pub fn opacity(&self) -> f32 {
        self.opacity
    }
    pub fn width(&self) -> f32 {
        self.width
    }
    pub fn dragging(&self) -> bool {
        self.drag.is_some()
    }
    /// A press at `y` on the lane of a pane scrolled to `offset`: on the empty track it
    /// jumps there first, then the drag starts from that position. Returns the offset to
    /// scroll to.
    pub fn press(&mut self, g: &BarGeometry, y: f32, offset: f32) -> f32 {
        let start = if y < g.thumb_y || y > g.thumb_y + g.thumb_h {
            ((y - g.track.y - g.thumb_h / 2.) / g.travel * g.range).clamp(0., g.range)
        } else {
            offset
        };
        self.drag = Some((y, start));
        start
    }
    /// The pointer at `y` during a drag: the offset it asks for, the thumb following it one
    /// to one. None without a drag.
    pub fn drag_to(&self, g: &BarGeometry, y: f32) -> Option<f32> {
        self.drag
            .map(|(start_y, start)| start + (y - start_y) * g.range / g.travel)
    }
    /// A release: true when it ended a drag, which reveals the bar again.
    pub fn release(&mut self) -> bool {
        let ended = self.drag.take().is_some();
        self.revealed |= ended;
        ended
    }
    /// Advance to `now`: whether it changed, and whether it still moves or waits to hide.
    pub fn tick(&mut self, s: &ScrollbarStyle, now: Instant) -> (bool, bool) {
        if std::mem::take(&mut self.revealed) {
            self.shown_at = Some(now);
        }
        let held = self.in_lane || self.drag.is_some();
        let recent = self
            .shown_at
            .is_some_and(|t| (now - t).as_secs_f32() * 1000. < s.hide_ms);
        let target_opacity = if held || recent { 1. } else { 0. };
        let target_width = if held { s.thumb_hover } else { s.thumb_rest };
        let dt = self
            .last
            .map_or(0., |t| ((now - t).as_secs_f32() * 1000.).min(50.));
        self.last = Some(now);
        let (opacity, width) = (self.opacity, self.width.max(s.thumb_rest));
        // Showing is immediate, as the kit's opacity flip; hiding fades.
        self.opacity = if target_opacity > opacity {
            1.
        } else {
            (opacity - dt / s.fade_ms).max(0.)
        };
        self.width = width + (target_width - width) * (1. - (-dt / s.width_tau_ms).exp());
        if (target_width - self.width).abs() < 0.25 {
            self.width = target_width;
        }
        let changed = self.opacity != opacity || self.width != width;
        (changed, self.opacity > 0. || self.width != target_width)
    }
    /// Paint the bar at `g`, shifted by `-origin`.
    pub fn paint(&self, s: &ScrollbarStyle, g: &BarGeometry, origin: Point, canvas: &mut Canvas) {
        if self.opacity <= 0. {
            return;
        }
        let width = self.width.max(s.thumb_rest);
        let held = self.in_lane || self.drag.is_some();
        let mut ink = if held { s.active } else { s.color };
        ink.components[3] *= self.opacity;
        let x = g.lane.x + g.lane.width - s.edge_clear - width - origin.x;
        let expand = ((width - s.thumb_rest) / (s.thumb_hover - s.thumb_rest).max(f32::EPSILON))
            .clamp(0., 1.);
        if expand > 0.01 {
            let mut track = ink;
            track.components[3] *= s.track_opacity * expand;
            canvas.rounded_rect(
                Rect {
                    x,
                    y: g.track.y - origin.y,
                    width,
                    height: g.track.height,
                },
                (width / 2.) as f64,
                track,
            );
        }
        canvas.rounded_rect(
            Rect {
                x,
                y: g.thumb_y - origin.y,
                width,
                height: g.thumb_h,
            },
            (width / 2.) as f64,
            ink,
        );
    }
}

impl Tree {
    /// Without it no pane draws a bar (the widgets demo, unit trees).
    pub fn set_scrollbar_style(&mut self, style: ScrollbarStyle) -> Result<()> {
        style.validate()?;
        for bar in self.bars.values_mut() {
            bar.width = style.thumb_rest;
        }
        self.scrollbar_style = Some(style);
        Ok(())
    }
    /// The panes that carry a bar: the content Scroll and the Sidebar.
    fn bar_panes(&self) -> Vec<NodeId> {
        self.nodes[&self.root]
            .children
            .iter()
            .copied()
            .filter(|id| {
                let n = &self.nodes[id];
                matches!(n.kind, Kind::Scroll | Kind::Sidebar) && !n.hidden
            })
            .collect()
    }
    fn bar_geometry(&self, id: NodeId) -> Option<BarGeometry> {
        let s = self.scrollbar_style.as_ref()?;
        let n = self.nodes.get(&id)?;
        // The window's own corner is the compositor's; the sidebar's frame shares its radius,
        // so the bottom clearance is taken from the same curve. The content pane's top edge
        // meets the header line, not a corner.
        let (viewport, top) = match n.kind {
            Kind::Sidebar => (self.sidebar_viewport(), self.sidebar_radius),
            Kind::Scroll => (self.content_viewport(), 0.),
            _ => return None,
        };
        s.geometry(
            viewport,
            n.measured.height,
            n.scroll.y,
            top,
            self.sidebar_radius,
        )
    }
    fn reveal_bar(&mut self, id: NodeId) {
        if self.scrollbar_style.is_some() {
            self.bars.entry(id).or_default().reveal();
        }
    }
    /// A scroll offset changed: the pane's bar shows.
    pub(crate) fn scrolled(&mut self, id: NodeId) {
        self.reveal_bar(id);
    }
    /// Pointer motion in window coordinates: reveals the pane under it, tracks the lane and
    /// drives a drag. True when a drag consumed it.
    pub fn scrollbar_motion(&mut self, p: Point) -> Result<bool> {
        if self.scrollbar_style.is_none() {
            return Ok(false);
        }
        for id in self.bar_panes() {
            let Some(g) = self.bar_geometry(id) else {
                continue;
            };
            let bar = self.bars.entry(id).or_default();
            if let Some(offset) = bar.drag_to(&g, p.y) {
                let x = self.nodes[&id].scroll.x;
                self.scroll_to(id, Point { x, y: offset })?;
                return Ok(true);
            }
            if bar.set_in_lane(contains(g.lane, p)) {
                self.invalidate(id, Invalid::STATE);
            }
            let pane = Rect {
                y: g.lane.y,
                height: g.lane.height,
                x: if self.nodes[&id].kind == Kind::Sidebar {
                    self.sidebar_viewport().x
                } else {
                    self.content_viewport().x
                },
                width: g.lane.x + g.lane.width
                    - if self.nodes[&id].kind == Kind::Sidebar {
                        self.sidebar_viewport().x
                    } else {
                        self.content_viewport().x
                    },
            };
            if contains(pane, p) {
                self.reveal_bar(id);
            }
        }
        Ok(false)
    }
    /// A press in window coordinates. True when it landed on a lane and is the bar's.
    pub fn scrollbar_press(&mut self, p: Point) -> Result<bool> {
        for id in self.bar_panes() {
            let Some(g) = self.bar_geometry(id) else {
                continue;
            };
            if !contains(g.lane, p) || self.bars.get(&id).is_none_or(|b| !b.shown()) {
                continue;
            }
            let (x, offset) = (self.nodes[&id].scroll.x, self.nodes[&id].scroll.y);
            let y = self.bars.entry(id).or_default().press(&g, p.y, offset);
            if y != offset {
                self.scroll_to(id, Point { x, y })?;
            }
            self.invalidate(id, Invalid::STATE);
            return Ok(true);
        }
        Ok(false)
    }
    /// A release: true when it ended a drag.
    pub fn scrollbar_release(&mut self) -> bool {
        let mut ended = None;
        for (&id, bar) in self.bars.iter_mut() {
            if bar.release() {
                ended = Some(id);
            }
        }
        if let Some(id) = ended {
            self.invalidate(id, Invalid::STATE);
        }
        ended.is_some()
    }
    pub fn scrollbar_leave(&mut self) {
        let left: Vec<_> = self
            .bars
            .iter_mut()
            .filter(|(_, b)| !b.dragging())
            .filter_map(|(id, b)| b.set_in_lane(false).then_some(*id))
            .collect();
        for id in left {
            self.invalidate(id, Invalid::STATE);
        }
    }
    pub fn scrollbar_dragging(&self) -> bool {
        self.bars.values().any(|b| b.dragging())
    }
    /// Advance the bars to `now`. True while any of them still moves or waits to hide, so
    /// the caller keeps ticking.
    pub fn tick_scrollbars(&mut self, now: Instant) -> bool {
        let Some(s) = self.scrollbar_style.clone() else {
            return false;
        };
        let mut busy = false;
        let mut changed = Vec::new();
        for (&id, bar) in self.bars.iter_mut() {
            let (moved, moving) = bar.tick(&s, now);
            if moved {
                changed.push(id);
            }
            busy |= moving;
        }
        for id in changed {
            self.invalidate(id, Invalid::STATE);
        }
        busy
    }
    /// Paint `id`'s bar; `origin` is the surface's position in window coordinates.
    pub(crate) fn paint_scrollbar(&self, id: NodeId, origin: Point, canvas: &mut Canvas) {
        if let (Some(s), Some(bar), Some(g)) = (
            self.scrollbar_style.as_ref(),
            self.bars.get(&id),
            self.bar_geometry(id),
        ) {
            bar.paint(s, &g, origin, canvas);
        }
    }
}
