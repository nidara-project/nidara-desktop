// SPDX-License-Identifier: GPL-3.0-or-later
//! Administrator grants for exact development executables. No environment override.
use super::{Role, invalid};
use std::{
    ffi::CString,
    fs::{self, File},
    io::{self, Read},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::fs::MetadataExt,
    },
    path::{Component, Path},
};

const DIRECTORY: &str = "/etc/nidara/access.d";
const MAX_FILES: usize = 32;
const MAX_FILE_BYTES: u64 = 16 * 1024;

fn root_owned(file: &File, directory: bool) -> io::Result<()> {
    let m = file.metadata()?;
    if m.uid() != 0
        || m.mode() & 0o022 != 0
        || if directory {
            !m.is_dir()
        } else {
            !m.is_file() || m.mode() & 0o777 != 0o644
        }
    {
        return Err(invalid());
    }
    Ok(())
}
fn open_at(parent: &File, name: &std::ffi::OsStr, directory: bool) -> io::Result<File> {
    use std::os::unix::ffi::OsStrExt;
    let name = CString::new(name.as_bytes()).map_err(|_| invalid())?;
    let flags = libc::O_RDONLY
        | libc::O_CLOEXEC
        | libc::O_NOFOLLOW
        | libc::O_NONBLOCK
        | if directory { libc::O_DIRECTORY } else { 0 };
    let fd = unsafe { libc::openat(parent.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn directory(path: &Path) -> io::Result<File> {
    let mut fd = File::open("/")?;
    root_owned(&fd, true)?;
    for c in path.components() {
        match c {
            Component::RootDir => {}
            Component::Normal(name) => {
                fd = open_at(&fd, name, true)?;
                root_owned(&fd, true)?;
            }
            _ => return Err(invalid()),
        }
    }
    Ok(fd)
}
fn exact_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.ends_with('/')
        && !path.contains(['\0', '\t', '\r', '\n'])
        && path
            .split('/')
            .skip(1)
            .all(|c| !c.is_empty() && c != "." && c != "..")
}

#[derive(Debug, PartialEq, Eq)]
struct Entry {
    uid: u32,
    role: Role,
    path: String,
}
fn parse(text: &str) -> io::Result<Vec<Entry>> {
    text.lines()
        .filter(|line| !line.trim().is_empty() && !line.starts_with('#'))
        .map(|line| {
            let fields: Vec<_> = line.split('\t').collect();
            if fields.len() != 3
                || !exact_path(fields[2])
                || fields[1].is_empty()
                || !fields[1].bytes().all(|b| b.is_ascii_digit())
            {
                return Err(invalid());
            }
            let role = match fields[0] {
                "settings" => Role::Settings,
                "session" => Role::Session,
                "shell" => Role::Shell,
                "legacy-shell" => Role::LegacyShell,
                _ => return Err(invalid()),
            };
            let uid = fields[1].parse::<u32>().map_err(|_| invalid())?;
            Ok(Entry {
                uid,
                role,
                path: fields[2].into(),
            })
        })
        .collect()
}

pub(super) fn role(path: &Path, uid: u32) -> io::Result<Option<Role>> {
    lookup(Path::new(DIRECTORY), path, uid)
}
fn lookup(config: &Path, path: &Path, uid: u32) -> io::Result<Option<Role>> {
    let dir = match directory(config) {
        Ok(dir) => dir,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    // Enumerate the pinned directory, not a path that can be swapped underneath us.
    let mut files: Vec<_> = fs::read_dir(format!("/proc/self/fd/{}", dir.as_raw_fd()))?
        .map(|entry| entry.map(|e| e.file_name()))
        .collect::<io::Result<_>>()?;
    files.retain(|name| Path::new(name).extension().is_some_and(|s| s == "conf"));
    if files.len() > MAX_FILES {
        return Err(invalid());
    }
    files.sort();
    let mut found = None;
    for name in files {
        let file = open_at(&dir, &name, false)?;
        root_owned(&file, false)?;
        let mut text = String::new();
        file.take(MAX_FILE_BYTES + 1).read_to_string(&mut text)?;
        if text.len() as u64 > MAX_FILE_BYTES {
            return Err(invalid());
        }
        for entry in parse(&text)? {
            if entry.uid == uid && Path::new(&entry.path) == path {
                if found.is_some_and(|role| role != entry.role) {
                    return Err(invalid());
                }
                found = Some(entry.role);
            }
        }
    }
    Ok(found)
}

/// Explicit dev grants allow owner-writable executables, never a symlink or a path
/// writable by another user. Compare the actual running inode again in Peer::identity.
pub(super) fn development(path: &Path, uid: u32, running: &File) -> io::Result<bool> {
    let m = fs::symlink_metadata(path)?;
    let live = running.metadata()?;
    if !m.is_file() || m.dev() != live.dev() || m.ino() != live.ino() || m.mode() & 0o111 == 0 {
        return Ok(false);
    }
    for part in path.ancestors() {
        let m = fs::symlink_metadata(part)?;
        if m.file_type().is_symlink() || ![0, uid].contains(&m.uid()) || m.mode() & 0o022 != 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grants_are_exact_and_have_no_implicit_interpreter_role() {
        let entries =
            parse("# comment\nlegacy-shell\t1000\t/home/dev/with spaces/nidara-shell\n").unwrap();
        assert_eq!(entries[0].uid, 1000);
        assert_eq!(entries[0].role, Role::LegacyShell);
        for line in [
            "shell /home/dev/shell",
            "all\t1000\t/home/dev/shell",
            "shell\t*\t/home/dev/shell",
            "shell\t1000\trelative",
            "shell\t1000\t/a/../shell",
            "shell\t1000\t/a//shell",
            "shell\t1000\t/a/./shell",
            "shell\t1000\t/a/",
            "shell\t1000\t/a\textra",
        ] {
            assert!(parse(line).is_err(), "{line:?}");
        }
    }
    #[test]
    fn non_root_files_and_symlinks_do_not_grant_privilege() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("target/access-negative");
        fs::create_dir_all(&root).unwrap();
        let path = root.join(format!("{}.conf", std::process::id()));
        let _ = fs::remove_file(&path);
        fs::write(&path, "shell\t1000\t/home/dev/shell\n").unwrap();
        if unsafe { libc::geteuid() } != 0 {
            assert!(root_owned(&File::open(&path).unwrap(), false).is_err());
        }
        let link = path.with_extension("link");
        let _ = fs::remove_file(&link);
        std::os::unix::fs::symlink(&path, &link).unwrap();
        let parent = File::open(&root).unwrap();
        assert!(open_at(&parent, link.file_name().unwrap(), false).is_err());
        let _ = fs::remove_file(link);
        fs::remove_file(path).unwrap();
    }
    #[test]
    #[ignore = "requires check-access-list-namespace.sh private /etc"]
    fn namespace_root_fixtures() {
        // Run explicitly in check-access-list-namespace.sh, never using the host /etc.
        assert!(
            Path::new("/nidara-access-fixture").exists(),
            "requires private fixture namespace"
        );
        assert_eq!(unsafe { libc::geteuid() }, 0);
        let config = Path::new(DIRECTORY);
        let path = Path::new("/work/fixture/python");
        assert_eq!(lookup(config, path, 0).unwrap(), Some(Role::LegacyShell));
        assert_eq!(lookup(config, path, 1).unwrap(), None);
        let file = config.join("dev-0.conf");
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&file, fs::Permissions::from_mode(0o666)).unwrap();
        assert!(lookup(config, path, 0).is_err());
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        let original = fs::read_to_string(&file).unwrap();
        fs::write(&file, "invalid-role\t0\t/work/fixture/python\n").unwrap();
        assert!(lookup(config, path, 0).is_err());
        fs::write(&file, "#".repeat(MAX_FILE_BYTES as usize + 1)).unwrap();
        assert!(lookup(config, path, 0).is_err());
        fs::write(&file, original).unwrap();
        let parent = config.parent().unwrap();
        fs::set_permissions(parent, fs::Permissions::from_mode(0o777)).unwrap();
        assert!(lookup(config, path, 0).is_err());
        fs::set_permissions(parent, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            config.join("duplicate.conf"),
            "settings\t0\t/work/fixture/python\n",
        )
        .unwrap();
        fs::set_permissions(
            config.join("duplicate.conf"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(lookup(config, path, 0).is_err());
        fs::remove_file(config.join("duplicate.conf")).unwrap();
        fs::rename(&file, file.with_extension("saved")).unwrap();
        std::os::unix::fs::symlink(file.with_extension("saved"), &file).unwrap();
        assert!(lookup(config, path, 0).is_err());
        fs::remove_file(&file).unwrap();
        fs::rename(file.with_extension("saved"), &file).unwrap();
        // Directory-component symlinks are refused as well.
        fs::rename(config, parent.join("saved.d")).unwrap();
        std::os::unix::fs::symlink(parent.join("saved.d"), config).unwrap();
        assert!(lookup(config, path, 0).is_err());
        fs::remove_file(config).unwrap();
        fs::rename(parent.join("saved.d"), config).unwrap();
    }
}
