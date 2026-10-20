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
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Surface {
    Content,
    Sidebar,
    TitleBar,
}
impl Tree {
    /// Paint the retained Layouts measured by layout(). Independent pane buffers
    /// have local coordinates; D5 paints both panes into the root with an opaque base.
    pub fn paint(
        &self,
        frame: nk_wayland::Frame,
        surface: Surface,
        palette: Palette,
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
                        canvas.rect(local(n.bounds, origin), opaque(palette.background));
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
                canvas.rounded_rect(card, m.group_radius as f64, palette.surface);
            }
            Kind::Page { selected: true } => {
                canvas.rounded_rect(r, m.radius as f64, palette.selected)
            }
            Kind::Button => canvas.rounded_rect(r, m.radius as f64, palette.surface),
            Kind::Switch { checked } => {
                canvas.rounded_rect(
                    r,
                    (r.height / 2.) as f64,
                    if checked {
                        palette.accent
                    } else {
                        palette.track
                    },
                );
                let pad = (r.height * 0.1).max(1.);
                let diameter = r.height - 2. * pad;
                canvas.rounded_rect(
                    Rect {
                        x: if checked {
                            r.x + r.width - pad - diameter
                        } else {
                            r.x + pad
                        },
                        y: r.y + pad,
                        width: diameter,
                        height: diameter,
                    },
                    (diameter / 2.) as f64,
                    palette.thumb,
                );
            }
            _ => {}
        }
        if let Some(layout) = &n.layout
            && !matches!(n.kind, Kind::Switch { .. })
        {
            let padding = if matches!(n.kind, Kind::Button | Kind::Page { .. } | Kind::TitleBar) {
                if n.kind == Kind::TitleBar {
                    m.padding
                        + n.children
                            .iter()
                            .filter(|id| !self.is_hidden(**id))
                            .map(|id| self.nodes[id].measured.width + m.gap)
                            .sum::<f32>()
                } else {
                    m.padding
                }
            } else {
                0.
            };
            canvas.layout(
                layout,
                (
                    r.x + padding,
                    r.y + (r.height - layout.measured_size().height) / 2.,
                ),
                ink,
            )?;
        }
        if self.focused == Some(id) {
            // An inset ring, no change in hit geometry.
            let line = 1.;
            canvas.rect(
                Rect {
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: line,
                },
                palette.focus,
            );
            canvas.rect(
                Rect {
                    x: r.x,
                    y: r.y + r.height - line,
                    width: r.width,
                    height: line,
                },
                palette.focus,
            );
            canvas.rect(
                Rect {
                    x: r.x,
                    y: r.y,
                    width: line,
                    height: r.height,
                },
                palette.focus,
            );
            canvas.rect(
                Rect {
                    x: r.x + r.width - line,
                    y: r.y,
                    width: line,
                    height: r.height,
                },
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
            canvas.pop_clip();
        } else {
            for child in &n.children {
                self.paint_node(*child, origin, canvas, palette, clip)?;
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
