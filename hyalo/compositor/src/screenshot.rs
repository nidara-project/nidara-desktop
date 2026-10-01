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
        allocator::Fourcc,
        renderer::{
            Bind, ExportMem, Offscreen, Texture as _, TextureMapping as _,
            damage::OutputDamageTracker,
            gles::{GlesRenderer, GlesTexture},
        },
    },
    output::Output,
    utils::{Rectangle, Transform},
};

use crate::render;

pub fn capture(
    renderer: &mut GlesRenderer,
    scene: &render::Scene<'_>,
    output: &Output,
) -> Result<(u32, u32, Vec<u8>), String> {
    let geo = scene.space.output_geometry(output).ok_or("output not mapped")?;
    let scale = output.current_scale().fractional_scale();
    let size = geo.size.to_f64().to_physical_precise_round(scale);
    let mut texture: GlesTexture = renderer
        .create_buffer(Fourcc::Abgr8888, (size.w, size.h).into())
        .map_err(|e| e.to_string())?;
    let elements = render::output_elements(scene, renderer, output, None);
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

pub fn write_png(path: &Path, w: u32, h: u32, rgba: &[u8]) -> Result<(), String> {
    let file = std::fs::File::create(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    let mut writer = encoder.write_header().map_err(|e| e.to_string())?;
    writer.write_image_data(rgba).map_err(|e| e.to_string())
}
