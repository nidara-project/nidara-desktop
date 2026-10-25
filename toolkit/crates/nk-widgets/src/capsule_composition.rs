// SPDX-License-Identifier: LGPL-3.0-or-later
//! Capsule layers share the host's synchronized parent transaction.
use crate::*;
use nk_wayland::{Event, LayerEvent, LayerId, Window};
type PaintSignature = (u64, u64, u64, bool);
#[derive(Default)]
pub struct CapsuleComposition {
    layers: BTreeMap<NodeId, (LayerId, Option<PaintSignature>)>,
    revision: u64,
    paints: u64,
    // Client monotonic time since first sync, only for D5 wash sampling.
    // This is not a frame/presentation timestamp or phase-locked to D7.
    clock: Option<std::time::Instant>,
    fallback: crate::capsule_fallback::Fallback,
}
impl CapsuleComposition {
    /// Successful client layer-buffer paints, not compositor damage or presentations.
    pub fn paint_count(&self) -> u64 {
        self.paints
    }
    /// Whether the opaque fallback still needs timed samples; false for D7.
    pub fn is_animating(&self) -> bool {
        self.fallback.active
    }
    pub fn invalidate(&mut self) {
        self.revision = self.revision.wrapping_add(1);
    }
    pub fn layer(&self, capsule: NodeId) -> Option<LayerId> {
        self.layers.get(&capsule).map(|v| v.0)
    }
    pub fn sync(
        &mut self,
        tree: &mut Tree,
        window: &mut Window,
        palette: Palette,
        style: impl Fn(f64, bool) -> Result<CapsuleStyle>,
        reduce_motion: bool,
    ) -> Result<()> {
        let enabled = tree.layered && window.capabilities().layers;
        let ids: Vec<_> = tree
            .capsule_ids()
            .filter(|id| !tree.is_hidden(*id))
            .collect();
        let retired: Vec<_> = self
            .layers
            .keys()
            .copied()
            .filter(|id| !enabled || !ids.contains(id))
            .collect();
        for id in retired {
            let (layer, _) = self.layers.remove(&id).unwrap();
            window.destroy_layer(layer)?;
            window.redraw();
        }
        for id in ids {
            let bounds = tree.nodes[&id].bounds;
            let style = style(bounds.width.min(bounds.height) as f64, enabled)?;
            let payload = tree.capsule_material(id, &style, reduce_motion)?;
            tree.capsule_styles.insert(id, style);
            if !enabled {
                continue;
            }
            let size = (
                bounds.width.ceil().max(1.) as u32,
                bounds.height.ceil().max(1.) as u32,
            );
            if let std::collections::btree_map::Entry::Vacant(entry) = self.layers.entry(id) {
                entry.insert((window.create_layer(size)?, None));
            }
            let entry = self.layers.get_mut(&id).unwrap();
            let signature = (
                tree.pane_epoch,
                window.scale().to_bits(),
                self.revision,
                reduce_motion,
            );
            if entry.1 == Some(signature) {
                continue;
            }
            window.set_layer_size(entry.0, size)?;
            if !window.paint_layer(entry.0, |frame| {
                tree.paint_capsule_coverage(id, frame, palette)
            })? {
                continue;
            }
            self.paints = self.paints.wrapping_add(1);
            window.set_layer_control_material(entry.0, &payload)?;
            window.set_position(entry.0, bounds.x as f64, bounds.y as f64)?;
            entry.1 = Some(signature);
            window.redraw();
        }
        let now = self
            .clock
            .get_or_insert_with(std::time::Instant::now)
            .elapsed();
        if self.fallback.update(tree, now, reduce_motion, !enabled) {
            window.redraw();
        }
        Ok(())
    }
    pub fn search_layers(&self, tree: &Tree) -> BTreeMap<NodeId, (LayerId, Point)> {
        let mut layers = BTreeMap::new();
        for (capsule, (layer, _)) in &self.layers {
            let r = tree.nodes[capsule].bounds;
            for child in &tree.nodes[capsule].children {
                if tree.nodes[child].kind == Kind::SearchInput && !tree.is_hidden(*child) {
                    layers.insert(*child, (*layer, Point { x: r.x, y: r.y }));
                }
            }
        }
        layers
    }
    pub fn event(&mut self, tree: &mut Tree, event: &Event) -> Result<Option<Effect>> {
        let Event::Layer { id, event } = event else {
            return Ok(None);
        };
        let Some((&capsule, _)) = self.layers.iter().find(|(_, v)| v.0 == *id) else {
            return Ok(None);
        };
        Self::route(tree, capsule, event).map(Some)
    }
    pub(crate) fn route(tree: &mut Tree, capsule: NodeId, event: &LayerEvent) -> Result<Effect> {
        match event {
            LayerEvent::Motion(x, y) => tree.pointer_motion_in(
                capsule,
                Point {
                    x: *x as f32,
                    y: *y as f32,
                },
            )?,
            LayerEvent::Leave => tree.pointer_leave(),
            LayerEvent::Button {
                button: 272,
                pressed,
                x,
                y,
                ..
            } => {
                let point = Point {
                    x: *x as f32,
                    y: *y as f32,
                };
                tree.pointer_motion_in(capsule, point)?;
                if *pressed {
                    tree.pointer_press_in(capsule, point)?;
                } else {
                    return tree.pointer_release_in(capsule, point);
                }
            }
            _ => {}
        }
        Ok(Effect::None)
    }
}
