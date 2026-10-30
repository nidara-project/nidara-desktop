// SPDX-License-Identifier: LGPL-3.0-or-later
//! A layer-shell root (the dock, the bar): placement changes reconfigure the SAME
//! wl_surface, so moving to another edge never recreates it (SHELL-SURFACES.md §1).
use crate::{Event, Result, Window, err};
use wayland_client::{Connection, Dispatch, QueueHandle, delegate_noop};
pub(crate) use wayland_protocols_wlr::layer_shell::v1::client::{
    zwlr_layer_shell_v1, zwlr_layer_surface_v1,
};

bitflags::bitflags! {
    #[derive(Clone, Copy, Debug, PartialEq, Eq)]
    pub struct Edges: u32 {
        const TOP = 1;
        const BOTTOM = 2;
        const LEFT = 4;
        const RIGHT = 8;
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LayerLevel {
    Background,
    Bottom,
    Top,
    Overlay,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyboardMode {
    None,
    OnDemand,
    Exclusive,
}
/// Everything here may change on the same surface with `set_layer_placement`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LayerPlacement {
    pub anchor: Edges,
    /// Logical size; 0 on an axis anchored to both of its sides means stretch.
    pub size: (u32, u32),
    pub exclusive_zone: i32,
    /// Top, right, bottom, left.
    pub margin: [i32; 4],
    pub keyboard: KeyboardMode,
}
/// The wl_registry global name of one output instance. It is the same on every
/// connection to the compositor and is never reused for a re-added output, so a
/// stale id can only fail (`OUTPUT_GONE`), never bind the newer output.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct OutputId(pub u32);
/// Namespace and output are fixed for the surface's lifetime (protocol).
#[derive(Clone, Copy, Debug)]
pub struct LayerSpec {
    pub namespace: &'static str,
    /// One output INSTANCE (see `OutputId`); None lets the compositor choose.
    pub output: Option<OutputId>,
    pub layer: LayerLevel,
    pub placement: LayerPlacement,
}

impl LayerPlacement {
    /// The protocol's own rule: a zero size needs both opposite anchors on that axis.
    pub(crate) fn validate(&self) -> Result<()> {
        let horizontal = self.anchor.contains(Edges::LEFT | Edges::RIGHT);
        let vertical = self.anchor.contains(Edges::TOP | Edges::BOTTOM);
        if self.size.0 == 0 && !horizontal {
            return Err("layer width 0 needs both left and right anchors".into());
        }
        if self.size.1 == 0 && !vertical {
            return Err("layer height 0 needs both top and bottom anchors".into());
        }
        if self.size.0 > 16384 || self.size.1 > 16384 {
            return Err("layer size exceeds 16384".into());
        }
        Ok(())
    }
    pub(crate) fn send(&self, s: &zwlr_layer_surface_v1::ZwlrLayerSurfaceV1) {
        use zwlr_layer_surface_v1::{Anchor, KeyboardInteractivity};
        s.set_anchor(Anchor::from_bits_truncate(self.anchor.bits()));
        s.set_size(self.size.0, self.size.1);
        s.set_exclusive_zone(self.exclusive_zone);
        let [top, right, bottom, left] = self.margin;
        s.set_margin(top, right, bottom, left);
        s.set_keyboard_interactivity(match self.keyboard {
            KeyboardMode::None => KeyboardInteractivity::None,
            KeyboardMode::OnDemand => KeyboardInteractivity::OnDemand,
            KeyboardMode::Exclusive => KeyboardInteractivity::Exclusive,
        });
    }
}
pub(crate) fn level(l: LayerLevel) -> zwlr_layer_shell_v1::Layer {
    use zwlr_layer_shell_v1::Layer;
    match l {
        LayerLevel::Background => Layer::Background,
        LayerLevel::Bottom => Layer::Bottom,
        LayerLevel::Top => Layer::Top,
        LayerLevel::Overlay => Layer::Overlay,
    }
}

impl Window {
    /// Move/resize this layer root in place: anchor, size, exclusive zone, margin and
    /// keyboard mode change on the same wl_surface. The new size arrives with the
    /// compositor's configure (`Event::Configure`); until then the old frame stays.
    pub fn set_layer_placement(&mut self, placement: LayerPlacement) -> Result<()> {
        placement.validate()?;
        let s = self
            .layer_surface
            .as_ref()
            .ok_or("layer placement requires a layer root")?;
        placement.send(s);
        self.surface.as_ref().ok_or("no root surface")?.commit();
        self.connection.flush().map_err(err)?;
        Ok(())
    }
    /// Change the stacking layer in place (zwlr_layer_surface_v1 v2).
    pub fn set_layer_level(&mut self, layer: LayerLevel) -> Result<()> {
        let s = self
            .layer_surface
            .as_ref()
            .ok_or("layer level requires a layer root")?;
        if wayland_client::Proxy::version(s) < 2 {
            return Err("compositor's layer shell cannot change layers in place".into());
        }
        s.set_layer(level(layer));
        self.surface.as_ref().ok_or("no root surface")?.commit();
        self.connection.flush().map_err(err)?;
        Ok(())
    }
    /// Logical input rectangles in root coordinates; None restores the whole surface.
    /// Applied with the next root commit, together with the frame it describes.
    pub fn set_input_region(&mut self, rects: Option<&[[i32; 4]]>) -> Result<()> {
        let surface = self.surface.as_ref().ok_or("no root surface")?;
        match rects {
            None => surface.set_input_region(None),
            Some(rects) => {
                if rects.len() > 256 {
                    return Err("input region has more than 256 rectangles".into());
                }
                let c = self.compositor.as_ref().ok_or("no compositor")?;
                let region = c.create_region(&self.qh, ());
                for [x, y, w, h] in rects {
                    if *w > 0 && *h > 0 {
                        region.add(*x, *y, *w, *h);
                    }
                }
                surface.set_input_region(Some(&region));
                region.destroy();
            }
        }
        self.dirty = true;
        Ok(())
    }
    pub fn is_layer(&self) -> bool {
        self.layer_surface.is_some()
    }
}

impl Dispatch<zwlr_layer_surface_v1::ZwlrLayerSurfaceV1, ()> for Window {
    fn event(
        w: &mut Self,
        s: &zwlr_layer_surface_v1::ZwlrLayerSurfaceV1,
        e: zwlr_layer_surface_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            zwlr_layer_surface_v1::Event::Configure {
                serial,
                width,
                height,
            } => {
                s.ack_configure(serial);
                if width > 0 {
                    w.width = width;
                }
                if height > 0 {
                    w.height = height;
                }
                w.configured = true;
                w.dirty = true;
                w.events.push(Event::Configure);
            }
            zwlr_layer_surface_v1::Event::Closed => {
                w.events.push(Event::Closed);
            }
            _ => {}
        }
    }
}
delegate_noop!(Window: ignore zwlr_layer_shell_v1::ZwlrLayerShellV1);
delegate_noop!(Window: ignore wayland_client::protocol::wl_region::WlRegion);

#[cfg(test)]
mod tests {
    use super::*;
    fn p(anchor: Edges, size: (u32, u32)) -> LayerPlacement {
        LayerPlacement {
            anchor,
            size,
            exclusive_zone: 0,
            margin: [0; 4],
            keyboard: KeyboardMode::None,
        }
    }
    #[test]
    fn zero_size_needs_both_anchors() {
        assert!(p(Edges::BOTTOM, (400, 80)).validate().is_ok());
        assert!(p(Edges::BOTTOM, (0, 80)).validate().is_err());
        assert!(
            p(Edges::BOTTOM | Edges::LEFT | Edges::RIGHT, (0, 80))
                .validate()
                .is_ok()
        );
        assert!(p(Edges::LEFT, (80, 0)).validate().is_err());
        assert!(
            p(Edges::LEFT | Edges::TOP | Edges::BOTTOM, (80, 0))
                .validate()
                .is_ok()
        );
        assert!(p(Edges::all(), (0, 0)).validate().is_ok());
        assert!(p(Edges::BOTTOM, (20000, 80)).validate().is_err());
    }
}
