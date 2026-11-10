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
}

/// Something that opens and closes in place, unrolling downward (VIEW.md §6).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Reveal {
    pub open: bool,
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
}
impl Corner {
    /// The radius for a `w` × `h` box, never more than half its shorter side.
    pub fn of(self, w: f64, h: f64, radii: &Radii) -> f64 {
        let half = w.min(h) / 2.;
        match self {
            Corner::Pill => half,
            Corner::Token(r) => radii.px(r).min(half),
        }
    }
}

/// One piece of Hyalo glass: a card. Its bounds are its child's (VIEW.md §5).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pane {
    pub corner: Corner,
    pub child: Box<Node>,
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
    pub child: Box<Node>,
}

/// The roles a control takes (CATALOG.md).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Role {
    Button,
    /// A button with an on and off state (`marked` is its state).
    Toggle,
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
                action: action.into(),
                wash: Wash::Glass,
                corner: Corner::Pill,
                enabled: true,
                marked: false,
                revealed_with: None,
                child: Box::new(child),
            }),
        )
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
    pub fn revealed_with(mut self, pane: impl Into<Key>) -> Self {
        if let Kind::Control(c) = &mut self.kind {
            c.revealed_with = Some(pane.into());
        }
        self
    }
}
