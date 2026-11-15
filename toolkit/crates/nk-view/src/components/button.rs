// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Button {
    pub label: String,
    pub style: nk_text::TextStyle,
    pub selected: bool,
    pub corner: Corner,
}
impl Component for Button {
    fn selected(&self) -> bool {
        self.selected
    }
    fn corner(&self) -> Corner {
        self.corner
    }
    fn configure(&self, p: Configure) -> Option<Part> {
        let mut next = self.clone();
        match p {
            Configure::Marked(v) => next.selected = v,
            Configure::Corner(v) => next.corner = v,
            _ => return None,
        };
        Some(Part::Button(next))
    }
    fn semantics(&self, cx: &Read<'_>, n: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        n.states.checked = matches!(
            cx.role,
            Some(crate::Role::Toggle | crate::Role::Check | crate::Role::Radio)
        ) && self.selected;
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        Node::text(cx.key("label"), self.label.clone(), self.style.clone()).lines(1)
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let b = &look.tokens.button;
        FrameSpec {
            inset: (b.padding_x + b.border, b.padding_y + b.border),
            least: (0., b.min_height()),
            body: BodyPlacement::NaturalCentered,
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
        let corner = cx.corner;

        // A content button (VIEW.md §13.2): the surface, its border, and the
        // surface's own hover and pressed tones; no glass, nothing for Hyalo.
        let b = &tokens.button;

        let fill = if interaction.pressed {
            b.pressed
        } else if interaction.hover {
            b.hover
        } else {
            b.background
        };
        let faded = |colour: nk_render::Color| {
            let a = if interaction.enabled {
                1.
            } else {
                b.disabled_opacity as f32
            };
            ink(colour.with_alpha(colour.components[3] * a))
        };
        let radius = corner.of(r[2], r[3], &tokens.radii);
        canvas.clip(rect(&visible));
        // Each tone replaces the rest one, as the stylesheet's do.
        canvas.rounded_rect(rect(&r), radius, faded(fill));
        if b.border > 0. {
            canvas.rounded_ring(rect(&r), radius, b.border, faded(b.border_color));
        }
        canvas.pop_clip();
        if interaction.focus_ring {
            canvas.rounded_ring(
                rect(&r),
                radius,
                tokens.look.focus_width,
                ink(tokens.look.focus),
            );
        }
    }
}
