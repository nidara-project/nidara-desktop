// SPDX-License-Identifier: LGPL-3.0-or-later
//! Independent pane buffers on the existing nk-wayland host. Scrolling never
//! repaints them; resize, font, appearance or pane state changes do.
use crate::*;
use nk_wayland::{Curve, Event, LayerEvent, LayerId, Material, Property, Window};
/// Explicit provisional D7 title recipe supplied by the application, never transport defaults.
#[derive(Clone, Debug)]
pub struct TitlebarStyle {
    pub blur: nk_wayland::Blur,
    pub height: f32,
    pub curve: Vec<f64>,
    pub background_opacity: f32,
    pub opaque: bool,
}
impl TitlebarStyle {
    pub fn validate(&self) -> Result<()> {
        if !self.height.is_finite()
            || self.height <= 0.
            || self.curve.len() < 2
            || self.curve.iter().any(|v| !(0. ..=1.).contains(v))
            || !(0. ..=1.).contains(&self.background_opacity)
            || !self.blur.size.is_finite()
            || self.blur.size < 0.
        {
            return Err("invalid titlebar style".into());
        }
        Ok(())
    }
    fn panes(&self, width: f64, height: f64, scale: f64) -> Vec<nk_wayland::GradedPane> {
        let count = self.curve.len() - 1;
        self.curve
            .windows(2)
            .enumerate()
            .map(|(i, values)| {
                // Shared interior edges must fall on a physical pixel. Otherwise two
                // antialiased half-coverages expose sharp content between blur bands.
                let edge = |index: usize| {
                    if index == count {
                        height
                    } else {
                        (height * index as f64 / count as f64 * scale).round() / scale
                    }
                };
                let y = edge(i);
                let bottom = edge(i + 1);
                nk_wayland::GradedPane {
                    pane: nk_wayland::Pane {
                        x: 0.,
                        y,
                        width,
                        height: bottom - y,
                        radius: 0.,
                        exponent: 2.,
                    },
                    top: values[0],
                    bottom: values[1],
                }
            })
            .collect()
    }
}
#[derive(Default)]
pub struct Composition {
    title_style: Option<TitlebarStyle>,
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
    double_click_ms: Option<u32>,
    last_title_press: Option<u32>,
    paste_target: Option<Target>,
    search_focus: Option<NodeId>,
    search_layers: BTreeMap<NodeId, (LayerId, Point)>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TitlebarAction {
    Move(u32),
    ToggleMaximize,
}
impl Composition {
    /// Input policy is supplied by the application; the kit invents no interval.
    pub fn set_titlebar_double_click_ms(&mut self, ms: u32) -> Result<()> {
        if ms == 0 {
            return Err("double click interval must be positive".into());
        }
        self.double_click_ms = Some(ms);
        self.last_title_press = None;
        Ok(())
    }
    fn titlebar_press(
        &mut self,
        tree: &Tree,
        point: Point,
        serial: u32,
        time: u32,
    ) -> Option<TitlebarAction> {
        let empty = !tree.sidebar_overlay()
            && tree
                .nodes
                .iter()
                .find(|(id, n)| n.kind == Kind::TitleBar && !tree.is_hidden(**id))
                .is_some_and(|(_, title)| {
                    let r = title.bounds;
                    if !contains(r, point) {
                        return false;
                    }
                    if tree.nodes.iter().any(|(id, n)| {
                        n.kind.focusable()
                            && !tree.is_hidden(*id)
                            && contains(n.bounds, point)
                            && contains(tree.visible_clip(*id), point)
                    }) {
                        return false;
                    }
                    if let Some(layout) = tree.server_controls {
                        if tree.window_control_capsule.is_some() {
                            if tree
                                .server_controls_bounds()
                                .is_some_and(|r| contains(r, point))
                            {
                                return false;
                            }
                        } else {
                            let reserve = layout.width as f32 + tree.metrics.gap;
                            if match layout.side {
                                nk_wayland::ControlsSide::Left => point.x < r.x + reserve,
                                nk_wayland::ControlsSide::Right => {
                                    point.x >= r.x + r.width - reserve
                                }
                            } {
                                return false;
                            }
                        }
                    }
                    true
                });
        if !empty {
            self.last_title_press = None;
            return None;
        }
        let double = self.double_click_ms.is_some_and(|limit| {
            self.last_title_press
                .is_some_and(|last| time.wrapping_sub(last) <= limit)
        });
        self.last_title_press = if double { None } else { Some(time) };
        Some(if double {
            TitlebarAction::ToggleMaximize
        } else {
            TitlebarAction::Move(serial)
        })
    }
    /// Route client-side title chrome before ordinary retained widget input.
    pub fn event_with_window(
        &mut self,
        tree: &mut Tree,
        event: &Event,
        window: &mut Window,
    ) -> Result<Effect> {
        if let Event::Key(key) = event
            && key.ctrl
            && !key.alt
        {
            if key.sym == 0x63 || key.sym == 0x43 || key.sym == 0x78 || key.sym == 0x58 {
                if let Some((text, effect)) =
                    tree.search_clipboard(key.sym == 0x78 || key.sym == 0x58)?
                {
                    if !text.is_empty() {
                        window.copy(text);
                    }
                    window.reset_ime();
                    self.sync_search_input(tree, window)?;
                    return Ok(effect);
                }
            } else if (key.sym == 0x76 || key.sym == 0x56)
                && tree
                    .focused
                    .is_some_and(|id| tree.searches.contains_key(&id) && tree.available(id))
            {
                self.paste_target = tree.focused.map(|id| tree.target(id));
                window.paste()?;
                return Ok(Effect::None);
            }
        }
        let old_focus = tree.focused;
        let press = match event {
            Event::Button {
                button: 272,
                pressed: true,
                serial,
                time,
            } => Some((self.pointer, *serial, *time)),
            Event::Layer {
                id,
                event:
                    LayerEvent::Button {
                        button: 272,
                        pressed: true,
                        serial,
                        time,
                        x,
                        y,
                    },
            } if Some(*id) == self.titlebar => tree
                .nodes
                .values()
                .find(|n| n.kind == Kind::TitleBar)
                .map(|n| {
                    (
                        Point {
                            x: n.bounds.x + *x as f32,
                            y: n.bounds.y + *y as f32,
                        },
                        *serial,
                        *time,
                    )
                }),
            _ => None,
        };
        if press.is_none()
            && matches!(
                event,
                Event::Button { pressed: true, .. }
                    | Event::Layer {
                        event: LayerEvent::Button { pressed: true, .. },
                        ..
                    }
                    | Event::Focus(false)
            )
        {
            self.last_title_press = None;
        }
        if let Some((point, serial, time)) = press
            && let Some(action) = self.titlebar_press(tree, point, serial, time)
        {
            tree.pointer_press(point)?;
            match action {
                TitlebarAction::Move(serial) => window.move_from_pointer_press(serial)?,
                TitlebarAction::ToggleMaximize => {
                    window.window_action(nk_wayland::WindowAction::ToggleMaximize)
                }
            }
            return Ok(Effect::None);
        }
        let effect = self.event(tree, event)?;
        if old_focus != tree.focused || matches!(event, Event::Focus(false)) {
            self.paste_target = None;
            if let Some(search) = old_focus.and_then(|id| tree.searches.get_mut(&id)) {
                search.editor.cancel_preedit()?;
            }
            window.reset_ime();
        } else if matches!(event, Event::Key(_) | Event::Button { pressed: true, .. }) {
            window.reset_ime();
        }
        self.sync_search_input(tree, window)?;
        Ok(effect)
    }
    /// Floating retained editors use the same text-input host, on their actual pane.
    pub fn set_search_layers(&mut self, layers: BTreeMap<NodeId, (LayerId, Point)>) {
        self.search_layers = layers;
    }
    /// Call after layout too, so the IME gets the same scrolled caret and pane as paint.
    pub fn sync_search_input(&mut self, tree: &Tree, window: &mut Window) -> Result<()> {
        if tree.searches.is_empty() {
            if self.search_focus.take().is_some() {
                self.paste_target = None;
                window.reset_ime();
                window.set_text_input(Default::default());
            }
            return Ok(());
        }
        let mut input = tree.search_text_input();
        let next = tree.focused.filter(|_| input.focused);
        if next != self.search_focus {
            self.search_focus = next;
            self.paste_target = None;
            window.reset_ime();
        }
        if let Some((layer, origin)) = tree.focused.and_then(|id| self.search_layers.get(&id)) {
            input.rect[0] -= origin.x.floor() as i32;
            input.rect[1] -= origin.y.floor() as i32;
            window.set_layer_text_input(*layer, input)?;
            return Ok(());
        }
        let sidebar = tree.focused.and_then(|id| {
            let mut p = Some(id);
            while let Some(id) = p {
                if tree.nodes[&id].kind == Kind::Sidebar {
                    return Some(tree.nodes[&id].bounds);
                }
                p = tree.nodes[&id].parent;
            }
            None
        });
        if input.focused
            && let (Some(layer), Some(origin)) = (self.sidebar, sidebar)
        {
            input.rect[0] -= origin.x.floor() as i32;
            input.rect[1] -= origin.y.floor() as i32;
            window.set_layer_text_input(layer, input)?;
        } else {
            window.set_text_input(input);
        }
        Ok(())
    }

    pub fn set_titlebar_style(&mut self, style: TitlebarStyle) -> Result<()> {
        style.validate()?;
        self.title_style = Some(style);
        self.invalidate_panes();
        Ok(())
    }
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
        panel: impl Fn(f64) -> Result<Material>,
        layers_allowed: bool,
    ) -> Result<()> {
        self.sync_with_layout(
            tree,
            window,
            backend,
            palette,
            panel,
            layers_allowed,
            |_, _, _, _| Ok(()),
        )
    }
    /// Place app-owned floating controls on the same sampled pane/inset timeline,
    /// before any chrome buffers are painted or committed.
    #[allow(clippy::too_many_arguments)]
    pub fn sync_with_layout<B: TextBackend>(
        &mut self,
        tree: &mut Tree,
        window: &mut Window,
        backend: &mut B,
        palette: Palette,
        panel: impl Fn(f64) -> Result<Material>,
        layers_allowed: bool,
        mut arrange: impl FnMut(&mut Tree, Size, bool, &mut B) -> Result<()>,
    ) -> Result<()> {
        if tree.window_buttons.is_some() {
            window.request_window_controls();
        }
        tree.set_server_controls(window.window_controls_layout())?;
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
        arrange(
            tree,
            Size {
                width: w as f32,
                height: h as f32,
            },
            layered,
            backend,
        )?;
        if let Some(controls) = tree.server_controls_bounds() {
            let c = palette.text.components;
            let dark = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] < 0.5;
            window.place_window_controls(controls.x as f64, controls.y as f64, dark)?;
        }
        if layered {
            let inset = tree.content_viewport();
            let side_rect = tree.sidebar_rect();
            let sidebar_size = (
                side_rect.width.ceil().max(1.) as u32,
                side_rect.height.ceil().max(1.) as u32,
            );
            let titlebar_size = (
                inset.width.ceil().max(1.) as u32,
                self.title_style
                    .as_ref()
                    .map_or(inset.y, |s| s.height.max(inset.y))
                    .ceil()
                    .max(1.) as u32,
            );
            if self.sidebar.is_none() {
                self.sidebar = Some(window.create_layer(sidebar_size)?);
                self.titlebar = Some(window.create_layer(titlebar_size)?);
                window.set_position(
                    self.sidebar.unwrap(),
                    if tree.sidebar_open {
                        tree.sidebar_margin as f64
                    } else {
                        f64::from(tree.sidebar_margin - tree.metrics.sidebar)
                    },
                    tree.sidebar_margin as f64,
                )?;
                window.set_position(self.titlebar.unwrap(), inset.x as f64, 0.)?;
            }
            let signature = (w, h, window.scale().to_bits(), tree.pane_epoch);
            if self.painted != Some(signature) {
                let sidebar = self.sidebar.unwrap();
                let titlebar = self.titlebar.unwrap();
                window.set_position(titlebar, inset.x as f64, 0.)?;
                if self.motion.is_none() {
                    window.set_position(
                        sidebar,
                        (tree.sidebar_target() + tree.sidebar_margin) as f64,
                        side_rect.y as f64,
                    )?;
                }
                window.set_layer_size(sidebar, sidebar_size)?;
                window.set_layer_size(titlebar, titlebar_size)?;
                let mut material = panel(f64::from(sidebar_size.0.min(sidebar_size.1)))?;
                material.shapes = vec![nk_wayland::Pane {
                    x: 0.,
                    y: 0.,
                    width: sidebar_size.0 as f64,
                    height: sidebar_size.1 as f64,
                    radius: tree.sidebar_radius as f64,
                    exponent: 2.,
                }];
                window.set_layer_material(sidebar, Some(&material))?;
                if let Some(style) = &self.title_style {
                    window.set_layer_blur(
                        titlebar,
                        style.blur,
                        &style.panes(
                            titlebar_size.0 as f64,
                            titlebar_size.1 as f64,
                            window.scale(),
                        ),
                    )?;
                } else {
                    window.set_layer_material(titlebar, None)?;
                }
                let a =
                    window.paint_layer(sidebar, |f| tree.paint(f, Surface::Sidebar, palette))?;
                let b = window.paint_layer(titlebar, |f| {
                    tree.paint_with_titlebar(
                        f,
                        Surface::TitleBar,
                        palette,
                        self.title_style.as_ref(),
                    )
                })?;
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
        self.sync_search_input(tree, window)?;
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
            window.set_position(
                id,
                (tree.sidebar_target() + tree.sidebar_margin) as f64,
                tree.sidebar_margin as f64,
            )?;
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
            let _ = tree.traverse_focus(false);
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
        root_input: bool,
    ) -> Result<()> {
        if root_input
            && !sidebar
            && let Some((&id, n)) = tree.nodes.iter().find(|(id, n)| {
                tree.thumbnail_styles.contains_key(id)
                    && tree.available(**id)
                    && contains(n.bounds, self.pointer)
                    && contains(tree.visible_clip(**id), self.pointer)
            })
        {
            let mut offset = n.scroll;
            offset.x += delta as f32;
            return tree.scroll_to(id, offset);
        }
        // A horizontal gesture on the sidebar has no horizontal navigation;
        // continue it into the underlying content, like the title pane.
        if root_input
            && !sidebar
            && !horizontal
            && let Some((&id, n)) = tree.nodes.iter().find(|(id, n)| {
                matches!(n.kind, Kind::List { .. })
                    && tree.available(**id)
                    && contains(n.bounds, self.pointer)
                    && contains(tree.visible_clip(**id), self.pointer)
            })
        {
            let mut offset = n.scroll;
            offset.y += delta as f32;
            return tree.scroll_to(id, offset);
        }
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
                    false,
                )?;
                Ok(true)
            }
            _ => Ok(false),
        }
    }
    pub fn event(&mut self, tree: &mut Tree, event: &Event) -> Result<Effect> {
        if let Event::Ime(batch) = event {
            return tree.search_ime(batch);
        }
        if let Event::Paste(text) = event {
            if let Some(target) = self.paste_target.take()
                && tree.focused == Some(target.id)
                && target.generation == tree.generation
                && tree.available(target.id)
            {
                return tree.search_paste(target, text);
            }
            return Ok(Effect::None);
        }
        if matches!(event, Event::Key(_)) {
            tree.set_focus_visible(true);
        }
        if let Event::Key(key) = event
            && let Some(effect) = tree.search_key(key)?
        {
            return Ok(effect);
        }
        if let Event::Key(key) = event
            && let Some(effect) = tree.control_key(key.sym)?
        {
            return Ok(effect);
        }
        match event {
            Event::Key(key) if key.sym == 0xff1b && tree.sidebar_overlay() => {
                tree.sidebar_request = Some(false);
            }
            Event::PointerLeave => tree.pointer_leave(),
            Event::Focus(active) => {
                if !active && let Some(id) = tree.focused {
                    tree.cancel_search_preedit(id)?;
                }
                tree.set_active(*active);
            }
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
                };
                tree.pointer_motion(self.pointer);
                if let Some(id) = tree.range_drag(self.pointer)? {
                    return Ok(Effect::Changed(id));
                }
            }
            Event::Button {
                button: 272,
                pressed,
                ..
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
                    if let Some(id) = tree.range_drag(self.pointer)? {
                        return Ok(Effect::Changed(id));
                    }
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
                    true,
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
                        };
                        tree.pointer_motion_in(
                            container,
                            Point {
                                x: *x as f32,
                                y: *y as f32,
                            },
                        )?;
                    }
                    LayerEvent::Button {
                        button: 272,
                        pressed,
                        x,
                        y,
                        ..
                    } => {
                        self.pointer = Point {
                            x: origin.x + *x as f32,
                            y: origin.y + *y as f32,
                        };
                        tree.pointer_motion_in(
                            container,
                            Point {
                                x: *x as f32,
                                y: *y as f32,
                            },
                        )?;
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
                    LayerEvent::Leave => tree.pointer_leave(),
                    LayerEvent::Done { .. }
                        if !tree.sidebar_open
                            && tree.focused.is_some_and(|id| {
                                matches!(tree.nodes[&id].kind, Kind::Page { .. })
                            }) =>
                    {
                        tree.traverse_focus(false)?
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
                form_width: 400.,
                content_floor: 280.,
                titlebar: 48.,
                padding: 8.,
                gap: 4.,
                row: 48.,
                control: 24.,
                switch_width: 44.,
                radius: 8.,
                group_radius: 12.,
                focus_width: 2.,
                highlight_inset: 4.,
                hover_opacity: 0.08,
                separator_width: 1.,
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
        let color = nk_render::rgba(30, 30, 30, 255);
        let style = MenuStyle {
            border: 1.,
            radius: 16.,
            inset: 6.,
            padding_x: 9.,
            padding_y: 6.,
            row_radius: 10.,
            text_scale: 0.93,
            weight: 400.,
            check_size: 14.,
            check_gap: 8.,
            check_stroke: 2.2,
            background: color,
            border_color: color,
            text: color,
            accent: color,
            accent_text: color,
            pressed_black: 0.15,
        };
        let list = t.list(content, "Families", 80., style).unwrap();
        for _ in 0..8 {
            t.append(list, Kind::MenuOption { selected: false }, "Font")
                .unwrap();
        }
        let mut b = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
        t.layout(t.size, false, &mut b).unwrap();
        t.scroll_to(content, Point { x: 0., y: 10000. }).unwrap();
        t.scroll_to(list, Point { x: 0., y: 30. }).unwrap();
        let r = t.node(list).unwrap().bounds();
        c.pointer = Point {
            x: r.x + 20.,
            y: r.y + 20.,
        };
        assert!(
            contains(t.visible_clip(list), c.pointer),
            "root pointer setup must be inside the visible list"
        );
        let old_list = t.node(list).unwrap().scroll();
        let old_content = t.node(content).unwrap().scroll();
        c.layer_scroll(&mut t, Kind::TitleBar, &LayerEvent::Scroll(-30.))
            .unwrap();
        assert_eq!(
            t.node(list).unwrap().scroll(),
            old_list,
            "layer input must not reuse a stale root pointer"
        );
        assert_eq!(t.node(content).unwrap().scroll().y, old_content.y - 30.);
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
                serial: 7,
                time: 10,
            },
        )
        .unwrap();
        assert_eq!(t.sidebar_request.take(), Some(false));
        assert_eq!(t.captured(), None);
        c.event(
            &mut t,
            &Event::Key(nk_wayland::Key {
                serial: None,
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
    fn test_palette() -> Palette {
        use nk_render::rgba;
        Palette {
            background: rgba(20, 30, 40, 255),
            surface: rgba(50, 60, 70, 255),
            text: rgba(255, 255, 255, 255),
            disabled: rgba(100, 100, 100, 255),
            selected: rgba(70, 80, 90, 255),
            accent: rgba(0, 100, 255, 255),
            track: rgba(60, 70, 80, 255),
            thumb: rgba(255, 255, 255, 255),
            focus: rgba(0, 100, 255, 255),
            separator: rgba(99, 88, 77, 255),
        }
    }
    #[test]
    fn floating_sidebar_pixels_stay_local_while_the_layer_moves() {
        for scale in [1., 1.25] {
            let (mut tree, mut backend, sidebar, _, _) = fixture();
            tree.set_sidebar_frame(8., 12.).unwrap();
            tree.layout(tree.size, true, &mut backend).unwrap();
            let bounds = tree.node(sidebar).unwrap().bounds();
            assert_eq!(
                (bounds.x, bounds.y, bounds.width, bounds.height),
                (8., 8., 104., 344.)
            );
            let frame = nk_wayland::Frame {
                width: 104,
                height: 344,
                pixel_width: (104. * scale) as u16,
                pixel_height: (344. * scale) as u16,
                scale,
                material: true,
            };
            let reference = tree.paint(frame, Surface::Sidebar, test_palette()).unwrap();
            // Both directions, including fractional layer positions. Only the layer moves.
            for x in [-15.25, -60., -119.5, -60., -15.25, 0.] {
                tree.sidebar_x = x;
                tree.leading = 120. + x;
                tree.invalidate(tree.root, Invalid::LAYOUT);
                tree.layout(tree.size, true, &mut backend).unwrap();
                assert!(
                    reference == tree.paint(frame, Surface::Sidebar, test_palette()).unwrap(),
                    "sidebar pixels shifted inside the pane at x={x} scale={scale}"
                );
            }
            assert_eq!(reference[3], 0, "rounded corner has no painted pixel");
        }
    }
    #[test]
    fn titlebar_recipe_has_contiguous_graded_bands_and_only_a_background_fade() {
        let (mut tree, mut backend, _, _, _) = fixture();
        tree.layout(tree.size, true, &mut backend).unwrap();
        let mut style = TitlebarStyle {
            blur: nk_wayland::Blur {
                size: 2.,
                passes: 2,
            },
            height: 72.,
            curve: vec![1., 1., 0.5, 0.],
            background_opacity: 0.85,
            opaque: false,
        };
        style.validate().unwrap();
        let panes = style.panes(520., 72., 1.);
        assert_eq!(panes.len(), 3);
        assert_eq!((panes[0].top, panes[0].bottom), (1., 1.));
        assert_eq!((panes[2].top, panes[2].bottom), (0.5, 0.));
        assert_eq!(panes[0].pane.y, 0.);
        assert_eq!(panes[2].pane.y + panes[2].pane.height, 72.);
        for pair in panes.windows(2) {
            assert_eq!(pair[0].pane.y + pair[0].pane.height, pair[1].pane.y);
            assert_eq!(pair[0].bottom, pair[1].top);
        }
        for scale in [1., 1.25] {
            let frame = nk_wayland::Frame {
                width: 520,
                height: 72,
                pixel_width: (520. * scale) as u16,
                pixel_height: (72. * scale) as u16,
                scale,
                material: true,
            };
            let pixels = tree
                .paint_with_titlebar(frame, Surface::TitleBar, test_palette(), Some(&style))
                .unwrap();
            let alpha = |data: &[u8], y: usize| {
                data[(y * frame.pixel_width as usize + frame.pixel_width as usize - 1) * 4 + 3]
            };
            assert!((alpha(&pixels, 0) as i32 - 217).abs() <= 2);
            assert!(alpha(&pixels, frame.pixel_height as usize - 1) < 5);
            for row in 1..frame.pixel_height as usize {
                assert!(
                    alpha(&pixels, row) <= alpha(&pixels, row - 1),
                    "fade has a divider/band"
                );
            }
            style.opaque = true;
            let opaque = tree
                .paint_with_titlebar(frame, Surface::TitleBar, test_palette(), Some(&style))
                .unwrap();
            assert_eq!(alpha(&opaque, frame.pixel_height as usize - 1), 255);
            style.opaque = false;
        }
        style.curve[1] = f64::NAN;
        assert!(style.validate().is_err());
    }
    #[test]
    fn pointer_focus_keeps_semantics_and_selection_without_a_ring_but_tab_draws_round() {
        for layered in [false, true] {
            for scale in [1., 1.25] {
                let (mut tree, mut backend, sidebar, _, _) = fixture();
                tree.layout(tree.size, layered, &mut backend).unwrap();
                let page = tree.nodes[&sidebar].children[0];
                tree.focus(page).unwrap();
                let bounds = tree.nodes[&page].bounds;
                let origin = if layered {
                    tree.nodes[&sidebar].bounds.x
                } else {
                    0.
                };
                let width = if layered { 120 } else { 640 };
                let surface = if layered {
                    Surface::Sidebar
                } else {
                    Surface::Content
                };
                let frame = nk_wayland::Frame {
                    width,
                    height: 480,
                    pixel_width: (width as f64 * scale) as u16,
                    pixel_height: (480. * scale) as u16,
                    scale,
                    material: layered,
                };
                let baseline = tree.paint(frame, surface, test_palette()).unwrap();
                let point = Point {
                    x: bounds.x + bounds.width / 2.,
                    y: bounds.y + bounds.height / 2.,
                };
                if layered {
                    tree.pointer_press_in(
                        sidebar,
                        Point {
                            x: point.x - tree.nodes[&sidebar].bounds.x,
                            y: point.y - tree.nodes[&sidebar].bounds.y,
                        },
                    )
                    .unwrap();
                } else {
                    tree.pointer_press(point).unwrap();
                }
                assert_eq!(tree.focused(), Some(page));
                assert!(!tree.focus_visible());
                assert!(matches!(
                    tree.nodes[&page].kind,
                    Kind::Page { selected: true }
                ));
                assert!(
                    baseline == tree.paint(frame, surface, test_palette()).unwrap(),
                    "pointer focus painted a ring"
                );
                tree.tab(false).unwrap();
                tree.tab(true).unwrap();
                assert_eq!(tree.focused(), Some(page));
                assert!(tree.focus_visible());
                let keyboard = tree.paint(frame, surface, test_palette()).unwrap();
                assert!(baseline != keyboard, "keyboard ring missing");
                let x = ((bounds.x - origin) as f64 * scale) as usize;
                let y = (bounds.y as f64 * scale) as usize;
                let corner = (y * frame.pixel_width as usize + x) * 4;
                assert_eq!(
                    &baseline[corner..corner + 4],
                    &keyboard[corner..corner + 4],
                    "focus ring has a square corner"
                );
                // Clicking outside any target changes modality but keeps semantic focus.
                tree.pointer_press(Point { x: -10., y: -10. }).unwrap();
                assert_eq!(tree.focused(), Some(page));
                assert!(!tree.focus_visible());
                assert!(baseline == tree.paint(frame, surface, test_palette()).unwrap());
            }
        }
    }
    #[test]
    fn list_hover_uses_the_shared_inset_shape_and_visible_neighbors() {
        let (mut tree, mut backend, sidebar, _, content) = fixture();
        let pages = tree.nodes[&sidebar].children.clone();
        for id in &pages[5..] {
            tree.set_hidden(*id, true).unwrap();
        }
        tree.layout(tree.size, true, &mut backend).unwrap();
        let baseline_lines = tree.list_separators(sidebar);
        assert_eq!(baseline_lines.len(), 3); // No line beside selected first or below last.
        assert!(
            baseline_lines
                .iter()
                .all(|line| line.x == tree.nodes[&pages[1]].bounds.x + tree.metrics.padding)
        );
        let bounds = tree.nodes[&pages[2]].bounds;
        let (shape, radius) = tree.highlight_shape(pages[2]);
        assert!(shape.x > bounds.x && shape.y > bounds.y);
        assert!(shape.width < bounds.width && shape.height < bounds.height);
        assert_eq!(radius, tree.metrics.radius);
        for scale in [1., 1.25] {
            let frame = nk_wayland::Frame {
                width: 120,
                height: 480,
                pixel_width: (120. * scale) as u16,
                pixel_height: (480. * scale) as u16,
                scale,
                material: true,
            };
            tree.pointer_leave();
            let before = tree.paint(frame, Surface::Sidebar, test_palette()).unwrap();
            tree.acknowledge();
            tree.pointer_motion_in(
                sidebar,
                Point {
                    x: bounds.x + bounds.width / 2.,
                    y: bounds.y + bounds.height / 2.,
                },
            )
            .unwrap();
            assert_eq!(tree.hovered, Some(pages[2]));
            assert!(
                tree.invalidation().paint
                    && !tree.invalidation().layout
                    && !tree.invalidation().semantics
            );
            let hovered = tree.paint(frame, Surface::Sidebar, test_palette()).unwrap();
            let sample = |x: f32, y: f32| {
                let x = (x as f64 * scale).round() as usize;
                let y = (y as f64 * scale).round() as usize;
                (y * frame.pixel_width as usize + x) * 4
            };
            let inside = sample(shape.x + shape.width / 2., shape.y + shape.height - 3.);
            assert_ne!(
                &before[inside..inside + 4],
                &hovered[inside..inside + 4],
                "hover fill missing inside inset shape"
            );
            let separator = baseline_lines[0];
            let edge = sample(separator.x + 1., separator.y);
            assert_eq!(before[edge + 3], 255, "separator not painted");
            assert_eq!(hovered[edge + 3], 0, "separator cuts hovered highlight");
            assert_eq!(
                tree.list_separators(sidebar).len(),
                1,
                "separators cut hovered highlight"
            );
            tree.pointer_leave();
            assert!(
                before == tree.paint(frame, Surface::Sidebar, test_palette()).unwrap(),
                "hover survives pointer leave"
            );
        }
        tree.pointer_motion(Point {
            x: bounds.x + 10.,
            y: bounds.y + 10.,
        });
        tree.set_hidden(pages[2], true).unwrap();
        assert_eq!(tree.hovered, None);
        tree.layout(tree.size, true, &mut backend).unwrap();
        assert_eq!(tree.list_separators(sidebar).len(), 2);
        for id in &pages[1..5] {
            tree.set_hidden(*id, true).unwrap();
        }
        assert!(tree.list_separators(sidebar).is_empty());
        let row = tree.nodes[&content].children[0];
        let label = tree.nodes[&row].children[0];
        let control = tree.nodes[&row].children[1];
        let point = |r: Rect| Point {
            x: r.x + r.width / 2.,
            y: r.y + r.height / 2.,
        };
        tree.pointer_motion(point(tree.nodes[&label].bounds));
        assert_eq!(tree.hovered, None, "control-only row has whole-row hover");
        tree.pointer_motion(point(tree.nodes[&control].bounds));
        assert_eq!(tree.hovered, Some(control));
        let (button, button_radius) = tree.highlight_shape(control);
        assert_eq!(
            button_radius, tree.metrics.radius,
            "ordinary button changed silhouette"
        );
        assert_ne!(button_radius, button.height / 2.);
        tree.set_button_shape(control, ButtonShape::Capsule)
            .unwrap();
        assert_eq!(tree.highlight_shape(control), (button, button.height / 2.));
        tree.set_button_shape(control, ButtonShape::Rounded)
            .unwrap();
        assert_eq!(tree.highlight_shape(control), (button, tree.metrics.radius));
        assert!(tree.set_button_shape(label, ButtonShape::Capsule).is_err());
        let switch = tree
            .row(content, "Switch", Kind::Switch { checked: false })
            .unwrap();
        tree.layout(tree.size, true, &mut backend).unwrap();
        let (track, track_radius) = tree.highlight_shape(switch.1);
        assert_eq!(track_radius, track.height / 2.);
    }
    #[test]
    fn form_width_is_constant_then_yields_to_its_floor_and_centers_beside_sidebar() {
        for layered in [false, true] {
            let (mut tree, mut backend, _, _, scroll) = fixture();
            let wide = *tree.nodes[&scroll].children.last().unwrap();
            tree.remove(wide).unwrap();
            tree.metrics.form_width = 800.;
            tree.metrics.content_floor = 560.;
            tree.set_page_width(PageWidth::Form).unwrap();
            let row = tree.nodes[&scroll].children[0];
            for width in [1400., 800., 700., 650.] {
                tree.layout(
                    Size {
                        width,
                        height: 480.,
                    },
                    layered,
                    &mut backend,
                )
                .unwrap();
                let viewport = tree.content_viewport();
                let bounds = tree.nodes[&row].bounds;
                let column = bounds.width + 2. * tree.metrics.padding;
                assert_eq!(
                    column,
                    if width == 1400. {
                        800.
                    } else if width == 650. {
                        560.
                    } else {
                        width - 120.
                    }
                );
                assert!(
                    (bounds.x
                        - (viewport.x
                            + (viewport.width - column).max(0.) / 2.
                            + tree.metrics.padding))
                        .abs()
                        < 0.001,
                    "column centered in whole window, not beside sidebar"
                );
            }
            tree.scroll_to(scroll, Point { x: 1000., y: 0. }).unwrap();
            assert_eq!(
                tree.nodes[&scroll].scroll.x, 30.,
                "floor must remain horizontally reachable"
            );
            tree.layout(
                Size {
                    width: 1400.,
                    height: 480.,
                },
                layered,
                &mut backend,
            )
            .unwrap();
            assert_eq!(tree.nodes[&scroll].scroll.x, 0.);
            tree.set_page_width(PageWidth::None).unwrap();
            tree.layout(tree.size, layered, &mut backend).unwrap();
            assert_eq!(
                tree.nodes[&row].bounds.width + 2. * tree.metrics.padding,
                1280.,
                "named-width change reused stale measure"
            );
            assert!(tree.set_page_width(PageWidth::Reading).is_err());
            tree.set_page_width(PageWidth::Form).unwrap();
            tree.layout(tree.size, layered, &mut backend).unwrap();
            tree.sidebar_open = false;
            let mut composition = Composition::default();
            composition
                .start_motion(
                    &mut tree,
                    Some((
                        1,
                        Curve::Bezier {
                            x1: 0.,
                            y1: 0.,
                            x2: 1.,
                            y2: 1.,
                            duration_ms: 1000,
                        },
                    )),
                )
                .unwrap();
            for seconds in [0., 0.25, 0.5, 0.75, 1.] {
                composition.sample(&mut tree, Some(seconds));
                tree.layout(tree.size, layered, &mut backend).unwrap();
                let viewport = tree.content_viewport();
                let bounds = tree.nodes[&row].bounds;
                assert!(
                    (bounds.x - (viewport.x + (viewport.width - 800.) / 2. + tree.metrics.padding))
                        .abs()
                        < 0.01,
                    "centering does not follow collapse timeline"
                );
            }
        }
    }
    #[test]
    fn group_card_keeps_form_column_while_wide_child_retains_scroll_extent() {
        for layered in [false, true] {
            let (mut tree, mut backend, _, _, scroll) = fixture();
            for child in tree.nodes[&scroll].children.clone() {
                tree.remove(child).unwrap();
            }
            tree.metrics.form_width = 800.;
            tree.metrics.content_floor = 560.;
            tree.set_page_width(PageWidth::Form).unwrap();
            let group = tree.group(scroll, "Group").unwrap();
            let normal = tree.row(group, "Normal", Kind::Button).unwrap().0;
            let wide = tree.row(group, "Wide probe", Kind::Button).unwrap().0;
            for width in [1262., 900., 650.] {
                tree.set_min_width(wide, width).unwrap();
                tree.layout(
                    Size {
                        width,
                        height: 480.,
                    },
                    layered,
                    &mut backend,
                )
                .unwrap();
                let column = tree.content_column_width(tree.content_viewport().width);
                let card = tree.nodes[&group].bounds;
                assert_eq!(
                    card.width,
                    column - 2. * tree.metrics.padding,
                    "group card follows overflow instead of form column"
                );
                assert_eq!(
                    tree.nodes[&normal].bounds.width,
                    card.width - 2. * tree.metrics.padding
                );
                assert!(
                    tree.nodes[&scroll].measured.width >= width,
                    "wide probe lost scroll extent"
                );
                if width == 1262. {
                    for scale in [1., 1.25] {
                        let frame = nk_wayland::Frame {
                            width: width as u32,
                            height: 480,
                            pixel_width: (width as f64 * scale).ceil() as u16,
                            pixel_height: (480. * scale) as u16,
                            scale,
                            material: layered,
                        };
                        let pixels = tree.paint(frame, Surface::Content, test_palette()).unwrap();
                        let pixel = |x: f32, y: f32| {
                            let at = (((y as f64 * scale).floor() as usize)
                                * frame.pixel_width as usize
                                + (x as f64 * scale).floor() as usize)
                                * 4;
                            &pixels[at..at + 4]
                        };
                        let y = card.y + card.height - 3.;
                        let outside = pixel(card.x + card.width + 20., y);
                        if layered {
                            assert_eq!(outside[3], 0, "group card paints beyond form column");
                        } else {
                            assert_ne!(
                                outside,
                                pixel(card.x + card.width / 2., y),
                                "group card paints beyond form column"
                            );
                        }
                    }
                }
                tree.scroll_to(scroll, Point { x: 10000., y: 0. }).unwrap();
                assert!(tree.nodes[&scroll].scroll.x > 0.);
                tree.scroll_to(scroll, Point::default()).unwrap();
            }
        }
    }
    #[test]
    fn title_press_uses_exact_serial_and_never_steals_controls_or_content() {
        for layered in [false, true] {
            let (mut tree, mut backend, _, title, _) = fixture();
            tree.layout(tree.size, layered, &mut backend).unwrap();
            let bounds = tree.nodes[&title].bounds;
            let blank = Point {
                x: bounds.x + bounds.width / 2.,
                y: bounds.y + bounds.height / 2.,
            };
            let mut c = Composition::default();
            c.set_titlebar_double_click_ms(400).unwrap();
            assert_eq!(
                c.titlebar_press(&tree, blank, 71, 1000),
                Some(TitlebarAction::Move(71))
            );
            assert_eq!(
                c.titlebar_press(&tree, blank, 99, 1399),
                Some(TitlebarAction::ToggleMaximize)
            );
            assert_eq!(
                c.titlebar_press(&tree, blank, 101, 1400),
                Some(TitlebarAction::Move(101))
            );
            assert_eq!(
                c.titlebar_press(&tree, blank, 102, 1801),
                Some(TitlebarAction::Move(102))
            );
            let button = tree.nodes[&title].children[0];
            let b = tree.nodes[&button].bounds;
            let point = Point {
                x: b.x + b.width / 2.,
                y: b.y + b.height / 2.,
            };
            assert_eq!(
                c.titlebar_press(&tree, point, 103, 1802),
                None,
                "title button stolen by drag"
            );
            tree.set_disabled(button, true).unwrap();
            assert_eq!(
                c.titlebar_press(&tree, point, 104, 1803),
                None,
                "disabled title button stolen by drag"
            );
            assert_eq!(
                c.titlebar_press(
                    &tree,
                    Point {
                        x: blank.x,
                        y: bounds.y + bounds.height + 1.
                    },
                    105,
                    1804
                ),
                None,
                "blur-only area below title starts drag"
            );
            for side in [
                nk_wayland::ControlsSide::Left,
                nk_wayland::ControlsSide::Right,
            ] {
                tree.set_server_controls(Some(nk_wayland::ControlsLayout {
                    side,
                    width: 80.,
                    height: 32.,
                }))
                .unwrap();
                tree.layout(tree.size, layered, &mut backend).unwrap();
                let point = Point {
                    x: if side == nk_wayland::ControlsSide::Left {
                        bounds.x + 1.
                    } else {
                        bounds.x + bounds.width - 1.
                    },
                    y: blank.y,
                };
                assert_eq!(
                    c.titlebar_press(&tree, point, 106, 1805),
                    None,
                    "server control reservation stolen by drag"
                );
            }
            c.last_title_press = None;
            assert_eq!(
                c.titlebar_press(&tree, blank, 0, u32::MAX - 20),
                Some(TitlebarAction::Move(0))
            );
            assert_eq!(
                c.titlebar_press(&tree, blank, 200, 20),
                Some(TitlebarAction::ToggleMaximize)
            );
            tree.narrow = true;
            tree.sidebar_open = true;
            assert_eq!(
                c.titlebar_press(&tree, blank, 201, 25),
                None,
                "open overlay must dismiss before dragging"
            );
            tree.narrow = false;
            tree.set_hidden(title, true).unwrap();
            assert_eq!(
                c.titlebar_press(&tree, blank, 201, 30),
                None,
                "hidden title starts drag"
            );
        }
    }
    #[test]
    fn capsules_retain_existing_button_actions_capture_names_and_geometry() {
        for layered in [false, true] {
            let (mut tree, mut backend, _, _, _) = fixture();
            tree.set_text_style(TextStyle {
                size: 14.,
                ..Default::default()
            });
            let metrics = CapsuleMetrics {
                padding: 5.,
                gap: 3.,
                button_min: 26.,
                height_min: 38.,
            };
            let capsule = tree
                .control_capsule("Window actions", Point { x: 300., y: 8. }, metrics)
                .unwrap();
            let names = ["Minimize", "Maximize", "Close"];
            let glyphs = [
                WindowGlyph::Minimize,
                WindowGlyph::Maximize,
                WindowGlyph::Close,
            ];
            tree.set_window_glyph_style(WindowGlyphStyle {
                size: 14.,
                stroke: 1.6,
                minimize_half: 3.5,
                maximize_half: 3.7,
                maximize_radius: 1.6,
                close_half: 3.,
            })
            .unwrap();
            let mut buttons = Vec::new();
            for i in 0..3 {
                let id = tree
                    .capsule_button(capsule, names[i], glyphs[i], i == 2)
                    .unwrap();
                buttons.push(id);
                tree.layout(tree.size, layered, &mut backend).unwrap();
                let bounds = tree.nodes[&capsule].bounds;
                assert_eq!((bounds.width, bounds.height), ([36., 65., 94.][i], 38.));
                assert_eq!(tree.nodes[&id].name, names[i]);
                assert_eq!(tree.nodes[&id].window_glyph, Some(glyphs[i]));
                assert!(tree.nodes[&id].layout.is_none());
                assert!(tree.nodes[&id].caption.is_none());
                assert!(tree.showing(id));
            }
            let semantics = tree.semantics();
            assert_eq!(semantics.nodes[&capsule].role, nk_a11y::Role::Panel);
            assert_eq!(semantics.nodes[&capsule].children, buttons);
            for id in &buttons {
                assert_eq!(semantics.nodes[id].role, nk_a11y::Role::Button);
                assert!(tree.focus_order().contains(id));
                assert_eq!(
                    tree.dispatch(tree.target(*id), Command::Activate).unwrap(),
                    Effect::Activated(*id)
                );
            }
            let close = buttons[2];
            let r = tree.nodes[&close].bounds;
            let point = Point {
                x: r.x + r.width / 2.,
                y: r.y + r.height / 2.,
            };
            tree.pointer_press(point).unwrap();
            assert_eq!(tree.captured(), Some(close));
            assert_eq!(
                tree.pointer_release(Point { x: 0., y: 0. }).unwrap(),
                Effect::None
            );
            tree.pointer_press_in(
                capsule,
                Point {
                    x: point.x - 300.,
                    y: point.y - 8.,
                },
            )
            .unwrap();
            assert_eq!(tree.captured(), Some(close));
            tree.set_disabled(close, true).unwrap();
            assert_eq!(tree.captured(), None);
            assert!(
                tree.dispatch(tree.target(close), Command::Activate)
                    .is_err()
            );
            tree.set_disabled(close, false).unwrap();
            tree.pointer_press(point).unwrap();
            tree.remove(close).unwrap();
            assert_eq!(tree.captured(), None);
            assert!(tree.node(close).is_none());
            tree.set_capsule_position(capsule, Point { x: 320., y: 12. })
                .unwrap();
            tree.layout(tree.size, layered, &mut backend).unwrap();
            assert_eq!(tree.nodes[&capsule].children, buttons[..2]);
            assert_eq!(
                (tree.nodes[&capsule].bounds.x, tree.nodes[&capsule].bounds.y),
                (320., 12.)
            );
            tree.set_capsule_metrics(
                capsule,
                CapsuleMetrics {
                    button_min: 32.,
                    height_min: 44.,
                    ..metrics
                },
            )
            .unwrap();
            tree.layout(tree.size, layered, &mut backend).unwrap();
            assert_eq!(tree.nodes[&capsule].children, buttons[..2]);
            assert_eq!(
                (
                    tree.nodes[&capsule].bounds.width,
                    tree.nodes[&capsule].bounds.height
                ),
                (77., 44.)
            );
            tree.set_capsule_position(capsule, Point { x: 1000., y: 12. })
                .unwrap();
            tree.layout(tree.size, layered, &mut backend).unwrap();
            assert!(
                buttons[..2].iter().all(|id| !tree.showing(*id)),
                "capsule outside clipped window is still showing"
            );
            tree.remove(capsule).unwrap();
            assert!(!tree.capsules.contains_key(&capsule));
        }
    }
    #[test]
    fn window_control_paths_paint_without_text_at_both_scales() {
        let (mut tree, mut backend, _, _, _) = fixture();
        let style = WindowGlyphStyle {
            size: 14.,
            stroke: 1.6,
            minimize_half: 3.5,
            maximize_half: 3.7,
            maximize_radius: 1.6,
            close_half: 3.,
        };
        let capsule = tree
            .control_capsule(
                "Controls",
                Point::default(),
                CapsuleMetrics {
                    padding: 4.,
                    gap: 8.,
                    button_min: 16.,
                    height_min: 24.,
                },
            )
            .unwrap();
        let id = tree
            .capsule_button(
                capsule,
                "Translated accessible name",
                WindowGlyph::Minimize,
                false,
            )
            .unwrap();
        tree.set_window_glyph_style(style).unwrap();
        let epoch = tree.pane_epoch;
        tree.set_window_glyph_style(style).unwrap();
        assert_eq!(epoch, tree.pane_epoch, "unchanged style repainted panes");
        tree.set_window_glyph_style(WindowGlyphStyle {
            stroke: 1.5,
            ..style
        })
        .unwrap();
        assert!(
            tree.pane_epoch > epoch,
            "style update left cached layer coverage stale"
        );
        tree.set_window_glyph_style(style).unwrap();
        for kind in [
            WindowGlyph::Minimize,
            WindowGlyph::Maximize,
            WindowGlyph::Close,
        ] {
            tree.nodes.get_mut(&id).unwrap().window_glyph = Some(kind);
            tree.layout(tree.size, true, &mut backend).unwrap();
            assert!(tree.nodes[&id].layout.is_none());
            assert!(tree.nodes[&id].caption.is_none());
            assert_eq!(tree.nodes[&id].bounds.width, 16.);
            for scale in [1., 1.25] {
                let pixels = (24. * scale) as u16;
                let frame = nk_wayland::Frame {
                    width: 24,
                    height: 24,
                    pixel_width: pixels,
                    pixel_height: pixels,
                    scale,
                    material: true,
                };
                let image = tree
                    .paint_capsule_coverage(capsule, frame, test_palette())
                    .unwrap();
                let alpha = |x: usize, y: usize| image[4 * (y * pixels as usize + x) + 3];
                let centre = (12. * scale) as usize;
                assert!(
                    image.as_chunks::<4>().0.iter().any(|p| p[3] > 200),
                    "{kind:?} drew nothing"
                );
                if kind == WindowGlyph::Maximize {
                    assert_eq!(alpha(centre, centre), 0, "maximize must be hollow");
                } else {
                    assert!(alpha(centre, centre) > 200, "missing stroke centre");
                }
                assert_eq!(alpha(0, 0), 0, "glyph escaped its box");
            }
        }
        tree.window_glyph_style = None;
        assert!(
            tree.paint_capsule_coverage(
                capsule,
                nk_wayland::Frame {
                    width: 24,
                    height: 24,
                    pixel_width: 24,
                    pixel_height: 24,
                    scale: 1.,
                    material: true
                },
                test_palette()
            )
            .is_err()
        );
    }

    #[test]
    fn capsule_coverage_states_and_layer_input_share_retained_geometry() {
        use crate::capsule_composition::CapsuleComposition;
        use nk_wayland::{Blur, ControlMaterial, Glass, Material, Shadow, Tone};
        let (mut tree, mut backend, _, _, _) = fixture();
        let capsule = tree
            .control_capsule(
                "Test controls",
                Point { x: 150., y: 100. },
                CapsuleMetrics {
                    padding: 5.,
                    gap: 3.,
                    button_min: 26.,
                    height_min: 38.,
                },
            )
            .unwrap();
        let normal = tree.capsule_button(capsule, "Normal", "A", false).unwrap();
        let close = tree.capsule_button(capsule, "Close", "X", true).unwrap();
        tree.layout(tree.size, true, &mut backend).unwrap();
        let tone = Tone {
            saturation: 1.,
            ceiling: 1.,
            lift: 0.,
            gain: 1.,
            wash: [0., 0., 0., 1.],
            ambient: 0.,
            ambient_lift: 0.,
            ambient_gain: 1.,
        };
        let state = |wash, ink| CapsuleStateStyle { wash, ink };
        let style = CapsuleStyle {
            material: ControlMaterial {
                base: Material {
                    glass: Glass {
                        refraction: 0.,
                        rim: 0.,
                        lensing: 0.,
                    },
                    tone,
                    shadow: Shadow {
                        opacity_small: 0.,
                        opacity_large: 0.,
                        blur_small: 0.,
                        blur_large: 0.,
                        offset: 0.,
                    },
                    shapes: vec![],
                },
                blur: Blur {
                    size: 0.,
                    passes: 0,
                },
                ink_tone: tone,
                response: None,
                light_ink: [1.; 4],
                dark_ink: [0., 0., 0., 1.],
                states: vec![],
                coverage: vec![],
            },
            hover: state([1., 1., 1., 0.1], None),
            press: state([1., 1., 1., 0.2], None),
            destructive_hover: state([1., 0., 0., 0.5], Some([1.; 4])),
            destructive_press: state([0.5, 0., 0., 0.7], Some([1.; 4])),
            fade_ms: 123,
        };
        let idle = tree.capsule_material(capsule, &style, false).unwrap();
        assert_eq!(
            idle.states[0].wash,
            [1., 1., 1., 0.],
            "normal idle wash discarded its hue"
        );
        assert_eq!(
            idle.states[1].wash,
            [1., 0., 0., 0.],
            "destructive idle wash discarded its hue"
        );
        let bounds = tree.nodes[&capsule].bounds;
        let frame = |scale: f64| nk_wayland::Frame {
            width: bounds.width.ceil() as u32,
            height: bounds.height.ceil() as u32,
            pixel_width: (bounds.width as f64 * scale).ceil() as u16,
            pixel_height: (bounds.height as f64 * scale).ceil() as u16,
            scale,
            material: true,
        };
        let local_center = |tree: &Tree, id| {
            let r = tree.nodes[&id].bounds;
            (
                r.x - bounds.x + r.width / 2.,
                r.y - bounds.y + r.height / 2.,
            )
        };
        let material = tree.capsule_material(capsule, &style, false).unwrap();
        assert_eq!(material.base.shapes.len(), 1);
        assert_eq!(
            material
                .states
                .iter()
                .map(|s| s.id as u64)
                .collect::<Vec<_>>(),
            vec![normal, close]
        );
        assert!(
            material
                .states
                .iter()
                .all(|s| s.wash[3] == 0. && s.fade_ms == 123)
        );
        assert_eq!(material.coverage.len(), 2);
        for scale in [1., 1.25] {
            let f = frame(scale);
            let idle = tree
                .paint_capsule_coverage(capsule, f, test_palette())
                .unwrap();
            assert_eq!(idle[3], 0, "coverage buffer paints a capsule background");
            assert!(
                idle.as_chunks::<4>().0.iter().any(|p| p[3] > 0),
                "glyph coverage absent"
            );
            for pixel in idle.as_chunks::<4>().0.iter().filter(|p| p[3] > 0) {
                assert_eq!(pixel[0], pixel[1]);
                assert_eq!(pixel[1], pixel[2]);
            }
            let (x, y) = local_center(&tree, close);
            CapsuleComposition::route(&mut tree, capsule, &LayerEvent::Motion(x as f64, y as f64))
                .unwrap();
            let hovered = tree.capsule_material(capsule, &style, false).unwrap();
            assert_eq!(hovered.states[1].wash, style.destructive_hover.wash);
            assert_eq!(hovered.coverage[1].override_color, [1.; 4]);
            assert_eq!(
                idle,
                tree.paint_capsule_coverage(capsule, f, test_palette())
                    .unwrap(),
                "hover painted a client-side disc instead of material wash"
            );
            CapsuleComposition::route(
                &mut tree,
                capsule,
                &LayerEvent::Button {
                    button: 272,
                    serial: 7,
                    time: 11,
                    pressed: true,
                    x: x as f64,
                    y: y as f64,
                },
            )
            .unwrap();
            assert_eq!(tree.captured(), Some(close));
            assert_eq!(
                tree.capsule_material(capsule, &style, false)
                    .unwrap()
                    .states[1]
                    .wash,
                style.destructive_press.wash
            );
            CapsuleComposition::route(&mut tree, capsule, &LayerEvent::Leave).unwrap();
            assert_eq!(
                tree.capsule_material(capsule, &style, false)
                    .unwrap()
                    .states[1]
                    .wash[3],
                0.,
                "exit region lost its alpha-zero state"
            );
            assert_eq!(
                CapsuleComposition::route(
                    &mut tree,
                    capsule,
                    &LayerEvent::Button {
                        button: 272,
                        serial: 7,
                        time: 11,
                        pressed: false,
                        x: -1.,
                        y: -1.
                    }
                )
                .unwrap(),
                Effect::None
            );
            let (x, y) = local_center(&tree, normal);
            CapsuleComposition::route(
                &mut tree,
                capsule,
                &LayerEvent::Button {
                    button: 272,
                    serial: 7,
                    time: 11,
                    pressed: true,
                    x: x as f64,
                    y: y as f64,
                },
            )
            .unwrap();
            assert_eq!(
                CapsuleComposition::route(
                    &mut tree,
                    capsule,
                    &LayerEvent::Button {
                        button: 272,
                        serial: 7,
                        time: 11,
                        pressed: false,
                        x: x as f64,
                        y: y as f64
                    }
                )
                .unwrap(),
                Effect::Activated(normal)
            );
            tree.pointer_leave();
        }
        tree.set_disabled(close, true).unwrap();
        let (x, y) = local_center(&tree, close);
        CapsuleComposition::route(&mut tree, capsule, &LayerEvent::Motion(x as f64, y as f64))
            .unwrap();
        let m = tree.capsule_material(capsule, &style, true).unwrap();
        assert!(m.states.iter().all(|s| s.fade_ms == 0));
        assert_eq!(m.states[1].wash[3], 0.);
        tree.set_hidden(close, true).unwrap();
        assert_eq!(
            tree.capsule_material(capsule, &style, false)
                .unwrap()
                .coverage
                .len(),
            1
        );
        tree.set_hidden(close, false).unwrap();
        tree.layout(tree.size, false, &mut backend).unwrap();
        tree.capsule_styles.insert(capsule, style);
        let mut canvas = nk_render::Canvas::new(frame(1.).pixel_width, frame(1.).pixel_height, 1.);
        tree.paint_capsule_into(
            capsule,
            Point {
                x: bounds.x,
                y: bounds.y,
            },
            &mut canvas,
            test_palette(),
            tree.capsule_styles.get(&capsule),
        )
        .unwrap();
        let opaque = canvas.finish();
        let center =
            ((frame(1.).pixel_height as usize / 2) * frame(1.).pixel_width as usize + 1) * 4;
        assert_eq!(opaque[center + 3], 255, "D5 capsule base is not opaque");

        // The opaque fallback uses the same exported duration and linear wash
        // law as Hyalo; painting must actually consume the shared sample.
        use std::time::Duration;
        let ms = |v: f64| Duration::from_secs_f64(v / 1000.);
        let mut fade = crate::capsule_fallback::Fallback::default();
        fade.update(&mut tree, ms(0.), false, true);
        assert!(!fade.active);
        let pixel = |tree: &Tree| {
            let mut c = nk_render::Canvas::new(frame(1.).pixel_width, frame(1.).pixel_height, 1.);
            tree.paint_capsule_into(
                capsule,
                Point {
                    x: bounds.x,
                    y: bounds.y,
                },
                &mut c,
                test_palette(),
                tree.capsule_styles.get(&capsule),
            )
            .unwrap();
            let r = tree.nodes[&normal].bounds;
            let x = (r.x - bounds.x + 2.) as usize;
            let y = (r.y - bounds.y + r.height / 2.) as usize;
            c.finish()[(y * frame(1.).pixel_width as usize + x) * 4]
        };
        let idle_pixel = pixel(&tree);
        let (x, y) = local_center(&tree, normal);
        CapsuleComposition::route(&mut tree, capsule, &LayerEvent::Motion(x as f64, y as f64))
            .unwrap();
        fade.update(&mut tree, ms(0.), false, true);
        assert!(fade.active);
        assert_eq!(
            tree.capsule_washes[&normal][3], 0.,
            "D5 hover jumped to its target"
        );
        fade.update(&mut tree, ms(61.5), false, true);
        assert!((tree.capsule_washes[&normal][3] - 0.05).abs() < 1e-9);
        assert_eq!(
            &tree.capsule_washes[&normal][..3],
            &[1., 1., 1.],
            "D5 midpoint lost hover RGB"
        );
        let middle_pixel = pixel(&tree);
        fade.update(&mut tree, ms(123.), false, true);
        let end_pixel = pixel(&tree);
        // The lab's custom root canvas must use the same retained opaque painter.
        let width = tree.size.width.ceil() as u16;
        let height = tree.size.height.ceil() as u16;
        let mut root_canvas = nk_render::Canvas::new(width, height, 1.);
        tree.paint_capsules_fallback(&mut root_canvas, test_palette())
            .unwrap();
        let root_pixels = root_canvas.finish();
        let r = tree.nodes[&normal].bounds;
        let sample = ((r.y + r.height / 2.) as usize * width as usize + (r.x + 2.) as usize) * 4;
        assert_eq!(
            root_pixels[sample], end_pixel,
            "custom root canvas omitted the retained capsule wash"
        );
        assert_eq!(root_pixels[sample + 3], 255);
        assert_eq!(
            root_pixels[root_pixels.len() - 1],
            0,
            "capsule fallback filled the diagnostic backdrop"
        );
        assert!(
            idle_pixel < middle_pixel && middle_pixel < end_pixel,
            "D5 painter ignored the interpolated wash: {idle_pixel}/{middle_pixel}/{end_pixel}"
        );
        assert!(!fade.active);
        assert!(
            ((middle_pixel as i16 - idle_pixel as i16) * 2
                - (end_pixel as i16 - idle_pixel as i16))
                .abs()
                <= 1,
            "D5 wash changed hue during a linear alpha fade: {idle_pixel}/{middle_pixel}/{end_pixel}"
        );
        tree.pointer_leave();
        fade.update(&mut tree, ms(123.), false, true);
        assert_eq!(tree.capsule_washes[&normal][3], 0.1);
        fade.update(&mut tree, ms(184.5), false, true);
        assert!((tree.capsule_washes[&normal][3] - 0.05).abs() < 1e-9);
        CapsuleComposition::route(&mut tree, capsule, &LayerEvent::Motion(x as f64, y as f64))
            .unwrap();
        fade.update(&mut tree, ms(184.5), false, true);
        fade.update(&mut tree, ms(246.), false, true);
        assert!(
            (tree.capsule_washes[&normal][3] - 0.075).abs() < 1e-9,
            "interrupted fade did not restart from its current sample"
        );
        fade.update(&mut tree, ms(247.), true, true);
        assert_eq!(tree.capsule_washes[&normal][3], 0.1);
        assert!(!fade.active);
        assert!(
            !fade.update(&mut tree, ms(500.), true, true),
            "settled D5 kept invalidating paint"
        );
        tree.set_hidden(capsule, true).unwrap();
        fade.update(&mut tree, ms(501.), false, true);
        assert!(tree.capsule_washes.is_empty());
        assert!(!fade.active);

        // CPU-only mixed-ownership oracle: one synthetic panel ID denotes a
        // layer-owned capsule, the other stays in the custom root canvas.
        // This does not fabricate a Wayland LayerId or allocation failure.
        tree.set_hidden(capsule, false).unwrap();
        let other = tree
            .control_capsule(
                "Other root panel",
                Point { x: 350., y: 200. },
                CapsuleMetrics {
                    padding: 5.,
                    gap: 3.,
                    button_min: 26.,
                    height_min: 38.,
                },
            )
            .unwrap();
        tree.capsule_button(other, "Other action", "B", false)
            .unwrap();
        tree.layout(tree.size, false, &mut backend).unwrap();
        tree.capsule_styles
            .insert(other, tree.capsule_styles[&capsule].clone());
        for layered in [capsule, other] {
            let mut canvas = nk_render::Canvas::new(width, height, 1.);
            tree.paint_capsules_fallback_where(&mut canvas, test_palette(), |id| id != layered)
                .unwrap();
            let pixels = canvas.finish();
            for id in [capsule, other] {
                let b = tree.nodes[&id].bounds;
                let alpha = pixels[((b.y + b.height / 2.) as usize * width as usize
                    + (b.x + 2.) as usize)
                    * 4
                    + 3];
                assert_eq!(
                    alpha,
                    if id == layered { 0 } else { 255 },
                    "mixed ownership duplicated a layered capsule or omitted a root capsule"
                );
            }
        }
    }
    #[test]
    fn blur_band_interior_edges_are_shared_physical_pixel_boundaries() {
        let style = TitlebarStyle {
            blur: nk_wayland::Blur {
                size: 2.,
                passes: 2,
            },
            height: 72.,
            curve: vec![1., 1., 0.5, 0.],
            background_opacity: 0.85,
            opaque: false,
        };
        for height in [71., 72., 101.] {
            for scale in [1., 1.25, 1.5, 1.75, 2.] {
                let panes = style.panes(520., height, scale);
                assert_eq!(panes[0].pane.y, 0.);
                let last = panes.last().unwrap().pane;
                assert!((last.y + last.height - height).abs() < 1e-9);
                for pair in panes.windows(2) {
                    let edge = pair[0].pane.y + pair[0].pane.height;
                    assert!((edge - pair[1].pane.y).abs() < 1e-9);
                    let physical = edge * scale;
                    assert!(
                        (physical - physical.round()).abs() < 1e-9,
                        "blur boundary inside a physical pixel: height={height} scale={scale}"
                    );
                    assert_eq!(pair[0].bottom, pair[1].top);
                }
            }
        }
    }
    #[test]
    fn server_controls_reserve_the_chosen_side_and_fallbacks_keep_the_same_actions() {
        let (mut tree, mut backend, _, title, _) = fixture();
        let ids = tree
            .window_controls(title, ["Minimize", "Maximize", "Close"])
            .unwrap();
        tree.layout(tree.size, true, &mut backend).unwrap();
        let normal = tree.node(title).unwrap().children()[0];
        assert!(tree.node(normal).unwrap().bounds().x < tree.node(ids[0]).unwrap().bounds().x);
        for id in ids {
            assert!(tree.focus_order().contains(&id));
            assert_eq!(
                tree.dispatch(tree.target(id), Command::Activate).unwrap(),
                Effect::Activated(id)
            );
            assert_eq!(tree.semantics().nodes[&id].role, nk_a11y::Role::Button);
        }
        for side in [
            nk_wayland::ControlsSide::Right,
            nk_wayland::ControlsSide::Left,
        ] {
            tree.set_server_controls(Some(nk_wayland::ControlsLayout {
                side,
                width: 88.,
                height: 32.,
            }))
            .unwrap();
            tree.layout(tree.size, true, &mut backend).unwrap();
            assert!(
                ids.iter()
                    .all(|id| !tree.semantics().nodes.contains_key(id))
            );
            let bounds = tree.node(normal).unwrap().bounds();
            let bar = tree.node(title).unwrap().bounds();
            if side == nk_wayland::ControlsSide::Left {
                assert!(bounds.x >= bar.x + 88.);
            } else {
                assert!(bounds.x + bounds.width < bar.x + bar.width - 88.);
            }
        }
        tree.set_server_controls(None).unwrap();
        tree.layout(tree.size, false, &mut backend).unwrap();
        assert!(ids.iter().all(|id| tree.focus_order().contains(id)));
        assert_eq!(tree.node(ids[2]).unwrap().name(), "Close");
    }
}
