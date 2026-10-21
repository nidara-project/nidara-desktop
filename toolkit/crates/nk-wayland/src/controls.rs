// SPDX-License-Identifier: LGPL-3.0-or-later
//! Existing server controls protocol, opt-in per toplevel; no geometry or palette defaults.
use super::*;
pub(super) use crate::protocol::controls::{
    nidara_window_controls_manager_v1, nidara_window_controls_v1,
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ControlsSide {
    Left,
    Right,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ControlsLayout {
    pub side: ControlsSide,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Copy, Debug)]
pub enum WindowAction {
    Close,
    Minimize,
    ToggleMaximize,
}
#[derive(Default)]
pub(super) struct Controls {
    pub manager: Option<nidara_window_controls_manager_v1::NidaraWindowControlsManagerV1>,
    proxy: Option<nidara_window_controls_v1::NidaraWindowControlsV1>,
    layout: Option<ControlsLayout>,
    sent: Option<(f64, f64, bool)>,
}
impl Window {
    /// Opt in after a toplevel exists. Layout arrives asynchronously on this event queue.
    pub fn request_window_controls(&mut self) -> bool {
        let Some(manager) = &self.controls.manager else {
            return false;
        };
        if self.controls.proxy.is_none() {
            let Some(surface) = &self.surface else {
                return false;
            };
            self.controls.proxy = Some(manager.get_window_controls(surface, &self.qh, ()));
            self.redraw();
        }
        true
    }
    pub fn window_controls_layout(&self) -> Option<ControlsLayout> {
        self.controls.layout
    }
    /// Position is root-surface local and lands with the next painted root commit.
    pub fn place_window_controls(&mut self, x: f64, y: f64, dark_ink: bool) -> Result<()> {
        if ![x, y]
            .iter()
            .all(|v| v.is_finite() && *v >= -8_388_608. && *v <= 8_388_607.996_093_75)
        {
            return Err("invalid window control position".into());
        }
        let Some(proxy) = &self.controls.proxy else {
            return Ok(());
        };
        if self.controls.sent != Some((x, y, dark_ink)) {
            proxy.set_position(x, y);
            proxy.set_ink(if dark_ink {
                nidara_window_controls_v1::Ink::Dark
            } else {
                nidara_window_controls_v1::Ink::Light
            });
            self.controls.sent = Some((x, y, dark_ink));
            self.redraw();
        }
        Ok(())
    }
    /// Used by client fallback buttons, through the same action as pointer/AT-SPI activation.
    pub fn window_action(&mut self, action: WindowAction) {
        match action {
            WindowAction::Close => self.close(),
            WindowAction::Minimize => {
                if let Some(top) = &self.toplevel {
                    top.set_minimized();
                }
            }
            WindowAction::ToggleMaximize => {
                if let Some(top) = &self.toplevel {
                    if self.maximized {
                        top.unset_maximized();
                    } else {
                        top.set_maximized();
                    }
                }
            }
        }
    }
}
impl Dispatch<nidara_window_controls_v1::NidaraWindowControlsV1, ()> for Window {
    fn event(
        w: &mut Self,
        _: &nidara_window_controls_v1::NidaraWindowControlsV1,
        event: nidara_window_controls_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let nidara_window_controls_v1::Event::Layout {
            side,
            width,
            height,
        } = event;
        {
            let side = match side {
                WEnum::Value(nidara_window_controls_v1::Side::Left) => ControlsSide::Left,
                WEnum::Value(nidara_window_controls_v1::Side::Right) => ControlsSide::Right,
                _ => {
                    w.events.push(Event::Error("unknown controls side".into()));
                    return;
                }
            };
            if !width.is_finite() || !height.is_finite() || width <= 0. || height <= 0. {
                w.events
                    .push(Event::Error("invalid server control layout".into()));
                return;
            }
            let layout = ControlsLayout {
                side,
                width,
                height,
            };
            if w.controls.layout != Some(layout) {
                w.controls.layout = Some(layout);
                w.events.push(Event::ControlsLayout(layout));
                w.redraw();
            }
        }
    }
}
delegate_noop!(Window: ignore nidara_window_controls_manager_v1::NidaraWindowControlsManagerV1);
