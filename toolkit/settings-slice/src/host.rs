// SPDX-License-Identifier: LGPL-3.0-or-later
//! Read-only slice host. No widget surfaces; one shm buffer per complete frame.
use crate::{
    Result, data, timing,
    view::{Fonts, View},
};
use std::{fs::File, os::fd::AsFd, time::Instant};
use wayland_client::{
    Connection, Dispatch, Proxy, QueueHandle, delegate_noop,
    protocol::{
        wl_buffer, wl_callback, wl_compositor, wl_keyboard, wl_output, wl_pointer, wl_registry,
        wl_seat, wl_shm, wl_shm_pool, wl_surface,
    },
};
use wayland_protocols::{
    wp::{
        fractional_scale::v1::client::{wp_fractional_scale_manager_v1, wp_fractional_scale_v1},
        presentation_time::client::{wp_presentation, wp_presentation_feedback},
        viewporter::client::{wp_viewport, wp_viewporter},
    },
    xdg::shell::client::{xdg_surface, xdg_toplevel, xdg_wm_base},
};
#[allow(clippy::all)]
mod material {
    use wayland_client;
    use wayland_client::protocol::*;
    pub mod __interfaces {
        use wayland_client::protocol::__interfaces::*;
        wayland_scanner::generate_interfaces!("../../protocols/nidara-material-v1.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("../../protocols/nidara-material-v1.xml");
}
use material::{nidara_material_manager_v1 as manager, nidara_material_v1 as mat};
struct Buffer {
    proxy: wl_buffer::WlBuffer,
    busy: bool,
}
pub struct Host {
    compositor: Option<wl_compositor::WlCompositor>,
    shm: Option<wl_shm::WlShm>,
    shell: Option<xdg_wm_base::XdgWmBase>,
    seat: Option<wl_seat::WlSeat>,
    viewporter: Option<wp_viewporter::WpViewporter>,
    fractional: Option<wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1>,
    presentation: Option<wp_presentation::WpPresentation>,
    manager: Option<manager::NidaraMaterialManagerV1>,
    surface: Option<wl_surface::WlSurface>,
    xdg: Option<xdg_surface::XdgSurface>,
    top: Option<xdg_toplevel::XdgToplevel>,
    viewport: Option<wp_viewport::WpViewport>,
    material: Option<mat::NidaraMaterialV1>,
    /// `--control-no-background`: no window background declared (the CI control).
    no_background: bool,
    pub width: u32,
    pub height: u32,
    scale: f64,
    integer_scale: i32,
    configured: bool,
    dirty: bool,
    pending: bool,
    closed: bool,
    buffers: Vec<Buffer>,
    commit: u64,
    ready: bool,
    pointer_x: f64,
    pointer_y: f64,
    pub active: bool,
    outputs: std::collections::HashMap<wayland_client::backend::ObjectId, i32>,
    entered: std::collections::HashSet<wayland_client::backend::ObjectId>,
}
impl Host {
    fn new(width: u32, height: u32) -> Self {
        Self {
            compositor: None,
            shm: None,
            shell: None,
            seat: None,
            viewporter: None,
            fractional: None,
            presentation: None,
            manager: None,
            surface: None,
            xdg: None,
            top: None,
            viewport: None,
            material: None,
            no_background: std::env::args().any(|s| s == "--control-no-background") && {
                eprintln!("CONTROL_APPLIED no-background");
                true
            },
            width,
            height,
            scale: 1.,
            integer_scale: 1,
            configured: false,
            dirty: true,
            pending: false,
            closed: false,
            buffers: vec![],
            commit: 0,
            ready: false,
            pointer_x: 0.,
            pointer_y: 0.,
            active: false,
            outputs: Default::default(),
            entered: Default::default(),
        }
    }
    fn paint(
        &mut self,
        fonts: &mut Fonts,
        view: &mut View,
        qh: &QueueHandle<Self>,
        conn: &Connection,
        start: Instant,
    ) -> Result<()> {
        if !self.configured || !self.dirty || self.pending {
            return Ok(());
        }
        self.buffers.retain(|b| {
            if !b.busy {
                b.proxy.destroy();
            }
            b.busy
        });
        if self.buffers.len() >= 2 {
            return Ok(());
        }
        let (scale, buffer_scale) = frame_scale(
            self.viewport.is_some(),
            self.fractional.is_some(),
            self.integer_scale,
            self.scale,
        );
        if self.width as f64 * scale > 16384. || self.height as f64 * scale > 16384. {
            return Err("buffer dimensions exceed renderer limit".into());
        }
        let painted = view.paint(
            fonts,
            self.width,
            self.height,
            scale,
            self.material.is_some(),
        )?;
        let pw = (self.width as f64 * scale).ceil() as i32;
        let ph = (self.height as f64 * scale).ceil() as i32;
        let file = File::from(
            rustix::fs::memfd_create("nk-settings-slice", rustix::fs::MemfdFlags::CLOEXEC)
                .map_err(data::err)?,
        );
        file.set_len(painted.pixels.len() as u64)
            .map_err(data::err)?;
        // SAFETY: fresh private memfd, never resized, not yet exposed to the compositor.
        let mut map = unsafe { memmap2::MmapMut::map_mut(&file) }.map_err(data::err)?;
        map.copy_from_slice(&painted.pixels);
        let pool = self.shm.as_ref().unwrap().create_pool(
            file.as_fd(),
            painted.pixels.len() as i32,
            qh,
            (),
        );
        let buffer = pool.create_buffer(0, pw, ph, pw * 4, wl_shm::Format::Argb8888, qh, ());
        pool.destroy();
        let s = self.surface.as_ref().unwrap();
        if let Some(v) = &self.viewport {
            v.set_destination(self.width as i32, self.height as i32);
            s.set_buffer_scale(1)
        } else {
            s.set_buffer_scale(buffer_scale)
        }
        if let Some(m) = &self.material {
            // The window's background is Hyalo's (toolkit/PHASE1.md D6): the colour only, opaque;
            // how much of it shows, and the blur under it, are the windows' settings there.
            if !self.no_background {
                let bg = view.token("--nidara-bg", true)?;
                m.set_window_background(bg[0] as f64 / 255., bg[1] as f64 / 255., bg[2] as f64 / 255.);
            }
        }
        s.attach(Some(&buffer), 0, 0);
        s.damage_buffer(0, 0, pw, ph);
        s.frame(qh, ());
        self.pending = true;
        if let Some(p) = &self.presentation {
            p.feedback(s, qh, self.commit + 1);
        }
        let t = Instant::now();
        s.commit();
        self.commit += 1;
        conn.flush().map_err(data::err)?;
        self.buffers.push(Buffer {
            proxy: buffer,
            busy: true,
        });
        self.dirty = false;
        if !self.ready && painted.full && painted.values == view.evidence {
            timing("first_commit", t);
            eprintln!(
                "TIMING main_to_first_commit={:.3}",
                start.elapsed().as_secs_f64() * 1000.
            );
            eprintln!("DRAWN_VALUES commit={} {}", self.commit, painted.values);
            eprintln!("VISIBLE_ICONS {}", serde_json::json!(painted.icons));
            if let Some(path) = std::env::var_os("NK_SLICE_FRAME") {
                std::fs::write(&path, &painted.pixels).map_err(data::err)?;
                eprintln!(
                    "FRAME_EVIDENCE {}",
                    serde_json::json!({"path":std::path::PathBuf::from(path).to_string_lossy(),"width":pw,"height":ph,"samples":painted.samples})
                );
            }
            eprintln!("CONTENT_READY commit={}", self.commit);
            self.ready = true;
        }
        Ok(())
    }
}
pub fn run(
    mut fonts: Fonts,
    mut view: View,
    updates: std::sync::mpsc::Receiver<Result<data::Services>>,
    control: bool,
    start: Instant,
) -> Result<()> {
    let t = Instant::now();
    let conn = Connection::connect_to_env().map_err(data::err)?;
    let mut queue = conn.new_event_queue();
    let qh = queue.handle();
    conn.display().get_registry(&qh, ());
    let (width, height) = view.dimensions()?;
    let mut h = Host::new(width, height);
    queue.roundtrip(&mut h).map_err(data::err)?;
    timing("Wayland_connect", t);
    for (name, present) in [
        ("wl_compositor", h.compositor.is_some()),
        ("wl_shm", h.shm.is_some()),
        ("xdg_wm_base", h.shell.is_some()),
        ("wl_seat", h.seat.is_some()),
    ] {
        if !present {
            return Err(format!("required Wayland protocol missing: {name}"));
        }
    }
    let surface = h.compositor.as_ref().unwrap().create_surface(&qh, ());
    let xdg = h.shell.as_ref().unwrap().get_xdg_surface(&surface, &qh, ());
    let top = xdg.get_toplevel(&qh, ());
    top.set_app_id("nk-settings-slice".into());
    top.set_title("Nidara Settings · measured slice".into());
    if let (Some(viewporter), Some(fractional)) = (&h.viewporter, &h.fractional) {
        h.viewport = Some(viewporter.get_viewport(&surface, &qh, ()));
        fractional.get_fractional_scale(&surface, &qh, ());
    }
    h.material = h
        .manager
        .as_ref()
        .map(|m| m.get_material(&surface, &qh, ()));
    h.surface = Some(surface.clone());
    h.xdg = Some(xdg);
    h.top = Some(top);
    surface.commit();
    h.commit = 1;
    // A11y publication is off the first-frame path. Its entire setup has a deadline
    // at the caller, since the phase-0 provider's internal connection has none.
    let semantics = crate::semantics::Worker::new(
        view.groups.iter().flat_map(|(_, r)| r).cloned().collect(),
        view.pages
            .iter()
            .map(|p| (p.title.clone(), p.selected))
            .collect(),
    );
    let mut last_active = false;
    while !h.closed {
        queue.dispatch_pending(&mut h).map_err(data::err)?;
        if h.active != last_active {
            semantics.focus(h.active);
            last_active = h.active;
        }
        semantics.check()?;
        while let Ok(update) = updates.try_recv() {
            view.refresh(&update?, control)?;
            semantics.refresh(
                view.groups
                    .iter()
                    .flat_map(|(_, rows)| rows)
                    .cloned()
                    .collect(),
                view.pages
                    .iter()
                    .map(|p| (p.title.clone(), p.selected))
                    .collect(),
            );
            h.dirty = true;
        }
        if h.pointer_y != 0. {
            let delta = h.pointer_y as f32;
            h.pointer_y = 0.;
            if h.pointer_x < view.exports.number("WINDOW_LAYOUT", "sidebar")? as f64 {
                let single = view.exports.number("ROW_HEIGHT", "single")?;
                view.sidebar_scroll = (view.sidebar_scroll + delta).clamp(
                    0.,
                    (view.pages.len() as f32 * single - h.height as f32).max(0.),
                );
            } else {
                view.content_scroll = (view.content_scroll + delta)
                    .clamp(0., (view.content_height - h.height as f32).max(0.));
            }
        }
        h.paint(&mut fonts, &mut view, &qh, &conn, start)?;
        conn.flush().map_err(data::err)?;
        if let Some(guard) = queue.prepare_read() {
            let fd = guard.connection_fd();
            let mut fds = [rustix::event::PollFd::new(
                &fd,
                rustix::event::PollFlags::IN,
            )];
            rustix::event::poll(
                &mut fds,
                Some(&rustix::event::Timespec {
                    tv_sec: 0,
                    tv_nsec: 16_000_000,
                }),
            )
            .map_err(data::err)?;
            if fds[0].revents().intersects(rustix::event::PollFlags::IN) {
                guard.read().map_err(data::err)?;
            }
        }
    }
    Ok(())
}
impl Dispatch<wl_registry::WlRegistry, ()> for Host {
    fn event(
        h: &mut Self,
        r: &wl_registry::WlRegistry,
        e: wl_registry::Event,
        _: &(),
        _: &Connection,
        q: &QueueHandle<Self>,
    ) {
        if let wl_registry::Event::Global {
            name,
            interface,
            version,
        } = e
        {
            match interface.as_str() {
                "wl_output" => {
                    let output: wl_output::WlOutput = r.bind(name, version.min(4), q, ());
                    h.outputs.insert(output.id(), 1);
                }
                "wl_compositor" => h.compositor = Some(r.bind(name, version.min(6), q, ())),
                "wl_shm" => h.shm = Some(r.bind(name, 1, q, ())),
                "xdg_wm_base" => h.shell = Some(r.bind(name, 1, q, ())),
                "wl_seat" => h.seat = Some(r.bind(name, version.min(7), q, ())),
                "wp_viewporter" => h.viewporter = Some(r.bind(name, 1, q, ())),
                "wp_fractional_scale_manager_v1" => h.fractional = Some(r.bind(name, 1, q, ())),
                "wp_presentation" => h.presentation = Some(r.bind(name, 1, q, ())),
                "nidara_material_manager_v1" => h.manager = Some(r.bind(name, 1, q, ())),
                _ => {}
            }
        }
    }
}
impl Dispatch<xdg_wm_base::XdgWmBase, ()> for Host {
    fn event(
        _: &mut Self,
        s: &xdg_wm_base::XdgWmBase,
        e: xdg_wm_base::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_wm_base::Event::Ping { serial } = e {
            s.pong(serial)
        }
    }
}
impl Dispatch<xdg_surface::XdgSurface, ()> for Host {
    fn event(
        h: &mut Self,
        s: &xdg_surface::XdgSurface,
        e: xdg_surface::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let xdg_surface::Event::Configure { serial } = e {
            s.ack_configure(serial);
            h.configured = true;
            h.dirty = true;
        }
    }
}
impl Dispatch<xdg_toplevel::XdgToplevel, ()> for Host {
    fn event(
        h: &mut Self,
        _: &xdg_toplevel::XdgToplevel,
        e: xdg_toplevel::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            xdg_toplevel::Event::Close => h.closed = true,
            xdg_toplevel::Event::Configure { width, height, .. } => {
                if width > 0 {
                    h.width = width as u32
                }
                if height > 0 {
                    h.height = height as u32
                }
                h.dirty = true
            }
            _ => {}
        }
    }
}
impl Dispatch<wp_fractional_scale_v1::WpFractionalScaleV1, ()> for Host {
    fn event(
        h: &mut Self,
        _: &wp_fractional_scale_v1::WpFractionalScaleV1,
        e: wp_fractional_scale_v1::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        // A scale it already draws at (re-sent, or the first one told) is no reason to repaint.
        if let wp_fractional_scale_v1::Event::PreferredScale { scale } = e {
            eprintln!("PREFERRED_SCALE scale={} after_commit={}", scale as f64 / 120., h.commit);
            let scale = scale as f64 / 120.;
            h.dirty |= h.scale != scale;
            h.scale = scale;
        }
    }
}
impl Dispatch<wl_surface::WlSurface, ()> for Host {
    fn event(
        h: &mut Self,
        _: &wl_surface::WlSurface,
        e: wl_surface::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            wl_surface::Event::PreferredBufferScale { factor } => {
                h.dirty |= h.integer_scale != factor.max(1);
                h.integer_scale = factor.max(1);
            }
            wl_surface::Event::Enter { output } => {
                h.entered.insert(output.id());
                h.output_scale();
            }
            wl_surface::Event::Leave { output } => {
                h.entered.remove(&output.id());
                h.output_scale();
            }
            _ => {}
        }
    }
}
impl Dispatch<wl_buffer::WlBuffer, ()> for Host {
    fn event(
        h: &mut Self,
        b: &wl_buffer::WlBuffer,
        e: wl_buffer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_buffer::Event::Release = e
            && let Some(b) = h.buffers.iter_mut().find(|v| v.proxy.id() == b.id())
        {
            b.busy = false
        }
    }
}
impl Dispatch<wl_callback::WlCallback, ()> for Host {
    fn event(
        h: &mut Self,
        _: &wl_callback::WlCallback,
        _: wl_callback::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        h.pending = false;
    }
}
impl Dispatch<wl_seat::WlSeat, ()> for Host {
    fn event(
        _: &mut Self,
        s: &wl_seat::WlSeat,
        e: wl_seat::Event,
        _: &(),
        _: &Connection,
        q: &QueueHandle<Self>,
    ) {
        if let wl_seat::Event::Capabilities {
            capabilities: wayland_client::WEnum::Value(c),
        } = e
        {
            if c.contains(wl_seat::Capability::Pointer) {
                s.get_pointer(q, ());
            }
            if c.contains(wl_seat::Capability::Keyboard) {
                s.get_keyboard(q, ());
            }
        }
    }
}
impl Dispatch<wl_pointer::WlPointer, ()> for Host {
    fn event(
        h: &mut Self,
        _: &wl_pointer::WlPointer,
        e: wl_pointer::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            wl_pointer::Event::Motion { surface_x, .. }
            | wl_pointer::Event::Enter { surface_x, .. } => h.pointer_x = surface_x,
            wl_pointer::Event::Axis { value, .. } => {
                h.pointer_y += value;
                h.dirty = true
            }
            _ => {}
        }
    }
}
impl Dispatch<wl_keyboard::WlKeyboard, ()> for Host {
    fn event(
        h: &mut Self,
        _: &wl_keyboard::WlKeyboard,
        e: wl_keyboard::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        match e {
            wl_keyboard::Event::Enter { .. } => h.active = true,
            wl_keyboard::Event::Leave { .. } => h.active = false,
            _ => {}
        }
    }
}
impl Dispatch<wp_presentation_feedback::WpPresentationFeedback, u64> for Host {
    fn event(
        _: &mut Self,
        _: &wp_presentation_feedback::WpPresentationFeedback,
        e: wp_presentation_feedback::Event,
        commit: &u64,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wp_presentation_feedback::Event::Presented {
            tv_sec_hi,
            tv_sec_lo,
            tv_nsec,
            ..
        } = e
        {
            eprintln!(
                "PRESENTED commit={commit} seconds={} nanoseconds={tv_nsec}",
                ((tv_sec_hi as u64) << 32) | tv_sec_lo as u64
            );
        }
    }
}
delegate_noop!(Host: ignore wl_compositor::WlCompositor);
delegate_noop!(Host: ignore wl_shm::WlShm);
delegate_noop!(Host: ignore wl_shm_pool::WlShmPool);

delegate_noop!(Host: ignore wp_viewporter::WpViewporter);
delegate_noop!(Host: ignore wp_viewport::WpViewport);
delegate_noop!(Host: ignore wp_fractional_scale_manager_v1::WpFractionalScaleManagerV1);
delegate_noop!(Host: ignore wp_presentation::WpPresentation);
delegate_noop!(Host: ignore manager::NidaraMaterialManagerV1);
delegate_noop!(Host: ignore mat::NidaraMaterialV1);

impl Host {
    fn output_scale(&mut self) {
        let scale = self
            .entered
            .iter()
            .filter_map(|id| self.outputs.get(id))
            .copied()
            .max()
            .unwrap_or(1);
        self.dirty |= self.integer_scale != scale;
        self.integer_scale = scale;
    }
}
impl Dispatch<wl_output::WlOutput, ()> for Host {
    fn event(
        h: &mut Self,
        output: &wl_output::WlOutput,
        e: wl_output::Event,
        _: &(),
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
        if let wl_output::Event::Scale { factor } = e {
            h.outputs.insert(output.id(), factor.max(1));
            h.output_scale();
        }
    }
}
fn frame_scale(viewporter: bool, fractional: bool, integer: i32, preferred: f64) -> (f64, i32) {
    if viewporter && fractional {
        (preferred, 1)
    } else {
        (integer.max(1) as f64, integer.max(1))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn integer_fallback_when_either_fractional_protocol_is_missing() {
        assert_eq!(frame_scale(true, true, 2, 1.25), (1.25, 1));
        for (v, f) in [(false, true), (true, false), (false, false)] {
            assert_eq!(frame_scale(v, f, 2, 1.25), (2., 2));
        }
    }
}
