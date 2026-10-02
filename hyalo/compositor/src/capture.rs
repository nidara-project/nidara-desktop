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
//!   window is drawn on its own — its surface and subsurfaces, no other window, no glass —
//!   into a texture of ours and copied into the client's shm buffer.
//!
//! A window on a hidden workspace is captured too, with its last committed content, as on
//! Hyprland: drawing it from its surface tree does not need it on screen. Each capture is one
//! draw, on request; nothing is captured continuously.
//!
//! - `ext-output-image-capture-source-v1`: a whole output, as the screen shows it (glass
//!   included, no cursor) — what `grim` asks for, so the screenshot tile, Print and the
//!   region picker work. Drawn again offscreen like `msg screenshot` (screenshot.rs). Until
//!   2026-10-02 Hyalo offered windows only, and grim said "compositor doesn't support the screen
//!   capture protocol": the screenshot never reached the clipboard (owner-caught).

use std::time::Duration;

use smithay::{
    backend::{
        allocator::Fourcc,
        renderer::{
            Bind, ExportMem, Offscreen, Texture as _, TextureMapping as _,
            damage::OutputDamageTracker,
            element::{Kind, surface::{WaylandSurfaceRenderElement, render_elements_from_surface_tree}},
            gles::{GlesRenderer, GlesTexture},
            utils::import_surface_tree,
        },
    },
    desktop::Window,
    reexports::wayland_server::protocol::wl_shm,
    utils::{Rectangle, Scale, Transform},
    wayland::{
        foreign_toplevel_list::{ForeignToplevelHandle, ForeignToplevelListHandler, ForeignToplevelListState},
        image_capture_source::{
            ImageCaptureSource, ImageCaptureSourceHandler, OutputCaptureSourceHandler, OutputCaptureSourceState,
            ToplevelCaptureSourceHandler, ToplevelCaptureSourceState,
        },
        image_copy_capture::{
            BufferConstraints, CaptureFailureReason, Frame, ImageCopyCaptureHandler, ImageCopyCaptureState, Session,
            SessionRef,
        },
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
        let size = if let Some(output) = self.source_output(source) {
            // What screenshot.rs draws: the logical area at the output's scale, upright.
            let geo = self.space.output_geometry(&output)?;
            let s = geo.size.to_f64().to_physical_precise_round::<_, i32>(output.current_scale().fractional_scale());
            (s.w, s.h).into()
        } else {
            let window = self.source_window(source)?;
            window.geometry().size.to_f64().to_buffer(self.source_scale(source), Transform::Normal).to_i32_round()
        };
        if size.w <= 0 || size.h <= 0 {
            return None;
        }
        Some(BufferConstraints {
            size,
            shm: vec![wl_shm::Format::Xrgb8888, wl_shm::Format::Argb8888],
            dma: None,
        })
    }

    // ⚠️ A `Session` STOPS the client's session when it is dropped (Smithay's `Drop`): it is
    // held here until the client destroys it, or every capture is answered "stopped" before a
    // frame is even asked for (measured, 2026-10-01).
    fn new_session(&mut self, session: Session) {
        self.capture_sessions.push(session);
    }

    fn session_destroyed(&mut self, session: SessionRef) {
        self.capture_sessions.retain(|s| **s != session);
    }

    fn frame(&mut self, session: &SessionRef, frame: Frame) {
        // Nothing of the session leaves it while it is locked (lock.rs).
        if self.lock.is_locked() {
            frame.fail(CaptureFailureReason::Unknown);
            return;
        }
        let source = session.source();
        let pixels = if let Some(output) = self.source_output(&source) {
            crate::backend::capture_output(self, &output)
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

/// `window` alone — its surface and subsurfaces, at `scale` — as RGBA rows, top first.
pub fn draw_window(renderer: &mut GlesRenderer, window: &Window, scale: f64) -> Result<(u32, u32, Vec<u8>), String> {
    let geo = window.geometry();
    let size = geo.size.to_f64().to_physical_precise_round(scale);
    let surface = window.toplevel().ok_or("not a toplevel")?.wl_surface().clone();
    // A window on a hidden workspace has not been drawn since its last commits: its buffers
    // become textures here, as they would when shown.
    import_surface_tree(renderer, &surface).map_err(|e| format!("{e:?}"))?;
    // The geometry's origin at 0,0: the client's own decoration margin falls outside.
    let origin = (geo.loc.to_f64().upscale(-1.0)).to_physical_precise_round(scale);
    let elements: Vec<WaylandSurfaceRenderElement<GlesRenderer>> = render_elements_from_surface_tree(
        renderer,
        &surface,
        origin,
        Scale::from(scale),
        1.0,
        Kind::Unspecified,
    );
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
