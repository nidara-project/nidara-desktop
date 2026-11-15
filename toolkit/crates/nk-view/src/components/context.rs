// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
use crate::{Placed, Role, TextCache};

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Value {
    Bool(bool),
    Number(f64),
    Index(usize),
    Text(String),
}
impl Value {
    pub fn number(&self) -> Option<f64> {
        match self {
            Self::Number(n) => Some(*n),
            Self::Index(n) => Some(*n as f64),
            _ => None,
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Capture {
    #[default]
    Keep,
    Take,
    Release,
}
#[derive(Clone, Debug)]
pub enum Request {
    Activate,
    Set(Value),
    Expanded(bool),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Configure {
    Wash(crate::Wash),
    Marked(bool),
    On(bool),
    Surface,
    Accent(bool),
    Corner(Corner),
    Value(Value),
    Sample(usize, crate::Shown),
}
#[derive(Clone, Copy)]
pub struct Read<'a> {
    pub key: &'a Key,
    pub look: ComponentLook<'a>,
    pub rect: Rect,
    pub visible: Rect,
    pub interaction: Interaction,
    pub role: Option<Role>,
    pub focused: bool,
    pub owns_mark: bool,
    pub fading: bool,
    pub state: Option<&'a dyn Any>,
    pub placed: &'a [Placed],
    pub text: &'a TextCache,
}
impl Read<'_> {
    pub fn text(&self, suffix: &str) -> Option<(&Placed, &crate::Fitted)> {
        let key = Key(format!("{}/{suffix}", self.key.0));
        Some((
            self.placed.iter().find(|p| p.key == key)?,
            self.text.get(&key)?,
        ))
    }
    pub fn key(&self, suffix: &str) -> Key {
        format!("{}/{suffix}", self.key.0).into()
    }
}
#[derive(Clone, Debug)]
pub struct SemanticChild {
    pub key: Key,
    pub node: nk_a11y::Node,
    pub value: Option<Value>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ListItem {
    pub key: Key,
    pub value: Value,
    pub name: String,
}
#[derive(Clone, Debug, PartialEq)]
pub struct ListSpec {
    pub node: Node,
    pub items: Vec<ListItem>,
    pub selected: usize,
    pub scroll: Key,
    pub edge: f64,
    pub radius: f64,
    pub border: f64,
    pub border_color: Color,
    pub background: Color,
}
#[derive(Clone, Debug, PartialEq)]
pub enum HostRequest {
    OpenList { owner: Key, list: ListSpec },
}
pub trait Host {
    fn request(&mut self, request: HostRequest);
}
