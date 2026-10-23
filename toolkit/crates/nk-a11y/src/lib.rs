// SPDX-License-Identifier: LGPL-3.0-or-later
//! Window-owned semantics. All input indices are UTF-8 bytes. Platform indices
//! are Unicode scalar values; graphemes are an editing policy, not AT-SPI units.
use std::{
    collections::{BTreeMap, BTreeSet},
    ops::Range,
    sync::Arc,
};
#[cfg(feature = "atspi")]
pub mod atspi_backend;
#[cfg(feature = "atspi")]
pub mod bridge;
mod geometry;
mod latest;
pub use geometry::{TextGeometry, TextSpan};
pub type Result<T> = std::result::Result<T, String>;
pub type NodeId = u64;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Window,
    Dialog,
    Label,
    TextInput,
    Password,
    ComboBox,
    Option,
    CheckBox,
    Button,
    ToggleButton,
    Panel,
    List,
    ScrollPane,
    /// One of a group's choices; the group is a `Panel` holding them. `checked` is the choice.
    RadioButton,
    /// A value on a range, moved by steps: carries `Node::value`.
    Slider,
    /// A number typed or stepped: carries `Node::value`.
    SpinButton,
}
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct States {
    /// A `Window`/`Dialog` that is the active window (holds keyboard focus). A screen
    /// reader ignores focus inside a window that is not active (#835).
    pub active: bool,
    pub focused: bool,
    pub disabled: bool,
    pub checked: bool,
    pub expanded: bool,
    /// It can open and close (a disclosure row); a combo box always can.
    pub expandable: bool,
    pub selected: bool,
    pub invalid: bool,
    pub hidden: bool,
    /// Retained and visible, but outside the unoccluded viewport.
    pub offscreen: bool,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    Focus,
    Activate,
    SetText,
    SetSelection,
    /// The node's value may be set from outside (AT-SPI `Value.CurrentValue`).
    SetValue,
}
/// A range control's value, in the control's own units (`Slider`, `SpinButton`). The text is
/// what a reader says for it ("4500 K"); without one it says the number.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ValueInfo {
    pub min: f64,
    pub max: f64,
    pub current: f64,
    /// The smallest change the control makes; 0: continuous.
    pub step: f64,
    pub text: String,
}
impl ValueInfo {
    pub fn validate(&self) -> Result<()> {
        if ![self.min, self.max, self.current, self.step]
            .iter()
            .all(|v| v.is_finite())
            || self.min > self.max
            || self.step < 0.
            || self.current < self.min
            || self.current > self.max
        {
            return Err("value outside its range, or a range that is not one".into());
        }
        Ok(())
    }
}
/// Plain app-supplied data. `lines` includes soft wraps from the painted layout.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct TextInfo {
    pub text: String,
    pub caret: usize,
    pub anchor: usize,
    pub words: Vec<Range<usize>>,
    pub lines: Vec<Range<usize>>,
    pub geometry: Option<TextGeometry>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Relation {
    LabelledBy(NodeId),
    LabelFor(NodeId),
}
#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    pub id: NodeId,
    pub role: Role,
    pub name: String,
    pub description: String,
    pub states: States,
    pub actions: Vec<Action>,
    pub bounds: Bounds,
    pub text: Option<TextInfo>,
    pub value: Option<ValueInfo>,
    pub children: Vec<NodeId>,
    pub relations: Vec<Relation>,
    pub attributes: BTreeMap<String, String>,
}
impl Node {
    pub fn new(id: NodeId, role: Role, name: impl Into<String>) -> Self {
        Self {
            id,
            role,
            name: name.into(),
            description: String::new(),
            states: States::default(),
            actions: vec![],
            bounds: Bounds::default(),
            text: None,
            value: None,
            children: vec![],
            relations: vec![],
            attributes: BTreeMap::new(),
        }
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Tree {
    pub root: NodeId,
    pub nodes: BTreeMap<NodeId, Node>,
}
impl Tree {
    /// Redact BEFORE storing a snapshot, computing a diff, or calling a backend.
    /// No password text, boundaries, caret or length survives this seam.
    pub fn filtered(&self, include: impl Fn(&Node) -> bool) -> Self {
        let mut nodes: BTreeMap<_, _> = self
            .nodes
            .iter()
            .filter(|(_, n)| include(n))
            .map(|(id, n)| (*id, n.clone()))
            .collect();
        let ids: BTreeSet<_> = nodes.keys().copied().collect();
        for n in nodes.values_mut() {
            n.children.retain(|id| ids.contains(id));
            n.relations.retain(|r| {
                let (Relation::LabelledBy(id) | Relation::LabelFor(id)) = r;
                ids.contains(id)
            });
            if n.role == Role::Password {
                n.text = None;
            }
        }
        Self {
            root: self.root,
            nodes,
        }
    }
    pub fn validate(&self) -> Result<()> {
        let mut seen = BTreeSet::new();
        let mut todo = vec![self.root];
        let mut focus = 0;
        while let Some(id) = todo.pop() {
            if !seen.insert(id) {
                return Err("cycle or duplicate semantic parent".into());
            }
            let n = self.nodes.get(&id).ok_or("missing semantic child")?;
            if id != n.id {
                return Err("semantic map key differs from id".into());
            }
            for relation in &n.relations {
                let (Relation::LabelledBy(target) | Relation::LabelFor(target)) = relation;
                if !self.nodes.contains_key(target) {
                    return Err("missing relation target".into());
                }
            }
            focus += usize::from(n.states.focused);
            if let Some(t) = &n.text {
                t.characters()?;
            }
            if let Some(v) = &n.value {
                v.validate()?;
            }
            todo.extend(&n.children);
        }
        if seen.len() != self.nodes.len() || focus > 1 {
            return Err("unreachable node or multiple focused nodes".into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct CharacterText {
    pub text: String,
    pub caret: usize,
    pub anchor: usize,
    pub words: Vec<Range<usize>>,
    pub lines: Vec<Range<usize>>,
}
pub fn character_offset(text: &str, byte: usize) -> Result<usize> {
    if !text.is_char_boundary(byte) {
        return Err("offset is not a UTF-8 boundary".into());
    }
    Ok(text[..byte].chars().count())
}
pub fn byte_offset(text: &str, character: usize) -> Result<usize> {
    text.char_indices()
        .map(|(i, _)| i)
        .chain([text.len()])
        .nth(character)
        .ok_or_else(|| "character offset out of range".into())
}
impl TextInfo {
    pub fn characters(&self) -> Result<CharacterText> {
        if let Some(g) = &self.geometry {
            g.validate(&self.text)?;
        }
        let range = |r: &Range<usize>| -> Result<Range<usize>> {
            if r.start > r.end {
                return Err("reversed text range".into());
            }
            Ok(character_offset(&self.text, r.start)?..character_offset(&self.text, r.end)?)
        };
        Ok(CharacterText {
            text: self.text.clone(),
            caret: character_offset(&self.text, self.caret)?,
            anchor: character_offset(&self.text, self.anchor)?,
            words: self.words.iter().map(range).collect::<Result<_>>()?,
            lines: self.lines.iter().map(range).collect::<Result<_>>()?,
        })
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Request {
    Focus(NodeId),
    Activate(NodeId),
    SetText(NodeId, String),
    SetSelection(NodeId, Range<usize>),
    /// A value asked from outside, unclamped: the app clamps and steps it as a key would.
    SetValue(NodeId, f64),
}
/// Returned selection ranges are bytes again. The callback queues work to the
/// app thread; neither backend mutates the application's model on a D-Bus thread.
pub type Callback = Arc<dyn Fn(Request) + Send + Sync>;
pub trait A11yBackend {
    fn update(&mut self, tree: Tree) -> Result<()>;
}
/// Stable identifiers may be temporarily absent (collapsed lists, modal UI), but
/// cannot be assigned to another control. The application owns allocation.
#[derive(Default)]
pub struct Snapshot {
    pub tree: Option<Tree>,
    retired: BTreeMap<NodeId, Role>,
}
impl Snapshot {
    pub fn accept(&mut self, tree: Tree) -> Result<Tree> {
        let tree = tree.filtered(|_| true);
        tree.validate()?;
        for n in tree.nodes.values() {
            if self.retired.get(&n.id).is_some_and(|role| *role != n.role) {
                return Err("semantic id reused for another role".into());
            }
            self.retired.insert(n.id, n.role);
        }
        Ok(tree)
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Event {
    Focus(NodeId, bool),
    Name(NodeId, String),
    Description(NodeId, String),
    State(NodeId, &'static str, bool),
    Insert(NodeId, usize, String),
    Remove(NodeId, usize, String),
    Caret(NodeId, usize),
    Selection(NodeId),
    /// A selection container's set of selected children changed (AT-SPI Selection).
    SelectionChanged(NodeId),
    /// A range control's current value changed.
    Value(NodeId),
    Children(NodeId),
}
impl Role {
    /// Whose children are chosen among: exposed through AT-SPI Selection. A reader asks a
    /// combo box for its selected child to say its value, collapsed or open (#835).
    pub fn is_selection_container(self) -> bool {
        matches!(self, Role::ComboBox)
    }
}
impl Tree {
    /// The children of `id` that carry `selected`, in order.
    pub fn selected_children(&self, id: NodeId) -> Vec<NodeId> {
        self.nodes.get(&id).map_or(vec![], |n| {
            n.children
                .iter()
                .copied()
                .filter(|c| self.nodes.get(c).is_some_and(|c| c.states.selected))
                .collect()
        })
    }
}
pub fn diff(old: Option<&Tree>, new: &Tree) -> Result<Vec<Event>> {
    let mut out = vec![];
    let mut activations = 0;
    for n in new.nodes.values() {
        let before = old.and_then(|t| t.nodes.get(&n.id));
        let s = before.map(|n| n.states.clone()).unwrap_or_default();
        if s.focused != n.states.focused {
            out.push(Event::Focus(n.id, n.states.focused));
        }
        if before.is_some_and(|b| b.name != n.name) {
            out.push(Event::Name(n.id, n.name.clone()));
        }
        if before.is_some_and(|b| b.description != n.description) {
            out.push(Event::Description(n.id, n.description.clone()));
        }
        if s.active != n.states.active {
            // Before any focus event, wherever the node sits in the tree: a reader takes
            // focus only inside the window it already knows is active.
            out.insert(activations, Event::State(n.id, "active", n.states.active));
            activations += 1;
        }
        for (key, a, b) in [
            ("checked", s.checked, n.states.checked),
            ("expanded", s.expanded, n.states.expanded),
            ("selected", s.selected, n.states.selected),
            ("invalid-entry", s.invalid, n.states.invalid),
            ("enabled", !s.disabled, !n.states.disabled),
            ("sensitive", !s.disabled, !n.states.disabled),
            ("visible", !s.hidden, !n.states.hidden),
            (
                "showing",
                !s.hidden && !s.offscreen,
                !n.states.hidden && !n.states.offscreen,
            ),
        ] {
            if a != b {
                out.push(Event::State(n.id, key, b));
            }
        }
        if before.is_some_and(|b| b.children != n.children) {
            out.push(Event::Children(n.id));
        }
        if let Some(b) = before
            && b.value.as_ref().map(|v| (v.current, &v.text))
                != n.value.as_ref().map(|v| (v.current, &v.text))
        {
            out.push(Event::Value(n.id));
        }
        if n.role.is_selection_container()
            && let Some(old) = old.filter(|t| t.nodes.contains_key(&n.id))
            && old.selected_children(n.id) != new.selected_children(n.id)
        {
            out.push(Event::SelectionChanged(n.id));
        }
        if n.role == Role::Password {
            continue;
        }
        if let Some(t) = &n.text {
            let t = t.characters()?;
            let previous = before
                .and_then(|n| n.text.as_ref())
                .map(TextInfo::characters)
                .transpose()?
                .unwrap_or(CharacterText {
                    text: String::new(),
                    caret: 0,
                    anchor: 0,
                    words: vec![],
                    lines: vec![],
                });
            let a: Vec<_> = previous.text.chars().collect();
            let b: Vec<_> = t.text.chars().collect();
            let start = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
            let suffix = a[start..]
                .iter()
                .rev()
                .zip(b[start..].iter().rev())
                .take_while(|(a, b)| a == b)
                .count();
            if a.len() > start + suffix {
                out.push(Event::Remove(
                    n.id,
                    start,
                    a[start..a.len() - suffix].iter().collect(),
                ));
            }
            if b.len() > start + suffix {
                out.push(Event::Insert(
                    n.id,
                    start,
                    b[start..b.len() - suffix].iter().collect(),
                ));
            }
            if previous.caret != t.caret {
                out.push(Event::Caret(n.id, t.caret));
            }
            if previous.anchor != t.anchor || previous.caret != t.caret {
                out.push(Event::Selection(n.id));
            }
        }
    }
    if let Some(old) = old {
        for n in old.nodes.values() {
            if n.states.focused && !new.nodes.contains_key(&n.id) {
                out.push(Event::Focus(n.id, false));
            }
        }
    }
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn description_changes_are_observable_once_without_renaming_the_button() {
        let mut node = Node::new(1, Role::Button, "Interface font");
        node.description = "Noto Sans 11".into();
        let old = Tree {
            root: 1,
            nodes: BTreeMap::from([(1, node)]),
        };
        let mut new = old.clone();
        new.nodes.get_mut(&1).unwrap().description = "Noto Sans Bold 13".into();
        assert_eq!(
            diff(Some(&old), &new).unwrap(),
            vec![Event::Description(1, "Noto Sans Bold 13".into())]
        );
        assert!(diff(Some(&new), &new).unwrap().is_empty());
    }
    #[test]
    fn offsets_are_scalars_and_invalid_bytes_are_rejected() {
        let t = TextInfo {
            text: "日🙂e\u{301} word".into(),
            caret: 7,
            anchor: 0,
            words: std::iter::once(11..15).collect(),
            lines: std::iter::once(0..15).collect(),
            geometry: None,
        };
        let c = t.characters().unwrap();
        assert_eq!(c.caret, 2);
        assert_eq!(c.words.len(), 1);
        assert_eq!(c.words[0], 5..9);
        assert_eq!(byte_offset(&t.text, 2).unwrap(), 7);
        assert!(character_offset(&t.text, 1).is_err());
    }
    #[test]
    fn password_redaction_precedes_snapshots_and_events() {
        let mut n = Node::new(1, Role::Password, "Password");
        n.text = Some(TextInfo {
            text: "secret日本🙂".into(),
            ..Default::default()
        });
        let t = Tree {
            root: 1,
            nodes: BTreeMap::from([(1, n)]),
        }
        .filtered(|_| true);
        assert!(t.nodes[&1].text.is_none());
        assert!(diff(None, &t).unwrap().is_empty());
    }
    #[test]
    fn window_activation_precedes_focus_whatever_the_ids() {
        // The focused control has a LOWER id than its window, so the tree walks it first.
        let mut window = Node::new(9, Role::Window, "Form");
        let mut field = Node::new(1, Role::TextInput, "Name");
        let tree = |active: bool, window: &Node, field: &mut Node| {
            field.states.focused = active;
            let mut w = window.clone();
            w.states.active = active;
            w.children = vec![1];
            Tree {
                root: 9,
                nodes: BTreeMap::from([(1, field.clone()), (9, w)]),
            }
        };
        let old = tree(false, &window, &mut field);
        window.states.active = true;
        let new = tree(true, &window, &mut field);
        let events = diff(Some(&old), &new).unwrap();
        assert!(
            matches!(events[0], Event::State(9, "active", true)),
            "{events:?}"
        );
        assert!(matches!(events[1], Event::Focus(1, true)), "{events:?}");
    }
    #[test]
    fn a_value_out_of_its_range_is_refused_and_a_change_is_reported_once() {
        let tree = |current: f64, text: &str| {
            let mut n = Node::new(1, Role::Slider, "Temperature");
            n.value = Some(ValueInfo {
                min: 1000.,
                max: 6500.,
                current,
                step: 100.,
                text: text.into(),
            });
            Tree {
                root: 1,
                nodes: BTreeMap::from([(1, n)]),
            }
        };
        assert!(tree(4500., "4500 K").validate().is_ok());
        assert!(tree(7000., "7000 K").validate().is_err());
        assert!(tree(f64::NAN, "").validate().is_err());
        let (a, b) = (tree(4500., "4500 K"), tree(4600., "4600 K"));
        let events = diff(Some(&a), &b).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|e| matches!(e, Event::Value(1)))
                .count(),
            1,
            "{events:?}"
        );
        assert!(
            !diff(Some(&b), &b)
                .unwrap()
                .iter()
                .any(|e| matches!(e, Event::Value(_)))
        );
    }
    #[test]
    fn a_combo_box_reports_a_changed_choice_once() {
        let tree = |chosen: u64| {
            let mut combo = Node::new(1, Role::ComboBox, "Language");
            combo.children = vec![2, 3];
            let mut nodes = BTreeMap::from([(1, combo)]);
            for id in [2, 3] {
                let mut o = Node::new(id, Role::Option, format!("o{id}"));
                o.states.selected = id == chosen;
                nodes.insert(id, o);
            }
            Tree { root: 1, nodes }
        };
        let (a, b) = (tree(2), tree(3));
        assert_eq!(b.selected_children(1), vec![3]);
        let events = diff(Some(&a), &b).unwrap();
        let n = events
            .iter()
            .filter(|e| matches!(e, Event::SelectionChanged(1)))
            .count();
        assert_eq!(n, 1, "{events:?}");
        assert!(
            !diff(Some(&b), &b)
                .unwrap()
                .iter()
                .any(|e| matches!(e, Event::SelectionChanged(_)))
        );
    }
}
