// SPDX-License-Identifier: LGPL-3.0-or-later
//! Radio groups (#882): one choice of several, kept by the tree. The segmented choice (also the
//! preset choice) and the swatch choice are one component with two looks; the app names the
//! look, never its numbers (`ChoiceStyle`, from the exported `components.json` choices).
use crate::*;
use nk_render::{Canvas, Color};

/// Radio layouts share the same keyboard, pointer and AT-SPI selection model.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChoiceKind {
    /// Linked segments with their text; the chosen one in the accent.
    Segmented,
    /// Round colour samples, each named; the chosen one ringed.
    Swatch,
    /// Pictures inside an independent horizontal viewport with explicit per-strip style.
    Thumbnail,
}
/// The groups' measurements and colours, resolved by the app from the exported choices
/// (`toolkit/tokens/choices.json` → `components.json`). There are no defaults here.
#[derive(Clone, Copy, Debug)]
pub struct ChoiceStyle {
    pub segment_padding_x: f32,
    pub segment_padding_y: f32,
    pub segment_border: f32,
    /// The segment's text size relative to the tree's style (`fse-small`).
    pub segment_text_scale: f32,
    pub segment_border_color: Color,
    pub segment_selected: Color,
    pub segment_selected_text: Color,
    pub swatch_diameter: f32,
    pub swatch_border: f32,
    pub swatch_ring: f32,
    pub swatch_gap: f32,
    pub swatch_selected: Color,
    pub swatch_hover: Color,
}
impl ChoiceStyle {
    fn validate(&self) -> Result<()> {
        let sizes = [
            self.segment_padding_x,
            self.segment_padding_y,
            self.segment_border,
            self.swatch_border,
            self.swatch_ring,
            self.swatch_gap,
        ];
        if !sizes.iter().all(|v| v.is_finite() && *v >= 0.)
            || !(self.segment_text_scale.is_finite() && self.segment_text_scale > 0.)
            || !(self.swatch_diameter.is_finite() && self.swatch_diameter > 2. * self.swatch_border)
        {
            return Err("invalid choice measurements".into());
        }
        Ok(())
    }
}
const LEFT: u32 = 0xff51;
const UP: u32 = 0xff52;
const RIGHT: u32 = 0xff53;
const DOWN: u32 = 0xff54;
const HOME: u32 = 0xff50;
const END: u32 = 0xff57;

impl Tree {
    /// A row holding a radio group: its label, the group, and one choice per option, the
    /// `selected` one chosen. The group is named by the row's label; each choice by its option.
    pub fn choices(
        &mut self,
        group: NodeId,
        label: &str,
        kind: ChoiceKind,
        options: &[&str],
        selected: usize,
    ) -> Result<(NodeId, NodeId, Vec<NodeId>)> {
        if options.is_empty() || selected >= options.len() {
            return Err("a radio group needs its options and one of them chosen".into());
        }
        let row = self.append(group, Kind::Row, "")?;
        self.append(row, Kind::Label, label)?;
        let choices = self.append(row, Kind::Choices { kind }, label)?;
        let ids = options
            .iter()
            .enumerate()
            .map(|(i, name)| {
                self.append(
                    choices,
                    Kind::Choice {
                        checked: i == selected,
                    },
                    *name,
                )
            })
            .collect::<Result<Vec<_>>>()?;
        Ok((row, choices, ids))
    }
    /// The colour a swatch choice shows.
    pub fn set_swatch(&mut self, id: NodeId, color: Color) -> Result<()> {
        let node = self.nodes.get_mut(&id).ok_or("unknown choice")?;
        if !matches!(node.kind, Kind::Choice { .. }) {
            return Err("a swatch colour needs a choice".into());
        }
        node.swatch = Some(color);
        self.invalidate(id, Invalid::PAINT);
        Ok(())
    }
    /// The radio groups' look, from the app's exported tokens; again after an appearance change.
    pub fn set_choice_style(&mut self, style: ChoiceStyle) -> Result<()> {
        style.validate()?;
        self.choice_style = Some(style);
        let groups: Vec<_> = self
            .nodes
            .iter()
            .filter(|(_, n)| matches!(n.kind, Kind::Choices { .. } | Kind::Choice { .. }))
            .map(|(id, _)| *id)
            .collect();
        for id in groups {
            let n = self.nodes.get_mut(&id).unwrap();
            n.layout = None;
            n.constraint = 0.;
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }
    /// Update the chosen option from the app's model, without activating it.
    pub fn set_choice(&mut self, id: NodeId) -> Result<()> {
        let node = self.nodes.get(&id).ok_or("unknown choice")?;
        if !matches!(node.kind, Kind::Choice { .. }) {
            return Err("widget is not a choice".into());
        }
        let parent = node.parent.unwrap();
        for child in self.nodes[&parent].children.clone() {
            let checked = child == id;
            let n = self.nodes.get_mut(&child).unwrap();
            if n.kind != (Kind::Choice { checked }) {
                n.kind = Kind::Choice { checked };
                self.invalidate(child, Invalid::STATE);
            }
        }
        Ok(())
    }
    pub(crate) fn choice_kind(&self, id: NodeId) -> Option<ChoiceKind> {
        let parent = self.nodes.get(&id)?.parent?;
        match self.nodes[&parent].kind {
            Kind::Choices { kind } => Some(kind),
            _ => None,
        }
    }
    /// One Tab stop per group: its chosen option (the first while none is). The others are
    /// reached with the arrows, as a radio group is.
    pub(crate) fn tab_stop(&self, id: NodeId) -> bool {
        let n = &self.nodes[&id];
        if matches!(n.kind, Kind::MenuOption { .. })
            && let Some(parent) = n.parent
            && matches!(self.nodes[&parent].kind, Kind::List { .. })
        {
            let available: Vec<_> = self.nodes[&parent]
                .children
                .iter()
                .copied()
                .filter(|id| self.available(*id))
                .collect();
            let entry = self
                .focused
                .filter(|id| available.contains(id))
                .or_else(|| {
                    available.iter().copied().find(|id| {
                        matches!(self.nodes[id].kind, Kind::MenuOption { selected: true })
                    })
                })
                .or_else(|| available.first().copied());
            return entry == Some(id);
        }
        let Kind::Choice { checked } = n.kind else {
            return true;
        };
        if checked {
            return true;
        }
        let siblings = &self.nodes[&n.parent.unwrap()].children;
        let available: Vec<_> = siblings
            .iter()
            .copied()
            .filter(|c| self.available(*c))
            .collect();
        !available
            .iter()
            .any(|c| self.nodes[c].kind == (Kind::Choice { checked: true }))
            && available.first() == Some(&id)
    }
    /// Keys a focused control takes before Tab and activation: a range control's (ranges.rs),
    /// and the arrows, Home and End on a focused choice: the next/previous/first/last available
    /// option of its group takes the focus AND the choice; it wraps at the ends.
    pub fn control_key(&mut self, sym: u32) -> Result<Option<Effect>> {
        if self.action_menu.is_some() {
            return self.action_menu_key(sym);
        }
        let Some(id) = self.focused else {
            return Ok(None);
        };
        if matches!(self.nodes[&id].kind, Kind::MenuOption { .. }) {
            return self.menu_key(id, sym);
        }
        if matches!(
            self.nodes[&id].kind,
            Kind::Slider { .. } | Kind::Spin { .. }
        ) {
            return self.range_key(id, sym);
        }
        if !matches!(self.nodes[&id].kind, Kind::Choice { .. }) {
            return Ok(None);
        }
        let siblings: Vec<_> = self.nodes[&self.nodes[&id].parent.unwrap()]
            .children
            .iter()
            .copied()
            .filter(|c| self.available(*c))
            .collect();
        let Some(at) = siblings.iter().position(|c| *c == id) else {
            return Ok(None);
        };
        let n = siblings.len();
        let target = match sym {
            LEFT | UP => siblings[(at + n - 1) % n],
            RIGHT | DOWN => siblings[(at + 1) % n],
            HOME => siblings[0],
            END => siblings[n - 1],
            _ => return Ok(None),
        };
        self.focus(target)?;
        self.set_choice(target)?;
        Ok(Some(Effect::Activated(target)))
    }
    pub(crate) fn measure_choices(
        &mut self,
        id: NodeId,
        kind: ChoiceKind,
        available: f32,
        backend: &mut impl TextBackend,
    ) -> Result<Size> {
        if kind == ChoiceKind::Thumbnail {
            return self.measure_thumbnails(id, available);
        }
        let style = self
            .choice_style
            .ok_or("radio group measured before its choice style was set")?;
        let m = self.metrics;
        let mut text_style = self.style.clone();
        text_style.size *= style.segment_text_scale;
        let mut width: f32 = 0.;
        let mut count = 0;
        for child in self.nodes[&id].children.clone() {
            if self.is_hidden(child) {
                self.nodes.get_mut(&child).unwrap().measured = Size::default();
                continue;
            }
            let size = match kind {
                ChoiceKind::Thumbnail => unreachable!("thumbnail strip measured above"),
                ChoiceKind::Swatch => Size {
                    width: style.swatch_diameter + 2. * style.swatch_ring,
                    height: style.swatch_diameter + 2. * style.swatch_ring,
                },
                ChoiceKind::Segmented => {
                    let n = self.nodes.get_mut(&child).unwrap();
                    let text = if let Some(layout) = &mut n.layout {
                        layout.size(available)?
                    } else {
                        let layout = backend.layout(&n.name, &text_style, available)?;
                        let size = layout.measured_size();
                        n.layout = Some(layout);
                        size
                    };
                    Size {
                        width: text.width + 2. * style.segment_padding_x,
                        height: m.control.max(text.height + 2. * style.segment_padding_y),
                    }
                }
            };
            let n = self.nodes.get_mut(&child).unwrap();
            n.measured = size;
            n.constraint = size.width;
            width += size.width;
            count += 1;
        }
        let gap = match kind {
            ChoiceKind::Swatch => style.swatch_gap,
            ChoiceKind::Segmented => 0.,
            ChoiceKind::Thumbnail => unreachable!("thumbnail strip measured above"),
        };
        let height = self.nodes[&id]
            .children
            .iter()
            .map(|c| self.nodes[c].measured.height)
            .fold(m.control, f32::max);
        let size = Size {
            width: width + gap * (count.max(1) - 1) as f32,
            height,
        };
        self.nodes.get_mut(&id).unwrap().measured = size;
        Ok(size)
    }
    pub(crate) fn place_choices(&mut self, id: NodeId, r: Rect) {
        if self.thumbnail_styles.contains_key(&id) {
            self.place_thumbnails(id, r);
            return;
        }
        let gap = match self.nodes[&id].kind {
            Kind::Choices {
                kind: ChoiceKind::Swatch,
            } => self.choice_style.map_or(0., |s| s.swatch_gap),
            _ => 0.,
        };
        let mut x = r.x;
        for child in self.nodes[&id].children.clone() {
            if self.is_hidden(child) {
                continue;
            }
            let s = self.nodes[&child].measured;
            self.nodes.get_mut(&child).unwrap().bounds = Rect {
                x,
                y: r.y + (r.height - s.height) / 2.,
                width: s.width,
                height: s.height,
            };
            x += s.width + gap;
        }
    }
    /// The focus/hover silhouette of a choice: its segment, or its sample's circle.
    pub(crate) fn choice_shape(&self, id: NodeId) -> (Rect, f32) {
        let r = self.nodes[&id].bounds;
        if let Some(style) = self.nodes[&id]
            .parent
            .and_then(|p| self.thumbnail_styles.get(&p))
        {
            return (r, style.radius);
        }
        match (self.choice_kind(id), self.choice_style) {
            (Some(ChoiceKind::Swatch), Some(s)) => {
                let d = s.swatch_diameter;
                (
                    Rect {
                        x: r.x + (r.width - d) / 2.,
                        y: r.y + (r.height - d) / 2.,
                        width: d,
                        height: d,
                    },
                    d / 2.,
                )
            }
            _ => (r, self.metrics.radius),
        }
    }
    /// Where a choice's keyboard ring goes: OUTSIDE its shape, one ring's width away — the
    /// chosen segment is the accent, and a ring of the accent on it would not show (the kit's
    /// `nidara-focus-ring`, outline-offset 2 px). A sample's ring clears its chosen band.
    pub(crate) fn choice_focus_shape(&self, id: NodeId) -> (Rect, f32) {
        let (r, radius) = self.choice_shape(id);
        let band = match (self.choice_kind(id), self.choice_style) {
            (Some(ChoiceKind::Swatch), Some(s)) => s.swatch_ring,
            _ => 0.,
        };
        let out = band + 2. * self.metrics.focus_width;
        (
            Rect {
                x: r.x - out,
                y: r.y - out,
                width: r.width + 2. * out,
                height: r.height + 2. * out,
            },
            radius + out,
        )
    }
    /// The group's own pixels: the segments' track and border, the chosen segment, or each
    /// sample with its ring. Text, hover and the focus ring are painted as for any control.
    pub(crate) fn paint_choices(
        &self,
        id: NodeId,
        r: Rect,
        origin: Point,
        canvas: &mut Canvas,
        palette: Palette,
    ) {
        let Some(style) = self.choice_style else {
            return;
        };
        let Kind::Choices { kind } = self.nodes[&id].kind else {
            return;
        };
        let local = |b: Rect| Rect {
            x: b.x - origin.x,
            y: b.y - origin.y,
            ..b
        };
        let children: Vec<_> = self.nodes[&id]
            .children
            .iter()
            .copied()
            .filter(|c| !self.is_hidden(*c))
            .collect();
        match kind {
            ChoiceKind::Thumbnail => unreachable!("thumbnail strip painted separately"),
            ChoiceKind::Segmented => {
                let radius = self.metrics.radius as f64;
                canvas.rounded_rect(r, radius, palette.surface);
                canvas.clip_rounded_rect(r, radius);
                for (i, child) in children.iter().enumerate() {
                    let b = local(self.nodes[child].bounds);
                    if self.nodes[child].kind == (Kind::Choice { checked: true }) {
                        canvas.rect(b, style.segment_selected);
                    }
                    if i > 0 {
                        canvas.rect(
                            Rect {
                                x: b.x,
                                width: style.segment_border,
                                ..b
                            },
                            style.segment_border_color,
                        );
                    }
                }
                canvas.pop_clip();
                canvas.rounded_ring(
                    r,
                    radius,
                    style.segment_border as f64,
                    style.segment_border_color,
                );
            }
            ChoiceKind::Swatch => {
                for child in children {
                    let (circle, radius) = self.choice_shape(child);
                    let circle = local(circle);
                    let n = &self.nodes[&child];
                    let b = style.swatch_border;
                    let fill = Rect {
                        x: circle.x + b,
                        y: circle.y + b,
                        width: circle.width - 2. * b,
                        height: circle.height - 2. * b,
                    };
                    let mut color = n.swatch.unwrap_or(palette.disabled);
                    if !self.available(child) {
                        color.components[3] *= 0.45;
                    }
                    canvas.rounded_rect(fill, (radius - b) as f64, color);
                    if n.kind == (Kind::Choice { checked: true }) {
                        // The border and its outer ring, one band of the ink.
                        let ring = style.swatch_ring;
                        let outer = Rect {
                            x: circle.x - ring,
                            y: circle.y - ring,
                            width: circle.width + 2. * ring,
                            height: circle.height + 2. * ring,
                        };
                        canvas.rounded_ring(
                            outer,
                            (radius + ring) as f64,
                            (b + ring) as f64,
                            style.swatch_selected,
                        );
                    } else if self.hovered == Some(child) && self.available(child) {
                        canvas.rounded_ring(circle, radius as f64, b as f64, style.swatch_hover);
                    }
                }
            }
        }
    }
    /// The ink of a segment's text: the accent's text on the chosen one.
    pub(crate) fn choice_ink(&self, id: NodeId, ink: Color) -> Color {
        match (self.nodes[&id].kind, self.choice_style) {
            (Kind::Choice { checked: true }, Some(s)) if self.available(id) => {
                s.segment_selected_text
            }
            _ => ink,
        }
    }
}
