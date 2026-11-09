// SPDX-License-Identifier: LGPL-3.0-or-later
//! Mapped-only resource sampling and bounded, byte-preserving clipboard helpers.
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::{Read, Write},
    process::{Command, Stdio},
    sync::{Arc, Mutex, OnceLock, mpsc},
    time::{Duration, Instant},
};
#[derive(Clone, Debug, PartialEq)]
pub struct Clip {
    pub id: String,
    pub label: String,
    pub image: bool,
}
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Snapshot {
    pub resources: Option<(f64, f64)>,
    pub clips: Arc<Vec<Clip>>,
    pub clip_revision: u64,
    pub revision: u64,
}
#[derive(Default)]
struct Thumbnails {
    ready: HashMap<(u64, String), Option<Arc<nk_render::Raster>>>,
    order: VecDeque<(u64, String)>,
    pending: HashSet<(u64, String)>,
}
struct Service {
    state: Arc<Mutex<Snapshot>>,
    visible: mpsc::Sender<(String, bool)>,
    thumbnails: Arc<Mutex<Thumbnails>>,
    pictures: mpsc::SyncSender<(u64, String)>,
}
static SERVICE: OnceLock<Service> = OnceLock::new();
fn service() -> &'static Service {
    SERVICE.get_or_init(|| {
        let state = Arc::new(Mutex::new(Snapshot::default()));
        let (tx, rx) = mpsc::channel::<(String, bool)>();
        let out = state.clone();
        std::thread::Builder::new()
            .name("cc-resources".into())
            .spawn(move || {
                let mut outputs = HashSet::new();
                let mut previous = None;
                loop {
                    let changed = if outputs.is_empty() {
                        rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected)
                    } else {
                        rx.recv_timeout(Duration::from_secs(2))
                    };
                    match changed {
                        Ok((name, true)) => {
                            outputs.insert(name);
                        }
                        Ok((name, false)) => {
                            outputs.remove(&name);
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                    if outputs.is_empty() {
                        previous = None;
                        continue;
                    }
                    crate::icon_metrics::emit(
                        "cc-resources-sample",
                        serde_json::json!({"outputs":outputs.len()}),
                    );
                    let cpu = std::fs::read_to_string("/proc/stat").ok();
                    let memory = std::fs::read_to_string("/proc/meminfo").ok();
                    if let (Some(cpu), Some(memory)) = (cpu, memory) {
                        let (sample, values) = resources(&cpu, &memory, previous);
                        previous = sample;
                        let mut state = out.lock().unwrap();
                        if state.resources != values {
                            state.resources = values;
                            state.revision += 1;
                        }
                    }
                }
            })
            .expect("resource reader");
        let thumbnails = Arc::new(Mutex::new(Thumbnails::default()));
        let (pictures, requested) = mpsc::sync_channel::<(u64, String)>(32);
        let (cache, current) = (thumbnails.clone(), state.clone());
        std::thread::Builder::new()
            .name("cc-clip-previews".into())
            .spawn(move || {
                while let Ok(key) = requested.recv() {
                    let valid = || {
                        let s = current.lock().unwrap();
                        s.clip_revision == key.0 && s.clips.iter().any(|c| c.id == key.1 && c.image)
                    };
                    let picture = if valid() {
                        helper(
                            "cliphist",
                            &["decode"],
                            Some(format!("{}\t", key.1).into_bytes()),
                            32 << 20,
                        )
                        .ok()
                        .and_then(|b| preview(&b))
                        .map(Arc::new)
                    } else {
                        None
                    };
                    let mut state = current.lock().unwrap();
                    let mut cache = cache.lock().unwrap();
                    cache.pending.remove(&key);
                    if state.clip_revision != key.0 {
                        continue;
                    }
                    while cache.order.len() >= 32 {
                        if let Some(old) = cache.order.pop_front() {
                            cache.ready.remove(&old);
                        }
                    }
                    cache.order.push_back(key.clone());
                    cache.ready.insert(key, picture);
                    state.revision += 1;
                }
            })
            .expect("clipboard previews");
        Service {
            state,
            visible: tx,
            thumbnails,
            pictures,
        }
    })
}
/// Called only for visible image rows. One bounded worker and 32 small previews.
pub fn thumbnail(revision: u64, id: &str) -> Option<Arc<nk_render::Raster>> {
    let service = service();
    let key = (revision, id.to_owned());
    let mut cache = service.thumbnails.lock().unwrap();
    if let Some(picture) = cache.ready.get(&key).cloned() {
        cache.order.retain(|k| k != &key);
        cache.order.push_back(key);
        return picture;
    }
    if cache.pending.insert(key.clone()) && service.pictures.try_send(key.clone()).is_err() {
        cache.pending.remove(&key);
    }
    None
}
fn preview(bytes: &[u8]) -> Option<nk_render::Raster> {
    use image::ImageReader;
    let mut reader = ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(8192);
    limits.max_image_height = Some(8192);
    limits.max_alloc = Some(64 << 20);
    reader.limits(limits);
    let image = reader.decode().ok()?.thumbnail(40, 40).to_rgba8();
    nk_render::Raster::from_rgba(
        image.width() as u16,
        image.height() as u16,
        image.into_raw(),
    )
    .ok()
}
pub fn snapshot() -> Snapshot {
    service().state.lock().unwrap().clone()
}
pub fn mapped(output: &str, visible: bool) {
    let _ = service().visible.send((output.into(), visible));
}
type Counters = (u64, u64);
type ResourceValues = (f64, f64);
pub fn resources(
    cpu: &str,
    memory: &str,
    previous: Option<(u64, u64)>,
) -> (Option<Counters>, Option<ResourceValues>) {
    let values: Vec<u64> = cpu
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .skip(1)
        .take(8)
        .filter_map(|n| n.parse().ok())
        .collect();
    if values.len() < 4 {
        return (None, None);
    }
    let total = values.iter().sum::<u64>();
    let idle = values[3] + values.get(4).copied().unwrap_or(0);
    let fraction = previous
        .map_or(0., |(t, i)| {
            let dt = total.saturating_sub(t);
            if dt == 0 {
                0.
            } else {
                1. - idle.saturating_sub(i) as f64 / dt as f64
            }
        })
        .clamp(0., 1.);
    let number = |name: &str| {
        memory.lines().find_map(|l| {
            l.strip_prefix(name)?
                .split_whitespace()
                .next()?
                .parse::<u64>()
                .ok()
        })
    };
    let ram = number("MemTotal:")
        .zip(number("MemAvailable:"))
        .filter(|(total, _)| *total > 0)
        .map(|(total, available)| 1. - available.min(total) as f64 / total as f64);
    (Some((total, idle)), ram.map(|ram| (fraction, ram)))
}
pub fn clipboard_available() -> bool {
    std::env::var_os("PATH").is_some_and(|path| {
        std::env::split_paths(&path).any(|dir| executable(&dir.join("cliphist")))
    })
}
fn executable(p: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}
/// Preserve record separators while removing C0 controls before UTF-8 conversion.
pub fn parse_list(bytes: &[u8]) -> Vec<Clip> {
    let kept: Vec<_> = bytes
        .iter()
        .copied()
        .filter(|b| *b == b'\t' || *b == b'\n' || (*b >= 32 && *b != 127))
        .collect();
    String::from_utf8_lossy(&kept)
        .lines()
        .filter_map(|line| {
            let (id, preview) = line.split_once('\t')?;
            if id.is_empty() || id.len() > 20 || id.parse::<u64>().is_err() {
                return None;
            }
            let preview = preview.split_whitespace().collect::<Vec<_>>().join(" ");
            let image = preview.starts_with("[[ binary data ")
                && preview.ends_with(" ]]")
                && preview.split_whitespace().any(|part| {
                    part.split_once('x')
                        .is_some_and(|(w, h)| w.parse::<u32>().is_ok() && h.parse::<u32>().is_ok())
                });
            Some(Clip {
                id: id.into(),
                label: if image {
                    let parts: Vec<_> = preview.split_whitespace().collect();
                    format!(
                        "{} · {}",
                        parts[parts.len() - 3].to_uppercase(),
                        parts[parts.len() - 2].replace('x', "×")
                    )
                } else {
                    preview.chars().take(240).collect()
                },
                image,
            })
        })
        .take(200)
        .collect()
}
/// Only the positively identified UTF-16 text case is converted. Images stay exact.
pub fn copy_bytes(bytes: Vec<u8>) -> Vec<u8> {
    if bytes.len() < 4 {
        return bytes;
    }
    let pairs = bytes.len() / 2;
    let even = bytes.iter().step_by(2).filter(|b| **b == 0).count();
    let odd = bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
    let little = if even == 0 && odd * 5 > pairs * 4 {
        true
    } else if odd == 0 && even * 5 > pairs * 4 {
        false
    } else {
        return bytes;
    };
    String::from_utf16_lossy(
        &bytes
            .as_chunks::<2>()
            .0
            .iter()
            .map(|p| {
                if little {
                    u16::from_le_bytes([p[0], p[1]])
                } else {
                    u16::from_be_bytes([p[0], p[1]])
                }
            })
            .collect::<Vec<_>>(),
    )
    .into_bytes()
}
pub fn helper(
    program: &str,
    args: &[&str],
    input: Option<Vec<u8>>,
    limit: usize,
) -> Result<Vec<u8>, String> {
    use std::os::fd::AsRawFd;
    let mut child = Command::new(program)
        .args(args)
        .env_remove("GTK_THEME")
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(if limit == 0 {
            Stdio::null()
        } else {
            Stdio::piped()
        })
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let result = (|| {
        // Linux fcntl ABI: nonblocking owned pipes keep one deadline over both
        // directions, without reader/writer threads that a descendant can strand.
        fn nonblocking(fd: std::ffi::c_int) -> Result<(), String> {
            unsafe extern "C" {
                fn fcntl(fd: std::ffi::c_int, cmd: std::ffi::c_int, ...) -> std::ffi::c_int;
            }
            // SAFETY: fd belongs to a live ChildStdin/Stdout; F_GETFL=3,
            // F_SETFL=4, O_NONBLOCK=04000 in Linux's fcntl ABI.
            unsafe {
                let flags = fcntl(fd, 3);
                if flags < 0 || fcntl(fd, 4, flags | 0o4000) < 0 {
                    return Err(std::io::Error::last_os_error().to_string());
                }
            }
            Ok(())
        }
        let mut stdin = child.stdin.take();
        let mut stdout = child.stdout.take();
        if let Some(pipe) = &stdin {
            nonblocking(pipe.as_raw_fd())?;
        }
        if let Some(pipe) = &stdout {
            nonblocking(pipe.as_raw_fd())?;
        }
        let input = input.unwrap_or_default();
        let mut sent = 0;
        let mut kept = Vec::new();
        let mut status = None;
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if Instant::now() >= deadline {
                return Err("clipboard helper timed out".into());
            }
            let mut progressed = false;
            if let Some(pipe) = &mut stdin {
                if sent == input.len() {
                    stdin = None;
                } else {
                    match pipe.write(&input[sent..input.len().min(sent + 16384)]) {
                        Ok(n) => {
                            sent += n;
                            progressed = true;
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                        Err(e) => return Err(e.to_string()),
                    }
                }
            }
            if let Some(pipe) = &mut stdout {
                let mut buffer = [0; 8192];
                match pipe.read(&mut buffer) {
                    Ok(0) => stdout = None,
                    Ok(n) => {
                        if kept.len() + n > limit {
                            return Err("helper output exceeds its limit".into());
                        }
                        kept.extend_from_slice(&buffer[..n]);
                        progressed = true;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            if status.is_none() {
                status = child.try_wait().map_err(|e| e.to_string())?;
            }
            if let Some(status) = status
                && stdin.is_none()
                && stdout.is_none()
            {
                return if status.success() {
                    Ok(kept)
                } else {
                    Err("clipboard helper failed".into())
                };
            }
            if !progressed {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    })();
    if result.is_err() {
        let _ = child.kill();
        let _ = child.wait();
    }
    result
}
pub fn refresh_clipboard() -> Result<(), String> {
    let bytes = helper("cliphist", &["list"], None, 2 << 20)?;
    let clips = Arc::new(parse_list(&bytes));
    let mut state = service().state.lock().unwrap();
    *service().thumbnails.lock().unwrap() = Thumbnails::default();
    state.clips = clips;
    state.clip_revision += 1;
    state.revision += 1;
    Ok(())
}
pub fn clipboard(id: Option<&str>, revision: u64, remove: bool, wipe: bool) -> Result<(), String> {
    let state = snapshot();
    if state.clip_revision != revision {
        return Err("clipboard history changed; refresh it".into());
    }
    if wipe {
        helper("cliphist", &["wipe"], None, 0)?;
        return refresh_clipboard();
    }
    let entry = state
        .clips
        .iter()
        .find(|e| Some(e.id.as_str()) == id)
        .ok_or("clipboard entry is gone")?;
    let input = Some(format!("{}\t", entry.id).into_bytes());
    if remove {
        helper("cliphist", &["delete"], input, 0)?;
        refresh_clipboard()
    } else {
        let bytes = helper("cliphist", &["decode"], input, 32 << 20)?;
        helper("wl-copy", &[], Some(copy_bytes(bytes)), 0)?;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn oversized_output_and_a_nonreading_child_cannot_hold_the_helper_lane() {
        let start = Instant::now();
        assert!(
            helper(
                "python3",
                &["-c", "import sys;sys.stdout.buffer.write(b'x'*65536)"],
                None,
                32
            )
            .unwrap_err()
            .contains("limit")
        );
        assert!(start.elapsed() < Duration::from_secs(3));
        let start = Instant::now();
        assert!(
            helper(
                "python3",
                &["-c", "import time;time.sleep(9)"],
                Some(vec![1; 1 << 20]),
                0
            )
            .unwrap_err()
            .contains("tim")
        );
        assert!(start.elapsed() < Duration::from_secs(7));
    }

    #[test]
    fn nul_in_a_clip_never_hides_the_following_rows_and_images_keep_their_bytes() {
        let rows = parse_list(b"12\th\0e\0l\0l\0o\0\n13\t[[ binary data 24 KiB png 1920x1080 ]]\n");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].label, "hello");
        assert!(rows[1].image);
        assert_eq!(copy_bytes(b"h\0e\0l\0l\0o\0".to_vec()), b"hello");
        let png = b"\x89PNG\r\n\x1a\n\0\0\0\0".to_vec();
        assert_eq!(copy_bytes(png.clone()), png);
    }
    #[test]
    fn cpu_uses_deltas_and_ram_uses_available_not_only_free() {
        let (p, v) = resources(
            "cpu 10 0 10 80 0 0 0 0\n",
            "MemTotal: 100 kB\nMemAvailable: 40 kB\nMemFree: 1 kB",
            None,
        );
        assert_eq!(p, Some((100, 80)));
        assert_eq!(v, Some((0., 0.6)));
        let (_, v) = resources(
            "cpu 20 0 20 100 0 0 0 0\n",
            "MemTotal: 100 kB\nMemAvailable: 40 kB",
            p,
        );
        assert_eq!(v, Some((0.5, 0.6)));
    }
}
