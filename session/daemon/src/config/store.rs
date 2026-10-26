// SPDX-License-Identifier: GPL-3.0-or-later
//! The GLib thread the registry lives on: it owns the `gio::Settings` (not `Send`) and the
//! file monitor, runs their change notifications, and answers the D-Bus side's calls. Every
//! change of a key's home, from any writer, comes out of `changes` as (key, value).

use super::registry::{self, Store, Value};
use gio::prelude::*;
use std::cell::RefCell;
use std::sync::{Arc, Mutex};
use tokio::sync::{Notify, oneshot};

/// Changes heard on the GLib thread, waiting to be announced. Pushed BEFORE that thread
/// answers the call that caused them, so `Apply` finds its own change here.
#[derive(Default)]
pub struct Changes {
    pending: Mutex<Vec<(String, Value)>>,
    pub notify: Notify,
}
impl Changes {
    fn push(&self, name: &str, value: Value) {
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
    })
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
                STORE.with(|s| *s.borrow_mut() = Some(store));
                glib::MainLoop::new(Some(&ctx), false).run();
            })
            .expect("a fresh context is free to own");
        })
        .expect("spawning the GLib thread");
    Handle { ctx }
}
