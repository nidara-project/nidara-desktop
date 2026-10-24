// SPDX-License-Identifier: LGPL-3.0-or-later
//! Identities and routing (PHASE1.md D1 [A1], D3): which bus names the native Settings owns,
//! and where a request to open Settings goes.
//!
//! | Bus name | Owned by |
//! |---|---|
//! | `org.nidara.SettingsNative` | the native Settings, always: the one name `Config1` trusts |
//! | `org.nidara.Settings` | the entry point every client calls: the legacy Settings until the takeover, the native one after |
//! | `org.nidara.SettingsLegacy` | the legacy Settings after the takeover: where a page the native one does not draw goes |
//!
//! `Request(as) → s` keeps the legacy interface's verbs and answers (`ui/settings/app.ts`):
//! `open`, `page <id>`, `app <desktop-id>`, `queryUI [id]`. A page on [`DRAWN`] is navigated
//! to here; other pages and `app` go to the existing entry point in Native mode,
//! or to the launcher-backed legacy name after takeover. Its answer is this answer.
//! One connection for everything: the one the [`Client`]
//! calls `Config1` on, so "the sender owns `org.nidara.SettingsNative`" holds per call.
//!
//! [`Client`]: crate::client::Client

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use zbus::blocking::Connection;
use zbus::fdo::RequestNameFlags;

pub const NATIVE: &str = "org.nidara.SettingsNative";
pub const ENTRY: &str = "org.nidara.Settings";
pub const LEGACY: &str = "org.nidara.SettingsLegacy";
pub const PATH: &str = "/org/nidara/Settings";

/// The pages the native Settings draws (D2: an allowlist, never inferred from `kind`).
pub const DRAWN: &[&str] = &["appearance"];

/// How long a started legacy Settings has to take its name (its cold start is ~1 s).
pub const LEGACY_START: Duration = Duration::from_secs(20);

/// Where a request goes.
#[derive(Debug, PartialEq, Eq)]
pub enum Route {
    /// Bring the window up as it is.
    Raise,
    /// Show this page (one of `DRAWN`) and raise.
    Navigate(String),
    /// The legacy Settings answers it, unchanged.
    Forward(Vec<String>),
    /// The window's own UI tree (`queryUI`), optionally from a node.
    Query(Option<String>),
}

/// Optional metadata on the existing Request(as), not a new remote action method.
pub const ACTIVATION_ARG: &str = "--xdg-activation-token";
fn activation_metadata(args: &[String]) -> Result<(&[String], Option<String>), String> {
    // page/app IDs are positional; a literal ID equal to this marker is still an ID.
    let positional = match args.first().map(String::as_str) {
        Some("page" | "app") => 2,
        Some("queryUI") if args.get(1).is_some_and(|a| a != ACTIVATION_ARG) => 2,
        _ => 1,
    };
    if let Some(index) = args
        .iter()
        .enumerate()
        .skip(positional)
        .find_map(|(i, a)| (a == ACTIVATION_ARG).then_some(i))
    {
        if index + 2 != args.len() || args[index + 1].is_empty() || args[index + 1].contains('\0') {
            return Err("invalid activation metadata".into());
        }
        Ok((&args[..index], Some(args[index + 1].clone())))
    } else {
        Ok((args, None))
    }
}
/// Attach the initiating launch token without changing the original routing arguments.
pub fn with_activation(args: &[String], token: String) -> Result<Vec<String>, String> {
    if activation_metadata(args)?.1.is_some() || token.is_empty() || token.contains('\0') {
        return Err("invalid or duplicate activation metadata".into());
    }
    let mut result = args.to_vec();
    result.extend([ACTIVATION_ARG.into(), token]);
    Ok(result)
}

/// The decision, with nothing else: the legacy verbs, the allowlist.
pub fn route(args: &[String], drawn: &[&str]) -> Result<Route, String> {
    let (args, _) = activation_metadata(args)?;
    let id = args.get(1).filter(|s| !s.is_empty()).cloned();
    match args.first().map(String::as_str) {
        Some("open") => Ok(Route::Raise),
        Some("page") => match id {
            Some(id) if drawn.contains(&id.as_str()) => Ok(Route::Navigate(id)),
            Some(_) => Ok(Route::Forward(args.to_vec())),
            None => Err("usage: settingsPage <page-id>".into()),
        },
        // Apps are a page the native Settings does not draw.
        Some("app") => match id {
            Some(_) => Ok(Route::Forward(args.to_vec())),
            None => Err("usage: settingsApp <desktop-id>".into()),
        },
        Some("queryUI") => Ok(Route::Query(id)),
        _ => Err("Unknown Settings request".into()),
    }
}

/// Whether this process is the entry point (after the takeover) or only the native
/// Settings beside the legacy one (before it).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Native,
    EntryPoint,
}

/// A request the app answers on its own loop (navigation, raising, the UI tree).
pub struct Incoming {
    pub route: Route,
    pub activation: Option<String>,
    reply: async_channel::Sender<String>,
}

impl Incoming {
    pub fn respond(self, text: impl Into<String>) {
        let _ = self.reply.try_send(text.into());
    }
}

/// Starts the legacy Settings (its launcher); the router then waits for its name.
pub type Launcher = Arc<dyn Fn() -> Result<(), String> + Send + Sync>;

/// The launcher the package installs: `nidara-settings-legacy`, which owns
/// `org.nidara.SettingsLegacy`.
pub fn legacy_launcher() -> Launcher {
    Arc::new(|| {
        let program =
            std::env::var("NK_SETTINGS_LEGACY").unwrap_or_else(|_| "nidara-settings-legacy".into());
        std::process::Command::new(program)
            .spawn()
            .map(drop)
            .map_err(|e| format!("starting the legacy Settings: {e}"))
    })
}

pub struct Router {
    incoming: async_channel::Receiver<Incoming>,
}

/// Why this process should not go on: the native Settings already runs. The request it was
/// started for has been handed to that one (as a GApplication's second instance does).
#[derive(Debug)]
pub struct AlreadyRunning;

struct Service {
    mode: Mode,
    to_app: async_channel::Sender<Incoming>,
    legacy: Launcher,
    starting: Arc<Mutex<()>>,
}

#[zbus::interface(name = "org.nidara.Settings")]
impl Service {
    async fn request(
        &self,
        args: Vec<String>,
        #[zbus(connection)] connection: &zbus::Connection,
    ) -> zbus::fdo::Result<String> {
        let (args, activation) = activation_metadata(&args).map_err(zbus::fdo::Error::Failed)?;
        let route = match route(args, DRAWN) {
            Ok(r) => r,
            Err(e) if e.starts_with("usage") => return Ok(e),
            Err(e) => return Err(zbus::fdo::Error::Failed(e)),
        };
        if let Route::Forward(args) = route {
            return forward(connection, self.mode, &self.legacy, &self.starting, args)
                .await
                .map_err(zbus::fdo::Error::Failed);
        }
        let (reply, answer) = async_channel::bounded(1);
        self.to_app
            .send(Incoming {
                route,
                activation,
                reply,
            })
            .await
            .map_err(|_| zbus::fdo::Error::Failed("the window has gone".into()))?;
        answer
            .recv()
            .await
            .map_err(|_| zbus::fdo::Error::Failed("the window did not answer".into()))
    }
}

/// Forward to the entry point before takeover, or start/use the legacy name afterwards.
async fn forward(
    connection: &zbus::Connection,
    mode: Mode,
    launcher: &Launcher,
    starting: &Mutex<()>,
    args: Vec<String>,
) -> Result<String, String> {
    if mode == Mode::Native {
        let reply = connection
            .call_method(Some(ENTRY), PATH, Some(ENTRY), "Request", &(args,))
            .await
            .map_err(|e| format!("the Settings entry point: {e}"))?;
        return reply
            .body()
            .deserialize::<String>()
            .map_err(|e| e.to_string());
    }
    let dbus = zbus::fdo::DBusProxy::new(connection)
        .await
        .map_err(|e| e.to_string())?;
    let legacy = zbus::names::BusName::try_from(LEGACY).map_err(|e| e.to_string())?;
    if !dbus.name_has_owner(legacy.clone()).await.unwrap_or(false) {
        // One start for any number of requests arriving together.
        let first = starting.try_lock().is_ok();
        if first {
            launcher()?;
        }
        let deadline = Instant::now() + LEGACY_START;
        while !dbus.name_has_owner(legacy.clone()).await.unwrap_or(false) {
            if Instant::now() >= deadline {
                return Err("the legacy Settings did not take its name".into());
            }
            async_io_sleep(Duration::from_millis(50)).await;
        }
    }
    // Its name is taken just before its interface is exported (GApplication): retry only
    // UnknownMethod/UnknownObject, where no request ran — never a timeout.
    let deadline = Instant::now() + LEGACY_START;
    loop {
        let reply = connection
            .call_method(Some(LEGACY), PATH, Some(ENTRY), "Request", &(args.clone(),))
            .await;
        match reply {
            Ok(m) => return m.body().deserialize::<String>().map_err(|e| e.to_string()),
            Err(zbus::Error::MethodError(name, ..))
                if (name.as_str() == "org.freedesktop.DBus.Error.UnknownMethod"
                    || name.as_str() == "org.freedesktop.DBus.Error.UnknownObject")
                    && Instant::now() < deadline =>
            {
                async_io_sleep(Duration::from_millis(50)).await;
            }
            Err(e) => return Err(format!("the legacy Settings: {e}")),
        }
    }
}

/// A pause on zbus's own executor, without a runtime of ours.
async fn async_io_sleep(d: Duration) {
    let (tx, rx) = async_channel::bounded::<()>(1);
    std::thread::spawn(move || {
        std::thread::sleep(d);
        let _ = tx.send_blocking(());
    });
    let _ = rx.recv().await;
}

impl Router {
    /// Takes the names of `mode` on `connection` (the client's). If the native Settings already
    /// runs, `args` are handed to it and `AlreadyRunning` comes back: this process ends.
    pub fn start(
        connection: &Connection,
        mode: Mode,
        legacy: Launcher,
        args: &[String],
    ) -> Result<Result<Self, AlreadyRunning>, String> {
        let (to_app, incoming) = async_channel::unbounded();
        let names: &[&str] = match mode {
            Mode::Native => &[NATIVE],
            Mode::EntryPoint => &[NATIVE, ENTRY],
        };
        // The interface first: a name taken with nothing behind it answers UnknownMethod.
        connection
            .object_server()
            .at(
                PATH,
                Service {
                    mode,
                    to_app,
                    legacy,
                    starting: Arc::new(Mutex::new(())),
                },
            )
            .map_err(|e| format!("exporting {PATH}: {e}"))?;
        for name in names {
            let reply = connection
                .request_name_with_flags(*name, RequestNameFlags::DoNotQueue.into())
                .map_err(|e| format!("{name}: {e}"));
            match reply {
                Ok(_) => {}
                Err(_) if *name == NATIVE => {
                    // Another native Settings: give it the request and go.
                    let target = if mode == Mode::EntryPoint {
                        ENTRY
                    } else {
                        NATIVE
                    };
                    let args: Vec<String> = if args.is_empty() {
                        vec!["open".into()]
                    } else {
                        args.to_vec()
                    };
                    connection
                        .call_method(Some(target), PATH, Some(ENTRY), "Request", &(args,))
                        .map_err(|e| format!("handing the request to {target}: {e}"))?;
                    return Ok(Err(AlreadyRunning));
                }
                Err(e) => return Err(e),
            }
        }
        Ok(Ok(Self { incoming }))
    }

    /// The requests waiting for the window, from the app's idle; each must be answered.
    pub fn poll(&self) -> Vec<Incoming> {
        std::iter::from_fn(|| self.incoming.try_recv().ok()).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn activation_metadata_keeps_tokens_opaque_and_original_route_shape() {
        let original = args(&["page", "appearance"]);
        let marked = with_activation(&original, " opaque 日本語 ".into()).unwrap();
        assert_eq!(
            activation_metadata(&marked).unwrap(),
            (original.as_slice(), Some(" opaque 日本語 ".into()))
        );
        assert_eq!(
            route(&marked, DRAWN),
            Ok(Route::Navigate("appearance".into()))
        );
        assert_eq!(
            route(&args(&["page", ACTIVATION_ARG]), DRAWN),
            Ok(Route::Forward(args(&["page", ACTIVATION_ARG])))
        );
        assert!(with_activation(&marked, "second".into()).is_err());
    }
    #[test]
    fn malformed_activation_is_rejected_without_echoing_token() {
        for a in [
            args(&["open", ACTIVATION_ARG]),
            args(&["open", ACTIVATION_ARG, ""]),
            args(&["open", ACTIVATION_ARG, "bad\0secret"]),
            args(&["open", ACTIVATION_ARG, "secret", ACTIVATION_ARG, "other"]),
        ] {
            let error = route(&a, DRAWN).unwrap_err();
            assert!(!error.contains("secret"));
        }
        assert!(with_activation(&args(&["open"]), "".into()).is_err());
    }
    #[test]
    fn a_drawn_page_is_navigated_and_any_other_forwarded() {
        assert_eq!(
            route(&args(&["page", "appearance"]), DRAWN),
            Ok(Route::Navigate("appearance".into()))
        );
        assert_eq!(
            route(&args(&["page", "network"]), DRAWN),
            Ok(Route::Forward(args(&["page", "network"])))
        );
        assert_eq!(
            route(&args(&["app", "org.gnome.Nautilus.desktop"]), DRAWN),
            Ok(Route::Forward(args(&["app", "org.gnome.Nautilus.desktop"])))
        );
        assert_eq!(route(&args(&["open"]), DRAWN), Ok(Route::Raise));
        assert_eq!(route(&args(&["queryUI"]), DRAWN), Ok(Route::Query(None)));
    }

    #[test]
    fn the_legacy_verbs_answer_as_they_did() {
        assert!(
            route(&args(&["page"]), DRAWN)
                .unwrap_err()
                .starts_with("usage")
        );
        assert!(
            route(&args(&["app", ""]), DRAWN)
                .unwrap_err()
                .starts_with("usage")
        );
        assert_eq!(
            route(&args(&["reload"]), DRAWN).unwrap_err(),
            "Unknown Settings request"
        );
        assert!(route(&[], DRAWN).is_err());
    }
}
