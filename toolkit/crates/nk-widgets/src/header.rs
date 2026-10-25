// SPDX-License-Identifier: LGPL-3.0-or-later
//! Explicit app-supplied title geometry; accessibility names never become icon captions.
use crate::*;
#[derive(Clone, Debug, PartialEq)]
pub struct TitleTextBox {
    /// Relative to the title pane, after reserving its floating controls.
    pub bounds: Rect,
    pub style: TextStyle,
}
impl Tree {
    pub fn set_title_text_box(&mut self, value: TitleTextBox) -> Result<()> {
        let r = value.bounds;
        if [r.x, r.y, r.width, r.height]
            .iter()
            .any(|v| !v.is_finite() || *v < 0.)
        {
            return Err("invalid title text box".into());
        }
        value.style.validate(r.width.max(1.))?;
        if self.title_text_box.as_ref() != Some(&value) {
            self.title_text_box = Some(value);
            if let Some(id) = self
                .nodes
                .iter()
                .find(|(_, n)| n.kind == Kind::TitleBar)
                .map(|(id, _)| *id)
            {
                self.nodes.get_mut(&id).unwrap().layout = None;
                self.invalidate(id, Invalid::LAYOUT);
            }
        }
        Ok(())
    }
    pub fn set_content_top_gap(&mut self, gap: f32) -> Result<()> {
        if !gap.is_finite() || gap < 0. {
            return Err("invalid content top gap".into());
        }
        if self.content_top_gap != Some(gap) {
            self.content_top_gap = Some(gap);
            self.invalidate(self.root, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub fn set_sidebar_toggle(&mut self, button: NodeId) -> Result<()> {
        if self
            .nodes
            .get(&button)
            .is_none_or(|n| n.kind != Kind::Button)
        {
            return Err("sidebar toggle requires a retained button".into());
        }
        if self
            .sidebar_button
            .is_some_and(|old| old != button && self.nodes.contains_key(&old))
        {
            return Err("sidebar already has a toggle button".into());
        }
        self.sidebar_button = Some(button);
        Ok(())
    }
    pub fn set_button_icon(&mut self, button: NodeId, name: &str, size: f32) -> Result<()> {
        if self
            .nodes
            .get(&button)
            .is_none_or(|n| n.kind != Kind::Button)
            || name.is_empty()
            || !size.is_finite()
            || size <= 0.
        {
            return Err("invalid retained button icon".into());
        }
        let value = (name.to_owned(), size);
        if self.button_icons.get(&button) != Some(&value) {
            self.button_icons.insert(button, value);
            self.nodes.get_mut(&button).unwrap().layout = None;
            self.invalidate(button, Invalid::LAYOUT);
        }
        Ok(())
    }
}
