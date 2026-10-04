//! A picture of one output, as a PNG — what `nidara-hyalo msg screenshot` asks for, and what
//! CI's headless boot uploads for a person to look at (the same role grim has in the
//! Hyprland smoke; Hyalo does not speak a capture protocol yet, #683).
//!
//! The scene is drawn again, whole, into a texture of our own, in the output's upright
//! orientation and at its scale — the same elements the screen shows, glass included — and
//! read back.

use std::path::Path;

use smithay::{
    backend::{
        allocator::{Fourcc, dmabuf::Dmabuf},
        renderer::{
            Bind, Blit, ExportMem, Offscreen, TextureFilter, Texture as _, TextureMapping as _,
            damage::OutputDamageTracker,
            gles::{GlesRenderer, GlesTexture},
        },
    },
    output::Output,
    utils::{Physical, Rectangle, Size, Transform},
};

use crate::render;

pub fn capture(
    renderer: &mut GlesRenderer,
    scene: &render::Scene<'_>,
    output: &Output,
    cursor: Option<&crate::cursor::CursorImage>,
) -> Result<(u32, u32, Vec<u8>), String> {
    let geo = scene.space.output_geometry(output).ok_or("output not mapped")?;
    let scale = output.current_scale().fractional_scale();
    let size = geo.size.to_f64().to_physical_precise_round(scale);
    let mut texture: GlesTexture = renderer
        .create_buffer(Fourcc::Abgr8888, (size.w, size.h).into())
        .map_err(|e| e.to_string())?;
    let elements = render::output_elements(scene, renderer, output, cursor);
    let mut tracker = OutputDamageTracker::new(size, scale, Transform::Normal);
    {
        let mut fb = renderer.bind(&mut texture).map_err(|e| e.to_string())?;
        tracker
            .render_output(renderer, &mut fb, 0, &elements, render::CLEAR_COLOR)
            .map_err(|e| format!("{e:?}"))?;
    }
    let fb = renderer.bind(&mut texture).map_err(|e| e.to_string())?;
    let mapping = renderer
        .copy_framebuffer(&fb, Rectangle::from_size((size.w, size.h).into()), Fourcc::Abgr8888)
        .map_err(|e| e.to_string())?;
    drop(fb);
    // `flipped()` is relative to GL's lower-left origin: a mapping that is NOT flipped holds
    // the bottom row first, so it is the unflipped one that gets reversed (measured: the
    // other way round wrote every screenshot upside down).
    let bottom_first = !mapping.flipped();
    let (w, h) = (mapping.width(), mapping.height());
    let data = renderer.map_texture(&mapping).map_err(|e| e.to_string())?;
    let stride = w as usize * 4;
    let mut rgba = Vec::with_capacity(stride * h as usize);
    for row in 0..h as usize {
        let r = if bottom_first { h as usize - 1 - row } else { row };
        rgba.extend_from_slice(&data[r * stride..(r + 1) * stride]);
    }
    Ok((w, h, rgba))
}

/// `area` of one output (physical, upright; the whole output if None) drawn straight into a
/// client's dmabuf of `size`, in the OUTPUT's orientation — what a recorder on the GPU asks
/// screencopy for (screencopy.rs): no read-back, the frame never touches the CPU.
///
/// A region is drawn as the whole output and copied out on the GPU (`blit`), never by drawing
/// the scene shifted: the windows' corners (render/window.rs) and the glass place themselves in
/// OUTPUT pixels, so a shifted scene cut every window away — a region recorded on the GPU was
/// black from #722 until 2026-10-04 (measured nested: the build before #722 recorded it).
pub fn draw_into(
    renderer: &mut GlesRenderer,
    scene: &render::Scene<'_>,
    output: &Output,
    area: Option<Rectangle<i32, Physical>>,
    size: Size<i32, Physical>,
    dmabuf: &mut Dmabuf,
    cursor: Option<&crate::cursor::CursorImage>,
) -> Result<(), String> {
    let scale = output.current_scale().fractional_scale();
    let transform = output.current_transform();
    let elements = render::output_elements(scene, renderer, output, cursor);
    let Some(area) = area else {
        let mut tracker = OutputDamageTracker::new(size, scale, transform);
        let mut fb = renderer.bind(dmabuf).map_err(|e| e.to_string())?;
        let result = tracker
            .render_output(renderer, &mut fb, 0, &elements, render::CLEAR_COLOR)
            .map_err(|e| format!("{e:?}"))?;
        // The client reads the buffer as soon as `ready` is sent.
        return result.sync.wait().map_err(|e| format!("{e:?}"));
    };
    let geo = scene.space.output_geometry(output).ok_or("output not mapped")?;
    let upright: Size<i32, Physical> = geo.size.to_f64().to_physical_precise_round(scale);
    let full = transform.transform_size(upright);
    let mut texture: GlesTexture = renderer.create_buffer(Fourcc::Abgr8888, (full.w, full.h).into()).map_err(|e| e.to_string())?;
    {
        let mut tracker = OutputDamageTracker::new(full, scale, transform);
        let mut fb = renderer.bind(&mut texture).map_err(|e| e.to_string())?;
        tracker
            .render_output(renderer, &mut fb, 0, &elements, render::CLEAR_COLOR)
            .map_err(|e| format!("{e:?}"))?;
    }
    // The region where the output's buffer holds it.
    let src = transform.transform_rect_in(area, &upright);
    let from = renderer.bind(&mut texture).map_err(|e| e.to_string())?;
    let mut to = renderer.bind(dmabuf).map_err(|e| e.to_string())?;
    let sync = renderer
        .blit(&from, &mut to, src, Rectangle::from_size(size), TextureFilter::Nearest)
        .map_err(|e| format!("{e:?}"))?;
    sync.wait().map_err(|e| format!("{e:?}"))
}

pub fn write_png(path: &Path, w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())
}
