//! zwlr_screencopy_v1: the screen, copied into a client's buffer — what `wf-recorder` (the
//! screen recorder, `core/RecordingConfig.ts`) speaks; it knows no other capture protocol.
//! Screenshots go through ext-image-copy-capture (capture.rs), which grim prefers.
//!
//! - `copy`: the output (or a region of it) as it is now, drawn again offscreen like a
//!   screenshot (screenshot.rs) and written into the client's shm buffer.
//! - `copy_with_damage` — a recorder's request — waits for the next frame Hyalo draws on that
//!   output (`complete_screencopy` from post_repaint), so a still screen sends nothing.
//! - Two kinds of buffer. shm: every frame is a draw and a read-back on the CPU side, as
//!   wlroots does for shm. dmabuf (`linux_dmabuf`, v3): the frame is drawn straight into the
//!   client's buffer on the GPU — what wf-recorder uses with a hardware encoder (VA-API, the
//!   recorder's default here), and it waits for that event: without it the recording never got
//!   its first frame, wrote no file and could not be stopped (2026-10-03).
//! - No cursor (`overlay_cursor` is not honoured).
//! - Locked: every frame fails (lock.rs). Not offered to sandboxed clients (sandbox.rs).

use std::sync::Mutex;

use smithay::{
    backend::allocator::{Buffer as _, Fourcc},
    output::Output,
    reexports::{
        wayland_protocols_wlr::screencopy::v1::server::{
            zwlr_screencopy_frame_v1::{self, ZwlrScreencopyFrameV1},
            zwlr_screencopy_manager_v1::{self, ZwlrScreencopyManagerV1},
        },
        wayland_server::{
            Client, DataInit, DisplayHandle, New, Resource,
            protocol::{wl_buffer::WlBuffer, wl_shm},
        },
    },
    utils::{Logical, Rectangle, Transform},
    wayland::{Dispatch2, GlobalDispatch2, dmabuf::get_dmabuf, shm::with_buffer_contents_mut},
};

use crate::Hyalo;

pub struct ScreencopyGlobal;

/// A frame: what it copies, and the buffer size it announced.
pub struct ScreencopyFrame {
    /// None: the output was gone when the capture was asked for (the frame has failed).
    output: Option<Output>,
    /// The output's transform when the frame was made: the buffer is in ITS orientation.
    transform: Transform,
    /// Logical, relative to the output; None = all of it.
    region: Option<Rectangle<i32, Logical>>,
    size: Mutex<(i32, i32)>,
}

/// `copy_with_damage` requests waiting for their output's next frame.
#[derive(Default)]
pub struct PendingCopies(pub Vec<(ZwlrScreencopyFrameV1, WlBuffer)>);

pub fn init(dh: &DisplayHandle) {
    dh.create_global::<Hyalo, ZwlrScreencopyManagerV1, _>(3, ScreencopyGlobal);
}

impl GlobalDispatch2<ZwlrScreencopyManagerV1, Hyalo> for ScreencopyGlobal {
    fn bind(
        &self,
        _state: &mut Hyalo,
        _dh: &DisplayHandle,
        _client: &Client,
        resource: New<ZwlrScreencopyManagerV1>,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        data_init.init(resource, ScreencopyGlobal);
    }

    /// Not for a sandboxed client (sandbox.rs).
    fn can_view(&self, client: &Client) -> bool {
        crate::sandbox::unrestricted(client)
    }
}

impl Dispatch2<ZwlrScreencopyManagerV1, Hyalo> for ScreencopyGlobal {
    fn request(
        &self,
        state: &mut Hyalo,
        _client: &Client,
        _resource: &ZwlrScreencopyManagerV1,
        request: zwlr_screencopy_manager_v1::Request,
        _dh: &DisplayHandle,
        data_init: &mut DataInit<'_, Hyalo>,
    ) {
        use zwlr_screencopy_manager_v1::Request;
        let (frame, output, region) = match request {
            Request::CaptureOutput { frame, output, .. } => (frame, output, None),
            Request::CaptureOutputRegion { frame, output, x, y, width, height, .. } => {
                (frame, output, Some(Rectangle::new((x, y).into(), (width, height).into())))
            }
            Request::Destroy => return,
            _ => return,
        };
        let Some(output) = Output::from_resource(&output) else {
            let frame = data_init.init(frame, ScreencopyFrame { output: None, transform: Transform::Normal, region: None, size: Mutex::new((0, 0)) });
            frame.failed();
            return;
        };
        let transform = output.current_transform();
        let size = buffer_size(state, &output, region);
        let frame = data_init.init(frame, ScreencopyFrame { output: Some(output), transform, region, size: Mutex::new(size) });
        let Some((w, h)) = Some(size).filter(|(w, h)| *w > 0 && *h > 0) else {
            frame.failed();
            return;
        };
        frame.buffer(wl_shm::Format::Xrgb8888, w as u32, h as u32, w as u32 * 4);
        if frame.version() >= 3 {
            frame.linux_dmabuf(Fourcc::Xrgb8888 as u32, w as u32, h as u32);
            frame.buffer_done();
        }
    }
}

impl Dispatch2<ZwlrScreencopyFrameV1, Hyalo> for ScreencopyFrame {
    fn request(
        &self,
        state: &mut Hyalo,
        _client: &Client,
        resource: &ZwlrScreencopyFrameV1,
        request: zwlr_screencopy_frame_v1::Request,
        _dh: &DisplayHandle,
        _data_init: &mut DataInit<'_, Hyalo>,
    ) {
        use zwlr_screencopy_frame_v1::Request;
        match request {
            Request::Copy { buffer } => copy_now(state, resource, &buffer, false),
            // Not a redraw of our own: the next frame the screen draws anyway answers it, so a
            // still screen records nothing (RecordingConfig.ts's "follow the compositor").
            Request::CopyWithDamage { buffer } => state.screencopy_pending.0.push((resource.clone(), buffer)),
            _ => {}
        }
    }
}

/// The region (or the whole output) as the user sees it: physical pixels at the output's scale.
fn upright_size(state: &Hyalo, output: &Output, region: Option<Rectangle<i32, Logical>>) -> (i32, i32) {
    let Some(geo) = state.space.output_geometry(output) else { return (0, 0) };
    let scale = output.current_scale().fractional_scale();
    let area = region.unwrap_or(Rectangle::from_size(geo.size));
    let s = area.size.to_f64().to_physical_precise_round::<_, i32>(scale);
    (s.w, s.h)
}

/// The buffer it needs: the upright size, turned by the output's transform.
fn buffer_size(state: &Hyalo, output: &Output, region: Option<Rectangle<i32, Logical>>) -> (i32, i32) {
    let (w, h) = upright_size(state, output, region);
    if quarter_turn(output.current_transform()) { (h, w) } else { (w, h) }
}

fn quarter_turn(t: Transform) -> bool {
    matches!(t, Transform::_90 | Transform::_270 | Transform::Flipped90 | Transform::Flipped270)
}

/// Where the upright pixel (x, y) of a `w`×`h` image lands in the buffer of an output with
/// transform `t` — the buffer is in the OUTPUT's orientation, as wlr-screencopy defines it, and
/// the client turns it upright by applying the output's transform (wf-recorder: a `transpose` /
/// `vflip` filter). A wl_output transform is: flip around the vertical axis if FLIPPED, then
/// rotate counter-clockwise.
pub fn to_buffer(t: Transform, x: usize, y: usize, w: usize, h: usize) -> (usize, usize) {
    let flipped = matches!(t, Transform::Flipped | Transform::Flipped90 | Transform::Flipped180 | Transform::Flipped270);
    let x = if flipped { w - 1 - x } else { x };
    match t {
        Transform::Normal | Transform::Flipped => (x, y),
        Transform::_90 | Transform::Flipped90 => (y, w - 1 - x),
        Transform::_180 | Transform::Flipped180 => (w - 1 - x, h - 1 - y),
        Transform::_270 | Transform::Flipped270 => (h - 1 - y, x),
    }
}

fn copy_now(state: &mut Hyalo, frame: &ZwlrScreencopyFrameV1, buffer: &WlBuffer, damage: bool) {
    let Some(data) = frame.data::<ScreencopyFrame>() else { return };
    if state.lock.is_locked() {
        frame.failed();
        return;
    }
    let Some(output) = data.output.clone() else {
        frame.failed();
        return;
    };
    let (w, h) = *data.size.lock().unwrap();
    // The region's origin in the drawn output's pixels.
    let scale = output.current_scale().fractional_scale();
    let origin = data.region.map(|r| {
        let p = r.loc.to_f64().to_physical_precise_round::<_, i32>(scale);
        (p.x.max(0), p.y.max(0))
    });
    if let Ok(dmabuf) = get_dmabuf(buffer) {
        let mut dmabuf = dmabuf.clone();
        let size = dmabuf.size();
        if (size.w, size.h) != (w, h) || dmabuf.format().code != Fourcc::Xrgb8888 && dmabuf.format().code != Fourcc::Argb8888 {
            frame.failed();
            return;
        }
        let (uw, uh) = upright_size(state, &output, data.region);
        let area = origin.map(|(x, y)| Rectangle::new((x, y).into(), (uw, uh).into()));
        if let Err(err) = crate::backend::draw_output_into(state, &output, area, (w, h).into(), &mut dmabuf) {
            tracing::warn!(%err, "screencopy into a dmabuf failed");
            frame.failed();
            return;
        }
        send_ready(state, frame, damage, w, h);
        return;
    }
    let Ok((ow, oh, rgba)) = crate::backend::capture_output(state, &output) else {
        frame.failed();
        return;
    };
    let (x0, y0) = origin.map(|(x, y)| (x as usize, y as usize)).unwrap_or((0, 0));
    let written = with_buffer_contents_mut(buffer, |ptr, len, info| {
        if info.width != w || info.height != h || info.format != wl_shm::Format::Xrgb8888 && info.format != wl_shm::Format::Argb8888 {
            return false;
        }
        let stride = info.stride as usize;
        let offset = info.offset as usize;
        if offset + stride * h as usize > len {
            return false;
        }
        // SAFETY: the pool's mapping, `len` bytes, valid for this closure; writes checked above.
        let dst = unsafe { std::slice::from_raw_parts_mut(ptr, len) };
        // Top row first, no Y_INVERT, in the OUTPUT's orientation (`to_buffer`). Until this was
        // understood the copy was upright with Y_INVERT, which looked right nested only because the
        // winit output is Flipped180 and wf-recorder applies that as a second flip — on a real
        // (Normal) output, CI's vkms, it recorded upside down (2026-10-02).
        let (uw, uh) = if quarter_turn(data.transform) { (h as usize, w as usize) } else { (w as usize, h as usize) };
        for uy in 0..uh {
            for ux in 0..uw {
                let (sx, sy) = (x0 + ux, y0 + uy);
                let (bx, by) = to_buffer(data.transform, ux, uy, uw, uh);
                let o = offset + by * stride + bx * 4;
                if sx >= ow as usize || sy >= oh as usize {
                    dst[o..o + 4].copy_from_slice(&[0, 0, 0, 255]);
                    continue;
                }
                let s = (sy * ow as usize + sx) * 4;
                // RGBA in, little-endian XRGB8888 out: B, G, R, X in memory.
                dst[o] = rgba[s + 2];
                dst[o + 1] = rgba[s + 1];
                dst[o + 2] = rgba[s];
                dst[o + 3] = 255;
            }
        }
        true
    });
    if !matches!(written, Ok(true)) {
        frame.failed();
        return;
    }
    send_ready(state, frame, damage, w, h);
}

fn send_ready(state: &Hyalo, frame: &ZwlrScreencopyFrameV1, damage: bool, w: i32, h: i32) {
    if damage {
        frame.damage(0, 0, w as u32, h as u32);
    }
    frame.flags(zwlr_screencopy_frame_v1::Flags::empty());
    let now: std::time::Duration = state.clock.now().into();
    let secs = now.as_secs();
    frame.ready((secs >> 32) as u32, secs as u32, now.subsec_nanos());
}

impl Hyalo {
    /// `output` just drew a frame: the recorders waiting on it get theirs (post_repaint).
    pub fn complete_screencopy(&mut self, output: &Output) {
        if self.screencopy_pending.0.is_empty() {
            return;
        }
        let (ready, rest): (Vec<_>, Vec<_>) = std::mem::take(&mut self.screencopy_pending.0)
            .into_iter()
            .filter(|(f, _)| f.is_alive())
            .partition(|(f, _)| f.data::<ScreencopyFrame>().is_some_and(|d| d.output.as_ref() == Some(output)));
        self.screencopy_pending.0 = rest;
        for (frame, buffer) in ready {
            copy_now(self, &frame, &buffer, true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normal_is_upright_and_flipped180_is_a_vertical_flip() {
        assert_eq!(to_buffer(Transform::Normal, 3, 1, 10, 4), (3, 1));
        // The winit output: what wf-recorder's `vflip` undoes.
        assert_eq!(to_buffer(Transform::Flipped180, 3, 1, 10, 4), (3, 2));
    }

    #[test]
    fn a_quarter_turn_swaps_and_lands_every_corner_once() {
        let (w, h) = (4usize, 3usize);
        for t in [Transform::_90, Transform::_270, Transform::Flipped90, Transform::Flipped270] {
            let mut seen = std::collections::HashSet::new();
            for y in 0..h {
                for x in 0..w {
                    let (bx, by) = to_buffer(t, x, y, w, h);
                    assert!(bx < h && by < w, "{t:?} put ({x},{y}) outside the {h}x{w} buffer");
                    seen.insert((bx, by));
                }
            }
            assert_eq!(seen.len(), w * h, "{t:?} is not a permutation");
        }
        // 90 counter-clockwise: the upright top-right corner is the buffer's top-left.
        assert_eq!(to_buffer(Transform::_90, w - 1, 0, w, h), (0, 0));
    }
}
