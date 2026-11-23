// SPDX-License-Identifier: LGPL-3.0-or-later
//! Settings → About on `AppWindow` (#1103 step 8a), the detail half of the About pair: the
//! desktop's version and whether a newer release exists, the machine and the system on it, and
//! the compositor it runs on. Read-only; every fact comes from `system_info`.
//!
//! The quick facts are read on the first visit. The slow ones (graphics, the compositor's
//! version) come from a worker. The update check is asked on every visit until it answers,
//! then never again: Settings is often opened right after login, before the network is up.
//! It stays quiet when it cannot be asked.
use crate::{exports::Exports, system_info};
use nk::{Ink, Node, Type, TypeScale, Weight};
use std::sync::mpsc::{Receiver, Sender, TryRecvError, channel};

/// What a worker brings back.
enum Answer {
    Graphics(String),
    Compositor(String),
    /// The latest release's tag; None when it could not be asked.
    Release(Option<String>),
}

struct Facts {
    version: String,
    device: String,
    os: String,
    cpu: String,
    ram: String,
    kernel: String,
}

#[derive(Default)]
pub struct About {
    facts: Option<Facts>,
    /// None while the worker has not answered.
    graphics: Option<String>,
    compositor: Option<String>,
    /// The latest release's tag, once asked successfully.
    release: Option<String>,
    checking: bool,
    answers: Option<(Sender<Answer>, Receiver<Answer>)>,
}

impl About {
    /// The page is shown: read what is not read yet, and ask again for the release while it
    /// has not answered.
    pub fn visit(&mut self) {
        let (tx, _) = self.answers.get_or_insert_with(channel);
        let tx = tx.clone();
        if self.facts.is_none() {
            self.facts = Some(Facts {
                version: system_info::desktop_version(),
                device: system_info::device_name(),
                os: system_info::os_name(),
                cpu: system_info::cpu_model(),
                ram: system_info::total_ram(),
                kernel: system_info::kernel(),
            });
            let tx = tx.clone();
            let _ = std::thread::Builder::new()
                .name("about-facts".into())
                .spawn(move || {
                    let _ = tx.send(Answer::Graphics(system_info::graphics()));
                    let _ = tx.send(Answer::Compositor(system_info::compositor_version()));
                });
        }
        if self.release.is_none() && !self.checking {
            self.checking = true;
            let _ = std::thread::Builder::new()
                .name("about-release".into())
                .spawn(move || {
                    let _ = tx.send(Answer::Release(system_info::latest_release()));
                });
        }
    }

    /// Takes what the workers brought; true when the page changed.
    pub fn poll(&mut self) -> bool {
        let Some((_, rx)) = &self.answers else {
            return false;
        };
        let mut changed = false;
        loop {
            match rx.try_recv() {
                Ok(Answer::Graphics(g)) => self.graphics = Some(g),
                Ok(Answer::Compositor(c)) => self.compositor = Some(c),
                Ok(Answer::Release(r)) => {
                    self.checking = false;
                    self.release = r;
                }
                Err(TryRecvError::Empty | TryRecvError::Disconnected) => return changed,
            }
            changed = true;
        }
    }

    /// Whether a worker has yet to answer (the window looks again soon).
    pub fn waiting(&self) -> bool {
        self.facts.is_some() && (self.graphics.is_none() || self.compositor.is_none())
            || self.checking
    }

    /// The page's groups.
    pub fn content(&self, e: &Exports, types: &TypeScale) -> Result<Vec<Node>, String> {
        let Some(f) = &self.facts else {
            return Ok(vec![]);
        };
        let unavailable = e.text("settings.about.unavailable")?;
        let shown = |v: &str| {
            if v.is_empty() {
                unavailable.to_owned()
            } else {
                v.to_owned()
            }
        };
        let later = |v: &Option<String>| v.as_deref().map_or_else(|| "…".to_owned(), shown);
        let row = |id: &str, title: &str, subtitle: &str, value: String| -> Node {
            nk::ListRow::new(
                format!("about/{id}"),
                title,
                types.style(Type::Body, Weight::Regular),
            )
            .subtitle(subtitle, types.style(Type::Small, Weight::Regular))
            .trailing(
                nk::Label::new(
                    format!("about/{id}/value"),
                    value,
                    types.style(Type::Body, Weight::Regular),
                )
                .ink(Ink::Secondary),
            )
            .into()
        };
        let t = |k: &str| e.text(k);

        let mut nidara = vec![row(
            "version",
            t("settings.about.version")?,
            "Nidara Desktop",
            shown(&f.version),
        )];
        if let Some(tag) = &self.release {
            let newer = system_info::is_newer(tag, &f.version);
            nidara.push(row(
                "update",
                t("settings.about.update")?,
                t(if newer {
                    "settings.about.update.available.desc"
                } else {
                    "settings.about.update.up-to-date"
                })?,
                if newer { tag.clone() } else { String::new() },
            ));
        }
        let system = vec![
            row(
                "device",
                t("settings.about.device")?,
                t("settings.about.device.desc")?,
                shown(&f.device),
            ),
            row(
                "os",
                t("settings.about.os")?,
                t("settings.about.os.desc")?,
                shown(&f.os),
            ),
            row(
                "cpu",
                t("settings.about.cpu")?,
                t("settings.about.cpu.desc")?,
                shown(&f.cpu),
            ),
            row(
                "ram",
                t("settings.about.ram")?,
                t("settings.about.ram.desc")?,
                shown(&f.ram),
            ),
            row(
                "graphics",
                t("settings.about.graphics")?,
                t("settings.about.graphics.desc")?,
                later(&self.graphics),
            ),
            row(
                "kernel",
                t("settings.about.kernel")?,
                t("settings.about.kernel.desc")?,
                shown(&f.kernel),
            ),
            // The one value that is wrong the moment after it is read: re-read each build.
            row(
                "uptime",
                t("settings.about.uptime")?,
                t("settings.about.uptime.desc")?,
                shown(&system_info::uptime_seconds().map_or(Ok(String::new()), |s| uptime(e, s))?),
            ),
        ];
        // "Hyalo" is a proper name; its description is translated.
        let environment = vec![row(
            "compositor",
            "Hyalo",
            t("settings.about.hyprland.desc")?,
            later(&self.compositor),
        )];

        let mut nodes = vec![];
        for (id, title, rows) in [
            ("nidara", "settings.about.group.nidara", nidara),
            ("system", "settings.about.group.system", system),
            (
                "environment",
                "settings.about.group.environment",
                environment,
            ),
        ] {
            nodes.push(
                nk::Label::new(
                    format!("about/{id}/title"),
                    t(title)?,
                    types.style(Type::Body, Weight::Medium),
                )
                .into(),
            );
            nodes.push(
                nk::Group::new(
                    format!("about/{id}/group"),
                    nk::Column::new(format!("about/{id}/rows"), rows),
                )
                .into(),
            );
        }
        Ok(nodes)
    }
}

/// Time since boot in the session's language, at most two units, largest first: "3 days and
/// 8 hours", "8 hours and 3 minutes", "22 minutes".
pub fn uptime(e: &Exports, secs: u64) -> Result<String, String> {
    let (days, hours, minutes) = (secs / 86400, secs % 86400 / 3600, secs % 3600 / 60);
    let unit = |key: &str, n: u64| e.count(&format!("settings.about.uptime.{key}"), n);
    let pair = |a: String, b: String| -> Result<String, String> {
        Ok(e.text("settings.about.uptime.pair")?
            .replace("{0}", &a)
            .replace("{1}", &b))
    };
    if days > 0 {
        pair(unit("day", days)?, unit("hour", hours)?)
    } else if hours > 0 {
        pair(unit("hour", hours)?, unit("minute", minutes)?)
    } else {
        unit("minute", minutes)
    }
}
