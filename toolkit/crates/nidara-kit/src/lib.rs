// SPDX-License-Identifier: LGPL-3.0-or-later
//! Nidara's toolkit, as an app sees it: `nk::Button`, `nk::Row`, `nk::AppWindow` (#1079).
//!
//! Every piece is a type named for what it is, GTK's name wherever GTK has the same piece, and
//! built one way: `new` with what it cannot do without, chained setters for the rest, and into
//! the tree with `.into()`. Start every file that builds an interface with
//! `use nk::prelude::*;`.
//!
//! ```ignore
//! nk::Column::new("page", vec![
//!     nk::Label::new("page/title", "Profile", title).into(),
//!     nk::Button::new("page/save", "Save", "save", body).into(),
//! ])
//! .gap(nk::Space::S3)
//! ```
//!
//! The pieces live in `nk-view`, the kit's base; this crate is its public name.
pub use nk_text::TextStyle;
pub use nk_view::*;
