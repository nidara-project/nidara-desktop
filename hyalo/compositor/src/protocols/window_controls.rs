//! nidara-window-controls-v1 (#708 point 5): a window's controls — close, minimize, maximize —
//! are Hyalo's. The app keeps its own header and says where in it they go (`set_position`,
//! double-buffered on wl_surface.commit, so they move with the buffer that leaves room for
//! them); Hyalo draws them there over the app's pixels (render/controls.rs) and takes their
//! clicks (input.rs). The side is the user's (`[windows.controls] side`), sent to the app as
//! `layout` with the box to reserve.
//!
//! - One capsule of three buttons, the owner's choice: the shape of the back/forward pair in
//!   Settings' header, not three coloured circles.
//! - Minimize is drawn disabled: what minimizing means here is #724.
//! - Maximize is disabled for a window that cannot change size (its minimum = its maximum).

use smithay::{
    desktop::Window,
    reexports::wayland_server::{
        Client, DataInit, DisplayHandle, New, Resource, Weak, protocol::wl_surface::WlSurface,
    },
    utils::{Logical, Point, Rectangle, Size},
    wayland::{
        Dispatch2, GlobalDispatch2,
        compositor::{Cacheable, with_states},
        shell::xdg::SurfaceCachedState,
    },
};

use crate::{
    Hyalo,
    config::ControlsSide,
    protocols::gen_window_controls::{
        nidara_window_controls_manager_v1::{self, NidaraWindowControlsManagerV1},
        nidara_window_controls_v1::{self, NidaraWindowControlsV1, Side},
    },
};

/// One button's box, logical px: the back/forward pair's (Settings' header).
pub const BUTTON_W: f64 = 34.0;
pub const BUTTON_H: f64 = 30.0;
/// The capsule: three buttons side by side.
pub const CAPSULE_W: f64 = BUTTON_W * 3.0;

fn capsule() -> Size<f64, Logical> {
    Size::from((CAPSULE_W, BUTTON_H))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Close,
    Minimize,
    Maximize,
}

impl Button {
    /// The shader's glyph for it (render/controls.rs).
    pub fn glyph(self) -> f32 {
        match self {
            Self::Minimize => 0.0,
            Self::Maximize => 1.0,
            Self::Close => 2.0,
        }
    }
}

/// The buttons from left to right: close last on the right, first on the left.
pub fn order(side: ControlsSide) -> [Button; 3] {
    match side {
        ControlsSide::Right => [Button::Minimize, Button::Maximize, Button::Close],
        ControlsSide::Left => [Button::Close, Button::Minimize, Button::Maximize],
    }
}

/// Whether a button does anything for `window`: minimize never yet (#724); maximize unless
/// the window cannot change size.
pub fn enabled(window: &Window, button: Button) -> bool {
    match button {
        Button::Close => true,
        Button::Minimize => false,
        Button::Maximize => window.toplevel().is_some_and(|t| {
            with_states(t.wl_surface(), |states| {
                let mut cached = states.cached_state.get::<SurfaceCachedState>();
                let s = cached.current();
                !(s.max_size.w > 0 && s.max_size.h > 0 && s.min_size == s.max_size)
            })
        }),
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct ControlsState {
    /// The reserved box's top-left corner, surface-local logical px; none = no controls.
    pub position: Option<Point<f64, Logical>>,
}

impl Cacheable for ControlsState {
    fn commit(&mut self, _dh: &DisplayHandle) -> Self {
        *self
    }
    fn merge_into(self, into: &mut Self, _dh: &DisplayHandle) {
        *into = self;
    }
}

/// Where the controls of the window with this main surface are, surface-local logical px.
pub fn rect(surface: &WlSurface) -> Option<Rectangle<f64, Logical>> {
    with_states(surface, |states| {
        if !states.cached_state.has::<ControlsState>() {
            return None;
        }
        let at = states.cached_state.get::<ControlsState>().current().position?;
        Some(Rectangle::new(at, capsule()))
    })
}

/// The window's controls box, surface-local logical px, if it has one.
pub fn window_rect(window: &Window) -> Option<Rectangle<f64, Logical>> {
    rect(window.toplevel()?.wl_surface())
}

/// The button at `local` (surface-local logical px), if the controls are there.
pub fn button_at(window: &Window, local: Point<f64, Logical>, side: ControlsSide) -> Option<Button> {
    let r = window_rect(window)?;
    if !r.contains(local) {
        return None;
    }
    let i = (((local.x - r.loc.x) / BUTTON_W).floor() as usize).min(2);
    Some(order(side)[i])
}

fn side_of(side: ControlsSide) -> Side {
    match side {
        ControlsSide::Right => Side::Right,
        ControlsSide::Left => Side::Left,
    }
}

fn send_layout(res: &NidaraWindowControlsV1, side: ControlsSide) {
    res.layout(side_of(side), CAPSULE_W, BUTTON_H);
}

/// After the side changed: every app lays its box out again.
pub fn send_layouts(state: &mut Hyalo) {
    let side = state.config.windows.controls.side;
    state.window_controls.retain(|r| r.is_alive());
    for r in &state.window_controls {
        send_layout(r, side);
    }
}

pub struct ControlsGlobal;
pub struct ControlsData(Weak<WlSurface>);

pub fn init(dh: &DisplayHandle) {
    dh.create_global::<Hyalo, NidaraWindowControlsManagerV1, _>(1, ControlsGlobal);
}

impl GlobalDispatch2<NidaraWindowControlsManagerV1, Hyalo> for ControlsGlobal {
    fn bind(
        &self,
        _state: &mut Hyalo,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<NidaraWindowControlsManagerV1>,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        data_init.init(resource, ControlsGlobal);
    }

    /// Not for a sandboxed client (sandbox.rs), like the glass: our apps' protocol.
    fn can_view(&self, client: &Client) -> bool {
        crate::sandbox::unrestricted(client)
    }
}

impl Dispatch2<NidaraWindowControlsManagerV1, Hyalo> for ControlsGlobal {
    fn request(
        &self,
        state: &mut Hyalo,
        _client: &Client,
        _resource: &NidaraWindowControlsManagerV1,
        request: nidara_window_controls_manager_v1::Request,
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        if let nidara_window_controls_manager_v1::Request::GetWindowControls { id, surface } = request {
            let res = data_init.init(id, ControlsData(surface.downgrade()));
            send_layout(&res, state.config.windows.controls.side);
            state.window_controls.retain(|r| r.is_alive());
            state.window_controls.push(res);
        }
    }
}

impl ControlsData {
    fn pending(&self, f: impl FnOnce(&mut ControlsState)) {
        if let Ok(surface) = self.0.upgrade() {
            with_states(&surface, |states| f(states.cached_state.get::<ControlsState>().pending()));
        }
    }
}

impl Dispatch2<NidaraWindowControlsV1, Hyalo> for ControlsData {
    fn request(
        &self,
        _state: &mut Hyalo,
        _client: &Client,
        _resource: &NidaraWindowControlsV1,
        request: nidara_window_controls_v1::Request,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, Hyalo>,
    ) {
        use nidara_window_controls_v1::Request;
        match request {
            Request::SetPosition { x, y } => self.pending(|c| c.position = Some(Point::from((x, y)))),
            Request::UnsetPosition | Request::Destroy => self.pending(|c| c.position = None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_is_last_on_the_right_and_first_on_the_left() {
        assert_eq!(order(ControlsSide::Right)[2], Button::Close);
        assert_eq!(order(ControlsSide::Left)[0], Button::Close);
        assert_eq!(CAPSULE_W, 102.0);
    }
}
