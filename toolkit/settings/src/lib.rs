// SPDX-License-Identifier: LGPL-3.0-or-later
//! The native Settings (#915, `toolkit/PHASE1.md`). This crate holds no setting logic: every
//! value it shows and every change it makes goes through `org.nidara.Config1` (D1), and it
//! paints from the Settings portal alone (D4 [A8]).
//!
//! The data layer, which the renderer and the builders read:
//!
//! | module | what |
//! |---|---|
//! | `session` | the store and every ordering rule of [A3], pure (no bus) |
//! | `client` | `Config1` over one bus connection, feeding the session |
//! | `portal` | the four appearance values that pick the token set, plus reduced motion |
//! | `exports` | `settings-data`: the manifest, the strings, the token sets |
//! | `manifest` | the pages, groups, items and predicates, typed |
//! | `styles` | the exported tokens as `nk-widgets`' styles, once for every reader |
//! | `value` | a setting's value as `Config1` carries it |

pub mod client;
pub mod exports;
pub mod manifest;
pub mod portal;
pub mod session;
pub mod styles;
pub mod value;

pub use value::Value;
