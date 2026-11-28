//! The wallpaper, drawn by Hyalo itself (#1044): one picture per output, under every layer and
//! every window, in the session's frame and in the locked one. No client draws it, so there is
//! nothing to start, to wait for or to stop in order, and the glass refracts a picture Hyalo
//! already holds.
//!
//! **Whose choice it is.** The user's wallpaper is `~/.config/nidara/wallpaper` (JSON, `path`),
//! which the session's Config1 owns. Hyalo reads it once when it starts, so the first frame has
//! the picture, and after that is told of each change over IPC (`wallpaper`, from
//! `nidara-sessiond`). A file that is missing or cannot be read shows the shipped default,
//! never a bare background.
//!
//! **How it is drawn.** The file is decoded and scaled to cover the output (the middle kept,
//! what does not fit cut off), at the output's own size in pixels: one buffer per output, as
//! large as the screen and no larger. An output's first picture is decoded where it is first
//! drawn, so that frame shows it; every later one (another wallpaper, another size) is decoded
//! on a thread of its own and swapped in when ready, the one before it shown until then.
//!
//! **Changing it.** The new picture fades in over the old one (`[animations] fade`), or
//! replaces it at once with the transition `none` or with motion reduced. An animated file
//! shows its first frame.
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

use smithay::{
    backend::{
        allocator::Fourcc,
        renderer::element::{
            Kind,
            memory::{MemoryRenderBuffer, MemoryRenderBufferRenderElement},
        },
    },
    output::Output,
    reexports::calloop::ping::Ping,
    utils::{Logical, Physical, Rectangle, Size, Transform},
};

use super::HyaloRenderer;

/// What is shown when the user's choice is missing or cannot be read.
pub const DEFAULT: &str = "/usr/share/nidara/wallpaper.jpg";

/// How a new wallpaper replaces the one shown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Transition {
    None,
    Fade,
}

impl Transition {
    /// By the name Config1 keeps (`wallpaper.transition`). Every name but `none` fades until
    /// the set of transitions is decided (#1044).
    pub fn named(name: &str) -> Self {
        if name == "none" { Self::None } else { Self::Fade }
    }
}

/// The wallpaper asked for. `serial` tells one request from the next, the same file included.
struct Want {
    path: PathBuf,
    /// When the file was last written: the same path can come to hold another picture.
    written: Option<std::time::SystemTime>,
    fade: Option<Duration>,
    serial: u64,
}

/// A decoded picture for one output, or `None` when neither the file nor the default decoded.
struct Decoded {
    serial: u64,
    size: (i32, i32),
    bgra: Option<Vec<u8>>,
}

#[derive(Default)]
struct Shared {
    want: Option<Want>,
    /// By output name: what a decoding thread brought, until that output's next frame takes it.
    ready: HashMap<String, Decoded>,
    /// Outputs a thread is decoding for.
    pending: HashSet<String>,
    /// Asks the event loop for a frame once a picture is ready.
    wake: Option<Ping>,
}

static SHARED: LazyLock<Mutex<Shared>> = LazyLock::new(Default::default);

struct Layer {
    buffer: MemoryRenderBuffer,
    serial: u64,
    size: (i32, i32),
}

/// What one output shows, kept in its user data.
#[derive(Default)]
struct Shown {
    now: Option<Layer>,
    /// The picture being faded out from under `now`.
    before: Option<Layer>,
    fade: Option<(Instant, Duration)>,
    /// A request and size nothing could be decoded for: not tried again each frame.
    failed: Option<(u64, (i32, i32))>,
}

struct ShownData(Mutex<Shown>);

/// The path in the user's wallpaper file, if it names one.
fn saved_path(text: &str) -> Option<PathBuf> {
    let json: serde_json::Value = serde_json::from_str(text).ok()?;
    let path = json.get("path")?.as_str()?;
    let path = path.strip_prefix("file://").unwrap_or(path);
    Some(PathBuf::from(path)).filter(|p| p.is_absolute())
}

/// The user's wallpaper as saved, or the default. `HYALO_WALLPAPER` names another, for a
/// nested Hyalo whose home is a throwaway one (hyalo/scripts/sandboxed-shell.sh).
pub fn saved() -> PathBuf {
    if let Some(path) = std::env::var_os("HYALO_WALLPAPER").map(PathBuf::from).filter(|p| p.is_absolute()) {
        return path;
    }
    // The login screen shows the system's wallpaper, not the login user's (#1195 L5).
    if crate::login_mode() {
        return PathBuf::from(DEFAULT);
    }
    let file = crate::config::user_config_path().with_file_name("wallpaper");
    std::fs::read_to_string(file)
        .ok()
        .and_then(|text| saved_path(&text))
        .filter(|p| p.is_file())
        .unwrap_or_else(|| PathBuf::from(DEFAULT))
}

/// Once, when Hyalo starts: the saved wallpaper is the one to show, with no transition.
pub fn init(wake: Ping) {
    let mut shared = SHARED.lock().unwrap();
    shared.wake = Some(wake);
    let path = saved();
    shared.want = Some(Want { written: written(&path), path, fade: None, serial: 1 });
}

fn written(path: &Path) -> Option<std::time::SystemTime> {
    std::fs::metadata(path).and_then(|m| m.modified()).ok()
}

/// Another wallpaper, from now on. `fade` is how long a fade takes. The file already shown,
/// unchanged, is not decoded again: the session restates its settings when outputs change.
pub fn set(path: PathBuf, transition: Transition, fade: Duration) {
    let mut shared = SHARED.lock().unwrap();
    let written = written(&path);
    if shared.want.as_ref().is_some_and(|w| w.path == path && w.written == written) {
        return;
    }
    let serial = shared.want.as_ref().map_or(1, |w| w.serial + 1);
    shared.want = Some(Want { path, written, fade: (transition == Transition::Fade).then_some(fade), serial });
}

/// `path` scaled to cover `size`, as the bytes of an opaque Argb8888 buffer. Falls back to
/// `default` when `path` cannot be read; `None` when neither can.
fn decode(path: &Path, default: &Path, (w, h): (i32, i32)) -> Option<Vec<u8>> {
    let read = |p: &Path| -> Result<image::RgbaImage, String> {
        use image::ImageDecoder;
        let reader = image::ImageReader::open(p).map_err(|e| e.to_string())?.with_guessed_format().map_err(|e| e.to_string())?;
        let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
        // A photograph says which way up it is in its metadata, not in its pixels.
        let orientation = decoder.orientation().map_err(|e| e.to_string())?;
        let mut picture = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
        picture.apply_orientation(orientation);
        Ok(picture.resize_to_fill(w as u32, h as u32, image::imageops::FilterType::CatmullRom).into_rgba8())
    };
    let picture = match read(path) {
        Ok(p) => p,
        Err(err) => {
            tracing::warn!(?path, %err, "wallpaper not read, showing the default");
            if path == default {
                return None;
            }
            match read(default) {
                Ok(p) => p,
                Err(err) => {
                    tracing::warn!(path = ?default, %err, "default wallpaper not read");
                    return None;
                }
            }
        }
    };
    let mut bytes = picture.into_raw();
    // RGBA in the file's order to little-endian ARGB, and opaque whatever the file says.
    for px in bytes.as_chunks_mut::<4>().0 {
        px.swap(0, 2);
        px[3] = 255;
    }
    Some(bytes)
}

fn layer(bgra: &[u8], serial: u64, size: (i32, i32)) -> Layer {
    let opaque = vec![Rectangle::from_size(Size::from(size))];
    Layer { buffer: MemoryRenderBuffer::from_slice(bgra, Fourcc::Argb8888, size, 1, Transform::Normal, Some(opaque)), serial, size }
}

/// The wallpaper on `output`, front to back: the picture, and under it the one it is
/// replacing while it fades in. `logical` is the output's size in the layout, `physical` the
/// same in its own pixels; `at` is where the output's top left corner lands in the target,
/// its pixels (0,0 on the output itself; a window capture moves it, capture.rs); `when` is
/// the moment the frame shows.
#[allow(clippy::too_many_arguments)]
pub fn elements<R: HyaloRenderer>(
    renderer: &mut R,
    output: &Output,
    logical: Size<i32, Logical>,
    physical: Size<i32, Physical>,
    at: smithay::utils::Point<f64, Physical>,
    when: Instant,
    reduce_motion: bool,
) -> Vec<MemoryRenderBufferRenderElement<R>> {
    let size = (physical.w, physical.h);
    if size.0 <= 0 || size.1 <= 0 {
        return Vec::new();
    }
    let name = output.name();
    output.user_data().insert_if_missing(|| ShownData(Mutex::new(Shown::default())));
    let mut shown = output.user_data().get::<ShownData>().unwrap().0.lock().unwrap();

    let mut arrived = None;
    let mut first = None;
    {
        let mut shared = SHARED.lock().unwrap();
        let Some((path, serial, fade)) = shared.want.as_ref().map(|w| (w.path.clone(), w.serial, w.fade)) else {
            return Vec::new();
        };
        // What a thread brought for an older request or another size is dropped.
        if let Some(d) = shared.ready.remove(&name).filter(|d| d.serial == serial && d.size == size) {
            arrived = Some((d, fade));
        }
        let have = shown.now.as_ref().map(|l| (l.serial, l.size));
        let wanted = Some((serial, size));
        if arrived.is_none() && have != wanted && shown.failed != wanted && !shared.pending.contains(&name) {
            if shown.now.is_none() {
                first = Some((path, serial));
            } else {
                shared.pending.insert(name.clone());
                let wake = shared.wake.clone();
                let output = name.clone();
                std::thread::spawn(move || {
                    let bgra = decode(&path, Path::new(DEFAULT), size);
                    let mut shared = SHARED.lock().unwrap();
                    shared.pending.remove(&output);
                    shared.ready.insert(output, Decoded { serial, size, bgra });
                    if let Some(wake) = wake {
                        wake.ping();
                    }
                });
            }
        }
    }
    // An output's first picture, decoded here: the frame being built is the one that shows it.
    if let Some((path, serial)) = first {
        arrived = Some((Decoded { serial, size, bgra: decode(&path, Path::new(DEFAULT), size) }, None));
    }
    if let Some((decoded, fade)) = arrived {
        match decoded.bgra {
            Some(bgra) => {
                let old = shown.now.replace(layer(&bgra, decoded.serial, size));
                shown.failed = None;
                // A fade is between two pictures of one size: after a change of mode or scale
                // the new one is simply shown.
                match (old, fade.filter(|_| !reduce_motion)) {
                    (Some(old), Some(duration)) if old.size == size && !duration.is_zero() => {
                        shown.before = Some(old);
                        shown.fade = Some((when, duration));
                    }
                    _ => {
                        shown.before = None;
                        shown.fade = None;
                    }
                }
            }
            None => shown.failed = Some((decoded.serial, size)),
        }
    }

    let progress = match shown.fade {
        Some((start, duration)) => {
            let t = when.saturating_duration_since(start).as_secs_f64() / duration.as_secs_f64();
            if t >= 1.0 {
                shown.before = None;
                shown.fade = None;
                1.0
            } else {
                t
            }
        }
        None => 1.0,
    };
    let mut out = Vec::new();
    // Drawn at the output's size whatever the buffer's: a picture of the size before a mode
    // change is stretched for the frames its replacement takes to decode.
    let mut push = |l: &Layer, alpha: Option<f32>| match MemoryRenderBufferRenderElement::from_buffer(renderer, at, &l.buffer, alpha, None, Some(logical), Kind::Unspecified) {
        Ok(e) => out.push(e),
        Err(err) => tracing::warn!(?err, "wallpaper not drawn"),
    };
    if let Some(l) = &shown.now {
        push(l, (progress < 1.0).then_some(progress as f32));
    }
    if let Some(l) = &shown.before {
        push(l, None);
    }
    out
}

/// Is `output`'s wallpaper fading from one picture to another (a frame until it settles)?
pub fn animating(output: &Output) -> bool {
    output.user_data().get::<ShownData>().is_some_and(|s| s.0.lock().unwrap().fade.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_saved_file_names_an_absolute_path_or_nothing() {
        assert_eq!(saved_path(r#"{"path":"/home/u/a b.jpg","transition":"random"}"#), Some(PathBuf::from("/home/u/a b.jpg")));
        assert_eq!(saved_path(r#"{"path":"file:///home/u/a.png"}"#), Some(PathBuf::from("/home/u/a.png")));
        assert_eq!(saved_path(r#"{"path":"relative.png"}"#), None);
        assert_eq!(saved_path(r#"{"transition":"fade"}"#), None);
        assert_eq!(saved_path("not json"), None);
    }

    #[test]
    fn every_transition_but_none_fades() {
        assert_eq!(Transition::named("none"), Transition::None);
        for name in ["random", "fade", "simple", "wipe", ""] {
            assert_eq!(Transition::named(name), Transition::Fade);
        }
    }

    /// A directory of this test's own under the build's, not the machine's temporary one.
    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../target/wallpaper-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A picture `w` by `h`: red on its left half, blue on its right, half transparent.
    fn picture(path: &Path, w: u32, h: u32) {
        let img = image::RgbaImage::from_fn(w, h, |x, _| if x < w / 2 { image::Rgba([255, 0, 0, 128]) } else { image::Rgba([0, 0, 255, 128]) });
        img.save(path).unwrap();
    }

    #[test]
    fn a_picture_covers_the_output_keeping_its_middle_and_is_opaque() {
        let dir = scratch("cover");
        let file = dir.join("wide.png");
        // Four times as wide as the output is: the middle half is kept, a quarter cut each side.
        picture(&file, 400, 50);
        let bytes = decode(&file, &dir.join("none.png"), (100, 50)).expect("decoded");
        assert_eq!(bytes.len(), 100 * 50 * 4);
        let px = |x: usize, y: usize| &bytes[(y * 100 + x) * 4..][..4];
        // Blue, green, red, alpha: the left is still red and the right blue, both opaque.
        assert_eq!(px(5, 25), [0, 0, 255, 255]);
        assert_eq!(px(94, 25), [255, 0, 0, 255]);
    }

    #[test]
    fn a_file_that_cannot_be_read_shows_the_default_and_nothing_when_that_fails_too() {
        let dir = scratch("fallback");
        let default = dir.join("default.png");
        picture(&default, 20, 20);
        let broken = dir.join("broken.jpg");
        std::fs::write(&broken, b"not a picture").unwrap();
        for missing in [dir.join("gone.png"), broken] {
            let bytes = decode(&missing, &default, (20, 20)).expect("the default");
            assert_eq!(&bytes[..4], [0, 0, 255, 255]);
            assert!(decode(&missing, &dir.join("no-default.png"), (20, 20)).is_none());
        }
    }
}
