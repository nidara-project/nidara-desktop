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
    /// Gallery-only stable keyboard-focus sample of the inner editor.
    #[serde(default)]
    pub shown: Option<(usize, crate::Shown)>,
    /// The list that holds this field's suggestions: Down in the field goes to its first row,
    /// Up on that row comes back.
    #[serde(default)]
    pub suggestions: Option<Key>,
}
impl Search {
    pub(crate) fn node(self, key: impl Into<Key>) -> Node {
        Node::drawing(key, Part::Search(self))
    }
}
impl Component for Search {
    fn configure(&self, property: Configure) -> Option<Part> {
        let Configure::Sample(index @ 0..=1, shown) = property else {
            return None;
        };
        let mut next = self.clone();
        next.shown = Some((index, shown));
        Some(Part::Search(next))
    }
    fn contains_controls(&self) -> bool {
        true
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let t = &cx.look.tokens.entry;
        let mut field = self.field.clone();
        field.chrome = false;
        field.escape_clears = true;
        let mut input = field
            .node(cx.key("input"), self.name.clone(), self.changed.clone())
            .enabled(!self.disabled)
            .grow();
        if let Some((0, shown)) = self.shown {
            input = input.shown(shown);
        }
        let mut nodes = vec![
            Node::icon(cx.key("icon"), t.icon.clone(), t.icon_size).ink(if self.disabled {
                crate::Ink::Disabled
            } else {
                crate::Ink::Dim
            }),
            Node::row(cx.key("icon-gap"), vec![]).width(t.icon_gap),
            input,
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
            if let Some((1, shown)) = self.shown {
                clear = clear.shown(shown);
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
            super::editable::chrome(cx);
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
impl Clear {
    fn visible(&self, cx: &Read<'_>) -> Rect {
        let r = cx.rect;
        let side = cx.look.tokens.entry.clear_button.min(r[2]).min(r[3]);
        [
            r[0] + (r[2] - side) / 2.,
            r[1] + (r[3] - side) / 2.,
            side,
            side,
        ]
    }
}
impl Component for Clear {
    fn silhouette(&self, cx: &Read<'_>) -> Rect {
        self.visible(cx)
    }
    fn focus_outline(&self, cx: &Read<'_>) -> Option<FocusOutline> {
        let bounds = self.silhouette(cx);
        Some(FocusOutline::rounded(bounds, bounds[3] / 2.))
    }
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
        let r = self.visible(&cx.read);
        if cx.interaction.enabled && (cx.interaction.hover || cx.interaction.pressed) {
            cx.canvas
                .rounded_rect(rect(&r), r[3] / 2., cx.ink(cx.look.tokens.button.hover));
        }
    }
}
