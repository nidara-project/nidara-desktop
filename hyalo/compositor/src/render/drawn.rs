//! A surface's drawn region (`nidara-material-v1` set_drawn_region, #761): its content is drawn
//! only inside it. The bar and the dock are layers the size of the monitor that paint a strip and
//! whatever panel is open; everywhere else their pixels are transparent, and without this every
//! damage under them — a video under the dock — was blended through those empty pixels: measured
//! in the session at 9 % of Hyalo's GPU time per frame for the two of them (#761).
//!
//! Two elements: `Clipped` wraps each of the surface tree's elements and draws, and reports
//! damage, only inside the region; `DrawnChange` draws nothing and reports where the region
//! itself changed, so what appeared or went is repainted even when the client's buffer did not
//! change there (the region lands on a commit, not necessarily with new pixels).

use smithay::{
    backend::renderer::{
        element::{Element, Id, Kind, RenderElement, UnderlyingStorage},
        utils::{CommitCounter, DamageSet, DamageSnapshot, OpaqueRegions},
    },
    utils::{Buffer as BufferCoords, Logical, Physical, Point, Rectangle, Scale, Transform, user_data::UserDataMap},
};

/// A surface-local logical rectangle on the output, grown outward to whole pixels: a region one
/// pixel short is a column of the surface not drawn.
fn on_output(r: Rectangle<i32, Logical>, origin: Point<i32, Physical>, scale: Scale<f64>) -> Rectangle<i32, Physical> {
    let r = r.to_f64().to_physical(scale);
    let (x0, y0) = (r.loc.x.floor() as i32, r.loc.y.floor() as i32);
    let (x1, y1) = ((r.loc.x + r.size.w).ceil() as i32, (r.loc.y + r.size.h).ceil() as i32);
    Rectangle::new((origin.x + x0, origin.y + y0).into(), (x1 - x0, y1 - y0).into())
}

/// The region on the output, for a surface whose tree is drawn at `origin`.
pub fn region_on_output(rects: &[Rectangle<i32, Logical>], origin: Point<i32, Physical>, scale: Scale<f64>) -> Vec<Rectangle<i32, Physical>> {
    rects.iter().map(|r| on_output(*r, origin, scale)).collect()
}

/// `rects` cut to `within` (output pixels), relative to `within`'s corner: what an element's
/// damage and draw speak.
fn local(rects: &[Rectangle<i32, Physical>], within: Rectangle<i32, Physical>) -> Vec<Rectangle<i32, Physical>> {
    rects
        .iter()
        .filter_map(|r| r.intersection(within))
        .map(|mut r| {
            r.loc -= within.loc;
            r
        })
        .collect()
}

/// `a` ∩ `b`, every pair.
fn cut(a: &[Rectangle<i32, Physical>], b: &[Rectangle<i32, Physical>]) -> Vec<Rectangle<i32, Physical>> {
    a.iter().flat_map(|x| b.iter().filter_map(|y| x.intersection(*y))).collect()
}

/// One element of a surface tree, drawn only inside the surface's drawn region.
#[derive(Debug)]
pub struct Clipped<E> {
    pub inner: E,
    /// Output pixels.
    pub region: Vec<Rectangle<i32, Physical>>,
}

impl<E: Element> Element for Clipped<E> {
    fn id(&self) -> &Id {
        self.inner.id()
    }
    fn current_commit(&self) -> CommitCounter {
        self.inner.current_commit()
    }
    fn location(&self, scale: Scale<f64>) -> Point<i32, Physical> {
        self.inner.location(scale)
    }
    fn src(&self) -> Rectangle<f64, BufferCoords> {
        self.inner.src()
    }
    fn transform(&self) -> Transform {
        self.inner.transform()
    }
    fn geometry(&self, scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.inner.geometry(scale)
    }
    /// Only what changed inside the region: damage the client sends for pixels that are never
    /// drawn repaints nothing.
    fn damage_since(&self, scale: Scale<f64>, commit: Option<CommitCounter>) -> DamageSet<i32, Physical> {
        let region = local(&self.region, self.geometry(scale));
        DamageSet::from_slice(&cut(&self.inner.damage_since(scale, commit), &region))
    }
    fn opaque_regions(&self, scale: Scale<f64>) -> OpaqueRegions<i32, Physical> {
        let region = local(&self.region, self.geometry(scale));
        OpaqueRegions::from_slice(&cut(&self.inner.opaque_regions(scale), &region))
    }
    fn alpha(&self) -> f32 {
        self.inner.alpha()
    }
    fn kind(&self) -> Kind {
        self.inner.kind()
    }
}

impl<R: smithay::backend::renderer::Renderer, E: RenderElement<R>> RenderElement<R> for Clipped<E> {
    /// The damage the tracker hands in, cut to the region: outside it nothing is sampled or
    /// blended — the whole point.
    fn draw(
        &self,
        frame: &mut R::Frame<'_, '_>,
        src: Rectangle<f64, BufferCoords>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        opaque_regions: &[Rectangle<i32, Physical>],
        cache: Option<&UserDataMap>,
    ) -> Result<(), R::Error> {
        let damage = cut(damage, &local(&self.region, dst));
        if damage.is_empty() {
            return Ok(());
        }
        self.inner.draw(frame, src, dst, &damage, opaque_regions, cache)
    }

    /// Never scanned out: a plane would show the whole buffer.
    fn underlying_storage(&self, _renderer: &mut R) -> Option<UnderlyingStorage<'_>> {
        None
    }
}

/// Where a surface's drawn region changed: draws nothing, damages what appeared or went.
#[derive(Debug)]
pub struct DrawnChange {
    id: Id,
    changes: DamageSnapshot<i32, Logical>,
    /// The surface tree's box, output pixels.
    geometry: Rectangle<i32, Physical>,
    /// Where the surface's (0, 0) is drawn, output pixels.
    origin: Point<i32, Physical>,
    scale: Scale<f64>,
}

impl DrawnChange {
    pub fn new(
        id: Id,
        changes: DamageSnapshot<i32, Logical>,
        tree: Rectangle<i32, Logical>,
        origin: Point<i32, Physical>,
        scale: Scale<f64>,
    ) -> Self {
        let geometry = on_output(tree, origin, scale);
        Self { id, changes, geometry, origin, scale }
    }
}

impl Element for DrawnChange {
    fn id(&self) -> &Id {
        &self.id
    }
    fn current_commit(&self) -> CommitCounter {
        self.changes.current_commit()
    }
    fn src(&self) -> Rectangle<f64, BufferCoords> {
        Rectangle::from_size((self.geometry.size.w as f64, self.geometry.size.h as f64).into())
    }
    fn geometry(&self, _scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.geometry
    }
    fn damage_since(&self, _scale: Scale<f64>, commit: Option<CommitCounter>) -> DamageSet<i32, Physical> {
        match self.changes.damage_since(commit) {
            Some(changes) => {
                let rects: Vec<_> = changes.iter().map(|r| on_output(*r, self.origin, self.scale)).collect();
                DamageSet::from_slice(&local(&rects, self.geometry))
            }
            // Too old to tell (or never seen): all of it.
            None => DamageSet::from_slice(&[Rectangle::from_size(self.geometry.size)]),
        }
    }
    fn kind(&self) -> Kind {
        Kind::Unspecified
    }
}

impl<R: smithay::backend::renderer::Renderer> RenderElement<R> for DrawnChange {
    fn draw(
        &self,
        _frame: &mut R::Frame<'_, '_>,
        _src: Rectangle<f64, BufferCoords>,
        _dst: Rectangle<i32, Physical>,
        _damage: &[Rectangle<i32, Physical>],
        _opaque_regions: &[Rectangle<i32, Physical>],
        _cache: Option<&UserDataMap>,
    ) -> Result<(), R::Error> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_region_reaches_whole_pixels_outward() {
        let r = Rectangle::<i32, Logical>::new((10, 20).into(), (101, 33).into());
        let p = on_output(r, (5, 0).into(), Scale::from(1.25));
        // 12.5 → 12, 25 → 25; (10+101)*1.25 = 138.75 → 139, (20+33)*1.25 = 66.25 → 67.
        assert_eq!(p, Rectangle::new((17, 25).into(), (127, 42).into()));
    }

    #[test]
    fn damage_outside_the_region_is_dropped_and_inside_is_kept() {
        let region = vec![Rectangle::<i32, Physical>::new((0, 1300).into(), (2560, 140).into())];
        let geo = Rectangle::<i32, Physical>::from_size((2560, 1440).into());
        let video = Rectangle::new((5, 45).into(), (2550, 1294).into());
        let kept = cut(&[video], &local(&region, geo));
        assert_eq!(kept, vec![Rectangle::new((5, 1300).into(), (2550, 39).into())], "only the strip the dock draws in");
        let above = Rectangle::new((0, 0).into(), (2560, 1200).into());
        assert!(cut(&[above], &local(&region, geo)).is_empty(), "nothing over the empty part");
    }
}
