// SPDX-License-Identifier: LGPL-3.0-or-later
use std::{path::Path, sync::Arc};

const EMBEDDED_LIMIT: usize = 64 * 1024 * 1024;

/// Decode resized SVG or raster artwork found by `find_app_icon`, in straight RGBA.
/// Bound source dimensions and embedded SVG resources before decoding.
pub fn read_app_icon(path: &Path, side: u32) -> Option<(u32, u32, Vec<u8>)> {
    if path.metadata().ok()?.len() > 16 * 1024 * 1024 || side == 0 || side > 1024 {
        return None;
    }
    use std::io::Read;
    let mut bytes = Vec::new();
    std::fs::File::open(path)
        .ok()?
        .take(16 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 16 * 1024 * 1024 {
        return None;
    }
    let (w, h, rgba) = if path.extension().is_some_and(|e| e == "svg") {
        // Theme art is untrusted input too. SVG images cannot escape the source
        // or allocate an unbounded raster before our output-size check.
        use std::sync::atomic::{AtomicUsize, Ordering};
        let used = Arc::new(AtomicUsize::new(0));
        let rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (data_rejected, path_rejected) = (rejected.clone(), rejected.clone());
        let decode = resvg::usvg::ImageHrefResolver::default_data_resolver();
        let options = resvg::usvg::Options {
            image_href_resolver: resvg::usvg::ImageHrefResolver {
                resolve_string: Box::new(move |_, _| {
                    path_rejected.store(true, Ordering::Relaxed);
                    None
                }),
                resolve_data: Box::new(move |mime, data, options| {
                    let dimensions = image::ImageReader::new(std::io::Cursor::new(data.as_slice()))
                        .with_guessed_format()
                        .ok()
                        .and_then(|r| r.into_dimensions().ok());
                    let cost = dimensions
                        .filter(|(w, h)| {
                            *w <= 4096 && *h <= 4096 && u64::from(*w) * u64::from(*h) <= 16_000_000
                        })
                        .map(|(w, h)| w as usize * h as usize * 4);
                    if data.len() <= 16 * 1024 * 1024
                        && let Some(cost) = cost
                        && used.fetch_add(cost, Ordering::Relaxed).saturating_add(cost)
                            <= EMBEDDED_LIMIT
                    {
                        return decode(mime, data, options);
                    }
                    data_rejected.store(true, Ordering::Relaxed);
                    None
                }),
            },
            ..Default::default()
        };
        let tree = resvg::usvg::Tree::from_data(&bytes, &options).ok()?;
        if rejected.load(Ordering::Relaxed) {
            return None;
        }
        let size = tree.size();
        if size.width() * size.height() > 16_000_000. {
            return None;
        }
        let mut pix = resvg::tiny_skia::Pixmap::new(side, side)?;
        let scale = side as f32 / size.width().max(size.height());
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::from_scale(scale, scale).post_translate(
                (side as f32 - size.width() * scale) / 2.,
                (side as f32 - size.height() * scale) / 2.,
            ),
            &mut pix.as_mut(),
        );
        (
            side,
            side,
            pix.pixels()
                .iter()
                .flat_map(|p| {
                    let c = p.demultiply();
                    [c.red(), c.green(), c.blue(), c.alpha()]
                })
                .collect(),
        )
    } else {
        let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()
            .ok()?;
        let mut limits = image::Limits::default();
        limits.max_image_width = Some(4096);
        limits.max_image_height = Some(4096);
        limits.max_alloc = Some(64 * 1024 * 1024);
        reader.limits(limits);
        let img = reader.decode().ok()?;
        if u64::from(img.width()) * u64::from(img.height()) > 16_000_000 {
            return None;
        }
        let img = img.thumbnail(side, side).to_rgba8();
        (img.width(), img.height(), img.into_raw())
    };
    Some((w, h, rgba))
}
