// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Switch {
    pub on: bool,
}
impl Component for Switch {
    fn body(&self, cx: &Build<'_>) -> Node {
        let s = &cx.look.tokens.switch;
        Node::spacer(cx.key("body")).width(s.width).height(s.height)
    }
    fn target(&self) -> Option<f64> {
        Some(f64::from(self.on))
    }
    fn glass(&self) -> Glass {
        Glass { owns_mark: true }
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

        // VIEW.md §12.6: the native switch's track, border and thumb, blended from
        // off to on as the thumb slides; faded while its row is disabled.
        let s = &tokens.switch;
        let t = progress.clamp(0., 1.) as f32;
        let enabled = interaction.enabled;
        let fade = |c: nk_render::Color| {
            let a = if enabled {
                1.
            } else {
                s.disabled_opacity as f32
            };
            ink(c.with_alpha(c.components[3] * a))
        };
        // At its own size, centred in what a stretching stack gave it.
        let (w, h) = (s.width.min(r[2]), s.height.min(r[3]));
        let r = [r[0] + (r[2] - w) / 2., r[1] + (r[3] - h) / 2., w, h];
        let radius = r[3] / 2.;
        canvas.clip(rect(&visible));
        canvas.rounded_rect(rect(&r), radius, fade(mix(s.track, s.checked, t)));
        if s.border > 0. {
            let edge = mix(s.border_color, s.checked_border_color, t);
            canvas.rounded_ring(rect(&r), radius, s.border, fade(edge));
        }
        let d = r[3] - 2. * s.thumb_margin;
        let travel = r[2] - 2. * s.thumb_margin - d;
        let x = r[0] + s.thumb_margin + travel * t as f64;
        let thumb = [x, r[1] + s.thumb_margin, d, d];
        canvas.rounded_rect(rect(&thumb), d / 2., fade(s.thumb));
        canvas.pop_clip();
    }
}
