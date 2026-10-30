// SPDX-License-Identifier: LGPL-3.0-or-later
//! A Wayland connect that gives up at a deadline (SHELL-SURFACES.md §2). The usual
//! `UnixStream::connect` blocks while the compositor's listen backlog is full, before
//! any roundtrip deadline can apply; the shell's thread must not hang there.
use crate::err;
use rustix::io::Errno;
use rustix::net::{AddressFamily, SocketAddrUnix, SocketFlags, SocketType, connect, socket_with};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use wayland_client::Connection;

/// As `Connection::connect_to_env`, bounded by `deadline`. A `WAYLAND_SOCKET` handed in
/// by the parent is already connected and used as is.
pub(crate) fn connect_within(deadline: Instant) -> Result<Connection, String> {
    if std::env::var_os("WAYLAND_SOCKET").is_some() {
        return Connection::connect_to_env().map_err(err);
    }
    let name: PathBuf = std::env::var_os("WAYLAND_DISPLAY")
        .ok_or("WAYLAND_DISPLAY is not set")?
        .into();
    let path = if name.is_absolute() {
        name
    } else {
        let dir: PathBuf = std::env::var_os("XDG_RUNTIME_DIR")
            .ok_or("XDG_RUNTIME_DIR is not set")?
            .into();
        if !dir.is_absolute() {
            return Err("XDG_RUNTIME_DIR is not absolute".into());
        }
        dir.join(name)
    };
    Connection::from_socket(connect_path(&path, deadline)?).map_err(err)
}

pub(crate) fn connect_path(path: &Path, deadline: Instant) -> Result<UnixStream, String> {
    let addr = SocketAddrUnix::new(path).map_err(err)?;
    loop {
        let fd = socket_with(
            AddressFamily::UNIX,
            SocketType::STREAM,
            SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
            None,
        )
        .map_err(err)?;
        match connect(&fd, &addr) {
            Ok(()) => {
                let stream = UnixStream::from(fd);
                stream.set_nonblocking(false).map_err(err)?;
                return Ok(stream);
            }
            // A full backlog: Unix sockets do not queue the attempt, so try again.
            Err(Errno::AGAIN) => {
                let left = deadline.saturating_duration_since(Instant::now());
                if left.is_zero() {
                    return Err("the compositor did not accept the connection in time".into());
                }
                std::thread::sleep(left.min(Duration::from_millis(5)));
            }
            Err(e) => return Err(err(e)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    fn socket_path(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("nk-connect-{}-{name}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }
    #[test]
    fn a_listener_that_never_accepts_fails_in_time() {
        let path = socket_path("full");
        let _listener = UnixListener::bind(&path).unwrap();
        let addr = SocketAddrUnix::new(&path).unwrap();
        // Fill the backlog without accepting anything.
        let mut held = Vec::new();
        loop {
            let fd = socket_with(
                AddressFamily::UNIX,
                SocketType::STREAM,
                SocketFlags::CLOEXEC | SocketFlags::NONBLOCK,
                None,
            )
            .unwrap();
            match connect(&fd, &addr) {
                Ok(()) => held.push(fd),
                Err(Errno::AGAIN) => break,
                Err(e) => panic!("{e}"),
            }
            assert!(held.len() < 100_000, "the backlog never filled");
        }
        let started = Instant::now();
        let r = connect_path(&path, started + Duration::from_millis(100));
        assert!(r.is_err());
        let took = started.elapsed();
        assert!(
            took >= Duration::from_millis(100) && took < Duration::from_secs(1),
            "{took:?}"
        );
        std::fs::remove_file(&path).unwrap();
    }
    #[test]
    fn an_accepting_listener_connects_and_no_listener_fails_at_once() {
        let path = socket_path("ok");
        let listener = UnixListener::bind(&path).unwrap();
        let stream = connect_path(&path, Instant::now() + Duration::from_secs(1)).unwrap();
        listener.accept().unwrap();
        drop(stream);
        drop(listener);
        std::fs::remove_file(&path).unwrap();
        let started = Instant::now();
        assert!(connect_path(&path, started + Duration::from_secs(5)).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
    }
}
