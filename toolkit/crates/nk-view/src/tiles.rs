// SPDX-License-Identifier: LGPL-3.0-or-later
//! The kit's tiles (#1156 step 4): a glass pane on the tile grid, the whole of it one control —
//! the Control Center's, and any surface's that lays controls on a grid (a widget, a player).
//! `toolkit/tokens/tile.json` holds every measure; the surface says only what a tile is.
use crate::{
    Align, Button, Column, Corner, Image, Ink, Justify, Key, Label, Node, Overlay, Padding, Pane,
    Role, Row, Slider, SliderRange, Slot, Space, Spacer, prelude::*, tokens::TileStyle,
};
use nk_text::TextStyle;

/// A tile's size on the grid, in cells: 1×1, 2×1, 2×2, 1×2 and 4×1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TileSize {
    Single,
    Wide,
    Square,
    Tall,
    Full,
}

impl TileSize {
    /// Its corner: a 2×2 the tokens' square corner, a 4×1 `full` (the surface's wide corner),
    /// the rest circles and capsules.
    pub fn corner(self, style: &TileStyle, full: f64) -> Corner {
        match self {
            Self::Square => Corner::Fixed(style.corner_square.round() as u32),
            Self::Full => Corner::Fixed(full.round() as u32),
            _ => Corner::Pill,
        }
    }
}

/// One action of a picture tile: a glyph button of its own inside the tile.
#[derive(Clone, Debug)]
pub struct TileAction {
    pub key: Key,
    /// What it reports when activated ("" for a surface that answers by key).
    pub action: String,
    pub icon: String,
    pub name: String,
    pub enabled: bool,
    /// The one a 2×1 shows (a player's play); a 2×2 shows all.
    pub primary: bool,
}

/// What a tile shows.
#[derive(Clone, Debug)]
pub enum TileContent {
    /// A glyph in its middle (a 1×1).
    Icon(String),
    /// A circle with its glyph, then the title over its subtitle. `toggle`: the badge is its
    /// own toggle (its key), else only a picture of the state; `lit` its state shown.
    Badge {
        icon: String,
        title: String,
        subtitle: String,
        toggle: Option<Key>,
        lit: bool,
    },
    /// A picture (the slot `{id}/cover`, painted by the surface), title, subtitle and up to
    /// three actions — a player, a contact, a timer. A 1×1 is the picture alone.
    Picture {
        title: String,
        subtitle: String,
        actions: Vec<TileAction>,
    },
    /// What only its surface lays out (a battery, gauges), under the tile's control.
    Custom(Node),
}

/// A glass pane on the tile grid. Its pane's key is `p:{id}`, its parts' `{id}/…` (the slots a
/// surface paints: `{id}/cover`). With `control`, the whole tile is one button; `toggle` makes
/// it a toggle; `detail` adds the second action that opens its details, for keys and readers
/// only (the pointer's is the tile's own).
#[must_use]
pub struct Tile<'a> {
    id: String,
    size: TileSize,
    style: &'a TileStyle,
    base: &'a TextStyle,
    content: TileContent,
    control: Option<(Key, String)>,
    action: String,
    toggle: Option<Option<bool>>,
    detail: Option<Key>,
    full_corner: f64,
}

impl<'a> Tile<'a> {
    pub fn new(
        id: impl Into<String>,
        size: TileSize,
        content: TileContent,
        style: &'a TileStyle,
        base: &'a TextStyle,
    ) -> Self {
        Self {
            id: id.into(),
            size,
            style,
            base,
            content,
            control: None,
            action: String::new(),
            toggle: None,
            detail: None,
            full_corner: style.corner_square,
        }
    }
    /// The whole tile is the button `key`, its accessible name `name`.
    pub fn control(mut self, key: impl Into<Key>, name: impl Into<String>) -> Self {
        self.control = Some((key.into(), name.into()));
        self
    }
    /// What the tile's control reports when activated (none: a surface that answers by key).
    pub fn action(mut self, action: impl Into<String>) -> Self {
        self.action = action.into();
        self
    }
    /// The tile is a toggle, `on` or off, and shows it.
    pub fn toggle(mut self, on: bool) -> Self {
        self.toggle = Some(Some(on));
        self
    }
    /// The tile is a toggle whose state its badge shows (`TileContent::Badge`'s `lit`).
    pub fn toggle_in_badge(mut self) -> Self {
        self.toggle = Some(None);
        self
    }
    /// A second action, opening its details: keys and readers only.
    pub fn detail(mut self, key: impl Into<Key>) -> Self {
        self.detail = Some(key.into());
        self
    }
    /// The corner of a 4×1 (the surface's wide corner).
    pub fn full_corner(mut self, radius: f64) -> Self {
        self.full_corner = radius;
        self
    }
}

fn sized(base: &TextStyle, size: f32, weight: f32) -> TextStyle {
    let mut s = base.clone();
    s.size = size;
    s.weight = weight;
    s
}

fn strut(key: String, px: f64) -> Node {
    Slot::new(key, px).into()
}

/// A glyph of `size` centred in a box of `room`.
fn boxed(key: String, name: &str, size: f64, room: f64, ink: Ink) -> Node {
    Overlay::new(format!("{key}/box"), Slot::new(format!("{key}/room"), room))
        .layer(
            Align::Center,
            Align::Center,
            Padding::default(),
            Image::new(key, name, size).ink(ink),
        )
        .into()
}

fn centred(key: String, child: Node) -> Node {
    Column::new(key, vec![child])
        .justify(Justify::Center)
        .align(Align::Center)
        .into()
}

/// The keys-and-readers-only button over `base` that opens its details.
fn detail_layer(id: &str, corner: Corner, detail: Option<Key>, base: Node) -> Node {
    match detail {
        Some(key) => Overlay::new(format!("{id}/layers"), base)
            .layer(
                Align::Stretch,
                Align::Stretch,
                Padding::default(),
                Button::with_child(key, "", "", Spacer::new(format!("{id}/d")))
                    .corner(corner)
                    .keys_only(),
            )
            .into(),
        None => base,
    }
}

impl Tile<'_> {
    fn titles(&self, title: String, sub: String) -> Column {
        let (s, id) = (self.style, &self.id);
        let lines = if sub.is_empty() { 2 } else { 1 };
        let mut col: Vec<Node> = vec![
            Label::new(
                format!("{id}/title"),
                title,
                sized(self.base, s.title, s.title_weight),
            )
            .lines(lines)
            .into(),
        ];
        if !sub.is_empty() {
            col.push(
                Label::new(format!("{id}/sub"), sub, sized(self.base, s.subtitle, 400.))
                    .lines(1)
                    .ink(Ink::Secondary)
                    .into(),
            );
        }
        Column::new(format!("{id}/titles"), col)
            .justify(Justify::Center)
            .grow()
    }

    fn action_button(&self, a: &TileAction, room: f64) -> Node {
        let ink = if a.enabled { Ink::Primary } else { Ink::Dim };
        Button::with_child(
            a.key.clone(),
            a.name.clone(),
            a.action.clone(),
            boxed(
                format!("{}/glyph", a.key.0),
                &a.icon,
                self.style.action_glyph,
                room,
                ink,
            ),
        )
        .enabled(a.enabled)
        .into()
    }

    fn picture(&self, title: String, subtitle: String, actions: &[TileAction]) -> Node {
        let (s, id) = (self.style, &self.id);
        let k = |part: &str| format!("{id}/{part}");
        match self.size {
            TileSize::Single => Slot::new(k("cover"), s.cell).into(),
            TileSize::Wide | TileSize::Full => {
                let mut row = vec![
                    strut(k("lead"), s.picture_lead),
                    Slot::new(k("cover"), s.picture_wide).into(),
                    strut(k("gap"), s.picture_gap),
                    self.titles(title, subtitle).into(),
                ];
                if let Some(a) = actions.iter().find(|a| a.primary) {
                    row.push(strut(k("before"), s.picture_gap));
                    row.push(self.action_button(a, s.action_room_wide));
                }
                row.push(strut(k("end"), s.picture_lead));
                Row::new(k("row"), row).align(Align::Center).into()
            }
            TileSize::Square | TileSize::Tall => {
                let mut centre = sized(self.base, s.title, s.title_weight);
                centre.alignment = nk_text::Alignment::Center;
                let mut second = sized(self.base, s.subtitle, 400.);
                second.alignment = nk_text::Alignment::Center;
                let line = |part: &str, child: Node| -> Node {
                    Row::new(
                        k(part),
                        vec![
                            strut(k(&format!("{part}-l")), s.picture_side),
                            child.grow(),
                            strut(k(&format!("{part}-r")), s.picture_side),
                        ],
                    )
                    .into()
                };
                let mut col = vec![
                    Row::new(
                        k("art"),
                        vec![Slot::new(k("cover"), s.picture_square).into()],
                    )
                    .justify(Justify::Center)
                    .into(),
                    strut(k("under-art"), s.picture_between),
                    line(
                        "title-line",
                        Label::new(k("title"), title, centre).lines(2).into(),
                    ),
                    line(
                        "artist-line",
                        Label::new(k("artist"), subtitle, second)
                            .lines(1)
                            .ink(Ink::Secondary)
                            .into(),
                    ),
                ];
                if !actions.is_empty() {
                    col.push(strut(k("above-controls"), s.picture_between));
                    col.push(
                        Row::new(
                            k("controls"),
                            actions
                                .iter()
                                .map(|a| self.action_button(a, s.action_room_square))
                                .collect(),
                        )
                        .gap(Space::S4)
                        .justify(Justify::Center)
                        .into(),
                    );
                }
                Column::new(k("stack"), col).justify(Justify::Center).into()
            }
        }
    }

    fn badge(
        &self,
        icon: &str,
        title: String,
        sub: String,
        toggle: Option<Key>,
        lit: bool,
    ) -> Node {
        let (s, id) = (self.style, &self.id);
        let k = |part: &str| format!("{id}/{part}");
        let face = boxed(k("icon"), icon, s.icon, s.badge, Ink::Primary);
        let badge = match toggle {
            Some(key) => Button::with_child(key, "", "", face).role(Role::Toggle),
            // A badge that is only a picture of the state: no pointer, no Tab stop.
            None => Button::with_child(k("well"), "", "", face).enabled(false),
        }
        .surface()
        .on(lit);
        Row::new(
            k("row"),
            vec![
                strut(k("lead"), s.pad + s.badge_inset),
                badge.into(),
                strut(k("gap"), s.badge_gap),
                self.titles(title, sub).into(),
                strut(k("end"), s.pad),
            ],
        )
        .align(Align::Center)
        .into()
    }
}

impl From<Tile<'_>> for Node {
    fn from(t: Tile<'_>) -> Node {
        let corner = t.size.corner(t.style, t.full_corner);
        let body: Node = match &t.content {
            TileContent::Icon(name) => centred(
                format!("{}/centre", t.id),
                Image::new(format!("{}/icon", t.id), name.as_str(), t.style.icon).into(),
            ),
            TileContent::Badge {
                icon,
                title,
                subtitle,
                toggle,
                lit,
            } => t.badge(icon, title.clone(), subtitle.clone(), toggle.clone(), *lit),
            TileContent::Picture {
                title,
                subtitle,
                actions,
            } => t.picture(title.clone(), subtitle.clone(), actions),
            TileContent::Custom(node) => node.clone(),
        };
        let content = match t.control {
            Some((key, name)) => {
                let mut b = Button::with_child(key, name, t.action, body).corner(corner);
                match t.toggle {
                    Some(Some(on)) => b = b.role(Role::Toggle).on(on),
                    Some(None) => b = b.role(Role::Toggle),
                    None => {}
                }
                detail_layer(&t.id, corner, t.detail, b.into())
            }
            None => detail_layer(&t.id, corner, t.detail, body),
        };
        Pane::new(format!("p:{}", t.id), corner, content).into()
    }
}

/// A tile that is a slider: a 4×1 with its low and high icons and its value (the slot
/// `{id}/value`, painted by the surface), or a 1×2 filled from the bottom with its value at the
/// top and its icon at the bottom. `detail`: its details — the pointer's on a 4×1 (the tile
/// around the slider), keys and readers only on a 1×2.
#[must_use]
pub struct SliderTile<'a> {
    id: String,
    size: TileSize,
    slider: Key,
    range: SliderRange,
    icons: (String, f64, String),
    detail: Option<(Key, String)>,
    name: String,
    action: String,
    style: &'a TileStyle,
    full_corner: f64,
}

impl<'a> SliderTile<'a> {
    /// `size` is `Full` or `Tall`; `icons`: the low one and its size, the high one (a 1×2 shows
    /// the high one).
    pub fn new(
        id: impl Into<String>,
        size: TileSize,
        slider: impl Into<Key>,
        range: SliderRange,
        icons: (impl Into<String>, f64, impl Into<String>),
        style: &'a TileStyle,
    ) -> Self {
        Self {
            id: id.into(),
            size,
            slider: slider.into(),
            range,
            icons: (icons.0.into(), icons.1, icons.2.into()),
            detail: None,
            name: String::new(),
            action: String::new(),
            style,
            full_corner: style.corner_square,
        }
    }
    /// The slider's accessible name and what it reports as it moves.
    pub fn named(mut self, name: impl Into<String>, action: impl Into<String>) -> Self {
        self.name = name.into();
        self.action = action.into();
        self
    }
    pub fn detail(mut self, key: impl Into<Key>, name: impl Into<String>) -> Self {
        self.detail = Some((key.into(), name.into()));
        self
    }
    pub fn full_corner(mut self, radius: f64) -> Self {
        self.full_corner = radius;
        self
    }
}

impl From<SliderTile<'_>> for Node {
    fn from(t: SliderTile<'_>) -> Node {
        let (s, id) = (t.style, t.id.clone());
        let k = |part: &str| format!("{id}/{part}");
        let corner = t.size.corner(s, t.full_corner);
        let content: Node = if t.size == TileSize::Tall {
            let fill = Column::new(
                k("fill"),
                vec![
                    strut(k("top"), s.tall_top),
                    Slot::new(k("value"), s.tall_value).into(),
                    Spacer::new(k("middle")).into(),
                    Image::new(k("icon"), t.icons.2.as_str(), s.icon).into(),
                    strut(k("bottom"), s.tall_bottom),
                ],
            )
            .align(Align::Center);
            let slider = Slider::new(t.slider, t.name, t.action, t.range.fill())
                .corner(Corner::Pill)
                .child(fill);
            // The fill reaches `tall_pad` from the glass.
            let inset = Row::new(
                k("inset-row"),
                vec![
                    strut(k("inset-l"), s.tall_pad),
                    Column::new(
                        k("inset"),
                        vec![
                            strut(k("inset-t"), s.tall_pad),
                            slider.grow().into(),
                            strut(k("inset-b"), s.tall_pad),
                        ],
                    )
                    .grow()
                    .into(),
                    strut(k("inset-r"), s.tall_pad),
                ],
            );
            detail_layer(&id, corner, t.detail.map(|d| d.0), inset.into())
        } else {
            let row = Row::new(
                k("row"),
                vec![
                    strut(k("lead"), s.slider_lead),
                    boxed(k("low"), &t.icons.0, t.icons.1, s.slider_icon, Ink::Dim),
                    strut(k("before"), s.slider_gap),
                    Slider::new(t.slider, t.name, t.action, t.range)
                        .grow()
                        .into(),
                    strut(k("after"), s.slider_gap),
                    boxed(
                        k("high"),
                        &t.icons.2,
                        s.slider_icon,
                        s.slider_icon,
                        Ink::Dim,
                    ),
                    strut(k("gap"), s.slider_gap),
                    Slot::new(k("value"), s.slider_value).into(),
                    strut(k("end"), s.slider_lead),
                ],
            )
            .align(Align::Center);
            let under: Node = match t.detail {
                Some((key, name)) => Button::with_child(key, name, "", Spacer::new(k("body")))
                    .corner(corner)
                    .into(),
                None => Spacer::new(k("body")).into(),
            };
            Overlay::new(k("layers"), under)
                .layer(Align::Stretch, Align::Center, Padding::default(), row)
                .into()
        };
        Pane::new(format!("p:{id}"), corner, content).into()
    }
}
