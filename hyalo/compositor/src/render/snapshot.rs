//! A window drawn on its own into a texture of ours — its surfaces, popups, corners, controls or
//! title bar, line and shadow, as the screen shows them — so it can be drawn scaled and faded
//! as ONE picture (wm/motion.rs): a window opening, drawn again every frame of it, and one
//! closing, drawn once as it was when its app destroyed it (its surfaces go right after).
//!
//! What a picture leaves out: the blur behind a translucent window and the glass a client
//! declares (`nidara-material-v1`), which sample what is behind them on the screen, and here
//! there is nothing behind them.
//!
//! Drawn with the GL renderer underneath (`HyaloRenderer::gles`, the GPU that renders), like a
//! screenshot: on tty the surfaces are imported for it first (`import_surface_tree`), as for a
//! window capture (capture.rs).

use smithay::{
    backend::{
        allocator::Fourcc,
        renderer::{
            Bind, Color32F, Offscreen,
            damage::OutputDamageTracker,
            element::{Element, Id, Kind, RenderElement},
            gles::{GlesRenderer, GlesTexture},
            utils::{CommitCounter, import_surface_tree},
        },
    },
    desktop::{PopupManager, Window},
    utils::{Buffer as BufferCoords, Logical, Physical, Point, Rectangle, Scale, Size, Transform, user_data::UserDataMap},
};

use super::{HyaloRenderer, OutputElement, Scene};

/// A picture of a window.
#[derive(Debug)]
pub struct Snapshot {
    pub texture: GlesTexture,
    /// The texture's size, physical px.
    pub size: Size<i32, Physical>,
    /// Where the window's whole box (its title bar included) is in it, physical px: around
    /// it, room for its shadow.
    pub frame: Rectangle<f64, Physical>,
    /// The scale it was drawn at (its output's).
    pub scale: f64,
    /// Which picture it is, for the damage tracker; its commit moves on every time it is
    /// drawn, since it is drawn faded a little further each frame.
    pub id: Id,
    pub commit: std::cell::Cell<CommitCounter>,
}

/// Room around the box for its line and its shadow, logical px.
fn margin(cfg: &crate::config::WindowsConfig) -> f64 {
    let s = &cfg.shadow;
    let reach = |l: &crate::config::ShadowLook| l.range + l.offset.abs();
    cfg.border.width + reach(&s.active).max(reach(&s.inactive)) + 2.0
}

/// `window` alone at `scale`, as it is now.
pub fn take(gles: &mut GlesRenderer, scene: &Scene<'_>, window: &Window, scale: f64) -> Result<Snapshot, String> {
    let m = scene.wm.by_window(window).ok_or("not a window of ours")?;
    let surface = window.toplevel().ok_or("not a toplevel")?.wl_surface().clone();
    import_surface_tree(gles, &surface).map_err(|e| format!("{e:?}"))?;
    for (popup, _) in PopupManager::popups_for_surface(&surface) {
        import_surface_tree(gles, popup.wl_surface()).map_err(|e| format!("{e:?}"))?;
    }
    let frame = m.frame().to_f64();
    let pad = margin(scene.windows);
    let logical: Size<f64, Logical> = (frame.size.w + 2.0 * pad, frame.size.h + 2.0 * pad).into();
    let size = logical.to_physical_precise_round(scale);
    if size.w <= 0 || size.h <= 0 {
        return Err("an empty window".into());
    }
    let mut texture: GlesTexture = gles.create_buffer(Fourcc::Abgr8888, (size.w, size.h).into()).map_err(|e| e.to_string())?;
    let mut elements: Vec<OutputElement<GlesRenderer>> = Vec::new();
    let place = crate::wm::minimize::Placement { origin: (pad, pad).into(), scale: 1.0 };
    super::push_window(&mut elements, gles, scene, window, Some(place), Point::from((0, 0)), Scale::from(scale), size);
    // What samples the screen behind it: nothing is behind it here.
    elements.retain(|e| !matches!(e, OutputElement::Glass(_) | OutputElement::Scrim(_)));
    let mut tracker = OutputDamageTracker::new(size, scale, Transform::Normal);
    {
        let mut fb = gles.bind(&mut texture).map_err(|e| e.to_string())?;
        tracker
            .render_output(gles, &mut fb, 0, &elements, Color32F::new(0.0, 0.0, 0.0, 0.0))
            .map_err(|e| format!("{e:?}"))?;
    }
    let frame = Rectangle::new(Point::<f64, Logical>::from((pad, pad)).to_physical(scale), frame.size.to_physical(scale));
    Ok(Snapshot { texture, size, frame, scale, id: Id::new(), commit: Default::default() })
}

/// A picture drawn on screen: its window's box at `frame` (output physical px) scaled about
/// its middle by `k`, faded to `alpha`.
#[derive(Debug)]
pub struct SnapshotElement {
    id: Id,
    commit: CommitCounter,
    texture: GlesTexture,
    size: Size<i32, Physical>,
    geometry: Rectangle<i32, Physical>,
    alpha: f32,
}

impl SnapshotElement {
    pub fn new(
        snapshot: &Snapshot,
        frame: Rectangle<f64, Physical>,
        k: f64,
        alpha: f64,
    ) -> Self {
        // The picture's box lands on `frame` scaled about its middle: a point `q` of the
        // picture goes to `centre + (q − box centre) × k × (frame / box)`.
        let fx = frame.size.w / snapshot.frame.size.w.max(1.0) * k;
        let fy = frame.size.h / snapshot.frame.size.h.max(1.0) * k;
        let centre = frame.loc + frame.size.to_point().downscale(2.0);
        let box_centre = snapshot.frame.loc + snapshot.frame.size.to_point().downscale(2.0);
        let loc = Point::<f64, Physical>::from((centre.x - box_centre.x * fx, centre.y - box_centre.y * fy));
        let size = Size::<f64, Physical>::from((snapshot.size.w as f64 * fx, snapshot.size.h as f64 * fy));
        let geometry = Rectangle::new(loc.to_i32_round(), size.to_i32_round());
        let mut commit = snapshot.commit.get();
        commit.increment();
        snapshot.commit.set(commit);
        Self {
            id: snapshot.id.clone(),
            commit,
            texture: snapshot.texture.clone(),
            size: snapshot.size,
            geometry,
            alpha: alpha.clamp(0.0, 1.0) as f32,
        }
    }
}

impl Element for SnapshotElement {
    fn id(&self) -> &Id {
        &self.id
    }

    fn current_commit(&self) -> CommitCounter {
        self.commit
    }

    fn src(&self) -> Rectangle<f64, BufferCoords> {
        Rectangle::from_size((self.size.w as f64, self.size.h as f64).into())
    }

    fn geometry(&self, _scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.geometry
    }

    fn alpha(&self) -> f32 {
        self.alpha
    }

    fn kind(&self) -> Kind {
        Kind::Unspecified
    }
}

impl<R: HyaloRenderer> RenderElement<R> for SnapshotElement {
    fn draw(
        &self,
        frame: &mut R::Frame<'_, '_>,
        src: Rectangle<f64, BufferCoords>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        opaque_regions: &[Rectangle<i32, Physical>],
        _cache: Option<&UserDataMap>,
    ) -> Result<(), R::Error> {
        R::gles_frame(frame)
            .render_texture_from_to(&self.texture, src, dst, damage, opaque_regions, Transform::Normal, self.alpha, None, &[])
            .map_err(R::from_gles_error)
    }
}
