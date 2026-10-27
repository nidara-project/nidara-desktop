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
        if self.0.snapshot().state == "ready" {
            vec!["mixer".into(), "defaults".into()]
        } else {
            vec![]
        }
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
// All properties are invalidated together on a changed record; clients re-read. This also
// covers capability loss and avoids a second, drifting table of hand-written deltas.
async fn invalidate(c: &Connection, key: &str, iface: &str, names: &[&str]) -> zbus::Result<()> {
    let e = SignalEmitter::new(c, key)?;
    zbus::fdo::Properties::properties_changed(
        &e,
        iface.try_into()?,
        std::collections::HashMap::new(),
        names.into(),
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
    invalidate(
        c,
        ROOT,
        "org.nidara.Audio1",
        &[
            "State",
            "LastError",
            "Generation",
            "DefaultOutput",
            "DefaultInput",
            "VolumeLimit",
            "RecordingStreams",
            "InternalCapture",
            "Streams",
            "Capabilities",
            "DefaultSwitchMode",
        ],
    )
    .await?;
    for (k, n) in &new.nodes {
        if old.nodes.get(k).is_some_and(|o| o != n) {
            invalidate(
                c,
                k,
                "org.nidara.AudioNode1",
                &[
                    "Name",
                    "Description",
                    "MediaName",
                    "ApplicationId",
                    "ApplicationName",
                    "IconName",
                    "Device",
                    "Volume",
                    "Muted",
                    "Channels",
                    "Balance",
                    "Capabilities",
                    "State",
                    "Targets",
                    "RequestedTarget",
                    "CaptureKind",
                    "Routes",
                    "ActiveRoute",
                ],
            )
            .await?;
        }
    }
    for (k, n) in &new.devices {
        if old.devices.get(k).is_some_and(|o| o != n) {
            invalidate(
                c,
                k,
                "org.nidara.AudioDevice1",
                &[
                    "Name",
                    "Description",
                    "Profiles",
                    "ActiveProfile",
                    "Capabilities",
                ],
            )
            .await?;
        }
    }
    for (k, n) in &new.profiles {
        if old.profiles.get(k).is_some_and(|o| o != n) {
            invalidate(
                c,
                k,
                "org.nidara.AudioProfile1",
                &["Name", "Description", "Availability", "Priority"],
            )
            .await?;
        }
    }
    for (k, n) in &new.routes {
        if old.routes.get(k).is_some_and(|o| o != n) {
            invalidate(
                c,
                k,
                "org.nidara.AudioRoute1",
                &["Name", "Description", "Availability", "Profiles", "Active"],
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
