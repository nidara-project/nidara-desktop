// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ButtonAppearance {
    #[default]
    Normal,
    Default,
    Destructive,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Button {
    #[serde(default)]
    pub appearance: ButtonAppearance,
    pub label: String,
    pub style: nk_text::TextStyle,
    pub selected: bool,
    pub corner: Corner,
    /// What activating it reports with its action (`Button::value`): which crumb, which row.
    #[serde(default)]
    pub value: Option<Value>,
}
impl Component for Button {
    fn ink(&self, look: ComponentLook<'_>, _: Interaction, _: bool) -> Option<Color> {
        match self.appearance {
            ButtonAppearance::Normal => None,
            ButtonAppearance::Default => Some(look.tokens.button.primary.text),
            ButtonAppearance::Destructive => Some(look.tokens.button.destructive.text),
        }
    }
    fn selected(&self) -> bool {
        self.selected
    }
    fn value(&self, _state: Option<&dyn Any>) -> Option<Value> {
        self.value.clone()
    }
    fn corner(&self) -> Corner {
        self.corner
    }
    /// A glass button (`Node::glass`): its hover and press are Hyalo's, on its own glass; a
    /// destructive one takes the destructive washes. A button for content declares nothing.
    fn glass(&self, cx: &Read<'_>) -> Glass {
        if !cx.is_glass() {
            return Glass::default();
        }
        let washes = &cx.look.tokens.washes;
        let (hover, press) = if self.appearance == ButtonAppearance::Destructive {
            (washes.destructive_hover, washes.destructive_press)
        } else {
            (washes.hover, washes.press)
        };
        let lit = if !cx.interaction.enabled {
            (4, [hover[0], hover[1], hover[2], 0.])
        } else if cx.interaction.pressed {
            (0, press)
        } else if cx.interaction.hover {
            (1, hover)
        } else if cx.fading {
            (2, [hover[0], hover[1], hover[2], 0.])
        } else {
            (4, [hover[0], hover[1], hover[2], 0.])
        };
        Glass { lit: Some(lit) }
    }
    fn configure(&self, p: Configure) -> Option<Part> {
        let mut next = self.clone();
        match p {
            Configure::Marked(v) => next.selected = v,
            Configure::ButtonAppearance(v) => next.appearance = v,
            Configure::Corner(v) => next.corner = v,
            Configure::Value(v) => next.value = Some(v),
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

        let appearance = match self.appearance {
            ButtonAppearance::Normal => None,
            ButtonAppearance::Default => Some(&b.primary),
            ButtonAppearance::Destructive => Some(&b.destructive),
        };
        // Glass itself: the glass is its rest and Hyalo its hover and press. Only the default
        // button keeps its accent fill on it, the glass tinted as the action the page is for.
        let glass = cx.read.is_glass();
        if glass && self.appearance != ButtonAppearance::Default {
            return;
        }
        let fill = if glass {
            b.primary.background
        } else if interaction.pressed {
            appearance.map_or(b.pressed, |a| a.pressed)
        } else if interaction.hover {
            appearance.map_or(b.hover, |a| a.hover)
        } else {
            appearance.map_or(b.background, |a| a.background)
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
        if b.border > 0. && !glass {
            canvas.rounded_ring(
                rect(&r),
                radius,
                b.border,
                faded(appearance.map_or(b.border_color, |a| a.border)),
            );
        }
        canvas.pop_clip();
    }
}
