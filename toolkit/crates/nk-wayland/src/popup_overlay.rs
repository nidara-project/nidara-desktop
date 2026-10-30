// SPDX-License-Identifier: LGPL-3.0-or-later
//! Nonmodal xdg popup on the parent's event queue; parent editor/IME stays live.
use super::*;
use std::sync::atomic::{AtomicU64, Ordering};
static NEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PopupId(u64);
#[derive(Clone, Debug)]
pub enum PopupEvent {
    Configure,
    Done,
    FrameDone,
    Repositioned(u32),
    Key(Key),
    Input(LayerEvent),
}
pub(super) struct Overlay {
    pub id: PopupId,
    pub modal: bool,
    pub parent: Option<PopupId>,
    pub side: PopupSide,
    pub surface: wl_surface::WlSurface,
    xdg: xdg_surface::XdgSurface,
    popup: xdg_popup::XdgPopup,
    viewport: Option<wp_viewport::WpViewport>,
    fractional: Option<wp_fractional_scale_v1::WpFractionalScaleV1>,
    material: Option<nidara_material_v1::NidaraMaterialV1>,
    pub buffers: Vec<Buffer>,
    geometry: popup::Geometry,
    scale: u32,
    pending: bool,
}
impl Overlay {
    fn destroy(self) {
        if let Some(m) = self.material {
            m.destroy();
        }
        if let Some(f) = self.fractional {
            f.destroy();
        }
        if let Some(v) = self.viewport {
            v.destroy();
        }
        self.popup.destroy();
        self.xdg.destroy();
        self.surface.destroy();
        for b in self.buffers {
            b.proxy.destroy();
        }
    }
}
impl Window {
    pub fn open_popup_overlay(&mut self, placement: PopupPlacement) -> Result<PopupId> {
        if !self.overlay.is_empty() {
            return Err("a popup is already open".into());
        }
        self.open_overlay(placement, PopupSide::Below, None, None, false)
    }
    pub fn open_menu_popup(&mut self, options: MenuPopupPlacement) -> Result<PopupId> {
        let placement = options.constrained()?;
        if self.overlay.len() >= 16 {
            return Err("popup depth limit".into());
        }
        if self.overlay.iter().any(|p| !p.modal) {
            return Err("nonmodal popup is open".into());
        }
        if options.parent != self.overlay.last().map(|p| p.id) {
            return Err("menu parent must be the active popup".into());
        }
        self.open_overlay(
            placement,
            options.side,
            options.parent,
            options.grab_serial,
            true,
        )
    }
    fn open_overlay(
        &mut self,
        placement: PopupPlacement,
        side: PopupSide,
        parent_id: Option<PopupId>,
        grab: Option<u32>,
        modal: bool,
    ) -> Result<PopupId> {
        placement.validate()?;
        // A layer root has no xdg_surface: its first-level popup is created without
        // a parent and attached with zwlr_layer_surface_v1.get_popup before its
        // initial commit (SHELL-SURFACES.md §3). Deeper levels keep the xdg chain.
        let parent = if let Some(id) = parent_id {
            Some(
                &self
                    .overlay
                    .iter()
                    .find(|p| p.id == id)
                    .ok_or("stale popup parent")?
                    .xdg,
            )
        } else if self.layer_surface.is_some() {
            None
        } else {
            Some(self.xdg.as_ref().ok_or("popup parent has no xdg surface")?)
        };
        let shell = self.wm.as_ref().ok_or("xdg shell missing")?;
        let compositor = self.compositor.as_ref().ok_or("compositor missing")?;

        let id = PopupId(NEXT.fetch_add(1, Ordering::Relaxed));
        let surface = compositor.create_surface(&self.qh, id);
        let xdg = shell.get_xdg_surface(&surface, &self.qh, id);
        let positioner = shell.create_positioner(&self.qh, ());
        placement.apply_side(&positioner, side)?;
        let popup = xdg.get_popup(parent, &positioner, &self.qh, id);
        if parent.is_none()
            && let Some(layer) = &self.layer_surface
        {
            layer.get_popup(&popup);
        }
        positioner.destroy();
        if let Some(serial) = grab {
            popup.grab(
                self.seat.as_ref().ok_or("popup grab requires a seat")?,
                serial,
            );
        }
        let viewport = self
            .viewporter
            .as_ref()
            .map(|v| v.get_viewport(&surface, &self.qh, ()));
        let fractional = self
            .fractional_manager
            .as_ref()
            .filter(|_| viewport.is_some())
            .map(|m| m.get_fractional_scale(&surface, &self.qh, id));
        let material = self
            .materials
            .as_ref()
            .filter(|_| self.capabilities.material)
            .map(|m| m.get_material(&surface, &self.qh, ()));
        surface.commit();
        self.overlay.push(Overlay {
            id,
            modal,
            parent: parent_id,
            side,
            surface,
            xdg,
            popup,
            viewport,
            fractional,
            material,
            buffers: vec![],
            geometry: Default::default(),
            scale: self.scale,
            pending: false,
        });
        Ok(id)
    }
    pub fn reposition_popup_overlay(
        &mut self,
        id: PopupId,
        placement: PopupPlacement,
        token: u32,
    ) -> Result<()> {
        placement.validate()?;
        let p = self
            .overlay
            .iter()
            .find(|p| p.id == id)
            .ok_or("stale popup")?;
        if p.popup.version() < 3 {
            return Err("nonmodal popup reposition requires xdg-shell v3".into());
        }
        let positioner = self
            .wm
            .as_ref()
            .ok_or("xdg shell missing")?
            .create_positioner(&self.qh, ());
        placement.apply_side(&positioner, p.side)?;
        p.popup.reposition(&positioner, token);
        positioner.destroy();
        Ok(())
    }
    pub fn close_popup_overlay(&mut self) {
        if let Some(id) = self.overlay.first().map(|p| p.id) {
            self.close_menu_popup(id);
        }
    }
    /// Retire a popup and descendants, topmost first. Suggestions uses the same
    /// primitive but never applies modal keyboard/pointer dismissal barriers.
    pub fn close_menu_popup(&mut self, id: PopupId) {
        let Some(at) = self.overlay.iter().position(|p| p.id == id) else {
            return;
        };
        let modal = self.overlay[at].modal;
        for p in self.overlay.drain(at..).rev() {
            p.destroy();
        }
        self.pointer_popup = self
            .pointer_popup
            .filter(|id| self.overlay.iter().any(|p| p.id == *id));
        if modal {
            self.keyboard.reset();
            self.ignore_input_before = Some(self.serial);
            self.block_popup_release = true;
            self.block_popup_repeat = true;
        }
    }
    pub fn active_menu_popup(&self) -> Option<PopupId> {
        self.overlay.last().filter(|p| p.modal).map(|p| p.id)
    }
    /// Actual configured origin in root window-geometry coordinates, through all parents.
    pub fn menu_popup_origin(&self, id: PopupId) -> Option<(i32, i32)> {
        let mut id = Some(id);
        let mut point = (0i32, 0i32);
        while let Some(current) = id {
            let p = self.overlay.iter().find(|p| p.id == current)?;
            let [x, y, _, _] = p.geometry.current?;
            point = (point.0.checked_add(x)?, point.1.checked_add(y)?);
            id = p.parent;
        }
        Some(point)
    }
    pub fn popup_overlay_geometry(&self, id: PopupId) -> Option<[i32; 4]> {
        self.overlay.iter().find(|p| p.id == id)?.geometry.current
    }
    pub fn popup_overlay_frame(&self, id: PopupId) -> Result<Option<Frame>> {
        let p = self
            .overlay
            .iter()
            .find(|p| p.id == id)
            .ok_or("stale popup")?;
        let Some([_, _, w, h]) = p.geometry.current else {
            return Ok(None);
        };
        if p.pending {
            return Ok(None);
        }
        let mut frame = layers::frame((w as u32, h as u32), p.scale)?;
        frame.material = p.material.is_some();
        Ok(Some(frame))
    }
    /// Present only after the compositor has configured this popup. Busy buffers are
    /// released by the same queue as the parent; unavailable slots retry after release.
    pub fn paint_popup_overlay(
        &mut self,
        id: PopupId,
        frame: Frame,
        bytes: &[u8],
        material: Option<&Material>,
    ) -> Result<bool> {
        let actual = self
            .popup_overlay_frame(id)?
            .ok_or("popup frame unavailable")?;
        if actual.width != frame.width
            || actual.height != frame.height
            || actual.pixel_width != frame.pixel_width
            || actual.pixel_height != frame.pixel_height
            || actual.scale != frame.scale
        {
            return Err("stale popup frame".into());
        }
        if bytes.len() != usize::from(frame.pixel_width) * usize::from(frame.pixel_height) * 4 {
            return Err("popup buffer length".into());
        }
        let p = self.overlay.iter_mut().find(|p| p.id == id).unwrap();
        p.buffers.retain(|b| {
            let keep = b.busy || (b.width == frame.pixel_width && b.height == frame.pixel_height);
            if !keep {
                b.proxy.destroy();
            }
            keep
        });
        let slot = p.buffers.iter().position(|b| !b.busy);
        let slot = match slot {
            Some(i) => i,
            None if p.buffers.len() < 2 => {
                let buffer = self.new_buffer(frame)?;
                let p = self.overlay.iter_mut().find(|p| p.id == id).unwrap();
                p.buffers.push(buffer);
                p.buffers.len() - 1
            }
            None => return Ok(false),
        };
        let p = self.overlay.iter_mut().find(|p| p.id == id).unwrap();
        let b = &mut p.buffers[slot];
        b.map.copy_from_slice(bytes);
        b.busy = true;
        if let Some(v) = &p.viewport {
            v.set_destination(frame.width as i32, frame.height as i32);
            p.surface.set_buffer_scale(1);
        } else {
            p.surface.set_buffer_scale(frame.scale as i32);
        }
        if let Some(m) = &p.material {
            send_material(m, material);
        }
        p.surface.attach(Some(&b.proxy), 0, 0);
        p.surface
            .damage_buffer(0, 0, frame.pixel_width as i32, frame.pixel_height as i32);
        p.surface.frame(&self.qh, id);
        p.pending = true;
        p.surface.commit();
        self.connection.flush().map_err(err)?;
        Ok(true)
    }
}
impl Dispatch<xdg_surface::XdgSurface, PopupId> for Window {
    fn event(
        w: &mut Self,
        p: &xdg_surface::XdgSurface,
        e: xdg_surface::Event,
        id: &PopupId,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_surface::Event::Configure { serial } = e {
            p.ack_configure(serial);
            if let Some(o) = w.overlay.iter_mut().find(|o| o.id == *id) {
                o.geometry.commit();
                w.events.push(Event::PopupOverlay {
                    id: *id,
                    event: PopupEvent::Configure,
                });
            }
        }
    }
}
impl Dispatch<xdg_popup::XdgPopup, PopupId> for Window {
    fn event(
        w: &mut Self,
        _: &xdg_popup::XdgPopup,
        e: xdg_popup::Event,
        id: &PopupId,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let Some(o) = w.overlay.iter_mut().find(|o| o.id == *id) {
            match e {
                xdg_popup::Event::Configure {
                    x,
                    y,
                    width,
                    height,
                } => {
                    if let Err(error) = o.geometry.stage(x, y, width, height) {
                        w.events.push(Event::Error(error));
                    }
                }
                xdg_popup::Event::Repositioned { token } => w.events.push(Event::PopupOverlay {
                    id: *id,
                    event: PopupEvent::Repositioned(token),
                }),
                xdg_popup::Event::PopupDone => w.events.push(Event::PopupOverlay {
                    id: *id,
                    event: PopupEvent::Done,
                }),
                _ => {}
            }
        }
    }
}
impl Dispatch<wl_surface::WlSurface, PopupId> for Window {
    fn event(
        w: &mut Self,
        _: &wl_surface::WlSurface,
        event: wl_surface::Event,
        id: &PopupId,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_surface::Event::PreferredBufferScale { factor } = event
            && let Some(p) = w
                .overlay
                .iter_mut()
                .find(|p| p.id == *id && p.fractional.is_none())
        {
            if factor <= 0 || factor > 8 {
                w.events.push(Event::Error("invalid popup scale".into()));
                return;
            }
            p.scale = factor as u32 * 120;
            w.events.push(Event::PopupOverlay {
                id: *id,
                event: PopupEvent::Configure,
            });
        }
    }
}
impl Dispatch<wp_fractional_scale_v1::WpFractionalScaleV1, PopupId> for Window {
    fn event(
        w: &mut Self,
        _: &wp_fractional_scale_v1::WpFractionalScaleV1,
        e: wp_fractional_scale_v1::Event,
        id: &PopupId,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wp_fractional_scale_v1::Event::PreferredScale { scale } = e
            && let Some(o) = w.overlay.iter_mut().find(|o| o.id == *id)
        {
            if scale == 0 {
                w.events.push(Event::Error("zero popup scale".into()));
                return;
            }
            o.scale = scale;
            w.events.push(Event::PopupOverlay {
                id: *id,
                event: PopupEvent::Configure,
            });
        }
    }
}
impl Dispatch<wl_callback::WlCallback, PopupId> for Window {
    fn event(
        w: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        id: &PopupId,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let Some(o) = w.overlay.iter_mut().find(|o| o.id == *id) {
            o.pending = false;
            w.events.push(Event::PopupOverlay {
                id: *id,
                event: PopupEvent::FrameDone,
            });
        }
    }
}
