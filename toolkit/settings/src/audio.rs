// SPDX-License-Identifier: LGPL-3.0-or-later
//! Sound on AppWindow, with one Audio1 subscription for the lifetime of the page.

use crate::exports::Exports;
use nk::{Activated, Node, SliderEnd, SliderRange, Space, Type, TypeScale, Value, Weight};
use nk_platform::audio::{self, Command, Snapshot};
use std::{
    collections::VecDeque,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
    time::Duration,
};
use zbus::blocking::{Connection, connection::Builder};

pub const PAGE: &str = "audio";
const PREFIX: &str = "audio:";

#[derive(Default)]
pub struct Audio {
    client: Option<Client>,
    graph: Option<Snapshot>,
    unavailable: bool,
    write_error: bool,
}

struct Client {
    connection: Connection,
    stopped: Arc<AtomicBool>,
    commands: Arc<Mutex<VecDeque<Write>>>,
    wake_writer: SyncSender<()>,
    updates: Receiver<Option<Snapshot>>,
    errors: Receiver<bool>,
}

struct Write {
    owner: String,
    path: String,
    command: Command,
    intermediate: bool,
}

impl Write {
    fn same_slider(&self, other: &Self) -> bool {
        self.owner == other.owner
            && self.path == other.path
            && matches!(
                (&self.command, &other.command),
                (Command::Volume(_), Command::Volume(_))
                    | (Command::Balance(_), Command::Balance(_))
            )
    }
}

impl Client {
    fn connect() -> Result<Self, String> {
        let connection = Builder::session()
            .and_then(|builder| builder.method_timeout(Duration::from_secs(18)).build())
            .map_err(|error| error.to_string())?;
        let stopped = Arc::new(AtomicBool::new(false));
        let (updates_tx, updates) = mpsc::channel();
        let read = connection.clone();
        let reading_stopped = stopped.clone();
        std::thread::spawn(move || {
            if let Err(error) = audio::watch(&read, |snapshot| updates_tx.send(snapshot).is_ok())
                && !reading_stopped.load(Ordering::Acquire)
            {
                let _ = updates_tx.send(None);
                eprintln!("nidara-settings-view: audio subscription ended: {error}");
            }
        });

        let commands = Arc::new(Mutex::new(VecDeque::<Write>::new()));
        let pending = commands.clone();
        let (wake_writer, ready) = mpsc::sync_channel(1);
        let (errors_tx, errors) = mpsc::channel();
        let writing_stopped = stopped.clone();
        let write = connection.clone();
        std::thread::spawn(move || {
            while ready.recv().is_ok() {
                while !writing_stopped.load(Ordering::Acquire) {
                    let intent = pending.lock().unwrap().pop_front();
                    let Some(intent) = intent else { break };
                    let result = intent.command.send(&write, &intent.owner, &intent.path);
                    if let Err(error) = &result {
                        eprintln!("nidara-settings-view: audio change failed: {error}");
                    }
                    if errors_tx.send(result.is_err()).is_err() {
                        return;
                    }
                }
            }
        });
        Ok(Self {
            connection,
            stopped,
            commands,
            wake_writer,
            updates,
            errors,
        })
    }

    fn enqueue(&self, intent: Write) -> bool {
        let mut pending = self.commands.lock().unwrap();
        // A queued motion can be replaced. Release and keyboard events must survive
        // even when the service is still confirming a write from an earlier gesture.
        if matches!(intent.command, Command::Volume(_) | Command::Balance(_)) {
            pending.retain(|queued| !queued.intermediate || !queued.same_slider(&intent));
        }
        pending.push_back(intent);
        !matches!(
            self.wake_writer.try_send(()),
            Err(TrySendError::Disconnected(()))
        )
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        let _ = self.connection.clone().close();
    }
}

impl Audio {
    pub fn visit(&mut self) {
        match Client::connect() {
            Ok(client) => self.client = Some(client),
            Err(error) => {
                eprintln!("nidara-settings-view: cannot watch audio: {error}");
                self.unavailable = true;
            }
        }
    }

    pub fn poll(&mut self) -> bool {
        let Some(client) = &self.client else {
            return false;
        };
        let mut changed = false;
        if let Some(graph) = client.updates.try_iter().last() {
            self.unavailable = graph.as_ref().is_none_or(|graph| !graph.available);
            self.graph = graph;
            changed = true;
        }
        if let Some(error) = client.errors.try_iter().last() {
            self.write_error = error;
            changed = true;
        }
        changed
    }

    pub fn activate(&mut self, activated: &Activated, dragging: bool) -> bool {
        let Some(action) = activated.action.strip_prefix(PREFIX) else {
            return false;
        };
        let Some(client) = &self.client else {
            return true;
        };
        let Some(graph) = self.graph.as_ref().filter(|graph| graph.available) else {
            return true;
        };
        let Some((path, command)) = write_for(graph, action, activated) else {
            return true;
        };
        if !client.enqueue(Write {
            owner: graph.owner.clone(),
            path,
            intermediate: dragging && matches!(command, Command::Volume(_) | Command::Balance(_)),
            command,
        }) {
            self.write_error = true;
        }
        true
    }

    pub fn rows(&self, types: &TypeScale, exports: &Exports) -> Result<Vec<Node>, String> {
        let body = || types.style(Type::Body, Weight::Regular);
        let status = |key| -> Result<Node, String> {
            Ok(nk::Label::new(format!("audio/status/{key}"), exports.text(key)?, body()).into())
        };
        let Some(graph) = self.graph.as_ref().filter(|graph| graph.available) else {
            return Ok(vec![status(if self.unavailable {
                "settings.audio.error.no-service"
            } else {
                "settings.native.loading"
            })?]);
        };

        let mut rows = Vec::new();
        if self.write_error {
            rows.push(status("settings.audio.error.change")?);
        }
        if !graph
            .nodes
            .iter()
            .any(|node| matches!(node.kind.as_str(), "input" | "output"))
        {
            rows.push(status("settings.audio.error.no-hardware")?);
        }
        for (kind, title, default, icon) in [
            (
                "output",
                "settings.audio.group.output",
                graph.default_output.as_str(),
                "nd-audio-speakers",
            ),
            (
                "input",
                "settings.audio.group.input",
                graph.default_input.as_str(),
                "nd-audio-input-microphone",
            ),
            (
                "playback",
                "settings.audio.group.apps",
                "",
                "nd-audio-volume-high",
            ),
        ] {
            let nodes = graph
                .nodes
                .iter()
                .filter(|node| node.kind == kind)
                .map(|node| node_rows(graph, node, default, icon, types, exports))
                .collect::<Result<Vec<_>, String>>()?;
            if !nodes.is_empty() {
                rows.push(
                    nk::Label::new(
                        format!("audio/group/{kind}"),
                        exports.text(title)?,
                        types.style(Type::Body, Weight::Medium),
                    )
                    .into(),
                );
                rows.push(
                    nk::Group::new(
                        format!("audio/{kind}"),
                        nk::Column::new(format!("audio/{kind}/rows"), nodes),
                    )
                    .into(),
                );
            }
        }
        let profiles = graph
            .devices
            .iter()
            .filter_map(|(path, device)| {
                let choices = choices(graph, "profile", path)?;
                Some(choice_row(
                    graph,
                    &choices,
                    &device.name,
                    &device.name,
                    types,
                    exports,
                ))
            })
            .collect::<Result<Vec<_>, String>>()?;
        if !profiles.is_empty() {
            rows.push(
                nk::Label::new(
                    "audio/profiles/title",
                    exports.text("settings.audio.profiles")?,
                    types.style(Type::Body, Weight::Medium),
                )
                .into(),
            );
            rows.push(
                nk::Group::new(
                    "audio/profiles",
                    nk::Column::new("audio/profiles/rows", profiles),
                )
                .into(),
            );
        }
        Ok(rows)
    }
}

fn identity(graph: &Snapshot, path: &str) -> String {
    format!("{}:{}:{path}", graph.owner, graph.generation)
}

fn write_for(graph: &Snapshot, action: &str, activated: &Activated) -> Option<(String, Command)> {
    let (operation, target) = action.split_once(':')?;
    let prefix = format!("{}:{}:", graph.owner, graph.generation);
    let path = target.strip_prefix(&prefix)?;
    if let ("profile" | "route" | "destination", Some(Value::Index(index))) =
        (operation, &activated.value)
    {
        let candidates = choices(graph, operation, path)?;
        if activated.key.0 != candidates.key(graph) || *index == candidates.chosen {
            return None;
        }
        let selected = candidates.options.get(*index)?.path?;
        return Some(match operation {
            "profile" => (selected.into(), Command::Profile),
            "route" => (path.into(), Command::Route(selected.into())),
            _ if selected == "/" => (path.into(), Command::FollowDefault),
            _ => (path.into(), Command::MovePlayback(selected.into())),
        });
    }
    let node = graph.nodes.iter().find(|node| node.path == path)?;
    let command = match (operation, &activated.value) {
        ("volume", Some(Value::Number(value))) if value.is_finite() && node.supports("volume") => {
            Command::Volume((value / 100.).clamp(0., node.volume_limit))
        }
        ("balance", Some(Value::Number(value)))
            if value.is_finite()
                && node.kind == "output"
                && node.supports("balance")
                && node.balance.is_some() =>
        {
            Command::Balance((value / 100.).clamp(-1., 1.))
        }
        ("mute", Some(Value::Bool(value))) if node.supports("mute") => Command::Muted(*value),
        ("default", _)
            if graph.can_set_default && matches!(node.kind.as_str(), "input" | "output") =>
        {
            Command::Default
        }
        _ => return None,
    };
    Some((path.into(), command))
}

struct Choice<'a> {
    path: Option<&'a str>,
    /// Hardware and application names come from Audio1, built-in labels from Exports.
    label: &'a str,
}

struct Choices<'a> {
    operation: &'a str,
    source: &'a str,
    label: &'static str,
    options: Vec<Choice<'a>>,
    chosen: usize,
}

impl Choices<'_> {
    fn key(&self, graph: &Snapshot) -> String {
        let options = self
            .options
            .iter()
            .map(|option| option.path.unwrap_or(""))
            .collect::<Vec<_>>()
            .join(",");
        format!(
            "audio/{}/{}/{options}",
            identity(graph, self.source),
            self.operation
        )
    }
}

fn choices<'a>(graph: &'a Snapshot, operation: &'a str, source: &'a str) -> Option<Choices<'a>> {
    let hardware_options = |paths: &'a [String],
                            records: &'a std::collections::BTreeMap<String, audio::Choice>,
                            current: &str| {
        paths
            .iter()
            .filter_map(|path| {
                let record = records.get(path)?;
                (record.available || path == current).then_some(Choice {
                    path: Some(path.as_str()),
                    label: &record.name,
                })
            })
            .collect::<Vec<_>>()
    };
    let (label, current, mut options) = if operation == "profile" {
        let device = graph.devices.get(source)?;
        (
            "settings.audio.profile",
            device.active_profile.as_str(),
            hardware_options(&device.profiles, &graph.profiles, &device.active_profile),
        )
    } else {
        let node = graph.nodes.iter().find(|node| node.path == source)?;
        match operation {
            "route" if node.supports("routes") => (
                "settings.audio.port",
                node.active_route.as_str(),
                hardware_options(&node.routes, &graph.routes, &node.active_route),
            ),
            "destination" if node.kind == "playback" && node.supports("move") => {
                let mut options = vec![Choice {
                    path: Some("/"),
                    label: "settings.audio.follow-default",
                }];
                options.extend(graph.nodes.iter().filter(|node| node.kind == "output").map(
                    |node| Choice {
                        path: Some(node.path.as_str()),
                        label: &node.name,
                    },
                ));
                (
                    "settings.audio.destination",
                    node.requested_target.as_str(),
                    options,
                )
            }
            _ => return None,
        }
    };
    if options.is_empty() {
        return None;
    }
    let chosen = options
        .iter()
        .position(|option| option.path == Some(current))
        .unwrap_or_else(|| {
            options.insert(
                0,
                Choice {
                    path: None,
                    label: "settings.audio.choice-unavailable",
                },
            );
            0
        });
    Some(Choices {
        operation,
        source,
        label,
        options,
        chosen,
    })
}

fn choice_row(
    graph: &Snapshot,
    choices: &Choices<'_>,
    title: &str,
    context: &str,
    types: &TypeScale,
    exports: &Exports,
) -> Result<Node, String> {
    let label = exports.text(choices.label)?;
    let style = types.style(Type::Body, Weight::Regular);
    let key = choices.key(graph);
    let labels = choices
        .options
        .iter()
        .map(|option| {
            if matches!(option.path, None | Some("/")) {
                exports.text(option.label).map(str::to_owned)
            } else {
                Ok(option.label.into())
            }
        })
        .collect::<Result<Vec<_>, String>>()?;
    Ok(nk::ListRow::new(format!("{key}/row"), title, style)
        .trailing(
            nk::DropDown::new(
                key,
                format!("{label} · {context}"),
                format!(
                    "{PREFIX}{}:{}",
                    choices.operation,
                    identity(graph, choices.source)
                ),
                labels,
                choices.chosen,
            )
            .enabled(choices.options.len() > 1),
        )
        .into())
}

fn node_rows(
    graph: &Snapshot,
    node: &audio::Node,
    default: &str,
    icon: &str,
    types: &TypeScale,
    exports: &Exports,
) -> Result<Node, String> {
    let id = identity(graph, &node.path);
    let key = format!("audio/{id}");
    let body = || types.style(Type::Body, Weight::Regular);
    let image = if node.kind == "playback" && !node.icon.is_empty() {
        nk::Image::new(format!("{key}/icon"), &node.icon, 24.).app_theme(icon)
    } else {
        nk::Image::new(format!("{key}/icon"), icon, 18.)
    };
    let mut heading = nk::ListRow::new(format!("{key}/name"), &node.name, body()).leading(image);
    let mut controls: Vec<Node> = Vec::new();
    if node.path == default {
        heading = heading.subtitle(
            exports.text("settings.audio.default")?,
            types.style(Type::Small, Weight::Regular),
        );
    } else if graph.can_set_default && !default.is_empty() {
        controls.push(
            nk::Button::new(
                format!("{key}/default"),
                exports.text("settings.audio.btn.set-default")?,
                format!("{PREFIX}default:{id}"),
                body(),
            )
            .description(&node.name)
            .into(),
        );
    }
    if node.supports("mute") {
        controls.push(
            nk::Switch::new(
                format!("{key}/mute"),
                exports.text("cc.detail.mute")?,
                format!("{PREFIX}mute:{id}"),
                node.muted,
            )
            .description(&node.name)
            .into(),
        );
    }
    if !controls.is_empty() {
        heading =
            heading.trailing(nk::Row::new(format!("{key}/controls"), controls).gap(Space::S2));
    }
    let mut rows = vec![heading.into()];
    if node.supports("volume") && node.volume_limit > 0. {
        let volume = exports.text("cc.volume.name")?;
        let range = SliderRange::new(
            0.,
            node.volume_limit.max(node.volume) * 100.,
            1.,
            node.volume * 100.,
        );
        let range = range.unit("%").live();
        rows.push(
            nk::ListRow::new(format!("{key}/volume-row"), volume, body())
                .trailing(
                    SliderEnd::new(
                        format!("{key}/volume"),
                        format!("{volume} · {}", node.name),
                        format!("{PREFIX}volume:{id}"),
                        range,
                        body(),
                    )
                    .icons(["nd-audio-volume-low".into(), "nd-audio-volume-high".into()]),
                )
                .into(),
        );
    }
    if let Some(balance) = node
        .balance
        .filter(|_| node.kind == "output" && node.supports("balance"))
    {
        let label = exports.text("settings.audio.balance")?;
        let range = SliderRange::new(-100., 100., 1., balance * 100.).live();
        let direction = exports.text("settings.audio.balance-direction")?;
        rows.push(
            nk::ListRow::new(format!("{key}/balance-row"), label, body())
                .subtitle(direction, types.style(Type::Small, Weight::Regular))
                .trailing(SliderEnd::new(
                    format!("{key}/balance"),
                    format!("{label} · {} · {direction}", node.name),
                    format!("{PREFIX}balance:{id}"),
                    range,
                    body(),
                ))
                .into(),
        );
    }
    for operation in ["route", "destination"] {
        if let Some(choices) = choices(graph, operation, &node.path) {
            rows.push(choice_row(
                graph,
                &choices,
                exports.text(choices.label)?,
                &node.name,
                types,
                exports,
            )?);
        }
    }
    Ok(nk::Column::new(key, rows).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(path: &str, name: &str, kind: &str, capabilities: &[&str]) -> audio::Node {
        audio::Node {
            path: path.into(),
            owner: ":1.5".into(),
            name: name.into(),
            kind: kind.into(),
            icon: String::new(),
            volume_limit: 1.,
            volume: 0.5,
            muted: false,
            balance: None,
            routes: vec![],
            active_route: "/".into(),
            requested_target: "/".into(),
            capabilities: capabilities.iter().map(|cap| (*cap).into()).collect(),
        }
    }

    fn choice(graph: &Snapshot, operation: &str, path: &str, index: usize) -> Activated {
        let menu = choices(graph, operation, path).unwrap();
        Activated {
            key: menu.key(graph).into(),
            action: format!("{operation}:{}", identity(graph, path)),
            value: Some(Value::Index(index)),
        }
    }

    #[test]
    fn audio_choices_send_object_paths_and_a_stale_choice_cannot_move_a_stream() {
        let mut graph = Snapshot {
            owner: ":1.5".into(),
            generation: 7,
            available: true,
            nodes: vec![
                node("/one", "Speakers", "output", &["routes", "balance"]),
                node("/two", "Headphones", "output", &[]),
                node("/stream", "Player", "playback", &["move"]),
            ],
            ..Snapshot::default()
        };
        graph.nodes[0].routes = vec!["/unavailable".into(), "/port".into()];
        graph.nodes[0].balance = Some(0.);
        graph.routes.extend([
            (
                "/unavailable".into(),
                audio::Choice {
                    name: "Disconnected".into(),
                    available: false,
                },
            ),
            (
                "/port".into(),
                audio::Choice {
                    name: "Connected".into(),
                    available: true,
                },
            ),
        ]);
        graph.profiles.insert(
            "/profile".into(),
            audio::Choice {
                name: "Stereo".into(),
                available: true,
            },
        );
        graph.devices.insert(
            "/device".into(),
            audio::Device {
                name: "Integrated audio".into(),
                profiles: vec!["/profile".into()],
                active_profile: "/".into(),
            },
        );

        let select_profile = choice(&graph, "profile", "/device", 1);
        assert_eq!(
            write_for(&graph, &select_profile.action, &select_profile),
            Some(("/profile".into(), Command::Profile))
        );
        let select_port = choice(&graph, "route", "/one", 1);
        assert_eq!(
            write_for(&graph, &select_port.action, &select_port),
            Some(("/one".into(), Command::Route("/port".into())))
        );
        let balance = Activated {
            key: "balance".into(),
            action: format!("balance:{}", identity(&graph, "/one")),
            value: Some(Value::Number(-40.)),
        };
        assert_eq!(
            write_for(&graph, &balance.action, &balance),
            Some(("/one".into(), Command::Balance(-0.4)))
        );

        let move_stream = choice(&graph, "destination", "/stream", 1);
        assert_eq!(
            write_for(&graph, &move_stream.action, &move_stream),
            Some(("/stream".into(), Command::MovePlayback("/one".into())))
        );
        graph.nodes.swap(0, 1);
        assert!(write_for(&graph, &move_stream.action, &move_stream).is_none());

        graph.nodes[2].requested_target = "/one".into();
        let follow = choice(&graph, "destination", "/stream", 0);
        assert_eq!(
            write_for(&graph, &follow.action, &follow),
            Some(("/stream".into(), Command::FollowDefault))
        );
    }
}
