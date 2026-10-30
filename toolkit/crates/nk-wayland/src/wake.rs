// SPDX-License-Identifier: LGPL-3.0-or-later
//! Waking a layer root's run loop from another thread (SHELL-SURFACES.md §2): the shell
//! ends a dock when the watcher reports its output removed, and D1 hands it new data.
//! A nonblocking pipe in the loop's poll, so a quiet dock never polls.
use crate::{Result, err};
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::sync::Arc;

/// Send it anywhere; every `wake` becomes at least one `Event::Wake` (wakes coalesce).
#[derive(Clone)]
pub struct Waker(Arc<OwnedFd>);
/// Handed to `run_layer`; the loop owns it.
pub struct WakeSource(OwnedFd);

pub fn wake_channel() -> Result<(Waker, WakeSource)> {
    use rustix::pipe::{PipeFlags, pipe_with};
    let (read, write) = pipe_with(PipeFlags::CLOEXEC | PipeFlags::NONBLOCK).map_err(err)?;
    Ok((Waker(Arc::new(write)), WakeSource(read)))
}
impl Waker {
    /// Never blocks. Fails only when the loop has ended (its end of the pipe is gone).
    pub fn wake(&self) -> Result<()> {
        match rustix::io::write(&*self.0, &[1]) {
            // A full pipe already holds a wake that has not been seen.
            Ok(_) | Err(rustix::io::Errno::AGAIN) => Ok(()),
            Err(e) => Err(err(e)),
        }
    }
}
impl WakeSource {
    pub(crate) fn fd(&self) -> BorrowedFd<'_> {
        self.0.as_fd()
    }
    /// Empties the pipe; true when any wake was waiting.
    pub(crate) fn drain(&self) -> bool {
        let mut buf = [0u8; 64];
        let mut any = false;
        while let Ok(n) = rustix::io::read(&self.0, &mut buf) {
            if n == 0 {
                break;
            }
            any = true;
        }
        any
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn wakes_coalesce_and_never_block() {
        let (waker, source) = wake_channel().unwrap();
        assert!(!source.drain());
        // Far more than a pipe holds: a full pipe must not block or fail.
        for _ in 0..100_000 {
            waker.clone().wake().unwrap();
        }
        assert!(source.drain());
        assert!(!source.drain());
    }
    #[test]
    fn waking_an_ended_loop_fails() {
        let (waker, source) = wake_channel().unwrap();
        drop(source);
        assert!(waker.wake().is_err());
    }
}
