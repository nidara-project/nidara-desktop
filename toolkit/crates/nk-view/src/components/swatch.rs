// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Swatch {
    pub color: [f32; 4],
    pub group: Key,
    pub selected: bool,
    pub value: usize,
}
impl Component for Swatch {
    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        let r = self.silhouette(cx);
        Some(FocusOutline::rounded(r, r[2].min(r[3]) / 2.))
    }
    fn selected(&self) -> bool {
        self.selected
    }
    fn value(&self, _state: Option<&dyn Any>) -> Option<Value> {
        Some(Value::Index(self.value))
    }
    fn configure(&self, p: Configure) -> Option<Part> {
        if let Configure::Marked(selected) = p {
            let mut next = self.clone();
            next.selected = selected;
            Some(Part::Swatch(next))
        } else {
            None
        }
    }
    fn semantics(&self, _cx: &Read<'_>, n: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        n.states.checked = self.selected;
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let s = &cx.look.tokens.swatch;
        let side = s.diameter + 2. * s.ring;
        Node::spacer(cx.key("circle")).width(side).height(side)
    }
    fn group(&self, cx: &Read<'_>) -> Membership {
        Membership::Named {
            key: self.group.clone(),
            selected: cx.interaction.marked,
        }
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

        let color = self.color;
        let s = &tokens.swatch;
        let alpha = if interaction.enabled {
            1.
        } else {
            s.disabled_opacity as f32
        };
        let fade = |color: nk_render::Color| ink(color.with_alpha(color.components[3] * alpha));
        canvas.clip(rect(&visible));
        let d = s.diameter;
        let b = s.border;
        let circle = [r[0] + (r[2] - d) / 2., r[1] + (r[3] - d) / 2., d, d];
        let inside = [circle[0] + b, circle[1] + b, d - 2. * b, d - 2. * b];
        canvas.rounded_rect(
            rect(&inside),
            (d - 2. * b) / 2.,
            fade(nk_render::Color::new(color)),
        );
        if interaction.marked {
            let r = s.ring;
            let outside = [circle[0] - r, circle[1] - r, d + 2. * r, d + 2. * r];
            canvas.rounded_ring(rect(&outside), (d + 2. * r) / 2., b + r, fade(s.selected));
        } else if interaction.enabled && (interaction.hover || interaction.pressed) {
            canvas.rounded_ring(rect(&circle), d / 2., b, fade(s.hover));
        }
        canvas.pop_clip();
    }
}
