// SPDX-License-Identifier: LGPL-3.0-or-later
//! Ownership of one mounted manifest page; the caller keeps its Tree and host.
use crate::{
    manifest::Page,
    render::{Builders, Host, Rendered, Result},
};
use nk_widgets::NodeId;
use std::collections::BTreeSet;

pub struct Mounted {
    renderer: Rendered,
    roots: Vec<NodeId>,
}
impl Mounted {
    pub fn build(
        host: Host<'_>,
        page: &Page,
        builders: &mut Builders,
        content: NodeId,
        mount: u64,
    ) -> Result<Self> {
        if mount == 0 {
            return Err("page mount token must be nonzero".into());
        }
        let before: BTreeSet<_> = host
            .tree
            .node(content)
            .ok_or("missing page content")?
            .children()
            .iter()
            .copied()
            .collect();
        let renderer = Rendered::build(
            Host {
                tree: &mut *host.tree,
                editor: &mut *host.editor,
                exports: host.exports,
                styles: host.styles,
                window: None,
                modal: None,
            },
            page,
            builders,
            content,
            mount,
        )?;
        let roots = host
            .tree
            .node(content)
            .ok_or("missing page content")?
            .children()
            .iter()
            .copied()
            .filter(|id| !before.contains(id))
            .collect();
        Ok(Self { renderer, roots })
    }
    pub fn renderer(&mut self) -> &mut Rendered {
        &mut self.renderer
    }
    pub fn unmount(self, host: Host<'_>) -> Result<()> {
        let result = self.renderer.unmount(Host {
            tree: &mut *host.tree,
            editor: &mut *host.editor,
            exports: host.exports,
            styles: host.styles,
            window: None,
            modal: None,
        });
        for id in self.roots {
            if host.tree.node(id).is_some() {
                host.tree.remove(id)?;
            }
        }
        result
    }
}
