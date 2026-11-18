// SPDX-License-Identifier: LGPL-3.0-or-later
//! nk-view: the kit's one way to build an interface, for applications and the shell alike
//! (`toolkit/VIEW.md`, #1048, §13 #1079). A window or surface builds a `Node` tree from its
//! model; `ViewState` lays it out from the spacing tokens,
//! derives hover, press and focus, and gives back what Hyalo draws (a pane per card and its
//! state regions), the semantics, and the content paint. The surface keeps only its model
//! and what an `Activated` means.
pub mod components;
pub use components::{ListSource, RowInfo};
mod host;
mod layout;
mod motion;
mod state;
mod tokens;
mod view;

mod frame;
mod window;
pub use frame::{BACK, Band, FORWARD, FrameStyle, SIDEBAR, Sidebar};
pub use host::{Glyphs, Type, TypeScale, Weight};
pub use layout::{Fitted, Placed, Rect, TextCache, What, first_line_centre};
pub use state::{Activated, BUDGET, Frame, FramePane, KeyInput, ScrollBy, Ticked, ViewState};
pub use tokens::{
    Bezier, ButtonStyle, CheckStyle, DisclosureStyle, DropdownStyle, EntryStyle, ListStyle, Look,
    MenuStyle, Motion, Radii, Radius, SegmentStyle, SliderStyle, Space, Spacing, SwatchStyle,
    SwitchStyle, Tokens, TriggerStyle, Washes, button_from, check_from, disclosure_from,
    dropdown_from, entry_from, list_from, parse_color, scrollbar_from, segmented_from, slider_from,
    swatch_from, switch_from,
};
pub use view::{
    Align, Axis, Cell, Corner, Ink, Justify, Key, Kind, Layer, Node, Padding, Role, Shown, Wash,
};
/// What a node holds, by kind: for code that reads a built tree (tests, semantics), never for
/// building one.
pub mod node {
    pub use crate::view::{Control, Grid, Group, Icon, Overlay, Pane, Reveal, Scroll, Stack, Text};
}
mod widgets;
pub use widgets::{
    Button, CheckButton, Column, DropDown, Entry, Expander, Field, FieldState, Grid, Group, Image,
    Label, ListView, MenuItem, Overlay, Pane, Placeholder, Revealer, Row, Scroll, SearchEntry,
    Segmented, SettingRow, SidebarEntry, Slider, SliderEnd, SliderRange, Slot, Spacer, Swatches,
    Switch, Widget, prelude,
};
pub use window::{
    Alert, AppWindow, CONTENT, Dialog, DialogAnswer, DialogButton, DialogContent, DialogUpdate,
    Labels, Page, WindowLook,
};

#[cfg(test)]
mod tests;

pub use components::{ButtonAppearance, ComponentLook, Drawing, Part};

pub use components::{Host, HostRequest, Value};

#[cfg(test)]
mod editable_tests;

#[cfg(test)]
mod long_list_tests;

pub use components::FocusOutline;
pub use state::LayoutMetrics;
pub use tokens::{FocusStyle, focus_from};
