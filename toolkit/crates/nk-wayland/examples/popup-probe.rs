// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic only: standard popup lifecycle under the existing headless harness.
use nk_wayland::{Application, Event, Frame, Material, Options, PopupPlacement, Window};
use std::time::Instant;
type Result<T> = std::result::Result<T, String>;
const PLACEMENT: PopupPlacement = PopupPlacement {
    anchor: [120, 100, 100, 30],
    size: (200, 120),
};
struct Probe {
    child: bool,
    ready: bool,
    repositioned: bool,
    toplevel_control: bool,
    child_error: bool,
}
impl Application for Probe {
    fn poll_interval_ms(&self) -> u32 {
        16
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        // An independent diagnostic end barrier lets even a wrong child role finish.
        if self.child
            && std::env::var_os("NK_POPUP_FINISH")
                .is_some_and(|p| std::path::Path::new(&p).exists())
        {
            w.close();
            return Ok(());
        }
        if self.child && self.ready && self.child_error {
            return Err("deliberate child callback error".into());
        }
        if self.child && self.ready && !self.repositioned {
            self.repositioned = true;
            let result = w.reposition_popup(
                PopupPlacement {
                    anchor: [160, 140, 100, 30],
                    ..PLACEMENT
                },
                17,
            );
            eprintln!("REPOSITION_REQUEST {}", result.is_ok());
            if !self.toplevel_control {
                result?;
            }
        }
        Ok(())
    }
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        match event {
            Event::Error(e) => return Err(e),
            Event::Configure => {
                eprintln!("CONFIGURE child={} size={:?}", self.child, w.size());
                w.redraw();
            }
            Event::PopupDone => eprintln!("POPUP_DONE"),
            Event::PopupRepositioned(token) => eprintln!("REPOSITIONED {token}"),
            Event::Key(key) if key.sym == 0xff1b => w.close(),
            Event::Key(key) if !self.child && key.sym == 0xff0d => {
                eprintln!("OPEN_FROM_KEY serial={:?}", key.serial);
                let child = Self {
                    child: true,
                    ready: false,
                    repositioned: false,
                    toplevel_control: self.toplevel_control,
                    child_error: self.child_error,
                };
                if self.toplevel_control {
                    nk_wayland::run_dialog(child, w)?;
                } else {
                    let result = nk_wayland::run_popup(child, w, PLACEMENT, key.serial);
                    if self.child_error {
                        if result.as_ref().err().map(String::as_str)
                            != Some("deliberate child callback error")
                        {
                            return Err("wrong child error result".into());
                        }
                        eprintln!("CHILD_ERROR_CAUGHT");
                    } else {
                        result?;
                    }
                }
                eprintln!("PARENT_RESUMED");
                w.close();
            }
            _ => {}
        }
        Ok(())
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        let mut pixels = vec![0; f.pixel_width as usize * f.pixel_height as usize * 4];
        for p in pixels.as_chunks_mut::<4>().0 {
            p[3] = 255;
        }
        Ok(pixels)
    }
    fn material(&self) -> Option<Material> {
        None
    }
    fn committed(&mut self, serial: u64) {
        if !self.ready {
            eprintln!(
                "{}_READY commit={serial}",
                if self.child { "CHILD" } else { "PARENT" }
            );
            self.ready = true;
        }
    }
}
fn main() {
    let control = std::env::args().any(|a| a == "--toplevel-control");
    if let Err(e) = nk_wayland::run(
        Probe {
            child: false,
            ready: false,
            repositioned: false,
            toplevel_control: control,
            child_error: std::env::args().any(|a| a == "--child-error"),
        },
        Options {
            material: false,
            map: true,
            app_id: "nk-popup-probe",
            title: "Popup probe",
            size: (640, 480),
            require_material: None,
        },
        Instant::now(),
    ) {
        eprintln!("PROBE_ERROR {e}");
        std::process::exit(1);
    }
}
