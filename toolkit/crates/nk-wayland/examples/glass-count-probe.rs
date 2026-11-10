// SPDX-License-Identifier: LGPL-3.0-or-later
//! Diagnostic only (VIEW.md §5): one layer surface declaring NK_GLASS_COUNT panes of glass,
//! card-sized, in columns of ten. Every frame it moves them by one pixel, so Hyalo re-draws
//! the glass each frame and `nidara-hyalo msg stats` shows what N panes cost.
use nk_wayland::{
    Application, Edges, Event, Frame, Glass, KeyboardMode, LayerLevel, LayerPlacement, LayerSpec,
    Material, Options, Pane, Shadow, Tone, Window,
};
use std::time::Instant;
type Result<T> = std::result::Result<T, String>;
const W: f64 = 232.;
const H: f64 = 60.;
const GAP: f64 = 8.;
const ROWS: usize = 10;

fn count() -> usize {
    std::env::var("NK_GLASS_COUNT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10)
}
fn size() -> (u32, u32) {
    let cols = std::env::var("NK_GLASS_COLS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(count().div_ceil(ROWS).max(1)) as f64;
    (
        (cols * (W + GAP) + GAP + 2.) as u32,
        (ROWS as f64 * (H + GAP) + GAP + 2.) as u32,
    )
}
struct Probe {
    tick: u64,
}
impl Application for Probe {
    fn event(&mut self, event: Event, _w: &mut Window) -> Result<()> {
        match event {
            Event::Error(e) => return Err(e),
            Event::Configure => eprintln!("READY"),
            _ => {}
        }
        Ok(())
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        self.tick += 1;
        w.redraw();
        Ok(())
    }
    fn poll_interval_ms(&self) -> u32 {
        8
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        Ok(vec![
            0u8;
            f.pixel_width as usize * f.pixel_height as usize * 4
        ])
    }
    fn material(&self) -> Option<Material> {
        let shift = (self.tick % 2) as f64;
        // NK_GLASS_ONE: one pane over the area the cards would cover (today's NC).
        let one = std::env::var_os("NK_GLASS_ONE").is_some();
        let cols = count().div_ceil(ROWS) as f64;
        let shapes = if one {
            vec![Pane {
                x: GAP + shift,
                y: GAP,
                width: cols * (W + GAP) - GAP,
                height: ROWS as f64 * (H + GAP) - GAP,
                radius: 22.,
                exponent: 2.,
                pointer: None,
            }]
        } else {
            (0..count())
                .map(|i| Pane {
                    x: GAP + (i / ROWS) as f64 * (W + GAP) + shift,
                    y: GAP + (i % ROWS) as f64 * (H + GAP),
                    width: W,
                    height: H,
                    radius: 22.,
                    exponent: 2.,
                    pointer: None,
                })
                .collect()
        };
        Some(Material {
            glass: Glass {
                refraction: 1.,
                rim: 1.,
                lensing: 1.,
            },
            tone: Tone {
                saturation: 1.4,
                ceiling: 1.,
                lift: 0.,
                gain: 1.,
                wash: [0.1, 0.1, 0.1, 0.3],
                ambient: 0.,
                ambient_lift: 0.,
                ambient_gain: 1.,
            },
            shadow: Shadow {
                opacity_small: 0.2,
                opacity_large: 0.2,
                blur_small: 4.,
                blur_large: 24.,
                offset: 4.,
            },
            shapes,
            groups: vec![],
            veils: vec![],
            states: vec![],
        })
    }
}
fn main() {
    let r = nk_wayland::run_layer(
        Probe { tick: 0 },
        Options {
            material: true,
            map: true,
            app_id: "nk-glass-count-probe",
            title: "",
            size: size(),
            require_material: None,
        },
        LayerSpec {
            namespace: "nk-glass-count-probe",
            output: None,
            layer: LayerLevel::Top,
            placement: LayerPlacement {
                anchor: Edges::TOP | Edges::LEFT,
                size: size(),
                exclusive_zone: 0,
                margin: [0, 0, 0, 0],
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
