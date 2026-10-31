// SPDX-License-Identifier: GPL-3.0-or-later
//! Admission is not focus/window confirmation. No retry after any ambiguous delivery.
use super::{
    Dict, Error,
    catalogue::{self, App},
    desktop::{self, Desktop, Request},
    store::Handle,
};
use futures_util::StreamExt;
use nidara_access::{Operation, Peer};
use serde_json::{Value as Json, json};
use std::{
    collections::HashMap,
    sync::Arc,
    time::{Duration, Instant},
};
use zbus::{
    Connection,
    zvariant::{OwnedObjectPath, OwnedValue, Value},
};
const ACTIVE: usize = 32;
const RETAIN: Duration = Duration::from_secs(30);
const LIFETIME: Duration = Duration::from_secs(10);
pub struct Entry {
    owner: String,
    nonce: String,
    fingerprint: String,
    created: Instant,
    active: bool,
    dispatch_allowed: bool,
    baseline: Option<(String, std::collections::BTreeSet<u64>)>,
    correlation: Option<(String, u64)>,
    pub public: Json,
}
#[derive(Default)]
pub struct Book {
    entries: HashMap<String, Entry>,
    tokens: HashMap<String, Instant>,
}
impl Book {
    fn cleanup(&mut self) {
        self.tokens.retain(|_, created| created.elapsed() < RETAIN);
        self.entries
            .retain(|_, e| e.active || e.created.elapsed() < RETAIN);
    }
    pub fn existing(
        &mut self,
        owner: &str,
        nonce: &str,
        fingerprint: &str,
    ) -> Result<Option<String>, Error> {
        self.cleanup();
        if nonce.is_empty() {
            return Ok(None);
        }
        if let Some((id, e)) = self
            .entries
            .iter()
            .find(|(_, e)| e.owner == owner && e.nonce == nonce)
        {
            return if e.fingerprint == fingerprint {
                Ok(Some(id.clone()))
            } else {
                Err(Error::Conflict("RequestId argument mismatch".into()))
            };
        }
        Ok(None)
    }
    pub fn insert(
        &mut self,
        owner: String,
        nonce: String,
        fingerprint: String,
        app: &App,
        mode: &str,
        token: Option<String>,
    ) -> Result<String, Error> {
        self.cleanup();
        if self
            .entries
            .values()
            .filter(|e| e.active || e.public["DispatchFinished"] != true)
            .count()
            >= ACTIVE
            || self.entries.len() >= 1024
            || (!nonce.is_empty()
                && self
                    .entries
                    .values()
                    .filter(|e| e.owner == owner && !e.nonce.is_empty())
                    .count()
                    >= 64)
        {
            return Err(Error::Busy("launch retention/admission budget".into()));
        }
        if let Some(token) = token {
            if self.tokens.contains_key(&token) {
                return Err(Error::Conflict("activation token already admitted".into()));
            }
            self.tokens.insert(token, Instant::now());
        }
        let id = format!("launch-{}", super::unique());
        let public = json!({"LaunchId":id,"DesktopId":app.id,"AppGeneration":app.generation,"Mode":mode,"State":"accepted","EffectStarted":false,"DispatchFinished":false,"OutcomeUnknown":false,"FocusConfirmed":false,"WindowConfirmed":false,"ActualUnit":"","DispatchUnits":[],"PortalIdentityVerified":false,"HyaloEpoch":"","WindowId":0_u64,"Correlation":"none","CausalConfirmed":false,"ObservationReason":"no coherent correlation","Error":"","CreatedMonotonic":monotonic()});
        self.entries.insert(
            id.clone(),
            Entry {
                owner,
                nonce,
                fingerprint,
                created: Instant::now(),
                active: true,
                dispatch_allowed: true,
                baseline: None,
                correlation: None,
                public,
            },
        );
        Ok(id)
    }
    pub fn state(&self, id: &str) -> Result<Json, Error> {
        self.entries
            .get(id)
            .filter(|e| e.active || e.created.elapsed() < RETAIN)
            .map(|e| e.public.clone())
            .ok_or_else(|| Error::NotFound("launch expired or unknown".into()))
    }
    pub fn active(&self) -> Vec<Json> {
        self.entries
            .values()
            .filter(|e| e.active)
            .map(|e| e.public.clone())
            .collect()
    }
    pub fn update(
        &mut self,
        id: &str,
        state: &str,
        error: &str,
        unknown: bool,
        unit: Option<String>,
    ) {
        if let Some(e) = self.entries.get_mut(id) {
            if let Some(unit) = unit {
                let units = e.public["DispatchUnits"].as_array_mut().unwrap();
                if !units.contains(&json!(unit)) {
                    units.push(json!(unit));
                }
            }
            if !e.active {
                if state == "failed" {
                    e.public["Error"] = json!(error);
                    e.dispatch_allowed = false;
                }
                return;
            }
            e.public["State"] = json!(state);
            e.public["Error"] = json!(error);
            e.public["OutcomeUnknown"] = json!(unknown);
            if ["failed", "timed-out-unknown"].contains(&state) {
                e.active = false;
                e.dispatch_allowed = false;
            }
        }
    }
    pub fn finished(&mut self, id: &str) {
        if let Some(e) = self.entries.get_mut(id) {
            e.public["DispatchFinished"] = json!(true);
        }
    }
    pub fn actual(&mut self, id: &str, unit: String) {
        if let Some(e) = self.entries.get_mut(id) {
            e.public["ActualUnit"] = json!(unit);
        }
    }
    pub fn started(&mut self, id: &str) {
        if let Some(e) = self.entries.get_mut(id) {
            e.public["EffectStarted"] = json!(true);
        }
    }
    pub fn may_dispatch(&self, id: &str) -> bool {
        self.entries
            .get(id)
            .is_some_and(|e| e.dispatch_allowed && e.created.elapsed() < LIFETIME)
    }
    pub fn invalidate_apps(&mut self, apps: &std::collections::BTreeMap<String, App>) -> bool {
        let mut changed = false;
        for e in self.entries.values_mut().filter(|e| e.active) {
            let id = e.public["DesktopId"].as_str().unwrap_or_default();
            if apps
                .get(id)
                .is_none_or(|a| Some(a.generation) != e.public["AppGeneration"].as_u64())
            {
                let started = e.public["EffectStarted"] == true;
                e.public["State"] = json!(if started {
                    "timed-out-unknown"
                } else {
                    "failed"
                });
                e.public["OutcomeUnknown"] = json!(started);
                e.public["Error"] = json!("desktop removed or generation changed");
                e.active = false;
                changed = true;
            }
        }
        changed
    }
    pub fn baseline(&mut self, id: &str, epoch: String, windows: std::collections::BTreeSet<u64>) {
        if let Some(e) = self.entries.get_mut(id) {
            e.baseline = Some((epoch, windows));
        }
    }
    pub fn bind(&mut self, id: &str, epoch: &str, number: u64) {
        if let Some(e) = self.entries.get_mut(id).filter(|e| e.active) {
            e.correlation = Some((epoch.into(), number));
            e.public["ObservationReason"] = json!("");
        }
    }
    pub fn outcome(
        &mut self,
        epoch: &str,
        number: u64,
        outcome: &Json,
        focus: Option<u64>,
    ) -> bool {
        let Some(e) = self.entries.values_mut().find(|e| {
            e.active
                && e.correlation
                    .as_ref()
                    .is_some_and(|(ep, n)| ep == epoch && *n == number)
        }) else {
            return false;
        };
        let kind = outcome["outcome"].as_str().unwrap_or_default();
        match kind {
            "window" | "activated" => {
                let Some(window) = outcome["window"].as_u64() else {
                    return false;
                };
                e.public["State"] = json!(if kind == "window" {
                    "window-observed"
                } else {
                    "existing-window-activated"
                });
                e.public["HyaloEpoch"] = json!(epoch);
                e.public["WindowId"] = json!(window);
                e.public["WindowConfirmed"] = json!(true);
                e.public["FocusConfirmed"] = json!(focus == Some(window));
                e.public["Correlation"] = json!("activation-token");
                e.public["CausalConfirmed"] = json!(true);
                e.public["OutcomeUnknown"] = json!(false);
                e.public["ObservationReason"] = json!("");
            }
            "refused" => {
                e.public["State"] = json!("failed");
                e.public["Error"] = json!("activation refused by compositor");
                e.public["ObservationReason"] = json!("activation refused");
            }
            "expired" => {
                e.public["State"] = json!("timed-out-unknown");
                e.public["OutcomeUnknown"] = json!(true);
                e.public["ObservationReason"] = json!("activation token expired");
            }
            _ => return false,
        }
        e.active = false;
        true
    }
    pub fn stop_observation(&mut self, reason: &str) {
        for e in self.entries.values_mut().filter(|e| e.active) {
            e.active = false;
            e.public["State"] = json!("timed-out-unknown");
            e.public["OutcomeUnknown"] = json!(true);
            e.public["ObservationReason"] = json!(reason);
        }
    }
    pub fn reconcile(&mut self, epoch: &str, matches: &[Json], focus: Option<u64>) -> bool {
        let counts = self.entries.values().filter(|e| e.active).fold(
            HashMap::<String, usize>::new(),
            |mut c, e| {
                *c.entry(e.public["DesktopId"].as_str().unwrap_or_default().into())
                    .or_default() += 1;
                c
            },
        );
        let mut changed = false;
        for e in self
            .entries
            .values_mut()
            .filter(|e| e.active && e.correlation.is_none() && e.public["EffectStarted"] == true)
        {
            if counts.get(e.public["DesktopId"].as_str().unwrap_or_default()) != Some(&1) {
                continue;
            }
            let Some((base_epoch, base)) = &e.baseline else {
                continue;
            };
            if base_epoch != epoch {
                continue;
            }
            let candidates = matches
                .iter()
                .filter(|m| {
                    m["DesktopId"] == e.public["DesktopId"]
                        && m["AppGeneration"] == e.public["AppGeneration"]
                        && m["WindowId"].as_u64().is_some_and(|id| !base.contains(&id))
                })
                .collect::<Vec<_>>();
            if candidates.len() != 1 {
                continue;
            }
            let window = candidates[0]["WindowId"].as_u64().unwrap();
            e.public["State"] = json!("window-observed");
            e.public["HyaloEpoch"] = json!(epoch);
            e.public["WindowId"] = json!(window);
            e.public["WindowConfirmed"] = json!(true);
            e.public["FocusConfirmed"] = json!(focus == Some(window));
            e.public["Correlation"] = json!("app-match-after-launch");
            e.public["CausalConfirmed"] = json!(false);
            e.public["ObservationReason"] = json!("weaker app match; causality unconfirmed");
            e.active = false;
            changed = true;
        }
        changed
    }
    pub fn sender_lost(&mut self, sender: &str) {
        for e in self.entries.values_mut().filter(|e| e.owner == sender) {
            e.nonce.clear();
        }
    }
}
fn monotonic() -> f64 {
    let mut t = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut t) };
    t.tv_sec as f64 + t.tv_nsec as f64 / 1e9
}
enum Backend {
    Dbus {
        bus: String,
        path: String,
        method: String,
        action: String,
        uris: Vec<String>,
    },
    Exec {
        argv: Vec<Vec<String>>,
        cwd: String,
    },
}
pub struct Plan {
    pub app: App,
    backend: Backend,
    token: String,
}
impl Plan {
    pub fn token_hash(&self) -> Option<String> {
        (!self.token.is_empty()).then(|| catalogue::hash(self.token.as_bytes()))
    }
}
pub fn prepare(
    app: &App,
    request: Request,
    apps: &std::collections::BTreeMap<String, App>,
    default_directory: &str,
) -> Result<Plan, Error> {
    let d = Desktop::load(app)?;
    if request.uris.iter().any(|u| {
        glib::Uri::parse(u, glib::UriFlags::NONE)
            .is_ok_and(|u| u.scheme().eq_ignore_ascii_case("trash"))
    }) && app.id != default_directory
    {
        return Err(Error::Stale(
            "Trash must use the current default directory handler".into(),
        ));
    }
    let action = match request.mode.as_str() {
        "action" => {
            if !d.actions().contains(&request.action) {
                return Err(Error::Invalid("undeclared desktop action".into()));
            }
            Some(request.action.clone())
        }
        "new-window" => {
            if d.new_window() == "unsupported" {
                return Err(Error::Unsupported("new window is unsupported".into()));
            }
            d.new_action()
        }
        _ => None,
    };
    let backend = if d.flag("DBusActivatable") {
        if d.flag("Terminal") {
            return Err(Error::Unsupported(
                "D-Bus activation cannot request a terminal wrapper".into(),
            ));
        }
        let bus =
            d.id.strip_suffix(".desktop")
                .ok_or_else(|| Error::Invalid("desktop identity".into()))?
                .to_string();
        zbus::names::WellKnownName::try_from(bus.as_str())
            .map_err(|_| Error::Invalid("DBusActivatable desktop ID is not a bus name".into()))?;
        let path = format!("/{}", bus.replace('.', "/"));
        let path = path.replace('-', "_");
        zbus::zvariant::ObjectPath::try_from(path.as_str())
            .map_err(|_| Error::Invalid("D-Bus application path".into()))?;
        if request.mode == "open" {
            if app.record["SupportsOpen"] != true {
                return Err(Error::Unsupported(
                    "app does not declare opening support".into(),
                ));
            }
            let schemes = catalogue::strv(&d.key, "Desktop Entry", "MimeType");
            for u in &request.uris {
                if !desktop::supports_uri(u, &schemes) {
                    return Err(Error::Unsupported("URI scheme not declared".into()));
                }
            }
        }
        Backend::Dbus {
            bus,
            path,
            method: if action.is_some() {
                "ActivateAction"
            } else if request.mode == "open" {
                "Open"
            } else {
                "Activate"
            }
            .into(),
            action: action.unwrap_or_default(),
            uris: request.uris,
        }
    } else {
        let mut argv = d.argv(action.as_deref(), &request.uris)?;
        if d.flag("Terminal") {
            let terminal = desktop::terminal(apps)?;
            for a in &mut argv {
                let mut t = terminal.clone();
                t.append(a);
                *a = t;
            }
        }
        Backend::Exec {
            argv,
            cwd: d
                .cwd()?
                .to_str()
                .ok_or_else(|| Error::Unsupported("non-UTF-8 working directory".into()))?
                .to_owned(),
        }
    };
    Ok(Plan {
        app: app.clone(),
        backend,
        token: request.token,
    })
}
fn val(v: impl Into<Value<'static>>) -> OwnedValue {
    OwnedValue::try_from(v.into()).expect("owned D-Bus property")
}
fn unit_name(desktop_id: &str, launch: &str, index: usize) -> Result<String, Error> {
    let id = desktop_id
        .strip_suffix(".desktop")
        .ok_or_else(|| Error::Invalid("desktop identity".into()))?;
    let escaped = id
        .as_bytes()
        .iter()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"._:".contains(b) {
                (*b as char).to_string()
            } else {
                format!("\\x{b:02x}")
            }
        })
        .collect::<String>();
    let unit = format!("app-{escaped}@{launch}-{index}.service");
    if unit.len() > 255 {
        return Err(Error::Unsupported(
            "canonical desktop ID exceeds systemd unit bound".into(),
        ));
    }
    Ok(unit)
}
fn environment(app: &App, token: &str) -> (Vec<String>, Vec<String>) {
    // A fresh allowlist overrides relevant manager values; never forwards daemon FDs.
    let mut env = Vec::new();
    let mut unset = vec![
        "INVOCATION_ID",
        "JOURNAL_STREAM",
        "NOTIFY_SOCKET",
        "WATCHDOG_USEC",
        "WATCHDOG_PID",
        "MEMORY_PRESSURE_WATCH",
        "MEMORY_PRESSURE_WRITE",
        "LISTEN_PID",
        "LISTEN_FDS",
        "LISTEN_FDNAMES",
        "DESKTOP_STARTUP_ID",
        "GIO_LAUNCHED_DESKTOP_FILE_PID",
        "XDG_ACTIVATION_TOKEN",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    for key in [
        "HOME",
        "USER",
        "LOGNAME",
        "PATH",
        "LANG",
        "LANGUAGE",
        "LC_ALL",
        "DISPLAY",
        "WAYLAND_DISPLAY",
        "XDG_RUNTIME_DIR",
        "XDG_CURRENT_DESKTOP",
        "XDG_SESSION_TYPE",
        "XDG_SESSION_DESKTOP",
        "XDG_DATA_HOME",
        "XDG_DATA_DIRS",
        "XDG_CONFIG_HOME",
        "XDG_CONFIG_DIRS",
        "DBUS_SESSION_BUS_ADDRESS",
        "XAUTHORITY",
        "XCURSOR_SIZE",
        "XCURSOR_THEME",
    ] {
        if let Ok(value) = std::env::var(key)
            && !value.contains('\0')
        {
            env.push(format!("{key}={value}"));
        }
    }
    match std::env::var("GTK_THEME") {
        Ok(theme) if theme.split(':').next() != Some("Empty") && !theme.contains('\0') => {
            env.push(format!("GTK_THEME={theme}"))
        }
        _ => unset.push("GTK_THEME".into()),
    }
    env.push(format!(
        "GIO_LAUNCHED_DESKTOP_FILE={}",
        app.record["DesktopPath"].as_str().unwrap_or_default()
    ));
    if !token.is_empty() {
        unset.retain(|s| s != "XDG_ACTIVATION_TOKEN");
        env.push(format!("XDG_ACTIVATION_TOKEN={token}"));
    }
    (env, unset)
}
fn properties(plan: &Plan, argv: Vec<String>, cwd: &str, token: &str) -> Vec<(String, OwnedValue)> {
    let (env, unset) = environment(&plan.app, token);
    vec![
        ("Type".into(), val("exec".to_owned())),
        ("ExitType".into(), val("cgroup".to_owned())),
        ("Slice".into(), val("app-graphical.slice".to_owned())),
        ("CollectMode".into(), val("inactive-or-failed".to_owned())),
        (
            "Description".into(),
            val(format!("Application {}", plan.app.id)),
        ),
        (
            "SourcePath".into(),
            val(plan.app.record["DesktopPath"]
                .as_str()
                .unwrap_or_default()
                .to_owned()),
        ),
        ("WorkingDirectory".into(), val(cwd.to_owned())),
        ("StandardInput".into(), val("null".to_owned())),
        ("StandardOutput".into(), val("journal".to_owned())),
        ("StandardError".into(), val("journal".to_owned())),
        ("Environment".into(), val(env)),
        ("UnsetEnvironment".into(), val(unset)),
        (
            "ExecStartEx".into(),
            val(vec![(
                argv[0].clone(),
                argv,
                vec!["no-env-expand".to_string()],
            )]),
        ),
    ]
}
async fn permit(store: &Handle, peer: &Arc<Peer>, id: &str, app: &App) -> Result<(), Error> {
    let peer = peer.clone();
    let id = id.to_owned();
    let app = app.clone();
    store
        .call(move |s| {
            s.authorize(&peer, Operation::AppLaunch)?;
            s.app(&app.id, app.generation)?;
            Desktop::load(&app)?;
            if !s.launches.may_dispatch(&id) {
                return Err(Error::Timeout("launch expired before dispatch".into()));
            }
            s.launches.started(&id);
            Ok(())
        })
        .await
}
async fn owner(conn: &Connection, name: &str) -> Result<String, Error> {
    zbus::fdo::DBusProxy::new(conn)
        .await?
        .get_name_owner(
            name.try_into()
                .map_err(|_| Error::Invalid("bus name".into()))?,
        )
        .await
        .map(|o| o.to_string())
        .map_err(|_| Error::Unavailable("required service has no owner".into()))
}
/// Errors use only error names; a remote reply body can echo private URIs/tokens.
fn remote_error(e: zbus::Error) -> Error {
    match e {
        zbus::Error::MethodError(n, _, _) if n.as_str().ends_with("AccessDenied") => {
            Error::AccessDenied("application/systemd refused request".into())
        }
        zbus::Error::MethodError(_, _, _) => {
            Error::Failed("application/systemd rejected request".into())
        }
        _ => Error::Timeout("launch result unknown".into()),
    }
}
async fn dispatch(
    plan: &Plan,
    id: &str,
    peer: &Arc<Peer>,
    store: &Handle,
    conn: &Connection,
) -> Result<Option<String>, Error> {
    match &plan.backend {
        Backend::Exec { argv, cwd } => {
            // Subscribe is connection-scoped. A private connection keeps concurrent launches
            // from unsubscribing each other; dropping it also releases the subscription.
            let manager_conn = Connection::session().await?;
            let name = owner(&manager_conn, "org.freedesktop.systemd1").await?;
            let p = zbus::Proxy::new(
                &manager_conn,
                name,
                "/org/freedesktop/systemd1",
                "org.freedesktop.systemd1.Manager",
            )
            .await?;
            let mut jobs = p.receive_signal("JobRemoved").await?;
            p.call::<_, _, ()>("Subscribe", &())
                .await
                .map_err(remote_error)?;
            for (i, a) in argv.iter().enumerate() {
                let unit = unit_name(&plan.app.id, id, i)?;
                let props = properties(plan, a.clone(), cwd, if i == 0 { &plan.token } else { "" });
                permit(store, peer, id, &plan.app).await?;
                let job: OwnedObjectPath = p
                    .call(
                        "StartTransientUnit",
                        &(
                            &unit,
                            "fail",
                            props,
                            Vec::<(String, Vec<(String, OwnedValue)>)>::new(),
                        ),
                    )
                    .await
                    .map_err(remote_error)?;
                let launch_id = id.to_owned();
                store
                    .call(move |s| {
                        s.launches
                            .update(&launch_id, "accepted", "", false, Some(unit));
                        s.mark("launches");
                        Ok(())
                    })
                    .await?;
                loop {
                    let message = jobs.next().await.ok_or_else(|| {
                        Error::Timeout("systemd observation ended; result unknown".into())
                    })?;
                    let (_, removed, _, result): (u32, OwnedObjectPath, String, String) =
                        message.body().deserialize()?;
                    if removed != job {
                        continue;
                    }
                    if result != "done" {
                        return Err(Error::Failed("systemd application start job failed".into()));
                    }
                    break;
                }
            }
            Ok(None)
        }
        Backend::Dbus {
            bus,
            path,
            method,
            action,
            uris,
        } => {
            let dbus = zbus::fdo::DBusProxy::new(conn).await?;
            let name = match owner(conn, bus).await {
                Ok(n) => n,
                Err(_) => {
                    permit(store, peer, id, &plan.app).await?;
                    dbus.start_service_by_name(
                        bus.as_str()
                            .try_into()
                            .map_err(|_| Error::Invalid("bus name".into()))?,
                        0,
                    )
                    .await
                    .map_err(|e| match e {
                        zbus::fdo::Error::ServiceUnknown(_)
                        | zbus::fdo::Error::NameHasNoOwner(_) => Error::Unavailable(
                            "application has no activatable D-Bus service (no Exec retry)".into(),
                        ),
                        zbus::fdo::Error::AccessDenied(_) => {
                            Error::AccessDenied("bus refused application activation".into())
                        }
                        _ => Error::Timeout(
                            "D-Bus activation outcome unknown (no Exec retry)".into(),
                        ),
                    })?;
                    owner(conn, bus).await?
                }
            };
            let p = zbus::Proxy::new(
                conn,
                name.clone(),
                path.as_str(),
                "org.freedesktop.Application",
            )
            .await?;
            let mut context = Dict::new();
            if !plan.token.is_empty() {
                context.insert("activation-token".into(), val(plan.token.clone()));
            }
            permit(store, peer, id, &plan.app).await?;
            match method.as_str() {
                "Open" => p.call::<_, _, ()>("Open", &(uris, &context)).await,
                "ActivateAction" => {
                    p.call::<_, _, ()>(
                        "ActivateAction",
                        &(action, Vec::<OwnedValue>::new(), &context),
                    )
                    .await
                }
                _ => p.call::<_, _, ()>("Activate", &(&context,)).await,
            }
            .map_err(remote_error)?;
            // Read the ACTUAL owner's unit if available; never labels a helper's unit as the app.
            let unit = async {
                let pid = dbus
                    .get_connection_unix_process_id(name.as_str().try_into().ok()?)
                    .await
                    .ok()?;
                let manager_owner = owner(conn, "org.freedesktop.systemd1").await.ok()?;
                let m = zbus::Proxy::new(
                    conn,
                    manager_owner,
                    "/org/freedesktop/systemd1",
                    "org.freedesktop.systemd1.Manager",
                )
                .await
                .ok()?;
                let object: OwnedObjectPath = m.call("GetUnitByPID", &(pid,)).await.ok()?;
                let u = zbus::Proxy::new(
                    conn,
                    m.destination().to_owned(),
                    object,
                    "org.freedesktop.systemd1.Unit",
                )
                .await
                .ok()?;
                u.get_property::<String>("Id").await.ok()
            };
            Ok(tokio::time::timeout(Duration::from_millis(500), unit)
                .await
                .ok()
                .flatten())
        }
    }
}
pub fn run(
    store: Handle,
    conn: Connection,
    workers: Arc<tokio::sync::Semaphore>,
    id: String,
    peer: Arc<Peer>,
    plan: Plan,
) {
    let launch_id = id.clone();
    let timer_store = store.clone();
    tokio::spawn(async move {
        tokio::time::sleep(LIFETIME).await;
        let _ = timer_store
            .call(move |s| {
                let state = s.launches.state(&launch_id)?;
                if ["accepted", "dispatched"].contains(&state["State"].as_str().unwrap_or_default())
                {
                    let started = state["EffectStarted"] == true;
                    s.launches.update(
                        &launch_id,
                        if started {
                            "timed-out-unknown"
                        } else {
                            "failed"
                        },
                        if started {
                            "observation unavailable before H1/A3"
                        } else {
                            "deadline before dispatch"
                        },
                        started,
                        None,
                    );
                    s.mark("launches");
                }
                Ok(())
            })
            .await;
    });
    tokio::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(9), async {
            let _permit = workers
                .acquire_owned()
                .await
                .map_err(|_| Error::Unavailable("launch workers unavailable".into()))?;
            if !plan.token.is_empty() {
                let context = store
                    .call(|s| Ok(s.observation.live.then(|| s.observation.epoch.clone())))
                    .await?;
                if let Some(context) = context
                    && let Ok((run, number, already)) =
                        super::observation::launch(&plan.token).await
                {
                    let launch_id = id.clone();
                    let _ = store
                        .call(move |s| {
                            s.bind_launch(&launch_id, &context, run, number, already);
                            Ok(())
                        })
                        .await;
                }
            }
            dispatch(&plan, &id, &peer, &store, &conn).await
        })
        .await;
        let _ = store
            .call(move |s| {
                s.launches.finished(&id);
                match result {
                    Ok(Ok(unit)) => {
                        s.launches.update(&id, "dispatched", "", false, None);
                        if let Some(unit) = unit {
                            s.launches.actual(&id, unit);
                        }
                    }
                    Ok(Err(error)) => {
                        let ambiguous = matches!(error, Error::Timeout(_));
                        s.launches.update(
                            &id,
                            if ambiguous {
                                "timed-out-unknown"
                            } else {
                                "failed"
                            },
                            &error.to_string(),
                            ambiguous,
                            None,
                        );
                    }
                    Err(_) => {
                        let started = s.launches.state(&id)?["EffectStarted"] == true;
                        s.launches.update(
                            &id,
                            if started {
                                "timed-out-unknown"
                            } else {
                                "failed"
                            },
                            if started {
                                "delivery deadline; result unknown"
                            } else {
                                "deadline before dispatch"
                            },
                            started,
                            None,
                        );
                    }
                }
                s.mark("launches");
                Ok(())
            })
            .await;
    });
}
#[cfg(test)]
mod tests {
    use super::*;
    fn app() -> App {
        App {
            id: "org.example.App-name.desktop".into(),
            generation: 1,
            digest: String::new(),
            source_hash: String::new(),
            exec_hash: String::new(),
            record: json!({"DesktopPath":"/apps/org.example.App-name.desktop"}),
            executable: String::new(),
            keywords: vec![],
            icon: String::new(),
        }
    }
    #[test]
    fn admission_is_bounded_and_nonce_conflicts_do_not_dispatch() {
        let mut b = Book::default();
        let a = app();
        let id = b
            .insert(
                ":1.1".into(),
                "nonce".into(),
                "digest".into(),
                &a,
                "activate",
                None,
            )
            .unwrap();
        assert_eq!(
            b.existing(":1.1", "nonce", "digest").unwrap(),
            Some(id.clone())
        );
        assert!(b.existing(":1.1", "nonce", "other").is_err());
        assert_eq!(b.existing(":1.2", "nonce", "digest").unwrap(), None);
        for _ in 1..ACTIVE {
            b.insert(
                ":1.1".into(),
                String::new(),
                String::new(),
                &a,
                "activate",
                None,
            )
            .unwrap();
        }
        assert!(
            b.insert(
                ":1.2".into(),
                String::new(),
                String::new(),
                &a,
                "activate",
                None
            )
            .is_err()
        );
        b.finished(&id);
        b.update(&id, "failed", "refused", false, None);
        assert!(
            b.insert(
                ":1.2".into(),
                String::new(),
                String::new(),
                &a,
                "activate",
                None
            )
            .is_ok()
        );
        b.update(&id, "dispatched", "", false, None);
        assert_eq!(b.state(&id).unwrap()["State"], "failed");
    }
    #[test]
    fn unit_identity_and_argv_are_not_shell_or_environment_programs() {
        let a = app();
        assert_eq!(
            unit_name(&a.id, "launch1", 0).unwrap(),
            "app-org.example.App\\x2dname@launch1-0.service"
        );
        let plan = Plan {
            app: a,
            backend: Backend::Exec {
                argv: vec![],
                cwd: "/".into(),
            },
            token: "private".into(),
        };
        let props = properties(
            &plan,
            vec!["/usr/bin/echo".into(), "${HOME};%U".into()],
            "/",
            "private",
        );
        let mut props = props.into_iter().collect::<Dict>();
        let commands = Vec::<(String, Vec<String>, Vec<String>)>::try_from(
            props.remove("ExecStartEx").unwrap(),
        )
        .unwrap();
        assert_eq!(commands[0].1[1], "${HOME};%U");
        assert_eq!(commands[0].2, ["no-env-expand"]);
        let env = Vec::<String>::try_from(props.remove("Environment").unwrap()).unwrap();
        assert!(env.contains(&"XDG_ACTIVATION_TOKEN=private".to_owned()));
        let unset = Vec::<String>::try_from(props.remove("UnsetEnvironment").unwrap()).unwrap();
        assert!(!unset.contains(&"XDG_ACTIVATION_TOKEN".to_owned()));
        let state = json!(Book::default().active());
        assert!(!state.to_string().contains("private"));
    }
    #[test]
    fn correlation_does_not_cancel_the_rest_of_a_multi_file_dispatch() {
        let mut b = Book::default();
        let a = app();
        let id = b
            .insert(":1".into(), "".into(), "".into(), &a, "open", None)
            .unwrap();
        b.bind(&id, "epoch", 4);
        assert!(b.outcome(
            "epoch",
            4,
            &json!({"outcome":"window","window":12}),
            Some(12)
        ));
        assert!(b.may_dispatch(&id));
        b.update(&id, "accepted", "", false, Some("unit-2".into()));
        b.finished(&id);
        b.update(&id, "dispatched", "", false, None);
        let state = b.state(&id).unwrap();
        assert_eq!(state["State"], "window-observed");
        assert_eq!(state["DispatchUnits"], json!(["unit-2"]));
        assert_eq!(state["CausalConfirmed"], true);
    }
    #[test]
    fn weak_matching_needs_a_baseline_and_does_not_claim_simultaneous_launches() {
        let mut b = Book::default();
        let a = app();
        let id = b
            .insert(":1".into(), "".into(), "".into(), &a, "activate", None)
            .unwrap();
        b.started(&id);
        let matches = vec![json!({"WindowId":8,"DesktopId":a.id,"AppGeneration":a.generation})];
        assert!(!b.reconcile("epoch", &matches, Some(8)));
        b.baseline(&id, "epoch".into(), [1].into());
        let other = b
            .insert(":2".into(), "".into(), "".into(), &a, "activate", None)
            .unwrap();
        b.started(&other);
        assert!(!b.reconcile("epoch", &matches, Some(8)));
        b.update(&other, "failed", "denied", false, None);
        assert!(b.reconcile("epoch", &matches, Some(8)));
        assert_eq!(b.state(&id).unwrap()["CausalConfirmed"], false);
    }
    #[test]
    fn finishing_observation_does_not_free_the_dispatch_admission_budget() {
        let mut b = Book::default();
        let a = app();
        let mut first = String::new();
        for n in 0..ACTIVE {
            let id = b
                .insert(":1".into(), "".into(), "".into(), &a, "activate", None)
                .unwrap();
            b.bind(&id, "epoch", n as u64);
            assert!(b.outcome(
                "epoch",
                n as u64,
                &json!({"outcome":"activated","window":1}),
                Some(1)
            ));
            if n == 0 {
                first = id;
            }
        }
        assert!(
            b.insert(":1".into(), "".into(), "".into(), &a, "activate", None)
                .is_err()
        );
        b.finished(&first);
        assert!(
            b.insert(":1".into(), "".into(), "".into(), &a, "activate", None)
                .is_ok()
        );
    }
}
