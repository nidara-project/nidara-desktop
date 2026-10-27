// SPDX-License-Identifier: GPL-3.0-or-later
//! Conservative causal headphone loss detector, independent of default selection.
use super::model::{Graph, Node};
use std::collections::BTreeMap;
pub struct Event {
    pub old: String,
    pub new: String,
    pub streams: Vec<String>,
    pub reason: &'static str,
}
#[derive(Default)]
pub struct Tracker {
    pending: BTreeMap<String, (u64, Vec<String>)>,
}
pub fn endpoint(g: &Graph, n: &Node) -> &'static str {
    if n.kind != "output" || n.device == "/" {
        return "unknown";
    }
    if n.endpoint_kind == "bluetooth" {
        return "bluetooth";
    }
    if let Some(route) = g.routes.get(&n.active_route) {
        match route.port_type.as_str() {
            "headphones" | "headset" => return "headphones",
            "speaker" => return "speaker",
            _ => {}
        }
        if matches!(
            route.name.as_str(),
            "analog-output-headphones"
                | "analog-output-headset"
                | "[Out] Headphones"
                | "[Out] Headset"
        ) {
            return "headphones";
        }
        if matches!(
            route.name.as_str(),
            "analog-output-speaker" | "[Out] Speaker"
        ) {
            return "speaker";
        }
    }
    match n.endpoint_kind.as_str() {
        "bluetooth" => "bluetooth",
        "headphones" => "headphones",
        "speaker" => "speaker",
        _ => "unknown",
    }
}
impl Tracker {
    pub fn advance(&mut self, old: &Graph, new: &Graph, now: u64, manual: bool) -> Vec<Event> {
        if manual
            || old.generation != new.generation
            || !matches!(old.state.as_str(), "ready" | "degraded")
            || !matches!(new.state.as_str(), "ready" | "degraded")
        {
            self.pending.clear();
            return vec![];
        }
        let mut events = vec![];
        for (path, before) in &old.nodes {
            if before.kind != "output" {
                continue;
            }
            let affected = old
                .nodes
                .values()
                .filter(|s| s.kind == "playback" && !s.internal && s.targets.contains(path))
                .map(|s| s.path.clone())
                .collect::<Vec<_>>();
            if affected.is_empty() {
                continue;
            }
            match (endpoint(old, before), new.nodes.get(path)) {
                ("headphones", Some(after))
                    if endpoint(new, after) == "speaker"
                        && before.active_route != after.active_route =>
                {
                    let lost = old
                        .routes
                        .get(&before.active_route)
                        .zip(new.routes.get(&before.active_route))
                        .is_some_and(|(a, b)| a.availability != "no" && b.availability == "no");
                    if lost {
                        events.push(Event {
                            old: path.clone(),
                            new: path.clone(),
                            streams: affected,
                            reason: "headphone-route-unavailable",
                        });
                    }
                }
                ("bluetooth" | "headphones", None)
                    if old.devices.contains_key(&before.device)
                        && !new.devices.contains_key(&before.device) =>
                {
                    self.pending.entry(path.clone()).or_insert((now, affected));
                }
                _ => {}
            }
        }
        self.pending
            .retain(|_, (when, _)| now.saturating_sub(*when) <= 2_000_000);
        let mut done = vec![];
        for (lost, (_, streams)) in &self.pending {
            let mut destinations: BTreeMap<String, Vec<String>> = BTreeMap::new();
            for stream in streams {
                if let Some(s) = new.nodes.get(stream)
                    && s.targets.len() == 1
                    && let Some(target) = new.nodes.get(&s.targets[0])
                    && endpoint(new, target) == "speaker"
                {
                    destinations
                        .entry(target.path.clone())
                        .or_default()
                        .push(stream.clone());
                }
            }
            if !destinations.is_empty() {
                done.push(lost.clone());
                for (target, streams) in destinations {
                    events.push(Event {
                        old: lost.clone(),
                        new: target,
                        streams,
                        reason: "headphone-output-removed",
                    });
                }
            }
        }
        for lost in done {
            self.pending.remove(&lost);
        }
        events
    }
}
#[cfg(test)]
mod tests {
    use super::super::model::{Device, Route};
    use super::*;
    fn node(path: &str, kind: &str, endpoint: &str) -> Node {
        Node {
            path: path.into(),
            kind: kind.into(),
            device: "/device".into(),
            endpoint_kind: endpoint.into(),
            ..Default::default()
        }
    }
    fn graph() -> Graph {
        let mut g = Graph {
            state: "ready".into(),
            generation: 1,
            ..Default::default()
        };
        g.devices.insert("/device".into(), Device::default());
        g.nodes
            .insert("/out".into(), node("/out", "output", "headphones"));
        let mut stream = node("/app", "playback", "");
        stream.targets = vec!["/out".into()];
        g.nodes.insert("/app".into(), stream);
        g
    }
    #[test]
    fn analog_route_loss_requires_availability_and_ignores_manual_or_restart() {
        let mut a = graph();
        a.nodes.get_mut("/out").unwrap().active_route = "/headphone".into();
        a.routes.insert(
            "/headphone".into(),
            Route {
                name: "analog-output-headphones".into(),
                availability: "yes".into(),
                ..Default::default()
            },
        );
        a.routes.insert(
            "/speaker".into(),
            Route {
                name: "analog-output-speaker".into(),
                ..Default::default()
            },
        );
        let mut b = a.clone();
        b.nodes.get_mut("/out").unwrap().active_route = "/speaker".into();
        let mut t = Tracker::default();
        assert!(t.advance(&a, &b, 1, false).is_empty());
        b.routes.get_mut("/headphone").unwrap().availability = "no".into();
        assert_eq!(t.advance(&a, &b, 2, false).len(), 1);
        assert!(t.advance(&a, &b, 3, true).is_empty());
        b.generation = 2;
        assert!(t.advance(&a, &b, 4, false).is_empty());
    }
    #[test]
    fn bluetooth_loss_waits_for_actual_speaker_links() {
        let mut a = graph();
        a.nodes.get_mut("/out").unwrap().endpoint_kind = "bluetooth".into();
        let mut b = a.clone();
        b.nodes.remove("/out");
        b.devices.remove("/device");
        b.nodes.get_mut("/app").unwrap().targets.clear();
        let mut t = Tracker::default();
        assert!(t.advance(&a, &b, 10, false).is_empty());
        let mut c = b.clone();
        c.nodes
            .insert("/speaker".into(), node("/speaker", "output", "speaker"));
        c.nodes.get_mut("/app").unwrap().targets = vec!["/speaker".into()];
        assert_eq!(t.advance(&b, &c, 20, false).len(), 1);
        assert!(t.advance(&c, &c, 30, false).is_empty());
    }
    #[test]
    fn profile_reenumeration_and_unclassified_destinations_do_not_pause() {
        let mut old = graph();
        old.nodes.get_mut("/out").unwrap().endpoint_kind = "bluetooth".into();
        let mut new = old.clone();
        new.nodes.remove("/out");
        new.nodes
            .insert("/speaker".into(), node("/speaker", "output", "speaker"));
        new.nodes.get_mut("/app").unwrap().targets = vec!["/speaker".into()];
        let mut tracker = Tracker::default();
        assert!(
            tracker.advance(&old, &new, 1, false).is_empty(),
            "same physical device is profile reenumeration, not disconnect"
        );
        new.devices.remove("/device");
        new.nodes.get_mut("/speaker").unwrap().device = "/".into();
        assert!(
            tracker.advance(&old, &new, 2, false).is_empty(),
            "virtual/unknown destinations are not evidence of speaker fallback"
        );
    }
    #[test]
    fn ucm_jack_availability_loss_on_same_sink_and_port_type_priority() {
        let mut old = graph();
        old.nodes.get_mut("/out").unwrap().endpoint_kind = "unknown".into();
        old.nodes.get_mut("/out").unwrap().active_route = "/headphones".into();
        old.routes.insert(
            "/headphones".into(),
            Route {
                name: "[Out] Headphones".into(),
                availability: "yes".into(),
                ..Default::default()
            },
        );
        old.routes.insert(
            "/speaker".into(),
            Route {
                name: "[Out] Speaker".into(),
                availability: "yes".into(),
                ..Default::default()
            },
        );
        let mut new = old.clone();
        new.routes.get_mut("/headphones").unwrap().availability = "no".into();
        new.nodes.get_mut("/out").unwrap().active_route = "/speaker".into();
        assert_eq!(Tracker::default().advance(&old, &new, 1, false).len(), 1);
        let route = new.routes.get_mut("/speaker").unwrap();
        route.name = "custom-uCm-name".into();
        route.port_type = "speaker".into();
        assert_eq!(endpoint(&new, &new.nodes["/out"]), "speaker");
        new.routes.get_mut("/speaker").unwrap().name = "[Out] Headphones".into();
        assert_eq!(
            endpoint(&new, &new.nodes["/out"]),
            "speaker",
            "typed metadata takes precedence over names"
        );
    }
    #[test]
    fn bluetooth_disconnect_can_fall_back_to_ucm_speaker() {
        let mut old = graph();
        old.nodes.get_mut("/out").unwrap().endpoint_kind = "bluetooth".into();
        let mut new = old.clone();
        new.nodes.remove("/out");
        new.devices.remove("/device");
        let mut speaker = node("/internal", "output", "unknown");
        speaker.device = "/internal_card".into();
        speaker.active_route = "/ucm_speaker".into();
        new.nodes.insert(speaker.path.clone(), speaker);
        new.routes.insert(
            "/ucm_speaker".into(),
            Route {
                name: "[Out] Speaker".into(),
                ..Default::default()
            },
        );
        new.nodes.get_mut("/app").unwrap().targets = vec!["/internal".into()];
        let events = Tracker::default().advance(&old, &new, 1, false);
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].new, "/internal");
    }
}
