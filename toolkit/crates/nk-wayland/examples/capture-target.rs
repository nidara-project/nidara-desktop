// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic only: a toplevel with a known pattern for window capture (SHELL-SURFACES.md
//! §5). Left half translucent orange (straight 200, 100, 50 at alpha 128), right half
//! opaque green (10, 200, 30): coloured, non-gray, one of them translucent.
use nk_wayland::{Application, Event, Frame, Material, Options, Window};
use std::time::Instant;
type Result<T> = std::result::Result<T, String>;
struct Target(bool);
impl Application for Target {
    fn event(&mut self, event: Event, _: &mut Window) -> Result<()> {
        match event {
            Event::Error(e) => return Err(e),
            Event::FrameDone if !self.0 => {
                self.0 = true;
                eprintln!("TARGET_READY");
            }
            _ => {}
        }
        Ok(())
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        // Premultiplied B, G, R, A in memory (argb8888).
        let (w, h) = (f.pixel_width as usize, f.pixel_height as usize);
        let mut px = vec![0u8; w * h * 4];
        for (i, p) in px.as_chunks_mut::<4>().0.iter_mut().enumerate() {
            *p = if i % w < w / 2 {
                [25, 50, 100, 128]
            } else {
                [30, 200, 10, 255]
            };
        }
        Ok(px)
    }
    fn material(&self) -> Option<Material> {
        None
    }
}
fn main() {
    let r = nk_wayland::run(
        Target(false),
        Options {
            material: false,
            map: true,
            app_id: "nk-capture-target",
            title: "nk-capture-target",
            size: (640, 360),
            require_material: None,
        },
        Instant::now(),
    );
    if let Err(e) = r {
        eprintln!("ERROR {e}");
        std::process::exit(1);
    }
}
