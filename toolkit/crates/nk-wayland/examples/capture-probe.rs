// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic only (SHELL-SURFACES.md §5): a dock-shaped layer root captures the window
//! the driver names in NK_CAPTURE_ID (Hyalo's window id in hex), then shows the limits:
//! nine at once (one Busy), a cancel, an unknown id, and the window after it closed.
//! With NK_CAPTURE_CLOSE=1 it starts one capture and closes itself at once: the capture
//! must still end, exactly once, as Closed.
use nk_wayland::{
    Application, CaptureFailure, CaptureId, Edges, Event, Frame, KeyboardMode, LayerLevel,
    LayerPlacement, LayerSpec, Material, Options, Window,
};
use std::collections::HashSet;
use std::time::Instant;
type Result<T> = std::result::Result<T, String>;
#[derive(Default)]
struct Probe {
    close_at_once: bool,
    configured: bool,
    target: Option<String>,
    step: u32,
    batch: HashSet<CaptureId>,
    cancelled: Option<CaptureId>,
}
fn file(name: &str) -> Option<String> {
    let path = std::env::var(name).ok()?;
    let text = std::fs::read_to_string(path).ok()?;
    Some(text.trim().to_string()).filter(|t| !t.is_empty())
}
impl Application for Probe {
    fn poll_interval_ms(&self) -> u32 {
        20
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        if !self.configured {
            return Ok(());
        }
        match self.step {
            0 => {
                let Some(id) = file("NK_CAPTURE_ID") else {
                    return Ok(());
                };
                // The list may not have the window yet: retry until it does.
                match w.capture_window(&id, (64, 64)) {
                    Err(CaptureFailure::NotFound) => return Ok(()),
                    r => eprintln!("CAPTURE_STARTED {r:?}"),
                }
                if self.close_at_once {
                    w.close();
                    eprintln!("AFTER_CLOSE_REQUEST {:?}", w.capture_window(&id, (64, 64)));
                    self.step = 9;
                    return Ok(());
                }
                self.target = Some(id);
                self.step = 1;
            }
            2 => {
                let id = self.target.clone().unwrap();
                for _ in 0..9 {
                    match w.capture_window(&id, (32, 32)) {
                        Ok(c) => {
                            self.batch.insert(c);
                        }
                        Err(e) => eprintln!("BATCH_REFUSED {e:?}"),
                    }
                }
                let first = *self.batch.iter().min_by_key(|c| c.0).unwrap();
                w.cancel_capture(first);
                self.cancelled = Some(first);
                eprintln!("BATCH_STARTED {}", self.batch.len());
                eprintln!("UNKNOWN {:?}", w.capture_window("ffffffffff", (32, 32)));
                self.step = 3;
            }
            4 => {
                if file("NK_CLOSED").is_none() {
                    return Ok(());
                }
                let id = self.target.clone().unwrap();
                match w.capture_window(&id, (32, 32)) {
                    // The list's "closed" may still be on its way.
                    Ok(c) => {
                        self.batch.insert(c);
                        eprintln!("AFTER_CLOSE_STARTED");
                        self.step = 5;
                    }
                    Err(e) => {
                        eprintln!("AFTER_CLOSE {e:?}");
                        eprintln!("DONE");
                        w.close();
                    }
                }
            }
            _ => {}
        }
        Ok(())
    }
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        match event {
            Event::Error(e) => return Err(e),
            Event::Configure => self.configured = true,
            Event::Capture { id, result } if self.step == 9 => {
                eprintln!("TERMINAL {id:?} {:?}", result.map(|_| "image"))
            }
            Event::Capture { id, result } => match self.step {
                1 => {
                    match &result {
                        Ok(img) => {
                            let at = |x: u32, y: u32| {
                                let i = ((y * img.width + x) * 4) as usize;
                                img.rgba[i..i + 4].to_vec()
                            };
                            let (cy, l, r) = (img.height / 2, img.width / 4, img.width * 3 / 4);
                            eprintln!(
                                "IMAGE {}x{} left={:?} right={:?}",
                                img.width,
                                img.height,
                                at(l, cy),
                                at(r, cy)
                            );
                        }
                        Err(e) => eprintln!("IMAGE_FAILED {e:?}"),
                    }
                    self.step = 2;
                }
                3 | 5 => {
                    if self.batch.remove(&id) {
                        let what = match &result {
                            Ok(_) => "image".to_string(),
                            Err(e) => format!("{e:?}"),
                        };
                        let cancelled = Some(id) == self.cancelled;
                        eprintln!("BATCH_RESULT cancelled={cancelled} {what}");
                    } else {
                        eprintln!("UNEXPECTED {id:?}");
                    }
                    if self.batch.is_empty() {
                        if self.step == 3 {
                            eprintln!("BATCH_DONE");
                            self.step = 4;
                        } else {
                            eprintln!("DONE");
                            w.close();
                        }
                    }
                }
                _ => eprintln!("UNEXPECTED {id:?}"),
            },
            _ => {}
        }
        Ok(())
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        Ok(vec![
            0x40;
            f.pixel_width as usize * f.pixel_height as usize * 4
        ])
    }
    fn material(&self) -> Option<Material> {
        None
    }
}
fn main() {
    let r = nk_wayland::run_layer(
        Probe {
            close_at_once: std::env::var("NK_CAPTURE_CLOSE").is_ok_and(|v| v == "1"),
            ..Default::default()
        },
        Options {
            material: false,
            map: true,
            app_id: "nk-capture-probe",
            title: "",
            size: (200, 40),
            require_material: None,
        },
        LayerSpec {
            namespace: "nk-capture-probe",
            output: None,
            layer: LayerLevel::Top,
            placement: LayerPlacement {
                anchor: Edges::TOP,
                size: (200, 40),
                exclusive_zone: 0,
                margin: [0; 4],
                keyboard: KeyboardMode::None,
            },
        },
        None,
        Instant::now(),
    );
    if let Err(e) = r {
        eprintln!("ERROR {e}");
        std::process::exit(1);
    }
}
