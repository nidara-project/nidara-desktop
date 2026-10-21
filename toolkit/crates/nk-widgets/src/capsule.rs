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
        node.button_shape = ButtonShape::Capsule;
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

#[derive(Clone, Copy, Debug)]
pub struct CapsuleStateStyle {
    pub wash: [f64; 4],
    pub ink: Option<[f64; 4]>,
}
#[derive(Clone, Debug)]
pub struct CapsuleStyle {
    pub material: nk_wayland::ControlMaterial,
    pub hover: CapsuleStateStyle,
    pub press: CapsuleStateStyle,
    pub destructive_hover: CapsuleStateStyle,
    pub destructive_press: CapsuleStateStyle,
    pub fade_ms: u32,
}
impl CapsuleStyle {
    pub fn for_pane(
        &self,
        pane: nk_wayland::Pane,
        reduce_motion: bool,
    ) -> Result<nk_wayland::ControlMaterial> {
        for state in [
            self.hover,
            self.press,
            self.destructive_hover,
            self.destructive_press,
        ] {
            if !state
                .wash
                .iter()
                .chain(state.ink.as_ref().into_iter().flatten())
                .all(|v| (0. ..=1.).contains(v))
            {
                return Err("invalid capsule state RGBA".into());
            }
        }
        let mut material = self.material.clone();
        material.base.shapes = vec![pane];
        if reduce_motion && let Some(response) = &mut material.response {
            response.settle_ms = 0;
        }
        material.validate()?;
        Ok(material)
    }
    pub fn fade_ms(&self, reduce_motion: bool) -> u32 {
        if reduce_motion { 0 } else { self.fade_ms }
    }
}
impl Tree {
    pub fn capsule_ids(&self) -> impl Iterator<Item = NodeId> + '_ {
        self.capsules.keys().copied()
    }
    pub(crate) fn capsule_state(
        &self,
        id: NodeId,
        style: &CapsuleStyle,
    ) -> Option<CapsuleStateStyle> {
        if !self.available(id) || self.hovered != Some(id) {
            return None;
        }
        Some(
            match (self.nodes[&id].destructive, self.capture == Some(id)) {
                (true, true) => style.destructive_press,
                (true, false) => style.destructive_hover,
                (false, true) => style.press,
                (false, false) => style.hover,
            },
        )
    }
    /// One monochrome capsule buffer and its complete, validated material replacement.
    pub fn capsule_material(
        &self,
        id: NodeId,
        style: &CapsuleStyle,
        reduce_motion: bool,
    ) -> Result<nk_wayland::ControlMaterial> {
        if !self.capsules.contains_key(&id) || self.is_hidden(id) {
            return Err("unknown or hidden capsule".into());
        }
        let pane = self.nodes[&id].bounds;
        let mut material = style.for_pane(
            nk_wayland::Pane {
                x: 0.,
                y: 0.,
                width: pane.width as f64,
                height: pane.height as f64,
                radius: (pane.height / 2.) as f64,
                exponent: 2.,
            },
            reduce_motion,
        )?;
        material.states.clear();
        material.coverage.clear();
        for button in &self.nodes[&id].children {
            if self.is_hidden(*button) {
                continue;
            }
            let r = self.nodes[button].bounds;
            let bounds = nk_wayland::MaterialRect {
                x: (r.x - pane.x) as f64,
                y: (r.y - pane.y) as f64,
                width: r.width as f64,
                height: r.height as f64,
            };
            let state = self.capsule_state(*button, style);
            material.states.push(nk_wayland::StateRegion {
                id: u32::try_from(*button)
                    .map_err(|_| "capsule button id exceeds protocol range")?,
                bounds,
                radius: self.highlight_shape(*button).1 as f64,
                // Keep idle regions with the same IDs for compositor-owned fade-out.
                wash: state.map_or([0.; 4], |s| s.wash),
                fade_ms: style.fade_ms(reduce_motion),
            });
            material.coverage.push(nk_wayland::InkCoverage {
                bounds,
                override_color: state.and_then(|s| s.ink).unwrap_or([0.; 4]),
            });
        }
        material.validate()?;
        Ok(material)
    }
    pub fn paint_capsule_coverage(
        &self,
        id: NodeId,
        frame: nk_wayland::Frame,
        palette: Palette,
    ) -> Result<Vec<u8>> {
        if !self.capsules.contains_key(&id) {
            return Err("unknown capsule".into());
        }
        let mut canvas = nk_render::Canvas::new(frame.pixel_width, frame.pixel_height, frame.scale);
        let bounds = self.nodes[&id].bounds;
        self.paint_capsule_into(
            id,
            Point {
                x: bounds.x,
                y: bounds.y,
            },
            &mut canvas,
            palette,
            None,
        )?;
        Ok(canvas.finish())
    }
    pub(crate) fn paint_capsule_into(
        &self,
        id: NodeId,
        origin: Point,
        canvas: &mut nk_render::Canvas,
        palette: Palette,
        fallback: Option<&CapsuleStyle>,
    ) -> Result<()> {
        if self.is_hidden(id) {
            return Ok(());
        }
        let local = |r: Rect| Rect {
            x: r.x - origin.x,
            y: r.y - origin.y,
            ..r
        };
        let pane = local(self.nodes[&id].bounds);
        canvas.clip_rounded_rect(pane, (pane.height / 2.) as f64);
        let color = |c: [f64; 4]| nk_render::Color::new(c.map(|v| v as f32));
        if let Some(style) = fallback {
            let wash = style.material.base.tone.wash;
            if wash[3] != 1. {
                return Err("D5 capsule requires exported opaque variant".into());
            }
            canvas.rounded_rect(pane, (pane.height / 2.) as f64, color(wash));
        }
        for button in &self.nodes[&id].children {
            if self.is_hidden(*button) {
                continue;
            }
            let n = &self.nodes[button];
            let r = local(n.bounds);
            canvas.clip(r);
            let mut ink = nk_render::rgba(255, 255, 255, 255);
            if let Some(style) = fallback {
                let state = self.capsule_state(*button, style);
                let wash = self
                    .capsule_washes
                    .get(button)
                    .copied()
                    .unwrap_or_else(|| state.map_or([0.; 4], |s| s.wash));
                if wash[3] > 0. {
                    canvas.rounded_rect(r, self.highlight_shape(*button).1 as f64, color(wash));
                }
                ink = color(
                    state
                        .and_then(|s| s.ink)
                        .unwrap_or(style.material.light_ink),
                );
            }
            if !self.available(*button) {
                ink.components[3] *= palette.disabled.components[3];
            }
            if let Some(layout) = &n.layout {
                let size = layout.measured_size();
                canvas.layout(
                    layout,
                    (
                        r.x + (r.width - size.width) / 2.,
                        r.y + (r.height - size.height) / 2.,
                    ),
                    ink,
                )?;
            }
            if self.focus_visible && self.focused == Some(*button) {
                canvas.rounded_ring(
                    r,
                    self.highlight_shape(*button).1 as f64,
                    self.metrics.focus_width as f64,
                    ink,
                );
            }
            canvas.pop_clip();
        }
        canvas.pop_clip();
        Ok(())
    }
}
