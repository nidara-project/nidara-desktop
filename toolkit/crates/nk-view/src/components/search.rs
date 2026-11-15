// SPDX-License-Identifier: LGPL-3.0-or-later
//! Search composes the retained entry, the token glyph and a normal clear control.
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Search {
    pub field: EditableField,
    pub name: String,
    pub changed: String,
    pub clear_label: String,
    pub disabled: bool,
}
impl Search {
    pub fn node(self, key: impl Into<Key>) -> Node {
        Node::drawing(key, Part::Search(self))
    }
}
impl Component for Search {
    fn contains_controls(&self) -> bool {
        true
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let t = &cx.look.tokens.entry;
        let mut field = self.field.clone();
        field.chrome = false;
        field.escape_clears = true;
        let mut nodes = vec![
            Node::icon(cx.key("icon"), t.icon.clone(), t.icon_size).ink(if self.disabled {
                crate::Ink::Disabled
            } else {
                crate::Ink::Dim
            }),
            Node::row(cx.key("icon-gap"), vec![]).width(t.icon_gap),
            field
                .node(cx.key("input"), self.name.clone(), self.changed.clone())
                .enabled(!self.disabled)
                .grow(),
        ];
        if !editable::normalize_single_line(&self.field.text).is_empty() {
            let mut clear = Node::control(
                cx.key("clear"),
                self.clear_label.clone(),
                "",
                Node::spacer(cx.key("clear/body")),
            )
            .enabled(!self.disabled);
            if let Kind::Control(c) = &mut clear.kind {
                c.part = Some(Box::new(Part::SearchClear(Clear {
                    owner: cx.key("input"),
                })));
            }
            nodes.push(clear);
        }
        Node::row(cx.key("body"), nodes).align(crate::Align::Center)
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let t = &look.tokens.entry;
        FrameSpec {
            inset: (t.padding_x + t.border, t.border),
            least: (0., t.min_height),
            body: BodyPlacement::FillWidth,
        }
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase == PaintPhase::Under {
            super::editable::chrome(cx, cx.read.focused_part("input"));
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Clear {
    pub owner: Key,
}
impl Clear {
    fn clear(&self, cx: &mut Input<'_>) {
        cx.effects.handled = true;
        cx.effects.host.push(HostRequest::Respond {
            owner: self.owner.clone(),
            request: Request::SetText(String::new()),
        });
        cx.effects.host.push(HostRequest::Focus {
            owner: self.owner.clone(),
        });
    }
}
impl Component for Clear {
    fn body(&self, cx: &Build<'_>) -> Node {
        let t = &cx.look.tokens.entry;
        Node::icon(cx.key("glyph"), t.clear_icon.clone(), t.icon_size).ink(crate::Ink::Dim)
    }
    fn frame(&self, look: ComponentLook<'_>) -> FrameSpec {
        let t = &look.tokens.entry;
        let side = (t.min_height - 2. * t.border).max(t.icon_size);
        FrameSpec {
            inset: (0., 0.),
            least: (side, side),
            body: BodyPlacement::NaturalCentered,
        }
    }
    fn release(&self, cx: &mut Input<'_>, _at: (f64, f64)) {
        self.clear(cx)
    }
    fn key(&self, cx: &mut Input<'_>, key: crate::KeyInput) {
        if key == crate::KeyInput::Activate {
            self.clear(cx)
        }
    }
    fn paint(&self, cx: &mut Paint<'_>, phase: PaintPhase) {
        if phase != PaintPhase::Under {
            return;
        }
        let r = cx.rect;
        if cx.interaction.enabled && (cx.interaction.hover || cx.interaction.pressed) {
            cx.canvas
                .rounded_rect(rect(&r), r[3] / 2., cx.ink(cx.look.tokens.button.hover));
        }
        if cx.interaction.focus_ring {
            cx.canvas.rounded_ring(
                rect(&r),
                r[3] / 2.,
                cx.look.tokens.look.focus_width,
                cx.ink(cx.look.tokens.look.focus),
            );
        }
    }
}
