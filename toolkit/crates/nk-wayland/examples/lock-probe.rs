// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic only: the ext-session-lock-v1 role (#1195). Locks the session with one lock
//! surface per output, each on its own thread and queue on the lock's connection, prints
//! LOCKED when the compositor says so, and unlocks on the first key press (UNLOCKED).
use nk_wayland::{Application, Event, Frame, LockStatus, Material, Options, Window, Waker};
use std::sync::mpsc;
use std::time::{Duration, Instant};
type Result<T> = std::result::Result<T, String>;

struct Probe {
    keys: mpsc::Sender<()>,
}
impl Application for Probe {
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        match event {
            Event::Configure => {
                let (width, height) = w.size();
                println!("CONFIGURE {width}x{height}");
                w.redraw();
            }
            Event::Key(k) if k.serial.is_some() => {
                let _ = self.keys.send(());
            }
            Event::Wake => w.close(),
            _ => {}
        }
        Ok(())
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        // Opaque dark grey: premultiplied ARGB8888, little-endian.
        Ok([0x30, 0x30, 0x30, 0xff].repeat(f.pixel_width as usize * f.pixel_height as usize))
    }
    fn material(&self) -> Option<Material> {
        None
    }
}

fn main() -> Result<()> {
    let mut watch = nk_wayland::outputs(Duration::from_secs(3))?;
    let mut lock = nk_wayland::lock_session(Duration::from_secs(3))?;
    println!("REQUESTED");
    let (keys, pressed) = mpsc::channel();
    let mut surfaces: Vec<(Waker, std::thread::JoinHandle<Result<()>>)> = Vec::new();
    for info in watch.current() {
        let output = lock
            .bind_output(&mut watch, info.id, Duration::from_secs(3))
            .map_err(|e| format!("{e:?}"))?;
        let (waker, source) = nk_wayland::wake_channel()?;
        let keys = keys.clone();
        let thread = std::thread::spawn(move || {
            nk_wayland::run_lock_surface(
                Probe { keys },
                Options {
                    material: false,
                    map: true,
                    app_id: "nk-lock-probe",
                    title: "",
                    size: (0, 0),
                    require_material: None,
                },
                output,
                Some(source),
                Instant::now(),
            )
        });
        surfaces.push((waker, thread));
    }
    match lock.wait(Some(Duration::from_secs(5)))? {
        LockStatus::Locked => println!("LOCKED"),
        other => return Err(format!("the lock was not confirmed: {other:?}")),
    }
    pressed
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| "no key reached the lock surface")?;
    lock.unlock()?;
    for (waker, thread) in surfaces {
        waker.wake()?;
        thread.join().map_err(|_| "a lock surface panicked")??;
    }
    println!("UNLOCKED");
    Ok(())
}
