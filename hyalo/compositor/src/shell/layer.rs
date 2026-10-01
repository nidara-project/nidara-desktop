//! wlr-layer-shell: the protocol the shell's bar and dock are made of (gtk4-layer-shell).
//! Smithay's `LayerMap` does the arranging, exclusive zones and hit-testing; this file only
//! connects it to the state, the commit path and input.

use smithay::{
    desktop::{LayerSurface, WindowSurfaceType, layer_map_for_output},
    output::Output,
    reexports::wayland_server::protocol::{wl_output::WlOutput, wl_surface::WlSurface},
    utils::{Logical, Point},
    wayland::{
        compositor::with_states,
        shell::wlr_layer::{
            KeyboardInteractivity, Layer, LayerSurface as WlrLayerSurface, LayerSurfaceData,
            WlrLayerShellHandler, WlrLayerShellState,
        },
    },
};

use crate::Hyalo;

impl WlrLayerShellHandler for Hyalo {
    fn shell_state(&mut self) -> &mut WlrLayerShellState {
        &mut self.layer_shell_state
    }

    fn new_layer_surface(
        &mut self,
        surface: WlrLayerSurface,
        wl_output: Option<WlOutput>,
        _layer: Layer,
        namespace: String,
    ) {
        // A surface with no output asked for goes to the one under the pointer.
        let pointer = self.seat.get_pointer().unwrap().current_location();
        let output = wl_output.as_ref().and_then(Output::from_resource).or_else(|| {
            self.space
                .output_under(pointer)
                .next()
                .or_else(|| self.space.outputs().next())
                .cloned()
        });
        let Some(output) = output else {
            // No output at all (every monitor off): nothing can show it.
            surface.send_close();
            return;
        };
        if let Err(err) = layer_map_for_output(&output).map_layer(&LayerSurface::new(surface, namespace)) {
            tracing::warn!(?err, "could not map a layer surface");
        }
    }

    fn layer_destroyed(&mut self, surface: WlrLayerSurface) {
        for output in self.space.outputs() {
            let mut map = layer_map_for_output(output);
            let layer = map.layers().find(|l| l.layer_surface() == &surface).cloned();
            if let Some(layer) = layer {
                map.unmap_layer(&layer);
            }
        }
        self.queue_redraw(None);
    }

    fn new_popup(&mut self, _parent: WlrLayerSurface, popup: smithay::wayland::shell::xdg::PopupSurface) {
        // Already tracked by xdg-shell's `new_popup`, before it had a parent; now that it has
        // one, it can be kept on its output.
        self.unconstrain_popup(&popup);
    }
}

impl Hyalo {
    /// Called on every commit: re-arrange the layer's output, and send the first configure
    /// (the client may not attach a buffer before it gets one).
    pub fn layer_commit(&mut self, surface: &WlSurface) {
        let Some(output) = self
            .space
            .outputs()
            .find(|o| {
                layer_map_for_output(o)
                    .layer_for_surface(surface, WindowSurfaceType::TOPLEVEL)
                    .is_some()
            })
            .cloned()
        else {
            return;
        };
        let initial_configure_sent = with_states(surface, |states| {
            states
                .data_map
                .get::<LayerSurfaceData>()
                .unwrap()
                .lock()
                .unwrap()
                .initial_configure_sent
        });
        let mut map = layer_map_for_output(&output);
        map.arrange();
        if !initial_configure_sent {
            map.layer_for_surface(surface, WindowSurfaceType::TOPLEVEL)
                .unwrap()
                .layer_surface()
                .send_configure();
        }
    }

    /// The layer surface under a point on one of the given layers, topmost first.
    pub fn layer_under(
        &self,
        layers: &[Layer],
        pos: Point<f64, Logical>,
    ) -> Option<(LayerSurface, WlSurface, Point<f64, Logical>)> {
        let output = self.space.output_under(pos).next()?;
        let output_loc = self.space.output_geometry(output)?.loc;
        let map = layer_map_for_output(output);
        // Every layer surface of a kind, topmost first, asked through its INPUT region.
        // `LayerMap::layer_under` stops at the first bounding box, and the shell's bar, dock
        // and island are all monitor-sized: the bar would swallow every click meant for the
        // dock beneath it.
        for layer in layers {
            for l in map.layers_on(*layer).rev() {
                let Some(geo) = map.layer_geometry(l) else { continue };
                let origin = geo.loc + output_loc;
                if let Some((s, p)) = l.surface_under(pos - origin.to_f64(), WindowSurfaceType::ALL) {
                    return Some((l.clone(), s, (p + origin).to_f64()));
                }
            }
        }
        None
    }

    /// A layer that asked for the keyboard gets it when clicked.
    pub fn layer_wants_keyboard(layer: &LayerSurface) -> bool {
        layer.cached_state().keyboard_interactivity != KeyboardInteractivity::None
    }

    pub fn arrange_layers(&self) {
        for output in self.space.outputs() {
            layer_map_for_output(output).arrange();
        }
    }
}
