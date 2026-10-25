// SPDX-License-Identifier: LGPL-3.0-or-later
//! Editable combo: one retained SearchInput, existing MenuList and nonmodal xdg popup.
use crate::*;
use nk_wayland::{Event, LayerEvent, Material, Pane, PopupEvent, PopupId, PopupPlacement, Window};
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Suggestion {
    pub key: u64,
    pub label: String,
    pub description: String,
}
pub(crate) struct SemanticState {
    pub list: NodeId,
    pub expanded: bool,
    pub active: Option<NodeId>,
}
pub struct Suggestions {
    input: NodeId,
    list: NodeId,
    options: Vec<NodeId>,
    values: Vec<Suggestion>,
    menu: Option<Tree>,
    items: Vec<NodeId>,
    popup: Option<PopupId>,
    placement: Option<PopupPlacement>,
    reposition: u32,
    open: bool,
    active: Option<usize>,
    style: MenuStyle,
    composition: window::Composition,
    origin: Option<Point>,
    changed: bool,
}
impl Suggestions {
    /// Attach before the first semantic publication; this input stays a ComboBox.
    pub fn new(parent: &mut Tree, input: NodeId, name: &str, style: MenuStyle) -> Result<Self> {
        if !parent.searches.contains_key(&input) || parent.suggestion_combos.contains_key(&input) {
            return Err("suggestions require an unattached SearchInput".into());
        }
        let list = parent.allocate(Some(input), Kind::List { height: 1. }, name.into());
        parent.set_hidden(list, true)?;
        parent.suggestion_combos.insert(
            input,
            SemanticState {
                list,
                expanded: false,
                active: None,
            },
        );
        Ok(Self {
            input,
            list,
            options: vec![],
            values: vec![],
            menu: None,
            items: vec![],
            popup: None,
            placement: None,
            reposition: 0,
            open: false,
            active: None,
            style,
            composition: Default::default(),
            origin: None,
            changed: true,
        })
    }
    pub fn restyle(&mut self, parent: &Tree, style: MenuStyle) -> Result<()> {
        if let Some(menu) = &mut self.menu {
            menu.set_menu_style(style.clone())?;
            menu.metrics = parent.metrics;
            menu.set_text_style(parent.style.clone());
        }
        self.style = style;
        self.changed = true;
        Ok(())
    }
    /// The existing retained MenuList, for read-only geometry/paint inspection.
    pub fn view(&self) -> Option<&Tree> {
        self.menu.as_ref()
    }
    pub fn is_open(&self) -> bool {
        self.open
    }
    /// Programmatic page navigation dismisses the model immediately; sync retires
    /// the transport popup on the owning Window without nesting an event loop.
    pub fn dismiss(&mut self, parent: &mut Tree) -> Result<()> {
        self.open = false;
        self.active = None;
        self.origin = None;
        self.update_semantics(parent)
    }
    pub fn close(&mut self, parent: &mut Tree, window: &mut Window) -> Result<()> {
        self.dismiss(parent)?;
        self.placement = None;
        if self.popup.take().is_some() {
            window.close_popup_overlay();
        }
        Ok(())
    }
    pub fn set_values(
        &mut self,
        parent: &mut Tree,
        values: Vec<Suggestion>,
        backend: &mut impl TextBackend,
    ) -> Result<()> {
        if values == self.values {
            return Ok(());
        }
        self.values = values;
        parent.invalidate(self.input, Invalid::SEMANTICS);
        self.active = None;
        self.changed = true;
        self.origin = None;
        while self.options.len() < self.values.len() {
            self.options.push(parent.allocate(
                Some(self.list),
                Kind::DropdownOption { selected: false },
                String::new(),
            ));
        }
        for (at, id) in self.options.iter().enumerate() {
            let value = self.values.get(at);
            parent.set_hidden(*id, value.is_none())?;
            if let Some(value) = value {
                parent.set_name(*id, &value.label)?;
                parent.nodes.get_mut(id).unwrap().caption = Some(value.description.clone());
            }
        }
        self.open = !self.values.is_empty()
            && parent.focused == Some(self.input)
            && !parent.search_composing(self.input)?;
        if self.values.is_empty() {
            self.menu = None;
            self.items.clear();
        } else {
            let labels: Vec<_> = self
                .values
                .iter()
                .map(|v| {
                    if v.description.is_empty() {
                        v.label.clone()
                    } else {
                        format!("{}\n{}", v.label, v.description)
                    }
                })
                .collect();
            let names: Vec<_> = labels.iter().map(String::as_str).collect();
            let (mut menu, items) = Tree::menu_list(
                &parent.nodes[&self.input].name,
                parent.metrics,
                parent.style.clone(),
                self.style.clone(),
                &names,
                0,
            )?;
            for id in &items {
                menu.nodes.get_mut(id).unwrap().kind = Kind::MenuOption { selected: false };
            }
            let r = parent.nodes[&self.input].bounds;
            menu.layout(
                Size {
                    width: r.width.max(parent.metrics.content_floor),
                    height: parent.size.height,
                },
                false,
                backend,
            )?;
            self.menu = Some(menu);
            self.items = items;
        }
        self.update_semantics(parent)
    }
    fn update_semantics(&mut self, parent: &mut Tree) -> Result<()> {
        let visible = self.open && self.origin.is_some();
        parent.set_hidden(self.list, !visible)?;
        let active = self
            .active
            .and_then(|at| self.options.get(at))
            .copied()
            .filter(|_| visible);
        let state = parent
            .suggestion_combos
            .get_mut(&self.input)
            .ok_or("suggestion input removed")?;
        let mut different = state.expanded != visible || state.active != active;
        state.expanded = visible;
        state.active = active;
        for (at, id) in self.options.iter().enumerate() {
            parent.nodes.get_mut(id).unwrap().kind = Kind::DropdownOption {
                selected: visible && self.active == Some(at),
            };
            if let (Some(origin), Some(menu), Some(item)) =
                (self.origin, self.menu.as_ref(), self.items.get(at))
            {
                let r = menu.nodes[item].bounds;
                let bounds = Rect {
                    x: r.x + origin.x,
                    y: r.y + origin.y,
                    ..r
                };
                different |= parent.nodes[id].bounds != bounds;
                parent.nodes.get_mut(id).unwrap().bounds = bounds;
            }
        }
        if let Some(origin) = self.origin
            && let Some(menu) = &self.menu
        {
            let bounds = Rect {
                x: origin.x,
                y: origin.y,
                width: menu.size.width,
                height: menu.size.height,
            };
            different |= parent.nodes[&self.list].bounds != bounds;
            parent.nodes.get_mut(&self.list).unwrap().bounds = bounds;
        }
        if different {
            parent.invalidate(self.input, Invalid::SEMANTICS);
        }
        Ok(())
    }
    pub fn move_selection(&mut self, parent: &mut Tree, down: bool) -> Result<()> {
        if self.values.is_empty() {
            return Ok(());
        }
        self.open = true;
        let at = match self.active {
            None => {
                if down {
                    0
                } else {
                    self.values.len() - 1
                }
            }
            Some(at) => {
                if down {
                    (at + 1).min(self.values.len() - 1)
                } else {
                    at.saturating_sub(1)
                }
            }
        };
        self.active = Some(at);
        if let Some(menu) = &mut self.menu {
            menu.set_focus_visible(true);
            menu.focus(self.items[at])?;
        }
        self.changed = true;
        self.update_semantics(parent)
    }
    /// None means ordinary parent dispatch; Some(None) consumes navigation/dismissal.
    pub fn event(
        &mut self,
        parent: &mut Tree,
        event: &Event,
        window: &mut Window,
    ) -> Result<Option<Option<u64>>> {
        if let Event::PopupOverlay { id, event } = event {
            if Some(*id) != self.popup {
                return Ok(Some(None));
            }
            match event {
                PopupEvent::Done => {
                    self.close(parent, window)?;
                }
                PopupEvent::Configure => {
                    parent.invalidate(self.input, Invalid::SEMANTICS);
                    self.changed = true;
                }
                PopupEvent::FrameDone => {}
                PopupEvent::Input(input) => {
                    let translated = match input {
                        LayerEvent::Motion(x, y) => Some(Event::Motion(*x, *y)),
                        LayerEvent::Leave => Some(Event::PointerLeave),
                        LayerEvent::Button {
                            button,
                            pressed,
                            serial,
                            time,
                            ..
                        } => Some(Event::Button {
                            button: *button,
                            pressed: *pressed,
                            serial: *serial,
                            time: *time,
                        }),
                        LayerEvent::Scroll(y) => Some(Event::Scroll(*y)),
                        _ => None,
                    };
                    if let (Some(menu), Some(event)) = (&mut self.menu, translated) {
                        if let Effect::Activated(id) = self.composition.event(menu, &event)?
                            && let Some(at) = self.items.iter().position(|i| *i == id)
                        {
                            let key = self.values[at].key;
                            self.close(parent, window)?;
                            return Ok(Some(Some(key)));
                        }
                        self.changed |= menu.invalidation().paint;
                        if matches!(event, Event::Motion(..)) {
                            self.active = menu
                                .hovered
                                .and_then(|id| self.items.iter().position(|i| *i == id));
                        }
                    }
                }
            }
            return Ok(Some(None));
        }
        if matches!(event, Event::Focus(false)) {
            self.close(parent, window)?;
            return Ok(None);
        }
        if matches!(
            event,
            Event::Button { pressed: true, .. }
                | Event::Layer {
                    event: LayerEvent::Button { pressed: true, .. },
                    ..
                }
        ) {
            // Parent clicks keep their normal dispatch; a click in the editor may reopen on edit.
            self.close(parent, window)?;
        }
        if parent.focused != Some(self.input) {
            return Ok(None);
        }
        let Event::Key(key) = event else {
            return Ok(None);
        };
        if key.ctrl || key.alt || parent.search_composing(self.input)? {
            return Ok(None);
        }
        match key.sym {
            0xff54 | 0xff52 => {
                self.move_selection(parent, key.sym == 0xff54)?;
                Ok(Some(None))
            }
            0xff1b if self.open && !parent.search_consumes_escape(self.input)? => {
                self.close(parent, window)?;
                Ok(Some(None))
            }
            0xff0d | 0xff8d if self.open => {
                let key = self
                    .active
                    .or(Some(0))
                    .and_then(|at| self.values.get(at))
                    .map(|v| v.key);
                self.close(parent, window)?;
                Ok(Some(key))
            }
            _ => Ok(None),
        }
    }
    pub fn request(
        &mut self,
        parent: &mut Tree,
        request: &nk_a11y::Request,
        window: &mut Window,
    ) -> Result<Option<Option<u64>>> {
        let (id, activate) = match request {
            nk_a11y::Request::Focus(id) => (*id, false),
            nk_a11y::Request::Activate(id) => (*id, true),
            _ => return Ok(None),
        };
        let Some(at) = self.options.iter().position(|i| *i == id) else {
            return Ok(None);
        };
        if !self.open || self.origin.is_none() || at >= self.values.len() {
            return Err("stale suggestion option".into());
        }
        if activate {
            let key = self.values[at].key;
            self.close(parent, window)?;
            Ok(Some(Some(key)))
        } else {
            self.active = Some(at);
            if let Some(menu) = &mut self.menu {
                menu.set_focus_visible(true);
                menu.focus(self.items[at])?;
            }
            self.changed = true;
            self.update_semantics(parent)?;
            Ok(Some(None))
        }
    }
    pub fn sync(
        &mut self,
        parent: &mut Tree,
        window: &mut Window,
        backend: &mut impl TextBackend,
        palette: Palette,
        material: impl Fn(f64) -> Result<Option<Material>>,
    ) -> Result<()> {
        if !parent.showing(self.input) || parent.focused != Some(self.input) {
            self.close(parent, window)?;
            return Ok(());
        }
        if !self.open {
            if self.popup.is_some() {
                self.close(parent, window)?;
            }
            return Ok(());
        }
        let Some(menu) = &mut self.menu else {
            return Ok(());
        };
        if self.changed {
            menu.layout(menu.size, false, backend)?;
        }
        let r = parent.nodes[&self.input].bounds;
        let scroll = menu.nodes[&menu.root].children[0];
        let height = menu.nodes[&scroll].measured.height + 2. * self.style.border;
        let placement = PopupPlacement {
            anchor: [
                r.x.floor() as i32,
                r.y.floor() as i32,
                r.width.ceil() as i32,
                r.height.ceil() as i32,
            ],
            size: (
                r.width.max(parent.metrics.content_floor).ceil() as u32,
                height.ceil().max(1.) as u32,
            ),
        };
        match self.popup {
            None => {
                self.popup = Some(window.open_popup_overlay(placement)?);
                self.placement = Some(placement);
            }
            Some(id) if self.placement != Some(placement) => {
                self.reposition = self.reposition.wrapping_add(1);
                window.reposition_popup_overlay(id, placement, self.reposition)?;
                self.placement = Some(placement);
            }
            _ => {}
        }
        let id = self.popup.unwrap();
        if let Some([x, y, w, h]) = window.popup_overlay_geometry(id) {
            let origin = Point {
                x: x as f32,
                y: y as f32,
            };
            let size = Size {
                width: w as f32,
                height: h as f32,
            };
            if self.origin != Some(origin) || menu.size != size {
                self.changed = true;
                self.origin = Some(origin);
                menu.layout(size, false, backend)?;
            }
            if self.changed
                && let Some(mut frame) = window.popup_overlay_frame(id)?
            {
                let material = material(f64::from(w.min(h)))?;
                frame.material &= material.is_some();
                let bytes = menu.paint(frame, Surface::Content, palette)?;
                let material = material.map(|mut m| {
                    m.shapes = vec![Pane {
                        x: 0.,
                        y: 0.,
                        width: f64::from(w),
                        height: f64::from(h),
                        radius: f64::from(self.style.radius),
                        exponent: 2.,
                    }];
                    m
                });
                if window.paint_popup_overlay(id, frame, &bytes, material.as_ref())? {
                    menu.acknowledge();
                    self.changed = false;
                }
            }
        }
        self.update_semantics(parent)
    }
}
