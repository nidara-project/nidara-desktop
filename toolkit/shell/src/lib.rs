// SPDX-License-Identifier: LGPL-3.0-or-later
//! The Rust shell process, starting with the dock (#959 D1). The design is DOCK.md;
//! the contract it implements is session/design/APPLICATIONS1-DOCK.md.
pub mod actions;
pub mod apps;
pub mod dock;
pub mod geometry;
pub mod hub;
pub mod hyalo;
pub mod keys;
pub mod material;
pub mod model;
pub mod prefs;
pub mod semantics;
pub mod shell1;
