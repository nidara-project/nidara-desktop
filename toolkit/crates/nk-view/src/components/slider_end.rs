// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
use crate::{Align, Ink};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SliderRow {
    pub owner: Key,
    pub end: crate::view::SliderEnd,
}
impl Component for SliderRow {
    fn contains_controls(&self) -> bool {
        true
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let end = self.end.clone();
        let key = self.owner.clone();
        let style = &cx.look.tokens.slider;
        let k = |part: &str| format!("{}/{part}", key.0);
        let range = end.slider.range();
        let shown = range.text(end.slider.shown(end.slider.value) as f32);
        let room = vec![
            range.text(end.slider.min as f32),
            range.text(end.slider.max as f32),
        ];
        let ink = if end.disabled {
            Ink::Disabled
        } else {
            Ink::Primary
        };
        let glyph = |part: &str, name: &str| {
            Node::icon(k(part), name, style.icon_size)
                .ink(ink)
                .alpha(style.icon_opacity)
        };
        let gap = |part: &str, w: f64| Node::spacer(k(part)).width(w);
        let mut parts = vec![];
        if let Some([lesser, _]) = &end.icons {
            parts.push(glyph("lesser", lesser));
            parts.push(gap("lesser-gap", style.icon_gap));
        }
        parts.push(
            Node::slider(key.clone(), end.name, end.action, end.slider)
                .width(style.width)
                .enabled(!end.disabled),
        );
        if let Some([_, greater]) = &end.icons {
            parts.push(gap("greater-gap", style.icon_gap));
            parts.push(glyph("greater", greater));
        }
        parts.push(gap("value-gap", style.value_gap));
        parts.push(
            Node::text(k("value"), shown, end.value_style)
                .ink(ink)
                .room(room),
        );
        Node::row(cx.key("body"), parts).align(Align::Center)
    }
}
