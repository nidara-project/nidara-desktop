// SPDX-License-Identifier: LGPL-3.0-or-later
//! Applications1, read for the dock (DOCK.md §3, APPLICATIONS1-DOCK.md §2): subscribe to
//! Changed and the owner first, then the snapshot and its pages; a newer revision that
//! arrived meanwhile rereads. Icons come on demand from their own worker. Every call has
//! the connection's deadline; a failure is an explicit Unavailable, never an empty dock.
use crate::model::{App, Pin};
use std::collections::HashMap;
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::time::{Duration, Instant};
use zbus::blocking::{Connection, MessageIterator};
use zbus::zvariant::OwnedValue;
use zbus::{MatchRule, message::Type};

pub const DEST: &str = "org.nidara.Applications";
pub const PATH: &str = "/org/nidara/Applications";
pub const IFACE: &str = "org.nidara.Applications1";
pub const DEADLINE: Duration = Duration::from_secs(2);
/// The layout token of the dynamic Files pin (APPLICATIONS1-DOCK.md §6).
pub const DEFAULT_DIRECTORY: &str = "default-handler:inode/directory";

type Dict = HashMap<String, OwnedValue>;

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AppsState {
    pub epoch: u64,
    pub revision: u64,
    pub apps: Vec<App>,
    pub pins: Vec<Pin>,
    pub default_directory: Option<String>,
    pub capabilities: Vec<String>,
    pub icon_revision: u64,
}
impl AppsState {
    pub fn can(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum AppsUpdate {
    State(AppsState),
    Unavailable(String),
}

/// An icon job: (epoch, DesktopId, generation, logical size, scale).
#[derive(Clone, Debug, PartialEq)]
pub struct IconJob {
    pub epoch: u64,
    pub id: String,
    pub generation: u64,
    pub logical: u32,
    pub scale: f64,
}
/// Straight-alpha RGBA, as the service sends it.
#[derive(Clone, Debug, PartialEq)]
pub struct Icon {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

pub fn connect() -> Result<Connection, String> {
    zbus::blocking::connection::Builder::session()
        .and_then(|b| b.method_timeout(DEADLINE).build())
        .map_err(|e| e.to_string())
}

enum Poke {
    Changed { epoch: u64, revision: u64 },
    Owner(String),
}

/// Runs forever on its own thread: every state change goes to `emit`.
pub fn watch(conn: Connection, emit: impl Fn(AppsUpdate) + Send + 'static) {
    let (tx, rx) = channel();
    if let Err(e) = subscribe(&conn, tx) {
        emit(AppsUpdate::Unavailable(format!(
            "cannot subscribe to Applications1: {e}"
        )));
        return;
    }
    run(&rx, || snapshot(&conn), emit);
}

fn subscribe(conn: &Connection, tx: Sender<Poke>) -> zbus::Result<()> {
    let changed = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface(IFACE)?
        .member("Changed")?
        .path(PATH)?
        .build();
    let owner = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender("org.freedesktop.DBus")?
        .interface("org.freedesktop.DBus")?
        .member("NameOwnerChanged")?
        .add_arg(DEST)?
        .build();
    // Both iterators exist before the first snapshot is read: nothing is missed between.
    let changed = MessageIterator::for_match_rule(changed, conn, Some(64))?;
    let owner = MessageIterator::for_match_rule(owner, conn, Some(16))?;
    let t = tx.clone();
    std::thread::Builder::new()
        .name("apps-changed".into())
        .spawn(move || {
            for m in changed.flatten() {
                if let Ok((epoch, revision, _)) = m.body().deserialize::<(u64, u64, Vec<String>)>()
                    && t.send(Poke::Changed { epoch, revision }).is_err()
                {
                    return;
                }
            }
        })?;
    std::thread::Builder::new()
        .name("apps-owner".into())
        .spawn(move || {
            for m in owner.flatten() {
                if let Ok((_, _, new)) = m.body().deserialize::<(String, String, String)>()
                    && tx.send(Poke::Owner(new)).is_err()
                {
                    return;
                }
            }
        })?;
    Ok(())
}

/// The hydration rules, apart from the bus so they can be tested with a fake reader.
fn run(
    rx: &Receiver<Poke>,
    mut read: impl FnMut() -> Result<AppsState, String>,
    emit: impl Fn(AppsUpdate),
) {
    let mut known: Option<(u64, u64)> = None;
    let mut retry: Option<Instant> = Some(Instant::now());
    let mut backoff = Duration::from_secs(1);
    loop {
        let poke = match retry {
            Some(at) => match rx.recv_timeout(at.saturating_duration_since(Instant::now())) {
                Ok(p) => Some(p),
                Err(RecvTimeoutError::Timeout) => None,
                Err(RecvTimeoutError::Disconnected) => return,
            },
            None => match rx.recv() {
                Ok(p) => Some(p),
                Err(_) => return,
            },
        };
        match poke {
            // Already seen, or from an owner we no longer read: nothing to do.
            Some(Poke::Changed { epoch, revision })
                if known.is_some_and(|(e, r)| e != epoch || r >= revision) && retry.is_none() =>
            {
                continue;
            }
            Some(Poke::Owner(new)) if new.is_empty() => {
                known = None;
                retry = None;
                emit(AppsUpdate::Unavailable("Applications1 has no owner".into()));
                continue;
            }
            // A new owner, a newer revision, or a retry: read again.
            _ => {}
        }
        match read() {
            Ok(state) => {
                known = Some((state.epoch, state.revision));
                retry = None;
                backoff = Duration::from_secs(1);
                emit(AppsUpdate::State(state));
            }
            Err(e) => {
                known = None;
                retry = Some(Instant::now() + backoff);
                backoff = (backoff * 2).min(Duration::from_secs(60));
                emit(AppsUpdate::Unavailable(e));
            }
        }
    }
}

fn call<B: serde::Serialize + zbus::zvariant::DynamicType, R>(
    conn: &Connection,
    method: &str,
    body: &B,
) -> Result<R, String>
where
    R: for<'d> zbus::zvariant::DynamicDeserialize<'d>,
{
    conn.call_method(Some(DEST), PATH, Some(IFACE), method, body)
        .and_then(|m| m.body().deserialize::<R>())
        .map_err(|e| format!("{method}: {e}"))
}

fn snapshot(conn: &Connection) -> Result<AppsState, String> {
    let props = zbus::blocking::Proxy::new(conn, DEST, PATH, IFACE).map_err(|e| e.to_string())?;
    let capabilities: Vec<String> = props
        .get_property("Capabilities")
        .map_err(|e| e.to_string())?;
    let (epoch, revision, state): (u64, u64, Dict) = call(conn, "GetSnapshot", &())?;
    let mut apps: Vec<Dict> = records(&state, "Apps");
    let mut next = text(&state, "AppsNext");
    let first = next.clone();
    let mut pages = 0;
    while !next.is_empty() {
        pages += 1;
        if pages > 128 {
            return Err("Applications1 snapshot has too many pages".into());
        }
        let (page, token): (Vec<Dict>, String) =
            call(conn, "ReadSnapshotPage", &(epoch, next.as_str()))?;
        apps.extend(page);
        next = token;
    }
    if !first.is_empty() {
        let _: () = call(conn, "CloseSnapshot", &(epoch, first.as_str()))?;
    }
    Ok(parse(epoch, revision, &state, &apps, capabilities))
}

fn parse(
    epoch: u64,
    revision: u64,
    state: &Dict,
    apps: &[Dict],
    capabilities: Vec<String>,
) -> AppsState {
    let apps = apps
        .iter()
        .map(|a| App {
            id: text(a, "DesktopId"),
            generation: number(a, "Generation"),
            name: text(a, "Name"),
            startup_wm_class: text(a, "StartupWMClass"),
            flatpak_id: if text(a, "Origin") == "flatpak" {
                text(a, "OriginId")
            } else {
                String::new()
            },
            launchable: flag(a, "Launchable"),
        })
        .filter(|a| !a.id.is_empty())
        .collect();
    let pins = records(state, "Layout")
        .iter()
        .filter_map(|e| {
            let key = text(e, "Key");
            match text(e, "Kind").as_str() {
                "folder" => Some(Pin::Folder {
                    key,
                    uri: text(e, "Uri"),
                    name: text(e, "Name"),
                }),
                "app" if key == DEFAULT_DIRECTORY && text(e, "DesktopId").is_empty() => {
                    Some(Pin::DefaultDirectory { key })
                }
                "app" => Some(Pin::App {
                    key,
                    id: text(e, "DesktopId"),
                }),
                _ => None,
            }
        })
        .collect();
    let default = text(state, "DefaultDirectoryApp");
    AppsState {
        epoch,
        revision,
        apps,
        pins,
        default_directory: (!default.is_empty()).then_some(default),
        capabilities,
        icon_revision: number(state, "IconRevision"),
    }
}

fn text(d: &Dict, key: &str) -> String {
    d.get(key)
        .and_then(|v| <&str>::try_from(v).ok())
        .unwrap_or_default()
        .to_string()
}
fn number(d: &Dict, key: &str) -> u64 {
    d.get(key)
        .and_then(|v| u64::try_from(v).ok())
        .unwrap_or_default()
}
fn flag(d: &Dict, key: &str) -> bool {
    d.get(key)
        .and_then(|v| bool::try_from(v).ok())
        .unwrap_or_default()
}
fn records(d: &Dict, key: &str) -> Vec<Dict> {
    d.get(key)
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| Vec::<Dict>::try_from(v).ok())
        .unwrap_or_default()
}

/// The service's bounds (APPLICATIONS1-DOCK.md §2 GetIcon): 16..512 logical, scale 1..4.
/// Below 16 the dock asks for 16 and scales the art down itself.
pub fn icon_request(logical: f64, scale: f64) -> (u32, f64) {
    ((logical.ceil() as u32).clamp(16, 512), scale.clamp(1., 4.))
}

/// Runs forever on its own thread: one GetIcon per job, in order.
pub fn icons(
    conn: Connection,
    jobs: Receiver<IconJob>,
    done: impl Fn(IconJob, Option<Icon>) + Send + 'static,
) {
    for job in jobs {
        let (logical, scale) = icon_request(job.logical as f64, job.scale);
        let icon = call::<_, (String, u32, u32, Vec<u8>)>(
            &conn,
            "GetIcon",
            &(job.epoch, job.id.as_str(), job.generation, logical, scale),
        )
        .ok()
        .filter(|(_, w, h, rgba)| *w > 0 && *h > 0 && rgba.len() == *w as usize * *h as usize * 4)
        .map(|(_, width, height, rgba)| Icon {
            width,
            height,
            rgba,
        });
        done(job, icon);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use zbus::zvariant::{Str, Value};

    fn v<'a>(x: impl Into<Value<'a>>) -> OwnedValue {
        OwnedValue::try_from(x.into()).unwrap()
    }
    fn dict(pairs: &[(&str, OwnedValue)]) -> Dict {
        pairs
            .iter()
            .map(|(k, x)| (k.to_string(), x.try_clone().unwrap()))
            .collect()
    }

    #[test]
    fn records_become_apps_and_pins() {
        let app = dict(&[
            ("DesktopId", v("org.gnome.Maps.desktop")),
            ("Generation", v(4u64)),
            ("Name", v("Maps")),
            ("StartupWMClass", v("")),
            ("Origin", v("flatpak")),
            ("OriginId", v("org.gnome.Maps")),
            ("Launchable", v(false)),
        ]);
        let layout: Vec<Dict> = vec![
            dict(&[
                ("Key", v(DEFAULT_DIRECTORY)),
                ("Kind", v("app")),
                ("DesktopId", v("")),
            ]),
            dict(&[
                ("Key", v("app:foot.desktop")),
                ("Kind", v("app")),
                ("DesktopId", v("foot.desktop")),
            ]),
            dict(&[
                ("Key", v("folder:file:///d")),
                ("Kind", v("folder")),
                ("Uri", v("file:///d")),
                ("Name", v("d")),
            ]),
        ];
        let state = dict(&[
            ("Layout", OwnedValue::try_from(Value::from(layout)).unwrap()),
            ("DefaultDirectoryApp", v(Str::from(""))),
            ("IconRevision", v(9u64)),
        ]);
        let s = parse(3, 7, &state, &[app], vec!["catalogue".into()]);
        assert_eq!(s.apps[0].flatpak_id, "org.gnome.Maps");
        assert_eq!((s.apps[0].generation, s.apps[0].launchable), (4, false));
        assert_eq!(
            s.pins,
            [
                Pin::DefaultDirectory {
                    key: DEFAULT_DIRECTORY.into()
                },
                Pin::App {
                    key: "app:foot.desktop".into(),
                    id: "foot.desktop".into()
                },
                Pin::Folder {
                    key: "folder:file:///d".into(),
                    uri: "file:///d".into(),
                    name: "d".into()
                },
            ]
        );
        assert_eq!((s.default_directory.as_deref(), s.icon_revision), (None, 9));
        assert!(!s.can("launch"));
    }

    fn state(epoch: u64, revision: u64) -> AppsState {
        AppsState {
            epoch,
            revision,
            ..Default::default()
        }
    }

    #[test]
    fn hydration_rereads_only_for_news_and_reports_loss() {
        let (tx, rx) = channel();
        let reads = RefCell::new(vec![Ok(state(1, 5)), Ok(state(1, 6)), Ok(state(2, 1))]);
        let seen = RefCell::new(vec![]);
        // Queued while the first snapshot is read: one older, one equal, one newer.
        tx.send(Poke::Changed {
            epoch: 1,
            revision: 4,
        })
        .unwrap();
        tx.send(Poke::Changed {
            epoch: 1,
            revision: 5,
        })
        .unwrap();
        tx.send(Poke::Changed {
            epoch: 1,
            revision: 6,
        })
        .unwrap();
        tx.send(Poke::Owner(String::new())).unwrap();
        tx.send(Poke::Owner(":1.9".into())).unwrap();
        drop(tx);
        run(
            &rx,
            || reads.borrow_mut().remove(0),
            |u| seen.borrow_mut().push(u),
        );
        assert_eq!(
            seen.into_inner(),
            [
                AppsUpdate::State(state(1, 5)),
                AppsUpdate::State(state(1, 6)),
                AppsUpdate::Unavailable("Applications1 has no owner".into()),
                AppsUpdate::State(state(2, 1)),
            ]
        );
        assert!(reads.into_inner().is_empty());
    }

    #[test]
    fn a_failed_read_is_unavailable_then_retried() {
        let (tx, rx) = channel::<Poke>();
        let reads = RefCell::new(vec![Err("no".to_string()), Ok(state(1, 1))]);
        let seen = RefCell::new(vec![]);
        let t = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(1500));
            drop(tx);
        });
        run(
            &rx,
            || reads.borrow_mut().remove(0),
            |u| seen.borrow_mut().push(u),
        );
        t.join().unwrap();
        assert_eq!(
            seen.into_inner(),
            [
                AppsUpdate::Unavailable("no".into()),
                AppsUpdate::State(state(1, 1))
            ]
        );
    }

    #[test]
    fn icon_sizes_stay_inside_the_service_bounds() {
        assert_eq!(icon_request(64., 1.25), (64, 1.25));
        assert_eq!(icon_request(3.2, 1.), (16, 1.));
        assert_eq!(icon_request(900., 9.), (512, 4.));
        assert_eq!(icon_request(63.2, 0.5), (64, 1.));
    }
}
