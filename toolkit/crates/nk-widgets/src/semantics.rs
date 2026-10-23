// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::*;
use nk_a11y::{Action, Bounds, Node as Semantic, Relation, Role, States, Tree as Semantics};
impl Tree {
    pub fn semantics(&self) -> Semantics {
        let mut ids = vec![];
        self.ordered(self.root, &mut ids);
        let mut nodes = BTreeMap::new();
        for id in ids {
            let widget = &self.nodes[&id];
            let role = match widget.kind {
                Kind::Window => Role::Window,
                Kind::Sidebar => Role::List,
                Kind::TitleBar | Kind::Label | Kind::Subtitle | Kind::Footer => Role::Label,
                Kind::Disclosure { .. } => Role::ToggleButton,
                Kind::Page { .. } => Role::Option,
                Kind::Scroll => Role::ScrollPane,
                Kind::Group
                | Kind::Row
                | Kind::Choices { .. }
                | Kind::Fields
                | Kind::ControlCapsule => Role::Panel,
                Kind::Slider { .. } => Role::Slider,
                Kind::Spin { .. } => Role::SpinButton,
                Kind::Switch { .. } => Role::ToggleButton,
                Kind::Button => Role::Button,
                Kind::SearchInput => Role::TextInput,
                Kind::Dropdown { .. } => Role::ComboBox,
                Kind::DropdownOption { .. } | Kind::MenuOption { .. } => Role::Option,
                Kind::Choice { .. } => Role::RadioButton,
            };
            let mut n = Semantic::new(id, role, &widget.name);
            if id == self.root {
                n.attributes
                    .insert("application-name".into(), widget.name.clone());
            }
            n.attributes.insert("nidara-node-id".into(), id.to_string());
            n.attributes
                .insert("nidara-tree-generation".into(), self.generation.to_string());
            let mut r = widget.bounds;
            let mut ancestor = Some(id);
            let mut sidebar = false;
            while let Some(p) = ancestor {
                sidebar |= self.nodes[&p].kind == Kind::Sidebar;
                ancestor = self.nodes[&p].parent;
            }
            if sidebar {
                // AT-SPI bounds are model values (CONTRACT.md), even on the D5
                // client timeline. Pointer/paint use the tree's sampled placement.
                let model = if self.sidebar_open {
                    0.
                } else {
                    -self.metrics.sidebar
                };
                r.x += model - self.sidebar_x;
            }
            n.bounds = Bounds {
                x: r.x as f64,
                y: r.y as f64,
                width: r.width as f64,
                height: r.height as f64,
            };
            n.states = States {
                active: id == self.root && self.active,
                focused: self.focused == Some(id),
                disabled: !self.available(id),
                checked: matches!(
                    widget.kind,
                    Kind::Switch { checked: true } | Kind::Choice { checked: true }
                ),
                selected: matches!(
                    widget.kind,
                    Kind::Page { selected: true }
                        | Kind::DropdownOption { selected: true }
                        | Kind::MenuOption { selected: true }
                ),
                expanded: matches!(
                    widget.kind,
                    Kind::Disclosure { expanded: true } | Kind::Dropdown { expanded: true }
                ),
                expandable: matches!(widget.kind, Kind::Disclosure { .. } | Kind::Dropdown { .. }),
                offscreen: !intersects(r, self.visible_clip(id)),
                ..Default::default()
            };
            n.children = widget
                .children
                .iter()
                .copied()
                .filter(|id| !self.is_hidden(*id))
                .collect();
            if let (Some(range), Some(value)) = (&widget.range, self.value(id)) {
                n.actions = vec![Action::Focus, Action::SetValue];
                n.value = Some(nk_a11y::ValueInfo {
                    min: range.min as f64,
                    max: range.max as f64,
                    current: value as f64,
                    step: range.step as f64,
                    text: range.text(value),
                });
            } else if matches!(widget.kind, Kind::DropdownOption { .. }) {
                n.actions = vec![Action::Activate];
            } else if widget.kind.focusable() {
                n.actions = vec![Action::Focus, Action::Activate];
            }
            if matches!(
                widget.kind,
                Kind::Group | Kind::Row | Kind::Disclosure { .. }
            ) && let Some(label) = n
                .children
                .iter()
                .find(|id| self.nodes[id].kind == Kind::Label)
            {
                n.relations.push(Relation::LabelledBy(*label));
                n.name = self.nodes[label].name.clone();
            }
            if widget.kind.row_control()
                && let Some(parent) = widget.parent
                && let Some(label) = self.nodes[&parent]
                    .children
                    .iter()
                    .find(|id| self.nodes[id].kind == Kind::Label && !self.is_hidden(**id))
            {
                n.relations.push(Relation::LabelledBy(*label));
                n.name = self.nodes[label].name.clone();
            }
            // A row's second line describes the row and its control (as a GTK row's subtitle).
            let row = match widget.kind {
                Kind::Row => Some(id),
                k if k.row_control() => widget.parent,
                _ => None,
            };
            if let Some(subtitle) = row.and_then(|r| {
                self.nodes[&r]
                    .children
                    .iter()
                    .find(|c| self.nodes[c].kind == Kind::Subtitle && !self.is_hidden(**c))
            }) {
                n.description = self.nodes[subtitle].name.clone();
            }
            if widget.kind == Kind::SearchInput {
                self.search_semantics(id, &mut n);
            }
            nodes.insert(id, n);
        }
        let inverse: Vec<_> = nodes
            .values()
            .flat_map(|n| {
                n.relations.iter().filter_map(|r| {
                    if let Relation::LabelledBy(label) = r {
                        Some((*label, n.id))
                    } else {
                        None
                    }
                })
            })
            .collect();
        for (label, target) in inverse {
            nodes
                .get_mut(&label)
                .unwrap()
                .relations
                .push(Relation::LabelFor(target));
        }
        Semantics {
            root: self.root,
            nodes,
        }
    }
}
