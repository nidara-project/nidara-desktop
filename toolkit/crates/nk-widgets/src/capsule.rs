// SPDX-License-Identifier: LGPL-3.0-or-later
//! One retained panel of existing buttons; geometry comes from shared component data.
use crate::*;
/// Captions are for ordinary toolbar actions; window controls use paths.
pub enum CapsuleGlyph<'a> {
    Window(WindowGlyph),
    Caption(&'a str),
}
impl<'a> From<&'a str> for CapsuleGlyph<'a> {
    fn from(value: &'a str) -> Self {
        Self::Caption(value)
    }
}
impl From<WindowGlyph> for CapsuleGlyph<'_> {
    fn from(value: WindowGlyph) -> Self {
        Self::Window(value)
    }
}
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
    /// Register an existing vector capsule as the client fallback for server controls.
    /// The host hides the whole panel on layout, including semantics, focus and capture.
    pub fn window_controls_capsule(&mut self, panel: NodeId) -> Result<[NodeId; 3]> {
        if self.window_buttons.is_some() {
            return Err("duplicate window controls".into());
        }
        let capsule = self
            .nodes
            .get(&panel)
            .filter(|_| self.capsules.contains_key(&panel))
            .ok_or("window controls need a capsule")?;
        let ids: [NodeId; 3] = capsule
            .children
            .as_slice()
            .try_into()
            .map_err(|_| "window controls need three buttons")?;
        for (id, kind) in ids.into_iter().zip([
            WindowGlyph::Minimize,
            WindowGlyph::Maximize,
            WindowGlyph::Close,
        ]) {
            if self.nodes[&id].kind != Kind::Button || self.nodes[&id].window_glyph != Some(kind) {
                return Err(
                    "window controls need minimize, maximize and close paths in order".into(),
                );
            }
        }
        self.window_buttons = Some(ids);
        self.window_control_capsule = Some(panel);
        self.set_hidden(panel, self.server_controls.is_some())?;
        self.invalidate(self.root, Invalid::LAYOUT);
        Ok(ids)
    }

    pub fn set_window_glyph_style(&mut self, style: WindowGlyphStyle) -> Result<()> {
        style.validate()?;
        if self.window_glyph_style != Some(style) {
            self.window_glyph_style = Some(style);
            for id in self.capsules.keys().copied().collect::<Vec<_>>() {
                self.invalidate(id, Invalid::PAINT);
            }
        }
        Ok(())
    }

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
    pub fn capsule_button<'a>(
        &mut self,
        capsule: NodeId,
        name: &str,
        glyph: impl Into<CapsuleGlyph<'a>>,
        destructive: bool,
    ) -> Result<NodeId> {
        let glyph = glyph.into();
        if !self.capsules.contains_key(&capsule)
            || name.is_empty()
            || matches!(glyph, CapsuleGlyph::Caption(""))
        {
            return Err("capsule button needs its panel, accessible name and glyph".into());
        }
        let id = self.append(capsule, Kind::Button, name)?;
        let node = self.nodes.get_mut(&id).unwrap();
        node.button_shape = ButtonShape::Capsule;
        match glyph {
            CapsuleGlyph::Window(kind) => node.window_glyph = Some(kind),
            CapsuleGlyph::Caption(text) => node.caption = Some(text.into()),
        }
        node.destructive = destructive;
        Ok(id)
    }
    /// The current exported metrics, including changes applied before the next layout.
    pub fn capsule_metrics(&self, id: NodeId) -> Result<CapsuleMetrics> {
        self.capsules
            .get(&id)
            .map(|capsule| capsule.metrics)
            .ok_or_else(|| "unknown capsule".into())
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
    /// Match Hyalo's server controls: idle keeps the hover hue at zero alpha.
    /// Interpolating straight RGBA from transparent black changes the fade itself.
    pub(crate) fn capsule_wash(&self, id: NodeId, style: &CapsuleStyle) -> [f64; 4] {
        if let Some(state) = self.capsule_state(id, style) {
            return state.wash;
        }
        let mut wash = if self.nodes[&id].destructive {
            style.destructive_hover.wash
        } else {
            style.hover.wash
        };
        wash[3] = 0.;
        wash
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
                wash: self.capsule_wash(*button, style),
                fade_ms: style.fade_ms(reduce_motion),
            });
            // Keep actual coloured selection pixels out of the adaptive ink mask.
            // The conservative union bounds bidi selections with at most four regions.
            let selected = if self.nodes[button].kind == Kind::SearchInput {
                self.search_selection_box(*button)?
            } else {
                None
            };
            let regions = match selected {
                None => vec![r],
                Some(cut) => vec![
                    Rect {
                        x: r.x,
                        y: r.y,
                        width: r.width,
                        height: (cut.y - r.y).max(0.),
                    },
                    Rect {
                        x: r.x,
                        y: cut.y + cut.height,
                        width: r.width,
                        height: (r.y + r.height - cut.y - cut.height).max(0.),
                    },
                    Rect {
                        x: r.x,
                        y: cut.y,
                        width: (cut.x - r.x).max(0.),
                        height: cut.height,
                    },
                    Rect {
                        x: cut.x + cut.width,
                        y: cut.y,
                        width: (r.x + r.width - cut.x - cut.width).max(0.),
                        height: cut.height,
                    },
                ],
            };
            for area in regions
                .into_iter()
                .filter(|a| a.width > 0. && a.height > 0.)
            {
                material.coverage.push(nk_wayland::InkCoverage {
                    bounds: nk_wayland::MaterialRect {
                        x: (area.x - pane.x) as f64,
                        y: (area.y - pane.y) as f64,
                        width: area.width as f64,
                        height: area.height as f64,
                    },
                    override_color: state.and_then(|s| s.ink).unwrap_or([0.; 4]),
                });
            }
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
                    .unwrap_or_else(|| self.capsule_wash(*button, style));
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
            if n.kind == Kind::SearchInput {
                self.paint_search_chrome(*button, r, canvas, palette.disabled, false)?;
            } else if let Some(kind) = n.window_glyph {
                canvas.window_glyph(
                    kind,
                    self.window_glyph_style
                        .ok_or("missing window glyph style")?,
                    r,
                    ink,
                );
            } else if let Some((name, size)) = self.button_icons.get(button) {
                let icon = self.icon(name, *size)?;
                canvas.icon(
                    &icon,
                    Rect {
                        x: r.x + (r.width - size) / 2.,
                        y: r.y + (r.height - size) / 2.,
                        width: *size,
                        height: *size,
                    },
                    ink,
                );
            } else if let Some(layout) = &n.layout {
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
