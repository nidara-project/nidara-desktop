// SPDX-License-Identifier: LGPL-3.0-or-later
//! nk-view: the shell's own small view vocabulary (`toolkit/VIEW.md`, #1048). A surface
//! builds a `Node` tree from its model; `ViewState` lays it out from the spacing tokens,
//! derives hover, press and focus, and gives back what Hyalo draws (a pane per card and its
//! state regions), the semantics, and the content paint. The surface keeps only its model
//! and what an `Activated` means.
mod layout;
mod motion;
mod state;
mod tokens;
mod view;

pub use layout::{Fitted, Placed, Rect, TextCache, What, first_line_centre};
pub use state::{Activated, BUDGET, Frame, FramePane, KeyInput, ScrollBy, Ticked, ViewState};
pub use tokens::{
    Bezier, Look, Motion, Radii, Radius, Space, Spacing, Tokens, Washes, parse_color,
    scrollbar_from,
};
pub use view::{
    Align, Axis, Control, Corner, Icon, Ink, Justify, Key, Kind, Layer, Node, Overlay, Padding,
    Pane, Reveal, Role, Scroll, Stack, Text, Wash,
};

#[cfg(test)]
mod tests;
