// SPDX-License-Identifier: LGPL-3.0-or-later
//! Retained ComboBox model and Selection; popup hosting is in nk-wayland.
use crate::*;

impl Tree {
    pub fn dropdown(
        &mut self,
        group: NodeId,
        label: &str,
        options: &[&str],
        selected: usize,
    ) -> Result<(NodeId, NodeId)> {
        if options.is_empty() || selected >= options.len() {
            return Err("dropdown needs options and a valid selection".into());
        }
        // Check the parent before creating any of the compound widget.
        if !matches!(
            self.nodes.get(&group).map(|n| n.kind),
            Some(Kind::Group | Kind::Scroll)
        ) {
            return Err("dropdown row requires a group or scroll".into());
        }
        let row = self.append(group, Kind::Row, "")?;
        self.append(row, Kind::Label, label)?;
        let combo = self.append(row, Kind::Dropdown { expanded: false }, options[selected])?;
        for (index, option) in options.iter().enumerate() {
            self.append(
                combo,
                Kind::DropdownOption {
                    selected: index == selected,
                },
                *option,
            )?;
        }
        Ok((row, combo))
    }

    pub fn dropdown_selected(&self, combo: NodeId) -> Result<usize> {
        let node = self.nodes.get(&combo).ok_or("unknown dropdown")?;
        if !matches!(node.kind, Kind::Dropdown { .. }) {
            return Err("not a dropdown".into());
        }
        node.children
            .iter()
            .position(|id| self.nodes[id].kind == Kind::DropdownOption { selected: true })
            .ok_or_else(|| "dropdown has no selection".into())
    }

    /// A model update (e.g. Config1 canonical reply); no user effect or write is emitted.
    pub fn set_dropdown_selected(&mut self, combo: NodeId, selected: usize) -> Result<()> {
        let node = self.nodes.get(&combo).ok_or("unknown dropdown")?;
        if !matches!(node.kind, Kind::Dropdown { .. }) {
            return Err("not a dropdown".into());
        }
        let option = *node
            .children
            .get(selected)
            .ok_or("dropdown selection outside options")?;
        self.select_dropdown_option(option)?;
        Ok(())
    }

    pub fn set_dropdown_expanded(&mut self, combo: NodeId, expanded: bool) -> Result<()> {
        let node = self.nodes.get_mut(&combo).ok_or("unknown dropdown")?;
        if !matches!(node.kind, Kind::Dropdown { .. }) {
            return Err("not a dropdown".into());
        }
        if node.kind != (Kind::Dropdown { expanded }) {
            node.kind = Kind::Dropdown { expanded };
            self.invalidate(combo, Invalid::STATE);
        }
        Ok(())
    }

    pub(crate) fn select_dropdown_option(&mut self, option: NodeId) -> Result<bool> {
        let node = self.nodes.get(&option).ok_or("unknown dropdown option")?;
        if !matches!(node.kind, Kind::DropdownOption { .. }) {
            return Err("not a dropdown option".into());
        }
        let combo = node.parent.ok_or("orphan dropdown option")?;
        if !matches!(self.nodes[&combo].kind, Kind::Dropdown { .. }) {
            return Err("option has no dropdown".into());
        }
        if node.kind == (Kind::DropdownOption { selected: true }) {
            return Ok(false);
        }
        let name = node.name.clone();
        let children = self.nodes[&combo].children.clone();
        for child in children {
            self.nodes.get_mut(&child).unwrap().kind = Kind::DropdownOption {
                selected: child == option,
            };
            self.invalidate(child, Invalid::SEMANTICS);
        }
        self.set_name(combo, name)?;
        Ok(true)
    }
}
