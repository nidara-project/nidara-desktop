// SPDX-License-Identifier: LGPL-3.0-or-later
//! Test 5 uses the real Window/buffer/input path, with diagnostic colours shared
//! with the server's C probe. All motion parameters belong to this app.
use crate::{Result, material, palette};
use nk_render::{Canvas, rgba};
use nk_text::{FontSet, Layout, ParleyBackend, Rect, TextBackend, TextStyle};
use nk_wayland::{
    Application, Curve, Event, Frame, LayerEvent, LayerId, Material, Property, TextInput, Window,
};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
const A_Y: f64 = 40.;
const B_Y: f64 = 180.;
const BUTTON: Rect = Rect {
    x: 24.,
    y: 300.,
    width: 180.,
    height: 44.,
};
const RED: (u8, u8, u8) = (224, 32, 32);
const BLUE: (u8, u8, u8) = (32, 64, 224);
fn linear() -> Curve {
    Curve::Bezier {
        x1: 0.,
        y1: 0.,
        x2: 1.,
        y2: 1.,
        duration_ms: 2000,
    }
}
fn spring() -> Curve {
    Curve::Spring {
        mass: 1.,
        stiffness: 30.,
        damping: 4.,
        initial_velocity: 0.,
    }
}
pub struct MotionApp {
    layers: Option<[LayerId; 2]>,
    pointer: (f64, f64),
    ready: bool,
    palette: palette::Palette,
    start_label: Layout,
    a_label: Layout,
    scale: f64,
    width: u32,
    height: u32,
    no_parent: bool,
    cursor_mode: bool,
    no_cursor: bool,
    client_motion: bool,
    moving: Option<Instant>,
    paints: u32,
    retarget: bool,
    started: bool,
    ids: u32,
    repaint_layers: bool,
}
impl MotionApp {
    pub fn new(args: &[String]) -> Result<Self> {
        let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required()?))?;
        Ok(Self {
            layers: None,
            pointer: (0., 0.),
            ready: false,
            palette: palette::Palette::startup()?,
            start_label: text.layout("Start test 5", &TextStyle::default(), 170.)?,
            a_label: text.layout("A", &TextStyle::default(), 70.)?,
            scale: 0.,
            width: 960,
            height: 720,
            cursor_mode: false,
            no_cursor: args.iter().any(|s| s == "--control-no-cursor-association"),
            no_parent: args.iter().any(|s| s == "--control-no-parent-commit"),
            client_motion: args.iter().any(|s| s == "--control-client-motion"),
            moving: None,
            paints: 0,
            retarget: false,
            started: false,
            ids: 0,
            repaint_layers: true,
        })
    }
    fn configure(&mut self, w: &mut Window) -> Result<()> {
        (self.width, self.height) = w.size();
        if self.client_motion {
            return Ok(());
        }
        if self.layers.is_none() {
            let a = w.create_layer((80, 60))?;
            let b = w.create_layer((80, 60))?;
            // Exercise the app-side limit and ID lifetime against a real server.
            let mut extras = Vec::new();
            for _ in 2..64 {
                extras.push(w.create_layer((1, 1))?);
            }
            if w.create_layer((1, 1)).is_ok() {
                return Err("65th layer accepted".into());
            }
            for id in extras {
                w.destroy_layer(id)?;
            }
            let fresh = w.create_layer((1, 1))?;
            w.destroy_layer(fresh)?;
            if w.set_position(fresh, 0., 0.).is_ok() {
                return Err("destroyed ID accepted".into());
            }
            println!("LIMIT_OK");
            w.set_position(a, 20., A_Y)?;
            w.set_position(b, 20., B_Y)?;
            self.layers = Some([a, b]);
        }
        self.repaint_layers |= self.scale != w.scale();
        self.scale = w.scale();
        Ok(())
    }
    fn begin(&mut self, w: &mut Window, retarget: bool) -> Result<()> {
        if self.started {
            return Ok(());
        }
        self.started = true;
        self.retarget = retarget;
        self.moving = Some(Instant::now());
        if let Some([a, b]) = self.layers {
            for (id, y, serial) in [(a, A_Y, 1), (b, B_Y, 2)] {
                w.set_transition(
                    id,
                    Property::Position,
                    serial,
                    if retarget { spring() } else { linear() },
                )?;
                w.set_position(id, 300., y)?;
            }
            if self.cursor_mode {
                w.set_transition(a, Property::Scale, 7, linear())?;
                w.set_scale(a, 1.5, (40., 30.))?;
            }
            if self.no_parent {
                w.control_commit_children_only()?;
            } else {
                w.commit()?;
            }
        }
        self.ids = 2;
        println!("MOVED");
        if !retarget {
            // No dispatch, painting, commit or polling during this interval.
            let before = self.paints;
            std::thread::sleep(Duration::from_millis(1500));
            println!("AWAKE PAINTS {before} {}", self.paints);
        }
        Ok(())
    }
    fn retarget(&mut self, w: &mut Window) -> Result<()> {
        if !self.retarget || self.ids != 2 {
            return Ok(());
        }
        if let Some([a, b]) = self.layers {
            for (id, y, serial) in [(a, A_Y, 3), (b, B_Y, 4)] {
                w.set_transition(id, Property::Position, serial, spring())?;
                w.set_position(id, 20., y)?;
            }
            w.commit()?;
        }
        self.ids = 4;
        println!("RETARGETED");
        Ok(())
    }
}
fn solid(f: Frame, colour: (u8, u8, u8), label: Option<&Layout>) -> Result<Vec<u8>> {
    let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
    c.rect(
        Rect {
            x: 0.,
            y: 0.,
            width: f.width as f32,
            height: f.height as f32,
        },
        rgba(colour.0, colour.1, colour.2, 255),
    );
    if let Some(label) = label {
        c.layout(label, (32., 10.), rgba(255, 255, 255, 255))?;
    }
    Ok(c.finish())
}
impl Application for MotionApp {
    fn poll_interval_ms(&self) -> u32 {
        if self.client_motion && self.moving.is_some() {
            16
        } else {
            1000
        }
    }
    fn idle(&mut self, w: &mut Window) -> Result<()> {
        if self.repaint_layers
            && let Some([a, b]) = self.layers
        {
            let pa = w.paint_layer(a, |f| solid(f, RED, Some(&self.a_label)))?;
            let pb = w.paint_layer(b, |f| solid(f, BLUE, None))?;
            self.repaint_layers = !(pa && pb);
        }
        if self.client_motion && self.moving.is_some() {
            w.redraw();
        }
        Ok(())
    }
    fn event(&mut self, e: Event, w: &mut Window) -> Result<()> {
        match e {
            Event::Configure => self.configure(w)?,
            Event::FrameDone if !self.ready => {
                self.ready = true;
                println!("READY");
            }
            Event::Motion(x, y) => self.pointer = (x, y),
            Event::Button {
                button: 0x110,
                pressed: true,
            } => {
                println!("PRESS WINDOW {:.3} {:.3}", self.pointer.0, self.pointer.1);
                if self.pointer.0 >= f64::from(BUTTON.x)
                    && self.pointer.0 < f64::from(BUTTON.x + BUTTON.width)
                    && self.pointer.1 >= f64::from(BUTTON.y)
                    && self.pointer.1 < f64::from(BUTTON.y + BUTTON.height)
                {
                    self.begin(w, false)?;
                }
            }
            Event::Key(k) if k.text == "i" => {
                if let Some([a, _]) = self.layers {
                    self.cursor_mode = true;
                    let input = TextInput {
                        focused: true,
                        rect: [32, 24, 2, 12],
                        ..Default::default()
                    };
                    if self.no_cursor {
                        w.set_text_input(TextInput {
                            rect: [52, 64, 2, 12],
                            ..input
                        });
                    } else {
                        w.set_layer_text_input(a, input)?;
                    }
                }
            }
            Event::Key(k) if k.text == "o" => {
                w.set_text_input(TextInput {
                    focused: true,
                    rect: [220, 120, 2, 12],
                    ..Default::default()
                });
            }
            Event::Key(k) if k.text == "u" => {
                if let Some([a, b]) = self.layers {
                    let curve = Curve::Bezier {
                        x1: 0.,
                        y1: 0.,
                        x2: 1.,
                        y2: 1.,
                        duration_ms: 200,
                    };
                    w.set_transition(a, Property::Scale, 5, curve)?;
                    w.set_scale(a, 1.5, (40., 30.))?;
                    w.set_transition(b, Property::Opacity, 6, curve)?;
                    w.set_opacity(b, 0.)?;
                    w.commit()?;
                }
            }
            Event::Key(k) if k.text == "b" => {
                if let Some([a, b]) = self.layers {
                    w.set_scale(a, 1., (0., 0.))?;
                    w.set_opacity(b, 1.)?;
                    w.set_layer_size(a, (100, 70))?;
                    // Repeated invalidations before a commit must reuse the
                    // pending slot: a never-committed attachment has no release.
                    for _ in 0..4 {
                        if !w.paint_layer(a, |f| solid(f, RED, Some(&self.a_label)))? {
                            return Err("pending/released layer slot not reusable".into());
                        }
                    }
                    w.commit()?;
                    println!("BUFFER_REPLACED");
                }
            }
            Event::Key(k) if k.text == "r" => self.begin(w, true)?,
            Event::Key(k) if k.text == "t" => self.retarget(w)?,
            Event::Layer { id, event } => match event {
                LayerEvent::Button {
                    pressed: true,
                    x,
                    y,
                    ..
                } => {
                    let name = if self.layers.is_some_and(|l| l[0] == id) {
                        "A"
                    } else {
                        "B"
                    };
                    println!("PRESS {name} {x:.3} {y:.3}");
                }
                LayerEvent::Done {
                    serial,
                    seconds,
                    nanoseconds,
                } => println!("DONE {serial} {seconds} {nanoseconds}"),
                LayerEvent::Cancelled { serial } => println!("CANCELLED {serial}"),
                _ => {}
            },
            _ => {}
        }
        Ok(())
    }
    fn paint(&mut self, f: Frame) -> Result<Vec<u8>> {
        self.paints += 1;
        println!("PAINT {}", self.paints);
        let mut c = Canvas::new(f.pixel_width, f.pixel_height, f.scale);
        c.rounded_rect(BUTTON, 8., self.palette.field);
        c.layout(&self.start_label, (32., 310.), self.palette.ink)?;
        if self.client_motion {
            let x = self.moving.map_or(20., |t| {
                20. + 280. * (t.elapsed().as_secs_f32() / 2.).min(1.)
            });
            for (y, rgb) in [(A_Y, RED), (B_Y, BLUE)] {
                c.rect(
                    Rect {
                        x,
                        y: y as f32,
                        width: 80.,
                        height: 60.,
                    },
                    rgba(rgb.0, rgb.1, rgb.2, 255),
                );
            }
        }
        Ok(c.finish())
    }
    fn material(&self) -> Option<Material> {
        Some(material::panel(self.width as f32, self.height as f32))
    }
}
