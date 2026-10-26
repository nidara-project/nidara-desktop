// SPDX-License-Identifier: LGPL-3.0-or-later
//! Local #936 pixel evidence: CPU vector paths and the former font control, no compositor.
//! NK_SETTINGS_DATA=build/settings-data cargo run -p nk-settings --example window-glyphs -- OUT
use nk_render::{Canvas, WindowGlyph, rgba};
use nk_settings::{exports::Exports, styles::window_glyph_style};
use nk_text::{FontSet, ParleyBackend, Rect, TextBackend, TextStyle};
use std::{path::PathBuf, sync::Arc};
fn main() -> Result<(), String> {
    let out = PathBuf::from(std::env::args().nth(1).ok_or("provide output directory")?);
    std::fs::create_dir_all(&out).map_err(|e| e.to_string())?;
    let exports = Exports::load(&Exports::root())?;
    let capsule = &exports.components["variants"][0]["capsule"];
    let style = window_glyph_style(&capsule["glyph"])?;
    let n = |k| capsule[k].as_f64().ok_or("missing capsule geometry");
    let button = n("button")?;
    let edge = n("edge")?;
    let gap = n("gap")?;
    let width = 2. * edge + 3. * button + 2. * gap;
    let height = n("height")?;
    let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required()?))?;
    let font = TextStyle {
        size: button as f32,
        line_height: 1.,
        ..Default::default()
    };
    for scale in [1., 1.25] {
        let w = (width * scale).ceil() as u16;
        let h = (height * scale).ceil() as u16;
        for control in [false, true] {
            let mut canvas = Canvas::new(w, h, scale);
            for (i, kind) in [
                WindowGlyph::Minimize,
                WindowGlyph::Maximize,
                WindowGlyph::Close,
            ]
            .into_iter()
            .enumerate()
            {
                let bounds = Rect {
                    x: (edge + i as f64 * (button + gap)) as f32,
                    y: ((height - button) / 2.) as f32,
                    width: button as f32,
                    height: button as f32,
                };
                if control {
                    let layout = text.layout(["−", "□", "×"][i], &font, button as f32)?;
                    let size = layout.measured_size();
                    canvas.layout(
                        &layout,
                        (
                            bounds.x + (bounds.width - size.width) / 2.,
                            bounds.y + (bounds.height - size.height) / 2.,
                        ),
                        rgba(255, 255, 255, 255),
                    )?;
                } else {
                    canvas.window_glyph(kind, style, bounds, rgba(255, 255, 255, 255));
                }
            }
            let pixels = canvas.finish();
            let name = format!(
                "{}-{scale}",
                if control { "font-control" } else { "toolkit" }
            );
            std::fs::write(out.join(format!("{name}.rgba")), &pixels).map_err(|e| e.to_string())?;
            image::save_buffer(
                out.join(format!("{name}.png")),
                &pixels,
                w.into(),
                h.into(),
                image::ColorType::Rgba8,
            )
            .map_err(|e| e.to_string())?;
            println!("{name}: {w}x{h}");
        }
    }
    Ok(())
}
