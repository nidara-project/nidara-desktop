//! What an output shows, as a list of render elements, front to back — the same list for
//! every backend; each backend hands it to Smithay's damage tracker (winit) or DRM
//! compositor (tty), which redraw only what changed and scan buffers out directly when
//! nothing needs compositing over them.
//!
//! The order is ours, not `Space`'s: Smithay's stock `space::render_output` sorts layer
//! surfaces by insertion, not by layer (an Overlay mapped before a Top drew below it — found
//! in the prototype), and a surface's glass has to go right below that surface.

pub mod glass;
pub mod glass_gl;

use smithay::{
    backend::{
        drm::DrmDeviceFd,
        renderer::{
            Color32F, ImportAll, ImportMem, Renderer, RendererSuper,
            element::{
                Kind,
                memory::MemoryRenderBufferRenderElement,
                surface::{WaylandSurfaceRenderElement, render_elements_from_surface_tree},
            },
            gles::{GlesError, GlesFrame, GlesRenderer},
            multigpu::{self, MultiRenderer, gbm::GbmGlesBackend},
        },
    },
    desktop::{PopupManager, Space, Window, layer_map_for_output},
    input::Seat,
    input::pointer::{CursorImageAttributes, CursorImageStatus},
    output::Output,
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Logical, Physical, Point, Scale},
    wayland::{compositor::with_states, seat::WaylandFocus, shell::wlr_layer::Layer},
};

pub use glass::GlassElement;

use crate::state::Hyalo;

/// The renderer of the tty backend: one GL renderer per GPU, copying between them when the
/// GPU that renders is not the one that scans out.
pub type UdevRenderer<'a> =
    MultiRenderer<'a, 'a, GbmGlesBackend<GlesRenderer, DrmDeviceFd>, GbmGlesBackend<GlesRenderer, DrmDeviceFd>>;

/// What every renderer we draw with can do: Smithay's usual imports, plus reaching the GL
/// frame underneath, which the glass draws into directly.
pub trait HyaloRenderer: Renderer<TextureId = Self::HyaloTexture> + ImportAll + ImportMem {
    /// Named here so the bounds travel with the trait (a `where` on the trait would not).
    type HyaloTexture: smithay::backend::renderer::Texture + Clone + Send + 'static;

    fn gles_frame<'a, 'frame, 'buffer>(frame: &'a mut Self::Frame<'frame, 'buffer>) -> &'a mut GlesFrame<'frame, 'buffer>
    where
        'buffer: 'frame,
        Self: 'frame;

    fn from_gles_error(err: GlesError) -> Self::Error;
}

impl HyaloRenderer for GlesRenderer {
    type HyaloTexture = smithay::backend::renderer::gles::GlesTexture;
    fn gles_frame<'a, 'frame, 'buffer>(frame: &'a mut GlesFrame<'frame, 'buffer>) -> &'a mut GlesFrame<'frame, 'buffer>
    where
        'buffer: 'frame,
    {
        frame
    }

    fn from_gles_error(err: GlesError) -> GlesError {
        err
    }
}

impl<'r> HyaloRenderer for UdevRenderer<'r> {
    type HyaloTexture = smithay::backend::renderer::multigpu::MultiTexture;
    fn gles_frame<'a, 'frame, 'buffer>(
        frame: &'a mut <Self as RendererSuper>::Frame<'frame, 'buffer>,
    ) -> &'a mut GlesFrame<'frame, 'buffer>
    where
        'buffer: 'frame,
        Self: 'frame,
    {
        frame.as_mut()
    }

    fn from_gles_error(err: GlesError) -> Self::Error {
        multigpu::Error::Render(err)
    }
}

smithay::backend::renderer::element::render_elements! {
    pub OutputElement<R> where R: HyaloRenderer;
    Surface=WaylandSurfaceRenderElement<R>,
    Glass=GlassElement,
    Cursor=MemoryRenderBufferRenderElement<R>,
}

impl<R: HyaloRenderer> std::fmt::Debug for OutputElement<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Surface(e) => f.debug_tuple("Surface").field(e).finish(),
            Self::Glass(e) => f.debug_tuple("Glass").field(e).finish(),
            Self::Cursor(e) => f.debug_tuple("Cursor").field(e).finish(),
            Self::_GenericCatcher(_) => f.write_str("_GenericCatcher"),
        }
    }
}

/// Behind everything: shown only where nothing covers the output (no wallpaper yet).
pub const CLEAR_COLOR: Color32F = Color32F::new(0.06, 0.06, 0.07, 1.0);

/// A surface tree and its popups, front to back, each with its glass right below it.
fn push_surface<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    renderer: &mut R,
    surface: &WlSurface,
    location: Point<i32, Physical>,
    scale: Scale<f64>,
    output_size: smithay::utils::Size<i32, Physical>,
) {
    for (popup, offset) in PopupManager::popups_for_surface(surface) {
        let offset = (offset - popup.geometry().loc).to_f64().to_physical(scale).to_i32_round();
        let loc = location + offset;
        out.extend(render_elements_from_surface_tree(renderer, popup.wl_surface(), loc, scale, 1.0, Kind::Unspecified));
        out.extend(GlassElement::for_surface(popup.wl_surface(), loc, scale, output_size).into_iter().map(OutputElement::Glass));
    }
    out.extend(render_elements_from_surface_tree(renderer, surface, location, scale, 1.0, Kind::ScanoutCandidate));
    out.extend(GlassElement::for_surface(surface, location, scale, output_size).into_iter().map(OutputElement::Glass));
}

/// What a frame is made from: the parts of the state rendering reads, borrowed apart from the
/// backend (which renders them).
pub struct Scene<'a> {
    pub space: &'a Space<Window>,
    pub pointer: Point<f64, Logical>,
    pub cursor_status: &'a CursorImageStatus,
}

impl<'a> Scene<'a> {
    pub fn new(space: &'a Space<Window>, seat: &Seat<Hyalo>, cursor_status: &'a CursorImageStatus) -> Self {
        Self { space, pointer: seat.get_pointer().unwrap().current_location(), cursor_status }
    }
}

/// Everything on `output`, front to back.
pub fn output_elements<R: HyaloRenderer>(
    state: &Scene<'_>,
    renderer: &mut R,
    output: &Output,
    cursor: Option<&crate::cursor::CursorImage>,
) -> Vec<OutputElement<R>>
{
    let mut out = Vec::new();
    let Some(output_geo) = state.space.output_geometry(output) else { return out };
    let scale = Scale::from(output.current_scale().fractional_scale());
    let output_size = output_geo.size.to_f64().to_physical_precise_round(scale);

    if let Some(image) = cursor {
        push_cursor(&mut out, state, renderer, output_geo.loc, scale, image);
    }

    let map = layer_map_for_output(output);
    let layer_loc = |l: &smithay::desktop::LayerSurface| {
        map.layer_geometry(l).unwrap_or_default().loc.to_f64().to_physical_precise_round(scale)
    };
    for layer in [Layer::Overlay, Layer::Top] {
        for l in map.layers_on(layer).rev() {
            push_surface(&mut out, renderer, l.wl_surface(), layer_loc(l), scale, output_size);
        }
    }
    for window in state.space.elements_for_output(output).rev() {
        let Some(loc) = state.space.element_location(window) else { continue };
        let Some(surface) = window.wl_surface() else { continue };
        let loc = (loc - window.geometry().loc - output_geo.loc).to_f64().to_physical_precise_round(scale);
        push_surface(&mut out, renderer, &surface, loc, scale, output_size);
    }
    for layer in [Layer::Bottom, Layer::Background] {
        for l in map.layers_on(layer).rev() {
            push_surface(&mut out, renderer, l.wl_surface(), layer_loc(l), scale, output_size);
        }
    }
    out
}

/// The pointer: the client's own cursor surface, or our themed one.
fn push_cursor<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    state: &Scene<'_>,
    renderer: &mut R,
    output_loc: Point<i32, Logical>,
    scale: Scale<f64>,
    (themed, hotspot): &crate::cursor::CursorImage,
) {
    let pointer = state.pointer - output_loc.to_f64();
    match &state.cursor_status {
        CursorImageStatus::Hidden => {}
        CursorImageStatus::Surface(surface) => {
            let hotspot = with_states(surface, |states| {
                states
                    .data_map
                    .get::<std::sync::Mutex<CursorImageAttributes>>()
                    .map(|a| a.lock().unwrap().hotspot)
                    .unwrap_or_default()
            });
            let loc = (pointer - hotspot.to_f64()).to_physical(scale).to_i32_round();
            out.extend(render_elements_from_surface_tree(renderer, surface, loc, scale, 1.0, Kind::Cursor));
        }
        CursorImageStatus::Named(_) => {
            let loc = (pointer.to_physical(scale) - hotspot.to_f64()).to_i32_round::<i32>();
            if let Ok(e) =
                MemoryRenderBufferRenderElement::from_buffer(renderer, loc.to_f64(), themed, None, None, None, Kind::Cursor)
            {
                out.push(OutputElement::Cursor(e));
            }
        }
    }
}
