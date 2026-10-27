// SPDX-License-Identifier: GPL-3.0-or-later
//! XDG sound-theme lookup and bounded PCM decoding, exclusively outside realtime.
//! https://specifications.freedesktop.org/sound-theme/latest/sound_lookup.html
use super::Error;
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Cursor, Read},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::SystemTime,
};
const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_SECONDS: usize = 10;
const MAX_RATE: u32 = 48000;
const MAX_CHANNELS: usize = 2;
const MAX_INDEX: u64 = 64 * 1024;
const EVENTS: &[&str] = &[
    "message-new-instant",
    "dialog-warning",
    "dialog-error",
    "complete",
    "audio-volume-change",
];
#[derive(Debug)]
pub struct Clip {
    pub rate: u32,
    pub channels: usize,
    pub samples: Vec<f32>,
}
impl Clip {
    pub fn duration(&self) -> std::time::Duration {
        std::time::Duration::from_secs_f64(
            self.samples.len() as f64 / self.channels as f64 / self.rate as f64,
        )
    }
}
fn component(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.len() <= 128
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-@.".contains(&b))
}
fn directory(s: &str) -> bool {
    s == "." || (!s.is_empty() && s.len() <= 256 && s.split('/').all(component))
}
fn bases() -> Vec<PathBuf> {
    let mut result = Vec::new();
    if let Some(home) = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        result.push(home.join("sounds"));
    } else if let Some(home) = std::env::var_os("HOME") {
        result.push(PathBuf::from(home).join(".local/share/sounds"));
    }
    let dirs = std::env::var_os("XDG_DATA_DIRS")
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/usr/local/share:/usr/share".into());
    result.extend(
        std::env::split_paths(&dirs)
            .filter(|p| p.is_absolute())
            .map(|p| p.join("sounds")),
    );
    result.truncate(32);
    result
}
fn locales() -> Vec<String> {
    let locale = ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .find_map(|k| std::env::var(k).ok().filter(|s| !s.is_empty()))
        .unwrap_or("C".into());
    let (base, modifier) = locale
        .split_once('@')
        .map_or((locale.as_str(), None), |(a, b)| (a, Some(b)));
    let base = base.split('.').next().unwrap_or("C");
    let mut out = Vec::new();
    if let Some(m) = modifier {
        let name = format!("{base}@{m}");
        if component(&name) {
            out.push(name);
        }
    }
    if component(base) {
        out.push(base.to_string());
        if let Some((language, _)) = base.split_once('_') {
            out.push(language.into());
        }
    }
    out.extend(["C".into(), String::new()]);
    out.dedup();
    out
}
type Ini = BTreeMap<String, BTreeMap<String, String>>;
fn index(path: &Path) -> Option<Ini> {
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.take(MAX_INDEX + 1).read_to_string(&mut text).ok()?;
    if text.len() as u64 > MAX_INDEX {
        return None;
    }
    let mut sections = Ini::new();
    let mut group = String::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        if let Some(name) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            group = name.to_string();
        } else if let Some((k, v)) = line.split_once('=') {
            sections
                .entry(group.clone())
                .or_default()
                .insert(k.trim().into(), v.trim().into());
        }
    }
    sections.contains_key("Sound Theme").then_some(sections)
}
fn list(s: Option<&String>) -> Vec<String> {
    s.map(|s| {
        s.split([',', ';'])
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .take(64)
            .map(str::to_string)
            .collect()
    })
    .unwrap_or_default()
}
#[derive(Debug, PartialEq)]
enum Found {
    Missing,
    Disabled,
    File(PathBuf),
}
fn names(event: &str) -> Vec<&str> {
    let mut out = vec![event];
    let mut name = event;
    while let Some((stem, _)) = name.rsplit_once('-') {
        out.push(stem);
        name = stem;
    }
    out
}
fn lookup_dirs(
    roots: &[PathBuf],
    theme: &str,
    dirs: &[(String, String)],
    event: &str,
    locale: &[String],
) -> Found {
    // This daemon renders theme sounds as mono/stereo; PW remixes into the target.
    for profile in ["stereo", ""] {
        for (dir, p) in dirs.iter().filter(|(_, p)| p == profile) {
            let _ = p;
            for root in roots {
                for name in names(event) {
                    for language in locale {
                        let folder = root.join(theme).join(dir).join(language);
                        if folder.join(format!("{name}.disabled")).is_file() {
                            return Found::Disabled;
                        }
                        for extension in ["oga", "ogg", "wav"] {
                            let file = folder.join(format!("{name}.{extension}"));
                            if file.is_file() {
                                return Found::File(file);
                            }
                        }
                    }
                }
            }
        }
    }
    Found::Missing
}
fn theme(
    roots: &[PathBuf],
    name: &str,
    event: &str,
    locale: &[String],
    visited: &mut BTreeSet<String>,
) -> Found {
    if !component(name) || visited.len() >= 32 || !visited.insert(name.into()) {
        return Found::Missing;
    }
    let Some(config) = roots
        .iter()
        .find_map(|r| index(&r.join(name).join("index.theme")))
    else {
        return Found::Missing;
    };
    let head = &config["Sound Theme"];
    let dirs = list(head.get("Directories"))
        .into_iter()
        .filter(|s| directory(s))
        .map(|s| {
            let profile = config
                .get(&s)
                .and_then(|g| g.get("OutputProfile"))
                .cloned()
                .unwrap_or_default();
            (s, profile)
        })
        .collect::<Vec<_>>();
    let found = lookup_dirs(roots, name, &dirs, event, locale);
    if found != Found::Missing {
        return found;
    }
    for parent in list(head.get("Inherits")) {
        let found = theme(roots, &parent, event, locale, visited);
        if found != Found::Missing {
            return found;
        }
    }
    Found::Missing
}
fn lookup(roots: &[PathBuf], selected: &str, event: &str, locale: &[String]) -> Found {
    let mut visited = BTreeSet::new();
    let found = theme(roots, selected, event, locale, &mut visited);
    if found != Found::Missing {
        return found;
    }
    if selected != "freedesktop" {
        let found = theme(roots, "freedesktop", event, locale, &mut visited);
        if found != Found::Missing {
            return found;
        }
    }
    lookup_dirs(roots, "", &[(String::new(), String::new())], event, locale)
}
fn limits(rate: u32, channels: usize) -> Result<usize, String> {
    if !(8000..=MAX_RATE).contains(&rate) || !(1..=MAX_CHANNELS).contains(&channels) {
        return Err("sound rate/channels exceed supported limits".into());
    }
    Ok(rate as usize * MAX_SECONDS * channels)
}
fn decode(bytes: Vec<u8>, extension: &str) -> Result<Clip, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err("encoded sound exceeds 2 MiB".into());
    }
    let mut samples = Vec::new();
    let (rate, channels);
    if matches!(extension, "oga" | "ogg") {
        let mut reader = lewton::inside_ogg::OggStreamReader::new(Cursor::new(bytes))
            .map_err(|e| format!("invalid Vorbis sound: {e}"))?;
        rate = reader.ident_hdr.audio_sample_rate;
        channels = reader.ident_hdr.audio_channels as usize;
        let max = limits(rate, channels)?;
        while let Some(packet) = reader
            .read_dec_packet_itl()
            .map_err(|e| format!("invalid Vorbis packet: {e}"))?
        {
            if reader.ident_hdr.audio_channels as usize != channels
                || reader.ident_hdr.audio_sample_rate != rate
            {
                return Err("chained Vorbis format change is unsupported".into());
            }
            if samples.len().saturating_add(packet.len()) > max {
                return Err("decoded sound exceeds 10 seconds".into());
            }
            samples.extend(packet.into_iter().map(|s| s as f32 / 32768.0));
        }
    } else if extension == "wav" {
        let mut reader = hound::WavReader::new(Cursor::new(bytes))
            .map_err(|e| format!("invalid WAV sound: {e}"))?;
        let spec = reader.spec();
        rate = spec.sample_rate;
        channels = spec.channels as usize;
        let max = limits(rate, channels)?;
        if reader.len() as usize > max {
            return Err("decoded sound exceeds 10 seconds".into());
        }
        if spec.sample_format == hound::SampleFormat::Float && spec.bits_per_sample == 32 {
            for sample in reader.samples::<f32>() {
                if samples.len() >= max {
                    return Err("decoded sound exceeds 10 seconds".into());
                }
                let value = sample.map_err(|e| e.to_string())?;
                if !value.is_finite() {
                    return Err("non-finite WAV sample".into());
                }
                samples.push(value.clamp(-1.0, 1.0));
            }
        } else if spec.sample_format == hound::SampleFormat::Int
            && (1..=32).contains(&spec.bits_per_sample)
        {
            let divisor = 2_f32.powi(spec.bits_per_sample as i32 - 1);
            for sample in reader.samples::<i32>() {
                if samples.len() >= max {
                    return Err("decoded sound exceeds 10 seconds".into());
                }
                samples
                    .push((sample.map_err(|e| e.to_string())? as f32 / divisor).clamp(-1.0, 1.0));
            }
        } else {
            return Err("unsupported WAV encoding".into());
        }
    } else {
        return Err("unsupported sound extension".into());
    }
    if samples.is_empty() || samples.len() % channels != 0 {
        return Err("empty or partial PCM sound".into());
    }
    Ok(Clip {
        rate,
        channels,
        samples,
    })
}
struct Cached {
    modified: Option<SystemTime>,
    bytes: u64,
    clip: Arc<Clip>,
}
fn load(selected: &str, event: &str) -> Result<Arc<Clip>, Error> {
    if !EVENTS.contains(&event) {
        return Err(Error::InvalidArgument("unknown XDG sound event".into()));
    }
    if !component(selected) {
        return Err(Error::InvalidArgument("invalid sound theme name".into()));
    }
    let file = match lookup(&bases(), selected, event, &locales()) {
        Found::File(file) => file,
        Found::Disabled => return Err(Error::NotSupported("sound disabled by theme".into())),
        Found::Missing => return Err(Error::NotSupported("sound absent from XDG theme".into())),
    };
    let mut input = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(&file)
        .map_err(|_| Error::Failed("cannot open theme sound".into()))?;
    let metadata = input
        .metadata()
        .map_err(|_| Error::Failed("cannot inspect theme sound".into()))?;
    if !metadata.is_file() || metadata.len() > MAX_BYTES {
        return Err(Error::Failed(
            "theme sound is not a regular file within 2 MiB".into(),
        ));
    }
    static CACHE: OnceLock<Mutex<BTreeMap<PathBuf, Cached>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Mutex::default);
    if let Some(c) = cache
        .lock()
        .unwrap()
        .get(&file)
        .filter(|c| c.modified == metadata.modified().ok() && c.bytes == metadata.len())
    {
        return Ok(c.clip.clone());
    }
    let mut bytes = Vec::new();
    input
        .by_ref()
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Error::Failed("cannot read theme sound".into()))?;
    let extension = file
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or_default();
    let clip = Arc::new(decode(bytes, extension).map_err(Error::Failed)?);
    let mut cache = cache.lock().unwrap();
    if cache.len() >= 16 {
        cache.pop_first();
    }
    cache.insert(
        file,
        Cached {
            modified: metadata.modified().ok(),
            bytes: metadata.len(),
            clip: clip.clone(),
        },
    );
    Ok(clip)
}
pub async fn resolve(selected: String, event: String) -> Result<Arc<Clip>, Error> {
    static DECODERS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = DECODERS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(2)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| Error::Busy("sound decoders busy".into()))?;
    tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::task::spawn_blocking(move || {
            let _permit = permit;
            load(&selected, &event)
        }),
    )
    .await
    .map_err(|_| Error::Timeout("sound decoder deadline exceeded".into()))?
    .map_err(|_| Error::Failed("sound decoder stopped".into()))?
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../target/audio-theme-tests")
                .join(format!(
                    "{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
                ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
        fn put(&self, name: &str, data: &[u8]) -> PathBuf {
            let p = self.0.join(name);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(&p, data).unwrap();
            p
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn lookup_honors_inheritance_suffix_locale_disabled_and_base_precedence() {
        let f = Fixture::new();
        let roots = vec![f.0.join("user"), f.0.join("system")];
        let loc = vec!["es_ES".into(), "es".into(), "C".into(), "".into()];
        f.put(
            "user/child/index.theme",
            b"[Sound Theme]\nDirectories=stereo\nInherits=parent\n[stereo]\nOutputProfile=stereo\n",
        );
        f.put(
            "system/parent/index.theme",
            b"[Sound Theme]\nDirectories=stereo\nInherits=child\n[stereo]\nOutputProfile=stereo\n",
        );
        let parent = f.put("system/parent/stereo/message-new-instant.wav", b"x");
        assert_eq!(
            lookup(&roots, "child", "message-new-instant", &loc),
            Found::File(parent)
        );
        let user = f.put("user/child/stereo/es/message.ogg", b"y");
        assert_eq!(
            lookup(&roots, "child", "message-new-instant", &loc),
            Found::File(user)
        );
        f.put("user/child/stereo/es/message.disabled", b"");
        assert_eq!(
            lookup(&roots, "child", "message-new-instant", &loc),
            Found::Disabled
        );
        assert_eq!(lookup(&roots, "child", "missing", &loc), Found::Missing);
        f.put(
            "system/freedesktop/index.theme",
            b"[Sound Theme]\nDirectories=stereo\n[stereo]\nOutputProfile=stereo\n",
        );
        f.put("system/freedesktop/stereo/dialog-error.oga", b"system");
        let custom = f.put("user/freedesktop/stereo/dialog-error.wav", b"override");
        assert_eq!(
            lookup(&roots, "absent-theme", "dialog-error", &loc),
            Found::File(custom)
        );
        let unthemed = f.put("system/complete.wav", b"unthemed");
        assert_eq!(
            lookup(&roots, "absent-theme", "complete", &loc),
            Found::File(unthemed)
        );

        assert!(!component("../bad"));
        assert!(!directory("stereo/../../etc"));
    }
    fn wav(rate: u32, seconds: usize) -> Vec<u8> {
        let mut out = Cursor::new(Vec::new());
        {
            let mut w = hound::WavWriter::new(
                &mut out,
                hound::WavSpec {
                    channels: 2,
                    sample_rate: rate,
                    bits_per_sample: 16,
                    sample_format: hound::SampleFormat::Int,
                },
            )
            .unwrap();
            for _ in 0..rate as usize * seconds {
                w.write_sample(16384_i16).unwrap();
                w.write_sample(-8192_i16).unwrap();
            }
            w.finalize().unwrap();
        }
        out.into_inner()
    }
    #[test]
    fn pcm_decode_is_normalized_and_bounded() {
        let clip = decode(wav(8000, 1), "wav").unwrap();
        assert_eq!(
            (clip.rate, clip.channels, clip.samples.len()),
            (8000, 2, 16000)
        );
        assert_eq!(&clip.samples[..2], &[0.5, -0.25]);
        assert!(decode(wav(8000, 11), "wav").is_err());
        assert!(decode(wav(1000, 1), "wav").is_err());
        assert!(decode(vec![0; (MAX_BYTES + 1) as usize], "wav").is_err());
        assert!(decode(vec![0; 32], "oga").is_err());
    }
}
