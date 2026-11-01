// SPDX-License-Identifier: LGPL-3.0-or-later
//! The Rust shell process, starting with the dock (#959 D1). The design is DOCK.md;
//! the contract it implements is session/design/APPLICATIONS1-DOCK.md.
pub mod actions;
pub mod apps;
pub mod attention;
pub mod autohide;
pub mod chooser;
pub mod cycle;
pub mod dock;
pub mod geometry;
pub mod hub;
pub mod hyalo;
pub mod keys;
pub mod material;
pub mod menu;
pub mod model;
pub mod paths;
pub mod popup;
pub mod prefs;
pub mod resize;
pub mod semantics;
pub mod shell1;
pub mod spring;
pub mod thumbs;
pub mod tooltip;
pub mod trash;
