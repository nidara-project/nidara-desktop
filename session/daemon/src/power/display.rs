// SPDX-License-Identifier: GPL-3.0-or-later
//! Event-driven forwarding, with one in-flight request and no property proxy/cache.
use super::{Power, provider};
use futures_util::StreamExt;
use std::sync::atomic::Ordering;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Effect {
    owner: String,
    closed: bool,
}
#[derive(Default)]
pub(super) struct Forwarder {
    owner: String,
    desired: Option<bool>,
    attempted: Option<Effect>,
    running: bool,
}
impl Forwarder {
    fn next(&self) -> Option<Effect> {
        let effect = Effect {
            owner: self.owner.clone(),
            closed: self.desired?,
        };
        (!effect.owner.is_empty() && self.attempted.as_ref() != Some(&effect)).then_some(effect)
    }
    fn claim(&mut self) -> bool {
        if self.running || self.next().is_none() {
            return false;
        }
        self.running = true;
        true
    }
}
/// Called on every provider refresh, but does not send or spawn unless desired state changes.
pub(super) fn update(p: &Power, closed: bool) {
    if p.read_only {
        return;
    }
    p.display_lid.lock().unwrap().desired = Some(closed);
    start(p);
}
pub(super) fn owner(p: &Power, owner: String) {
    let mut f = p.display_lid.lock().unwrap();
    if f.owner == owner {
        return;
    }
    f.owner = owner;
    // Same closed state must reach a replacement compositor, even before another refresh.
    f.attempted = None;
    drop(f);
    if !p.read_only {
        start(p);
    }
}
pub(super) async fn watch(p: &Power) -> zbus::Result<()> {
    let proxy = zbus::fdo::DBusProxy::new(&p.conn).await?;
    let mut changes = proxy
        .receive_name_owner_changed_with_args(&[(0, "org.nidara.Display")])
        .await?;
    let name = zbus::names::BusName::try_from("org.nidara.Display").unwrap();
    owner(
        p,
        proxy
            .get_name_owner(name)
            .await
            .map(|o| o.to_string())
            .unwrap_or_default(),
    );
    let p = p.clone();
    tokio::spawn(async move {
        while let Some(event) = changes.next().await {
            let Ok(args) = event.args() else { continue };
            let previous = args
                .old_owner()
                .as_ref()
                .map(|o| o.as_str())
                .unwrap_or_default();
            let next = args
                .new_owner()
                .as_ref()
                .map(|o| o.to_string())
                .unwrap_or_default();
            // The initial owner query can overtake transitions already queued on this stream.
            // Ignore that stale prefix instead of sending to a superseded unique owner.
            let current = p.display_lid.lock().unwrap().owner.clone();
            if current != previous && current != next {
                continue;
            }
            owner(&p, next);
        }
    });
    Ok(())
}
fn start(p: &Power) {
    if !p.display_lid.lock().unwrap().claim() {
        return;
    }
    let p = p.clone();
    tokio::spawn(async move {
        loop {
            let effect = {
                let mut f = p.display_lid.lock().unwrap();
                let Some(effect) = f.next() else {
                    f.running = false;
                    return;
                };
                // Failures do not cause retry storms on unrelated Power1 refreshes.
                // A closed-state change or a new bus owner can send again.
                f.attempted = Some(effect.clone());
                effect
            };
            let sequence = p.serial.fetch_add(1, Ordering::Relaxed);
            let _ = provider::bounded(p.conn.call_method(
                Some(effect.owner.as_str()),
                "/org/nidara/Display",
                Some("org.nidara.Display1"),
                "SetLidState",
                &(p.epoch, sequence, effect.closed),
            ))
            .await;
            // Coalesce all changes while this bounded call was in flight to the latest value.
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_refreshes_do_not_send_again_and_restart_replays_latest_state() {
        let mut f = Forwarder {
            owner: ":1.1".into(),
            desired: Some(true),
            ..Default::default()
        };
        assert!(f.claim());
        let sent = f.next().unwrap();
        f.attempted = Some(sent);
        assert!(f.next().is_none());
        assert!(!f.claim());
        f.running = false;
        for _ in 0..100 {
            f.desired = Some(true);
            assert!(!f.claim());
        }
        f.owner = ":1.2".into();
        f.attempted = None;
        assert!(f.claim());
        assert_eq!(
            f.next().unwrap(),
            Effect {
                owner: ":1.2".into(),
                closed: true
            }
        );
    }
    #[test]
    fn slow_call_coalesces_changes_without_starting_another_worker() {
        let mut f = Forwarder {
            owner: ":1.1".into(),
            desired: Some(true),
            ..Default::default()
        };
        assert!(f.claim());
        f.attempted = f.next();
        f.desired = Some(false);
        assert!(!f.claim());
        assert!(!f.next().unwrap().closed);
        f.owner.clear();
        assert!(f.next().is_none());
    }
}
