//! Moving and resizing a window with the pointer — from the client's own header (xdg
//! `move`/`resize` requests) or from Super+drag. One grab for all four cases:
//!
//! - a floating window moves, or is resized from the edge or corner it was taken by;
//! - a tiled window follows the pointer and, dropped, takes the place of the window it lands
//!   on (on that window's workspace, whichever output it is on);
//! - resizing a tiled window moves the layout's split lines.

use smithay::{
    input::pointer::{
        AxisFrame, ButtonEvent, GestureHoldBeginEvent, GestureHoldEndEvent, GesturePinchBeginEvent,
        GesturePinchEndEvent, GesturePinchUpdateEvent, GestureSwipeBeginEvent, GestureSwipeEndEvent,
        GestureSwipeUpdateEvent, GrabStartData as PointerGrabStartData, MotionEvent, PointerGrab, PointerInnerHandle,
        RelativeMotionEvent,
    },
    reexports::{
        wayland_protocols::xdg::shell::server::xdg_toplevel,
        wayland_server::protocol::wl_surface::WlSurface,
    },
    utils::{Logical, Point, Rectangle, Size},
    wayland::{compositor::with_states, shell::xdg::SurfaceCachedState},
};

use super::{Fullscreen, Rect, WindowId, inset, layout::Edge};
use crate::state::Hyalo;

bitflags::bitflags! {
    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub struct ResizeEdge: u32 {
        const TOP    = 0b0001;
        const BOTTOM = 0b0010;
        const LEFT   = 0b0100;
        const RIGHT  = 0b1000;
    }
}

impl From<xdg_toplevel::ResizeEdge> for ResizeEdge {
    fn from(x: xdg_toplevel::ResizeEdge) -> Self {
        Self::from_bits_truncate(x as u32)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Move,
    Resize(ResizeEdge),
}

/// The grab in progress, where the commit path can see it.
#[derive(Debug, Clone, Copy)]
pub struct Active {
    pub id: WindowId,
    pub kind: Kind,
    /// The window's box when the grab began.
    pub initial: Rect,
    pub tiled: bool,
}

pub struct WindowGrab {
    start_data: PointerGrabStartData<Hyalo>,
    button: u32,
    last: Point<f64, Logical>,
}

impl Hyalo {
    /// Starts moving or resizing window `id`, held by `button`. Refused for a fullscreen or
    /// maximized window, whose box is not the user's to drag.
    pub fn start_window_grab(&mut self, id: WindowId, kind: Kind, start_data: PointerGrabStartData<Hyalo>, button: u32) {
        let Some(m) = self.wm.get(id) else { return };
        if m.fullscreen != Fullscreen::None || self.wm.grab.is_some() {
            return;
        }
        let tiled = !m.floating;
        let initial = m.rect;
        if let (Kind::Resize(_), Some(t)) = (kind, m.window.toplevel()) {
            t.with_pending_state(|s| s.states.set(xdg_toplevel::State::Resizing));
            t.send_pending_configure();
        }
        self.wm.grab = Some(Active { id, kind, initial, tiled });
        let last = start_data.location;
        let pointer = self.seat.get_pointer().unwrap();
        let serial = smithay::utils::SERIAL_COUNTER.next_serial();
        pointer.set_grab(self, WindowGrab { start_data, button, last }, serial, smithay::input::pointer::Focus::Clear);
    }

    /// The edges a Super+right-drag resizes: those of the window's quarter the pointer is in.
    pub fn edges_nearest(&self, id: WindowId, pos: Point<f64, Logical>) -> ResizeEdge {
        let Some(m) = self.wm.get(id) else { return ResizeEdge::BOTTOM | ResizeEdge::RIGHT };
        let c = m.rect.to_f64();
        let mut e = ResizeEdge::empty();
        e |= if pos.x < c.loc.x + c.size.w / 2.0 { ResizeEdge::LEFT } else { ResizeEdge::RIGHT };
        e |= if pos.y < c.loc.y + c.size.h / 2.0 { ResizeEdge::TOP } else { ResizeEdge::BOTTOM };
        e
    }

    fn grab_motion(&mut self, location: Point<f64, Logical>, last: Point<f64, Logical>, start: Point<f64, Logical>) {
        let Some(g) = self.wm.grab else { return };
        let Some(m) = self.wm.get(g.id) else { return };
        let window = m.window.clone();
        let delta = location - start;
        match (g.kind, g.tiled) {
            (Kind::Move, _) => {
                // The window follows the pointer; where it lands is decided on release.
                let loc = (g.initial.loc.to_f64() + delta).to_i32_round();
                self.space.map_element(window.clone(), loc, false);
                self.queue_redraw(None);
            }
            (Kind::Resize(edges), false) => {
                let (min, max) = size_limits(&window);
                let dx = delta.x.round() as i32;
                let dy = delta.y.round() as i32;
                let mut w = g.initial.size.w;
                let mut h = g.initial.size.h;
                if edges.contains(ResizeEdge::LEFT) {
                    w -= dx;
                } else if edges.contains(ResizeEdge::RIGHT) {
                    w += dx;
                }
                if edges.contains(ResizeEdge::TOP) {
                    h -= dy;
                } else if edges.contains(ResizeEdge::BOTTOM) {
                    h += dy;
                }
                let clampd = |v: i32, lo: i32, hi: i32| v.max(lo.max(1)).min(if hi > 0 { hi } else { i32::MAX });
                let size = Size::from((clampd(w, min.w, max.w), clampd(h, min.h, max.h)));
                if let Some(t) = window.toplevel() {
                    t.with_pending_state(|s| s.size = Some(size));
                    t.send_pending_configure();
                }
            }
            (Kind::Resize(edges), true) => {
                let step = location - last;
                let (dx, dy) = (step.x.round() as i32, step.y.round() as i32);
                let ws = m.workspace;
                let Some(output) = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)) else { return };
                let area = inset(self.work_area(&output), self.config.layout.gaps_out);
                let Some(w) = self.wm.workspaces.get_mut(&ws) else { return };
                let edge_x = if edges.contains(ResizeEdge::LEFT) { Some(Edge::Left) } else if edges.contains(ResizeEdge::RIGHT) { Some(Edge::Right) } else { None };
                let edge_y = if edges.contains(ResizeEdge::TOP) { Some(Edge::Top) } else if edges.contains(ResizeEdge::BOTTOM) { Some(Edge::Bottom) } else { None };
                if let (Some(e), true) = (edge_x, dx != 0) {
                    w.layout.resize_edge(g.id, e, dx, area);
                }
                if let (Some(e), true) = (edge_y, dy != 0) {
                    w.layout.resize_edge(g.id, e, dy, area);
                }
                self.arrange_workspace(ws);
                self.sync_space();
            }
        }
    }

    /// A commit during a floating resize: the box grows from the edge being dragged, so a
    /// window taken by its left or top edge keeps its right or bottom one still.
    pub fn grab_commit(&mut self, id: WindowId) {
        let Some(g) = self.wm.grab.filter(|g| g.id == id && !g.tiled) else { return };
        let Kind::Resize(edges) = g.kind else { return };
        let Some(m) = self.wm.get(id) else { return };
        let window = m.window.clone();
        let size = window.geometry().size;
        let mut loc = g.initial.loc;
        if edges.contains(ResizeEdge::LEFT) {
            loc.x = g.initial.loc.x + g.initial.size.w - size.w;
        }
        if edges.contains(ResizeEdge::TOP) {
            loc.y = g.initial.loc.y + g.initial.size.h - size.h;
        }
        let ws = m.workspace;
        let og = self.wm.workspaces.get(&ws).and_then(|w| self.output_named(&w.output)).and_then(|o| self.space.output_geometry(&o)).unwrap_or_default();
        let m = self.wm.get_mut(id).unwrap();
        m.rect = Rectangle::new(loc, size);
        m.float_rect = Some(Rectangle::new(loc - og.loc, size));
        self.space.map_element(window.clone(), loc, false);
    }

    /// The pointer let go: a moved window settles where it was dropped.
    fn grab_released(&mut self, location: Point<f64, Logical>, start: Point<f64, Logical>) {
        let Some(g) = self.wm.grab.take() else { return };
        let Some(m) = self.wm.get(g.id) else { return };
        let window = m.window.clone();
        let from_ws = m.workspace;
        if let (Kind::Resize(_), Some(t)) = (g.kind, window.toplevel()) {
            t.with_pending_state(|s| s.states.unset(xdg_toplevel::State::Resizing));
            t.send_pending_configure();
        }
        let target_output = self.space.output_under(location).next().cloned();
        match (g.kind, g.tiled) {
            (Kind::Move, false) => {
                let dropped = Rectangle::new((g.initial.loc.to_f64() + (location - start)).to_i32_round(), g.initial.size);
                // Onto another output: onto the workspace it shows there.
                if let Some(o) = target_output {
                    let to_ws = self.active_workspace(&o.name());
                    let og = self.space.output_geometry(&o).unwrap_or_default();
                    // Held inside, but only as far as its header: a window may hang off the
                    // sides and the bottom while dragged, never off the top of the area.
                    let area = self.floating_area(&o);
                    let bar = self.wm.get(g.id).map_or(0, |m| m.bar());
                    let mut r = dropped;
                    r.loc.y = r.loc.y.max(area.loc.y + bar);
                    if to_ws != from_ws {
                        self.move_to_workspace(g.id, to_ws, false);
                    }
                    if let Some(m) = self.wm.get_mut(g.id) {
                        m.float_rect = Some(Rectangle::new(r.loc - og.loc, r.size));
                    }
                    self.wm.dirty_windows = true;
                    self.arrange_workspace(to_ws);
                    self.focus_window(Some(g.id));
                }
            }
            (Kind::Move, true) => {
                // Dropped on a tiled window: it takes that window's place in ITS workspace.
                let target = self
                    .space
                    .elements()
                    .rev()
                    .filter(|w| **w != window)
                    .filter_map(|w| self.wm.by_window(w))
                    .find(|m| m.frame().to_f64().contains(location))
                    .filter(|t| !t.floating && t.fullscreen == Fullscreen::None)
                    .map(|t| (t.id, t.workspace));
                match target {
                    Some((tid, tws)) => {
                        if tws != from_ws {
                            if let Some(w) = self.wm.workspaces.get_mut(&from_ws) {
                                w.layout.remove(g.id);
                            }
                            if let Some(m) = self.wm.get_mut(g.id) {
                                m.workspace = tws;
                            }
                            self.wm.dirty_workspaces = true;
                        }
                        let output = self.wm.workspaces.get(&tws).and_then(|w| self.output_named(&w.output));
                        if let Some(o) = output {
                            let area = inset(self.work_area(&o), self.config.layout.gaps_out);
                            if let Some(w) = self.wm.workspaces.get_mut(&tws) {
                                if w.layout.contains(g.id) {
                                    w.layout.move_next_to(g.id, tid, area, location);
                                } else {
                                    w.layout.insert(g.id, area, Some(tid), Some(location));
                                }
                            }
                        }
                        self.wm.dirty_windows = true;
                        self.arrange_workspace(from_ws);
                        self.arrange_workspace(tws);
                    }
                    None => {
                        // Onto another output's empty space: to its workspace.
                        if let Some(o) = target_output {
                            let to_ws = self.active_workspace(&o.name());
                            if to_ws != from_ws {
                                self.move_to_workspace(g.id, to_ws, false);
                            }
                        }
                        self.arrange_workspace(from_ws);
                    }
                }
                self.focus_window(Some(g.id));
            }
            (Kind::Resize(_), _) => {
                self.wm.dirty_windows = true;
                self.arrange_workspace(from_ws);
                self.sync_space();
            }
        }
        self.prune_workspaces();
        self.sync_space();
    }
}

/// The client's minimum and maximum size (0 = none).
fn size_limits(window: &smithay::desktop::Window) -> (Size<i32, Logical>, Size<i32, Logical>) {
    let Some(t) = window.toplevel() else { return (Size::default(), Size::default()) };
    with_states(t.wl_surface(), |states| {
        let mut cached = states.cached_state.get::<SurfaceCachedState>();
        let s = cached.current();
        (s.min_size, s.max_size)
    })
}

impl PointerGrab<Hyalo> for WindowGrab {
    fn motion(
        &mut self,
        data: &mut Hyalo,
        handle: &mut PointerInnerHandle<'_, Hyalo>,
        _focus: Option<(WlSurface, Point<f64, Logical>)>,
        event: &MotionEvent,
    ) {
        // No client has the pointer while a window is carried.
        handle.motion(data, None, event);
        let last = self.last;
        self.last = event.location;
        data.grab_motion(event.location, last, self.start_data.location);
    }

    fn relative_motion(
        &mut self,
        data: &mut Hyalo,
        handle: &mut PointerInnerHandle<'_, Hyalo>,
        focus: Option<(WlSurface, Point<f64, Logical>)>,
        event: &RelativeMotionEvent,
    ) {
        handle.relative_motion(data, focus, event);
    }

    fn button(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>, event: &ButtonEvent) {
        handle.button(data, event);
        if !handle.current_pressed().contains(&self.button) {
            handle.unset_grab(self, data, event.serial, event.time, true);
        }
    }

    fn axis(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>, details: AxisFrame) {
        handle.axis(data, details)
    }

    fn frame(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>) {
        handle.frame(data);
    }

    fn gesture_swipe_begin(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>, event: &GestureSwipeBeginEvent) {
        handle.gesture_swipe_begin(data, event)
    }

    fn gesture_swipe_update(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>, event: &GestureSwipeUpdateEvent) {
        handle.gesture_swipe_update(data, event)
    }

    fn gesture_swipe_end(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>, event: &GestureSwipeEndEvent) {
        handle.gesture_swipe_end(data, event)
    }

    fn gesture_pinch_begin(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>, event: &GesturePinchBeginEvent) {
        handle.gesture_pinch_begin(data, event)
    }

    fn gesture_pinch_update(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>, event: &GesturePinchUpdateEvent) {
        handle.gesture_pinch_update(data, event)
    }

    fn gesture_pinch_end(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>, event: &GesturePinchEndEvent) {
        handle.gesture_pinch_end(data, event)
    }

    fn gesture_hold_begin(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>, event: &GestureHoldBeginEvent) {
        handle.gesture_hold_begin(data, event)
    }

    fn gesture_hold_end(&mut self, data: &mut Hyalo, handle: &mut PointerInnerHandle<'_, Hyalo>, event: &GestureHoldEndEvent) {
        handle.gesture_hold_end(data, event)
    }

    fn start_data(&self) -> &PointerGrabStartData<Hyalo> {
        &self.start_data
    }

    fn unset(&mut self, data: &mut Hyalo) {
        // Settled once the pointer is free again: this runs with the pointer locked, and
        // settling the window asks the seat for things (asking the pointer here deadlocked
        // the compositor — measured, Super+drag).
        let (location, start) = (self.last, self.start_data.location);
        data.loop_handle.insert_idle(move |state| state.grab_released(location, start));
    }
}
