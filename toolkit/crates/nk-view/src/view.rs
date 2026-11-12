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
    pub kind: Kind,
}

/// The closed set of node kinds (VIEW.md §2).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Kind {
    Stack(Stack),
    Pane(Pane),
    Text(Text),
    Icon(Icon),
    Spacer,
    Control(Control),
    Reveal(Reveal),
    Scroll(Scroll),
    Overlay(Overlay),
    Grid(Grid),
    /// An on/off switch, drawn only: the control around it is what is pressed (VIEW.md §12.6).
    Switch(Switch),
    /// A row the surface did not build, at the height it had when it was (VIEW.md §8).
    Placeholder(f64),
}

/// An on/off switch (VIEW.md §12.6): its size and colours are the tokens'; a change of `on`
/// slides it as a reveal opens (§6).
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Switch {
    pub on: bool,
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
    /// Not drawn while the pointer is over this pane or focus is inside it, the inverse of
    /// a control's `revealed_with`; it keeps its room, so what replaces it does not move it.
    #[serde(default)]
    pub hidden_with: Option<Key>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Icon {
    /// An interface glyph's `nd-` name.
    pub name: String,
    pub size: f64,
    pub ink: Ink,
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
    pub wash: Wash,
    pub corner: Corner,
    pub enabled: bool,
    /// A persistent marker on the glass (today in a calendar, a selected item), shown with
    /// the hover wash and counted last in the budget.
    pub marked: bool,
    /// Drawn only while the pointer is over this pane, or focus is inside it. Always in the
    /// semantic tree and the Tab order.
    pub revealed_with: Option<Key>,
    /// Swiped across, its card (the nearest pane) follows the pointer; released far enough,
    /// it leaves the surface and the surface receives this action (VIEW.md §7).
    pub swipe: Option<String>,
    /// A slider's value and range (VIEW.md §12.1); its role is `Slider`.
    #[serde(default)]
    pub slider: Option<Slider>,
    /// A text field's text, caret and selection (VIEW.md §12.2); its role is `Field`.
    #[serde(default)]
    pub field: Option<Field>,
    /// On (VIEW.md §12.4): the glass under it is white, the primary ink at full, and what it
    /// holds is drawn in the accent. Hover and press do not show over it.
    #[serde(default)]
    pub on: bool,
    /// At rest it shows the surface wash (`--nidara-surface`), a well in the glass: the CC's
    /// badges. Hover and press lie over it.
    #[serde(default)]
    pub surface: bool,
    /// False: the pointer passes through it to what lies under. Keys and readers still reach
    /// it (a tile's second way in, its detail, under the tile's own control).
    #[serde(default = "yes")]
    pub pointer: bool,
    /// A state it shows whatever the pointer and the focus do (VIEW.md §13.3). Only the
    /// gallery sets it, to show a component's states side by side; a live control has none.
    #[serde(default)]
    pub shown: Option<Shown>,
    pub child: Box<Node>,
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
        }
    }
    /// The tile slider: it fills its control from the bottom.
    pub fn fill(mut self) -> Self {
        self.fill = true;
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
}

/// The constructors a surface builds its view with.
impl Node {
    fn new(key: impl Into<Key>, kind: Kind) -> Self {
        Node {
            key: key.into(),
            grow: false,
            kind,
        }
    }
    pub fn row(key: impl Into<Key>, children: Vec<Node>) -> Self {
        Self::stack(key, Axis::Horizontal, children)
    }
    pub fn column(key: impl Into<Key>, children: Vec<Node>) -> Self {
        Self::stack(key, Axis::Vertical, children)
    }
    fn stack(key: impl Into<Key>, axis: Axis, children: Vec<Node>) -> Self {
        Self::new(
            key,
            Kind::Stack(Stack {
                axis,
                gap: None,
                padding: Padding::default(),
                justify: Justify::Start,
                align: Align::Stretch,
                children,
            }),
        )
    }
    pub fn pane(key: impl Into<Key>, corner: Corner, child: Node) -> Self {
        Self::new(
            key,
            Kind::Pane(Pane {
                corner,
                opacity: 1.,
                child: Box::new(child),
            }),
        )
    }
    pub fn text(key: impl Into<Key>, text: impl Into<String>, style: TextStyle) -> Self {
        Self::new(
            key,
            Kind::Text(Text {
                text: text.into(),
                style,
                ink: Ink::Primary,
                lines: None,
                reserve: 0,
                hidden_with: None,
            }),
        )
    }
    pub fn icon(key: impl Into<Key>, name: impl Into<String>, size: f64) -> Self {
        Self::new(
            key,
            Kind::Icon(Icon {
                name: name.into(),
                size,
                ink: Ink::Primary,
            }),
        )
    }
    pub fn reveal(key: impl Into<Key>, open: bool, child: Node) -> Self {
        Self::new(
            key,
            Kind::Reveal(Reveal {
                open,
                child: Box::new(child),
            }),
        )
    }
    /// `base` with no layers yet; `layer` adds them, the last drawn on top.
    pub fn overlay(key: impl Into<Key>, base: Node) -> Self {
        Self::new(
            key,
            Kind::Overlay(Overlay {
                base: Box::new(base),
                layers: vec![],
            }),
        )
    }
    /// A grid of `columns` cells of `unit`, `gap` apart, holding `cells` (VIEW.md §12.4).
    pub fn grid(
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
    pub fn scroll(key: impl Into<Key>, child: Node) -> Self {
        Self::new(
            key,
            Kind::Scroll(Scroll {
                child: Box::new(child),
            }),
        )
    }
    /// Room the surface paints in itself, `size` square: a picture, a mark, a gauge
    /// (VIEW.md §12.3). Placed, clipped and faded as any node; never a control.
    pub fn slot(key: impl Into<Key>, size: f64) -> Self {
        Self::icon(key, "", size)
    }
    /// An on/off switch (VIEW.md §12.6), at the tokens' size. It is drawn only: put it in a
    /// control with `Role::Toggle` and `marked(on)`, which is what is pressed and said.
    pub fn switch(key: impl Into<Key>, on: bool) -> Self {
        Self::new(key, Kind::Switch(Switch { on }))
    }
    /// Stands in for a row the surface leaves unbuilt, outside a scroll region's window:
    /// `height` is what `ViewState::rect` gave for the row when it was built.
    pub fn placeholder(key: impl Into<Key>, height: f64) -> Self {
        Self::new(key, Kind::Placeholder(height))
    }
    pub fn spacer(key: impl Into<Key>) -> Self {
        Self::new(key, Kind::Spacer)
    }
    pub fn control(
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
                wash: Wash::Glass,
                corner: Corner::Pill,
                enabled: true,
                marked: false,
                revealed_with: None,
                swipe: None,
                slider: None,
                field: None,
                on: false,
                surface: false,
                pointer: true,
                shown: None,
                child: Box::new(child),
            }),
        )
    }
    /// A slider (VIEW.md §12.1): as tall as its thumb and as wide as it is given (a column
    /// stretches it; in a row, `.grow()` it). `action` is reported on every change, its value
    /// read with `ViewState::value`.
    pub fn slider(
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
            c.slider = Some(slider);
        }
        n
    }

    /// A text field (VIEW.md §12.2), its text in `style`; `action` is its Enter.
    pub fn field(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        field: Field,
        style: TextStyle,
    ) -> Self {
        let key = key.into();
        let text = Self::text(format!("{}/text", key.0), field.shown.clone(), style);
        let mut n = Self::control(key, name, action, text);
        if let Kind::Control(c) = &mut n.kind {
            c.role = Role::Field;
            c.field = Some(field);
        }
        n
    }

    // Modifiers. Each applies to the kind it names and is a no-op on any other.
    pub fn gap(mut self, s: Space) -> Self {
        if let Kind::Stack(st) = &mut self.kind {
            st.gap = Some(s);
        }
        self
    }
    pub fn padding(mut self, p: Padding) -> Self {
        if let Kind::Stack(st) = &mut self.kind {
            st.padding = p;
        }
        self
    }
    pub fn justify(mut self, j: Justify) -> Self {
        if let Kind::Stack(st) = &mut self.kind {
            st.justify = j;
        }
        self
    }
    pub fn align(mut self, a: Align) -> Self {
        if let Kind::Stack(st) = &mut self.kind {
            st.align = a;
        }
        self
    }
    pub fn layer(mut self, across: Align, down: Align, inset: Padding, child: Node) -> Self {
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
    pub fn layer_at(mut self, x: f64, y: f64, child: Node) -> Self {
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
    pub fn opacity(mut self, o: f64) -> Self {
        if let Kind::Pane(p) = &mut self.kind {
            p.opacity = o.clamp(0., 1.);
        }
        self
    }
    pub fn grow(mut self) -> Self {
        self.grow = true;
        self
    }
    pub fn lines(mut self, n: usize) -> Self {
        if let Kind::Text(t) = &mut self.kind {
            t.lines = Some(n.max(1));
        }
        self
    }
    /// A text at least `n` lines tall.
    pub fn reserve(mut self, n: usize) -> Self {
        if let Kind::Text(t) = &mut self.kind {
            t.reserve = n;
        }
        self
    }
    /// A text hidden while `pane` is hovered or holds the focus.
    pub fn hidden_with(mut self, pane: impl Into<Key>) -> Self {
        if let Kind::Text(t) = &mut self.kind {
            t.hidden_with = Some(pane.into());
        }
        self
    }
    pub fn ink(mut self, ink: Ink) -> Self {
        match &mut self.kind {
            Kind::Text(t) => t.ink = ink,
            Kind::Icon(i) => i.ink = ink,
            _ => {}
        }
        self
    }
    pub fn wash(mut self, w: Wash) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.wash = w;
        }
        self
    }
    pub fn corner(mut self, corner: Corner) -> Self {
        match &mut self.kind {
            Kind::Control(c) => c.corner = corner,
            Kind::Pane(p) => p.corner = corner,
            _ => {}
        }
        self
    }
    pub fn role(mut self, r: Role) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.role = r;
        }
        self
    }
    pub fn enabled(mut self, on: bool) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.enabled = on;
        }
        self
    }
    pub fn marked(mut self, on: bool) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.marked = on;
        }
        self
    }
    /// Shows a control in `state` for good: the gallery's states side by side (§13.3).
    pub fn shown(mut self, state: Shown) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.shown = Some(state);
        }
        self
    }
    pub fn on(mut self, on: bool) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.on = on;
        }
        self
    }
    pub fn surface(mut self) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.surface = true;
        }
        self
    }
    /// The pointer passes through it; keys and readers reach it.
    pub fn keys_only(mut self) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.pointer = false;
        }
        self
    }
    pub fn revealed_with(mut self, pane: impl Into<Key>) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.revealed_with = Some(pane.into());
        }
        self
    }
    pub fn description(mut self, text: impl Into<String>) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.description = text.into();
        }
        self
    }
    pub fn swipe(mut self, action: impl Into<String>) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.swipe = Some(action.into());
        }
        self
    }
}
