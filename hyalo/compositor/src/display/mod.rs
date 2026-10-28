// SPDX-License-Identifier: GPL-3.0-or-later
//! Compositor-owned Display1. Rendering state stays on calloop; bus and disk do not.
mod bus;
pub mod hardware;
pub mod model;
mod store;
use crate::{
    backend::Backend,
    config::{OutputConfig, Vrr},
    state::Hyalo,
};
use bus::{Error, Result};
use model::*;
use smithay::reexports::calloop::{
    RegistrationToken, channel,
    timer::{TimeoutAction, Timer},
};
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{Arc, Mutex, mpsc},
    time::{Duration, Instant},
};

type Reply = mpsc::SyncSender<Result<Pending>>;
pub enum Command {
    Preview {
        epoch: u64,
        revision: u64,
        layout: Layout,
    },
    LidState {
        generation: u64,
        sequence: u64,
        closed: bool,
    },
    Confirm(String),
    Cancel(String),
    Identify {
        epoch: u64,
        revision: u64,
    },
}
pub enum Event {
    Command {
        owner: String,
        command: Command,
        reply: Reply,
        expires: Instant,
    },
    OwnerLost(String),
    Loaded(Profiles, BTreeMap<String, OutputConfig>, String),
    Saved(u64, std::result::Result<(), String>),
}
#[derive(Debug, Default, Clone)]
pub struct Identity {
    pub make: String,
    pub model: String,
    pub serial: String,
    pub edid: String,
    pub port: String,
}
/// Stable non-security fingerprint. Duplicate fingerprints are port-disambiguated below.
pub fn edid_key(data: &[u8]) -> String {
    if data.is_empty() {
        return String::new();
    }
    let h = data.iter().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ *b as u64).wrapping_mul(0x100000001b3)
    });
    format!("edid-{}-{h:016x}", data.len())
}
struct Lease {
    owner: String,
    token: String,
    before: Layout,
    after: Layout,
    started: Instant,
    waiting: BTreeSet<String>,
    deadline: Instant,
    deadline_us: u64,
    activated: bool,
    reply: Option<Reply>,
}
impl Lease {
    fn frame(&mut self, name: &str, built: Instant, now: Instant, deadline_us: u64) -> bool {
        if self.activated || built < self.started {
            return false;
        }
        self.waiting.remove(name);
        if !self.waiting.is_empty() {
            return false;
        }
        self.activated = true;
        self.deadline = now + Duration::from_secs(15);
        self.deadline_us = deadline_us;
        true
    }
}
struct Commit {
    serial: u64,
    reply: Reply,
    profiles: Profiles,
}
#[derive(Default)]
pub struct State {
    epoch: u64,
    revision: u64,
    serial: u64,
    generation: u64,
    topology: String,
    reconcile_needed: bool,
    outputs: Vec<Output>,
    primary: String,
    lease: Option<Lease>,
    commit: Option<Commit>,
    profiles: Profiles,
    loaded: bool,
    ready: bool,
    applying: bool,
    notifying: bool,
    event_queued: bool,
    lease_timer: Option<RegistrationToken>,
    signal: Option<mpsc::SyncSender<()>>,
    last_error: String,
    overrides: BTreeMap<String, OutputConfig>,
    legacy: BTreeMap<String, OutputConfig>,
    snapshot: Option<Arc<Mutex<Snapshot>>>,
    hardware: Option<Arc<Mutex<hardware::Snapshot>>>,
    store: Option<mpsc::Sender<store::Save>>,
    /// A temporary panel inhibition, not a saved preference.
    lid_closed: bool,
    lid_before: Option<Layout>,
    lid_owner: String,
    lid_generation: u64,
    lid_sequence: u64,
    recovery: Option<Layout>,
}
impl State {
    pub(crate) fn output_connector(&self, id: &str) -> Option<String> {
        self.outputs
            .iter()
            .find(|o| o.id == id)
            .map(|o| o.connector.clone())
    }
}
fn current_layout(state: &Hyalo) -> Layout {
    let mut layout = observed(&state.displays.outputs, &state.displays.primary);
    layout.mirror_groups = crate::mirror::layout_groups(state, &state.displays.outputs);
    layout
}
fn now_us(state: &Hyalo) -> u64 {
    Duration::from(state.clock.now()).as_micros() as u64
}
fn active(state: &Hyalo) -> bool {
    match &state.backend {
        Backend::Tty(t) => t.session_active(),
        Backend::Winit(_) => true,
    }
}
fn mutation_allowed(state: &Hyalo) -> Result<()> {
    if !active(state) || state.lock.is_locked() {
        return Err(Error::PermissionDenied("session inactive or locked".into()));
    }
    if !state.displays.loaded {
        return Err(Error::Busy("profiles are loading".into()));
    }
    if state.displays.commit.is_some() {
        return Err(Error::Busy("confirmation is being saved".into()));
    }
    Ok(())
}

pub fn start(state: &mut Hyalo) {
    state.displays.epoch = now_us(state).max(1);
    state.displays.revision = 1;
    state.displays.legacy = state.config.outputs.clone();
    let (tx, rx) = channel::channel();
    state
        .loop_handle
        .insert_source(rx, |event, _, state| {
            if let channel::Event::Msg(event) = event {
                handle(state, event);
                reconcile(state);
                publish_if_changed(state);
                arm_lease_timer(state);
            }
        })
        .expect("Display1 channel");
    let (save_tx, save_rx) = mpsc::channel();
    state.displays.store = Some(save_tx);
    let path = store::path();
    let store_tx = tx.clone();
    std::thread::spawn(move || store::run(path, save_rx, store_tx));
    refresh(state);
    let snapshot = Arc::new(Mutex::new(snapshot(state)));
    state.displays.snapshot = Some(snapshot.clone());
    let (signal_tx, signal_rx) = mpsc::sync_channel(1);
    state.displays.signal = Some(signal_tx);
    let hardware = Arc::new(Mutex::new(hardware_snapshot(state)));
    state.displays.hardware = Some(hardware.clone());
    std::thread::spawn(move || bus::serve(tx, snapshot, hardware, signal_rx));
}
fn pending(state: &Hyalo) -> Pending {
    state
        .displays
        .lease
        .as_ref()
        .map(|l| Pending {
            token: l.token.clone(),
            phase: if state.displays.commit.is_some() {
                "saving"
            } else if l.activated {
                "confirming"
            } else {
                "applying"
            }
            .into(),
            deadline_us: l.deadline_us,
        })
        .unwrap_or_default()
}
fn snapshot(state: &Hyalo) -> Snapshot {
    Snapshot {
        epoch: state.displays.epoch,
        revision: state.displays.revision,
        capabilities: {
            let mut c = vec![
                "extend".into(),
                "preview".into(),
                "profiles".into(),
                "identify".into(),
            ];
            if matches!(state.backend, Backend::Tty(_)) {
                c.push("mirror".into());
            }
            c
        },
        outputs: state.displays.outputs.clone(),
        layout: current_layout(state),
        pending: pending(state),
        last_error: state.displays.last_error.clone(),
    }
}
fn hardware_snapshot(state: &Hyalo) -> hardware::Snapshot {
    let mut identities = BTreeMap::new();
    if let Backend::Tty(tty) = &state.backend {
        for (_, c) in tty.connectors() {
            let name = crate::backend::tty::connector_name(c);
            // Ambiguous connector names must never acquire a writable channel.
            identities
                .entry(name)
                .and_modify(|v: &mut Option<Identity>| *v = None)
                .or_insert(Some(tty.display_identity(c)));
        }
    }
    hardware::Snapshot {
        epoch: state.displays.epoch,
        revision: state.displays.revision,
        outputs: state
            .displays
            .outputs
            .iter()
            .map(|o| {
                let identity = identities.get(&o.connector).and_then(|i| i.as_ref()).cloned().unwrap_or_default();
                let size = current_layout(state)
                    .outputs
                    .iter()
                    .find(|s| s.id == o.id)
                    .and_then(|s| dimensions(s, o).ok())
                    .unwrap_or_default();
                hardware::Output {
                    id: o.id.clone(),
                    identity: o.identity.clone(),
                    connector: o.connector.clone(),
                    port: identity.port,
                    edid: identity.edid,
                    internal: o.internal,
                    enabled: o.enabled,
                    logical: crate::backend::physical_output(state, &o.connector).is_some_and(|p| !crate::mirror::follower(&p)),
                    x: o.x,
                    y: o.y,
                    width: size.0,
                    height: size.1,
                }
            })
            .collect(),
    }
}

fn publish(state: &mut Hyalo) {
    state.displays.revision += 1;
    if let Some(s) = &state.displays.snapshot {
        *s.lock().unwrap() = snapshot(state);
    }
    if let Some(hardware) = &state.displays.hardware {
        *hardware.lock().unwrap() = hardware_snapshot(state);
    }
    if let Some(signal) = &state.displays.signal {
        let _ = signal.try_send(());
    }
    state.displays.notifying = true;
    crate::ipc::server::outputs_changed(state);
    state.displays.notifying = false;
}
fn mode_id(w: i32, h: i32, r: i32) -> String {
    format!("{w}x{h}@{r}")
}
fn inventory(state: &Hyalo) -> Vec<Output> {
    let raw = crate::outputs::info(state);
    let mut identities = BTreeMap::new();
    if let Backend::Tty(tty) = &state.backend {
        for (_, c) in tty.connectors() {
            identities.insert(crate::backend::tty::connector_name(c), tty.display_identity(c));
        }
    }
    let keys: Vec<String> = raw
        .iter()
        .map(|o| {
            let i = identities.get(&o.name).cloned().unwrap_or_default();
            let fields = if !i.serial.trim().is_empty() {
                vec![i.make.trim(), i.model.trim(), i.serial.trim()]
            } else if !i.edid.is_empty() {
                vec![i.edid.as_str()]
            } else {
                vec![i.port.as_str(), o.name.as_str()]
            };
            serde_json::to_string(&fields).unwrap()
        })
        .collect();
    let mut result: Vec<Output> = raw
        .iter()
        .zip(&keys)
        .map(|(o, key)| {
            let i = identities.get(&o.name).cloned().unwrap_or_default();
            let identity = if keys.iter().filter(|k| *k == key).count() > 1 {
                format!("{key}:{}", i.port)
            } else {
                key.clone()
            };
            let modes: Vec<Mode> = o
                .modes
                .iter()
                .map(|m| Mode {
                    id: mode_id(m.width, m.height, m.refresh),
                    width: m.width,
                    height: m.height,
                    refresh_mhz: m.refresh,
                    preferred: m.preferred,
                })
                .collect();
            let cfg = state.config.outputs.get(&o.name);
            let mode = o
                .current_mode
                .as_ref()
                .map(|m| mode_id(m.width, m.height, m.refresh))
                .or_else(|| {
                    let (w, h, r) = cfg.and_then(|c| c.parsed_mode())?;
                    modes
                        .iter()
                        .find(|m| m.width == w && m.height == h && r.is_none_or(|r| r == m.refresh_mhz))
                        .map(|m| m.id.clone())
                })
                .or_else(|| {
                    modes
                        .iter()
                        .find(|m| m.preferred)
                        .or(modes.first())
                        .map(|m| m.id.clone())
                })
                .unwrap_or_default();
            Output {
                id: o.name.clone(),
                identity,
                connector: o.name.clone(),
                internal: internal(&o.name),
                enabled: o.enabled,
                powered: o.powered,
                make: if i.make.is_empty() { o.make.clone() } else { i.make },
                model: if i.model.is_empty() { o.model.clone() } else { i.model },
                serial: if i.serial.is_empty() {
                    o.serial.clone()
                } else {
                    i.serial
                },
                physical_width_mm: o.physical_size.0,
                physical_height_mm: o.physical_size.1,
                modes,
                current_mode: mode,
                scale: if o.enabled {
                    o.scale
                } else {
                    cfg.map_or(1.0, |c| c.scale)
                },
                transform: if matches!(state.backend, Backend::Winit(_)) {
                    "normal".into()
                } else if o.enabled {
                    o.transform.clone()
                } else {
                    cfg.map_or("normal".into(), |c| c.transform.clone())
                },
                x: o.position.or_else(|| cfg.and_then(|c| c.position)).map_or(0, |p| p.0),
                y: o.position.or_else(|| cfg.and_then(|c| c.position)).map_or(0, |p| p.1),
                vrr_supported: o.vrr_supported,
                vrr: match o.vrr {
                    Vrr::Off => "off",
                    Vrr::On => "on",
                    Vrr::Games => "games",
                }
                .into(),
                vrr_enabled: o.vrr_enabled,
                number: 0,
            }
        })
        .collect();
    result.sort_by(|a, b| a.connector.cmp(&b.connector));
    for (n, o) in result.iter_mut().enumerate() {
        o.number = n as u32 + 1;
    }
    result
}
/// Refresh cheap cached discovery; DRM EDID is read only at connector events.
fn refresh(state: &mut Hyalo) -> bool {
    let mut outputs = inventory(state);
    let topology = serde_json::to_string(
        &outputs
            .iter()
            .map(|o| (&o.connector, &o.identity, &o.modes))
            .collect::<Vec<_>>(),
    )
    .unwrap();
    let changed = topology != state.displays.topology;
    if changed {
        state.displays.generation += 1;
        state.displays.topology = topology;
    }
    for o in &mut outputs {
        o.id = format!("{}:{}:{}", state.displays.epoch, state.displays.generation, o.connector);
    }
    if state.displays.outputs != outputs {
        state.displays.outputs = outputs;
    }
    changed
}
fn reconcile(state: &mut Hyalo) {
    if !state.displays.ready {
        return;
    }
    if refresh(state) {
        state.displays.reconcile_needed = true;
    }
    if active(state)
        && let Some(before) = state.displays.recovery.take()
        && apply(state, &before).is_err()
    {
        safe_layout(state);
    }
    if state.displays.reconcile_needed && state.displays.commit.is_none() {
        state.displays.reconcile_needed = false;
        rollback(state, "topology changed");
        state.displays.lid_before = None;
        restore_profile(state);
    }
    if state.displays.commit.is_none() {
        let reason = state.displays.lease.as_ref().and_then(|l| {
            if !active(state) || state.lock.is_locked() {
                Some("session inactive")
            } else if Instant::now() >= l.deadline {
                Some(if l.activated {
                    "confirmation expired"
                } else {
                    "activation timed out"
                })
            } else {
                None
            }
        });
        if let Some(reason) = reason {
            rollback(state, reason);
        }
    }
    reconcile_lid(state);
    publish_if_changed(state);
}
fn check_version(state: &Hyalo, epoch: u64, revision: u64) -> Result<()> {
    if epoch != state.displays.epoch || revision != state.displays.revision {
        Err(Error::StaleState("reread snapshot".into()))
    } else {
        Ok(())
    }
}
fn handle(state: &mut Hyalo, event: Event) {
    match event {
        Event::Loaded(p, overrides, error) => {
            state.displays.last_error = error;
            state.displays.overrides = overrides;
            state.displays.legacy = state.config.outputs.clone();
            state.displays.profiles = p;
            state.displays.loaded = true;
            state.displays.ready = true;
            restore_profile(state);
        }
        Event::OwnerLost(owner) => {
            if state.displays.lid_owner == owner {
                state.displays.lid_closed = false;
                state.displays.lid_owner.clear();
                reconcile_lid(state);
            }
            if state.displays.lease.as_ref().is_some_and(|l| l.owner == owner) && state.displays.commit.is_none() {
                rollback(state, "client disconnected");
            }
        }
        Event::Saved(serial, result) => {
            let Some(c) = state.displays.commit.take() else { return };
            if c.serial != serial {
                state.displays.commit = Some(c);
                return;
            }
            match result {
                Ok(()) => {
                    state.displays.profiles = c.profiles;
                    state.displays.lease = None;
                    state.displays.last_error.clear();
                    let _ = c.reply.send(Ok(Pending::default()));
                }
                Err(e) => {
                    state.displays.last_error = e.clone();
                    let _ = c.reply.send(Err(Error::PersistenceFailed(e)));
                }
            }
        }
        Event::Command {
            owner,
            command,
            reply,
            expires,
        } => {
            if Instant::now() > expires {
                let _ = reply.send(Err(Error::Expired("request expired before execution".into())));
                return;
            }
            reconcile(state);
            let result = command_inner(state, owner, command, reply.clone());
            if let Some(result) = result {
                let _ = reply.send(result);
            }
        }
    }
}
fn command_inner(state: &mut Hyalo, owner: String, command: Command, reply: Reply) -> Option<Result<Pending>> {
    if let Command::LidState {
        generation,
        sequence,
        closed,
    } = &command
    {
        if state.displays.lid_owner == owner
            && (*generation < state.displays.lid_generation
                || (*generation == state.displays.lid_generation && *sequence <= state.displays.lid_sequence))
        {
            return Some(Err(Error::StaleState("obsolete lid effect".into())));
        }
        state.displays.lid_owner = owner;
        state.displays.lid_generation = *generation;
        state.displays.lid_sequence = *sequence;
        lid_policy(state, *closed);
        return Some(Ok(Pending::default()));
    }
    // Cancel remains available when activity/lock changes.
    if let Command::Cancel(token) = &command {
        return Some(owned(state, token, &owner).map(|_| ()).map(|_| {
            rollback(state, "cancelled");
            Pending::default()
        }));
    }
    if let Err(e) = mutation_allowed(state) {
        return Some(Err(e));
    }
    match command {
        Command::Preview {
            epoch,
            revision,
            layout,
        } => {
            if let Err(e) = check_version(state, epoch, revision) {
                return Some(Err(e));
            }
            if state.displays.lease.is_some() {
                return Some(Err(Error::Busy("confirm or cancel the current preview".into())));
            }
            if state.displays.lid_before.is_some() {
                return Some(Err(Error::Busy("open the lid before editing the layout".into())));
            }
            let layout = match validate(layout, &state.displays.outputs) {
                Ok(l) => l,
                Err(e) => return Some(Err(Error::InvalidLayout(e))),
            };
            if matches!(state.backend, Backend::Winit(_))
                && layout
                    .outputs
                    .iter()
                    .any(|s| !s.enabled || s.transform != "normal" || s.vrr != "off")
            {
                return Some(Err(Error::Unsupported(
                    "nested backend cannot disable, rotate or use VRR".into(),
                )));
            }
            if !layout.mirror_groups.is_empty() {
                let result = match &mut state.backend {
                    Backend::Tty(t) => t.mirror_preflight(&layout, &state.displays.outputs),
                    Backend::Winit(_) => Err("mirroring needs multiple physical scanouts".into()),
                };
                if let Err(e) = result {
                    return Some(Err(Error::Unsupported(e)));
                }
            }
            if let Err(e) = check_overrides(state, &layout) {
                return Some(Err(Error::InvalidLayout(e)));
            }
            let before = current_layout(state);
            state.displays.serial += 1;
            let token = format!("{}-{}", state.displays.epoch, state.displays.serial);
            let started = Instant::now();
            let waiting = layout
                .outputs
                .iter()
                .filter(|s| s.enabled)
                .filter_map(|s| {
                    state
                        .displays
                        .outputs
                        .iter()
                        .find(|o| o.id == s.id)
                        .map(|o| o.connector.clone())
                })
                .collect();
            state.displays.lease = Some(Lease {
                owner,
                token,
                before,
                after: layout.clone(),
                started,
                waiting,
                deadline: started + Duration::from_secs(5),
                deadline_us: 0,
                activated: false,
                reply: Some(reply),
            });
            let before = state.displays.lease.as_ref().unwrap().before.clone();
            if let Err((error, restored)) = transaction(&before, &layout, |l| apply(state, l)) {
                let mut lease = state.displays.lease.take().unwrap();
                state.displays.last_error = error.clone();
                if !restored {
                    safe_layout(state);
                }
                if let Some(reply) = lease.reply.take() {
                    let _ = reply.send(Err(Error::ApplyFailed(error)));
                }
                publish(state);
                return None;
            }
            publish(state);
            None
        }
        Command::Confirm(token) => {
            if let Err(e) = owned(state, &token, &owner) {
                return Some(Err(e));
            }
            let l = state.displays.lease.as_ref().unwrap();
            if !l.activated || Instant::now() >= l.deadline {
                return Some(Err(Error::Expired("preview not active or expired".into())));
            }
            let mut profiles = state.displays.profiles.clone();
            profiles.remember(&state.displays.outputs, &l.after);
            state.displays.serial += 1;
            let serial = state.displays.serial;
            if state
                .displays
                .store
                .as_ref()
                .unwrap()
                .send(store::Save {
                    serial,
                    profiles: profiles.clone(),
                })
                .is_err()
            {
                return Some(Err(Error::PersistenceFailed("disk worker stopped".into())));
            }
            // Confirmation has been accepted. Resolve this durable commit before any later
            // layout mutation; owner loss cannot undo an explicitly accepted confirmation.
            state.displays.commit = Some(Commit {
                serial,
                reply,
                profiles,
            });
            None
        }
        Command::Identify { epoch, revision } => {
            if let Err(e) = check_version(state, epoch, revision) {
                return Some(Err(e));
            }
            identify(state);
            Some(Ok(Pending::default()))
        }
        Command::Cancel(_) | Command::LidState { .. } => unreachable!(),
    }
}
fn owned(state: &Hyalo, token: &str, owner: &str) -> Result<()> {
    let l = state
        .displays
        .lease
        .as_ref()
        .filter(|l| l.token == token)
        .ok_or_else(|| Error::Expired("preview expired".into()))?;
    if l.owner != owner {
        return Err(Error::PermissionDenied("preview belongs to another sender".into()));
    }
    if state.displays.commit.is_some() {
        return Err(Error::Busy("confirmation already accepted".into()));
    }
    Ok(())
}
/// Only a successfully submitted frame BUILT after the apply can activate the lease.
pub fn presented(state: &mut Hyalo, name: &str, built: Instant) {
    let deadline_us = now_us(state) + 15_000_000;
    let Some(l) = state.displays.lease.as_mut() else { return };
    if l.frame(name, built, Instant::now(), deadline_us) {
        let reply = l.reply.take();
        publish(state);
        if let Some(reply) = reply {
            let _ = reply.send(Ok(pending(state)));
        }
        arm_lease_timer(state);
    }
}
fn rollback(state: &mut Hyalo, reason: &str) {
    if state.displays.commit.is_some() {
        return;
    }
    let Some(mut l) = state.displays.lease.take() else {
        return;
    };
    state.displays.last_error = reason.into();
    if let Some(reply) = l.reply.take() {
        let _ = reply.send(Err(Error::ApplyFailed(reason.into())));
    }
    if !active(state) {
        state.displays.recovery = Some(l.before);
    } else if apply(state, &l.before).is_err() {
        safe_layout(state);
    }
    refresh(state);
    publish(state);
}
fn apply(state: &mut Hyalo, layout: &Layout) -> std::result::Result<(), String> {
    let outputs = state.displays.outputs.clone();
    if !layout.mirror_groups.is_empty() {
        match &mut state.backend {
            Backend::Tty(t) => t.mirror_preflight(layout, &outputs)?,
            Backend::Winit(_) => return Err("mirroring needs multiple physical scanouts".into()),
        }
    }
    // Refuse ambiguous connector names rather than applying a change to another GPU.
    let raw = crate::outputs::info(state);
    if raw.iter().map(|o| &o.name).collect::<BTreeSet<_>>().len() != raw.len() {
        return Err("duplicate connector names across GPUs are unsupported".into());
    }
    state.displays.applying = true;
    let result = (|| {
        // Enable destinations before removing origins. All target configs are installed first.
        let mut configs = Vec::new();
        for s in &layout.outputs {
            let o = outputs.iter().find(|o| o.id == s.id).ok_or("output identity changed")?;
            let m = o.modes.iter().find(|m| m.id == s.mode);
            if s.enabled && m.is_none() {
                return Err("mode disappeared".into());
            }
            let cfg = OutputConfig {
                enabled: s.enabled,
                mode: m
                    .map(|m| format!("{}x{}@{:.3}", m.width, m.height, m.refresh_mhz as f64 / 1000.0))
                    .unwrap_or_default(),
                scale: s.scale,
                position: Some((s.x, s.y)),
                transform: s.transform.clone(),
                vrr: match s.vrr.as_str() {
                    "on" => Vrr::On,
                    "games" => Vrr::Games,
                    _ => Vrr::Off,
                },
            };
            state.config.outputs.insert(o.connector.clone(), cfg.clone());
            configs.push((o.connector.clone(), cfg));
        }
        configs.sort_by_key(|(_, c)| !c.enabled);
        for (name, cfg) in &configs {
            crate::outputs::apply(state, name, cfg)?;
        }
        crate::outputs::arrange(state);
        // Existing backend methods may return Ok after a failed connector initialization.
        let actual = crate::outputs::info(state);
        for (name, cfg) in configs {
            let o = actual
                .iter()
                .find(|o| o.name == name)
                .ok_or("output disappeared during apply")?;
            if o.enabled != cfg.enabled {
                return Err("output enable/disable not observed".into());
            }
            if cfg.enabled {
                let want = cfg.parsed_mode().ok_or("invalid prepared mode")?;
                if !o
                    .current_mode
                    .as_ref()
                    .is_some_and(|m| m.width == want.0 && m.height == want.1 && Some(m.refresh) == want.2)
                {
                    return Err("requested mode not observed".into());
                }
            }
        }
        state.displays.primary = layout.primary.clone();
        crate::mirror::install(state, layout)?;
        Ok(())
    })();
    state.displays.applying = false;
    refresh(state);
    force_redraw(state);
    result
}
fn safe_layout(state: &mut Hyalo) {
    let outputs = state.displays.outputs.clone();
    let mut l = default_layout(&outputs);
    if l.outputs.is_empty() {
        return;
    }
    if let Some(existing) = outputs.iter().find(|o| o.enabled && !o.modes.is_empty()) {
        l.primary = existing.id.clone();
    }
    for s in &mut l.outputs {
        s.enabled = s.id == l.primary;
    }
    if let Err(e) = apply(state, &l) {
        state.displays.last_error = format!("safe output recovery failed: {e}");
    }
}
fn restore_profile(state: &mut Hyalo) {
    if state.displays.commit.is_some() || !active(state) {
        return;
    }
    let outputs = state.displays.outputs.clone();
    if outputs.is_empty() {
        return;
    }
    let recalled = state.displays.profiles.recall(&outputs);
    let mut layout = recalled.clone().unwrap_or_else(|| default_layout(&outputs));
    if recalled.is_none() {
        merge_configs(&outputs, &mut layout, &state.displays.legacy);
    }
    merge_overrides(state, &mut layout);
    if let Err(e) = validate(layout.clone(), &outputs).and_then(|l| apply(state, &l)) {
        state.displays.last_error = format!("profile/configuration refused: {e}");
        safe_layout(state);
    }
}

// Identify's render elements are compositor-owned and expire without a client.
fn identify(state: &mut Hyalo) {
    for o in crate::backend::physical_outputs(state) {
        if let Some(info) = state
            .displays
            .outputs
            .iter()
            .find(|d| d.connector == o.name())
        {
            super::display::identify::show(&o, info.number);
        }
    }
    state.queue_redraw(None);
    state
        .loop_handle
        .insert_source(Timer::from_duration(Duration::from_secs(3)), |_, _, state| {
            state.queue_redraw(None);
            TimeoutAction::Drop
        })
        .ok();
}
pub mod identify;

/// Called exclusively by the existing Power1 policy, never by an independent lid watcher.
pub fn lid_policy(state: &mut Hyalo, closed: bool) {
    state.displays.lid_closed = closed;
    reconcile_lid(state);
}
fn reconcile_lid(state: &mut Hyalo) {
    if !state.displays.ready
        || state.displays.commit.is_some()
        || !active(state)
        || !state.idle.session
        || state.idle.nested
    {
        return;
    }
    let outputs = state.displays.outputs.clone();
    let inhibit = lid_inhibited(&outputs, state.displays.lid_closed);
    if inhibit && state.displays.lid_before.is_none() {
        rollback(state, "lid policy changed");
        // Rollback may have removed the external enabled by an unconfirmed preview.
        // Re-read the restored state before deciding whether the panel can go dark.
        let outputs = state.displays.outputs.clone();
        let Some(l) = lid_layout(
            &outputs,
            &state.displays.primary,
            &current_layout(state).mirror_groups,
        ) else {
            return;
        };
        let before = current_layout(state);
        if apply(state, &l).is_ok() {
            state.displays.lid_before = Some(before);
        }
    } else if !inhibit
        && let Some(before) = state.displays.lid_before.take()
        && apply(state, &before).is_err()
    {
        safe_layout(state);
    }
}

fn lid_inhibited(outputs: &[Output], closed: bool) -> bool {
    closed && outputs.iter().any(|o| o.internal) && outputs.iter().any(|o| !o.internal && o.enabled)
}
fn lid_layout(outputs: &[Output], primary: &str, groups: &[Vec<String>]) -> Option<Layout> {
    if !outputs.iter().any(|o| o.internal && o.enabled)
        || !outputs.iter().any(|o| !o.internal && o.enabled)
    {
        return None;
    }
    let mut l = observed(outputs, primary);
    for setting in &mut l.outputs {
        if outputs.iter().any(|o| o.id == setting.id && o.internal) {
            setting.enabled = false;
        }
    }
    l.mirror_groups = groups
        .iter()
        .filter_map(|g| {
            let remaining: Vec<_> = g
                .iter()
                .filter(|id| l.outputs.iter().any(|s| s.id == **id && s.enabled))
                .cloned()
                .collect();
            (remaining.len() >= 2).then_some(remaining)
        })
        .collect();
    l.primary = outputs
        .iter()
        .find(|o| !o.internal && o.enabled)?
        .id
        .clone();
    if let Some(group) = l.mirror_groups.iter().find(|g| g.contains(&l.primary)) {
        l.primary = group[0].clone();
    }
    let min_x = l.outputs.iter().filter(|s| s.enabled).map(|s| s.x).min()?;
    let min_y = l.outputs.iter().filter(|s| s.enabled).map(|s| s.y).min()?;
    for setting in l.outputs.iter_mut().filter(|s| s.enabled) {
        setting.x -= min_x;
        setting.y -= min_y;
    }
    if let Ok(connected) = validate(l.clone(), outputs) {
        return Some(connected);
    }
    // Removing a bridge panel can disconnect the remaining graph. Only then reflow.
    l.outputs.sort_by_key(|s| (s.x, s.y, s.id.clone()));
    let mut x = 0;
    let followers: std::collections::BTreeSet<_> = l
        .mirror_groups
        .iter()
        .flat_map(|g| g.iter().skip(1).cloned())
        .collect();
    for setting in l
        .outputs
        .iter_mut()
        .filter(|s| s.enabled && !followers.contains(&s.id))
    {
        setting.x = x;
        setting.y = 0;
        x += dimensions(setting, outputs.iter().find(|o| o.id == setting.id)?)
            .ok()?
            .0;
    }
    validate(l, outputs).ok()
}

fn merge_overrides(state: &Hyalo, layout: &mut Layout) {
    merge_configs(&state.displays.outputs, layout, &state.displays.overrides);
}
fn merge_configs(outputs: &[Output], layout: &mut Layout, configs: &BTreeMap<String, OutputConfig>) {
    for s in &mut layout.outputs {
        let Some(o) = outputs.iter().find(|o| o.id == s.id) else {
            continue;
        };
        let Some(c) = configs.get(&o.connector) else {
            continue;
        };
        s.enabled = c.enabled;
        s.scale = c.scale;
        s.transform = c.transform.clone();
        s.vrr = match c.vrr {
            Vrr::Off => "off",
            Vrr::On => "on",
            Vrr::Games => "games",
        }
        .into();
        if let Some((x, y)) = c.position {
            s.x = x;
            s.y = y;
        }
        if let Some((w, h, r)) = c.parsed_mode()
            && let Some(m) = o
                .modes
                .iter()
                .find(|m| m.width == w && m.height == h && r.is_none_or(|r| r == m.refresh_mhz))
        {
            s.mode = m.id.clone();
        }
    }
    if !layout.outputs.iter().any(|s| s.id == layout.primary && s.enabled) {
        layout.primary = layout
            .outputs
            .iter()
            .find(|s| s.enabled)
            .map(|s| s.id.clone())
            .unwrap_or_default();
    }
}
fn check_overrides(state: &Hyalo, layout: &Layout) -> std::result::Result<(), String> {
    let mut constrained = layout.clone();
    merge_overrides(state, &mut constrained);
    if constrained != *layout {
        Err("layout conflicts with explicit compositor configuration; edit the override first".into())
    } else {
        Ok(())
    }
}
/// Existing config reloads cannot bypass a preview or apply half a display layout.
pub fn config_changed(state: &mut Hyalo, overrides: BTreeMap<String, OutputConfig>) {
    rollback(state, "configuration reloaded");
    state.displays.overrides = overrides;
    state.displays.legacy = state.config.outputs.clone();
    if state.displays.ready {
        restore_profile(state);
    }
}
/// A legacy runtime SetOutput is validated as one whole desktop. It never persists.
pub fn legacy_apply(state: &mut Hyalo, name: &str, cfg: &OutputConfig) -> std::result::Result<(), String> {
    if !state.displays.ready {
        return Err("Display1 is loading".into());
    }
    mutation_allowed(state).map_err(|e| e.to_string())?;
    if state.displays.lease.is_some() {
        return Err("confirm or cancel Display1 preview first".into());
    }
    let before = current_layout(state);
    let mut layout = before.clone();
    let o = state
        .displays
        .outputs
        .iter()
        .find(|o| o.connector == name)
        .ok_or("output unavailable")?;
    let s = layout.outputs.iter_mut().find(|s| s.id == o.id).unwrap();
    s.enabled = cfg.enabled;
    s.scale = cfg.scale;
    s.transform = cfg.transform.clone();
    s.vrr = match cfg.vrr {
        Vrr::Off => "off",
        Vrr::On => "on",
        Vrr::Games => "games",
    }
    .into();
    if let Some((x, y)) = cfg.position {
        s.x = x;
        s.y = y;
    }
    if let Some((w, h, r)) = cfg.parsed_mode() {
        s.mode = o
            .modes
            .iter()
            .find(|m| m.width == w && m.height == h && r.is_none_or(|r| r == m.refresh_mhz))
            .ok_or("mode not advertised")?
            .id
            .clone();
    }
    if !layout.outputs.iter().any(|s| s.id == layout.primary && s.enabled) {
        layout.primary = layout
            .outputs
            .iter()
            .find(|s| s.enabled)
            .map(|s| s.id.clone())
            .unwrap_or_default();
    }
    let layout = validate(layout, &state.displays.outputs)?;
    check_overrides(state, &layout)?;
    match apply(state, &layout) {
        Ok(()) => Ok(()),
        Err(e) => {
            if apply(state, &before).is_err() {
                safe_layout(state);
            }
            Err(e)
        }
    }
}

pub fn preview_pending(state: &Hyalo) -> bool {
    state.displays.lease.is_some() || state.displays.commit.is_some()
}

fn force_redraw(state: &mut Hyalo) {
    match &mut state.backend {
        Backend::Tty(t) => t.display_redraw(),
        Backend::Winit(w) => w.display_redraw(),
    }
    state.queue_redraw(None);
}

/// Validate the fully merged configuration before a settings patch reaches disk.
pub fn validate_config(state: &Hyalo, configs: &BTreeMap<String, OutputConfig>) -> std::result::Result<(), String> {
    if !state.displays.ready {
        return Ok(());
    }
    if preview_pending(state) {
        return Err("confirm or cancel Display1 preview first".into());
    }
    let mut layout = current_layout(state);
    for s in &mut layout.outputs {
        let o = state.displays.outputs.iter().find(|o| o.id == s.id).unwrap();
        let Some(c) = configs.get(&o.connector) else { continue };
        s.enabled = c.enabled;
        s.scale = c.scale;
        s.transform = c.transform.clone();
        s.vrr = match c.vrr {
            Vrr::Off => "off",
            Vrr::On => "on",
            Vrr::Games => "games",
        }
        .into();
        if let Some((x, y)) = c.position {
            s.x = x;
            s.y = y;
        }
        if let Some((w, h, r)) = c.parsed_mode() {
            s.mode = o
                .modes
                .iter()
                .find(|m| m.width == w && m.height == h && r.is_none_or(|r| r == m.refresh_mhz))
                .ok_or("configured mode is not advertised")?
                .id
                .clone();
        }
    }
    if !layout.outputs.iter().any(|s| s.id == layout.primary && s.enabled) {
        layout.primary = layout
            .outputs
            .iter()
            .find(|s| s.enabled)
            .map(|s| s.id.clone())
            .unwrap_or_default();
    }
    validate(layout, &state.displays.outputs).map(|_| ())
}

pub fn before_reload(state: &mut Hyalo) {
    rollback(state, "configuration reloaded");
}

fn publish_if_changed(state: &mut Hyalo) {
    let changed = state
        .displays
        .snapshot
        .as_ref()
        .is_some_and(|s| *s.lock().unwrap() != snapshot(state));
    if changed {
        publish(state);
    }
}
pub fn applying(state: &Hyalo) -> bool {
    state.displays.applying
}

/// Recovery ordering shared by the real backend and fault tests. A backend may mutate
/// before failing, so even the first failed apply always attempts the complete old layout.
fn transaction<T, E>(
    before: &T,
    after: &T,
    mut apply: impl FnMut(&T) -> std::result::Result<(), E>,
) -> std::result::Result<(), (E, bool)> {
    match apply(after) {
        Ok(()) => Ok(()),
        Err(error) => {
            let restored = apply(before).is_ok();
            Err((error, restored))
        }
    }
}

pub fn owns_profile(state: &Hyalo) -> bool {
    state.displays.profiles.recall(&state.displays.outputs).is_some()
}

/// Coalesce compositor events into one reconciliation after the current mutation.
/// No periodic inventory walk or wakeup exists when there is no event or lease.
pub fn changed(state: &mut Hyalo) {
    if !state.displays.ready || state.displays.applying || state.displays.notifying || state.displays.event_queued {
        return;
    }
    state.displays.event_queued = true;
    state.loop_handle.insert_idle(|state| {
        state.displays.event_queued = false;
        reconcile(state);
        arm_lease_timer(state);
    });
}
fn arm_lease_timer(state: &mut Hyalo) {
    if let Some(token) = state.displays.lease_timer.take() {
        state.loop_handle.remove(token);
    }
    let deadline = state
        .displays
        .lease
        .as_ref()
        .filter(|_| state.displays.commit.is_none())
        .map(|l| l.deadline);
    let Some(deadline) = deadline else { return };
    let token = state
        .loop_handle
        .insert_source(Timer::from_deadline(deadline), |_, _, state| {
            state.displays.lease_timer = None;
            reconcile(state);
            arm_lease_timer(state);
            TimeoutAction::Drop
        })
        .expect("Display1 lease deadline");
    state.displays.lease_timer = Some(token);
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_lid_stays_inhibited_across_dpms_idle_and_wake() {
        let mut outputs = vec![
            model::tests::output("internal", true, 100, 100),
            model::tests::output("external", false, 200, 100),
        ];
        outputs[1].x = 100;
        let l = lid_layout(&outputs, "internal", &[]).unwrap();
        for o in &mut outputs {
            let setting = l.outputs.iter().find(|s| s.id == o.id).unwrap();
            o.enabled = setting.enabled;
            o.x = setting.x;
            o.y = setting.y;
        }
        assert!(lid_inhibited(&outputs, true));
        assert!(!outputs[0].enabled);
        for o in &mut outputs {
            o.powered = false;
        }
        // This is the same predicate used on an output event: DPMS must not restore lid_before.
        assert!(lid_inhibited(&outputs, true));
        assert!(!outputs[0].enabled);
        for o in &mut outputs {
            o.powered = true;
        }
        assert!(lid_inhibited(&outputs, true));
        assert!(!outputs[0].enabled);
        assert!(!lid_inhibited(&outputs, false));
        outputs[1].enabled = false;
        assert!(!lid_inhibited(&outputs, true));
    }
    #[test]
    fn lid_preserves_stacked_externals_and_only_compacts_a_disconnected_graph() {
        let mut outputs = vec![
            model::tests::output("internal", true, 100, 100),
            model::tests::output("a", false, 100, 100),
            model::tests::output("b", false, 100, 100),
        ];
        outputs[0].x = 100;
        outputs[2].y = 100;
        let l = lid_layout(&outputs, "internal", &[]).unwrap();
        let a = l.outputs.iter().find(|s| s.id == "a").unwrap();
        let b = l.outputs.iter().find(|s| s.id == "b").unwrap();
        assert_eq!((b.x - a.x, b.y - a.y), (0, 100));
        outputs[0].x = 0;
        outputs[1].x = -100;
        outputs[2].x = 100;
        outputs[2].y = 0;
        let l = lid_layout(&outputs, "internal", &[]).unwrap();
        assert!(validate(l, &outputs).is_ok());
        outputs[1].enabled = false;
        outputs[2].enabled = false;
        assert!(lid_layout(&outputs, "internal", &[]).is_none());
    }
    #[test]
    fn lid_promotes_an_external_mirror_source_without_overlapping_desktops() {
        let outputs = vec![
            model::tests::output("internal", true, 1920, 1080),
            model::tests::output("a", false, 1024, 768),
            model::tests::output("b", false, 800, 600),
        ];
        let groups = vec![vec!["internal".into(), "b".into(), "a".into()]];
        let l = lid_layout(&outputs, "internal", &groups).unwrap();
        assert_eq!(l.primary, "b");
        assert_eq!(l.mirror_groups, vec![vec!["b", "a"]]);
        assert!(
            !l.outputs
                .iter()
                .find(|s| s.id == "internal")
                .unwrap()
                .enabled
        );
        assert!(validate(l, &outputs).is_ok());
        let groups = vec![vec!["internal".into(), "a".into()]];
        let l = lid_layout(&outputs[..2], "internal", &groups).unwrap();
        assert!(l.mirror_groups.is_empty());
        assert_eq!(l.primary, "a");
    }
    #[test]
    fn lease_waits_for_all_new_frames_then_allows_exactly_fifteen_seconds() {
        let now = Instant::now();
        let mut lease = Lease {
            owner: ":1.2".into(),
            token: "token".into(),
            before: Layout::default(),
            after: Layout::default(),
            started: now,
            waiting: BTreeSet::from(["a".into(), "b".into()]),
            deadline: now + Duration::from_secs(5),
            deadline_us: 0,
            activated: false,
            reply: None,
        };
        assert!(!lease.frame("a", now - Duration::from_millis(1), now, 0));
        assert_eq!(lease.waiting.len(), 2);
        assert!(!lease.frame("a", now, now, 0));
        assert!(!lease.activated);
        assert_eq!(lease.deadline, now + Duration::from_secs(5));
        let activated = now + Duration::from_secs(2);
        assert!(lease.frame("b", activated, activated, 42_000_000));
        assert!(lease.activated);
        assert_eq!(lease.deadline, activated + Duration::from_secs(15));
        assert_eq!(lease.deadline_us, 42_000_000);
        assert!(!lease.frame("b", activated, activated + Duration::from_secs(1), 99_000_000));
        assert_eq!(lease.deadline, activated + Duration::from_secs(15));
    }
    #[test]
    fn partial_backend_failure_restores_every_previous_output() {
        let before = vec![1, 2];
        let after = vec![3, 4];
        let mut hardware = before.clone();
        let mut calls = Vec::new();
        let result = transaction(&before, &after, |layout| {
            calls.push(layout.clone());
            hardware[0] = layout[0];
            if layout[1] == 4 {
                return Err("second output failed");
            }
            hardware[1] = layout[1];
            Ok(())
        });
        assert_eq!(result, Err(("second output failed", true)));
        assert_eq!(hardware, before);
        assert_eq!(calls, vec![after, before]);
    }
    #[test]
    fn failed_recovery_is_distinct_and_requires_safe_fallback() {
        let mut calls = 0;
        let result = transaction(&1, &2, |_| {
            calls += 1;
            Err("hardware unavailable")
        });
        assert_eq!(result, Err(("hardware unavailable", false)));
        assert_eq!(calls, 2);
    }
    #[test]
    fn success_does_not_apply_previous_layout() {
        let mut calls = Vec::new();
        assert_eq!(
            transaction(&1, &2, |l| {
                calls.push(*l);
                Ok::<_, ()>(())
            }),
            Ok(())
        );
        assert_eq!(calls, vec![2]);
    }
    #[test]
    fn edid_fingerprint_is_stable_and_missing_edid_is_explicit() {
        assert_eq!(edid_key(&[]), "");
        assert_eq!(edid_key(&[1, 2, 3]), edid_key(&[1, 2, 3]));
        assert_ne!(edid_key(&[1, 2, 3]), edid_key(&[1, 2, 4]));
    }
}
