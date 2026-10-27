// SPDX-License-Identifier: GPL-3.0-or-later
//! The GLib thread the registry lives on: it owns the `gio::Settings` (not `Send`) and the
//! file monitor, runs their change notifications, and answers the D-Bus side's calls. Every
//! change of a key's home, from any writer, comes out of `changes` as (key, value).

use super::followers::Snapshot;
use super::registry::{self, Store, Value};
use gio::prelude::*;
use std::cell::RefCell;
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, oneshot};

/// Changes heard on the GLib thread, waiting to be announced. Pushed BEFORE that thread
/// answers the call that caused them, so `Apply` finds its own change here.
pub struct Changes {
    pending: Mutex<Vec<(String, Value)>>,
    pub notify: Notify,
    pub followers: tokio::sync::watch::Sender<Snapshot>,
}
impl Default for Changes {
    fn default() -> Self {
        Self {
            pending: Mutex::new(Vec::new()),
            notify: Notify::new(),
            followers: tokio::sync::watch::channel(Snapshot::default()).0,
        }
    }
}
impl Changes {
    pub fn publish(&self) {
        STORE.with(|s| {
            if let Some(st) = s.borrow().as_ref() {
                let snapshot = Snapshot::read(st);
                self.followers.send_if_modified(|old| {
                    if *old == snapshot {
                        return false;
                    }
                    *old = snapshot;
                    true
                });
            }
        });
    }
    pub(super) fn push(&self, name: &str, value: Value) {
        self.pending.lock().unwrap().push((name.to_owned(), value));
        self.notify.notify_one();
    }
    pub fn take(&self) -> Vec<(String, Value)> {
        std::mem::take(&mut self.pending.lock().unwrap())
    }
}

thread_local! {
    static STORE: RefCell<Option<Store>> = const { RefCell::new(None) };
    /// Held for the life of the thread: a monitor nobody references is collected and says
    /// nothing.
    static MONITORS: RefCell<Vec<gio::FileMonitor>> = const { RefCell::new(Vec::new()) };
}

#[derive(Clone)]
pub struct Handle {
    ctx: glib::MainContext,
}
impl Handle {
    /// `f` on the GLib thread, with the store; its answer.
    pub async fn call<R: Send + 'static>(&self, f: impl FnOnce(&Store) -> R + Send + 'static) -> R {
        let (tx, rx) = oneshot::channel();
        self.ctx.invoke(move || {
            STORE.with(|s| {
                let s = s.borrow();
                let _ = tx.send(f(s
                    .as_ref()
                    .expect("the store is set before the loop runs")));
            })
        });
        rx.await
            .expect("the GLib thread lives as long as the daemon")
    }
}

fn announce(changes: &Changes, name: &'static str) {
    STORE.with(|s| {
        if let Some(st) = s.borrow().as_ref()
            && let Some(key) = registry::find(name)
            && registry::available(st, key)
        {
            changes.push(name, registry::get(st, key));
        }
    });
    changes.publish();
}

pub fn spawn(changes: Arc<Changes>) -> Handle {
    let ctx = glib::MainContext::new();
    let thread_ctx = ctx.clone();
    std::thread::Builder::new()
        .name("config-glib".into())
        .spawn(move || {
            let ctx = thread_ctx;
            ctx.with_thread_default(|| {
                let store = Store::new();
                for key in registry::keys() {
                    for (schema, k) in key.watch {
                        if let Some(settings) =
                            store.settings(schema).filter(|_| store.has(schema, k))
                        {
                            let changes = changes.clone();
                            let name = key.name;
                            settings.connect_changed(Some(k), move |_, _| announce(&changes, name));
                        }
                    }
                }
                // Cursor size is a GSettings home even though Config1 has no picker for it.
                if store.has("org.gnome.desktop.interface", "cursor-size") {
                    let updates = changes.clone();
                    store
                        .settings("org.gnome.desktop.interface")
                        .unwrap()
                        .connect_changed(Some("cursor-size"), move |_, _| updates.publish());
                }
                // The wallpaper's file: whoever writes it (the TypeScript shell, a script).
                let file = gio::File::for_path(store.wallpaper_file());
                match file.monitor_file(gio::FileMonitorFlags::NONE, gio::Cancellable::NONE) {
                    Ok(monitor) => {
                        let changes = changes.clone();
                        monitor.connect_changed(move |_, _, _, _| {
                            for key in registry::keys().iter().filter(|k| k.file) {
                                announce(&changes, key.name);
                            }
                        });
                        MONITORS.with(|m| m.borrow_mut().push(monitor));
                    }
                    Err(e) => eprintln!("[config] cannot watch the wallpaper file: {e}"),
                }
                let idle_serial = store.idle_serial.clone();
                STORE.with(|s| *s.borrow_mut() = Some(store));
                changes.publish();
                let updates = changes.clone();
                let context = ctx.clone();
                std::thread::Builder::new()
                    .name("config-hyalo".into())
                    .spawn(move || {
                        loop {
                            let serial = idle_serial.load(std::sync::atomic::Ordering::SeqCst);
                            let idle = registry::read_idle();
                            let updates = updates.clone();
                            context.invoke(move || {
                                STORE.with(|s| {
                                    if let Some(st) = s.borrow().as_ref() {
                                        if st.idle_serial.load(std::sync::atomic::Ordering::SeqCst)
                                            != serial
                                        {
                                            return;
                                        }
                                        let before = st.idle.replace(idle);
                                        for key in registry::keys() {
                                            if let Some(field) = registry::idle_field(key.name)
                                                && before[field] != st.idle.borrow()[field]
                                                && registry::available(st, key)
                                            {
                                                updates.push(key.name, registry::get(st, key));
                                            }
                                        }
                                    }
                                })
                            });
                            std::thread::sleep(std::time::Duration::from_secs(2));
                        }
                    })
                    .expect("Hyalo settings watcher");
                glib::MainLoop::new(Some(&ctx), false).run();
            })
            .expect("a fresh context is free to own");
        })
        .expect("spawning the GLib thread");
    Handle { ctx }
}
