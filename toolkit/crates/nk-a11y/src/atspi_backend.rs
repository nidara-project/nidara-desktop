// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::*;
use atspi_common::{Role as AtRole, State, StateSet};
use std::{collections::HashMap, sync::Mutex};
use zbus::{
    blocking::{Connection, Proxy, connection::Builder},
    fdo, interface,
    zvariant::{OwnedObjectPath, Value},
};
type Address = (String, OwnedObjectPath);
const ROOT: &str = "/org/a11y/atspi/accessible/root";
const NULL: &str = "/org/a11y/atspi/null";
fn path(id: NodeId) -> String {
    if id == 0 {
        ROOT.into()
    } else {
        format!("/org/a11y/atspi/accessible/n{id}")
    }
}
fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
#[derive(Clone)]
struct Object {
    id: NodeId,
    tree: Arc<Mutex<Tree>>,
    bus: String,
    callback: Callback,
}
impl Object {
    fn node(&self) -> fdo::Result<Node> {
        self.tree
            .lock()
            .unwrap()
            .nodes
            .get(&self.id)
            .cloned()
            .ok_or_else(|| fdo::Error::UnknownObject("retired node".into()))
    }
    fn address(&self, id: NodeId) -> Address {
        (
            self.bus.clone(),
            OwnedObjectPath::try_from(path(id)).unwrap(),
        )
    }
    fn null(&self) -> Address {
        (String::new(), OwnedObjectPath::try_from(NULL).unwrap())
    }
    fn children(&self) -> Vec<NodeId> {
        if self.id == 0 {
            vec![self.tree.lock().unwrap().root]
        } else {
            self.node().map(|n| n.children).unwrap_or_default()
        }
    }
    fn parent_id(&self) -> Option<NodeId> {
        let tree = self.tree.lock().unwrap();
        if self.id == tree.root {
            Some(0)
        } else {
            tree.nodes
                .values()
                .find(|n| n.children.contains(&self.id))
                .map(|n| n.id)
        }
    }
    fn request(&self, action: Action, request: Request) -> bool {
        if let Ok(n) = self.node()
            && n.actions.contains(&action)
            && !n.states.disabled
            && !n.states.hidden
        {
            (self.callback)(request);
            true
        } else {
            false
        }
    }
    fn text(&self) -> fdo::Result<CharacterText> {
        let n = self.node()?;
        n.text
            .unwrap_or_default()
            .characters()
            .map_err(fdo::Error::InvalidArgs)
    }
    fn selection(&self, start: i32, end: i32) -> bool {
        let Ok(t) = self.text() else { return false };
        let (Ok(start), Ok(end)) = (
            usize::try_from(start)
                .ok()
                .and_then(|c| byte_offset(&t.text, c).ok())
                .ok_or(()),
            usize::try_from(end)
                .ok()
                .and_then(|c| byte_offset(&t.text, c).ok())
                .ok_or(()),
        ) else {
            return false;
        };
        self.request(
            Action::SetSelection,
            Request::SetSelection(self.id, start..end),
        )
    }
    fn slice(&self, start: i32, end: i32) -> fdo::Result<String> {
        let t = self.text()?;
        let count = t.text.chars().count() as i32;
        let end = if end == -1 { count } else { end };
        if start < 0 || end < start || end > count {
            return Err(fdo::Error::InvalidArgs("text range".into()));
        }
        Ok(t.text
            .chars()
            .skip(start as usize)
            .take((end - start) as usize)
            .collect())
    }
}
fn role(n: &Node) -> AtRole {
    match n.role {
        Role::Window => AtRole::Frame,
        Role::Dialog => AtRole::Dialog,
        Role::Label => AtRole::Label,
        Role::TextInput => AtRole::Entry,
        Role::Password => AtRole::PasswordText,
        Role::ComboBox => AtRole::ComboBox,
        Role::Option => AtRole::ListItem,
        Role::CheckBox => AtRole::CheckBox,
        Role::Button => AtRole::Button,
    }
}
fn states(n: &Node) -> StateSet {
    let mut s = StateSet::empty();
    for (yes, state) in [
        (true, State::Visible),
        (n.states.active, State::Active),
        (!n.states.hidden, State::Showing),
        (!n.states.disabled, State::Enabled),
        (!n.states.disabled, State::Sensitive),
        (n.actions.contains(&Action::Focus), State::Focusable),
        (n.states.focused, State::Focused),
        (n.states.checked, State::Checked),
        (n.role == Role::CheckBox, State::Checkable),
        (n.states.expanded, State::Expanded),
        (n.role == Role::ComboBox, State::Expandable),
        (n.states.selected, State::Selected),
        (n.role == Role::Option, State::Selectable),
        (n.states.invalid, State::InvalidEntry),
        (n.actions.contains(&Action::SetText), State::Editable),
        (n.role == Role::Dialog, State::Modal),
    ] {
        if yes {
            s.insert(state);
        }
    }
    s
}
#[interface(name = "org.a11y.atspi.Accessible")]
impl Object {
    #[zbus(property)]
    fn name(&self) -> String {
        if self.id == 0 {
            "nk-phase0".into()
        } else {
            self.node().map(|n| n.name).unwrap_or_default()
        }
    }
    #[zbus(property)]
    fn description(&self) -> String {
        self.node().map(|n| n.description).unwrap_or_default()
    }
    #[zbus(property)]
    fn parent(&self) -> Address {
        self.parent_id()
            .map(|id| self.address(id))
            .unwrap_or_else(|| {
                (
                    "org.a11y.atspi.Registry".into(),
                    OwnedObjectPath::try_from(ROOT).unwrap(),
                )
            })
    }
    #[zbus(property)]
    fn child_count(&self) -> i32 {
        self.children().len() as i32
    }
    #[zbus(property)]
    fn locale(&self) -> &str {
        "en_US.UTF-8"
    }
    #[zbus(property)]
    fn accessible_id(&self) -> String {
        format!("nk-{}", self.id)
    }
    fn get_child_at_index(&self, index: i32) -> (Address,) {
        (self
            .children()
            .get(index as usize)
            .map(|id| self.address(*id))
            .unwrap_or_else(|| self.null()),)
    }
    fn get_children(&self) -> Vec<Address> {
        self.children().iter().map(|id| self.address(*id)).collect()
    }
    fn get_index_in_parent(&self) -> i32 {
        let tree = self.tree.lock().unwrap();
        tree.nodes
            .values()
            .find_map(|n| n.children.iter().position(|id| *id == self.id))
            .unwrap_or(0) as i32
    }
    fn get_role(&self) -> u32 {
        if self.id == 0 {
            AtRole::Application as u32
        } else {
            self.node().map(|n| role(&n) as u32).unwrap_or(0)
        }
    }
    fn get_role_name(&self) -> String {
        self.node()
            .map(|n| format!("{:?}", role(&n)))
            .unwrap_or("application".into())
    }
    fn get_localized_role_name(&self) -> String {
        self.get_role_name()
    }
    fn get_state(&self) -> StateSet {
        self.node().map(|n| states(&n)).unwrap_or_default()
    }
    fn get_attributes(&self) -> HashMap<String, String> {
        HashMap::new()
    }
    fn get_relation_set(&self) -> Vec<(u32, Vec<Address>)> {
        vec![]
    }
    fn get_application(&self) -> (Address,) {
        (self.address(0),)
    }
    fn get_interfaces(&self) -> Vec<String> {
        let mut v = vec!["org.a11y.atspi.Accessible".into()];
        if self.id == 0 {
            v.push("org.a11y.atspi.Application".into());
        } else {
            v.push("org.a11y.atspi.Component".into());
            if let Ok(n) = self.node() {
                if !n.actions.is_empty() {
                    v.push("org.a11y.atspi.Action".into());
                }
                if n.text.is_some() {
                    v.push("org.a11y.atspi.Text".into());
                }
                if n.actions.contains(&Action::SetText) {
                    v.push("org.a11y.atspi.EditableText".into());
                }
            }
        }
        v
    }
}
struct AppInterface {
    id: i32,
}
#[interface(name = "org.a11y.atspi.Application")]
impl AppInterface {
    #[zbus(property)]
    fn toolkit_name(&self) -> &str {
        "nk-phase0"
    }
    #[zbus(property)]
    fn version(&self) -> &str {
        env!("CARGO_PKG_VERSION")
    }
    #[zbus(property)]
    fn atspi_version(&self) -> &str {
        "2.1"
    }
    #[zbus(property)]
    fn id(&self) -> i32 {
        self.id
    }
    #[zbus(property)]
    fn set_id(&mut self, id: i32) {
        self.id = id;
    }
}
struct Component(Object);
#[interface(name = "org.a11y.atspi.Component")]
impl Component {
    fn grab_focus(&self) -> bool {
        self.0.request(Action::Focus, Request::Focus(self.0.id))
    }
    fn get_extents(&self, coord_type: u32) -> fdo::Result<((i32, i32, i32, i32),)> {
        if coord_type != 1 {
            return Err(fdo::Error::NotSupported(
                "phase 0 exposes window coordinates; Wayland supplies no global window origin"
                    .into(),
            ));
        }
        let n = self.0.node()?;
        Ok(((
            n.bounds.x as i32,
            n.bounds.y as i32,
            n.bounds.width as i32,
            n.bounds.height as i32,
        ),))
    }
    fn get_position(&self, c: u32) -> fdo::Result<(i32, i32)> {
        let (x, y, _, _) = self.get_extents(c)?.0;
        Ok((x, y))
    }
    fn get_size(&self) -> fdo::Result<(i32, i32)> {
        let (_, _, w, h) = self.get_extents(1)?.0;
        Ok((w, h))
    }
    fn get_layer(&self) -> u32 {
        3
    }
    fn get_alpha(&self) -> f64 {
        1.
    }
}
struct Actions(Object);
#[interface(name = "org.a11y.atspi.Action")]
impl Actions {
    #[zbus(property)]
    fn n_actions(&self) -> i32 {
        i32::from(
            self.0
                .node()
                .is_ok_and(|n| n.actions.contains(&Action::Activate)),
        )
    }
    fn get_name(&self, index: i32) -> &str {
        if index == 0 && self.n_actions() > 0 {
            "click"
        } else {
            ""
        }
    }
    fn get_localized_name(&self, index: i32) -> &str {
        self.get_name(index)
    }
    fn get_description(&self, index: i32) -> &str {
        self.get_name(index)
    }
    fn get_key_binding(&self, _index: i32) -> &str {
        ""
    }
    fn get_actions(&self) -> Vec<(String, String, String)> {
        if self.n_actions() > 0 {
            vec![("click".into(), "Activate".into(), "".into())]
        } else {
            vec![]
        }
    }
    fn do_action(&self, index: i32) -> bool {
        index == 0
            && self
                .0
                .request(Action::Activate, Request::Activate(self.0.id))
    }
}
struct Text(Object);
#[interface(name = "org.a11y.atspi.Text")]
impl Text {
    #[zbus(property)]
    fn character_count(&self) -> fdo::Result<i32> {
        Ok(self.0.text()?.text.chars().count() as i32)
    }
    #[zbus(property)]
    fn caret_offset(&self) -> fdo::Result<i32> {
        Ok(self.0.text()?.caret as i32)
    }
    fn get_text(&self, start: i32, end: i32) -> fdo::Result<String> {
        self.0.slice(start, end)
    }
    fn get_character_at_offset(&self, offset: i32) -> fdo::Result<i32> {
        Ok(self
            .0
            .text()?
            .text
            .chars()
            .nth(offset as usize)
            .map_or(0, |c| c as i32))
    }
    fn set_caret_offset(&self, offset: i32) -> bool {
        self.0.selection(offset, offset)
    }
    fn get_n_selections(&self) -> fdo::Result<i32> {
        let t = self.0.text()?;
        Ok(i32::from(t.anchor != t.caret))
    }
    fn get_selection(&self, _index: i32) -> fdo::Result<(i32, i32)> {
        let t = self.0.text()?;
        Ok((t.anchor.min(t.caret) as i32, t.anchor.max(t.caret) as i32))
    }
    fn add_selection(&self, start: i32, end: i32) -> bool {
        self.0.selection(start, end)
    }
    fn set_selection(&self, index: i32, start: i32, end: i32) -> bool {
        index == 0 && self.0.selection(start, end)
    }
    fn remove_selection(&self, index: i32) -> bool {
        index == 0 && self.caret_offset().is_ok_and(|c| self.0.selection(c, c))
    }
    fn get_string_at_offset(
        &self,
        offset: i32,
        granularity: u32,
    ) -> fdo::Result<(String, i32, i32)> {
        let t = self.0.text()?;
        let i = usize::try_from(offset).map_err(|_| fdo::Error::InvalidArgs("offset".into()))?;
        let r = match granularity {
            0 => Some(i..i + 1),
            1 => t.words.into_iter().find(|r| r.contains(&i)),
            3 => t.lines.into_iter().find(|r| r.contains(&i)),
            _ => None,
        }
        .unwrap_or(i..i);
        Ok((
            self.0.slice(r.start as i32, r.end as i32)?,
            r.start as i32,
            r.end as i32,
        ))
    }
    fn get_text_at_offset(&self, offset: i32, boundary: u32) -> fdo::Result<(String, i32, i32)> {
        self.get_string_at_offset(
            offset,
            match boundary {
                0 => 0,
                1 | 2 => 1,
                5 | 6 => 3,
                _ => 4,
            },
        )
    }
    fn get_default_attributes(&self) -> HashMap<String, String> {
        HashMap::new()
    }
    fn get_attribute_run(
        &self,
        _offset: i32,
        _include: bool,
    ) -> fdo::Result<(HashMap<String, String>, i32, i32)> {
        Ok((HashMap::new(), 0, self.character_count()?))
    }
}
struct Editable(Object);
#[interface(name = "org.a11y.atspi.EditableText")]
impl Editable {
    fn set_text_contents(&self, text: &str) -> bool {
        self.0
            .request(Action::SetText, Request::SetText(self.0.id, text.into()))
    }
}
struct Cache;
#[interface(name = "org.a11y.atspi.Cache")]
impl Cache {
    fn get_items(&self) -> Vec<atspi_common::CacheItem> {
        vec![]
    }
}
pub struct Backend {
    connection: Connection,
    shared: Arc<Mutex<Tree>>,
    snapshot: Snapshot,
    callback: Callback,
    registered: BTreeSet<NodeId>,
}
impl Backend {
    pub fn new(tree: Tree, callback: Callback) -> Result<Self> {
        let mut snapshot = Snapshot::default();
        let tree = snapshot.accept(tree)?;
        let session = Connection::session().map_err(error)?;
        let bus =
            Proxy::new(&session, "org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus").map_err(error)?;
        let address: String = bus.call("GetAddress", &()).map_err(error)?;
        let connection = Builder::address(address.as_str())
            .map_err(error)?
            .build()
            .map_err(error)?;
        let mut b = Self {
            connection,
            shared: Arc::new(Mutex::new(tree.clone())),
            snapshot,
            callback,
            registered: BTreeSet::new(),
        };
        b.connection
            .object_server()
            .at("/org/a11y/atspi/cache", Cache)
            .map_err(error)?;
        b.register(0)?;
        for id in tree.nodes.keys() {
            b.register(*id)?;
        }
        let root = b.object(0).address(0);
        let socket = Proxy::new(
            &b.connection,
            "org.a11y.atspi.Registry",
            ROOT,
            "org.a11y.atspi.Socket",
        )
        .map_err(error)?;
        let _desktop: Address = socket.call("Embed", &(root,)).map_err(error)?;
        b.snapshot.tree = Some(tree);
        Ok(b)
    }
    fn object(&self, id: NodeId) -> Object {
        Object {
            id,
            tree: self.shared.clone(),
            bus: self.connection.unique_name().unwrap().to_string(),
            callback: self.callback.clone(),
        }
    }
    fn register(&mut self, id: NodeId) -> Result<()> {
        if !self.registered.insert(id) {
            return Ok(());
        }
        let p = path(id);
        let s = self.connection.object_server();
        let o = self.object(id);
        s.at(p.clone(), o.clone()).map_err(error)?;
        if id == 0 {
            s.at(p, AppInterface { id: 0 }).map_err(error)?;
        } else {
            s.at(p.clone(), Component(o.clone())).map_err(error)?;
            s.at(p.clone(), Actions(o.clone())).map_err(error)?;
            let n = o.node().map_err(error)?;
            if n.text.is_some() {
                s.at(p.clone(), Text(o.clone())).map_err(error)?;
            }
            if n.actions.contains(&Action::SetText) {
                s.at(p, Editable(o)).map_err(error)?;
            }
        }
        Ok(())
    }
    fn emit(
        &self,
        id: NodeId,
        member: &str,
        kind: &str,
        a: i32,
        b: i32,
        value: Value<'_>,
    ) -> Result<()> {
        self.emit_on("org.a11y.atspi.Event.Object", id, member, kind, a, b, value)
    }
    #[allow(clippy::too_many_arguments)]
    fn emit_on(
        &self,
        interface: &str,
        id: NodeId,
        member: &str,
        kind: &str,
        a: i32,
        b: i32,
        value: Value<'_>,
    ) -> Result<()> {
        self.connection
            .emit_signal(
                None::<&str>,
                path(id),
                interface,
                member,
                &(kind, a, b, value, HashMap::<String, Value<'_>>::new()),
            )
            .map_err(error)
    }
}
impl A11yBackend for Backend {
    fn update(&mut self, tree: Tree) -> Result<()> {
        let tree = self.snapshot.accept(tree)?;
        let events = diff(self.snapshot.tree.as_ref(), &tree)?;
        *self.shared.lock().unwrap() = tree.clone();
        for id in tree.nodes.keys() {
            self.register(*id)?;
        }
        for event in events {
            match event {
                Event::Focus(id, v) => {
                    self.emit(id, "StateChanged", "focused", i32::from(v), 0, 0i32.into())?
                }
                Event::State(id, s, v) => {
                    self.emit(id, "StateChanged", s, i32::from(v), 0, 0i32.into())?;
                    // window:activate / window:deactivate, as GTK sends with the state.
                    if s == "active" {
                        let member = if v { "Activate" } else { "Deactivate" };
                        let name = tree
                            .nodes
                            .get(&id)
                            .map(|n| n.name.clone())
                            .unwrap_or_default();
                        self.emit_on(
                            "org.a11y.atspi.Event.Window",
                            id,
                            member,
                            "",
                            0,
                            0,
                            name.as_str().into(),
                        )?;
                    }
                }
                Event::Name(id, s) => self.emit(
                    id,
                    "PropertyChange",
                    "accessible-name",
                    0,
                    0,
                    s.as_str().into(),
                )?,
                Event::Insert(id, start, s) => self.emit(
                    id,
                    "TextChanged",
                    "insert",
                    start as i32,
                    s.chars().count() as i32,
                    s.as_str().into(),
                )?,
                Event::Remove(id, start, s) => self.emit(
                    id,
                    "TextChanged",
                    "delete",
                    start as i32,
                    s.chars().count() as i32,
                    s.as_str().into(),
                )?,
                Event::Caret(id, c) => {
                    self.emit(id, "TextCaretMoved", "", c as i32, 0, 0i32.into())?
                }
                Event::Selection(id) => {
                    self.emit(id, "TextSelectionChanged", "", 0, 0, 0i32.into())?
                }
                Event::Children(id) => {
                    let before = self
                        .snapshot
                        .tree
                        .as_ref()
                        .and_then(|t| t.nodes.get(&id))
                        .map(|n| n.children.as_slice())
                        .unwrap_or(&[]);
                    let after = tree
                        .nodes
                        .get(&id)
                        .map(|n| n.children.as_slice())
                        .unwrap_or(&[]);
                    for (i, child) in before.iter().enumerate() {
                        if !after.contains(child) {
                            self.emit(
                                id,
                                "ChildrenChanged",
                                "remove",
                                i as i32,
                                0,
                                Value::new(self.object(*child).address(*child)),
                            )?;
                        }
                    }
                    for (i, child) in after.iter().enumerate() {
                        if !before.contains(child) {
                            self.emit(
                                id,
                                "ChildrenChanged",
                                "add",
                                i as i32,
                                0,
                                Value::new(self.object(*child).address(*child)),
                            )?;
                        }
                    }
                }
            }
        }
        self.snapshot.tree = Some(tree);
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn password_queries_have_no_content_or_length() {
        let mut n = Node::new(1, Role::Password, "Password");
        n.text = Some(TextInfo {
            text: "secret日本🙂".into(),
            ..Default::default()
        });
        let tree = Tree {
            root: 1,
            nodes: BTreeMap::from([(1, n)]),
        }
        .filtered(|_| true);
        let o = Object {
            id: 1,
            tree: Arc::new(Mutex::new(tree)),
            bus: ":1.1".into(),
            callback: Arc::new(|_| {}),
        };
        assert!(
            !o.get_interfaces()
                .iter()
                .any(|s| s == "org.a11y.atspi.Text")
        );
        assert_eq!(Text(o.clone()).character_count().unwrap(), 0);
        assert_eq!(Text(o).get_text(0, -1).unwrap(), "");
    }
}
