// SPDX-License-Identifier: LGPL-3.0-or-later
//! Retained decoded image; file/worker lifetime is the application's responsibility.
use crate::*;
use nk_render::{Canvas, Color, ImageFit, Raster};
use std::sync::Arc;
#[derive(Clone, Copy, Debug)]
pub struct ImageStyle {
    pub fit: ImageFit,
    pub radius: f32,
    pub border_width: f32,
    pub border: Color,
    pub background: Color,
}
pub(crate) struct Image {
    pub(crate) size: Size,
    pub(crate) style: ImageStyle,
    pub(crate) pixels: Option<Arc<Raster>>,
}
pub(crate) fn validate(size: Size, style: ImageStyle) -> Result<()> {
    if ![size.width, size.height]
        .iter()
        .all(|v| v.is_finite() && *v > 0.)
        || ![style.radius, style.border_width]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.)
    {
        return Err("invalid retained image dimensions/style".into());
    }
    if ![style.border, style.background]
        .iter()
        .all(|c| c.components.iter().all(|v| v.is_finite()))
    {
        return Err("invalid retained image colour".into());
    }
    Ok(())
}
impl Tree {
    pub fn image(
        &mut self,
        parent: NodeId,
        name: &str,
        size: Size,
        style: ImageStyle,
    ) -> Result<NodeId> {
        validate(size, style)?;
        let id = self.append(parent, Kind::Image, name)?;
        self.images.insert(
            id,
            Image {
                size,
                style,
                pixels: None,
            },
        );
        Ok(id)
    }
    pub fn set_image(&mut self, id: NodeId, pixels: Option<Arc<Raster>>) -> Result<()> {
        let image = self.images.get_mut(&id).ok_or("not a retained Image")?;
        if match (&image.pixels, &pixels) {
            (None, None) => true,
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            _ => false,
        } {
            return Ok(());
        }
        image.pixels = pixels;
        self.invalidate(id, Invalid::PAINT);
        Ok(())
    }
    pub fn set_image_size(&mut self, id: NodeId, size: Size) -> Result<()> {
        let image = self.images.get_mut(&id).ok_or("not a retained Image")?;
        validate(size, image.style)?;
        if image.size != size {
            image.size = size;
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub fn set_image_style(&mut self, id: NodeId, style: ImageStyle) -> Result<()> {
        let image = self.images.get_mut(&id).ok_or("not a retained Image")?;
        validate(image.size, style)?;
        image.style = style;
        self.invalidate(id, Invalid::PAINT);
        Ok(())
    }
    pub(crate) fn measure_image(&mut self, id: NodeId, width: f32) -> Result<Size> {
        let image = self.images.get(&id).ok_or("Image size/style missing")?;
        let factor = (width / image.size.width).clamp(0., 1.);
        let size = Size {
            width: image.size.width * factor,
            height: image.size.height * factor,
        };
        self.nodes.get_mut(&id).unwrap().measured = size;
        Ok(size)
    }
    pub(crate) fn paint_image(
        &self,
        id: NodeId,
        r: Rect,
        canvas: &mut Canvas,
        clip: Rect,
    ) -> Result<()> {
        let image = self.images.get(&id).ok_or("Image size/style missing")?;
        let s = image.style;
        canvas.clip(clip);
        canvas.clip_rounded_rect(r, s.radius as f64);
        canvas.rect(r, s.background);
        if let Some(pixels) = &image.pixels {
            canvas.image(pixels, r, s.fit);
        }
        canvas.pop_clip();
        canvas.rounded_ring(r, s.radius as f64, s.border_width as f64, s.border);
        canvas.pop_clip();
        Ok(())
    }
}
