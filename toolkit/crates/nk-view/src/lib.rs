// SPDX-License-Identifier: LGPL-3.0-or-later
//! nk-view: the kit's one way to build an interface, for applications and the shell alike
//! (`toolkit/VIEW.md`, #1048, §13 #1079). A window or surface builds a `Node` tree from its
//! model; `ViewState` lays it out from the spacing tokens,
//! derives hover, press and focus, and gives back what Hyalo draws (a pane per card and its
//! state regions), the semantics, and the content paint. The surface keeps only its model
//! and what an `Activated` means.
mod host;
mod layout;
mod motion;
mod state;
mod tokens;
mod view;

pub use host::{Glyphs, Type, TypeScale, Weight};
pub use layout::{Fitted, Placed, Rect, TextCache, What, first_line_centre};
pub use state::{Activated, BUDGET, Frame, FramePane, KeyInput, ScrollBy, Ticked, ViewState};
pub use tokens::{
    Bezier, Look, Motion, Radii, Radius, SliderStyle, Space, Spacing, SwitchStyle, Tokens, Washes,
    parse_color, scrollbar_from, slider_from, switch_from,
};
pub use view::{
    Align, Axis, Cell, Control, Corner, Field, Grid, Icon, Ink, Justify, Key, Kind, Layer, Node,
    Overlay, Padding, Pane, Reveal, Role, Scroll, Shown, Slider, Stack, Switch, Text, Wash,
};

#[cfg(test)]
mod tests;
