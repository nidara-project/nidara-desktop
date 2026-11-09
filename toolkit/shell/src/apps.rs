// SPDX-License-Identifier: LGPL-3.0-or-later
//! Applications1, read for the dock (DOCK.md §3, APPLICATIONS1-DOCK.md §2): subscribe to
//! Changed and the owner first, then the snapshot and its pages; a newer revision that
//! arrived meanwhile rereads. Icons come on demand through the shared icon memory. Every call has
//! the connection's deadline; a failure is an explicit Unavailable, never an empty dock.
use crate::model::{App, Autostart, DesktopAction, Launcher, Pin};
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
    pub owner: String,
    pub hyalo_epoch: String,
    pub matching_available: bool,
    pub window_matches: HashMap<u64, String>,
    pub epoch: u64,
    pub revision: u64,
    pub apps: Vec<App>,
    pub pins: Vec<Pin>,
    pub default_directory: Option<String>,
    pub capabilities: Vec<String>,
    pub icon_revision: u64,
    /// EditLayout's compare-and-swap token.
    pub layout_revision: u64,
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

/// The Trash's art travels as two pseudo-ids beside the apps' (no DesktopId has this
/// shape: they end in `.desktop`), fetched with GetTrashIcon instead of GetIcon.
pub const TRASH_EMPTY: &str = "trash:empty";
pub const TRASH_FULL: &str = "trash:full";

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

/// The ids Applications1's Search ranks for `query` (its tiers, APPLICATIONS1-DOCK.md §3),
/// best first, at most `limit` (1..=100). Asked against the catalogue revision it has now;
/// a catalogue that changed between the two is asked again, once.
pub fn search(
    conn: &Connection,
    epoch: u64,
    query: &str,
    limit: u32,
) -> Result<Vec<String>, String> {
    let props = zbus::blocking::Proxy::new(conn, DEST, PATH, IFACE).map_err(|e| e.to_string())?;
    let mut last = String::new();
    for _ in 0..2 {
        let revision: u64 = props
            .get_property("CatalogueRevision")
            .map_err(|e| e.to_string())?;
        match call::<_, (u64, Vec<Dict>)>(
            conn,
            "Search",
            &(epoch, revision, query, limit.clamp(1, 100), false),
        ) {
            Ok((_, records)) => {
                return Ok(records
                    .iter()
                    .map(|r| text(r, "DesktopId"))
                    .filter(|id| !id.is_empty())
                    .collect());
            }
            Err(e) => last = e,
        }
    }
    Err(last)
}

fn snapshot(conn: &Connection) -> Result<AppsState, String> {
    let owner = || -> Result<String, String> {
        conn.call_method(
            Some("org.freedesktop.DBus"),
            "/org/freedesktop/DBus",
            Some("org.freedesktop.DBus"),
            "GetNameOwner",
            &(DEST,),
        )
        .and_then(|r| r.body().deserialize())
        .map_err(|e| e.to_string())
    };
    let before = owner()?;
    let mut state = snapshot_data(conn)?;
    if before != owner()? {
        return Err("Applications1 owner changed during hydration".into());
    }
    state.owner = before;
    Ok(state)
}
fn snapshot_data(conn: &Connection) -> Result<AppsState, String> {
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
    let mut matching = records(&state, "WindowMatches");
    let mut next = text(&state, "WindowMatchesNext");
    let matching_first = next.clone();
    while !next.is_empty() {
        pages += 1;
        if pages > 256 {
            return Err("Applications1 snapshot has too many pages".into());
        }
        let (page, token): (Vec<Dict>, String) =
            call(conn, "ReadSnapshotPage", &(epoch, next.as_str()))?;
        matching.extend(page);
        next = token;
    }
    let close = if first.is_empty() {
        &matching_first
    } else {
        &first
    };
    if !close.is_empty() {
        let _: () = call(conn, "CloseSnapshot", &(epoch, close.as_str()))?;
    }
    let mut parsed = parse(epoch, revision, &state, &apps, capabilities);
    parsed.window_matches = matching
        .iter()
        .filter_map(|m| {
            let id = number(m, "WindowId");
            let app = text(m, "DesktopId");
            (text(m, "HyaloEpoch") == parsed.hyalo_epoch).then_some((id, app))
        })
        .collect();
    Ok(parsed)
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
            raw_icon: text(a, "RawIcon"),
            generation: number(a, "Generation"),
            name: text(a, "Name"),
            startup_wm_class: text(a, "StartupWMClass"),
            flatpak_id: if text(a, "Origin") == "flatpak" {
                text(a, "OriginId")
            } else {
                String::new()
            },
            launchable: flag(a, "Launchable"),
            opens: flag(a, "SupportsFileDrop"),
            mime_types: a
                .get("MimeTypes")
                .and_then(|v| Vec::<String>::try_from(v.try_clone().ok()?).ok())
                .unwrap_or_default(),
            new_window: matches!(
                text(a, "NewWindowMode").as_str(),
                "declared-action" | "relaunch"
            ),
            actions: records(a, "Actions")
                .iter()
                .map(|d| DesktopAction {
                    id: text(d, "Id"),
                    name: text(d, "Name"),
                })
                .filter(|d| !d.id.is_empty() && !d.name.is_empty())
                .collect(),
            autostart: dict(a, "Autostart")
                .map(|d| Autostart {
                    available: flag(&d, "Available"),
                    writable: flag(&d, "Writable"),
                    enabled: flag(&d, "Enabled"),
                })
                .unwrap_or_default(),
            launcher: dict(a, "Launcher")
                .map(|d| launcher(&d))
                .unwrap_or_default(),
            visible: flag(a, "Visible"),
            is_new: flag(a, "IsNew"),
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
                "file" => Some(Pin::File {
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
        owner: String::new(),
        hyalo_epoch: text(state, "HyaloEpoch"),
        matching_available: flag(state, "MatchingAvailable"),
        window_matches: HashMap::new(),
        epoch,
        revision,
        apps,
        pins,
        default_directory: (!default.is_empty()).then_some(default),
        capabilities,
        icon_revision: number(state, "IconRevision"),
        layout_revision: number(state, "LayoutRevision"),
    }
}

/// Unity's record (APPLICATIONS1-DOCK.md §5): a count or a progress only while its
/// visibility says so; a zero count is no badge.
fn launcher(d: &Dict) -> Launcher {
    let count = d.get("Count").and_then(|v| i64::try_from(v).ok());
    let progress = d.get("Progress").and_then(|v| f64::try_from(v).ok());
    Launcher {
        count: count
            .filter(|n| flag(d, "CountVisible") && *n > 0)
            .map(|n| n as u64),
        progress: progress
            .filter(|p| flag(d, "ProgressVisible") && p.is_finite())
            .map(|p| p.clamp(0., 1.)),
        urgent: flag(d, "Urgent"),
    }
}

/// No field code or no complete type list means no file drop. This is advisory;
/// Applications1 revalidates the current files and declaration before dispatch.
pub fn accepts_drop(app: &App, types: &[String]) -> bool {
    app.opens
        && !types.is_empty()
        && types.iter().all(|kind| {
            !kind.is_empty()
                && app.mime_types.iter().any(|declared| {
                    !declared.starts_with("x-scheme-handler/")
                        && gio::content_type_is_a(kind, declared)
                })
        })
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
fn dict(d: &Dict, key: &str) -> Option<Dict> {
    d.get(key)
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| Dict::try_from(v).ok())
}
fn records(d: &Dict, key: &str) -> Vec<Dict> {
    d.get(key)
        .and_then(|v| v.try_clone().ok())
        .and_then(|v| Vec::<Dict>::try_from(v).ok())
        .unwrap_or_default()
}

/// A pinned folder's or file's layout key: its art comes from GetLayoutIcon, by that key.
pub fn is_place(key: &str) -> bool {
    key.starts_with("folder:") || key.starts_with("file:")
}

/// The service's bounds (APPLICATIONS1-DOCK.md §2 GetIcon): 16..512 logical, scale 1..4.
/// Below 16 the dock asks for 16 and scales the art down itself.
pub fn icon_request(logical: f64, scale: f64) -> (u32, f64) {
    ((logical.ceil() as u32).clamp(16, 512), scale.clamp(1., 4.))
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
    fn drops_require_a_field_and_every_declared_type() {
        let mut app = App {
            opens: true,
            mime_types: vec!["application/pdf".into()],
            ..App::default()
        };
        assert!(accepts_drop(&app, &["application/pdf".into()]));
        assert!(!accepts_drop(&app, &["inode/directory".into()]));
        assert!(!accepts_drop(
            &app,
            &["application/pdf".into(), "inode/directory".into()]
        ));
        assert!(!accepts_drop(&app, &[]));
        app.mime_types = vec!["inode/directory".into()];
        assert!(accepts_drop(&app, &["inode/directory".into()]));
        app.mime_types = vec!["x-scheme-handler/tg".into(), "x-scheme-handler/file".into()];
        assert!(!accepts_drop(&app, &["inode/directory".into()]));
        app.mime_types = vec!["image/*".into(), "text/plain".into()];
        assert!(accepts_drop(
            &app,
            &["image/png".into(), "text/x-csrc".into()]
        ));
        app.opens = false; // kitty / Settings: no file field even if a MIME is present.
        assert!(!accepts_drop(&app, &["image/png".into()]));
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

    #[test]
    fn unity_shows_only_what_the_app_makes_visible() {
        let rec = |count: i64, cv: bool, progress: f64, pv: bool, urgent: bool| {
            launcher(&dict(&[
                ("Count", v(count)),
                ("CountVisible", v(cv)),
                ("Progress", v(progress)),
                ("ProgressVisible", v(pv)),
                ("Urgent", v(urgent)),
            ]))
        };
        assert_eq!(
            rec(4, true, 0.25, true, true),
            Launcher {
                count: Some(4),
                progress: Some(0.25),
                urgent: true
            }
        );
        assert_eq!(rec(4, false, 0.25, false, false), Launcher::default());
        assert_eq!(
            rec(0, true, 0., false, false).count,
            None,
            "zero is no badge"
        );
        assert_eq!(launcher(&Dict::new()), Launcher::default());
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
