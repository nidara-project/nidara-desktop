// SPDX-License-Identifier: LGPL-3.0-or-later
//! What a screen reader is told about one dock (DOCK.md §7): a window named Dock holding one
//! button per item, in the order drawn, with its state in the description, the roving focus
//! as the focused state, and the click's own action behind Activate.
use crate::actions::{Action as Click, primary};
use crate::model::{Item, Kind};
use nk_a11y::{Action, Bounds, Node, NodeId, Role, Tree};
use std::collections::HashMap;

pub const ROOT: NodeId = 1;

/// Item keys to semantic ids: stable for as long as the dock lives, never given to another
/// item (a key that comes back gets its old id).
#[derive(Default)]
pub struct Ids {
    ids: HashMap<String, NodeId>,
    next: NodeId,
}
impl Ids {
    pub fn of(&mut self, key: &str) -> NodeId {
        if let Some(id) = self.ids.get(key) {
            return *id;
        }
        self.next = self.next.max(ROOT) + 1;
        self.ids.insert(key.to_string(), self.next);
        self.next
    }
    pub fn key(&self, id: NodeId) -> Option<&str> {
        self.ids
            .iter()
            .find(|(_, v)| **v == id)
            .map(|(k, _)| k.as_str())
    }
}

pub struct Input<'a> {
    pub items: &'a [Item],
    pub rects: &'a [[f64; 4]],
    pub size: (u32, u32),
    /// The roving focus, while the dock holds the keyboard.
    pub focus: Option<usize>,
    pub focused_window: Option<u64>,
    pub can_launch: bool,
    pub hidden: bool,
}

fn state(item: &Item, click: Option<&Click>) -> String {
    let mut words = vec![];
    match &item.kind {
        Kind::Minimized { .. } => words.push("minimized window"),
        Kind::MissingApp { .. } => words.push("not installed"),
        _ => {
            if item.running() {
                words.push("running");
            }
            if !item.minimized.is_empty() {
                words.push("has minimized windows");
            }
        }
    }
    if matches!(click, Some(Click::Unavailable)) {
        words.push("cannot be opened now");
    }
    words.join(", ")
}

pub fn tree(ids: &mut Ids, input: &Input) -> Tree {
    let mut root = Node::new(ROOT, Role::Window, "Dock");
    root.states.active = input.focus.is_some();
    root.states.hidden = input.hidden;
    root.bounds = Bounds {
        x: 0.,
        y: 0.,
        width: input.size.0 as f64,
        height: input.size.1 as f64,
    };
    let mut nodes = std::collections::BTreeMap::new();
    for (n, item) in input.items.iter().enumerate() {
        let id = ids.of(&item.key);
        let [x, y, width, height] = input.rects[n];
        let mut node = if item.kind == Kind::Separator {
            Node::new(id, Role::Separator, "")
        } else {
            let label = if item.kind == Kind::Trash {
                "Trash"
            } else {
                item.label.as_str()
            };
            let mut node = Node::new(id, Role::Button, label);
            let mut click = primary(item, input.focused_window, input.can_launch);
            // The Trash and folders open through the launch service too.
            if matches!(click, Some(Click::OpenTrash | Click::OpenFolder(_))) && !input.can_launch {
                click = Some(Click::Unavailable);
            }
            node.description = state(item, click.as_ref());
            node.states.disabled = matches!(click, None | Some(Click::Unavailable));
            node.states.focused = input.focus == Some(n);
            node.actions = vec![Action::Focus, Action::Activate];
            node
        };
        node.states.hidden = input.hidden;
        node.bounds = Bounds {
            x,
            y,
            width,
            height,
        };
        root.children.push(id);
        nodes.insert(id, node);
    }
    nodes.insert(ROOT, root);
    Tree { root: ROOT, nodes }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn item(key: &str, kind: Kind, windows: Vec<u64>) -> Item {
        Item {
            key: key.into(),
            kind,
            label: key.into(),
            windows,
            minimized: vec![],
        }
    }
    #[test]
    fn buttons_in_drawn_order_with_their_state_and_stable_ids() {
        let app = |key: &str, windows| {
            item(
                key,
                Kind::App {
                    id: format!("{key}.desktop"),
                    generation: 1,
                    launchable: false,
                    pinned: true,
                },
                windows,
            )
        };
        let items = vec![
            app("files", vec![]),
            item("separator:0", Kind::Separator, vec![]),
            app("term", vec![7]),
            item("trash", Kind::Trash, vec![]),
        ];
        let rects = vec![[0., 0., 64., 64.]; 4];
        let mut ids = Ids::default();
        let input = Input {
            items: &items,
            rects: &rects,
            size: (300, 92),
            focus: Some(2),
            focused_window: None,
            can_launch: false,
            hidden: false,
        };
        let t = tree(&mut ids, &input);
        t.validate().unwrap();
        let kids: Vec<&Node> = t.nodes[&ROOT]
            .children
            .iter()
            .map(|c| &t.nodes[c])
            .collect();
        assert_eq!(
            kids.iter().map(|n| n.role).collect::<Vec<_>>(),
            [Role::Button, Role::Separator, Role::Button, Role::Button]
        );
        assert_eq!(kids[3].name, "Trash");
        assert!(
            kids[3].states.disabled,
            "no launch service: the Trash cannot open either"
        );
        // No launch service: a closed app is said to be unavailable and is disabled; a
        // running one still focuses its window.
        assert!(kids[0].states.disabled && kids[0].description.contains("cannot be opened now"));
        assert!(!kids[2].states.disabled && kids[2].description == "running");
        assert!(kids[2].states.focused && t.nodes[&ROOT].states.active);
        // The same keys keep their ids in the next frame; a new key never takes one.
        let files = ids.of("files");
        let again = tree(
            &mut ids,
            &Input {
                focus: None,
                ..input
            },
        );
        assert_eq!(again.nodes[&ROOT].children[0], files);
        assert!(!again.nodes[&ROOT].states.active);
        assert_ne!(ids.of("new"), files);
        assert_eq!(ids.key(files), Some("files"));
    }
}
