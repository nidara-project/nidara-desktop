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
    glass: Option<glass_gl::Glass>,
    /// The ink boxes that fall in this group (v3), measured when the capture or they change.
    ink_boxes: Vec<glass_gl::InkBox>,
    surface: Weak<WlSurface>,
}

/// One id per group of a surface's shapes, stable across frames.
#[derive(Default)]
struct GlassIds(RefCell<Vec<Id>>);

impl GlassElement {
    /// The glass elements of `surface`, placed at `location` (its origin, output pixels):
    /// one per group of shapes whose blurs would overlap.
    pub fn for_surface(
        surface: &WlSurface,
        location: Point<i32, Physical>,
        scale: Scale<f64>,
        output_size: smithay::utils::Size<i32, Physical>,
    ) -> Vec<GlassElement> {
        let Some(current) = material::current(surface) else { return Vec::new() };
        let m = &current.state;
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
                GlassElement {
                    id,
                    commit: current.commit,
                    region,
                    shapes,
                    offset: (m.blur_size * scale.x) as f32,
                    passes: m.blur_passes as usize,
                    glass,
                    ink_boxes: mine,
                    surface: surface_weak.clone(),
                }
            })
            .collect()
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
            glass_gl::capture(gl, user_data, map, self.region, self.offset, self.passes, &mut c);
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
                glass_gl::measure_ink(gl, user_data, map, &mut c, &self.ink_boxes, g.saturation, &self.surface);
            }
            glass_gl::draw(gl, user_data, map, &c, &self.shapes, &clip, self.glass.as_ref());
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

/// A material's shapes in output pixels, grouped where their blur reaches overlap, each group
/// with the region it blurs: its bounds grown by how far the kawase chain reaches.
fn groups(
    size: smithay::utils::Size<i32, Physical>,
    scale: Scale<f64>,
    location: Point<i32, Physical>,
    m: &material::MaterialState,
) -> Vec<(Rectangle<i32, Physical>, Vec<glass_gl::Shape>)> {
    let blur_reach = m.blur_size * scale.x * 2f64.powi(m.blur_passes as i32 + 1);
    // Plus how far the refractive glass's edge reads from outside the shape.
    let grow = |r: &Rectangle<f64, Physical>, refraction: f64| {
        let reach = blur_reach + refraction;
        Rectangle::<f64, Physical>::new(
            r.loc - Point::from((reach, reach)),
            (r.size.w + 2.0 * reach, r.size.h + 2.0 * reach).into(),
        )
    };
    let shapes: Vec<glass_gl::Shape> = m
        .shapes
        .iter()
        .map(|s| glass_gl::Shape {
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
            if grow(&shapes[a].bounds(), shapes[a].refraction).overlaps(grow(&shapes[b].bounds(), shapes[b].refraction)) {
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
    by_root
        .into_values()
        .filter_map(|shapes| {
            let mut bounds = shapes[0].bounds();
            for s in &shapes[1..] {
                bounds = bounds.merge(s.bounds());
            }
            let most = shapes.iter().map(|s| s.refraction).fold(0.0, f64::max);
            let region = grow(&bounds, most).to_i32_round::<i32>().intersection(Rectangle::from_size(size))?;
            (region.size.w >= 2 && region.size.h >= 2).then_some((region, shapes))
        })
        .collect()
}
