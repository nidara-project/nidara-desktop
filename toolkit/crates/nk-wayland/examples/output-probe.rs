// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic only (SHELL-SURFACES.md §2), as the shell will do it: a layer root on the
//! output the watcher reports, on its own thread, ended from the main thread with its
//! Waker; an output id that is not present is refused with OUTPUT_GONE. Same-number
//! re-add needs a second output, which nested Hyalo lacks: unit tests in outputs.rs.
use nk_wayland::{
    Application, Edges, Event, Frame, KeyboardMode, LayerLevel, LayerPlacement, LayerSpec,
    Material, OUTPUT_GONE, Options, OutputId, WakeSource, Window,
};
use std::sync::mpsc;
use std::time::{Duration, Instant};
type Result<T> = std::result::Result<T, String>;
struct Dock(mpsc::Sender<()>);
impl Application for Dock {
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        match event {
            Event::Error(e) => return Err(e),
            Event::Configure => {
                let _ = self.0.send(());
            }
            Event::Wake => {
                eprintln!("WOKE");
                w.close();
            }
            _ => {}
        }
        Ok(())
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        Ok(vec![
            0x80;
            f.pixel_width as usize * f.pixel_height as usize * 4
        ])
    }
    fn material(&self) -> Option<Material> {
        None
    }
}
fn dock(output: OutputId, wake: Option<WakeSource>, ready: mpsc::Sender<()>) -> Result<()> {
    nk_wayland::run_layer(
        Dock(ready),
        Options {
            material: false,
            map: true,
            app_id: "nk-output-probe",
            title: "",
            size: (200, 40),
            require_material: None,
        },
        LayerSpec {
            namespace: "nk-output-probe",
            output: Some(output),
            layer: LayerLevel::Top,
            placement: LayerPlacement {
                anchor: Edges::BOTTOM,
                size: (200, 40),
                exclusive_zone: 0,
                margin: [0; 4],
                keyboard: KeyboardMode::None,
            },
        },
        wake,
        Instant::now(),
    )
}
fn main() -> Result<()> {
    let watch = nk_wayland::outputs()?;
    for o in watch.current() {
        eprintln!("ADDED id={} name={} logical={:?}", o.id.0, o.name, o.logical);
    }
    let first = watch.current().first().cloned().ok_or("no output")?;
    let (waker, source) = nk_wayland::wake_channel()?;
    let (ready_tx, ready) = mpsc::channel();
    let thread = std::thread::spawn(move || dock(first.id, Some(source), ready_tx));
    ready
        .recv_timeout(Duration::from_secs(10))
        .map_err(|e| format!("dock never configured: {e}"))?;
    eprintln!("DOCK_READY id={}", first.id.0);
    waker.wake()?;
    let ended = thread.join().map_err(|_| "dock thread panicked")?;
    eprintln!("WAKE_ENDED {ended:?}");
    eprintln!("WAKE_AFTER_END {:?}", waker.wake().is_err());
    let absent = OutputId(first.id.0 + 1000);
    let (tx, _rx) = mpsc::channel();
    match dock(absent, None, tx) {
        Err(e) if e == OUTPUT_GONE => eprintln!("ABSENT_REFUSED"),
        other => eprintln!("ABSENT_RESULT {other:?}"),
    }
    Ok(())
}
