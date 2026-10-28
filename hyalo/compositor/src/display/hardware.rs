// SPDX-License-Identifier: GPL-3.0-or-later
//! Additive Display1 hardware mapping; brightness I/O belongs to sessiond, not calloop.
use serde::{Deserialize, Serialize};
use zbus::zvariant::Type;
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Output {
    pub id: String,
    pub identity: String,
    pub connector: String,
    pub port: String,
    pub edid: String,
    pub internal: bool,
    pub enabled: bool,
    pub logical: bool,
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Snapshot {
    pub epoch: u64,
    pub revision: u64,
    pub outputs: Vec<Output>,
}
