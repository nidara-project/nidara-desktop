// SPDX-License-Identifier: GPL-3.0-or-later
//! Display brightness shares Power1's logind connection/session authority. No energy policy here.
mod discovery;
#[path = "../../../../hyalo/compositor/src/display/hardware.rs"]
mod hardware;
mod model;
mod process;
use super::{Power, provider};
use discovery::{Channel, Link, Paths};
use futures_util::StreamExt;
use model::{Device, Snapshot};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tokio::sync::{oneshot, watch};
use zbus::zvariant::OwnedValue;
const ROOT: &str = "/org/nidara/DisplayBrightness";
const IFACE: &str = "org.nidara.DisplayBrightness1";
const DISPLAY: &str = "org.nidara.Display";
#[derive(Debug, zbus::DBusError)]
#[zbus(prefix = "org.nidara.DisplayBrightness1.Error")]
pub enum Error {
    #[zbus(error)]
    ZBus(zbus::Error),
    Unavailable(String),
    NotSupported(String),
    Stale(String),
    InvalidArgument(String),
    PermissionDenied(String),
    Superseded(String),
    Timeout(String),
}
impl From<super::Error> for Error {
    fn from(e: super::Error) -> Self {
        match e {
            super::Error::PermissionDenied(s) | super::Error::AuthenticationRequired(s) => {
                Self::PermissionDenied(s)
            }
            super::Error::Timeout(s) => Self::Timeout(s),
            _ => Self::Unavailable(e.to_string()),
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Context {
    owner: String,
    epoch: u64,
    session: String,
    active: bool,
}
fn context(p: &Power) -> Context {
    let s = p.state.read().unwrap();
    let provider = s.providers.get("logind").cloned().unwrap_or_default();
    Context {
        owner: provider.owner,
        epoch: provider.epoch,
        session: s.root["SessionPath"].as_str().unwrap_or("").into(),
        active: s.root["SessionActive"].as_bool().unwrap_or(false),
    }
}
struct Request {
    value: u32,
    serial: u64,
    reply: oneshot::Sender<Result<Device, Error>>,
}
#[derive(Default)]
struct ChannelIo {
    last_issue: Option<Instant>,
    #[cfg(test)]
    issues: Vec<Instant>,
}
type ChannelLock = Arc<tokio::sync::Mutex<ChannelIo>>;
struct Entry {
    io: ChannelLock,
    device: Device,
    link: Link,
    cancel: watch::Sender<bool>,
    desired: Option<Request>,
    serial: u64,
    requested: u32,
    running: bool,
}
#[derive(Default)]
struct State {
    owner: String,
    hardware: hardware::Snapshot,
    context: Context,
    key: String,
    entries: BTreeMap<String, Entry>,
    revision: u64,
    serial: u64,
    last_refresh: Option<Instant>,
}
#[derive(Clone)]
struct Service {
    power: Power,
    paths: Paths,
    state: Arc<Mutex<State>>,
    refresh: Arc<tokio::sync::Mutex<()>>,
    probes: Arc<tokio::sync::Semaphore>,
    io: Arc<Mutex<BTreeMap<String, ChannelLock>>>,
}
#[derive(Clone)]
struct Target {
    io: ChannelLock,
    device: Device,
    link: Link,
    cancel: watch::Receiver<bool>,
    owner: String,
    display_epoch: u64,
    context: Context,
}
impl Service {
    fn snapshot(&self) -> Snapshot {
        let s = self.state.lock().unwrap();
        Snapshot {
            generation: self.power.epoch,
            revision: s.revision,
            devices: s.entries.values().map(|e| e.device.clone()).collect(),
        }
    }
    async fn publish(&self) {
        let revision = {
            let mut s = self.state.lock().unwrap();
            s.revision += 1;
            s.revision
        };
        let _ = self
            .power
            .conn
            .emit_signal(
                None::<&str>,
                ROOT,
                IFACE,
                "Changed",
                &(self.power.epoch, revision),
            )
            .await;
    }
    fn target(&self, id: &str) -> Result<Target, Error> {
        let s = self.state.lock().unwrap();
        let e = s
            .entries
            .get(id)
            .ok_or_else(|| Error::Stale("device withdrawn".into()))?;
        Ok(Target {
            io: e.io.clone(),
            device: e.device.clone(),
            link: e.link.clone(),
            cancel: e.cancel.subscribe(),
            owner: s.owner.clone(),
            display_epoch: s.hardware.epoch,
            context: s.context.clone(),
        })
    }
    fn valid(&self, target: &Target) -> Result<(), Error> {
        let s = self.state.lock().unwrap();
        if *target.cancel.borrow()
            || s.context != target.context
            || context(&self.power) != target.context
            || s.owner != target.owner
            || !s
                .entries
                .get(&target.device.id)
                .is_some_and(|e| e.device.epoch == target.device.epoch)
        {
            return Err(Error::Stale("session or output epoch changed".into()));
        }
        Ok(())
    }
    async fn hardware(&self) -> Result<(String, hardware::Snapshot), Error> {
        let dbus = zbus::fdo::DBusProxy::new(&self.power.conn).await?;
        let owner = provider::bounded(dbus.get_name_owner(DISPLAY.try_into().unwrap()))
            .await?
            .to_string();
        let message = provider::bounded(self.power.conn.call_method(
            Some(owner.as_str()),
            "/org/nidara/Display",
            Some("org.nidara.Display1"),
            "GetHardwareState",
            &(),
        ))
        .await?;
        let snapshot = message.body().deserialize::<hardware::Snapshot>()?;
        if snapshot.outputs.len() > 64
            || snapshot
                .outputs
                .iter()
                .any(|o| o.id.len() > 4096 || o.port.len() > 4096 || o.edid.len() > 4096)
        {
            return Err(Error::Unavailable(
                "invalid compositor hardware inventory".into(),
            ));
        }
        Ok((owner, snapshot))
    }
    async fn guard(&self, target: &Target) -> Result<(), Error> {
        self.valid(target)?;
        discovery::verify(&target.link)?;
        if !target.context.active || target.context.session.is_empty() {
            return Err(Error::PermissionDenied(
                "inactive or unresolved local session".into(),
            ));
        }
        provider::check_owner(&self.power, "logind").await?;
        let proxy = self
            .power
            .backend(
                "logind",
                &target.context.session,
                "org.freedesktop.DBus.Properties",
            )
            .await?;
        let properties: std::collections::HashMap<String, OwnedValue> =
            provider::bounded(proxy.call("GetAll", &("org.freedesktop.login1.Session",))).await?;
        if !properties
            .get("Active")
            .and_then(|v| bool::try_from(v).ok())
            .unwrap_or(false)
            || properties
                .get("Remote")
                .and_then(|v| bool::try_from(v).ok())
                .unwrap_or(true)
        {
            return Err(Error::PermissionDenied("session inactive or remote".into()));
        }
        let (owner, hardware) = self.hardware().await?;
        if owner != target.owner
            || hardware.epoch != target.display_epoch
            || !hardware.outputs.iter().any(|o| {
                o.id == target.link.output.id
                    && o.port == target.link.output.port
                    && o.edid == target.link.output.edid
                    && o.enabled
            })
        {
            return Err(Error::Stale("compositor output changed".into()));
        }
        self.valid(target)?;
        discovery::verify(&target.link)
    }
    async fn read(&self, target: &Target) -> Result<(u32, u32), Error> {
        discovery::verify(&target.link)?;
        let result = match &target.link.channel {
            Channel::Panel { path, max, .. } => {
                let value = discovery::panel_value(path)?;
                if value > *max {
                    return Err(Error::Unavailable("invalid panel value".into()));
                }
                (value, *max)
            }
            Channel::Ddc { bus, .. } => {
                let text = process::run(
                    &self.paths.ddcutil,
                    &[
                        "--bus".into(),
                        bus.to_string(),
                        "--terse".into(),
                        "getvcp".into(),
                        "10".into(),
                    ],
                    target.cancel.clone(),
                )
                .await?;
                model::vcp(&text)
                    .ok_or_else(|| Error::Unavailable("brightness VCP read unavailable".into()))?
            }
        };
        self.valid(target)?;
        discovery::verify(&target.link)?;
        Ok(result)
    }
    async fn probe(&self, id: String) {
        let Ok(target) = self.target(&id) else {
            return;
        };
        let mut cancel = target.cancel.clone();
        if !target.context.active {
            return;
        }
        let permit = tokio::select! {p=self.probes.acquire()=>p,_=cancel.changed()=>return};
        let Ok(_permit) = permit else {
            return;
        };
        let _io = tokio::select! {guard=target.io.lock()=>guard,_=cancel.changed()=>return};
        let result = async {
            self.guard(&target).await?;
            let value = self.read(&target).await?;
            self.guard(&target).await?;
            Ok::<_, Error>(value)
        }
        .await;
        let changed = {
            let mut s = self.state.lock().unwrap();
            let Some(entry) = s
                .entries
                .get_mut(&id)
                .filter(|e| e.device.epoch == target.device.epoch)
            else {
                return;
            };
            match result {
                Ok((current, max)) => {
                    entry.device.current = current;
                    entry.device.max = max;
                    entry.device.available = true;
                    entry.device.writable = !self.power.read_only && entry.link.output.enabled;
                    true
                }
                Err(error) => {
                    eprintln!("[brightness] {}: {error}", entry.device.id);
                    false
                }
            }
        };
        if changed {
            self.publish().await;
        }
    }
    async fn refresh(&self, force: bool) -> Result<(), Error> {
        let _serial = self.refresh.lock().await;
        if force {
            let mut s = self.state.lock().unwrap();
            if s.last_refresh
                .is_some_and(|t| t.elapsed() < Duration::from_secs(2))
            {
                return Err(Error::Unavailable("refresh rate limit".into()));
            }
            s.last_refresh = Some(Instant::now());
        }
        let fetched = self.hardware().await;
        let context = context(&self.power);
        let (owner, hardware) = fetched.unwrap_or_default();
        let key = format!(
            "{owner}:{context:?}:{:?}",
            hardware
                .outputs
                .iter()
                .map(|o| (&o.id, &o.port, &o.edid, o.internal, o.enabled))
                .collect::<Vec<_>>()
        );
        {
            let mut s = self.state.lock().unwrap();
            if s.key == key && !force {
                s.hardware = hardware;
                return Ok(());
            }
            for e in s.entries.values_mut() {
                let _ = e.cancel.send(true);
                if let Some(r) = e.desired.take() {
                    let _ = r.reply.send(Err(Error::Stale("channel withdrawn".into())));
                }
            }
            s.entries.clear();
            s.owner = owner;
            s.hardware = hardware.clone();
            s.context = context;
            s.key = key;
        }
        self.publish().await;
        let paths = self.paths.clone();
        let outputs = hardware.outputs;
        let links = tokio::task::spawn_blocking(move || discovery::discover(&paths, &outputs))
            .await
            .map_err(|e| Error::Unavailable(e.to_string()))?;
        let ids = {
            let mut s = self.state.lock().unwrap();
            let mut ids = Vec::new();
            for link in links.into_iter().take(64) {
                s.serial += 1;
                let epoch = s.serial;
                let id = format!("b{}-{epoch}", self.power.epoch);
                let (cancel, _) = watch::channel(false);
                let max = match &link.channel {
                    Channel::Panel { max, .. } => *max,
                    _ => 0,
                };
                let device = Device {
                    id: id.clone(),
                    output_id: link.output.id.clone(),
                    provider: if matches!(link.channel, Channel::Panel { .. }) {
                        "logind"
                    } else {
                        "ddc"
                    }
                    .into(),
                    min: 0,
                    max,
                    current: 0,
                    available: false,
                    writable: false,
                    epoch,
                };
                let resource = match &link.channel {
                    Channel::Panel { path, .. } => path.to_string_lossy().into_owned(),
                    Channel::Ddc { node, .. } => node.to_string_lossy().into_owned(),
                };
                let io = self.io.lock().unwrap().entry(resource).or_default().clone();
                s.entries.insert(
                    id.clone(),
                    Entry {
                        io,
                        device,
                        link,
                        cancel,
                        desired: None,
                        serial: 0,
                        requested: 0,
                        running: false,
                    },
                );
                ids.push(id);
            }
            ids
        };
        self.io.lock().unwrap().retain(|_, lock| {
            Arc::strong_count(lock) > 1
                || lock.try_lock().is_ok_and(|io| {
                    io.last_issue
                        .is_some_and(|t| t.elapsed() < Duration::from_millis(250))
                })
        });
        self.publish().await;
        for id in ids {
            let service = self.clone();
            tokio::spawn(async move {
                service.probe(id).await;
            });
        }
        Ok(())
    }
    async fn enqueue(
        &self,
        id: String,
        epoch: u64,
        value: Option<u32>,
        direction: Option<i32>,
    ) -> Result<Device, Error> {
        self.power.mutable()?;
        let (tx, rx) = oneshot::channel();
        let start = {
            let mut s = self.state.lock().unwrap();
            if s.context != context(&self.power) || !s.context.active {
                return Err(Error::PermissionDenied("inactive session".into()));
            }
            let e = s
                .entries
                .get_mut(&id)
                .filter(|e| e.device.epoch == epoch)
                .ok_or_else(|| Error::Stale("device epoch changed".into()))?;
            if !e.device.available || !e.device.writable {
                return Err(Error::NotSupported("brightness channel unavailable".into()));
            }
            let value = if let Some(direction) = direction {
                model::step(
                    if e.running {
                        e.requested
                    } else {
                        value.unwrap_or(e.device.current)
                    },
                    e.device.max,
                    direction,
                )
                .ok_or_else(|| Error::InvalidArgument("direction must be -1 or 1".into()))?
            } else {
                value.unwrap()
            };
            if value > e.device.max {
                return Err(Error::InvalidArgument("value outside device range".into()));
            }
            e.serial += 1;
            e.requested = value;
            if let Some(old) = e.desired.replace(Request {
                value,
                serial: e.serial,
                reply: tx,
            }) {
                let _ = old
                    .reply
                    .send(Err(Error::Superseded("newer brightness request".into())));
            }
            let start = !e.running;
            e.running = true;
            start
        };
        if start {
            let service = self.clone();
            tokio::spawn(async move {
                service.writer(id).await;
            });
        }
        rx.await
            .map_err(|_| Error::Unavailable("brightness worker stopped".into()))?
    }
    fn starting_write(&self, target: &Target, io: &mut ChannelIo) -> Result<(), Error> {
        self.valid(target)?;
        let issued = Instant::now();
        io.last_issue = Some(issued);
        #[cfg(test)]
        io.issues.push(issued);
        Ok(())
    }
    async fn write(&self, target: &Target, value: u32, io: &mut ChannelIo) -> Result<u32, Error> {
        self.guard(target).await?;
        self.power.mutable()?;
        match &target.link.channel {
            Channel::Panel { name, .. } => {
                let session = self
                    .power
                    .backend(
                        "logind",
                        &target.context.session,
                        "org.freedesktop.login1.Session",
                    )
                    .await?;
                self.starting_write(target, io)?;
                provider::bounded(
                    session.call::<_, _, ()>("SetBrightness", &("backlight", name.as_str(), value)),
                )
                .await?;
            }
            Channel::Ddc { bus, .. } => {
                self.starting_write(target, io)?;
                process::run(
                    &self.paths.ddcutil,
                    &[
                        "--bus".into(),
                        bus.to_string(),
                        "--noverify".into(),
                        "setvcp".into(),
                        "10".into(),
                        value.to_string(),
                    ],
                    target.cancel.clone(),
                )
                .await?;
            }
        }
        let deadline = Instant::now() + Duration::from_millis(600);
        loop {
            let (observed, max) = self.read(target).await?;
            if max != target.device.max {
                return Err(Error::Stale("brightness range changed".into()));
            }
            if observed == value {
                self.guard(target).await?;
                return Ok(observed);
            }
            if matches!(target.link.channel, Channel::Ddc { .. }) || Instant::now() >= deadline {
                return Err(Error::Unavailable(
                    "brightness write was not confirmed".into(),
                ));
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    }
    async fn writer(&self, id: String) {
        loop {
            let target = match self.target(&id) {
                Ok(t) => t,
                Err(_) => return,
            };
            let mut cancel = target.cancel.clone();
            let mut io = tokio::select! {guard=target.io.lock()=>guard,_=cancel.changed()=>return};
            let delay = io
                .last_issue
                .map(|t| Duration::from_millis(250).saturating_sub(t.elapsed()))
                .unwrap_or_default();
            tokio::select! {_=tokio::time::sleep(delay)=>{},_=cancel.changed()=>return}
            let request = {
                let mut s = self.state.lock().unwrap();
                let Some(e) = s.entries.get_mut(&id) else {
                    return;
                };
                let Some(r) = e.desired.take() else {
                    e.running = false;
                    return;
                };
                r
            };
            let result = tokio::time::timeout(
                Duration::from_secs(5),
                self.write(&target, request.value, &mut io),
            )
            .await
            .unwrap_or_else(|_| Err(Error::Timeout("write deadline; result uncertain".into())));
            let (reply, again) = {
                let mut s = self.state.lock().unwrap();
                let Some(e) = s
                    .entries
                    .get_mut(&id)
                    .filter(|e| e.device.epoch == target.device.epoch)
                else {
                    let _ = request
                        .reply
                        .send(Err(Error::Stale("device withdrawn during write".into())));
                    return;
                };
                let reply = match result {
                    Ok(value) => {
                        e.device.current = value;
                        if e.serial == request.serial {
                            Ok(e.device.clone())
                        } else {
                            Err(Error::Superseded("newer brightness request".into()))
                        }
                    }
                    Err(error) => {
                        eprintln!("[brightness] {}: {error}", e.device.id);
                        e.device.available = false;
                        e.device.writable = false;
                        let _ = e.cancel.send(true);
                        if let Some(r) = e.desired.take() {
                            let _ = r.reply.send(Err(Error::Unavailable(
                                "channel withdrawn after failed I/O".into(),
                            )));
                        }
                        Err(error)
                    }
                };
                let again = e.desired.is_some();
                if !again {
                    e.running = false;
                }
                (reply, again)
            };
            let _ = request.reply.send(reply);
            self.publish().await;
            if !again {
                return;
            }
        }
    }
    async fn step(&self, direction: i32) -> Result<Device, Error> {
        self.power.mutable()?;
        if ![-1, 1].contains(&direction) {
            return Err(Error::InvalidArgument("direction must be -1 or 1".into()));
        }
        let (internals, hardware, devices) = {
            let s = self.state.lock().unwrap();
            (
                s.entries
                    .values()
                    .filter(|e| e.link.output.internal && e.device.available && e.device.writable)
                    .map(|e| e.device.clone())
                    .collect::<Vec<_>>(),
                s.hardware.clone(),
                s.entries
                    .values()
                    .map(|e| e.device.clone())
                    .collect::<Vec<_>>(),
            )
        };
        let device = if let Some(device) = internals.first() {
            device.clone()
        } else {
            let cursor = tokio::task::spawn_blocking(|| {
                crate::hyalo::request(serde_json::json!({"request":"cursor_position"}))
            })
            .await
            .map_err(|e| Error::Unavailable(e.to_string()))?
            .map_err(Error::Unavailable)?;
            let (owner, current) = self.hardware().await?;
            if owner != self.state.lock().unwrap().owner
                || current.epoch != hardware.epoch
                || current.revision != hardware.revision
            {
                return Err(Error::Stale(
                    "layout changed while selecting pointer output".into(),
                ));
            }
            let x = cursor["x"]
                .as_f64()
                .ok_or_else(|| Error::Unavailable("pointer output unknown".into()))?;
            let y = cursor["y"]
                .as_f64()
                .ok_or_else(|| Error::Unavailable("pointer output unknown".into()))?;
            let outputs: Vec<_> = hardware
                .outputs
                .iter()
                .filter(|o| {
                    o.enabled
                        && o.logical
                        && x >= o.x as f64
                        && y >= o.y as f64
                        && x < (o.x as f64 + o.width as f64)
                        && y < (o.y as f64 + o.height as f64)
                })
                .collect();
            let output = outputs
                .first()
                .filter(|_| outputs.len() == 1)
                .ok_or_else(|| Error::NotSupported("pointer has no unambiguous output".into()))?;
            devices
                .into_iter()
                .find(|d| d.output_id == output.id && d.available && d.writable)
                .ok_or_else(|| {
                    Error::NotSupported("pointer output has no brightness channel".into())
                })?
        };
        // At wake/after firmware changes the UI observation can be a second old.
        // The panel's configured raw level is the Fn base; actual_brightness remains
        // the observed status/readback. External DDC retains its explicitly probed cache.
        let base = match self.target(&device.id)?.link.channel {
            Channel::Panel { path, .. } => {
                let raw = discovery::number(&path.join("brightness"))?;
                if raw > device.max {
                    return Err(Error::Unavailable("invalid configured panel level".into()));
                }
                Some(raw)
            }
            Channel::Ddc { .. } => None,
        };
        self.enqueue(device.id, device.epoch, base, Some(direction))
            .await
    }
    async fn panels(&self) {
        let targets = {
            let s = self.state.lock().unwrap();
            s.entries
                .values()
                .filter(|e| e.device.available && matches!(e.link.channel, Channel::Panel { .. }))
                .map(|e| e.device.id.clone())
                .collect::<Vec<_>>()
        };
        let mut changed = false;
        for id in targets {
            let Ok(t) = self.target(&id) else { continue };
            let result = self.read(&t).await;
            let mut s = self.state.lock().unwrap();
            let Some(e) = s
                .entries
                .get_mut(&id)
                .filter(|e| e.device.epoch == t.device.epoch)
            else {
                continue;
            };
            match result {
                Ok((value, _)) if e.device.current != value => {
                    e.device.current = value;
                    changed = true;
                }
                Err(_) => {
                    e.device.available = false;
                    e.device.writable = false;
                    let _ = e.cancel.send(true);
                    if let Some(request) = e.desired.take() {
                        let _ = request
                            .reply
                            .send(Err(Error::Unavailable("panel observation lost".into())));
                    }
                    e.running = false;
                    changed = true;
                }
                _ => {}
            }
        }
        if changed {
            self.publish().await;
        }
    }
}
#[derive(Clone)]
struct Root(Service);
#[zbus::interface(name = "org.nidara.DisplayBrightness1")]
impl Root {
    fn get_state(&self) -> Snapshot {
        self.0.snapshot()
    }
    async fn set_brightness(
        &self,
        device: String,
        epoch: u64,
        value: u32,
    ) -> Result<Device, Error> {
        self.0.enqueue(device, epoch, Some(value), None).await
    }
    async fn step_brightness(&self, direction: i32) -> Result<Device, Error> {
        self.0.step(direction).await
    }
    async fn refresh(&self) -> Result<u64, Error> {
        self.0.refresh(true).await?;
        Ok(self.0.snapshot().revision)
    }
    #[zbus(signal)]
    async fn changed(
        emitter: &zbus::object_server::SignalEmitter<'_>,
        generation: u64,
        revision: u64,
    ) -> zbus::Result<()>;
}
pub(super) async fn serve(power: Power) -> zbus::Result<()> {
    start(power, Paths::default()).await.map(|_| ())
}
async fn start(power: Power, paths: Paths) -> zbus::Result<Service> {
    let service = Service {
        power: power.clone(),
        paths,
        state: Default::default(),
        refresh: Default::default(),
        probes: Arc::new(tokio::sync::Semaphore::new(2)),
        io: Default::default(),
    };
    power
        .conn
        .object_server()
        .at(ROOT, Root(service.clone()))
        .await?;
    let mut streams = futures_util::stream::SelectAll::new();
    for rule in [
        zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender(DISPLAY)?
            .path("/org/nidara/Display")?
            .interface("org.nidara.Display1")?
            .member("Changed")?
            .build(),
        zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .sender("org.freedesktop.DBus")?
            .interface("org.freedesktop.DBus")?
            .member("NameOwnerChanged")?
            .add_arg(DISPLAY)?
            .build(),
    ] {
        streams.push(zbus::MessageStream::for_match_rule(rule, &power.conn, Some(32)).await?);
    }
    let handle = service.clone();
    tokio::spawn(async move {
        let _ = service.refresh(false).await;
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            tokio::select! {message=streams.next()=>{if message.is_none(){return;}let _=service.refresh(false).await;},_=power.brightness_notify.notified()=>{let changed=context(&power)!=service.state.lock().unwrap().context;if changed{let _=service.refresh(false).await;}},_=interval.tick()=>service.panels().await}
        }
    });
    Ok(handle)
}
#[cfg(test)]
mod tests;
