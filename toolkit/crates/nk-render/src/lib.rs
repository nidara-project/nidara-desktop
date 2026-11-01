// SPDX-License-Identifier: LGPL-3.0-or-later
//! CPU painting only. Layout, glyph IDs, face index and normalized coordinates
//! come unchanged from nk-text; this crate never shapes or discovers fonts.
use nk_text::{GlyphRun, Layout, Rect};
use std::sync::Arc;
use vello_cpu::{
    Glyph, Pixmap, RenderContext, Resources,
    color::AlphaColor,
    color::Srgb,
    kurbo::{Affine, BezPath, Cap, Join, Rect as BoxRect, RoundedRect, Shape, Stroke},
    peniko::{Blob, Fill, FontData},
};

pub type Color = AlphaColor<Srgb>;
pub fn rgba(r: u8, g: u8, b: u8, a: u8) -> Color {
    Color::from_rgba8(r, g, b, a)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageFit {
    Contain,
    Cover,
}
#[derive(Debug)]
pub struct Raster {
    pixels: Arc<Pixmap>,
    width: u16,
    height: u16,
}
impl Raster {
    pub fn from_rgba(width: u16, height: u16, pixels: Vec<u8>) -> Result<Self, String> {
        if width == 0 || height == 0 || pixels.len() != usize::from(width) * usize::from(height) * 4
        {
            return Err("invalid RGBA image dimensions/buffer".into());
        }
        let pixels = pixels.into_boxed_slice().into_vec();
        Ok(Self {
            pixels: Arc::new(Pixmap::from_parts(
                pixels,
                width,
                height,
                vello_cpu::PixelMetadata::new(vello_cpu::peniko::ImageAlphaType::Alpha, true),
            )),
            width,
            height,
        })
    }
    pub fn size(&self) -> (u16, u16) {
        (self.width, self.height)
    }
    /// Overwrites the pixels with zeros before they are freed, for a picture that must
    /// not linger in memory (a window's content). False when another holder still shares
    /// them: they are freed when the last one lets go, unwiped.
    pub fn wipe(self) -> bool {
        match Arc::try_unwrap(self.pixels) {
            Ok(mut pixmap) => {
                pixmap.data_as_u8_slice_mut().fill(0);
                true
            }
            Err(_) => false,
        }
    }
}
pub struct Canvas {
    context: RenderContext,
    resources: Resources,
    scale: f64,
}
impl Canvas {
    pub fn new(width: u16, height: u16, scale: f64) -> Self {
        let mut context = RenderContext::new(width, height);
        context.set_transform(Affine::scale(scale));
        Self {
            context,
            resources: Resources::new(),
            scale,
        }
    }
    pub fn image(&mut self, image: &Raster, bounds: Rect, fit: ImageFit) {
        if bounds.width <= 0. || bounds.height <= 0. {
            return;
        }
        let sx = bounds.width as f64 / f64::from(image.width);
        let sy = bounds.height as f64 / f64::from(image.height);
        let scale = match fit {
            ImageFit::Contain => sx.min(sy),
            ImageFit::Cover => sx.max(sy),
        };
        let x = bounds.x as f64 + (bounds.width as f64 - f64::from(image.width) * scale) / 2.;
        let y = bounds.y as f64 + (bounds.height as f64 - f64::from(image.height) * scale) / 2.;
        self.clip(bounds);
        self.context.set_paint(vello_cpu::Image {
            image: vello_cpu::ImageSource::Pixmap(image.pixels.clone()),
            sampler: vello_cpu::peniko::ImageSampler::default(),
        });
        self.context
            .set_paint_transform(Affine::translate((x, y)) * Affine::scale(scale));
        self.context.fill_rect(&BoxRect::new(
            x,
            y,
            x + f64::from(image.width) * scale,
            y + f64::from(image.height) * scale,
        ));
        self.context.reset_paint_transform();
        self.pop_clip();
    }
    pub fn rect(&mut self, r: Rect, color: Color) {
        self.context.set_paint(color);
        self.context.fill_rect(&rect(r));
    }
    pub fn rounded_rect(&mut self, r: Rect, radius: f64, color: Color) {
        self.context.set_paint(color);
        self.context
            .fill_path(&RoundedRect::from_rect(rect(r), radius).to_path(0.1));
    }
    /// An inward stroke follows the element silhouette without changing hit geometry.
    pub fn rounded_ring(&mut self, r: Rect, radius: f64, width: f64, color: Color) {
        if width <= 0. {
            return;
        }
        let inset = width.min(r.width.min(r.height) as f64) / 2.;
        let bounds = rect(r).inset(-inset);
        self.context.set_stroke(Stroke::new(width));
        self.context.set_paint(color);
        self.context
            .stroke_path(&RoundedRect::from_rect(bounds, (radius - inset).max(0.)).to_path(0.1));
    }
    pub fn clip(&mut self, r: Rect) {
        self.context.push_clip_rect(&rect(r));
    }
    pub fn clip_rounded_rect(&mut self, r: Rect, radius: f64) {
        self.context
            .push_clip_path(&RoundedRect::from_rect(rect(r), radius).to_path(0.1));
    }
    pub fn pop_clip(&mut self) {
        self.context.pop_clip();
    }
    /// Horizontal separator thickness is specified in physical pixels.
    pub fn horizontal_rule(&mut self, mut r: Rect, pixels: f64, color: Color) {
        r.y = ((r.y as f64 * self.scale).round() / self.scale) as f32;
        r.height = (pixels / self.scale) as f32;
        self.rect(r, color);
    }
    /// Device pixels per logical pixel.
    pub fn scale(&self) -> f64 {
        self.scale
    }
    /// Vertical separator thickness is specified in physical pixels.
    pub fn vertical_rule(&mut self, mut r: Rect, pixels: f64, color: Color) {
        r.x = ((r.x as f64 * self.scale).round() / self.scale) as f32;
        r.width = (pixels / self.scale) as f32;
        self.rect(r, color);
    }
    /// A round dot about `diameter` across, rounded to whole physical pixels on the device
    /// grid nearest `center`, so its edge is the same on every side (a dot between pixels
    /// comes out blurred and uneven).
    pub fn dot(&mut self, center: (f64, f64), diameter: f64, color: Color) {
        let r = snapped_dot(center, diameter, self.scale);
        self.rounded_rect(r, f64::from(r.width) / 2., color);
    }
    pub fn caret(&mut self, mut r: Rect, color: Color) {
        // Exactly one physical pixel at every fractional scale.
        r.x = ((r.x as f64 * self.scale).round() / self.scale) as f32;
        r.width = (1.0 / self.scale) as f32;
        self.rect(r, color);
    }
    pub fn selection(&mut self, rects: &[Rect], origin: (f32, f32), color: Color) {
        for r in rects {
            self.rect(offset(*r, origin), color);
        }
    }
    pub fn layout(
        &mut self,
        layout: &Layout,
        origin: (f32, f32),
        color: Color,
    ) -> Result<(), String> {
        for run in layout.glyph_runs() {
            self.glyph_run(run, origin, color)?;
        }
        Ok(())
    }
    pub fn glyph_run(
        &mut self,
        run: &GlyphRun,
        origin: (f32, f32),
        color: Color,
    ) -> Result<(), String> {
        let font = FontData::new(Blob::new(Arc::new(run.font.data.clone())), run.font.index);
        let coords: Vec<_> = run.font.variations.iter().map(|v| v.normalized).collect();
        self.context.set_paint(color);
        self.context
            .glyph_run(&mut self.resources, &font)
            .font_size(run.size)
            .glyph_transform(Affine::skew(-run.skew_degrees.to_radians() as f64, 0.))
            .normalized_coords(&coords)
            .fill_glyphs(run.glyphs.iter().map(|&(id, x, y)| Glyph {
                id,
                x: x + origin.0,
                y: y + origin.1,
            }))
            .map_err(|e| format!("glyph rasterization: {e:?}"))
    }
    /// A symbolic icon in one ink, its own units fitted into `r` (nk-icons: vector shapes,
    /// sharp at any scale). Painted opaque into a layer that takes the ink's alpha, as GTK
    /// composites a symbolic icon: where two strokes cross, a half-transparent ink is not laid
    /// twice. Each shape's own opacity still multiplies inside the layer.
    pub fn icon(&mut self, icon: &nk_icons::Icon, r: Rect, color: Color) {
        let (w, h) = icon.size;
        if w <= 0. || h <= 0. {
            return;
        }
        let alpha = color.components[3];
        let color = color.with_alpha(1.);
        self.context.push_opacity_layer(alpha);
        let fit = Affine::scale(self.scale)
            * Affine::translate((r.x as f64, r.y as f64))
            * Affine::scale_non_uniform((r.width / w) as f64, (r.height / h) as f64);
        self.context.set_transform(fit);
        for shape in &icon.shapes {
            let path = bez(&shape.segments);
            let fill = |c: &mut Self| {
                if let Some(f) = shape.fill {
                    c.context.set_fill_rule(if f.even_odd {
                        Fill::EvenOdd
                    } else {
                        Fill::NonZero
                    });
                    c.context.set_paint(color.multiply_alpha(f.opacity));
                    c.context.fill_path(&path);
                }
            };
            let stroke = |c: &mut Self| {
                if let Some(k) = shape.stroke {
                    let mut s = Stroke::new(k.width as f64).with_caps(match k.cap {
                        nk_icons::Cap::Butt => Cap::Butt,
                        nk_icons::Cap::Round => Cap::Round,
                        nk_icons::Cap::Square => Cap::Square,
                    });
                    s = s.with_join(match k.join {
                        nk_icons::Join::Miter => Join::Miter,
                        nk_icons::Join::Round => Join::Round,
                        nk_icons::Join::Bevel => Join::Bevel,
                    });
                    s.miter_limit = k.miter_limit as f64;
                    c.context.set_stroke(s);
                    c.context.set_paint(color.multiply_alpha(k.opacity));
                    c.context.stroke_path(&path);
                }
            };
            if shape.stroke_first {
                stroke(self);
                fill(self);
            } else {
                fill(self);
                stroke(self);
            }
        }
        self.context.set_fill_rule(Fill::NonZero);
        self.context.set_transform(Affine::scale(self.scale));
        self.context.pop_layer();
    }
    /// Native-endian wl_shm ARGB8888: premultiplied, sRGB encoded.
    pub fn finish(mut self) -> Vec<u8> {
        let mut target = Pixmap::new(self.context.width(), self.context.height());
        self.context.flush();
        self.context.render(&mut target, &mut self.resources);
        target
            .data()
            .iter()
            .flat_map(|p| u32::from_be_bytes([p.a, p.r, p.g, p.b]).to_ne_bytes())
            .collect()
    }
}
fn bez(segments: &[nk_icons::Segment]) -> BezPath {
    use nk_icons::Segment as S;
    let p = |p: nk_icons::Point| (p.x as f64, p.y as f64);
    let mut path = BezPath::new();
    for s in segments {
        match *s {
            S::Move(a) => path.move_to(p(a)),
            S::Line(a) => path.line_to(p(a)),
            S::Quad(a, b) => path.quad_to(p(a), p(b)),
            S::Cubic(a, b, c) => path.curve_to(p(a), p(b), p(c)),
            S::Close => path.close_path(),
        }
    }
    path
}
fn rect(r: Rect) -> BoxRect {
    BoxRect::new(
        r.x as f64,
        r.y as f64,
        (r.x + r.width) as f64,
        (r.y + r.height) as f64,
    )
}
/// A whole number of physical pixels across, its corner on a physical pixel.
pub fn snapped_dot(center: (f64, f64), diameter: f64, scale: f64) -> Rect {
    let d = (diameter * scale).round().max(1.);
    let corner = |v: f64| (v * scale - d / 2.).round() / scale;
    Rect {
        x: corner(center.0) as f32,
        y: corner(center.1) as f32,
        width: (d / scale) as f32,
        height: (d / scale) as f32,
    }
}
pub fn offset(mut r: Rect, origin: (f32, f32)) -> Rect {
    r.x += origin.0;
    r.y += origin.1;
    r
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn dots_land_on_whole_physical_pixels() {
        for scale in [1., 1.25, 1.5, 2.] {
            for center in [(46., 85.), (46.3, 84.9), (10.5, 10.5)] {
                let r = snapped_dot(center, 5., scale);
                for v in [r.x, r.y, r.width, r.height] {
                    let px = f64::from(v) * scale;
                    assert!((px - px.round()).abs() < 1e-4, "{scale} {center:?} {r:?}");
                }
                let mid = f64::from(r.x) + f64::from(r.width) / 2.;
                assert!(
                    (mid - center.0).abs() <= 0.5 / scale + 1e-4,
                    "stays put: {mid}"
                );
            }
        }
    }
    #[test]
    fn alpha_and_caret_are_physical_pixels() {
        let mut c = Canvas::new(16, 16, 1.25);
        c.rect(
            Rect {
                x: 0.,
                y: 0.,
                width: 4.,
                height: 4.,
            },
            rgba(255, 0, 0, 128),
        );
        c.caret(
            Rect {
                x: 8.,
                y: 0.,
                width: 20.,
                height: 8.,
            },
            rgba(255, 255, 255, 255),
        );
        let p = c.finish();
        let pixel = |x: usize, y: usize| {
            u32::from_ne_bytes(
                p[(y * 16 + x) * 4..(y * 16 + x + 1) * 4]
                    .try_into()
                    .unwrap(),
            )
        };
        assert_eq!(pixel(1, 1), 0x80800000);
        assert_eq!(pixel(10, 1), 0xffffffff);
        assert_eq!(pixel(11, 1), 0);
    }
    #[test]
    fn corpus_runs_paint_including_bitmap_color_emoji() {
        use nk_text::{FontSet, ParleyBackend, TextBackend, corpus};
        let fonts = Arc::new(FontSet::discover_required().expect("install corpus fonts"));
        let mut backend = ParleyBackend::new(fonts.clone()).unwrap();
        for case in corpus::cases().unwrap() {
            let layout = backend
                .layout(&case.text, &corpus::style(&case, &fonts), case.widths[0])
                .unwrap();
            let mut c = Canvas::new(1000, 1000, 1.);
            c.layout(&layout, (8., 8.), rgba(255, 255, 255, 255))
                .unwrap();
            let p = c.finish();
            if !case.text.trim().is_empty() {
                assert!(
                    p.as_chunks::<4>()
                        .0
                        .iter()
                        .any(|b| u32::from_ne_bytes(*b) != 0),
                    "{} is blank",
                    case.id
                );
            }
            // The font's family pictogram can be monochrome. Rainbow/flags
            // specifically prove that bitmap strikes retain their colours.
            if case.id == "zwj-rainbow" || case.id == "flags" {
                assert!(
                    p.as_chunks::<4>().0.iter().any(|b| {
                        let v = u32::from_ne_bytes(*b);
                        let r = (v >> 16) & 255;
                        let g = (v >> 8) & 255;
                        let b = v & 255;
                        r.abs_diff(g) > 30 || g.abs_diff(b) > 30
                    }),
                    "{} lost color emoji",
                    case.id
                );
            }
        }
    }
}

mod window_glyph;
pub use window_glyph::{WindowGlyph, WindowGlyphStyle};
