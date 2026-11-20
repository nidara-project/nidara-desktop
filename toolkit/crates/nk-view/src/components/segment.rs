// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Segment {
    pub label: String,
    pub group: Key,
    pub join_before: bool,
    pub join_after: bool,
    pub selected: bool,
    pub value: usize,
}
impl Component for Segment {
    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        // Round the whole control, its ends rounded, never one segment (owner, #1156): the
        // focused segment is always the chosen one (one Tab stop, the arrows move the choice),
        // so the ring says no less, and inside it the accent would sit on the accent fill.
        let mut bounds = self.silhouette(cx);
        let parent = cx
            .placed
            .iter()
            .find(|p| &p.key == cx.key)
            .and_then(|p| p.parent);
        if let Some(parent) = parent {
            for p in cx.placed.iter().filter(|p| {
                p.parent == Some(parent) && matches!(p.what, crate::layout::What::Control(_))
            }) {
                let r = p.rect;
                let (x0, y0) = (bounds[0].min(r[0]), bounds[1].min(r[1]));
                let x1 = (bounds[0] + bounds[2]).max(r[0] + r[2]);
                let y1 = (bounds[1] + bounds[3]).max(r[1] + r[3]);
                bounds = [x0, y0, x1 - x0, y1 - y0];
            }
        }
        Some(FocusOutline::rounded(
            bounds,
            cx.look.tokens.segmented.radius,
        ))
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
            Some(Part::Segment(next))
        } else {
            None
        }
    }
    fn semantics(&self, _cx: &Read<'_>, n: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        n.states.checked = self.selected;
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let s = &cx.look.tokens.segmented;
        Node::text(
            cx.key("label"),
            self.label.clone(),
            cx.look.types.style(s.font.0, s.font.1),
        )
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let (x, y, h) = look.tokens.segmented.inset();
        FrameSpec {
            inset: (x, y),
            least: (0., h),
            body: BodyPlacement::NaturalCentered,
        }
    }
    fn group(&self, cx: &Read<'_>) -> Membership {
        Membership::Named {
            key: self.group.clone(),
            selected: cx.interaction.marked,
        }
    }
    fn ink(&self, look: ComponentLook<'_>, i: Interaction, _glyph: bool) -> Option<Color> {
        let s = &look.tokens.segmented;
        let c = if i.marked { s.selected_text } else { s.text };
        Some(c.with_alpha(
            c.components[3]
                * if i.enabled {
                    1.
                } else {
                    s.disabled_opacity as f32
                },
        ))
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

        // A segment (VIEW.md §13.10): its tone inside the group's outline, cut to
        // it, so only the group's two ends are rounded. The chosen one is the accent
        // to its edges; another draws the outline's border and the line before it.
        // Its ring is drawn after every segment (below), so a neighbour never covers it.
        let s = &tokens.segmented;

        let pressed = interaction.enabled && (interaction.pressed);
        let hovered = interaction.enabled && (interaction.hover);
        let white = nk_render::Color::new([1., 1., 1., 1.]);
        let black = nk_render::Color::new([0., 0., 0., 1.]);
        let fill = match (interaction.marked, pressed, hovered) {
            (true, true, _) => mix(s.selected, black, s.selected_pressed_black as f32),
            (true, false, true) => mix(s.selected, white, s.selected_hover_white as f32),
            (true, ..) => s.selected,
            (false, true, _) => s.pressed,
            (false, false, true) => s.hover,
            (false, ..) => s.background,
        };
        let a = if interaction.enabled {
            1.
        } else {
            s.disabled_opacity as f32
        };
        let faded = |colour: nk_render::Color| ink(colour.with_alpha(colour.components[3] * a));
        let (r, round) = (r, s.radius);
        // A join's corner lies a corner's width past the segment's clip, and
        // another, since the canvas's corner curves on beyond its radius.
        let before = if self.join_before { 2. * round } else { 0. };
        let after = if self.join_after { 2. * round } else { 0. };
        let outline = [r[0] - before, r[1], r[2] + before + after, r[3]];
        canvas.clip(rect(&visible));
        canvas.clip(rect(&r));
        canvas.rounded_rect(rect(&outline), round, faded(fill));
        if !interaction.marked && s.border > 0. {
            canvas.rounded_ring(rect(&outline), round, s.border, faded(s.border_color));
            if self.join_before {
                canvas.rounded_rect(
                    rect(&[r[0], r[1], s.border, r[3]]),
                    0.,
                    faded(s.border_color),
                );
            }
        }
        canvas.pop_clip();
        canvas.pop_clip();
    }
}
