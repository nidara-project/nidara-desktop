// SPDX-License-Identifier: LGPL-3.0-or-later
//! Retained dropdown list: a chosen check and an independently hovered/focused option.
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
    fn validate(&self) -> Result<()> {
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
        let s = self
            .menu_style
            .as_ref()
            .ok_or("menu style missing")?
            .clone();
        let size = if self.nodes[&id].kind == Kind::Scroll {
            let mut height = 2. * s.inset;
            for child in self.nodes[&id].children.clone() {
                if !self.is_hidden(child) {
                    height += self
                        .measure_menu(child, (width - 2. * (s.border + s.inset)).max(1.), backend)?
                        .height;
                }
            }
            Size {
                width: (width - 2. * s.border).max(0.),
                height,
            }
        } else {
            let mut style = self.style.clone();
            style.size *= s.text_scale;
            style.weight = s.weight;
            let n = self.nodes.get_mut(&id).unwrap();
            let text_width = (width - 2. * s.padding_x - s.check_gap - s.check_size).max(1.);
            let layout = backend.layout(&n.name, &style, text_width)?;
            let height = layout.measured_size().height.max(s.check_size) + 2. * s.padding_y;
            n.layout = Some(layout);
            Size { width, height }
        };
        self.nodes.get_mut(&id).unwrap().measured = size;
        Ok(size)
    }
    pub(crate) fn place_menu(&mut self, id: NodeId, r: Rect) {
        let s = self.menu_style.as_ref().unwrap().clone();
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
        let check = check_icon(s.check_stroke);
        for (id, node) in &self.nodes {
            let Kind::MenuOption { selected } = node.kind else {
                continue;
            };
            if self.is_hidden(*id) || !intersects(node.bounds, clip) {
                continue;
            }
            let r = node.bounds;
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
            if let Some(layout) = &node.layout {
                canvas.layout(
                    layout,
                    (
                        r.x + s.padding_x,
                        r.y + (r.height - layout.measured_size().height) / 2.,
                    ),
                    ink,
                )?;
            }
            if selected {
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
        canvas.pop_clip();
        Ok(canvas.finish())
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
