// SPDX-License-Identifier: GPL-3.0-or-later
//! Cooperative Unity Update SIGNALS. No remote methods, quicklists or execution.
use super::{Dict, store::Handle};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use zbus::{MatchRule, MessageStream, message::Type};
const NAME: &str = "com.canonical.Unity";
const IFACE: &str = "com.canonical.Unity.LauncherEntry";
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Launcher {
    count: i64,
    count_visible: bool,
    progress: f64,
    progress_visible: bool,
    urgent: bool,
}
impl Launcher {
    pub fn json(&self) -> Value {
        json!({"Count":self.count,"CountVisible":self.count_visible,"Progress":self.progress,"ProgressVisible":self.progress_visible,"Urgent":self.urgent})
    }
}
#[derive(Default)]
pub struct Patch {
    count: Option<i64>,
    count_visible: Option<bool>,
    progress: Option<f64>,
    progress_visible: Option<bool>,
    urgent: Option<bool>,
}
impl Patch {
    pub fn parse(values: Dict) -> Option<Self> {
        if values.len() > 64 {
            return None;
        }
        let mut p = Self::default();
        for (key, v) in values {
            match key.as_str() {
                "count" => {
                    let n = i64::try_from(v).ok()?;
                    if n < 0 {
                        return None;
                    }
                    p.count = Some(n)
                }
                "count-visible" => p.count_visible = Some(bool::try_from(v).ok()?),
                "progress" => {
                    let n = f64::try_from(v).ok()?;
                    if !n.is_finite() {
                        return None;
                    }
                    p.progress = Some(n.clamp(0.0, 1.0))
                }
                "progress-visible" => p.progress_visible = Some(bool::try_from(v).ok()?),
                "urgent" => p.urgent = Some(bool::try_from(v).ok()?),
                _ => {}
            }
        }
        (p.count.is_some()
            || p.count_visible.is_some()
            || p.progress.is_some()
            || p.progress_visible.is_some()
            || p.urgent.is_some())
        .then_some(p)
    }
    fn apply(self, l: &mut Launcher) {
        if let Some(v) = self.count {
            l.count = v
        }
        if let Some(v) = self.count_visible {
            l.count_visible = v
        }
        if let Some(v) = self.progress {
            l.progress = v
        }
        if let Some(v) = self.progress_visible {
            l.progress_visible = v
        }
        if let Some(v) = self.urgent {
            l.urgent = v
        }
    }
}
struct Entry {
    value: Launcher,
    order: u64,
}
#[derive(Default)]
pub struct Unity {
    entries: BTreeMap<(String, String, String), Entry>,
    published: BTreeMap<String, Launcher>,
    pending: BTreeSet<String>,
    next: u64,
    pub available: bool,
    pub incomplete: bool,
}
impl Unity {
    pub fn status(&mut self, available: bool, incomplete: bool) -> bool {
        let changed = self.available != available || self.incomplete != incomplete;
        self.available = available;
        self.incomplete = incomplete;
        if !available {
            self.pending.extend(self.published.keys().cloned());
            self.entries.clear();
        }
        changed
    }
    pub fn update(&mut self, owner: String, path: String, id: String, patch: Patch) {
        if !owner.starts_with(':') || owner.len() > 255 || path.len() > 1024 {
            return;
        }
        let key = (owner.clone(), path, id.clone());
        if !self.entries.contains_key(&key)
            && (self.entries.len() >= 1024
                || (!self.entries.keys().any(|(o, _, _)| o == &owner)
                    && self
                        .entries
                        .keys()
                        .map(|(o, _, _)| o)
                        .collect::<BTreeSet<_>>()
                        .len()
                        >= 256))
        {
            return;
        }
        self.next = self.next.saturating_add(1);
        let e = self.entries.entry(key).or_insert(Entry {
            value: Launcher::default(),
            order: 0,
        });
        patch.apply(&mut e.value);
        e.order = self.next;
        self.pending.insert(id);
    }
    pub fn lost(&mut self, owner: &str) -> BTreeSet<String> {
        let ids = self
            .entries
            .keys()
            .filter(|(o, _, _)| o == owner)
            .map(|(_, _, id)| id.clone())
            .collect::<BTreeSet<_>>();
        self.entries.retain(|(o, _, _), _| o != owner);
        self.publish(ids)
    }
    pub fn retain(&mut self, ids: &BTreeSet<String>) {
        self.entries.retain(|(_, _, id), _| ids.contains(id));
        self.published.retain(|id, _| ids.contains(id));
        self.pending.retain(|id| ids.contains(id));
    }
    pub fn pending(&self) -> bool {
        !self.pending.is_empty()
    }
    pub fn flush(&mut self) -> BTreeSet<String> {
        let ids = std::mem::take(&mut self.pending);
        self.publish(ids)
    }
    fn publish(&mut self, ids: BTreeSet<String>) -> BTreeSet<String> {
        let mut changed = BTreeSet::new();
        for id in ids {
            let value = self
                .entries
                .iter()
                .filter(|((_, _, a), _)| a == &id)
                .max_by_key(|(_, e)| e.order)
                .map(|(_, e)| e.value.clone())
                .unwrap_or_default();
            if self.published.get(&id).cloned().unwrap_or_default() != value {
                changed.insert(id.clone());
            }
            if value == Launcher::default() {
                self.published.remove(&id);
            } else {
                self.published.insert(id, value);
            }
        }
        changed
    }
    pub fn record(&self, id: &str) -> Value {
        self.published.get(id).cloned().unwrap_or_default().json()
    }
}
pub fn spawn(store: Handle) {
    tokio::spawn(async move {
        loop {
            if listen(&store).await.is_err() {
                let _ = store
                    .call(|s| {
                        s.unity_status(false, true);
                        Ok(())
                    })
                    .await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
    });
}
async fn claim(conn: &zbus::Connection) -> zbus::Result<bool> {
    match conn
        .request_name_with_flags(NAME, zbus::fdo::RequestNameFlags::DoNotQueue.into())
        .await
    {
        Ok(
            zbus::fdo::RequestNameReply::PrimaryOwner | zbus::fdo::RequestNameReply::AlreadyOwner,
        ) => Ok(false),
        Ok(_) | Err(zbus::Error::NameTaken) => Ok(true),
        Err(e) => Err(e),
    }
}
async fn listen(store: &Handle) -> zbus::Result<()> {
    store
        .call(|s| {
            s.unity_status(false, true);
            Ok(())
        })
        .await
        .map_err(|_| zbus::Error::Failure("Unity store unavailable".into()))?;
    // One dedicated connection/stream preserves Update-before-owner-loss ordering.
    // Two SelectAll streams can otherwise replay a queued Update AFTER sender loss.
    let conn = zbus::connection::Builder::session()?
        .max_queued(256)
        .method_timeout(std::time::Duration::from_secs(2))
        .build()
        .await?;
    let mut stream = MessageStream::from(&conn);
    let bus = zbus::fdo::DBusProxy::new(&conn).await?;
    let updates = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface(IFACE)?
        .member("Update")?
        .build();
    let owners = MatchRule::builder()
        .msg_type(Type::Signal)
        .sender("org.freedesktop.DBus")?
        .interface("org.freedesktop.DBus")?
        .member("NameOwnerChanged")?
        .build();
    bus.add_match_rule(updates).await?;
    bus.add_match_rule(owners).await?;
    let incomplete = claim(&conn).await?;
    store
        .call(move |s| {
            s.unity_status(true, incomplete);
            Ok(())
        })
        .await
        .map_err(|_| zbus::Error::Failure("Unity store unavailable".into()))?;
    while let Some(message) = stream.next().await {
        let message = message?;
        let h = message.header();
        if h.message_type() != Type::Signal {
            continue;
        }
        if h.sender()
            .is_some_and(|s| s.as_str() == "org.freedesktop.DBus")
            && h.member().is_some_and(|m| m.as_str() == "NameOwnerChanged")
        {
            if let Ok((name, _, new)) = message.body().deserialize::<(String, String, String)>() {
                if name.starts_with(':') && new.is_empty() {
                    store
                        .call(move |s| {
                            s.unity_lost(&name);
                            Ok(())
                        })
                        .await
                        .map_err(|_| zbus::Error::Failure("Unity store unavailable".into()))?;
                } else if name == NAME && new.is_empty() {
                    let incomplete = claim(&conn).await?;
                    store
                        .call(move |s| {
                            s.unity_status(true, incomplete);
                            Ok(())
                        })
                        .await
                        .map_err(|_| zbus::Error::Failure("Unity store unavailable".into()))?;
                }
            }
        } else if h.interface().is_some_and(|i| i.as_str() == IFACE)
            && h.member().is_some_and(|m| m.as_str() == "Update")
            && message.data().len() <= 64 * 1024
        {
            let Some(owner) = h.sender().map(|s| s.to_string()) else {
                continue;
            };
            let Some(path) = h.path().map(|p| p.to_string()) else {
                continue;
            };
            if let Ok((uri, values)) = message.body().deserialize::<(String, Dict)>()
                && let Some(id) = uri
                    .strip_prefix("application://")
                    .filter(|id| id.len() <= 1024)
                && let Some(patch) = Patch::parse(values)
            {
                let id = id.to_owned();
                store
                    .call(move |s| {
                        if s.apps.contains_key(&id) {
                            s.unity_update(owner, path, id, patch);
                        }
                        Ok(())
                    })
                    .await
                    .map_err(|_| zbus::Error::Failure("Unity store unavailable".into()))?;
            }
        }
    }
    Err(zbus::Error::Failure("Unity signal stream ended".into()))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn patch(count: i64, visible: bool) -> Patch {
        Patch {
            count: Some(count),
            count_visible: Some(visible),
            ..Patch::default()
        }
    }
    #[test]
    fn latest_whole_entry_wins_and_loss_recomputes_without_summing() {
        let mut u = Unity::default();
        u.update(":1".into(), "/a".into(), "A".into(), patch(3, true));
        u.update(":2".into(), "/b".into(), "A".into(), patch(7, true));
        u.flush();
        assert_eq!(u.record("A")["Count"], 7);
        u.update(
            ":1".into(),
            "/a".into(),
            "A".into(),
            Patch {
                urgent: Some(true),
                ..Patch::default()
            },
        );
        u.flush();
        assert_eq!(u.record("A")["Count"], 3);
        assert_eq!(u.record("A")["Urgent"], true);
        u.lost(":1");
        assert_eq!(u.record("A")["Count"], 7);
        u.lost(":2");
        assert_eq!(u.record("A")["CountVisible"], false);
    }
    #[test]
    fn visibility_false_clears_without_forgetting_own_fields() {
        let mut u = Unity::default();
        u.update(":1".into(), "/a".into(), "A".into(), patch(3, true));
        u.flush();
        u.update(
            ":1".into(),
            "/a".into(),
            "A".into(),
            Patch {
                count_visible: Some(false),
                ..Patch::default()
            },
        );
        u.flush();
        assert_eq!(u.record("A")["Count"], 3);
        assert_eq!(u.record("A")["CountVisible"], false);
    }
    #[test]
    fn sender_and_entry_budgets_are_hard_limits() {
        let mut u = Unity::default();
        for i in 0..256 {
            u.update(format!(":1.{i}"), "/a".into(), "A".into(), patch(i, true));
        }
        u.update(":new".into(), "/a".into(), "A".into(), patch(999, true));
        assert_eq!(u.entries.len(), 256);
        for i in 0..800 {
            u.update(
                ":1.0".into(),
                format!("/more{i}"),
                "A".into(),
                patch(i, true),
            );
        }
        assert_eq!(u.entries.len(), 1024);
    }
}
