// SPDX-License-Identifier: LGPL-3.0-or-later
//! Action rows and scroll affordances share the retained tree with their semantics.
use crate::*;
use std::sync::Arc;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MenuActionKind {
    Action,
    Check(bool),
    Radio(bool),
    Submenu { expanded: bool },
    Separator,
}
#[derive(Clone)]
pub enum MenuIcon {
    Vector(nk_icons::Icon),
    Raster(Arc<nk_render::Raster>),
}
#[derive(Clone)]
pub struct ActionMenuRow {
    pub label: String,
    pub kind: MenuActionKind,
    pub enabled: bool,
    pub icon: Option<MenuIcon>,
}
#[derive(Clone)]
pub struct ActionMenuStyle {
    pub row: MenuStyle,
    pub band_height: f32,
    pub up: nk_icons::Icon,
    pub down: nk_icons::Icon,
    pub submenu: nk_icons::Icon,
}
pub(crate) struct ActionMenu {
    pub rows: BTreeMap<NodeId, ActionMenuRow>,
    pub scroll: NodeId,
    pub bands: [NodeId; 2],
    pub style: ActionMenuStyle,
}
impl Tree {
    pub fn action_menu(
        title: &str,
        metrics: Metrics,
        text: TextStyle,
        style: ActionMenuStyle,
        rows: &[ActionMenuRow],
        band_names: [&str; 2],
    ) -> Result<(Self, Vec<NodeId>)> {
        Self::action_menu_at(title, metrics, text, style, rows, band_names, 1)
    }
    fn action_menu_at(
        title: &str,
        metrics: Metrics,
        text: TextStyle,
        style: ActionMenuStyle,
        rows: &[ActionMenuRow],
        band_names: [&str; 2],
        first: NodeId,
    ) -> Result<(Self, Vec<NodeId>)> {
        style.row.validate()?;
        if !style.band_height.is_finite() || style.band_height <= 0. {
            return Err("invalid menu scroll band".into());
        }
        if rows.len() > 4096 {
            return Err("menu row limit".into());
        }
        let mut tree = Self::new_at(title, metrics, text, first)?;
        tree.menu_style = Some(style.row.clone());
        tree.leading = 0.;
        tree.sidebar_open = false;
        let scroll = tree.append(tree.root(), Kind::Scroll, title)?;
        let mut values = BTreeMap::new();
        let mut ids = Vec::new();
        for row in rows {
            let kind = if row.kind == MenuActionKind::Separator {
                Kind::Label
            } else {
                Kind::Button
            };
            let id = tree.allocate(Some(scroll), kind, row.label.clone());
            tree.nodes.get_mut(&id).unwrap().disabled = !row.enabled;
            values.insert(id, row.clone());
            ids.push(id);
        }
        let bands =
            band_names.map(|name| tree.allocate(Some(tree.root()), Kind::Button, name.into()));
        tree.action_menu = Some(ActionMenu {
            rows: values,
            scroll,
            bands,
            style,
        });
        Ok((tree, ids))
    }
    /// Reserve IDs from the owning window so popup semantics can share its provider.
    pub fn action_menu_child(
        &mut self,
        title: &str,
        style: ActionMenuStyle,
        rows: &[ActionMenuRow],
        band_names: [&str; 2],
    ) -> Result<(Self, Vec<NodeId>)> {
        if self.action_menu.is_some() {
            return Err("allocate popup IDs from the owning parent window".into());
        }
        let (tree, ids) = Self::action_menu_at(
            title,
            self.metrics,
            self.style.clone(),
            style,
            rows,
            band_names,
            self.next,
        )?;
        self.next = tree.next;
        Ok((tree, ids))
    }
    /// Updating a leading icon does not change the permanently reserved gutter.
    pub fn set_menu_icon(&mut self, id: NodeId, icon: Option<MenuIcon>) -> Result<()> {
        self.action_menu
            .as_mut()
            .and_then(|m| m.rows.get_mut(&id))
            .ok_or("not an action menu row")?
            .icon = icon;
        self.invalidate(id, Invalid::PAINT);
        Ok(())
    }
    pub fn set_action_menu_style(&mut self, style: ActionMenuStyle) -> Result<()> {
        style.row.validate()?;
        if !style.band_height.is_finite() || style.band_height <= 0. {
            return Err("invalid menu band height".into());
        }
        let menu = self.action_menu.as_mut().ok_or("not an action menu")?;
        self.menu_style = Some(style.row.clone());
        menu.style = style;
        self.invalidate(self.root, Invalid::LAYOUT);
        Ok(())
    }
    pub fn menu_scroll_bands(&self) -> Option<[NodeId; 2]> {
        self.action_menu.as_ref().map(|m| m.bands)
    }
    pub fn menu_action_kind(&self, id: NodeId) -> Option<MenuActionKind> {
        self.action_menu.as_ref()?.rows.get(&id).map(|r| r.kind)
    }
    /// Controlled state update: activating a check/radio never edits the remote model.
    pub fn set_menu_action_kind(&mut self, id: NodeId, kind: MenuActionKind) -> Result<()> {
        let row = self
            .action_menu
            .as_mut()
            .and_then(|m| m.rows.get_mut(&id))
            .ok_or("not an action row")?;
        if (row.kind == MenuActionKind::Separator) != (kind == MenuActionKind::Separator) {
            return Err("rebuild a separator as a new row".into());
        }
        if std::mem::discriminant(&row.kind) != std::mem::discriminant(&kind)
            && !matches!(
                (row.kind, kind),
                (MenuActionKind::Action, MenuActionKind::Submenu { .. })
                    | (MenuActionKind::Submenu { .. }, MenuActionKind::Action)
            )
        {
            return Err("menu role changes need a new row identity".into());
        }
        if row.kind == kind {
            return Ok(());
        }
        row.kind = kind;
        self.invalidate(id, Invalid::STATE);
        Ok(())
    }
    pub(crate) fn action_row(&self, id: NodeId) -> bool {
        self.action_menu
            .as_ref()
            .is_some_and(|m| m.rows.contains_key(&id))
    }
    pub(crate) fn action_band(&self, id: NodeId) -> bool {
        self.action_menu
            .as_ref()
            .is_some_and(|m| m.bands.contains(&id))
    }
    pub(crate) fn menu_band_height(&self) -> f32 {
        let Some(m) = &self.action_menu else {
            return 0.;
        };
        let border = m.style.row.border;
        let h = (self.size.height - 2. * border).max(0.);
        if self.nodes[&m.scroll].measured.height <= h {
            0.
        } else {
            m.style.band_height.min(((h - 1.) / 2.).max(0.))
        }
    }
    pub(crate) fn place_action_bands(&mut self) {
        let Some(m) = &self.action_menu else { return };
        let bands = m.bands;
        let scroll = m.scroll;
        let border = m.style.row.border;
        let h = self.menu_band_height();
        let max = (self.nodes[&scroll].measured.height - self.content_viewport().height).max(0.);
        let offset = self.nodes[&scroll].scroll.y;
        for (at, id) in bands.into_iter().enumerate() {
            let hidden = h == 0. || (if at == 0 { offset <= 0. } else { offset >= max });
            let n = self.nodes.get_mut(&id).unwrap();
            n.bounds = Rect {
                x: border,
                y: if at == 0 {
                    border
                } else {
                    self.size.height - border - h
                },
                width: (self.size.width - 2. * border).max(0.),
                height: h,
            };
            if n.hidden != hidden {
                n.hidden = hidden;
                self.invalid.paint = true;
                self.invalid.semantics = true;
            }
            if hidden && self.focused == Some(id) {
                self.focused = None;
            }
        }
    }
    pub(crate) fn activate_menu_band(&mut self, id: NodeId) -> Result<bool> {
        let Some(m) = &self.action_menu else {
            return Ok(false);
        };
        let Some(at) = m.bands.iter().position(|n| *n == id) else {
            return Ok(false);
        };
        let scroll = m.scroll;
        let old = self.nodes[&scroll].scroll;
        let delta = self.content_viewport().height;
        self.set_hovered(None);
        self.scroll_to(
            scroll,
            Point {
                x: 0.,
                y: old.y + if at == 0 { -delta } else { delta },
            },
        )?;
        Ok(true)
    }
    pub(crate) fn action_menu_key(&mut self, sym: u32) -> Result<Option<Effect>> {
        let Some(m) = &self.action_menu else {
            return Ok(None);
        };
        if !matches!(sym, 0xff52 | 0xff54 | 0xff50 | 0xff57 | 0xff55 | 0xff56) {
            return Ok(None);
        }
        let ids = self.nodes[&m.scroll]
            .children
            .iter()
            .copied()
            .filter(|id| self.available(*id))
            .collect::<Vec<_>>();
        if ids.is_empty() {
            return Ok(Some(Effect::None));
        }
        let at = self
            .focused
            .and_then(|id| ids.iter().position(|n| *n == id))
            .unwrap_or(0);
        let last = ids.len() - 1;
        let next = match sym {
            0xff50 => 0,
            0xff57 => last,
            0xff52 => at.saturating_sub(1),
            0xff54 => (at + 1).min(last),
            _ => {
                let y = self.nodes[&ids[at]].bounds.y;
                let page = self.content_viewport().height;
                if sym == 0xff55 {
                    (0..at)
                        .rev()
                        .find(|n| self.nodes[&ids[*n]].bounds.y <= y - page)
                        .unwrap_or(0)
                } else {
                    ((at + 1)..=last)
                        .find(|n| self.nodes[&ids[*n]].bounds.y >= y + page)
                        .unwrap_or(last)
                }
            }
        };
        self.set_hovered(None);
        self.set_focus_visible(true);
        self.focus(ids[next])?;
        Ok(Some(Effect::Focused(ids[next])))
    }
    pub(crate) fn paint_action_bands(&self, canvas: &mut nk_render::Canvas) -> Result<()> {
        let Some(m) = &self.action_menu else {
            return Ok(());
        };
        for (at, id) in m.bands.into_iter().enumerate() {
            let n = &self.nodes[&id];
            if n.hidden {
                continue;
            }
            let highlighted =
                self.hovered == Some(id) || (self.focus_visible && self.focused == Some(id));
            let style = &m.style.row;
            if highlighted {
                canvas.rounded_rect(n.bounds, style.row_radius as f64, style.accent);
            }
            let size = style.check_size.min(n.bounds.height).min(n.bounds.width);
            canvas.icon(
                if at == 0 { &m.style.up } else { &m.style.down },
                Rect {
                    x: n.bounds.x + (n.bounds.width - size) / 2.,
                    y: n.bounds.y + (n.bounds.height - size) / 2.,
                    width: size,
                    height: size,
                },
                if highlighted {
                    style.accent_text
                } else {
                    style.text
                },
            );
        }
        Ok(())
    }
}

/// Compose retained action menus into the real parent's provider. No second
/// accessibility window or fabricated global position is introduced.
pub fn action_menu_snapshot(parent: &Tree, menus: &[(&Tree, Point)]) -> Result<PopupSnapshot> {
    let mut semantic = parent.semantics();
    if menus.is_empty() {
        return PopupSnapshot::new(semantic);
    }
    for node in semantic.nodes.values_mut() {
        node.actions.clear();
        node.states.focused = false;
    }
    for (level, (menu, origin)) in menus.iter().enumerate() {
        if menu.action_menu.is_none() || !origin.x.is_finite() || !origin.y.is_finite() {
            return Err("invalid action menu projection".into());
        }
        if semantic.nodes.contains_key(&menu.root) {
            return Err("popup root overlaps the parent namespace".into());
        }
        let tree = menu.semantics();
        let children = tree.nodes[&tree.root].children.clone();
        semantic
            .nodes
            .get_mut(&semantic.root)
            .unwrap()
            .children
            .extend(children);
        for (id, mut node) in tree.nodes {
            if id == tree.root {
                continue;
            }
            node.bounds.x += origin.x as f64;
            node.bounds.y += origin.y as f64;
            if level + 1 != menus.len() {
                node.states.focused = false;
            }
            if semantic.nodes.insert(id, node).is_some() {
                return Err("popup IDs overlap; allocate with action_menu_child".into());
            }
        }
    }
    PopupSnapshot::new(semantic)
}
