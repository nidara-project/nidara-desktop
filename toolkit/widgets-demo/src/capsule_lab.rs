// SPDX-License-Identifier: LGPL-3.0-or-later
//! Explicit diagnostic scenes, not product material values or permanent animation.
use crate::{accessibility::Bridge, appearance::Appearance};
use nk_a11y::Request;
use nk_render::{Canvas, rgba};
use nk_text::{Layout, ParleyBackend, Point, Rect, Size, TextBackend};
use nk_wayland::{Application, Event, Frame, Material, Options, Window, WindowAction};
use nk_widgets::{
    Command, Effect, Kind, Result, Target, Tree, capsule_composition::CapsuleComposition,
    window::Composition,
};
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Scene {
    White,
    Text,
    Dark,
    Sweep,
    Overlay,
}
impl Scene {
    fn parse(name: &str) -> Result<Self> {
        match name {
            "white" => Ok(Self::White),
            "text" => Ok(Self::Text),
            "dark" => Ok(Self::Dark),
            "sweep" => Ok(Self::Sweep),
            "overlay" => Ok(Self::Overlay),
            _ => Err("capsule lab expects white/text/dark/sweep/overlay".into()),
        }
    }
}
fn sweep_level(elapsed: Duration, duration: Duration) -> (f32, bool) {
    let t = (elapsed.as_secs_f64() / duration.as_secs_f64()).clamp(0., 1.);
    (
        ((1. - (std::f64::consts::TAU * t).cos()) / 2.) as f32,
        t >= 1.,
    )
}
fn paint_scene(
    canvas: &mut Canvas,
    frame: Frame,
    scene: Scene,
    phase: f32,
    pattern: &Layout,
    gap: f32,
) -> Result<f32> {
    let level = match scene {
        Scene::White | Scene::Text => 1.,
        Scene::Dark => 0.,
        Scene::Sweep => phase,
        Scene::Overlay => return Ok(0.),
    };
    canvas.rect(
        Rect {
            x: 0.,
            y: 0.,
            width: frame.width as f32,
            height: frame.height as f32,
        },
        nk_render::Color::new([level, level, level, 1.]),
    );
    if scene == Scene::Text {
        let size = pattern.measured_size();
        let step = size.height + gap;
        let mut y = 0.;
        while y < frame.height as f32 {
            let mut x = 0.;
            while x < frame.width as f32 {
                canvas.layout(pattern, (x, y), rgba(0, 0, 0, 255))?;
                x += size.width.max(1.);
            }
            y += step.max(1.);
        }
    }
    Ok(level)
}

struct Lab {
    tree: Tree,
    text: ParleyBackend,
    appearance: Appearance,
    updates: mpsc::Receiver<Result<Appearance>>,
    a11y: Option<Bridge>,
    capsules: CapsuleComposition,
    input: Composition,
    panels: [u64; 2],
    controls: [u64; 3],
    choices: Vec<(u64, Scene)>,
    scene: Scene,
    phase: f32,
    duration: Option<Duration>,
    started: Option<Instant>,
    sweep_pending: bool,
    pattern: Layout,
    caption: Layout,
}
impl Lab {
    fn action(&mut self, effect: Effect, window: &mut Window) {
        if let Effect::Activated(id) = effect {
            if let Some(i) = self.controls.iter().position(|v| *v == id) {
                window.window_action(
                    [
                        WindowAction::Minimize,
                        WindowAction::ToggleMaximize,
                        WindowAction::Close,
                    ][i],
                );
            } else if let Some((_, scene)) = self.choices.iter().find(|(v, _)| *v == id) {
                self.scene = *scene;
                self.started = None;
                self.sweep_pending = false;
                if *scene == Scene::Sweep
                    && self.duration.is_some()
                    && !self.appearance.reduce_motion
                {
                    self.started = Some(Instant::now());
                } else if *scene == Scene::Sweep && self.appearance.reduce_motion {
                    eprintln!(
                        "CAPSULE_LAB_SWEEP_DISABLED reduced-motion stationary-level={}",
                        self.phase
                    );
                }
                window.redraw();
            }
        }
    }
    fn sync(&mut self, window: &mut Window) -> Result<()> {
        for panel in self.panels {
            self.tree
                .set_capsule_metrics(panel, self.appearance.capsule_metrics)?;
        }
        let (w, h) = window.size();
        let size = Size {
            width: w as f32,
            height: h as f32,
        };
        self.tree
            .layout(size, window.capabilities().layers, &mut self.text)?;
        let control = self.tree.node(self.panels[0]).unwrap().bounds();
        let toolbar = self.tree.node(self.panels[1]).unwrap().bounds();
        let margin = self.appearance.metrics.padding;
        let server = window.window_controls_layout();
        let reserved = server.map_or(0., |s| s.width as f32 + self.appearance.metrics.gap);
        self.tree.set_capsule_position(
            self.panels[0],
            Point {
                x: (w as f32 - margin - control.width - reserved).max(0.),
                y: margin,
            },
        )?;
        self.tree.set_capsule_position(
            self.panels[1],
            Point {
                x: ((w as f32 - toolbar.width) / 2.).max(0.),
                y: ((h as f32 - toolbar.height) / 2.).max(0.),
            },
        )?;
        self.tree
            .layout(size, window.capabilities().layers, &mut self.text)?;
        if let Some(s) = server {
            window.place_window_controls(
                (w as f64 - margin as f64 - s.width).max(0.),
                margin as f64,
                false,
            )?;
        }
        self.capsules.sync(
            &mut self.tree,
            window,
            self.appearance.palette,
            |side, material| {
                if material {
                    self.appearance.control.at(side)
                } else {
                    self.appearance.opaque_control.at(side)
                }
            },
            self.appearance.reduce_motion,
        )?;
        if self.tree.invalidation().semantics || self.a11y.is_none() {
            if let Some(bridge) = &self.a11y {
                bridge.update(self.tree.generation(), self.tree.semantics())?;
            } else {
                self.a11y = Some(Bridge::new(self.tree.generation(), self.tree.semantics()));
            }
            self.tree.acknowledge_semantics();
        }
        if self.tree.invalidation().paint {
            window.redraw();
        }
        Ok(())
    }
}
impl Application for Lab {
    fn window_controls(&self) -> bool {
        true
    }
    fn poll_interval_ms(&self) -> u32 {
        if self.started.is_some() || self.capsules.is_animating() {
            16
        } else {
            1000
        }
    }
    fn idle(&mut self, window: &mut Window) -> Result<()> {
        while let Ok(appearance) = self.updates.try_recv() {
            let appearance = appearance?;
            self.text = crate::text_backend(&appearance.style)?;
            self.tree.set_text_style(appearance.style.clone());
            self.pattern = self.text.layout(
                "Backdrop text: black letters over a white page. ",
                &appearance.style,
                window.size().0 as f32,
            )?;
            self.caption = self.text.layout(
                "Control capsule lab",
                &appearance.style,
                window.size().0 as f32,
            )?;
            self.input
                .set_titlebar_double_click_ms(appearance.titlebar_double_click_ms)?;
            if appearance.reduce_motion {
                if self.started.is_some() || self.sweep_pending {
                    eprintln!(
                        "CAPSULE_LAB_SWEEP_DISABLED reduced-motion stationary-level={}",
                        self.phase
                    );
                }
                self.started = None;
                self.sweep_pending = false;
            }
            self.appearance = appearance;
            self.capsules.invalidate();
            window.redraw();
        }
        if let Some(start) = self.started {
            let (level, done) = sweep_level(start.elapsed(), self.duration.unwrap());
            self.phase = level;
            if done {
                self.started = None;
                eprintln!("CAPSULE_LAB_SWEEP_DONE");
            }
            window.redraw();
        }
        if let Some(bridge) = &self.a11y {
            bridge.check()?;
        }
        while let Some((generation, request)) =
            self.a11y.as_ref().and_then(|b| b.requests.try_recv().ok())
        {
            let (id, command) = match request {
                Request::Focus(id) => (id, Command::Focus),
                Request::Activate(id) => (id, Command::Activate),
                _ => continue,
            };
            if let Ok(effect) = self.tree.dispatch(Target { id, generation }, command) {
                self.action(effect, window);
                window.redraw();
            }
        }
        self.sync(window)
    }
    fn event(&mut self, event: Event, window: &mut Window) -> Result<()> {
        if let Event::Error(e) = &event {
            return Err(e.clone());
        }
        // Start the bounded diagnostic only once the compositor grants a frame.
        // The initial commit can precede a costly software-renderer startup.
        if matches!(event, Event::FrameDone) && self.sweep_pending {
            self.started = Some(Instant::now());
            self.sweep_pending = false;
            window.redraw();
        }
        let effect = if let Some(e) = self.capsules.event(&mut self.tree, &event)? {
            e
        } else {
            self.input
                .event_with_window(&mut self.tree, &event, window)?
        };
        self.action(effect, window);
        self.sync(window)
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        let mut canvas = Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
        let level = paint_scene(
            &mut canvas,
            frame,
            self.scene,
            self.phase,
            &self.pattern,
            self.appearance.metrics.gap,
        )?;
        canvas.layout(
            &self.caption,
            (
                self.appearance.metrics.padding,
                self.appearance.metrics.padding,
            ),
            if level < 0.5 {
                rgba(255, 255, 255, 255)
            } else {
                rgba(0, 0, 0, 255)
            },
        )?;
        self.tree
            .paint_capsules_fallback_where(&mut canvas, self.appearance.palette, |id| {
                self.capsules.layer(id).is_none()
            })?;
        Ok(canvas.finish())
    }
    fn material(&self) -> Option<Material> {
        None
    }
    fn committed(&mut self, commit: u64) {
        eprintln!(
            "CAPSULE_LAB_COMMIT root={commit} layer_paints={} phase={} scene={:?}",
            self.capsules.paint_count(),
            self.phase,
            self.scene
        );
        self.tree.acknowledge();
    }
}
pub fn run(
    name: &str,
    appearance: Appearance,
    updates: mpsc::Receiver<Result<Appearance>>,
    start: Instant,
    size: (u32, u32),
) -> Result<()> {
    let scene = Scene::parse(name)?;
    let level = std::env::args()
        .find_map(|a| a.strip_prefix("--capsule-level=").map(str::to_owned))
        .unwrap_or_else(|| "0".into())
        .parse::<f32>()
        .map_err(|e| e.to_string())?;
    if !level.is_finite() || !(0. ..=1.).contains(&level) {
        return Err("capsule level must be between0 and1".into());
    }
    let duration = std::env::args()
        .find_map(|a| a.strip_prefix("--capsule-sweep-ms=").map(str::to_owned))
        .map(|s| s.parse::<u32>().map_err(|e| e.to_string()))
        .transpose()?
        .map(|ms| {
            if ms == 0 {
                Err("sweep duration must be positive".to_string())
            } else {
                Ok(Duration::from_millis(ms as u64))
            }
        })
        .transpose()?;
    let mut text = crate::text_backend(&appearance.style)?;
    let pattern = text.layout(
        "Backdrop text: black letters over a white page. ",
        &appearance.style,
        size.0 as f32,
    )?;
    let caption = text.layout("Control capsule lab", &appearance.style, size.0 as f32)?;
    let mut metrics = appearance.metrics;
    metrics.sidebar = 0.;
    let mut tree = Tree::new(
        "Nidara control capsule lab",
        metrics,
        appearance.style.clone(),
    )?;
    tree.append(tree.root(), Kind::TitleBar, "Control capsule lab")?;
    let native = tree.control_capsule(
        "Native window controls",
        Point::default(),
        appearance.capsule_metrics,
    )?;
    let controls = [
        tree.capsule_button(native, "Minimize", "-", false)?,
        tree.capsule_button(native, "Maximize", "+", false)?,
        tree.capsule_button(native, "Close", "x", true)?,
    ];
    let toolbar = tree.control_capsule(
        "Backdrop controls",
        Point::default(),
        appearance.capsule_metrics,
    )?;
    let mut choices = vec![];
    for (name, glyph, scene) in [
        ("White backdrop", "W", Scene::White),
        ("Text backdrop", "T", Scene::Text),
        ("Dark backdrop", "D", Scene::Dark),
        ("Sweep backdrop", "S", Scene::Sweep),
    ] {
        choices.push((tree.capsule_button(toolbar, name, glyph, false)?, scene));
    }
    let mut input = Composition::default();
    input.set_titlebar_double_click_ms(appearance.titlebar_double_click_ms)?;
    let sweep_pending = scene == Scene::Sweep && duration.is_some() && !appearance.reduce_motion;
    let started = None;
    if scene == Scene::Sweep && appearance.reduce_motion {
        eprintln!("CAPSULE_LAB_SWEEP_DISABLED reduced-motion stationary-level={level}");
    }
    nk_wayland::run(
        Lab {
            tree,
            text,
            appearance,
            updates,
            a11y: None,
            capsules: Default::default(),
            input,
            panels: [native, toolbar],
            controls,
            choices,
            scene,
            phase: level,
            duration,
            started,
            sweep_pending,
            pattern,
            caption,
        },
        Options {
            material: true,
            map: true,
            app_id: "nk-capsule-lab",
            title: "Nidara control capsule lab",
            size,
            require_material: None,
        },
        start,
    )
}
// A deliberately separate Wayland client. The driver changes one file at a time;
// unchanged input never requests redraw, and there is no animation loop.
struct Backdrop {
    path: String,
    command: String,
    scene: Scene,
    level: f32,
    pattern: Layout,
    gap: f32,
}
fn backdrop_command(value: &str) -> Result<(Scene, f32)> {
    let mut words = value.split_whitespace();
    let scene = Scene::parse(words.next().ok_or("empty backdrop command")?)?;
    if scene == Scene::Overlay {
        return Err("external backdrop must be opaque".into());
    }
    let level = words
        .next()
        .map(str::parse::<f32>)
        .transpose()
        .map_err(|e| e.to_string())?
        .unwrap_or(0.);
    if !level.is_finite() || !(0. ..=1.).contains(&level) || words.next().is_some() {
        return Err("invalid external backdrop level".into());
    }
    Ok((scene, level))
}
impl Application for Backdrop {
    fn event(&mut self, event: Event, _: &mut Window) -> Result<()> {
        if let Event::Error(error) = event {
            return Err(error);
        }
        Ok(())
    }
    fn material(&self) -> Option<Material> {
        None
    }

    fn idle(&mut self, window: &mut Window) -> Result<()> {
        let command = std::fs::read_to_string(&self.path).map_err(|e| e.to_string())?;
        if command != self.command {
            (self.scene, self.level) = backdrop_command(&command)?;
            self.command = command;
            window.redraw();
        }
        Ok(())
    }
    fn paint(&mut self, frame: Frame) -> Result<Vec<u8>> {
        let mut canvas = Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
        paint_scene(
            &mut canvas,
            frame,
            self.scene,
            self.level,
            &self.pattern,
            self.gap,
        )?;
        Ok(canvas.finish())
    }
    fn committed(&mut self, commit: u64) {
        eprintln!(
            "CAPSULE_BACKDROP_COMMIT root={commit} command={}",
            self.command.trim()
        );
    }
}
pub fn run_backdrop(path: String, appearance: Appearance, start: Instant) -> Result<()> {
    let command = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let (scene, level) = backdrop_command(&command)?;
    let mut text = crate::text_backend(&appearance.style)?;
    let pattern = text.layout(
        "Backdrop text: black letters over a white page. ",
        &appearance.style,
        1100.,
    )?;
    nk_wayland::run(
        Backdrop {
            path,
            command,
            scene,
            level,
            pattern,
            gap: appearance.metrics.gap,
        },
        Options {
            material: false,
            map: true,
            app_id: "nk-capsule-backdrop",
            title: "Capsule external backdrop",
            size: (1100, 620),
            require_material: None,
        },
        start,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn backdrop_paints_opaque_stimuli_and_overlay_keeps_transparency() {
        let style = nk_text::TextStyle::default();
        let mut text = crate::text_backend(&style).unwrap();
        let pattern = text.layout("Backdrop text", &style, 96.).unwrap();
        let frame = Frame {
            width: 96,
            height: 64,
            pixel_width: 96,
            pixel_height: 64,
            scale: 1.,
            material: false,
        };
        let mut backdrop = Backdrop {
            path: String::new(),
            command: "white".into(),
            scene: Scene::White,
            level: 0.,
            pattern,
            gap: 3.,
        };
        let white = backdrop.paint(frame).unwrap();
        assert!(
            white
                .as_chunks::<4>()
                .0
                .iter()
                .all(|p| *p == [255, 255, 255, 255])
        );
        backdrop.scene = Scene::Dark;
        let dark = backdrop.paint(frame).unwrap();
        assert!(dark.as_chunks::<4>().0.iter().all(|p| *p == [0, 0, 0, 255]));
        backdrop.scene = Scene::Sweep;
        backdrop.level = 0.25;
        let gray = backdrop.paint(frame).unwrap();
        assert!(gray.as_chunks::<4>().0.iter().all(|p| p[0] > 0
            && p[0] < 255
            && p[0] == p[1]
            && p[1] == p[2]
            && p[3] == 255));
        backdrop.scene = Scene::Text;
        let text = backdrop.paint(frame).unwrap();
        assert!(text.as_chunks::<4>().0.iter().all(|p| p[3] == 255));
        assert!(
            text.as_chunks::<4>().0.iter().any(|p| p[0] < 128),
            "text stimulus omitted dark glyphs"
        );
        let mut canvas = Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
        paint_scene(
            &mut canvas,
            frame,
            Scene::Overlay,
            0.,
            &backdrop.pattern,
            3.,
        )
        .unwrap();
        assert!(
            canvas.finish().iter().all(|v| *v == 0),
            "overlay stimulus painted over the external backdrop"
        );
    }
    #[test]
    fn sweep_samples_clamp_to_one_cycle() {
        let duration = Duration::from_secs(2);
        assert_eq!(sweep_level(Duration::ZERO, duration), (0., false));
        assert_eq!(sweep_level(Duration::from_secs(1), duration), (1., false));
        assert_eq!(sweep_level(duration, duration), (0., true));
        assert_eq!(sweep_level(duration * 2, duration), (0., true));
        assert!(Scene::parse("unrecognized").is_err());
        assert_eq!(
            backdrop_command("sweep 0.25").unwrap(),
            (Scene::Sweep, 0.25)
        );
        for invalid in [
            "",
            "overlay",
            "sweep NaN",
            "sweep inf",
            "sweep -0.1",
            "sweep 1.1",
            "white extra",
            "dark 0 extra",
        ] {
            assert!(
                backdrop_command(invalid).is_err(),
                "accepted invalid backdrop command: {invalid}"
            );
        }
    }
}
