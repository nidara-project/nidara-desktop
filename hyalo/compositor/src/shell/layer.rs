//! wlr-layer-shell: the protocol the shell's bar and dock are made of (gtk4-layer-shell).
//! Smithay's `LayerMap` keeps the surfaces and does the hit-testing; WHERE they go is
//! `arrange_output`'s, by Hyprland's rule (see there). This file connects it to the state, the
//! commit path and input.

use std::sync::Mutex;

use smithay::{
    desktop::{LayerMap, LayerSurface, PopupManager, WindowSurfaceType, layer_map_for_output},
    output::Output,
    reexports::wayland_server::protocol::{wl_output::WlOutput, wl_surface::WlSurface},
    utils::{Logical, Point, Rectangle, Size},
    wayland::{
        compositor::{TraversalAction, with_states, with_surface_tree_downward},
        shell::wlr_layer::{
            Anchor, ExclusiveZone, KeyboardInteractivity, Layer, LayerSurface as WlrLayerSurface,
            LayerSurfaceCachedState, LayerSurfaceData, WlrLayerShellHandler, WlrLayerShellState,
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
        for output in self.space.outputs() {
            arrange_output(output);
        }
        // A panel that had the keyboard is gone: it goes back to the focused window, and the
        // usable area may have grown.
        self.restore_keyboard_focus();
        self.arrange_all();
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
        let zone_before = usable_zone(&output);
        let mut map = layer_map_for_output(&output);
        // A surface that moved to another level goes to the TOP of it, as on Hyprland: a
        // client has no "raise" in layer-shell, so leaving the level and coming back is how
        // it gets above a sibling (the shell's island over the bar, IslandWindow.raise).
        // Smithay keeps the order surfaces were mapped in, so it is re-mapped at the end.
        if let Some(layer) = map.layer_for_surface(surface, WindowSurfaceType::TOPLEVEL).cloned() {
            let now = layer.layer();
            let moved = with_states(surface, |states| {
                let last = states.data_map.get_or_insert_threadsafe(|| std::sync::Mutex::new(now));
                let mut last = last.lock().unwrap();
                let moved = *last != now;
                *last = now;
                moved
            });
            if moved {
                map.unmap_layer(&layer);
                if let Err(err) = map.map_layer(&layer) {
                    tracing::warn!(?err, "a layer surface that changed level could not be re-mapped");
                }
            }
        }
        drop(map);
        arrange_output(&output);
        let zone_changed = usable_zone(&output) != zone_before;
        let map = layer_map_for_output(&output);
        if !initial_configure_sent {
            map.layer_for_surface(surface, WindowSurfaceType::TOPLEVEL)
                .unwrap()
                .layer_surface()
                .send_configure();
        }
        drop(map);
        // The bar or the dock took or gave back room: the windows on that output follow.
        if zone_changed {
            let name = output.name();
            let on: Vec<i32> = self.wm.workspaces.values().filter(|w| w.output == name).map(|w| w.id).collect();
            for ws in on {
                // Floating windows that the bar or dock now covers come out from under it.
                self.reclamp_floating(ws);
                self.arrange_workspace(ws);
            }
            self.sync_space();
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
                let Some(geo) = layer_geometry(&map, l) else { continue };
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
            arrange_output(output);
        }
    }
}

/// The usable area Hyalo arranged an output's layer surfaces into: what the bar and the dock
/// leave, output coordinates. (Smithay's `non_exclusive_zone` is only brought up to date by its
/// own arranging, which Hyalo does not use — see `arrange_output`.)
pub fn usable_zone(output: &Output) -> Rectangle<i32, Logical> {
    let stored = output.user_data().get::<UsableZone>().and_then(|z| *z.0.lock().unwrap());
    stored.unwrap_or_else(|| layer_map_for_output(output).non_exclusive_zone())
}

struct UsableZone(Mutex<Option<Rectangle<i32, Logical>>>);

/// Where `arrange_output` put a layer surface, output coordinates.
struct Place(Mutex<Option<Point<i32, Logical>>>);

/// A layer surface's rectangle on its output, as `arrange_output` placed it — what to draw,
/// hit-test and place popups by. Never `LayerMap::layer_geometry`: that is where Smithay's own
/// rule put it.
pub fn layer_geometry(map: &LayerMap, layer: &LayerSurface) -> Option<Rectangle<i32, Logical>> {
    let mut geo = map.layer_geometry(layer)?;
    if let Some(loc) = layer.user_data().get::<Place>().and_then(|p| *p.0.lock().unwrap()) {
        geo.loc = layer.geometry().loc + loc;
    }
    Some(geo)
}

/// Places an output's layer surfaces, Hyprland's way: a surface that reserves room (a positive
/// exclusive zone) is placed against the WHOLE output, and its room comes off the usable area;
/// a surface with zone 0 goes in what is left; one with -1 ignores it all.
///
/// Smithay's `LayerMap::arrange` places each reserving surface inside what the ones mapped
/// before it left, so the result depended on the order the shell's surfaces were mapped in. The
/// bar and the dock both cover the whole monitor (the bar for its panels, the dock for its
/// magnification) and each reserves its own strip: mapped bar-first — as after an unlock,
/// which shows them again in that order — the dock was placed under the bar's 36 px and hung
/// off the bottom of the screen (owner-caught 2026-10-02). The shell is written for the rule
/// here (`Bar.tsx` → "Top zone reservation").
///
/// Smithay still arranges by its own rule when a surface is mapped or unmapped (inside
/// `map_layer`/`unmap_layer`); this runs right after, on the commit or the destruction. It
/// sends a configure only when a size changes, so it settles: never call `LayerMap::arrange`
/// besides it, or the two rules would answer each other's configures forever.
pub fn arrange_output(output: &Output) {
    let Some(mode) = output.current_mode() else { return };
    let size = output
        .current_transform()
        .transform_size(mode.size.to_f64().to_logical(output.current_scale().fractional_scale()).to_i32_round());
    let whole = Rectangle::from_size(size);
    let mut zone = whole;
    let map = layer_map_for_output(output);
    let reserves = |l: &LayerSurface| reserved_edge(&l.cached_state()).is_some();
    let ordered: Vec<LayerSurface> =
        map.layers().filter(|l| reserves(l)).chain(map.layers().filter(|l| !reserves(l))).cloned().collect();
    drop(map);
    for layer in &ordered {
        enter_output(output, layer.wl_surface());
        let data = layer.cached_state();
        let source = match data.exclusive_zone {
            _ if reserved_edge(&data).is_some() => whole,
            ExclusiveZone::DontCare => whole,
            _ => zone,
        };
        let (location, size) = place(&data, source);
        if let (Some(edge), ExclusiveZone::Exclusive(amount)) = (reserved_edge(&data), data.exclusive_zone) {
            let m = &data.margin;
            let amount = amount as i32;
            match edge {
                Anchor::TOP => {
                    let cut = (whole.loc.y + amount + m.top - zone.loc.y).max(0);
                    zone.loc.y += cut;
                    zone.size.h -= cut;
                }
                Anchor::BOTTOM => {
                    let edge_y = whole.loc.y + whole.size.h - amount - m.bottom;
                    zone.size.h = zone.size.h.min(edge_y - zone.loc.y);
                }
                Anchor::LEFT => {
                    let cut = (whole.loc.x + amount + m.left - zone.loc.x).max(0);
                    zone.loc.x += cut;
                    zone.size.w -= cut;
                }
                _ => {
                    let edge_x = whole.loc.x + whole.size.w - amount - m.right;
                    zone.size.w = zone.size.w.min(edge_x - zone.loc.x);
                }
            }
        }
        let size = Size::from((size.w.max(0), size.h.max(0)));
        let surface = layer.layer_surface();
        let changed = surface.with_pending_state(|state| state.size.replace(size) != Some(size));
        let configured = with_states(layer.wl_surface(), |states| {
            states.data_map.get::<LayerSurfaceData>().is_some_and(|d| d.lock().unwrap().initial_configure_sent)
        });
        // Never before the initial configure, which answers the client's first commit.
        if changed && configured {
            surface.send_pending_configure();
        }
        layer.user_data().insert_if_missing_threadsafe(|| Place(Mutex::new(None)));
        *layer.user_data().get::<Place>().unwrap().0.lock().unwrap() = Some(location);
    }
    zone.size = Size::from((zone.size.w.max(0), zone.size.h.max(0)));
    output.user_data().insert_if_missing_threadsafe(|| UsableZone(Mutex::new(None)));
    *output.user_data().get::<UsableZone>().unwrap().0.lock().unwrap() = Some(zone);
}

/// The edge a surface reserves room along, if it reserves any: a positive zone, anchored to one
/// edge, or to an edge and both of its neighbours (or naming its edge).
fn reserved_edge(data: &LayerSurfaceCachedState) -> Option<Anchor> {
    if !matches!(data.exclusive_zone, ExclusiveZone::Exclusive(_)) {
        return None;
    }
    data.exclusive_edge.or_else(|| match data.anchor.bits().count_ones() {
        1 => Some(data.anchor),
        3 => Some(match data.anchor.complement() {
            Anchor::TOP => Anchor::BOTTOM,
            Anchor::BOTTOM => Anchor::TOP,
            Anchor::LEFT => Anchor::RIGHT,
            _ => Anchor::LEFT,
        }),
        _ => None,
    })
}

/// A surface's place inside `source`: its anchors, margins and asked-for size (0 along an axis
/// = as large as it is anchored to, or half).
fn place(data: &LayerSurfaceCachedState, source: Rectangle<i32, Logical>) -> (Point<i32, Logical>, Size<i32, Logical>) {
    let (a, m) = (data.anchor, &data.margin);
    let mut avail = source.size;
    if a.contains(Anchor::LEFT) {
        avail.w -= m.left;
    }
    if a.contains(Anchor::RIGHT) {
        avail.w -= m.right;
    }
    if a.contains(Anchor::TOP) {
        avail.h -= m.top;
    }
    if a.contains(Anchor::BOTTOM) {
        avail.h -= m.bottom;
    }
    let mut w = data.size.w.min(avail.w);
    let mut h = data.size.h.min(avail.h);
    if w == 0 {
        w = avail.w / 2;
    }
    if h == 0 {
        h = avail.h / 2;
    }
    if a.anchored_horizontally() {
        w = avail.w;
    }
    if a.anchored_vertically() {
        h = avail.h;
    }
    let x = if a.contains(Anchor::LEFT) {
        source.loc.x + m.left
    } else if a.contains(Anchor::RIGHT) {
        source.loc.x + (avail.w - w)
    } else {
        source.loc.x + avail.w / 2 - w / 2
    };
    let y = if a.contains(Anchor::TOP) {
        source.loc.y + m.top
    } else if a.contains(Anchor::BOTTOM) {
        source.loc.y + (avail.h - h)
    } else {
        source.loc.y + avail.h / 2 - h / 2
    };
    ((x, y).into(), (w, h).into())
}

/// The output a layer surface is on, told to it and to its popups (their scale).
fn enter_output(output: &Output, surface: &WlSurface) {
    let enter = |s: &WlSurface| {
        with_surface_tree_downward(s, (), |_, _, _| TraversalAction::DoChildren(()), |s, _, _| output.enter(s), |_, _, _| true)
    };
    enter(surface);
    for (popup, _) in PopupManager::popups_for_surface(surface) {
        enter(popup.wl_surface());
    }
}
