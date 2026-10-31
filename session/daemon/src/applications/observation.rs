// SPDX-License-Identifier: GPL-3.0-or-later
//! H1 is the only source of session/window truth. No title or executable matching.
use super::{catalogue::App, store::Handle};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Window {
    pub id: u64,
    #[serde(default)]
    pub app_id: String,
    #[serde(default)]
    pub initial_app_id: String,
    #[serde(default)]
    pub minimized: bool,
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub focused: bool,
}
#[derive(Default)]
pub struct Index {
    exact: BTreeMap<String, BTreeSet<String>>,
    wmclass: BTreeMap<String, BTreeSet<String>>,
    flatpak: BTreeMap<String, BTreeSet<String>>,
    generations: BTreeMap<String, u64>,
}
impl Index {
    pub fn new(apps: &BTreeMap<String, App>) -> Self {
        let mut i = Self::default();
        for (id, a) in apps {
            i.generations.insert(id.clone(), a.generation);
            for name in [id.as_str(), id.strip_suffix(".desktop").unwrap_or(id)] {
                i.exact.entry(name.into()).or_default().insert(id.clone());
            }
            for (key, map) in [
                ("StartupWMClass", &mut i.wmclass),
                ("OriginId", &mut i.flatpak),
            ] {
                if let Some(s) = a.record[key].as_str().filter(|s| !s.is_empty()) {
                    map.entry(s.into()).or_default().insert(id.clone());
                }
            }
        }
        i
    }
    pub fn resolve(&self, w: &Window, epoch: &str) -> Value {
        let choices = [
            (self.exact.get(&w.app_id), "exact-app-id"),
            (self.wmclass.get(&w.app_id), "startup-wmclass"),
            (self.flatpak.get(&w.app_id), "flatpak"),
            (self.exact.get(&w.initial_app_id), "initial-app-id"),
        ];
        let (set, kind) = choices
            .into_iter()
            .find_map(|(v, k)| v.filter(|v| !v.is_empty()).map(|v| (v, k)))
            .map_or((None, "unknown"), |(v, k)| (Some(v), k));
        let count = set.map_or(0, BTreeSet::len);
        let id = if count == 1 {
            set.unwrap().first().unwrap().as_str()
        } else {
            ""
        };
        let mut bytes = 0;
        let ids = set
            .into_iter()
            .flatten()
            .take(16)
            .take_while(|id| {
                bytes += id.len();
                bytes <= 8192
            })
            .cloned()
            .collect::<Vec<_>>();
        json!({"HyaloEpoch":epoch,"WindowId":w.id,"DesktopId":id,"AppGeneration":self.generations.get(id).copied().unwrap_or(0),"MatchKind":if count>1{"ambiguous"}else{kind},"CandidateCount":count as u64,"CandidatesComplete":ids.len()==count,"Candidates":ids})
    }
    pub fn id(&self, w: &Window) -> Option<String> {
        let r = self.resolve(w, "");
        r["DesktopId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    }
}
#[derive(Default)]
pub struct Model {
    pub live: bool,
    pub epoch: String,
    pub run: u64,
    serial: u64,
    pub time: u64,
    pub windows: BTreeMap<u64, Window>,
    pub focus: Option<u64>,
    fallback: String,
    pub locked: bool,
    pub idle: bool,
    pub session_active: bool,
    pub sleeping: bool,
}
pub struct Effect {
    pub boundary: bool,
    pub force: bool,
    pub idle_cap: bool,
    pub stop: bool,
    pub outcome: Option<(u64, Value)>,
}
fn parse_outcome(v: &Value) -> Result<Value, String> {
    match v["outcome"].as_str() {
        Some("expired") => Ok(json!({"outcome":"expired"})),
        Some(kind @ ("window" | "activated" | "refused")) => {
            let id = number(v, "window")?;
            let mut out = json!({"outcome":kind,"window":id});
            if kind == "window" {
                out["honoured"] = json!(boolean(v, "honoured")?);
            }
            Ok(out)
        }
        _ => Err("invalid launch outcome".into()),
    }
}
fn number(v: &Value, k: &str) -> Result<u64, String> {
    v[k].as_u64().ok_or_else(|| format!("missing {k}"))
}
fn boolean(v: &Value, k: &str) -> Result<bool, String> {
    v[k].as_bool().ok_or_else(|| format!("missing {k}"))
}
fn focus(v: &Value) -> Result<Option<u64>, String> {
    if v.is_null() {
        Ok(None)
    } else {
        v.as_u64().map(Some).ok_or("invalid focus".into())
    }
}
fn windows(v: &Value) -> Result<BTreeMap<u64, Window>, String> {
    let a = v
        .as_array()
        .filter(|a| a.len() <= 4096)
        .ok_or("window budget")?;
    let mut out = BTreeMap::new();
    for w in a {
        let w: Window = serde_json::from_value(w.clone()).map_err(|_| "invalid window")?;
        if w.app_id.len() > 1024 || w.initial_app_id.len() > 1024 || out.insert(w.id, w).is_some() {
            return Err("window identity budget/duplicate".into());
        }
    }
    Ok(out)
}
impl Model {
    pub fn bootstrap(&mut self, v: Value) -> Result<(), String> {
        if v["event"] != "snapshot" {
            return Err("H1 snapshot unavailable".into());
        }
        let run = number(&v, "epoch")?;
        if run == 0 {
            return Err("invalid epoch".into());
        }
        let ws = windows(&v["windows"])?;
        let f = focus(&v["focus"])?;
        *self = Self {
            live: true,
            epoch: format!("{run}:{}", super::unique()),
            run,
            serial: number(&v, "serial")?,
            time: number(&v, "time_us")?,
            windows: ws,
            focus: f,
            fallback: String::new(),
            locked: boolean(&v, "locked")?,
            idle: boolean(&v, "idle")?,
            session_active: boolean(&v, "session_active")?,
            sleeping: boolean(&v, "sleeping")?,
        };
        Ok(())
    }
    pub fn event(&mut self, v: Value) -> Result<Effect, String> {
        let run = number(&v, "epoch")?;
        let serial = number(&v, "serial")?;
        let time = number(&v, "time_us")?;
        let mut effect = Effect {
            boundary: false,
            force: false,
            idle_cap: false,
            stop: false,
            outcome: None,
        };
        if run != self.run || time < self.time || serial < self.serial {
            return Err("H1 epoch/time/order changed".into());
        }
        if serial == self.serial {
            return Ok(effect);
        }
        if serial != self.serial.checked_add(1).ok_or("serial overflow")? {
            return Err("H1 serial gap".into());
        }
        match v["event"].as_str().ok_or("missing event")? {
            "snapshot" => return Err("unexpected snapshot".into()),
            "windows_changed" => {
                let ws = windows(&v["windows"])?;
                let fs = ws
                    .values()
                    .filter(|w| w.focused)
                    .map(|w| w.id)
                    .collect::<Vec<_>>();
                if fs.len() > 1 {
                    return Err("multiple focused windows".into());
                }
                let f = fs.first().copied();
                effect.force = f != self.focus;
                self.windows = ws;
                self.focus = f;
                self.fallback.clear();
                effect.boundary = true;
            }
            "focus_transition" => {
                let id = focus(&v["id"])?;
                let app = if v["app_id"].is_null() {
                    String::new()
                } else {
                    v["app_id"]
                        .as_str()
                        .filter(|s| s.len() <= 1024)
                        .ok_or("invalid focus identity")?
                        .to_owned()
                };
                effect.force = id != self.focus;
                self.focus = id;
                self.fallback = app.clone();
                if let Some(w) = id.and_then(|id| self.windows.get_mut(&id)) {
                    w.visible = true;
                    w.minimized = false;
                    w.app_id = app;
                }
                effect.boundary = true;
            }
            "lock_changed" => {
                let b = boolean(&v, "locked")?;
                effect.force = b != self.locked;
                self.locked = b;
                effect.boundary = effect.force;
                effect.stop = b;
            }
            "idle_changed" => {
                let b = boolean(&v, "idle")?;
                effect.force = b != self.idle;
                self.idle = b;
                effect.boundary = effect.force;
                effect.idle_cap = b;
            }
            "session_active_changed" => {
                let b = boolean(&v, "active")?;
                effect.force = b != self.session_active;
                self.session_active = b;
                effect.boundary = effect.force;
            }
            "sleep_changed" => {
                let b = boolean(&v, "sleeping")?;
                effect.force = b != self.sleeping;
                self.sleeping = b;
                effect.boundary = effect.force;
                effect.stop = b;
            }
            "launch_outcome" => effect.outcome = Some((number(&v, "launch")?, parse_outcome(&v)?)),
            _ => {}
        }
        self.serial = serial;
        self.time = time;
        Ok(effect)
    }
    pub fn eligible(&self, index: &Index) -> Option<String> {
        if !self.live || self.locked || self.idle || self.sleeping || !self.session_active {
            return None;
        }
        let id = self.focus?;
        if let Some(w) = self.windows.get(&id) {
            if w.minimized || !w.visible {
                return None;
            }
            index.id(w)
        } else if !self.fallback.is_empty() {
            index.id(&Window {
                id,
                app_id: self.fallback.clone(),
                ..Window::default()
            })
        } else {
            None
        }
    }
    pub fn matches(&self, index: &Index) -> Vec<Value> {
        self.windows
            .values()
            .map(|w| index.resolve(w, &self.epoch))
            .collect()
    }
    pub fn disconnect(&mut self) {
        self.live = false;
        self.epoch.clear();
        self.windows.clear();
        self.focus = None;
        self.fallback.clear();
    }
}
const MAX_LINE: usize = 8 * 1024 * 1024;
pub async fn line(r: &mut BufReader<UnixStream>) -> Result<Value, String> {
    let mut out = Vec::new();
    loop {
        let b = r.fill_buf().await.map_err(|_| "Hyalo read failed")?;
        if b.is_empty() {
            return Err("Hyalo EOF".into());
        }
        let n = b
            .iter()
            .position(|b| *b == b'\n')
            .map_or(b.len(), |i| i + 1);
        if out.len() + n > MAX_LINE {
            return Err("Hyalo line budget".into());
        }
        let done = b[n - 1] == b'\n';
        out.extend_from_slice(&b[..n]);
        r.consume(n);
        if done {
            return serde_json::from_slice(&out).map_err(|_| "invalid Hyalo JSON".into());
        }
    }
}
async fn connect() -> Result<UnixStream, String> {
    let path = crate::hyalo::socket().ok_or("Hyalo socket unavailable")?;
    tokio::time::timeout(std::time::Duration::from_secs(2), UnixStream::connect(path))
        .await
        .map_err(|_| "Hyalo connect deadline")?
        .map_err(|_| "Hyalo connect failed".into())
}
pub fn spawn(store: Handle) {
    tokio::spawn(async move {
        let mut delay = 1;
        loop {
            let result = listen(&store).await;
            let _ = store
                .call(move |s| {
                    s.observation_lost(result.err().unwrap_or("Hyalo stream ended".into()));
                    Ok(())
                })
                .await;
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
            delay = (delay * 2).min(30);
        }
    });
}
async fn listen(store: &Handle) -> Result<(), String> {
    let mut stream = connect().await?;
    stream
        .write_all(b"{\"request\":\"event_stream\",\"snapshot\":true}\n")
        .await
        .map_err(|_| "Hyalo subscribe failed")?;
    let mut r = BufReader::new(stream);
    let bootstrap = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let ack = line(&mut r).await?;
        if ack.get("ok").is_none() {
            return Err("Hyalo refused stream".into());
        }
        line(&mut r).await
    })
    .await
    .map_err(|_| "Hyalo snapshot deadline")??;
    store
        .call(move |s| s.observation_start(bootstrap))
        .await
        .map_err(|_| "invalid H1 snapshot/store unavailable")?;
    loop {
        let event = line(&mut r).await?;
        store
            .call(move |s| s.observation_event(event))
            .await
            .map_err(|_| "H1 continuity/store unavailable")?;
    }
}
/// Observe and sample the epoch on ONE request connection, which cannot span a restart.
pub async fn launch(token: &str) -> Result<(u64, u64, Option<Value>), String> {
    tokio::time::timeout(std::time::Duration::from_secs(2), async {
        let mut s = connect().await?;
        let first = json!({"request":"observe_launch","token":token}).to_string()
            + "\n{\"request\":\"event_stream\",\"snapshot\":true}\n";
        s.write_all(first.as_bytes())
            .await
            .map_err(|_| "observe launch write")?;
        let mut r = BufReader::new(s);
        let reply = line(&mut r).await?;
        let ok = reply.get("ok").ok_or("launch observation refused")?;
        let n = number(ok, "launch")?;
        let already = ok
            .get("already")
            .filter(|v| !v.is_null())
            .map(parse_outcome)
            .transpose()?;
        let ack = line(&mut r).await?;
        if ack.get("ok").is_none() {
            return Err("launch epoch barrier failed".into());
        }
        let snapshot = line(&mut r).await?;
        if snapshot["event"] != "snapshot" {
            return Err("launch epoch barrier unavailable".into());
        }
        Ok((number(&snapshot, "epoch")?, n, already))
    })
    .await
    .map_err(|_| "launch observation deadline".to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    fn snapshot() -> Value {
        json!({"event":"snapshot","epoch":7,"serial":3,"time_us":100,"windows":[],"focus":null,"locked":false,"idle":false,"session_active":true,"sleeping":false})
    }
    #[test]
    fn gaps_restarts_and_time_reversal_are_not_observation() {
        let mut m = Model::default();
        m.bootstrap(snapshot()).unwrap();
        assert!(
            m.event(json!({"event":"anything","epoch":7,"serial":5,"time_us":101}))
                .is_err()
        );
        assert!(
            m.event(json!({"event":"anything","epoch":8,"serial":4,"time_us":101}))
                .is_err()
        );
        assert!(
            m.event(json!({"event":"anything","epoch":7,"serial":4,"time_us":99}))
                .is_err()
        );
    }
    #[test]
    fn reconnect_has_a_fresh_connection_identity_even_for_same_run() {
        let mut m = Model::default();
        m.bootstrap(snapshot()).unwrap();
        let old = m.epoch.clone();
        m.bootstrap(snapshot()).unwrap();
        assert_ne!(old, m.epoch);
    }
    #[test]
    fn ambiguous_identity_never_becomes_foreground_and_boundaries_gate_it() {
        let mut index = Index::default();
        index.exact.insert("A".into(), ["A.desktop".into()].into());
        let mut m = Model::default();
        let mut v = snapshot();
        v["focus"] = json!(1);
        v["windows"] = json!([{"id":1,"app_id":"A","visible":true,"focused":true}]);
        m.bootstrap(v).unwrap();
        assert_eq!(m.eligible(&index), Some("A.desktop".into()));
        let mut serial = 4;
        for (event, key) in [
            ("lock_changed", "locked"),
            ("sleep_changed", "sleeping"),
            ("idle_changed", "idle"),
        ] {
            m.event(json!({"event":event,"epoch":7,"serial":serial,"time_us":100+serial,key:true}))
                .unwrap();
            serial += 1;
            assert_eq!(m.eligible(&index), None);
            m.event(
                json!({"event":event,"epoch":7,"serial":serial,"time_us":100+serial,key:false}),
            )
            .unwrap();
            serial += 1;
            assert!(m.eligible(&index).is_some());
        }
        index
            .exact
            .get_mut("A")
            .unwrap()
            .insert("Another.desktop".into());
        let r = index.resolve(m.windows.get(&1).unwrap(), &m.epoch);
        assert_eq!(r["MatchKind"], "ambiguous");
        assert_eq!(m.eligible(&index), None);
    }
    #[test]
    fn ambiguity_diagnostics_are_bounded_without_picking_a_winner() {
        let mut i = Index::default();
        i.exact.insert(
            "Shared".into(),
            (0..100).map(|n| format!("App{n}.desktop")).collect(),
        );
        let r = i.resolve(
            &Window {
                app_id: "Shared".into(),
                ..Window::default()
            },
            "epoch",
        );
        assert_eq!(r["DesktopId"], "");
        assert_eq!(r["CandidateCount"], 100);
        assert_eq!(r["CandidatesComplete"], false);
        assert_eq!(r["Candidates"].as_array().unwrap().len(), 16);
    }
    #[test]
    fn buffered_outcomes_exclude_unknown_private_payloads() {
        let clean = parse_outcome(
            &json!({"outcome":"activated","window":1,"unknown":"private-token-or-uri"}),
        )
        .unwrap();
        assert_eq!(clean, json!({"outcome":"activated","window":1}));
        assert!(parse_outcome(&json!({"outcome":"made-up","window":1})).is_err());
    }
}
