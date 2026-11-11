// SPDX-License-Identifier: LGPL-3.0-or-later
//! How any Nidara program learns its appearance (#1072): the one door to it for an app, the
//! shell and Settings alike (`CONTRACT.md` → "The platform"). Nothing here is an app's own.
//!
//! | module | what |
//! |---|---|
//! | `portal` | the four appearance values that pick the token set, plus reduced motion and the font |
//! | `exports` | `settings-data`'s strings and token sets |
//! | `styles` | the exported tokens as `nk-widgets`' styles, once for every reader |
//! | `material` | the exported glass: a panel's and a control's material |
//! | `font_description` | a Pango font description, as the portal gives it |

pub mod exports;
pub mod font_description;
pub mod material;
pub mod portal;
pub mod styles;
