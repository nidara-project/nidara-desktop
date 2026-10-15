// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::*;
use accesskit::{self as ak, ActionHandler, ActivationHandler, DeactivationHandler};
use std::sync::Mutex;
#[derive(Clone)]
struct Projected {
    update: ak::TreeUpdate,
    runs: BTreeMap<ak::NodeId, (NodeId, usize, String)>,
}
fn project(tree: &Tree) -> Result<Projected> {
    let tree = tree.filtered(|_| true);
    tree.validate()?;
    let mut nodes = vec![];
    let mut runs = BTreeMap::new();
    for n in tree.nodes.values() {
        if n.id >= (1 << 31) {
            return Err("phase-0 AccessKit node id exceeds reserved range".into());
        }
        let role = match n.role {
            Role::Window => ak::Role::Window,
            Role::Dialog => ak::Role::Dialog,
            Role::Label => ak::Role::Label,
            Role::TextInput => ak::Role::TextInput,
            Role::Password => ak::Role::PasswordInput,
            Role::ComboBox => ak::Role::ComboBox,
            Role::Option => ak::Role::ListBoxOption,
            Role::CheckBox => ak::Role::CheckBox,
            Role::Button => ak::Role::Button,
        };
        let mut node = ak::Node::new(role);
        node.set_label(n.name.clone());
        node.set_description(n.description.clone());
        node.set_bounds(ak::Rect::new(
            n.bounds.x,
            n.bounds.y,
            n.bounds.x + n.bounds.width,
            n.bounds.y + n.bounds.height,
        ));
        if n.states.hidden {
            node.set_hidden();
        }
        if n.states.disabled {
            node.set_disabled();
        }
        if n.role == Role::CheckBox {
            node.set_toggled(if n.states.checked {
                ak::Toggled::True
            } else {
                ak::Toggled::False
            });
        }
        if n.role == Role::ComboBox {
            node.set_expanded(n.states.expanded);
        }
        if n.role == Role::Option {
            node.set_selected(n.states.selected);
        }
        if n.states.invalid {
            node.set_invalid(ak::Invalid::True);
        }
        if n.role == Role::Dialog {
            node.set_modal();
        }
        for a in &n.actions {
            node.add_action(match a {
                Action::Focus => ak::Action::Focus,
                Action::Activate => ak::Action::Click,
                Action::SetText => ak::Action::SetValue,
                Action::SetSelection => ak::Action::SetTextSelection,
            });
        }
        let mut children: Vec<_> = n.children.iter().map(|id| ak::NodeId(*id)).collect();
        if let Some(t) = &n.text {
            let converted = t.characters()?;
            let lines = if t.lines.is_empty() {
                std::iter::once(0..t.text.len()).collect()
            } else {
                t.lines.clone()
            };
            let mut positions = vec![];
            for (i, line) in lines.iter().enumerate() {
                let text = &t.text[line.clone()];
                // AT-SPI counts code points, including combining marks and ZWJ.
                let id = ak::NodeId((1 << 63) | (n.id << 24) | i as u64);
                let mut run = ak::Node::new(ak::Role::TextRun);
                run.set_value(text.to_string());
                run.set_character_lengths(
                    text.chars().map(|c| c.len_utf8() as u8).collect::<Vec<_>>(),
                );
                run.set_word_starts(
                    converted
                        .words
                        .iter()
                        .filter_map(|w| {
                            let start = character_offset(&t.text, line.start).ok()?;
                            let end = character_offset(&t.text, line.end).ok()?;
                            (w.start >= start && w.start < end)
                                .then(|| u8::try_from(w.start - start).ok())
                                .flatten()
                        })
                        .collect::<Vec<_>>(),
                );
                run.set_bounds(ak::Rect::new(
                    n.bounds.x,
                    n.bounds.y,
                    n.bounds.x + n.bounds.width,
                    n.bounds.y + n.bounds.height,
                ));
                children.push(id);
                nodes.push((id, run));
                runs.insert(id, (n.id, line.start, text.into()));
                positions.push((id, line.clone()));
            }
            let position = |byte: usize| -> ak::TextPosition {
                let (id, r) = positions
                    .iter()
                    .find(|(_, r)| r.contains(&byte))
                    .or(positions.last())
                    .unwrap();
                ak::TextPosition {
                    node: *id,
                    character_index: character_offset(
                        &t.text[r.clone()],
                        byte.saturating_sub(r.start).min(r.len()),
                    )
                    .unwrap(),
                }
            };
            node.set_text_selection(ak::TextSelection {
                anchor: position(t.anchor),
                focus: position(t.caret),
            });
        }
        node.set_children(children);
        nodes.push((ak::NodeId(n.id), node));
    }
    let mut info = ak::TreeInfo::new(ak::NodeId(tree.root));
    info.toolkit_name = Some("nk-phase0".into());
    info.toolkit_version = Some(env!("CARGO_PKG_VERSION").into());
    Ok(Projected {
        update: ak::TreeUpdate {
            nodes,
            tree: Some(info),
            tree_id: ak::TreeId::ROOT,
            focus: ak::NodeId(
                tree.nodes
                    .values()
                    .find(|n| n.states.focused)
                    .map_or(tree.root, |n| n.id),
            ),
        },
        runs,
    })
}
struct Handler {
    shared: Arc<Mutex<Projected>>,
    callback: Callback,
}
impl ActivationHandler for Handler {
    fn request_initial_tree(&mut self) -> Option<ak::TreeUpdate> {
        Some(self.shared.lock().unwrap().update.clone())
    }
}
impl DeactivationHandler for Handler {
    fn deactivate_accessibility(&mut self) {}
}
impl ActionHandler for Handler {
    fn do_action(&mut self, r: ak::ActionRequest) {
        let id = r.target_node.0;
        let request = match (r.action, r.data) {
            (ak::Action::Focus, _) => Some(Request::Focus(id)),
            (ak::Action::Click, _) => Some(Request::Activate(id)),
            (ak::Action::SetValue, Some(ak::ActionData::Value(s))) => {
                Some(Request::SetText(id, s.into()))
            }
            (ak::Action::SetTextSelection, Some(ak::ActionData::SetTextSelection(s))) => {
                let p = self.shared.lock().unwrap();
                let convert = |v: ak::TextPosition| {
                    let (owner, start, text) = p.runs.get(&v.node)?;
                    Some((*owner, start + byte_offset(text, v.character_index).ok()?))
                };
                match (convert(s.anchor), convert(s.focus)) {
                    (Some((a, start)), Some((b, end))) if a == b => {
                        Some(Request::SetSelection(a, start..end))
                    }
                    _ => None,
                }
            }
            _ => None,
        };
        if let Some(r) = request {
            (self.callback)(r);
        }
    }
}
pub struct Backend {
    adapter: accesskit_unix::Adapter,
    shared: Arc<Mutex<Projected>>,
    snapshot: Snapshot,
}
impl Backend {
    pub fn new(tree: Tree, callback: Callback) -> Result<Self> {
        let mut snapshot = Snapshot::default();
        let tree = snapshot.accept(tree)?;
        let shared = Arc::new(Mutex::new(project(&tree)?));
        let handler = || Handler {
            shared: shared.clone(),
            callback: callback.clone(),
        };
        let adapter = accesskit_unix::Adapter::new(handler(), handler(), handler());
        snapshot.tree = Some(tree);
        Ok(Self {
            adapter,
            shared,
            snapshot,
        })
    }
}
impl A11yBackend for Backend {
    fn update(&mut self, tree: Tree) -> Result<()> {
        let tree = self.snapshot.accept(tree)?;
        let projected = project(&tree)?;
        *self.shared.lock().unwrap() = projected.clone();
        self.adapter.update_if_active(|| projected.update);
        self.adapter
            .update_window_focus_state(tree.nodes.values().any(|n| n.states.focused));
        self.snapshot.tree = Some(tree);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_has_neither_value_nor_runs_or_selection() {
        let mut n = Node::new(1, Role::Password, "Password");
        n.text = Some(TextInfo {
            text: "secret日本🙂".into(),
            ..Default::default()
        });
        let p = project(&Tree {
            root: 1,
            nodes: BTreeMap::from([(1, n)]),
        })
        .unwrap();
        assert!(p.runs.is_empty());
        assert_eq!(p.update.nodes.len(), 1);
        let n = &p.update.nodes[0].1;
        assert_eq!(n.value(), None);
        assert_eq!(n.text_selection(), None);
        assert!(n.children().is_empty());
    }
}
