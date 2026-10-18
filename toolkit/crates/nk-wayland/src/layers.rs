// SPDX-License-Identifier: LGPL-3.0-or-later
//! Synchronized subsurfaces; Hyalo owns their presented transforms.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};

pub const MAX_LAYERS: usize = 64;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// Stable for the lifetime of a layer; IDs are never reused, including across windows.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LayerId(u64);
#[derive(Clone, Copy, Debug)]
pub enum Property {
    Position,
    Scale,
    Opacity,
}
impl Property {
    fn wire(self) -> nidara_layer_v1::Property {
        match self {
            Self::Position => nidara_layer_v1::Property::Position,
            Self::Scale => nidara_layer_v1::Property::Scale,
            Self::Opacity => nidara_layer_v1::Property::Opacity,
        }
    }
}
/// Transport values only: the app supplies every parameter, including the serial.
#[derive(Clone, Copy, Debug)]
pub enum Curve {
    Spring {
        mass: f64,
        stiffness: f64,
        damping: f64,
        initial_velocity: f64,
    },
    Bezier {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
        duration_ms: u32,
    },
}
#[derive(Clone, Debug)]
pub enum LayerEvent {
    Motion(f64, f64),
    Leave,
    Button {
        button: u32,
        pressed: bool,
        x: f64,
        y: f64,
    },
    Scroll(f64),
    Done {
        serial: u32,
        seconds: u64,
        nanoseconds: u32,
    },
    /// The XML carries no presentation timestamp for cancellation.
    Cancelled {
        serial: u32,
    },
}
pub(super) struct Layer {
    pub id: LayerId,
    pub surface: wl_surface::WlSurface,
    subsurface: wl_subsurface::WlSubsurface,
    proxy: nidara_layer_v1::NidaraLayerV1,
    viewport: wp_viewport::WpViewport,
    material: nidara_material_v1::NidaraMaterialV1,
    pub buffers: Vec<Buffer>,
    attached: Option<wl_buffer::WlBuffer>,
    size: (u32, u32),
    pub pending: bool,
}
impl Layer {
    pub fn destroy(self) {
        self.proxy.destroy();
        self.material.destroy();
        self.viewport.destroy();
        self.subsurface.destroy();
        self.surface.destroy();
        for b in self.buffers {
            b.proxy.destroy();
        }
    }
}
fn frame(size: (u32, u32), scale: u32) -> Result<Frame> {
    let (width, height) = size;
    let scale = f64::from(scale) / 120.;
    let pw = (f64::from(width) * scale).ceil();
    let ph = (f64::from(height) * scale).ceil();
    if width == 0 || height == 0 || pw > 8192. || ph > 8192. || pw * ph > 32_000_000. {
        return Err("layer size exceeds buffer limits (or is empty)".into());
    }
    Ok(Frame {
        width,
        height,
        pixel_width: pw as u16,
        pixel_height: ph as u16,
        scale,
        material: true,
    })
}
// Wayland fixed is signed 24.8. Reject overflow rather than silently wrapping.
fn fixed(values: &[f64]) -> Result<()> {
    if values
        .iter()
        .all(|v| v.is_finite() && *v >= -8_388_608. && *v <= 8_388_607.996_093_75)
    {
        Ok(())
    } else {
        Err("value is not representable as Wayland fixed".into())
    }
}
impl Window {
    pub fn supports_layers(&self) -> bool {
        self.layers_manager.is_some()
            && self.subcompositor.is_some()
            && self.viewporter.is_some()
            && self.materials.is_some()
    }
    /// Create an empty synchronized child. Paint its content before the parent commit.
    /// The 65th layer is refused before sending any request.
    pub fn create_layer(&mut self, size: (u32, u32)) -> Result<LayerId> {
        if self.layers.len() >= MAX_LAYERS {
            return Err("at most 64 layers per window".into());
        }
        frame(size, self.scale)?;
        let manager = self
            .layers_manager
            .as_ref()
            .ok_or("missing nidara-layers-v1")?;
        let sub = self
            .subcompositor
            .as_ref()
            .ok_or("missing wl_subcompositor")?;
        let id = LayerId(NEXT_ID.fetch_add(1, Ordering::Relaxed));
        let surface = self
            .compositor
            .as_ref()
            .unwrap()
            .create_surface(&self.qh, ());
        let subsurface = sub.get_subsurface(&surface, self.surface.as_ref().unwrap(), &self.qh, ());
        subsurface.set_sync();
        let proxy = manager.get_layer(&surface, &self.qh, id);
        let viewport = self
            .viewporter
            .as_ref()
            .ok_or("missing wp_viewporter")?
            .get_viewport(&surface, &self.qh, ());
        let material = self
            .materials
            .as_ref()
            .ok_or("missing nidara-material-v1")?
            .get_material(&surface, &self.qh, ());
        self.layers.push(Layer {
            id,
            surface,
            subsurface,
            proxy,
            viewport,
            material,
            buffers: Vec::new(),
            attached: None,
            size,
            pending: true,
        });
        Ok(id)
    }
    fn layer(&mut self, id: LayerId) -> Result<&mut Layer> {
        self.layers
            .iter_mut()
            .find(|l| l.id == id)
            .ok_or_else(|| "unknown layer (or belongs to another window)".into())
    }
    pub fn destroy_layer(&mut self, id: LayerId) -> Result<()> {
        let index = self
            .layers
            .iter()
            .position(|l| l.id == id)
            .ok_or("unknown layer")?;
        if self.input_layer == Some(id) {
            self.set_text_input(TextInput::default());
        }
        self.layers.remove(index).destroy();
        if self.pointer_layer == Some(id) {
            self.pointer_layer = None;
            self.pointer_inside = false;
        }
        Ok(())
    }
    pub fn set_layer_size(&mut self, id: LayerId, size: (u32, u32)) -> Result<()> {
        frame(size, self.scale)?;
        self.layer(id)?.size = size;
        Ok(())
    }
    /// A layer paints only when the app asks (content/size/output scale changed).
    /// False means both buffers are in use; retry after dispatching buffer releases.
    pub fn paint_layer(
        &mut self,
        id: LayerId,
        paint: impl FnOnce(Frame) -> Result<Vec<u8>>,
    ) -> Result<bool> {
        let size = self.layer(id)?.size;
        let frame = frame(size, self.scale)?;
        let l = self.layer(id)?;
        l.buffers.retain(|b| {
            let keep = b.busy || (b.width == frame.pixel_width && b.height == frame.pixel_height);
            if !keep {
                b.proxy.destroy();
            }
            keep
        });
        let slot = if let Some(i) = l.buffers.iter().position(|b| !b.busy) {
            i
        } else if l.buffers.len() < 2 {
            let buffer = self.new_buffer(frame)?;
            let l = self.layer(id)?;
            l.buffers.push(buffer);
            l.buffers.len() - 1
        } else {
            return Ok(false);
        };
        let bytes = paint(frame)?;
        let l = self.layer(id)?;
        let b = &mut l.buffers[slot];
        if bytes.len() != b.map.len() {
            return Err("layer renderer returned the wrong buffer length".into());
        }
        b.map.copy_from_slice(&bytes);
        // Before commit the buffer is only pending on this client. Several
        // invalidations can replace it; no release is sent for an attachment
        // that was superseded before its first commit.
        l.attached = Some(b.proxy.clone());
        l.viewport
            .set_destination(frame.width as i32, frame.height as i32);
        l.surface.set_buffer_scale(1);
        l.surface.attach(Some(&b.proxy), 0, 0);
        l.surface.damage_buffer(
            0,
            0,
            i32::from(frame.pixel_width),
            i32::from(frame.pixel_height),
        );
        l.pending = true;
        Ok(true)
    }
    pub fn set_position(&mut self, id: LayerId, x: f64, y: f64) -> Result<()> {
        fixed(&[x, y])?;
        let l = self.layer(id)?;
        l.proxy.set_position(x, y);
        l.pending = true;
        Ok(())
    }
    pub fn set_scale(&mut self, id: LayerId, scale: f64, anchor: (f64, f64)) -> Result<()> {
        fixed(&[scale, anchor.0, anchor.1])?;
        if scale < 0. {
            return Err("scale must not be negative".into());
        }
        let l = self.layer(id)?;
        l.proxy.set_scale(scale, anchor.0, anchor.1);
        l.pending = true;
        Ok(())
    }
    pub fn set_opacity(&mut self, id: LayerId, opacity: f64) -> Result<()> {
        if !(0. ..=1.).contains(&opacity) {
            return Err("opacity must be in 0..1".into());
        }
        let l = self.layer(id)?;
        l.proxy.set_opacity(opacity);
        l.pending = true;
        Ok(())
    }
    pub fn set_transition(
        &mut self,
        id: LayerId,
        property: Property,
        serial: u32,
        curve: Curve,
    ) -> Result<()> {
        match curve {
            Curve::Spring {
                mass,
                stiffness,
                damping,
                initial_velocity,
            } => {
                fixed(&[mass, stiffness, damping, initial_velocity])?;
                if [mass, stiffness, damping].iter().any(|v| *v < 1. / 256.) {
                    return Err(
                        "spring mass, stiffness and damping must stay positive on the wire".into(),
                    );
                }
                self.layer(id)?.proxy.set_spring_transition(
                    property.wire(),
                    serial,
                    mass,
                    stiffness,
                    damping,
                    initial_velocity,
                );
            }
            Curve::Bezier {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
            } => {
                fixed(&[x1, y1, x2, y2])?;
                if !(0. ..=1.).contains(&x1) || !(0. ..=1.).contains(&x2) {
                    return Err("Bezier x values must be in 0..1".into());
                }
                self.layer(id)?.proxy.set_curve_transition(
                    property.wire(),
                    serial,
                    x1,
                    y1,
                    x2,
                    y2,
                    duration_ms,
                );
            }
        }
        self.layer(id)?.pending = true;
        Ok(())
    }
    /// Focus/edit state stays on the root; rect is LOCAL to this layer.
    /// Only the private cursor association receives these local coordinates.
    /// It lands with the next parent commit and Hyalo maps it every frame.
    pub fn set_layer_text_input(&mut self, id: LayerId, input: TextInput) -> Result<()> {
        let proxy = self.layer(id)?.proxy.clone();
        if !input.focused {
            self.set_text_input(input);
            return Ok(());
        }
        let [x, y, width, height] = input.rect;
        if width <= 0 || height <= 0 {
            return Err("layer cursor needs positive width/height".into());
        }
        if self.input_layer != Some(id) || self.input.rect != input.rect {
            self.layers_manager
                .as_ref()
                .unwrap()
                .set_text_input_cursor_rectangle(
                    self.surface.as_ref().unwrap(),
                    Some(&proxy),
                    x,
                    y,
                    width,
                    height,
                );
            self.cursor_pending = true;
        }
        self.input_layer = Some(id);
        self.input = input;
        self.sync_ime();
        Ok(())
    }
    pub(super) fn clear_layer_cursor(&mut self) {
        if self.input_layer.take().is_some() {
            self.layers_manager
                .as_ref()
                .unwrap()
                .set_text_input_cursor_rectangle(self.surface.as_ref().unwrap(), None, 0, 0, 0, 0);
            self.cursor_pending = true;
            // Switching coordinate spaces must send fresh standard state even
            // if the same numerical rectangle occurs in both fields.
            self.sent_input = None;
        }
    }
    pub fn set_layer_material(&mut self, id: LayerId, material: Option<&Material>) -> Result<()> {
        let l = self.layer(id)?;
        super::send_material(&l.material, material);
        l.pending = true;
        Ok(())
    }
    pub(super) fn stage_layers(&mut self) {
        self.cursor_pending = false;
        for l in &mut self.layers {
            if l.pending {
                if let Some(attached) = l.attached.take()
                    && let Some(b) = l.buffers.iter_mut().find(|b| b.proxy == attached)
                {
                    b.busy = true;
                }
                l.surface.commit();
                l.pending = false;
            }
        }
    }
    /// Commit state/content of every dirty child with ONE parent commit, without
    /// repainting the parent. For parent pixel changes use redraw(), which stages
    /// the layers with those new pixels. Flushes before returning (safe to block).
    pub fn commit(&mut self) -> Result<()> {
        if self.dirty {
            return Err(
                "parent pixels are dirty; let redraw finish before committing layers".into(),
            );
        }
        self.stage_layers();
        self.surface.as_ref().unwrap().commit();
        self.connection.flush().map_err(err)
    }
    /// Fault injection used only by phase0's negative control: deliberately omit
    /// the parent commit, leaving all changes in the synchronized child cache.
    #[doc(hidden)]
    pub fn control_commit_children_only(&mut self) -> Result<()> {
        self.stage_layers();
        self.connection.flush().map_err(err)
    }
}
impl Dispatch<nidara_layer_v1::NidaraLayerV1, LayerId> for Window {
    fn event(
        w: &mut Self,
        _: &nidara_layer_v1::NidaraLayerV1,
        e: nidara_layer_v1::Event,
        id: &LayerId,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // Destruction may leave events already queued; never resurrect that ID.
        if !w.layers.iter().any(|l| l.id == *id) {
            return;
        }
        let event = match e {
            nidara_layer_v1::Event::Done {
                serial,
                tv_sec_hi,
                tv_sec_lo,
                tv_nsec,
            } => LayerEvent::Done {
                serial,
                seconds: (u64::from(tv_sec_hi) << 32) | u64::from(tv_sec_lo),
                nanoseconds: tv_nsec,
            },
            nidara_layer_v1::Event::Cancelled { serial } => LayerEvent::Cancelled { serial },
        };
        w.events.push(Event::Layer { id: *id, event });
    }
}
delegate_noop!(Window: ignore wl_subcompositor::WlSubcompositor);
delegate_noop!(Window: ignore wl_subsurface::WlSubsurface);
delegate_noop!(Window: ignore nidara_layers_manager_v1::NidaraLayersManagerV1);
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wire_values_and_fractional_buffers_are_checked_before_requests() {
        assert!(fixed(&[f64::NAN]).is_err());
        assert!(fixed(&[8_388_608.]).is_err());
        assert!(frame((0, 60), 120).is_err());
        assert!(frame((8192, 8192), 120).is_err());
        let f = frame((81, 61), 150).unwrap();
        assert_eq!((f.pixel_width, f.pixel_height), (102, 77));
        assert_eq!(f.scale, 1.25);
    }
}
