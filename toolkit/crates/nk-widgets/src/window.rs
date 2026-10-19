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
    motion: Option<(
        std::time::Instant,
        crate::motion::Timeline,
        crate::motion::Timeline,
    )>,
    transition: Option<(u32, Curve)>,
}
impl Composition {
    pub fn at_rest(&self) -> bool {
        self.motion.is_none()
    }
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
        let (w, h) = window.size();
        let initialized = tree.sidebar_initialized;
        let adapted = tree.adapt_sidebar(w as f32);
        if adapted {
            self.animate(
                tree,
                window,
                if initialized { self.transition } else { None },
            )?;
        }
        if let Some(open) = tree.sidebar_request.take() {
            self.set_sidebar_open(tree, window, open, self.transition)?;
        }
        self.sample(tree, None);
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
                window.set_position(titlebar, inset.x as f64, 0.)?;
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
    /// Use the same curve for the compositor pane and the content relayout.
    /// A reduced-motion app supplies None. The curve is also used on resize.
    pub fn set_sidebar_transition(&mut self, transition: Option<(u32, Curve)>) {
        self.transition = transition;
    }
    fn animate(
        &mut self,
        tree: &mut Tree,
        window: &mut Window,
        transition: Option<(u32, Curve)>,
    ) -> Result<()> {
        self.start_motion(tree, transition)?;
        if let Some(id) = self.sidebar {
            if let Some((serial, curve)) = transition {
                window.set_transition(id, Property::Position, serial, curve)?;
            }
            window.set_position(id, tree.sidebar_target() as f64, 0.)?;
        }
        window.redraw();
        Ok(())
    }
    fn start_motion(&mut self, tree: &mut Tree, transition: Option<(u32, Curve)>) -> Result<()> {
        self.sample(tree, None);
        let (vx, vi) = self.motion.map_or((0., 0.), |(started, x, inset)| {
            let elapsed = started.elapsed().as_secs_f64();
            (x.sample(elapsed).1, inset.sample(elapsed).1)
        });
        self.motion = transition
            .map(|(_, curve)| -> Result<_> {
                Ok((
                    std::time::Instant::now(),
                    crate::motion::Timeline::new(
                        tree.sidebar_x as f64,
                        tree.sidebar_target() as f64,
                        vx,
                        curve,
                    )?,
                    crate::motion::Timeline::new(
                        tree.leading as f64,
                        tree.inset_target() as f64,
                        vi,
                        curve,
                    )?,
                ))
            })
            .transpose()?;
        if self.motion.is_none() {
            tree.sidebar_x = tree.sidebar_target();
            tree.leading = tree.inset_target();
        }
        tree.invalidate(tree.root, Invalid::LAYOUT);
        tree.pane_epoch += 1;
        Ok(())
    }
    // `seconds` is an explicit clock for compositor-free tests of both directions.
    fn sample(&mut self, tree: &mut Tree, seconds: Option<f64>) {
        if let Some((started, x, inset)) = self.motion {
            let t = seconds.unwrap_or_else(|| started.elapsed().as_secs_f64());
            let (x, _, xdone) = x.sample(t);
            let (inset, _, idone) = inset.sample(t);
            tree.sidebar_x = x as f32;
            tree.leading = inset as f32;
            tree.invalidate(tree.root, Invalid::LAYOUT);
            tree.pane_epoch += 1;
            if xdone && idone {
                self.motion = None;
            }
        }
        if !tree.sidebar_open
            && self.motion.is_none()
            && tree
                .focused
                .is_some_and(|id| matches!(tree.nodes[&id].kind, Kind::Page { .. }))
        {
            // Do not leave a focused page behind the closed pane.
            let _ = tree.tab(false);
        }
    }
    pub fn set_sidebar_open(
        &mut self,
        tree: &mut Tree,
        window: &mut Window,
        open: bool,
        transition: Option<(u32, Curve)>,
    ) -> Result<()> {
        self.transition = transition;
        if tree.sidebar_open != open {
            tree.change_sidebar(open);
            self.animate(tree, window, transition)?;
        }
        Ok(())
    }
    fn scroll(
        &mut self,
        tree: &mut Tree,
        sidebar: bool,
        horizontal: bool,
        delta: f64,
    ) -> Result<()> {
        // A horizontal gesture on the sidebar has no horizontal navigation;
        // continue it into the underlying content, like the title pane.
        let kind = if sidebar && !horizontal {
            Kind::Sidebar
        } else {
            Kind::Scroll
        };
        if let Some((&id, n)) = tree.nodes.iter().find(|(_, n)| n.kind == kind) {
            let mut offset = n.scroll;
            if horizontal {
                offset.x += delta as f32;
            } else {
                offset.y += delta as f32;
            }
            tree.scroll_to(id, offset)?;
        }
        Ok(())
    }
    fn layer_scroll(&mut self, tree: &mut Tree, kind: Kind, event: &LayerEvent) -> Result<bool> {
        match event {
            LayerEvent::Scroll(delta) | LayerEvent::HorizontalScroll(delta) => {
                self.scroll(
                    tree,
                    kind == Kind::Sidebar,
                    matches!(event, LayerEvent::HorizontalScroll(_)),
                    *delta,
                )?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
    pub fn event(&mut self, tree: &mut Tree, event: &Event) -> Result<Effect> {
        match event {
            Event::Key(key) if key.sym == 0xff1b && tree.sidebar_overlay() => {
                tree.sidebar_request = Some(false);
            }
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
                if *pressed
                    && tree.sidebar_overlay()
                    && !contains(tree.sidebar_viewport(), self.pointer)
                {
                    tree.sidebar_request = Some(false);
                    return Ok(Effect::None);
                }
                if *pressed {
                    tree.pointer_press(self.pointer)?;
                } else {
                    return tree.pointer_release(self.pointer);
                }
            }
            Event::Scroll(delta) | Event::HorizontalScroll(delta) => {
                let sidebar = tree
                    .nodes
                    .values()
                    .any(|n| n.kind == Kind::Sidebar && contains(n.bounds, self.pointer));
                self.scroll(
                    tree,
                    sidebar,
                    matches!(event, Event::HorizontalScroll(_)),
                    *delta,
                )?;
            }
            Event::Layer { id, event } => {
                let kind = if Some(*id) == self.sidebar {
                    Kind::Sidebar
                } else if Some(*id) == self.titlebar {
                    Kind::TitleBar
                } else {
                    return Ok(Effect::None);
                };
                if self.layer_scroll(tree, kind, event)? {
                    return Ok(Effect::None);
                }
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
                        if *pressed
                            && tree.sidebar_overlay()
                            && kind == Kind::TitleBar
                            && !contains(tree.sidebar_viewport(), self.pointer)
                            && tree.hit_test(self.pointer).is_none()
                        {
                            tree.sidebar_request = Some(false);
                            return Ok(Effect::None);
                        }
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

#[cfg(test)]
mod tests {
    use super::*;
    use nk_text::{FontSet, ParleyBackend};
    use std::sync::Arc;
    fn fixture() -> (Tree, ParleyBackend, NodeId, NodeId, NodeId) {
        let mut t = Tree::new(
            "Window",
            Metrics {
                sidebar: 120.,
                content: 400.,
                titlebar: 48.,
                padding: 8.,
                gap: 4.,
                row: 48.,
                control: 24.,
                switch_width: 44.,
                radius: 8.,
                group_radius: 12.,
            },
            TextStyle::default(),
        )
        .unwrap();
        let sidebar = t.append(t.root(), Kind::Sidebar, "Pages").unwrap();
        for i in 0..20 {
            t.append(
                sidebar,
                Kind::Page { selected: i == 0 },
                format!("Page {i}"),
            )
            .unwrap();
        }
        let title = t.append(t.root(), Kind::TitleBar, "Title").unwrap();
        t.sidebar_button(title, "Sidebar").unwrap();
        let content = t.append(t.root(), Kind::Scroll, "Content").unwrap();
        for i in 0..20 {
            t.row(content, &format!("Row {i}"), Kind::Button).unwrap();
        }
        let wide = t.row(content, "Wide", Kind::Button).unwrap().0;
        t.set_min_width(wide, 1000.).unwrap();
        let mut b = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
        t.layout(
            Size {
                width: 640.,
                height: 360.,
            },
            true,
            &mut b,
        )
        .unwrap();
        assert_eq!(
            t.node(title).unwrap().bounds().height,
            48.,
            "button padding must not be added twice to title height"
        );
        (t, b, sidebar, title, content)
    }
    #[test]
    fn sidebar_layer_scroll_is_independent_and_clamped() {
        let (mut t, _, sidebar, _, content) = fixture();
        let mut c = Composition::default();
        assert!(
            c.layer_scroll(&mut t, Kind::Sidebar, &LayerEvent::Scroll(10000.))
                .unwrap()
        );
        let max = t.node(sidebar).unwrap().measured().height - t.sidebar_viewport().height;
        assert_eq!(t.node(sidebar).unwrap().scroll().y, max);
        assert_eq!(t.node(content).unwrap().scroll().y, 0.);
        let page = *t.node(sidebar).unwrap().children().last().unwrap();
        let point = t.node(page).unwrap().bounds().center();
        assert_eq!(t.hit_test(point), Some(page));
        c.layer_scroll(&mut t, Kind::Sidebar, &LayerEvent::Scroll(-10000.))
            .unwrap();
        assert_eq!(t.node(sidebar).unwrap().scroll().y, 0.);
        assert!(!t.showing(page));
        t.focus(page).unwrap();
        let r = t.node(page).unwrap().bounds();
        assert!(t.showing(page) && r.y >= 48. && r.y + r.height <= 360.);
    }
    #[test]
    fn title_layer_routes_vertical_and_horizontal_scroll_to_content() {
        let (mut t, _, sidebar, _, content) = fixture();
        let mut c = Composition::default();
        assert!(
            c.layer_scroll(&mut t, Kind::TitleBar, &LayerEvent::Scroll(90.))
                .unwrap()
        );
        assert_eq!(t.node(content).unwrap().scroll().y, 90.);
        assert_eq!(t.node(sidebar).unwrap().scroll().y, 0.);
        assert!(
            c.layer_scroll(&mut t, Kind::TitleBar, &LayerEvent::HorizontalScroll(70.))
                .unwrap()
        );
        assert_eq!(t.node(content).unwrap().scroll().x, 70.);
        assert_eq!(t.node(content).unwrap().scroll().y, 90.);
    }
    #[test]
    fn collapse_and_expand_reflow_on_the_same_curve_in_d7_and_d5() {
        for layered in [true, false] {
            let (mut t, mut b, sidebar, title, content) = fixture();
            t.layout(t.size, layered, &mut b).unwrap();
            let first = t.node(content).unwrap().children()[0];
            let before = t.node(first).unwrap().bounds();
            let curve = Some((
                1,
                Curve::Bezier {
                    x1: 0.,
                    y1: 0.,
                    x2: 1.,
                    y2: 1.,
                    duration_ms: 200,
                },
            ));
            let mut c = Composition::default();
            for (open, expected) in [(false, 0.), (true, 120.)] {
                t.change_sidebar(open);
                c.start_motion(&mut t, curve).unwrap();
                c.sample(&mut t, Some(0.1));
                t.layout(t.size, layered, &mut b).unwrap();
                assert!((t.content_viewport().x - 60.).abs() < 0.1);
                assert!((t.node(sidebar).unwrap().bounds().x + 60.).abs() < 0.1);
                assert_eq!(t.node(title).unwrap().bounds().x, t.content_viewport().x);
                let r = t.node(first).unwrap().bounds();
                assert!(
                    (2. * (r.x - t.leading) + r.width - (t.size.width - t.leading)).abs() < 0.1
                );
                c.sample(&mut t, Some(0.2));
                t.layout(t.size, layered, &mut b).unwrap();
                assert_eq!(t.content_viewport().x, expected);
                assert!(c.at_rest());
            }
            assert_eq!(t.node(first).unwrap().bounds(), before);
        }
    }
    #[test]
    fn breakpoint_is_window_owned_and_overlay_dismisses_in_all_three_ways() {
        let (mut t, mut b, sidebar, title, content) = fixture();
        let size = Size {
            width: 519.,
            height: 360.,
        };
        t.layout(size, false, &mut b).unwrap();
        assert!(!t.sidebar_open && t.narrow && t.content_viewport().x == 0.);
        let button = t.node(title).unwrap().children()[0];
        t.dispatch(t.target(button), Command::Activate).unwrap();
        assert_eq!(t.sidebar_request.take(), Some(true));
        t.change_sidebar(true);
        let mut c = Composition::default();
        c.start_motion(&mut t, None).unwrap();
        t.layout(size, false, &mut b).unwrap();
        let first = t.node(content).unwrap().children()[0];
        assert_eq!(t.node(first).unwrap().bounds().width, 519. - 16.);
        assert!(t.sidebar_overlay() && t.content_viewport().x == 0.);
        let page = t.node(sidebar).unwrap().children()[0];
        t.dispatch(t.target(page), Command::Activate).unwrap();
        assert_eq!(t.sidebar_request.take(), Some(false));
        c.pointer = Point { x: 400., y: 150. };
        c.event(
            &mut t,
            &Event::Button {
                button: 272,
                pressed: true,
            },
        )
        .unwrap();
        assert_eq!(t.sidebar_request.take(), Some(false));
        assert_eq!(t.captured(), None);
        c.event(
            &mut t,
            &Event::Key(nk_wayland::Key {
                sym: 0xff1b,
                text: String::new(),
                shift: false,
                ctrl: false,
                alt: false,
            }),
        )
        .unwrap();
        assert_eq!(t.sidebar_request.take(), Some(false));
        // Page content/font changes cannot alter this window's breakpoint.
        t.set_name(page, "A very long page name that wraps")
            .unwrap();
        t.set_text_style(TextStyle {
            size: 28.,
            ..TextStyle::default()
        });
        t.layout(size, false, &mut b).unwrap();
        assert!(t.sidebar_overlay() && t.content_viewport().x == 0.);
        // Crossing back to the exact breakpoint docks the existing sidebar.
        t.layout(
            Size {
                width: 520.,
                height: 360.,
            },
            false,
            &mut b,
        )
        .unwrap();
        assert!(t.sidebar_open && !t.narrow && t.content_viewport().x == 120.);
    }
}
