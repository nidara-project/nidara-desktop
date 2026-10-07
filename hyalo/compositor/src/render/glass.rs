//! A surface's glass as a render element of its own, drawn right below the surface.
//!
//! It is a Smithay *framebuffer effect*: the damage tracker calls `capture_framebuffer` when
//! anything behind the glass changed — after redrawing everything behind it — and `draw` when
//! the glass's own area needs repainting. So the blur is recomputed only when its backdrop
//! moves (a bar over a still wallpaper costs nothing per frame), and the rest of the frame
//! keeps damage tracking and direct scanout. No change to Smithay was needed: the mechanism
//! is its public API.
//!
//! What it adds over Hyprland (#679): the blur is per surface (its own size and passes), cut
//! to the shapes the client declares (`nidara-material-v1`) instead of guessed from alpha,
//! and the backdrop is exactly what lies below — sibling surfaces included.

use std::cell::RefCell;

use smithay::{
    backend::renderer::{
        element::{Element, Id, Kind, RenderElement},
        gles::GlesError,
        utils::CommitCounter,
    },
    reexports::wayland_server::{Resource, Weak, protocol::wl_surface::WlSurface},
    utils::{Buffer as BufferCoords, Physical, Point, Rectangle, Scale, user_data::UserDataMap},
    wayland::compositor::with_states,
};

use super::{HyaloRenderer, glass_gl};
use crate::protocols::material;

#[derive(Debug, Clone)]
pub struct GlassElement {
    id: Id,
    commit: CommitCounter,
    /// What the blur reads: the shapes' bounds grown by how far the blur reaches, in output
    /// pixels, clamped to the output.
    region: Rectangle<i32, Physical>,
    shapes: Vec<glass_gl::Shape>,
    offset: f32,
    passes: usize,
    /// How formed this group's glass is (#764): its most formed shape's. Its blur is captured
    /// for that much (`glass_gl::formed_blur`).
    formed: f32,
    glass: Option<glass_gl::Glass>,
    /// The ink boxes that fall in this group, measured when the capture or they change.
    ink_boxes: Vec<glass_gl::InkBox>,
    /// Where the backdrop under this group's shadowed shapes is measured.
    probes: Vec<glass_gl::LightProbe>,
    surface: Weak<WlSurface>,
    /// Hyprland's blur finishing: a window's backdrop has it (render/window.rs), the shell's
    /// glass does not.
    finish: glass_gl::Finish,
}

/// One id per group of a surface's shapes, stable across frames.
#[derive(Default)]
struct GlassIds(RefCell<Vec<Id>>);

impl GlassElement {
    /// The glass elements of `surface`, placed at `location` (its origin, output pixels):
    /// one per group of shapes whose blurs would overlap. `scrims` is the shadow drawn under
    /// it this frame (render/scrim.rs), which its measurement divides out.
    pub fn for_surface(
        surface: &WlSurface,
        location: Point<i32, Physical>,
        scale: Scale<f64>,
        output_size: smithay::utils::Size<i32, Physical>,
        scrims: &[super::scrim::ScrimPx],
    ) -> Vec<GlassElement> {
        let Some(current) = material::current(surface) else { return Vec::new() };
        let m = &current.state;
        // The shapes that lie under a shadow: the backdrop under each is measured.
        let shadowed: std::collections::BTreeSet<usize> =
            m.scrim_units().into_iter().flat_map(|u| u.members).collect();
        let groups = groups(output_size, scale, location, m);
        let ids: Vec<Id> = with_states(surface, |states| {
            let ids = states.data_map.get_or_insert(GlassIds::default);
            let mut ids = ids.0.borrow_mut();
            while ids.len() < groups.len() {
                ids.push(Id::new());
            }
            ids[..groups.len()].to_vec()
        });
        let ink_tint = m.ink.map_or([1.0; 3], |i| [i.tint[0] as f32, i.tint[1] as f32, i.tint[2] as f32]);
        let glass = m.glass.map(|g| glass_gl::Glass {
            tint: [g.tint[0] as f32, g.tint[1] as f32, g.tint[2] as f32],
            alpha_min: g.alpha_min as f32,
            alpha_max: g.alpha_max as f32,
            target: g.target_luminance as f32,
            rim: g.rim as f32,
            saturation: g.saturation as f32,
            ink_tint,
        });
        // The ink is measured only where the compositor paints the glass: it is that glass's
        // tint the decision changes.
        let ink_boxes: Vec<glass_gl::InkBox> = if m.ink.is_some() && glass.is_some() {
            m.ink_boxes
                .iter()
                .map(|b| glass_gl::InkBox {
                    id: b.id,
                    rect: Rectangle::new(
                        location.to_f64() + Point::from((b.x * scale.x, b.y * scale.y)),
                        (b.w * scale.x, b.h * scale.y).into(),
                    ),
                })
                .collect()
        } else {
            Vec::new()
        };
        let surface_weak = surface.downgrade();
        groups
            .into_iter()
            .zip(ids)
            .map(|((region, mut shapes), id)| {
                let center = |b: &glass_gl::InkBox| {
                    Point::<f64, Physical>::from((b.rect.loc.x + b.rect.size.w / 2.0, b.rect.loc.y + b.rect.size.h / 2.0))
                };
                let mine: Vec<glass_gl::InkBox> = ink_boxes
                    .iter()
                    .filter(|b| shapes.iter().any(|s| s.rect.contains(center(b))))
                    .copied()
                    .collect();
                // A dark group darkens no shape: the topmost shape holding one of its boxes
                // wears the light veil.
                for b in mine.iter().filter(|b| current.dark_ink.contains(&b.id)) {
                    if let Some(s) = shapes.iter_mut().rev().find(|s| s.rect.contains(center(b))) {
                        s.ink_dark = true;
                    }
                }
                let probes = if glass.is_some() {
                    shapes.iter().filter(|s| shadowed.contains(&s.index)).filter_map(|s| probe(s, scrims)).collect()
                } else {
                    Vec::new()
                };
                let formed = shapes.iter().map(|s| s.opacity).fold(0.0, f32::max);
                GlassElement {
                    formed,
                    id,
                    commit: current.commit,
                    region,
                    probes,
                    shapes,
                    offset: (m.blur_size * scale.x) as f32,
                    passes: m.blur_passes as usize,
                    glass,
                    ink_boxes: mine,
                    surface: surface_weak.clone(),
                    finish: glass_gl::Finish::NEUTRAL,
                }
            })
            .collect()
    }

    /// A window's backdrop (render/window.rs): one shape, the window's rounded box, blurred
    /// and finished like Hyprland's window blur — no refraction, no tint, no ink.
    #[allow(clippy::too_many_arguments)]
    pub fn backdrop(
        id: Id,
        commit: CommitCounter,
        rect: Rectangle<f64, Physical>,
        radius: f64,
        exponent: f64,
        offset: f64,
        passes: u32,
        finish: glass_gl::Finish,
        output_size: smithay::utils::Size<i32, Physical>,
        surface: &WlSurface,
    ) -> Option<GlassElement> {
        let reach = offset * 2f64.powi(passes as i32 + 1);
        let grown = Rectangle::<f64, Physical>::new(rect.loc - Point::from((reach, reach)), (rect.size.w + 2.0 * reach, rect.size.h + 2.0 * reach).into());
        let region = grown.to_i32_round::<i32>().intersection(Rectangle::from_size(output_size))?;
        (region.size.w >= 2 && region.size.h >= 2 && passes > 0).then(|| GlassElement {
            id,
            commit,
            region,
            shapes: vec![glass_gl::Shape {
                index: 0,
                rect,
                radius,
                exponent,
                opacity: 1.0,
                clip: None,
                ink_dark: false,
                pointer: None,
                refraction: 0.0,
                px_scale: 1.0,
                fusion: None,
                fusion_merge: 0.0,
            }],
            offset: offset as f32,
            passes: passes as usize,
            formed: 1.0,
            glass: None,
            ink_boxes: Vec::new(),
            probes: Vec::new(),
            surface: surface.downgrade(),
            finish,
        })
    }

    fn capture_gles(&self, frame: &mut smithay::backend::renderer::gles::GlesFrame<'_, '_>, cache: &UserDataMap) -> Result<(), GlesError> {
        let projection = *frame.projection();
        let user_data = frame.egl_context().user_data() as *const UserDataMap;
        cache.insert_if_missing(|| RefCell::new(glass_gl::Cache::default()));
        let mut c = cache.get::<RefCell<glass_gl::Cache>>().unwrap().borrow_mut();
        frame.with_context(|gl| unsafe {
            // Safety: the EGL context outlives this frame, and its user data with it.
            let user_data = &*user_data;
            let map = glass_gl::FrameMap { projection, fb_size: glass_gl::fb_size(gl) };
            // Measured on the full blur while it forms: there is something to measure.
            let measure_full = self.glass.is_some() && (!self.ink_boxes.is_empty() || !self.probes.is_empty());
            glass_gl::capture(
                gl, user_data, map, self.region, self.offset, self.passes, self.formed, measure_full, &self.finish, &mut c,
            );
        })
    }

    fn draw_gles(
        &self,
        frame: &mut smithay::backend::renderer::gles::GlesFrame<'_, '_>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        cache: Option<&UserDataMap>,
    ) -> Result<(), GlesError> {
        let Some(c) = cache.and_then(|c| c.get::<RefCell<glass_gl::Cache>>()) else { return Ok(()) };
        let mut c = c.borrow_mut();
        let projection = *frame.projection();
        let user_data = frame.egl_context().user_data() as *const UserDataMap;
        // Damage is relative to the element; the GL side works in output pixels.
        let clip: Vec<_> = damage
            .iter()
            .map(|d| Rectangle::new(d.loc + dst.loc, d.size))
            .collect();
        frame.with_context(|gl| unsafe {
            let user_data = &*user_data;
            let map = glass_gl::FrameMap { projection, fb_size: glass_gl::fb_size(gl) };
            if let Some(g) = &self.glass {
                glass_gl::measure_ink(gl, user_data, map, &mut c, &self.ink_boxes, &self.probes, g.saturation, &self.surface);
            }
            glass_gl::draw(gl, user_data, map, &c, &self.shapes, &clip, self.glass.as_ref(), &self.finish);
        })
    }
}

impl Element for GlassElement {
    fn id(&self) -> &Id {
        &self.id
    }

    fn current_commit(&self) -> CommitCounter {
        self.commit
    }

    fn src(&self) -> Rectangle<f64, BufferCoords> {
        Rectangle::from_size((self.region.size.w as f64, self.region.size.h as f64).into())
    }

    fn geometry(&self, _scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.region
    }

    fn kind(&self) -> Kind {
        Kind::Unspecified
    }

    fn is_framebuffer_effect(&self) -> bool {
        true
    }
}

impl<R: HyaloRenderer> RenderElement<R> for GlassElement {
    fn draw(
        &self,
        frame: &mut R::Frame<'_, '_>,
        _src: Rectangle<f64, BufferCoords>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        _opaque_regions: &[Rectangle<i32, Physical>],
        cache: Option<&UserDataMap>,
    ) -> Result<(), R::Error> {
        self.draw_gles(R::gles_frame(frame), dst, damage, cache).map_err(R::from_gles_error)
    }

    fn capture_framebuffer(
        &self,
        frame: &mut R::Frame<'_, '_>,
        _src: Rectangle<f64, BufferCoords>,
        _dst: Rectangle<i32, Physical>,
        cache: &UserDataMap,
    ) -> Result<(), R::Error> {
        self.capture_gles(R::gles_frame(frame), cache).map_err(R::from_gles_error)
    }
}

/// Two shapes formed this alike (#764) share a blur: an animation moves a pane's shapes together.
const FORMED_ALIKE: f32 = 0.01;

/// Where to measure the backdrop under one shape for its shadow: its body, inset by where a
/// round corner leaves the rectangle (0.29 of the radius, the corner's 45° point), cut by its
/// clip; and what of the backdrop there the shadow drawn this frame already takes.
fn probe(s: &glass_gl::Shape, scrims: &[super::scrim::ScrimPx]) -> Option<glass_gl::LightProbe> {
    let inset = s.radius * 0.29;
    let mut r = Rectangle::<f64, Physical>::new(
        s.rect.loc + Point::from((inset, inset)),
        ((s.rect.size.w - 2.0 * inset).max(1.0), (s.rect.size.h - 2.0 * inset).max(1.0)).into(),
    );
    if let Some(c) = s.clip {
        r = r.intersection(c)?;
    }
    let centre = Point::from((r.loc.x + r.size.w / 2.0, r.loc.y + r.size.h / 2.0));
    let shadow = super::scrim::alpha_at(scrims, centre).min(0.95);
    Some(glass_gl::LightProbe { shape: s.index, rect: r, unscale: (1.0 / (1.0 - shadow)) as f32 })
}

/// A material's shapes in output pixels, grouped where their blur reaches overlap, each group
/// with the region it blurs: its bounds grown by how far the kawase chain reaches.
fn groups(
    size: smithay::utils::Size<i32, Physical>,
    scale: Scale<f64>,
    location: Point<i32, Physical>,
    m: &material::MaterialState,
) -> Vec<(Rectangle<i32, Physical>, Vec<glass_gl::Shape>)> {
    // The refractive edge reads the backdrop from INSIDE the shape (glass_gl.rs), so this is all.
    let reach = m.blur_size * scale.x * 2f64.powi(m.blur_passes as i32 + 1);
    let grow = |r: &Rectangle<f64, Physical>| {
        Rectangle::<f64, Physical>::new(
            r.loc - Point::from((reach, reach)),
            (r.size.w + 2.0 * reach, r.size.h + 2.0 * reach).into(),
        )
    };
    let shapes: Vec<glass_gl::Shape> = m
        .shapes
        .iter()
        .enumerate()
        .map(|(index, s)| glass_gl::Shape {
            index,
            rect: Rectangle::new(
                location.to_f64() + Point::from((s.x * scale.x, s.y * scale.y)),
                (s.w * scale.x, s.h * scale.y).into(),
            ),
            radius: s.radius * scale.x,
            exponent: s.exponent,
            opacity: s.opacity as f32,
            clip: s.clip.map(|c| {
                Rectangle::new(
                    location.to_f64() + Point::from((c[0] * scale.x, c[1] * scale.y)),
                    (c[2] * scale.x, c[3] * scale.y).into(),
                )
            }),
            ink_dark: false,
            refraction: m.refraction_of(s) * scale.x,
            px_scale: scale.x,
            fusion: s.fusion.map(|f| (f.group, 2.0 * f.spacing * scale.x)),
            fusion_merge: s.fusion.map_or(0.0, |f| f.merge),
            pointer: s.pointer.and_then(|p| {
                let at = |q: [f64; 2]| {
                    let o = location.to_f64() + Point::from((q[0] * scale.x, q[1] * scale.y));
                    [o.x, o.y]
                };
                glass_gl::PointerPx::new(
                    at(p.base), at(p.tip), p.width * scale.x, p.tip_radius * scale.x, p.base_radius * scale.x,
                )
            }),
        })
        .collect();
    let mut root: Vec<usize> = (0..shapes.len()).collect();
    fn find(g: &mut [usize], mut i: usize) -> usize {
        while g[i] != i {
            g[i] = g[g[i]];
            i = g[i];
        }
        i
    }
    for a in 0..shapes.len() {
        for b in a + 1..shapes.len() {
            // A fusion group is one silhouette: one element, whatever lies between its shapes.
            let fused = shapes[a].fusion.is_some() && shapes[a].fusion.map(|f| f.0) == shapes[b].fusion.map(|f| f.0);
            // A pane forming (#764) has a blur of its own, its reach growing: it shares no
            // pyramid with panes at rest beside it (the Control Center under the bar's capsules).
            let formed_alike = (shapes[a].opacity - shapes[b].opacity).abs() < FORMED_ALIKE;
            if fused || (formed_alike && grow(&shapes[a].bounds()).overlaps(grow(&shapes[b].bounds()))) {
                let (ra, rb) = (find(&mut root, a), find(&mut root, b));
                root[ra] = rb;
            }
        }
    }
    let mut by_root: std::collections::BTreeMap<usize, Vec<glass_gl::Shape>> = Default::default();
    for (i, s) in shapes.into_iter().enumerate() {
        let r = find(&mut root, i);
        by_root.entry(r).or_default().push(s);
    }
    // Forming groups LAST — drawn first, below the rest of the surface's glass — so what a forming
    // pane captures never holds a neighbour's finished glass.
    let mut by_root: Vec<Vec<glass_gl::Shape>> = by_root.into_values().collect();
    by_root.sort_by_key(|g| g.iter().all(|s| s.opacity >= 1.0) as u8 ^ 1);
    by_root
        .into_iter()
        .filter_map(|shapes| {
            let mut bounds = shapes[0].bounds();
            for s in &shapes[1..] {
                bounds = bounds.merge(s.bounds());
            }
            let region = grow(&bounds).to_i32_round::<i32>().intersection(Rectangle::from_size(size))?;
            (region.size.w >= 2 && region.size.h >= 2).then_some((region, shapes))
        })
        .collect()
}
