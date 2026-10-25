// SPDX-License-Identifier: LGPL-3.0-or-later
//! One pending snapshot, independently of how long publication takes.
use std::sync::{Arc, Mutex, mpsc};

type Slot<T> = Arc<Mutex<Option<T>>>;
pub(crate) struct Sender<T> {
    slot: Slot<T>,
    wake: mpsc::SyncSender<()>,
}
pub(crate) struct Receiver<T> {
    slot: Slot<T>,
    wake: mpsc::Receiver<()>,
}
pub(crate) fn channel<T>() -> (Sender<T>, Receiver<T>) {
    let slot = Arc::new(Mutex::new(None));
    let (wake, receive) = mpsc::sync_channel(1);
    (
        Sender {
            slot: slot.clone(),
            wake,
        },
        Receiver {
            slot,
            wake: receive,
        },
    )
}
impl<T> Sender<T> {
    pub(crate) fn send(&self, value: T) -> Result<(), String> {
        *self.slot.lock().map_err(|e| e.to_string())? = Some(value);
        match self.wake.try_send(()) {
            Ok(()) | Err(mpsc::TrySendError::Full(())) => Ok(()),
            Err(mpsc::TrySendError::Disconnected(())) => Err("snapshot worker exited".into()),
        }
    }
}
impl<T> Receiver<T> {
    pub(crate) fn recv(&self) -> Result<T, String> {
        loop {
            self.wake.recv().map_err(|e| e.to_string())?;
            if let Some(value) = self.slot.lock().map_err(|e| e.to_string())?.take() {
                return Ok(value);
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slow_reader_keeps_only_latest_payload_and_revision() {
        let (send, receive) = channel();
        let old = Arc::new("old full tree");
        let weak = Arc::downgrade(&old);
        send.send((1, old)).unwrap();
        send.send((2, Arc::new("intermediate"))).unwrap();
        send.send((3, Arc::new("final checked state"))).unwrap();
        assert!(
            weak.upgrade().is_none(),
            "superseded snapshot retained while reader is slow"
        );
        let (revision, payload) = receive.recv().unwrap();
        assert_eq!((revision, *payload), (3, "final checked state"));
        send.send((4, Arc::new("next final state"))).unwrap();
        assert_eq!(receive.recv().unwrap().0, 4);
        drop(send);
        assert!(receive.recv().is_err());
    }
    #[test]
    fn disconnected_reader_is_an_error_and_never_blocks_the_app() {
        let (send, receive) = channel();
        drop(receive);
        assert!(send.send(1).is_err());
    }
}
