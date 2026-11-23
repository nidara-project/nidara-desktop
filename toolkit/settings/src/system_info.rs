// SPDX-License-Identifier: LGPL-3.0-or-later
//! The one reader of "what is this computer" on the Rust side, as `ui/shell/core/SystemInfo.ts`
//! is on the TypeScript one: a surface asks, it never reads, and the formatting lives here too
//! (the same machine once showed 31 GB in one window and 31.3 GB in another). Unknown is the
//! empty string, never a word: each surface shows its own placeholder.
//!
//! The quick facts are files; the slow ones (the graphics adapter, the compositor's version,
//! the latest release) are for a worker thread.
use serde_json::Value;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

fn read(path: &str) -> String {
    std::fs::read_to_string(path).unwrap_or_default()
}

/// A field of `/etc/os-release`, unquoted.
fn os_release(text: &str, field: &str) -> String {
    text.lines()
        .find_map(|l| l.strip_prefix(field)?.strip_prefix('='))
        .map(|v| v.trim().trim_matches('"').trim().to_owned())
        .unwrap_or_default()
}

/// The operating system as it names itself (`PRETTY_NAME`): an identity, no version.
pub fn os_name() -> String {
    os_release(&read("/etc/os-release"), "PRETTY_NAME")
}

/// The machine's name.
pub fn device_name() -> String {
    read("/proc/sys/kernel/hostname").trim().to_owned()
}

/// The CPU without the marketing noise ("Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz" →
/// "Intel Core i7-9700K").
pub fn cpu_model() -> String {
    cpu_name(&read("/proc/cpuinfo"))
}

fn cpu_name(cpuinfo: &str) -> String {
    let Some(raw) = cpuinfo.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == "model name").then(|| v.trim())
    }) else {
        return String::new();
    };
    let words: Vec<&str> = raw
        .split_whitespace()
        .map(|w| w.trim_end_matches("(R)").trim_end_matches("(TM)"))
        .filter(|w| !w.is_empty())
        .collect();
    // "CPU @ 3.60GHz" and anything after the "@".
    let end = words.iter().position(|w| *w == "@").unwrap_or(words.len());
    words[..end]
        .iter()
        .filter(|w| **w != "CPU")
        .copied()
        .collect::<Vec<_>>()
        .join(" ")
}

/// Installed memory, rounded up to the whole GB: `MemTotal` is what the kernel can hand out,
/// a few percent under what is in the slots.
pub fn total_ram() -> String {
    memory(&read("/proc/meminfo"))
}

fn memory(meminfo: &str) -> String {
    meminfo
        .lines()
        .find_map(|l| l.strip_prefix("MemTotal:"))
        .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
        .map(|kb| format!("{} GB", kb.div_ceil(1024 * 1024)))
        .unwrap_or_default()
}

/// The running kernel's release.
pub fn kernel() -> String {
    read("/proc/sys/kernel/osrelease").trim().to_owned()
}

/// Whole seconds since boot; None when unreadable.
pub fn uptime_seconds() -> Option<u64> {
    let secs: f64 = read("/proc/uptime")
        .split_whitespace()
        .next()?
        .parse()
        .ok()?;
    (secs.is_finite() && secs >= 0.).then_some(secs as u64)
}

/// The desktop's version: the checkout's `VERSION` in a dev install, else the installed one.
pub fn desktop_version() -> String {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_default();
    let dev = std::fs::read_to_string(home.join(".config/nidara/.dev"))
        .ok()
        .map(|repo| PathBuf::from(repo.trim()).join("VERSION"));
    dev.and_then(|p| std::fs::read_to_string(p).ok())
        .or_else(|| std::fs::read_to_string("/usr/share/nidara/VERSION").ok())
        .map(|v| v.trim().to_owned())
        .unwrap_or_default()
}

/// The first display adapter's name (slow: runs `lspci`).
pub fn graphics() -> String {
    let out = Command::new("lspci").output().ok();
    let text = out.map(|o| String::from_utf8_lossy(&o.stdout).into_owned());
    let line = text.as_deref().unwrap_or_default().lines().find(|l| {
        let l = l.to_lowercase();
        l.contains("vga") || l.contains("3d") || l.contains("display")
    });
    let Some(line) = line else {
        return String::new();
    };
    // "00:00.0 VGA compatible controller: <raw> (rev c1)"
    let raw = line.split_once(": ").map_or(line, |(_, r)| r);
    let raw = raw.split(" (").next().unwrap_or(raw).trim();
    gpu_name(raw)
}

/// The GPU as a name rather than a PCI database entry: the vendor as people say it, and the
/// model lspci puts in its last bracket (`[AMD/ATI]` is a vendor tag, not a model).
pub fn gpu_name(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let lower = raw.to_lowercase();
    let word = |w: &str| lower.split(|c: char| !c.is_alphanumeric()).any(|t| t == w);
    // Intel before AMD: "ati" would match inside "Corporation".
    let vendor = if word("nvidia") {
        "NVIDIA"
    } else if word("intel") {
        "Intel"
    } else if lower.contains("advanced micro devices") || word("amd") || word("ati") {
        "AMD"
    } else {
        ""
    };
    let mut models = vec![];
    let mut rest = raw;
    while let Some(open) = rest.find('[') {
        let Some(close) = rest[open..].find(']') else {
            break;
        };
        let inner = rest[open + 1..open + close].trim();
        if !matches!(inner.to_lowercase().as_str(), "amd/ati" | "ati" | "amd") {
            models.push(inner);
        }
        rest = &rest[open + close + 1..];
    }
    let model = match models.last() {
        Some(m) => (*m).to_owned(),
        None => {
            // No brackets (virtio in a VM, an odd vendor): drop the corporate suffix.
            let cut = ["Corporation", "Inc.", "Technologies", "Ltd."]
                .iter()
                .filter_map(|s| raw.find(s).map(|i| i + s.len()))
                .min();
            match cut {
                Some(i) if !raw[i..].trim().is_empty() => raw[i..].trim().to_owned(),
                _ => raw.to_owned(),
            }
        }
    };
    if !vendor.is_empty() && !model.to_lowercase().starts_with(&vendor.to_lowercase()) {
        format!("{vendor} {model}")
    } else {
        model
    }
}

/// Hyalo's version, asked on its socket (slow: a round trip).
pub fn compositor_version() -> String {
    hyalo_version().unwrap_or_default()
}

fn hyalo_version() -> Option<String> {
    let path = std::env::var_os("HYALO_SOCKET")
        .map(PathBuf::from)
        .or_else(|| {
            let rt = std::env::var_os("XDG_RUNTIME_DIR")?;
            let display = std::env::var("WAYLAND_DISPLAY").ok()?;
            let name = std::path::Path::new(&display)
                .file_name()?
                .to_str()?
                .to_owned();
            Some(PathBuf::from(rt).join(format!("nidara-hyalo.{name}.sock")))
        })?;
    let mut stream = UnixStream::connect(path).ok()?;
    let deadline = Some(Duration::from_secs(2));
    stream.set_read_timeout(deadline).ok()?;
    stream.set_write_timeout(deadline).ok()?;
    stream.write_all(b"{\"request\":\"version\"}\n").ok()?;
    let mut line = String::new();
    BufReader::new(stream)
        .take(64 << 10)
        .read_line(&mut line)
        .ok()?;
    let reply: Value = serde_json::from_str(&line).ok()?;
    reply["ok"]["version"].as_str().map(str::to_owned)
}

/// The latest published release's tag ("v0.4.0"), None when it cannot be asked (no network,
/// no release yet).
pub fn latest_release() -> Option<String> {
    let out = Command::new("curl")
        .args([
            "-fsS",
            "--max-time",
            "5",
            "https://api.github.com/repos/nidara-project/nidara-desktop/releases/latest",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let reply: Value = serde_json::from_slice(&out.stdout).ok()?;
    reply["tag_name"]
        .as_str()
        .filter(|t| !t.is_empty())
        .map(str::to_owned)
}

/// Whether `latest` is a strictly newer dotted version than `current`.
pub fn is_newer(latest: &str, current: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        v.trim_start_matches('v')
            .split('.')
            .map(|n| n.parse().unwrap_or(0))
            .collect()
    };
    if latest.is_empty() || current.is_empty() {
        return false;
    }
    let (a, b) = (parts(latest), parts(current));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (
            a.get(i).copied().unwrap_or(0),
            b.get(i).copied().unwrap_or(0),
        );
        if x != y {
            return x > y;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_gpu_is_named_by_its_vendor_and_model() {
        let cases = [
            (
                "Advanced Micro Devices, Inc. [AMD/ATI] Navi 10 [Radeon RX 5600 OEM/5600 XT / 5700/5700 XT]",
                "AMD Radeon RX 5600 OEM/5600 XT / 5700/5700 XT",
            ),
            (
                "Intel Corporation Alder Lake-P GT2 [Iris Xe Graphics]",
                "Intel Iris Xe Graphics",
            ),
            (
                "NVIDIA Corporation GA104 [GeForce RTX 3070]",
                "NVIDIA GeForce RTX 3070",
            ),
            ("Red Hat, Inc. Virtio 1.0 GPU", "Virtio 1.0 GPU"),
            (
                "Intel Corporation UHD Graphics 620",
                "Intel UHD Graphics 620",
            ),
            ("", ""),
        ];
        for (raw, name) in cases {
            assert_eq!(gpu_name(raw), name, "{raw}");
        }
    }

    #[test]
    fn a_cpu_loses_its_marketing_noise() {
        assert_eq!(
            cpu_name("model name\t: Intel(R) Core(TM) i7-9700K CPU @ 3.60GHz\n"),
            "Intel Core i7-9700K"
        );
        assert_eq!(
            cpu_name("model name\t: AMD Ryzen 7 5800X 8-Core Processor\n"),
            "AMD Ryzen 7 5800X 8-Core Processor"
        );
        assert_eq!(cpu_name(""), "");
    }

    #[test]
    fn memory_is_the_installed_size() {
        assert_eq!(memory("MemTotal:       32778376 kB\n"), "32 GB");
        assert_eq!(memory(""), "");
    }

    #[test]
    fn the_os_is_its_pretty_name() {
        assert_eq!(
            os_release("NAME=Arch\nPRETTY_NAME=\"Arch Linux\"\n", "PRETTY_NAME"),
            "Arch Linux"
        );
    }

    #[test]
    fn only_a_strictly_newer_release_is_an_update() {
        assert!(is_newer("v0.5.0", "0.4.9"));
        assert!(!is_newer("0.4.0", "0.4.0"));
        assert!(!is_newer("0.3.9", "0.4.0"));
        assert!(!is_newer("", "0.4.0"));
    }
}
