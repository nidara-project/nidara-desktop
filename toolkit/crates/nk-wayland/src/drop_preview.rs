// SPDX-License-Identifier: LGPL-3.0-or-later
//! A drag's advisory read: one stream, bounded bytes and time, never a finish.
use std::{
    fs::File,
    io::Read,
    time::{Duration, Instant},
};

pub(crate) const LIMIT: usize = 1024 * 1024;
pub(crate) const DEADLINE: Duration = Duration::from_secs(2);

pub(crate) struct Preview {
    file: File,
    bytes: Vec<u8>,
    started: Instant,
}

impl Preview {
    pub(crate) fn new(file: File, now: Instant) -> Self {
        Self {
            file,
            bytes: Vec::new(),
            started: now,
        }
    }

    /// None means pending; an error or timeout grants no acceptance.
    pub(crate) fn poll(&mut self, now: Instant) -> Option<Result<Vec<u8>, ()>> {
        if now.saturating_duration_since(self.started) >= DEADLINE {
            return Some(Err(()));
        }
        let mut buf = [0; 8192];
        loop {
            match self.file.read(&mut buf) {
                Ok(0) => return Some(Ok(std::mem::take(&mut self.bytes))),
                Ok(n) => {
                    self.bytes.extend_from_slice(&buf[..n]);
                    if self.bytes.len() > LIMIT {
                        return Some(Err(()));
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return None,
                Err(_) => return Some(Err(())),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{io::Write, os::unix::net::UnixStream};

    #[test]
    fn slow_offer_is_pending_then_fails_at_its_deadline() {
        let (read, _writer) = UnixStream::pair().unwrap();
        read.set_nonblocking(true).unwrap();
        let now = Instant::now();
        let mut preview = Preview::new(std::os::fd::OwnedFd::from(read).into(), now);
        assert!(preview.poll(now).is_none());
        assert_eq!(preview.poll(now + DEADLINE), Some(Err(())));
    }

    #[test]
    fn partial_read_waits_for_eof_and_preserves_exact_bytes() {
        let (read, mut writer) = UnixStream::pair().unwrap();
        read.set_nonblocking(true).unwrap();
        let now = Instant::now();
        let mut preview = Preview::new(std::os::fd::OwnedFd::from(read).into(), now);
        writer.write_all(b"file:///a").unwrap();
        assert!(preview.poll(now).is_none());
        writer.write_all(b"\r\n").unwrap();
        drop(writer);
        assert_eq!(preview.poll(now), Some(Ok(b"file:///a\r\n".to_vec())));
    }

    #[test]
    fn an_oversized_stream_is_refused_before_eof() {
        let (read, mut writer) = UnixStream::pair().unwrap();
        read.set_nonblocking(true).unwrap();
        let now = Instant::now();
        let mut preview = Preview::new(std::os::fd::OwnedFd::from(read).into(), now);
        for _ in 0..LIMIT / 8192 {
            writer.write_all(&[1; 8192]).unwrap();
            assert!(preview.poll(now).is_none());
        }
        writer.write_all(&[1]).unwrap();
        assert_eq!(preview.poll(now), Some(Err(())));
    }
}
