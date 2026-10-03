//! The ring Hyalo lays a client-side frame out in (owner, 2026-10-03: "round the web apps
//! without hiding any of their corners"). A web app of Chrome's draws its own frame with a
//! shadow margin and — tiled — square corners: cutting them to the window's curve would hide
//! what is in them (4.7 px along the diagonal at `rounding` 24, `rounding_power` 3.2). Instead
//! the layout gives the client its tile less a ring of `wm::FRAME_W` on every side, the client
//! is drawn inside its own box only (its shadow margin lies under the ring), and the ring —
//! whose outer edge carries the window's corners — continues the client's edges outward:
//!
//! - each side is the client's column (or row) one buffer pixel in from that edge, stretched
//!   across the ring — the edge as it is, row by row, not an average: a sidebar, a header and a
//!   body each continue in their own colour. One pixel in, as the title bar samples (a client's
//!   outermost row is sometimes an edge of its own, a highlight line: it stays where it is);
//! - each corner square is the client's pixel at that corner, one pixel in both ways.
//!
//! Eight draws of the client's own texture through Smithay's texture path (which knows its
//! format, transform, crop and whether it is an external image), with the window's rounded
//! shader (render/window.rs) cutting the outer corners. Nothing is drawn under the client.

use std::cell::RefCell;

use smithay::{
    backend::renderer::{
        element::{Element, Id, Kind, RenderElement},
        gles::{GlesError, GlesFrame, GlesTexProgram, GlesTexture},
        utils::{CommitCounter, DamageSet, RendererSurfaceStateUserData},
    },
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Buffer as BufferCoords, Logical, Physical, Rectangle, Scale, Transform, user_data::UserDataMap},
    wayland::compositor::with_states,
};

use super::{HyaloRenderer, glass_gl, window::rounded_uniforms};

/// A ring piece: what of the client's buffer it shows, and where, output px.
type Piece = (Rectangle<f64, BufferCoords>, Rectangle<i32, Physical>);

/// Where a client's box is in its buffer — what it has drawn as its window, whatever else the
/// buffer holds (a viewport's crop, a buffer larger than the surface) — for sampling it.
pub struct ClientBox {
    /// The box, in the buffer's logical space: `to_buffer` takes a part of it to buffer px.
    pub b: Rectangle<f64, Logical>,
    /// One buffer pixel, in that space.
    pub px: f64,
    scale: f64,
    pub transform: Transform,
    size: smithay::utils::Size<f64, Logical>,
    pub commit: CommitCounter,
}

impl ClientBox {
    /// `surface`'s box `g` (surface-local logical: `Window::geometry`), if it has drawn.
    pub fn of(surface: &WlSurface, g: Rectangle<i32, Logical>) -> Option<Self> {
        let (view, scale, transform, size, commit) = with_states(surface, |states| {
            let d = states.data_map.get::<RendererSurfaceStateUserData>()?;
            let d = d.lock().unwrap();
            Some((d.view()?, d.buffer_scale().max(1) as f64, d.buffer_transform(), d.buffer_size()?, d.current_commit()))
        })?;
        if view.dst.w <= 0 || view.dst.h <= 0 {
            return None;
        }
        // Surface-local → the buffer's logical space, through the viewport's crop and scaling.
        let (sx, sy) = (view.src.size.w / view.dst.w as f64, view.src.size.h / view.dst.h as f64);
        let b = Rectangle::new(
            (view.src.loc.x + g.loc.x as f64 * sx, view.src.loc.y + g.loc.y as f64 * sy).into(),
            (g.size.w as f64 * sx, g.size.h as f64 * sy).into(),
        );
        Some(Self { b, px: 1.0 / scale, scale, transform, size: size.to_f64(), commit })
    }

    /// A rectangle of the buffer's logical space, in buffer px.
    pub fn to_buffer(&self, x: f64, y: f64, w: f64, h: f64) -> Rectangle<f64, BufferCoords> {
        Rectangle::<f64, Logical>::new((x, y).into(), (w, h).into()).to_buffer(self.scale, self.transform, &self.size)
    }
}

#[derive(Debug, Clone)]
pub struct FrameElement {
    id: Id,
    commit: CommitCounter,
    /// The whole window — the client and its ring — output px: the element's box and the
    /// shape whose corners are cut.
    outer: Rectangle<f64, Physical>,
    geometry: Rectangle<i32, Physical>,
    radius: f64,
    exponent: f64,
    texture: GlesTexture,
    transform: Transform,
    pieces: Vec<Piece>,
    program: GlesTexProgram,
}

/// The element's id and what it last drew, kept on the window's surface.
#[derive(Default)]
struct FrameMemo(RefCell<Option<(Id, CommitCounter, String)>>);

impl FrameElement {
    /// The ring of `ring` output px around the client whose box is `geo` (output px) and `g`
    /// (surface-local logical: `Window::geometry`). None while the client has nothing drawn.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        surface: &WlSurface,
        g: Rectangle<i32, Logical>,
        geo: Rectangle<f64, Physical>,
        ring: f64,
        texture: Option<GlesTexture>,
        program: GlesTexProgram,
        outer: Rectangle<f64, Physical>,
        radius: f64,
        exponent: f64,
    ) -> Option<Self> {
        let texture = texture?;
        let cb = ClientBox::of(surface, g)?;
        let (b, px, transform, client_commit) = (cb.b, cb.px, cb.transform, cb.commit);
        // One buffer pixel in: its centre, and a sliver around it so every sample is that pixel.
        let (inset, eps) = (1.5 * px, 0.001 * px);
        if b.size.w < 3.0 * px || b.size.h < 3.0 * px {
            return None;
        }
        let (x0, x1) = (b.loc.x + inset - eps / 2.0, b.loc.x + b.size.w - inset - eps / 2.0);
        let (y0, y1) = (b.loc.y + inset - eps / 2.0, b.loc.y + b.size.h - inset - eps / 2.0);
        let src = |x: f64, y: f64, w: f64, h: f64| cb.to_buffer(x, y, w, h);
        let f = ring.round() as i32;
        let gi = geo.to_i32_round::<i32>();
        let (gx, gy, gw, gh) = (gi.loc.x, gi.loc.y, gi.size.w, gi.size.h);
        let dst = |x: i32, y: i32, w: i32, h: i32| Rectangle::<i32, Physical>::new((x, y).into(), (w, h).into());
        let (bx, by, bw, bh) = (b.loc.x, b.loc.y, b.size.w, b.size.h);
        let pieces = vec![
            (src(x0, by, eps, bh), dst(gx - f, gy, f, gh)),
            (src(x1, by, eps, bh), dst(gx + gw, gy, f, gh)),
            (src(bx, y0, bw, eps), dst(gx, gy - f, gw, f)),
            (src(bx, y1, bw, eps), dst(gx, gy + gh, gw, f)),
            (src(x0, y0, eps, eps), dst(gx - f, gy - f, f, f)),
            (src(x1, y0, eps, eps), dst(gx + gw, gy - f, f, f)),
            (src(x0, y1, eps, eps), dst(gx - f, gy + gh, f, f)),
            (src(x1, y1, eps, eps), dst(gx + gw, gy + gh, f, f)),
        ];
        let key = format!("{outer:?} {radius} {exponent} {pieces:?} {client_commit:?}");
        let (id, commit) = with_states(surface, |states| {
            let memo = states.data_map.get_or_insert(FrameMemo::default);
            let mut memo = memo.0.borrow_mut();
            let entry = memo.get_or_insert_with(|| (Id::new(), CommitCounter::default(), key.clone()));
            if entry.2 != key {
                entry.1.increment();
                entry.2 = key;
            }
            (entry.0.clone(), entry.1)
        });
        Some(Self {
            id,
            commit,
            outer,
            geometry: outer.to_i32_round::<i32>(),
            radius,
            exponent,
            texture,
            transform,
            pieces,
            program,
        })
    }

    fn draw_gles(
        &self,
        frame: &mut GlesFrame<'_, '_>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
    ) -> Result<(), GlesError> {
        let projection = *frame.projection();
        // Safety: only reads the viewport Smithay set for this frame.
        let fb = frame.with_context(|gl| unsafe { glass_gl::fb_size(gl) })?;
        let off = dst.loc - self.geometry.loc;
        let outer = Rectangle::new((self.outer.loc.x + off.x as f64, self.outer.loc.y + off.y as f64).into(), self.outer.size);
        let uniforms = rounded_uniforms(&projection, fb, outer, self.radius, self.exponent, None);
        for (src, piece) in &self.pieces {
            let at = Rectangle::new(piece.loc + off, piece.size);
            // The damage that falls on this piece, relative to it.
            let local: Vec<Rectangle<i32, Physical>> = damage
                .iter()
                .filter_map(|d| Rectangle::new(d.loc + dst.loc, d.size).intersection(at))
                .map(|d| Rectangle::new(d.loc - at.loc, d.size))
                .collect();
            if local.is_empty() || at.size.w <= 0 || at.size.h <= 0 {
                continue;
            }
            frame.render_texture_from_to(&self.texture, *src, at, &local, &[], self.transform, 1.0, Some(&self.program), &uniforms)?;
        }
        Ok(())
    }
}

impl Element for FrameElement {
    fn id(&self) -> &Id {
        &self.id
    }

    fn current_commit(&self) -> CommitCounter {
        self.commit
    }

    fn src(&self) -> Rectangle<f64, BufferCoords> {
        Rectangle::from_size((self.geometry.size.w as f64, self.geometry.size.h as f64).into())
    }

    fn geometry(&self, _scale: Scale<f64>) -> Rectangle<i32, Physical> {
        self.geometry
    }

    /// The ring only: its box is the whole window, and a client's frame must not damage the
    /// client's whole box a second time.
    fn damage_since(&self, _scale: Scale<f64>, commit: Option<CommitCounter>) -> DamageSet<i32, Physical> {
        if commit == Some(self.commit) {
            return DamageSet::default();
        }
        self.pieces.iter().map(|(_, p)| Rectangle::new(p.loc - self.geometry.loc, p.size)).collect()
    }

    fn kind(&self) -> Kind {
        Kind::Unspecified
    }
}

impl<R: HyaloRenderer> RenderElement<R> for FrameElement {
    fn draw(
        &self,
        frame: &mut R::Frame<'_, '_>,
        _src: Rectangle<f64, BufferCoords>,
        dst: Rectangle<i32, Physical>,
        damage: &[Rectangle<i32, Physical>],
        _opaque_regions: &[Rectangle<i32, Physical>],
        _cache: Option<&UserDataMap>,
    ) -> Result<(), R::Error> {
        self.draw_gles(R::gles_frame(frame), dst, damage).map_err(R::from_gles_error)
    }
}
