// SPDX-License-Identifier: LGPL-3.0-or-later
//! A row's second line, a group's footer, and the disclosure row (#915) — the kit's
//! `.nidara-row-subtitle`, `.nidara-list-footer` and the Settings' "Advanced" row
//! (`PreferencePage.ts`: a row whose activation reveals the items after it, with a chevron).
//! Their look is `RowTextStyle`, from `toolkit/tokens/rows.json` through `components.json`'s
//! `rows`; there are no defaults here.
use crate::*;
use nk_render::Color;

#[derive(Clone, Debug)]
pub struct RowTextStyle {
    /// Relative to the tree's text style (`fse-small`).
    pub subtitle_scale: f32,
    pub subtitle: Color,
    /// Relative to the tree's text style (`fse-caption`).
    pub footer_scale: f32,
    pub footer: Color,
    /// Between the group's card and its footer (the kit's `margin-top`).
    pub footer_gap: f32,
    pub disclosure_icon_size: f32,
    /// The chevron's icon names, open and closed (`nd-pan-down`, `nd-pan-end`).
    pub disclosure_open: String,
    pub disclosure_closed: String,
}

impl RowTextStyle {
    fn validate(&self) -> Result<()> {
        if !(self.subtitle_scale.is_finite() && self.subtitle_scale > 0.)
            || !(self.footer_scale.is_finite() && self.footer_scale > 0.)
            || !(self.footer_gap.is_finite() && self.footer_gap >= 0.)
            || !(self.disclosure_icon_size.is_finite() && self.disclosure_icon_size > 0.)
            || self.disclosure_open.is_empty()
            || self.disclosure_closed.is_empty()
        {
            return Err("invalid row text style".into());
        }
        Ok(())
    }
}

impl Tree {
    pub fn set_row_text_style(&mut self, style: RowTextStyle) -> Result<()> {
        style.validate()?;
        self.row_text_style = Some(style);
        let texts: Vec<_> = self
            .nodes
            .iter()
            .filter(|(_, n)| {
                matches!(
                    n.kind,
                    Kind::Subtitle | Kind::Footer | Kind::Disclosure { .. }
                )
            })
            .map(|(id, _)| *id)
            .collect();
        for id in texts {
            self.nodes.get_mut(&id).unwrap().layout = None;
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }

    pub(crate) fn row_text(&self) -> Result<&RowTextStyle> {
        self.row_text_style
            .as_ref()
            .ok_or_else(|| "a row text measured before its row text style was set".into())
    }

    /// A row's second line under its label; `None` removes it. AT-SPI: the description of
    /// the row and of its control.
    pub fn set_subtitle(&mut self, row: NodeId, text: Option<&str>) -> Result<Option<NodeId>> {
        if self.nodes.get(&row).map(|n| n.kind) != Some(Kind::Row) {
            return Err("a subtitle needs a row".into());
        }
        self.set_text_child(row, Kind::Subtitle, text)
    }

    /// The line under a group's card; `None` removes it. Hidden and shown like any node
    /// (`set_hidden`), which is how a `footerWhen` is followed.
    pub fn set_footer(&mut self, group: NodeId, text: Option<&str>) -> Result<Option<NodeId>> {
        if self.nodes.get(&group).map(|n| n.kind) != Some(Kind::Group) {
            return Err("a footer needs a group".into());
        }
        let id = self.set_text_child(group, Kind::Footer, text)?;
        // Always the group's last child: under the card, after every row added before or since.
        if let Some(id) = id {
            let children = &mut self.nodes.get_mut(&group).unwrap().children;
            children.retain(|c| *c != id);
            children.push(id);
        }
        Ok(id)
    }

    fn set_text_child(
        &mut self,
        parent: NodeId,
        kind: Kind,
        text: Option<&str>,
    ) -> Result<Option<NodeId>> {
        let existing = self.nodes[&parent]
            .children
            .iter()
            .copied()
            .find(|c| self.nodes[c].kind == kind);
        match (existing, text) {
            (Some(id), Some(text)) => {
                self.set_name(id, text)?;
                self.nodes.get_mut(&id).unwrap().layout = None;
                self.invalidate(id, Invalid::LAYOUT);
                Ok(Some(id))
            }
            (Some(id), None) => {
                self.remove(id)?;
                self.invalidate(parent, Invalid::LAYOUT);
                Ok(None)
            }
            (None, Some(text)) => Ok(Some(self.append(parent, kind, text)?)),
            (None, None) => Ok(None),
        }
    }

    /// A row that opens and closes what follows it ("Advanced"): focusable, activated by a
    /// click anywhere on it, Space or Enter (`Effect::Activated`, its state already flipped);
    /// the application shows or hides the items. AT-SPI: an expandable `ToggleButton`.
    pub fn disclosure(&mut self, group: NodeId, label: &str, expanded: bool) -> Result<NodeId> {
        let id = self.append(group, Kind::Disclosure { expanded }, label)?;
        self.append(id, Kind::Label, label)?;
        Ok(id)
    }

    /// From the model, without activation.
    pub fn set_expanded(&mut self, id: NodeId, expanded: bool) -> Result<()> {
        let n = self.nodes.get_mut(&id).ok_or("unknown disclosure")?;
        if !matches!(n.kind, Kind::Disclosure { .. }) {
            return Err("widget is not a disclosure".into());
        }
        if n.kind != (Kind::Disclosure { expanded }) {
            n.kind = Kind::Disclosure { expanded };
            self.invalidate(id, Invalid::STATE);
        }
        Ok(())
    }

    pub fn expanded(&self, id: NodeId) -> Option<bool> {
        match self.nodes.get(&id)?.kind {
            Kind::Disclosure { expanded } => Some(expanded),
            _ => None,
        }
    }

    /// The chevron at a disclosure row's trailing edge.
    pub(crate) fn paint_disclosure(
        &self,
        r: Rect,
        expanded: bool,
        ink: Color,
        canvas: &mut nk_render::Canvas,
    ) -> Result<()> {
        let s = self.row_text()?;
        let size = s.disclosure_icon_size;
        let name = if expanded {
            &s.disclosure_open
        } else {
            &s.disclosure_closed
        };
        let icon = self.icon(name, size)?;
        canvas.icon(
            &icon,
            Rect {
                x: r.x + r.width - self.metrics.padding - size,
                y: r.y + (r.height - size) / 2.,
                width: size,
                height: size,
            },
            ink,
        );
        Ok(())
    }
}
