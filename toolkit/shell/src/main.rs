// SPDX-License-Identifier: LGPL-3.0-or-later
//! `nidara-shell`: the supervisor (DOCK.md §2). It watches the outputs, gives each one a
//! dock on its own thread and connection, and joins a dock before anything else happens
//! to its output. The sources and the hub run on threads of their own.
use nidara_shell::{apps, bar, dock, hub, hyalo, material, prefs, shell1, trash};
use nk_wayland::{OutputEvent, OutputId, OutputInfo, Waker};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::mpsc::{Sender, channel};
use std::thread::JoinHandle;
use std::time::Duration;

const BIND_DEADLINE: Duration = Duration::from_secs(5);

struct Running {
    waker: Waker,
    thread: JoinHandle<()>,
    bar: Option<(Waker, JoinHandle<()>)>,
}

/// The bar is drawn only when asked (`--bar`, B1): until it has its panels, the TS bar
/// stays the session's.
fn bar_wanted() -> bool {
    std::env::args().any(|a| a == "--bar")
}

/// A bar on `info`'s output, on its own thread and connection.
fn start_bar(
    watch: &mut nk_wayland::OutputWatch,
    info: &OutputInfo,
    hub: &Sender<hub::HubEvent>,
    requests: &Sender<hub::Request>,
    bus: &Option<zbus::blocking::Connection>,
) -> Option<(Waker, JoinHandle<()>)> {
    let output = match watch.bind_output(info.id, BIND_DEADLINE) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("nidara-shell: no bar on {}: {e:?}", info.name);
            return None;
        }
    };
    let (waker, source) = nk_wayland::wake_channel()
        .map_err(|e| eprintln!("nidara-shell: {e}"))
        .ok()?;
    let (frames_tx, frames_rx) = channel();
    let name = info.name.clone();
    let (requests, bus) = (requests.clone(), bus.clone());
    let bar_waker = waker.clone();
    let origin = info.logical.map_or((0, 0), |l| (l[0], l[1]));
    let height = size_of(info).1;
    let thread = spawn(&format!("bar-{name}"), move || {
        let b = bar::Bar::new(
            name.clone(),
            frames_rx,
            requests,
            bus,
            bar_waker,
            origin,
            height,
        );
        if let Err(e) = bar::run(b, output, source) {
            eprintln!("nidara-shell: the bar on {name} ended: {e}");
        }
    });
    let _ = hub.send(hub::HubEvent::BarUp {
        id: info.id,
        name: info.name.clone(),
        frames: frames_tx,
        waker: waker.clone(),
    });
    Some((waker, thread))
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
    nk_icons::Icons::new("", &[], &nidara_shell::paths::icon_reference())
        .and_then(|mut i| i.get("nd-user-trash", 64))
        .map_err(|e| eprintln!("nidara-shell: no Trash icon: {e}"))
        .ok()
}

/// Settings answers `Request` on the session bus: running now, or activatable.
fn settings_reachable(conn: &zbus::blocking::Connection) -> bool {
    const NAME: &str = "org.nidara.Settings";
    let Ok(bus) = zbus::blocking::fdo::DBusProxy::new(conn) else {
        return false;
    };
    let owned = zbus::names::BusName::try_from(NAME)
        .ok()
        .and_then(|n| bus.name_has_owner(n).ok())
        .unwrap_or(false);
    owned
        || bus
            .list_activatable_names()
            .is_ok_and(|names| names.iter().any(|n| n.as_str() == NAME))
}

fn start(
    watch: &mut nk_wayland::OutputWatch,
    info: &OutputInfo,
    hub: &Sender<hub::HubEvent>,
    requests: &Sender<hub::Request>,
    tokens: &Option<Arc<serde_json::Value>>,
    trash: &Option<Arc<nk_icons::Icon>>,
    bus: &Option<zbus::blocking::Connection>,
) -> Option<Running> {
    // The bar first: the dock's room depends on the strip the bar reserves.
    let bar = if bar_wanted() {
        start_bar(watch, info, hub, requests, bus)
    } else {
        None
    };
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
    let name = info.name.clone();
    let (requests, trash, dock_waker) = (requests.clone(), trash.clone(), waker.clone());
    // Made on its own thread: what draws its popups (text shaping) stays there.
    let thread = spawn(&format!("dock-{name}"), move || {
        let d = dock::Dock::new(
            frames_rx,
            requests,
            name.clone(),
            size,
            first,
            trash,
            dock_waker,
        );
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
    Some(Running { waker, thread, bar })
}

fn main() {
    let (hub_tx, hub_rx) = channel();
    let tokens = material::load()
        .map(Arc::new)
        .map_err(|e| eprintln!("nidara-shell: no glass tokens: {e}"))
        .ok();

    static ICON_SUBSCRIPTION: std::sync::OnceLock<nidara_shell::icon_memory::Subscription> =
        std::sync::OnceLock::new();
    let mut apps_conn = None;
    match apps::connect() {
        Ok(conn) => {
            let memory = nidara_shell::icon_memory::install(conn.clone());
            let t = hub_tx.clone();
            let subscription = memory.subscribe(move || {
                let _ = t.send(hub::HubEvent::IconsChanged);
            });
            // The hub's process lifetime owns this subscription, not each surface.
            let _ = ICON_SUBSCRIPTION.set(subscription);
            apps_conn = Some(conn.clone());
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
    if bar_wanted() {
        let t = hub_tx.clone();
        spawn("notification-policy", move || {
            prefs::watch_notifications(move |p| drop(t.send(hub::HubEvent::NotificationPrefs(p))))
        });
        if let Some(conn) = apps_conn.clone() {
            let t = hub_tx.clone();
            spawn("notifications", move || {
                if let Err(e) = nidara_shell::notification_wire::watch(conn, move |u| {
                    drop(t.send(hub::HubEvent::Notifications(u)))
                }) {
                    eprintln!("nidara-shell: notification source failed: {e}");
                }
            });
        }
        if let Some(conn) = &apps_conn {
            let (tx, rx) = channel();
            nidara_shell::status::watch(conn, tx);
            let (tray_tx, tray_rx) = channel();
            nidara_shell::tray::watch(conn, tray_tx);
            let t = hub_tx.clone();
            spawn("tray-items", move || {
                for items in tray_rx {
                    if t.send(hub::HubEvent::Tray(items)).is_err() {
                        return;
                    }
                }
            });
            let t = hub_tx.clone();
            spawn("widgets", move || {
                for u in rx {
                    if t.send(hub::HubEvent::Widgets(u)).is_err() {
                        return;
                    }
                }
            });
        }
        let t = hub_tx.clone();
        spawn("control-center", move || {
            prefs::watch_cc(move |c| {
                use nidara_shell::status::Update;
                drop(t.send(match c {
                    prefs::Cc::NightSchedule(on, from, to) => {
                        hub::HubEvent::Widgets(Update::NightSchedule(on, from, to))
                    }
                    prefs::Cc::Dark(d) => hub::HubEvent::Widgets(Update::Dark(d)),
                    prefs::Cc::Night(n) => hub::HubEvent::Widgets(Update::Night(n)),
                    prefs::Cc::Layout(l) => hub::HubEvent::CcLayout(l),
                }))
            })
        });
    }
    let t = hub_tx.clone();
    spawn("region", move || {
        prefs::watch_region(move |r| drop(t.send(hub::HubEvent::Region(r))))
    });
    let settings = apps_conn.as_ref().is_some_and(settings_reachable);
    let bus = apps_conn.clone();
    let hub = hub::Hub::new(
        prefs::Prefs::default(),
        apps_conn,
        tokens.clone(),
        status,
        shell1,
    )
    .with_settings(settings)
    .with_inbox(hub_tx.clone());
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
                    if let Some(r) =
                        start(&mut watch, &info, &hub_tx, &req_tx, &tokens, &trash, &bus)
                    {
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
                    let _ = hub_tx.send(hub::HubEvent::BarDown(id));
                    if let Some(r) = docks.remove(&id) {
                        std::thread::sleep(Duration::from_millis(20));
                        let _ = r.waker.wake();
                        let _ = r.thread.join();
                        if let Some((waker, thread)) = r.bar {
                            let _ = waker.wake();
                            let _ = thread.join();
                        }
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
