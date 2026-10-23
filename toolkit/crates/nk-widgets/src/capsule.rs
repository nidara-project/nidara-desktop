// SPDX-License-Identifier: LGPL-3.0-or-later
//! One retained panel of existing buttons; geometry comes from shared component data.
use crate::*;
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CapsuleMetrics {
    pub padding: f32,
    pub gap: f32,
    pub button_min: f32,
    pub height_min: f32,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct Capsule {
    pub position: Point,
    pub metrics: CapsuleMetrics,
}
impl CapsuleMetrics {
    fn validate(self) -> Result<()> {
        if ![self.padding, self.gap, self.button_min, self.height_min]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.)
            || self.button_min == 0.
            || self.height_min == 0.
        {
            return Err("invalid capsule metrics".into());
        }
        Ok(())
    }
}
impl Tree {
    pub fn control_capsule(
        &mut self,
        name: &str,
        position: Point,
        metrics: CapsuleMetrics,
    ) -> Result<NodeId> {
        metrics.validate()?;
        if name.is_empty() || !position.x.is_finite() || !position.y.is_finite() {
            return Err("capsule needs a name and finite position".into());
        }
        let id = self.allocate(Some(self.root), Kind::ControlCapsule, name.into());
        self.capsules.insert(id, Capsule { position, metrics });
        Ok(id)
    }
    pub fn capsule_button(
        &mut self,
        capsule: NodeId,
        name: &str,
        glyph: &str,
        destructive: bool,
    ) -> Result<NodeId> {
        if !self.capsules.contains_key(&capsule) || name.is_empty() || glyph.is_empty() {
            return Err("capsule button needs its panel, accessible name and glyph".into());
        }
        let id = self.append(capsule, Kind::Button, name)?;
        let node = self.nodes.get_mut(&id).unwrap();
        node.caption = Some(glyph.into());
        node.destructive = destructive;
        Ok(id)
    }
    pub fn set_capsule_metrics(&mut self, id: NodeId, metrics: CapsuleMetrics) -> Result<()> {
        metrics.validate()?;
        let capsule = self.capsules.get_mut(&id).ok_or("unknown capsule")?;
        if capsule.metrics != metrics {
            capsule.metrics = metrics;
            // Child constraints may be unchanged while their minimum size changed.
            for child in self.nodes[&id].children.clone() {
                self.invalidate(child, Invalid::LAYOUT);
            }
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub fn set_capsule_position(&mut self, id: NodeId, position: Point) -> Result<()> {
        if !position.x.is_finite() || !position.y.is_finite() {
            return Err("invalid capsule position".into());
        }
        let capsule = self.capsules.get_mut(&id).ok_or("unknown capsule")?;
        if capsule.position != position {
            capsule.position = position;
            self.invalidate(id, Invalid::LAYOUT);
        }
        Ok(())
    }
    pub(crate) fn capsule_for_button(&self, id: NodeId) -> Option<Capsule> {
        self.nodes[&id]
            .parent
            .and_then(|p| self.capsules.get(&p).copied())
    }
}
