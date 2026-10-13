//! Window capture for the shell's thumbnails (the overview, the app grid's strip): the standard
//! protocols, all three from Smithay —
//!
//! - `ext-foreign-toplevel-list-v1`: every shown window, with its title and app id. Its
//!   `identifier` is Hyalo's window id in hex, the same string the shell uses as the window's
//!   address (`core/HyaloState.ts`), so the client finds a window by the address it already
//!   holds. On Hyprland the client asks `hyprland-toplevel-mapping` for that address instead;
//!   Hyalo does not carry a Hyprland protocol for it (lib/nidara-wl falls back to the
//!   identifier when the mapping manager is absent).
//! - `ext-image-capture-source-v1` (toplevel sources) + `ext-image-copy-capture-v1`: the
//!   window is drawn on its own — its surface and subsurfaces, no other window, no glass.
//!
//! A window on a hidden workspace is captured too, with its last committed content, as on
//! Hyprland: drawing it from its surface tree does not need it on screen.
//!
//! A screen or a window shared in a call comes through here too (xdg-desktop-portal-wlr asks
//! for frame after frame on one session): a session's first frame is drawn at once, every later
//! one when there is something new (`frame` below); into the client's dmabuf on the GPU when it
//! hands one (`capture_dmabuf`), into its shm buffer otherwise.
//!
//! - `ext-output-image-capture-source-v1`: a whole output, as the screen shows it (glass
//!   included, the pointer only when the session asks) — what `grim` asks for, so the screenshot tile, Print and the
//!   region picker work. Drawn again offscreen like `msg screenshot` (screenshot.rs). Until
//!   2026-10-02 Hyalo offered windows only, and grim said "compositor doesn't support the screen
//!   capture protocol": the screenshot never reached the clipboard (owner-caught).

use std::time::Duration;

use smithay::{
    backend::{
        allocator::{Fourcc, dmabuf::Dmabuf},
        renderer::{
            Bind, ExportMem, Offscreen, Texture as _, TextureMapping as _,
            damage::OutputDamageTracker,
            element::{Kind, surface::{WaylandSurfaceRenderElement, render_elements_from_surface_tree}},
            gles::{GlesRenderer, GlesTexture},
            utils::import_surface_tree,
        },
    },
    desktop::Window,
    reexports::wayland_server::protocol::{wl_shm, wl_surface::WlSurface},
    utils::{Buffer as BufferCoords, Physical, Rectangle, Scale, Size, Transform},
    wayland::{
        foreign_toplevel_list::{ForeignToplevelHandle, ForeignToplevelListHandler, ForeignToplevelListState},
        image_capture_source::{
            ImageCaptureSource, ImageCaptureSourceHandler, OutputCaptureSourceHandler, OutputCaptureSourceState,
            ToplevelCaptureSourceHandler, ToplevelCaptureSourceState,
        },
        image_copy_capture::{
            BufferConstraints, CaptureFailureReason, Frame, FrameRef, ImageCopyCaptureHandler, ImageCopyCaptureState,
            Session, SessionRef,
        },
        dmabuf::get_dmabuf,
        shm::with_buffer_contents_mut,
    },
};

use crate::{state::Hyalo, wm::WindowId};

/// The identifier a window is listed under: its id in hex, the shell's address for it.
pub fn identifier(id: WindowId) -> String {
    format!("{id:x}")
}

/// What a capture source points at: the listed window.
struct SourceWindow(WindowId);
/// ...or an output, by name.
struct SourceOutput(String);

impl Hyalo {
    /// A window is shown for the first time: it enters the list.
    pub fn list_window(&mut self, id: WindowId) {
        let Some(m) = self.wm.get(id) else { return };
        let (title, app_id) = (crate::wm::title(&m.window), crate::wm::app_id(&m.window));
        let handle = self
            .foreign_toplevel_list
            .new_toplevel_with_identifier::<Hyalo>(title, app_id, identifier(id));
        handle.send_done();
        self.wm.get_mut(id).unwrap().listed = Some(handle);
    }

    /// Its title or app id changed.
    pub fn relist_window(&mut self, id: WindowId) {
        let Some(m) = self.wm.get(id) else { return };
        let Some(h) = &m.listed else { return };
        h.send_title(&crate::wm::title(&m.window));
        h.send_app_id(&crate::wm::app_id(&m.window));
        h.send_done();
    }

    /// It is gone.
    pub fn unlist_window(&mut self, handle: Option<ForeignToplevelHandle>) {
        if let Some(h) = handle {
            self.foreign_toplevel_list.remove_toplevel(&h);
        }
    }

    fn source_output(&self, source: &ImageCaptureSource) -> Option<smithay::output::Output> {
        let name = &source.user_data().get::<SourceOutput>()?.0;
        self.space.outputs().find(|o| &o.name() == name).cloned()
    }

    fn source_window(&self, source: &ImageCaptureSource) -> Option<&Window> {
        let id = source.user_data().get::<SourceWindow>()?.0;
        self.wm.get(id).filter(|m| m.mapped).map(|m| &m.window)
    }

    /// The scale a window is drawn at: its output's, so a thumbnail is as sharp as the screen.
    fn source_scale(&self, source: &ImageCaptureSource) -> f64 {
        let Some(id) = source.user_data().get::<SourceWindow>().map(|s| s.0) else { return 1.0 };
        self.wm
            .get(id)
            .and_then(|m| self.wm.workspaces.get(&m.workspace))
            .and_then(|w| self.output_named(&w.output))
            .map_or(1.0, |o| o.current_scale().fractional_scale())
    }
}

impl ForeignToplevelListHandler for Hyalo {
    fn foreign_toplevel_list_state(&mut self) -> &mut ForeignToplevelListState {
        &mut self.foreign_toplevel_list
    }
}

impl ImageCaptureSourceHandler for Hyalo {}

impl OutputCaptureSourceHandler for Hyalo {
    fn output_capture_source_state(&mut self) -> &mut OutputCaptureSourceState {
        &mut self.output_capture_source
    }

    fn output_source_created(&mut self, source: ImageCaptureSource, output: &smithay::output::Output) {
        source.user_data().insert_if_missing(|| SourceOutput(output.name()));
    }
}

impl ToplevelCaptureSourceHandler for Hyalo {
    fn toplevel_capture_source_state(&mut self) -> &mut ToplevelCaptureSourceState {
        &mut self.toplevel_capture_source
    }

    fn toplevel_source_created(&mut self, source: ImageCaptureSource, toplevel: ForeignToplevelHandle) {
        let ident = toplevel.identifier();
        if let Ok(id) = WindowId::from_str_radix(&ident, 16) {
            source.user_data().insert_if_missing(|| SourceWindow(id));
        }
    }
}

impl ImageCopyCaptureHandler for Hyalo {
    fn image_copy_capture_state(&mut self) -> &mut ImageCopyCaptureState {
        &mut self.image_copy_capture
    }

    fn capture_constraints(&mut self, source: &ImageCaptureSource) -> Option<BufferConstraints> {
        let size = self.capture_size(source)?;
        Some(BufferConstraints {
            size,
            shm: vec![wl_shm::Format::Xrgb8888, wl_shm::Format::Argb8888],
            dma: crate::backend::capture_dmabuf(self),
        })
    }

    // ⚠️ A `Session` STOPS the client's session when it is dropped (Smithay's `Drop`): it is
    // held here until the client destroys it, or every capture is answered "stopped" before a
    // frame is even asked for (measured, 2026-10-01).
    fn new_session(&mut self, session: Session) {
        self.capture_sessions.push(session);
    }

    fn session_destroyed(&mut self, session: SessionRef) {
        self.capture_pending.retain(|(s, _)| *s != session);
        self.capture_sessions.retain(|s| **s != session);
    }

    fn frame_aborted(&mut self, frame: FrameRef) {
        self.capture_pending.retain(|(_, f)| *f != frame);
    }

    // A session's first frame is drawn at once: a thumbnail or a screenshot asks for one frame
    // and closes. Every later one waits for something new — the output's next frame, the
    // window's next commit — so a still screen being shared costs nothing, and a moving one
    // costs one draw per frame the screen draws anyway. Until 2026-10-13 every frame was drawn
    // on request: a shared screen was drawn again as fast as the client asked, still or not.
    fn frame(&mut self, session: &SessionRef, frame: Frame) {
        let delivered = session.user_data().get::<Delivered>().is_some_and(|d| d.0.get());
        if delivered {
            self.capture_pending.push((session.clone(), frame));
        } else {
            self.capture_now(session, frame);
        }
    }
}

/// The session has had its first frame (`frame` above).
#[derive(Default)]
struct Delivered(std::cell::Cell<bool>);

impl Hyalo {
    /// The buffer a source is copied into, in pixels.
    fn capture_size(&self, source: &ImageCaptureSource) -> Option<Size<i32, BufferCoords>> {
        let size: Size<i32, BufferCoords> = if let Some(output) = self.source_output(source) {
            // What screenshot.rs draws: the logical area at the output's scale, upright.
            let geo = self.space.output_geometry(&output)?;
            let s = geo.size.to_f64().to_physical_precise_round::<_, i32>(output.current_scale().fractional_scale());
            (s.w, s.h).into()
        } else {
            let window = self.source_window(source)?;
            window.geometry().size.to_f64().to_buffer(self.source_scale(source), Transform::Normal).to_i32_round()
        };
        (size.w > 0 && size.h > 0).then_some(size)
    }

    /// `output` just drew a frame: the sessions on it waiting for one get it (post_repaint).
    pub fn complete_capture_output(&mut self, output: &smithay::output::Output) {
        self.complete_capture(|state, source| state.source_output(source).as_ref() == Some(output));
    }

    /// The window under `root` committed: the sessions on it waiting for a frame get it.
    pub fn complete_capture_window(&mut self, root: &WlSurface) {
        if self.capture_pending.is_empty() {
            return;
        }
        let Some(id) = self.wm.by_surface(root).map(|m| m.id) else { return };
        self.complete_capture(|_, source| source.user_data().get::<SourceWindow>().is_some_and(|s| s.0 == id));
    }

    /// A window being captured is gone: its sessions stop.
    pub fn stop_capture_window(&mut self, id: WindowId) {
        self.stop_capture(|source| source.user_data().get::<SourceWindow>().is_some_and(|s| s.0 == id));
    }

    /// An output being captured is gone: its sessions stop.
    pub fn stop_capture_output(&mut self, name: &str) {
        self.stop_capture(|source| source.user_data().get::<SourceOutput>().is_some_and(|s| s.0 == name));
    }

    // The sessions go first: dropping one sends `stopped` and fails its frame with "stopped",
    // which a call waiting on a shared window reads as "the window is gone" and ends the share.
    // Their frames go after, already answered. Until 2026-10-13 a closed window's session was
    // never stopped, and the call waited on it forever.
    fn stop_capture(&mut self, on: impl Fn(&ImageCaptureSource) -> bool) {
        let (stopped, kept): (Vec<_>, Vec<_>) =
            std::mem::take(&mut self.capture_sessions).into_iter().partition(|s| on(&s.source()));
        self.capture_sessions = kept;
        drop(stopped);
        self.capture_pending.retain(|(s, _)| !on(&s.source()));
    }

    fn complete_capture(&mut self, waits_on: impl Fn(&Hyalo, &ImageCaptureSource) -> bool) {
        if self.capture_pending.is_empty() {
            return;
        }
        let (ready, rest): (Vec<_>, Vec<_>) =
            std::mem::take(&mut self.capture_pending).into_iter().partition(|(s, _)| waits_on(self, &s.source()));
        self.capture_pending = rest;
        for (session, frame) in ready {
            self.capture_now(&session, frame);
        }
    }

    /// Draws the source into the frame's buffer now and answers it.
    fn capture_now(&mut self, session: &SessionRef, frame: Frame) {
        session.user_data().insert_if_missing(Delivered::default);
        if let Some(d) = session.user_data().get::<Delivered>() {
            d.0.set(true);
        }
        // Nothing of the session leaves it while it is locked (lock.rs).
        if self.lock.is_locked() {
            frame.fail(CaptureFailureReason::Unknown);
            return;
        }
        let source = session.source();
        // The output changed size or scale, or the window was resized: the client is told the
        // new size and asks again with a buffer of it (the protocol's own way, not an error).
        let Some(size) = self.capture_size(&source) else {
            frame.fail(CaptureFailureReason::Stopped);
            return;
        };
        if session.current_constraints().is_some_and(|c| c.size != size) {
            if let Some(constraints) = self.capture_constraints(&source) {
                session.update_constraints(constraints);
            }
            frame.fail(CaptureFailureReason::BufferConstraints);
            return;
        }
        if let Ok(dmabuf) = get_dmabuf(&frame.buffer()) {
            let mut dmabuf = dmabuf.clone();
            let drawn = if let Some(output) = self.source_output(&source) {
                crate::backend::draw_upright_into(self, &output, &mut dmabuf, session.draw_cursor())
            } else if let Some(window) = self.source_window(&source).cloned() {
                let scale = self.source_scale(&source);
                crate::backend::draw_window_into(self, &window, scale, &mut dmabuf)
            } else {
                frame.fail(CaptureFailureReason::Stopped);
                return;
            };
            match drawn {
                Ok(()) => frame.success(Transform::Normal, None, Duration::from(self.clock.now())),
                Err(err) => {
                    tracing::warn!(%err, "capture into a dmabuf failed");
                    frame.fail(CaptureFailureReason::Unknown);
                }
            }
            return;
        }
        let pixels = if let Some(output) = self.source_output(&source) {
            crate::backend::capture_output(self, &output, session.draw_cursor())
        } else if let Some(window) = self.source_window(&source).cloned() {
            let scale = self.source_scale(&source);
            crate::backend::capture_window(self, &window, scale)
        } else {
            frame.fail(CaptureFailureReason::Stopped);
            return;
        };
        let pixels = match pixels {
            Ok(p) => p,
            Err(err) => {
                tracing::warn!(%err, "capture failed");
                frame.fail(CaptureFailureReason::Unknown);
                return;
            }
        };
        let (w, h, rgba) = pixels;
        let written = with_buffer_contents_mut(&frame.buffer(), |ptr, len, data| {
            if data.width != w as i32 || data.height != h as i32 {
                return Err(CaptureFailureReason::BufferConstraints);
            }
            let format = data.format;
            if format != wl_shm::Format::Xrgb8888 && format != wl_shm::Format::Argb8888 {
                return Err(CaptureFailureReason::BufferConstraints);
            }
            let stride = data.stride as usize;
            let offset = data.offset as usize;
            if offset + stride * h as usize > len {
                return Err(CaptureFailureReason::BufferConstraints);
            }
            // SAFETY: Smithay hands out the pool's mapping, `len` bytes long, for the duration
            // of this closure; every write below was checked against it.
            let dst = unsafe { std::slice::from_raw_parts_mut(ptr, len) };
            // RGBA bytes in, little-endian [AX]RGB8888 out — B, G, R, A in memory.
            for row in 0..h as usize {
                let src = &rgba[row * w as usize * 4..(row + 1) * w as usize * 4];
                let out = &mut dst[offset + row * stride..offset + row * stride + w as usize * 4];
                for (o, s) in out.as_chunks_mut::<4>().0.iter_mut().zip(src.as_chunks::<4>().0) {
                    o[0] = s[2];
                    o[1] = s[1];
                    o[2] = s[0];
                    o[3] = s[3];
                }
            }
            Ok(())
        });
        match written {
            Ok(Ok(())) => {
                let now = self.clock.now();
                frame.success(Transform::Normal, None, Duration::from(now));
            }
            Ok(Err(reason)) => frame.fail(reason),
            Err(_) => frame.fail(CaptureFailureReason::BufferConstraints),
        }
    }
}

/// A window's elements, and the size they are drawn at.
type WindowDraw = (Size<i32, Physical>, Vec<WaylandSurfaceRenderElement<GlesRenderer>>);

/// What `window` alone is drawn from — its surface and subsurfaces, at `scale`, the geometry's
/// origin at 0,0 — and the size it is drawn at.
fn window_elements(renderer: &mut GlesRenderer, window: &Window, scale: f64) -> Result<WindowDraw, String> {
    let geo = window.geometry();
    let size = geo.size.to_f64().to_physical_precise_round(scale);
    let surface = crate::wm::surface_of(window).ok_or("no surface yet")?;
    // A window on a hidden workspace has not been drawn since its last commits: its buffers
    // become textures here, as they would when shown.
    import_surface_tree(renderer, &surface).map_err(|e| format!("{e:?}"))?;
    // The geometry's origin at 0,0: the client's own decoration margin falls outside.
    let origin = (geo.loc.to_f64().upscale(-1.0)).to_physical_precise_round(scale);
    let elements = render_elements_from_surface_tree(renderer, &surface, origin, Scale::from(scale), 1.0, Kind::Unspecified);
    Ok((size, elements))
}

/// `window` alone straight into a client's dmabuf — a window being shared: never read back.
pub fn draw_window_into(renderer: &mut GlesRenderer, window: &Window, scale: f64, dmabuf: &mut Dmabuf) -> Result<(), String> {
    let (size, elements) = window_elements(renderer, window, scale)?;
    let mut tracker = OutputDamageTracker::new(size, scale, Transform::Normal);
    let mut fb = renderer.bind(dmabuf).map_err(|e| e.to_string())?;
    let result = tracker
        .render_output(renderer, &mut fb, 0, &elements, [0.0, 0.0, 0.0, 0.0])
        .map_err(|e| format!("{e:?}"))?;
    result.sync.wait().map_err(|e| format!("{e:?}"))
}

/// `window` alone — its surface and subsurfaces, at `scale` — as RGBA rows, top first.
pub fn draw_window(renderer: &mut GlesRenderer, window: &Window, scale: f64) -> Result<(u32, u32, Vec<u8>), String> {
    let (size, elements) = window_elements(renderer, window, scale)?;
    let mut texture: GlesTexture = renderer
        .create_buffer(Fourcc::Abgr8888, (size.w, size.h).into())
        .map_err(|e| e.to_string())?;
    let mut tracker = OutputDamageTracker::new(size, scale, Transform::Normal);
    {
        let mut fb = renderer.bind(&mut texture).map_err(|e| e.to_string())?;
        tracker
            .render_output(renderer, &mut fb, 0, &elements, [0.0, 0.0, 0.0, 0.0])
            .map_err(|e| format!("{e:?}"))?;
    }
    let fb = renderer.bind(&mut texture).map_err(|e| e.to_string())?;
    let mapping = renderer
        .copy_framebuffer(&fb, Rectangle::from_size((size.w, size.h).into()), Fourcc::Abgr8888)
        .map_err(|e| e.to_string())?;
    drop(fb);
    // Same read-back rule as screenshot.rs: a mapping that is NOT flipped holds the bottom row first.
    let bottom_first = !mapping.flipped();
    let (w, h) = (mapping.width(), mapping.height());
    let data = renderer.map_texture(&mapping).map_err(|e| e.to_string())?;
    let stride = w as usize * 4;
    let mut rgba = Vec::with_capacity(stride * h as usize);
    for row in 0..h as usize {
        let r = if bottom_first { h as usize - 1 - row } else { row };
        rgba.extend_from_slice(&data[r * stride..(r + 1) * stride]);
    }
    Ok((w, h, rgba))
}
