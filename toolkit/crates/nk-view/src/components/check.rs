// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Check {
    pub on: bool,
    pub radio: bool,
}
impl Component for Check {
    fn body(&self, cx: &Build<'_>) -> Node {
        let side = cx.look.tokens.check.size;
        Node::spacer(cx.key("body")).width(side).height(side)
    }
    fn target(&self) -> Option<f64> {
        Some(f64::from(self.on))
    }
    fn owns_mark(&self) -> bool {
        true
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        let tokens = cx.look.tokens;
        let r = cx.rect;
        let visible = cx.visible;
        let interaction = cx.interaction;
        let alpha = cx.alpha;
        let ink = |c: Color| c.with_alpha(c.components[3] * alpha as f32);
        let canvas = &mut *cx.canvas;
        let progress = cx.progress.unwrap_or(f64::from(self.on));

        // VIEW.md §13.5: a CheckButton's mark, off glass, every state the view's:
        // the surface and its border, lifted under the pointer and darker pressed;
        // checked, the accent, with a tick or the radio's band around its dot.
        let s = &tokens.check;
        let t = progress.clamp(0., 1.) as f32;
        let (enabled, hover, press) = (
            interaction.enabled,
            interaction.hover && interaction.enabled,
            interaction.pressed && interaction.enabled,
        );
        let fade = |c: nk_render::Color| {
            let a = if enabled {
                1.
            } else {
                s.disabled_opacity as f32
            };
            ink(c.with_alpha(c.components[3] * a))
        };
        let side = s.size.min(r[2]).min(r[3]);
        let r = [
            r[0] + (r[2] - side) / 2.,
            r[1] + (r[3] - side) / 2.,
            side,
            side,
        ];
        let radius = if self.radio { side / 2. } else { s.radius };
        let (fill, edge) = if press {
            (s.pressed, s.hover_border)
        } else if hover {
            (s.hover, s.hover_border)
        } else {
            (s.background, s.border_color)
        };
        canvas.clip(rect(&visible));
        canvas.rounded_rect(rect(&r), radius, fade(mix(fill, s.checked, t)));
        canvas.rounded_ring(rect(&r), radius, s.border, fade(mix(edge, s.checked, t)));
        if t > 0. {
            let on = |c: nk_render::Color| fade(c.with_alpha(c.components[3] * t));
            if self.radio {
                // The band inside the border, the accent left as the dot.
                let b = s.border;
                let inner = [r[0] + b, r[1] + b, side - 2. * b, side - 2. * b];
                canvas.rounded_ring(
                    rect(&inner),
                    inner[2] / 2.,
                    s.dot_band,
                    on(s.dot_band_color),
                );
            } else {
                let at = |x: f64, y: f64| (r[0] + x * side, r[1] + y * side);
                canvas.polyline(
                    &[at(0.27, 0.52), at(0.44, 0.68), at(0.74, 0.34)],
                    s.tick_width,
                    on(s.tick),
                );
            }
        }
        canvas.pop_clip();
    }
}
