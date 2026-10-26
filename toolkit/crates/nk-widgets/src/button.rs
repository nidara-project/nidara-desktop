// SPDX-License-Identifier: LGPL-3.0-or-later
//! A row's button (a Button whose parent is a Row: Browse, the font buttons): token-driven
//! box, border and type, so it stands as tall as the Dropdown trigger beside it. Header and
//! capsule buttons are not row buttons and keep their own geometry.
use crate::*;
use nk_render::{Canvas, Color};

/// The exact exported look (`components.json` `button`); no geometry or colour defaults.
#[derive(Clone, Debug)]
pub struct ButtonStyle {
    pub padding_x: f32,
    pub padding_y: f32,
    pub border: f32,
    pub min_content_height: f32,
    pub radius: f32,
    pub text_scale: f32,
    pub weight: f32,
    pub background: Color,
    pub border_color: Color,
    pub hover: Color,
    pub pressed: Color,
    pub text: Color,
    pub focus: Color,
    pub disabled_opacity: f32,
}
impl ButtonStyle {
    fn validate(&self) -> Result<()> {
        if ![self.padding_x, self.padding_y, self.border, self.radius]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.)
            || ![self.min_content_height, self.text_scale]
                .iter()
                .all(|v| v.is_finite() && *v > 0.)
            || !self.weight.is_finite()
            || !(1. ..=1000.).contains(&self.weight)
            || !self.disabled_opacity.is_finite()
            || !(0. ..=1.).contains(&self.disabled_opacity)
            || ![
                self.background,
                self.border_color,
                self.hover,
                self.pressed,
                self.text,
                self.focus,
            ]
            .iter()
            .all(|c| {
                c.components.iter().all(|v| v.is_finite()) && (0. ..=1.).contains(&c.components[3])
            })
        {
            return Err("invalid button style".into());
        }
        Ok(())
    }
}

impl Tree {
    /// Without it a row button keeps the generic control box (the widgets demo, unit trees).
    pub fn set_button_style(&mut self, style: ButtonStyle) -> Result<()> {
        style.validate()?;
        self.button_style = Some(style);
        let ids: Vec<_> = self
            .nodes
            .keys()
            .copied()
            .filter(|id| self.row_button(*id))
            .collect();
        for id in ids {
            let n = self.nodes.get_mut(&id).unwrap();
            n.layout = None;
            n.constraint = 0.;
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub(crate) fn row_button(&self, id: NodeId) -> bool {
        let n = &self.nodes[&id];
        n.kind == Kind::Button
            && n.parent
                .is_some_and(|p| self.nodes.get(&p).is_some_and(|p| p.kind == Kind::Row))
    }
    /// The style when `id` is a row button and one was set.
    pub(crate) fn styled_button(&self, id: NodeId) -> Option<&ButtonStyle> {
        self.button_style.as_ref().filter(|_| self.row_button(id))
    }
    pub(crate) fn measure_button(
        &mut self,
        id: NodeId,
        width: f32,
        backend: &mut impl TextBackend,
    ) -> Result<Size> {
        let s = self.styled_button(id).ok_or("not a styled button")?.clone();
        let inset = 2. * (s.border + s.padding_x);
        // A caption with its own style keeps it whole: a font button shows its font.
        let text_style = self.label_styles.get(&id).cloned().unwrap_or_else(|| {
            let mut style = self.style.clone();
            style.size *= s.text_scale;
            style.weight = s.weight;
            style
        });
        let n = self.nodes.get_mut(&id).unwrap();
        let text = if n.name.is_empty() {
            Size::default()
        } else if let Some(layout) = &mut n.layout {
            layout.size((width - inset).max(1.))?
        } else {
            let layout = backend.layout(&n.name, &text_style, (width - inset).max(1.))?;
            let size = layout.measured_size();
            n.layout = Some(layout);
            size
        };
        n.measured = Size {
            width: text.width + inset,
            height: text.height.max(s.min_content_height) + 2. * (s.padding_y + s.border),
        };
        Ok(n.measured)
    }
    pub(crate) fn paint_button(&self, id: NodeId, r: Rect, canvas: &mut Canvas) -> Result<()> {
        let s = self.styled_button(id).ok_or("not a styled button")?;
        let enabled = self.available(id);
        let opacity = if enabled { 1. } else { s.disabled_opacity };
        let ink = |mut c: Color| {
            c.components[3] *= opacity;
            c
        };
        let bg = if enabled && self.capture == Some(id) {
            s.pressed
        } else if enabled && self.hovered == Some(id) {
            s.hover
        } else {
            s.background
        };
        canvas.rounded_rect(r, s.radius as f64, ink(s.border_color));
        let inner = Rect {
            x: r.x + s.border,
            y: r.y + s.border,
            width: (r.width - 2. * s.border).max(0.),
            height: (r.height - 2. * s.border).max(0.),
        };
        canvas.rounded_rect(inner, (s.radius - s.border).max(0.) as f64, ink(bg));
        if enabled && self.focus_visible && self.focused == Some(id) {
            canvas.rounded_ring(r, s.radius as f64, self.metrics.focus_width as f64, s.focus);
        }
        if let Some(layout) = &self.nodes[&id].layout {
            let size = layout.measured_size();
            canvas.layout(
                layout,
                (
                    r.x + (r.width - size.width) / 2.,
                    r.y + (r.height - size.height) / 2.,
                ),
                ink(s.text),
            )?;
        }
        Ok(())
    }
}
