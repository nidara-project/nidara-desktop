// SPDX-License-Identifier: LGPL-3.0-or-later
use nk_a11y::{A11yBackend, Request, Tree};
use nk_widgets::Result;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
    mpsc,
};
/// Only the app thread mutates widgets. Requests carry the published generation,
/// so a queued action cannot target a subtree hidden/rebuilt since it was read.
pub struct Bridge {
    pub requests: mpsc::Receiver<(u64, Request)>,
    updates: mpsc::Sender<(u64, Tree)>,
    status: mpsc::Receiver<Result<()>>,
}
impl Bridge {
    pub fn new(generation: u64, tree: Tree) -> Self {
        let (updates, rx) = mpsc::channel();
        let (actions, requests) = mpsc::channel();
        let (status, check) = mpsc::channel();
        std::thread::spawn(move || {
            let run = || -> Result<()> {
                let version = Arc::new(AtomicU64::new(generation));
                let current = version.clone();
                let callback = Arc::new(move |request| {
                    let _ = actions.send((current.load(Ordering::Acquire), request));
                });
                let mut backend = nk_a11y::atspi_backend::Backend::new(tree.clone(), callback)?;
                backend.update(tree)?;
                eprintln!("A11Y_PUBLISHED");
                let _ = status.send(Ok(()));
                for (generation, tree) in rx {
                    // Store before publishing: the app revalidates both this
                    // generation AND target availability when it drains requests.
                    version.store(generation, Ordering::Release);
                    backend.update(tree)?;
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
            updates,
            status: check,
        }
    }
    pub fn update(&self, generation: u64, tree: Tree) -> Result<()> {
        self.updates
            .send((generation, tree))
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
