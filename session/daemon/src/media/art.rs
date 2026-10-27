// SPDX-License-Identifier: GPL-3.0-or-later
//! Bounded image fetch/decode. Cache ownership is separate from the TS shell.
use super::*;
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path as FilePath, PathBuf},
};
use tokio::io::AsyncReadExt;
const MAX: usize = 10 * 1024 * 1024;
#[derive(Clone)]
pub struct Art {
    slots: Arc<tokio::sync::Semaphore>,
    negative: Arc<Mutex<BTreeMap<String, std::time::Instant>>>,
}
impl Art {
    pub fn new() -> Self {
        Self {
            slots: Arc::new(tokio::sync::Semaphore::new(2)),
            negative: Default::default(),
        }
    }
    pub async fn resolve(&self, url: String) -> Result<String, String> {
        let key = format!("{:x}", Sha256::digest(url.as_bytes()));
        if self
            .negative
            .lock()
            .await
            .get(&key)
            .is_some_and(|t| t.elapsed() < Duration::from_secs(60))
        {
            return Err("recent artwork failure".into());
        }
        let slot = self
            .slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| "artwork workers busy")?;
        let source = url.clone();
        let task = tokio::spawn(async move {
            let _slot = slot;
            resolve(&source).await
        });
        let result = tokio::time::timeout(Duration::from_secs(10), task)
            .await
            .map_err(|_| "artwork deadline exceeded".to_string())
            .and_then(|r| r.map_err(|e| e.to_string()))
            .and_then(|r| r);
        if result.is_err() {
            let mut n = self.negative.lock().await;
            if n.len() >= 256 {
                n.pop_first();
            }
            n.insert(key, std::time::Instant::now());
        }
        result
    }
}
fn directory() -> Result<PathBuf, String> {
    let dir = std::env::var_os("XDG_CACHE_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
        .unwrap_or_else(|| glib::home_dir().join(".cache"))
        .join("nidara/media-art/sessiond");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    Ok(dir)
}
fn local(p: &FilePath) -> Result<Vec<u8>, String> {
    let f = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(p)
        .map_err(|e| e.to_string())?;
    let meta = f.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > MAX as u64 {
        return Err("artwork must be a regular file within 10 MiB".into());
    }
    let mut data = vec![];
    f.take(MAX as u64 + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() > MAX {
        return Err("artwork exceeds 10 MiB".into());
    }
    Ok(data)
}
fn validate(data: &[u8]) -> Result<(), String> {
    let mut reader = image::ImageReader::new(std::io::Cursor::new(data))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    if !matches!(
        reader.format(),
        Some(
            image::ImageFormat::Png
                | image::ImageFormat::Jpeg
                | image::ImageFormat::Gif
                | image::ImageFormat::WebP
        )
    ) {
        return Err("unsupported image format".into());
    }
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let decoded = reader.decode().map_err(|e| e.to_string())?;
    if decoded.width() == 0
        || decoded.height() == 0
        || u64::from(decoded.width()) * u64::from(decoded.height()) > 16_777_216
    {
        return Err("image dimensions out of bounds".into());
    }
    Ok(())
}
async fn resolve(url: &str) -> Result<String, String> {
    if url.is_empty() {
        return Err("empty artwork URL".into());
    }
    let dir = directory()?;
    let key = format!("{:x}", Sha256::digest(url.as_bytes()));
    let file = dir.join(format!("{key}.img"));
    if !url.starts_with("/")
        && !url.starts_with("file:")
        && std::fs::symlink_metadata(&file).is_ok_and(|m| m.file_type().is_file())
    {
        let copy = file.clone();
        if tokio::task::spawn_blocking(move || local(&copy).and_then(|b| validate(&b)))
            .await
            .map_err(|e| e.to_string())?
            .is_ok()
        {
            if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&file) {
                let _ = f.set_times(
                    std::fs::FileTimes::new().set_modified(std::time::SystemTime::now()),
                );
            }
            return Ok(file.to_string_lossy().into());
        }
    }
    let data = if url.starts_with("http://") || url.starts_with("https://") {
        if url.len() > 8192 {
            return Err("art URL too long".into());
        }
        let mut child = tokio::process::Command::new("curl")
            .args([
                "--disable",
                "--fail",
                "--silent",
                "--location",
                "--max-redirs",
                "3",
                "--proto",
                "=http,https",
                "--proto-redir",
                "=http,https",
                "--max-time",
                "10",
                "--max-filesize",
                "10485760",
                "--url",
                url,
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut out = vec![];
        child
            .stdout
            .take()
            .ok_or("curl stdout unavailable")?
            .take(MAX as u64 + 1)
            .read_to_end(&mut out)
            .await
            .map_err(|e| e.to_string())?;
        if out.len() > MAX {
            return Err("artwork exceeds 10 MiB".into());
        }
        if !child.wait().await.map_err(|e| e.to_string())?.success() {
            return Err("artwork download failed".into());
        }
        out
    } else if url.starts_with("data:") {
        let (head, body) = url.split_once(',').ok_or("invalid data URL")?;
        if ![
            "data:image/png;base64",
            "data:image/jpeg;base64",
            "data:image/gif;base64",
            "data:image/webp;base64",
        ]
        .contains(&head)
            || body.len() > MAX.div_ceil(3) * 4
            || !body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"+/=\r\n".contains(&b))
        {
            return Err("invalid image base64 data URL".into());
        }
        let decoded = glib::base64_decode(body);
        if decoded.len() > MAX {
            return Err("artwork exceeds 10 MiB".into());
        }
        decoded.to_vec()
    } else {
        let p = if url.starts_with("file:") {
            let (p, host) = glib::filename_from_uri(url).map_err(|e| e.to_string())?;
            if host.is_some_and(|h| !h.is_empty() && h != "localhost") {
                return Err("nonlocal file URI".into());
            }
            p
        } else {
            let p = PathBuf::from(url);
            if !p.is_absolute() {
                return Err("unsupported artwork URI".into());
            }
            p
        };
        tokio::task::spawn_blocking(move || local(&p))
            .await
            .map_err(|e| e.to_string())??
    };
    let copy = file.clone();
    tokio::task::spawn_blocking(move || {
        validate(&data)?;
        static SERIAL: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let tmp = copy.with_extension(format!(
            "{}-{}.part",
            std::process::id(),
            SERIAL.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| e.to_string())?;
        use std::io::Write;
        let result = f
            .write_all(&data)
            .and_then(|_| std::fs::rename(&tmp, &copy));
        if result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        result.map_err(|e| e.to_string())?;
        prune(copy.parent().unwrap(), &copy);
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(file.to_string_lossy().into())
}
fn prune(dir: &FilePath, keep: &FilePath) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files = entries
        .flatten()
        .filter_map(|e| {
            let m = e.path().symlink_metadata().ok()?;
            (m.is_file() && e.path().extension().is_some_and(|s| s == "img")).then_some((
                m.modified().ok(),
                e.path(),
                m.len(),
            ))
        })
        .collect::<Vec<_>>();
    let mut size = files.iter().map(|x| x.2).sum::<u64>();
    let mut count = files.len();
    files.sort();
    for (_, p, bytes) in files {
        if count <= 150 && size <= 100 * 1024 * 1024 {
            break;
        }
        if p != keep && std::fs::remove_file(p).is_ok() {
            count -= 1;
            size -= bytes;
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decoder_rejects_invalid_or_unbounded_images() {
        assert!(validate(b"not an image").is_err());
        let mut data = vec![];
        let encoder = png::Encoder::new(&mut data, 1, 1);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(&[0]).unwrap();
        drop(writer);
        assert!(validate(&data).is_ok());
        data.truncate(20);
        assert!(validate(&data).is_err());
    }
}
