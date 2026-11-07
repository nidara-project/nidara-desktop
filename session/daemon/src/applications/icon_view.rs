// SPDX-License-Identifier: GPL-3.0-or-later
//! Last atomically published icon metadata. No filesystem work under its lock.
//! Refresh builds the next catalogue on the actor; icon readers keep using the
//! committed generation until publication, then revalidate before replying.
use super::{Error, catalogue::App};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Arc, RwLock,
        atomic::{AtomicBool, Ordering},
    },
};

#[derive(Clone)]
pub struct Snapshot {
    pub epoch: u64,
    pub catalogue_revision: u64,
    pub layout_revision: u64,
    pub revision: u64,
    pub theme: String,
    pub apps: BTreeMap<String, App>,
    pub layout: BTreeSet<String>,
}
impl Snapshot {
    pub fn stamp(&self) -> (u64, u64, u64, u64) {
        (
            self.epoch,
            self.catalogue_revision,
            self.layout_revision,
            self.revision,
        )
    }
    pub fn epoch(&self, epoch: u64) -> Result<(), Error> {
        if self.epoch != epoch {
            return Err(Error::Stale("service epoch changed".into()));
        }
        Ok(())
    }
    pub fn app(&self, id: &str, generation: u64) -> Result<&App, Error> {
        let app = self
            .apps
            .get(id)
            .ok_or_else(|| Error::NotFound("app not found".into()))?;
        if app.generation != generation {
            return Err(Error::Stale("app generation changed".into()));
        }
        Ok(app)
    }
    pub fn unchanged(&self, epoch: u64, revision: u64) -> Result<(), Error> {
        self.epoch(epoch)?;
        if self.revision != revision {
            return Err(Error::Stale("icon changed during decode".into()));
        }
        Ok(())
    }
}
#[derive(Default)]
pub struct Published(RwLock<Option<Arc<Snapshot>>>, AtomicBool);
impl Published {
    pub fn get(&self) -> Result<Arc<Snapshot>, Error> {
        if self.1.load(Ordering::Acquire) {
            return Err(Error::Unavailable("catalogue worker exited".into()));
        }
        self.0
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
            .ok_or_else(|| Error::Busy("icon metadata publication in progress".into()))
    }
    pub fn publish(&self, snapshot: Snapshot) {
        let next = Arc::new(snapshot);
        *self.0.write().unwrap_or_else(|p| p.into_inner()) = Some(next);
    }
    /// Override writes change files outside the catalogue. Withdraw before the
    /// first write, so concurrent decodes cannot return uncommitted artwork.
    /// The actor republishes before returning success OR failure to its caller.
    pub fn withdraw(&self) {
        *self.0.write().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// Withdraw even when the actor exits by unwinding. A surviving service must
/// report Unavailable rather than serving its last generation indefinitely.
pub struct Lifetime(pub Arc<Published>);
impl Drop for Lifetime {
    fn drop(&mut self) {
        self.0.1.store(true, Ordering::Release);
        self.0.withdraw();
    }
}
