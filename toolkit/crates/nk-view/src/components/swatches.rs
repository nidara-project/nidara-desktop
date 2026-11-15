// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SwatchRow {
    pub name: String,
    pub colors: Vec<(String, [f32; 4])>,
    pub chosen: usize,
    pub action: String,
    pub disabled: bool,
    pub shown: Vec<(usize, crate::Shown)>,
}
impl Component for SwatchRow {
    fn contains_controls(&self) -> bool {
        true
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let mut children = Vec::new();
        for (index, (name, color)) in self.colors.iter().enumerate() {
            if index > 0 {
                children.push(
                    Node::row(cx.key(&format!("gap/{index}")), vec![])
                        .width(cx.look.tokens.swatch.gap),
                );
            }
            let mut n = Node::control(
                cx.key(&index.to_string()),
                name.clone(),
                format!("{}:{index}", self.action),
                Node::spacer(cx.key(&format!("{index}/circle"))),
            )
            .role(crate::Role::Radio)
            .enabled(!self.disabled)
            .description(self.name.clone());
            if let Kind::Control(c) = &mut n.kind {
                c.part = Some(Box::new(Part::Swatch(Swatch {
                    color: *color,
                    group: cx.key.clone(),
                    selected: index == self.chosen,
                    value: index,
                })));
                c.shown = self
                    .shown
                    .iter()
                    .rev()
                    .find(|(i, _)| *i == index)
                    .map(|(_, shown)| *shown);
            }
            children.push(n);
        }
        Node::row(cx.key("body"), children).align(crate::Align::Center)
    }
    fn configure(&self, p: Configure) -> Option<Part> {
        if let Configure::Sample(i, shown) = p {
            let mut next = self.clone();
            next.shown.push((i, shown));
            Some(Part::Swatches(next))
        } else {
            None
        }
    }
}
