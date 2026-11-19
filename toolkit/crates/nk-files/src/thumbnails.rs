// SPDX-License-Identifier: LGPL-3.0-or-later
//! Thumbnail interoperability with the desktop cache. Call from a worker.
use crate::{Sources, file_uri};
use image::{ImageReader, RgbaImage};
use std::{
    fs::{self, File, OpenOptions},
    io::{self, BufReader, Cursor, Read},
    os::unix::fs::{DirBuilderExt, OpenOptionsExt},
    path::Path,
    time::UNIX_EPOCH,
};

const MAX_SOURCE_BYTES: u64 = 48 * 1024 * 1024;
const MAX_THUMB_BYTES: u64 = 2 * 1024 * 1024;

pub struct Preview {
    pub width: u16,
    pub height: u16,
    pub rgba: Vec<u8>,
}

impl Sources {
    /// Read a fresh cached thumbnail or generate it in the shared cache. The
    /// preview still works when the cache is unwritable.
    pub fn preview(&self, path: &Path, large: bool) -> Option<Preview> {
        let uri = file_uri(path)?;
        let source = open_regular(path)?;
        let metadata = source.metadata().ok()?;
        let stamp = metadata.modified().ok()?.duration_since(UNIX_EPOCH).ok()?;
        let mtime = stamp.as_secs().to_string();
        let side = if large { 256 } else { 128 };
        let dir = self
            .cache
            .join("thumbnails")
            .join(if large { "large" } else { "normal" });
        let cached = dir.join(format!("{:x}.png", md5::compute(&uri)));
        if let Some(image) = read_cached(&cached, &uri, &mtime, side) {
            return Some(as_preview(image));
        }
        if metadata.len() > MAX_SOURCE_BYTES {
            return None;
        }
        let mut bytes = Vec::new();
        source
            .take(MAX_SOURCE_BYTES + 1)
            .read_to_end(&mut bytes)
            .ok()?;
        if bytes.len() as u64 > MAX_SOURCE_BYTES {
            return None;
        }
        let decoded = image(&bytes, 8192)?;
        let image = if decoded.width().max(decoded.height()) > side {
            decoded.thumbnail(side, side).into_rgba8()
        } else {
            decoded.into_rgba8()
        };
        // Reject a stale result if a writer modified or replaced the file before
        // we published. Readers also validate the metadata on every lookup.
        use std::os::unix::fs::MetadataExt;
        let after = path.metadata().ok()?;
        if after.ino() != metadata.ino()
            || after.dev() != metadata.dev()
            || after.len() != metadata.len()
            || after.modified().ok()? != UNIX_EPOCH + stamp
        {
            return None;
        }
        let _ = write_cache(&cached, &image, uri, mtime);
        Some(as_preview(image))
    }
}

fn as_preview(image: RgbaImage) -> Preview {
    Preview {
        width: image.width() as u16,
        height: image.height() as u16,
        rgba: image.into_raw(),
    }
}

fn image(bytes: &[u8], max_side: u32) -> Option<image::DynamicImage> {
    let mut reader = ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .ok()?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(max_side);
    limits.max_image_height = Some(max_side);
    limits.max_alloc = Some(96 * 1024 * 1024);
    reader.limits(limits);
    reader.decode().ok()
}

fn open_regular(path: &Path) -> Option<File> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    file.metadata().ok()?.is_file().then_some(file)
}

fn read_cached(path: &Path, uri: &str, mtime: &str, side: u32) -> Option<RgbaImage> {
    let mut bytes = Vec::new();
    open_regular(path)?
        .take(MAX_THUMB_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() as u64 > MAX_THUMB_BYTES {
        return None;
    }
    let info = png::Decoder::new(BufReader::new(Cursor::new(&bytes)))
        .read_info()
        .ok()?;
    let metadata = &info.info().uncompressed_latin1_text;
    let matches = |key, value| {
        metadata
            .iter()
            .any(|item| item.keyword == key && item.text == value)
    };
    if !matches("Thumb::URI", uri) || !matches("Thumb::MTime", mtime) {
        return None;
    }
    Some(image(&bytes, side)?.to_rgba8())
}

fn write_cache(path: &Path, image: &RgbaImage, uri: String, mtime: String) -> io::Result<()> {
    let dir = path.parent().expect("cache directory");
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(dir)?;
    let mut output = tempfile::NamedTempFile::new_in(dir)?;
    {
        let mut encoder = png::Encoder::new(output.as_file_mut(), image.width(), image.height());
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.add_text_chunk("Thumb::URI".into(), uri)?;
        encoder.add_text_chunk("Thumb::MTime".into(), mtime)?;
        encoder.write_header()?.write_image_data(image.as_raw())?;
    }
    output.persist(path)?;
    Ok(())
}

#[cfg(test)]
#[test]
fn stale_png_is_refreshed_with_the_shared_uri_and_mtime() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let sources = Sources {
        home: root.into(),
        config: root.into(),
        data: root.into(),
        cache: root.join("cache"),
        mountinfo: root.join("mountinfo"),
        media: None,
    };
    let path = root.join("a [photo].png");
    let original = RgbaImage::from_pixel(8, 5, image::Rgba([7, 13, 19, 255]));
    original.save(&path).unwrap();
    let uri = format!("file://{}/a%20%5Bphoto%5D.png", root.display());
    let cached = sources
        .cache
        .join("thumbnails/normal")
        .join(format!("{:x}.png", md5::compute(&uri)));
    let stale = RgbaImage::from_pixel(1, 1, image::Rgba([255, 0, 0, 255]));
    write_cache(&cached, &stale, uri.clone(), "1".into()).unwrap();
    let preview = sources.preview(&path, false).unwrap();
    assert_eq!((preview.width, preview.height), (8, 5));
    assert_eq!(preview.rgba, original.as_raw().as_slice());
    let mtime = path
        .metadata()
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();
    assert!(read_cached(&cached, &uri, &mtime, 128).is_some());
}
