// SPDX-License-Identifier: LGPL-3.0-or-later
//! One still image of one window, for the dock's thumbnails (SHELL-SURFACES.md §5): a
//! toplevel source, one copy-capture session, one frame into an shm buffer, then all of it
//! destroyed. Only layer roots (the shell) list toplevels; an app's window never does.
use crate::{Event, Window, err};
use memmap2::MmapMut;
use std::fs::File;
use std::os::fd::AsFd;
use std::time::{Duration, Instant};
use wayland_client::{
    Connection, Dispatch, QueueHandle, delegate_noop,
    protocol::{wl_buffer, wl_shm},
};
use wayland_protocols::ext::foreign_toplevel_list::v1::client::{
    ext_foreign_toplevel_handle_v1 as handle_v1, ext_foreign_toplevel_list_v1 as list_v1,
};
use wayland_protocols::ext::image_capture_source::v1::client::{
    ext_foreign_toplevel_image_capture_source_manager_v1 as source_manager_v1,
    ext_image_capture_source_v1 as source_v1,
};
use wayland_protocols::ext::image_copy_capture::v1::client::{
    ext_image_copy_capture_frame_v1 as frame_v1, ext_image_copy_capture_manager_v1 as manager_v1,
    ext_image_copy_capture_session_v1 as session_v1,
};

/// Captures waiting for the compositor, per window. The dock's global limit across its
/// outputs is its own scheduler's (D2).
pub const MAX_PENDING: usize = 8;
/// Hyalo draws a still window at once; a thumbnail later than this is not worth having.
pub const DEADLINE: Duration = Duration::from_secs(2);
/// The source buffer is the window's full physical size (the protocol requires exactly
/// that): a 5120×2880 window is 56.25 MiB.
pub const MAX_SOURCE_SIDE: u32 = 8192;
pub const MAX_SOURCE_BYTES: usize = 64 << 20;
/// The returned image fits in this, whatever `max` asks.
pub const MAX_IMAGE_SIDE: u32 = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct CaptureId(pub u64);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureFailure {
    /// The compositor lacks the protocols, or this is not a layer root.
    Unsupported,
    /// No listed window has that identifier.
    NotFound,
    /// MAX_PENDING captures are already waiting.
    Busy,
    /// The window is larger than MAX_SOURCE_SIDE or MAX_SOURCE_BYTES.
    TooLarge,
    /// No usable shm format, or the window changed size during the capture.
    BufferConstraints,
    /// The window went away.
    Stopped,
    Unknown,
    /// No frame within DEADLINE.
    Deadline,
    Cancelled,
    /// The layer root was closed by the compositor.
    Closed,
}
/// RGBA8, straight (not premultiplied) alpha, rows packed.
#[derive(Clone, PartialEq, Eq)]
pub struct Image {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}
impl std::fmt::Debug for Image {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Image({}x{})", self.width, self.height)
    }
}

/// Stride and size of the shm buffer for a source of `width`×`height`, or TooLarge.
/// Overflow-checked: the sizes come from the compositor.
pub(crate) fn source_buffer(width: u32, height: u32) -> Result<(usize, usize), CaptureFailure> {
    if width == 0 || height == 0 {
        return Err(CaptureFailure::BufferConstraints);
    }
    if width > MAX_SOURCE_SIDE || height > MAX_SOURCE_SIDE {
        return Err(CaptureFailure::TooLarge);
    }
    let stride = (width as usize)
        .checked_mul(4)
        .ok_or(CaptureFailure::TooLarge)?;
    let bytes = stride
        .checked_mul(height as usize)
        .ok_or(CaptureFailure::TooLarge)?;
    if bytes > MAX_SOURCE_BYTES {
        return Err(CaptureFailure::TooLarge);
    }
    Ok((stride, bytes))
}
/// The image size for a `width`×`height` source fitting `max` (each side clamped to
/// 1..=MAX_IMAGE_SIDE): aspect kept, never enlarged, at least 1 px a side.
pub(crate) fn fit(width: u32, height: u32, max: (u32, u32)) -> (u32, u32) {
    let mw = max.0.clamp(1, MAX_IMAGE_SIDE);
    let mh = max.1.clamp(1, MAX_IMAGE_SIDE);
    if width <= mw && height <= mh {
        return (width, height);
    }
    // Compare mw/width with mh/height without floating point.
    if u64::from(mw) * u64::from(height) <= u64::from(mh) * u64::from(width) {
        let h = (u64::from(height) * u64::from(mw) + u64::from(width) / 2) / u64::from(width);
        (mw, (h as u32).max(1))
    } else {
        let w = (u64::from(width) * u64::from(mh) + u64::from(height) / 2) / u64::from(height);
        ((w as u32).max(1), mh)
    }
}
/// Little-endian [AX]RGB8888 rows (B, G, R, A in memory) to a straight-alpha RGBA image
/// fitting `max`. argb8888 is premultiplied (wl_shm); xrgb8888's fourth byte is ignored
/// and its alpha is 255. Each image pixel is the average of the source pixels it covers,
/// taken while still premultiplied so colour never bleeds from transparent pixels.
pub(crate) fn to_image(
    src: &[u8],
    width: u32,
    height: u32,
    stride: usize,
    format: wl_shm::Format,
    max: (u32, u32),
) -> Image {
    let opaque = format == wl_shm::Format::Xrgb8888;
    let (w, h) = (width as usize, height as usize);
    let (dw, dh) = fit(width, height, max);
    let (dw, dh) = (dw as usize, dh as usize);
    let mut rgba = Vec::with_capacity(dw * dh * 4);
    for dy in 0..dh {
        let y0 = dy * h / dh;
        let y1 = ((dy + 1) * h / dh).max(y0 + 1);
        for dx in 0..dw {
            let x0 = dx * w / dw;
            let x1 = ((dx + 1) * w / dw).max(x0 + 1);
            let mut sum = [0u64; 4];
            for y in y0..y1 {
                let row = &src[y * stride..y * stride + w * 4];
                for p in row[x0 * 4..x1 * 4].as_chunks::<4>().0 {
                    let a = if opaque { 255 } else { p[3] };
                    sum[0] += u64::from(p[2]);
                    sum[1] += u64::from(p[1]);
                    sum[2] += u64::from(p[0]);
                    sum[3] += u64::from(a);
                }
            }
            let n = ((x1 - x0) * (y1 - y0)) as u64;
            let a = (sum[3] + n / 2) / n;
            for c in &sum[..3] {
                let premul = (c + n / 2) / n;
                // Fully transparent: no colour to recover.
                let straight = (premul * 255 + a / 2).checked_div(a).unwrap_or(0);
                rgba.push(straight.min(255) as u8);
            }
            rgba.push(a as u8);
        }
    }
    Image {
        width: dw as u32,
        height: dh as u32,
        rgba,
    }
}

/// What a pending capture owns on the wire; a fake in tests.
pub(crate) trait Handle {
    fn destroy(&self);
}
/// The shm buffer a frame is captured into.
pub(crate) struct Target {
    proxy: wl_buffer::WlBuffer,
    map: MmapMut,
    width: u32,
    height: u32,
    stride: usize,
    format: wl_shm::Format,
}
pub(crate) struct Wire {
    source: source_v1::ExtImageCaptureSourceV1,
    session: session_v1::ExtImageCopyCaptureSessionV1,
    frame: Option<frame_v1::ExtImageCopyCaptureFrameV1>,
    target: Option<Target>,
    /// From the session's constraint batch, until its `done`.
    size: Option<(u32, u32)>,
    formats: Vec<wl_shm::Format>,
}
impl Handle for Wire {
    fn destroy(&self) {
        if let Some(f) = &self.frame {
            f.destroy();
        }
        self.session.destroy();
        self.source.destroy();
        if let Some(t) = &self.target {
            t.proxy.destroy();
        }
    }
}
struct Pending<P> {
    id: CaptureId,
    max: (u32, u32),
    deadline: Instant,
    wire: P,
}
/// Every capture ends exactly once: image, failure, deadline, cancel or closed. Its
/// objects are destroyed at that moment, and anything arriving later is dropped.
pub(crate) struct Captures<P = Wire> {
    pending: Vec<Pending<P>>,
    next: u64,
}
impl<P> Default for Captures<P> {
    fn default() -> Self {
        Self {
            pending: Vec::new(),
            next: 0,
        }
    }
}
impl<P: Handle> Captures<P> {
    /// Checked BEFORE any protocol object is created.
    fn admit(&mut self) -> Result<CaptureId, CaptureFailure> {
        if self.pending.len() >= MAX_PENDING {
            return Err(CaptureFailure::Busy);
        }
        self.next += 1;
        Ok(CaptureId(self.next))
    }
    fn insert(&mut self, id: CaptureId, max: (u32, u32), wire: P, deadline: Instant) {
        self.pending.push(Pending {
            id,
            max,
            deadline,
            wire,
        });
    }
    fn get(&mut self, id: CaptureId) -> Option<&mut Pending<P>> {
        self.pending.iter_mut().find(|p| p.id == id)
    }
    pub(crate) fn wait(&self, now: Instant) -> Option<Duration> {
        self.pending
            .iter()
            .map(|p| p.deadline.saturating_duration_since(now))
            .min()
    }
    /// Remove one capture WITHOUT destroying it (the caller reads its buffer first), or
    /// None if it already ended.
    fn take(&mut self, id: CaptureId) -> Option<Pending<P>> {
        let at = self.pending.iter().position(|p| p.id == id)?;
        Some(self.pending.swap_remove(at))
    }
    /// The frame is ready: `read` makes the image unless the deadline already passed.
    fn ready(
        &mut self,
        id: CaptureId,
        now: Instant,
        events: &mut Vec<Event>,
        read: impl FnOnce(&P, (u32, u32)) -> Result<Image, CaptureFailure>,
    ) {
        let Some(p) = self.take(id) else {
            return;
        };
        let result = if now < p.deadline {
            read(&p.wire, p.max)
        } else {
            Err(CaptureFailure::Deadline)
        };
        p.wire.destroy();
        events.push(Event::Capture { id, result });
    }
    fn fail(&mut self, id: CaptureId, reason: CaptureFailure, events: &mut Vec<Event>) {
        if let Some(p) = self.take(id) {
            p.wire.destroy();
            events.push(Event::Capture {
                id,
                result: Err(reason),
            });
        }
    }
    pub(crate) fn expire(&mut self, now: Instant, events: &mut Vec<Event>) {
        let late: Vec<_> = self
            .pending
            .iter()
            .filter(|p| p.deadline <= now)
            .map(|p| p.id)
            .collect();
        for id in late {
            self.fail(id, CaptureFailure::Deadline, events);
        }
    }
    /// The surface is going away: every pending capture ends `Closed` before the close
    /// itself is published.
    pub(crate) fn close_all(&mut self, events: &mut Vec<Event>) {
        let all: Vec<_> = self.pending.iter().map(|p| p.id).collect();
        for id in all {
            self.fail(id, CaptureFailure::Closed, events);
        }
    }
    pub(crate) fn destroy(&mut self) {
        for p in self.pending.drain(..) {
            p.wire.destroy();
        }
    }
}

/// The compositor's window list, kept for identifier lookups.
#[derive(Default)]
pub(crate) struct Toplevels {
    pub(crate) list: Option<list_v1::ExtForeignToplevelListV1>,
    pub(crate) sources: Option<source_manager_v1::ExtForeignToplevelImageCaptureSourceManagerV1>,
    pub(crate) copy: Option<manager_v1::ExtImageCopyCaptureManagerV1>,
    /// Handle, identifier (empty until sent), announced (`done` seen).
    handles: Vec<(handle_v1::ExtForeignToplevelHandleV1, String, bool)>,
}
impl Toplevels {
    pub(crate) fn destroy(&mut self) {
        for (h, _, _) in self.handles.drain(..) {
            h.destroy();
        }
        if let Some(l) = self.list.take() {
            l.stop();
            l.destroy();
        }
        if let Some(s) = self.sources.take() {
            s.destroy();
        }
        if let Some(c) = self.copy.take() {
            c.destroy();
        }
    }
}

impl Window {
    /// One image of the window the compositor lists as `identifier` (Hyalo: the window
    /// id in hex), fitting `max`. The answer is exactly one `Event::Capture` for the
    /// returned id. Layer roots only.
    pub fn capture_window(
        &mut self,
        identifier: &str,
        max: (u32, u32),
    ) -> Result<CaptureId, CaptureFailure> {
        let t = &self.toplevels;
        let (Some(sources), Some(copy)) = (&t.sources, &t.copy) else {
            return Err(CaptureFailure::Unsupported);
        };
        let Some((handle, _, _)) = t
            .handles
            .iter()
            .find(|(_, id, done)| *done && id == identifier)
        else {
            return Err(CaptureFailure::NotFound);
        };
        let id = self.captures.admit()?;
        let source = sources.create_source(handle, &self.qh, ());
        let session = copy.create_session(&source, manager_v1::Options::empty(), &self.qh, id);
        self.captures.insert(
            id,
            max,
            Wire {
                source,
                session,
                frame: None,
                target: None,
                size: None,
                formats: Vec::new(),
            },
            Instant::now() + DEADLINE,
        );
        let _ = self.connection.flush();
        Ok(id)
    }
    /// Cancel a pending capture; its one terminal event is `Cancelled`.
    pub fn cancel_capture(&mut self, id: CaptureId) {
        self.captures
            .fail(id, CaptureFailure::Cancelled, &mut self.events);
    }
    /// The session's constraints are complete: make the buffer and ask for one frame.
    fn start_frame(&mut self, id: CaptureId) -> Result<(), CaptureFailure> {
        let qh = self.qh.clone();
        let shm = self.shm.clone().ok_or(CaptureFailure::Unsupported)?;
        let Some(p) = self.captures.get(id) else {
            return Ok(());
        };
        if p.wire.frame.is_some() {
            // A later constraint batch: the frame already asked will fail on its own.
            return Ok(());
        }
        let (width, height) = p.wire.size.ok_or(CaptureFailure::Unknown)?;
        let (stride, bytes) = source_buffer(width, height)?;
        let format = [wl_shm::Format::Argb8888, wl_shm::Format::Xrgb8888]
            .into_iter()
            .find(|f| p.wire.formats.contains(f))
            .ok_or(CaptureFailure::BufferConstraints)?;
        let fd = rustix::fs::memfd_create("nk-capture", rustix::fs::MemfdFlags::CLOEXEC)
            .map_err(|_| CaptureFailure::Unknown)?;
        let file = File::from(fd);
        file.set_len(bytes as u64)
            .map_err(|_| CaptureFailure::Unknown)?;
        // SAFETY: private memfd of fixed size, read only after the frame's `ready`.
        let map = unsafe { MmapMut::map_mut(&file) }.map_err(|_| CaptureFailure::Unknown)?;
        let pool = shm.create_pool(file.as_fd(), bytes as i32, &qh, ());
        let proxy = pool.create_buffer(
            0,
            width as i32,
            height as i32,
            stride as i32,
            format,
            &qh,
            id,
        );
        pool.destroy();
        let frame = p.wire.session.create_frame(&qh, id);
        frame.attach_buffer(&proxy);
        frame.damage_buffer(0, 0, width as i32, height as i32);
        frame.capture();
        p.wire.frame = Some(frame);
        p.wire.target = Some(Target {
            proxy,
            map,
            width,
            height,
            stride,
            format,
        });
        Ok(())
    }
}
fn read(wire: &Wire, max: (u32, u32)) -> Result<Image, CaptureFailure> {
    let t = wire.target.as_ref().ok_or(CaptureFailure::Unknown)?;
    Ok(to_image(&t.map, t.width, t.height, t.stride, t.format, max))
}

impl Dispatch<list_v1::ExtForeignToplevelListV1, ()> for Window {
    fn event(
        w: &mut Self,
        list: &list_v1::ExtForeignToplevelListV1,
        e: list_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            list_v1::Event::Toplevel { toplevel } => {
                w.toplevels.handles.push((toplevel, String::new(), false))
            }
            list_v1::Event::Finished => {
                list.destroy();
                w.toplevels.list = None;
            }
            _ => {}
        }
    }
    wayland_client::event_created_child!(Window, list_v1::ExtForeignToplevelListV1, [
        list_v1::EVT_TOPLEVEL_OPCODE => (handle_v1::ExtForeignToplevelHandleV1, ())
    ]);
}
impl Dispatch<handle_v1::ExtForeignToplevelHandleV1, ()> for Window {
    fn event(
        w: &mut Self,
        h: &handle_v1::ExtForeignToplevelHandleV1,
        e: handle_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let handles = &mut w.toplevels.handles;
        let Some(at) = handles.iter().position(|(p, _, _)| p == h) else {
            return;
        };
        match e {
            handle_v1::Event::Identifier { identifier } => handles[at].1 = identifier,
            handle_v1::Event::Done => handles[at].2 = true,
            handle_v1::Event::Closed => {
                let (p, _, _) = handles.swap_remove(at);
                p.destroy();
            }
            _ => {}
        }
    }
}
impl Dispatch<session_v1::ExtImageCopyCaptureSessionV1, CaptureId> for Window {
    fn event(
        w: &mut Self,
        _: &session_v1::ExtImageCopyCaptureSessionV1,
        e: session_v1::Event,
        id: &CaptureId,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        let id = *id;
        match e {
            session_v1::Event::BufferSize { width, height } => {
                if let Some(p) = w.captures.get(id) {
                    p.wire.size = Some((width, height));
                }
            }
            session_v1::Event::ShmFormat {
                format: wayland_client::WEnum::Value(f),
            } => {
                if let Some(p) = w.captures.get(id) {
                    p.wire.formats.push(f);
                }
            }
            session_v1::Event::Done => {
                if let Err(reason) = w.start_frame(id) {
                    w.captures.fail(id, reason, &mut w.events);
                }
                let _ = w.connection.flush().map_err(err);
            }
            session_v1::Event::Stopped => {
                w.captures.fail(id, CaptureFailure::Stopped, &mut w.events);
            }
            _ => {}
        }
    }
}
impl Dispatch<frame_v1::ExtImageCopyCaptureFrameV1, CaptureId> for Window {
    fn event(
        w: &mut Self,
        _: &frame_v1::ExtImageCopyCaptureFrameV1,
        e: frame_v1::Event,
        id: &CaptureId,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            frame_v1::Event::Ready => w.captures.ready(*id, Instant::now(), &mut w.events, read),
            frame_v1::Event::Failed { reason } => {
                use frame_v1::FailureReason;
                let reason = match reason {
                    wayland_client::WEnum::Value(FailureReason::Stopped) => CaptureFailure::Stopped,
                    wayland_client::WEnum::Value(FailureReason::BufferConstraints) => {
                        CaptureFailure::BufferConstraints
                    }
                    _ => CaptureFailure::Unknown,
                };
                w.captures.fail(*id, reason, &mut w.events);
            }
            _ => {}
        }
    }
}
impl Dispatch<wl_buffer::WlBuffer, CaptureId> for Window {
    fn event(
        _: &mut Self,
        _: &wl_buffer::WlBuffer,
        _: wl_buffer::Event,
        _: &CaptureId,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}
delegate_noop!(Window: ignore source_v1::ExtImageCaptureSourceV1);
delegate_noop!(Window: ignore source_manager_v1::ExtForeignToplevelImageCaptureSourceManagerV1);
delegate_noop!(Window: ignore manager_v1::ExtImageCopyCaptureManagerV1);

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::rc::Rc;
    struct Fake(Rc<Cell<u32>>);
    impl Handle for Fake {
        fn destroy(&self) {
            self.0.set(self.0.get() + 1);
        }
    }
    fn add(c: &mut Captures<Fake>, d: &Rc<Cell<u32>>, now: Instant) -> CaptureId {
        let id = c.admit().unwrap();
        c.insert(id, (64, 64), Fake(d.clone()), now + DEADLINE);
        id
    }
    fn image() -> Result<Image, CaptureFailure> {
        Ok(Image {
            width: 1,
            height: 1,
            rgba: vec![1, 2, 3, 4],
        })
    }
    fn terminals(events: &[Event], id: CaptureId) -> usize {
        events
            .iter()
            .filter(|e| matches!(e, Event::Capture { id: i, .. } if *i == id))
            .count()
    }

    #[test]
    fn ninth_capture_is_busy_before_any_object_exists() {
        let (mut c, d, now) = (
            Captures::<Fake>::default(),
            Rc::new(Cell::new(0)),
            Instant::now(),
        );
        for _ in 0..MAX_PENDING {
            add(&mut c, &d, now);
        }
        assert_eq!(c.admit(), Err(CaptureFailure::Busy));
        assert_eq!(c.pending.len(), MAX_PENDING);
    }
    #[test]
    fn cancel_then_late_ready_publishes_nothing() {
        let (mut c, d, now) = (
            Captures::<Fake>::default(),
            Rc::new(Cell::new(0)),
            Instant::now(),
        );
        let id = add(&mut c, &d, now);
        let mut events = Vec::new();
        c.fail(id, CaptureFailure::Cancelled, &mut events);
        c.ready(id, now, &mut events, |_, _| image());
        assert_eq!(terminals(&events, id), 1);
        assert!(matches!(
            events[0],
            Event::Capture {
                result: Err(CaptureFailure::Cancelled),
                ..
            }
        ));
        assert_eq!(d.get(), 1);
    }
    #[test]
    fn deadline_ends_once_and_a_late_ready_is_no_image() {
        let (mut c, d, now) = (
            Captures::<Fake>::default(),
            Rc::new(Cell::new(0)),
            Instant::now(),
        );
        let expired = add(&mut c, &d, now);
        let late = add(&mut c, &d, now);
        let mut events = Vec::new();
        // A ready processed after its deadline, before expire ran: never pixels.
        c.ready(late, now + DEADLINE, &mut events, |_, _| image());
        c.expire(now + DEADLINE, &mut events);
        c.expire(now + DEADLINE * 2, &mut events);
        c.ready(expired, now, &mut events, |_, _| image());
        for id in [expired, late] {
            assert_eq!(terminals(&events, id), 1);
        }
        assert!(events.iter().all(|e| matches!(
            e,
            Event::Capture {
                result: Err(CaptureFailure::Deadline),
                ..
            }
        )));
        assert_eq!(d.get(), 2);
        assert_eq!(c.wait(now), None);
    }
    #[test]
    fn closed_ends_every_capture_before_a_ready_in_the_same_batch() {
        let (mut c, d, now) = (
            Captures::<Fake>::default(),
            Rc::new(Cell::new(0)),
            Instant::now(),
        );
        let a = add(&mut c, &d, now);
        let b = add(&mut c, &d, now);
        let mut events = Vec::new();
        c.close_all(&mut events);
        c.ready(a, now, &mut events, |_, _| image());
        assert_eq!(terminals(&events, a), 1);
        assert_eq!(terminals(&events, b), 1);
        assert_eq!(d.get(), 2);
    }
    #[test]
    fn a_ready_in_time_is_the_image_and_destroys_the_objects() {
        let (mut c, d, now) = (
            Captures::<Fake>::default(),
            Rc::new(Cell::new(0)),
            Instant::now(),
        );
        let id = add(&mut c, &d, now);
        let mut events = Vec::new();
        c.ready(id, now, &mut events, |_, max| {
            assert_eq!(max, (64, 64));
            image()
        });
        assert!(
            matches!(&events[0], Event::Capture { result: Ok(i), .. } if i.rgba == [1, 2, 3, 4])
        );
        assert_eq!(d.get(), 1);
    }

    #[test]
    fn source_limits_exactly_at_and_just_over() {
        // 4096×4096×4 is exactly 64 MiB.
        assert_eq!(source_buffer(4096, 4096), Ok((16384, MAX_SOURCE_BYTES)));
        assert_eq!(source_buffer(4096, 4097), Err(CaptureFailure::TooLarge));
        assert!(source_buffer(5120, 2880).is_ok());
        assert_eq!(source_buffer(8192, 1).map(|s| s.0), Ok(32768));
        assert_eq!(source_buffer(8193, 1), Err(CaptureFailure::TooLarge));
        assert_eq!(source_buffer(1, 8193), Err(CaptureFailure::TooLarge));
        assert_eq!(
            source_buffer(u32::MAX, u32::MAX),
            Err(CaptureFailure::TooLarge)
        );
        assert_eq!(source_buffer(0, 10), Err(CaptureFailure::BufferConstraints));
    }
    #[test]
    fn fit_keeps_aspect_never_enlarges_and_caps_the_image() {
        assert_eq!(fit(1920, 1080, (192, 192)), (192, 108));
        assert_eq!(fit(1080, 1920, (192, 192)), (108, 192));
        assert_eq!(fit(100, 50, (192, 192)), (100, 50));
        assert_eq!(fit(5120, 2880, (4096, 4096)), (1024, 576));
        assert_eq!(fit(10000, 1, (100, 100)), (100, 1));
        assert_eq!(fit(1920, 1080, (0, 0)), (1, 1));
    }
    /// Translucent, coloured, non-gray pixels: the conversion is checked per channel.
    #[test]
    fn premultiplied_argb_becomes_straight_rgba() {
        // Straight (200, 100, 50, 128) premultiplied: (100, 50, 25), in B, G, R, A order.
        let src = [25u8, 50, 100, 128, 0, 0, 0, 0];
        let img = to_image(&src, 2, 1, 8, wl_shm::Format::Argb8888, (2, 1));
        assert_eq!(img.rgba, [199, 100, 50, 128, 0, 0, 0, 0]);
    }
    #[test]
    fn xrgb_is_opaque_whatever_its_fourth_byte() {
        let src = [10u8, 20, 30, 0, 40, 50, 60, 7];
        let img = to_image(&src, 2, 1, 8, wl_shm::Format::Xrgb8888, (2, 1));
        assert_eq!(img.rgba, [30, 20, 10, 255, 60, 50, 40, 255]);
    }
    #[test]
    fn downscale_averages_premultiplied_so_transparency_does_not_darken() {
        // Opaque pure red next to fully transparent black, with stride padding.
        let src = [0u8, 0, 255, 255, 0, 0, 0, 0, 9, 9, 9, 9];
        let img = to_image(&src, 2, 1, 12, wl_shm::Format::Argb8888, (1, 1));
        // Half coverage of red: straight colour stays pure red, alpha halves.
        assert_eq!(img.rgba, [255, 0, 0, 128]);
        assert_eq!((img.width, img.height), (1, 1));
    }
    #[test]
    fn image_debug_never_prints_pixels() {
        let i = image().unwrap();
        assert_eq!(format!("{i:?}"), "Image(1x1)");
    }
}
