//! The pointer's image when no client draws it: the xcursor theme, by shape name
//! (cursor-shape-v1 — GTK4 asks for shapes by name rather than attaching its own surface).

use std::{cell::RefCell, collections::HashMap, io::Read};

use smithay::{
    backend::{allocator::Fourcc, renderer::element::memory::MemoryRenderBuffer},
    input::pointer::CursorIcon,
    utils::{Physical, Point, Transform},
};
use xcursor::{
    CursorTheme,
    parser::{Image, parse_xcursor},
};

pub struct Cursors {
    theme: CursorTheme,
    size: u32,
    loaded: RefCell<HashMap<CursorIcon, Option<Vec<Image>>>>,
    buffers: RefCell<HashMap<(CursorIcon, u32, usize), CursorImage>>,
}

/// A themed cursor image and its hotspot, in buffer pixels.
pub type CursorImage = (MemoryRenderBuffer, Point<i32, Physical>);

impl Cursors {
    pub fn load(theme: &str, size: u32) -> Self {
        Self {
            theme: CursorTheme::load(theme),
            size,
            loaded: Default::default(),
            buffers: Default::default(),
        }
    }

    fn images(&self, icon: CursorIcon) -> Option<Vec<Image>> {
        self.loaded
            .borrow_mut()
            .entry(icon)
            .or_insert_with(|| {
                std::iter::once(icon.name())
                    .chain(icon.alt_names().iter().copied())
                    .find_map(|name| {
                        let path = self.theme.load_icon(name)?;
                        let mut data = Vec::new();
                        std::fs::File::open(path).ok()?.read_to_end(&mut data).ok()?;
                        parse_xcursor(&data)
                    })
            })
            .clone()
    }

    /// The image for `icon` at an output scale, animated by `millis`. Falls back to the
    /// default arrow, and to a plain square when the theme has nothing at all.
    pub fn image(&self, icon: CursorIcon, scale: f64, millis: u32) -> CursorImage {
        let images = self
            .images(icon)
            .or_else(|| self.images(CursorIcon::Default))
            .unwrap_or_else(|| vec![fallback()]);
        let want = (self.size as f64 * scale).round() as u32;
        let nearest = images
            .iter()
            .min_by_key(|i| (i.size as i32 - want as i32).abs())
            .map(|i| i.size)
            .unwrap_or(0);
        let frames: Vec<&Image> = images.iter().filter(|i| i.size == nearest).collect();
        let total: u32 = frames.iter().map(|i| i.delay).sum();
        let mut t = if total == 0 { 0 } else { millis % total };
        let mut index = 0;
        for (k, f) in frames.iter().enumerate() {
            if t < f.delay {
                index = k;
                break;
            }
            t -= f.delay;
        }
        let key = (icon, nearest, index);
        if let Some(b) = self.buffers.borrow().get(&key) {
            return b.clone();
        }
        let img = frames[index];
        // `pixels_rgba` is the file's byte order: little-endian ARGB32, i.e. DRM's Argb8888.
        let buffer = MemoryRenderBuffer::from_slice(
            &img.pixels_rgba,
            Fourcc::Argb8888,
            (img.width as i32, img.height as i32),
            1,
            Transform::Normal,
            None,
        );
        let image = (buffer, (img.xhot as i32, img.yhot as i32).into());
        self.buffers.borrow_mut().insert(key, image.clone());
        image
    }
}

fn fallback() -> Image {
    // A 16×16 white square with a dark edge: something to point with, never meant to be seen.
    let mut px = vec![0u8; 16 * 16 * 4];
    for y in 0..16 {
        for x in 0..16 {
            let edge = x == 0 || y == 0 || x == 15 || y == 15;
            let v = if edge { 30 } else { 240 };
            let i = (y * 16 + x) * 4;
            px[i..i + 4].copy_from_slice(&[v, v, v, 255]);
        }
    }
    Image { size: 16, width: 16, height: 16, xhot: 0, yhot: 0, delay: 0, pixels_rgba: px, pixels_argb: vec![] }
}
