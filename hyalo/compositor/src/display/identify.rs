// SPDX-License-Identifier: GPL-3.0-or-later
//! A passive compositor label: no focus, input grab or client lifetime.
use crate::render::{HyaloRenderer, OutputElement};
use pangocairo::{cairo, pango};
use smithay::{
    backend::{
        allocator::Fourcc,
        renderer::element::{
            Kind,
            memory::{MemoryRenderBuffer, MemoryRenderBufferRenderElement},
        },
    },
    output::Output,
    utils::Transform,
};
use std::{
    sync::Mutex,
    time::{Duration, Instant},
};
struct Label {
    until: Instant,
    buffer: MemoryRenderBuffer,
    side: i32,
}
pub fn show(output: &Output, number: u32) {
    let scale = output.current_scale().fractional_scale();
    let side = (128.0 * scale).round() as i32;
    let Ok(mut surface) = cairo::ImageSurface::create(cairo::Format::ARgb32, side, side) else {
        return;
    };
    {
        let Ok(cr) = cairo::Context::new(&surface) else { return };
        let bg = crate::render::CLEAR_COLOR;
        cr.set_source_rgba(bg.r() as f64, bg.g() as f64, bg.b() as f64, 1.0);
        let _ = cr.paint();
        let ink = crate::render::glass_tokens::pane("control", 128.0, true, false)
            .and_then(|p| p.control)
            .map(|c| c.ink[0])
            .unwrap_or([1.0 - bg.r() as f64, 1.0 - bg.g() as f64, 1.0 - bg.b() as f64, 1.0]);
        cr.set_source_rgba(ink[0], ink[1], ink[2], ink[3]);
        let layout = pangocairo::functions::create_layout(&cr);
        let mut font = pango::FontDescription::from_string("Sans Bold");
        font.set_absolute_size(64.0 * scale * pango::SCALE as f64);
        layout.set_font_description(Some(&font));
        layout.set_text(&number.to_string());
        let (_, rect) = layout.pixel_extents();
        cr.move_to(
            (side - rect.width()) as f64 / 2.0 - rect.x() as f64,
            (side - rect.height()) as f64 / 2.0 - rect.y() as f64,
        );
        pangocairo::functions::show_layout(&cr, &layout);
    }
    surface.flush();
    let Ok(data) = surface.data() else { return };
    let buffer = MemoryRenderBuffer::from_slice(&data, Fourcc::Argb8888, (side, side), 1, Transform::Normal, None);
    output.user_data().insert_if_missing(|| Mutex::new(None::<Label>));
    *output
        .user_data()
        .get::<Mutex<Option<Label>>>()
        .unwrap()
        .lock()
        .unwrap() = Some(Label {
        until: Instant::now() + Duration::from_secs(3),
        buffer,
        side,
    });
}
pub fn elements<R: HyaloRenderer>(renderer: &mut R, output: &Output) -> Vec<OutputElement<R>> {
    let Some(label) = output.user_data().get::<Mutex<Option<Label>>>() else {
        return Vec::new();
    };
    let mut slot = label.lock().unwrap();
    if slot.as_ref().is_some_and(|l| Instant::now() >= l.until) {
        *slot = None;
    }
    let Some(label) = slot.as_ref() else { return Vec::new() };
    let size = output
        .current_mode()
        .map(|m| output.current_transform().transform_size(m.size))
        .unwrap_or_default();
    let loc = ((size.w - label.side) as f64 / 2.0, (size.h - label.side) as f64 / 2.0);
    MemoryRenderBufferRenderElement::from_buffer(renderer, loc, &label.buffer, None, None, None, Kind::Unspecified)
        .map(|e| vec![OutputElement::Cursor(e)])
        .unwrap_or_default()
}
