// SPDX-License-Identifier: LGPL-3.0-or-later
//! The native Settings (#915, `toolkit/PHASE1.md`). Configuration rows use Config1;
//! the hardware Display page uses Display1/DisplayBrightness1 directly. Appearance
//! always comes from the Settings portal alone (D4 [A8]).
//!
//! The data layer, which the renderer and the builders read:
//!
//! | module | what |
//! |---|---|
//! | `routing` | the bus names (D1 [A1]) and where a request to open Settings goes (D3) |
//! | `session` | the store and every ordering rule of [A3], pure (no bus) |
//! | `client` | `Config1` over one bus connection, feeding the session |
//! | `portal` | `nk_platform::portal`: the appearance values that pick the token set |
//! | `exports` | the manifest's pages, on top of `nk_platform::exports` (strings, token sets) |
//! | `builders` | Claude's named builders: `accentPicker`, `nightScheduleTimes` |
//! | `render` | a manifest page drawn into a tree: the generic rows, predicates, builders |
//! | `manifest` | the pages, groups, items and predicates, typed |
//! | `styles` | `nk_platform::styles` plus this app's header and wallpaper looks |
//! | `value` | a setting's value as `Config1` carries it |

pub mod builders;
pub mod client;
pub mod dropdown;
pub mod dropdown_builder;
pub mod exports;
pub mod font_builder;
pub mod font_catalog;
pub mod font_chooser;
pub mod header;
pub mod image_load;
pub mod manifest;
pub mod page;
pub mod render;
pub mod routing;
pub mod session;
pub mod styles;
pub mod value;
pub mod window;

pub use nk_platform::{font_description, material, portal};
pub use value::Value;

pub mod wallpaper;

pub mod file_chooser;

pub mod wallpaper_picker;

pub mod search;

pub mod display;
