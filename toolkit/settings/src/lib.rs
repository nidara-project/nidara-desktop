// SPDX-License-Identifier: LGPL-3.0-or-later
//! The native Settings (#915, `toolkit/PHASE1.md`). This crate holds no setting logic: every
//! value it shows and every change it makes goes through `org.nidara.Config1` (D1), and it
//! paints from the Settings portal alone (D4 [A8]).
//!
//! The data layer, which the renderer and the builders read:
//!
//! | module | what |
//! |---|---|
//! | `routing` | the bus names (D1 [A1]) and where a request to open Settings goes (D3) |
//! | `session` | the store and every ordering rule of [A3], pure (no bus) |
//! | `client` | `Config1` over one bus connection, feeding the session |
//! | `portal` | the four appearance values that pick the token set, plus reduced motion |
//! | `exports` | `settings-data`: the manifest, the strings, the token sets |
//! | `builders` | Claude's named builders: `accentPicker`, `nightScheduleTimes` |
//! | `render` | a manifest page drawn into a tree: the generic rows, predicates, builders |
//! | `manifest` | the pages, groups, items and predicates, typed |
//! | `styles` | the exported tokens as `nk-widgets`' styles, once for every reader |
//! | `value` | a setting's value as `Config1` carries it |

pub mod builders;
pub mod client;
pub mod dropdown;
pub mod dropdown_builder;
pub mod exports;
pub mod font_builder;
pub mod font_catalog;
pub mod font_chooser;
pub mod font_description;
pub mod header;
pub mod image_load;
pub mod manifest;
pub mod material;
pub mod page;
pub mod portal;
pub mod render;
pub mod routing;
pub mod session;
pub mod styles;
pub mod value;
pub mod window;

pub use value::Value;

pub mod wallpaper;

pub mod file_chooser;

pub mod wallpaper_picker;
