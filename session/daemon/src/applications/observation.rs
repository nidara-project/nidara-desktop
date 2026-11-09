// SPDX-License-Identifier: GPL-3.0-or-later
//! H1 is the only source of window truth; Applications1 owns presentation identity.
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
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub parent: Option<u64>,
    #[serde(default)]
    pub xwayland: bool,
    #[serde(default)]
    pub steam_app: Option<u32>,
    #[serde(skip)]
    pub token_app: String,
    #[serde(skip)]
    pub evidence: super::identity::Evidence,
    #[serde(skip)]
    pub evidence_ready: bool,
}
impl Window {
    pub fn identity(&self) -> String {
        format!(
            "{:?}",
            (
                self.id,
                &self.app_id,
                &self.initial_app_id,
                self.pid,
                self.parent,
                self.xwayland,
                self.steam_app
            )
        )
    }
}
#[derive(Clone, Default)]
pub struct Index {
    exact: BTreeMap<String, BTreeSet<String>>,
    wmclass: BTreeMap<String, BTreeSet<String>>,
    flatpak: BTreeMap<String, BTreeSet<String>>,
    generations: BTreeMap<String, u64>,
    paths: BTreeMap<String, BTreeSet<String>>,
    snap: BTreeMap<String, BTreeSet<String>>,
    folded: BTreeMap<String, BTreeSet<String>>,
    folded_class: BTreeMap<String, BTreeSet<String>>,
    browsers: BTreeSet<String>,
}
impl Index {
    pub fn new(apps: &BTreeMap<String, App>) -> Self {
        let mut i = Self::default();
        for (id, a) in apps {
            i.generations.insert(id.clone(), a.generation);
            if a.record["MimeTypes"]
                .as_array()
                .is_some_and(|v| v.iter().any(|m| m == "x-scheme-handler/http"))
            {
                i.browsers.insert(id.clone());
            }
            if let Some(path) = a.record["DesktopPath"].as_str() {
                i.paths.entry(path.into()).or_default().insert(id.clone());
            }
            if a.record["Origin"] == "snap" {
                // Exported Snap desktop IDs have <snap>_<app>.desktop form.
                if let Some((name, _)) = id.split_once('_') {
                    i.snap.entry(name.into()).or_default().insert(id.clone());
                }
            }
            for name in [id.as_str(), id.strip_suffix(".desktop").unwrap_or(id)] {
                i.exact.entry(name.into()).or_default().insert(id.clone());
                i.folded
                    .entry(name.to_ascii_lowercase())
                    .or_default()
                    .insert(id.clone());
            }
            for (key, map) in [
                ("StartupWMClass", &mut i.wmclass),
                ("OriginId", &mut i.flatpak),
            ] {
                if let Some(s) = a.record[key].as_str().filter(|s| !s.is_empty())
                    && (key != "OriginId" || a.record["Origin"] == "flatpak")
                {
                    map.entry(s.into()).or_default().insert(id.clone());
                }
            }
            if let Some(s) = a.record["StartupWMClass"]
                .as_str()
                .filter(|s| !s.is_empty())
            {
                i.folded_class
                    .entry(s.to_ascii_lowercase())
                    .or_default()
                    .insert(id.clone());
            }
        }
        i
    }
    fn hits(map: &BTreeMap<String, BTreeSet<String>>, keys: &[String]) -> BTreeSet<String> {
        keys.iter()
            .flat_map(|k| map.get(k).into_iter().flatten().cloned())
            .collect()
    }
    fn names(&self, w: &Window) -> Vec<(BTreeSet<String>, &'static str)> {
        vec![
            (
                Self::hits(&self.exact, std::slice::from_ref(&w.app_id)),
                "exact-app-id",
            ),
            (
                Self::hits(&self.wmclass, std::slice::from_ref(&w.app_id)),
                "startup-wmclass",
            ),
            (
                Self::hits(&self.flatpak, std::slice::from_ref(&w.app_id)),
                "flatpak-name",
            ),
            (
                Self::hits(&self.folded, &[w.app_id.to_ascii_lowercase()]),
                "case-insensitive-app-id",
            ),
            (
                Self::hits(&self.folded_class, &[w.app_id.to_ascii_lowercase()]),
                "case-insensitive-wmclass",
            ),
            (
                Self::hits(&self.exact, std::slice::from_ref(&w.initial_app_id)),
                "initial-app-id",
            ),
            (
                Self::hits(&self.wmclass, std::slice::from_ref(&w.initial_app_id)),
                "initial-startup-wmclass",
            ),
            (
                Self::hits(&self.flatpak, std::slice::from_ref(&w.initial_app_id)),
                "initial-flatpak-name",
            ),
            (
                Self::hits(&self.folded, &[w.initial_app_id.to_ascii_lowercase()]),
                "initial-case-insensitive-app-id",
            ),
            (
                Self::hits(&self.folded_class, &[w.initial_app_id.to_ascii_lowercase()]),
                "initial-case-insensitive-wmclass",
            ),
        ]
    }
    pub fn resolve(&self, w: &Window, epoch: &str) -> Value {
        self.resolution(w, epoch).0
    }
    fn resolution(&self, w: &Window, epoch: &str) -> (Value, BTreeSet<String>) {
        if w.pid.is_some() && !w.evidence_ready && w.token_app.is_empty() {
            return (
                json!({"HyaloEpoch":epoch,"WindowId":w.id,"DesktopId":"","AppGeneration":0_u64,"MatchKind":"pending","CandidateCount":0_u64,"CandidatesComplete":true,"Candidates":[],"Narrowing":[]}),
                BTreeSet::new(),
            );
        }
        let e = &w.evidence;
        let mut sandbox = Self::hits(&self.flatpak, &e.flatpak);
        sandbox.extend(Self::hits(&self.snap, &e.snap));
        if let Some(steam) = w.steam_app {
            sandbox.extend(Self::hits(&self.exact, &[format!("steam_app_{steam}")]));
            sandbox.extend(Self::hits(&self.wmclass, &[format!("steam_app_{steam}")]));
        }
        let names = self.names(w);
        let name_hits = names
            .iter()
            .find(|(s, _)| !s.is_empty())
            .map(|(s, _)| s.clone())
            .unwrap_or_default();
        let mut units = Self::hits(&self.exact, &e.units);
        let scopes = Self::hits(&self.exact, &e.scopes);
        // A foreign Chromium scope naming another app is not launch provenance.
        units.extend(
            scopes
                .into_iter()
                .filter(|id| name_hits.is_empty() || name_hits.contains(id)),
        );
        units.retain(|id| !self.browsers.contains(id) || name_hits.contains(id));
        let token = if self.generations.contains_key(&w.token_app) {
            [w.token_app.clone()].into()
        } else {
            BTreeSet::new()
        };
        let mut choices = vec![
            (token, "activation-token"),
            (sandbox, "sandbox"),
            (Self::hits(&self.paths, &e.packages), "package"),
            (units, "launch-unit"),
        ];
        choices.extend(names);
        let mut candidates: Option<BTreeSet<String>> = None;
        let mut kind = "unknown";
        let mut narrowing = Vec::new();
        for (set, tier) in choices {
            if set.is_empty() {
                continue;
            }
            let next = match &candidates {
                Some(old) => old.intersection(&set).cloned().collect(),
                None => set,
            };
            if next.is_empty() {
                continue;
            }
            narrowing.push(json!({"Tier":tier,"CandidateCount":next.len() as u64}));
            let unique = next.len() == 1;
            candidates = Some(next);
            kind = tier;
            if unique {
                break;
            }
        }
        let set = candidates.as_ref();
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
        let result = json!({"HyaloEpoch":epoch,"WindowId":w.id,"DesktopId":id,"AppGeneration":self.generations.get(id).copied().unwrap_or(0),"MatchKind":if count>1{"ambiguous"}else{kind},"CandidateCount":count as u64,"CandidatesComplete":ids.len()==count,"Candidates":ids,"Narrowing":narrowing});
        (result, candidates.unwrap_or_default())
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
                let mut ws = windows(&v["windows"])?;
                for (id, w) in &mut ws {
                    if let Some(old) = self.windows.get(id) {
                        w.token_app = old.token_app.clone();
                        if w.identity() == old.identity() {
                            w.evidence = old.evidence.clone();
                            w.evidence_ready = old.evidence_ready;
                        }
                    }
                }
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
                    if w.app_id != app {
                        w.evidence = Default::default();
                        w.evidence_ready = false;
                    }
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
            self.resolve(index, w.id)["DesktopId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
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
    pub fn resolve(&self, index: &Index, id: u64) -> Value {
        fn walk(m: &Model, index: &Index, id: u64, seen: &mut BTreeSet<u64>) -> Option<Value> {
            if seen.len() >= 32 || !seen.insert(id) {
                return None;
            }
            let w = m.windows.get(&id)?;
            let (mut result, candidates) = index.resolution(w, &m.epoch);
            if result["DesktopId"] == ""
                && result["MatchKind"] != "pending"
                && let Some(parent) = w.parent.and_then(|p| walk(m, index, p, seen))
            {
                let app = parent["DesktopId"].as_str().unwrap_or_default();
                let allowed = candidates.is_empty() || candidates.contains(app);
                if !app.is_empty() && allowed {
                    result["DesktopId"] = json!(app);
                    result["AppGeneration"] = parent["AppGeneration"].clone();
                    result["MatchKind"] = json!("parent");
                    result["Candidates"] = json!([app]);
                    result["CandidateCount"] = json!(1);
                    result["CandidatesComplete"] = json!(true);
                    result["Narrowing"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!({"Tier":"parent","CandidateCount":1_u64}));
                }
            }
            Some(result)
        }
        walk(self, index, id, &mut BTreeSet::new()).unwrap_or(Value::Null)
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

#[cfg(test)]
mod identity_tests {
    use super::*;
    fn app(id: &str, extra: Value) -> App {
        let mut record =
            json!({"DesktopId":id,"DesktopPath":format!("/usr/share/applications/{id}")});
        for (key, value) in extra.as_object().unwrap() {
            record[key] = value.clone();
        }
        App {
            id: id.into(),
            generation: 1,
            digest: String::new(),
            source_hash: String::new(),
            exec_hash: String::new(),
            record,
            executable: String::new(),
            keywords: Vec::new(),
            icon: String::new(),
        }
    }
    fn index() -> Index {
        Index::new(
            &[
                app("chatgpt.desktop", json!({})),
                app(
                    "org.telegram.desktop.desktop",
                    json!({"StartupWMClass":"Telegram"}),
                ),
                app(
                    "org.flat.App.desktop",
                    json!({"Origin":"flatpak","OriginId":"org.flat.App"}),
                ),
                app("snapapp_editor.desktop", json!({"Origin":"snap"})),
                app(
                    "steam-game.desktop",
                    json!({"StartupWMClass":"steam_app_440"}),
                ),
                app(
                    "chromium.desktop",
                    json!({"MimeTypes":["x-scheme-handler/http"]}),
                ),
            ]
            .into_iter()
            .map(|a| (a.id.clone(), a))
            .collect(),
        )
    }
    fn w() -> Window {
        Window {
            id: 1,
            ..Default::default()
        }
    }
    fn check(i: &Index, w: &Window, app: &str, kind: &str) {
        let r = i.resolve(w, "7:fixture");
        assert_eq!(r["DesktopId"], app);
        assert_eq!(r["MatchKind"], kind);
    }
    #[test]
    fn every_tier_has_its_own_positive_and_missing_evidence_control() {
        let i = index();
        let mut win = w();
        win.token_app = "chatgpt.desktop".into();
        check(&i, &win, "chatgpt.desktop", "activation-token");
        win.token_app.clear();
        check(&i, &win, "", "unknown");
        win.evidence.flatpak = vec!["org.flat.App".into()];
        check(&i, &win, "org.flat.App.desktop", "sandbox");
        win.evidence.flatpak.clear();
        check(&i, &win, "", "unknown");
        win.evidence.snap = vec!["snapapp".into()];
        check(&i, &win, "snapapp_editor.desktop", "sandbox");
        win.evidence.snap.clear();
        win.steam_app = Some(440);
        check(&i, &win, "steam-game.desktop", "sandbox");
        win.steam_app = None;
        win.evidence.packages = vec!["/usr/share/applications/chatgpt.desktop".into()];
        check(&i, &win, "chatgpt.desktop", "package");
        win.evidence.packages.clear();
        check(&i, &win, "", "unknown");
        win.evidence.units = vec!["chatgpt".into()];
        check(&i, &win, "chatgpt.desktop", "launch-unit");
        win.evidence.units.clear();
        check(&i, &win, "", "unknown");
        win.app_id = "Chatgpt".into();
        check(&i, &win, "chatgpt.desktop", "case-insensitive-app-id");
        win.app_id = "Telegram".into();
        check(&i, &win, "org.telegram.desktop.desktop", "startup-wmclass");
        win.app_id.clear();
        win.initial_app_id = "chatgpt".into();
        check(&i, &win, "chatgpt.desktop", "initial-app-id");
    }
    #[test]
    fn pid_evidence_is_hydrated_before_lower_tiers_can_choose() {
        let i = index();
        let mut win = w();
        win.pid = Some(42);
        win.app_id = "Chatgpt".into();
        check(&i, &win, "", "pending");
        win.evidence_ready = true;
        check(&i, &win, "chatgpt.desktop", "case-insensitive-app-id");
        win.app_id.clear();
        win.initial_app_id = "Chatgpt".into();
        check(
            &i,
            &win,
            "chatgpt.desktop",
            "initial-case-insensitive-app-id",
        );
    }
    #[test]
    fn ambiguity_narrows_but_conflicting_lower_tiers_never_replace_it() {
        let i = index();
        let mut win = w();
        win.evidence.packages = vec![
            "/usr/share/applications/chatgpt.desktop".into(),
            "/usr/share/applications/steam-game.desktop".into(),
        ];
        win.app_id = "chromium".into();
        check(&i, &win, "", "ambiguous");
        win.app_id = "Chatgpt".into();
        check(&i, &win, "chatgpt.desktop", "case-insensitive-app-id");
        let r = i.resolve(&win, "e");
        assert_eq!(r["Narrowing"][0]["CandidateCount"], 2);
        win.token_app = "steam-game.desktop".into();
        check(&i, &win, "steam-game.desktop", "activation-token");
    }
    #[test]
    fn browser_pwas_and_foreign_scopes_cannot_steal_another_app() {
        let i = index();
        let mut win = w();
        win.app_id = "chrome-abc-Default".into();
        win.evidence.scopes = vec!["chromium".into()];
        check(&i, &win, "", "unknown");
        win.app_id = "Chatgpt".into();
        check(&i, &win, "chatgpt.desktop", "case-insensitive-app-id");
        win.evidence.units = vec!["chatgpt".into()];
        check(&i, &win, "chatgpt.desktop", "launch-unit");
        win.app_id = "chromium".into();
        win.evidence.units.clear();
        check(&i, &win, "chromium.desktop", "launch-unit");
        win.evidence.scopes.clear();
        check(&i, &win, "chromium.desktop", "exact-app-id");
    }
    #[test]
    fn dialogs_inherit_only_unresolved_identity_and_cycles_terminate() {
        let i = index();
        let mut m = Model {
            epoch: "7:e".into(),
            ..Default::default()
        };
        let mut main = w();
        main.app_id = "Chatgpt".into();
        let dialog = Window {
            id: 2,
            parent: Some(1),
            ..Default::default()
        };
        m.windows = [(1, main), (2, dialog)].into();
        assert_eq!(m.resolve(&i, 2)["MatchKind"], "parent");
        assert_eq!(m.resolve(&i, 2)["DesktopId"], "chatgpt.desktop");
        m.windows.get_mut(&2).unwrap().app_id = "chromium".into();
        assert_eq!(m.resolve(&i, 2)["DesktopId"], "chromium.desktop");
        m.windows.get_mut(&2).unwrap().app_id.clear();
        m.windows.get_mut(&1).unwrap().app_id.clear();
        m.windows.get_mut(&1).unwrap().parent = Some(2);
        assert_eq!(m.resolve(&i, 2)["DesktopId"], "");
    }
    #[test]
    fn token_identity_survives_snapshots_but_not_window_close_or_connection_loss() {
        let mut m = Model::default();
        m.bootstrap(json!({"event":"snapshot","epoch":7,"serial":1,"time_us":1,"windows":[{"id":1}],"focus":null,"locked":false,"idle":false,"session_active":true,"sleeping":false})).unwrap();
        m.windows.get_mut(&1).unwrap().token_app = "chatgpt.desktop".into();
        m.event(json!({"event":"windows_changed","epoch":7,"serial":2,"time_us":2,"windows":[{"id":1,"app_id":"new-name"}]})).unwrap();
        assert_eq!(m.resolve(&index(), 1)["MatchKind"], "activation-token");
        m.event(json!({"event":"windows_changed","epoch":7,"serial":3,"time_us":3,"windows":[]}))
            .unwrap();
        m.event(json!({"event":"windows_changed","epoch":7,"serial":4,"time_us":4,"windows":[{"id":1}]})).unwrap();
        assert_eq!(m.resolve(&index(), 1)["DesktopId"], "");
        m.disconnect();
        assert!(m.windows.is_empty());
    }
}
