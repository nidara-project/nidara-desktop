// SPDX-License-Identifier: LGPL-3.0-or-later
//! Retained Settings chrome. The host remains nk-wayland; page rendering and routing stay
//! in their existing modules. All geometry and labels are inputs, never look defaults.
use crate::{exports::Exports, styles::Styles};
use nk_text::{Point, Size, TextBackend};
use nk_wayland::{ControlsSide, Window, WindowAction};
use nk_widgets::{Effect, Kind, NodeId, PageWidth, Result, Tree};
use std::collections::HashMap;

pub struct Labels<'a> {
    pub application: &'a str,
    pub sidebar: &'a str,
    pub sidebar_button: &'a str,
    pub content: &'a str,
    pub controls: &'a str,
    pub minimize: &'a str,
    pub maximize: &'a str,
    pub close: &'a str,
}

#[derive(Debug)]
pub enum Action {
    None,
    Page(String),
    Window(WindowAction),
}

pub struct Shell {
    pub tree: Tree,
    pub sidebar: NodeId,
    pub titlebar: NodeId,
    pub content: NodeId,
    pub controls: NodeId,
    pub composition: nk_widgets::window::Composition,
    pub capsules: nk_widgets::capsule_composition::CapsuleComposition,
    pages: HashMap<NodeId, String>,
    buttons: [NodeId; 3],
    selected_page: NodeId,
}

/// One coherent portal-selected look. Recipes are the shared exact export readers.
pub struct Look<'a> {
    pub styles: &'a Styles,
    pub panel: &'a crate::material::panel::PanelMaterial,
    pub control: &'a crate::material::control::ControlRecipe,
    pub opaque_control: &'a crate::material::control::ControlRecipe,
    pub reduced_motion: bool,
    pub controls_side: ControlsSide,
    pub layers_allowed: bool,
}

impl Shell {
    pub fn build(
        exports: &Exports,
        styles: &Styles,
        labels: Labels<'_>,
        metrics: nk_widgets::CapsuleMetrics,
        selected: &str,
    ) -> Result<Self> {
        let page = exports
            .page(selected)
            .ok_or("unknown initial Settings page")?;
        let mut tree = Tree::new(labels.application, styles.metrics, styles.text.clone())?;
        styles.apply(&mut tree)?;
        tree.set_page_width(PageWidth::Form)?;
        tree.set_sidebar_frame(styles.metrics.padding, styles.metrics.group_radius)?;
        let root = tree.root();
        let sidebar = tree.append(root, Kind::Sidebar, labels.sidebar)?;
        let mut pages = HashMap::new();
        for p in exports.pages.iter().filter(|p| p.parent.is_none()) {
            let id = tree.append(
                sidebar,
                Kind::Page {
                    selected: p.id == selected,
                },
                exports.text(&p.label)?,
            )?;
            pages.insert(id, p.id.clone());
        }
        let selected_page = pages
            .iter()
            .find(|(_, page)| page.as_str() == selected)
            .map(|(id, _)| *id)
            .ok_or("initial page has no sidebar entry")?;
        let titlebar = tree.append(root, Kind::TitleBar, exports.text(&page.label)?)?;
        tree.sidebar_button(titlebar, labels.sidebar_button)?;
        let controls = tree.control_capsule(labels.controls, Point::default(), metrics)?;
        let buttons = [
            tree.capsule_button(controls, labels.minimize, "−", false)?,
            tree.capsule_button(controls, labels.maximize, "□", false)?,
            tree.capsule_button(controls, labels.close, "×", true)?,
        ];
        let content = tree.append(root, Kind::Scroll, labels.content)?;
        Ok(Self {
            tree,
            sidebar,
            titlebar,
            content,
            controls,
            composition: Default::default(),
            capsules: Default::default(),
            pages,
            buttons,
            selected_page,
        })
    }

    /// The Router decides what can be drawn. A sidebar click alone does not change pages.
    pub fn action(&mut self, effect: Effect) -> Result<Action> {
        let Effect::Activated(id) = effect else {
            return Ok(Action::None);
        };
        if let Some(page) = self.pages.get(&id) {
            let page = page.clone();
            self.tree.select_page(self.selected_page)?;
            return Ok(Action::Page(page));
        }
        Ok(match self.buttons.iter().position(|button| *button == id) {
            Some(0) => Action::Window(WindowAction::Minimize),
            Some(1) => Action::Window(WindowAction::ToggleMaximize),
            Some(2) => Action::Window(WindowAction::Close),
            _ => Action::None,
        })
    }

    /// Only after routing and mounting succeeded: keep selection/title coherent with content.
    pub fn selected(&mut self, exports: &Exports, page: &str) -> Result<()> {
        let p = exports.page(page).ok_or("unknown Settings page")?;
        let id = self
            .pages
            .iter()
            .find(|(_, name)| name.as_str() == page)
            .map(|(id, _)| *id)
            .ok_or("page has no sidebar entry")?;
        let title = exports.text(&p.label)?;
        self.tree.set_name(self.titlebar, title)?;
        self.tree.select_page(id)?;
        self.selected_page = id;
        self.composition.invalidate_panes();
        Ok(())
    }

    /// Place the one retained control capsule, then lay out before the synchronized commit.
    pub fn layout_controls(
        &mut self,
        size: Size,
        side: ControlsSide,
        metrics: nk_widgets::Metrics,
        layered: bool,
        backend: &mut impl TextBackend,
    ) -> Result<()> {
        self.tree.layout(size, layered, backend)?;
        let width = self
            .tree
            .node(self.controls)
            .ok_or("missing controls capsule")?
            .bounds()
            .width;
        let x = match side {
            ControlsSide::Left => metrics.padding,
            ControlsSide::Right => (size.width - metrics.padding - width).max(0.),
        };
        self.tree
            .set_capsule_position(self.controls, Point { x, y: metrics.gap })?;
        self.tree.layout(size, layered, backend)
    }

    /// Stage the independent D7 panes and capsule on the existing host. In D5 the same
    /// retained tree paints opaque chrome and clips content at its insets.
    pub fn sync(
        &mut self,
        window: &mut Window,
        backend: &mut impl TextBackend,
        look: Look<'_>,
    ) -> Result<()> {
        self.composition.sync(
            &mut self.tree,
            window,
            backend,
            look.styles.palette,
            |side| look.panel.at(side),
            look.layers_allowed,
        )?;
        self.layout_controls(
            Size {
                width: window.size().0 as f32,
                height: window.size().1 as f32,
            },
            look.controls_side,
            look.styles.metrics,
            look.layers_allowed && window.capabilities().layers,
            backend,
        )?;
        self.capsules.sync(
            &mut self.tree,
            window,
            look.styles.palette,
            |side, material| {
                if material {
                    look.control.at(side)
                } else {
                    look.opaque_control.at(side)
                }
            },
            look.reduced_motion,
        )
    }

    /// Capsule input and ordinary window input use their shared toolkit dispatchers.
    pub fn event(&mut self, event: &nk_wayland::Event, window: &mut Window) -> Result<Effect> {
        if let Some(effect) = self.capsules.event(&mut self.tree, event)? {
            Ok(effect)
        } else {
            self.composition
                .event_with_window(&mut self.tree, event, window)
        }
    }

    pub fn paint(&self, frame: nk_wayland::Frame, styles: &Styles) -> Result<Vec<u8>> {
        self.tree
            .paint(frame, nk_widgets::Surface::Content, styles.palette)
    }

    pub fn dispatch_window_action(action: Action, window: &mut Window) -> Option<String> {
        match action {
            Action::Window(action) => {
                window.window_action(action);
                None
            }
            Action::Page(page) => Some(page),
            Action::None => None,
        }
    }
}
