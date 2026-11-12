// SPDX-License-Identifier: LGPL-3.0-or-later
//! An application window's frame (VIEW.md §13.2), the format Settings defined: a glass
//! sidebar floating at the header's inset, the content scrolling to the window's edges and
//! under a header band, the band's blur graded by Hyalo over it, the page's title in the
//! band, and room for Hyalo's window controls on the side the user chose. Every measure is
//! the exported `header` component's (`toolkit/tokens/header.json`) or the window layout's;
//! an app passes only its sidebar, its content and its title.
use crate::view::{Align, Corner, Node};
use nk_platform::{exports::Exports, portal::Appearance};
use nk_wayland::{ControlsLayout, ControlsSide};

/// The frame's measures in one appearance.
#[derive(Clone, Debug)]
pub struct FrameStyle {
    /// The header band's height, where the title and the window controls sit.
    pub band: f64,
    /// The sidebar's distance from the window's edges.
    pub inset: f64,
    /// The sidebar's room, its inset included (`WINDOW_LAYOUT.sidebar`).
    pub sidebar: f64,
    pub sidebar_radius: f64,
    /// Between the band and the content's first row, at rest.
    pub content_gap: f64,
    /// The window controls' distance from the window's edge (`capsule.windowInset`).
    pub controls_inset: f64,
    /// From the title to what follows it in the band.
    pub title_gap: f64,
    /// The graded blur under the band and the fade of the window's background over it.
    pub blur: nk_wayland::Blur,
    pub titlebar: f64,
    pub curve: Vec<f64>,
    pub background_opacity: f64,
    pub opaque: bool,
    /// Two presses on the band within this toggle maximised, as on any title bar.
    pub double_click_ms: u32,
}

fn number(v: &serde_json::Value, what: &str) -> Result<f64, String> {
    v.as_f64()
        .filter(|v| v.is_finite() && *v >= 0.)
        .ok_or_else(|| format!("components.json: no {what}"))
}

impl FrameStyle {
    pub fn load(e: &Exports, a: &Appearance) -> Result<Self, String> {
        let set = e.tokens(a)?;
        let h = &set.components["header"];
        let reduce = a.reduce_transparency;
        let blur = &e.glass["blur"]["panel"];
        let band = number(&h["band"], "header.band")?;
        let curve = h["titlebar"]["curve"]
            .as_array()
            .ok_or("components.json: no header.titlebar.curve")?
            .iter()
            .map(|v| {
                v.as_f64()
                    .filter(|v| (0. ..=1.).contains(v))
                    .ok_or("components.json: header.titlebar.curve out of 0..1".to_string())
            })
            .collect::<Result<Vec<_>, _>>()?;
        if curve.len() < 2 {
            return Err("components.json: header.titlebar.curve needs two steps".into());
        }
        let style = Self {
            band,
            inset: number(&h["inset"], "header.inset")?,
            sidebar: number(
                &e.statics["ts"]["WINDOW_LAYOUT"]["sidebar"],
                "WINDOW_LAYOUT.sidebar",
            )?,
            sidebar_radius: number(&h["sidebarRadius"], "header.sidebarRadius")?,
            content_gap: number(&h["contentTopGap"], "header.contentTopGap")?,
            controls_inset: number(
                &set.components["capsule"]["windowInset"],
                "capsule.windowInset",
            )?,
            title_gap: number(&h["titleGap"], "header.titleGap")?,
            blur: nk_wayland::Blur {
                size: number(&blur["size"], "glass blur.panel.size")?,
                passes: if reduce {
                    0
                } else {
                    blur["passes"]
                        .as_u64()
                        .and_then(|v| v.try_into().ok())
                        .ok_or("glass.json: no blur.panel.passes")?
                },
            },
            titlebar: band
                + if reduce {
                    0.
                } else {
                    number(&h["titlebar"]["extraHeight"], "header.titlebar.extraHeight")?
                },
            curve,
            background_opacity: if reduce {
                1.
            } else {
                number(
                    &h["titlebar"]["backgroundOpacity"],
                    "header.titlebar.backgroundOpacity",
                )?
                .min(1.)
            },
            opaque: reduce,
            double_click_ms: h["titlebar"]["doubleClickMs"]
                .as_u64()
                .filter(|v| *v > 0)
                .and_then(|v| v.try_into().ok())
                .ok_or("components.json: no header.titlebar.doubleClickMs")?,
        };
        if 2. * style.inset >= style.sidebar || style.band < style.inset {
            return Err("components.json: the header's inset does not fit its sidebar".into());
        }
        Ok(style)
    }

    /// The window's view at `size`: `sidebar` in the floating glass sidebar, under the room
    /// its top keeps for the band; `content` in the scroll region `frame/content`, which
    /// reaches the window's edges and starts its rows below the band.
    pub fn view(&self, size: (f64, f64), sidebar: Node, content: Node) -> Node {
        let empty = |key: &str| Node::column(key, vec![]);
        let pane = Node::pane(
            "frame/side",
            Corner::Fixed(self.sidebar_radius.round() as u32),
            Node::column(
                "frame/side/col",
                vec![
                    empty("frame/side/top").height(self.band - self.inset),
                    sidebar.grow(),
                ],
            ),
        )
        .width(self.sidebar - 2. * self.inset)
        .height((size.1 - 2. * self.inset).max(0.));
        let scroll = Node::scroll(
            "frame/content",
            Node::column(
                "frame/content/col",
                vec![
                    empty("frame/content/top").height(self.band + self.content_gap),
                    content,
                ],
            ),
        )
        .grow();
        Node::overlay(
            "frame",
            Node::row(
                "frame/row",
                vec![empty("frame/side/room").width(self.sidebar), scroll],
            ),
        )
        .layer_at(self.inset, self.inset, pane)
    }

    /// Where the header band's layer lies in the window: over the content, from the
    /// sidebar's room to the window's right edge, as tall as its graded blur.
    pub fn header_rect(&self, size: (f64, f64)) -> [f64; 4] {
        [
            self.sidebar,
            0.,
            (size.0 - self.sidebar).max(1.),
            self.titlebar.min(size.1).max(1.),
        ]
    }

    /// The band's view, in the header layer's coordinates (`origin` = 0), or in the
    /// window's when it is drawn without layers (`origin` = the sidebar's room): `title`
    /// after `lead`, centred in the band, and the window controls' room kept on the right
    /// when they are there.
    pub fn header(
        &self,
        size: (f64, f64),
        origin: f64,
        lead: f64,
        controls: Option<ControlsLayout>,
        title: Node,
    ) -> Node {
        let empty = |key: &str| Node::column(key, vec![]);
        let right = match controls {
            Some(c) if c.side == ControlsSide::Right => {
                self.controls_inset + c.width + self.title_gap
            }
            _ => lead,
        };
        Node::row(
            "header",
            vec![
                empty("header/lead").width(origin + lead),
                title.grow(),
                empty("header/end").width(right),
            ],
        )
        .align(Align::Center)
        .width(size.0)
        .height(self.band)
    }

    /// Where Hyalo's window controls go, in window coordinates: centred in the band, at the
    /// inset from the edge the user's layout puts them on (over the sidebar's top when it is
    /// the left).
    pub fn controls_at(&self, size: (f64, f64), c: ControlsLayout) -> (f64, f64) {
        let y = ((self.band - c.height) / 2.).max(0.);
        let x = match c.side {
            ControlsSide::Left => self.controls_inset,
            ControlsSide::Right => (size.0 - self.controls_inset - c.width).max(0.),
        };
        (x, y)
    }

    /// Whether a press at `(x, y)` in the window lands on the band where nothing else is:
    /// the sidebar's top, which moves the window as the rest of the band does.
    pub fn on_band(&self, x: f64, y: f64) -> bool {
        x < self.sidebar && y < self.band
    }

    /// The header layer's graded blur: one pane per step of the curve, their shared edges
    /// on physical pixels so no sharp line shows between two bands.
    pub fn graded(&self, width: f64, height: f64, scale: f64) -> Vec<nk_wayland::GradedPane> {
        let count = self.curve.len() - 1;
        let edge = |i: usize| {
            if i == count {
                height
            } else {
                (height * i as f64 / count as f64 * scale).round() / scale
            }
        };
        self.curve
            .windows(2)
            .enumerate()
            .map(|(i, v)| nk_wayland::GradedPane {
                pane: nk_wayland::Pane {
                    x: 0.,
                    y: edge(i),
                    width,
                    height: edge(i + 1) - edge(i),
                    radius: 0.,
                    exponent: 2.,
                    pointer: None,
                },
                top: v[0],
                bottom: v[1],
            })
            .collect()
    }

    /// The window's background faded over the band, top to bottom: what keeps the title
    /// legible over the content scrolled under it. The blur is Hyalo's; this is content.
    pub fn paint_fade(&self, canvas: &mut nk_render::Canvas, r: [f64; 4], background: [f64; 3]) {
        let scale = canvas.scale();
        let rows = (r[3] * scale).ceil() as u32;
        for row in 0..rows {
            let y = row as f64 / scale;
            let alpha = if self.opaque {
                1.
            } else {
                self.background_opacity * (1. - y / r[3])
            };
            canvas.rect(
                nk_text::Rect {
                    x: r[0] as f32,
                    y: (r[1] + y) as f32,
                    width: r[2] as f32,
                    height: (1. / scale) as f32,
                },
                nk_render::Color::new([
                    background[0] as f32,
                    background[1] as f32,
                    background[2] as f32,
                    alpha as f32,
                ]),
            );
        }
    }
}
