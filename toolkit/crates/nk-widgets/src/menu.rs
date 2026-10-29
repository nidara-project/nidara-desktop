// SPDX-License-Identifier: LGPL-3.0-or-later
//! Shared retained popup/embedded list rows: chosen state and independent hover/focus.
use crate::*;
use nk_render::{Canvas, Color};

#[derive(Clone, Debug)]
pub struct MenuStyle {
    pub border: f32,
    pub radius: f32,
    pub inset: f32,
    pub padding_x: f32,
    pub padding_y: f32,
    pub row_radius: f32,
    pub text_scale: f32,
    pub weight: f32,
    pub check_size: f32,
    pub check_gap: f32,
    pub check_stroke: f32,
    pub background: Color,
    pub border_color: Color,
    pub text: Color,
    pub accent: Color,
    pub accent_text: Color,
    pub pressed_black: f32,
}
impl MenuStyle {
    pub(crate) fn validate(&self) -> Result<()> {
        if ![
            self.border,
            self.radius,
            self.inset,
            self.padding_x,
            self.padding_y,
            self.row_radius,
            self.check_gap,
        ]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.)
            || ![
                self.text_scale,
                self.check_size,
                self.check_stroke,
                self.weight,
            ]
            .iter()
            .all(|v| v.is_finite() && *v > 0.)
            || !self.pressed_black.is_finite()
            || !(0. ..=1.).contains(&self.pressed_black)
            || ![
                self.background,
                self.border_color,
                self.text,
                self.accent,
                self.accent_text,
            ]
            .iter()
            .all(|c| {
                c.components.iter().all(|v| v.is_finite()) && (0. ..=1.).contains(&c.components[3])
            })
        {
            return Err("invalid menu style".into());
        }
        Ok(())
    }
}
impl Tree {
    /// Embed the existing menu rows in a bounded single-selection LIST.
    pub fn list(
        &mut self,
        parent: NodeId,
        name: &str,
        height: f32,
        style: MenuStyle,
    ) -> Result<NodeId> {
        style.validate()?;
        if !height.is_finite() || height <= 0. {
            return Err("invalid list viewport height".into());
        }
        if !self
            .nodes
            .get(&parent)
            .is_some_and(|node| matches!(node.kind, Kind::Scroll | Kind::Group))
        {
            return Err("list needs a Scroll or Group parent".into());
        }
        let id = self.allocate(Some(parent), Kind::List { height }, name.into());
        self.list_styles.insert(id, style);
        Ok(id)
    }
    pub fn set_list_height(&mut self, id: NodeId, height: f32) -> Result<()> {
        if !height.is_finite() || height <= 0. {
            return Err("invalid list viewport height".into());
        }
        if !self.list_styles.contains_key(&id) {
            return Err("not an embedded list".into());
        }
        self.nodes.get_mut(&id).unwrap().kind = Kind::List { height };
        self.invalidate(id, Invalid::LAYOUT);
        Ok(())
    }
    pub fn set_list_style(&mut self, id: NodeId, style: MenuStyle) -> Result<()> {
        style.validate()?;
        let slot = self
            .list_styles
            .get_mut(&id)
            .ok_or("not an embedded list")?;
        *slot = style;
        self.invalidate(id, Invalid::LAYOUT);
        Ok(())
    }
    /// Canonical selection: no user effect; validate before mutating any row.
    pub fn set_list_selected(&mut self, list: NodeId, selected: Option<NodeId>) -> Result<()> {
        if !self.list_styles.contains_key(&list) {
            return Err("not an embedded list".into());
        }
        if selected.is_some_and(|id| !self.nodes[&list].children.contains(&id)) {
            return Err("selection is not a list child".into());
        }
        for id in self.nodes[&list].children.clone() {
            self.nodes.get_mut(&id).unwrap().kind = Kind::MenuOption {
                selected: Some(id) == selected,
            };
            self.invalidate(id, Invalid::STATE);
        }
        Ok(())
    }
    fn menu_style_for(&self, id: NodeId) -> Result<&MenuStyle> {
        let list = if self.action_row(id) || matches!(self.nodes[&id].kind, Kind::MenuOption { .. })
        {
            self.nodes[&id].parent.ok_or("orphan menu option")?
        } else {
            id
        };
        self.list_styles
            .get(&list)
            .or(self.menu_style.as_ref())
            .ok_or_else(|| "menu style missing".into())
    }
    pub(crate) fn list_viewport(&self, id: NodeId) -> Rect {
        let r = self.nodes[&id].bounds;
        let border = self.list_styles.get(&id).map_or(0., |style| style.border);
        Rect {
            x: r.x + border,
            y: r.y + border,
            width: (r.width - 2. * border).max(0.),
            height: (r.height - 2. * border).max(0.),
        }
    }
    pub(crate) fn list_extent(&self, id: NodeId) -> f32 {
        2. * self.list_styles[&id].inset
            + self.nodes[&id]
                .children
                .iter()
                .filter(|id| !self.is_hidden(**id))
                .map(|id| self.nodes[id].measured.height)
                .sum::<f32>()
    }
    /// Portal/theme update, preserving node identities, focus and scroll.
    pub fn set_menu_style(&mut self, style: MenuStyle) -> Result<()> {
        style.validate()?;
        if self.menu_style.is_none() {
            return Err("not a menu tree".into());
        }
        self.menu_style = Some(style);
        self.invalidate(self.root, Invalid::LAYOUT);
        Ok(())
    }
    pub fn menu_list(
        title: &str,
        metrics: Metrics,
        text: TextStyle,
        style: MenuStyle,
        options: &[&str],
        selected: usize,
    ) -> Result<(Self, Vec<NodeId>)> {
        style.validate()?;
        if options.is_empty() || selected >= options.len() {
            return Err("menu needs options and a valid selection".into());
        }
        let mut tree = Self::new(title, metrics, text)?;
        tree.menu_style = Some(style);
        tree.leading = 0.;
        tree.sidebar_open = false;
        let scroll = tree.append(tree.root(), Kind::Scroll, title)?;
        let ids = options
            .iter()
            .enumerate()
            .map(|(at, name)| {
                tree.append(
                    scroll,
                    Kind::MenuOption {
                        selected: at == selected,
                    },
                    *name,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        Ok((tree, ids))
    }
    pub(crate) fn measure_menu(
        &mut self,
        id: NodeId,
        width: f32,
        backend: &mut impl TextBackend,
    ) -> Result<Size> {
        let s = self.menu_style_for(id)?.clone();
        let width = if matches!(self.nodes[&id].kind, Kind::List { .. }) {
            self.nodes[&id]
                .width
                .unwrap_or(width)
                .max(self.nodes[&id].min_width)
                .max(1.)
        } else {
            width
        };
        let size = if matches!(self.nodes[&id].kind, Kind::Scroll | Kind::List { .. }) {
            let mut height = 2. * s.inset;
            for child in self.nodes[&id].children.clone() {
                if !self.is_hidden(child) {
                    height += self
                        .measure_menu(child, (width - 2. * (s.border + s.inset)).max(1.), backend)?
                        .height;
                }
            }
            if let Kind::List { height: viewport } = self.nodes[&id].kind {
                self.nodes.get_mut(&id).unwrap().scroll.y = self.nodes[&id]
                    .scroll
                    .y
                    .min((height - (viewport - 2. * s.border).max(0.)).max(0.));
                Size {
                    width,
                    height: viewport,
                }
            } else {
                Size {
                    width: (width - 2. * s.border).max(0.),
                    height,
                }
            }
        } else if self.menu_action_kind(id) == Some(MenuActionKind::Separator) {
            Size {
                width,
                height: self.metrics.separator_width + 2. * s.padding_y,
            }
        } else {
            let mut style = self.style.clone();
            style.size *= s.text_scale;
            style.weight = s.weight;
            let icon_gutter = if self.action_row(id) {
                s.check_gap + s.check_size
            } else {
                0.
            };
            let n = self.nodes.get_mut(&id).unwrap();
            let text_width =
                (width - 2. * s.padding_x - s.check_gap - s.check_size - icon_gutter).max(1.);
            let layout = backend.layout(&n.name, &style, text_width)?;
            let height = layout.measured_size().height.max(s.check_size) + 2. * s.padding_y;
            n.layout = Some(layout);
            Size { width, height }
        };
        self.nodes.get_mut(&id).unwrap().measured = size;
        Ok(size)
    }
    pub(crate) fn place_menu(&mut self, id: NodeId, r: Rect) {
        let s = self.menu_style_for(id).unwrap().clone();
        let mut y = r.y + s.border + s.inset - self.nodes[&id].scroll.y;
        for child in self.nodes[&id].children.clone() {
            if self.is_hidden(child) {
                continue;
            }
            let height = self.nodes[&child].measured.height;
            self.place_node(
                child,
                Rect {
                    x: r.x + s.border + s.inset,
                    y,
                    width: (r.width - 2. * (s.border + s.inset)).max(0.),
                    height,
                },
            );
            y += height;
        }
    }
    pub(crate) fn menu_key(&mut self, id: NodeId, sym: u32) -> Result<Option<Effect>> {
        if !matches!(sym, 0xff52 | 0xff54 | 0xff50 | 0xff57) {
            return Ok(None);
        }
        let available: Vec<_> = self.nodes[&self.nodes[&id].parent.unwrap()]
            .children
            .iter()
            .copied()
            .filter(|id| self.available(*id))
            .collect();
        let Some(at) = available.iter().position(|v| *v == id) else {
            return Ok(Some(Effect::None));
        };
        let n = available.len();
        let next = match sym {
            0xff52 => (at + n - 1) % n,
            0xff54 => (at + 1) % n,
            0xff50 => 0,
            _ => n - 1,
        };
        self.set_hovered(None);
        self.set_focus_visible(true);
        self.focus(available[next])?;
        Ok(Some(Effect::Focused(available[next])))
    }
    pub(crate) fn paint_menu(&self, frame: nk_wayland::Frame, palette: Palette) -> Result<Vec<u8>> {
        let s = self.menu_style.as_ref().ok_or("menu style missing")?;
        let mut canvas = Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
        let outer = self.nodes[&self.root].bounds;
        if !frame.material {
            let mut bg = s.background;
            bg.components[3] = 1.;
            canvas.rounded_rect(outer, s.radius as f64, bg);
        }
        canvas.rounded_ring(outer, s.radius as f64, s.border as f64, s.border_color);
        let clip = self.content_viewport();
        canvas.clip_rounded_rect(clip, (s.radius - s.border).max(0.) as f64);
        let list = self.nodes[&self.root]
            .children
            .iter()
            .copied()
            .find(|id| self.nodes[id].kind == Kind::Scroll)
            .ok_or("menu scroll missing")?;
        self.paint_menu_rows(list, s, Point::default(), &mut canvas, palette, clip)?;
        canvas.pop_clip();
        self.paint_action_bands(&mut canvas)?;
        Ok(canvas.finish())
    }
    pub(crate) fn paint_list(
        &self,
        id: NodeId,
        origin: Point,
        canvas: &mut Canvas,
        palette: Palette,
        clip: Rect,
    ) -> Result<()> {
        let s = self.menu_style_for(id)?;
        let outer = crate::paint::local(self.nodes[&id].bounds, origin);
        let mut bg = s.background;
        bg.components[3] = 1.;
        canvas.rounded_rect(outer, s.radius as f64, bg);
        canvas.rounded_ring(outer, s.radius as f64, s.border as f64, s.border_color);
        let viewport = crate::paint::local(self.list_viewport(id), origin);
        let clip = intersect_rect(clip, viewport);
        canvas.clip(clip);
        canvas.clip_rounded_rect(viewport, (s.radius - s.border).max(0.) as f64);
        self.paint_menu_rows(id, s, origin, canvas, palette, clip)?;
        canvas.pop_clip();
        canvas.pop_clip();
        Ok(())
    }
    fn paint_menu_rows(
        &self,
        list: NodeId,
        s: &MenuStyle,
        origin: Point,
        canvas: &mut Canvas,
        palette: Palette,
        clip: Rect,
    ) -> Result<()> {
        let check = check_icon(s.check_stroke);
        for id in &self.nodes[&list].children {
            let node = &self.nodes[id];
            let action = self.action_menu.as_ref().and_then(|m| m.rows.get(id));
            let selected = match (node.kind, action) {
                (Kind::MenuOption { selected }, _) => selected,
                (_, Some(row)) => matches!(
                    row.kind,
                    MenuActionKind::Check(true) | MenuActionKind::Radio(true)
                ),
                _ => continue,
            };
            if self.is_hidden(*id) || !intersects(crate::paint::local(node.bounds, origin), clip) {
                continue;
            }
            let r = crate::paint::local(node.bounds, origin);
            if action.is_some_and(|a| a.kind == MenuActionKind::Separator) {
                canvas.rounded_rect(
                    Rect {
                        x: r.x + s.padding_x,
                        y: r.y + (r.height - self.metrics.separator_width) / 2.,
                        width: (r.width - 2. * s.padding_x).max(0.),
                        height: self.metrics.separator_width,
                    },
                    0.,
                    palette.separator,
                );
                continue;
            }
            let highlighted = self.available(*id)
                && (self.hovered == Some(*id) || (self.focus_visible && self.focused == Some(*id)));
            let ink = if !self.available(*id) {
                palette.disabled
            } else if highlighted {
                s.accent_text
            } else {
                s.text
            };
            if highlighted {
                let mut bg = s.accent;
                if self.capture == Some(*id) {
                    for channel in &mut bg.components[..3] {
                        *channel *= 1. - s.pressed_black;
                    }
                }
                canvas.rounded_rect(r, s.row_radius as f64, bg);
            }
            if let Some(icon) = action.and_then(|a| a.icon.as_ref()) {
                let bounds = Rect {
                    x: r.x + s.padding_x,
                    y: r.y + (r.height - s.check_size) / 2.,
                    width: s.check_size,
                    height: s.check_size,
                };
                match icon {
                    MenuIcon::Vector(icon) => canvas.icon(icon, bounds, ink),
                    MenuIcon::Raster(image) => {
                        canvas.image(image, bounds, nk_render::ImageFit::Contain)
                    }
                }
            }
            if let Some(layout) = &node.layout {
                canvas.layout(
                    layout,
                    (
                        r.x + s.padding_x
                            + if action.is_some() {
                                s.check_gap + s.check_size
                            } else {
                                0.
                            },
                        r.y + (r.height - layout.measured_size().height) / 2.,
                    ),
                    ink,
                )?;
            }
            if let Some(action) = action
                && matches!(action.kind, MenuActionKind::Submenu { .. })
            {
                canvas.icon(
                    &self.action_menu.as_ref().unwrap().style.submenu,
                    Rect {
                        x: r.x + r.width - s.padding_x - s.check_size,
                        y: r.y + (r.height - s.check_size) / 2.,
                        width: s.check_size,
                        height: s.check_size,
                    },
                    ink,
                );
            }
            if selected && action.is_some_and(|a| matches!(a.kind, MenuActionKind::Radio(true))) {
                let size = s.check_size / 2.;
                canvas.rounded_rect(
                    Rect {
                        x: r.x + r.width - s.padding_x - s.check_size + (s.check_size - size) / 2.,
                        y: r.y + (r.height - size) / 2.,
                        width: size,
                        height: size,
                    },
                    size as f64 / 2.,
                    ink,
                );
            } else if selected {
                canvas.icon(
                    &check,
                    Rect {
                        x: r.x + r.width - s.padding_x - s.check_size,
                        y: r.y + (r.height - s.check_size) / 2.,
                        width: s.check_size,
                        height: s.check_size,
                    },
                    ink,
                );
            }
        }
        Ok(())
    }
}
// The single-select check.ts path, in its 24×24 source units; size/stroke/ink are inputs.
fn check_icon(width: f32) -> nk_icons::Icon {
    use nk_icons::{Cap, Icon, Join, Point as P, Segment as S, Shape, Stroke};
    Icon {
        size: (24., 24.),
        shapes: vec![Shape {
            segments: vec![
                S::Move(P { x: 4., y: 12. }),
                S::Line(P { x: 9., y: 17. }),
                S::Line(P { x: 20., y: 6. }),
            ],
            fill: None,
            stroke: Some(Stroke {
                width,
                cap: Cap::Round,
                join: Join::Round,
                miter_limit: 1.,
                opacity: 1.,
            }),
            stroke_first: false,
        }],
    }
}
