// SPDX-License-Identifier: GPL-3.0-or-later
//! An accepted push is staged privately. Only an exclusive final publication is received.
use super::Error;
use std::{
    ffi::CString,
    fs::{self, File, OpenOptions},
    io,
    os::unix::{
        ffi::OsStrExt,
        fs::{MetadataExt, OpenOptionsExt},
    },
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
pub const FREE_FLOOR: u64 = 256 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);
pub trait Space: Send + Sync {
    fn available(&self, path: &Path) -> Result<u64, Error>;
}
pub struct RealSpace;
impl Space for RealSpace {
    fn available(&self, path: &Path) -> Result<u64, Error> {
        let path = CString::new(path.as_os_str().as_bytes())
            .map_err(|_| Error::Invalid("invalid filesystem path".into()))?;
        let mut s = std::mem::MaybeUninit::<libc::statvfs>::uninit();
        // SAFETY: statvfs writes exactly one initialized struct on success; path is NUL terminated.
        if unsafe { libc::statvfs(path.as_ptr(), s.as_mut_ptr()) } != 0 {
            return Err(io_error());
        }
        let s = unsafe { s.assume_init() };
        Ok(s.f_bavail.saturating_mul(s.f_frsize))
    }
}
fn io_error() -> Error {
    Error::Failed("file operation failed".into())
}
impl From<io::Error> for Error {
    fn from(_: io::Error) -> Self {
        io_error()
    }
}
pub fn capacity(
    space: &dyn Space,
    stage: &Path,
    destination: &Path,
    size: Option<u64>,
    reserved: u64,
) -> Result<(), Error> {
    let need = FREE_FLOOR
        .checked_add(size.unwrap_or(0))
        .and_then(|n| n.checked_add(reserved))
        .ok_or_else(|| Error::NoSpace("file exceeds available capacity".into()))?;
    for p in [stage, destination] {
        if space.available(p)? < need {
            return Err(Error::NoSpace("256 MiB free-space margin required".into()));
        }
    }
    Ok(())
}
// Admission preflight creates nothing before consent, even if Downloads is absent.
pub fn preflight(
    space: &dyn Space,
    root: &Path,
    destination: &Path,
    size: u64,
    reserved: u64,
) -> Result<(), Error> {
    let existing = destination
        .ancestors()
        .find(|p| p.exists())
        .ok_or_else(io_error)?;
    capacity(space, root, existing, Some(size), reserved)
}
fn require_persistent(path: &Path) -> Result<(), Error> {
    let path = CString::new(path.as_os_str().as_bytes()).map_err(|_| io_error())?;
    let mut info = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: valid path and output struct; inspect only after successful statfs.
    if unsafe { libc::statfs(path.as_ptr(), info.as_mut_ptr()) } != 0 {
        return Err(io_error());
    }
    let kind = unsafe { info.assume_init() }.f_type;
    if matches!(kind, 0x0102_1994 | 0x8584_58f6 | 0x9584_58f6) {
        return Err(Error::Unavailable(
            "persistent obexd root and Downloads required; RAM-backed filesystems are refused"
                .into(),
        ));
    }
    Ok(())
}
pub fn downloads() -> PathBuf {
    glib::user_special_dir(glib::UserDirectory::Downloads)
        .unwrap_or_else(|| glib::home_dir().join("Downloads"))
}
pub fn safe_name(input: &str) -> String {
    let mut out = String::new();
    for c in input.chars() {
        let c = if c.is_control()
            || matches!(c,'/'|'\\'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'|'\u{200e}'|'\u{200f}'|'\u{061c}')
        {
            '_'
        } else {
            c
        };
        if out.len() + c.len_utf8() > 160 {
            break;
        }
        out.push(c);
    }
    while out.contains("..") {
        out = out.replace("..", "_");
    }
    let out = out.trim_matches(['.', ' ']);
    if out.is_empty() {
        "bluetooth-file".into()
    } else {
        out.into()
    }
}
fn private_dir(root: &Path) -> Result<PathBuf, Error> {
    for _ in 0..32 {
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        let p = root.join(format!(".nidara-bt-{}-{id}", std::process::id()));
        match fs::DirBuilder::new().mode(0o700).create(&p) {
            Ok(()) => return Ok(p),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(Error::Busy("temporary namespace exhausted".into()))
}
use std::os::unix::fs::DirBuilderExt;
fn owned_directory(path: &Path) -> Result<PathBuf, Error> {
    let p = fs::canonicalize(path)?;
    let m = fs::metadata(&p)?;
    if !m.is_dir() || m.uid() != unsafe { libc::getuid() } {
        return Err(Error::Denied("directory must belong to this user".into()));
    }
    Ok(p)
}
pub struct Incoming {
    pub directory: PathBuf,
    pub path: PathBuf,
    pub destination: PathBuf,
    pub name: String,
    pub size: Option<u64>,
}
impl Incoming {
    pub fn prepare(
        root: &Path,
        destination: &Path,
        name: &str,
        size: Option<u64>,
        space: &dyn Space,
        reserved: u64,
    ) -> Result<Self, Error> {
        let root = owned_directory(root)?;
        require_persistent(&root)?;
        fs::create_dir_all(destination)?;
        let destination = owned_directory(destination)?;
        require_persistent(&destination)?;
        capacity(space, &root, &destination, size, reserved)?;
        let directory = private_dir(&root)?;
        let path = directory.join("payload.part");
        if OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&path)
            .is_err()
        {
            let _ = fs::remove_dir(&directory);
            return Err(io_error());
        }
        Ok(Self {
            directory,
            path,
            destination,
            name: safe_name(name),
            size,
        })
    }
    pub fn check_space(&self, space: &dyn Space) -> Result<(), Error> {
        capacity(space, &self.directory, &self.destination, None, 0)
    }
    pub fn publish(&self, space: &dyn Space) -> Result<String, Error> {
        self.check_space(space)?;
        let mut source = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(&self.path)?;
        let metadata = source.metadata()?;
        if !metadata.is_file() || metadata.uid() != unsafe { libc::getuid() } {
            return Err(Error::Invalid(
                "incoming payload must be a regular owned file".into(),
            ));
        }
        if self.size.is_some_and(|size| size != metadata.len()) {
            return Err(Error::Failed(
                "received size does not match accepted metadata".into(),
            ));
        }
        // Same filesystem: no duplicate full payload or second space reservation.
        if metadata.dev() == fs::metadata(&self.destination)?.dev() {
            source.sync_all()?;
            return publish_exclusive(&self.path, &self.destination, &self.name);
        }
        let publishing = private_dir(&self.destination)?;
        let result = (|| {
            let temp = publishing.join("payload.part");
            let mut target = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o600)
                .open(&temp)?;
            // Bounded chunks check both volumes, even for unknown-size data.
            let mut buffer = [0u8; 64 * 1024];
            use std::io::{Read, Write};
            loop {
                let n = source.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                self.check_space(space)?;
                target.write_all(&buffer[..n])?;
            }
            target.sync_all()?;
            drop(target);
            publish_exclusive(&temp, &self.destination, &self.name)
        })();
        // Only paths created by this operation; no sweeping or removal of other agents' files.
        let _ = fs::remove_file(publishing.join("payload.part"));
        let _ = fs::remove_dir(publishing);
        result
    }
}
fn publish_exclusive(source: &Path, destination: &Path, base: &str) -> Result<String, Error> {
    for suffix in 0..10_000 {
        let name = if suffix == 0 {
            base.to_owned()
        } else {
            match base.rsplit_once('.') {
                Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
                    format!("{stem} ({suffix}).{extension}")
                }
                _ => format!("{base} ({suffix})"),
            }
        };
        let old = CString::new(source.as_os_str().as_bytes()).map_err(|_| io_error())?;
        let new =
            CString::new(destination.join(&name).as_os_str().as_bytes()).map_err(|_| io_error())?;
        // SAFETY: valid path strings; NOREPLACE rejects existing files AND symlinks.
        if unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                old.as_ptr(),
                libc::AT_FDCWD,
                new.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        } == 0
        {
            let _ = File::open(destination).and_then(|f| f.sync_all());
            return Ok(name);
        }
        if io::Error::last_os_error().kind() != io::ErrorKind::AlreadyExists {
            return Err(io_error());
        }
    }
    Err(Error::Busy("too many filename collisions".into()))
}
impl Drop for Incoming {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
        let _ = fs::remove_dir(&self.directory);
    }
}
pub fn outgoing(path: &Path) -> Result<PathBuf, Error> {
    if !path.is_absolute() {
        return Err(Error::Invalid("absolute local file path required".into()));
    }
    let m = fs::symlink_metadata(path)?;
    if !m.is_file() {
        return Err(Error::Invalid("only regular files may be sent".into()));
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    if !file.metadata()?.is_file() {
        return Err(Error::Invalid("only regular files may be sent".into()));
    }
    Ok(fs::canonicalize(path)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    struct FakeSpace(u64);
    impl Space for FakeSpace {
        fn available(&self, _: &Path) -> Result<u64, Error> {
            Ok(self.0)
        }
    }
    #[test]
    fn space_margin_and_unknown_size() {
        let p = Path::new("/unused");
        assert!(capacity(&FakeSpace(FREE_FLOOR + 10), p, p, Some(10), 0).is_ok());
        assert!(capacity(&FakeSpace(FREE_FLOOR + 9), p, p, Some(10), 0).is_err());
        assert!(capacity(&FakeSpace(FREE_FLOOR - 1), p, p, None, 0).is_err());
        assert!(capacity(&FakeSpace(u64::MAX), p, p, Some(u64::MAX), 0).is_err());
        assert!(capacity(&FakeSpace(FREE_FLOOR + 10), p, p, Some(10), 1).is_err());
    }
    #[test]
    fn collision_suffix_preserves_last_extension_and_extensionless_names() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target");
        fs::create_dir_all(&root).unwrap();
        let directory = private_dir(&root).unwrap();
        for (base, expected) in [
            ("photo.jpg", "photo (1).jpg"),
            ("archive.tar.gz", "archive.tar (1).gz"),
            ("README", "README (1)"),
            (".hidden", ".hidden (1)"),
        ] {
            fs::write(directory.join(base), b"keep").unwrap();
            let source = directory.join("partial");
            fs::write(&source, b"new").unwrap();
            assert_eq!(
                publish_exclusive(&source, &directory, base).unwrap(),
                expected
            );
            assert_eq!(fs::read(directory.join(base)).unwrap(), b"keep");
            fs::remove_file(directory.join(base)).unwrap();
            fs::remove_file(directory.join(expected)).unwrap();
        }
        let absent = directory.join("missing-downloads");
        assert!(preflight(&FakeSpace(FREE_FLOOR + 4), &directory, &absent, 4, 0).is_ok());
        assert!(preflight(&FakeSpace(FREE_FLOOR + 3), &directory, &absent, 4, 0).is_err());
        assert!(
            !absent.exists(),
            "preflight must not create Downloads before consent"
        );
        assert_eq!(safe_name(""), "bluetooth-file");
        fs::remove_dir(directory).unwrap();
    }
    #[test]
    fn cross_filesystem_publication_primitive_and_ram_admission_refusal() {
        let disk = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target");
        fs::create_dir_all(&disk).unwrap();
        let destination = private_dir(&disk).unwrap();
        let directory = private_dir(Path::new("/dev/shm")).unwrap();
        assert!(
            Incoming::prepare(
                &directory,
                &destination,
                "reject.txt",
                Some(4),
                &FakeSpace(u64::MAX),
                0
            )
            .is_err()
        );
        let path = directory.join("payload.part");
        fs::write(&path, b"test").unwrap();
        // Direct primitive fixture, not a production AuthorizePush/prepare bypass.
        let incoming = Incoming {
            directory,
            path,
            destination: destination.clone(),
            name: "test.txt".into(),
            size: Some(4),
        };
        if fs::metadata(&incoming.directory).unwrap().dev()
            != fs::metadata(&destination).unwrap().dev()
        {
            fs::write(destination.join("test.txt"), b"keep").unwrap();
            assert_eq!(
                incoming.publish(&FakeSpace(u64::MAX)).unwrap(),
                "test (1).txt"
            );
            assert_eq!(fs::read(destination.join("test.txt")).unwrap(), b"keep");
            assert_eq!(fs::read(destination.join("test (1).txt")).unwrap(), b"test");
            fs::remove_file(destination.join("test.txt")).unwrap();
            fs::remove_file(destination.join("test (1).txt")).unwrap();
        }
        drop(incoming);
        fs::remove_dir(destination).unwrap();
    }
    #[test]
    fn names_have_no_paths_controls_or_dotdot() {
        for input in [
            "../../a",
            "a\\b",
            ".",
            "..",
            "\u{202e}evil",
            "\u{200e}a\u{200f}b\u{061c}",
            "a\nb",
            "",
        ] {
            let n = safe_name(input);
            assert!(
                !n.contains('/')
                    && !n.contains('\\')
                    && !n.contains("..")
                    && !n.chars().any(char::is_control)
            );
            assert!(!n.is_empty());
            assert!(!n.chars().any(|c| matches!(c, '\u{200e}'|'\u{200f}'|'\u{061c}'|'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')));
        }
    }
}
