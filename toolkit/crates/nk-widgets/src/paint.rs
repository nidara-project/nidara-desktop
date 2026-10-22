// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::*;
use nk_render::{Canvas, Color};
/// Resolved exported tokens; no colour defaults live in the widget crate.
#[derive(Clone, Copy)]
pub struct Palette {
    pub background: Color,
    pub surface: Color,
    pub text: Color,
    pub disabled: Color,
    pub selected: Color,
    pub accent: Color,
    pub track: Color,
    pub thumb: Color,
    pub focus: Color,
    pub separator: Color,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Content,
    Sidebar,
    TitleBar,
}
impl Tree {
    /// One silhouette for selection, hover and keyboard focus; never changes hit bounds.
    pub(crate) fn highlight_shape(&self, id: NodeId) -> (Rect, f32) {
        let n = &self.nodes[&id];
        let mut bounds = n.bounds;
        let radius = match n.kind {
            Kind::Page { .. } => {
                let inset = self
                    .metrics
                    .highlight_inset
                    .min(bounds.width.min(bounds.height) / 2.);
                bounds.x += inset;
                bounds.y += inset;
                bounds.width -= 2. * inset;
                bounds.height -= 2. * inset;
                self.metrics.radius
            }
            Kind::Button => match n.button_shape {
                ButtonShape::Rounded => self.metrics.radius,
                ButtonShape::Capsule => bounds.height / 2.,
            },
            Kind::Switch { .. } => bounds.height / 2.,
            Kind::Choice { .. } => return self.choice_shape(id),
            Kind::Slider { .. } | Kind::Spin { .. } => return self.range_shape(id),
            _ => 0.,
        };
        (bounds, radius)
    }

    pub(crate) fn list_separators(&self, parent: NodeId) -> Vec<Rect> {
        let children: Vec<_> = self.nodes[&parent]
            .children
            .iter()
            .copied()
            .filter(|id| {
                !self.is_hidden(*id) && matches!(self.nodes[id].kind, Kind::Page { .. } | Kind::Row)
            })
            .collect();
        children
            .windows(2)
            .filter_map(|pair| {
                let highlighted = |id: NodeId| {
                    self.hovered == Some(id)
                        || matches!(self.nodes[&id].kind, Kind::Page { selected: true })
                };
                if pair.iter().any(|id| highlighted(*id)) {
                    return None;
                }
                let a = &self.nodes[&pair[0]];
                let b = &self.nodes[&pair[1]];
                let text_x = a
                    .children
                    .iter()
                    .map(|id| &self.nodes[id])
                    .find(|n| n.kind == Kind::Label && !n.hidden)
                    .map_or(a.bounds.x + self.metrics.padding, |n| n.bounds.x);
                Some(Rect {
                    x: text_x,
                    y: (a.bounds.y + a.bounds.height + b.bounds.y) / 2.,
                    width: (a.bounds.x + a.bounds.width - self.metrics.padding - text_x).max(0.),
                    height: 0.,
                })
            })
            .collect()
    }
    /// Paint the retained Layouts measured by layout(). Independent pane buffers
    /// have local coordinates; D5 paints both panes into the root with an opaque base.
    pub fn paint(
        &self,
        frame: nk_wayland::Frame,
        surface: Surface,
        palette: Palette,
    ) -> Result<Vec<u8>> {
        self.paint_with_titlebar(frame, surface, palette, None)
    }
    pub(crate) fn paint_with_titlebar(
        &self,
        frame: nk_wayland::Frame,
        surface: Surface,
        palette: Palette,
        title_style: Option<&crate::window::TitlebarStyle>,
    ) -> Result<Vec<u8>> {
        let mut canvas = Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
        if surface == Surface::Content && !frame.material {
            canvas.rect(self.nodes[&self.root].bounds, opaque(palette.background));
        }
        if surface == Surface::Content {
            // D7 permits pixels underneath glass; D5 clips at the insets.
            let clip = if self.layered {
                self.nodes[&self.root].bounds
            } else {
                self.content_viewport()
            };
            canvas.clip(clip);
            for &id in &self.nodes[&self.root].children {
                if self.nodes[&id].kind == Kind::Scroll {
                    self.paint_node(id, Point::default(), &mut canvas, palette, clip)?;
                }
            }
            canvas.pop_clip();
        }
        if surface == Surface::TitleBar
            && self.layered
            && let Some(style) = title_style
        {
            // Fade only the window background. The compositor supplies the graded blur.
            for row in 0..frame.pixel_height {
                let y = row as f32 / frame.scale as f32;
                let mut color = opaque(palette.background);
                color.components[3] = if style.opaque {
                    1.
                } else {
                    style.background_opacity * (1. - y / frame.height as f32)
                };
                canvas.rect(
                    Rect {
                        x: 0.,
                        y,
                        width: frame.width as f32,
                        height: 1. / frame.scale as f32,
                    },
                    color,
                );
            }
        }
        if surface != Surface::Content || !self.layered {
            let panes = match surface {
                Surface::Content => vec![Kind::Sidebar, Kind::TitleBar],
                Surface::Sidebar => vec![Kind::Sidebar],
                Surface::TitleBar => vec![Kind::TitleBar],
            };
            for kind in panes {
                if let Some((&id, n)) = self.nodes.iter().find(|(_, n)| n.kind == kind && !n.hidden)
                {
                    let origin = if surface == Surface::Content {
                        Point::default()
                    } else {
                        Point {
                            x: n.bounds.x,
                            y: n.bounds.y,
                        }
                    };
                    if !self.layered {
                        canvas.rounded_rect(
                            local(n.bounds, origin),
                            if kind == Kind::Sidebar {
                                self.sidebar_radius as f64
                            } else {
                                0.
                            },
                            opaque(palette.background),
                        );
                    }
                    if kind == Kind::Sidebar {
                        canvas
                            .clip_rounded_rect(local(n.bounds, origin), self.sidebar_radius as f64);
                    }
                    self.paint_node(
                        id,
                        origin,
                        &mut canvas,
                        palette,
                        Rect {
                            x: 0.,
                            y: 0.,
                            width: frame.width as f32,
                            height: frame.height as f32,
                        },
                    )?;
                    if kind == Kind::Sidebar {
                        canvas.pop_clip();
                    }
                }
            }
        }
        Ok(canvas.finish())
    }
    fn paint_node(
        &self,
        id: NodeId,
        origin: Point,
        canvas: &mut Canvas,
        palette: Palette,
        clip: Rect,
    ) -> Result<()> {
        if self.is_hidden(id) {
            return Ok(());
        }
        let n = &self.nodes[&id];
        let r = local(n.bounds, origin);
        if !intersects(r, clip) {
            return Ok(());
        }
        let m = self.metrics;
        let ink = if self.available(id) {
            palette.text
        } else {
            palette.disabled
        };
        let (highlight, radius) = self.highlight_shape(id);
        let highlight = local(highlight, origin);
        match n.kind {
            Kind::Group => {
                // The header labels the card from outside it, as NidaraList does.
                let mut card = r;
                if let Some(header) = n
                    .children
                    .iter()
                    .map(|id| &self.nodes[id])
                    .find(|n| n.kind == Kind::Label && !n.hidden)
                {
                    let top = header.bounds.y - origin.y + header.bounds.height + m.gap;
                    card.y = top;
                    card.height = (r.y + r.height - top).max(0.);
                }
                // The footer explains the card from under it, outside it.
                if let Some(footer) = n
                    .children
                    .iter()
                    .map(|id| &self.nodes[id])
                    .find(|n| n.kind == Kind::Footer && !n.hidden)
                {
                    let gap = self.row_text()?.footer_gap;
                    let bottom = footer.bounds.y - origin.y - gap;
                    card.height = (bottom - card.y).max(0.);
                }
                canvas.rounded_rect(card, m.group_radius as f64, palette.surface);
            }
            Kind::Page { selected: true } => {
                canvas.rounded_rect(highlight, radius as f64, palette.selected)
            }
            Kind::Button => canvas.rounded_rect(highlight, radius as f64, palette.surface),
            Kind::Choices { .. } => self.paint_choices(id, r, origin, canvas, palette),
            Kind::Slider { .. } | Kind::Spin { .. } | Kind::Fields => {
                self.paint_range(id, r, origin, canvas, palette)?
            }
            Kind::Switch { checked } => {
                self.paint_switch(r, checked, self.available(id), canvas)?
            }
            Kind::Disclosure { expanded } => self.paint_disclosure(r, expanded, ink, canvas)?,
            _ => {}
        }
        if self.hovered == Some(id)
            && self.available(id)
            && n.kind.focusable()
            && !matches!(n.kind, Kind::Page { selected: true })
            // A sample shows its hover as its ring (paint_choices).
            && self.choice_kind(id) != Some(ChoiceKind::Swatch)
        {
            let mut hover = palette.text;
            hover.components[3] = m.hover_opacity;
            canvas.rounded_rect(highlight, radius as f64, hover);
        }
        if let Some(layout) = &n.layout
            && matches!(
                n.kind,
                Kind::Label
                    | Kind::Subtitle
                    | Kind::Footer
                    | Kind::Page { .. }
                    | Kind::Button
                    | Kind::TitleBar
                    | Kind::Choice { .. }
            )
        {
            // A second line and a footer are dimmer than the label, unless unavailable.
            let ink = match (n.kind, self.available(id)) {
                (Kind::Subtitle, true) => self.row_text()?.subtitle,
                (Kind::Footer, true) => self.row_text()?.footer,
                _ => ink,
            };
            let padding = if matches!(n.kind, Kind::Button | Kind::Page { .. } | Kind::TitleBar) {
                if n.kind == Kind::TitleBar {
                    m.padding
                        + self.title_leading_controls()
                        + n.children
                            .iter()
                            .filter(|id| {
                                !self.is_hidden(**id)
                                    && !self.window_buttons.is_some_and(|ids| ids.contains(id))
                            })
                            .map(|id| self.nodes[id].measured.width + m.gap)
                            .sum::<f32>()
                } else {
                    m.padding
                }
            } else {
                0.
            };
            // A segment centres its text; everything else starts at its padding.
            let x = if matches!(n.kind, Kind::Choice { .. }) {
                r.x + (r.width - layout.measured_size().width) / 2.
            } else {
                r.x + padding
            };
            canvas.layout(
                layout,
                (x, r.y + (r.height - layout.measured_size().height) / 2.),
                self.choice_ink(id, ink),
            )?;
        }
        if self.focus_visible && self.focused == Some(id) {
            let (highlight, radius) = if matches!(n.kind, Kind::Choice { .. }) {
                let (ring, radius) = self.choice_focus_shape(id);
                (local(ring, origin), radius)
            } else {
                (highlight, radius)
            };
            canvas.rounded_ring(
                highlight,
                radius as f64,
                m.focus_width as f64,
                palette.focus,
            );
        }
        if n.kind == Kind::Sidebar {
            let viewport = if self.layered {
                Rect {
                    x: 0.,
                    y: self.content_viewport().y,
                    width: r.width,
                    height: (r.height - self.content_viewport().y).max(0.),
                }
            } else {
                local(self.sidebar_viewport(), origin)
            };
            canvas.clip(viewport);
            for child in &n.children {
                self.paint_node(*child, origin, canvas, palette, viewport)?;
            }
            for separator in self.list_separators(id) {
                canvas.horizontal_rule(
                    local(separator, origin),
                    m.separator_width as f64,
                    palette.separator,
                );
            }
            canvas.pop_clip();
        } else {
            for child in &n.children {
                self.paint_node(*child, origin, canvas, palette, clip)?;
            }
            if n.kind == Kind::Group {
                for separator in self.list_separators(id) {
                    canvas.horizontal_rule(
                        local(separator, origin),
                        m.separator_width as f64,
                        palette.separator,
                    );
                }
            }
        }
        Ok(())
    }
}
fn local(mut r: Rect, origin: Point) -> Rect {
    r.x -= origin.x;
    r.y -= origin.y;
    r
}
fn opaque(mut c: Color) -> Color {
    c.components[3] = 1.;
    c
}
