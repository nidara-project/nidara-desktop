// SPDX-License-Identifier: LGPL-3.0-or-later
//! Horizontal viewport of the existing radio Choice model, painting shared Rasters.
use crate::*;
use nk_render::{Canvas, Color};
#[derive(Clone, Copy, Debug)]
pub struct ThumbnailStyle {
    pub picture: Size,
    pub image: ImageStyle,
    pub padding: f32,
    pub border: f32,
    pub radius: f32,
    pub gap: f32,
    pub background: Color,
    pub idle_border: Color,
    pub hover_border: Color,
    pub selected_border: Color,
}
impl ThumbnailStyle {
    fn validate(&self) -> Result<()> {
        crate::image::validate(self.picture, self.image)?;
        if ![self.padding, self.border, self.radius, self.gap]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.)
            || ![
                self.background,
                self.idle_border,
                self.hover_border,
                self.selected_border,
            ]
            .iter()
            .all(|c| c.components.iter().all(|v| v.is_finite()))
        {
            return Err("invalid thumbnail style".into());
        }
        Ok(())
    }
    fn button(&self) -> Size {
        let edge = 2. * (self.padding + self.border);
        Size {
            width: self.picture.width + edge,
            height: self.picture.height + edge,
        }
    }
}
impl Tree {
    pub fn thumbnail_strip(
        &mut self,
        parent: NodeId,
        name: &str,
        style: ThumbnailStyle,
    ) -> Result<NodeId> {
        style.validate()?;
        let id = self.append(
            parent,
            Kind::Choices {
                kind: ChoiceKind::Thumbnail,
            },
            name,
        )?;
        self.thumbnail_styles.insert(id, style);
        Ok(id)
    }
    pub fn thumbnail_option(&mut self, strip: NodeId, name: &str, checked: bool) -> Result<NodeId> {
        let style = *self
            .thumbnail_styles
            .get(&strip)
            .ok_or("not a thumbnail strip")?;
        let id = self.append(strip, Kind::Choice { checked: false }, name)?;
        self.images.insert(
            id,
            crate::image::Image {
                size: style.picture,
                style: style.image,
                pixels: None,
            },
        );
        if checked {
            self.set_choice(id)?;
        }
        Ok(id)
    }
    pub fn set_thumbnail_selected(
        &mut self,
        strip: NodeId,
        selected: Option<NodeId>,
    ) -> Result<()> {
        if !self.thumbnail_styles.contains_key(&strip) {
            return Err("not a thumbnail strip".into());
        }
        if let Some(id) = selected {
            if !self.nodes[&strip].children.contains(&id) {
                return Err("thumbnail is outside strip".into());
            }
            self.set_choice(id)
        } else {
            for id in self.nodes[&strip].children.clone() {
                if self.nodes[&id].kind != (Kind::Choice { checked: false }) {
                    self.nodes.get_mut(&id).unwrap().kind = Kind::Choice { checked: false };
                    self.invalidate(id, Invalid::STATE);
                }
            }
            Ok(())
        }
    }
    /// Reorder the existing options without replacing their identities or pixels.
    pub fn reorder_thumbnails(&mut self, strip: NodeId, order: &[NodeId]) -> Result<()> {
        let node = self.nodes.get(&strip).ok_or("unknown thumbnail strip")?;
        let current: std::collections::BTreeSet<_> = node.children.iter().copied().collect();
        let requested: std::collections::BTreeSet<_> = order.iter().copied().collect();
        if !self.thumbnail_styles.contains_key(&strip)
            || node.children.len() != order.len()
            || requested.len() != order.len()
            || current != requested
        {
            return Err("thumbnail order must be a permutation of its options".into());
        }
        if node.children != order {
            self.nodes.get_mut(&strip).unwrap().children = order.to_vec();
            self.generation += 1;
            self.invalidate(strip, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub fn set_thumbnail_style(&mut self, strip: NodeId, style: ThumbnailStyle) -> Result<()> {
        style.validate()?;
        if !self.thumbnail_styles.contains_key(&strip) {
            return Err("not a thumbnail strip".into());
        }
        if self.nodes[&strip]
            .children
            .iter()
            .any(|id| !self.images.contains_key(id))
        {
            return Err("thumbnail image missing".into());
        }
        self.thumbnail_styles.insert(strip, style);
        for id in self.nodes[&strip].children.clone() {
            let image = self.images.get_mut(&id).ok_or("thumbnail image missing")?;
            image.size = style.picture;
            image.style = style.image;
            self.nodes.get_mut(&id).unwrap().layout = None;
        }
        self.invalidate(strip, Invalid::LAYOUT);
        Ok(())
    }
    fn thumbnail_extent(&self, id: NodeId) -> f32 {
        let s = self.thumbnail_styles[&id];
        let count = self.nodes[&id]
            .children
            .iter()
            .filter(|id| !self.is_hidden(**id))
            .count();
        4. * self.metrics.focus_width
            + count as f32 * s.button().width
            + count.saturating_sub(1) as f32 * s.gap
    }
    pub(crate) fn measure_thumbnails(&mut self, id: NodeId, available: f32) -> Result<Size> {
        let s = *self
            .thumbnail_styles
            .get(&id)
            .ok_or("thumbnail style missing")?;
        let size = s.button();
        for child in self.nodes[&id].children.clone() {
            let measured = if self.is_hidden(child) {
                Size::default()
            } else {
                size
            };
            let n = self.nodes.get_mut(&child).unwrap();
            n.measured = measured;
            n.layout = None;
        }
        let size = Size {
            width: available.min(self.thumbnail_extent(id)),
            height: size.height + 4. * self.metrics.focus_width,
        };
        self.nodes.get_mut(&id).unwrap().measured = size;
        Ok(size)
    }
    pub(crate) fn place_thumbnails(&mut self, id: NodeId, r: Rect) {
        let s = self.thumbnail_styles[&id];
        let max = (self.thumbnail_extent(id) - r.width).max(0.);
        let scroll = self.nodes[&id].scroll.x.clamp(0., max);
        self.nodes.get_mut(&id).unwrap().scroll = Point { x: scroll, y: 0. };
        let mut x = r.x + 2. * self.metrics.focus_width - scroll;
        for child in self.nodes[&id].children.clone() {
            if self.is_hidden(child) {
                continue;
            }
            let size = s.button();
            self.nodes.get_mut(&child).unwrap().bounds = Rect {
                x,
                y: r.y + 2. * self.metrics.focus_width,
                width: size.width,
                height: size.height,
            };
            x += size.width + s.gap;
        }
    }
    pub(crate) fn scroll_thumbnails(&mut self, id: NodeId, offset: f32) -> Result<()> {
        let max = (self.thumbnail_extent(id) - self.nodes[&id].bounds.width).max(0.);
        self.nodes.get_mut(&id).unwrap().scroll = Point {
            x: offset.clamp(0., max),
            y: 0.,
        };
        self.invalidate(id, Invalid::STATE);
        self.place();
        Ok(())
    }
    pub(crate) fn paint_thumbnails(
        &self,
        id: NodeId,
        origin: Point,
        canvas: &mut Canvas,
        clip: Rect,
    ) -> Result<()> {
        let s = *self
            .thumbnail_styles
            .get(&id)
            .ok_or("thumbnail style missing")?;
        let local = |r: Rect| nk_render::offset(r, (-origin.x, -origin.y));
        let viewport = local(self.nodes[&id].bounds);
        canvas.clip(clip);
        canvas.clip(viewport);
        for child in self.nodes[&id].children.iter().copied() {
            if self.is_hidden(child) {
                continue;
            }
            let r = local(self.nodes[&child].bounds);
            if !intersects(r, viewport) {
                continue;
            }
            canvas.rounded_rect(r, s.radius as f64, s.background);
            let edge = s.padding + s.border;
            self.paint_image(
                child,
                Rect {
                    x: r.x + edge,
                    y: r.y + edge,
                    width: s.picture.width,
                    height: s.picture.height,
                },
                canvas,
                viewport,
            )?;
            let border = if !self.available(child) {
                s.idle_border
            } else if self.nodes[&child].kind == (Kind::Choice { checked: true }) {
                s.selected_border
            } else if self.hovered == Some(child) {
                s.hover_border
            } else {
                s.idle_border
            };
            canvas.rounded_ring(r, s.radius as f64, s.border as f64, border);
            if self.focus_visible && self.focused == Some(child) {
                let (focus, radius) = self.choice_focus_shape(child);
                canvas.rounded_ring(
                    local(focus),
                    radius as f64,
                    self.metrics.focus_width as f64,
                    s.selected_border,
                );
            }
        }
        canvas.pop_clip();
        canvas.pop_clip();
        Ok(())
    }
}
