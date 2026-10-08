//! What an output shows, as a list of render elements, front to back — the same list for
//! every backend; each backend hands it to Smithay's damage tracker (winit) or DRM
//! compositor (tty), which redraw only what changed and scan buffers out directly when
//! nothing needs compositing over them.
//!
//! The order is ours, not `Space`'s: Smithay's stock `space::render_output` sorts layer
//! surfaces by insertion, not by layer (an Overlay mapped before a Top drew below it — found
//! in the prototype), and a surface's glass has to go right below that surface.

pub mod controls;
pub mod decor;
pub mod drawn;
pub mod glass;
pub mod glass_gl;
pub mod scrim;
pub mod snapshot;
pub mod stats;
pub mod timing;
pub mod title_bar;
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

    /// The GL texture `surface`'s buffer was imported as for this renderer (the GPU that
    /// renders), if it has been: what Hyalo's title bar samples (title_bar.rs).
    fn surface_texture(&mut self, surface: &WlSurface) -> Option<smithay::backend::renderer::gles::GlesTexture>;
}

fn surface_state<T>(surface: &WlSurface, f: impl FnOnce(&smithay::backend::renderer::utils::RendererSurfaceState) -> Option<T>) -> Option<T> {
    smithay::wayland::compositor::with_states(surface, |states| {
        let data = states.data_map.get::<smithay::backend::renderer::utils::RendererSurfaceStateUserData>()?;
        f(&data.lock().unwrap())
    })
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

    fn surface_texture(&mut self, surface: &WlSurface) -> Option<smithay::backend::renderer::gles::GlesTexture> {
        let id = self.context_id();
        surface_state(surface, |s| s.texture::<smithay::backend::renderer::gles::GlesTexture>(id).cloned())
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

    fn surface_texture(&mut self, surface: &WlSurface) -> Option<smithay::backend::renderer::gles::GlesTexture> {
        let multi = self.context_id();
        let gles = self.as_mut().context_id();
        surface_state(surface, |s| {
            s.texture::<multigpu::MultiTexture>(multi)?.get::<GbmGlesBackend<GlesRenderer, DrmDeviceFd>>(&gles)
        })
    }
}

smithay::backend::renderer::element::render_elements! {
    pub OutputElement<R> where R: HyaloRenderer;
    Surface=WaylandSurfaceRenderElement<R>,
    Drawn=drawn::Clipped<WaylandSurfaceRenderElement<R>>,
    DrawnChange=drawn::DrawnChange,
    Scaled=window::AtScale<WaylandSurfaceRenderElement<R>>,
    Rounded=window::RoundedElement<R>,
    Glass=GlassElement,
    Scrim=ScrimElement,
    Controls=controls::ControlsElement,
    TitleBar=title_bar::TitleBarElement,
    Decor=decor::DecorElement,
    Snapshot=snapshot::SnapshotElement,
    Cursor=MemoryRenderBufferRenderElement<R>,
    Debug=smithay::backend::renderer::element::solid::SolidColorRenderElement,
}

impl<R: HyaloRenderer> std::fmt::Debug for OutputElement<R> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Surface(e) => f.debug_tuple("Surface").field(e).finish(),
            Self::Drawn(e) => f.debug_tuple("Drawn").field(e).finish(),
            Self::DrawnChange(e) => f.debug_tuple("DrawnChange").field(e).finish(),
            Self::Scaled(e) => f.debug_tuple("Scaled").field(e).finish(),
            Self::Rounded(e) => f.debug_tuple("Rounded").field(e).finish(),
            Self::Glass(e) => f.debug_tuple("Glass").field(e).finish(),
            Self::Scrim(e) => f.debug_tuple("Scrim").field(e).finish(),
            Self::Controls(e) => f.debug_tuple("Controls").field(e).finish(),
            Self::TitleBar(e) => f.debug_tuple("TitleBar").field(e).finish(),
            Self::Decor(e) => f.debug_tuple("Decor").field(e).finish(),
            Self::Snapshot(e) => f.debug_tuple("Snapshot").field(e).finish(),
            Self::Cursor(e) => f.debug_tuple("Cursor").field(e).finish(),
            Self::Debug(e) => f.debug_tuple("Debug").field(e).finish(),
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
#[allow(clippy::too_many_arguments)]
fn push_surface<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    renderer: &mut R,
    surface: &WlSurface,
    location: Point<i32, Physical>,
    scale: Scale<f64>,
    output_size: smithay::utils::Size<i32, Physical>,
    floor: Option<&[scrim::ScrimPx]>,
    when: std::time::Instant,
) {
    let mut layer = |out: &mut Vec<OutputElement<R>>, s: &WlSurface, loc: Point<i32, Physical>, kind: Kind| {
        let elements: Vec<WaylandSurfaceRenderElement<R>> = render_elements_from_surface_tree(renderer, s, loc, scale, 1.0, kind);
        // A surface that declared where it draws (#761) is drawn only there, and repainted where
        // that changed.
        match crate::protocols::material::drawn(s) {
            None => out.extend(elements.into_iter().map(OutputElement::Surface)),
            Some(d) => {
                match &d.rects {
                    None => out.extend(elements.into_iter().map(OutputElement::Surface)),
                    Some(rects) => {
                        let region = drawn::region_on_output(rects, loc, scale);
                        out.extend(elements.into_iter().map(|inner| OutputElement::Drawn(drawn::Clipped { inner, region: region.clone() })));
                    }
                }
                let tree = smithay::desktop::utils::bbox_from_surface_tree(s, (0, 0));
                out.push(OutputElement::DrawnChange(drawn::DrawnChange::new(d.id, d.changes, tree, loc, scale)));
            }
        }
        match floor {
            Some(floor) => {
                out.extend(GlassElement::for_surface(s, loc, scale, output_size, floor).into_iter().map(OutputElement::Glass));
            }
            None => {
                let scrims = scrim::scrims_for(s, loc, scale, when);
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
/// push_surface's own step, without the popups (render/window.rs handles a window's). Its
/// surfaces are sized at `scale`, which is not the output's while a window shrinks into the
/// dock (`window::AtScale`).
#[allow(clippy::too_many_arguments)]
pub(super) fn push_tree<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    renderer: &mut R,
    surface: &WlSurface,
    location: Point<i32, Physical>,
    scale: Scale<f64>,
    output_size: smithay::utils::Size<i32, Physical>,
    kind: Kind,
    when: std::time::Instant,
) {
    let elements: Vec<WaylandSurfaceRenderElement<R>> = render_elements_from_surface_tree(renderer, surface, location, scale, 1.0, kind);
    out.extend(elements.into_iter().map(|inner| OutputElement::Scaled(window::AtScale { inner, scale })));
    push_material(out, surface, location, scale, output_size, when);
}

/// A surface's declared glass (`nidara-material-v1`) and the shadow under it, as it is `when`.
pub(super) fn push_material<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    surface: &WlSurface,
    location: Point<i32, Physical>,
    scale: Scale<f64>,
    output_size: smithay::utils::Size<i32, Physical>,
    when: std::time::Instant,
) {
    let scrims = scrim::scrims_for(surface, location, scale, when);
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
    /// The moment the frame shows: what Hyalo's own animations are drawn at (render/timing.rs).
    pub when: std::time::Instant,
}

impl<'a> Scene<'a> {
    pub fn new(
        space: &'a Space<Window>,
        wm: &'a crate::wm::Wm,
        seat: &Seat<Hyalo>,
        cursor_status: &'a CursorImageStatus,
        lock: &'a crate::lock::LockState,
        windows: &'a crate::config::WindowsConfig,
        when: std::time::Instant,
    ) -> Self {
        Self { space, wm, pointer: seat.get_pointer().unwrap().current_location(), cursor_status, lock, windows, when }
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
            push_surface(&mut out, renderer, surface, Point::from((0, 0)), scale, output_size, None, state.when);
        }
        for l in map.layers_on(Layer::Background).rev() {
            push_surface(&mut out, renderer, l.wl_surface(), layer_loc(l), scale, output_size, None, state.when);
        }
        return with_overlay(out, output);
    }
    let (above, below) = windows_front_to_back(state.space, state.wm, output);
    // Hyalo's own animations, as they are when this frame shows (render/timing.rs).
    let now = state.when;
    // A window shrinking into the dock or growing back out of it (wm/minimize.rs): where its
    // whole box is drawn now, scaled. `None` = where it is, as it is.
    let placement = |m: &crate::wm::Managed| state.wm.placement(m, now);
    // Going to another workspace (wm/motion.rs `Slide`): its windows and the ones left behind
    // drawn moved sideways by a share of the output's width — not a pinned one.
    let slide = state.wm.slide(&output.name(), now);
    let slid = |m: &crate::wm::Managed| -> Option<crate::wm::minimize::Placement> {
        let (s, p) = slide?;
        let shift = s.shift(m.workspace, p).filter(|_| !m.pinned)?;
        let dx = shift * output_geo.size.w as f64;
        Some(crate::wm::minimize::Placement { origin: m.frame().loc.to_f64() + Point::from((dx, 0.0)), scale: 1.0 })
    };
    let push_windows = |out: &mut Vec<OutputElement<R>>, renderer: &mut R, windows: &[Window]| {
        for w in windows {
            let managed = state.wm.by_window(w);
            let place = managed.and_then(placement).or_else(|| managed.and_then(slid));
            // Opening (wm/motion.rs): a picture of it as it is now, scaled about its middle
            // and faded. If the picture cannot be taken, the window as it is.
            if let Some(m) = managed.filter(|m| placement(m).is_none())
                && let Some(look) = state.wm.opening(m.id, now)
            {
                match snapshot::take(renderer.gles(), state, w, scale.x) {
                    Ok(picture) => {
                        let at = place.map_or(m.frame().loc.to_f64(), |p| p.origin);
                        let frame = Rectangle::new(at - output_geo.loc.to_f64(), m.frame().size.to_f64()).to_physical(scale);
                        out.push(OutputElement::Snapshot(snapshot::SnapshotElement::new(&picture, frame, look.scale, look.alpha)));
                        continue;
                    }
                    Err(err) => tracing::debug!(%err, id = m.id, "no picture of an opening window"),
                }
            }
            push_window(out, renderer, state, w, place, output_geo.loc, scale, output_size);
        }
    };
    // Windows closing: pictures of them, fading where they were — over the windows still there,
    // and a fullscreen one over the shell's chrome, as it was.
    let push_closing = |out: &mut Vec<OutputElement<R>>, fullscreen: bool| {
        for c in state.wm.closing.iter().rev().filter(|c| c.fullscreen == fullscreen) {
            let Some(look) = c.motion.look(now) else { continue };
            let frame = Rectangle::new(c.frame.loc - output_geo.loc.to_f64(), c.frame.size).to_physical(scale);
            out.push(OutputElement::Snapshot(snapshot::SnapshotElement::new(&c.picture, frame, look.scale, look.alpha)));
        }
    };
    // Windows going into the dock or coming back out of it, their dialogs in front of them:
    // drawn right in front of the dock's layer — a window lands where its thumbnail is, and
    // that is over the dock's glass, not under it — and out of the stack while they move. A
    // window going in is out of the space already; one coming back is in it, and goes back to
    // its place in the stack when it gets there.
    let moving: Vec<Window> = state
        .wm
        .animations
        .iter()
        .filter_map(|a| state.wm.get(a.id))
        .filter(|m| placement(m).is_some())
        .flat_map(|m| {
            let dialogs = state.wm.windows.iter().rev().filter(|d| d.id != m.id && state.wm.within(d, m.id));
            dialogs.chain(std::iter::once(m)).map(|d| d.window.clone()).collect::<Vec<_>>()
        })
        .collect();
    let still = |windows: Vec<Window>| -> Vec<Window> {
        if moving.is_empty() {
            return windows;
        }
        windows.into_iter().filter(|w| !moving.contains(w)).collect()
    };
    let (above, below) = (still(above), still(below));
    // The dock's layer here: Top, or Overlay over a fullscreen window and with the app grid.
    let dock_on_overlay = state
        .wm
        .minimize_targets
        .get(&output.name())
        .and_then(|t| map.layers().find(|l| l.namespace() == t.namespace))
        .is_some_and(|l| l.layer() == Layer::Overlay);
    // The shadows the shell's chrome (top and overlay layers) casts: one floor under all of
    // it, combined by their maximum like one surface's (two surfaces' shadows that overlap —
    // the Control Center's strip and the dock's band — never darken the corner twice).
    let floor: Vec<scrim::ScrimPx> = [Layer::Overlay, Layer::Top]
        .into_iter()
        .flat_map(|layer| map.layers_on(layer).map(|l| chrome_scrims(l.wl_surface(), layer_loc(l), scale, now)).collect::<Vec<_>>())
        .flatten()
        .collect();
    if dock_on_overlay {
        push_windows(&mut out, renderer, &moving);
    }
    for l in map.layers_on(Layer::Overlay).rev() {
        push_surface(&mut out, renderer, l.wl_surface(), layer_loc(l), scale, output_size, Some(&floor), state.when);
    }
    // X11 menus, tooltips and drop-downs (xwayland.rs): where their client puts them, over the
    // windows and the bar, the last one shown in front.
    for x in state.wm.x11_overrides.iter().rev() {
        let Some(surface) = x.wl_surface() else { continue };
        let at = x.last_configure().loc - output_geo.loc;
        push_surface(&mut out, renderer, &surface, at.to_f64().to_physical_precise_round(scale), scale, output_size, None, state.when);
    }
    push_closing(&mut out, true);
    push_windows(&mut out, renderer, &above);
    if !dock_on_overlay {
        push_windows(&mut out, renderer, &moving);
    }
    for l in map.layers_on(Layer::Top).rev() {
        push_surface(&mut out, renderer, l.wl_surface(), layer_loc(l), scale, output_size, Some(&floor), state.when);
    }
    out.extend(ScrimElement::new(output.user_data(), floor, output_size).map(OutputElement::Scrim));
    push_closing(&mut out, false);
    push_windows(&mut out, renderer, &below);
    // The workspace left behind, sliding out: hidden, so out of the space — drawn from the
    // model, front to back, behind the one coming in.
    if let Some((s, _)) = slide {
        let left: Vec<Window> = state.wm.on_workspace(s.from).filter(|m| !m.pinned).map(|m| m.window.clone()).collect();
        push_windows(&mut out, renderer, &left.into_iter().rev().collect::<Vec<_>>());
    }
    for layer in [Layer::Bottom, Layer::Background] {
        for l in map.layers_on(layer).rev() {
            push_surface(&mut out, renderer, l.wl_surface(), layer_loc(l), scale, output_size, None, state.when);
        }
    }
    with_overlay(out, output)
}

/// The debug overlay over everything (stats.rs, #766): where each glass element samples.
fn with_overlay<R: HyaloRenderer>(mut out: Vec<OutputElement<R>>, output: &Output) -> Vec<OutputElement<R>> {
    if !stats::overlay_enabled() {
        return out;
    }
    let regions: Vec<_> = out.iter().filter_map(|e| if let OutputElement::Glass(g) = e { Some(g.region()) } else { None }).collect();
    let overlay = stats::overlay(&output.name(), &regions);
    out.splice(0..0, overlay.into_iter().map(OutputElement::Debug));
    out
}

/// Everything of window `w` on an output at `output_loc` — its surfaces, popups, corners,
/// controls or title bar, line, shadow and backdrop — where the space has it, or at `place`
/// (scaled: wm/minimize.rs). Also how a window is drawn alone into a picture of it
/// (render/snapshot.rs).
#[allow(clippy::too_many_arguments)]
pub(crate) fn push_window<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    renderer: &mut R,
    state: &Scene<'_>,
    w: &Window,
    place: Option<crate::wm::minimize::Placement>,
    output_loc: Point<i32, Logical>,
    scale: Scale<f64>,
    output_size: smithay::utils::Size<i32, Physical>,
) {
    let managed = state.wm.by_window(w);
    // A minimized window is out of the space: drawn where the model has it.
    let Some(at) = state.space.element_location(w).or_else(|| managed.map(|m| m.rect.loc)) else { return };
    let fullscreen = managed.is_some_and(|m| m.fullscreen == crate::wm::Fullscreen::Fullscreen);
    let bar = managed.filter(|_| !fullscreen).map_or(0, |m| m.bar());
    // Everything of the window is drawn from its surface's origin, its box and the
    // scale: moved and scaled together, its corners, line and shadow follow (decor.rs,
    // window.rs). A point `q` of the window's whole box, from its top-left, lands at
    // `origin + q × k`.
    let (loc, geo, wscale, origin_of) = match place {
        None => {
            let loc = (at - w.geometry().loc - output_loc).to_f64().to_physical_precise_round(scale);
            let geo = Rectangle::new(at - output_loc, w.geometry().size).to_f64().to_physical_precise_round(scale);
            let origin = (at - w.geometry().loc - output_loc).to_f64();
            (loc, geo, scale, (origin, 1.0))
        }
        Some(p) => {
            let k = p.scale;
            let base = p.origin - output_loc.to_f64();
            let gl = w.geometry().loc.to_f64();
            let surface = base + Point::<f64, Logical>::from((-gl.x, bar as f64 - gl.y)).upscale(k);
            let client = base + Point::<f64, Logical>::from((0.0, bar as f64)).upscale(k);
            let geo = Rectangle::new(client.to_physical(scale), w.geometry().size.to_f64().upscale(k).to_physical(scale));
            (surface.to_physical(scale).to_i32_round(), geo, Scale::from(scale.x * k), (surface, k))
        }
    };
    let look = window::look(
        w,
        fullscreen,
        managed.is_none_or(|m| m.rounded),
        managed.is_none_or(|m| m.backdrop),
        state.windows,
    );
    // The controls over its header (protocols/window_controls.rs), or in Hyalo's title
    // bar (title_bar.rs): never on a fullscreen window.
    let controls = managed.filter(|_| !fullscreen).and_then(|m| {
        let (r, buttons) = crate::protocols::window_controls::managed_rect(m, &state.windows.controls)?;
        let (origin, k) = origin_of;
        let rect = Rectangle::new(origin + r.loc.upscale(k), r.size.upscale(k)).to_physical(scale);
        let hover = state.wm.controls_hover.filter(|h| h.window == m.id);
        let controls = controls::Controls {
            buttons,
            hover: hover.and_then(|h| buttons.as_slice().iter().position(|b| *b == h.button)),
            pressed: hover.is_some_and(|h| h.pressed),
            active: state.wm.focused == Some(m.id),
            dark: crate::wm::surface_of(&m.window).is_some_and(|s| crate::protocols::window_controls::dark_ink(&s)),
        };
        Some((rect, controls))
    });
    let (controls, title_bar) = match managed.filter(|_| bar > 0) {
        Some(m) => (None, Some(title_bar::TitleBar {
            height: bar as f64,
            title: crate::wm::title(w),
            family: state.windows.title_bar.font.clone(),
            active: state.wm.focused == Some(m.id),
            controls,
        })),
        None => (controls, None),
    };
    // Its line and its shadow (decor.rs), focused or not: not on a fullscreen window, nor
    // where a rule took its corners (games).
    let decor = managed.filter(|m| !fullscreen && m.rounded).map(|m| state.wm.focused == Some(m.id));
    window::push(out, renderer, w, look, loc, geo, wscale, output_size, state.windows, controls, title_bar, decor, state.when);
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
