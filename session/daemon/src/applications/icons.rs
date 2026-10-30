// SPDX-License-Identifier: GPL-3.0-or-later
//! Full-colour application assets. Never uses nk-icons' monochrome UI parser.
use super::{
    Error,
    catalogue::{self, App},
};
use resvg::{tiny_skia, usvg};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};
pub type Pixels = (u32, u32, Vec<u8>);
fn safe_name(s: &str) -> bool {
    !s.is_empty() && !s.contains(['/', '\\', '\0']) && s != "." && s != ".."
}
fn overlay() -> PathBuf {
    catalogue::data_home().join("icons/nidara")
}
pub fn app_override(id: &str) -> PathBuf {
    overlay()
        .join("per-app")
        .join(format!("{}.png", catalogue::hash(id.as_bytes())))
}
fn raw_key(s: &str) -> String {
    if !s.starts_with('/') {
        return s.to_string();
    }
    let n = Path::new(s)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(s);
    let extension = Path::new(n)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if ["svg", "png", "xpm", "jpg"].contains(&extension.as_str()) {
        Path::new(n)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or(n)
            .into()
    } else {
        n.into()
    }
}

pub fn roots() -> Vec<PathBuf> {
    let mut v = vec![
        catalogue::data_home().join("icons"),
        catalogue::home().join(".icons"),
    ];
    v.extend(catalogue::data_dirs().into_iter().map(|p| p.join("icons")));
    v
}
/// Bounded recursive watches: GFileMonitor only covers direct children.
/// Asset metadata is fingerprinted on events, never scanned on an idle timer.
pub fn watches() -> (BTreeSet<PathBuf>, bool, String) {
    let mut pending = roots().into_iter().map(|p| (p, 0)).collect::<Vec<_>>();
    pending.extend(
        catalogue::data_dirs()
            .into_iter()
            .map(|p| (p.join("pixmaps"), 0)),
    );
    let mut seen = BTreeSet::new();
    let mut watches = BTreeSet::new();
    let mut complete = true;
    let mut inspected = 0;
    let mut signatures = Vec::new();
    while let Some((p, depth)) = pending.pop() {
        if watches.len() >= 4096 || depth > 16 || inspected >= 65536 {
            complete = false;
            break;
        }
        watches.insert(p.clone());
        let real = match p.canonicalize() {
            Ok(p) => p,
            Err(e) => {
                if e.kind() != std::io::ErrorKind::NotFound {
                    complete = false;
                }
                continue;
            }
        };
        if !seen.insert(real) {
            continue;
        }
        let entries = match fs::read_dir(&p) {
            Ok(e) => e,
            Err(_) => {
                complete = false;
                continue;
            }
        };
        for e in entries {
            inspected += 1;
            if inspected > 65536 {
                complete = false;
                break;
            }
            let Ok(e) = e else {
                complete = false;
                continue;
            };
            let Ok(m) = e.metadata() else {
                complete = false;
                continue;
            };
            let symlink = m.file_type().is_symlink();
            let m = if symlink {
                let Ok(target) = fs::metadata(e.path()) else {
                    complete = false;
                    continue;
                };
                target
            } else {
                m
            };
            if m.is_dir() {
                // Theme size directories are commonly symlinks. Canonical
                // deduplication above bounds cycles without losing their events.
                pending.push((e.path(), depth + 1));
            } else {
                if symlink
                    && let Ok(target) = e.path().canonicalize()
                    && let Some(parent) = target.parent()
                {
                    watches.insert(parent.to_owned());
                }
                signatures.push(format!(
                    "{}:{}:{:?}",
                    e.path().display(),
                    m.len(),
                    m.modified()
                ));
            }
        }
    }
    signatures.sort();
    (
        watches,
        complete,
        catalogue::hash(signatures.join(";").as_bytes()),
    )
}
pub fn resolve(app: &App, theme: &str, size: u32) -> Option<PathBuf> {
    let own = app_override(&app.id);
    if own.is_file() {
        return Some(own);
    }
    let key = raw_key(&app.icon);
    if safe_name(&key) {
        for ext in ["svg", "png"] {
            let p = overlay().join("scalable/apps").join(format!("{key}.{ext}"));
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let pwa = if app.id.to_lowercase().starts_with("chrome-") {
        app.icon
            .strip_suffix("-default")
            .map(|s| format!("{s}-Default"))
    } else {
        None
    };
    pwa.as_ref()
        .and_then(|n| resolve_name(n, theme, size))
        .or_else(|| resolve_name(&app.icon, theme, size))
        .or_else(|| {
            let id = app
                .icon
                .strip_prefix("steam_icon_")
                .or_else(|| app.icon.strip_prefix("steam_app_"))?;
            if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            for base in [
                catalogue::home().join(".local/share/Steam/appcache/librarycache"),
                catalogue::home().join(".steam/steam/appcache/librarycache"),
            ] {
                let Ok(dir) = fs::read_dir(base.join(id)) else {
                    continue;
                };
                let mut best = None;
                for entry in dir.take(256).flatten() {
                    let p = entry.path();
                    let Some(name) = p.file_stem().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    if name.len() == 40
                        && name.bytes().all(|b| b.is_ascii_hexdigit())
                        && p.extension().is_some_and(|e| e == "png" || e == "jpg")
                    {
                        let Ok(metadata) = entry.metadata() else {
                            continue;
                        };
                        if !metadata.is_file() {
                            continue;
                        }
                        let len = metadata.len();
                        if best.as_ref().is_none_or(|(n, _)| len < *n) {
                            best = Some((len, p));
                        }
                    }
                }
                if let Some((_, p)) = best {
                    return Some(p);
                }
            }
            None
        })
}
pub fn resolve_name(name: &str, theme: &str, size: u32) -> Option<PathBuf> {
    if name.starts_with("file:") {
        let (p, host) = glib::filename_from_uri(name).ok()?;
        return (host.is_none() && p.is_file()).then_some(p);
    }
    if name.starts_with('/') {
        return Path::new(name).is_file().then(|| PathBuf::from(name));
    }
    if !safe_name(name) {
        return None;
    }
    let roots = roots();
    let mut seen = BTreeSet::new();
    for theme in [theme, "hicolor"] {
        if let Some(p) = themed(name, theme, size, &roots, &mut seen, 0) {
            return Some(p);
        }
    }
    for base in catalogue::data_dirs() {
        for ext in ["png", "svg", "xpm", ""] {
            let p = base.join("pixmaps").join(if ext.is_empty() {
                name.to_string()
            } else {
                format!("{name}.{ext}")
            });
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}
fn themed(
    name: &str,
    theme: &str,
    size: u32,
    roots: &[PathBuf],
    seen: &mut BTreeSet<String>,
    depth: u32,
) -> Option<PathBuf> {
    if depth > 8 || seen.len() > 32 || !safe_name(theme) || !seen.insert(theme.into()) {
        return None;
    }
    let text = roots
        .iter()
        .find_map(|r| catalogue::bounded(&r.join(theme).join("index.theme"), 256 * 1024).ok())?;
    let k = glib::KeyFile::new();
    k.load_from_data(std::str::from_utf8(&text).ok()?, glib::KeyFileFlags::NONE)
        .ok()?;
    let list = |key| {
        k.string("Icon Theme", key)
            .unwrap_or_default()
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect::<Vec<_>>()
    };
    let mut candidates = vec![];
    for dir in list("Directories")
        .into_iter()
        .chain(list("ScaledDirectories"))
        .take(2048)
    {
        if Path::new(&dir)
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            continue;
        }
        let scale = k.integer(&dir, "Scale").unwrap_or(1).clamp(1, 8) as u32;
        let logical = k.integer(&dir, "Size").unwrap_or(48).clamp(1, 4096) as u32;
        let nominal = logical * scale;
        let kind = k.string(&dir, "Type").unwrap_or_default();
        let (lo, hi) = match kind.as_str() {
            "Scalable" => (
                k.integer(&dir, "MinSize")
                    .unwrap_or(logical as i32)
                    .clamp(1, 4096) as u32
                    * scale,
                k.integer(&dir, "MaxSize")
                    .unwrap_or(logical as i32)
                    .clamp(1, 4096) as u32
                    * scale,
            ),
            "Fixed" => (nominal, nominal),
            _ => (
                nominal.saturating_sub(
                    k.integer(&dir, "Threshold").unwrap_or(2).clamp(0, 4096) as u32 * scale,
                ),
                nominal.saturating_add(
                    k.integer(&dir, "Threshold").unwrap_or(2).clamp(0, 4096) as u32 * scale,
                ),
            ),
        };
        let distance = if size < lo {
            lo - size
        } else {
            size.saturating_sub(hi)
        };
        for base in roots {
            for ext in ["svg", "png", "xpm"] {
                let p = base.join(theme).join(&dir).join(format!("{name}.{ext}"));
                if p.is_file() {
                    candidates.push((distance, p));
                }
            }
        }
    }
    candidates.sort_by_key(|(d, _)| *d);
    if let Some((_, p)) = candidates.first() {
        return Some(p.clone());
    }
    for parent in list("Inherits") {
        if let Some(p) = themed(name, &parent, size, roots, seen, depth + 1) {
            return Some(p);
        }
    }
    None
}
pub fn decode(bytes: &[u8], side: u32) -> Result<Pixels, Error> {
    if bytes.len() > 16 * 1024 * 1024 || !(1..=1024).contains(&side) {
        return Err(Error::Invalid("icon size budget".into()));
    }
    let svg = std::str::from_utf8(bytes).is_ok_and(|s| {
        s.trim_start_matches('\u{feff}')
            .trim_start()
            .starts_with('<')
    });
    if svg {
        static FONTS: OnceLock<Arc<usvg::fontdb::Database>> = OnceLock::new();
        let fonts = FONTS
            .get_or_init(|| {
                let mut f = usvg::fontdb::Database::new();
                f.load_system_fonts();
                Arc::new(f)
            })
            .clone();
        let embedded = Arc::new(std::sync::atomic::AtomicU64::new(0));
        let rejected = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let data_rejected = rejected.clone();
        let string_rejected = rejected.clone();
        let data_resolver = usvg::ImageHrefResolver::default_data_resolver();
        let opt = usvg::Options {
            fontdb: fonts,
            image_href_resolver: usvg::ImageHrefResolver {
                resolve_data: Box::new(move |mime, data, options| {
                    use std::sync::atomic::Ordering;
                    let dimensions = image::ImageReader::new(std::io::Cursor::new(data.as_slice()))
                        .with_guessed_format()
                        .ok()
                        .and_then(|r| r.into_dimensions().ok());
                    let valid = dimensions.is_some_and(|(w, h)| {
                        w <= 4096 && h <= 4096 && u64::from(w) * u64::from(h) <= 16_000_000
                    });
                    let bytes = dimensions
                        .map(|(w, h)| u64::from(w) * u64::from(h) * 4)
                        .unwrap_or(u64::MAX);
                    if data.len() > 16 * 1024 * 1024
                        || !valid
                        || embedded
                            .fetch_add(bytes, Ordering::Relaxed)
                            .checked_add(bytes)
                            .is_none_or(|n| n > 64 * 1024 * 1024)
                    {
                        data_rejected.store(true, Ordering::Relaxed);
                        return None;
                    }
                    data_resolver(mime, data, options)
                }),
                resolve_string: Box::new(move |_, _| {
                    string_rejected.store(true, std::sync::atomic::Ordering::Relaxed);
                    None
                }),
            },
            ..Default::default()
        };
        let tree = usvg::Tree::from_data(bytes, &opt).map_err(|e| Error::Invalid(e.to_string()))?;
        if rejected.load(std::sync::atomic::Ordering::Relaxed) {
            return Err(Error::Invalid(
                "external or oversized embedded SVG resource".into(),
            ));
        }
        if tree.size().width() * tree.size().height() > 16_000_000.0 {
            return Err(Error::Invalid("SVG pixel budget".into()));
        }
        let mut pix = tiny_skia::Pixmap::new(side, side)
            .ok_or_else(|| Error::Failed("icon allocation".into()))?;
        let scale = (side as f32 / tree.size().width()).min(side as f32 / tree.size().height());
        let tr = tiny_skia::Transform::from_translate(
            (side as f32 - tree.size().width() * scale) / 2.0,
            (side as f32 - tree.size().height() * scale) / 2.0,
        )
        .pre_scale(scale, scale);
        resvg::render(&tree, tr, &mut pix.as_mut());
        let mut rgba = pix.take();
        for p in rgba.as_chunks_mut::<4>().0 {
            if p[3] != 0 {
                for c in 0..3 {
                    p[c] = ((u32::from(p[c]) * 255 + u32::from(p[3]) / 2) / u32::from(p[3]))
                        .min(255) as u8;
                }
            }
        }
        if !rgba.as_chunks::<4>().0.iter().any(|p| p[3] != 0) {
            return Err(Error::Invalid("SVG draws no ink".into()));
        }
        return Ok((side, side, rgba));
    }
    let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| Error::Invalid(e.to_string()))?;
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(4096);
    limits.max_image_height = Some(4096);
    limits.max_alloc = Some(64 * 1024 * 1024);
    reader.limits(limits);
    let image = reader.decode().map_err(|e| Error::Invalid(e.to_string()))?;
    if u64::from(image.width()) * u64::from(image.height()) > 16_000_000 {
        return Err(Error::Invalid("image pixel budget".into()));
    }
    let resized = image
        .resize(side, side, image::imageops::FilterType::Lanczos3)
        .to_rgba8();
    let mut square = image::RgbaImage::new(side, side);
    image::imageops::overlay(
        &mut square,
        &resized,
        i64::from((side - resized.width()) / 2),
        i64::from((side - resized.height()) / 2),
    );
    Ok((side, side, square.into_raw()))
}
pub fn read(path: &Path, side: u32) -> Result<Pixels, Error> {
    let bytes = catalogue::bounded(path, 16 * 1024 * 1024).map_err(Error::Failed)?;
    decode(&bytes, side)
}
pub fn fallback(side: u32) -> Pixels {
    // A neutral application tile, source controlled and versioned with this resolver.
    let bytes = include_bytes!("fallback.svg");
    decode(bytes, side).expect("bundled fallback is valid")
}
pub fn check_override_parent() -> Result<(), Error> {
    let base = catalogue::data_home();
    let mut dir = app_override("check");
    dir.pop();
    while dir.starts_with(&base) {
        if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::AccessDenied("override directory symlink".into()));
        }
        if !dir.pop() {
            break;
        }
    }
    Ok(())
}
pub fn write_override(id: &str, bytes: &[u8]) -> Result<(), Error> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    check_override_parent()?;
    let target = app_override(id);
    let base = catalogue::data_home();
    let mut dir = base.clone();
    fs::create_dir_all(&dir).map_err(|e| Error::Failed(e.to_string()))?;
    for part in ["icons", "nidara", "per-app"] {
        if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(Error::AccessDenied(
                "override directory is a symlink".into(),
            ));
        }
        dir.push(part);
        match fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(e) => return Err(Error::Failed(e.to_string())),
        }
    }
    if fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err(Error::AccessDenied(
            "override directory is a symlink".into(),
        ));
    }
    let temporary = dir.join(format!(
        ".override-{}-{}",
        std::process::id(),
        super::unique()
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .map_err(|e| Error::Failed(e.to_string()))?;
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&temporary, &target)?;
        fs::File::open(&dir)?.sync_all()
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result.map_err(|e: std::io::Error| Error::Failed(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn theme_scale_inheritance_and_cycles() {
        let root = std::env::current_dir()
            .unwrap()
            .join(format!("target/a1-theme-{}", super::super::unique()));
        for d in ["Active/32/apps", "Active/64/apps", "Parent/apps"] {
            fs::create_dir_all(root.join(d)).unwrap();
        }
        fs::write(root.join("Active/index.theme"),"[Icon Theme]\nDirectories=32/apps,64/apps\nInherits=Parent\n[32/apps]\nSize=32\nScale=1\nType=Fixed\n[64/apps]\nSize=32\nScale=2\nType=Fixed\n").unwrap();
        fs::write(root.join("Parent/index.theme"),"[Icon Theme]\nDirectories=apps\nInherits=Active\n[apps]\nSize=48\nType=Scalable\nMinSize=2147483647\nMaxSize=2147483647\n").unwrap();
        for name in [
            "Active/32/apps/app.svg",
            "Active/64/apps/app.svg",
            "Parent/apps/inherited.svg",
        ] {
            fs::write(root.join(name), include_bytes!("fallback.svg")).unwrap();
        }
        let lookup = |name, size| {
            themed(
                name,
                "Active",
                size,
                std::slice::from_ref(&root),
                &mut BTreeSet::new(),
                0,
            )
        };
        assert_eq!(lookup("app", 64), Some(root.join("Active/64/apps/app.svg")));
        assert_eq!(
            lookup("inherited", 32),
            Some(root.join("Parent/apps/inherited.svg"))
        );
        assert!(lookup("missing", 32).is_none());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn colours_alpha_and_legacy_keys() {
        assert_eq!(raw_key("org.gnome.Nautilus"), "org.gnome.Nautilus");
        assert_eq!(raw_key("/a/b/foo.png"), "foo");
        let source=br#"  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="red" fill-opacity="0.5"/></svg>"#;
        let (w, h, p) = decode(source, 32).unwrap();
        assert_eq!((w, h), (32, 32));
        let center = &p[(16 * 32 + 16) * 4..][..4];
        assert!(center[0] > 250 && center[1] < 5 && center[3] > 120 && center[3] < 135);
        assert!(decode(source, 0).is_err());
        assert!(decode(&vec![0; 16 * 1024 * 1024 + 1], 32).is_err());
    }
}
