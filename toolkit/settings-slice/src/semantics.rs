// SPDX-License-Identifier: LGPL-3.0-or-later
//! Reuse the phase-0 provider; read-only controls advertise no editing actions.
use crate::{Result, data::DEADLINE, view::Row};
use nk_a11y::{A11yBackend, Node, Role, Tree};
use std::{
    collections::BTreeMap,
    sync::{Arc, mpsc},
    time::Instant,
};
pub struct Worker {
    tx: mpsc::Sender<Update>,
    rx: mpsc::Receiver<Result<()>>,
    started: Instant,
    ready: std::cell::Cell<bool>,
}
impl Worker {
    pub fn new(rows: Vec<Row>, pages: Vec<(String, bool)>) -> Self {
        let (tx, focus) = mpsc::channel();
        let (status, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let run = || -> Result<()> {
                let mut tree = tree(rows, pages);
                let mut backend =
                    nk_a11y::atspi_backend::Backend::new(tree.clone(), Arc::new(|_| {}))?;
                backend.update(tree.clone())?;
                let _ = status.send(Ok(()));
                for update in focus {
                    match update {
                        Update::Focus(active) => {
                            tree.nodes.get_mut(&1).unwrap().states.active = active
                        }
                        Update::Model(rows, pages) => {
                            let active = tree.nodes[&1].states.active;
                            tree = self::tree(rows, pages);
                            tree.nodes.get_mut(&1).unwrap().states.active = active;
                        }
                    }
                    backend.update(tree.clone())?;
                }
                Ok(())
            };
            if let Err(e) = run() {
                let _ = status.send(Err(e));
            }
        });
        Self {
            tx,
            rx,
            started: Instant::now(),
            ready: std::cell::Cell::new(false),
        }
    }
    pub fn focus(&self, active: bool) {
        let _ = self.tx.send(Update::Focus(active));
    }
    pub fn refresh(&self, rows: Vec<Row>, pages: Vec<(String, bool)>) {
        let _ = self.tx.send(Update::Model(rows, pages));
    }
    pub fn check(&self) -> Result<()> {
        match self.rx.try_recv() {
            Ok(Ok(())) => {
                self.ready.set(true);
                eprintln!("A11Y_READY");
            }
            Ok(Err(e)) => return Err(format!("AT-SPI: {e}")),
            _ => {}
        }
        if !self.ready.get() && self.started.elapsed() > DEADLINE {
            return Err("AT-SPI setup deadline exceeded".into());
        }
        Ok(())
    }
}

enum Update {
    Focus(bool),
    Model(Vec<Row>, Vec<(String, bool)>),
}
fn tree(rows: Vec<Row>, pages: Vec<(String, bool)>) -> Tree {
    let mut root = Node::new(1, Role::Window, "Nidara Settings slice");
    let mut nodes = BTreeMap::new();
    let mut id = 2;
    for (name, selected) in pages {
        let mut n = Node::new(id, Role::Option, name);
        n.states.selected = selected;
        root.children.push(id);
        nodes.insert(id, n);
        id += 1;
    }
    for r in rows {
        let mut n = Node::new(
            id,
            if r.control == "toggle" {
                Role::CheckBox
            } else {
                Role::ComboBox
            },
            r.title,
        );
        n.description = r.subtitle;
        n.states.disabled = true;
        n.states.checked = r.value.as_bool().unwrap_or(false);
        if r.control == "segmented" {
            for (v, label) in r.options {
                id += 1;
                let mut child = Node::new(id, Role::Option, label);
                child.states.selected = v == r.value;
                n.children.push(id);
                nodes.insert(id, child);
            }
        }
        root.children.push(n.id);
        nodes.insert(n.id, n);
        id += 1;
    }
    nodes.insert(1, root);
    Tree { root: 1, nodes }
}
