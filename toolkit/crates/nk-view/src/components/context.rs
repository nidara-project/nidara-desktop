// SPDX-License-Identifier: LGPL-3.0-or-later
use super::*;
use crate::{Placed, Role, TextCache};

/// An application-only password payload. It cannot be serialized or printed.
#[derive(Clone, PartialEq)]
pub struct Secret(String);

impl Secret {
    pub(super) fn new(value: String) -> Self {
        Self(value)
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for Secret {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Secret([redacted])")
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Value {
    Bool(bool),
    Number(f64),
    Displacement(f64, f64),
    Index(usize),
    Selection {
        cursor: usize,
        anchor: usize,
        indices: std::collections::BTreeSet<usize>,
    },
    Text(String),
    #[serde(skip)]
    Secret(Secret),
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
#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    Activate,
    Set(Value),
    Expanded(bool),
    Paste(String),
    SetText(String),
    SetSelection(std::ops::Range<usize>),
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub enum Configure {
    ButtonAppearance(crate::components::ButtonAppearance),
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
    pub showing: bool,
    pub focus: Option<&'a Key>,
    pub instance: u64,
    pub clicks: u8,
    pub owns_mark: bool,
    pub fading: bool,
    pub state: Option<&'a dyn Any>,
    pub placed: &'a [Placed],
    pub text: &'a TextCache,
}
impl Read<'_> {
    /// A node in this component's own expanded body, in surface coordinates.
    pub fn part(&self, suffix: &str) -> Option<&Placed> {
        let key = self.key(suffix);
        self.placed.iter().find(|p| p.key == key)
    }
    pub fn focused_part(&self, suffix: &str) -> bool {
        self.focus == Some(&self.key(suffix))
    }
    pub fn reply_target(&self, kind: std::any::TypeId, revision: u64) -> ReplyTarget {
        ReplyTarget {
            owner: self.key.clone(),
            kind,
            instance: self.instance,
            revision,
        }
    }

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
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReplyTarget {
    pub owner: Key,
    pub kind: std::any::TypeId,
    pub instance: u64,
    pub revision: u64,
}
#[derive(Clone, Debug, PartialEq)]
pub enum HostRequest {
    Rebuild { target: ReplyTarget },
    OpenList { owner: Key, list: Box<ListSpec> },
    Copy { text: String },
    Paste { target: ReplyTarget },
    TextInput { input: nk_wayland::TextInput },
    Respond { owner: Key, request: Request },
    Focus { owner: Key },
}
pub trait Host {
    fn request(&mut self, request: HostRequest);
}

/// A rectangle in a scroll region's content coordinates to bring minimally into view.
#[derive(Clone, Debug)]
pub struct RevealRect {
    pub region: Key,
    pub rect: Rect,
}
