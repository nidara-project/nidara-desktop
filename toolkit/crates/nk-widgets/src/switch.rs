// SPDX-License-Identifier: LGPL-3.0-or-later
//! The switch's look (`SwitchStyle`, from the exported `components.json` switch,
//! `toolkit/tokens/switch.json`); its size stays `Metrics::switch_width` × `Metrics::control`.
//! There are no defaults here: a switch painted without its style is an error.
use crate::*;
use nk_render::Color;

#[derive(Clone, Copy, Debug)]
pub struct SwitchStyle {
    pub border: f32,
    pub border_color: Color,
    pub checked_border_color: Color,
    pub track: Color,
    pub checked: Color,
    pub thumb: Color,
    /// Between the thumb and the track's edge (the kit's `slider { margin }`).
    pub thumb_margin: f32,
    /// The whole switch when it cannot be flipped (the kit's `:disabled { opacity }`).
    pub disabled_opacity: f32,
}

impl SwitchStyle {
    fn validate(&self) -> Result<()> {
        if !(self.border.is_finite() && self.border >= 0.)
            || !(self.thumb_margin.is_finite() && self.thumb_margin >= 0.)
            || !(self.disabled_opacity.is_finite() && (0. ..=1.).contains(&self.disabled_opacity))
        {
            return Err("invalid switch style".into());
        }
        Ok(())
    }
}

impl Tree {
    pub fn set_switch_style(&mut self, style: SwitchStyle) -> Result<()> {
        style.validate()?;
        if self.metrics.control <= 2. * style.thumb_margin {
            return Err("switch thumb margin leaves no thumb".into());
        }
        self.switch_style = Some(style);
        let switches: Vec<_> = self
            .nodes
            .iter()
            .filter(|(_, n)| matches!(n.kind, Kind::Switch { .. }))
            .map(|(id, _)| *id)
            .collect();
        for id in switches {
            self.invalidate(id, Invalid::PAINT);
        }
        Ok(())
    }

    pub(crate) fn paint_switch(
        &self,
        r: Rect,
        checked: bool,
        available: bool,
        canvas: &mut nk_render::Canvas,
    ) -> Result<()> {
        let s = self
            .switch_style
            .ok_or("switch painted before its switch style was set")?;
        let fade = |mut c: Color| {
            if !available {
                c.components[3] *= s.disabled_opacity;
            }
            c
        };
        let radius = (r.height / 2.) as f64;
        canvas.rounded_rect(r, radius, fade(if checked { s.checked } else { s.track }));
        if s.border > 0. {
            let edge = if checked {
                s.checked_border_color
            } else {
                s.border_color
            };
            canvas.rounded_ring(r, radius, s.border as f64, fade(edge));
        }
        let diameter = r.height - 2. * s.thumb_margin;
        let thumb = Rect {
            x: if checked {
                r.x + r.width - s.thumb_margin - diameter
            } else {
                r.x + s.thumb_margin
            },
            y: r.y + s.thumb_margin,
            width: diameter,
            height: diameter,
        };
        canvas.rounded_rect(thumb, (diameter / 2.) as f64, fade(s.thumb));
        Ok(())
    }
}
