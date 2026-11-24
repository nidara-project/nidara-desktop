// SPDX-License-Identifier: LGPL-3.0-or-later
//! The view: a value a surface builds from its model on each change (VIEW.md §2).
use crate::tokens::{Radii, Radius, Space};
use nk_text::TextStyle;
use serde::{Deserialize, Serialize};

/// A node's identity, taken from the surface's model (a notification's id, a group's key),
/// never from its position. Hover, press, focus, text layouts and the regions declared to
/// Hyalo follow the key across rebuilds.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct Key(pub String);
impl<T: Into<String>> From<T> for Key {
    fn from(s: T) -> Self {
        Key(s.into())
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Node {
    pub key: Key,
    /// In a `Stack`, this child takes a share of the room left on the main axis when no
    /// `Spacer` does.
    #[serde(default)]
    pub grow: bool,
    /// A width or height the surface's tokens fix (a window frame's sidebar, its header's
    /// band), never a literal: what it holds is laid out in it.
    #[serde(default)]
    pub width: Option<f64>,
    #[serde(default)]
    pub height: Option<f64>,
    /// At least the kit's row height (`ROW_HEIGHT.single`), whatever its content measures; taller
    /// when its content is.
    #[serde(default)]
    pub row_floor: bool,
    /// Decorative structure: layout/input remain, its automatic reader node is omitted.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub presentation: bool,
    /// An `nk::ListRow`: two of them next to each other in one stack get the kit's separator
    /// between them (`list.separator`, #1156).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub list_row: bool,
    /// A rule: the kit's separator drawn along it, between the two things it stands between
    /// (`list.separator`), and hidden next to one that is lit (#1156).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub rule: bool,
    pub kind: Kind,
}

/// The closed set of node kinds (VIEW.md §2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Kind {
    Stack(Stack),
    Pane(Pane),
    /// A group of rows on the window's own background, not glass: Settings' card, filled
    /// with `--nidara-surface` at the group radius. Glass is for what lies over content
    /// (a sidebar, a menu, a button); a section of a page is a group (VIEW.md §13.2).
    Group(Group),
    Text(Text),
    Icon(Icon),
    Spacer,
    Control(Control),
    Reveal(Reveal),
    Scroll(Scroll),
    Overlay(Overlay),
    Grid(Grid),
    /// A component drawn inside a control, inheriting its interaction.
    Drawing(crate::components::Drawing),
    /// A row the surface did not build, at the height it had when it was (VIEW.md §8).
    Placeholder(f64),
}

/// A list row (VIEW.md §13.6): the kit's general row in a list or a group of rows, in any
/// app and for anything — its title, an optional second line under it, what it starts and
/// ends with. Settings was its first user; the name says what it is (#1156).
#[derive(Clone, Debug, Default)]
pub struct ListRow {
    pub title: String,
    pub title_style: TextStyle,
    pub subtitle: Option<String>,
    pub subtitle_style: TextStyle,
    /// What the row ends with. In a row that is not activatable: a control that responds on its
    /// own (`switch_control`, a button, a slider). In an activatable one: what it shows, drawn
    /// only (`Node::switch`, a mark, a chevron), since the row is then the control.
    pub trailing: Option<Node>,
    pub leading: Option<Node>,
    /// The row responds as a whole and reports this action (GNOME's activatable row). Off by
    /// default: the control in it responds, not the row (owner, 2026-11-12).
    pub action: Option<String>,
    pub disabled: bool,
}

/// What a list row ends with when its control is a slider (VIEW.md §13.7): Settings' slider
/// row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SliderEnd {
    /// What a reader calls the slider: its row's title.
    pub name: String,
    /// Reported on every change; read the value with `ViewState::value`.
    pub action: String,
    pub slider: Slider,
    pub value_style: TextStyle,
    /// The glyphs at its lesser and greater ends (`nd-` names), as Brightness has.
    pub icons: Option<[String; 2]>,
    pub disabled: bool,
}

/// An entry of a window's sidebar (VIEW.md §13.8): a page the app can show.
#[derive(Clone, Debug)]
pub struct SidebarEntry {
    pub title: String,
    /// Its glyph's `nd-` name.
    pub glyph: String,
    /// Reported when it is chosen.
    pub action: String,
    /// It is the page shown.
    pub selected: bool,
    pub style: TextStyle,
}

/// Something that opens and closes in place, unrolling downward (VIEW.md §6).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reveal {
    pub open: bool,
    pub child: Box<Node>,
}

/// A base and layers placed over it (VIEW.md §9): the base alone gives the size, as
/// `Gtk.Overlay` measured only its child.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Overlay {
    pub base: Box<Node>,
    pub layers: Vec<Layer>,
}
/// One layer over an overlay's base: aligned on each axis within the base, kept `inset` from
/// its edges. `Stretch` fills the axis; `FirstLine` is `Start`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    pub across: Align,
    pub down: Align,
    pub inset: Padding,
    /// Placed at its natural size with its top-left here, from the base's (§9); `across`,
    /// `down` and `inset` then do not apply.
    #[serde(default)]
    pub at: Option<(f64, f64)>,
    pub child: Node,
}

/// Tiles on a grid of square cells (VIEW.md §12.4): `columns` cells of `unit` across,
/// `gap` between them, as many rows as the tiles reach. Where each tile goes is the
/// surface's to decide; the grid places what it is given, its child filling its cells.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Grid {
    pub columns: usize,
    pub unit: f64,
    pub gap: f64,
    pub cells: Vec<Cell>,
}
/// One tile: its first cell and how many cells it spans across and down.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Cell {
    pub at: (usize, usize),
    pub span: (usize, usize),
    pub child: Node,
}
impl Grid {
    /// The rows its tiles reach.
    pub fn rows(&self) -> usize {
        self.cells
            .iter()
            .map(|c| c.at.1 + c.span.1)
            .max()
            .unwrap_or(0)
    }
    /// The length of `n` cells and the gaps between them.
    pub fn span(&self, n: usize) -> f64 {
        if n == 0 {
            0.
        } else {
            n as f64 * self.unit + (n - 1) as f64 * self.gap
        }
    }
    /// Where a cell starts, from the grid's edge.
    pub fn start(&self, n: usize) -> f64 {
        n as f64 * (self.unit + self.gap)
    }
}

/// A region that shows its child through a viewport, scrolled vertically (VIEW.md §8).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Scroll {
    pub child: Box<Node>,
    /// A band at its top that something floats over (a search over a grid): the content
    /// scrolls under it, a control brought into view lands below it, and the bar starts
    /// below it.
    #[serde(default)]
    pub floating: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Axis {
    Horizontal,
    Vertical,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Justify {
    #[default]
    Start,
    Center,
    End,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Align {
    Start,
    Center,
    End,
    /// Children take the stack's whole cross size.
    #[default]
    Stretch,
    /// Children are centred on the first line of the stack's tallest first line: an icon
    /// level with a title whose body wraps below it.
    FirstLine,
}

/// Padding per side, in spacing tokens.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Padding {
    pub top: Option<Space>,
    pub right: Option<Space>,
    pub bottom: Option<Space>,
    pub left: Option<Space>,
}
impl Padding {
    pub fn all(s: Space) -> Self {
        Self::symmetric(s, s)
    }
    pub fn symmetric(vertical: Space, horizontal: Space) -> Self {
        Self {
            top: Some(vertical),
            right: Some(horizontal),
            bottom: Some(vertical),
            left: Some(horizontal),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Stack {
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub equal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub list_name: Option<String>,
    pub axis: Axis,
    pub gap: Option<Space>,
    pub padding: Padding,
    pub justify: Justify,
    pub align: Align,
    pub children: Vec<Node>,
}

/// A corner, as the glass and the washes draw it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Corner {
    /// Half the shorter side.
    Pill,
    /// A step of the kit's radius scale.
    Token(Radius),
    /// A radius the surface's own measures fix: the CC's 2×2 takes its 1×1's, half a cell.
    Fixed(u32),
}
impl Corner {
    /// The radius for a `w` × `h` box, never more than half its shorter side.
    pub fn of(self, w: f64, h: f64, radii: &Radii) -> f64 {
        let half = w.min(h) / 2.;
        match self {
            Corner::Pill => half,
            Corner::Token(r) => radii.px(r).min(half),
            Corner::Fixed(r) => (r as f64).min(half),
        }
    }
}

/// One piece of Hyalo glass: a card. Its bounds are its child's (VIEW.md §5).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pane {
    pub corner: Corner,
    /// Its glass and content are formed at this, times a reveal's or a swipe's (§12.7).
    #[serde(default = "one")]
    pub opacity: f64,
    pub child: Box<Node>,
}
/// A group's card around what it holds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Group {
    pub child: Box<Node>,
}
fn one() -> f64 {
    1.
}

/// Which text token a text is drawn in.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Ink {
    #[default]
    Primary,
    Secondary,
    Dim,
    /// The text of something unavailable (`--nidara-text-disabled`): a row whose control is
    /// disabled (VIEW.md §13.4, point 5).
    Disabled,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Text {
    pub text: String,
    pub style: TextStyle,
    pub ink: Ink,
    /// None: an interface label, one line, never cut (a label that does not fit is a wording
    /// problem). Some(n): text from outside, wrapped to n lines and ended in an ellipsis; its
    /// whole text stays in the semantics.
    pub lines: Option<usize>,
    /// Lines it is as tall as however few it fills, so cards of one kind share a height.
    #[serde(default)]
    pub reserve: usize,
    /// Texts it is as wide as the widest of, so a value that changes (a slider's) never moves
    /// what lies beside it.
    #[serde(default)]
    pub room: Vec<String>,
    /// Not drawn while the pointer is over this pane or focus is inside it, the inverse of
    /// a control's `revealed_with`; it keeps its room, so what replaces it does not move it.
    #[serde(default)]
    pub hidden_with: Option<Key>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Icon {
    /// A name in the interface or application icon theme.
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_fallback: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub picture: bool,
    pub size: f64,
    pub ink: Ink,
    /// Its ink's opacity on top of the ink's own (a slider's flanking glyphs).
    #[serde(default = "opaque")]
    pub alpha: f64,
}
fn opaque() -> f64 {
    1.
}

/// What a control's hover and press show on the glass.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Wash {
    /// The exported hover and press washes.
    #[default]
    Glass,
    /// The destructive hover and press.
    Destructive,
    /// None: its hover state exists (and reveals controls) but lights nothing and spends no
    /// region of the budget (VIEW.md "The NC's behaviour", point 2).
    None,
}

/// Something that can be pressed. It wraps what it shows; hover, press and focus belong to
/// controls only (VIEW.md §4).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Control {
    pub role: Role,
    /// What a reader says for it.
    pub name: String,
    /// What a reader says after its name: what the control holds besides it (a card's age
    /// and body), since the texts inside a control are not separate labels.
    #[serde(default)]
    pub description: String,
    /// What the surface receives in `Activated` (a name, never code).
    pub action: String,
    pub enabled: bool,
    /// Drawn only while the pointer is over this pane, or focus is inside it. Always in the
    /// semantic tree and the Tab order.
    pub revealed_with: Option<Key>,
    /// Swiped across, its card (the nearest pane) follows the pointer; released far enough,
    /// it leaves the surface and the surface receives this action (VIEW.md §7).
    pub swipe: Option<String>,
    /// False: the pointer passes through it to what lies under. Keys and readers still reach
    /// it (a tile's second way in, its detail, under the tile's own control).
    #[serde(default = "yes")]
    pub pointer: bool,
    /// A state it shows whatever the pointer and the focus do (VIEW.md §13.3). Only the
    /// gallery sets it, to show a component's states side by side; a live control has none.
    #[serde(default)]
    pub shown: Option<Shown>,
    pub part: Option<Box<crate::components::Part>>,
    pub child: Box<Node>,
}

impl Control {
    pub fn selected(&self) -> bool {
        self.part.as_ref().is_some_and(|p| p.component().selected())
    }
    fn configure(&mut self, property: crate::components::Configure) {
        match &self.part {
            Some(part) => self.part = Some(Box::new(part.configured(property))),
            None => crate::diagnostics::critical(format!(
                "a control with no part does not take {property:?}: the setting is lost"
            )),
        }
    }
}
/// Colour samples: one radio group, each choice reports `"{action}:{n}"`.
#[derive(Clone, Debug)]
pub struct Swatches {
    pub name: String,
    pub colors: Vec<(String, nk_render::Color)>,
    pub chosen: usize,
    pub action: String,
    pub disabled: bool,
}

/// A segmented choice (VIEW.md §13.10, GTK's linked toggle buttons): one choice of a few, all
/// shown side by side, the chosen one in the accent. Choosing one reports `"{action}:{n}"`.
#[derive(Clone, Debug)]
pub struct Segmented {
    /// What a reader calls the group: its row's title, said with each segment.
    pub name: String,
    pub options: Vec<String>,
    pub chosen: usize,
    pub action: String,
    pub disabled: bool,
}

/// A dropdown (VIEW.md §13.9, GTK's `DropDown`): one choice of several, shown closed as the
/// chosen one, its options in a list that opens over the window.
#[derive(Clone, Debug)]
pub struct Dropdown {
    /// What a reader calls it: its row's title.
    pub name: String,
    pub options: Vec<String>,
    pub chosen: usize,
    /// Reported when another option is chosen; read which with `ViewState::value`.
    pub action: String,
    pub disabled: bool,
}

/// A state a control can be shown in for good (`Control::shown`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Shown {
    Hover,
    Press,
    Focus,
}
fn yes() -> bool {
    true
}

/// What a text field shows (VIEW.md §12.2). The owner of the text edits it; the view only
/// shows it. A secret field is handed over as its bullets, never its text.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Field {
    pub shown: String,
    /// The caret and the selection's other end, as byte offsets into `shown`.
    pub caret: usize,
    pub anchor: usize,
    pub secret: bool,
}

/// What a slider holds: its value in a range, and how the value is said. The rules (steps,
/// keys, the pointer) are `nk-widgets`' `ValueRange`'s, the native Settings slider's.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Slider {
    pub min: f64,
    pub max: f64,
    pub step: f64,
    pub value: f64,
    /// Decimals in its value's text, and what follows the number (" K", " %").
    #[serde(default)]
    pub decimals: usize,
    #[serde(default)]
    pub unit: String,
    /// The tile slider (VIEW.md §12.1): the control's whole box, filled from the bottom up to
    /// its value, what it holds drawn dark where the fill has reached it. Else the row slider.
    #[serde(default)]
    pub fill: bool,
    /// Publish intermediate changes in AppWindow while the pointer is held.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub live: bool,
}
impl Slider {
    pub fn new(min: f64, max: f64, step: f64, value: f64) -> Self {
        Self {
            min,
            max,
            step,
            value,
            decimals: 0,
            unit: String::new(),
            fill: false,
            live: false,
        }
    }
    /// The tile slider: it fills its control from the bottom.
    pub fn fill(mut self) -> Self {
        self.fill = true;
        self
    }
    /// Send intermediate drag values as well as the final value on release.
    pub fn live(mut self) -> Self {
        self.live = true;
        self
    }
    pub fn unit(mut self, unit: impl Into<String>) -> Self {
        self.unit = unit.into();
        self
    }
    pub fn range(&self) -> nk_widgets::ValueRange {
        nk_widgets::ValueRange {
            min: self.min as f32,
            max: self.max as f32,
            step: self.step as f32,
            wrap: false,
            digits: 0,
            decimals: self.decimals,
            unit: self.unit.clone(),
        }
    }
    /// Its value clamped and on a step, as it is drawn and said.
    pub fn shown(&self, value: f64) -> f64 {
        f64::from(self.range().snap(value as f32))
    }
}

/// The roles a control takes (CATALOG.md).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    Button,
    /// A button with an on and off state (`marked` is its state).
    Toggle,
    /// A value in a range, set by dragging or by the keys (VIEW.md §12.1).
    Slider,
    /// One line of text being typed (VIEW.md §12.2).
    Field,
    /// A checkbox: on or off on its own (`marked` is its state).
    Check,
    /// One choice of several (`marked`: it is the one chosen). The radios next to each other
    /// in tree order are one group: the arrows move the choice in it, and Tab stops at it once.
    Radio,
    /// A dropdown (VIEW.md §13.9): activated, its window opens its list; a reader hears a
    /// combo box holding its options.
    Dropdown,
    /// One option of a dropdown's open list (`marked`: it is the one chosen).
    Option,
}

/// The constructors a surface builds its view with.
impl Node {
    fn new(key: impl Into<Key>, kind: Kind) -> Self {
        Node {
            key: key.into(),
            grow: false,
            width: None,
            height: None,
            row_floor: false,
            presentation: false,
            list_row: false,
            rule: false,
            kind,
        }
    }
    pub fn presentational(mut self) -> Self {
        self.presentation = true;
        self
    }
    pub(crate) fn row(key: impl Into<Key>, children: Vec<Node>) -> Self {
        Self::stack(key, Axis::Horizontal, children)
    }
    pub(crate) fn column(key: impl Into<Key>, children: Vec<Node>) -> Self {
        Self::stack(key, Axis::Vertical, children)
    }
    pub(crate) fn equal_row(key: impl Into<Key>, children: Vec<Node>) -> Self {
        let mut row = Self::row(key, children);
        if let Kind::Stack(stack) = &mut row.kind {
            stack.equal = true;
        }
        row
    }
    fn stack(key: impl Into<Key>, axis: Axis, children: Vec<Node>) -> Self {
        Self::new(
            key,
            Kind::Stack(Stack {
                equal: false,
                list_name: None,
                axis,
                gap: None,
                padding: Padding::default(),
                justify: Justify::Start,
                align: Align::Stretch,
                children,
            }),
        )
    }
    pub(crate) fn pane(key: impl Into<Key>, corner: Corner, child: Node) -> Self {
        Self::new(
            key,
            Kind::Pane(Pane {
                corner,
                opacity: 1.,
                child: Box::new(child),
            }),
        )
    }
    /// A group: a card on the window's background, not glass (see `Kind::Group`).
    pub(crate) fn group(key: impl Into<Key>, child: Node) -> Self {
        Self::new(
            key,
            Kind::Group(Group {
                child: Box::new(child),
            }),
        )
    }
    pub(crate) fn text(key: impl Into<Key>, text: impl Into<String>, style: TextStyle) -> Self {
        Self::new(
            key,
            Kind::Text(Text {
                text: text.into(),
                style,
                ink: Ink::Primary,
                lines: None,
                reserve: 0,
                room: vec![],
                hidden_with: None,
            }),
        )
    }
    pub(crate) fn icon(key: impl Into<Key>, name: impl Into<String>, size: f64) -> Self {
        Self::new(
            key,
            Kind::Icon(Icon {
                name: name.into(),
                app_fallback: None,
                picture: false,
                size,
                ink: Ink::Primary,
                alpha: 1.,
            }),
        )
    }
    pub(crate) fn reveal(key: impl Into<Key>, open: bool, child: Node) -> Self {
        Self::new(
            key,
            Kind::Reveal(Reveal {
                open,
                child: Box::new(child),
            }),
        )
    }
    /// `base` with no layers yet; `layer` adds them, the last drawn on top.
    pub(crate) fn overlay(key: impl Into<Key>, base: Node) -> Self {
        Self::new(
            key,
            Kind::Overlay(Overlay {
                base: Box::new(base),
                layers: vec![],
            }),
        )
    }
    /// A grid of `columns` cells of `unit`, `gap` apart, holding `cells` (VIEW.md §12.4).
    pub(crate) fn grid(
        key: impl Into<Key>,
        columns: usize,
        unit: f64,
        gap: f64,
        cells: Vec<Cell>,
    ) -> Self {
        Self::new(
            key,
            Kind::Grid(Grid {
                columns,
                unit,
                gap,
                cells,
            }),
        )
    }
    pub(crate) fn scroll(key: impl Into<Key>, child: Node) -> Self {
        Self::new(
            key,
            Kind::Scroll(Scroll {
                child: Box::new(child),
                floating: 0.,
            }),
        )
    }
    /// Room the surface paints in itself, `size` square: a picture, a mark, a gauge
    /// (VIEW.md §12.3). Placed, clipped and faded as any node; never a control.
    pub(crate) fn slot(key: impl Into<Key>, size: f64) -> Self {
        Self::icon(key, "", size)
    }
    /// An on/off switch (VIEW.md §12.6), at the tokens' size. It is drawn only: put it in a
    /// control with `Role::Toggle` and `marked(on)`, which is what is pressed and said.
    /// A switch as drawn, for a control that holds one (`switch_control`, or a row an app
    /// makes activatable as a whole).
    pub(crate) fn switch(key: impl Into<Key>, on: bool) -> Self {
        Self::drawing(key, crate::Part::Switch(crate::components::Switch { on }))
    }
    /// A switch (VIEW.md §12.6): only the switch responds, never the row it sits in. `name`
    /// is what its row says, so a reader calls the switch by it; `action` is reported on each
    /// flip. Off glass its hover and press are the view's, on its own pill.
    pub(crate) fn switch_control(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        on: bool,
    ) -> Self {
        let key = key.into();
        let drawn = Self::switch(format!("{}/track", key.0), on);
        Self::control(key, name, action, drawn)
            .corner(Corner::Pill)
            .role(Role::Toggle)
            .marked(on)
            // A flip reports the state it switches TO, as a disclosure does (#1148).
            .value(crate::Value::Bool(!on))
    }
    /// A list row (VIEW.md §13.6): its title and second line, what it ends with, at least
    /// the kit's row height, its padding the kit's. Not activatable, it is no control: the
    /// control it ends with responds, and its text says the state (disabled). Activatable
    /// (`action`), the row is one control named by its title and described by its second
    /// line, with the view's hover and press off glass; set its role and `marked` as for any
    /// control (a row that flips a switch it shows is `Role::Toggle`, `marked(on)`).
    /// A rule between two things in a row or a column: the kit's separator along its longer
    /// side, centred across the shorter one (#1156).
    pub(crate) fn rule(key: impl Into<Key>) -> Self {
        let mut n = Self::spacer(key);
        n.rule = true;
        n
    }
    pub(crate) fn list_row(key: impl Into<Key>, row: ListRow) -> Self {
        let key = key.into();
        let ink = |normal| if row.disabled { Ink::Disabled } else { normal };
        let mut text = vec![
            // Its text wraps to the row's width and never widens it (`Adw.ActionRow`'s
            // title-lines and subtitle-lines, 0: no limit).
            Self::text(
                format!("{}/title", key.0),
                row.title.clone(),
                row.title_style,
            )
            .ink(ink(Ink::Primary))
            .lines(usize::MAX),
        ];
        if let Some(sub) = &row.subtitle {
            text.push(
                Self::text(
                    format!("{}/subtitle", key.0),
                    sub.clone(),
                    row.subtitle_style,
                )
                .ink(ink(Ink::Dim))
                .lines(usize::MAX),
            );
        }
        let mut line: Vec<_> = row.leading.into_iter().collect();
        line.push(Self::column(format!("{}/text", key.0), text).grow());
        if let Some(t) = row.trailing {
            debug_assert!(
                row.action.is_none() || !t.holds_control(),
                "an activatable row is the control: what it ends with is drawn only"
            );
            line.push(t);
        }
        let line_key = match row.action {
            Some(_) => Key(format!("{}/line", key.0)),
            None => key.clone(),
        };
        let line = Self::row(line_key, line)
            .gap(Space::S3)
            .align(Align::Center)
            .padding(Padding::all(Space::S3))
            .row_floor();
        let mut row_node = match row.action {
            Some(action) => {
                let mut n = Self::control(key, row.title, action, line)
                    .corner(Corner::Token(Radius::Sm))
                    .enabled(!row.disabled);
                if let Some(sub) = row.subtitle {
                    n = n.description(sub);
                }
                n
            }
            None => line,
        };
        row_node.list_row = true;
        row_node
    }
    /// A slider and its value, for a list row to end with (VIEW.md §13.7): the slider at the
    /// kit's width, its glyphs either side of it when it has them, and its value after it in
    /// room for its widest text, so the slider never moves as the value changes. Measures are
    /// `style`'s, the exported `range.slider`.
    pub(crate) fn slider_end(key: impl Into<Key>, end: SliderEnd) -> Self {
        let owner = key.into();
        Self::drawing(
            format!("{}/end", owner.0),
            crate::Part::SliderRow(crate::components::SliderRow { owner, end }),
        )
    }
    /// An entry of a window's sidebar (VIEW.md §13.8, GTK's `StackSidebar` row): its glyph at
    /// `glyph_size` (the frame's, `FrameStyle::icon`) and its title, in the kit's padding. The
    /// selected one is filled with the accent and drawn in the accent's foreground (D1); a
    /// reader hears a toggle, checked when it is the page shown.
    pub(crate) fn sidebar_entry(key: impl Into<Key>, entry: SidebarEntry, glyph_size: f64) -> Self {
        let key = key.into();
        let k = |part: &str| format!("{}/{part}", key.0);
        let line = Self::row(
            k("row"),
            vec![
                Self::icon(k("icon"), entry.glyph, glyph_size),
                Self::text(k("text"), entry.title.clone(), entry.style),
            ],
        )
        .gap(Space::S2)
        .align(Align::Center)
        .padding(Padding::symmetric(Space::S2, Space::S3));
        let mut n = Self::control(key, entry.title, entry.action, line)
            .role(Role::Toggle)
            .marked(entry.selected)
            .corner(Corner::Token(Radius::Sm));
        if let Kind::Control(c) = &mut n.kind {
            c.configure(crate::components::Configure::Accent(true));
        }
        n
    }
    /// Whether a control lies in this node.
    fn holds_control(&self) -> bool {
        match &self.kind {
            Kind::Control(_) => true,
            Kind::Drawing(d) => d.part.component().contains_controls(),
            Kind::Stack(s) => s.children.iter().any(Self::holds_control),
            Kind::Pane(p) => p.child.holds_control(),
            Kind::Group(g) => g.child.holds_control(),
            Kind::Reveal(r) => r.child.holds_control(),
            Kind::Scroll(sc) => sc.child.holds_control(),
            Kind::Overlay(o) => {
                o.base.holds_control() || o.layers.iter().any(|l| l.child.holds_control())
            }
            Kind::Grid(g) => g.cells.iter().any(|c| c.child.holds_control()),
            _ => false,
        }
    }
    /// A checkbox's mark as drawn, for a control that holds one (`check_control`).
    pub(crate) fn check(key: impl Into<Key>, on: bool) -> Self {
        Self::drawing(
            key,
            crate::Part::Check(crate::components::Check { on, radio: false }),
        )
    }
    /// A radio's mark as drawn, for a control that holds one (`radio_control`).
    pub(crate) fn radio(key: impl Into<Key>, chosen: bool) -> Self {
        Self::drawing(
            key,
            crate::Part::Check(crate::components::Check {
                on: chosen,
                radio: true,
            }),
        )
    }
    /// A checkbox (VIEW.md §13.5): as the switch, only the box responds, never the row it
    /// sits in; `name` is what its row says, `action` is reported on each flip. It is off
    /// glass, and the view paints its states.
    pub(crate) fn check_control(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        on: bool,
    ) -> Self {
        let key = key.into();
        let drawn = Self::check(format!("{}/mark", key.0), on);
        Self::mark_control(key, name, action, drawn, Role::Check, on)
    }
    /// A radio (VIEW.md §13.5): one choice of several; put the group's radios next to each
    /// other. `action` is reported when it is chosen, by a click or by the arrows.
    pub(crate) fn radio_control(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        chosen: bool,
    ) -> Self {
        let key = key.into();
        let drawn = Self::radio(format!("{}/mark", key.0), chosen);
        Self::mark_control(key, name, action, drawn, Role::Radio, chosen)
    }
    fn mark_control(
        key: Key,
        name: impl Into<String>,
        action: impl Into<String>,
        drawn: Node,
        role: Role,
        on: bool,
    ) -> Self {
        let corner = if role == Role::Radio {
            Corner::Pill
        } else {
            Corner::Token(Radius::Xs)
        };
        Self::control(key, name, action, drawn)
            .corner(corner)
            .role(role)
            .marked(on)
            .wash(Wash::None)
    }
    /// Stands in for a row the surface leaves unbuilt, outside a scroll region's window:
    /// `height` is what `ViewState::rect` gave for the row when it was built.
    pub(crate) fn placeholder(key: impl Into<Key>, height: f64) -> Self {
        Self::new(key, Kind::Placeholder(height))
    }
    pub(crate) fn spacer(key: impl Into<Key>) -> Self {
        Self::new(key, Kind::Spacer)
    }
    pub(crate) fn control(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        child: Node,
    ) -> Self {
        Self::new(
            key,
            Kind::Control(Control {
                role: Role::Button,
                name: name.into(),
                description: String::new(),
                action: action.into(),
                enabled: true,
                revealed_with: None,
                swipe: None,
                pointer: true,
                shown: None,
                part: Some(Box::new(crate::Part::Surface(
                    crate::components::Surface::default(),
                ))),
                child: Box::new(child),
            }),
        )
    }
    /// A component without its own input or semantic node.
    pub(crate) fn drawing(key: impl Into<Key>, part: crate::Part) -> Self {
        let key = key.into();
        let child = Box::new(Self::spacer(format!("{}/body", key.0)));
        Self::new(
            key,
            Kind::Drawing(crate::Drawing {
                part: Box::new(part),
                child,
            }),
        )
    }
    /// A button in a page's content (`Part::Button`): `label` centred in `style`, in the
    /// button's padding and corner. Not glass: for one over content, put a control in a pane.
    pub(crate) fn button(
        key: impl Into<Key>,
        label: impl Into<String>,
        action: impl Into<String>,
        style: TextStyle,
    ) -> Self {
        let key = key.into();
        let label = label.into();
        let mut n = Self::control(
            key.clone(),
            label.clone(),
            action,
            Self::spacer(format!("{}/label", key.0)),
        )
        .corner(Corner::Token(Radius::Sm));
        if let Kind::Control(c) = &mut n.kind {
            c.part = Some(Box::new(crate::Part::Button(crate::components::Button {
                appearance: crate::components::ButtonAppearance::Normal,
                label,
                style,
                selected: false,
                corner: Corner::Token(Radius::Sm),
                value: None,
            })));
        }
        n
    }
    /// A dropdown (VIEW.md §13.9): the chosen option and the arrow, in the trigger's padding,
    /// as wide as its widest option so that a choice never moves what lies beside it. Its
    /// measures, tones and fonts are `style`'s (the exported `dropdown`), the font a step of
    /// `types`. Activated, the window it is in opens its list (`AppWindow`).
    pub(crate) fn dropdown(key: impl Into<Key>, d: Dropdown) -> Self {
        let key = key.into();
        let mut n = Self::control(
            key.clone(),
            d.name,
            d.action,
            Self::spacer(format!("{}/body", key.0)),
        )
        .role(Role::Dropdown)
        .enabled(!d.disabled);
        if let Kind::Control(c) = &mut n.kind {
            c.part = Some(Box::new(crate::Part::Dropdown(
                crate::components::Dropdown {
                    chosen: d.chosen.min(d.options.len().saturating_sub(1)),
                    options: d.options,
                },
            )));
        }
        n
    }
    /// A segmented choice (VIEW.md §13.10): a row of segments, each a radio of one group, so
    /// that the arrows move the choice and Tab stops at it once. Segment `n` is keyed
    /// `"{key}/{n}"` and reports `"{action}:{n}"` when it is chosen; its measures, tones and
    /// font arrive with the layout look (the exported `choices.segmented` and type scale).
    pub(crate) fn segmented(key: impl Into<Key>, s: Segmented) -> Self {
        Self::drawing(
            key,
            crate::Part::Segmented(crate::components::SegmentedRow {
                name: s.name,
                options: s.options,
                chosen: s.chosen,
                action: s.action,
                disabled: s.disabled,
                shown: Vec::new(),
            }),
        )
    }
    /// A row of colour samples, with the exported swatch geometry and independent radio membership.
    pub(crate) fn swatches(key: impl Into<Key>, s: Swatches) -> Self {
        Self::drawing(
            key,
            crate::Part::Swatches(crate::components::SwatchRow {
                name: s.name,
                colors: s
                    .colors
                    .into_iter()
                    .map(|(name, color)| (name, color.components))
                    .collect(),
                chosen: s.chosen,
                action: s.action,
                disabled: s.disabled,
                shown: Vec::new(),
            }),
        )
    }
    /// A row of a dropdown's open list: `label` and room for the tick after it, in the row's
    /// padding (`style`, the exported `dropdown.menu`). `chosen` ticks it.
    pub(crate) fn menu_row(
        key: impl Into<Key>,
        label: impl Into<String>,
        action: impl Into<String>,
        chosen: bool,
    ) -> Self {
        let key = key.into();
        let label = label.into();
        let mut n = Self::control(
            key.clone(),
            label.clone(),
            action,
            Self::spacer(format!("{}/body", key.0)),
        )
        .role(Role::Option);
        if let Kind::Control(c) = &mut n.kind {
            c.part = Some(Box::new(crate::Part::MenuRow(crate::components::MenuRow {
                label,
                selected: chosen,
            })));
        }
        n
    }
    /// A slider (VIEW.md §12.1): as tall as its thumb and as wide as it is given (a column
    /// stretches it; in a row, `.grow()` it). `action` is reported on every change, its value
    /// read with `ViewState::value`.
    pub(crate) fn slider(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        slider: Slider,
    ) -> Self {
        let key = key.into();
        let track = Key(format!("{}/track", key.0));
        let mut n = Self::control(key, name, action, Self::spacer(track));
        if let Kind::Control(c) = &mut n.kind {
            c.role = Role::Slider;
            c.part = Some(Box::new(crate::Part::Slider(
                crate::components::SliderControl {
                    range: slider,
                    surface: crate::components::Surface::default(),
                },
            )));
        }
        n
    }

    /// A text field (VIEW.md §12.2), its text in `style`; `action` is its Enter.
    pub(crate) fn field(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        field: Field,
        style: TextStyle,
    ) -> Self {
        let key = key.into();
        let text = Self::text(
            format!("{}/text", key.0),
            field.shown.clone(),
            style.clone(),
        );
        let mut n = Self::control(key, name, action, text);
        if let Kind::Control(c) = &mut n.kind {
            c.role = Role::Field;
            c.part = Some(Box::new(crate::Part::Field(
                crate::components::DisplayField {
                    field,
                    style: style.clone(),
                    surface: crate::components::Surface::default(),
                },
            )));
        }
        n
    }

    /// An application payload for a plain/surface control; intrinsic component values
    /// (a range or selection) remain owned by that component.
    pub(crate) fn value(mut self, value: crate::Value) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.configure(crate::components::Configure::Value(value));
        }
        self
    }
    /// Gallery fixture: show a child of a composed choice row in a stable state.
    pub(crate) fn button_appearance(
        mut self,
        appearance: crate::components::ButtonAppearance,
    ) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.configure(crate::components::Configure::ButtonAppearance(appearance));
        }
        self
    }
    pub(crate) fn sample_state(mut self, index: usize, shown: Shown) -> Self {
        if let Kind::Drawing(d) = &mut self.kind {
            *d.part = d
                .part
                .configured(crate::components::Configure::Sample(index, shown));
        }
        self
    }
    // Modifiers. Each applies to the kind it names and is a no-op on any other.
    pub(crate) fn gap(mut self, s: Space) -> Self {
        if let Kind::Stack(st) = &mut self.kind {
            st.gap = Some(s);
        }
        self
    }
    pub(crate) fn padding(mut self, p: Padding) -> Self {
        if let Kind::Stack(st) = &mut self.kind {
            st.padding = p;
        }
        self
    }
    pub(crate) fn justify(mut self, j: Justify) -> Self {
        if let Kind::Stack(st) = &mut self.kind {
            st.justify = j;
        }
        self
    }
    pub(crate) fn align(mut self, a: Align) -> Self {
        if let Kind::Stack(st) = &mut self.kind {
            st.align = a;
        }
        self
    }
    pub(crate) fn layer(mut self, across: Align, down: Align, inset: Padding, child: Node) -> Self {
        if let Kind::Overlay(o) = &mut self.kind {
            o.layers.push(Layer {
                across,
                down,
                inset,
                at: None,
                child,
            });
        }
        self
    }
    /// A layer at its natural size, its top-left `(x, y)` from the base's (§9).
    pub(crate) fn layer_at(mut self, x: f64, y: f64, child: Node) -> Self {
        if let Kind::Overlay(o) = &mut self.kind {
            o.layers.push(Layer {
                across: Align::Start,
                down: Align::Start,
                inset: Padding::default(),
                at: Some((x, y)),
                child,
            });
        }
        self
    }
    /// A pane's glass and content formed at `o` (§12.7).
    pub(crate) fn opacity(mut self, o: f64) -> Self {
        if let Kind::Pane(p) = &mut self.kind {
            p.opacity = o.clamp(0., 1.);
        }
        self
    }
    /// Laid out at this width, from a token, whatever its content measures.
    pub fn width(mut self, px: f64) -> Self {
        self.width = Some(px);
        self
    }
    /// Laid out at this height, from a token, whatever its content measures.
    pub fn height(mut self, px: f64) -> Self {
        self.height = Some(px);
        self
    }
    /// At least the kit's row height (`ROW_HEIGHT.single`), its content centred in it when its
    /// stack aligns to the centre; taller when the content is.
    pub fn row_floor(mut self) -> Self {
        self.row_floor = true;
        self
    }
    pub fn grow(mut self) -> Self {
        self.grow = true;
        self
    }
    pub(crate) fn lines(mut self, n: usize) -> Self {
        if let Kind::Text(t) = &mut self.kind {
            t.lines = Some(n.max(1));
        }
        self
    }
    /// A text at least `n` lines tall.
    /// A text as wide as the widest of `texts` (and its own), so it does not move what lies
    /// beside it as it changes.
    pub(crate) fn room(mut self, texts: Vec<String>) -> Self {
        if let Kind::Text(t) = &mut self.kind {
            t.room = texts;
        }
        self
    }
    /// An icon's ink at `alpha` of its own opacity.
    pub(crate) fn alpha(mut self, alpha: f64) -> Self {
        if let Kind::Icon(i) = &mut self.kind {
            i.alpha = alpha.clamp(0., 1.);
        }
        self
    }
    pub(crate) fn reserve(mut self, n: usize) -> Self {
        if let Kind::Text(t) = &mut self.kind {
            t.reserve = n;
        }
        self
    }
    /// A text hidden while `pane` is hovered or holds the focus.
    pub(crate) fn hidden_with(mut self, pane: impl Into<Key>) -> Self {
        if let Kind::Text(t) = &mut self.kind {
            t.hidden_with = Some(pane.into());
        }
        self
    }
    pub(crate) fn ink(mut self, ink: Ink) -> Self {
        match &mut self.kind {
            Kind::Text(t) => t.ink = ink,
            Kind::Icon(i) => i.ink = ink,
            _ => {}
        }
        self
    }
    pub(crate) fn wash(mut self, w: Wash) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.configure(crate::components::Configure::Wash(w));
        }
        self
    }
    pub(crate) fn corner(mut self, corner: Corner) -> Self {
        match &mut self.kind {
            Kind::Control(c) => c.configure(crate::components::Configure::Corner(corner)),
            Kind::Pane(p) => p.corner = corner,
            _ => {}
        }
        self
    }
    pub(crate) fn role(mut self, r: Role) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.role = r;
        }
        self
    }
    pub(crate) fn enabled(mut self, on: bool) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.enabled = on;
        }
        self
    }
    pub(crate) fn marked(mut self, on: bool) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.configure(crate::components::Configure::Marked(on));
        }
        self
    }
    /// Shows a control in `state` for good: the gallery's states side by side (§13.3).
    pub(crate) fn shown(mut self, state: Shown) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.shown = Some(state);
        }
        self
    }
    pub(crate) fn on(mut self, on: bool) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.configure(crate::components::Configure::On(on));
        }
        self
    }
    pub(crate) fn surface(mut self) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.configure(crate::components::Configure::Surface);
        }
        self
    }
    /// The pointer passes through it; keys and readers reach it.
    pub(crate) fn keys_only(mut self) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.pointer = false;
        }
        self
    }
    pub(crate) fn revealed_with(mut self, pane: impl Into<Key>) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.revealed_with = Some(pane.into());
        }
        self
    }
    pub(crate) fn description(mut self, text: impl Into<String>) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.description = text.into();
        }
        self
    }
    pub(crate) fn swipe(mut self, action: impl Into<String>) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.swipe = Some(action.into());
        }
        self
    }
}
