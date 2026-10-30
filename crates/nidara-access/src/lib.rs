// SPDX-License-Identifier: GPL-3.0-or-later
//! Cooperative session consent, not isolation from hostile code of the same Unix user.
//! Identity comes from the transport, never a request body, bus name or argv.
mod access_list;

use gio::prelude::*;
use std::{
    fs::{self, File},
    io,
    os::{
        fd::{AsRawFd, FromRawFd, OwnedFd},
        unix::{fs::MetadataExt, net::UnixStream},
    },
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Operation {
    Read,
    OpenSurface,
    RevokeControl,
    Reload,
    ActivateOwnWindow,
    WindowControl,
    Spawn,
    EndSession,
    CloseWindow,
    Configure,
    EditPins,
    AppIcon,
    Capture,
    Outputs,
    Power,
    NightLight,
    MinimizeTargets,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Role {
    External,
    Settings,
    Session,
    Shell,
    LegacyShell,
    LegacySettings,
    Launcher,
}

#[derive(Clone, Copy, Default)]
pub struct Consent {
    pub control: bool,
    pub config: bool,
    pub capture: bool,
    pub close: bool,
}
impl Consent {
    pub fn from_settings(s: &gio::Settings, schema: &gio::SettingsSchema) -> Self {
        let get = |k| schema.has_key(k) && s.boolean(k);
        Self {
            control: get("allow-computer-control"),
            config: get("allow-config-write"),
            capture: get("allow-screenshot"),
            close: get("allow-window-close"),
        }
    }
}
fn permitted(role: Role, op: Operation, consent: Consent) -> bool {
    use Operation::*;
    if matches!(op, Read | OpenSurface | RevokeControl | Reload) {
        return true;
    }
    let own = match role {
        Role::LegacySettings => matches!(op, ActivateOwnWindow),
        Role::Settings => matches!(op, Configure | EditPins | AppIcon),
        Role::Launcher => matches!(op, EditPins),
        Role::Session => matches!(op, Configure | Power | NightLight),
        Role::Shell => matches!(
            op,
            WindowControl | CloseWindow | MinimizeTargets | EditPins | AppIcon
        ),
        // Compatibility for the dedicated installed TS shell host. Generic GJS hosts
        // and computer-use helpers never receive this role.
        Role::LegacyShell => matches!(
            op,
            WindowControl
                | CloseWindow
                | MinimizeTargets
                | Configure
                | Capture
                | Outputs
                | NightLight
        ),
        Role::External => false,
    };
    // Ending the desktop is never authorized by the general computer-control gate.
    if op == EndSession {
        return false;
    }
    own || consent.control
        && match op {
            Configure | EditPins | AppIcon => consent.config,
            Capture => consent.capture,
            CloseWindow => consent.close,
            _ => true,
        }
}

/// A live process pinned by pidfd and /proc directory. Retained for the connection, but
/// executable identity is revalidated on EVERY protected operation (including after exec).
pub struct Peer {
    pidfd: OwnedFd,
    proc: File,
    uid: u32,
    pid: u32,
}
fn invalid() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "caller identity unavailable or changed",
    )
}
impl Peer {
    pub fn from_socket(s: &UnixStream) -> io::Result<Self> {
        let mut cred: libc::ucred = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of_val(&cred) as libc::socklen_t;
        if unsafe {
            libc::getsockopt(
                s.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut cred as *mut libc::ucred).cast(),
                &mut size,
            )
        } != 0
        {
            return Err(io::Error::last_os_error());
        }
        if size as usize != std::mem::size_of_val(&cred) || cred.pid <= 0 {
            return Err(invalid());
        }
        Self::from_credentials(cred.pid as u32, cred.uid)
    }
    pub fn from_credentials(pid: u32, uid: u32) -> io::Result<Self> {
        if uid != unsafe { libc::geteuid() } || pid == 0 || pid > i32::MAX as u32 {
            return Err(invalid());
        }
        let fd = unsafe { libc::syscall(libc::SYS_pidfd_open, pid as libc::pid_t, 0) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let pidfd = unsafe { OwnedFd::from_raw_fd(fd as i32) };
        let proc = File::open(format!("/proc/{pid}"))?;
        let peer = Self {
            pidfd,
            proc,
            uid,
            pid,
        };
        peer.identity()?;
        Ok(peer)
    }
    fn identity(&self) -> io::Result<Role> {
        let mut poll = libc::pollfd {
            fd: self.pidfd.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        if unsafe { libc::poll(&mut poll, 1, 0) } != 0 || self.proc.metadata()?.uid() != self.uid {
            return Err(invalid());
        }
        let exe = PathBuf::from(format!("/proc/self/fd/{}/exe", self.proc.as_raw_fd()));
        let path = fs::read_link(&exe)?;
        let file = File::open(&exe)?;
        // A deleted/replaced executable cannot gain trust, even when consent is enabled.
        if path.as_os_str().as_encoded_bytes().ends_with(b" (deleted)") {
            return Err(invalid());
        }
        let installed_role = match path.to_str() {
            Some("/usr/lib/nidara/nidara-settings-native") => Some(Role::Settings),
            Some("/usr/bin/nidara-sessiond") => Some(Role::Session),
            Some("/usr/bin/nidara-shell") => Some(Role::Shell),
            Some("/usr/bin/nidara-apps") => Some(Role::Launcher),
            Some("/usr/lib/nidara/nidara-shell") => Some(Role::LegacyShell),
            Some("/usr/lib/nidara/nidara-settings") => Some(Role::LegacySettings),
            _ => None,
        };
        let role = if let Some(role) = installed_role {
            if !installed(&path, &file)? {
                return Err(invalid());
            }
            role
        } else if let Some(role) = access_list::role(&path, self.uid).map_err(|e| {
            io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!("invalid /etc/nidara/access.d configuration: {e}"),
            )
        })? {
            if !access_list::development(&path, self.uid, &file)? {
                return Err(invalid());
            }
            role
        } else {
            Role::External
        };
        // Catch exit or exec during inspection. No identity cache survives exec.
        let current = fs::metadata(exe)?;
        let pinned = file.metadata()?;
        if current.dev() != pinned.dev()
            || current.ino() != pinned.ino()
            || unsafe { libc::poll(&mut poll, 1, 0) } != 0
        {
            return Err(invalid());
        }
        Ok(role)
    }
    /// The compositor supplies a PID from the Wayland connection, never app-id/title
    /// or an X11 _NET_WM_PID. Legacy Settings may activate only its own native window.
    pub fn authorize_own_window(&self, owner_pid: Option<i32>) -> Result<(), String> {
        if owner_pid.and_then(|p| u32::try_from(p).ok()) != Some(self.pid) {
            return Err("AccessDenied: activation target does not belong to the caller".into());
        }
        self.authorize(Operation::ActivateOwnWindow, Consent::default())
    }
    pub fn authorize(&self, op: Operation, consent: Consent) -> Result<(), String> {
        if matches!(
            op,
            Operation::Read | Operation::OpenSurface | Operation::RevokeControl | Operation::Reload
        ) {
            return Ok(());
        }
        let role = self.identity().map_err(|e| format!("AccessDenied: {e}"))?;
        if permitted(role, op, consent) {
            Ok(())
        } else {
            let reason = if !consent.control {
                "computer control is disabled (Settings → AI)"
            } else {
                match op {
                    Operation::Configure | Operation::EditPins | Operation::AppIcon => {
                        "configuration writes are disabled (allow-config-write)"
                    }
                    Operation::Capture => "screenshots are disabled (allow-screenshot)",
                    Operation::CloseWindow => {
                        "window close requests are disabled (allow-window-close)"
                    }
                    _ => "caller is not authorized for this operation",
                }
            };
            Err(format!("AccessDenied: {op:?}: {reason}"))
        }
    }
}
fn installed(path: &Path, running: &File) -> io::Result<bool> {
    let disk = fs::metadata(path)?;
    let live = running.metadata()?;
    if disk.dev() != live.dev() || disk.ino() != live.ino() {
        return Ok(false);
    }
    for part in path.ancestors() {
        let m = fs::symlink_metadata(part)?;
        if m.file_type().is_symlink() || m.uid() != 0 || m.mode() & 0o022 != 0 {
            return Ok(false);
        }
    }
    Ok(true)
}

fn publish(settings: &gio::Settings, schema: &gio::SettingsSchema, bits: &AtomicU8) {
    let c = Consent::from_settings(settings, schema);
    bits.store(
        u8::from(c.control)
            | u8::from(c.config) << 1
            | u8::from(c.capture) << 2
            | u8::from(c.close) << 3,
        Ordering::Release,
    );
}

/// GSettings is watched on its own GLib context, never blocking a compositor round trip.
/// Missing schema/keys and startup before the first snapshot deny protected operations.
#[derive(Clone, Default)]
pub struct ConsentWatch(Arc<AtomicU8>);
impl ConsentWatch {
    pub fn start() -> Self {
        let this = Self::default();
        let bits = this.0.clone();
        std::thread::spawn(move || {
            let ctx = gio::glib::MainContext::new();
            let _ = ctx.with_thread_default(|| {
                let Some(schema) = gio::SettingsSchemaSource::default()
                    .and_then(|s| s.lookup("org.nidara.ai", true))
                else {
                    return;
                };
                let settings = gio::Settings::new_full(&schema, gio::SettingsBackend::NONE, None);
                let observed_schema = schema.clone();
                let observed_bits = bits.clone();
                settings.connect_changed(None, move |s, _| {
                    publish(s, &observed_schema, &observed_bits)
                });
                // Subscribe before the first read so a concurrent revocation is not lost.
                publish(&settings, &schema, &bits);
                gio::glib::MainLoop::new(Some(&ctx), false).run();
            });
        });
        this
    }
    pub fn get(&self) -> Consent {
        let b = self.0.load(Ordering::Acquire);
        Consent {
            control: b & 1 != 0,
            config: b & 2 != 0,
            capture: b & 4 != 0,
            close: b & 8 != 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn application_roles_are_scoped() {
        let no = Consent::default();
        for role in [Role::Shell, Role::Settings, Role::Launcher] {
            assert!(permitted(role, Operation::EditPins, no));
        }
        assert!(permitted(Role::Shell, Operation::AppIcon, no));
        assert!(permitted(Role::Settings, Operation::AppIcon, no));
        assert!(!permitted(Role::Launcher, Operation::AppIcon, no));
        for op in [
            Operation::Configure,
            Operation::Capture,
            Operation::CloseWindow,
            Operation::Spawn,
            Operation::WindowControl,
        ] {
            assert!(!permitted(Role::Launcher, op, no));
        }
        for op in [Operation::EditPins, Operation::AppIcon] {
            for (control, config) in [(false, false), (true, false), (false, true)] {
                assert!(!permitted(
                    Role::External,
                    op,
                    Consent {
                        control,
                        config,
                        ..no
                    }
                ));
            }
            assert!(permitted(
                Role::External,
                op,
                Consent {
                    control: true,
                    config: true,
                    ..no
                }
            ));
            assert!(!permitted(Role::Session, op, no));
        }
    }
    #[test]
    fn scope_and_consent_are_both_enforced() {
        let no = Consent::default();
        assert!(permitted(Role::External, Operation::Read, no));
        assert!(permitted(Role::Settings, Operation::Configure, no));
        assert!(!permitted(Role::Settings, Operation::Capture, no));
        assert!(!permitted(Role::Session, Operation::WindowControl, no));
        assert!(!permitted(Role::Shell, Operation::Configure, no));
        let yes = Consent {
            control: true,
            config: true,
            capture: true,
            close: true,
        };
        assert!(permitted(Role::External, Operation::WindowControl, yes));
        assert!(permitted(Role::External, Operation::Spawn, yes));
        assert!(!permitted(Role::External, Operation::EndSession, yes));
        assert!(!permitted(Role::Shell, Operation::EndSession, yes));
        assert!(!permitted(
            Role::External,
            Operation::Configure,
            Consent {
                config: false,
                ..yes
            }
        ));
        assert!(!permitted(
            Role::External,
            Operation::Configure,
            Consent {
                control: false,
                ..yes
            }
        ));
        assert!(!permitted(
            Role::External,
            Operation::Capture,
            Consent {
                capture: false,
                ..yes
            }
        ));
    }
    #[test]
    fn legacy_shell_inventory_requires_exact_role_not_the_cli_or_generic_interpreter() {
        for op in [
            Operation::WindowControl,
            Operation::CloseWindow,
            Operation::MinimizeTargets,
            Operation::Configure,
            Operation::Capture,
            Operation::Outputs,
            Operation::NightLight,
        ] {
            assert!(
                !permitted(Role::External, op, Consent::default()),
                "external caller: {op:?}"
            );
            assert!(
                permitted(Role::LegacyShell, op, Consent::default()),
                "legacy shell needs {op:?}"
            );
        }
        assert!(!permitted(
            Role::LegacyShell,
            Operation::Spawn,
            Consent::default()
        ));
        assert!(!permitted(
            Role::LegacyShell,
            Operation::EndSession,
            Consent::default()
        ));
        assert!(permitted(
            Role::Session,
            Operation::Power,
            Consent::default()
        ));
    }
    #[test]
    fn legacy_settings_has_no_general_window_or_config_privilege() {
        assert!(permitted(
            Role::LegacySettings,
            Operation::ActivateOwnWindow,
            Consent::default()
        ));
        for op in [
            Operation::WindowControl,
            Operation::CloseWindow,
            Operation::Configure,
            Operation::Capture,
            Operation::Spawn,
        ] {
            assert!(!permitted(Role::LegacySettings, op, Consent::default()));
        }
        let peer = Peer::from_credentials(std::process::id(), unsafe { libc::geteuid() }).unwrap();
        assert!(peer.authorize_own_window(None).is_err());
        assert!(peer.authorize_own_window(Some(-1)).is_err());
        assert!(peer.authorize_own_window(Some(1)).is_err());
        assert!(
            peer.authorize_own_window(Some(std::process::id() as i32))
                .is_err(),
            "an external executable still needs its role"
        );
    }
    #[test]
    fn socket_uses_real_credentials_and_no_cli_trust() {
        let (a, _b) = UnixStream::pair().unwrap();
        let peer = Peer::from_socket(&a).unwrap();
        assert_eq!(peer.identity().unwrap(), Role::External);
        assert!(
            peer.authorize(Operation::WindowControl, Consent::default())
                .is_err()
        );
        assert!(
            peer.authorize(
                Operation::WindowControl,
                Consent {
                    control: true,
                    ..Consent::default()
                }
            )
            .is_ok()
        );
        assert!(Peer::from_credentials(u32::MAX, unsafe { libc::geteuid() }).is_err());
    }
    #[test]
    fn dead_process_is_not_reused() {
        let mut child = std::process::Command::new("sleep")
            .arg("10")
            .spawn()
            .unwrap();
        let peer = Peer::from_credentials(child.id(), unsafe { libc::geteuid() }).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(
            peer.authorize(
                Operation::Configure,
                Consent {
                    control: true,
                    config: true,
                    ..Consent::default()
                }
            )
            .is_err()
        );
    }
}
