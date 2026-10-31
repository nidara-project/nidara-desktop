// SPDX-License-Identifier: LGPL-3.0-or-later
//! Minimized windows' pictures (APPLICATIONS1-DOCK.md §8, "Drag sources, drops, thumbnails
//! and Trash"): one capture per minimize, only for the slots this dock shows, at most
//! MAX_PENDING at a time and BUDGET bytes kept. A window that comes back or goes loses its
//! picture; a lock wipes them all. A failed capture leaves the app's icon, never an old
//! picture. Pure bookkeeping: the dock does the capturing.
use nk_render::Raster;
use nk_wayland::CaptureId;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

pub const BUDGET: usize = 32 << 20;
pub const MAX_PENDING: usize = 8;

#[derive(Default)]
pub struct Thumbs {
    ready: HashMap<u64, Arc<Raster>>,
    pending: HashMap<CaptureId, u64>,
    failed: HashSet<u64>,
    shown: HashSet<u64>,
}

fn bytes(r: &Raster) -> usize {
    let (w, h) = r.size();
    usize::from(w) * usize::from(h) * 4
}

fn wipe(r: Arc<Raster>) {
    if let Ok(r) = Arc::try_unwrap(r) {
        r.wipe();
    }
}

impl Thumbs {
    /// The minimized windows this dock now shows (none while it is hidden: locked, or a
    /// fullscreen window). Returns the windows to capture now.
    pub fn sync(&mut self, shown: &[u64], hidden: bool) -> Vec<u64> {
        if hidden {
            self.shown.clear();
            for (_, r) in self.ready.drain() {
                wipe(r);
            }
            self.failed.clear();
            return vec![];
        }
        self.shown = shown.iter().copied().collect();
        let gone: Vec<u64> = self
            .ready
            .keys()
            .filter(|w| !self.shown.contains(w))
            .copied()
            .collect();
        for w in gone {
            if let Some(r) = self.ready.remove(&w) {
                wipe(r);
            }
        }
        self.failed.retain(|w| self.shown.contains(w));
        let asked: HashSet<u64> = self.pending.values().copied().collect();
        let room = MAX_PENDING.saturating_sub(self.pending.len());
        shown
            .iter()
            .copied()
            .filter(|w| {
                !self.ready.contains_key(w) && !self.failed.contains(w) && !asked.contains(w)
            })
            .take(room)
            .collect()
    }
    pub fn started(&mut self, id: CaptureId, window: u64) {
        self.pending.insert(id, window);
    }
    /// A capture could not start: the slot keeps the app's icon.
    pub fn refused(&mut self, window: u64) {
        self.failed.insert(window);
    }
    /// A capture's one answer. True when the picture is kept and the dock should repaint.
    pub fn finished(&mut self, id: CaptureId, picture: Option<Raster>) -> bool {
        let Some(window) = self.pending.remove(&id) else {
            return false;
        };
        let Some(picture) = picture else {
            if self.shown.contains(&window) {
                self.failed.insert(window);
            }
            return false;
        };
        let used: usize = self.ready.values().map(|r| bytes(r)).sum();
        if !self.shown.contains(&window) || used + bytes(&picture) > BUDGET {
            // Over the budget it stays the app's icon, and is not asked for again.
            if self.shown.contains(&window) {
                self.failed.insert(window);
            }
            picture.wipe();
            return false;
        }
        self.ready.insert(window, Arc::new(picture));
        true
    }
    pub fn get(&self, window: u64) -> Option<&Arc<Raster>> {
        self.ready.get(&window)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn picture(side: u16) -> Option<Raster> {
        Raster::from_rgba(
            side,
            side,
            vec![255; usize::from(side) * usize::from(side) * 4],
        )
        .ok()
    }

    #[test]
    fn one_capture_per_minimize_bounded_and_wiped_on_lock() {
        let mut t = Thumbs::default();
        assert_eq!(t.sync(&[1, 2], false), [1, 2]);
        t.started(CaptureId(10), 1);
        t.started(CaptureId(11), 2);
        assert!(
            t.sync(&[1, 2], false).is_empty(),
            "already asked: not again"
        );
        assert!(t.finished(CaptureId(10), picture(4)));
        assert!(!t.finished(CaptureId(11), None), "a failure keeps the icon");
        assert!(t.get(1).is_some() && t.get(2).is_none());
        assert!(
            t.sync(&[1, 2], false).is_empty(),
            "a failed window is not retried"
        );
        // Restored: the picture goes; minimized again later: a new capture.
        assert!(t.sync(&[2], false).is_empty());
        assert!(t.get(1).is_none());
        assert_eq!(t.sync(&[1, 2], false), [1]);
        // A capture answered after its window came back is not kept.
        t.started(CaptureId(12), 1);
        t.sync(&[2], false);
        assert!(!t.finished(CaptureId(12), picture(4)));
        // Locked: nothing kept, nothing asked.
        t.sync(&[1], false);
        t.started(CaptureId(13), 1);
        assert!(t.finished(CaptureId(13), picture(4)));
        assert!(t.sync(&[1], true).is_empty());
        assert!(t.get(1).is_none());
    }

    #[test]
    fn at_most_max_pending_and_within_the_budget() {
        let mut t = Thumbs::default();
        let many: Vec<u64> = (0..20).collect();
        let first = t.sync(&many, false);
        assert_eq!(first.len(), MAX_PENDING);
        for (n, w) in first.iter().enumerate() {
            t.started(CaptureId(n as u64), *w);
        }
        // 1024² RGBA is 4 MiB: eight fit in 32 MiB, a ninth would not.
        for n in 0..MAX_PENDING as u64 {
            assert!(t.finished(CaptureId(n), picture(1024)));
        }
        let next = t.sync(&many, false);
        t.started(CaptureId(99), next[0]);
        assert!(
            !t.finished(CaptureId(99), picture(1024)),
            "over the budget: not kept"
        );
        assert!(
            !t.sync(&many, false).contains(&next[0]),
            "and not asked for again"
        );
    }
}
