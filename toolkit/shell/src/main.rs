// SPDX-License-Identifier: LGPL-3.0-or-later
//! `nidara-shell`: the supervisor (DOCK.md §2). It watches the outputs, gives each one a
//! dock on its own thread and connection, and joins a dock before anything else happens
//! to its output. The sources and the hub run on threads of their own.
use nidara_shell::{apps, dock, hub, hyalo, material, prefs, shell1, trash};
use nk_wayland::{OutputEvent, OutputId, OutputInfo, Waker};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;
use std::time::Duration;

const BIND_DEADLINE: Duration = Duration::from_secs(5);

struct Running {
    waker: Waker,
    thread: JoinHandle<()>,
}

fn size_of(info: &OutputInfo) -> (u32, u32) {
    match info.logical {
        Some([_, _, w, h]) if w > 0 && h > 0 => (w as u32, h as u32),
        _ => {
            eprintln!(
                "nidara-shell: {} has no logical size; assuming 1920x1080",
                info.name
            );
            (1920, 1080)
        }
    }
}

fn spawn<T: Send + 'static>(name: &str, f: impl FnOnce() -> T + Send + 'static) -> JoinHandle<T> {
    std::thread::Builder::new()
        .name(name.into())
        .spawn(f)
        .expect("a thread")
}

fn trash_icon() -> Option<Arc<nk_icons::Icon>> {
    let reference = std::env::var_os("NK_ICON_REFERENCE")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let installed = PathBuf::from("/usr/share/nidara/ui/shell/assets/icons/nidara");
            if installed.is_dir() {
                installed
            } else {
                PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../ui/shell/assets/icons/nidara")
            }
        });
    nk_icons::Icons::new("", &[], &reference)
        .and_then(|mut i| i.get("nd-user-trash", 64))
        .map_err(|e| eprintln!("nidara-shell: no Trash icon: {e}"))
        .ok()
}

fn start(
    watch: &mut nk_wayland::OutputWatch,
    info: &OutputInfo,
    hub: &Sender<hub::HubEvent>,
    requests: &Sender<hub::Request>,
    tokens: &Option<Arc<serde_json::Value>>,
    trash: &Option<Arc<nk_icons::Icon>>,
) -> Option<Running> {
    let output = match watch.bind_output(info.id, BIND_DEADLINE) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("nidara-shell: no dock on {}: {e:?}", info.name);
            return None;
        }
    };
    let (waker, source) = nk_wayland::wake_channel()
        .map_err(|e| eprintln!("nidara-shell: {e}"))
        .ok()?;
    let (frames_tx, frames_rx) = channel();
    let size = size_of(info);
    let first = Arc::new(hub::Frame::empty(prefs::Prefs::default(), tokens.clone()));
    let d = dock::Dock::new(
        frames_rx,
        requests.clone(),
        info.name.clone(),
        size,
        first,
        trash.clone(),
        waker.clone(),
    );
    let name = info.name.clone();
    let thread = spawn(&format!("dock-{name}"), move || {
        if let Err(e) = dock::run(d, output, source) {
            eprintln!("nidara-shell: the dock on {name} ended: {e}");
        }
    });
    let _ = hub.send(hub::HubEvent::DockUp {
        id: info.id,
        name: info.name.clone(),
        size,
        scale: info.scale.max(1) as f64,
        frames: frames_tx,
        waker: waker.clone(),
    });
    Some(Running { waker, thread })
}

fn main() {
    let (hub_tx, hub_rx) = channel();
    let tokens = material::load()
        .map(Arc::new)
        .map_err(|e| eprintln!("nidara-shell: no glass tokens: {e}"))
        .ok();

    let mut icon_jobs = None;
    let mut apps_conn = None;
    match apps::connect() {
        Ok(conn) => {
            let (jobs_tx, jobs_rx) = channel();
            icon_jobs = Some(jobs_tx);
            apps_conn = Some(conn.clone());
            let (t, c) = (hub_tx.clone(), conn.clone());
            spawn("apps-icons", move || {
                apps::icons(c, jobs_rx, move |job, icon| {
                    drop(t.send(hub::HubEvent::Icon(job, icon)))
                })
            });
            let t = hub_tx.clone();
            spawn("apps", move || {
                apps::watch(conn, move |u| drop(t.send(hub::HubEvent::Apps(u))))
            });
        }
        Err(e) => eprintln!("nidara-shell: no session bus: {e}"),
    }
    let t = hub_tx.clone();
    spawn("hyalo", move || {
        hyalo::watch(move |u| drop(t.send(hub::HubEvent::Hyalo(u))))
    });
    let t = hub_tx.clone();
    spawn("prefs", move || {
        prefs::watch(move |p| drop(t.send(hub::HubEvent::Prefs(p))))
    });
    let status = Arc::new(shell1::Status::default());
    let shell1 = shell1::serve(status.clone(), hub_tx.clone())
        .map_err(|e| eprintln!("nidara-shell: Shell1 not served: {e}"))
        .ok();
    let hub = hub::Hub::new(
        prefs::Prefs::default(),
        icon_jobs,
        apps_conn,
        tokens.clone(),
        status,
        shell1,
    );
    spawn("hub", move || hub.run(hub_rx));
    let t = hub_tx.clone();
    spawn("trash", move || {
        trash::watch(move |state| {
            let _ = t.send(hub::HubEvent::Trash(state));
        })
    });
    let (req_tx, req_rx) = channel();
    let t = hub_tx.clone();
    spawn("requests", move || {
        for r in req_rx {
            if t.send(hub::HubEvent::Request(r)).is_err() {
                return;
            }
        }
    });

    let trash = trash_icon();
    let mut watch = match nk_wayland::outputs(Duration::from_secs(5)) {
        Ok(w) => w,
        Err(e) => {
            eprintln!("nidara-shell: no outputs: {e}");
            std::process::exit(1);
        }
    };
    let mut docks: HashMap<OutputId, Running> = HashMap::new();
    loop {
        let events = match watch.next(None) {
            Ok(e) => e,
            Err(e) => {
                eprintln!("nidara-shell: {e}");
                std::process::exit(1);
            }
        };
        for event in events {
            match event {
                OutputEvent::Added(info) => {
                    if let Some(r) = start(&mut watch, &info, &hub_tx, &req_tx, &tokens, &trash) {
                        docks.insert(info.id, r);
                    }
                }
                OutputEvent::Changed(info) => {
                    let _ = hub_tx.send(hub::HubEvent::DockChanged {
                        id: info.id,
                        name: info.name.clone(),
                        size: size_of(&info),
                        scale: info.scale.max(1) as f64,
                    });
                }
                OutputEvent::Removed(id) => {
                    // The hub lets go of its frames, the dock sees that on its wake and
                    // closes; joined before any later event is handled.
                    let _ = hub_tx.send(hub::HubEvent::DockDown(id));
                    if let Some(r) = docks.remove(&id) {
                        std::thread::sleep(Duration::from_millis(20));
                        let _ = r.waker.wake();
                        let _ = r.thread.join();
                    }
                }
                OutputEvent::Lost(why) => {
                    eprintln!("nidara-shell: the compositor went away: {why}");
                    std::process::exit(1);
                }
            }
        }
    }
}
