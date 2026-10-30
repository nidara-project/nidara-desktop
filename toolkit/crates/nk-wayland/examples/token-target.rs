// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic only: a toplevel that consumes the activation token another client made
//! (layer-probe --token), so Hyalo can be seen honouring it (SHELL-SURFACES.md §4).
use nk_wayland::{Application, Event, Frame, Material, Options, Window};
use std::time::Instant;
type Result<T> = std::result::Result<T, String>;
struct Target {
    file: Option<String>,
    painted: bool,
}
impl Application for Target {
    fn poll_interval_ms(&self) -> u32 {
        20
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        if !self.painted {
            return Ok(());
        }
        if let Some(path) = &self.file
            && let Ok(token) = std::fs::read_to_string(path)
        {
            self.file = None;
            eprintln!("ACTIVATE {:?}", w.activate(token)?);
        }
        Ok(())
    }
    fn event(&mut self, event: Event, _: &mut Window) -> Result<()> {
        match event {
            Event::Error(e) => Err(e),
            Event::FrameDone => {
                if !self.painted {
                    eprintln!("TARGET_READY");
                }
                self.painted = true;
                Ok(())
            }
            Event::Focus(f) => {
                eprintln!("FOCUS {f}");
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
    let app_id: &'static str = std::env::args()
        .nth(1)
        .map(|s| &*Box::leak(s.into_boxed_str()))
        .unwrap_or("nk-token-target");
    let r = nk_wayland::run(
        Target {
            file: std::env::var("NK_TOKEN_FILE")
                .ok()
                .filter(|_| app_id == "nk-token-target"),
            painted: false,
        },
        Options {
            material: false,
            map: true,
            app_id,
            title: app_id,
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
