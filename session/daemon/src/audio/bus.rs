// SPDX-License-Identifier: GPL-3.0-or-later
use super::*;
use zbus::object_server::SignalEmitter;
#[derive(Clone)]
pub struct Root(pub Audio);
#[zbus::interface(name = "org.nidara.Audio1")]
impl Root {
    #[zbus(property)]
    fn state(&self) -> String {
        self.0.snapshot().state
    }
    #[zbus(property)]
    fn last_error(&self) -> String {
        self.0.snapshot().error
    }
    #[zbus(property)]
    fn generation(&self) -> u64 {
        self.0.snapshot().generation
    }
    #[zbus(property)]
    fn default_output(&self) -> Path {
        path(&self.0.snapshot().default_output)
    }
    #[zbus(property)]
    fn default_input(&self) -> Path {
        path(&self.0.snapshot().default_input)
    }
    #[zbus(property)]
    fn volume_limit(&self) -> f64 {
        self.0.prefs.read().unwrap().limit()
    }
    #[zbus(property)]
    fn recording_streams(&self) -> Vec<Path> {
        self.0
            .snapshot()
            .nodes
            .values()
            .filter(|n| n.kind == "capture" && !n.internal)
            .map(|n| path(&n.path))
            .collect()
    }
    #[zbus(property)]
    fn internal_capture(&self) -> Vec<Path> {
        self.0
            .snapshot()
            .nodes
            .values()
            .filter(|n| n.kind == "capture" && n.internal)
            .map(|n| path(&n.path))
            .collect()
    }
    #[zbus(property)]
    fn streams(&self) -> Vec<Path> {
        self.0
            .snapshot()
            .nodes
            .values()
            .filter(|n| matches!(n.kind.as_str(), "playback" | "capture") && !n.internal)
            .map(|n| path(&n.path))
            .collect()
    }
    #[zbus(property)]
    fn default_switch_mode(&self) -> &str {
        if self.0.snapshot().switch_policy {
            "wireplumber-policy"
        } else {
            "unsupported"
        }
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<String> {
        root_caps(&self.0.snapshot())
    }
    async fn set_volume(&self, node: Path, volume: f64) -> Result<(), Error> {
        self.0.apply(node.as_str(), Action::Volume(volume)).await
    }
    async fn set_muted(&self, node: Path, muted: bool) -> Result<(), Error> {
        self.0.apply(node.as_str(), Action::Muted(muted)).await
    }
    async fn set_balance(&self, node: Path, balance: f64) -> Result<(), Error> {
        self.0.apply(node.as_str(), Action::Balance(balance)).await
    }
    async fn set_default(&self, node: Path) -> Result<(), Error> {
        self.0.apply(node.as_str(), Action::Default).await
    }
    async fn clear_default(&self, direction: String) -> Result<(), Error> {
        self.0.apply(ROOT, Action::ClearDefault(direction)).await
    }
    async fn move_playback(&self, stream: Path, output: Path) -> Result<(), Error> {
        self.0
            .apply(stream.as_str(), Action::Move(Some(output.to_string())))
            .await
    }
    async fn follow_default(&self, stream: Path) -> Result<(), Error> {
        self.0.apply(stream.as_str(), Action::Move(None)).await
    }
    async fn set_profile(&self, profile: Path) -> Result<(), Error> {
        self.0.apply(profile.as_str(), Action::Profile).await
    }
    async fn set_route(&self, node: Path, route: Path) -> Result<(), Error> {
        self.0
            .apply(node.as_str(), Action::Route(route.to_string()))
            .await
    }
    async fn subscribe_peak(
        &self,
        input: Path,
        requested_hz: u32,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<Path, Error> {
        #[cfg(feature = "audio-native")]
        {
            self.0
                .streams
                .subscribe(&self.0, conn, &header, input, requested_hz)
                .await
        }
        #[cfg(not(feature = "audio-native"))]
        {
            let _ = (input, requested_hz, header, conn);
            Err(Error::Unavailable("build without audio-native".into()))
        }
    }
    async fn test_channel(
        &self,
        output: Path,
        position: String,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<Path, Error> {
        #[cfg(feature = "audio-native")]
        {
            self.0
                .streams
                .play(&self.0, conn, &header, Some(output), &position, "test")
                .await
        }
        #[cfg(not(feature = "audio-native"))]
        {
            let _ = (output, position, header, conn);
            Err(Error::Unavailable("build without audio-native".into()))
        }
    }
    async fn play_alert(
        &self,
        event: String,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<Path, Error> {
        #[cfg(feature = "audio-native")]
        {
            self.0
                .streams
                .play(&self.0, conn, &header, None, &event, "alert")
                .await
        }
        #[cfg(not(feature = "audio-native"))]
        {
            let _ = (event, header, conn);
            Err(Error::Unavailable("build without audio-native".into()))
        }
    }
    async fn play_volume_feedback(
        &self,
        output: Path,
        #[zbus(header)] header: zbus::message::Header<'_>,
        #[zbus(connection)] conn: &Connection,
    ) -> Result<Path, Error> {
        #[cfg(feature = "audio-native")]
        {
            self.0
                .streams
                .play(&self.0, conn, &header, Some(output), "volume", "feedback")
                .await
        }
        #[cfg(not(feature = "audio-native"))]
        {
            let _ = (output, header, conn);
            Err(Error::Unavailable("build without audio-native".into()))
        }
    }
}
#[derive(Clone)]
pub struct NodeObject {
    pub audio: Audio,
    pub key: String,
    initial: model::Node,
}
impl NodeObject {
    fn get(&self) -> model::Node {
        self.audio
            .graph
            .read()
            .unwrap()
            .nodes
            .get(&self.key)
            .cloned()
            .unwrap_or_else(|| self.initial.clone())
    }
}
#[zbus::interface(name = "org.nidara.AudioNode1")]
impl NodeObject {
    #[zbus(property)]
    fn kind(&self) -> String {
        self.get().kind
    }
    #[zbus(property)]
    fn serial(&self) -> u64 {
        self.get().serial
    }
    #[zbus(property)]
    fn name(&self) -> String {
        self.get().name
    }
    #[zbus(property)]
    fn description(&self) -> String {
        self.get().description
    }
    #[zbus(property)]
    fn media_name(&self) -> String {
        self.get().media_name
    }
    #[zbus(property)]
    fn application_id(&self) -> String {
        self.get().application_id
    }
    #[zbus(property)]
    fn application_name(&self) -> String {
        self.get().application_name
    }
    #[zbus(property)]
    fn icon_name(&self) -> String {
        self.get().icon_name
    }
    #[zbus(property)]
    fn device(&self) -> Path {
        path(&self.get().device)
    }
    #[zbus(property)]
    fn volume(&self) -> f64 {
        self.get().volume
    }
    #[zbus(property)]
    fn muted(&self) -> bool {
        self.get().muted
    }
    #[zbus(property)]
    fn channels(&self) -> Vec<(String, f64)> {
        self.get()
            .channels
            .into_iter()
            .map(|c| (c.position, c.volume))
            .collect()
    }
    #[zbus(property)]
    fn balance(&self) -> f64 {
        model::balance(&self.get().channels)
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<String> {
        self.get().capabilities
    }
    #[zbus(property)]
    fn state(&self) -> String {
        self.get().state
    }
    #[zbus(property)]
    fn targets(&self) -> Vec<Path> {
        self.get().targets.iter().map(|s| path(s)).collect()
    }
    #[zbus(property)]
    fn requested_target(&self) -> Path {
        path(&self.get().requested_target)
    }
    #[zbus(property)]
    fn capture_kind(&self) -> String {
        self.get().capture_kind
    }
    #[zbus(property)]
    fn routes(&self) -> Vec<Path> {
        self.get().routes.iter().map(|s| path(s)).collect()
    }
    #[zbus(property)]
    fn active_route(&self) -> Path {
        path(&self.get().active_route)
    }
}
#[derive(Clone)]
pub struct DeviceObject {
    audio: Audio,
    key: String,
    initial: model::Device,
}
impl DeviceObject {
    fn get(&self) -> model::Device {
        self.audio
            .graph
            .read()
            .unwrap()
            .devices
            .get(&self.key)
            .cloned()
            .unwrap_or_else(|| self.initial.clone())
    }
}
#[zbus::interface(name = "org.nidara.AudioDevice1")]
impl DeviceObject {
    #[zbus(property)]
    fn name(&self) -> String {
        self.get().name
    }
    #[zbus(property)]
    fn description(&self) -> String {
        self.get().description
    }
    #[zbus(property)]
    fn profiles(&self) -> Vec<Path> {
        self.get().profiles.iter().map(|s| path(s)).collect()
    }
    #[zbus(property)]
    fn active_profile(&self) -> Path {
        path(&self.get().active_profile)
    }
    #[zbus(property)]
    fn capabilities(&self) -> Vec<String> {
        self.get().capabilities
    }
}
#[derive(Clone)]
pub struct ProfileObject {
    audio: Audio,
    key: String,
    initial: model::Profile,
}
impl ProfileObject {
    fn get(&self) -> model::Profile {
        self.audio
            .graph
            .read()
            .unwrap()
            .profiles
            .get(&self.key)
            .cloned()
            .unwrap_or_else(|| self.initial.clone())
    }
}
#[zbus::interface(name = "org.nidara.AudioProfile1")]
impl ProfileObject {
    #[zbus(property)]
    fn index(&self) -> i32 {
        self.get().index
    }
    #[zbus(property)]
    fn name(&self) -> String {
        self.get().name
    }
    #[zbus(property)]
    fn description(&self) -> String {
        self.get().description
    }
    #[zbus(property)]
    fn availability(&self) -> String {
        self.get().availability
    }
    #[zbus(property)]
    fn priority(&self) -> i32 {
        self.get().priority
    }
}
#[derive(Clone)]
pub struct RouteObject {
    audio: Audio,
    key: String,
    initial: model::Route,
}
impl RouteObject {
    fn get(&self) -> model::Route {
        self.audio
            .graph
            .read()
            .unwrap()
            .routes
            .get(&self.key)
            .cloned()
            .unwrap_or_else(|| self.initial.clone())
    }
}
#[zbus::interface(name = "org.nidara.AudioRoute1")]
impl RouteObject {
    #[zbus(property)]
    fn index(&self) -> i32 {
        self.get().index
    }
    #[zbus(property)]
    fn device_index(&self) -> i32 {
        self.get().device_index
    }
    #[zbus(property)]
    fn direction(&self) -> String {
        self.get().direction
    }
    #[zbus(property)]
    fn name(&self) -> String {
        self.get().name
    }
    #[zbus(property)]
    fn description(&self) -> String {
        self.get().description
    }
    #[zbus(property)]
    fn availability(&self) -> String {
        self.get().availability
    }
    #[zbus(property)]
    fn profiles(&self) -> Vec<Path> {
        self.get().profiles.iter().map(|s| path(s)).collect()
    }
    #[zbus(property)]
    fn active(&self) -> bool {
        self.get().active
    }
}
// Maps are shared by change detection: no invalidation/getter round-trips on a drag.
pub type Props = std::collections::BTreeMap<&'static str, zbus::zvariant::OwnedValue>;
fn v<T: Into<zbus::zvariant::Value<'static>>>(value: T) -> zbus::zvariant::OwnedValue {
    value
        .into()
        .try_into()
        .expect("audio properties contain no file descriptors")
}
fn paths(values: &[String]) -> Vec<Path> {
    values.iter().map(|s| path(s)).collect()
}
fn root_caps(g: &Graph) -> Vec<String> {
    if !matches!(g.state.as_str(), "ready" | "degraded") {
        return vec![];
    }
    let mut capabilities = vec!["mixer".into()];
    if g.defaults_available {
        capabilities.push("defaults".into());
    }
    capabilities
}
fn root_props(g: &Graph, prefs: &Preferences) -> Props {
    [
        ("State", v(g.state.clone())),
        ("LastError", v(g.error.clone())),
        ("Generation", v(g.generation)),
        ("DefaultOutput", v(path(&g.default_output))),
        ("DefaultInput", v(path(&g.default_input))),
        ("VolumeLimit", v(prefs.limit())),
        (
            "Streams",
            v(g.nodes
                .values()
                .filter(|n| matches!(n.kind.as_str(), "playback" | "capture") && !n.internal)
                .map(|n| path(&n.path))
                .collect::<Vec<_>>()),
        ),
        (
            "RecordingStreams",
            v(g.nodes
                .values()
                .filter(|n| n.kind == "capture" && !n.internal)
                .map(|n| path(&n.path))
                .collect::<Vec<_>>()),
        ),
        (
            "InternalCapture",
            v(g.nodes
                .values()
                .filter(|n| n.kind == "capture" && n.internal)
                .map(|n| path(&n.path))
                .collect::<Vec<_>>()),
        ),
        ("Capabilities", v(root_caps(g))),
        (
            "DefaultSwitchMode",
            v(if g.switch_policy {
                "wireplumber-policy"
            } else {
                "unsupported"
            }
            .to_string()),
        ),
    ]
    .into()
}
fn node_props(n: &model::Node) -> Props {
    [
        ("Kind", v(n.kind.clone())),
        ("Serial", v(n.serial)),
        ("Name", v(n.name.clone())),
        ("Description", v(n.description.clone())),
        ("MediaName", v(n.media_name.clone())),
        ("ApplicationId", v(n.application_id.clone())),
        ("ApplicationName", v(n.application_name.clone())),
        ("IconName", v(n.icon_name.clone())),
        ("Device", v(path(&n.device))),
        ("Volume", v(n.volume)),
        ("Muted", v(n.muted)),
        (
            "Channels",
            v(n.channels
                .iter()
                .map(|c| (c.position.clone(), c.volume))
                .collect::<Vec<_>>()),
        ),
        ("Balance", v(model::balance(&n.channels))),
        ("Capabilities", v(n.capabilities.clone())),
        ("State", v(n.state.clone())),
        ("Targets", v(paths(&n.targets))),
        ("RequestedTarget", v(path(&n.requested_target))),
        ("CaptureKind", v(n.capture_kind.clone())),
        ("Routes", v(paths(&n.routes))),
        ("ActiveRoute", v(path(&n.active_route))),
    ]
    .into()
}
fn device_props(n: &model::Device) -> Props {
    [
        ("Name", v(n.name.clone())),
        ("Description", v(n.description.clone())),
        ("Profiles", v(paths(&n.profiles))),
        ("ActiveProfile", v(path(&n.active_profile))),
        ("Capabilities", v(n.capabilities.clone())),
    ]
    .into()
}
fn profile_props(n: &model::Profile) -> Props {
    [
        ("Index", v(n.index)),
        ("Name", v(n.name.clone())),
        ("Description", v(n.description.clone())),
        ("Availability", v(n.availability.clone())),
        ("Priority", v(n.priority)),
    ]
    .into()
}
fn route_props(n: &model::Route) -> Props {
    [
        ("Index", v(n.index)),
        ("DeviceIndex", v(n.device_index)),
        ("Direction", v(n.direction.clone())),
        ("Name", v(n.name.clone())),
        ("Description", v(n.description.clone())),
        ("Availability", v(n.availability.clone())),
        ("Profiles", v(paths(&n.profiles))),
        ("Active", v(n.active)),
    ]
    .into()
}
fn delta(old: &Props, new: &Props) -> Props {
    new.iter()
        .filter(|(k, v)| old.get(*k) != Some(*v))
        .map(|(k, v)| {
            (
                *k,
                v.try_clone()
                    .expect("audio values contain no file descriptors"),
            )
        })
        .collect()
}
async fn emit(c: &Connection, key: &str, iface: &str, changed: Props) -> zbus::Result<()> {
    if changed.is_empty() {
        return Ok(());
    }
    let e = SignalEmitter::new(c, key)?;
    zbus::fdo::Properties::properties_changed(
        &e,
        iface.try_into()?,
        changed.into_iter().map(|(k, v)| (k, v.into())).collect(),
        Vec::new().into(),
    )
    .await
}
pub async fn publish(c: &Connection, a: &Audio, old: &Graph, new: &Graph) -> zbus::Result<()> {
    // Install dependencies before publishing root references; clear references before removal.
    for k in new
        .profiles
        .keys()
        .filter(|k| !old.profiles.contains_key(*k))
    {
        c.object_server()
            .at(
                k.as_str(),
                ProfileObject {
                    audio: a.clone(),
                    key: k.clone(),
                    initial: new.profiles[k].clone(),
                },
            )
            .await?;
    }
    for k in new.devices.keys().filter(|k| !old.devices.contains_key(*k)) {
        c.object_server()
            .at(
                k.as_str(),
                DeviceObject {
                    audio: a.clone(),
                    key: k.clone(),
                    initial: new.devices[k].clone(),
                },
            )
            .await?;
    }
    for k in new.routes.keys().filter(|k| !old.routes.contains_key(*k)) {
        c.object_server()
            .at(
                k.as_str(),
                RouteObject {
                    audio: a.clone(),
                    key: k.clone(),
                    initial: new.routes[k].clone(),
                },
            )
            .await?;
    }
    for k in new.nodes.keys().filter(|k| !old.nodes.contains_key(*k)) {
        c.object_server()
            .at(
                k.as_str(),
                NodeObject {
                    audio: a.clone(),
                    key: k.clone(),
                    initial: new.nodes[k].clone(),
                },
            )
            .await?;
    }
    *a.graph.write().unwrap() = new.clone();
    let root_changed = {
        let mut previous = a.announced_root.lock().unwrap();
        let current = root_props(new, &a.prefs.read().unwrap());
        let changed = delta(&previous, &current);
        *previous = current;
        changed
    };
    emit(c, ROOT, "org.nidara.Audio1", root_changed).await?;
    for (k, n) in &new.nodes {
        if let Some(old) = old.nodes.get(k).filter(|old| *old != n) {
            emit(
                c,
                k,
                "org.nidara.AudioNode1",
                delta(&node_props(old), &node_props(n)),
            )
            .await?;
        }
    }
    for (k, n) in &new.devices {
        if let Some(old) = old.devices.get(k).filter(|old| *old != n) {
            emit(
                c,
                k,
                "org.nidara.AudioDevice1",
                delta(&device_props(old), &device_props(n)),
            )
            .await?;
        }
    }
    for (k, n) in &new.profiles {
        if let Some(old) = old.profiles.get(k).filter(|old| *old != n) {
            emit(
                c,
                k,
                "org.nidara.AudioProfile1",
                delta(&profile_props(old), &profile_props(n)),
            )
            .await?;
        }
    }
    for (k, n) in &new.routes {
        if let Some(old) = old.routes.get(k).filter(|old| *old != n) {
            emit(
                c,
                k,
                "org.nidara.AudioRoute1",
                delta(&route_props(old), &route_props(n)),
            )
            .await?;
        }
    }
    for k in old.nodes.keys().filter(|k| !new.nodes.contains_key(*k)) {
        c.object_server()
            .remove::<NodeObject, _>(k.as_str())
            .await?;
    }
    for k in old.routes.keys().filter(|k| !new.routes.contains_key(*k)) {
        c.object_server()
            .remove::<RouteObject, _>(k.as_str())
            .await?;
    }
    for k in old.devices.keys().filter(|k| !new.devices.contains_key(*k)) {
        c.object_server()
            .remove::<DeviceObject, _>(k.as_str())
            .await?;
    }
    for k in old
        .profiles
        .keys()
        .filter(|k| !new.profiles.contains_key(*k))
    {
        c.object_server()
            .remove::<ProfileObject, _>(k.as_str())
            .await?;
    }
    a.changed.notify_waiters();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn volume_drag_has_values_only_and_does_not_change_root_properties() {
        let key = format!("{ROOT}/g1/nodes/n1");
        let before = model::Node {
            path: key.clone(),
            kind: "output".into(),
            volume: 0.4,
            device: "/".into(),
            requested_target: "/".into(),
            active_route: "/".into(),
            channels: vec![
                model::Channel {
                    position: "FL".into(),
                    volume: 0.2,
                },
                model::Channel {
                    position: "FR".into(),
                    volume: 0.4,
                },
            ],
            ..Default::default()
        };
        let mut after = before.clone();
        after.volume = 0.8;
        after.channels[0].volume = 0.4;
        after.channels[1].volume = 0.8;
        let changed = delta(&node_props(&before), &node_props(&after));
        assert_eq!(
            changed.keys().copied().collect::<Vec<_>>(),
            vec!["Channels", "Volume"]
        );
        assert_eq!(f64::try_from(&changed["Volume"]).unwrap(), 0.8);
        let mut old = Graph {
            state: "degraded".into(),
            defaults_available: true,
            default_output: key.clone(),
            ..Default::default()
        };
        old.nodes.insert(key.clone(), before);
        let mut new = old.clone();
        new.nodes.insert(key, after);
        let prefs = Preferences::default();
        assert!(delta(&root_props(&old, &prefs), &root_props(&new, &prefs)).is_empty());
        assert_eq!(root_caps(&old), vec!["mixer", "defaults"]);
        let no_defaults = Graph {
            defaults_available: false,
            ..old.clone()
        };
        assert_eq!(root_caps(&no_defaults), vec!["mixer"]);
        let boosted = Preferences {
            overamplification: true,
            ..Default::default()
        };
        assert_eq!(
            delta(&root_props(&new, &prefs), &root_props(&new, &boosted))
                .keys()
                .copied()
                .collect::<Vec<_>>(),
            vec!["VolumeLimit"]
        );
    }
}
