// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic only: a window that prints every scroll it receives, its pixels and its wheel
//! detents, so a wheel can be seen to arrive as detents and a touchpad as pixels (VIEW.md §8).
use nk_wayland::{Application, Event, Frame, Material, Options, Window};
use std::time::Instant;
type Result<T> = std::result::Result<T, String>;
struct Probe;
impl Application for Probe {
    fn event(&mut self, event: Event, _: &mut Window) -> Result<()> {
        match event {
            Event::Error(e) => Err(e),
            Event::Scroll(a) => {
                println!("SCROLL pixels {} detents {:?}", a.pixels, a.detents);
                Ok(())
            }
            Event::HorizontalScroll(a) => {
                println!("HSCROLL pixels {} detents {:?}", a.pixels, a.detents);
                Ok(())
            }
            _ => Ok(()),
        }
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
fn main() {
    let r = nk_wayland::run(
        Probe,
        Options {
            material: false,
            map: true,
            app_id: "nk-scroll-probe",
            title: "nk-scroll-probe",
            size: (400, 300),
            require_material: None,
        },
        Instant::now(),
    );
    if let Err(e) = r {
        eprintln!("ERROR {e}");
        std::process::exit(1);
    }
}
