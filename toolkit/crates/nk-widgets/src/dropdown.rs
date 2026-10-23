// SPDX-License-Identifier: LGPL-3.0-or-later
//! Retained ComboBox/Selection and token-driven closed trigger; open list pending.
use crate::*;
use nk_render::{Canvas, Color};

/// The exact exported trigger look; no geometry or colour defaults in the widget.
#[derive(Clone, Debug)]
pub struct DropdownStyle {
    pub padding_x: f32,
    pub padding_y: f32,
    pub border: f32,
    pub min_content_height: f32,
    pub radius: f32,
    pub text_scale: f32,
    pub weight: f32,
    pub label_margin: f32,
    pub arrow_size: f32,
    pub arrow_gap: f32,
    pub arrow: String,
    pub background: Color,
    pub hover: Color,
    pub pressed: Color,
    pub text: Color,
    pub arrow_color: Color,
    pub focus: Color,
    pub disabled_opacity: f32,
}
impl DropdownStyle {
    fn validate(&self) -> Result<()> {
        if ![
            self.padding_x,
            self.padding_y,
            self.border,
            self.radius,
            self.label_margin,
            self.arrow_gap,
        ]
        .iter()
        .all(|v| v.is_finite() && *v >= 0.)
            || ![self.min_content_height, self.text_scale, self.arrow_size]
                .iter()
                .all(|v| v.is_finite() && *v > 0.)
            || !self.weight.is_finite()
            || !(1. ..=1000.).contains(&self.weight)
            || !self.disabled_opacity.is_finite()
            || !(0. ..=1.).contains(&self.disabled_opacity)
            || self.arrow.is_empty()
            || ![
                self.background,
                self.hover,
                self.pressed,
                self.text,
                self.arrow_color,
                self.focus,
            ]
            .iter()
            .all(|c| {
                c.components.iter().all(|v| v.is_finite()) && (0. ..=1.).contains(&c.components[3])
            })
        {
            return Err("invalid dropdown style".into());
        }
        Ok(())
    }
}

impl Tree {
    pub fn set_dropdown_style(&mut self, style: DropdownStyle) -> Result<()> {
        style.validate()?;
        self.dropdown_style = Some(style);
        let ids: Vec<_> = self
            .nodes
            .iter()
            .filter(|(_, n)| matches!(n.kind, Kind::Dropdown { .. }))
            .map(|(id, _)| *id)
            .collect();
        for id in ids {
            let n = self.nodes.get_mut(&id).unwrap();
            n.layout = None;
            n.constraint = 0.;
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }
    fn dropdown_style(&self) -> Result<&DropdownStyle> {
        self.dropdown_style
            .as_ref()
            .ok_or_else(|| "dropdown style was not set".into())
    }
    pub(crate) fn measure_dropdown(
        &mut self,
        id: NodeId,
        width: f32,
        backend: &mut impl TextBackend,
    ) -> Result<Size> {
        let s = self.dropdown_style()?.clone();
        let inset = 2. * (s.border + s.padding_x) + s.label_margin + s.arrow_gap + s.arrow_size;
        let mut text_style = self.style.clone();
        text_style.size *= s.text_scale;
        text_style.weight = s.weight;
        let n = self.nodes.get_mut(&id).unwrap();
        let text_width = (width - inset).max(1.);
        let text = if let Some(layout) = &mut n.layout {
            layout.size(text_width)?
        } else {
            let layout = backend.layout(&n.name, &text_style, text_width)?;
            let size = layout.measured_size();
            n.layout = Some(layout);
            size
        };
        n.measured = Size {
            width: text.width + inset,
            height: text.height.max(s.arrow_size).max(s.min_content_height)
                + 2. * (s.padding_y + s.border),
        };
        Ok(n.measured)
    }
    pub(crate) fn paint_dropdown(&self, id: NodeId, r: Rect, canvas: &mut Canvas) -> Result<()> {
        let s = self.dropdown_style()?;
        let enabled = self.available(id);
        let opacity = if enabled { 1. } else { s.disabled_opacity };
        let ink = |mut c: Color| {
            c.components[3] *= opacity;
            c
        };
        let bg = if enabled && self.capture == Some(id) {
            s.pressed
        } else if enabled && self.hovered == Some(id) {
            s.hover
        } else {
            s.background
        };
        let inner = Rect {
            x: r.x + s.border,
            y: r.y + s.border,
            width: (r.width - 2. * s.border).max(0.),
            height: (r.height - 2. * s.border).max(0.),
        };
        canvas.rounded_rect(inner, (s.radius - s.border).max(0.) as f64, ink(bg));
        if enabled && self.focus_visible && self.focused == Some(id) {
            canvas.rounded_ring(r, s.radius as f64, s.border as f64, s.focus);
        }
        if let Some(layout) = &self.nodes[&id].layout {
            canvas.layout(
                layout,
                (
                    r.x + s.border + s.padding_x + s.label_margin,
                    r.y + (r.height - layout.measured_size().height) / 2.,
                ),
                ink(s.text),
            )?;
        }
        let icon = self.icon(&s.arrow, s.arrow_size)?;
        canvas.icon(
            &icon,
            Rect {
                x: r.x + r.width - s.border - s.padding_x - s.arrow_size,
                y: r.y + (r.height - s.arrow_size) / 2.,
                width: s.arrow_size,
                height: s.arrow_size,
            },
            ink(s.arrow_color),
        );
        Ok(())
    }
}

impl Tree {
    pub fn dropdown(
        &mut self,
        group: NodeId,
        label: &str,
        options: &[&str],
        selected: usize,
    ) -> Result<(NodeId, NodeId)> {
        if options.is_empty() || selected >= options.len() {
            return Err("dropdown needs options and a valid selection".into());
        }
        // Check the parent before creating any of the compound widget.
        if !matches!(
            self.nodes.get(&group).map(|n| n.kind),
            Some(Kind::Group | Kind::Scroll)
        ) {
            return Err("dropdown row requires a group or scroll".into());
        }
        let row = self.append(group, Kind::Row, "")?;
        self.append(row, Kind::Label, label)?;
        let combo = self.append(row, Kind::Dropdown { expanded: false }, options[selected])?;
        for (index, option) in options.iter().enumerate() {
            self.append(
                combo,
                Kind::DropdownOption {
                    selected: index == selected,
                },
                *option,
            )?;
        }
        Ok((row, combo))
    }

    pub fn dropdown_selected(&self, combo: NodeId) -> Result<usize> {
        let node = self.nodes.get(&combo).ok_or("unknown dropdown")?;
        if !matches!(node.kind, Kind::Dropdown { .. }) {
            return Err("not a dropdown".into());
        }
        node.children
            .iter()
            .position(|id| self.nodes[id].kind == Kind::DropdownOption { selected: true })
            .ok_or_else(|| "dropdown has no selection".into())
    }

    /// A model update (e.g. Config1 canonical reply); no user effect or write is emitted.
    pub fn set_dropdown_selected(&mut self, combo: NodeId, selected: usize) -> Result<()> {
        let node = self.nodes.get(&combo).ok_or("unknown dropdown")?;
        if !matches!(node.kind, Kind::Dropdown { .. }) {
            return Err("not a dropdown".into());
        }
        let option = *node
            .children
            .get(selected)
            .ok_or("dropdown selection outside options")?;
        self.select_dropdown_option(option)?;
        Ok(())
    }

    pub fn set_dropdown_expanded(&mut self, combo: NodeId, expanded: bool) -> Result<()> {
        let node = self.nodes.get_mut(&combo).ok_or("unknown dropdown")?;
        if !matches!(node.kind, Kind::Dropdown { .. }) {
            return Err("not a dropdown".into());
        }
        if node.kind != (Kind::Dropdown { expanded }) {
            node.kind = Kind::Dropdown { expanded };
            self.invalidate(combo, Invalid::STATE);
        }
        Ok(())
    }

    pub(crate) fn select_dropdown_option(&mut self, option: NodeId) -> Result<bool> {
        let node = self.nodes.get(&option).ok_or("unknown dropdown option")?;
        if !matches!(node.kind, Kind::DropdownOption { .. }) {
            return Err("not a dropdown option".into());
        }
        let combo = node.parent.ok_or("orphan dropdown option")?;
        if !matches!(self.nodes[&combo].kind, Kind::Dropdown { .. }) {
            return Err("option has no dropdown".into());
        }
        if node.kind == (Kind::DropdownOption { selected: true }) {
            return Ok(false);
        }
        let name = node.name.clone();
        let children = self.nodes[&combo].children.clone();
        for child in children {
            self.nodes.get_mut(&child).unwrap().kind = Kind::DropdownOption {
                selected: child == option,
            };
            self.invalidate(child, Invalid::SEMANTICS);
        }
        self.set_name(combo, name)?;
        Ok(true)
    }
}
