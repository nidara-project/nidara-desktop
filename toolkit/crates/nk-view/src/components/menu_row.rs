// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MenuRow {
    pub label: String,
    pub selected: bool,
}
impl MenuRow {
    fn lit(&self, cx: &Read<'_>) -> bool {
        let i = cx.interaction;
        i.enabled && (i.hover || i.focus_ring || i.pressed)
    }
}
impl Component for MenuRow {
    fn focus_outline(&self, _cx: &Read<'_>) -> Option<FocusOutline> {
        None
    }

    fn body(&self, cx: &Build<'_>) -> Node {
        let m = &cx.look.tokens.dropdown.menu;
        Node::row(
            cx.key("row"),
            vec![
                Node::text(
                    cx.key("label"),
                    self.label.clone(),
                    cx.look.types.style(m.font.0, m.font.1),
                )
                .grow(),
                Node::spacer(cx.key("gap")).width(m.check_gap),
                Node::slot(cx.key("tick"), m.check_size),
            ],
        )
        .align(crate::Align::Center)
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let (x, y, h) = look.tokens.dropdown.menu.row_inset();
        FrameSpec {
            inset: (x, y),
            least: (0., h),
            body: BodyPlacement::FillWidth,
        }
    }
    fn selected(&self) -> bool {
        self.selected
    }
    fn semantics(&self, _cx: &Read<'_>, n: &mut nk_a11y::Node, _: &mut Vec<SemanticChild>) {
        n.states.checked = false;
    }
    fn ink(&self, look: ComponentLook<'_>, i: Interaction, _glyph: bool) -> Option<Color> {
        let m = &look.tokens.dropdown.menu;
        Some(if i.enabled && (i.hover || i.focus_ring || i.pressed) {
            m.accent_text
        } else {
            m.text
        })
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        let m = &cx.look.tokens.dropdown.menu;
        let lit = self.lit(&cx.read);
        if lit {
            let mut bg = m.accent;
            if cx.interaction.pressed {
                for v in &mut bg.components[..3] {
                    *v *= 1. - m.pressed_black as f32;
                }
            }
            cx.canvas.clip(rect(&cx.visible));
            cx.canvas
                .rounded_rect(rect(&cx.rect), m.row_radius, cx.ink(bg));
            cx.canvas.pop_clip();
        }
        if self.selected
            && let Some(t) = cx
                .read
                .placed
                .iter()
                .find(|p| p.key == cx.read.key("tick"))
                .map(|p| p.rect)
        {
            let side = t[2].min(t[3]);
            let (x, y) = (t[0] + (t[2] - side) / 2., t[1] + (t[3] - side) / 2.);
            let at = |u: f64, v: f64| (x + u * side / 24., y + v * side / 24.);
            let tick = if lit { m.accent_text } else { m.text };
            cx.canvas.clip(rect(&cx.visible));
            cx.canvas.polyline(
                &[at(4., 12.), at(9., 17.), at(20., 6.)],
                m.check_stroke * side / 24.,
                cx.ink(tick),
            );
            cx.canvas.pop_clip();
        }
    }
}
