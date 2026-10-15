use crate::model::{Notification, truthy};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs, io,
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::{Path, PathBuf},
};
use zbus::zvariant::OwnedValue;

#[derive(Clone)]
pub struct Store {
    pub dir: PathBuf,
}
#[derive(Deserialize, Serialize)]
struct History {
    version: u32,
    notifications: Vec<Notification>,
}

fn private_dir(path: &Path) -> io::Result<()> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)
}
impl Store {
    pub fn new() -> io::Result<Self> {
        let cache = std::env::var_os("XDG_CACHE_HOME")
            .filter(|p| Path::new(p).is_absolute())
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("HOME").map(|p| PathBuf::from(p).join(".cache")))
            .ok_or_else(|| io::Error::other("neither XDG_CACHE_HOME nor HOME is available"))?;
        Ok(Self {
            dir: cache.join("nidara/notifd"),
        })
    }
    pub fn restore(&self) -> Vec<Notification> {
        match fs::read(self.dir.join("state.json")) {
            Ok(bytes) => match serde_json::from_slice::<History>(&bytes) {
                Ok(h) => h.notifications,
                Err(e) => {
                    eprintln!("[notifd] could not read the store: {e}");
                    Vec::new()
                }
            },
            Err(e) if e.kind() == io::ErrorKind::NotFound => Vec::new(),
            Err(e) => {
                eprintln!("[notifd] could not read the store: {e}");
                Vec::new()
            }
        }
        // Deliberately no restored expiry timers: just like notifd.ts, persisted
        // history remains in the NC until it is cleared, even across a restart.
    }
    pub fn flush(&self, notifications: &[Notification]) -> io::Result<()> {
        private_dir(&self.dir)?;
        let history = History {
            version: 1,
            notifications: notifications
                .iter()
                .filter(|n| !truthy(n.hints.get("transient")))
                .cloned()
                .collect(),
        };
        let tmp = self.dir.join("state.json.tmp");
        let file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&tmp)?;
        serde_json::to_writer(file, &history)?;
        fs::rename(tmp, self.dir.join("state.json"))
    }
    pub fn image(&self, hints: &HashMap<String, OwnedValue>) -> Option<String> {
        let raw = hints.get("image-data")?;
        match self.decode_image(raw) {
            Ok(path) => Some(path.to_string_lossy().into_owned()),
            Err(e) => {
                eprintln!("[notifd] could not decode image-data: {e}");
                None
            }
        }
    }
    fn decode_image(&self, value: &OwnedValue) -> Result<PathBuf, Box<dyn std::error::Error>> {
        let (w, h, stride, alpha, bps, _channels, data): (i32, i32, i32, bool, i32, i32, Vec<u8>) =
            value.try_clone()?.try_into()?;
        // GdkPixbuf's RGB decoder used has-alpha for the channel count, not the
        // sender's redundant channels field. Its rowstride may include padding.
        let channels = if alpha { 4usize } else { 3 };
        if bps != 8 || w <= 0 || h <= 0 || stride <= 0 {
            return Err("unsupported image dimensions/bits per sample".into());
        }
        let row = (w as usize)
            .checked_mul(channels)
            .ok_or("image row overflow")?;
        let stride = stride as usize;
        let end = (h as usize - 1)
            .checked_mul(stride)
            .and_then(|n| n.checked_add(row))
            .ok_or("image size overflow")?;
        if stride < row || data.len() < end {
            return Err("short image-data or rowstride".into());
        }
        let dir = self.dir.join("images");
        private_dir(&dir)?;
        let hash = format!("{:x}", Sha256::digest(&data));
        let path = dir.join(format!("{}.png", &hash[..32]));
        if path.exists() {
            return Ok(path);
        }
        // Write packed rows. The final row need not include trailing padding.
        let mut pixels = Vec::with_capacity(row * h as usize);
        for y in 0..h as usize {
            pixels.extend_from_slice(&data[y * stride..y * stride + row]);
        }
        let mut encoder = png::Encoder::new(fs::File::create(&path)?, w as u32, h as u32);
        encoder.set_color(if alpha {
            png::ColorType::Rgba
        } else {
            png::ColorType::Rgb
        });
        encoder.set_depth(png::BitDepth::Eight);
        encoder.write_header()?.write_image_data(&pixels)?;
        prune(&dir)?;
        Ok(path)
    }
}
fn prune(dir: &Path) -> io::Result<()> {
    let mut files: Vec<_> = fs::read_dir(dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| Some((entry.metadata().ok()?.modified().ok()?, entry.path())))
        .collect();
    files.sort_by_key(|(mtime, _)| *mtime);
    let excess = files.len().saturating_sub(150);
    for (_, path) in files.into_iter().take(excess) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::BufReader;
    use zbus::zvariant::Value as Variant;

    #[test]
    fn padded_rgb_and_rgba_match_the_original_pixbuf_decoder() {
        let dir = std::env::temp_dir().join(format!(
            "nidara-image-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = Store { dir: dir.clone() };
        for (alpha, stride, data, pixels, color) in [
            (
                false,
                4,
                vec![220u8, 64, 200, 0, 10, 20, 30],
                vec![220, 64, 200, 10, 20, 30],
                png::ColorType::Rgb,
            ),
            (
                true,
                5,
                vec![220, 64, 200, 80, 0, 10, 20, 30, 40],
                vec![220, 64, 200, 80, 10, 20, 30, 40],
                png::ColorType::Rgba,
            ),
        ] {
            // channels is deliberately inconsistent: the old Pixbuf decoder uses
            // has-alpha, and ignores this redundant sender field.
            let hint = OwnedValue::try_from(Variant::from((
                1i32, 2i32, stride, alpha, 8i32, 99i32, data,
            )))
            .unwrap();
            let path = store.decode_image(&hint).unwrap();
            let decoder = png::Decoder::new(BufReader::new(fs::File::open(path).unwrap()));
            let mut reader = decoder.read_info().unwrap();
            let mut output = vec![0; reader.output_buffer_size().unwrap()];
            let info = reader.next_frame(&mut output).unwrap();
            assert_eq!((info.width, info.height, info.color_type), (1, 2, color));
            assert_eq!(&output[..info.buffer_size()], pixels);
        }
        let unsupported = OwnedValue::try_from(Variant::from((
            1i32,
            1i32,
            3i32,
            false,
            16i32,
            3i32,
            vec![1u8, 2, 3],
        )))
        .unwrap();
        assert!(store.decode_image(&unsupported).is_err());
        let short = OwnedValue::try_from(Variant::from((
            1i32,
            2i32,
            3i32,
            false,
            8i32,
            3i32,
            vec![1u8],
        )))
        .unwrap();
        assert!(store.decode_image(&short).is_err());
        fs::remove_dir_all(dir).unwrap();
    }
}
