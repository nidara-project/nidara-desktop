// SPDX-License-Identifier: LGPL-3.0-or-later
//! Native Display1 consumers. Geometry/brightness are service state, never Config1.
pub mod client;
pub mod model;

pub mod page;

pub mod selector;

#[cfg(test)]
mod tests;
