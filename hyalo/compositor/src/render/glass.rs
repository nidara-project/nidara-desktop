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
    /// The saturation the ink is measured with: the group's first tone's (the glass's own
    /// treatment of the backdrop before the rest of its tone).
    ink_saturation: f32,
    surface: Weak<WlSurface>,
    /// Hyprland's blur finishing: a window's backdrop has it (render/window.rs), the shell's
    /// glass does not.
    finish: glass_gl::Finish,
    /// The glass's soft blur, output px (`glass_gl::BlurMix`): where the compositor paints the
    /// glass it mixes three blurs by each shape's size. None: the chain's blur alone.
    soft: Option<f32>,
}

/// One id per group of a surface's shapes, stable across frames: its own material's, and the
/// glass Hyalo paints for it (its window controls').
#[derive(Default)]
struct GlassIds(RefCell<Vec<Id>>);
#[derive(Default)]
struct OwnGlassIds(RefCell<Vec<Id>>);

/// Whose glass a surface's elements are: the material its client declared, or glass Hyalo
/// paints over it of its own (the window controls', render/controls.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Whose {
    Client,
    Hyalo,
}

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
        Self::for_material(surface, Whose::Client, &current, location, scale, output_size)
    }

    /// The glass elements of `current`, a material of `surface`'s (its client's, or one Hyalo
    /// made for it), placed at `location`.
    pub fn for_material(
        surface: &WlSurface,
        whose: Whose,
        current: &material::Current,
        location: Point<i32, Physical>,
        scale: Scale<f64>,
        output_size: smithay::utils::Size<i32, Physical>,
    ) -> Vec<GlassElement> {
        let m = &current.state;
        let groups = groups(output_size, scale, location, m);
        let ids: Vec<Id> = with_states(surface, |states| {
            let grow = |ids: &mut Vec<Id>| {
                while ids.len() < groups.len() {
                    ids.push(Id::new());
                }
                ids[..groups.len()].to_vec()
            };
            match whose {
                Whose::Client => grow(&mut states.data_map.get_or_insert(GlassIds::default).0.borrow_mut()),
                Whose::Hyalo => grow(&mut states.data_map.get_or_insert(OwnGlassIds::default).0.borrow_mut()),
            }
        });
        let glass = m.glass.map(|g| glass_gl::Glass { rim: g.rim as f32 });
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
            .map(|((region, mut shapes, blur), id)| {
                let center = |b: &glass_gl::InkBox| {
                    Point::<f64, Physical>::from((b.rect.loc.x + b.rect.size.w / 2.0, b.rect.loc.y + b.rect.size.h / 2.0))
                };
                let mine: Vec<glass_gl::InkBox> = ink_boxes
                    .iter()
                    .filter(|b| shapes.iter().any(|s| s.rect.contains(center(b))))
                    .copied()
                    .collect();
                // A dark group's content sits on the topmost shape holding one of its boxes:
                // that shape takes its ink tone.
                for b in mine.iter().filter(|b| current.dark_ink.contains(&b.id)) {
                    if let Some(s) = shapes.iter_mut().rev().find(|s| s.rect.contains(center(b))) {
                        s.ink_dark = true;
                        if let Some(t) = m.shapes.get(s.index).and_then(|ms| ms.ink_tone) {
                            s.tone = glass_gl::ToneGl::new(&t, m.shapes[s.index].w.min(m.shapes[s.index].h), scale.x);
                        }
                    }
                }
                let ink_saturation = m.shapes.iter().find_map(|s| s.tone).map_or(1.0, |t| t.saturation as f32);
                let formed = shapes.iter().map(|s| s.opacity).fold(0.0, f32::max);
                GlassElement {
                    formed,
                    id,
                    commit: current.commit,
                    region,
                    ink_saturation,
                    shapes,
                    offset: (blur.size * scale.x) as f32,
                    passes: blur.passes as usize,
                    glass,
                    ink_boxes: mine,
                    surface: surface_weak.clone(),
                    finish: glass_gl::Finish::NEUTRAL,
                    // The capture's three blurs: mixed by size where the compositor paints the
                    // glass, walked from sharp to full where a shape is graded.
                    soft: (m.glass.is_some() || m.shapes.iter().any(|s| s.grade.is_some()))
                        .then_some((glass_gl::BlurMix::SOFT * scale.x) as f32),
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
                tone: glass_gl::ToneGl::NONE,
                blur_mix: glass_gl::BlurMix::FULL,
                pointer: None,
                refraction: 0.0,
                px_scale: 1.0,
                fusion: None,
                fusion_merge: 0.0,
                grade: [1.0, 1.0],
            }],
            offset: offset as f32,
            passes: passes as usize,
            formed: 1.0,
            glass: None,
            ink_boxes: Vec::new(),
            ink_saturation: 1.0,
            surface: surface.downgrade(),
            finish,
            soft: None,
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
            let measure_full = self.glass.is_some() && !self.ink_boxes.is_empty();
            glass_gl::capture(
                gl, user_data, map, self.region, self.offset, self.passes, self.formed, measure_full, self.soft, &self.finish, &mut c,
            );
            super::stats::captured(self.region);
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
            if self.glass.is_some() {
                glass_gl::measure_ink(gl, user_data, map, &mut c, &self.ink_boxes, self.ink_saturation, &self.surface);
            }
            glass_gl::draw(gl, user_data, map, &c, &self.shapes, &clip, self.glass.as_ref(), &self.finish);
        })
    }
}

impl GlassElement {
    /// This glass `k` of the way formed (0..1), as a pane appearing forms (#764): a window
    /// opening is drawn as a picture of itself (render/snapshot.rs), which has no glass, and its
    /// glass forms under the picture as that fades in. `memo` is the window's surface data.
    pub fn forming(mut self, k: f32, memo: &UserDataMap) -> Self {
        for s in &mut self.shapes {
            s.opacity *= k;
        }
        self.formed *= k;
        (self.id, self.commit) = forming_id(memo, &self.id, self.commit, k);
        self
    }

    /// What its blur reads, output px (the debug overlay draws it: render/stats.rs).
    pub fn region(&self) -> Rectangle<i32, Physical> {
        self.region
    }

    /// This glass reading nothing outside `bounds` (output px): a layer's glass blurs its own
    /// window, whose edge repeats past it, never the desktop beside the window (toolkit/PHASE1.md
    /// D7). None when nothing of it is left.
    pub fn within(mut self, bounds: Rectangle<i32, Physical>) -> Option<Self> {
        self.region = self.region.intersection(bounds).filter(|r| r.size.w >= 2 && r.size.h >= 2)?;
        Some(self)
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

/// The ids a window's glass and veils are drawn with while it opens, by their own: what they
/// draw changes every frame, and their own ids, once it has opened, are drawn afresh.
#[derive(Default)]
struct FormingIds(RefCell<std::collections::HashMap<Id, (Id, CommitCounter, CommitCounter, u32)>>);

/// The id and commit an element `id` at `commit` is drawn with, formed `k` of the way: the
/// commit moves when either does.
pub(super) fn forming_id(memo: &UserDataMap, id: &Id, commit: CommitCounter, k: f32) -> (Id, CommitCounter) {
    let memo = memo.get_or_insert(FormingIds::default);
    let mut memo = memo.0.borrow_mut();
    let entry = memo.entry(id.clone()).or_insert_with(|| (Id::new(), CommitCounter::default(), commit, k.to_bits()));
    if entry.2 != commit || entry.3 != k.to_bits() {
        entry.1.increment();
        entry.2 = commit;
        entry.3 = k.to_bits();
    }
    (entry.0.clone(), entry.1)
}

/// Two shapes formed this alike (#764) share a blur: an animation moves a pane's shapes together.
const FORMED_ALIKE: f32 = 0.01;

/// A material's shapes in output pixels, grouped where their blur reaches overlap, each group
/// with the region it blurs — its bounds grown by how far the kawase chain reaches — and the
/// blur it is resolved with. Shapes blurred alike only (`set_shape_blur`): one pyramid has one
/// blur. A fusion group is one silhouette whatever its members' blurs, and takes the widest.
fn groups(
    size: smithay::utils::Size<i32, Physical>,
    scale: Scale<f64>,
    location: Point<i32, Physical>,
    m: &material::MaterialState,
) -> Vec<(Rectangle<i32, Physical>, Vec<glass_gl::Shape>, material::Blur)> {
    // The refractive edge reads the backdrop from INSIDE the shape (glass_gl.rs), so this is all.
    let reach_of = |b: material::Blur| b.size * scale.x * 2f64.powi(b.passes as i32 + 1);
    let blur_at = |s: &glass_gl::Shape| m.blur_of(&m.shapes[s.index]);
    let grow_by = |r: &Rectangle<f64, Physical>, reach: f64| {
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
            tone: s.tone.map_or(glass_gl::ToneGl::NONE, |t| glass_gl::ToneGl::new(&t, s.w.min(s.h), scale.x)),
            blur_mix: if m.glass.is_some() { glass_gl::BlurMix::weights(s.w.min(s.h)) } else { glass_gl::BlurMix::FULL },
            refraction: m.refraction_of(s) * scale.x,
            px_scale: scale.x,
            fusion: s.fusion.map(|f| (f.group, 2.0 * f.spacing * scale.x)),
            fusion_merge: s.fusion.map_or(0.0, |f| f.merge),
            grade: s.grade.map_or([1.0, 1.0], |g| [g[0] as f32, g[1] as f32]),
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
    let grow = |s: &glass_gl::Shape| grow_by(&s.bounds(), reach_of(blur_at(s)));
    for a in 0..shapes.len() {
        for b in a + 1..shapes.len() {
            // A fusion group is one silhouette: one element, whatever lies between its shapes.
            let fused = shapes[a].fusion.is_some() && shapes[a].fusion.map(|f| f.0) == shapes[b].fusion.map(|f| f.0);
            // A pane forming (#764) has a blur of its own, its reach growing: it shares no
            // pyramid with panes at rest beside it (the Control Center under the bar's capsules).
            let formed_alike = (shapes[a].opacity - shapes[b].opacity).abs() < FORMED_ALIKE;
            let blurred_alike = blur_at(&shapes[a]) == blur_at(&shapes[b]);
            if fused || (formed_alike && blurred_alike && grow(&shapes[a]).overlaps(grow(&shapes[b]))) {
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
            let blur = shapes
                .iter()
                .map(blur_at)
                .max_by(|a, b| reach_of(*a).total_cmp(&reach_of(*b)))
                .unwrap_or(material::Blur { size: m.blur_size, passes: m.blur_passes });
            let region = grow_by(&bounds, reach_of(blur)).to_i32_round::<i32>().intersection(Rectangle::from_size(size))?;
            (region.size.w >= 2 && region.size.h >= 2 && blur.passes > 0).then_some((region, shapes, blur))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(x: f64, y: f64, blur: Option<material::Blur>) -> material::Shape {
        material::Shape {
            x, y, w: 200.0, h: 40.0, radius: 12.0, exponent: 2.0, opacity: 1.0, clip: None, pointer: None,
            fusion: None, tone: None, ink_tone: None, blur, shadow: None, grade: None,
        }
    }

    #[test]
    fn panes_blurred_differently_share_no_pyramid_and_each_keeps_its_blur() {
        let wide = material::Blur { size: 2.0, passes: 3 };
        let m = material::MaterialState {
            // A capsule, and a menu right under it: their reaches overlap.
            shapes: vec![shape(0.0, 0.0, None), shape(0.0, 50.0, Some(wide)), shape(220.0, 0.0, None)],
            blur_size: 2.0,
            blur_passes: 2,
            ..Default::default()
        };
        let g = groups((2560, 1440).into(), Scale::from(1.0), Point::from((0, 0)), &m);
        let blurs: Vec<_> = g.iter().map(|(_, s, b)| (s.iter().map(|s| s.index).collect::<Vec<_>>(), *b)).collect();
        assert_eq!(blurs.len(), 2, "the menu alone, the capsules together: {blurs:?}");
        assert!(blurs.contains(&(vec![1], wide)));
        assert!(blurs.contains(&(vec![0, 2], material::Blur { size: 2.0, passes: 2 })));
        let menu = g.iter().find(|(_, s, _)| s[0].index == 1).unwrap().0;
        assert!(menu.loc.y <= 50 - 32, "its region reaches as far as its own blur (2·2⁴): {menu:?}");
    }

    #[test]
    fn glass_the_compositor_paints_shares_one_capture_and_mixes_its_blurs_by_each_pane_s_size() {
        let wide = material::Blur { size: 2.0, passes: 3 };
        let mut menu = shape(0.0, 50.0, Some(wide));
        menu.h = 300.0;
        let m = material::MaterialState {
            shapes: vec![shape(0.0, 0.0, None), menu, shape(220.0, 0.0, None)],
            blur_size: 2.0,
            blur_passes: 2,
            glass: Some(material::Glass { refraction: 10.0, rim: 1.0 }),
            ..Default::default()
        };
        let g = groups((2560, 1440).into(), Scale::from(1.0), Point::from((0, 0)), &m);
        assert_eq!(g.len(), 1, "one blur for all of them, whatever set_shape_blur said");
        assert_eq!(g[0].2, material::GLASS_BLUR);
        let mix = |i: usize| g[0].1.iter().find(|s| s.index == i).unwrap().blur_mix;
        assert_eq!(mix(0), glass_gl::BlurMix::SMALL, "a capsule, 40 tall");
        assert_eq!(mix(1), glass_gl::BlurMix::LARGE, "the menu, 200 by 300");
    }
}
