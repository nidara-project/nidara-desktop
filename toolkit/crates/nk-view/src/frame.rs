// SPDX-License-Identifier: LGPL-3.0-or-later
//! An application window's frame (VIEW.md §13.2), the format Settings defined: a glass
//! sidebar floating at the header's inset, the content scrolling to the window's edges and
//! under a header band, the band's blur graded by Hyalo over it, the page's title in the
//! band, and room for Hyalo's window controls on the side the user chose. Every measure is
//! the exported `header` component's (`toolkit/tokens/header.json`) or the window layout's;
//! an app passes only its sidebar, its content and its title.
//!
//! The band has the sidebar's toggle and back and forward, as Settings' header: glass
//! buttons in a layer of their own over the blur, so Hyalo draws their hover and press. The
//! sidebar slides in and out with the kit's motion, and below the width the window layout
//! gives a sidebar and a page it closes and opens over the content instead (`Sidebar`).
use crate::tokens::Motion;
use crate::view::{Align, Corner, Ink, Justify, Node, Role};
use nk_platform::{exports::Exports, portal::Appearance};
use nk_wayland::{ControlsLayout, ControlsSide};
use std::time::Instant;

/// The band's actions, as `Activated::action` names them.
pub const SIDEBAR: &str = "frame:sidebar";
pub const BACK: &str = "frame:back";
pub const FORWARD: &str = "frame:forward";

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
    /// The sidebar's toggle: its side and its glyph.
    pub button: f64,
    pub icon: f64,
    /// Back and forward: one capsule, its buttons, edge, gap, height and glyph.
    pub nav_button: f64,
    pub nav_edge: f64,
    pub nav_gap: f64,
    pub nav_height: f64,
    pub nav_icon: f64,
    /// Between the window controls and what the band puts next to them.
    pub gap: f64,
    /// The page's room the window layout keeps beside an open sidebar; narrower, the
    /// sidebar opens over the content (`WINDOW_LAYOUT.content`).
    pub content: f64,
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
            button: number(&h["button"], "header.button")?,
            icon: number(&h["icon"], "header.icon")?,
            nav_button: number(&h["navigation"]["button"], "header.navigation.button")?,
            nav_edge: number(&h["navigation"]["edge"], "header.navigation.edge")?,
            nav_gap: number(&h["navigation"]["gap"], "header.navigation.gap")?,
            nav_height: number(&h["navigation"]["height"], "header.navigation.height")?,
            nav_icon: number(&h["navigation"]["icon"], "header.navigation.icon")?,
            gap: number(&h["search"]["gap"], "header.search.gap")?,
            content: number(
                &e.statics["ts"]["WINDOW_LAYOUT"]["content"],
                "WINDOW_LAYOUT.content",
            )?,
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

    /// What the open sidebar takes from the page: all of its room while the window is wide
    /// enough for both, nothing when it opens over the content.
    pub fn room(&self, shown: f64, narrow: bool) -> f64 {
        if narrow {
            0.
        } else {
            self.sidebar * shown.clamp(0., 1.)
        }
    }

    /// The window's view at `size`: `sidebar` in the floating glass sidebar, under the room
    /// its top keeps for the band, `shown` of the way in (`Sidebar::shown`); `content` in
    /// the scroll region `frame/content`, which reaches the window's edges and starts its
    /// rows below the band.
    pub fn view(
        &self,
        size: (f64, f64),
        shown: f64,
        narrow: bool,
        sidebar: Node,
        content: Node,
    ) -> Node {
        let empty = |key: &str| Node::column(key, vec![]);
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
        let frame = Node::overlay(
            "frame",
            Node::row(
                "frame/row",
                vec![
                    empty("frame/side/room").width(self.room(shown, narrow)),
                    scroll,
                ],
            ),
        );
        if shown <= 0. {
            // Closed: no glass left outside the window.
            return frame;
        }
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
        frame.layer_at(self.inset - (1. - shown) * self.sidebar, self.inset, pane)
    }

    /// Where the band's blur lies in the window: over the content, from the sidebar's room
    /// to the window's right edge, as tall as its graded blur. It takes no pointer.
    pub fn header_rect(&self, size: (f64, f64), room: f64) -> [f64; 4] {
        [
            room,
            0.,
            (size.0 - room).max(1.),
            self.titlebar.min(size.1).max(1.),
        ]
    }

    /// The band's buttons and title, across the window's top: in a layer of its own over the
    /// blur, or in the window when there are no layers (D5). The sidebar's toggle sits at
    /// the inset (after the window controls when they are on the left), back and forward
    /// at the page's edge, the title after them, clear of the controls on the right.
    pub fn band(
        &self,
        size: (f64, f64),
        room: f64,
        controls: Option<ControlsLayout>,
        band: Band<'_>,
    ) -> Node {
        let empty = |key: &str| Node::column(key, vec![]);
        let at = controls.map(|c| (c, self.controls_at(size, c)));
        let tx = match at {
            Some((c, (cx, _))) if c.side == ControlsSide::Left => cx + c.width + self.gap,
            _ => self.inset,
        };
        let nx = (room + self.inset).max(tx + self.button + self.inset);
        let nw = 2. * self.nav_edge + 2. * self.nav_button + self.nav_gap;
        let title_x = nx + nw + self.title_gap;
        let right = match at {
            Some((c, (cx, _))) if c.side == ControlsSide::Right => cx - self.gap,
            _ => size.0 - self.inset,
        };
        let glyph = |key: String, name: &str, px: f64, side: f64, enabled: bool| {
            Node::row(
                format!("{key}/row"),
                vec![Node::icon(format!("{key}/icon"), name, px).ink(if enabled {
                    Ink::Primary
                } else {
                    Ink::Dim
                })],
            )
            .justify(Justify::Center)
            .align(Align::Center)
            .width(side)
            .height(side)
        };
        let toggle = Node::pane(
            "band/sidebar/glass",
            Corner::Pill,
            Node::control(
                "band/sidebar",
                band.sidebar,
                SIDEBAR,
                glyph(
                    "band/sidebar".into(),
                    "nd-sidebar-show",
                    self.icon,
                    self.button,
                    true,
                ),
            )
            .role(Role::Button)
            .corner(Corner::Pill),
        );
        let nav_button = |key: &str, label: &str, action: &str, name: &str, enabled: bool| {
            Node::control(
                key,
                label,
                action,
                glyph(key.into(), name, self.nav_icon, self.nav_button, enabled),
            )
            .corner(Corner::Pill)
            .enabled(enabled)
        };
        let nav = Node::pane(
            "band/nav/glass",
            Corner::Pill,
            Node::row(
                "band/nav",
                vec![
                    empty("band/nav/start").width(self.nav_edge),
                    nav_button("band/back", band.back, BACK, "nd-pan-start", band.can_back),
                    empty("band/nav/gap").width(self.nav_gap),
                    nav_button(
                        "band/forward",
                        band.forward,
                        FORWARD,
                        "nd-pan-end",
                        band.can_forward,
                    ),
                    empty("band/nav/end").width(self.nav_edge),
                ],
            )
            .align(Align::Center)
            .height(self.nav_height),
        );
        let title = Node::row("band/title", vec![band.title.grow()])
            .align(Align::Center)
            .width((right - title_x).max(0.))
            .height(self.band);
        Node::overlay("band", empty("band/base").width(size.0).height(self.band))
            .layer_at(tx, self.inset, toggle)
            .layer_at(nx, self.inset, nav)
            .layer_at(title_x, 0., title)
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

/// What the band says and can do: the page's title, the buttons' names for readers, and
/// whether back and forward lead anywhere.
pub struct Band<'a> {
    pub title: Node,
    pub sidebar: &'a str,
    pub back: &'a str,
    pub forward: &'a str,
    pub can_back: bool,
    pub can_forward: bool,
}

/// The sidebar's state: open or closed, whether the window is too narrow to keep it beside
/// the page, and its slide between the two.
#[derive(Clone, Debug, Default)]
pub struct Sidebar {
    open: bool,
    narrow: Option<bool>,
    from: f64,
    start: Option<Instant>,
}

impl Sidebar {
    /// Follows the window's width: crossing the layout's width for a sidebar and a page,
    /// it closes (narrower) or opens (wider), at once. True when that changed anything.
    pub fn adapt(&mut self, width: f64, style: &FrameStyle) -> bool {
        let narrow = width < style.sidebar + style.content;
        if self.narrow == Some(narrow) {
            return false;
        }
        self.narrow = Some(narrow);
        self.open = !narrow;
        self.start = None;
        true
    }
    /// Opens or closes it, sliding with the kit's motion unless motion is reduced.
    pub fn set(&mut self, open: bool, now: Instant, motion: &Motion, reduced: bool) {
        if open == self.open {
            return;
        }
        self.from = self.shown(now, motion);
        self.open = open;
        self.start = (!reduced).then_some(now);
    }
    pub fn open(&self) -> bool {
        self.open
    }
    pub fn narrow(&self) -> bool {
        self.narrow.unwrap_or(false)
    }
    /// Open over the content, as it is in a narrow window: Escape or a choice closes it.
    pub fn over_content(&self) -> bool {
        self.narrow() && self.open
    }
    /// How far in it is, 0 closed to 1 open, eased.
    pub fn shown(&self, now: Instant, motion: &Motion) -> f64 {
        let target = if self.open { 1. } else { 0. };
        let Some(start) = self.start else {
            return target;
        };
        let t = now.duration_since(start).as_secs_f64() / motion.base.as_secs_f64().max(1e-3);
        if t >= 1. {
            target
        } else {
            self.from + (target - self.from) * motion.ease.at(t)
        }
    }
    pub fn animating(&self, now: Instant, motion: &Motion) -> bool {
        self.start
            .is_some_and(|s| now.duration_since(s) < motion.base)
    }
}
