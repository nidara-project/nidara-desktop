// SPDX-License-Identifier: GPL-3.0-or-later
//! Compositor-owned Display1. Rendering state stays on calloop; bus and disk do not.
mod bus;
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
    channel,
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
    last_error: String,
    overrides: BTreeMap<String, OutputConfig>,
    legacy: BTreeMap<String, OutputConfig>,
    snapshot: Option<Arc<Mutex<Snapshot>>>,
    store: Option<mpsc::Sender<store::Save>>,
    /// A temporary panel inhibition, not a saved preference.
    lid_closed: bool,
    lid_before: Option<Layout>,
    lid_owner: String,
    lid_generation: u64,
    lid_sequence: u64,
    recovery: Option<Layout>,
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
                publish_if_changed(state);
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
    std::thread::spawn(move || bus::serve(tx, snapshot));
    state
        .loop_handle
        .insert_source(Timer::from_duration(Duration::from_millis(100)), |_, _, state| {
            tick(state);
            TimeoutAction::ToDuration(Duration::from_millis(100))
        })
        .expect("Display1 recovery timer");
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
        capabilities: vec!["extend".into(), "preview".into(), "profiles".into(), "identify".into()],
        outputs: state.displays.outputs.clone(),
        layout: observed(&state.displays.outputs, &state.displays.primary),
        pending: pending(state),
        last_error: state.displays.last_error.clone(),
    }
}
fn publish(state: &mut Hyalo) {
    state.displays.revision += 1;
    if let Some(s) = &state.displays.snapshot {
        *s.lock().unwrap() = snapshot(state);
    }
    crate::ipc::server::outputs_changed(state);
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
fn tick(state: &mut Hyalo) {
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
            tick(state);
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
            if let Err(e) = check_overrides(state, &layout) {
                return Some(Err(Error::InvalidLayout(e)));
            }
            let before = observed(&state.displays.outputs, &state.displays.primary);
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
    for o in state.space.outputs() {
        if let Some(info) = state.displays.outputs.iter().find(|d| d.connector == o.name()) {
            super::display::identify::show(o, info.number);
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
    let external = outputs.iter().any(|o| !o.internal && o.enabled && o.powered);
    let inhibit = state.displays.lid_closed && external && outputs.iter().any(|o| o.internal);
    if inhibit && state.displays.lid_before.is_none() {
        rollback(state, "lid policy changed");
        // Rollback may have removed the external enabled by an unconfirmed preview.
        // Re-read the restored state before deciding whether the panel can go dark.
        let outputs = state.displays.outputs.clone();
        let Some(l) = lid_layout(&outputs, &state.displays.primary) else {
            return;
        };
        let before = observed(&outputs, &state.displays.primary);
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

fn lid_layout(outputs: &[Output], primary: &str) -> Option<Layout> {
    if !outputs.iter().any(|o| o.internal && o.enabled)
        || !outputs.iter().any(|o| !o.internal && o.enabled && o.powered)
    {
        return None;
    }
    let mut l = observed(outputs, primary);
    for setting in &mut l.outputs {
        if outputs.iter().any(|o| o.id == setting.id && o.internal) {
            setting.enabled = false;
        }
    }
    l.primary = outputs
        .iter()
        .find(|o| !o.internal && o.enabled && o.powered)?
        .id
        .clone();
    let mut x = 0;
    for setting in l.outputs.iter_mut().filter(|s| s.enabled) {
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
    let before = observed(&state.displays.outputs, &state.displays.primary);
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
    let mut layout = observed(&state.displays.outputs, &state.displays.primary);
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lid_requires_a_powered_enabled_external_and_compacts_the_rest() {
        let mut outputs = vec![
            model::tests::output("internal", true, 100, 100),
            model::tests::output("external", false, 200, 100),
        ];
        outputs[1].x = 100;
        let l = lid_layout(&outputs, "internal").unwrap();
        assert_eq!(l.primary, "external");
        assert!(!l.outputs.iter().find(|s| s.id == "internal").unwrap().enabled);
        assert_eq!(l.outputs.iter().find(|s| s.id == "external").unwrap().x, 0);
        outputs[1].powered = false;
        assert!(lid_layout(&outputs, "internal").is_none());
        outputs[1].powered = true;
        outputs[1].enabled = false;
        assert!(lid_layout(&outputs, "internal").is_none());
        assert!(lid_layout(&outputs[..1], "internal").is_none());
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
