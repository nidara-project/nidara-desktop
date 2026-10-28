// SPDX-License-Identifier: GPL-3.0-or-later
//! One disk worker serializes durable profiles. No filesystem I/O on the render loop.
use super::{Event, model::Profiles};
use smithay::reexports::calloop::channel::Sender;
use std::{path::PathBuf, sync::mpsc};

pub struct Save {
    pub serial: u64,
    pub profiles: Profiles,
}
pub fn path() -> Option<PathBuf> {
    crate::config::settings_layer().map(|p| p.with_file_name("hyalo-display-profiles.json"))
}
pub fn run(path: Option<PathBuf>, rx: mpsc::Receiver<Save>, tx: Sender<Event>) {
    let loaded = path
        .as_ref()
        .map(|p| match std::fs::read(p) {
            Ok(bytes) => serde_json::from_slice::<Profiles>(&bytes)
                .map_err(|e| e.to_string())
                .and_then(|p| {
                    if p.version == 1 {
                        Ok(p)
                    } else {
                        Err("unsupported display profile version".into())
                    }
                }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Profiles::default()),
            Err(e) => Err(e.to_string()),
        })
        .unwrap_or_else(|| Ok(Profiles::default()));
    let blocked = loaded.as_ref().err().cloned().unwrap_or_default();
    let _ = tx.send(Event::Loaded(
        loaded.unwrap_or_default(),
        crate::config::display_overrides().unwrap_or_default(),
        blocked.clone(),
    ));
    for save in rx {
        let result = if !blocked.is_empty() {
            Err(format!("profile file was not loaded; refusing to overwrite: {blocked}"))
        } else {
            path.as_deref()
                .ok_or_else(|| "no settings layer for this session".to_string())
                .and_then(|path| write(path, &save.profiles).map_err(|e| e.to_string()))
        };
        let _ = tx.send(Event::Saved(save.serial, result));
    }
}
fn write(path: &std::path::Path, profiles: &Profiles) -> std::io::Result<()> {
    use std::{io::Write, os::unix::fs::OpenOptionsExt};
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("profile parent absent"))?;
    std::fs::create_dir_all(parent)?;
    static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let serial = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let tmp = path.with_extension(format!("json.{}.{serial}.next", std::process::id()));
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(&tmp)?;
    let result = (|| {
        f.write_all(&serde_json::to_vec(profiles)?)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)?;
        std::fs::File::open(parent)?.sync_all()
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn durable_replace_is_versioned_and_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::current_dir().unwrap().join("../target/display-store-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join(format!("profiles-{}.json", std::process::id()));
        let profiles = Profiles {
            version: 1,
            ..Default::default()
        };
        write(&path, &profiles).unwrap();
        let decoded: Profiles = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(decoded.version, 1);
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(!path.with_extension("json.next").exists());
        std::fs::remove_file(path).unwrap();
    }
}
