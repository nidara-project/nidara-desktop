// SPDX-License-Identifier: LGPL-3.0-or-later
//! Whether the Trash holds anything (APPLICATIONS1-DOCK.md §8 Trash): GIO's `trash:///`,
//! every volume's Trash, when gvfs serves it; else the home Trash alone, said to be
//! partial; else nothing, and the slot says it cannot tell. Read-only: emptying is D2.
use gio::prelude::*;
use std::path::Path;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct TrashState {
    pub full: bool,
    /// Only the home Trash was looked at: other volumes' Trash may hold items too.
    pub partial: bool,
}

const COUNT: &str = "trash::item-count";

/// The state from what could be read: the item count of `trash:///` if gvfs gave one,
/// else whether the home Trash's files folder holds an entry.
pub fn state(count: Option<u32>, home: &Path) -> Option<TrashState> {
    if let Some(n) = count {
        return Some(TrashState {
            full: n > 0,
            partial: false,
        });
    }
    match std::fs::read_dir(home) {
        Ok(mut entries) => Some(TrashState {
            full: entries.next().is_some(),
            partial: true,
        }),
        // No home Trash yet is an empty one; anything else cannot be told.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Some(TrashState {
            full: false,
            partial: true,
        }),
        Err(_) => None,
    }
}

fn count(trash: &gio::File) -> Option<u32> {
    trash
        .query_info(COUNT, gio::FileQueryInfoFlags::NONE, gio::Cancellable::NONE)
        .ok()
        .filter(|info| info.has_attribute(COUNT))
        .map(|info| info.attribute_uint32(COUNT))
}

/// Runs forever on its own thread: sends the state at start and at every change.
pub fn watch(send: impl Fn(Option<TrashState>) + 'static) {
    let ctx = glib::MainContext::new();
    let _ = ctx.with_thread_default(|| {
        let trash = gio::File::for_uri("trash:///");
        let home = glib::user_data_dir().join("Trash/files");
        let gvfs = count(&trash).is_some();
        let read = {
            let (trash, home) = (trash.clone(), home.clone());
            move || state(if gvfs { count(&trash) } else { None }, &home)
        };
        let last = std::cell::Cell::new(read());
        send(last.get());
        // gvfs's trash backend reports changes on trash:/// itself; without it, the home
        // folder's own monitor (GIO watches a missing folder through its parent).
        let watched = if gvfs {
            trash
        } else {
            gio::File::for_path(&home)
        };
        let monitor =
            watched.monitor_directory(gio::FileMonitorFlags::NONE, gio::Cancellable::NONE);
        let Ok(monitor) = monitor else {
            eprintln!("nidara-shell: the Trash is not watched; its look stays as read at start");
            return;
        };
        monitor.connect_changed(move |_, _, _, _| {
            let now = read();
            if now != last.replace(now) {
                send(now);
            }
        });
        glib::MainLoop::new(Some(&ctx), false).run();
        drop(monitor);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_count_wins_and_the_home_trash_is_partial() {
        let dir = std::env::temp_dir().join(format!("nk-trash-{}", std::process::id()));
        let files = dir.join("files");
        let _ = std::fs::remove_dir_all(&dir);
        let full = |c, p| {
            Some(TrashState {
                full: c,
                partial: p,
            })
        };
        assert_eq!(state(Some(3), &files), full(true, false));
        assert_eq!(state(Some(0), &files), full(false, false));
        assert_eq!(
            state(None, &files),
            full(false, true),
            "no home Trash yet: empty"
        );
        std::fs::create_dir_all(&files).unwrap();
        assert_eq!(state(None, &files), full(false, true));
        std::fs::write(files.join("a"), b"").unwrap();
        assert_eq!(state(None, &files), full(true, true));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
