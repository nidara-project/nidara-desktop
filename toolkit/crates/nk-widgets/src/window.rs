// SPDX-License-Identifier: LGPL-3.0-or-later
//! Independent pane buffers on the existing nk-wayland host. Scrolling never
//! repaints them; resize, font, appearance or pane state changes do.
use crate::*;
use nk_wayland::{Curve, Event, LayerEvent, LayerId, Material, Property, Window};
#[derive(Default)]
pub struct Composition {
    sidebar: Option<LayerId>,
    titlebar: Option<LayerId>,
    painted: Option<(u32, u32, u64, u64)>,
    pub pointer: Point,
    motion: Option<(std::time::Instant, crate::motion::Timeline)>,
}
impl Composition {
    pub fn invalidate_panes(&mut self) {
        self.painted = None;
    }
    pub fn sidebar(&self) -> Option<LayerId> {
        self.sidebar
    }
    pub fn titlebar(&self) -> Option<LayerId> {
        self.titlebar
    }
    pub fn sync(
        &mut self,
        tree: &mut Tree,
        window: &mut Window,
        backend: &mut impl TextBackend,
        palette: Palette,
        panel: &Material,
        layers_allowed: bool,
    ) -> Result<()> {
        if let Some((started, timeline)) = self.motion {
            let (x, _, done) = timeline.sample(started.elapsed().as_secs_f64());
            tree.sidebar_x = x as f32;
            tree.place();
            tree.invalidate(tree.root, Invalid::STATE);
            if done {
                self.motion = None;
                if tree.focused.is_some_and(|id| {
                    matches!(tree.nodes[&id].kind, Kind::Page { .. }) && !tree.showing(id)
                }) {
                    tree.tab(false)?;
                }
            }
        }
        let (w, h) = window.size();
        let layered = window.capabilities().layers && layers_allowed;
        tree.layout(
            Size {
                width: w as f32,
                height: h as f32,
            },
            layered,
            backend,
        )?;
        if layered {
            let inset = tree.content_viewport();
            let sidebar_size = (tree.metrics.sidebar.ceil().max(1.) as u32, h);
            let titlebar_size = (
                inset.width.ceil().max(1.) as u32,
                inset.y.ceil().max(1.) as u32,
            );
            if self.sidebar.is_none() {
                self.sidebar = Some(window.create_layer(sidebar_size)?);
                self.titlebar = Some(window.create_layer(titlebar_size)?);
                window.set_position(
                    self.sidebar.unwrap(),
                    if tree.sidebar_open {
                        0.
                    } else {
                        -f64::from(tree.metrics.sidebar)
                    },
                    0.,
                )?;
                window.set_position(self.titlebar.unwrap(), inset.x as f64, 0.)?;
            }
            let signature = (w, h, window.scale().to_bits(), tree.pane_epoch);
            if self.painted != Some(signature) {
                let sidebar = self.sidebar.unwrap();
                let titlebar = self.titlebar.unwrap();
                window.set_layer_size(sidebar, sidebar_size)?;
                window.set_layer_size(titlebar, titlebar_size)?;
                for (layer, size) in [(sidebar, sidebar_size), (titlebar, titlebar_size)] {
                    let mut material = panel.clone();
                    material.shapes = vec![nk_wayland::Pane {
                        x: 0.,
                        y: 0.,
                        width: size.0 as f64,
                        height: size.1 as f64,
                        radius: 0.,
                        exponent: 2.,
                    }];
                    window.set_layer_material(layer, Some(&material))?;
                }
                let a =
                    window.paint_layer(sidebar, |f| tree.paint(f, Surface::Sidebar, palette))?;
                let b =
                    window.paint_layer(titlebar, |f| tree.paint(f, Surface::TitleBar, palette))?;
                if a && b {
                    self.painted = Some(signature);
                }
                window.redraw();
            }
        } else {
            for layer in [self.sidebar.take(), self.titlebar.take()]
                .into_iter()
                .flatten()
            {
                window.destroy_layer(layer)?;
            }
            self.painted = None;
        }
        if tree.invalidation().paint {
            window.redraw();
        }
        Ok(())
    }
    /// Collapse is a compositor transition over the unchanged full-window layout.
    pub fn set_sidebar_open(
        &mut self,
        tree: &mut Tree,
        window: &mut Window,
        open: bool,
        transition: Option<(u32, Curve)>,
    ) -> Result<()> {
        if tree.sidebar_open == open {
            return Ok(());
        }
        let to = if open {
            0.
        } else {
            -f64::from(tree.metrics.sidebar)
        };
        if self.sidebar.is_none() {
            let velocity = self.motion.map_or(0., |(started, timeline)| {
                timeline.sample(started.elapsed().as_secs_f64()).1
            });
            self.motion = transition
                .map(|(_, curve)| {
                    crate::motion::Timeline::new(f64::from(tree.sidebar_x), to, velocity, curve)
                        .map(|timeline| (std::time::Instant::now(), timeline))
                })
                .transpose()?;
            if self.motion.is_none() {
                tree.sidebar_x = to as f32;
            }
        } else {
            self.motion = None;
            tree.sidebar_x = to as f32;
        }
        tree.sidebar_open = open;
        if let Some(id) = self.sidebar {
            if let Some((serial, curve)) = transition {
                window.set_transition(id, Property::Position, serial, curve)?;
            }
            window.set_position(
                id,
                if open {
                    0.
                } else {
                    -f64::from(tree.metrics.sidebar)
                },
                0.,
            )?;
        }
        tree.place();
        tree.generation += 1;
        if tree
            .focused
            .is_some_and(|id| !tree.focus_order().contains(&id))
        {
            tree.tab(false)?;
        }
        tree.invalidate(tree.root, Invalid::STATE);
        window.redraw();
        Ok(())
    }
    pub fn event(&mut self, tree: &mut Tree, event: &Event) -> Result<Effect> {
        match event {
            Event::Focus(active) => tree.set_active(*active),
            Event::Key(key) if key.sym == 0xff09 || key.sym == 0xfe20 => {
                tree.tab(key.shift || key.sym == 0xfe20)?
            }
            Event::Key(key) if key.sym == 0x20 || key.sym == 0xff0d => {
                if let Some(id) = tree.focused {
                    return tree.dispatch(tree.target(id), Command::Activate);
                }
            }
            Event::Motion(x, y) => {
                self.pointer = Point {
                    x: *x as f32,
                    y: *y as f32,
                }
            }
            Event::Button {
                button: 272,
                pressed,
            } => {
                if *pressed {
                    tree.pointer_press(self.pointer)?;
                } else {
                    return tree.pointer_release(self.pointer);
                }
            }
            Event::Scroll(delta) | Event::HorizontalScroll(delta) => {
                if let Some((&id, n)) = tree.nodes.iter().find(|(_, n)| n.kind == Kind::Scroll) {
                    let mut offset = n.scroll;
                    if matches!(event, Event::HorizontalScroll(_)) {
                        offset.x += *delta as f32;
                    } else {
                        offset.y += *delta as f32;
                    }
                    tree.scroll_to(id, offset)?;
                }
            }
            Event::Layer { id, event } => {
                let kind = if Some(*id) == self.sidebar {
                    Kind::Sidebar
                } else if Some(*id) == self.titlebar {
                    Kind::TitleBar
                } else {
                    return Ok(Effect::None);
                };
                let Some((&container, n)) = tree.nodes.iter().find(|(_, n)| n.kind == kind) else {
                    return Ok(Effect::None);
                };
                let origin = Point {
                    x: n.bounds.x,
                    y: n.bounds.y,
                };
                match event {
                    LayerEvent::Motion(x, y) => {
                        self.pointer = Point {
                            x: origin.x + *x as f32,
                            y: origin.y + *y as f32,
                        }
                    }
                    LayerEvent::Button {
                        button: 272,
                        pressed,
                        x,
                        y,
                    } => {
                        self.pointer = Point {
                            x: origin.x + *x as f32,
                            y: origin.y + *y as f32,
                        };
                        let local = Point {
                            x: *x as f32,
                            y: *y as f32,
                        };
                        if *pressed {
                            tree.pointer_press_in(container, local)?;
                        } else {
                            return tree.pointer_release_in(container, local);
                        }
                    }
                    LayerEvent::Done { .. }
                        if !tree.sidebar_open
                            && tree.focused.is_some_and(|id| {
                                matches!(tree.nodes[&id].kind, Kind::Page { .. })
                            }) =>
                    {
                        tree.tab(false)?
                    }
                    _ => {}
                }
            }
            _ => {}
        }
        Ok(Effect::None)
    }
}
