// SPDX-License-Identifier: LGPL-3.0-or-later
//! The kit's public face (#1079): every piece an app builds with is a type named for what it is,
//! GTK's name wherever GTK has the same piece (`nk::Button`, `nk::Switch`, `nk::DropDown`),
//! built the same way: `new` with what it cannot do without, chained setters for the rest, and
//! into the tree through `Into<Node>`. An app never names a `Node` constructor; those are the
//! kit's own.
//!
//! Each type offers only the setters that mean something for it. The setters every piece has
//! (its size and how it shares a stack's room) are `Widget`'s, in `nk::prelude`.
pub use crate::components::Arrangement;
use crate::components::{
    ButtonAppearance, Disclosure, EditableField, ListSource, LongList, Search,
};
use crate::tokens::Space;
use crate::view::{
    Align, Cell, Corner, Ink, Justify, Key, Kind, Node, Padding, Role, Shown, SliderEnd as EndSpec,
    Wash,
};
use crate::{FontChoice, Part, Value};
use nk_text::TextStyle;

/// What every piece of the kit can be asked, whatever it is.
pub trait Widget: Into<Node> + Sized {
    #[doc(hidden)]
    fn map(self, f: impl FnOnce(Node) -> Node) -> Self;
    /// Takes a share of the room its stack has left on the main axis.
    fn grow(self) -> Self {
        self.map(Node::grow)
    }
    /// Laid out at this width, from a token, whatever its content measures.
    fn width(self, px: f64) -> Self {
        self.map(|n| n.width(px))
    }
    /// Laid out at this height, from a token, whatever its content measures.
    fn height(self, px: f64) -> Self {
        self.map(|n| n.height(px))
    }
    /// At least the kit's row height, taller when its content is.
    fn row_floor(self) -> Self {
        self.map(Node::row_floor)
    }
    /// Decoration: laid out and drawn, but no reader node of its own.
    fn presentational(self) -> Self {
        self.map(Node::presentational)
    }
    /// Made of glass, in its own shape (`Node::glass`): `nk::Button::new(…).glass()` is the
    /// glass button, `nk::Button::new(…)` the one for content.
    fn glass(self) -> Self {
        self.map(Node::glass)
    }
}

/// A type holding a built node, with the setters that apply to it.
macro_rules! widget {
    ($(#[$m:meta])* $name:ident) => {
        $(#[$m])*
        #[derive(Clone, Debug)]
        #[must_use]
        pub struct $name(Node);
        impl From<$name> for Node {
            fn from(w: $name) -> Node {
                w.0
            }
        }
        impl Widget for $name {
            fn map(self, f: impl FnOnce(Node) -> Node) -> Self {
                Self(f(self.0))
            }
        }
    };
}
/// Setters that pass straight to the node.
macro_rules! setters {
    ($($(#[$m:meta])* $name:ident($($arg:ident: $ty:ty),*);)*) => {
        $($(#[$m])* pub fn $name(self, $($arg: $ty),*) -> Self {
            Self(self.0.$name($($arg),*))
        })*
    };
}
macro_rules! stack_setters {
    () => {
        setters! {
            /// The space between its children, a spacing token.
            gap(s: Space);
            padding(p: Padding);
            /// Where its children sit on the main axis when they do not fill it.
            justify(j: Justify);
            /// How its children sit across it.
            align(a: Align);
        }
    };
}
macro_rules! control_setters {
    () => {
        setters! {
            enabled(on: bool);
            /// What a reader says after its name.
            description(text: impl Into<String>);
            /// Drawn only while `pane` is hovered or holds the focus.
            revealed_with(pane: impl Into<Key>);
            /// Shown in `state` for good: the gallery's states side by side.
            shown(state: Shown);
            /// The pointer passes through it; keys and readers still reach it.
            keys_only();
            corner(corner: Corner);
            wash(w: Wash);
            /// An application payload carried with its activation.
            value(value: Value);
        }
    };
}

widget!(
    /// Children one beside the other (SwiftUI's `HStack`).
    Row
);
impl Row {
    pub fn new(key: impl Into<Key>, children: Vec<Node>) -> Self {
        Self(Node::row(key, children))
    }
    stack_setters!();
}
widget!(
    /// Children one under the other (SwiftUI's `VStack`).
    Column
);
impl Column {
    pub fn new(key: impl Into<Key>, children: Vec<Node>) -> Self {
        Self(Node::column(key, children))
    }
    stack_setters!();
}
widget!(
    /// A base and layers placed over it; the base alone gives the size (`Gtk.Overlay`).
    Overlay
);
impl Overlay {
    pub fn new(key: impl Into<Key>, base: impl Into<Node>) -> Self {
        Self(Node::overlay(key, base.into()))
    }
    /// A layer aligned on each axis within the base, `inset` from its edges; the last added is
    /// drawn on top.
    pub fn layer(self, across: Align, down: Align, inset: Padding, child: impl Into<Node>) -> Self {
        Self(self.0.layer(across, down, inset, child.into()))
    }
    /// A layer at its natural size, its top-left `(x, y)` from the base's.
    pub fn layer_at(self, x: f64, y: f64, child: impl Into<Node>) -> Self {
        Self(self.0.layer_at(x, y, child.into()))
    }
}
widget!(
    /// Tiles on a grid of square cells: `columns` cells of `unit`, `gap` apart (`Gtk.Grid`).
    Grid
);
impl Grid {
    pub fn new(key: impl Into<Key>, columns: usize, unit: f64, gap: f64, cells: Vec<Cell>) -> Self {
        Self(Node::grid(key, columns, unit, gap, cells))
    }
}
widget!(
    /// Its child through a viewport, scrolled vertically (AppKit's `NSScrollView`).
    Scroll
);
impl Scroll {
    pub fn new(key: impl Into<Key>, child: impl Into<Node>) -> Self {
        Self(Node::scroll(key, child.into()))
    }
    /// Something floats over its top `px` (a search over a grid): what is brought into view
    /// lands below it, and the bar starts below it.
    pub fn floating_top(mut self, px: f64) -> Self {
        if let Kind::Scroll(s) = &mut self.0.kind {
            s.floating = px.max(0.);
        }
        self
    }
}
widget!(
    /// Something that opens and closes in place, unrolling downward (`Gtk.Revealer`).
    Revealer
);
impl Revealer {
    pub fn new(key: impl Into<Key>, open: bool, child: impl Into<Node>) -> Self {
        Self(Node::reveal(key, open, child.into()))
    }
}
widget!(
    /// A card on the window's own background that groups rows (`nk::ListRow`), in any app.
    Group
);
impl Group {
    pub fn new(key: impl Into<Key>, child: impl Into<Node>) -> Self {
        Self(Node::group(key, child.into()))
    }
}
widget!(
    /// One piece of Hyalo glass around its child.
    Pane
);
impl Pane {
    pub fn new(key: impl Into<Key>, corner: Corner, child: impl Into<Node>) -> Self {
        Self(Node::pane(key, corner, child.into()))
    }
    setters! {
        /// Its glass and content formed at `o`.
        opacity(o: f64);
        corner(corner: Corner);
    }
}
widget!(
    /// Empty room that takes what its stack leaves.
    Spacer
);
impl Spacer {
    pub fn new(key: impl Into<Key>) -> Self {
        Self(Node::spacer(key))
    }
}
widget!(
    /// Stands in for a row left unbuilt outside a scroll region's window, at the height
    /// `ViewState::rect` gave it when it was built.
    Placeholder
);
impl Placeholder {
    pub fn new(key: impl Into<Key>, height: f64) -> Self {
        Self(Node::placeholder(key, height))
    }
}
widget!(
    /// Text (`Gtk.Label`). One line and never cut unless `lines` says it comes from outside.
    Label
);
impl Label {
    pub fn new(key: impl Into<Key>, text: impl Into<String>, style: TextStyle) -> Self {
        Self(Node::text(key, text, style))
    }
    setters! {
        ink(ink: Ink);
        /// Text from outside: wrapped to `n` lines and ended in an ellipsis.
        lines(n: usize);
        /// At least `n` lines tall however few it fills.
        reserve(n: usize);
        /// As wide as the widest of `texts`, so a changing value never moves its neighbours.
        room(texts: Vec<String>);
        /// Not drawn while `pane` is hovered or holds the focus; it keeps its room.
        hidden_with(pane: impl Into<Key>);
    }
}
widget!(
    /// An interface glyph by its `nd-` name (`Gtk.Image`).
    Image
);
impl Image {
    pub fn new(key: impl Into<Key>, name: impl Into<String>, size: f64) -> Self {
        Self(Node::icon(key, name, size))
    }
    /// A raster previously supplied to the window under this identifier.
    pub fn picture(mut self) -> Self {
        if let Kind::Icon(icon) = &mut self.0.kind {
            icon.picture = true;
        }
        self
    }
    /// Use the application icon theme, with a Nidara interface glyph as the fallback.
    pub fn app_theme(mut self, fallback: impl Into<String>) -> Self {
        if let Kind::Icon(icon) = &mut self.0.kind {
            icon.app_fallback = Some(fallback.into());
        }
        self
    }
    setters! {
        ink(ink: Ink);
        /// Its ink at `alpha` of its own opacity.
        alpha(alpha: f64);
    }
}
widget!(
    /// A person's picture, `size` across, cut to a circle (`Adw.Avatar`): the raster supplied
    /// under `picture`'s identifier when there is one, the default avatar glyph when there is
    /// not. Decoration to a reader: the name next to it, or the button it is in, says who.
    Avatar
);
impl Avatar {
    pub fn new(key: impl Into<Key>, size: f64) -> Self {
        let mut node = Node::icon(key, AVATAR_GLYPH, size).presentational();
        if let Kind::Icon(icon) = &mut node.kind {
            icon.round = true;
        }
        Self(node)
    }
    /// The raster supplied to the surface under `id` (`AppWindow::set_pictures`,
    /// `Glyphs::set_pictures`); the default glyph while it is missing.
    pub fn picture(mut self, id: impl Into<String>) -> Self {
        if let Kind::Icon(icon) = &mut self.0.kind {
            icon.name = id.into();
            icon.picture = true;
            icon.app_fallback = Some(AVATAR_GLYPH.into());
        }
        self
    }
    /// A dot on its lower right: something about the person shown on their picture (on the
    /// login screen, that their session is open). Say it to readers too.
    pub fn mark(mut self, on: bool) -> Self {
        if let Kind::Icon(icon) = &mut self.0.kind {
            icon.mark = on;
        }
        self
    }
}
const AVATAR_GLYPH: &str = "nd-avatar-default";
widget!(
    /// Room the app paints in itself, `size` square: a picture, a mark, a gauge. Never a control.
    Slot
);
impl Slot {
    pub fn new(key: impl Into<Key>, size: f64) -> Self {
        Self(Node::slot(key, size))
    }
}
widget!(
    /// A button (`Gtk.Button`). `new` gives a labelled one in a page's content; `with_child`
    /// one whose content is anything (a tile, a card, a row), on glass when it is in a pane.
    Button
);
impl Button {
    pub fn new(
        key: impl Into<Key>,
        label: impl Into<String>,
        action: impl Into<String>,
        style: TextStyle,
    ) -> Self {
        Self(Node::button(key, label, action, style))
    }
    /// `name` is what a reader calls it; `action` is reported when it is pressed.
    pub fn with_child(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        child: impl Into<Node>,
    ) -> Self {
        Self(Node::control(key, name, action, child.into()))
    }
    control_setters!();
    setters! {
        /// What it is to a reader and to the keys: a toggle, a radio, an option…
        role(r: Role);
        /// Its state as a toggle, radio or option.
        marked(on: bool);
        /// Whether the component it holds is on (a tile's switch, a toggle's light).
        on(on: bool);
        /// Its content drawn on the kit's own surface rather than glass.
        surface();
        /// Swiped across, its card follows the pointer and, released far enough, reports
        /// `action`.
        swipe(action: impl Into<String>);
    }
    /// In a page's content: `Default` for the action the page is for, in the accent (Save,
    /// Open; `.suggested-action`, AppKit's default button), `Destructive` for one that
    /// deletes or discards, in red (`.destructive-action`). `Normal` otherwise (owner, #1156).
    pub fn appearance(self, appearance: ButtonAppearance) -> Self {
        Self(self.0.button_appearance(appearance))
    }
}
widget!(
    /// A pill displaying the current family and size in its own font.
    FontButton
);
impl FontButton {
    pub fn new(key: impl Into<Key>, font: &FontChoice, action: impl Into<String>) -> Self {
        Self(
            Button::new(
                key,
                font.caption(),
                action,
                font.text_style(TextStyle::default()),
            )
            .corner(Corner::Pill)
            .into(),
        )
    }
    control_setters!();
}
widget!(
    /// An on/off switch (`Gtk.Switch`): only the switch responds, never its row.
    Switch
);
impl Switch {
    /// `name` is what its row says; `action` is reported on each flip.
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        on: bool,
    ) -> Self {
        Self(Node::switch_control(key, name, action, on))
    }
    /// The switch as drawn only, for a row that is itself the control.
    pub fn drawn(key: impl Into<Key>, on: bool) -> Self {
        Self(Node::switch(key, on))
    }
    control_setters!();
}
widget!(
    /// A checkbox, or a radio of a group (`Gtk.CheckButton`). A group's radios go next to each
    /// other: the arrows move the choice and Tab stops at the group once.
    CheckButton
);
impl CheckButton {
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        on: bool,
    ) -> Self {
        Self(Node::check_control(key, name, action, on))
    }
    /// One radio of a group; `action` is reported when it is chosen.
    pub fn radio(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        chosen: bool,
    ) -> Self {
        Self(Node::radio_control(key, name, action, chosen))
    }
    /// The checkbox's mark as drawn only.
    pub fn drawn(key: impl Into<Key>, on: bool) -> Self {
        Self(Node::check(key, on))
    }
    /// The radio's mark as drawn only.
    pub fn radio_drawn(key: impl Into<Key>, chosen: bool) -> Self {
        Self(Node::radio(key, chosen))
    }
    control_setters!();
}
widget!(
    /// One choice of several, shown closed as the chosen one, its options in a list over the
    /// window (`Gtk.DropDown`).
    DropDown
);
impl DropDown {
    /// `name` is what a reader calls it; `action` is reported when another option is chosen,
    /// read which with `ViewState::value`.
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        options: Vec<String>,
        chosen: usize,
    ) -> Self {
        Self(Node::dropdown(
            key,
            crate::view::Dropdown {
                name: name.into(),
                options,
                chosen,
                action: action.into(),
                disabled: false,
            },
        ))
    }
    control_setters!();
}
widget!(
    /// A button with a glyph that opens a list of commands (`Gtk.MenuButton`): a bar's power
    /// menu. Row `n` chosen reports `action` with `Value::Index(n)`, every time; `ticked`
    /// marks the row that is current, when there is one (the language in use); `checks` the
    /// rows that are on, in a menu of things each on or off (large text, the screen reader).
    MenuButton
);
impl MenuButton {
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        glyph: impl Into<String>,
        options: Vec<String>,
    ) -> Self {
        Self(Node::menu_button(
            key,
            name,
            action,
            crate::components::MenuButton {
                glyph: glyph.into(),
                options,
                ticked: None,
                checks: Vec::new(),
            },
        ))
    }
    pub fn ticked(mut self, n: Option<usize>) -> Self {
        if let Kind::Control(c) = &mut self.0.kind
            && let Some(Part::MenuButton(b)) = c.part.as_deref_mut()
        {
            b.ticked = n;
        }
        self
    }
    pub fn checks(mut self, rows: Vec<usize>) -> Self {
        if let Kind::Control(c) = &mut self.0.kind
            && let Some(Part::MenuButton(b)) = c.part.as_deref_mut()
        {
            b.checks = rows;
        }
        self
    }
    control_setters!();
}
widget!(
    /// One choice of a few, all shown side by side, the chosen one in the accent (GTK's linked
    /// toggle buttons). Segment `n` reports `"{action}:{n}"`.
    Segmented
);
impl Segmented {
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        options: Vec<String>,
        chosen: usize,
    ) -> Self {
        Self(Node::segmented(
            key,
            crate::view::Segmented {
                name: name.into(),
                options,
                chosen,
                action: action.into(),
                disabled: false,
            },
        ))
    }
    pub fn enabled(mut self, on: bool) -> Self {
        if let Kind::Drawing(d) = &mut self.0.kind
            && let Part::Segmented(s) = d.part.as_mut()
        {
            s.disabled = !on;
        }
        self
    }
    setters! {
        /// Gallery fixture: segment `index` shown in `shown` for good.
        sample_state(index: usize, shown: Shown);
    }
}
widget!(
    /// Colour samples, one radio group; choice `n` reports `"{action}:{n}"`.
    Swatches
);
impl Swatches {
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        colors: Vec<(String, nk_render::Color)>,
        chosen: usize,
    ) -> Self {
        Self(Node::swatches(
            key,
            crate::view::Swatches {
                name: name.into(),
                colors,
                chosen,
                action: action.into(),
                disabled: false,
            },
        ))
    }
    pub fn enabled(mut self, on: bool) -> Self {
        if let Kind::Drawing(d) = &mut self.0.kind
            && let Part::Swatches(s) = d.part.as_mut()
        {
            s.disabled = !on;
        }
        self
    }
    setters! {
        sample_state(index: usize, shown: Shown);
    }
}
/// What a slider holds: a value in a range, and how the value is said.
pub use crate::view::Slider as SliderRange;
widget!(
    /// A value in a range, set by dragging or by the keys (AppKit's `NSSlider`). `action` is
    /// reported on every change; read the value with `ViewState::value`.
    Slider
);
impl Slider {
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        range: SliderRange,
    ) -> Self {
        Self(Node::slider(key, name, action, range))
    }
    /// What a tile slider holds (its glyph and title), drawn dark where the fill has reached it.
    pub fn child(mut self, content: impl Into<Node>) -> Self {
        if let Kind::Control(c) = &mut self.0.kind {
            *c.child = content.into();
        }
        self
    }
    control_setters!();
}
/// A slider and its value, for a list row to end with: the slider at the kit's width, its
/// glyphs either side when it has them, its value after it in room for its widest text.
#[must_use]
pub struct SliderEnd {
    key: Key,
    end: EndSpec,
}
impl SliderEnd {
    /// `name` is its row's title; the value is drawn in `value_style`.
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        range: SliderRange,
        value_style: TextStyle,
    ) -> Self {
        Self {
            key: key.into(),
            end: EndSpec {
                name: name.into(),
                action: action.into(),
                slider: range,
                value_style,
                icons: None,
                disabled: false,
            },
        }
    }
    /// The glyphs at its lesser and greater ends (`nd-` names).
    pub fn icons(mut self, icons: [String; 2]) -> Self {
        self.end.icons = Some(icons);
        self
    }
    pub fn enabled(mut self, on: bool) -> Self {
        self.end.disabled = !on;
        self
    }
}
impl From<SliderEnd> for Node {
    fn from(s: SliderEnd) -> Node {
        Node::slider_end(s.key, s.end)
    }
}
widget!(
    /// One line of text the app owns and edits itself: what it shows, its caret and selection.
    /// A secret one is handed over as its bullets, never its text.
    Field
);
/// What a `Field` shows.
pub use crate::view::Field as FieldState;
impl Field {
    /// `action` is its Enter.
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        state: FieldState,
        style: TextStyle,
    ) -> Self {
        Self(Node::field(key, name, action, state, style))
    }
    control_setters!();
}
widget!(
    /// One line of text the kit edits: caret, selection, clipboard and input methods
    /// (`Gtk.Entry`). `changed` is reported with the new text as its value.
    Entry
);
impl Entry {
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        changed: impl Into<String>,
        text: impl Into<String>,
    ) -> Self {
        Self(EditableField::new(text).node(key, name, changed))
    }
    fn editable(&mut self) -> Option<&mut EditableField> {
        match &mut self.0.kind {
            Kind::Control(c) => match c.part.as_deref_mut() {
                Some(Part::Editable(e)) => Some(e),
                _ => None,
            },
            _ => None,
        }
    }
    /// Shown, dimmed, while it is empty.
    pub fn placeholder(mut self, text: impl Into<String>) -> Self {
        if let Some(e) = self.editable() {
            e.placeholder = text.into();
        }
        self
    }
    /// Reported when Enter is pressed in it.
    pub fn submit(mut self, action: impl Into<String>) -> Self {
        if let Some(e) = self.editable() {
            e.submit = Some(action.into());
        }
        self
    }
    /// Without its own field chrome, for a piece that draws its own around it.
    pub fn bare(mut self) -> Self {
        if let Some(e) = self.editable() {
            e.chrome = false;
        }
        self
    }
    /// Escape empties it.
    pub fn escape_clears(mut self) -> Self {
        if let Some(e) = self.editable() {
            e.escape_clears = true;
        }
        self
    }
    control_setters!();
}
widget!(
    /// A single-line password field that publishes only a redacted application payload.
    PasswordEntry
);
impl PasswordEntry {
    pub fn new(key: impl Into<Key>, name: impl Into<String>, changed: impl Into<String>) -> Self {
        let key = key.into();
        let mut node = Node::control(
            key.clone(),
            name,
            changed,
            Node::spacer(format!("{}/body", key.0)),
        )
        .role(Role::Field);
        if let Kind::Control(control) = &mut node.kind {
            control.part = Some(Box::new(Part::Password(
                crate::components::PasswordEntry::default(),
            )));
        }
        Self(node)
    }
    /// A button inside the field, at its end, that reports `action` (#1195): the pointer's
    /// way to do what Enter does. `label` is its name for readers ("Unlock", "Log in").
    pub fn submit(self, label: impl Into<String>, action: impl Into<String>) -> Self {
        let Kind::Control(control) = &self.0.kind else {
            return self;
        };
        let part = crate::components::PasswordSubmit {
            name: control.name.clone(),
            changed: control.action.clone(),
            submit_label: label.into(),
            submit: action.into(),
            disabled: !control.enabled,
            peek: None,
            revealed: control
                .part
                .as_deref()
                .is_some_and(|p| matches!(p, Part::Password(e) if e.revealed)),
        };
        Self(part.node(self.0.key.clone()))
    }
    /// Draw the characters as typed instead of as dots. The app keeps this, as it keeps a
    /// switch's state, and changes it on the `peek` action.
    pub fn revealed(mut self, on: bool) -> Self {
        match &mut self.0.kind {
            Kind::Control(c) => {
                if let Some(Part::Password(e)) = c.part.as_deref_mut() {
                    e.revealed = on;
                }
            }
            Kind::Drawing(d) => {
                if let Part::PasswordSubmit(p) = d.part.as_mut() {
                    p.revealed = on;
                }
            }
            _ => {}
        }
        self
    }
    /// A button inside the field, before the submit one, that shows the characters or
    /// hides them again (GTK's `show-peek-icon`); it reports `action`, and the app flips
    /// `revealed`. `show` and `hide` are its names for readers in each state. It goes with
    /// `submit`, whose row it shares; call it after.
    pub fn peek(
        mut self,
        show: impl Into<String>,
        hide: impl Into<String>,
        action: impl Into<String>,
    ) -> Self {
        if let Kind::Drawing(d) = &mut self.0.kind
            && let Part::PasswordSubmit(p) = d.part.as_mut()
        {
            p.peek = Some(crate::components::Peek {
                action: action.into(),
                show_label: show.into(),
                hide_label: hide.into(),
            });
        }
        self
    }
    control_setters!();
}

widget!(
    /// A time of day, hours and minutes (`NSDatePicker` in its hour-and-minute mode): one
    /// field, one Tab stop. Left and Right pick the part, Up and Down step it, digits type it.
    /// `changed` is reported on every change with "HH:MM" (24 h) as its value.
    TimeField
);
impl TimeField {
    /// `time` is "HH:MM"; anything else shows 00:00.
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        changed: impl Into<String>,
        time: &str,
        style: TextStyle,
    ) -> Self {
        let (hour, minute) = crate::components::parse_time(time).unwrap_or((0, 0));
        Self(
            crate::components::TimeField {
                hour,
                minute,
                style,
            }
            .node(key, name, changed),
        )
    }
    control_setters!();
}
/// A search field: the entry, the search glyph and its clear button (`Gtk.SearchEntry`).
#[must_use]
pub struct SearchEntry {
    key: Key,
    search: Search,
    width: Option<f64>,
}
impl SearchEntry {
    /// `changed` is reported with the new text; `clear_label` is what a reader calls the clear
    /// button.
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        changed: impl Into<String>,
        text: impl Into<String>,
        clear_label: impl Into<String>,
    ) -> Self {
        let field = EditableField::new(text);
        Self {
            key: key.into(),
            search: Search {
                field,
                name: name.into(),
                changed: changed.into(),
                clear_label: clear_label.into(),
                disabled: false,
                shown: None,
                suggestions: None,
            },
            width: None,
        }
    }
    pub fn width(mut self, px: f64) -> Self {
        self.width = Some(px);
        self
    }
    pub fn placeholder(mut self, text: impl Into<String>) -> Self {
        self.search.field.placeholder = text.into();
        self
    }
    pub fn submit(mut self, action: impl Into<String>) -> Self {
        self.search.field.submit = Some(action.into());
        self
    }
    pub fn enabled(mut self, on: bool) -> Self {
        self.search.disabled = !on;
        self
    }
    /// The [ListBox] under it that offers what the text matches: Down moves from the field to
    /// its first row and Up from that row back to the field.
    pub fn suggestions(mut self, list: impl Into<Key>) -> Self {
        self.search.suggestions = Some(list.into());
        self
    }
    /// Gallery fixture: its part `index` (0 the entry, 1 the clear button) shown in `shown`.
    pub fn sample_state(mut self, index: usize, shown: Shown) -> Self {
        self.search.shown = Some((index, shown));
        self
    }
}
impl From<SearchEntry> for Node {
    fn from(s: SearchEntry) -> Node {
        let n = s.search.node(s.key);
        match s.width {
            Some(w) => n.width(w),
            None => n,
        }
    }
}
/// A header that shows and hides what follows it (`Gtk.Expander`). Only the app changes
/// whether it is open: activation reports a Bool and the next build follows it.
#[must_use]
pub struct Expander {
    key: Key,
    action: String,
    disclosure: Disclosure,
    content: Option<Node>,
    enabled: bool,
    shown: Option<Shown>,
}
impl Expander {
    pub fn new(
        key: impl Into<Key>,
        label: impl Into<String>,
        action: impl Into<String>,
        expanded: bool,
    ) -> Self {
        Self {
            key: key.into(),
            action: action.into(),
            disclosure: Disclosure {
                label: label.into(),
                expanded,
            },
            content: None,
            enabled: true,
            shown: None,
        }
    }
    /// What it shows when open. Without it, the expander is its header alone.
    pub fn child(mut self, content: impl Into<Node>) -> Self {
        self.content = Some(content.into());
        self
    }
    pub fn enabled(mut self, on: bool) -> Self {
        self.enabled = on;
        self
    }
    /// Gallery fixture: its header shown in `state` for good.
    pub fn shown(mut self, state: Shown) -> Self {
        self.shown = Some(state);
        self
    }
}
impl From<Expander> for Node {
    fn from(e: Expander) -> Node {
        let open = e.disclosure.expanded;
        let header_key = match e.content {
            Some(_) => Key(format!("{}/header", e.key.0)),
            None => e.key.clone(),
        };
        let mut header = e.disclosure.header(header_key, e.action);
        if !e.enabled {
            header = header.enabled(false);
        }
        if let Some(state) = e.shown {
            header = header.shown(state);
        }
        match e.content {
            Some(content) => Node::column(
                e.key.clone(),
                vec![
                    header,
                    Node::reveal(format!("{}/content", e.key.0), open, content),
                ],
            ),
            None => header,
        }
    }
}
/// A long list that builds only the rows in view and the selected one, with single selection
/// (`Gtk.ListView`). Its rows come from a `ListSource`.
pub struct ListView<'a, S: ListSource + ?Sized> {
    key: Key,
    name: String,
    changed: String,
    list: LongList,
    window: Option<(f64, f64)>,
    source: &'a S,
    height: Option<f64>,
    width: Option<f64>,
    enabled: bool,
    shown: Option<Shown>,
}
impl<'a, S: ListSource + ?Sized> ListView<'a, S> {
    /// `count` rows of `row_height`, `selected` chosen; `changed` is reported when the choice
    /// moves.
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        changed: impl Into<String>,
        source: &'a S,
        count: usize,
        selected: usize,
        row_height: f64,
    ) -> Self {
        Self {
            key: key.into(),
            name: name.into(),
            changed: changed.into(),
            list: LongList::new(count, selected, row_height),
            window: None,
            source,
            height: None,
            width: None,
            enabled: true,
            shown: None,
        }
    }
    pub fn width(mut self, px: f64) -> Self {
        self.width = Some(px);
        self
    }
    /// Gallery fixture: shown in `state` for good.
    pub fn shown(mut self, state: Shown) -> Self {
        self.shown = Some(state);
        self
    }
    /// Laid out at this height, from a token: how many rows it shows.
    pub fn height(mut self, px: f64) -> Self {
        self.height = Some(px);
        self
    }
    pub fn enabled(mut self, on: bool) -> Self {
        self.enabled = on;
        self
    }
    /// Multiple selection. The selection action reports indices and a range anchor
    /// through `Value::Selection`. Arrows only move the cursor.
    pub fn multiple(
        mut self,
        selected: std::collections::BTreeSet<usize>,
        anchor: Option<usize>,
        changed: impl Into<String>,
    ) -> Self {
        self.list.multiple = Some(crate::components::MultipleSelection {
            selected,
            anchor,
            changed: changed.into(),
        });
        self
    }
    pub fn columns(mut self, count: usize) -> Self {
        self.list.columns = count.max(1);
        self
    }
    /// A row above the rows naming their columns, laid out as a row is (its titles over
    /// their columns); it does not scroll.
    pub fn header(mut self, header: impl Into<Node>) -> Self {
        self.list.header = Some(Box::new(header.into()));
        self
    }
    /// In a grid (`columns` > 1), every tile this wide, centred in its column.
    pub fn tile_width(mut self, width: f64) -> Self {
        self.list.tile_width = Some(width);
        self
    }
    /// The currently selected row, or none when a filter hides it.
    pub fn selected(mut self, index: Option<usize>) -> Self {
        self.list.selected = index;
        self
    }
    /// The part of the list in view, `(offset, height)`, from `Host::scroll_window` with
    /// `ListView::scroll_key`; without it only the selected row is built.
    pub fn window(mut self, window: Option<(f64, f64)>) -> Self {
        self.window = window;
        self
    }
    /// Reported when a row is activated (double-click, Enter).
    pub fn activate(mut self, action: impl Into<String>) -> Self {
        self.list.activate = Some(action.into());
        self
    }
}
impl ListView<'static, dyn ListSource> {
    /// The key of a list's scroll region, for `Host::scroll_window`.
    pub fn scroll_key(key: &Key) -> Key {
        LongList::scroll_key(key)
    }
}
impl<S: ListSource + ?Sized> From<ListView<'_, S>> for Node {
    fn from(l: ListView<'_, S>) -> Node {
        let mut n = l
            .list
            .node(l.key, l.name, l.changed, l.window, l.source)
            .enabled(l.enabled);
        if let Some(h) = l.height {
            n = n.height(h);
        }
        if let Some(w) = l.width {
            n = n.width(w);
        }
        if let Some(state) = l.shown {
            n = n.shown(state);
        }
        n
    }
}
/// A list row: its title, a second line under it, what it starts and ends with, in any list or
/// group of rows.
#[must_use]
pub struct ListRow {
    key: Key,
    row: crate::view::ListRow,
    role: Option<Role>,
    marked: Option<bool>,
    shown: Option<Shown>,
}
impl ListRow {
    pub fn new(key: impl Into<Key>, title: impl Into<String>, title_style: TextStyle) -> Self {
        Self {
            key: key.into(),
            row: crate::view::ListRow {
                title: title.into(),
                title_style,
                ..Default::default()
            },
            role: None,
            marked: None,
            shown: None,
        }
    }
    /// The second line, under its title.
    pub fn subtitle(mut self, text: impl Into<String>, style: TextStyle) -> Self {
        self.row.subtitle = Some(text.into());
        self.row.subtitle_style = style;
        self
    }
    /// What it starts with, before its title: an icon (`Adw.ActionRow`'s prefix).
    pub fn leading(mut self, start: impl Into<Node>) -> Self {
        self.row.leading = Some(start.into());
        self
    }
    /// What it ends with. In a row that is not activatable, a control that responds on its own;
    /// in an activatable one, what it shows, drawn only.
    pub fn trailing(mut self, end: impl Into<Node>) -> Self {
        self.row.trailing = Some(end.into());
        self
    }
    /// The row responds as a whole and reports `action` (GNOME's activatable row).
    pub fn action(mut self, action: impl Into<String>) -> Self {
        self.row.action = Some(action.into());
        self
    }
    pub fn enabled(mut self, on: bool) -> Self {
        self.row.disabled = !on;
        self
    }
    /// An activatable row's role: a row that flips the switch it shows is a toggle.
    pub fn role(mut self, r: Role) -> Self {
        self.role = Some(r);
        self
    }
    /// An activatable row's state as a toggle.
    pub fn marked(mut self, on: bool) -> Self {
        self.marked = Some(on);
        self
    }
    /// Gallery fixture: an activatable row shown in `state` for good.
    pub fn shown(mut self, state: Shown) -> Self {
        self.shown = Some(state);
        self
    }
}
impl From<ListRow> for Node {
    fn from(r: ListRow) -> Node {
        let mut n = Node::list_row(r.key, r.row);
        if let Some(role) = r.role {
            n = n.role(role);
        }
        if let Some(on) = r.marked {
            n = n.marked(on);
        }
        if let Some(state) = r.shown {
            n = n.shown(state);
        }
        n
    }
}
/// One selectable row in a [ListBox].
#[must_use]
pub struct ListBoxOption {
    title: String,
    subtitle: Option<String>,
    icon: Option<String>,
}
impl ListBoxOption {
    pub fn new(title: impl Into<String>) -> Self {
        Self {
            title: title.into(),
            subtitle: None,
            icon: None,
        }
    }
    /// A second line under the title, in the list's subtitle style.
    pub fn subtitle(mut self, text: impl Into<String>) -> Self {
        self.subtitle = Some(text.into());
        self
    }
    pub fn icon(mut self, name: impl Into<String>) -> Self {
        self.icon = Some(name.into());
        self
    }
}

/// A short, single-selection list for the inside of a group. Up and Down move focus;
/// activating a row reports its index. The caller supplies the current selection.
#[must_use]
pub struct ListBox {
    key: Key,
    name: String,
    action: String,
    options: Vec<ListBoxOption>,
    style: TextStyle,
    subtitle_style: Option<TextStyle>,
    selected: Option<usize>,
    enabled: bool,
}
impl ListBox {
    pub fn new(
        key: impl Into<Key>,
        name: impl Into<String>,
        action: impl Into<String>,
        options: Vec<ListBoxOption>,
        style: TextStyle,
    ) -> Self {
        Self {
            key: key.into(),
            name: name.into(),
            action: action.into(),
            options,
            style,
            subtitle_style: None,
            selected: None,
            enabled: true,
        }
    }
    /// The style of the options' subtitles (the title's when not given).
    pub fn subtitle_style(mut self, style: TextStyle) -> Self {
        self.subtitle_style = Some(style);
        self
    }
    pub fn selected(mut self, index: Option<usize>) -> Self {
        self.selected = index;
        self
    }
    pub fn enabled(mut self, on: bool) -> Self {
        self.enabled = on;
        self
    }
}
impl From<ListBox> for Node {
    fn from(list: ListBox) -> Self {
        let rows = list
            .options
            .into_iter()
            .enumerate()
            .map(|(index, option)| {
                let key = format!("{}/{index}", list.key.0);
                let selected = list.selected == Some(index);
                let mut row = ListRow::new(key.clone(), option.title, list.style.clone())
                    .action(&list.action)
                    .role(Role::Option)
                    .enabled(list.enabled)
                    .marked(selected);
                if let Some(text) = option.subtitle {
                    let style = list.subtitle_style.clone();
                    row = row.subtitle(text, style.unwrap_or_else(|| list.style.clone()));
                }
                let ink = if list.enabled {
                    Ink::Primary
                } else {
                    Ink::Disabled
                };
                row.row.leading = option
                    .icon
                    .map(|name| Node::icon(format!("{key}/icon"), name, 20.).ink(ink));
                if selected {
                    row = row.trailing(
                        Node::icon(format!("{key}/check"), "nd-emblem-default", 16.).ink(ink),
                    );
                }
                let mut node = Node::from(row).value(Value::Index(index));
                if let Kind::Control(c) = &mut node.kind
                    && let Some(Part::Surface(surface)) = c.part.as_deref_mut()
                {
                    surface.selection_group = Some(list.key.clone());
                }
                node
            })
            .collect();
        let mut node = Node::column(list.key, rows);
        if let Kind::Stack(stack) = &mut node.kind {
            stack.list_name = Some(list.name);
        }
        node
    }
}

/// An entry of a window's sidebar: a page the app can show (`Gtk.StackSidebar`'s row). The
/// selected one is filled with the accent.
#[must_use]
pub struct SidebarEntry {
    key: Key,
    entry: crate::view::SidebarEntry,
    glyph_size: f64,
    width: Option<f64>,
    shown: Option<Shown>,
    enabled: bool,
    value: Option<Value>,
}
impl SidebarEntry {
    /// Its glyph by `nd-` name at `glyph_size` (the frame's), its title in `style`; `action` is
    /// reported when it is chosen.
    pub fn new(
        key: impl Into<Key>,
        title: impl Into<String>,
        glyph: impl Into<String>,
        action: impl Into<String>,
        style: TextStyle,
        glyph_size: f64,
    ) -> Self {
        Self {
            key: key.into(),
            entry: crate::view::SidebarEntry {
                title: title.into(),
                glyph: glyph.into(),
                action: action.into(),
                selected: false,
                style,
            },
            glyph_size,
            width: None,
            shown: None,
            enabled: true,
            value: None,
        }
    }
    /// It is the page shown.
    pub fn selected(mut self, on: bool) -> Self {
        self.entry.selected = on;
        self
    }
    pub fn width(mut self, px: f64) -> Self {
        self.width = Some(px);
        self
    }
    pub fn enabled(mut self, on: bool) -> Self {
        self.enabled = on;
        self
    }
    pub fn value(mut self, value: Value) -> Self {
        self.value = Some(value);
        self
    }
    /// Gallery fixture: shown in `state` for good.
    pub fn shown(mut self, state: Shown) -> Self {
        self.shown = Some(state);
        self
    }
}
impl From<SidebarEntry> for Node {
    fn from(s: SidebarEntry) -> Node {
        let mut n = Node::sidebar_entry(s.key, s.entry, s.glyph_size).enabled(s.enabled);
        if let Some(value) = s.value {
            n = n.value(value);
        }
        if let Some(w) = s.width {
            n = n.width(w);
        }
        if let Some(state) = s.shown {
            n = n.shown(state);
        }
        n
    }
}
/// A window's sidebar (`Gtk.StackSidebar`, Finder's and Settings' source list): its entries,
/// in sections under an optional heading, scrolled on their own. The ONE sidebar of the kit
/// (#1148): its padding, the space between entries and between sections, the headings' type
/// and the scrolling are the kit's, never an app's, so the gallery, Settings, the file chooser
/// and every later app show the same sidebar. The wheel over it scrolls it, not the page.
#[must_use]
pub struct SidebarList {
    key: Key,
    sections: Vec<SidebarSection>,
}
/// A section of a sidebar: its heading and that heading's type, if any, and its entries.
type SidebarSection = (Option<(String, TextStyle)>, Vec<Node>);
impl SidebarList {
    pub fn new(key: impl Into<Key>) -> Self {
        Self {
            key: key.into(),
            sections: Vec::new(),
        }
    }
    /// A section without a heading: an app's pages.
    pub fn entries(mut self, entries: impl IntoIterator<Item = SidebarEntry>) -> Self {
        self.sections
            .push((None, entries.into_iter().map(Node::from).collect()));
        self
    }
    /// A section under `heading` (Places, Bookmarks), in `style`, the app's caption type. An
    /// empty section is left out, its heading too.
    pub fn section(
        mut self,
        heading: impl Into<String>,
        style: TextStyle,
        entries: impl IntoIterator<Item = SidebarEntry>,
    ) -> Self {
        self.sections.push((
            Some((heading.into(), style)),
            entries.into_iter().map(Node::from).collect(),
        ));
        self
    }
}
impl From<SidebarList> for Node {
    fn from(list: SidebarList) -> Node {
        let key = list.key.0;
        let sections = list
            .sections
            .into_iter()
            .enumerate()
            .filter(|(_, (_, entries))| !entries.is_empty())
            .map(|(i, (heading, mut entries))| {
                let section = format!("{key}/section/{i}");
                if let Some((text, style)) = heading {
                    // In line with the entries' glyphs (their padding), dimmer than they are.
                    let label =
                        Node::text(format!("{section}/heading"), text, style).ink(Ink::Secondary);
                    entries.insert(
                        0,
                        Node::row(format!("{section}/heading-row"), vec![label]).padding(Padding {
                            top: None,
                            right: Some(Space::S3),
                            bottom: None,
                            left: Some(Space::S3),
                        }),
                    );
                }
                Node::column(section, entries).gap(Space::S1)
            })
            .collect();
        Node::scroll(
            format!("{key}/scroll"),
            Node::column(key, sections)
                .gap(Space::S4)
                .padding(Padding::all(Space::S2)),
        )
    }
}
widget!(
    /// A row of a dropdown's open list or a menu: its label and room for the tick
    /// (`Gtk.PopoverMenu`'s item).
    MenuItem
);
impl MenuItem {
    pub fn new(
        key: impl Into<Key>,
        label: impl Into<String>,
        action: impl Into<String>,
        chosen: bool,
    ) -> Self {
        Self(Node::menu_row(key, label, action, chosen))
    }
    control_setters!();
}

/// What every widget file starts with: `use nk::prelude::*;`.
pub mod prelude {
    pub use super::Widget;
}
