// SPDX-License-Identifier: LGPL-3.0-or-later
//! Retained Settings chrome. The host remains nk-wayland; page rendering and routing stay
//! in their existing modules. All geometry and labels are inputs, never look defaults.
use crate::{exports::Exports, styles::Styles};
use nk_text::{FontSet, ParleyBackend, Point, Rect, Size, TextBackend, TextStyle};
use nk_wayland::{ControlsSide, Window, WindowAction};
use nk_widgets::{Effect, Kind, NodeId, PageWidth, Result, Tree};
use std::collections::HashMap;
use std::sync::Arc;

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
    selected_page: Option<NodeId>,
    controls_inset: f32,
    header: crate::header::Style,
    navigation: NodeId,
    navigation_buttons: [NodeId; 2],
    toggle: NodeId,
    search_panel: NodeId,
    pub search: NodeId,
    history: Vec<String>,
    history_at: usize,
    history_target: Option<usize>,
    title_style: TextStyle,
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
        fonts: Arc<FontSet>,
    ) -> Result<Self> {
        let page = exports
            .page(selected)
            .ok_or("unknown initial Settings page")?;
        let mut tree = Tree::new(labels.application, styles.metrics, styles.text.clone())?;
        styles.apply(&mut tree)?;
        tree.set_page_width(PageWidth::Form)?;
        tree.set_sidebar_frame(styles.header.inset, styles.header.sidebar_radius)?;
        tree.set_content_top_gap(styles.header.content_gap)?;
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
        let header = &styles.header;
        let solo = nk_widgets::CapsuleMetrics {
            padding: 0.,
            gap: 0.,
            button_min: header.button,
            height_min: header.button,
        };
        let toggle = tree.control_capsule(labels.sidebar_button, Point::default(), solo)?;
        let toggle_button = tree.capsule_button(toggle, labels.sidebar_button, " ", false)?;
        tree.set_button_icon(toggle_button, "nd-sidebar-show", header.icon)?;
        tree.set_sidebar_toggle(toggle_button)?;
        let navigation =
            tree.control_capsule(labels.sidebar, Point::default(), header.navigation)?;
        // Vector icons from the interface theme, as the toggle's: a font character's shape,
        // weight and centring were the font's.
        let navigation_buttons = [
            tree.capsule_button(navigation, exports.text("settings.nav.back")?, " ", false)?,
            tree.capsule_button(
                navigation,
                exports.text("settings.nav.forward")?,
                " ",
                false,
            )?,
        ];
        for (button, icon) in navigation_buttons
            .into_iter()
            .zip(["nd-pan-start", "nd-pan-end"])
        {
            tree.set_button_icon(button, icon, header.nav_icon)?;
            tree.set_disabled(button, true)?;
        }
        let placeholder = exports.text("settings.search.placeholder")?;
        let search_panel = tree.control_capsule(placeholder, Point::default(), solo)?;
        let mut text = styles.text.clone();
        text.size = header.search_size * styles.text_scale as f32;
        let search = tree.search_input_styled(
            search_panel,
            placeholder,
            placeholder,
            Box::new(ParleyBackend::with_system_fonts(fonts)?),
            text,
        )?;
        tree.set_width(search, header.search_width)?;
        let controls = tree.control_capsule(labels.controls, Point::default(), metrics)?;
        let buttons = [
            tree.capsule_button(
                controls,
                labels.minimize,
                nk_widgets::WindowGlyph::Minimize,
                false,
            )?,
            tree.capsule_button(
                controls,
                labels.maximize,
                nk_widgets::WindowGlyph::Maximize,
                false,
            )?,
            tree.capsule_button(controls, labels.close, nk_widgets::WindowGlyph::Close, true)?,
        ];
        tree.window_controls_capsule(controls)?;
        let content = tree.append(root, Kind::Scroll, labels.content)?;
        let mut composition = nk_widgets::window::Composition::default();
        composition.set_titlebar_style(header.titlebar.clone())?;
        composition.set_titlebar_double_click_ms(header.double_click_ms)?;
        let mut shell = Self {
            tree,
            sidebar,
            titlebar,
            content,
            controls,
            composition,
            capsules: Default::default(),
            pages,
            buttons,
            selected_page: Some(selected_page),
            controls_inset: styles.controls_inset,
            header: header.clone(),
            navigation,
            navigation_buttons,
            toggle,
            search_panel,
            search,
            history: vec![selected.to_owned()],
            history_at: 0,
            history_target: None,
            title_style: styles.text.clone(),
        };
        shell.restyle(styles)?;
        Ok(shell)
    }

    /// The Router decides what can be drawn. A sidebar click alone does not change pages.
    pub fn action(&mut self, effect: Effect) -> Result<Action> {
        let Effect::Activated(id) = effect else {
            return Ok(Action::None);
        };
        if let Some(direction) = self.navigation_buttons.iter().position(|b| *b == id) {
            let target = if direction == 0 {
                self.history_at.checked_sub(1)
            } else {
                (self.history_at + 1 < self.history.len()).then_some(self.history_at + 1)
            };
            if let Some(target) = target {
                self.history_target = Some(target);
                return Ok(Action::Page(self.history[target].clone()));
            }
        }
        if let Some(page) = self.pages.get(&id) {
            let page = page.clone();
            if let Some(selected) = self.selected_page {
                self.tree.select_page(selected)?;
            } else {
                self.tree.clear_page_selection(self.sidebar)?;
            }
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
        self.selected_page = Some(id);
        self.remember(page)
    }
    pub fn selected_results(&mut self, title: &str) -> Result<()> {
        self.tree.set_name(self.titlebar, title)?;
        self.tree.clear_page_selection(self.sidebar)?;
        self.selected_page = None;
        self.remember("search-results")
    }
    fn remember(&mut self, page: &str) -> Result<()> {
        if self.history.is_empty() {
            self.history.push(page.to_owned());
        }
        if let Some(target) = self
            .history_target
            .take()
            .filter(|at| self.history[*at] == page)
        {
            self.history_at = target;
        } else if self.history[self.history_at] != page {
            self.history.truncate(self.history_at + 1);
            self.history.push(page.to_owned());
            self.history_at = self.history.len() - 1;
        }
        self.tree
            .set_disabled(self.navigation_buttons[0], self.history_at == 0)?;
        self.tree.set_disabled(
            self.navigation_buttons[1],
            self.history_at + 1 == self.history.len(),
        )?;
        self.composition.invalidate_panes();
        Ok(())
    }

    pub fn restyle(&mut self, styles: &Styles) -> Result<()> {
        self.tree.set_window_glyph_style(styles.window_glyph)?;
        self.header = styles.header.clone();
        self.controls_inset = styles.controls_inset;
        self.title_style = styles.text.clone();
        self.title_style.size = self.header.title_size * styles.text_scale as f32;
        self.title_style.weight = self.header.title_weight;
        self.tree
            .set_sidebar_frame(self.header.inset, self.header.sidebar_radius)?;
        self.tree.set_content_top_gap(self.header.content_gap)?;
        let mut search = styles.search.clone();
        search.padding_x = self.header.search_padding;
        search.min_height = self.header.button;
        self.tree.set_search_style(search)?;
        let mut text = styles.text.clone();
        text.size = self.header.search_size * styles.text_scale as f32;
        self.tree.set_search_text_style(self.search, text)?;
        self.composition
            .set_titlebar_style(self.header.titlebar.clone())?;
        self.composition
            .set_titlebar_double_click_ms(self.header.double_click_ms)?;
        Ok(())
    }
    pub fn layout_controls(
        &mut self,
        size: Size,
        side: ControlsSide,
        layered: bool,
        backend: &mut impl TextBackend,
    ) -> Result<()> {
        let placement = self.placement(side);
        placement.arrange(&mut self.tree, size, layered, backend)
    }
    fn placement(&self, side: ControlsSide) -> Placement {
        Placement {
            header: self.header.clone(),
            title_style: self.title_style.clone(),
            side,
            controls_inset: self.controls_inset,
            controls: self.controls,
            nav: self.navigation,
            toggle: self.toggle,
            search_panel: self.search_panel,
            search: self.search,
        }
    }

    /// Stage the independent D7 panes and capsule on the existing host. In D5 the same
    /// retained tree paints opaque chrome and clips content at its insets.
    pub fn sync(
        &mut self,
        window: &mut Window,
        backend: &mut impl TextBackend,
        look: Look<'_>,
    ) -> Result<()> {
        let placement = self.placement(look.controls_side);
        self.composition.sync_with_layout(
            &mut self.tree,
            window,
            backend,
            look.styles.palette,
            |side| look.panel.at(side),
            look.layers_allowed,
            |tree, size, layered, backend| placement.arrange(tree, size, layered, backend),
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
        )?;
        self.composition
            .set_search_layers(self.capsules.search_layers(&self.tree));
        self.composition.sync_search_input(&self.tree, window)
    }

    /// Capsule input and ordinary window input use their shared toolkit dispatchers.
    pub fn event(&mut self, event: &nk_wayland::Event, window: &mut Window) -> Result<Effect> {
        if matches!(event, nk_wayland::Event::Key(key) if key.ctrl && !key.alt && matches!(key.sym, 0x66 | 0x46))
            && self.tree.showing(self.search)
        {
            self.tree.focus(self.search)?;
            return Ok(Effect::Focused(self.search));
        }
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

struct Placement {
    header: crate::header::Style,
    title_style: TextStyle,
    side: ControlsSide,
    controls_inset: f32,
    controls: NodeId,
    nav: NodeId,
    toggle: NodeId,
    search_panel: NodeId,
    search: NodeId,
}
impl Placement {
    fn arrange(
        &self,
        tree: &mut Tree,
        size: Size,
        layered: bool,
        backend: &mut impl TextBackend,
    ) -> Result<()> {
        let h = &self.header;
        let m = tree.capsule_metrics(self.controls)?;
        let server = tree.server_controls_layout();
        let side = server.map_or(self.side, |layout| layout.side);
        let cw = server.map_or(2. * m.padding + 3. * m.button_min + 2. * m.gap, |layout| {
            layout.width as f32
        });
        let cy = server.map_or(self.controls_inset, |layout| {
            ((h.band - layout.height as f32) / 2.).max(0.)
        });
        let cx = if side == ControlsSide::Left {
            self.controls_inset
        } else {
            (size.width - self.controls_inset - cw).max(0.)
        };
        tree.set_capsule_position(self.controls, Point { x: cx, y: cy })?;
        let leading = tree.content_viewport().x;
        let tx = if side == ControlsSide::Left {
            cx + cw + h.search_gap
        } else {
            h.inset
        };
        tree.set_capsule_position(self.toggle, Point { x: tx, y: h.inset })?;
        let nx = (leading + h.inset).max(tx + h.button + h.inset);
        tree.set_capsule_position(self.nav, Point { x: nx, y: h.inset })?;
        let nw = 2. * h.navigation.padding + 2. * h.navigation.button_min + h.navigation.gap;
        let title = nx + nw + h.title_gap;
        let right = if side == ControlsSide::Right {
            cx - h.search_gap
        } else {
            size.width - h.inset
        };
        let sx = right - h.search_width;
        let visible = sx > title + h.button;
        tree.set_hidden(self.search_panel, !visible)?;
        tree.set_capsule_position(
            self.search_panel,
            Point {
                x: sx.max(0.),
                y: h.inset,
            },
        )?;
        tree.set_width(self.search, h.search_width)?;
        let end = if visible { sx - h.search_gap } else { right };
        tree.set_title_text_box(nk_widgets::TitleTextBox {
            bounds: Rect {
                x: (title - leading).max(0.),
                y: 0.,
                width: (end - title).max(0.),
                height: h.band,
            },
            style: self.title_style.clone(),
        })?;
        tree.layout(size, layered, backend)
    }
}
