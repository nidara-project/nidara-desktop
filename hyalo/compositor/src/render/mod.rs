//! What an output shows, as a list of render elements, front to back — the same list for
//! every backend; each backend hands it to Smithay's damage tracker (winit) or DRM
//! compositor (tty), which redraw only what changed and scan buffers out directly when
//! nothing needs compositing over them.
//!
//! The order is ours, not `Space`'s: Smithay's stock `space::render_output` sorts layer
//! surfaces by insertion, not by layer (an Overlay mapped before a Top drew below it — found
//! in the prototype), and a surface's glass has to go right below that surface.

pub mod controls;
pub mod glass;
pub mod glass_gl;
pub mod scrim;
pub mod window;

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
    utils::{Logical, Physical, Point, Rectangle, Scale},
    wayland::{compositor::with_states, shell::wlr_layer::Layer},
};

pub use glass::GlassElement;
pub use scrim::ScrimElement;

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

    /// The GL renderer underneath (the one that renders, on a multi-GPU setup).
    fn gles(&mut self) -> &mut GlesRenderer;
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

    fn gles(&mut self) -> &mut GlesRenderer {
        self
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

    fn gles(&mut self) -> &mut GlesRenderer {
        self.as_mut()
    }
}

smithay::backend::renderer::element::render_elements! {
    pub OutputElement<R> where R: HyaloRenderer;
    Surface=WaylandSurfaceRenderElement<R>,
    Rounded=window::RoundedElement<R>,
    Glass=GlassElement,
    Scrim=ScrimElement,
    Controls=controls::ControlsElement,
    Cursor=MemoryRenderBufferRenderElement<R>,
}

impl<R: HyaloRenderer> std::fmt::Debug for OutputElement<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Surface(e) => f.debug_tuple("Surface").field(e).finish(),
            Self::Rounded(e) => f.debug_tuple("Rounded").field(e).finish(),
            Self::Glass(e) => f.debug_tuple("Glass").field(e).finish(),
            Self::Scrim(e) => f.debug_tuple("Scrim").field(e).finish(),
            Self::Controls(e) => f.debug_tuple("Controls").field(e).finish(),
            Self::Cursor(e) => f.debug_tuple("Cursor").field(e).finish(),
            Self::_GenericCatcher(_) => f.write_str("_GenericCatcher"),
        }
    }
}

/// Behind everything: shown only where nothing covers the output (no wallpaper yet).
pub const CLEAR_COLOR: Color32F = Color32F::new(0.06, 0.06, 0.07, 1.0);

/// A surface tree and its popups, front to back, each with its glass right below it, and the
/// shadow under that glass below the glass — unless `floor` is given: the shell's chrome
/// casts ONE floor of shadows under all of it (`chrome_scrims`, drawn by the caller), so the
/// Control Center's never falls on the dock, which sits in the same layer, and each glass
/// measures its backdrop with the whole floor divided out — not only its own shadow, or the
/// Control Center's would split the dock's backdrop and switch the dock's on (owner,
/// 2026-10-02: "the dock's shadow only comes on when the Control Center opens").
fn push_surface<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    renderer: &mut R,
    surface: &WlSurface,
    location: Point<i32, Physical>,
    scale: Scale<f64>,
    output_size: smithay::utils::Size<i32, Physical>,
    floor: Option<&[scrim::ScrimPx]>,
) {
    let now = std::time::Instant::now();
    let mut layer = |out: &mut Vec<OutputElement<R>>, s: &WlSurface, loc: Point<i32, Physical>, kind: Kind| {
        out.extend(render_elements_from_surface_tree(renderer, s, loc, scale, 1.0, kind));
        match floor {
            Some(floor) => {
                out.extend(GlassElement::for_surface(s, loc, scale, output_size, floor).into_iter().map(OutputElement::Glass));
            }
            None => {
                let scrims = scrim::scrims_for(s, loc, scale, now);
                out.extend(GlassElement::for_surface(s, loc, scale, output_size, &scrims).into_iter().map(OutputElement::Glass));
                let e = with_states(s, |states| ScrimElement::new(&states.data_map, scrims, output_size));
                out.extend(e.map(OutputElement::Scrim));
            }
        }
    };
    for (popup, offset) in PopupManager::popups_for_surface(surface) {
        let offset = (offset - popup.geometry().loc).to_f64().to_physical(scale).to_i32_round();
        layer(out, popup.wl_surface(), location + offset, Kind::Unspecified);
    }
    layer(out, surface, location, Kind::ScanoutCandidate);
}

/// One surface tree with its glass right below it and that glass's shadow below the glass —
/// push_surface's own step, without the popups (render/window.rs handles a window's).
pub(super) fn push_tree<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    renderer: &mut R,
    surface: &WlSurface,
    location: Point<i32, Physical>,
    scale: Scale<f64>,
    output_size: smithay::utils::Size<i32, Physical>,
    kind: Kind,
) {
    out.extend(render_elements_from_surface_tree(renderer, surface, location, scale, 1.0, kind));
    push_material(out, surface, location, scale, output_size);
}

/// A surface's declared glass (`nidara-material-v1`) and the shadow under it.
pub(super) fn push_material<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    surface: &WlSurface,
    location: Point<i32, Physical>,
    scale: Scale<f64>,
    output_size: smithay::utils::Size<i32, Physical>,
) {
    let scrims = scrim::scrims_for(surface, location, scale, std::time::Instant::now());
    out.extend(GlassElement::for_surface(surface, location, scale, output_size, &scrims).into_iter().map(OutputElement::Glass));
    let e = with_states(surface, |states| ScrimElement::new(&states.data_map, scrims, output_size));
    out.extend(e.map(OutputElement::Scrim));
}

/// The shadows a surface tree and its popups cast, for the chrome's floor.
fn chrome_scrims(surface: &WlSurface, location: Point<i32, Physical>, scale: Scale<f64>, now: std::time::Instant) -> Vec<scrim::ScrimPx> {
    let mut out = Vec::new();
    for (popup, offset) in PopupManager::popups_for_surface(surface) {
        let offset = (offset - popup.geometry().loc).to_f64().to_physical(scale).to_i32_round();
        out.extend(scrim::scrims_for(popup.wl_surface(), location + offset, scale, now));
    }
    out.extend(scrim::scrims_for(surface, location, scale, now));
    out
}

/// What a frame is made from: the parts of the state rendering reads, borrowed apart from the
/// backend (which renders them).
pub struct Scene<'a> {
    pub space: &'a Space<Window>,
    pub wm: &'a crate::wm::Wm,
    pub pointer: Point<f64, Logical>,
    pub cursor_status: &'a CursorImageStatus,
    pub lock: &'a crate::lock::LockState,
    /// How windows are drawn: corners, the blur behind them (render/window.rs).
    pub windows: &'a crate::config::WindowsConfig,
}

impl<'a> Scene<'a> {
    pub fn new(
        space: &'a Space<Window>,
        wm: &'a crate::wm::Wm,
        seat: &Seat<Hyalo>,
        cursor_status: &'a CursorImageStatus,
        lock: &'a crate::lock::LockState,
        windows: &'a crate::config::WindowsConfig,
    ) -> Self {
        Self { space, wm, pointer: seat.get_pointer().unwrap().current_location(), cursor_status, lock, windows }
    }
}

/// The windows shown on `output`, front to back, split where top layers go between them: a
/// fullscreen window covers the bar, so it — and anything stacked above it, like a special
/// workspace — is drawn over the top layers; every other window under them.
pub fn windows_front_to_back(space: &Space<Window>, wm: &crate::wm::Wm, output: &Output) -> (Vec<Window>, Vec<Window>) {
    let all: Vec<Window> = space.elements_for_output(output).rev().cloned().collect();
    let fullscreen = all.iter().position(|w| {
        wm.by_window(w).is_some_and(|m| m.fullscreen == crate::wm::Fullscreen::Fullscreen)
    });
    match fullscreen {
        Some(i) => {
            let mut above = all;
            let below = above.split_off(i + 1);
            (above, below)
        }
        None => (Vec::new(), all),
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

    if let Some(image) = cursor.filter(|_| !state.wm.cursor_hidden) {
        push_cursor(&mut out, state, renderer, output_geo.loc, scale, image);
    }

    let map = layer_map_for_output(output);
    let layer_loc = |l: &smithay::desktop::LayerSurface| {
        crate::shell::layer::layer_geometry(&map, l).unwrap_or_default().loc.to_f64().to_physical_precise_round(scale)
    };
    // Locked (lock.rs): the lock surface over the wallpaper, and nothing of the session — its
    // windows and the shell's layers are not drawn at all, not even under an opaque sheet. A new
    // lock shows the session until its lock surface here has drawn (`draws_locked`).
    if state.lock.draws_locked(output) {
        state.lock.note_rendered(output);
        if let Some(surface) = state.lock.surface_for(output) {
            push_surface(&mut out, renderer, surface, Point::from((0, 0)), scale, output_size, None);
        }
        for l in map.layers_on(Layer::Background).rev() {
            push_surface(&mut out, renderer, l.wl_surface(), layer_loc(l), scale, output_size, None);
        }
        return out;
    }
    let (above, below) = windows_front_to_back(state.space, state.wm, output);
    let push_windows = |out: &mut Vec<OutputElement<R>>, renderer: &mut R, windows: &[Window]| {
        for w in windows {
            let Some(at) = state.space.element_location(w) else { continue };
            let loc = (at - w.geometry().loc - output_geo.loc).to_f64().to_physical_precise_round(scale);
            let geo = Rectangle::new(at - output_geo.loc, w.geometry().size).to_f64().to_physical_precise_round(scale);
            let managed = state.wm.by_window(w);
            let fullscreen = managed.is_some_and(|m| m.fullscreen == crate::wm::Fullscreen::Fullscreen);
            let look = window::look(
                w,
                fullscreen,
                managed.is_none_or(|m| m.rounded),
                managed.is_none_or(|m| m.backdrop),
                state.windows,
            );
            // The controls over its header (protocols/window_controls.rs): never on a
            // fullscreen window.
            let controls = managed.filter(|_| !fullscreen).and_then(|m| {
                let r = crate::protocols::window_controls::window_rect(w)?;
                let origin = (at - w.geometry().loc - output_geo.loc).to_f64();
                let rect = Rectangle::new(origin + r.loc, r.size).to_physical(scale);
                let buttons = crate::protocols::window_controls::order(state.windows.controls.side);
                let hover = state.wm.controls_hover.filter(|h| h.window == m.id);
                let controls = controls::Controls {
                    buttons,
                    enabled: buttons.map(|b| crate::protocols::window_controls::enabled(w, b)),
                    hover: hover.and_then(|h| buttons.iter().position(|b| *b == h.button)),
                    pressed: hover.is_some_and(|h| h.pressed),
                    active: state.wm.focused == Some(m.id),
                };
                Some((rect, controls))
            });
            window::push(out, renderer, w, look, loc, geo, scale, output_size, state.windows, controls);
        }
    };
    // The shadows the shell's chrome (top and overlay layers) casts: one floor under all of
    // it, combined by their maximum like one surface's (two surfaces' shadows that overlap —
    // the Control Center's strip and the dock's band — never darken the corner twice).
    let now = std::time::Instant::now();
    let floor: Vec<scrim::ScrimPx> = [Layer::Overlay, Layer::Top]
        .into_iter()
        .flat_map(|layer| map.layers_on(layer).map(|l| chrome_scrims(l.wl_surface(), layer_loc(l), scale, now)).collect::<Vec<_>>())
        .flatten()
        .collect();
    for l in map.layers_on(Layer::Overlay).rev() {
        push_surface(&mut out, renderer, l.wl_surface(), layer_loc(l), scale, output_size, Some(&floor));
    }
    push_windows(&mut out, renderer, &above);
    for l in map.layers_on(Layer::Top).rev() {
        push_surface(&mut out, renderer, l.wl_surface(), layer_loc(l), scale, output_size, Some(&floor));
    }
    out.extend(ScrimElement::new(output.user_data(), floor, output_size).map(OutputElement::Scrim));
    push_windows(&mut out, renderer, &below);
    for layer in [Layer::Bottom, Layer::Background] {
        for l in map.layers_on(layer).rev() {
            push_surface(&mut out, renderer, l.wl_surface(), layer_loc(l), scale, output_size, None);
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
