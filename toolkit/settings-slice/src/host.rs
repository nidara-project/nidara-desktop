// SPDX-License-Identifier: LGPL-3.0-or-later
//! Read-only slice on the toolkit's transport (`nk-wayland`). One frame per change.
use crate::{
    Result, data,
    semantics::Worker,
    timing,
    view::{Fonts, Row, View},
};
use nk_wayland::{
    Application, Event, Frame, Material, Options, Window, WindowBackground, WindowLevel,
};
use serde_json::Value;
use std::time::Instant;

struct Slice {
    fonts: Fonts,
    view: View,
    updates: std::sync::mpsc::Receiver<Result<data::Services>>,
    control: bool,
    start: Instant,
    /// Started once the window is mapped: a11y publication is off the first-frame path.
    /// Its entire setup has a deadline, since the phase-0 provider's connection has none.
    semantics: Option<Worker>,
    /// `--control-no-background`: no window background declared (the CI control).
    no_background: bool,
    /// `--window-level LEVEL`: the app's own window background level (the CI check of
    /// `set_window_background_level`); None: the user's.
    window_level: Option<WindowLevel>,
    pointer_x: f64,
    /// What the frame being committed showed, for readiness after its commit.
    painted: Option<Painted>,
    ready: bool,
    error: Option<String>,
}
struct Painted {
    full: bool,
    values: Value,
    icons: Vec<String>,
    samples: Value,
    pixels: Option<Vec<u8>>,
    width: u16,
    height: u16,
    at: Instant,
}
impl Slice {
    fn rows(&self) -> Vec<Row> {
        self.view
            .groups
            .iter()
            .flat_map(|(_, r)| r)
            .cloned()
            .collect()
    }
    fn pages(&self) -> Vec<(String, bool)> {
        self.view
            .pages
            .iter()
            .map(|p| (p.title.clone(), p.selected))
            .collect()
    }
    fn scroll(&mut self, delta: f32, height: u32) -> Result<()> {
        let v = &mut self.view;
        if self.pointer_x < v.exports.number("WINDOW_LAYOUT", "sidebar")? as f64 {
            let single = v.exports.number("ROW_HEIGHT", "single")?;
            v.sidebar_scroll = (v.sidebar_scroll + delta)
                .clamp(0., (v.pages.len() as f32 * single - height as f32).max(0.));
        } else {
            v.content_scroll =
                (v.content_scroll + delta).clamp(0., (v.content_height - height as f32).max(0.));
        }
        Ok(())
    }
    /// Logged after the buffer's commit and flush, never before.
    fn ready(&mut self, commit: u64) -> Result<()> {
        let Some(p) = self.painted.take() else {
            return Ok(());
        };
        if self.ready || !p.full || p.values != self.view.evidence {
            return Ok(());
        }
        timing("first_commit", p.at);
        eprintln!(
            "TIMING main_to_first_commit={:.3}",
            self.start.elapsed().as_secs_f64() * 1000.
        );
        eprintln!("DRAWN_VALUES commit={commit} {}", p.values);
        eprintln!("VISIBLE_ICONS {}", serde_json::json!(p.icons));
        if let (Some(path), Some(pixels)) = (std::env::var_os("NK_SLICE_FRAME"), p.pixels) {
            std::fs::write(&path, pixels).map_err(data::err)?;
            eprintln!(
                "FRAME_EVIDENCE {}",
                serde_json::json!({"path":std::path::PathBuf::from(path).to_string_lossy(),"width":p.width,"height":p.height,"samples":p.samples})
            );
        }
        eprintln!("CONTENT_READY commit={commit}");
        self.ready = true;
        Ok(())
    }
}
impl Application for Slice {
    fn poll_interval_ms(&self) -> u32 {
        // Config1 updates arrive on a channel, not on the Wayland socket.
        16
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        if let Some(e) = self.error.take() {
            return Err(e);
        }
        if self.semantics.is_none() {
            self.semantics = Some(Worker::new(self.rows(), self.pages()));
        }
        self.semantics.as_ref().unwrap().check()?;
        let mut changed = false;
        while let Ok(update) = self.updates.try_recv() {
            self.view.refresh(&update?, self.control)?;
            changed = true;
        }
        if changed {
            let (rows, pages) = (self.rows(), self.pages());
            self.semantics.as_ref().unwrap().refresh(rows, pages);
            w.redraw();
        }
        Ok(())
    }
    fn event(&mut self, event: Event, w: &mut Window) -> Result<()> {
        match event {
            Event::Focus(active) => {
                if let Some(s) = &self.semantics {
                    s.focus(active);
                }
            }
            Event::Motion(x, _) => self.pointer_x = x,
            Event::Scroll(delta) => {
                self.scroll(delta as f32, w.size().1)?;
                w.redraw();
            }
            Event::PreferredScale(scale) => {
                eprintln!("PREFERRED_SCALE scale={scale} after_commit={}", w.commits())
            }
            Event::Presented {
                commit,
                seconds,
                nanoseconds,
            } => eprintln!("PRESENTED commit={commit} seconds={seconds} nanoseconds={nanoseconds}"),
            _ => {}
        }
        Ok(())
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        let painted = self.view.paint(
            &mut self.fonts,
            frame.width,
            frame.height,
            frame.scale,
            frame.material,
        )?;
        let evidence = !self.ready && std::env::var_os("NK_SLICE_FRAME").is_some();
        self.painted = Some(Painted {
            full: painted.full,
            values: painted.values,
            icons: painted.icons,
            samples: painted.samples,
            pixels: evidence.then(|| painted.pixels.clone()),
            width: frame.pixel_width,
            height: frame.pixel_height,
            // first_commit: the buffer's copy, commit and flush, as before the move.
            at: Instant::now(),
        });
        Ok(painted.pixels)
    }
    fn material(&self) -> Option<Material> {
        None
    }
    fn window_background(&self) -> Option<WindowBackground> {
        // The window's background is Hyalo's (toolkit/PHASE1.md D6): the colour only, opaque;
        // how much of it shows, and the blur under it, are the windows' settings there.
        if self.no_background {
            return None;
        }
        let bg = self.view.token("--nidara-bg", true).ok()?;
        Some(WindowBackground {
            color: [bg[0], bg[1], bg[2]].map(|c| c as f64 / 255.),
            level: self.window_level,
        })
    }
    fn committed(&mut self, commit: u64) {
        if let Err(e) = self.ready(commit) {
            self.error = Some(e);
        }
    }
}
pub fn run(
    fonts: Fonts,
    view: View,
    updates: std::sync::mpsc::Receiver<Result<data::Services>>,
    control: bool,
    start: Instant,
) -> Result<()> {
    let size = view.dimensions()?;
    let app = Slice {
        fonts,
        view,
        updates,
        control,
        start,
        semantics: None,
        no_background: std::env::args().any(|s| s == "--control-no-background") && {
            eprintln!("CONTROL_APPLIED no-background");
            true
        },
        window_level: window_level_arg(),
        pointer_x: 0.,
        painted: None,
        ready: false,
        error: None,
    };
    nk_wayland::run(
        app,
        Options {
            material: true,
            map: true,
            app_id: "nk-settings-slice",
            title: "Nidara Settings · measured slice",
            size,
            require_material: None,
        },
        start,
    )
}
/// `--window-level opaque|tinted|translucent`, announced like the controls.
fn window_level_arg() -> Option<WindowLevel> {
    let args: Vec<String> = std::env::args().collect();
    let value = args
        .iter()
        .position(|a| a == "--window-level")
        .and_then(|i| args.get(i + 1))?;
    let level = match value.as_str() {
        "opaque" => WindowLevel::Opaque,
        "tinted" => WindowLevel::Tinted,
        "translucent" => WindowLevel::Translucent,
        _ => return None,
    };
    eprintln!("WINDOW_LEVEL {value}");
    Some(level)
}
