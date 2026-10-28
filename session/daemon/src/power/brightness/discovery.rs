// SPDX-License-Identifier: GPL-3.0-or-later
//! Exact GPU port + EDID, plus the explicitly bounded firmware/platform fallback.
use super::{Error, hardware};
use std::{
    fs,
    path::{Path, PathBuf},
};
#[derive(Clone)]
pub struct Paths {
    pub sys: PathBuf,
    pub dev: PathBuf,
    pub ddcutil: PathBuf,
}
impl Default for Paths {
    fn default() -> Self {
        Self {
            sys: "/sys".into(),
            dev: "/dev".into(),
            ddcutil: "/usr/bin/ddcutil".into(),
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Channel {
    Panel {
        path: PathBuf,
        name: String,
        max: u32,
    },
    Ddc {
        bus: u32,
        node: PathBuf,
    },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Link {
    pub output: hardware::Output,
    pub connector: PathBuf,
    pub channel: Channel,
    /// Present only for the globally unique firmware/platform association. Recheck
    /// the candidate set before/after I/O, not just at initial discovery.
    pub platform_backlights: Option<PathBuf>,
}
pub fn edid_key(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let h = bytes.iter().fold(0xcbf29ce484222325u64, |h, b| {
        (h ^ *b as u64).wrapping_mul(0x100000001b3)
    });
    format!("edid-{}-{h:016x}", bytes.len())
}
pub fn number(path: &Path) -> Result<u32, Error> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .ok_or_else(|| Error::Unavailable("backlight value unavailable".into()))
}
fn connector(paths: &Paths, output: &hardware::Output) -> Option<PathBuf> {
    let (gpu, name) = output.port.rsplit_once(':')?;
    if name != output.connector || output.edid.is_empty() {
        return None;
    }
    let mut matches = Vec::new();
    for entry in fs::read_dir(paths.sys.join("class/drm")).ok()?.flatten() {
        let suffix = format!("-{}", output.connector);
        if !entry.file_name().to_str()?.ends_with(&suffix) {
            continue;
        }
        let path = entry.path().canonicalize().ok()?;
        let relative = path.strip_prefix(gpu).ok();
        if relative.is_none_or(|p| p.components().next().is_none_or(|c| c.as_os_str() != "drm")) {
            continue;
        }
        if fs::read_to_string(path.join("status")).ok()?.trim() != "connected" {
            continue;
        }
        if edid_key(&fs::read(path.join("edid")).ok()?) != output.edid {
            continue;
        }
        matches.push(path);
    }
    (matches.len() == 1).then(|| matches.remove(0))
}
fn associated(path: &Path, connector: &Path, gpu: &str, internal_count: usize) -> bool {
    let parent = path
        .join("device")
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf());
    path.starts_with(connector)
        || parent.starts_with(connector)
        || (internal_count == 1 && (path.starts_with(gpu) || parent == Path::new(gpu)))
}
fn panel(item: &Path) -> Option<Channel> {
    let path = item.canonicalize().ok()?;
    let name = item.file_name()?.to_str()?.to_owned();
    if !name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || "_-".contains(c))
    {
        return None;
    }
    let max = number(&path.join("max_brightness")).ok()?;
    (max > 0).then_some(Channel::Panel { path, name, max })
}
fn platform_panel(backlights: &Path, connector: &Path, gpu: &str) -> Option<Channel> {
    let mut candidates = Vec::new();
    for item in fs::read_dir(backlights).ok()? {
        let item = item.ok()?;
        let path = item.path().canonicalize().ok()?;
        let kind = fs::read_to_string(path.join("type")).unwrap_or_default();
        if kind.trim() == "raw" && associated(&path, connector, gpu, 1) {
            return None;
        }
        if matches!(kind.trim(), "firmware" | "platform") {
            // Count before validating range/name: a broken second candidate must
            // not turn ambiguity into permission to control the first one.
            candidates.push(item.path());
        }
    }
    if candidates.len() != 1 {
        return None;
    }
    panel(&candidates[0])
}
pub fn discover(paths: &Paths, outputs: &[hardware::Output]) -> Vec<Link> {
    let mut links = Vec::new();
    for output in outputs {
        let Some(connector) = connector(paths, output) else {
            continue;
        };
        if output.internal {
            let gpu = output.port.rsplit_once(':').unwrap().0;
            let internal_count = outputs
                .iter()
                .filter(|o| o.internal && o.port.rsplit_once(':').is_some_and(|(g, _)| g == gpu))
                .count();
            let mut panels = Vec::new();
            let mut raw_associated = false;
            let backlights = paths.sys.join("class/backlight");
            for item in fs::read_dir(&backlights).into_iter().flatten().flatten() {
                let Ok(path) = item.path().canonicalize() else {
                    continue;
                };
                if !associated(&path, &connector, gpu, internal_count) {
                    continue;
                }
                raw_associated |=
                    fs::read_to_string(path.join("type")).is_ok_and(|kind| kind.trim() == "raw");
                if let Some(channel) = panel(&item.path()) {
                    panels.push(channel);
                }
            }
            let mut platform_backlights = None;
            if panels.is_empty()
                && !raw_associated
                && outputs.iter().filter(|o| o.internal).count() == 1
                && let Some(channel) = platform_panel(&backlights, &connector, gpu)
            {
                panels.push(channel);
                platform_backlights = Some(backlights);
            }
            if panels.len() == 1 {
                links.push(Link {
                    output: output.clone(),
                    connector,
                    channel: panels.remove(0),
                    platform_backlights,
                });
            }
        } else if let Ok(ddc) = connector.join("ddc").canonicalize()
            && let Some(bus) = ddc
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(|s| s.strip_prefix("i2c-"))
                .and_then(|n| n.parse::<u32>().ok())
        {
            let node = paths.dev.join(format!("i2c-{bus}"));
            // Keep an exact candidate even if udev permissions are not ready yet.
            // verify() checks access before every probe; only a successful read can
            // publish availability. Recovery never invents a bus or sends a write.
            links.push(Link {
                output: output.clone(),
                connector,
                channel: Channel::Ddc { bus, node },
                platform_backlights: None,
            });
        }
    }
    // A bus/backlight must never be writable through two output identities.
    let duplicate: Vec<_> = links
        .iter()
        .filter(|a| links.iter().filter(|b| b.channel == a.channel).count() > 1)
        .map(|a| a.channel.clone())
        .collect();
    links.retain(|l| !duplicate.contains(&l.channel));
    links
}
pub fn verify(link: &Link) -> Result<(), Error> {
    let connected =
        fs::read_to_string(link.connector.join("status")).is_ok_and(|s| s.trim() == "connected");
    let same =
        fs::read(link.connector.join("edid")).is_ok_and(|b| edid_key(&b) == link.output.edid);
    if !connected || !same {
        return Err(Error::Stale("output identity changed".into()));
    }
    if let Some(backlights) = &link.platform_backlights {
        let gpu = link.output.port.rsplit_once(':').map(|v| v.0).unwrap_or("");
        if platform_panel(backlights, &link.connector, gpu).as_ref() != Some(&link.channel) {
            return Err(Error::Stale("firmware/platform association changed".into()));
        }
    }
    match &link.channel {
        Channel::Panel { path, max, .. } if number(&path.join("max_brightness"))? != *max => {
            Err(Error::Stale("backlight range changed".into()))
        }
        Channel::Ddc { bus, .. }
            if link
                .connector
                .join("ddc")
                .canonicalize()
                .ok()
                .and_then(|p| p.file_name().map(|s| s.to_string_lossy().into_owned()))
                != Some(format!("i2c-{bus}")) =>
        {
            Err(Error::Stale("DDC bus changed".into()))
        }
        Channel::Ddc { node, .. } => fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(node)
            .map(|_| ())
            .map_err(|e| Error::Unavailable(format!("DDC channel inaccessible: {e}"))),
        _ => Ok(()),
    }
}
pub fn panel_value(path: &Path) -> Result<u32, Error> {
    number(&path.join(if path.join("actual_brightness").exists() {
        "actual_brightness"
    } else {
        "brightness"
    }))
}
