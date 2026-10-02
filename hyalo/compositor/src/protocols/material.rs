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

/// The shadow under the glass (v5): its strongest, and how far a lone shape's fades.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Scrim {
    /// The shadow's opacity at its core, at most: 0..1.
    pub max_strength: f64,
    /// A shape inside no region fades over this fraction of its shorter side.
    pub size_fraction: f64,
    /// The least difference between the tint the darkest and the brightest point under a
    /// shadow's shapes need, for there to be a shadow at all (an opacity).
    pub min_spread: f64,
}

/// One shadow shared by the shapes whose centre lies inside it (v5), surface-local logical
/// coordinates; it may reach past the surface.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScrimRegion {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    pub falloff: f64,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct MaterialState {
    pub shapes: Vec<Shape>,
    pub blur_size: f64,
    pub blur_passes: u32,
    pub glass: Option<Glass>,
    pub ink_boxes: Vec<InkBox>,
    pub ink: Option<Ink>,
    /// v4: each shape's refraction is at least this fraction of its shorter side.
    pub lensing: f64,
    /// v5: the shadow under the glass, and the regions shapes share one in.
    pub scrim: Option<Scrim>,
    pub scrim_regions: Vec<ScrimRegion>,
}

impl MaterialState {
    /// How far a shape's edge displaces the backdrop, logical px: the glass's refraction, or
    /// `lensing` of its shorter side where that is more (v4). 0 without the compositor's glass.
    pub fn refraction_of(&self, s: &Shape) -> f64 {
        self.glass.map_or(0.0, |g| g.refraction.max(self.lensing * s.w.min(s.h)))
    }
}

/// One shadow under the glass: a core (surface-local logical px, a rounded rectangle) that
/// fades to nothing over `falloff` outside it, and the shapes it lies under.
#[derive(Debug, Clone, PartialEq)]
pub struct ScrimUnit {
    /// Stable while the client declares the same thing: a region's index, or a lone shape's
    /// index past `LONE_SCRIM`.
    pub key: u32,
    pub core: [f64; 4],
    pub radius: f64,
    pub falloff: f64,
    /// Indices into `MaterialState::shapes`.
    pub members: Vec<usize>,
}

/// A lone shape's shadow is keyed past every region's.
pub const LONE_SCRIM: u32 = 0x1_0000;

impl MaterialState {
    /// The shadows this material asks for (v5): one per region that holds a shape, and one
    /// per shape inside no region — none for a region whose falloff is negative, which claims
    /// its shapes and casts nothing. Nothing without set_scrim, or without the compositor's
    /// glass (the shadow is there for its tint).
    pub fn scrim_units(&self) -> Vec<ScrimUnit> {
        let Some(scrim) = self.scrim.filter(|s| s.max_strength > 0.0 && self.glass.is_some()) else {
            return Vec::new();
        };
        let mut units: Vec<ScrimUnit> = self
            .scrim_regions
            .iter()
            .enumerate()
            .map(|(i, r)| ScrimUnit {
                key: i as u32,
                core: [r.x, r.y, r.w, r.h],
                radius: 0.0,
                falloff: r.falloff,
                members: Vec::new(),
            })
            .collect();
        let mut lone = Vec::new();
        for (i, s) in self.shapes.iter().enumerate() {
            let (cx, cy) = (s.x + s.w / 2.0, s.y + s.h / 2.0);
            let home = units.iter_mut().find(|u| {
                cx >= u.core[0] && cx < u.core[0] + u.core[2] && cy >= u.core[1] && cy < u.core[1] + u.core[3]
            });
            match home {
                Some(u) => u.members.push(i),
                None => lone.push(ScrimUnit {
                    key: LONE_SCRIM + i as u32,
                    core: [s.x, s.y, s.w, s.h],
                    radius: s.radius.min(s.w.min(s.h) / 2.0),
                    falloff: scrim.size_fraction.max(0.0) * s.w.min(s.h),
                    members: vec![i],
                }),
            }
        }
        units.retain(|u| !u.members.is_empty() && u.falloff >= 0.0);
        units.extend(lone);
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
    /// The backdrop under each shape as the glass treats it, WITHOUT the shadow (v5): its
    /// darkest and brightest WCAG luminance, by shape index. Measured with the ink.
    pub shape_light: std::collections::BTreeMap<usize, (f32, f32)>,
    /// Each shadow's strength over time (v5), by `ScrimUnit::key`. Kept when its unit goes,
    /// like the ink: a panel reopened lies on the shadow it closed on.
    pub scrims: std::collections::BTreeMap<u32, ScrimAnim>,
}

/// A shadow's strength, easing from one value to the next (v5).
#[derive(Debug, Clone, Copy)]
pub struct ScrimAnim {
    pub from: f64,
    pub to: f64,
    pub start: std::time::Instant,
    pub duration: std::time::Duration,
}

impl ScrimAnim {
    pub fn value(&self, now: std::time::Instant) -> f64 {
        let t = if self.duration.is_zero() {
            1.0
        } else {
            (now.saturating_duration_since(self.start).as_secs_f64() / self.duration.as_secs_f64()).clamp(0.0, 1.0)
        };
        let e = t * t * (3.0 - 2.0 * t);
        self.from + (self.to - self.from) * e
    }

    pub fn settled(&self, now: std::time::Instant) -> bool {
        now.saturating_duration_since(self.start) >= self.duration
    }
}

/// How fast a shadow comes and goes: in quickly, as the backdrop brightens under a pane; out
/// slowly, so a backdrop that flickers (a video) does not pump the shadow.
const SCRIM_IN: std::time::Duration = std::time::Duration::from_millis(220);
const SCRIM_OUT: std::time::Duration = std::time::Duration::from_millis(600);
/// A new strength closer than this to the one in force is not worth a change.
const SCRIM_DEADBAND: f64 = 0.04;

/// sRGB encoding of a linear value: the inverse of the shader's `to_linear`.
fn encode(l: f64) -> f64 {
    let l = l.clamp(0.0, 1.0);
    if l <= 0.0031308 { l * 12.92 } else { 1.055 * l.powf(1.0 / 2.4) - 0.055 }
}

fn to_linear(v: f64) -> f64 {
    if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

/// The tint the glass lays over a backdrop of WCAG luminance `l` (render/glass_gl.rs, the last
/// pass, for a grey of that luminance): the least that brings it to the target, within the
/// glass's bounds.
fn tint_needed(l: f64, glass: &Glass) -> f64 {
    let c = encode(l);
    let lum = |a: f64| {
        let ch = |k: usize| to_linear(c * (1.0 - a) + glass.tint[k] * a);
        0.2126 * ch(0) + 0.7152 * ch(1) + 0.0722 * ch(2)
    };
    let mut a = 0.0;
    if lum(0.0) > glass.target_luminance {
        let (mut lo, mut hi) = (0.0, glass.alpha_max);
        for _ in 0..12 {
            let m = 0.5 * (lo + hi);
            if lum(m) > glass.target_luminance { lo = m } else { hi = m }
        }
        a = hi;
    }
    a.clamp(glass.alpha_min.min(glass.alpha_max), glass.alpha_max)
}

/// The shadow one unit wants (v5), from the darkest and brightest WCAG luminance of the
/// backdrop under its shapes without any shadow, and whether it has one now (`on`): a shadow
/// only while the tint those two points need differs by more than `min_spread` — a pane grey
/// in one part and clear in another — and until it falls below half of it.
///
/// Its strength is the LEAST that evens the pane out (owner, 2026-10-02: a last resort, there
/// only so the glass does not look painted grey over half of it): it brings the tint the two
/// points need to within half of `min_spread` of each other — the difference the hysteresis
/// already lets stand — and the tint does the rest, evenly. Bringing the brightest point all
/// the way down to the target (the first rule) made the tint idle and the shadow carry
/// everything. Black laid over the encoded colour scales it, so the encoded value is what is
/// solved for.
fn scrim_target(on: bool, darkest: f64, brightest: f64, glass: &Glass, scrim: &Scrim) -> f64 {
    let spread_under = |s: f64| {
        let left = |l: f64| to_linear(encode(l) * (1.0 - s));
        tint_needed(left(brightest), glass) - tint_needed(left(darkest), glass)
    };
    let spread = spread_under(0.0);
    let wanted = if on { spread > scrim.min_spread * 0.5 } else { spread > scrim.min_spread };
    if !wanted || brightest <= glass.target_luminance {
        return 0.0;
    }
    // At this strength the brightest point is at the target, and the spread is none.
    let full = (1.0 - encode(glass.target_luminance) / encode(brightest).max(1e-6))
        .clamp(0.0, scrim.max_strength.clamp(0.0, 1.0));
    let tolerated = scrim.min_spread * 0.5;
    if spread_under(full) > tolerated {
        return full;
    }
    let (mut lo, mut hi) = (0.0, full);
    for _ in 0..16 {
        let m = 0.5 * (lo + hi);
        if spread_under(m) > tolerated { lo = m } else { hi = m }
    }
    hi
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

/// A measurement came back (render/glass_gl.rs): the darkest and brightest luminance under
/// each shape, the shadow divided out. Moves each shadow toward the strength it now wants, and
/// returns whether one started to change (the caller redraws; the renderer keeps redrawing
/// while one eases, `scrim_easing`).
pub fn scrim_measured(surface: &WlSurface, light: &[(usize, f32, f32)], now: std::time::Instant) -> bool {
    with_states(surface, |states| {
        let Some(current) = states.data_map.get::<std::sync::Mutex<Current>>() else { return false };
        let mut current = current.lock().unwrap();
        let current = &mut *current;
        for &(i, lo, hi) in light {
            current.shape_light.insert(i, (lo, hi));
        }
        let n = current.state.shapes.len();
        current.shape_light.retain(|&i, _| i < n);
        let (Some(scrim), Some(glass)) = (current.state.scrim, current.state.glass) else { return false };
        let mut changed = false;
        for unit in current.state.scrim_units() {
            let lights: Vec<(f32, f32)> =
                unit.members.iter().filter_map(|i| current.shape_light.get(i).copied()).collect();
            if lights.is_empty() {
                continue;
            }
            let darkest = lights.iter().map(|l| l.0).fold(f32::MAX, f32::min) as f64;
            let brightest = lights.iter().map(|l| l.1).fold(f32::MIN, f32::max) as f64;
            let anim = current.scrims.get(&unit.key).copied();
            let to = anim.map_or(0.0, |a| a.to);
            let strength = scrim_target(to > 0.0, darkest, brightest, &glass, &scrim);
            let now_value = anim.map_or(0.0, |a| a.value(now));
            let retarget = (strength - to).abs() > SCRIM_DEADBAND || (strength == 0.0 && to > 0.0) || (strength > 0.0 && to == 0.0);
            if retarget {
                current.scrims.insert(unit.key, ScrimAnim {
                    from: now_value,
                    to: strength,
                    start: now,
                    duration: if strength > now_value { SCRIM_IN } else { SCRIM_OUT },
                });
                changed = true;
            }
        }
        if current.scrims.len() > MAX_INK_GROUPS {
            current.scrims.clear();
        }
        changed
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
    dh.create_global::<Hyalo, NidaraMaterialManagerV1, _>(5, MaterialGlobal);
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
                    m.scrim_regions.clear();
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
            Request::SetLensing { size_fraction } => {
                self.pending(|m| m.lensing = size_fraction.clamp(0.0, 1.0));
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
            Request::SetScrim { max_strength, size_fraction, min_spread } => {
                let max_strength = max_strength.clamp(0.0, 1.0);
                self.pending(|m| {
                    m.scrim = (max_strength > 0.0).then_some(Scrim {
                        max_strength,
                        size_fraction: size_fraction.clamp(0.0, 4.0),
                        min_spread: min_spread.clamp(0.0, 1.0),
                    })
                });
            }
            Request::AddScrimRegion { x, y, width, height, falloff } => {
                if width > 0.0 && height > 0.0 {
                    self.pending(|m| m.scrim_regions.push(ScrimRegion { x, y, w: width, h: height, falloff }));
                }
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

    fn glass() -> Glass {
        Glass {
            tint: [0.08, 0.08, 0.1], alpha_min: 0.05, alpha_max: 0.6, target_luminance: 0.183, refraction: 10.0,
            rim: 0.7, saturation: 1.0,
        }
    }

    #[test]
    fn a_shadow_only_where_the_tint_would_split_the_pane() {
        let g = glass();
        let scrim = Scrim { max_strength: 0.7, size_fraction: 0.5, min_spread: 0.12 };
        // The least that evens it out: black over the encoded colour scales it, and what the
        // strength leaves of the two points needs tints within half of min_spread — no closer.
        let s = scrim_target(false, 0.02, 1.0, &g, &scrim);
        let spread_left = |s: f64| tint_needed(to_linear(1.0 - s), &g) - tint_needed(to_linear(encode(0.02) * (1.0 - s)), &g);
        assert!((spread_left(s) - scrim.min_spread * 0.5).abs() < 0.005, "evened to the tolerated spread: {} for {s}", spread_left(s));
        let full = 1.0 - encode(g.target_luminance);
        assert!(s < full - 0.02, "less than bringing white to the target ({full}): {s}");
        assert_eq!(scrim_target(false, 0.0, 0.15, &g, &scrim), 0.0, "dark enough everywhere: none");
        assert_eq!(scrim_target(false, 0.55, 0.65, &g, &scrim), 0.0, "evenly light: an even tint, no shadow");
        assert_eq!(scrim_target(false, 0.9, 1.0, &g, &scrim), 0.0, "white everywhere: no shadow (the ink's veil)");
        // On the line: the spread that starts a shadow, and half of it that keeps one.
        let (lo, hi) = (0.30, 0.40);   // tints ≈0.24 and ≈0.34
        let spread = tint_needed(hi, &g) - tint_needed(lo, &g);
        assert!(spread > 0.06 && spread < 0.12, "the case sits between the two thresholds: {spread}");
        assert_eq!(scrim_target(false, lo, hi, &g, &scrim), 0.0, "not enough to start one");
        assert!(scrim_target(true, lo, hi, &g, &scrim) > 0.0, "enough to keep one (hysteresis)");
        let weak = Scrim { max_strength: 0.3, ..scrim };
        assert_eq!(scrim_target(false, 0.0, 1.0, &g, &weak), 0.3, "never past max_strength");
    }

    #[test]
    fn the_tint_needed_is_the_shaders() {
        let g = glass();
        assert_eq!(tint_needed(0.0, &g), g.alpha_min, "a dark backdrop: the least tint");
        let a = tint_needed(1.0, &g);
        let mixed = |k: usize| to_linear(1.0 * (1.0 - a) + g.tint[k] * a);
        let l = 0.2126 * mixed(0) + 0.7152 * mixed(1) + 0.0722 * mixed(2);
        assert!((l - g.target_luminance).abs() < 0.005, "white tinted by it comes to the target: {l}");
    }

    #[test]
    fn shapes_in_a_region_share_its_shadow_and_the_rest_get_their_own() {
        let shape = |x: f64, y: f64| Shape {
            x, y, w: 100.0, h: 40.0, radius: 12.0, exponent: 2.0, opacity: 1.0, clip: None, pointer: None,
        };
        let mut m = MaterialState {
            shapes: vec![shape(10.0, 10.0), shape(900.0, 100.0), shape(900.0, 200.0)],
            glass: Some(Glass {
                tint: [0.0; 3], alpha_min: 0.05, alpha_max: 0.6, target_luminance: 0.183, refraction: 10.0, rim: 0.7,
                saturation: 1.0,
            }),
            scrim: Some(Scrim { max_strength: 0.6, size_fraction: 0.5, min_spread: 0.12 }),
            scrim_regions: vec![
                ScrimRegion { x: 850.0, y: -1e5, w: 1e5, h: 2e5, falloff: 300.0 },
                ScrimRegion { x: 0.0, y: 600.0, w: 10.0, h: 10.0, falloff: 50.0 },
            ],
            ..Default::default()
        };
        let units = m.scrim_units();
        assert_eq!(units.len(), 2, "the empty region casts nothing: {units:?}");
        assert_eq!((units[0].key, units[0].members.clone()), (0, vec![1, 2]), "the two panes on the right share one");
        assert_eq!((units[1].key, units[1].members.clone()), (LONE_SCRIM, vec![0]), "the other gets its own");
        assert_eq!(units[1].falloff, 20.0, "fading over half its shorter side");
        // A region that casts nothing claims the shape anyway: no shadow of its own either.
        m.scrim_regions.insert(0, ScrimRegion { x: 0.0, y: 0.0, w: 200.0, h: 100.0, falloff: -1.0 });
        let units = m.scrim_units();
        assert_eq!(units.iter().map(|u| u.members.clone()).collect::<Vec<_>>(), vec![vec![1, 2]], "the first pane casts nothing");
        m.glass = None;
        assert!(m.scrim_units().is_empty(), "no shadow without the compositor's glass");
    }
}
