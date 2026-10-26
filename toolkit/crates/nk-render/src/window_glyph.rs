// SPDX-License-Identifier: LGPL-3.0-or-later
//! Window-control paths, independent of interface fonts. Geometry is supplied by the app.
use crate::{Canvas, Color};
use nk_text::Rect;
use vello_cpu::kurbo::{BezPath, Cap, Join, RoundedRect, Shape, Stroke};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowGlyph {
    Minimize,
    Maximize,
    Close,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct WindowGlyphStyle {
    pub size: f32,
    pub stroke: f32,
    pub minimize_half: f32,
    pub maximize_half: f32,
    pub maximize_radius: f32,
    pub close_half: f32,
}
impl WindowGlyphStyle {
    pub fn validate(self) -> Result<(), String> {
        if ![
            self.size,
            self.stroke,
            self.minimize_half,
            self.maximize_half,
            self.maximize_radius,
            self.close_half,
        ]
        .iter()
        .all(|n| n.is_finite() && *n > 0.)
            || self.maximize_radius > self.maximize_half
            || self.minimize_half + self.stroke / 2. > self.size / 2.
            || self.maximize_half + self.stroke / 2. > self.size / 2.
            || self.close_half + self.stroke / 2. > self.size / 2.
        {
            return Err("invalid window glyph geometry".into());
        }
        Ok(())
    }
}
impl Canvas {
    pub fn window_glyph(
        &mut self,
        kind: WindowGlyph,
        style: WindowGlyphStyle,
        bounds: Rect,
        ink: Color,
    ) {
        let x = (bounds.x + bounds.width / 2.) as f64;
        let y = (bounds.y + bounds.height / 2.) as f64;
        let mut path = BezPath::new();
        match kind {
            WindowGlyph::Minimize => {
                let h = style.minimize_half as f64;
                path.move_to((x - h, y));
                path.line_to((x + h, y));
            }
            WindowGlyph::Maximize => {
                let h = style.maximize_half as f64;
                path = RoundedRect::new(x - h, y - h, x + h, y + h, style.maximize_radius as f64)
                    .to_path(0.01);
            }
            WindowGlyph::Close => {
                let h = style.close_half as f64;
                path.move_to((x - h, y - h));
                path.line_to((x + h, y + h));
                path.move_to((x + h, y - h));
                path.line_to((x - h, y + h));
            }
        }
        self.context.set_paint(ink);
        self.context.set_stroke(
            Stroke::new(style.stroke as f64)
                .with_caps(Cap::Round)
                .with_join(Join::Round),
        );
        self.context.stroke_path(&path);
    }
}
