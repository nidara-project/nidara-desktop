// SPDX-License-Identifier: LGPL-3.0-or-later
//! Retained structural widgets. The tree is the source for layout, pixels,
//! hit-testing, focus and semantics; Wayland remains in nk-wayland.
mod image;
pub use image::ImageStyle;
mod choices;
mod dropdown;
pub use dropdown::DropdownStyle;
mod dialog;
mod dropdown_popup;
pub use dialog::DialogTree;
pub use dropdown_popup::{DropdownPopup, PopupSnapshot};
mod menu;
pub use menu::MenuStyle;

mod capsule;
mod capsule_fallback;
pub use capsule::{CapsuleMetrics, CapsuleStateStyle, CapsuleStyle};
pub mod capsule_composition;
mod motion;
mod paint;
mod ranges;
mod rows;
mod search;
mod semantics;
pub use search::SearchStyle;
mod switch;
pub mod window;
pub use choices::{ChoiceKind, ChoiceStyle};
pub use nk_a11y::NodeId;
use nk_text::{Layout, Point, Rect, Size, TextBackend, TextStyle};
pub use paint::{Palette, Surface};
pub use ranges::{RangeStyle, ValueRange};
pub use rows::RowTextStyle;
use std::collections::BTreeMap;
pub use switch::SwitchStyle;
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
    /// Embedded single-selection viewport; rows reuse MenuOption.
    List {
        height: f32,
    },
    Group,
    ControlCapsule,
    Row,
    Label,
    Image,
    Switch {
        checked: bool,
    },
    Button,
    SearchInput,
    Dropdown {
        expanded: bool,
    },
    /// Model-only children for ComboBox Selection, not painted popup items.
    DropdownOption {
        selected: bool,
    },
    MenuOption {
        selected: bool,
    },
    /// A radio group: a row's control holding its `Choice`s (#882).
    Choices {
        kind: ChoiceKind,
    },
    Choice {
        checked: bool,
    },
    /// A value on a range, moved by steps (#882); its range is the node's `range`.
    Slider {
        value: f32,
    },
    /// A row's control holding spin buttons (the time fields).
    Fields,
    Spin {
        value: f32,
    },
    /// A row's second line (`set_subtitle`).
    Subtitle,
    /// The line under a group's card (`set_footer`).
    Footer,
    /// A row that opens and closes what follows it (`disclosure`).
    Disclosure {
        expanded: bool,
    },
}
impl Kind {
    fn focusable(self) -> bool {
        matches!(
            self,
            Self::Page { .. }
                | Self::Switch { .. }
                | Self::Button
                | Self::SearchInput
                | Self::Dropdown { .. }
                | Self::MenuOption { .. }
                | Self::Choice { .. }
                | Self::Slider { .. }
                | Self::Spin { .. }
                | Self::Disclosure { .. }
        )
    }
    /// What a row holds beside its label: one of these.
    pub(crate) fn row_control(self) -> bool {
        matches!(
            self,
            Self::Switch { .. }
                | Self::Button
                | Self::Dropdown { .. }
                | Self::Choices { .. }
                | Self::Slider { .. }
                | Self::Fields
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
    pub(crate) caption: Option<String>,
    pub(crate) destructive: bool,
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
    pub(crate) range: Option<ValueRange>,
    /// A slider's flanking icons, by name: its lesser end, its greater end.
    pub(crate) endpoints: Option<[String; 2]>,
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
    /// A range control's value changed (key, pointer or assistive technology).
    Changed(NodeId),
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
    pub(crate) capsules: BTreeMap<NodeId, capsule::Capsule>,
    pub(crate) capsule_styles: BTreeMap<NodeId, CapsuleStyle>,
    pub(crate) capsule_washes: BTreeMap<NodeId, [f64; 4]>,
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
    pub(crate) range_style: Option<RangeStyle>,
    pub(crate) switch_style: Option<SwitchStyle>,
    pub(crate) row_text_style: Option<RowTextStyle>,
    dropdown_style: Option<DropdownStyle>,
    label_styles: BTreeMap<NodeId, TextStyle>,
    images: BTreeMap<NodeId, image::Image>,
    button_descriptions: BTreeMap<NodeId, String>,
    dialog_role: bool,
    menu_style: Option<MenuStyle>,
    list_styles: BTreeMap<NodeId, MenuStyle>,
    search_style: Option<SearchStyle>,
    searches: BTreeMap<NodeId, search::Search>,
    /// Interface icons by name (`set_icon_theme`), cached as they are drawn.
    pub(crate) icons: Option<std::cell::RefCell<nk_icons::Icons>>,
}
impl Tree {
    pub fn new(title: impl Into<String>, metrics: Metrics, style: TextStyle) -> Result<Self> {
        Self::new_at(title, metrics, style, 1)
    }
    fn new_at(
        title: impl Into<String>,
        metrics: Metrics,
        style: TextStyle,
        first: NodeId,
    ) -> Result<Self> {
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
            root: first,
            next: first,
            generation: 0,
            focused: None,
            focus_visible: false,
            hovered: None,
            page_width: PageWidth::None,
            capsules: BTreeMap::new(),
            capsule_styles: BTreeMap::new(),
            capsule_washes: BTreeMap::new(),
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
            range_style: None,
            switch_style: None,
            row_text_style: None,
            dropdown_style: None,
            label_styles: BTreeMap::new(),
            images: BTreeMap::new(),
            button_descriptions: BTreeMap::new(),
            dialog_role: false,
            menu_style: None,
            list_styles: BTreeMap::new(),
            search_style: None,
            searches: BTreeMap::new(),
            icons: None,
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
                caption: None,
                destructive: false,
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
                range: None,
                endpoints: None,
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
                | (Kind::Sidebar, Kind::Page { .. } | Kind::SearchInput)
                | (Kind::TitleBar | Kind::ControlCapsule, Kind::Button)
                | (
                    Kind::Scroll,
                    Kind::Group
                        | Kind::Image
                        | Kind::Row
                        | Kind::MenuOption { .. }
                        | Kind::SearchInput
                        | Kind::List { .. }
                )
                | (
                    Kind::Group,
                    Kind::Label
                        | Kind::Image
                        | Kind::Row
                        | Kind::Footer
                        | Kind::Disclosure { .. }
                        | Kind::SearchInput
                        | Kind::List { .. }
                )
                | (Kind::List { .. }, Kind::MenuOption { .. })
                | (Kind::Row, Kind::Subtitle)
                | (Kind::Disclosure { .. }, Kind::Label)
                | (Kind::Row, Kind::Label | Kind::Switch { .. } | Kind::Button)
                | (
                    Kind::Row,
                    Kind::Choices { .. } | Kind::Slider { .. } | Kind::Fields
                )
                | (Kind::Fields, Kind::Spin { .. })
                | (Kind::Choices { .. }, Kind::Choice { .. })
                | (Kind::Row, Kind::Dropdown { .. })
                | (Kind::Dropdown { .. }, Kind::DropdownOption { .. })
        );
        if !valid {
            return Err("invalid structural widget parent".into());
        }
        if matches!(kind, Kind::List { .. }) {
            return Err("use Tree::list to supply its required style".into());
        }
        if matches!(kind, Kind::MenuOption { selected: true })
            && p.children
                .iter()
                .any(|id| matches!(self.nodes[id].kind, Kind::MenuOption { selected: true }))
        {
            return Err("list already has a selected option".into());
        }
        if matches!(kind, Kind::Sidebar | Kind::TitleBar | Kind::Scroll)
            && p.children.iter().any(|id| self.nodes[id].kind == kind)
        {
            return Err("duplicate window region".into());
        }
        if (matches!(p.kind, Kind::Row | Kind::Group | Kind::Disclosure { .. })
            && matches!(kind, Kind::Label | Kind::Subtitle | Kind::Footer))
            && p.children.iter().any(|id| self.nodes[id].kind == kind)
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
        if matches!(kind, Kind::DropdownOption { selected: true })
            && p.children
                .iter()
                .any(|id| matches!(self.nodes[id].kind, Kind::DropdownOption { selected: true }))
        {
            return Err("dropdown already has a selected option".into());
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
            if matches!(
                n.kind,
                Kind::Sidebar | Kind::TitleBar | Kind::ControlCapsule
            ) {
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
        for search_id in self.searches.keys().copied().collect::<Vec<_>>() {
            if !self.available(search_id) {
                self.cancel_search_preedit(search_id)?;
            }
        }
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
            tree.searches.remove(&id);
            tree.images.remove(&id);
            tree.label_styles.remove(&id);
            tree.button_descriptions.remove(&id);
            tree.list_styles.remove(&id);
            tree.capsules.remove(&id);
            tree.capsule_styles.remove(&id);
            tree.capsule_washes.remove(&id);
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
    /// An explicit Label-only preview style, validated before replacing its layout.
    pub fn set_label_style(&mut self, id: NodeId, style: Option<TextStyle>) -> Result<()> {
        if self
            .nodes
            .get(&id)
            .is_none_or(|node| node.kind != Kind::Label)
        {
            return Err("preview style requires a label".into());
        }
        self.set_owned_text_style(id, style)
    }
    pub fn set_button_text_style(&mut self, id: NodeId, style: Option<TextStyle>) -> Result<()> {
        if self
            .nodes
            .get(&id)
            .is_none_or(|node| node.kind != Kind::Button)
        {
            return Err("caption style requires a live button".into());
        }
        self.set_owned_text_style(id, style)
    }
    fn set_owned_text_style(&mut self, id: NodeId, style: Option<TextStyle>) -> Result<()> {
        if let Some(style) = &style {
            style.validate(1.)?;
        }
        if let Some(style) = style {
            self.label_styles.insert(id, style);
        } else {
            self.label_styles.remove(&id);
        }
        self.nodes.get_mut(&id).unwrap().layout = None;
        self.invalidate(id, Invalid::LAYOUT);
        Ok(())
    }
    pub fn set_button_description(&mut self, id: NodeId, description: &str) -> Result<()> {
        if self
            .nodes
            .get(&id)
            .is_none_or(|node| node.kind != Kind::Button)
        {
            return Err("description requires a live button".into());
        }
        self.button_descriptions.insert(id, description.into());
        self.invalidate(id, Invalid::SEMANTICS);
        Ok(())
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
        if self.active != active {
            for id in self.searches.keys().copied().collect::<Vec<_>>() {
                self.invalidate(id, Invalid::PAINT);
            }
        }
        self.active = active;
        self.invalidate(self.root, Invalid::SEMANTICS);
    }
    pub fn dispatch(&mut self, target: Target, command: Command) -> Result<Effect> {
        if target.generation != self.generation
            || !self.available(target.id)
            || !(self.nodes[&target.id].kind.focusable()
                || (command == Command::Activate
                    && matches!(self.nodes[&target.id].kind, Kind::DropdownOption { .. })))
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
        self.focus_node(id)?;
        Ok(())
    }
    fn focus_node(&mut self, id: NodeId) -> Result<()> {
        if let Some(old) = self.focused {
            if old != id {
                self.cancel_search_preedit(old)?;
            }
            self.invalidate(old, Invalid::STATE);
        }
        self.focused = Some(id);
        self.invalidate(id, Invalid::STATE);
        self.reveal(id);
        Ok(())
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
            Kind::Disclosure { expanded } => self.set_expanded(id, !expanded)?,
            Kind::Choice { .. } => self.set_choice(id)?,
            // Space/Enter on a range control changes nothing; its keys and pointer do.
            Kind::Slider { .. } | Kind::Spin { .. } | Kind::SearchInput => return Ok(Effect::None),
            Kind::Page { .. } => {
                self.select_page(id)?;
                if self.narrow {
                    self.sidebar_request = Some(false);
                }
            }
            Kind::DropdownOption { .. } => {
                let parent = self.nodes[&id].parent.ok_or("orphan dropdown option")?;
                let changed = self.select_dropdown_option(id)?;
                return Ok(if changed {
                    Effect::Changed(parent)
                } else {
                    Effect::None
                });
            }
            Kind::MenuOption { .. }
                if self.nodes[&id]
                    .parent
                    .is_some_and(|p| matches!(self.nodes[&p].kind, Kind::List { .. })) =>
            {
                let parent = self.nodes[&id].parent.unwrap();
                let changed = !matches!(self.nodes[&id].kind, Kind::MenuOption { selected: true });
                self.set_list_selected(parent, Some(id))?;
                return Ok(if changed {
                    Effect::Changed(parent)
                } else {
                    Effect::None
                });
            }
            Kind::Dropdown { .. } | Kind::MenuOption { .. } => {}
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
        let hit = self.hit_test(point);
        if hit.is_some_and(|id| matches!(self.nodes[&id].kind, Kind::MenuOption { .. })) {
            self.set_focus_visible(false);
        }
        self.set_hovered(hit);
        if let Some(id) = self.capture {
            let _ = self.search_pointer(id, point, true);
        }
    }
    pub fn pointer_motion_in(&mut self, container: NodeId, local: Point) -> Result<()> {
        let id = self.hit_test_in(container, local)?;
        self.set_hovered(id);
        if let Some(id) = self.capture {
            let r = self.nodes[&container].bounds;
            self.search_pointer(
                id,
                Point {
                    x: r.x + local.x,
                    y: r.y + local.y,
                },
                true,
            )?;
        }
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
            self.search_pointer(id, p, false)?;
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
            self.focus_node(id)?;
            let r = self.nodes[&container].bounds;
            self.search_pointer(
                id,
                Point {
                    x: r.x + local.x,
                    y: r.y + local.y,
                },
                false,
            )?;
        }
        Ok(())
    }
    fn hit_test_in(&self, container: NodeId, local: Point) -> Result<Option<NodeId>> {
        let origin = self
            .nodes
            .get(&container)
            .ok_or("unknown input pane")?
            .bounds;
        if !matches!(
            self.nodes[&container].kind,
            Kind::Sidebar | Kind::TitleBar | Kind::ControlCapsule
        ) {
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
            if let Some(effect) = self.range_release(id, p)? {
                return Ok(effect);
            }
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
        if self.menu_style.is_none() && self.adapt_sidebar(size.width) {
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
        if matches!(kind, Kind::List { .. })
            || (self.menu_style.is_some() && kind == Kind::Scroll)
            || matches!(kind, Kind::MenuOption { .. })
        {
            return self.measure_menu(id, width, backend);
        }
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
        if matches!(kind, Kind::Dropdown { .. }) {
            return self.measure_dropdown(id, width, backend);
        }
        if let Kind::Choices { kind } = kind {
            return self.measure_choices(id, kind, width, backend);
        }
        if matches!(kind, Kind::Slider { .. } | Kind::Spin { .. } | Kind::Fields) {
            return self.measure_range(id, backend);
        }
        if kind == Kind::Image {
            return self.measure_image(id, width);
        }
        if kind == Kind::SearchInput {
            return self.measure_search(id, width, backend);
        }
        if kind == Kind::Button
            && let Some(capsule) = self.capsule_for_button(id)
        {
            let metrics = capsule.metrics;
            let n = self.nodes.get_mut(&id).unwrap();
            let caption = n.caption.as_deref().unwrap_or(&n.name);
            // Capsule captions occupy the exported glyph box, independently of body
            // typography; retain this same Layout for painting and geometry.
            let mut style = self.style.clone();
            style.size = metrics.button_min;
            style.line_height = 1.;
            let layout = backend.layout(caption, &style, width.max(1.))?;
            let text = layout.measured_size();
            n.measured = Size {
                width: metrics.button_min.max(text.width),
                height: metrics.button_min.max(text.height),
            };
            n.layout = Some(layout);
            return Ok(n.measured);
        }
        if kind == Kind::ControlCapsule {
            let metrics = self.capsules[&id].metrics;
            let mut count = 0;
            let mut sum = 0.;
            let mut height: f32 = 0.;
            for child in self.nodes[&id].children.clone() {
                let size = self.measure(child, width, backend)?;
                if self.is_hidden(child) {
                    continue;
                }
                count += 1;
                sum += size.width;
                height = height.max(size.height);
            }
            let size = Size {
                width: 2. * metrics.padding + sum + metrics.gap * (count as f32 - 1.).max(0.),
                height: metrics.height_min.max(2. * metrics.padding + height),
            };
            self.nodes.get_mut(&id).unwrap().measured = size;
            return Ok(size);
        }
        if matches!(kind, Kind::Row | Kind::Disclosure { .. }) {
            let children = self.nodes[&id].children.clone();
            let mut control_width: f32 = match kind {
                Kind::Disclosure { .. } => self.row_text()?.disclosure_icon_size,
                _ => 0.,
            };
            let mut height: f32 = 0.;
            for child in &children {
                if !self.is_hidden(*child) && self.nodes[child].kind.row_control() {
                    let size = self.measure(*child, (width / 2.).max(1.), backend)?;
                    control_width = control_width.max(size.width);
                    height = height.max(size.height);
                }
            }
            // The label and its second line, one above the other.
            let mut text: f32 = 0.;
            for child in &children {
                if !self.is_hidden(*child)
                    && matches!(self.nodes[child].kind, Kind::Label | Kind::Subtitle)
                {
                    let size = self.measure(
                        *child,
                        (width - control_width - 3. * m.padding).max(1.),
                        backend,
                    )?;
                    text += size.height;
                }
            }
            height = height.max(text);
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
            Kind::Page { .. } | Kind::Button | Kind::Dropdown { .. } => {
                (width - 2. * m.padding).max(1.)
            }
            _ => width,
        };
        let mut text = Size::default();
        if !self.nodes[&id].name.is_empty()
            && matches!(
                kind,
                Kind::Label
                    | Kind::Page { .. }
                    | Kind::Button
                    | Kind::Dropdown { .. }
                    | Kind::Subtitle
                    | Kind::Footer
            )
        {
            let mut style = self.label_styles.get(&id).unwrap_or(&self.style).clone();
            match kind {
                Kind::Subtitle => style.size *= self.row_text()?.subtitle_scale,
                Kind::Footer => style.size *= self.row_text()?.footer_scale,
                _ => {}
            }
            let n = self.nodes.get_mut(&id).unwrap();
            if let Some(layout) = &mut n.layout {
                text = layout.size(label_width)?;
            } else {
                let layout = backend.layout(&n.name, &style, label_width)?;
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
            if self.nodes[&child].kind == Kind::Footer {
                sum += (self.row_text()?.footer_gap - m.gap).max(0.);
            }
            sum += s.height + m.gap;
            max_h = max_h.max(s.height);
            max_w = max_w.max(s.width);
        }
        let size = match kind {
            Kind::MenuOption { .. } | Kind::List { .. } => unreachable!("list measured above"),
            Kind::DropdownOption { .. } => Size::default(),
            Kind::ControlCapsule => unreachable!("capsule measured above"),
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
            Kind::SearchInput | Kind::Image => unreachable!("measured above"),
            Kind::Button | Kind::Dropdown { .. } => Size {
                width: m.control.max(text.width + 2. * m.padding),
                height: m.control.max(text.height + 2. * m.padding),
            },
            Kind::Page { .. } => Size {
                width,
                height: m.row.max(text.height + 2. * m.padding),
            },
            Kind::Label | Kind::Subtitle | Kind::Footer => Size {
                width: text.width,
                height: text.height,
            },
            // Measured with their row (the Row branch above).
            Kind::Disclosure { .. } => self.nodes[&id].measured,
            // Measured with their group (measure_choices).
            Kind::Choices { .. }
            | Kind::Choice { .. }
            | Kind::Slider { .. }
            | Kind::Spin { .. }
            | Kind::Fields => self.nodes[&id].measured,
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
        if self.dialog_role {
            return false;
        }
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
        if let Some(s) = &self.menu_style {
            return Rect {
                x: s.border,
                y: s.border,
                width: (self.size.width - 2. * s.border).max(0.),
                height: (self.size.height - 2. * s.border).max(0.),
            };
        }
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
                Kind::ControlCapsule => {
                    let capsule = self.capsules[&child];
                    let size = self.nodes[&child].measured;
                    Rect {
                        x: capsule.position.x,
                        y: capsule.position.y,
                        width: size.width,
                        height: size.height,
                    }
                }
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
        if kind == Kind::Fields {
            self.place_fields(id, r);
            return;
        }
        let children = node.children.clone();
        if matches!(kind, Kind::List { .. }) || (kind == Kind::Scroll && self.menu_style.is_some())
        {
            self.place_menu(id, r);
            return;
        }
        if matches!(kind, Kind::Dropdown { .. }) {
            // The model's Selection children are not the popup's painted list.
            for child in children {
                self.place_node(child, Rect::default());
            }
            return;
        }
        let m = self.metrics;
        if kind == Kind::ControlCapsule {
            let metrics = self.capsules[&id].metrics;
            let mut x = r.x + metrics.padding;
            for child in children {
                if self.is_hidden(child) {
                    continue;
                }
                let size = self.nodes[&child].measured;
                self.place_node(
                    child,
                    Rect {
                        x,
                        y: r.y + (r.height - size.height) / 2.,
                        width: size.width,
                        height: size.height,
                    },
                );
                x += size.width + metrics.gap;
            }
            return;
        }
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
        // A row's label and second line, as one block centred in the row.
        let text_block: f32 = if matches!(kind, Kind::Row | Kind::Disclosure { .. }) {
            children
                .iter()
                .filter(|c| {
                    !self.is_hidden(**c)
                        && matches!(self.nodes[*c].kind, Kind::Label | Kind::Subtitle)
                })
                .map(|c| self.nodes[c].measured.height)
                .sum()
        } else {
            0.
        };
        let mut text_y = r.y + (r.height - text_block) / 2.;
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
            } else if matches!(kind, Kind::Row | Kind::Disclosure { .. }) {
                let control = n.kind.row_control();
                let y = if matches!(n.kind, Kind::Label | Kind::Subtitle) {
                    let y = text_y;
                    text_y += s.height;
                    y
                } else {
                    r.y + (r.height - s.height) / 2.
                };
                Rect {
                    x: if control {
                        r.x + r.width - m.padding - s.width
                    } else {
                        x
                    },
                    y,
                    width: s.width,
                    height: s.height,
                }
            } else {
                if n.kind == Kind::Footer
                    && let Some(style) = &self.row_text_style
                {
                    y += (style.footer_gap - m.gap).max(0.);
                }
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
            } else if !matches!(kind, Kind::Row | Kind::Disclosure { .. }) {
                y += s.height + m.gap;
            }
        }
    }
    pub fn scroll_to(&mut self, id: NodeId, offset: Point) -> Result<()> {
        if !offset.x.is_finite() || !offset.y.is_finite() {
            return Err("invalid scroll offset".into());
        }
        let viewport = if self
            .nodes
            .get(&id)
            .is_some_and(|n| matches!(n.kind, Kind::List { .. }))
        {
            self.list_viewport(id)
        } else if self.nodes.get(&id).is_some_and(|n| n.kind == Kind::Sidebar) {
            self.sidebar_viewport()
        } else {
            self.content_viewport()
        };
        let list_extent = self
            .list_styles
            .contains_key(&id)
            .then(|| self.list_extent(id));
        let n = self.nodes.get_mut(&id).ok_or("unknown scroll")?;
        if !matches!(n.kind, Kind::Scroll | Kind::Sidebar | Kind::List { .. }) {
            return Err("widget is not scrollable".into());
        }
        let max_y = (list_extent.unwrap_or(n.measured.height) - viewport.height).max(0.);
        // Horizontal content may be deliberately wider than the viewport. The
        // viewport width is excluded from the scrollable content extent.
        let max_x = if n.kind == Kind::Sidebar || matches!(n.kind, Kind::List { .. }) {
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
            if matches!(
                self.nodes[&p].kind,
                Kind::Scroll | Kind::Sidebar | Kind::List { .. }
            ) {
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
        let mut clip = self.outer_visible_clip(id);
        let mut current = Some(id);
        while let Some(p) = current {
            if matches!(self.nodes[&p].kind, Kind::List { .. }) {
                clip = intersect_rect(clip, self.list_viewport(p));
            }
            current = self.nodes[&p].parent;
        }
        clip
    }
    fn outer_visible_clip(&self, id: NodeId) -> Rect {
        if self.in_pane(id) {
            let mut current = Some(id);
            while let Some(p) = current {
                if self.nodes[&p].kind == Kind::Sidebar {
                    return self.sidebar_viewport();
                }
                if self.nodes[&p].kind == Kind::ControlCapsule {
                    let r = self.nodes[&p].bounds;
                    let x = r.x.max(0.);
                    let y = r.y.max(0.);
                    return Rect {
                        x,
                        y,
                        width: (r.x + r.width).min(self.size.width).max(x) - x,
                        height: (r.y + r.height).min(self.size.height).max(y) - y,
                    };
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

pub(crate) fn intersect_rect(a: Rect, b: Rect) -> Rect {
    let x = a.x.max(b.x);
    let y = a.y.max(b.y);
    Rect {
        x,
        y,
        width: ((a.x + a.width).min(b.x + b.width) - x).max(0.),
        height: ((a.y + a.height).min(b.y + b.height) - y).max(0.),
    }
}
