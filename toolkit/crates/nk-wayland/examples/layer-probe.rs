// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic only: a dock-shaped layer root moves bottom → left → right on the SAME
//! wl_surface (SHELL-SURFACES.md §1). A click inside its input region advances; the
//! driver also clicks inside the surface but outside the region, which must not arrive.
use nk_wayland::{
    Application, Edges, Event, Frame, KeyboardMode, LayerLevel, LayerPlacement, LayerSpec,
    Material, Options, Window,
};
use std::time::Instant;
type Result<T> = std::result::Result<T, String>;
const LONG: u32 = 400;
const SHORT: u32 = 64;
const GAP: i32 = 4;

fn placement(step: usize) -> LayerPlacement {
    let (anchor, size, margin) = match step {
        0 => (Edges::BOTTOM, (LONG, SHORT), [0, 0, GAP, 0]),
        1 => (Edges::LEFT, (SHORT, LONG), [0, 0, 0, GAP]),
        _ => (Edges::RIGHT, (SHORT, LONG), [0, GAP, 0, 0]),
    };
    LayerPlacement {
        anchor,
        size,
        exclusive_zone: SHORT as i32 + GAP,
        margin,
        keyboard: KeyboardMode::None,
    }
}
/// The resting shape is the middle half of the long axis.
fn region(step: usize) -> [i32; 4] {
    let (l, s) = (LONG as i32, SHORT as i32);
    if step == 0 {
        [l / 4, 0, l / 2, s]
    } else {
        [0, l / 4, s, l / 2]
    }
}
struct Probe {
    step: usize,
}
impl Application for Probe {
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        match event {
            Event::Error(e) => return Err(e),
            Event::Configure => {
                eprintln!("CONFIGURE step={} size={:?}", self.step, w.size());
                let expected = placement(self.step).size;
                if w.size() == expected {
                    w.set_input_region(Some(&[region(self.step)]))?;
                    eprintln!("READY step={}", self.step);
                }
            }
            Event::Button {
                button: 0x110,
                pressed: true,
                ..
            } => {
                eprintln!("BUTTON step={}", self.step);
                if self.step == 2 {
                    eprintln!("DONE");
                    w.close();
                } else {
                    self.step += 1;
                    w.set_layer_placement(placement(self.step))?;
                    eprintln!("MOVED step={}", self.step);
                    // Same size (left → right): the compositor need not configure again.
                    if w.size() == placement(self.step).size {
                        w.set_input_region(Some(&[region(self.step)]))?;
                        eprintln!("READY step={}", self.step);
                    }
                }
            }
            Event::Closed => eprintln!("CLOSED"),
            _ => {}
        }
        Ok(())
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        let mut px = vec![0u8; f.pixel_width as usize * f.pixel_height as usize * 4];
        for p in px.as_chunks_mut::<4>().0 {
            p.copy_from_slice(&[0x40, 0x30, 0x20, 0xff]);
        }
        Ok(px)
    }
    fn material(&self) -> Option<Material> {
        None
    }
}
fn main() {
    let r = nk_wayland::run_layer(
        Probe { step: 0 },
        Options {
            material: false,
            map: true,
            app_id: "nk-layer-probe",
            title: "",
            size: (LONG, SHORT),
            require_material: None,
        },
        LayerSpec {
            namespace: "nk-layer-probe",
            output: None,
            layer: LayerLevel::Top,
            placement: placement(0),
        },
        Instant::now(),
    );
    if let Err(e) = r {
        eprintln!("ERROR {e}");
        std::process::exit(1);
    }
}
