// SPDX-License-Identifier: LGPL-3.0-or-later
//! Retained structural widgets. The tree is the source for layout, pixels,
//! hit-testing, focus and semantics; Wayland remains in nk-wayland.
mod choices;
mod motion;
mod paint;
mod semantics;
pub mod window;
pub use choices::{ChoiceKind, ChoiceStyle};
pub use nk_a11y::NodeId;
use nk_text::{Layout, Point, Rect, Size, TextBackend, TextStyle};
pub use paint::{Palette, Surface};
use std::collections::BTreeMap;
pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Invalid {
    pub layout: bool,
    pub paint: bool,
    pub semantics: bool,
}
impl Invalid {
    pub const LAYOUT: Self = Self {
        layout: true,
        paint: true,
        semantics: true,
    };
    pub const PAINT: Self = Self {
        layout: false,
        paint: true,
        semantics: false,
    };
    pub const SEMANTICS: Self = Self {
        layout: false,
        paint: false,
        semantics: true,
    };
    pub const STATE: Self = Self {
        layout: false,
        paint: true,
        semantics: true,
    };
    fn merge(&mut self, other: Self) {
        self.layout |= other.layout;
        self.paint |= other.paint;
        self.semantics |= other.semantics;
    }
}
/// Logical measurements supplied from the kit's exported tokens, never a theme
/// hidden in the transport. Text may grow beyond these minima.
#[derive(Clone, Copy, Debug)]
pub struct Metrics {
    pub sidebar: f32,
    /// Fixed content width in WINDOW_LAYOUT; breakpoint = sidebar + content.
    pub content: f32,
    pub form_width: f32,
    pub content_floor: f32,
    pub titlebar: f32,
    pub padding: f32,
    pub gap: f32,
    pub row: f32,
    pub control: f32,
    pub switch_width: f32,
    pub radius: f32,
    pub group_radius: f32,
    pub focus_width: f32,
    pub highlight_inset: f32,
    pub hover_opacity: f32,
    pub separator_width: f32,
}
/// The application names a page category, never a width in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PageWidth {
    Form,
    Reading,
    None,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Window,
    Sidebar,
    Page {
        selected: bool,
    },
    TitleBar,
    Scroll,
    Group,
    Row,
    Label,
    Switch {
        checked: bool,
    },
    Button,
    /// A radio group: a row's control holding its `Choice`s (#882).
    Choices {
        kind: ChoiceKind,
    },
    Choice {
        checked: bool,
    },
}
impl Kind {
    fn focusable(self) -> bool {
        matches!(
            self,
            Self::Page { .. } | Self::Switch { .. } | Self::Button | Self::Choice { .. }
        )
    }
    /// What a row holds beside its label: one of these.
    pub(crate) fn row_control(self) -> bool {
        matches!(
            self,
            Self::Switch { .. } | Self::Button | Self::Choices { .. }
        )
    }
}
/// The button owns its silhouette; interaction feedback follows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ButtonShape {
    Rounded,
    Capsule,
}
pub struct Node {
    pub(crate) kind: Kind,
    pub(crate) button_shape: ButtonShape,
    pub(crate) name: String,
    pub(crate) parent: Option<NodeId>,
    pub(crate) children: Vec<NodeId>,
    pub(crate) hidden: bool,
    pub(crate) disabled: bool,
    pub(crate) bounds: Rect,
    pub(crate) measured: Size,
    pub(crate) layout: Option<Layout>,
    pub(crate) dirty: Invalid,
    pub(crate) scroll: Point,
    pub(crate) min_width: f32,
    width: Option<f32>,
    pub(crate) constraint: f32,
    pub(crate) swatch: Option<nk_render::Color>,
}
impl Node {
    pub fn kind(&self) -> Kind {
        self.kind
    }
    pub fn name(&self) -> &str {
        &self.name
    }
    pub fn children(&self) -> &[NodeId] {
        &self.children
    }
    pub fn bounds(&self) -> Rect {
        self.bounds
    }
    pub fn measured(&self) -> Size {
        self.measured
    }
    pub fn text_layout(&self) -> Option<&Layout> {
        self.layout.as_ref()
    }
    pub fn invalidation(&self) -> Invalid {
        self.dirty
    }
    pub fn scroll(&self) -> Point {
        self.scroll
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Target {
    pub id: NodeId,
    pub generation: u64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Command {
    Focus,
    Activate,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Effect {
    Activated(NodeId),
    Focused(NodeId),
    None,
}

pub struct Tree {
    pub(crate) nodes: BTreeMap<NodeId, Node>,
    root: NodeId,
    next: NodeId,
    generation: u64,
    pub(crate) focused: Option<NodeId>,
    pub(crate) focus_visible: bool,
    pub(crate) hovered: Option<NodeId>,
    page_width: PageWidth,
    capture: Option<NodeId>,
    capture_space: Option<NodeId>,
    pub(crate) active: bool,
    pub(crate) metrics: Metrics,
    style: TextStyle,
    pub(crate) size: Size,
    pub(crate) layered: bool,
    pub(crate) sidebar_open: bool,
    pub(crate) sidebar_x: f32,
    pub(crate) sidebar_margin: f32,
    pub(crate) sidebar_radius: f32,
    pub(crate) leading: f32,
    pub(crate) narrow: bool,
    sidebar_initialized: bool,
    pub(crate) sidebar_request: Option<bool>,
    sidebar_button: Option<NodeId>,
    pub(crate) window_buttons: Option<[NodeId; 3]>,
    pub(crate) server_controls: Option<nk_wayland::ControlsLayout>,
    invalid: Invalid,
    pub(crate) pane_epoch: u64,
    pub(crate) choice_style: Option<ChoiceStyle>,
}
impl Tree {
    pub fn new(title: impl Into<String>, metrics: Metrics, style: TextStyle) -> Result<Self> {
        if [
            metrics.sidebar,
            metrics.content,
            metrics.form_width,
            metrics.content_floor,
            metrics.titlebar,
            metrics.padding,
            metrics.gap,
            metrics.row,
            metrics.control,
            metrics.switch_width,
            metrics.radius,
            metrics.group_radius,
            metrics.focus_width,
            metrics.highlight_inset,
            metrics.hover_opacity,
            metrics.separator_width,
        ]
        .iter()
        .any(|n| !n.is_finite() || *n < 0.)
        {
            return Err("non-finite or negative widget measurement".into());
        }
        if metrics.content_floor <= 0. || metrics.form_width < metrics.content_floor {
            return Err("invalid content width tokens".into());
        }
        let mut tree = Self {
            nodes: BTreeMap::new(),
            root: 1,
            next: 1,
            generation: 0,
            focused: None,
            focus_visible: false,
            hovered: None,
            page_width: PageWidth::None,
            capture: None,
            capture_space: None,
            active: false,
            metrics,
            style,
            size: Size::default(),
            layered: false,
            sidebar_open: true,
            sidebar_x: 0.,
            sidebar_margin: 0.,
            sidebar_radius: 0.,
            leading: metrics.sidebar,
            narrow: false,
            sidebar_initialized: false,
            sidebar_request: None,
            sidebar_button: None,
            window_buttons: None,
            server_controls: None,
            invalid: Invalid::LAYOUT,
            pane_epoch: 0,
            choice_style: None,
        };
        tree.allocate(None, Kind::Window, title.into());
        Ok(tree)
    }
    fn allocate(&mut self, parent: Option<NodeId>, kind: Kind, name: String) -> NodeId {
        let id = self.next;
        self.next = self.next.checked_add(1).expect("widget id exhausted");
        self.nodes.insert(
            id,
            Node {
                kind,
                button_shape: ButtonShape::Rounded,
                name,
                parent,
                children: vec![],
                hidden: false,
                disabled: false,
                bounds: Rect::default(),
                measured: Size::default(),
                layout: None,
                dirty: Invalid::LAYOUT,
                scroll: Point::default(),
                min_width: 0.,
                width: None,
                constraint: 0.,
                swatch: None,
            },
        );
        if let Some(p) = parent {
            self.nodes.get_mut(&p).unwrap().children.push(id);
        }
        self.generation += 1;
        self.invalidate(id, Invalid::LAYOUT);
        id
    }
    pub fn root(&self) -> NodeId {
        self.root
    }
    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(&id)
    }
    pub fn generation(&self) -> u64 {
        self.generation
    }
    pub fn focused(&self) -> Option<NodeId> {
        self.focused
    }
    pub fn focus_visible(&self) -> bool {
        self.focus_visible
    }
    pub(crate) fn set_focus_visible(&mut self, visible: bool) {
        if self.focus_visible != visible {
            self.focus_visible = visible;
            if let Some(id) = self.focused {
                self.invalidate(id, Invalid::PAINT);
            }
        }
    }
    pub fn captured(&self) -> Option<NodeId> {
        self.capture
    }
    pub fn target(&self, id: NodeId) -> Target {
        Target {
            id,
            generation: self.generation,
        }
    }
    pub fn invalidation(&self) -> Invalid {
        self.invalid
    }
    /// Clear only after the consumer has laid out, painted and published semantics.
    pub fn acknowledge_semantics(&mut self) {
        self.invalid.semantics = false;
        for n in self.nodes.values_mut() {
            n.dirty.semantics = false;
        }
    }
    pub fn acknowledge(&mut self) {
        self.invalid = Invalid::default();
        for n in self.nodes.values_mut() {
            n.dirty = Invalid::default();
        }
    }
    pub fn append(
        &mut self,
        parent: NodeId,
        kind: Kind,
        name: impl Into<String>,
    ) -> Result<NodeId> {
        let p = self.nodes.get(&parent).ok_or("unknown parent")?;
        let valid = matches!(
            (p.kind, kind),
            (Kind::Window, Kind::Sidebar | Kind::TitleBar | Kind::Scroll)
                | (Kind::Sidebar, Kind::Page { .. })
                | (Kind::TitleBar, Kind::Button)
                | (Kind::Scroll, Kind::Group | Kind::Row)
                | (Kind::Group, Kind::Label | Kind::Row)
                | (Kind::Row, Kind::Label | Kind::Switch { .. } | Kind::Button)
                | (Kind::Row, Kind::Choices { .. })
                | (Kind::Choices { .. }, Kind::Choice { .. })
        );
        if !valid {
            return Err("invalid structural widget parent".into());
        }
        if matches!(kind, Kind::Sidebar | Kind::TitleBar | Kind::Scroll)
            && p.children.iter().any(|id| self.nodes[id].kind == kind)
        {
            return Err("duplicate window region".into());
        }
        if (matches!(p.kind, Kind::Row | Kind::Group) && kind == Kind::Label)
            && p.children
                .iter()
                .any(|id| self.nodes[id].kind == Kind::Label)
        {
            return Err("duplicate structural label".into());
        }
        if p.kind == Kind::Row
            && kind.row_control()
            && p.children
                .iter()
                .any(|id| self.nodes[id].kind.row_control())
        {
            return Err("a row has one control".into());
        }
        let id = self.allocate(Some(parent), kind, name.into());
        if matches!(kind, Kind::Page { selected: true }) {
            self.select_page(id)?;
        }
        Ok(id)
    }
    /// A regular button with the window's sidebar action; other title buttons
    /// remain application actions. The tree derives its identity and semantics.
    pub fn sidebar_button(&mut self, titlebar: NodeId, name: &str) -> Result<NodeId> {
        if self
            .nodes
            .get(&titlebar)
            .is_none_or(|n| n.kind != Kind::TitleBar)
        {
            return Err("sidebar button needs a title bar".into());
        }
        if self
            .sidebar_button
            .is_some_and(|id| self.nodes.contains_key(&id))
        {
            return Err("sidebar already has a toggle button".into());
        }
        let id = self.append(titlebar, Kind::Button, name)?;
        self.sidebar_button = Some(id);
        Ok(id)
    }
    /// Keyboard/AT-SPI reachable fallback controls. Composition hides them after server layout.
    pub fn window_controls(&mut self, titlebar: NodeId, names: [&str; 3]) -> Result<[NodeId; 3]> {
        if self.window_buttons.is_some() {
            return Err("duplicate window controls".into());
        }
        if self
            .nodes
            .get(&titlebar)
            .is_none_or(|n| n.kind != Kind::TitleBar)
        {
            return Err("window controls need a titlebar".into());
        }
        let ids = [
            self.append(titlebar, Kind::Button, names[0])?,
            self.append(titlebar, Kind::Button, names[1])?,
            self.append(titlebar, Kind::Button, names[2])?,
        ];
        self.window_buttons = Some(ids);
        Ok(ids)
    }
    pub(crate) fn set_server_controls(
        &mut self,
        layout: Option<nk_wayland::ControlsLayout>,
    ) -> Result<()> {
        if self.server_controls != layout {
            self.server_controls = layout;
            if let Some(ids) = self.window_buttons {
                for id in ids {
                    self.set_hidden(id, layout.is_some())?;
                }
            }
            self.pane_epoch += 1;
            self.invalidate(self.root, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub(crate) fn title_leading_controls(&self) -> f32 {
        self.server_controls
            .filter(|v| v.side == nk_wayland::ControlsSide::Left)
            .map_or(0., |v| v.width as f32 + self.metrics.gap)
    }
    pub fn group(&mut self, parent: NodeId, header: &str) -> Result<NodeId> {
        let id = self.append(parent, Kind::Group, "")?;
        self.append(id, Kind::Label, header)?;
        Ok(id)
    }
    pub fn row(&mut self, parent: NodeId, label: &str, control: Kind) -> Result<(NodeId, NodeId)> {
        if !matches!(control, Kind::Switch { .. } | Kind::Button) {
            return Err("row needs switch or button".into());
        }
        let row = self.append(parent, Kind::Row, "")?;
        self.append(row, Kind::Label, label)?;
        let control = self.append(row, control, label)?;
        Ok((row, control))
    }
    pub fn invalidate(&mut self, id: NodeId, kind: Invalid) {
        self.invalid.merge(kind);
        let mut current = Some(id);
        while let Some(id) = current {
            let n = self.nodes.get_mut(&id).unwrap();
            n.dirty.merge(kind);
            current = if kind.layout { n.parent } else { None };
        }
        if self.in_pane(id) {
            self.pane_epoch += 1;
        }
    }
    fn in_pane(&self, id: NodeId) -> bool {
        let mut current = Some(id);
        while let Some(id) = current {
            let n = &self.nodes[&id];
            if matches!(n.kind, Kind::Sidebar | Kind::TitleBar) {
                return true;
            }
            current = n.parent;
        }
        false
    }
    fn available(&self, id: NodeId) -> bool {
        let mut current = Some(id);
        while let Some(id) = current {
            let Some(n) = self.nodes.get(&id) else {
                return false;
            };
            if n.hidden || n.disabled {
                return false;
            }
            current = n.parent;
        }
        true
    }
    pub fn is_hidden(&self, id: NodeId) -> bool {
        let mut current = Some(id);
        while let Some(id) = current {
            let Some(n) = self.nodes.get(&id) else {
                return true;
            };
            if n.hidden {
                return true;
            }
            current = n.parent;
        }
        false
    }
    fn ordered(&self, id: NodeId, out: &mut Vec<NodeId>) {
        if self.is_hidden(id) {
            return;
        }
        out.push(id);
        for child in &self.nodes[&id].children {
            self.ordered(*child, out);
        }
    }
    pub fn focus_order(&self) -> Vec<NodeId> {
        let mut ids = vec![];
        self.ordered(self.root, &mut ids);
        ids.into_iter()
            .filter(|id| {
                self.nodes[id].kind.focusable()
                    && self.available(*id)
                    && self.tab_stop(*id)
                    && (self.sidebar_open
                        || !self.in_pane(*id)
                        || !matches!(self.nodes[id].kind, Kind::Page { .. }))
            })
            .collect()
    }
    pub fn set_hidden(&mut self, id: NodeId, hidden: bool) -> Result<()> {
        self.set_unavailable(id, hidden, false)
    }
    pub fn set_disabled(&mut self, id: NodeId, disabled: bool) -> Result<()> {
        self.set_unavailable(id, disabled, true)
    }
    fn set_unavailable(&mut self, id: NodeId, value: bool, disabled: bool) -> Result<()> {
        let old_order = self.focus_order();
        let old_focus = self.focused;
        let node = self.nodes.get_mut(&id).ok_or("unknown widget")?;
        let field = if disabled {
            &mut node.disabled
        } else {
            &mut node.hidden
        };
        if *field == value {
            return Ok(());
        }
        *field = value;
        self.generation += 1;
        self.invalidate(
            id,
            if disabled {
                Invalid::STATE
            } else {
                Invalid::LAYOUT
            },
        );
        if self.hovered.is_some_and(|id| !self.available(id)) {
            self.set_hovered(None);
        }
        if self.capture.is_some_and(|id| !self.available(id)) {
            self.capture = None;
            self.capture_space = None;
        }
        if old_focus.is_some_and(|id| !self.available(id)) {
            self.focused = None;
            let start = old_order
                .iter()
                .position(|id| Some(*id) == old_focus)
                .unwrap();
            if let Some(next) = old_order
                .iter()
                .cycle()
                .skip(start + 1)
                .take(old_order.len())
                .find(|id| self.available(**id))
                .copied()
            {
                self.focus(next)?;
            }
        }
        Ok(())
    }
    pub fn remove(&mut self, id: NodeId) -> Result<()> {
        if id == self.root {
            return Err("cannot remove window root".into());
        }
        self.set_hidden(id, true)?;
        let parent = self.nodes.get(&id).ok_or("unknown widget")?.parent.unwrap();
        fn erase(tree: &mut Tree, id: NodeId) {
            let node = tree.nodes.remove(&id).unwrap();
            for child in node.children {
                erase(tree, child);
            }
        }
        erase(self, id);
        self.nodes
            .get_mut(&parent)
            .unwrap()
            .children
            .retain(|child| *child != id);
        self.generation += 1;
        self.invalidate(parent, Invalid::LAYOUT);
        Ok(())
    }
    pub fn set_name(&mut self, id: NodeId, name: impl Into<String>) -> Result<()> {
        let node = self.nodes.get_mut(&id).ok_or("unknown widget")?;
        node.name = name.into();
        node.layout = None;
        node.constraint = 0.;
        self.invalidate(id, Invalid::LAYOUT);
        Ok(())
    }
    /// Ordinary buttons use Metrics.radius; capsules explicitly opt into half-height.
    pub fn set_button_shape(&mut self, id: NodeId, shape: ButtonShape) -> Result<()> {
        let node = self.nodes.get_mut(&id).ok_or("unknown widget")?;
        if node.kind != Kind::Button {
            return Err("button shape requires a button".into());
        }
        if node.button_shape != shape {
            node.button_shape = shape;
            self.invalidate(id, Invalid::PAINT);
        }
        Ok(())
    }
    pub fn set_text_style(&mut self, style: TextStyle) {
        self.style = style;
        for n in self.nodes.values_mut() {
            n.layout = None;
            n.constraint = 0.;
            n.dirty.merge(Invalid::LAYOUT);
        }
        self.pane_epoch += 1;
        self.invalidate(self.root, Invalid::LAYOUT);
    }
    pub fn set_width(&mut self, id: NodeId, width: f32) -> Result<()> {
        if !width.is_finite() || width <= 0. {
            return Err("invalid width".into());
        }
        self.nodes.get_mut(&id).ok_or("unknown widget")?.width = Some(width);
        self.invalidate(id, Invalid::LAYOUT);
        Ok(())
    }
    pub fn set_min_width(&mut self, id: NodeId, width: f32) -> Result<()> {
        if !width.is_finite() || width < 0. {
            return Err("invalid minimum width".into());
        }
        self.nodes.get_mut(&id).ok_or("unknown widget")?.min_width = width;
        self.invalidate(id, Invalid::LAYOUT);
        Ok(())
    }
    pub fn set_active(&mut self, active: bool) {
        self.active = active;
        self.invalidate(self.root, Invalid::SEMANTICS);
    }
    pub fn dispatch(&mut self, target: Target, command: Command) -> Result<Effect> {
        if target.generation != self.generation
            || !self.available(target.id)
            || !self.nodes[&target.id].kind.focusable()
        {
            return Err("stale, hidden, disabled or non-actionable widget target".into());
        }
        match command {
            Command::Focus => {
                self.focus(target.id)?;
                Ok(Effect::Focused(target.id))
            }
            Command::Activate => self.activate(target.id),
        }
    }
    pub fn focus(&mut self, id: NodeId) -> Result<()> {
        if !self.available(id)
            || !self.nodes[&id].kind.focusable()
            || (matches!(self.nodes[&id].kind, Kind::Page { .. })
                && !self.sidebar_open
                && !self.showing(id))
        {
            return Err("widget cannot take focus".into());
        }
        self.focus_node(id);
        Ok(())
    }
    fn focus_node(&mut self, id: NodeId) {
        if let Some(old) = self.focused {
            self.invalidate(old, Invalid::STATE);
        }
        self.focused = Some(id);
        self.invalidate(id, Invalid::STATE);
        self.reveal(id);
    }
    pub fn tab(&mut self, backwards: bool) -> Result<()> {
        self.set_focus_visible(true);
        self.traverse_focus(backwards)
    }
    pub(crate) fn traverse_focus(&mut self, backwards: bool) -> Result<()> {
        let order = self.focus_order();
        if order.is_empty() {
            return Ok(());
        }
        let next = match self
            .focused
            .and_then(|id| order.iter().position(|n| *n == id))
        {
            Some(i) if backwards => (i + order.len() - 1) % order.len(),
            Some(i) => (i + 1) % order.len(),
            None if backwards => order.len() - 1,
            None => 0,
        };
        self.focus(order[next])
    }
    /// Update a controlled switch from the application's model, without activation.
    pub fn set_checked(&mut self, id: NodeId, checked: bool) -> Result<()> {
        let node = self.nodes.get_mut(&id).ok_or("unknown switch")?;
        if !matches!(node.kind, Kind::Switch { .. }) {
            return Err("widget is not a switch".into());
        }
        if node.kind != (Kind::Switch { checked }) {
            node.kind = Kind::Switch { checked };
            self.invalidate(id, Invalid::STATE);
        }
        Ok(())
    }
    pub fn select_page(&mut self, id: NodeId) -> Result<()> {
        let node = self.nodes.get(&id).ok_or("unknown page")?;
        if !matches!(node.kind, Kind::Page { .. }) {
            return Err("widget is not a page".into());
        }
        let parent = node.parent.unwrap();
        for child in self.nodes[&parent].children.clone() {
            if matches!(self.nodes[&child].kind, Kind::Page { .. }) {
                self.nodes.get_mut(&child).unwrap().kind = Kind::Page {
                    selected: child == id,
                };
                self.invalidate(child, Invalid::STATE);
            }
        }
        Ok(())
    }
    fn activate(&mut self, id: NodeId) -> Result<Effect> {
        if !self.available(id) {
            return Err("unavailable activation".into());
        }
        match self.nodes[&id].kind {
            Kind::Switch { checked } => self.set_checked(id, !checked)?,
            Kind::Choice { .. } => self.set_choice(id)?,
            Kind::Page { .. } => {
                self.select_page(id)?;
                if self.narrow {
                    self.sidebar_request = Some(false);
                }
            }
            Kind::Button => {
                if self.sidebar_button == Some(id) {
                    self.sidebar_request = Some(!self.sidebar_open);
                }
                self.invalidate(id, Invalid::STATE);
            }
            _ => return Err("widget has no activation".into()),
        }
        Ok(Effect::Activated(id))
    }
    pub fn pointer_leave(&mut self) {
        self.set_hovered(None);
    }
    fn set_hovered(&mut self, id: Option<NodeId>) {
        if self.hovered != id {
            let previous = self.hovered;
            self.hovered = id;
            for id in previous.into_iter().chain(id) {
                self.invalidate(id, Invalid::PAINT);
            }
        }
    }
    pub fn pointer_motion(&mut self, point: Point) {
        self.set_hovered(self.hit_test(point));
    }
    pub fn pointer_motion_in(&mut self, container: NodeId, local: Point) -> Result<()> {
        let id = self.hit_test_in(container, local)?;
        self.set_hovered(id);
        Ok(())
    }
    pub fn pointer_press(&mut self, p: Point) -> Result<()> {
        self.set_focus_visible(false);
        self.capture_space = None;
        self.capture = self.hit_test(p);
        self.set_hovered(self.capture);
        if let Some(id) = self.capture {
            self.invalidate(id, Invalid::PAINT);
        }
        if let Some(id) = self.capture {
            self.focus(id)?;
        }
        Ok(())
    }
    /// A subsurface event is already clipped and inverse-transformed by the
    /// compositor at its PRESENTED position. Never clip it at the model endpoint.
    pub fn pointer_press_in(&mut self, container: NodeId, local: Point) -> Result<()> {
        self.set_focus_visible(false);
        self.capture = self.hit_test_in(container, local)?;
        self.set_hovered(self.capture);
        self.capture_space = Some(container);
        if let Some(id) = self.capture {
            self.focus_node(id);
        }
        Ok(())
    }
    fn hit_test_in(&self, container: NodeId, local: Point) -> Result<Option<NodeId>> {
        let origin = self
            .nodes
            .get(&container)
            .ok_or("unknown input pane")?
            .bounds;
        if !matches!(self.nodes[&container].kind, Kind::Sidebar | Kind::TitleBar) {
            return Err("input space is not a pane".into());
        }
        let p = Point {
            x: local.x + origin.x,
            y: local.y + origin.y,
        };
        let mut ids = vec![];
        self.ordered(container, &mut ids);
        let header = self.content_viewport().y;
        let inside = self.nodes[&container].kind != Kind::Sidebar || local.y >= header;
        Ok(ids.into_iter().rev().find(|id| {
            inside
                && self.available(*id)
                && self.nodes[id].kind.focusable()
                && contains(self.nodes[id].bounds, p)
        }))
    }
    pub fn pointer_release_in(&mut self, container: NodeId, local: Point) -> Result<Effect> {
        let origin = self
            .nodes
            .get(&container)
            .ok_or("unknown input pane")?
            .bounds;
        if self.nodes[&container].kind == Kind::Sidebar && local.y < self.content_viewport().y {
            self.capture = None;
            self.capture_space = None;
            return Ok(Effect::None);
        }
        self.release(
            Point {
                x: local.x + origin.x,
                y: local.y + origin.y,
            },
            Some(container),
        )
    }
    pub fn pointer_release(&mut self, p: Point) -> Result<Effect> {
        self.release(p, None)
    }
    fn release(&mut self, p: Point, space: Option<NodeId>) -> Result<Effect> {
        let capture = self.capture.take();
        if let Some(id) = capture {
            self.invalidate(id, Invalid::PAINT);
        }
        let same_space = self.capture_space.take() == space;
        if same_space
            && let Some(id) = capture.filter(|id| self.available(*id))
            && contains(self.nodes[&id].bounds, p)
            && (space.is_some() || self.showing(id))
        {
            return self.activate(id);
        }
        Ok(Effect::None)
    }
    pub fn hit_test(&self, p: Point) -> Option<NodeId> {
        // Use the sampled placement, including the visible portion of a closing
        // D5 sidebar; Tab order may already exclude its model-closed pages.
        let mut ids = vec![];
        self.ordered(self.root, &mut ids);
        ids.sort_by_key(|id| self.in_pane(*id));
        ids.into_iter().rev().find(|id| {
            self.available(*id)
                && self.nodes[id].kind.focusable()
                && contains(self.nodes[id].bounds, p)
                && contains(self.visible_clip(*id), p)
        })
    }
    pub fn layout(
        &mut self,
        size: Size,
        layered: bool,
        backend: &mut impl TextBackend,
    ) -> Result<()> {
        if !size.width.is_finite()
            || !size.height.is_finite()
            || size.width <= 0.
            || size.height <= 0.
        {
            return Err("invalid window constraints".into());
        }
        if self.adapt_sidebar(size.width) {
            self.sidebar_x = self.sidebar_target();
            self.leading = self.inset_target();
        }
        if self.size != size || self.layered != layered {
            self.size = size;
            self.layered = layered;
            self.pane_epoch += 1;
            self.invalidate(self.root, Invalid::LAYOUT);
        }
        if self.invalid.layout {
            self.measure(self.root, size.width, backend)?;
            let viewport = self.content_viewport();
            let side = self.sidebar_viewport();
            for n in self.nodes.values_mut() {
                let clip = if n.kind == Kind::Sidebar {
                    side
                } else {
                    viewport
                };
                if matches!(n.kind, Kind::Scroll | Kind::Sidebar) {
                    n.scroll.y = n.scroll.y.min((n.measured.height - clip.height).max(0.));
                    n.scroll.x = if n.kind == Kind::Sidebar {
                        0.
                    } else {
                        n.scroll.x.min((n.measured.width - clip.width).max(0.))
                    };
                }
            }
            self.place();
            self.invalid.layout = false;
            for n in self.nodes.values_mut() {
                n.dirty.layout = false;
            }
        }
        Ok(())
    }
    fn measure(&mut self, id: NodeId, width: f32, backend: &mut impl TextBackend) -> Result<Size> {
        if self.is_hidden(id) {
            self.nodes.get_mut(&id).unwrap().measured = Size::default();
            return Ok(Size::default());
        }
        let kind = self.nodes[&id].kind;
        let m = self.metrics;
        let width = self.nodes[&id]
            .width
            .unwrap_or(width)
            .max(self.nodes[&id].min_width)
            .max(1.);
        let width = if kind == Kind::Scroll {
            self.content_column_width(width)
        } else {
            width
        };
        if !self.nodes[&id].dirty.layout && self.nodes[&id].constraint == width {
            return Ok(self.nodes[&id].measured);
        }
        self.nodes.get_mut(&id).unwrap().constraint = width;
        if let Kind::Choices { kind } = kind {
            return self.measure_choices(id, kind, width, backend);
        }
        if kind == Kind::Row {
            let children = self.nodes[&id].children.clone();
            let mut control_width: f32 = 0.;
            let mut height: f32 = 0.;
            for child in &children {
                if !self.is_hidden(*child) && self.nodes[child].kind.row_control() {
                    let size = self.measure(*child, (width / 2.).max(1.), backend)?;
                    control_width = control_width.max(size.width);
                    height = height.max(size.height);
                }
            }
            for child in &children {
                if !self.is_hidden(*child) && self.nodes[child].kind == Kind::Label {
                    let size = self.measure(
                        *child,
                        (width - control_width - 3. * m.padding).max(1.),
                        backend,
                    )?;
                    height = height.max(size.height);
                }
            }
            let size = Size {
                width,
                height: m.row.max(height + 2. * m.padding),
            };
            self.nodes.get_mut(&id).unwrap().measured = size;
            return Ok(size);
        }
        if kind == Kind::TitleBar {
            let mut reserved = 0.;
            let mut child_height: f32 = 0.;
            for child in self.nodes[&id].children.clone() {
                if !self.is_hidden(child) {
                    let measured = self.measure(child, (width / 2.).max(1.), backend)?;
                    reserved += measured.width + m.gap;
                    child_height = child_height.max(measured.height);
                }
            }
            let server_reserved = self.server_controls.map_or(0., |v| v.width as f32 + m.gap);
            let legacy_reserved = if self.window_buttons.is_none() {
                3. * m.control
            } else {
                0.
            };
            let label_width =
                (width - reserved - server_reserved - legacy_reserved - 2. * m.padding).max(1.);
            let n = self.nodes.get_mut(&id).unwrap();
            let text = if n.name.is_empty() {
                Size::default()
            } else if let Some(layout) = &mut n.layout {
                layout.size(label_width)?
            } else {
                let layout = backend.layout(&n.name, &self.style, label_width)?;
                let size = layout.measured_size();
                n.layout = Some(layout);
                size
            };
            n.measured = Size {
                width,
                height: m
                    .titlebar
                    .max(text.height + 2. * m.padding)
                    .max(child_height)
                    .max(
                        self.server_controls
                            .map_or(0., |v| v.height as f32 + 2. * m.gap),
                    ),
            };
            return Ok(n.measured);
        }
        let label_width = match kind {
            Kind::TitleBar => (width - 3. * m.control - 2. * m.padding).max(1.),
            Kind::Page { .. } | Kind::Button => (width - 2. * m.padding).max(1.),
            _ => width,
        };
        let mut text = Size::default();
        if !self.nodes[&id].name.is_empty()
            && matches!(kind, Kind::Label | Kind::Page { .. } | Kind::Button)
        {
            let n = self.nodes.get_mut(&id).unwrap();
            if let Some(layout) = &mut n.layout {
                text = layout.size(label_width)?;
            } else {
                let layout = backend.layout(&n.name, &self.style, label_width)?;
                text = layout.measured_size();
                n.layout = Some(layout);
            }
        }
        let children = self.nodes[&id].children.clone();
        let mut sum: f32 = 0.;
        let mut max_h: f32 = 0.;
        let mut max_w = width;
        for child in children {
            let child_width = match kind {
                Kind::Window => match self.nodes[&child].kind {
                    Kind::Sidebar => m.sidebar - 2. * self.sidebar_margin,
                    Kind::Scroll => (width - self.leading).max(1.),
                    Kind::TitleBar => (width - self.leading).max(1.),
                    _ => width,
                },
                Kind::Row if self.nodes[&child].kind.row_control() => m.control,
                Kind::Row => label_width,
                _ => (width - 2. * m.padding).max(1.),
            };
            let s = self.measure(child, child_width, backend)?;
            if self.is_hidden(child) {
                continue;
            }
            sum += s.height + m.gap;
            max_h = max_h.max(s.height);
            max_w = max_w.max(s.width);
        }
        let size = match kind {
            Kind::Window => self.size,
            Kind::Sidebar => Size {
                width,
                height: sum + 2. * m.padding,
            },
            Kind::TitleBar => Size {
                width,
                height: m.titlebar.max(text.height + 2. * m.padding),
            },
            Kind::Scroll => Size {
                width: max_w,
                height: sum + 2. * m.padding,
            },
            Kind::Row => Size {
                width,
                height: m.row.max(max_h + 2. * m.padding),
            },
            Kind::Group => Size {
                width: max_w,
                height: sum + 2. * m.padding,
            },
            Kind::Switch { .. } => Size {
                width: m.switch_width,
                height: m.control,
            },
            Kind::Button => Size {
                width: m.control.max(text.width + 2. * m.padding),
                height: m.control.max(text.height + 2. * m.padding),
            },
            Kind::Page { .. } => Size {
                width,
                height: m.row.max(text.height + 2. * m.padding),
            },
            Kind::Label => Size {
                width: text.width,
                height: text.height,
            },
            // Measured with their group (measure_choices).
            Kind::Choices { .. } | Kind::Choice { .. } => self.nodes[&id].measured,
        };
        self.nodes.get_mut(&id).unwrap().measured = size;
        Ok(size)
    }
    /// Set the sampled leading inset for a coupled window relayout. Composition
    /// normally drives this from the same curve as the pane's position.
    pub fn set_leading_inset(&mut self, leading: f32) -> Result<()> {
        if !leading.is_finite() || leading < 0. || leading > self.metrics.sidebar {
            return Err("invalid leading inset".into());
        }
        if self.leading != leading {
            self.leading = leading;
            self.invalidate(self.root, Invalid::LAYOUT);
            self.pane_epoch += 1;
        }
        Ok(())
    }
    /// The sidebar's floating frame, from application tokens; the width law keeps its room.
    pub fn set_sidebar_frame(&mut self, margin: f32, radius: f32) -> Result<()> {
        if !margin.is_finite()
            || !radius.is_finite()
            || margin < 0.
            || radius < 0.
            || 2. * margin >= self.metrics.sidebar
        {
            return Err("invalid sidebar frame".into());
        }
        if self.sidebar_margin != margin || self.sidebar_radius != radius {
            self.sidebar_margin = margin;
            self.sidebar_radius = radius;
            self.pane_epoch += 1;
            self.invalidate(self.root, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub(crate) fn sidebar_rect(&self) -> Rect {
        let margin = self
            .sidebar_margin
            .min((self.size.height - 1.).max(0.) / 2.);
        Rect {
            x: self.sidebar_x + self.sidebar_margin,
            y: margin,
            width: self.metrics.sidebar - 2. * self.sidebar_margin,
            height: (self.size.height - 2. * margin).max(1.),
        }
    }
    /// Reading is intentionally unavailable until a real reading page measures its tokens.
    pub fn set_page_width(&mut self, kind: PageWidth) -> Result<()> {
        if kind == PageWidth::Reading {
            return Err("reading width tokens not defined".into());
        }
        if self.page_width != kind {
            self.page_width = kind;
            self.invalidate(self.root, Invalid::LAYOUT);
        }
        Ok(())
    }
    fn content_column_width(&self, available: f32) -> f32 {
        match self.page_width {
            PageWidth::Form => available.clamp(self.metrics.content_floor, self.metrics.form_width),
            PageWidth::None => available,
            PageWidth::Reading => unreachable!("reading tokens required by setter"),
        }
    }
    pub fn sidebar_open(&self) -> bool {
        self.sidebar_open
    }
    pub fn sidebar_overlay(&self) -> bool {
        self.narrow && self.sidebar_open
    }
    pub(crate) fn sidebar_target(&self) -> f32 {
        if self.sidebar_open {
            0.
        } else {
            -self.metrics.sidebar
        }
    }
    pub(crate) fn inset_target(&self) -> f32 {
        if self.sidebar_open && !self.narrow {
            self.metrics.sidebar
        } else {
            0.
        }
    }
    pub(crate) fn adapt_sidebar(&mut self, width: f32) -> bool {
        let narrow = width < self.metrics.sidebar + self.metrics.content;
        if self.sidebar_initialized && self.narrow == narrow {
            return false;
        }
        self.sidebar_initialized = true;
        self.narrow = narrow;
        self.change_sidebar(!narrow);
        true
    }
    pub(crate) fn change_sidebar(&mut self, open: bool) {
        self.sidebar_open = open;
        self.generation += 1;
        self.invalidate(self.root, Invalid::LAYOUT);
    }
    pub(crate) fn sidebar_viewport(&self) -> Rect {
        let pane = self.sidebar_rect();
        let top = (pane.y + self.content_viewport().y).min(pane.y + pane.height);
        let left = pane.x.max(0.);
        let right = (pane.x + pane.width).min(self.size.width).max(left);
        Rect {
            x: left,
            y: top,
            width: right - left,
            height: (pane.y + pane.height - top).max(0.),
        }
    }
    pub fn content_viewport(&self) -> Rect {
        let leading = self.leading;
        let top = self
            .nodes
            .values()
            .find(|n| n.kind == Kind::TitleBar)
            .map_or(self.metrics.titlebar, |n| n.measured.height);
        Rect {
            x: leading,
            y: top,
            width: (self.size.width - leading).max(0.),
            height: (self.size.height - top).max(0.),
        }
    }
    fn place(&mut self) {
        let size = self.size;
        self.nodes.get_mut(&self.root).unwrap().bounds = Rect {
            x: 0.,
            y: 0.,
            width: size.width,
            height: size.height,
        };
        let viewport = self.content_viewport();
        for child in self.nodes[&self.root].children.clone() {
            let r = match self.nodes[&child].kind {
                Kind::Sidebar => self.sidebar_rect(),
                Kind::TitleBar => Rect {
                    x: viewport.x,
                    y: 0.,
                    width: viewport.width,
                    height: viewport.y,
                },
                Kind::Scroll => Rect {
                    x: 0.,
                    y: 0.,
                    width: size.width,
                    height: size.height,
                },
                _ => continue,
            };
            self.place_node(child, r);
        }
    }
    fn place_node(&mut self, id: NodeId, r: Rect) {
        self.nodes.get_mut(&id).unwrap().bounds = r;
        let node = &self.nodes[&id];
        let kind = node.kind;
        if matches!(kind, Kind::Choices { .. }) {
            self.place_choices(id, r);
            return;
        }
        let children = node.children.clone();
        let m = self.metrics;
        let inset = self.content_viewport();
        let mut y = r.y + m.padding;
        let mut x = r.x + m.padding;
        if kind == Kind::Sidebar {
            y += inset.y - node.scroll.y;
        }
        if kind == Kind::Scroll {
            let column = self.content_column_width(inset.width);
            x = inset.x + (inset.width - column).max(0.) / 2. + m.padding - node.scroll.x;
            y = inset.y + m.padding - node.scroll.y;
        }
        let trailing_width = if kind == Kind::TitleBar {
            self.window_buttons.map_or(0., |ids| {
                ids.iter()
                    .filter(|id| !self.is_hidden(**id))
                    .map(|id| self.nodes[id].measured.width + m.gap)
                    .sum::<f32>()
            })
        } else {
            0.
        };
        let mut trailing_x = r.x + r.width - m.padding - trailing_width;
        if kind == Kind::TitleBar {
            x += self.title_leading_controls();
        }
        for child in children {
            if self.is_hidden(child) {
                continue;
            }
            let n = &self.nodes[&child];
            let s = n.measured;
            let fallback = self.window_buttons.is_some_and(|ids| ids.contains(&child));
            let bounds = if kind == Kind::TitleBar {
                Rect {
                    x: if fallback { trailing_x } else { x },
                    y: r.y + (r.height - s.height) / 2.,
                    width: s.width,
                    height: s.height,
                }
            } else if kind == Kind::Row {
                let control = n.kind.row_control();
                Rect {
                    x: if control {
                        r.x + r.width - m.padding - s.width
                    } else {
                        x
                    },
                    y: r.y + (r.height - s.height) / 2.,
                    width: s.width,
                    height: s.height,
                }
            } else {
                Rect {
                    x,
                    y,
                    // A group's measured width includes overflow for the enclosing
                    // scroll extent. Its card occupies its constrained column.
                    width: if n.kind == Kind::Group {
                        n.constraint
                    } else {
                        s.width
                    },
                    height: s.height,
                }
            };
            self.place_node(child, bounds);
            if kind == Kind::TitleBar {
                if fallback {
                    trailing_x += s.width + m.gap;
                } else {
                    x += s.width + m.gap;
                }
            } else if kind != Kind::Row {
                y += s.height + m.gap;
            }
        }
    }
    pub fn scroll_to(&mut self, id: NodeId, offset: Point) -> Result<()> {
        if !offset.x.is_finite() || !offset.y.is_finite() {
            return Err("invalid scroll offset".into());
        }
        let viewport = if self.nodes.get(&id).is_some_and(|n| n.kind == Kind::Sidebar) {
            self.sidebar_viewport()
        } else {
            self.content_viewport()
        };
        let n = self.nodes.get_mut(&id).ok_or("unknown scroll")?;
        if !matches!(n.kind, Kind::Scroll | Kind::Sidebar) {
            return Err("widget is not scrollable".into());
        }
        let max_y = (n.measured.height - viewport.height).max(0.);
        // Horizontal content may be deliberately wider than the viewport. The
        // viewport width is excluded from the scrollable content extent.
        let max_x = if n.kind == Kind::Sidebar {
            0.
        } else {
            (n.measured.width - viewport.width).max(0.)
        };
        n.scroll = Point {
            x: offset.x.clamp(0., max_x),
            y: offset.y.clamp(0., max_y),
        };
        self.invalidate(id, Invalid::STATE);
        self.place();
        Ok(())
    }
    fn reveal(&mut self, id: NodeId) {
        let mut parent = self.nodes[&id].parent;
        while let Some(p) = parent {
            if matches!(self.nodes[&p].kind, Kind::Scroll | Kind::Sidebar) {
                let r = self.nodes[&id].bounds;
                let clip = if self.nodes[&p].kind == Kind::Sidebar {
                    self.sidebar_viewport()
                } else {
                    self.visible_clip(id)
                };
                let delta = |start: f32, size: f32, low: f32, length: f32| {
                    if start < low {
                        start - low
                    } else if start + size > low + length {
                        (start + size - low - length).min(start - low)
                    } else {
                        0.
                    }
                };
                let old = self.nodes[&p].scroll;
                let _ = self.scroll_to(
                    p,
                    Point {
                        x: old.x + delta(r.x, r.width, clip.x, clip.width),
                        y: old.y + delta(r.y, r.height, clip.y, clip.height),
                    },
                );
            }
            parent = self.nodes[&p].parent;
        }
    }
    pub(crate) fn visible_clip(&self, id: NodeId) -> Rect {
        if self.in_pane(id) {
            let mut current = Some(id);
            while let Some(p) = current {
                if self.nodes[&p].kind == Kind::Sidebar {
                    return self.sidebar_viewport();
                }
                if self.nodes[&p].kind == Kind::TitleBar {
                    return self.nodes[&p].bounds;
                }
                current = self.nodes[&p].parent;
            }
        }
        let mut current = Some(id);
        while let Some(p) = current {
            if self.nodes[&p].kind == Kind::Scroll {
                let mut clip = self.content_viewport();
                if self.narrow && self.sidebar_open {
                    let occlusion =
                        (self.sidebar_x + self.metrics.sidebar).clamp(0., self.size.width);
                    clip.width = (self.size.width - occlusion).max(0.);
                    clip.x = occlusion;
                }
                return clip;
            }
            current = self.nodes[&p].parent;
        }
        Rect {
            x: 0.,
            y: 0.,
            width: self.size.width,
            height: self.size.height,
        }
    }
    pub fn showing(&self, id: NodeId) -> bool {
        !self.is_hidden(id) && intersects(self.nodes[&id].bounds, self.visible_clip(id))
    }
}
pub(crate) fn contains(r: Rect, p: Point) -> bool {
    p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height
}
pub(crate) fn intersects(a: Rect, b: Rect) -> bool {
    a.width > 0.
        && a.height > 0.
        && b.width > 0.
        && b.height > 0.
        && a.x < b.x + b.width
        && a.x + a.width > b.x
        && a.y < b.y + b.height
        && a.y + a.height > b.y
}
