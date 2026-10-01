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

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MaterialState {
    pub shapes: Vec<Shape>,
    pub blur_size: f64,
    pub blur_passes: u32,
    pub glass: Option<Glass>,
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
    dh.create_global::<Hyalo, NidaraMaterialManagerV1, _>(1, MaterialGlobal);
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
            data_init.init(id, MaterialData(surface.downgrade()));
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
                self.pending(|m| m.shapes.clear());
            }
            Request::AddShape { x, y, width, height, corner_radius, exponent } => {
                self.pending(|m| {
                    m.shapes.push(Shape { x, y, w: width, h: height, radius: corner_radius, exponent })
                });
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
            Request::Destroy => {
                self.pending(|m| *m = MaterialState::default());
            }
        }
    }

    fn destroyed(&self, _state: &mut Hyalo, _client: ClientId, _resource: &NidaraMaterialV1) {}
}
