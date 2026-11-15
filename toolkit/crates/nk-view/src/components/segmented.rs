// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SegmentedRow {
    pub name: String,
    pub options: Vec<String>,
    pub chosen: usize,
    pub action: String,
    pub disabled: bool,
    pub shown: Vec<(usize, crate::Shown)>,
}
impl Component for SegmentedRow {
    fn contains_controls(&self) -> bool {
        true
    }
    fn body(&self, cx: &Build<'_>) -> Node {
        let count = self.options.len();
        let children = self
            .options
            .iter()
            .enumerate()
            .map(|(index, label)| {
                let mut n = Node::control(
                    cx.key(&index.to_string()),
                    label.clone(),
                    format!("{}:{index}", self.action),
                    Node::spacer(cx.key(&format!("{index}/label"))),
                )
                .role(crate::Role::Radio)
                .enabled(!self.disabled)
                .description(self.name.clone());
                if let Kind::Control(c) = &mut n.kind {
                    c.part = Some(Box::new(Part::Segment(Segment {
                        label: label.clone(),
                        group: cx.key.clone(),
                        join_before: index > 0,
                        join_after: index + 1 < count,
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
                n
            })
            .collect();
        Node::row(cx.key("body"), children)
    }
    fn configure(&self, p: Configure) -> Option<Part> {
        if let Configure::Sample(i, shown) = p {
            let mut next = self.clone();
            next.shown.push((i, shown));
            Some(Part::Segmented(next))
        } else {
            None
        }
    }
}
