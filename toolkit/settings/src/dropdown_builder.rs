// SPDX-License-Identifier: LGPL-3.0-or-later
//! Schema-driven controlled Dropdown rows, backed exclusively by Config1's session.
use crate::{
    Value,
    manifest::Item,
    render::{Builder, Builders, Built, Cx, Result, failure},
    session::Notice,
};
use nk_widgets::{Effect, Kind, NodeId};

pub fn register(builders: &mut Builders) {
    builders.register("dropdown", || Box::new(Dropdown::default()));
}
#[derive(Default)]
pub struct Dropdown {
    key: String,
    row: NodeId,
    combo: NodeId,
    options: Vec<(String, NodeId)>,
    subtitle: Option<String>,
    error: Option<String>,
    mount: u64,
    alive: bool,
    visible: bool,
}
fn options(entry: &serde_json::Value, current: &str) -> Result<Vec<(String, String)>> {
    let mut out = Vec::new();
    for option in entry["ui"]["options"]
        .as_array()
        .ok_or("dropdown schema has no options")?
    {
        let value = option["value"]
            .as_str()
            .ok_or("dropdown option has no string value")?;
        if out.iter().any(|(v, _)| v == value) {
            return Err("duplicate dropdown value".into());
        }
        out.push((
            value.to_owned(),
            option["label"].as_str().unwrap_or(value).to_owned(),
        ));
    }
    if out.is_empty() {
        return Err("dropdown schema options are empty".into());
    }
    if !out.iter().any(|(v, _)| v == current) {
        out.push((current.into(), current.into()));
    }
    Ok(out)
}
impl Dropdown {
    fn show(&mut self, cx: &mut Cx<'_>, error: Option<String>) -> Result<()> {
        let entry = cx
            .session()
            .store()
            .and_then(|s| s.key(&self.key))
            .ok_or("dropdown key not in snapshot")?
            .clone();
        cx.tree.set_disabled(
            self.combo,
            !cx.session().available() || !entry.available || !entry.writable(),
        )?;
        if !entry.available {
            return Ok(());
        }
        let current = cx
            .session()
            .shown(&self.key)
            .and_then(Value::as_text)
            .ok_or("dropdown value is not a string")?
            .to_owned();
        let desired = options(&entry.entry, &current)?;
        for (value, label) in &desired {
            if let Some((_, id)) = self.options.iter().find(|(v, _)| v == value) {
                cx.tree.set_name(*id, label)?;
            } else {
                let id =
                    cx.tree
                        .append(self.combo, Kind::DropdownOption { selected: false }, label)?;
                cx.own(id);
                self.options.push((value.clone(), id));
            }
        }
        let selected = self.options.iter().find(|(v, _)| v == &current).unwrap().1;
        let index = cx
            .tree
            .node(self.combo)
            .unwrap()
            .children()
            .iter()
            .position(|id| *id == selected)
            .unwrap();
        cx.tree.set_dropdown_selected(self.combo, index)?;
        for (_, id) in self
            .options
            .iter()
            .filter(|(v, _)| !desired.iter().any(|(want, _)| want == v))
        {
            cx.remove(*id)?;
        }
        self.options
            .retain(|(v, _)| desired.iter().any(|(want, _)| want == v));
        let order: Vec<_> = desired
            .iter()
            .map(|(v, _)| self.options.iter().find(|(value, _)| value == v).unwrap().1)
            .collect();
        cx.tree.reorder_dropdown_options(self.combo, &order)?;
        cx.tree.set_name(
            self.combo,
            &desired.iter().find(|(v, _)| v == &current).unwrap().1,
        )?;
        if error.is_some() {
            self.error = error;
        }
        let line = self.error.clone().or_else(|| self.subtitle.clone());
        cx.tree.set_subtitle(self.row, line.as_deref())?;
        Ok(())
    }
    fn editable(&self, cx: &Cx<'_>) -> bool {
        self.alive
            && self.visible
            && self.mount == cx.mount()
            && cx.session().available()
            && cx
                .tree
                .semantics()
                .nodes
                .get(&self.combo)
                .is_some_and(|n| !n.states.disabled && !n.states.hidden)
            && cx
                .session()
                .store()
                .and_then(|s| s.key(&self.key))
                .is_some_and(|k| k.available && k.writable())
    }
}
impl Builder for Dropdown {
    fn build(&mut self, cx: &mut Cx<'_>, group: NodeId, item: &Item) -> Result<Built> {
        let Item::Key { key, .. } = item else {
            return Err("dropdown builder requires a schema key".into());
        };
        let entry = cx
            .session()
            .store()
            .and_then(|s| s.key(key))
            .ok_or("dropdown key not in snapshot")?
            .clone();
        let current = cx
            .session()
            .shown(key)
            .and_then(Value::as_text)
            .ok_or("dropdown value is not a string")?
            .to_owned();
        let options = options(&entry.entry, &current)?;
        let labels: Vec<_> = options.iter().map(|(_, label)| label.as_str()).collect();
        let selected = options
            .iter()
            .position(|(value, _)| value == &current)
            .unwrap();
        let title = entry.entry["ui"]["title"]
            .as_str()
            .ok_or("dropdown schema has no title")?;
        let (row, combo) = cx.tree.dropdown(group, title, &labels, selected)?;
        let ids = cx.tree.node(combo).unwrap().children().to_vec();
        for id in [row, combo].iter().chain(&ids) {
            cx.own(*id);
        }
        self.options = options
            .into_iter()
            .zip(ids)
            .map(|((value, _), id)| (value, id))
            .collect();
        self.key = key.clone();
        self.row = row;
        self.combo = combo;
        self.subtitle = entry.entry["ui"]["subtitle"].as_str().map(str::to_owned);
        self.mount = cx.mount();
        self.alive = true;
        self.visible = true;
        self.show(cx, None)?;
        Ok(Built {
            rows: vec![row],
            keys: vec![key.clone()],
        })
    }
    fn notice(&mut self, cx: &mut Cx<'_>, notice: &Notice) -> Result<()> {
        match notice {
            Notice::Failed { error, .. } => self.error = Some(failure(error)),
            Notice::Changed(_) | Notice::Ready => self.error = None,
            _ => {}
        }
        self.show(cx, None)
    }
    fn effect(&mut self, cx: &mut Cx<'_>, effect: Effect) -> Result<()> {
        if !self.editable(cx) {
            return Ok(());
        }
        let effect = if effect == Effect::Activated(self.combo) {
            cx.open_dropdown(self.combo)?
        } else {
            effect
        };
        if effect == Effect::Changed(self.combo) && self.editable(cx) {
            let index = cx.tree.dropdown_selected(self.combo)?;
            let id = cx.tree.node(self.combo).unwrap().children()[index];
            let value = self
                .options
                .iter()
                .find(|(_, option)| *option == id)
                .ok_or("dropdown selection is not mapped")?
                .0
                .clone();
            self.error = None;
            let error = cx
                .apply(&self.key, Value::Text(value))
                .err()
                .map(|e| failure(&e));
            self.show(cx, error)?;
        } else if effect == Effect::None {
            self.show(cx, None)?;
        }
        Ok(())
    }
    fn shown(&mut self, _: &mut Cx<'_>, visible: bool) -> Result<()> {
        self.visible = visible;
        Ok(())
    }
    fn unmount(&mut self, _: &mut Cx<'_>) -> Result<()> {
        self.alive = false;
        Ok(())
    }
}
