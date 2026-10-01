//! zwlr_virtual_pointer_v1: synthetic pointer input from a client — the Assistant's
//! computer use (`bin/nidara-input`, driven by `bin/nidara-click`), as on Hyprland.
//!
//! Every event goes through the same calls as a real mouse (`pointer_moved_to`,
//! `pointer_button`, the seat's axis), so focus, hit-testing, bindings and grabs treat it as
//! one. Absolute motion maps onto the pointer's output when the client named one, and onto
//! the whole layout (every output's box together) when it did not — wlroots' rule, which is
//! what `nidara-input` was written against.
//!
//! Gating is the caller's, not ours: `nidara-click` refuses unless Settings → AI allows
//! computer control, and Hyprland, too, lets any local client create a virtual pointer.

use std::sync::Mutex;

use smithay::{
    backend::input::{Axis, AxisSource, ButtonState, InputTime},
    input::pointer::AxisFrame,
    output::Output,
    reexports::{
        wayland_protocols_wlr::virtual_pointer::v1::server::{
            zwlr_virtual_pointer_manager_v1::{self, ZwlrVirtualPointerManagerV1},
            zwlr_virtual_pointer_v1::{self, ZwlrVirtualPointerV1},
        },
        wayland_server::{
            Client, DataInit, DisplayHandle, New, WEnum,
            protocol::wl_pointer,
        },
    },
    utils::{Logical, Point, Rectangle},
    wayland::{Dispatch2, GlobalDispatch2},
};

use crate::Hyalo;

pub struct VirtualPointerGlobal;

/// One virtual pointer: the output it maps onto, and the scroll being put together until the
/// client's `frame`.
pub struct VirtualPointer {
    output: Option<Output>,
    axis: Mutex<Option<AxisFrame>>,
}

pub fn init(dh: &DisplayHandle) {
    dh.create_global::<Hyalo, ZwlrVirtualPointerManagerV1, _>(2, VirtualPointerGlobal);
}

impl GlobalDispatch2<ZwlrVirtualPointerManagerV1, Hyalo> for VirtualPointerGlobal {
    fn bind(
        &self,
        _state: &mut Hyalo,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<ZwlrVirtualPointerManagerV1>,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        data_init.init(resource, VirtualPointerGlobal);
    }
}

impl Dispatch2<ZwlrVirtualPointerManagerV1, Hyalo> for VirtualPointerGlobal {
    fn request(
        &self,
        _state: &mut Hyalo,
        _client: &Client,
        _resource: &ZwlrVirtualPointerManagerV1,
        request: zwlr_virtual_pointer_manager_v1::Request,
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        use zwlr_virtual_pointer_manager_v1::Request;
        match request {
            Request::CreateVirtualPointer { id, .. } => {
                data_init.init(id, VirtualPointer { output: None, axis: Mutex::new(None) });
            }
            Request::CreateVirtualPointerWithOutput { output, id, .. } => {
                let output = output.as_ref().and_then(Output::from_resource);
                data_init.init(id, VirtualPointer { output, axis: Mutex::new(None) });
            }
            Request::Destroy => {}
            _ => {}
        }
    }
}

impl Dispatch2<ZwlrVirtualPointerV1, Hyalo> for VirtualPointer {
    fn request(
        &self,
        state: &mut Hyalo,
        _client: &Client,
        _resource: &ZwlrVirtualPointerV1,
        request: zwlr_virtual_pointer_v1::Request,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, Hyalo>,
    ) {
        use zwlr_virtual_pointer_v1::Request;
        let now = InputTime::now();
        match request {
            Request::Motion { dx, dy, .. } => {
                let at = state.seat.get_pointer().unwrap().current_location();
                state.pointer_moved_to(at + Point::from((dx, dy)), now);
            }
            Request::MotionAbsolute { x, y, x_extent, y_extent, .. } => {
                if x_extent == 0 || y_extent == 0 {
                    return;
                }
                let Some(area) = self.area(state) else { return };
                let fx = x as f64 / x_extent as f64;
                let fy = y as f64 / y_extent as f64;
                let pos = area.loc.to_f64() + Point::from((fx * area.size.w as f64, fy * area.size.h as f64));
                state.pointer_moved_to(pos, now);
            }
            Request::Button { button, state: s, .. } => {
                let s = match s {
                    WEnum::Value(wl_pointer::ButtonState::Pressed) => ButtonState::Pressed,
                    _ => ButtonState::Released,
                };
                state.pointer_button(button, s, now);
            }
            Request::Axis { axis, value, .. } => {
                let Some(axis) = axis_of(axis) else { return };
                self.with_frame(|f| f.value(axis, value));
            }
            Request::AxisSource { axis_source } => {
                let source = match axis_source {
                    WEnum::Value(wl_pointer::AxisSource::Finger) => AxisSource::Finger,
                    WEnum::Value(wl_pointer::AxisSource::Continuous) => AxisSource::Continuous,
                    WEnum::Value(wl_pointer::AxisSource::WheelTilt) => AxisSource::WheelTilt,
                    _ => AxisSource::Wheel,
                };
                self.with_frame(|f| f.source(source));
            }
            Request::AxisStop { axis, .. } => {
                let Some(axis) = axis_of(axis) else { return };
                self.with_frame(|f| f.stop(axis));
            }
            Request::AxisDiscrete { axis, value, discrete, .. } => {
                let Some(axis) = axis_of(axis) else { return };
                self.with_frame(|f| f.value(axis, value).v120(axis, discrete * 120));
            }
            Request::Frame => {
                let frame = self.axis.lock().unwrap().take();
                let pointer = state.seat.get_pointer().unwrap();
                if let Some(frame) = frame {
                    pointer.axis(state, frame);
                }
                pointer.frame(state);
            }
            Request::Destroy => {}
            _ => {}
        }
    }
}

impl VirtualPointer {
    /// What absolute coordinates span: the named output, or every output together.
    fn area(&self, state: &Hyalo) -> Option<Rectangle<i32, Logical>> {
        if let Some(o) = &self.output {
            return state.space.output_geometry(o);
        }
        state
            .space
            .outputs()
            .filter_map(|o| state.space.output_geometry(o))
            .reduce(|a, b| a.merge(b))
    }

    fn with_frame(&self, f: impl FnOnce(AxisFrame) -> AxisFrame) {
        let mut pending = self.axis.lock().unwrap();
        let frame = pending.take().unwrap_or_else(|| AxisFrame::new(InputTime::now()));
        *pending = Some(f(frame));
    }
}

fn axis_of(axis: WEnum<wl_pointer::Axis>) -> Option<Axis> {
    match axis {
        WEnum::Value(wl_pointer::Axis::VerticalScroll) => Some(Axis::Vertical),
        WEnum::Value(wl_pointer::Axis::HorizontalScroll) => Some(Axis::Horizontal),
        _ => None,
    }
}
