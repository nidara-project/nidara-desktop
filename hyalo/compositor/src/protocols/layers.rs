//! nidara-layers-v1: subsurfaces Hyalo animates for their client (#818, toolkit/CONTRACT.md).
//!
//! The client sets a layer's MODEL value (where it ends) and, beforehand, how the next change
//! gets there (a spring or a curve); Hyalo owns the PRESENTED value and moves it every frame,
//! whatever the client is doing. A new model value starts from where the layer is on screen
//! (a spring keeps its velocity): retargeting, never a jump.
//!
//! Smithay places a subsurface where it was at its last commit (`SurfaceView::offset`, set on
//! commit and private to Smithay), so a layer cannot be moved by writing that state. Instead a
//! tree that holds a layer is walked here, both to draw it (`render_tree`) and to find what is
//! under the pointer (`under_tree`), with each layer at its presented transform. A tree with no
//! layer goes through Smithay's own walks, untouched.

mod cursor;
pub use cursor::{place_input_popup, prepare_input_popups, remember_input_popup};

use std::{
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};

use smithay::{
    backend::renderer::{
        ImportAll, Renderer,
        element::{Kind, surface::WaylandSurfaceRenderElement},
        utils::RendererSurfaceStateUserData,
    },
    reexports::wayland_server::{
        Client, DataInit, DisplayHandle, New, Resource, Weak, protocol::wl_surface::WlSurface,
    },
    utils::{Logical, Physical, Point, Scale},
    wayland::{
        Dispatch2, GlobalDispatch2,
        compositor::{
            Cacheable, SUBSURFACE_ROLE, SurfaceAttributes, SurfaceData, TraversalAction, get_parent,
            get_role, with_states, with_surface_tree_downward,
        },
    },
};

use crate::{
    Hyalo,
    protocols::gen_layers::{
        nidara_layer_v1::{self, NidaraLayerV1},
        nidara_layers_manager_v1::{self, NidaraLayersManagerV1},
    },
    render::window::AtScale,
};

/// At most this many layers under one toplevel (the protocol's `too_many_layers`).
pub const MAX_LAYERS: usize = 64;
/// No transition runs longer than this, whatever its curve says: a spring that never settles
/// would keep the output drawing forever.
const LONGEST: Duration = Duration::from_secs(10);

/// Layers alive, for the fast path: with none, every walk is Smithay's.
static LIVE: AtomicUsize = AtomicUsize::new(0);
/// The surfaces that are layers, for stepping their transitions after each frame.
static LAYERS: Mutex<Vec<Weak<WlSurface>>> = Mutex::new(Vec::new());

// ─── Curves ──────────────────────────────────────────────────────────────────────────────────

/// How a property moves to a new model value.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Curve {
    /// A damped spring: mass, stiffness, damping; `velocity` is used only from rest.
    Spring { mass: f64, stiffness: f64, damping: f64, velocity: f64 },
    /// A cubic Bézier from (0,0) to (1,1) through `p1` and `p2`, over `duration`.
    Bezier { p1: (f64, f64), p2: (f64, f64), duration: Duration },
}

impl Curve {
    fn spring(mass: f64, stiffness: f64, damping: f64, velocity: f64) -> Option<Self> {
        let ok = [mass, stiffness, damping, velocity].iter().all(|v| v.is_finite());
        (ok && mass > 0.0 && stiffness > 0.0 && damping > 0.0).then_some(Self::Spring { mass, stiffness, damping, velocity })
    }

    fn bezier(x1: f64, y1: f64, x2: f64, y2: f64, ms: u32) -> Option<Self> {
        let ok = [x1, y1, x2, y2].iter().all(|v| v.is_finite()) && (0.0..=1.0).contains(&x1) && (0.0..=1.0).contains(&x2);
        ok.then_some(Self::Bezier { p1: (x1, y1), p2: (x2, y2), duration: Duration::from_millis(ms as u64) })
    }
}

/// One scalar moving from `from` to `to` since `start`.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Track {
    from: f64,
    to: f64,
    /// Velocity at `start`, units per second (springs).
    velocity: f64,
    start: Instant,
    curve: Curve,
    /// How close to `to`, and how slow, counts as arrived (springs).
    rest: f64,
}

impl Track {
    /// The value and its velocity at `t`, and whether it has arrived.
    fn sample(&self, t: Instant) -> (f64, f64, bool) {
        let dt = t.saturating_duration_since(self.start);
        if dt >= LONGEST {
            return (self.to, 0.0, true);
        }
        let secs = dt.as_secs_f64();
        match self.curve {
            Curve::Bezier { p1, p2, duration } => {
                if dt >= duration || duration.is_zero() {
                    return (self.to, 0.0, true);
                }
                let x = secs / duration.as_secs_f64();
                let y = crate::wm::motion::bezier(p1, p2, x);
                // The slope by a small difference: only a retarget reads it.
                let h = 1e-3;
                let dy = (crate::wm::motion::bezier(p1, p2, (x + h).min(1.0)) - y) / h / duration.as_secs_f64();
                (self.from + (self.to - self.from) * y, (self.to - self.from) * dy, false)
            }
            Curve::Spring { mass, stiffness, damping, .. } => {
                let (x, v) = spring(self.from - self.to, self.velocity, mass, stiffness, damping, secs);
                let arrived = x.abs() < self.rest && v.abs() < self.rest * 10.0;
                if arrived { (self.to, 0.0, true) } else { (self.to + x, v, false) }
            }
        }
    }
}

/// A damped spring's displacement and velocity `t` seconds after it was at `x0` moving at `v0`,
/// towards 0. Closed form: the same value at a given moment however the frames fall.
fn spring(x0: f64, v0: f64, m: f64, k: f64, c: f64, t: f64) -> (f64, f64) {
    let w0 = (k / m).sqrt();
    let zeta = c / (2.0 * (k * m).sqrt());
    if (zeta - 1.0).abs() < 1e-6 {
        let b = v0 + w0 * x0;
        let e = (-w0 * t).exp();
        ((x0 + b * t) * e, (b - w0 * (x0 + b * t)) * e)
    } else if zeta < 1.0 {
        let wd = w0 * (1.0 - zeta * zeta).sqrt();
        let a = x0;
        let b = (v0 + zeta * w0 * x0) / wd;
        let e = (-zeta * w0 * t).exp();
        let (s, co) = (wd * t).sin_cos();
        let x = e * (a * co + b * s);
        let v = e * ((b * wd - zeta * w0 * a) * co - (a * wd + zeta * w0 * b) * s);
        (x, v)
    } else {
        let r = (zeta * zeta - 1.0).sqrt();
        let (r1, r2) = (-w0 * (zeta - r), -w0 * (zeta + r));
        let c2 = (v0 - r1 * x0) / (r2 - r1);
        let c1 = x0 - c2;
        let (e1, e2) = ((r1 * t).exp(), (r2 * t).exp());
        (c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2)
    }
}

/// A property's model value and, while it moves, its transition.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Prop {
    model: f64,
    track: Option<Track>,
}

impl Prop {
    fn new(v: f64) -> Self {
        Self { model: v, track: None }
    }

    fn presented(&self, t: Instant) -> (f64, f64) {
        match &self.track {
            Some(tr) => {
                let (v, vel, _) = tr.sample(t);
                (v, vel)
            }
            None => (self.model, 0.0),
        }
    }

    /// A new model value: moved there by `curve` from where it is now, or at once.
    fn set(&mut self, to: f64, curve: Option<Curve>, now: Instant, rest: f64) {
        let (from, velocity) = self.presented(now);
        let moving = self.track.is_some();
        self.model = to;
        self.track = curve.map(|curve| {
            let velocity = match curve {
                Curve::Spring { velocity: v0, .. } if !moving => v0,
                _ => velocity,
            };
            Track { from, to, velocity, start: now, curve, rest }
        });
    }

    /// Drops a finished transition; whether one is still running.
    fn step(&mut self, t: Instant) -> bool {
        match &self.track {
            Some(tr) if tr.sample(t).2 => {
                self.track = None;
                false
            }
            Some(_) => true,
            None => false,
        }
    }
}

// ─── State ───────────────────────────────────────────────────────────────────────────────────

const POSITION: usize = 0;
const SCALE: usize = 1;
const OPACITY: usize = 2;

/// What a commit brings: double-buffered through Smithay's cached state, so a subsurface in
/// sync mode lands it with its parent's commit.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Pending {
    transitions: [Option<(Curve, u32)>; 3],
    position: Option<[f64; 2]>,
    scale: Option<(f64, [f64; 2])>,
    opacity: Option<f64>,
}

impl Cacheable for Pending {
    fn commit(&mut self, _dh: &DisplayHandle) -> Self {
        std::mem::take(self)
    }
    fn merge_into(self, into: &mut Self, _dh: &DisplayHandle) {
        for (i, t) in self.transitions.into_iter().enumerate() {
            if t.is_some() {
                into.transitions[i] = t;
            }
        }
        if self.position.is_some() {
            into.position = self.position;
        }
        if self.scale.is_some() {
            into.scale = self.scale;
        }
        if self.opacity.is_some() {
            into.opacity = self.opacity;
        }
    }
}

/// A layer as Hyalo keeps it, in its surface's data map.
#[derive(Debug)]
pub struct Layer {
    resource: NidaraLayerV1,
    /// False once its object is destroyed: the surface's data map keeps the entry (it cannot
    /// drop one), and the surface is a plain subsurface again.
    alive: bool,
    /// The transition the NEXT change of each property takes, with its serial.
    armed: [Option<(Curve, u32)>; 3],
    /// The serial of each property's running transition.
    running: [Option<u32>; 3],
    /// None until the client sets one: the subsurface's own position.
    x: Option<Prop>,
    y: Option<Prop>,
    scale: Prop,
    anchor: [f64; 2],
    opacity: Prop,
}

/// Where and how a layer is shown at a moment, in its parent's logical space.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Look {
    /// None: where the subsurface itself is.
    pub position: Option<[f64; 2]>,
    pub scale: f64,
    pub anchor: [f64; 2],
    pub opacity: f64,
}

impl Layer {
    fn look(&self, t: Instant) -> Look {
        let position = match (&self.x, &self.y) {
            (Some(x), Some(y)) => Some([x.presented(t).0, y.presented(t).0]),
            _ => None,
        };
        Look {
            position,
            scale: self.scale.presented(t).0.max(0.0),
            anchor: self.anchor,
            opacity: self.opacity.presented(t).0.clamp(0.0, 1.0),
        }
    }

    /// A property got a new model value: a transition replaced is cancelled, an armed one
    /// starts.
    fn begin(&mut self, which: usize) -> Option<Curve> {
        if let Some(serial) = self.running[which].take() {
            self.resource.cancelled(serial);
        }
        let armed = self.armed[which].take();
        self.running[which] = armed.map(|(_, serial)| serial);
        armed.map(|(curve, _)| curve)
    }

    fn apply(&mut self, p: Pending, now: Instant, at: Point<i32, Logical>) {
        for (i, t) in p.transitions.into_iter().enumerate() {
            if t.is_some() {
                self.armed[i] = t;
            }
        }
        if let Some([x, y]) = p.position {
            let curve = self.begin(POSITION);
            let rest = 0.05;
            let px = self.x.get_or_insert(Prop::new(at.x as f64));
            px.set(x, curve, now, rest);
            let py = self.y.get_or_insert(Prop::new(at.y as f64));
            py.set(y, curve, now, rest);
        }
        if let Some((s, anchor)) = p.scale {
            let curve = self.begin(SCALE);
            self.anchor = anchor;
            self.scale.set(s, curve, now, 5e-4);
        }
        if let Some(o) = p.opacity {
            let curve = self.begin(OPACITY);
            self.opacity.set(o, curve, now, 5e-4);
        }
    }

    /// Drops what has arrived and tells the client; whether anything still moves.
    fn step(&mut self, t: Instant, shown: Duration) -> bool {
        let pos = self.x.as_mut().is_some_and(|x| x.step(t)) | self.y.as_mut().is_some_and(|y| y.step(t));
        let moving = [pos, self.scale.step(t), self.opacity.step(t)];
        for (i, still) in moving.iter().enumerate() {
            if !still && let Some(serial) = self.running[i].take() {
                let secs = shown.as_secs();
                self.resource.done(serial, (secs >> 32) as u32, secs as u32, shown.subsec_nanos());
            }
        }
        moving.iter().any(|m| *m)
    }
}

/// Applies what a commit brought to every layer in `surface`'s tree. A sync subsurface's state
/// lands with its parent's commit, so the whole tree is looked at.
pub fn on_commit(surface: &WlSurface) {
    if LIVE.load(Ordering::Relaxed) == 0 {
        return;
    }
    let now = Instant::now();
    with_surface_tree_downward(
        surface,
        (),
        |_, _, _| TraversalAction::DoChildren(()),
        |_, states, _| {
            if !is_layer(states) || !states.cached_state.has::<Pending>() {
                return;
            }
            let pending = std::mem::take(states.cached_state.get::<Pending>().current());
            if pending == Pending::default() {
                return;
            }
            let at = view(states).map(|v| v.offset).unwrap_or_default();
            if let Some(layer) = states.data_map.get::<Mutex<Layer>>() {
                layer.lock().unwrap().apply(pending, now, at);
            }
        },
        |_, _, _| true,
    );
}

/// After a frame: transitions that have arrived are dropped and their `done` sent, at `shown`
/// (the monotonic clock). Whether any layer still moves — the caller keeps the frames coming.
pub fn step(shown: Duration) -> bool {
    if LIVE.load(Ordering::Relaxed) == 0 {
        return false;
    }
    let now = Instant::now();
    let mut layers = LAYERS.lock().unwrap();
    let mut moving = false;
    layers.retain(|w| {
        let Ok(surface) = w.upgrade() else { return false };
        with_states(&surface, |states| {
            let Some(layer) = states.data_map.get::<Mutex<Layer>>() else { return false };
            let mut layer = layer.lock().unwrap();
            if !layer.alive {
                return false;
            }
            moving |= layer.step(now, shown);
            true
        })
    });
    moving
}

fn view(states: &SurfaceData) -> Option<smithay::backend::renderer::utils::SurfaceView> {
    states.data_map.get::<RendererSurfaceStateUserData>()?.lock().unwrap().view()
}

fn look(states: &SurfaceData, t: Instant) -> Option<Look> {
    let layer = states.data_map.get::<Mutex<Layer>>()?.lock().unwrap();
    layer.alive.then(|| layer.look(t))
}

fn is_layer(states: &SurfaceData) -> bool {
    states.data_map.get::<Mutex<Layer>>().is_some_and(|l| l.lock().unwrap().alive)
}

/// Whether `surface`'s tree holds a layer.
pub fn tree_has_layer(surface: &WlSurface) -> bool {
    if LIVE.load(Ordering::Relaxed) == 0 {
        return false;
    }
    let found = std::cell::Cell::new(false);
    with_surface_tree_downward(
        surface,
        (),
        |_, _, _| TraversalAction::DoChildren(()),
        |_, states, _| found.set(found.get() | is_layer(states)),
        |_, _, _| !found.get(),
    );
    found.get()
}

fn count_in_tree(root: &WlSurface) -> usize {
    let mut n = 0;
    with_surface_tree_downward(
        root,
        (),
        |_, _, _| TraversalAction::DoChildren(()),
        |_, states, _| n += is_layer(states) as usize,
        |_, _, _| true,
    );
    n
}

// ─── The walks ───────────────────────────────────────────────────────────────────────────────

/// Where a surface of the tree is: its top-left, and the scale and opacity it is shown at
/// relative to the tree's root.
#[derive(Debug, Clone, Copy)]
struct Place {
    at: Point<f64, Logical>,
    scale: f64,
    alpha: f64,
}

/// A surface's place from its parent's: a layer at its presented transform, anything else at
/// its subsurface offset.
fn place(parent: Place, states: &SurfaceData, offset: Point<i32, Logical>, t: Instant) -> Place {
    match look(states, t) {
        Some(l) => {
            let p = l.position.map_or(offset.to_f64(), |[x, y]| Point::from((x, y)));
            // Scaled about the anchor: the anchor stays where it is at scale 1.
            let shift = Point::<f64, Logical>::from((l.anchor[0] * (1.0 - l.scale), l.anchor[1] * (1.0 - l.scale)));
            Place { at: parent.at + (p + shift).upscale(parent.scale), scale: parent.scale * l.scale, alpha: parent.alpha * l.opacity }
        }
        None => Place { at: parent.at + offset.to_f64().upscale(parent.scale), ..parent },
    }
}

/// `surface`'s tree as render elements, front to back, each layer at its presented transform
/// `when`. None when the tree holds no layer: the caller uses Smithay's own walk.
pub fn render_tree<R>(
    renderer: &mut R,
    surface: &WlSurface,
    location: Point<i32, Physical>,
    scale: Scale<f64>,
    kind: Kind,
    when: Instant,
) -> Option<Vec<AtScale<WaylandSurfaceRenderElement<R>>>>
where
    R: Renderer + ImportAll,
    R::TextureId: Clone + 'static,
{
    if !tree_has_layer(surface) {
        return None;
    }
    // Logical, relative to the root; turned physical per element at the output's scale.
    let origin = location.to_f64().to_logical(scale);
    let root = Place { at: origin, scale: 1.0, alpha: 1.0 };
    let mut out = Vec::new();
    with_surface_tree_downward(
        surface,
        root,
        |_, states, parent| match view(states) {
            Some(v) => {
                let here = place(*parent, states, v.offset, when);
                if here.alpha <= 0.0 { TraversalAction::SkipChildren } else { TraversalAction::DoChildren(here) }
            }
            None => TraversalAction::SkipChildren,
        },
        |surface, states, parent| {
            let Some(v) = view(states) else { return };
            let here = place(*parent, states, v.offset, when);
            if here.alpha <= 0.0 {
                return;
            }
            let at = here.at.to_physical(scale);
            match WaylandSurfaceRenderElement::from_surface(renderer, surface, states, at, here.alpha as f32, kind) {
                Ok(Some(inner)) => {
                    let s = Scale::from((scale.x * here.scale, scale.y * here.scale));
                    out.push(AtScale { inner, scale: s });
                }
                Ok(None) => {}
                Err(e) => tracing::warn!("layers: could not import a surface: {e}"),
            }
        },
        |_, _, _| true,
    );
    Some(out)
}

/// What of `surface`'s tree is under `point` (both relative to the same origin as `location`),
/// each layer where it is shown now. The point returned is the surface's origin as the pointer
/// must be told it: `point` minus it is the position inside the surface, in the surface's own
/// coordinates even while it is scaled. None when nothing is hit. Only for a tree that holds a
/// layer (`tree_has_layer`); Smithay's walk answers the others.
pub fn under_tree(
    surface: &WlSurface,
    point: Point<f64, Logical>,
    location: Point<i32, Logical>,
) -> Option<(WlSurface, Point<f64, Logical>)> {
    let now = Instant::now();
    let root = Place { at: location.to_f64(), scale: 1.0, alpha: 1.0 };
    let found = std::cell::RefCell::new(None);
    with_surface_tree_downward(
        surface,
        root,
        |_, states, parent| match view(states) {
            Some(v) => {
                let here = place(*parent, states, v.offset, now);
                // A layer faded out entirely takes no input: it is not there to be clicked.
                if here.alpha <= 0.0 { TraversalAction::SkipChildren } else { TraversalAction::DoChildren(here) }
            }
            None => TraversalAction::SkipChildren,
        },
        |surface, states, parent| {
            let Some(v) = view(states) else { return };
            let here = place(*parent, states, v.offset, now);
            if here.alpha <= 0.0 || here.scale <= 0.0 {
                return;
            }
            if std::env::var_os("HYALO_CONTROL").is_some() {
                eprintln!("LAYER_HIT point={point:?} origin={:?} scale={} size={:?}", here.at, here.scale, v.dst);
            }
            let local = Point::<f64, Logical>::from(((point.x - here.at.x) / here.scale, (point.y - here.at.y) / here.scale));
            let mut attrs = states.cached_state.get::<SurfaceAttributes>();
            if contains(v.dst, attrs.current(), local) {
                *found.borrow_mut() = Some((surface.clone(), point - local));
            }
        },
        |_, _, _| found.borrow().is_none(),
    );
    found.into_inner()
}

/// Smithay's rule (`RendererSurfaceState::contains_point`, private to it): inside the surface,
/// and inside its input region if it has one.
fn contains(size: smithay::utils::Size<i32, Logical>, attrs: &SurfaceAttributes, p: Point<f64, Logical>) -> bool {
    if !smithay::utils::Rectangle::from_size(size).to_f64().contains(p) {
        return false;
    }
    attrs.input_region.as_ref().is_none_or(|r| r.contains(p.to_i32_floor()))
}

// ─── The protocol ────────────────────────────────────────────────────────────────────────────

pub struct LayersGlobal;
pub struct LayerData(Weak<WlSurface>);

pub fn init(dh: &DisplayHandle) {
    dh.create_global::<Hyalo, NidaraLayersManagerV1, _>(1, LayersGlobal);
}

impl GlobalDispatch2<NidaraLayersManagerV1, Hyalo> for LayersGlobal {
    fn bind(
        &self,
        _state: &mut Hyalo,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<NidaraLayersManagerV1>,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        data_init.init(resource, LayersGlobal);
    }

    /// Not for a sandboxed client (sandbox.rs), like the glass: opening it to Flatpak apps is
    /// the later review of the trust boundary (#818).
    fn can_view(&self, client: &Client) -> bool {
        crate::sandbox::unrestricted(client)
    }
}

impl Dispatch2<NidaraLayersManagerV1, Hyalo> for LayersGlobal {
    fn request(
        &self,
        _state: &mut Hyalo,
        _client: &Client,
        resource: &NidaraLayersManagerV1,
        request: nidara_layers_manager_v1::Request,
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        use nidara_layers_manager_v1::{Error, Request};
        match request {
            Request::Destroy => {}
            Request::SetTextInputCursorRectangle { root, layer, x, y, width, height } => {
                cursor::set(resource, &root, layer,
                    smithay::utils::Rectangle::new((x,y).into(),(width,height).into()));
            }
            Request::GetLayer { id, surface } => {
                if get_role(&surface) != Some(SUBSURFACE_ROLE) {
                    resource.post_error(Error::NotSubsurface, "the surface is not a subsurface");
                    return;
                }
                if with_states(&surface, is_layer) {
                    resource.post_error(Error::AlreadyLayer, "the surface already is a layer");
                    return;
                }
                let mut root = surface.clone();
                while let Some(parent) = get_parent(&root) {
                    root = parent;
                }
                if count_in_tree(&root) >= MAX_LAYERS {
                    resource.post_error(Error::TooManyLayers, "more than 64 layers under one toplevel");
                    return;
                }
                let resource = data_init.init(id, LayerData(surface.downgrade()));
                let fresh = || Layer {
                    resource: resource.clone(),
                    alive: true,
                    armed: [None; 3],
                    running: [None; 3],
                    x: None,
                    y: None,
                    scale: Prop::new(1.0),
                    anchor: [0.0, 0.0],
                    opacity: Prop::new(1.0),
                };
                with_states(&surface, |s| {
                    // A surface that was a layer before keeps its entry: it is renewed.
                    let entry = s.data_map.get_or_insert_threadsafe(|| Mutex::new(fresh()));
                    *entry.lock().unwrap() = fresh();
                });
                LIVE.fetch_add(1, Ordering::Relaxed);
                LAYERS.lock().unwrap().push(surface.downgrade());
            }
        }
    }
}

impl LayerData {
    fn pending(&self, f: impl FnOnce(&mut Pending)) {
        if let Ok(surface) = self.0.upgrade() {
            with_states(&surface, |s| f(s.cached_state.get::<Pending>().pending()));
        }
    }
}

impl Dispatch2<NidaraLayerV1, Hyalo> for LayerData {
    fn request(
        &self,
        _state: &mut Hyalo,
        _client: &Client,
        resource: &NidaraLayerV1,
        request: nidara_layer_v1::Request,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, Hyalo>,
    ) {
        use nidara_layer_v1::{Error, Property, Request};
        let property = |p: smithay::reexports::wayland_server::WEnum<Property>| match p {
            smithay::reexports::wayland_server::WEnum::Value(Property::Position) => Some(POSITION),
            smithay::reexports::wayland_server::WEnum::Value(Property::Scale) => Some(SCALE),
            smithay::reexports::wayland_server::WEnum::Value(Property::Opacity) => Some(OPACITY),
            _ => None,
        };
        let invalid = |what: &str| resource.post_error(Error::InvalidValue, what.to_owned());
        match request {
            // Handled in `destroyed`, which a destructor request also reaches.
            Request::Destroy => {}
            Request::SetSpringTransition { property: p, serial, mass, stiffness, damping, initial_velocity } => {
                match (property(p), Curve::spring(mass, stiffness, damping, initial_velocity)) {
                    (Some(i), Some(c)) => self.pending(|m| m.transitions[i] = Some((c, serial))),
                    _ => invalid("a spring needs a known property and positive, finite mass, stiffness and damping"),
                }
            }
            Request::SetCurveTransition { property: p, serial, x1, y1, x2, y2, duration_ms } => {
                match (property(p), Curve::bezier(x1, y1, x2, y2, duration_ms)) {
                    (Some(i), Some(c)) => self.pending(|m| m.transitions[i] = Some((c, serial))),
                    _ => invalid("a curve needs a known property, finite points and x1, x2 within 0..1"),
                }
            }
            Request::SetPosition { x, y } => {
                if x.is_finite() && y.is_finite() {
                    self.pending(|m| m.position = Some([x, y]));
                } else {
                    invalid("a position must be finite");
                }
            }
            Request::SetScale { scale, anchor_x, anchor_y } => {
                if scale.is_finite() && scale >= 0.0 && anchor_x.is_finite() && anchor_y.is_finite() {
                    self.pending(|m| m.scale = Some((scale, [anchor_x, anchor_y])));
                } else {
                    invalid("a scale must be finite and not negative");
                }
            }
            Request::SetOpacity { opacity } => {
                if (0.0..=1.0).contains(&opacity) {
                    self.pending(|m| m.opacity = Some(opacity));
                } else {
                    invalid("an opacity must be within 0..1");
                }
            }
        }
    }

    /// The object is gone (destroyed, or its client is): the surface is a plain subsurface
    /// again, at its own position, and its transitions stop.
    fn destroyed(&self, state: &mut Hyalo, _client: smithay::reexports::wayland_server::backend::ClientId, resource: &NidaraLayerV1) {
        LIVE.fetch_sub(1, Ordering::Relaxed);
        if let Ok(surface) = self.0.upgrade() {
            with_states(&surface, |s| {
                let Some(layer) = s.data_map.get::<Mutex<Layer>>() else { return };
                let mut layer = layer.lock().unwrap();
                // A newer object on the same surface is not this one's to end.
                if layer.resource != *resource {
                    return;
                }
                // No `cancelled`: the object they would go to is gone.
                layer.alive = false;
                layer.running = [None; 3];
            });
        }
        state.queue_redraw(None);
    }
}

/// What of `window` is under `local` (window-relative, as `Window::surface_under` takes it):
/// Smithay's answer, except a tree with layers is walked at their presented transform. The
/// point is the surface's origin as the pointer must be told it.
pub fn window_under(
    window: &smithay::desktop::Window,
    local: Point<f64, Logical>,
    types: smithay::desktop::WindowSurfaceType,
) -> Option<(WlSurface, Point<f64, Logical>)> {
    use smithay::desktop::WindowSurfaceType;
    let toplevel = window.toplevel().map(|t| t.wl_surface().clone());
    if let Some(surface) = toplevel.filter(|s| types.contains(WindowSurfaceType::TOPLEVEL) && tree_has_layer(s)) {
        if types.contains(WindowSurfaceType::POPUP)
            && let Some((s, p)) = window.surface_under(local, WindowSurfaceType::POPUP | WindowSurfaceType::SUBSURFACE)
        {
            return Some((s, p.to_f64()));
        }
        return under_tree(&surface, local, (0, 0).into());
    }
    window.surface_under(local, types).map(|(s, p)| (s, p.to_f64()))
}

/// The same for a layer-shell surface (`LayerSurface::surface_under`).
pub fn layer_surface_under(
    layer: &smithay::desktop::LayerSurface,
    local: Point<f64, Logical>,
) -> Option<(WlSurface, Point<f64, Logical>)> {
    use smithay::desktop::WindowSurfaceType;
    if !tree_has_layer(layer.wl_surface()) {
        return layer.surface_under(local, WindowSurfaceType::ALL).map(|(s, p)| (s, p.to_f64()));
    }
    // Its popups first, as Smithay asks them (a popup is never a layer's tree).
    if let Some((s, p)) = layer.surface_under(local, WindowSurfaceType::POPUP | WindowSurfaceType::SUBSURFACE) {
        return Some((s, p.to_f64()));
    }
    under_tree(layer.wl_surface(), local, (0, 0).into())
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: fn(u64) -> Duration = Duration::from_millis;

    fn spring() -> Curve {
        Curve::spring(1.0, 300.0, 30.0, 0.0).unwrap()
    }

    #[test]
    fn a_spring_starts_where_it_was_and_arrives() {
        for (k, c) in [(300.0, 20.0), (300.0, 2.0 * 300f64.sqrt()), (300.0, 60.0)] {
            let t0 = Instant::now();
            let tr = Track { from: 0.0, to: 100.0, velocity: 0.0, start: t0, curve: Curve::spring(1.0, k, c, 0.0).unwrap(), rest: 0.05 };
            let (v0, vel0, done0) = tr.sample(t0);
            assert!(v0.abs() < 1e-9 && vel0.abs() < 1e-9 && !done0, "k {k} c {c}: {v0} {vel0}");
            let (v, _, _) = tr.sample(t0 + MS(100));
            assert!(v > 10.0 && v < 100.0 + 25.0, "k {k} c {c}: at 100 ms {v}");
            assert_eq!(tr.sample(t0 + MS(3000)), (100.0, 0.0, true), "k {k} c {c}");
        }
    }

    #[test]
    fn the_closed_form_is_the_spring() {
        // Integrated in tiny steps, the same spring lands where the closed form says.
        for c in [10.0, 2.0 * 300f64.sqrt(), 50.0] {
            let (m, k) = (1.0, 300.0);
            let (mut x, mut v) = (-100.0_f64, 40.0_f64);
            let dt = 1e-5;
            for _ in 0..(0.25 / dt) as usize {
                let a = (-k * x - c * v) / m;
                v += a * dt;
                x += v * dt;
            }
            let (cx, cv) = super::spring(-100.0, 40.0, m, k, c, 0.25);
            assert!((cx - x).abs() < 0.05 && (cv - v).abs() < 0.5, "c {c}: {cx} vs {x}, {cv} vs {v}");
        }
    }

    #[test]
    fn a_retargeted_spring_keeps_where_it_is_and_its_velocity() {
        let t0 = Instant::now();
        let mut p = Prop::new(0.0);
        p.set(100.0, Some(spring()), t0, 0.05);
        let mid = t0 + MS(60);
        let (at, vel) = p.presented(mid);
        p.set(-50.0, Some(spring()), mid, 0.05);
        let (at2, vel2) = p.presented(mid);
        assert!((at2 - at).abs() < 1e-9 && (vel2 - vel).abs() < 1e-6, "{at} {vel} → {at2} {vel2}");
        assert!(vel > 0.0, "it was still moving towards 100");
        assert_eq!(p.presented(mid + MS(5000)).0, -50.0);
    }

    #[test]
    fn a_spring_from_rest_takes_its_initial_velocity() {
        let t0 = Instant::now();
        let mut p = Prop::new(0.0);
        p.set(10.0, Some(Curve::spring(1.0, 300.0, 30.0, 500.0).unwrap()), t0, 0.05);
        assert_eq!(p.presented(t0).1, 500.0);
    }

    #[test]
    fn a_curve_runs_its_duration_and_a_change_without_one_is_immediate() {
        let t0 = Instant::now();
        let mut p = Prop::new(0.0);
        p.set(1.0, Curve::bezier(0.25, 0.1, 0.25, 1.0, 200), t0, 5e-4);
        let half = p.presented(t0 + MS(100)).0;
        assert!(half > 0.0 && half < 1.0, "{half}");
        assert!(p.step(t0 + MS(150)));
        assert!(!p.step(t0 + MS(200)));
        assert_eq!(p.presented(t0 + MS(200)), (1.0, 0.0));
        p.set(0.3, None, t0, 5e-4);
        assert_eq!(p.presented(t0), (0.3, 0.0));
    }

    #[test]
    fn no_transition_runs_forever() {
        let t0 = Instant::now();
        // Barely damped: it would ring for minutes.
        let tr = Track { from: 0.0, to: 1.0, velocity: 0.0, start: t0, curve: Curve::spring(1.0, 1000.0, 0.01, 0.0).unwrap(), rest: 5e-4 };
        assert!(!tr.sample(t0 + Duration::from_secs(9)).2);
        assert!(tr.sample(t0 + LONGEST).2);
    }

    #[test]
    fn curves_that_cannot_end_are_refused() {
        assert!(Curve::spring(0.0, 1.0, 1.0, 0.0).is_none());
        assert!(Curve::spring(1.0, -1.0, 1.0, 0.0).is_none());
        assert!(Curve::spring(1.0, 1.0, 0.0, 0.0).is_none());
        assert!(Curve::spring(1.0, 1.0, 1.0, f64::NAN).is_none());
        assert!(Curve::bezier(1.5, 0.0, 0.5, 1.0, 100).is_none());
        assert!(Curve::bezier(0.5, f64::INFINITY, 0.5, 1.0, 100).is_none());
    }

    #[test]
    fn later_commits_override_only_what_they_set() {
        let dh = smithay::reexports::wayland_server::Display::<()>::new().unwrap().handle();
        let mut cached = Pending { position: Some([1.0, 2.0]), opacity: Some(0.5), ..Default::default() };
        let next = Pending { position: Some([3.0, 4.0]), transitions: [None, None, Some((spring(), 7))], ..Default::default() };
        next.merge_into(&mut cached, &dh);
        assert_eq!(cached.position, Some([3.0, 4.0]));
        assert_eq!(cached.opacity, Some(0.5));
        assert_eq!(cached.transitions[OPACITY], Some((spring(), 7)));
        let mut pending = cached.clone();
        assert_eq!(pending.commit(&dh), cached);
        assert_eq!(pending, Pending::default(), "a commit takes what was pending");
    }
}
