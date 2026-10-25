// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{Request, Result, Tree};
use std::sync::{Arc, mpsc};
/// Only the app thread mutates widgets. Requests carry the snapshot-bound publication revision,
/// so a queued action cannot target a subtree hidden/rebuilt since it was read.
pub struct Bridge {
    pub requests: mpsc::Receiver<(u64, Request)>,
    /// Sent only after a successful backend update, for application-side barriers.
    pub published: mpsc::Receiver<u64>,
    updates: crate::latest::Sender<(u64, Tree)>,
    status: mpsc::Receiver<Result<()>>,
}
impl Bridge {
    pub fn new(revision: u64, tree: Tree) -> Self {
        let (updates, rx) = crate::latest::channel();
        updates
            .send((revision, tree))
            .expect("new snapshot receiver");
        let (actions, requests) = mpsc::channel();
        let (status, check) = mpsc::channel();
        let (published, commits) = mpsc::channel();
        std::thread::spawn(move || {
            let run = || -> Result<()> {
                let callback = Arc::new(move |revision, request| {
                    let _ = actions.send((revision, request));
                });
                let (revision, tree) = rx.recv()?;
                let mut backend =
                    crate::atspi_backend::Backend::new_versioned(tree.clone(), revision, callback)?;
                backend.update_versioned(revision, tree)?;
                let _ = published.send(revision);
                eprintln!("A11Y_PUBLISHED");
                let _ = status.send(Ok(()));
                while let Ok((revision, tree)) = rx.recv() {
                    backend.update_versioned(revision, tree)?;
                    let _ = published.send(revision);
                    eprintln!("A11Y_PUBLISHED");
                }
                Ok(())
            };
            if let Err(e) = run() {
                let _ = status.send(Err(e));
            }
        });
        Self {
            requests,
            published: commits,
            updates,
            status: check,
        }
    }
    pub fn update(&self, revision: u64, tree: Tree) -> Result<()> {
        self.updates
            .send((revision, tree))
            .map_err(|e| e.to_string())
    }
    pub fn check(&self) -> Result<()> {
        match self.status.try_recv() {
            Ok(Ok(())) => {
                eprintln!("A11Y_READY");
                Ok(())
            }
            Ok(Err(e)) => Err(e),
            Err(mpsc::TryRecvError::Disconnected) => Err("AT-SPI worker exited".into()),
            Err(mpsc::TryRecvError::Empty) => Ok(()),
        }
    }
}
