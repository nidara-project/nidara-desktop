// SPDX-License-Identifier: GPL-3.0-or-later
//! Owner-scoped streams. RT callbacks only touch sample buffers and atomics.
use super::*;
use futures_util::StreamExt;
use pipewire as pw;
use pw::spa;
use std::{
    collections::{BTreeMap, BTreeSet},
    sync::{
        Mutex,
        atomic::{AtomicBool, AtomicU32},
    },
    time::Instant,
};
use zbus::{message::Header, object_server::SignalEmitter};
const MAX_CHANNELS: usize = 64;
#[derive(Clone)]
pub struct Manager {
    state: Arc<Mutex<State>>,
    next: Arc<AtomicU64>,
    ids: Arc<Mutex<BTreeSet<(u32, u32)>>>,
}
struct State {
    subscriptions: BTreeMap<String, Subscription>,
    monitors: BTreeMap<String, Monitor>,
    playback: BTreeMap<String, Playback>,
    last_click: Option<Instant>,
}
struct Subscription {
    owner: String,
    node: String,
    rate: u32,
    last: Instant,
    peaks: [f32; MAX_CHANNELS],
}
struct Monitor {
    stop: Arc<AtomicBool>,
    peaks: Arc<[AtomicU32; MAX_CHANNELS]>,
    channels: Arc<AtomicU32>,
    result: Arc<Mutex<Option<String>>>,
}
struct Playback {
    owner: String,
    stop: Arc<AtomicBool>,
    result: Arc<Mutex<Option<String>>>,
    node: String,
    kind: String,
}
fn owner(h: &Header<'_>) -> Result<String, Error> {
    h.sender()
        .map(|s| s.to_string())
        .ok_or_else(|| Error::PermissionDenied("missing sender".into()))
}
impl Manager {
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(State {
                subscriptions: BTreeMap::new(),
                monitors: BTreeMap::new(),
                playback: BTreeMap::new(),
                last_click: None,
            })),
            next: Arc::new(AtomicU64::new(1)),
            ids: Arc::new(Mutex::new(BTreeSet::new())),
        }
    }
    pub fn is_internal_client(&self, cookie: u32, id: u32) -> bool {
        self.ids.lock().unwrap().contains(&(cookie, id))
    }
    pub fn cancel_all(&self, reason: &str) {
        let s = self.state.lock().unwrap();
        for m in s.monitors.values() {
            *m.result.lock().unwrap() = Some(reason.into());
            m.stop.store(true, Ordering::Release);
        }
        for p in s.playback.values() {
            *p.result.lock().unwrap() = Some(reason.into());
            p.stop.store(true, Ordering::Release);
        }
    }
    pub async fn subscribe(
        &self,
        a: &Audio,
        c: &Connection,
        h: &Header<'_>,
        node: Path,
        hz: u32,
    ) -> Result<Path, Error> {
        if !(1..=20).contains(&hz) {
            return Err(Error::InvalidArgument("peak rate must be 1..=20 Hz".into()));
        }
        let owner = owner(h)?;
        let graph = a.snapshot();
        let n = graph.node(node.as_str(), Some("peak"))?;
        if n.kind != "input" {
            return Err(Error::InvalidArgument(
                "peak target must be an input".into(),
            ));
        }
        let key = format!(
            "{ROOT}/subscriptions/s{}",
            self.next.fetch_add(1, Ordering::Relaxed)
        );
        {
            let mut s = self.state.lock().unwrap();
            if s.subscriptions.len() >= 32
                || s.subscriptions
                    .values()
                    .filter(|s| s.owner == owner)
                    .count()
                    >= 8
            {
                return Err(Error::Busy("peak subscription limit".into()));
            }
            if !s.monitors.contains_key(node.as_str()) {
                if s.monitors.len() >= 4 {
                    return Err(Error::Busy("input monitor limit".into()));
                }
                let m = Monitor {
                    stop: Arc::new(AtomicBool::new(false)),
                    peaks: Arc::new(std::array::from_fn(|_| AtomicU32::new(0))),
                    channels: Arc::new(AtomicU32::new(0)),
                    result: Arc::new(Mutex::new(None)),
                };
                launch(Job {
                    target: n.serial.to_string(),
                    positions: vec![],
                    capture: true,
                    selected: None,
                    gain: 1.0,
                    frequency: 0.0,
                    duration: None,
                    stop: m.stop.clone(),
                    peaks: m.peaks.clone(),
                    channels: m.channels.clone(),
                    result: m.result.clone(),
                    ids: self.ids.clone(),
                });
                s.monitors.insert(node.to_string(), m);
            }
            s.subscriptions.insert(
                key.clone(),
                Subscription {
                    owner,
                    node: node.to_string(),
                    rate: hz,
                    last: Instant::now(),
                    peaks: [0.0; MAX_CHANNELS],
                },
            );
        }
        if let Err(e) = c
            .object_server()
            .at(
                key.as_str(),
                Peak {
                    manager: self.clone(),
                    key: key.clone(),
                },
            )
            .await
        {
            self.remove_subscription(&key);
            return Err(Error::ZBus(e));
        }
        Ok(path(&key))
    }
    fn remove_subscription(&self, key: &str) {
        let mut s = self.state.lock().unwrap();
        if let Some(sub) = s.subscriptions.remove(key)
            && !s.subscriptions.values().any(|v| v.node == sub.node)
            && let Some(m) = s.monitors.remove(&sub.node)
        {
            m.stop.store(true, Ordering::Release);
        }
    }
    pub async fn play(
        &self,
        a: &Audio,
        c: &Connection,
        h: &Header<'_>,
        output: Option<Path>,
        event: &str,
        kind: &str,
    ) -> Result<Path, Error> {
        let owner = owner(h)?;
        let g = a.snapshot();
        // Config1 writes are delivered on our GLib context. Cross its queue before
        // checking playback preferences so a just-acknowledged disable cannot race us.
        a.backend
            .send(ROOT, g.generation, Action::Synchronize, 0)
            .await?;
        let prefs = a.prefs.read().unwrap().clone();
        if kind == "alert" && !prefs.alerts_enabled {
            return Err(Error::PermissionDenied("alert sounds disabled".into()));
        }
        if kind == "feedback" && !prefs.volume_feedback {
            return Err(Error::PermissionDenied("volume feedback disabled".into()));
        }
        let target = output.unwrap_or_else(|| path(&g.default_output));
        let n = g.node(target.as_str(), None)?;
        if n.kind != "output" {
            return Err(Error::InvalidArgument(
                "sound target must be an output".into(),
            ));
        }
        if n.muted {
            return Err(Error::Failed("output muted".into()));
        }
        let (frequency, duration, gain, selected) = match kind {
            "test" => {
                if !n.capabilities.iter().any(|s| s == "test-channels") {
                    return Err(Error::NotSupported("channel isolation unavailable".into()));
                }
                let index = n
                    .channels
                    .iter()
                    .position(|ch| ch.position == event)
                    .ok_or_else(|| {
                        Error::InvalidArgument("channel absent from output map".into())
                    })?;
                (440.0, Duration::from_millis(700), 0.15, Some(index))
            }
            "feedback" => (1200.0, Duration::from_millis(25), 0.08, None),
            "alert" => {
                let hz = match event {
                    "notification" => 880.0,
                    "warning" => 660.0,
                    "error" => 330.0,
                    "complete" => 1046.5,
                    _ => return Err(Error::InvalidArgument("unknown alert event".into())),
                };
                (
                    hz,
                    Duration::from_millis(180),
                    prefs.alert_volume.powi(3) * 0.2,
                    None,
                )
            }
            _ => return Err(Error::InvalidArgument("unknown playback kind".into())),
        };
        let positions: Vec<u32> = n
            .channels
            .iter()
            .map(|ch| {
                super::native::channel_id(&ch.position)
                    .ok_or_else(|| Error::NotSupported("unsupported channel map".into()))
            })
            .collect::<Result<_, _>>()?;
        let positions = if positions.is_empty() {
            vec![
                spa::sys::SPA_AUDIO_CHANNEL_FL,
                spa::sys::SPA_AUDIO_CHANNEL_FR,
            ]
        } else {
            positions
        };
        let key = format!(
            "{ROOT}/playbacks/p{}",
            self.next.fetch_add(1, Ordering::Relaxed)
        );
        {
            let mut s = self.state.lock().unwrap();
            if s.playback.len() >= 32
                || s.playback.values().any(|p| p.owner == owner)
                || (kind == "test" && s.playback.values().any(|p| p.kind == "test"))
            {
                return Err(Error::Busy("playback already active".into()));
            }
            if kind == "feedback" {
                if s.last_click
                    .is_some_and(|t| t.elapsed() < Duration::from_millis(100))
                {
                    return Err(Error::Superseded("feedback coalesced".into()));
                }
                s.last_click = Some(Instant::now());
            }
            let p = Playback {
                owner,
                stop: Arc::new(AtomicBool::new(false)),
                result: Arc::new(Mutex::new(None)),
                node: target.to_string(),
                kind: kind.into(),
            };
            launch(Job {
                target: n.serial.to_string(),
                positions,
                capture: false,
                selected,
                gain,
                frequency,
                duration: Some(duration),
                stop: p.stop.clone(),
                peaks: Arc::new(std::array::from_fn(|_| AtomicU32::new(0))),
                channels: Arc::new(AtomicU32::new(0)),
                result: p.result.clone(),
                ids: self.ids.clone(),
            });
            s.playback.insert(key.clone(), p);
        }
        if let Err(e) = c
            .object_server()
            .at(
                key.as_str(),
                PlaybackObject {
                    manager: self.clone(),
                    key: key.clone(),
                },
            )
            .await
        {
            if let Some(p) = self.state.lock().unwrap().playback.remove(&key) {
                p.stop.store(true, Ordering::Release);
            }
            return Err(Error::ZBus(e));
        }
        Ok(path(&key))
    }
    pub async fn serve(&self, c: Connection, a: Audio) -> Result<(), Error> {
        let proxy = zbus::fdo::DBusProxy::new(&c).await?;
        let mut owners = proxy.receive_name_owner_changed().await?;
        let m = self.clone();
        let owner_connection = c.clone();
        tokio::spawn(async move {
            while let Some(msg) = owners.next().await {
                if let Ok(args) = msg.args()
                    && args.new_owner().is_none()
                {
                    m.cancel_owner(&owner_connection, args.name().as_str())
                        .await;
                }
            }
        });
        let m = self.clone();
        tokio::spawn(async move {
            let clock = Instant::now();
            let mut tick = tokio::time::interval(Duration::from_millis(5));
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let graph = a.snapshot();
                let (mut peaks, mut ended, mut finished) = (vec![], vec![], vec![]);
                {
                    let mut s = m.state.lock().unwrap();
                    let mut readings = BTreeMap::new();
                    for (node, mon) in &s.monitors {
                        let error = mon.result.lock().unwrap().clone().or_else(|| {
                            (!graph.nodes.contains_key(node)).then(|| "target-removed".into())
                        });
                        let mut values = [0.0; MAX_CHANNELS];
                        for (i, v) in values.iter_mut().enumerate() {
                            *v = f32::from_bits(mon.peaks[i].swap(0, Ordering::AcqRel));
                        }
                        readings.insert(
                            node.clone(),
                            (values, mon.channels.load(Ordering::Acquire) as usize, error),
                        );
                    }
                    for (key, sub) in &mut s.subscriptions {
                        if let Some((values, channels, error)) = readings.get(&sub.node) {
                            if let Some(e) = error {
                                ended.push((key.clone(), sub.owner.clone(), e.clone()));
                                continue;
                            }
                            for (p, v) in sub.peaks.iter_mut().zip(values) {
                                *p = p.max(*v);
                            }
                            if sub.last.elapsed() >= Duration::from_secs_f64(1.0 / sub.rate as f64)
                                && *channels > 0
                            {
                                let values = sub.peaks[..(*channels).min(MAX_CHANNELS)]
                                    .iter()
                                    .map(|v| *v as f64)
                                    .collect::<Vec<_>>();
                                sub.peaks.fill(0.0);
                                sub.last = Instant::now();
                                peaks.push((key.clone(), sub.owner.clone(), values));
                            }
                        }
                    }
                    for (key, p) in &s.playback {
                        if let Some(reason) = p.result.lock().unwrap().clone().or_else(|| {
                            (!graph.nodes.contains_key(&p.node)).then(|| "target-removed".into())
                        }) {
                            p.stop.store(true, Ordering::Release);
                            finished.push((key.clone(), p.owner.clone(), reason));
                        }
                    }
                    for (key, _, _) in &finished {
                        s.playback.remove(key);
                    }
                }
                for (key, owner, values) in peaks {
                    if let (Ok(e), Ok(owner)) = (
                        SignalEmitter::new(&c, key.as_str()),
                        owner.as_str().try_into(),
                    ) {
                        let _ = Peak::peak(
                            &e.set_destination(owner),
                            clock.elapsed().as_micros() as u64,
                            values,
                        )
                        .await;
                    }
                }
                for (key, owner, reason) in ended {
                    m.remove_subscription(&key);
                    if let (Ok(e), Ok(owner)) = (
                        SignalEmitter::new(&c, key.as_str()),
                        owner.as_str().try_into(),
                    ) {
                        let _ = Peak::ended(&e.set_destination(owner), &reason).await;
                    }
                    let _ = c.object_server().remove::<Peak, _>(key.as_str()).await;
                }
                for (key, owner, reason) in finished {
                    if let (Ok(e), Ok(owner)) = (
                        SignalEmitter::new(&c, key.as_str()),
                        owner.as_str().try_into(),
                    ) {
                        let _ = PlaybackObject::finished(&e.set_destination(owner), &reason).await;
                    }
                    let _ = c
                        .object_server()
                        .remove::<PlaybackObject, _>(key.as_str())
                        .await;
                }
            }
        });
        Ok(())
    }
    async fn cancel_owner(&self, c: &Connection, owner: &str) {
        let keys: Vec<_> = self
            .state
            .lock()
            .unwrap()
            .subscriptions
            .iter()
            .filter(|(_, v)| v.owner == owner)
            .map(|(k, _)| k.clone())
            .collect();
        for key in keys {
            self.remove_subscription(&key);
            let _ = c.object_server().remove::<Peak, _>(key.as_str()).await;
        }
        let s = self.state.lock().unwrap();
        for p in s.playback.values().filter(|p| p.owner == owner) {
            *p.result.lock().unwrap() = Some("owner-disconnected".into());
            p.stop.store(true, Ordering::Release);
        }
    }
}
struct Peak {
    manager: Manager,
    key: String,
}
#[zbus::interface(name = "org.nidara.AudioPeakSubscription1")]
impl Peak {
    #[zbus(signal)]
    async fn peak(
        emitter: &SignalEmitter<'_>,
        monotonic_usec: u64,
        peaks: Vec<f64>,
    ) -> zbus::Result<()>;
    #[zbus(signal)]
    async fn ended(emitter: &SignalEmitter<'_>, reason: &str) -> zbus::Result<()>;
    #[zbus(property)]
    fn rate(&self) -> u32 {
        self.manager
            .state
            .lock()
            .unwrap()
            .subscriptions
            .get(&self.key)
            .map(|s| s.rate)
            .unwrap_or(0)
    }
    #[zbus(property)]
    fn node(&self) -> Path {
        self.manager
            .state
            .lock()
            .unwrap()
            .subscriptions
            .get(&self.key)
            .map(|s| path(&s.node))
            .unwrap_or_else(|| path("/"))
    }
    async fn unsubscribe(
        &self,
        #[zbus(header)] h: Header<'_>,
        #[zbus(connection)] c: &Connection,
    ) -> Result<(), Error> {
        let sender = owner(&h)?;
        {
            let s = self.manager.state.lock().unwrap();
            if s.subscriptions
                .get(&self.key)
                .is_some_and(|v| v.owner != sender)
            {
                return Err(Error::PermissionDenied(
                    "subscription belongs to another sender".into(),
                ));
            }
        }
        self.manager.remove_subscription(&self.key);
        c.object_server()
            .remove::<Peak, _>(self.key.as_str())
            .await?;
        Ok(())
    }
}
struct PlaybackObject {
    manager: Manager,
    key: String,
}
#[zbus::interface(name = "org.nidara.AudioTestPlayback1")]
impl PlaybackObject {
    #[zbus(signal)]
    async fn finished(emitter: &SignalEmitter<'_>, reason: &str) -> zbus::Result<()>;
    #[zbus(property)]
    fn state(&self) -> &str {
        "playing"
    }
    #[zbus(property)]
    fn error(&self) -> &str {
        ""
    }
    fn stop(&self, #[zbus(header)] h: Header<'_>) -> Result<(), Error> {
        let sender = owner(&h)?;
        if let Some(p) = self.manager.state.lock().unwrap().playback.get(&self.key) {
            if p.owner != sender {
                return Err(Error::PermissionDenied(
                    "playback belongs to another sender".into(),
                ));
            }
            *p.result.lock().unwrap() = Some("cancelled".into());
            p.stop.store(true, Ordering::Release);
        }
        Ok(())
    }
}
struct Job {
    target: String,
    positions: Vec<u32>,
    capture: bool,
    selected: Option<usize>,
    gain: f64,
    frequency: f64,
    duration: Option<Duration>,
    stop: Arc<AtomicBool>,
    peaks: Arc<[AtomicU32; MAX_CHANNELS]>,
    channels: Arc<AtomicU32>,
    result: Arc<Mutex<Option<String>>>,
    ids: Arc<Mutex<BTreeSet<(u32, u32)>>>,
}
fn launch(job: Job) {
    std::thread::spawn(move || {
        let result = run(&job);
        let mut value = job.result.lock().unwrap();
        if value.is_none() {
            *value = Some(match result {
                Ok(()) => "completed".into(),
                Err(e) => format!("failed: {e}"),
            });
        }
    });
}
fn run(job: &Job) -> Result<(), Box<dyn std::error::Error>> {
    pw::init();
    let mainloop = pw::main_loop::MainLoopRc::new(None)?;
    let context = pw::context::ContextRc::new(&mainloop, None)?;
    let core = context.connect_rc(None)?;
    // Register our actual PW client handle before any stream can enter the graph.
    // Public app-id/name strings never decide whether a recorder is internal.
    let cookie = std::rc::Rc::new(std::cell::Cell::new(None));
    let core_cookie = cookie.clone();
    let _core_listener = core
        .add_listener_local()
        .info(move |info| core_cookie.set(Some(info.cookie())))
        .register();
    let handshake = Instant::now();
    let client_id = loop {
        mainloop
            .loop_()
            .iterate(pw::loop_::Timeout::Finite(Duration::from_millis(5)));
        let client = unsafe { pw::sys::pw_core_get_client(core.as_raw_ptr()) };
        let id = if client.is_null() {
            u32::MAX
        } else {
            unsafe { pw::sys::pw_proxy_get_bound_id(client.cast()) }
        };
        if id != u32::MAX && cookie.get().is_some() {
            break id;
        }
        if handshake.elapsed() > Duration::from_secs(5) {
            return Err("PipeWire client handshake timed out".into());
        }
    };
    let cookie = cookie.get().unwrap();
    job.ids.lock().unwrap().insert((cookie, client_id));
    struct ClientGuard {
        ids: Arc<Mutex<BTreeSet<(u32, u32)>>>,
        id: (u32, u32),
    }
    impl Drop for ClientGuard {
        fn drop(&mut self) {
            self.ids.lock().unwrap().remove(&self.id);
        }
    }
    let _client = ClientGuard {
        ids: job.ids.clone(),
        id: (cookie, client_id),
    };
    let props = pw::properties::properties! {"media.type"=>"Audio","media.category"=>if job.capture{"Capture"}else{"Playback"},"media.role"=>if job.capture{"Monitor"}else{"Notification"},"application.name"=>"Nidara Audio","application.id"=>"org.nidara.Session","target.object"=>job.target.as_str(),"node.dont-reconnect"=>"true","node.dont-fallback"=>"true","node.dont-move"=>"true","stream.dont-remix"=>"true","state.restore-props"=>"false","state.restore-target"=>"false"};
    let stream = pw::stream::StreamBox::new(&core, "Nidara Audio", props)?;
    let count = Arc::new(AtomicU32::new(if job.capture {
        0
    } else {
        job.positions.len() as u32
    }));
    let failed = std::rc::Rc::new(std::cell::RefCell::new(None));
    let error = failed.clone();
    let (peaks, channels) = (job.peaks.clone(), job.channels.clone());
    let capture = job.capture;
    let selected = job.selected;
    let gain = job.gain;
    let frequency = job.frequency;
    let (mut phase, mut frames) = (0.0_f64, 0_u64);
    let duration_frames = job
        .duration
        .map(|d| (d.as_secs_f64() * 48000.0) as u64)
        .unwrap_or(u64::MAX);
    let done = Arc::new(AtomicBool::new(false));
    let rt_done = done.clone();
    let count_rt = count.clone();
    let _listener = stream
        .add_local_listener_with_user_data(())
        .state_changed(move |_, _, _, state| {
            if let pw::stream::StreamState::Error(e) = state {
                *error.borrow_mut() = Some(e.to_string());
            }
        })
        .param_changed(move |_, _, id, param| {
            if id == spa::param::ParamType::Format.as_raw()
                && let Some(p) = param
            {
                let mut info = spa::param::audio::AudioInfoRaw::new();
                if info.parse(p).is_ok() {
                    let n = info.channels().min(MAX_CHANNELS as u32);
                    count.store(n, Ordering::Release);
                    channels.store(n, Ordering::Release);
                }
            }
        })
        .process(move |stream, _| {
            let Some(mut buffer) = stream.dequeue_buffer() else {
                return;
            };
            let datas = buffer.datas_mut();
            if datas.is_empty() {
                return;
            }
            let data = &mut datas[0];
            let n = count_rt.load(Ordering::Acquire) as usize;
            if n == 0 || n > MAX_CHANNELS {
                return;
            }
            let offset = data.chunk().offset() as usize;
            let size = data.chunk().size() as usize;
            if capture {
                if let Some(bytes) = data.data() {
                    let start = offset.min(bytes.len());
                    let end = start.saturating_add(size).min(bytes.len());
                    for frame in bytes[start..end].chunks_exact(4 * n) {
                        for (i, b) in frame.as_chunks::<4>().0.iter().enumerate() {
                            let sample = f32::from_le_bytes(*b).abs();
                            if sample.is_finite() {
                                peaks[i].fetch_max(sample.to_bits(), Ordering::Relaxed);
                            }
                        }
                    }
                }
            } else {
                let mut written = 0;
                if let Some(bytes) = data.data() {
                    for frame in bytes.chunks_exact_mut(4 * n) {
                        phase = (phase + std::f64::consts::TAU * frequency / 48000.0)
                            % std::f64::consts::TAU;
                        let envelope = if frames >= duration_frames {
                            0.0
                        } else {
                            (frames as f64 / 240.0).min(1.0)
                                * ((duration_frames - frames) as f64 / 240.0).min(1.0)
                        };
                        let value = (phase.sin() * gain * envelope) as f32;
                        for (i, b) in frame.as_chunks_mut::<4>().0.iter_mut().enumerate() {
                            b.copy_from_slice(
                                &(if selected.is_none_or(|c| c == i) {
                                    value
                                } else {
                                    0.0
                                })
                                .to_le_bytes(),
                            );
                        }
                        frames += 1;
                        written += 4 * n;
                    }
                    if frames >= duration_frames {
                        rt_done.store(true, Ordering::Release);
                    }
                }
                let chunk = data.chunk_mut();
                *chunk.offset_mut() = 0;
                *chunk.stride_mut() = (4 * n) as i32;
                *chunk.size_mut() = written as u32;
            }
        })
        .register()?;
    let mut info = spa::param::audio::AudioInfoRaw::new();
    info.set_format(spa::param::audio::AudioFormat::F32LE);
    if !job.capture {
        info.set_rate(48000);
        info.set_channels(job.positions.len() as u32);
        let mut map = [0; spa::param::audio::MAX_CHANNELS];
        map[..job.positions.len()].copy_from_slice(&job.positions);
        info.set_position(map);
    }
    let bytes = spa::pod::serialize::PodSerializer::serialize(
        std::io::Cursor::new(Vec::new()),
        &spa::pod::Value::Object(spa::pod::Object {
            type_: spa::sys::SPA_TYPE_OBJECT_Format,
            id: spa::sys::SPA_PARAM_EnumFormat,
            properties: info.into(),
        }),
    )?
    .0
    .into_inner();
    stream.connect(
        if job.capture {
            spa::utils::Direction::Input
        } else {
            spa::utils::Direction::Output
        },
        None,
        pw::stream::StreamFlags::AUTOCONNECT
            | pw::stream::StreamFlags::MAP_BUFFERS
            | pw::stream::StreamFlags::RT_PROCESS
            | pw::stream::StreamFlags::DONT_RECONNECT,
        &mut [spa::pod::Pod::from_bytes(&bytes).unwrap()],
    )?;
    let start = Instant::now();
    let mut completed = None;
    let result = loop {
        if job.stop.load(Ordering::Acquire) {
            break Ok(());
        }
        mainloop
            .loop_()
            .iterate(pw::loop_::Timeout::Finite(Duration::from_millis(5)));
        if let Some(e) = failed.borrow().as_ref() {
            break Err(e.clone().into());
        }
        if done.load(Ordering::Acquire) {
            let end = completed.get_or_insert_with(Instant::now);
            if end.elapsed() >= Duration::from_millis(100) {
                break Ok(());
            }
        }
        if (!job.capture && start.elapsed() > job.duration.unwrap() + Duration::from_secs(5))
            || (job.capture
                && job.channels.load(Ordering::Acquire) == 0
                && start.elapsed() > Duration::from_secs(5))
        {
            break Err("stream did not finish within deadline".into());
        }
    };
    let _ = stream.disconnect();
    result
}
