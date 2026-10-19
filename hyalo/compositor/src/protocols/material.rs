//! nidara-material-v1: a surface declares its glass shapes and its blur; the renderer
//! (src/render/glass.rs) resolves them against the backdrop. Double-buffered on wl_surface.commit
//! through Smithay's cached state, so it lands with the buffer it describes.

use smithay::{
    reexports::wayland_server::{
        Client, DataInit, DisplayHandle, New, Resource, Weak, backend::ClientId,
        protocol::wl_surface::WlSurface,
    },
    backend::renderer::{
        element::Id,
        utils::{CommitCounter, DamageBag, DamageSnapshot},
    },
    utils::{Logical, Rectangle},
    wayland::{
        Dispatch2, GlobalDispatch2,
        compositor::{Cacheable, RectangleKind, RegionAttributes, get_region_attributes, with_states},
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
    /// The whole glass's opacity in this shape over the plain backdrop (1 from add_shape).
    pub opacity: f64,
    /// What of the shape may show, same coordinates: x, y, w, h. None = all of it.
    pub clip: Option<[f64; 4]>,
    /// A pointer spliced into one side (a tooltip's or a menu's), same coordinates.
    pub pointer: Option<Pointer>,
    /// The fusion group it belongs to (`set_fusion`): one silhouette with the group's others.
    pub fusion: Option<Fusion>,
    /// How the glass treats the backdrop under it (`set_tone`). None: as it is, blurred.
    pub tone: Option<Tone>,
    /// Its tone while its ink group's content is dark (`set_ink_tone`). None: `tone`.
    pub ink_tone: Option<Tone>,
    /// Its own blur (`set_shape_blur`). None: the surface's (`set_blur`).
    pub blur: Option<Blur>,
    /// The shadow it casts outside the surface's shapes (`set_shadow`). None: none.
    pub shadow: Option<ShadowLaw>,
    /// Its blur's strength at its top and bottom edges (`set_shape_grade`), 0..1. None: its
    /// whole blur everywhere.
    pub grade: Option<[f64; 2]>,
}

/// The shadow a shape casts (`set_shadow`): black, a gaussian of `blur` deviation, moved
/// `offset` down, only outside the surface's shapes; opacity and blur from their small values
/// (shorter side ≤ 64 logical px) to their large ones (≥ 160), the ramp of the tone's ambient
/// (render/glass_gl.rs `ToneGl::grown`). Logical px.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ShadowLaw {
    pub opacity: [f64; 2],
    pub blur: [f64; 2],
    pub offset: f64,
}

impl ShadowLaw {
    /// Its opacity and deviation (logical px) on a shape whose shorter side is `side`.
    pub fn at(&self, side: f64) -> (f64, f64) {
        let t = crate::render::glass_gl::ToneGl::grown(side);
        (self.opacity[0] + (self.opacity[1] - self.opacity[0]) * t, self.blur[0] + (self.blur[1] - self.blur[0]) * t)
    }
}

/// A blur: the kawase offset (logical px) and the number of passes (`set_blur`,
/// `set_shape_blur`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Blur {
    pub size: f64,
    pub passes: u32,
}

/// The blur of glass the compositor paints: the widest of the three it mixes per shape
/// (render/glass_gl.rs `BlurMix`, which says where the numbers come from). It is the glass's,
/// not the client's: `set_blur` and `set_shape_blur` blur only a surface whose glass its client
/// paints.
pub const GLASS_BLUR: Blur = Blur { size: 4.0, passes: 3 };

/// How the glass treats the blurred backdrop under a shape (`set_tone`), in this order, on the
/// sRGB-encoded colour: saturation about the Rec.709 luma; the luma l brought to
/// l·(1 − (1 − ceiling)·l); levels lift + (gain − lift)·v; the wash laid over; the ambient —
/// what surrounds the pane, blurred far wider, mapped by its own levels — lightening what is
/// darker than it, at `ambient` times how large the shape is (render/glass_gl.rs).
/// Each stage measured, input by input, on the reference's own glass (2026-10-11).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Tone {
    pub saturation: f64,
    pub ceiling: f64,
    pub lift: f64,
    pub gain: f64,
    pub wash: [f64; 4],
    pub ambient: f64,
    pub ambient_lift: f64,
    pub ambient_gain: f64,
}

impl Tone {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        saturation: f64, ceiling: f64, lift: f64, gain: f64,
        wash: [f64; 4], ambient: f64, ambient_lift: f64, ambient_gain: f64,
    ) -> Self {
        Self {
            saturation: saturation.clamp(0.0, 4.0),
            ceiling: ceiling.clamp(0.0, 1.0),
            lift: lift.clamp(-1.0, 2.0),
            gain: gain.clamp(-1.0, 4.0),
            wash: [wash[0].clamp(0.0, 1.0), wash[1].clamp(0.0, 1.0), wash[2].clamp(0.0, 1.0), wash[3].clamp(0.0, 1.0)],
            ambient: ambient.clamp(0.0, 1.0),
            ambient_lift: ambient_lift.clamp(-1.0, 2.0),
            ambient_gain: ambient_gain.clamp(-1.0, 4.0),
        }
    }
}

/// A fusion group (`set_fusion`): its shapes are drawn as one pane of glass, the smooth union
/// of their outlines; two closer than `spacing` (logical px) are joined. `merge`
/// (`set_fusion_merge`, 0..1) takes that union towards the group's envelope, one shape.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Fusion {
    pub group: u32,
    pub spacing: f64,
    pub merge: f64,
}

/// A pointer from a shape's edge: its base centred on `base`, `width` wide, to `tip`; a
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
    pub refraction: f64,
    pub rim: f64,
}

/// Where content of one ink group sits, surface-local logical coordinates.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct InkBox {
    pub id: u32,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// The ink measurement: WCAG luminance thresholds. A dark-ink shape takes its `ink_tone`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Ink {
    pub dark_above: f64,
    pub light_below: f64,
}

/// A fixed veil under the shapes whose centre lies inside it (add_veil_region), surface-local
/// logical coordinates; it may reach past the surface.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct VeilRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub falloff: f64,
    pub veil: Veil,
}

/// A fixed veil's opacity, even under its region, and the shape of its fall-off outside it,
/// `(1 − d/falloff)^exponent`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Veil {
    pub strength: f64,
    pub exponent: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MaterialState {
    pub shapes: Vec<Shape>,
    pub blur_size: f64,
    pub blur_passes: u32,
    pub glass: Option<Glass>,
    pub ink_boxes: Vec<InkBox>,
    pub ink: Option<Ink>,
    /// each shape's refraction is at least this fraction of its shorter side.
    pub lensing: f64,
    /// The fixed veils the shapes inside them lie on.
    pub veil_regions: Vec<VeilRegion>,
    /// What `set_fusion` last said: the group the next shapes join.
    pub fusing: Option<Fusion>,
    /// What `set_tone` and `set_ink_tone` last said: the tones the next shapes take.
    pub toning: Option<Tone>,
    pub ink_toning: Option<Tone>,
    /// What `set_shape_blur` last said: the blur the next shapes take.
    pub blurring: Option<Blur>,
    /// What `set_shadow` last said: the shadow the next shapes cast.
    pub shadowing: Option<ShadowLaw>,
    /// What `set_shape_grade` last said: how the next shapes' blur is graded.
    pub grading: Option<[f64; 2]>,
    /// `set_drawn_region`: where the surface's content is drawn, surface-local logical
    /// rectangles that do not overlap. None: the whole surface.
    pub drawn: Option<Vec<Rectangle<i32, Logical>>>,
    /// `set_window_background`: the window's background colour, sRGB 0..1, opaque. Not glass:
    /// drawn with the window (render/decor.rs) at the windows' opacity (toolkit/PHASE1.md D6).
    pub window_background: Option<[f64; 3]>,
    /// `set_window_background_level`: the level the app asked for; None: the user's.
    pub window_background_level: Option<crate::config::BackgroundLevel>,
}

impl MaterialState {
    /// How far a shape's edge displaces the backdrop, logical px: the glass's refraction, or
    /// `lensing` of its shorter side where that is more. 0 without the compositor's glass.
    pub fn refraction_of(&self, s: &Shape) -> f64 {
        self.glass.map_or(0.0, |g| g.refraction.max(self.lensing * s.w.min(s.h)))
    }

    /// The blur a shape is resolved with: the glass's where the compositor paints it
    /// (`GLASS_BLUR`, mixed per shape by its size); else its own (`set_shape_blur`), else the
    /// surface's.
    pub fn blur_of(&self, s: &Shape) -> Blur {
        if self.glass.is_some() {
            return GLASS_BLUR;
        }
        s.blur.unwrap_or(Blur { size: self.blur_size, passes: self.blur_passes })
    }
}

/// One fixed veil (add_veil_region): its core (surface-local logical px), how far it falls
/// outside, and the shapes that lie on it.
#[derive(Debug, Clone, PartialEq)]
pub struct VeilUnit {
    /// The region's index.
    pub key: u32,
    pub core: [f64; 4],
    pub falloff: f64,
    pub veil: Veil,
    /// Indices into `MaterialState::shapes`.
    pub members: Vec<usize>,
}

impl MaterialState {
    /// The veils this material casts: one per region that holds a shape (by its centre).
    /// Nothing without the compositor's glass.
    pub fn veil_units(&self) -> Vec<VeilUnit> {
        if self.glass.is_none() {
            return Vec::new();
        }
        let mut units: Vec<VeilUnit> = self
            .veil_regions
            .iter()
            .enumerate()
            .map(|(i, r)| VeilUnit { key: i as u32, core: [r.x, r.y, r.w, r.h], falloff: r.falloff, veil: r.veil, members: Vec::new() })
            .collect();
        for (i, s) in self.shapes.iter().enumerate() {
            let (cx, cy) = (s.x + s.w / 2.0, s.y + s.h / 2.0);
            if let Some(u) = units.iter_mut().find(|u| {
                cx >= u.core[0] && cx < u.core[0] + u.core[2] && cy >= u.core[1] && cy < u.core[1] + u.core[3]
            }) {
                u.members.push(i);
            }
        }
        units.retain(|u| !u.members.is_empty());
        units
    }
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
    /// The darkest point last measured under each ink group: a new rule (set_ink) is applied to
    /// it at once, as the backdrop under a still surface is not measured again (the bar's ink
    /// following the mode, 2026-10-09: it turned only when something moved behind it).
    pub ink_darkest: std::collections::BTreeMap<u32, f64>,
}

/// The surface's material object, for the ink event.
struct MaterialResource(std::sync::Mutex<Option<NidaraMaterialV1>>);

/// Groups the client has declared at most this many of are remembered; past it the memory
/// starts again (a shell does not declare thousands; a misbehaving client cannot grow it).
const MAX_INK_GROUPS: usize = 256;

/// The ink rule with its hysteresis: a group whose darkest point under its content is `darkest`
/// turns dark only above `dark_above`, and light again only below `light_below`. None: no change.
pub(crate) fn next_ink(dark: bool, darkest: f64, ink: &Ink) -> Option<bool> {
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
        if current.ink_darkest.len() > MAX_INK_GROUPS {
            current.ink_darkest.clear();
        }
        for &(id, l) in darkest {
            current.ink_darkest.insert(id, l as f64);
        }
        let Some(ink) = current.state.ink else { return false };
        let changed = apply_ink(&mut current, darkest.iter().map(|&(id, l)| (id, l as f64)), &ink);
        drop(current);
        send_ink(states, changed)
    })
}

/// The rule applied to these measurements: what changed, recorded in `current` (its counter
/// moved, as a shape's tint follows its group's ink).
fn apply_ink(current: &mut Current, darkest: impl Iterator<Item = (u32, f64)>, ink: &Ink) -> Vec<(u32, bool)> {
    let changed: Vec<(u32, bool)> = darkest
        .filter_map(|(id, l)| next_ink(current.dark_ink.contains(&id), l, ink).map(|dark| (id, dark)))
        .collect();
    if changed.is_empty() {
        return changed;
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
    changed
}

/// Tells the client what changed; whether anything did (the glass must be redrawn).
fn send_ink(states: &smithay::wayland::compositor::SurfaceData, changed: Vec<(u32, bool)>) -> bool {
    if changed.is_empty() {
        return false;
    }
    // The protocol is v1 and stays v1 (additions go inside it): the event is in v1, so no
    // version test. A `>= 3` left from before that rule sent it to nobody, while the glass
    // still wore the light veil — white text on a white veil.
    if let Some(res) = states.data_map.get::<MaterialResource>()
        && let Some(res) = res.0.lock().unwrap().as_ref()
    {
        for (id, dark) in changed {
            res.ink(id, dark as u32);
        }
    }
    true
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
        if current.state.drawn != committed.drawn {
            let drawn = states.data_map.get_or_insert_threadsafe(|| std::sync::Mutex::new(DrawnState::default()));
            drawn.lock().unwrap().changed(current.state.drawn.as_deref(), committed.drawn.as_deref());
        }
        // The glass's counter moves only when the glass changed: a dock that re-declares its
        // drawn region on every frame of a hover does not redraw its glass for it.
        let not_glass = |m: &MaterialState| MaterialState { drawn: None, window_background: None, window_background_level: None, ..m.clone() };
        let glass_changed = not_glass(&current.state) != not_glass(&committed);
        // A new ink rule meets the last measurement now: nothing measures a still backdrop again.
        let new_rule = committed.ink.filter(|i| current.state.ink.as_ref() != Some(i));
        if current.state != committed {
            current.state = committed;
            if glass_changed {
                current.commit.increment();
            }
        }
        if let Some(ink) = new_rule {
            let darkest: Vec<(u32, f64)> = current.ink_darkest.iter().map(|(&id, &l)| (id, l)).collect();
            let changed = apply_ink(&mut current, darkest.into_iter(), &ink);
            drop(current);
            send_ink(states, changed);
        }
    });
}

/// Past this many rectangles a drawn region is taken as its bounding box: generous, never short.
const MAX_DRAWN_RECTS: usize = 64;

/// A wl_region as rectangles that do not overlap, in its own order of adds and subtracts.
fn flatten(region: &RegionAttributes) -> Vec<Rectangle<i32, Logical>> {
    let mut out: Vec<Rectangle<i32, Logical>> = Vec::new();
    for (kind, r) in &region.rects {
        match kind {
            RectangleKind::Add => {
                let new = r.subtract_rects(out.iter().copied());
                out.extend(new);
            }
            RectangleKind::Subtract => out = Rectangle::subtract_rects_many(out, [*r]),
        }
        out.retain(|r| !r.is_empty());
    }
    if out.len() > MAX_DRAWN_RECTS {
        let bbox = out.iter().copied().reduce(|a, b| a.merge(b)).unwrap_or_default();
        out = vec![bbox];
    }
    out
}

/// The whole surface, for a damage that involves "no region": the renderer cuts it to the
/// surface (render/drawn.rs).
fn whole() -> Rectangle<i32, Logical> {
    Rectangle::from_size((1 << 20, 1 << 20).into())
}

/// A surface's drawn region over time: what changed, so the renderer repaints where content
/// appeared or went (render/drawn.rs) — the client's buffer need not have changed there.
pub struct DrawnState {
    changes: DamageBag<i32, Logical>,
    id: Id,
}

impl Default for DrawnState {
    fn default() -> Self {
        Self { changes: DamageBag::new(16), id: Id::new() }
    }
}

impl DrawnState {
    /// The region went from `old` to `new`: both repaint (what appeared and what went).
    fn changed(&mut self, old: Option<&[Rectangle<i32, Logical>]>, new: Option<&[Rectangle<i32, Logical>]>) {
        let side = |r: Option<&[Rectangle<i32, Logical>]>| r.map_or_else(|| vec![whole()], <[_]>::to_vec);
        let (old, new) = (side(old), side(new));
        // What is in one and not the other: content shown on one side only.
        let mut damage = Rectangle::subtract_rects_many(old.iter().copied(), new.iter().copied());
        damage.extend(Rectangle::subtract_rects_many(new.iter().copied(), old.iter().copied()));
        if damage.is_empty() {
            return;
        }
        self.changes.add(damage);
    }
}

/// What the renderer reads of a surface's drawn region (render/drawn.rs).
pub struct Drawn {
    /// Surface-local logical; None = the whole surface.
    pub rects: Option<Vec<Rectangle<i32, Logical>>>,
    /// Where the region changed, for the element that repaints it.
    pub changes: DamageSnapshot<i32, Logical>,
    pub id: Id,
}

/// The drawn region of a surface that has ever declared one. None for every other surface:
/// drawn whole, nothing to track.
pub fn drawn(surface: &WlSurface) -> Option<Drawn> {
    with_states(surface, |states| {
        let state = states.data_map.get::<std::sync::Mutex<DrawnState>>()?.lock().unwrap();
        let rects = states.data_map.get::<std::sync::Mutex<Current>>().and_then(|c| c.lock().unwrap().state.drawn.clone());
        Some(Drawn { rects, changes: state.changes.snapshot(), id: state.id.clone() })
    })
}

/// The material a surface has right now, if it has one worth resolving.
/// How many of the shapes committed on a surface have a blur — `current`'s test, for a walk that
/// already holds the surface's states.
pub fn glass_shapes(states: &smithay::wayland::compositor::SurfaceData) -> usize {
    states.data_map.get::<std::sync::Mutex<Current>>().map_or(0, |c| {
        let m = &c.lock().unwrap().state;
        m.shapes.iter().filter(|s| m.blur_of(s).passes > 0).count()
    })
}

pub fn current(surface: &WlSurface) -> Option<Current> {
    with_states(surface, |states| {
        let current = states.data_map.get::<std::sync::Mutex<Current>>()?.lock().unwrap().clone();
        let m = &current.state;
        (m.shapes.iter().any(|s| m.blur_of(s).passes > 0)).then_some(current)
    })
}

/// The background colour `surface` declared for its window (`set_window_background`), if any,
/// and the level it asked for (`set_window_background_level`; None: the user's).
pub fn window_background(surface: &WlSurface) -> Option<([f64; 3], Option<crate::config::BackgroundLevel>)> {
    with_states(surface, |states| {
        let current = states.data_map.get::<std::sync::Mutex<Current>>()?.lock().unwrap();
        current.state.window_background.map(|c| (c, current.state.window_background_level))
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
                    m.veil_regions.clear();
                    m.fusing = None;
                    m.toning = None;
                    m.ink_toning = None;
                    m.blurring = None;
                    m.shadowing = None;
                    m.grading = None;
                });
            }
            Request::AddShape { x, y, width, height, corner_radius, exponent } => {
                self.pending(|m| {
                    m.shapes.push(Shape {
                        x, y, w: width, h: height, radius: corner_radius, exponent, opacity: 1.0, clip: None,
                        pointer: None, fusion: m.fusing,
                        tone: m.toning, ink_tone: m.ink_toning, blur: m.blurring, shadow: m.shadowing, grade: m.grading,
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
                            fusion: m.fusing, tone: m.toning, ink_tone: m.ink_toning, blur: m.blurring, shadow: m.shadowing, grade: m.grading,
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
                        // A pointer's join is its own union: it fuses with nothing else.
                        m.shapes.push(Shape {
                            x, y, w: width, h: height, radius: corner_radius, exponent, opacity, clip, pointer,
                            fusion: if pointer.is_some() { None } else { m.fusing },
                            tone: m.toning, ink_tone: m.ink_toning, blur: m.blurring, shadow: m.shadowing, grade: m.grading,
                        })
                    });
                }
            }
            Request::SetFusion { group, spacing } => {
                self.pending(|m| {
                    m.fusing = (group != 0 && spacing > 0.0).then_some(Fusion { group, spacing, merge: 0.0 });
                });
            }
            Request::SetFusionMerge { merge } => {
                self.pending(|m| {
                    if let Some(f) = m.fusing.as_mut() {
                        f.merge = merge.clamp(0.0, 1.0);
                    }
                });
            }
            Request::SetBlur { size, passes } => {
                self.pending(|m| {
                    m.blur_size = size;
                    m.blur_passes = passes.min(8);
                });
            }
            Request::SetShapeBlur { size, passes } => {
                self.pending(|m| m.blurring = (passes > 0).then_some(Blur { size: size.max(0.0), passes: passes.min(8) }));
            }
            // The tint's arguments are inert since set_tone (the protocol stays v1).
            Request::SetGlass { refraction, rim, .. } => {
                self.pending(|m| m.glass = Some(Glass { refraction, rim }));
            }
            Request::SetTone {
                saturation, ceiling, lift, gain, wash_r, wash_g, wash_b, wash_a, ambient, ambient_lift, ambient_gain,
            } => {
                let tone = Tone::new(saturation, ceiling, lift, gain, [wash_r, wash_g, wash_b, wash_a], ambient, ambient_lift, ambient_gain);
                self.pending(|m| {
                    m.toning = Some(tone);
                    m.ink_toning = None;
                });
            }
            Request::SetInkTone {
                saturation, ceiling, lift, gain, wash_r, wash_g, wash_b, wash_a, ambient, ambient_lift, ambient_gain,
            } => {
                let tone = Tone::new(saturation, ceiling, lift, gain, [wash_r, wash_g, wash_b, wash_a], ambient, ambient_lift, ambient_gain);
                self.pending(|m| m.ink_toning = Some(tone));
            }
            Request::SetShadow { opacity_small, opacity_large, blur_small, blur_large, offset } => {
                let law = ShadowLaw {
                    opacity: [opacity_small.clamp(0.0, 1.0), opacity_large.clamp(0.0, 1.0)],
                    blur: [blur_small.clamp(0.0, 200.0), blur_large.clamp(0.0, 200.0)],
                    offset: offset.clamp(-200.0, 200.0),
                };
                self.pending(|m| m.shadowing = (law.opacity[0] > 0.0 || law.opacity[1] > 0.0).then_some(law));
            }
            Request::SetShapeGrade { top, bottom } => {
                let (top, bottom) = (top.clamp(0.0, 1.0), bottom.clamp(0.0, 1.0));
                self.pending(|m| m.grading = (top < 1.0 || bottom < 1.0).then_some([top, bottom]));
            }
            Request::SetLensing { size_fraction } => {
                self.pending(|m| m.lensing = size_fraction.clamp(0.0, 1.0));
            }
            Request::SetWindowBackground { r, g, b } => {
                self.pending(|m| m.window_background = Some([r.clamp(0.0, 1.0), g.clamp(0.0, 1.0), b.clamp(0.0, 1.0)]));
            }
            Request::UnsetWindowBackground => {
                self.pending(|m| m.window_background = None);
            }
            Request::SetWindowBackgroundLevel { level } => {
                use crate::config::BackgroundLevel;
                use nidara_material_v1::WindowBackgroundLevel as L;
                let level = match level.into_result() {
                    Ok(L::Opaque) => Some(BackgroundLevel::Opaque),
                    Ok(L::Tinted) => Some(BackgroundLevel::Tinted),
                    Ok(L::Translucent) => Some(BackgroundLevel::Translucent),
                    // follow, or a value a newer client knows and this compositor does not.
                    _ => None,
                };
                self.pending(|m| m.window_background_level = level);
            }
            Request::ClearGlass => {
                self.pending(|m| m.glass = None);
            }
            Request::AddInkBox { id, x, y, width, height } => {
                if width > 0.0 && height > 0.0 {
                    self.pending(|m| m.ink_boxes.push(InkBox { id, x, y, w: width, h: height }));
                }
            }
            // The tint is inert since set_ink_tone.
            Request::SetInk { dark_above, light_below, .. } => {
                self.pending(|m| m.ink = Some(Ink { dark_above, light_below: light_below.min(dark_above) }));
            }
            Request::ClearInk => {
                self.pending(|m| m.ink = None);
            }
            // Inert: the shadow under the glass is gone (set_tone replaced the tint it made up for).
            Request::SetScrim { .. } | Request::AddScrimRegion { .. } => {}
            Request::AddVeilRegion { x, y, width, height, falloff, strength, exponent } => {
                if width > 0.0 && height > 0.0 {
                    let veil = Veil { strength: strength.clamp(0.0, 1.0), exponent: exponent.max(0.1) };
                    self.pending(|m| {
                        m.veil_regions.push(VeilRegion { x, y, w: width, h: height, falloff: falloff.max(0.0), veil })
                    });
                }
            }
            Request::SetDrawnRegion { region } => {
                // Copied now: the client may destroy the wl_region right after this request.
                let rects = region.map(|r| flatten(&get_region_attributes(&r)));
                self.pending(|m| m.drawn = rects);
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
    fn a_drawn_region_is_its_adds_and_subtracts_in_order_and_its_changes_repaint() {
        let r = |x, y, w, h| Rectangle::<i32, Logical>::new((x, y).into(), (w, h).into());
        let area = |v: &[Rectangle<i32, Logical>]| v.iter().map(|r| r.size.w * r.size.h).sum::<i32>();
        // The bar: its strip and an open panel overlapping it — no pixel counted twice.
        let region = RegionAttributes { rects: vec![(RectangleKind::Add, r(0, 0, 2560, 60)), (RectangleKind::Add, r(1900, 40, 600, 800))] };
        let flat = flatten(&region);
        assert_eq!(area(&flat), 2560 * 60 + 600 * 780, "the overlap once: {flat:?}");
        // A subtract takes from what came before it, and an add after it puts it back.
        let region = RegionAttributes {
            rects: vec![(RectangleKind::Add, r(0, 0, 100, 100)), (RectangleKind::Subtract, r(0, 0, 50, 100)), (RectangleKind::Add, r(0, 0, 10, 10))],
        };
        assert_eq!(area(&flatten(&region)), 50 * 100 + 10 * 10);
        // A dock growing up by 40 px repaints the 40 px it gained, nothing it kept.
        let mut d = DrawnState::default();
        d.changed(Some(&[r(0, 1300, 2560, 140)]), Some(&[r(0, 1260, 2560, 180)]));
        let changes = d.changes.snapshot().damage_since(Some(CommitCounter::default())).unwrap();
        assert_eq!(changes.iter().copied().collect::<Vec<_>>(), vec![r(0, 1260, 2560, 40)]);
        // The same region again: nothing.
        let before = d.changes.current_commit();
        d.changed(Some(&[r(0, 0, 10, 10)]), Some(&[r(0, 0, 10, 10)]));
        assert_eq!(d.changes.current_commit(), before);
    }

    #[test]
    fn ink_turns_only_past_its_thresholds() {
        let ink = Ink { dark_above: 0.8, light_below: 0.65 };
        assert_eq!(next_ink(false, 0.95, &ink), Some(true), "all white under the text: dark");
        assert_eq!(next_ink(false, 0.79, &ink), None, "one point below the threshold keeps it light");
        assert_eq!(next_ink(true, 0.70, &ink), None, "between the two: it stays as it is (hysteresis)");
        assert_eq!(next_ink(false, 0.70, &ink), None, "...whichever way it was");
        assert_eq!(next_ink(true, 0.60, &ink), Some(false), "below the lower one: light again");
        assert_eq!(next_ink(true, 0.95, &ink), None, "already dark: no event");
    }

    #[test]
    fn a_new_rule_meets_the_last_measurement() {
        // An ink that follows the mode (the bar): a still backdrop is measured once, and each
        // mode's rule must turn it at once — light mode's (−1/−2) dark, dark mode's (2/1.5) light.
        let mut current = Current::default();
        current.ink_darkest.insert(7, 0.1);
        let light_mode = Ink { dark_above: -1.0, light_below: -2.0 };
        let last = |c: &Current| c.ink_darkest.iter().map(|(&id, &l)| (id, l)).collect::<Vec<_>>();
        let m = last(&current);
        assert_eq!(apply_ink(&mut current, m.into_iter(), &light_mode), vec![(7, true)],
            "over a dark backdrop, light mode turns it dark");
        let m = last(&current);
        assert_eq!(apply_ink(&mut current, m.into_iter(), &light_mode), vec![], "and keeps it");
        let dark_mode = Ink { dark_above: 2.0, light_below: 1.5 };
        current.ink_darkest.insert(7, 0.99);
        let m = last(&current);
        assert_eq!(apply_ink(&mut current, m.into_iter(), &dark_mode), vec![(7, false)],
            "over a white backdrop, dark mode turns it light");
    }

    fn shape(x: f64, y: f64) -> Shape {
        Shape {
            x, y, w: 100.0, h: 40.0, radius: 12.0, exponent: 2.0, opacity: 1.0, clip: None, pointer: None,
            fusion: None, tone: None, ink_tone: None, blur: None, shadow: None, grade: None,
        }
    }

    #[test]
    fn a_veil_region_holds_the_shapes_whose_centre_is_inside_it() {
        let veil = Veil { strength: 0.078, exponent: 1.5 };
        let mut m = MaterialState {
            shapes: vec![shape(10.0, 10.0), shape(900.0, 100.0), shape(900.0, 200.0)],
            glass: Some(Glass { refraction: 10.0, rim: 0.7 }),
            veil_regions: vec![
                VeilRegion { x: 850.0, y: 0.0, w: 400.0, h: 400.0, falloff: 125.0, veil },
                VeilRegion { x: 0.0, y: 600.0, w: 10.0, h: 10.0, falloff: 50.0, veil },
            ],
            ..Default::default()
        };
        let units = m.veil_units();
        assert_eq!(units.len(), 1, "the empty region casts nothing: {units:?}");
        assert_eq!((units[0].key, units[0].members.clone(), units[0].veil), (0, vec![1, 2], veil),
            "the two panes on the right lie on it; the other on nothing");
        m.glass = None;
        assert!(m.veil_units().is_empty(), "no veil without the compositor's glass");
    }

    #[test]
    fn a_shape_takes_the_tones_last_set_and_clear_shapes_resets_them() {
        let dark = Tone::new(1.3, 0.6, 0.125, 1.125, [0.0; 4], 0.0, 0.0, 1.0);
        let light = Tone::new(1.2, 0.94, 0.4, 1.03, [1.0, 1.0, 1.0, 0.2], 0.0, 0.0, 1.0);
        assert_eq!(Tone::new(9.0, 2.0, 0.0, 1.0, [2.0, -1.0, 0.5, 3.0], -1.0, 0.0, 1.0),
            Tone::new(4.0, 1.0, 0.0, 1.0, [1.0, 0.0, 0.5, 1.0], 0.0, 0.0, 1.0), "held to its range");
        let mut m = MaterialState { toning: Some(dark), ink_toning: Some(light), ..Default::default() };
        let add = |m: &mut MaterialState| m.shapes.push(Shape { tone: m.toning, ink_tone: m.ink_toning, ..shape(0.0, 0.0) });
        add(&mut m);
        m.toning = None;
        m.ink_toning = None;
        add(&mut m);
        assert_eq!((m.shapes[0].tone, m.shapes[0].ink_tone), (Some(dark), Some(light)));
        assert_eq!((m.shapes[1].tone, m.shapes[1].ink_tone), (None, None), "after a reset: none");
    }

    #[test]
    fn a_shape_without_a_blur_of_its_own_takes_the_surface_s() {
        let wide = Blur { size: 2.0, passes: 3 };
        let m = MaterialState {
            shapes: vec![shape(0.0, 0.0), Shape { blur: Some(wide), ..shape(0.0, 100.0) }],
            blur_size: 2.0,
            blur_passes: 2,
            ..Default::default()
        };
        assert_eq!(m.blur_of(&m.shapes[0]), Blur { size: 2.0, passes: 2 }, "the surface's");
        assert_eq!(m.blur_of(&m.shapes[1]), wide, "its own");
    }

    #[test]
    fn glass_the_compositor_paints_takes_the_glass_s_blur_whatever_the_client_set() {
        let wide = Blur { size: 2.0, passes: 3 };
        let m = MaterialState {
            shapes: vec![shape(0.0, 0.0), Shape { blur: Some(wide), ..shape(0.0, 100.0) }],
            blur_size: 1.0,
            blur_passes: 2,
            glass: Some(Glass { refraction: 10.0, rim: 1.0 }),
            ..Default::default()
        };
        assert_eq!(m.blur_of(&m.shapes[0]), GLASS_BLUR);
        assert_eq!(m.blur_of(&m.shapes[1]), GLASS_BLUR, "set_shape_blur blurs only glass its client paints");
    }
}
