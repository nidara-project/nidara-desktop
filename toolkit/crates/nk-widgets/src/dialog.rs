// SPDX-License-Identifier: LGPL-3.0-or-later
//! A transient retained view in its parent's lifetime ID/publication namespace.
use crate::*;
use nk_a11y::Request;

pub struct DialogTree<'a> {
    parent: &'a mut Tree,
    view: Tree,
    launcher: NodeId,
    live: bool,
    published: Option<(u64, u64)>,
}
impl<'a> DialogTree<'a> {
    pub fn new(parent: &'a mut Tree, launcher: NodeId, title: &str) -> Result<Self> {
        if !parent.available(launcher)
            || !parent.showing(launcher)
            || !parent.nodes[&launcher].kind.focusable()
        {
            return Err("dialog launcher is not available and showing".into());
        }
        let mut view = Tree::new_at(title, parent.metrics, parent.style.clone(), parent.next)?;
        view.dialog_role = true;
        view.sidebar_open = false;
        view.leading = 0.;
        if let Some(focused) = parent.focused.take() {
            parent.invalidate(focused, Invalid::STATE);
        }
        Ok(Self {
            parent,
            view,
            launcher,
            live: true,
            published: None,
        })
    }
    pub fn view(&self) -> &Tree {
        &self.view
    }
    pub fn view_mut(&mut self) -> &mut Tree {
        &mut self.view
    }
    pub fn invalidate(&mut self) {
        self.live = false;
        self.published = None;
        if self.parent.focused == Some(self.launcher) {
            self.parent.focused = None;
            self.parent.invalidate(self.launcher, Invalid::STATE);
        }
    }
    pub fn snapshot(&mut self) -> Result<PopupSnapshot> {
        if !self.live {
            return Err("invalidated dialog".into());
        }
        let mut tree = self.parent.semantics();
        for node in tree.nodes.values_mut() {
            node.states.focused = false;
            node.states.active = false;
            node.states.disabled = true;
            node.actions.clear();
        }
        let mut view = self.view.semantics();
        // Publish keyboard focus only after the host has activated this window.
        if !view.nodes[&view.root].states.active {
            for node in view.nodes.values_mut() {
                node.states.focused = false;
            }
        }
        tree.nodes
            .get_mut(&tree.root)
            .unwrap()
            .children
            .push(view.root);
        for (id, node) in view.nodes {
            if tree.nodes.insert(id, node).is_some() {
                return Err("dialog ID collision".into());
            }
        }
        let snapshot = PopupSnapshot::new(tree)?;
        self.published = Some((snapshot.revision, self.view.generation()));
        Ok(snapshot)
    }
    pub fn request(&mut self, revision: u64, request: Request) -> Result<Effect> {
        if !self.live || self.published != Some((revision, self.view.generation())) {
            return Err("stale dialog publication".into());
        }
        match request {
            Request::Focus(id) => self.view.dispatch(self.view.target(id), Command::Focus),
            Request::Activate(id) => self.view.dispatch(self.view.target(id), Command::Activate),
            Request::SetValue(id, value) => {
                self.view.request_value(self.view.target(id), value as f32)
            }
            request @ (Request::SetText(..) | Request::SetSelection(..)) => {
                let id = match &request {
                    Request::SetText(id, _) | Request::SetSelection(id, ..) => *id,
                    _ => unreachable!(),
                };
                self.view.search_request(self.view.target(id), request)
            }
        }
    }
}
impl Drop for DialogTree<'_> {
    fn drop(&mut self) {
        self.parent.next = self.parent.next.max(self.view.next);
        self.parent.generation += 1;
        if self.live && self.parent.available(self.launcher) && self.parent.showing(self.launcher) {
            let _ = self.parent.focus(self.launcher);
        }
    }
}
