// SPDX-License-Identifier: LGPL-3.0-or-later
//! Sound on AppWindow, with one Audio1 subscription for the lifetime of the page.

use crate::exports::Exports;
use nk::{Activated, Node, SliderEnd, SliderRange, Space, Type, TypeScale, Value, Weight};
use nk_platform::audio::{self, Command, Snapshot};
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, SyncSender},
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
    commands: SyncSender<Write>,
    updates: Receiver<Option<Snapshot>>,
    errors: Receiver<bool>,
}

struct Write {
    owner: String,
    path: String,
    command: Command,
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

        let (commands, command_rx) = mpsc::sync_channel::<Write>(16);
        let (errors_tx, errors) = mpsc::channel();
        let writing_stopped = stopped.clone();
        let write = connection.clone();
        std::thread::spawn(move || {
            while let Ok(intent) = command_rx.recv() {
                if writing_stopped.load(Ordering::Acquire) {
                    break;
                }
                let result = intent.command.send(&write, &intent.owner, &intent.path);
                if let Err(error) = &result {
                    eprintln!("nidara-settings-view: audio change failed: {error}");
                }
                if errors_tx.send(result.is_err()).is_err() {
                    break;
                }
            }
        });
        Ok(Self {
            connection,
            stopped,
            commands,
            updates,
            errors,
        })
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
        let Some((operation, target)) = action.split_once(':') else {
            return true;
        };
        let Some(node) = graph
            .nodes
            .iter()
            .find(|node| target == identity(graph, node))
        else {
            return true;
        };
        let command = match (operation, &activated.value) {
            ("volume", Some(Value::Number(value))) if !dragging && node.supports("volume") => {
                Command::Volume((value / 100.).clamp(0., node.volume_limit))
            }
            ("mute", Some(Value::Bool(value))) if node.supports("mute") => Command::Muted(*value),
            ("default", _)
                if graph.can_set_default && matches!(node.kind.as_str(), "input" | "output") =>
            {
                Command::Default
            }
            _ => return true,
        };
        if client
            .commands
            .try_send(Write {
                owner: graph.owner.clone(),
                path: node.path.clone(),
                command,
            })
            .is_err()
        {
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
        Ok(rows)
    }
}

fn identity(graph: &Snapshot, node: &audio::Node) -> String {
    format!("{}:{}:{}", graph.owner, graph.generation, node.path)
}

fn node_rows(
    graph: &Snapshot,
    node: &audio::Node,
    default: &str,
    icon: &str,
    types: &TypeScale,
    exports: &Exports,
) -> Result<Node, String> {
    let id = identity(graph, node);
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
        let mut range = range;
        range.unit = "%".into();
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
    Ok(nk::Column::new(key, rows).into())
}
