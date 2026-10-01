//! nidara-material-v1: a surface declares its glass shapes and its blur; the renderer
//! (src/render/glass.rs) resolves them against the backdrop. Double-buffered on wl_surface.commit
//! through Smithay's cached state, so it lands with the buffer it describes.

use smithay::{
    reexports::wayland_server::{
        Client, DataInit, DisplayHandle, New, Resource, Weak, backend::ClientId,
        protocol::wl_surface::WlSurface,
    },
    backend::renderer::utils::CommitCounter,
    wayland::{
        Dispatch2, GlobalDispatch2,
        compositor::{Cacheable, with_states},
    },
};

use crate::{
    Hyalo,
    protocols::gen_material::{
        nidara_material_manager_v1::{self, NidaraMaterialManagerV1},
        nidara_material_v1::{self, NidaraMaterialV1},
    },
};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Shape {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub radius: f64,
    pub exponent: f64,
    /// The whole glass's opacity in this shape over the plain backdrop (v2; 1 from add_shape).
    pub opacity: f64,
    /// What of the shape may show, same coordinates (v2): x, y, w, h. None = all of it.
    pub clip: Option<[f64; 4]>,
    /// A pointer spliced into one side (v3, a tooltip's or a menu's), same coordinates.
    pub pointer: Option<Pointer>,
}

/// A pointer from a shape's edge (v3): its base centred on `base`, `width` wide, to `tip`; a
/// circular tip of `tip_radius`, a concave join of `base_radius` where it meets the edge.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pointer {
    pub base: [f64; 2],
    pub tip: [f64; 2],
    pub width: f64,
    pub tip_radius: f64,
    pub base_radius: f64,
}

/// Refractive glass: the compositor paints the whole glass (src/render/glass_gl.rs, the last pass).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Glass {
    pub tint: [f64; 3],
    pub alpha_min: f64,
    pub alpha_max: f64,
    pub target_luminance: f64,
    pub refraction: f64,
    pub rim: f64,
    pub saturation: f64,
}

/// Where content of one ink group sits (v3), surface-local logical coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InkBox {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The ink measurement (v3): WCAG luminance thresholds, and the tint over a dark-ink shape.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ink {
    pub dark_above: f64,
    pub light_below: f64,
    pub tint: [f64; 3],
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MaterialState {
    pub shapes: Vec<Shape>,
    pub blur_size: f64,
    pub blur_passes: u32,
    pub glass: Option<Glass>,
    pub ink_boxes: Vec<InkBox>,
    pub ink: Option<Ink>,
}

impl Cacheable for MaterialState {
    fn commit(&mut self, _dh: &DisplayHandle) -> Self {
        self.clone()
    }
    fn merge_into(self, into: &mut Self, _dh: &DisplayHandle) {
        *into = self;
    }
}

/// What the renderer reads: the material a surface has right now, and a counter that moves
/// whenever it changes (the damage tracker redraws a glass whose counter moved).
#[derive(Debug, Clone, Default)]
pub struct Current {
    pub state: MaterialState,
    pub commit: CommitCounter,
    /// The ink groups whose content is dark now (the hysteresis' memory). A group no longer
    /// declared keeps its decision, as the client does: a panel reopened starts as it closed.
    pub dark_ink: std::collections::BTreeSet<u32>,
}

/// The surface's material object, for the ink event.
struct MaterialResource(std::sync::Mutex<Option<NidaraMaterialV1>>);

/// Groups the client has declared at most this many of are remembered; past it the memory
/// starts again (a shell does not declare thousands; a misbehaving client cannot grow it).
const MAX_INK_GROUPS: usize = 256;

/// The ink rule with its hysteresis: a group whose darkest point under its content is `darkest`
/// turns dark only above `dark_above`, and light again only below `light_below`. None: no change.
fn next_ink(dark: bool, darkest: f64, ink: &Ink) -> Option<bool> {
    if !dark && darkest > ink.dark_above {
        Some(true)
    } else if dark && darkest < ink.light_below {
        Some(false)
    } else {
        None
    }
}

/// A measurement came back (render/glass_gl.rs): the darkest WCAG luminance under each ink
/// group's boxes. Applies the hysteresis, tells the client what changed, and returns whether
/// the glass must be redrawn (a shape's tint follows its group's ink).
pub fn ink_measured(surface: &WlSurface, darkest: &[(u32, f32)]) -> bool {
    with_states(surface, |states| {
        let Some(current) = states.data_map.get::<std::sync::Mutex<Current>>() else { return false };
        let mut current = current.lock().unwrap();
        let Some(ink) = current.state.ink else { return false };
        let mut changed = Vec::new();
        for &(id, l) in darkest {
            if let Some(dark) = next_ink(current.dark_ink.contains(&id), l as f64, &ink) {
                changed.push((id, dark));
            }
        }
        if changed.is_empty() {
            return false;
        }
        if current.dark_ink.len() > MAX_INK_GROUPS {
            current.dark_ink.clear();
        }
        for &(id, dark) in &changed {
            if dark {
                current.dark_ink.insert(id);
            } else {
                current.dark_ink.remove(&id);
            }
        }
        current.commit.increment();
        drop(current);
        if let Some(res) = states.data_map.get::<MaterialResource>()
            && let Some(res) = res.0.lock().unwrap().as_ref()
            && res.version() >= 3
        {
            for (id, dark) in changed {
                res.ink(id, dark as u32);
            }
        }
        true
    })
}

/// Called after every surface commit: keeps `Current` in step with the committed state.
pub fn on_commit(surface: &WlSurface) {
    with_states(surface, |states| {
        if !states.cached_state.has::<MaterialState>() {
            return;
        }
        let committed = states.cached_state.get::<MaterialState>().current().clone();
        let current = states.data_map.get_or_insert(|| std::sync::Mutex::new(Current::default()));
        let mut current = current.lock().unwrap();
        if committed.ink.is_none() {
            // clear_ink: every group is light again, on both ends.
            current.dark_ink.clear();
        }
        if current.state != committed {
            current.state = committed;
            current.commit.increment();
        }
    });
}

/// The material a surface has right now, if it has one worth resolving.
pub fn current(surface: &WlSurface) -> Option<Current> {
    with_states(surface, |states| {
        let current = states.data_map.get::<std::sync::Mutex<Current>>()?.lock().unwrap().clone();
        (!current.state.shapes.is_empty() && current.state.blur_passes > 0).then_some(current)
    })
}

pub struct MaterialGlobal;
pub struct MaterialData(Weak<WlSurface>);

pub fn init(dh: &DisplayHandle) {
    dh.create_global::<Hyalo, NidaraMaterialManagerV1, _>(3, MaterialGlobal);
}

impl GlobalDispatch2<NidaraMaterialManagerV1, Hyalo> for MaterialGlobal {
    fn bind(
        &self,
        _state: &mut Hyalo,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<NidaraMaterialManagerV1>,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        data_init.init(resource, MaterialGlobal);
    }

    /// Not for a sandboxed client (sandbox.rs).
    fn can_view(&self, client: &Client) -> bool {
        crate::sandbox::unrestricted(client)
    }
}

impl Dispatch2<NidaraMaterialManagerV1, Hyalo> for MaterialGlobal {
    fn request(
        &self,
        _state: &mut Hyalo,
        _client: &Client,
        _resource: &NidaraMaterialManagerV1,
        request: nidara_material_manager_v1::Request,
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        if let nidara_material_manager_v1::Request::GetMaterial { id, surface } = request {
            let res = data_init.init(id, MaterialData(surface.downgrade()));
            with_states(&surface, |states| {
                let slot = states.data_map.get_or_insert_threadsafe(|| MaterialResource(Default::default()));
                *slot.0.lock().unwrap() = Some(res);
            });
        }
    }
}

impl MaterialData {
    fn pending<R>(&self, f: impl FnOnce(&mut MaterialState) -> R) -> Option<R> {
        let surface = self.0.upgrade().ok()?;
        Some(with_states(&surface, |states| f(states.cached_state.get::<MaterialState>().pending())))
    }
}

impl Dispatch2<NidaraMaterialV1, Hyalo> for MaterialData {
    fn request(
        &self,
        _state: &mut Hyalo,
        _client: &Client,
        _resource: &NidaraMaterialV1,
        request: nidara_material_v1::Request,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, Hyalo>,
    ) {
        use nidara_material_v1::Request;
        match request {
            Request::ClearShapes => {
                self.pending(|m| {
                    m.shapes.clear();
                    m.ink_boxes.clear();
                });
            }
            Request::AddShape { x, y, width, height, corner_radius, exponent } => {
                self.pending(|m| {
                    m.shapes.push(Shape {
                        x, y, w: width, h: height, radius: corner_radius, exponent, opacity: 1.0, clip: None,
                        pointer: None,
                    })
                });
            }
            Request::AddShapeClipped {
                x, y, width, height, corner_radius, exponent, opacity,
                clip_x, clip_y, clip_width, clip_height,
            } => {
                let opacity = opacity.clamp(0.0, 1.0);
                let clip = (clip_width > 0.0 && clip_height > 0.0).then_some([clip_x, clip_y, clip_width, clip_height]);
                // A shape faded out entirely, or clipped away, is no shape: nothing to blur for it.
                let shows = clip.is_none_or(|c| {
                    c[0] < x + width && x < c[0] + c[2] && c[1] < y + height && y < c[1] + c[3]
                });
                if opacity > 0.0 && shows {
                    self.pending(|m| {
                        m.shapes.push(Shape {
                            x, y, w: width, h: height, radius: corner_radius, exponent, opacity, clip, pointer: None,
                        })
                    });
                }
            }
            Request::AddShapePointed {
                x, y, width, height, corner_radius, exponent, opacity,
                clip_x, clip_y, clip_width, clip_height,
                base_x, base_y, tip_x, tip_y, pointer_width, tip_radius, base_radius,
            } => {
                let opacity = opacity.clamp(0.0, 1.0);
                let clip = (clip_width > 0.0 && clip_height > 0.0).then_some([clip_x, clip_y, clip_width, clip_height]);
                let pointer = (pointer_width > 0.0 && (tip_x - base_x).hypot(tip_y - base_y) > 0.0).then_some(Pointer {
                    base: [base_x, base_y],
                    tip: [tip_x, tip_y],
                    width: pointer_width,
                    tip_radius: tip_radius.max(0.0),
                    base_radius: base_radius.max(0.0),
                });
                if opacity > 0.0 {
                    self.pending(|m| {
                        m.shapes.push(Shape {
                            x, y, w: width, h: height, radius: corner_radius, exponent, opacity, clip, pointer,
                        })
                    });
                }
            }
            Request::SetBlur { size, passes } => {
                self.pending(|m| {
                    m.blur_size = size;
                    m.blur_passes = passes.min(8);
                });
            }
            Request::SetGlass {
                tint_r, tint_g, tint_b, alpha_min, alpha_max, target_luminance, refraction, rim, saturation,
            } => {
                self.pending(|m| {
                    m.glass = Some(Glass {
                        tint: [tint_r, tint_g, tint_b],
                        alpha_min,
                        alpha_max,
                        target_luminance,
                        refraction,
                        rim,
                        saturation,
                    })
                });
            }
            Request::ClearGlass => {
                self.pending(|m| m.glass = None);
            }
            Request::AddInkBox { id, x, y, width, height } => {
                if width > 0.0 && height > 0.0 {
                    self.pending(|m| m.ink_boxes.push(InkBox { id, x, y, w: width, h: height }));
                }
            }
            Request::SetInk { dark_above, light_below, tint_r, tint_g, tint_b } => {
                self.pending(|m| {
                    m.ink = Some(Ink {
                        dark_above,
                        light_below: light_below.min(dark_above),
                        tint: [tint_r, tint_g, tint_b],
                    })
                });
            }
            Request::ClearInk => {
                self.pending(|m| m.ink = None);
            }
            Request::Destroy => {
                self.pending(|m| *m = MaterialState::default());
            }
        }
    }

    fn destroyed(&self, _state: &mut Hyalo, _client: ClientId, _resource: &NidaraMaterialV1) {}
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ink_turns_only_past_its_thresholds() {
        let ink = Ink { dark_above: 0.8, light_below: 0.65, tint: [1.0; 3] };
        assert_eq!(next_ink(false, 0.95, &ink), Some(true), "all white under the text: dark");
        assert_eq!(next_ink(false, 0.79, &ink), None, "one point below the threshold keeps it light");
        assert_eq!(next_ink(true, 0.70, &ink), None, "between the two: it stays as it is (hysteresis)");
        assert_eq!(next_ink(false, 0.70, &ink), None, "...whichever way it was");
        assert_eq!(next_ink(true, 0.60, &ink), Some(false), "below the lower one: light again");
        assert_eq!(next_ink(true, 0.95, &ink), None, "already dark: no event");
    }
}
