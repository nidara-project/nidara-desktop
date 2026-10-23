// SPDX-License-Identifier: LGPL-3.0-or-later
//! One semantic ComboBox across its parent surface and modal popup view.
use crate::*;
use nk_a11y::{Action, Request, Tree as Semantics};
use std::sync::Mutex;

static PUBLICATION: Mutex<u64> = Mutex::new(1);

pub struct PopupSnapshot {
    pub revision: u64,
    pub tree: Semantics,
}

/// Borrows the controlled model; popup-local IDs never escape into its provider.
pub struct DropdownPopup<'a> {
    parent: &'a mut Tree,
    combo: NodeId,
    options: Vec<NodeId>,
    menu: Tree,
    items: Vec<NodeId>,
    published: Option<(u64, u64)>,
}
impl<'a> DropdownPopup<'a> {
    pub fn new(parent: &'a mut Tree, combo: NodeId, style: MenuStyle) -> Result<Self> {
        let selected = parent.dropdown_selected(combo)?;
        if !parent.available(combo) {
            return Err("unavailable dropdown".into());
        }
        let options = parent.nodes[&combo].children.clone();
        let names: Vec<_> = options
            .iter()
            .map(|id| parent.nodes[id].name.as_str())
            .collect();
        let name = parent.semantics().nodes[&combo].name.clone();
        let (mut menu, items) = Tree::menu_list(
            &name,
            parent.metrics,
            parent.style.clone(),
            style,
            &names,
            selected,
        )?;
        for (option, item) in options.iter().zip(&items) {
            menu.set_disabled(*item, !parent.available(*option))?;
        }
        // No parent mutation on construction failure.
        let focus = Some(items[selected])
            .filter(|item| menu.available(*item))
            .or_else(|| items.iter().copied().find(|item| menu.available(*item)));
        if let Some(item) = focus {
            menu.focus(item)?;
        }
        parent.set_dropdown_expanded(combo, true)?;
        Ok(Self {
            parent,
            combo,
            options,
            menu,
            items,
            published: None,
        })
    }
    pub fn menu(&self) -> &Tree {
        &self.menu
    }
    pub fn menu_mut(&mut self) -> &mut Tree {
        &mut self.menu
    }
    pub fn index(&self, item: NodeId) -> Option<usize> {
        self.items.iter().position(|id| *id == item)
    }
    fn validate(&self) -> Result<()> {
        if self.items.iter().any(|id| {
            !self
                .menu
                .nodes
                .get(id)
                .is_some_and(|n| matches!(n.kind, Kind::MenuOption { .. }))
        }) {
            return Err("popup option removed or replaced".into());
        }
        Ok(())
    }
    /// Origin is the actual configured popup location relative to the parent window.
    pub fn snapshot(&mut self, origin: Point) -> Result<PopupSnapshot> {
        self.validate()?;
        if !origin.x.is_finite() || !origin.y.is_finite() {
            return Err("nonfinite popup origin".into());
        }
        let mut tree = self.parent.semantics();
        let view = self.menu.semantics();
        for n in tree.nodes.values_mut() {
            n.states.focused = false;
            n.actions.clear();
        }
        for (option, item) in self.options.iter().zip(&self.items) {
            let n = tree.nodes.get_mut(option).ok_or("missing parent option")?;
            n.states.hidden |= self.menu.is_hidden(*item);
            if let Some(v) = view.nodes.get(item) {
                n.bounds = v.bounds;
                n.bounds.x += f64::from(origin.x);
                n.bounds.y += f64::from(origin.y);
                n.states.focused = v.states.focused;
                n.states.disabled |= v.states.disabled;
                n.states.offscreen = v.states.offscreen;
            } else {
                n.bounds = Default::default();
                n.states.offscreen = true;
            }
            if !n.states.disabled && !n.states.hidden {
                n.actions = vec![Action::Focus, Action::Activate];
            }
        }
        tree.validate()?;
        let mut next = PUBLICATION
            .lock()
            .map_err(|_| "popup revision lock poisoned")?;
        let revision = *next;
        *next = next
            .checked_add(1)
            .ok_or("popup publication revision exhausted")?;
        self.published = Some((revision, self.menu.generation()));
        Ok(PopupSnapshot { revision, tree })
    }
    pub fn request(&mut self, revision: u64, request: Request) -> Result<Effect> {
        self.validate()?;
        if self.published != Some((revision, self.menu.generation())) {
            return Err("stale popup publication".into());
        }
        let (id, command) = match request {
            Request::Focus(id) => (id, Command::Focus),
            Request::Activate(id) => (id, Command::Activate),
            _ => return Err("unsupported popup request".into()),
        };
        let index = self
            .options
            .iter()
            .position(|v| *v == id)
            .ok_or("request outside modal options")?;
        let item = self.items[index];
        self.menu.dispatch(self.menu.target(item), command)
    }
    /// A host calls this only for an activated item; None is Escape/PopupDone.
    pub fn finish(mut self, selected: Option<usize>) -> Result<Effect> {
        self.published = None;
        self.validate()?;
        match selected {
            Some(index) => {
                let option = *self
                    .options
                    .get(index)
                    .ok_or("popup selection outside options")?;
                let item = self.items[index];
                if !self.menu.available(item) {
                    return Err("unavailable popup option".into());
                }
                self.parent
                    .dispatch(self.parent.target(option), Command::Activate)
            }
            None => Ok(Effect::None),
        }
    }
}
impl Drop for DropdownPopup<'_> {
    fn drop(&mut self) {
        let _ = self.parent.set_dropdown_expanded(self.combo, false);
        if self.parent.available(self.combo) {
            let _ = self.parent.focus(self.combo);
        }
    }
}
