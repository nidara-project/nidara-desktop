//! Where frames go and input comes from: `tty` (DRM/KMS + libinput + libseat — a real
//! session) or `winit` (a window inside another compositor, for development).

pub mod tty;
pub mod winit;

use std::time::Duration;

use smithay::{
    backend::{
        allocator::dmabuf::Dmabuf,
        renderer::element::{RenderElementStates, default_primary_scanout_output_compare, utils::select_dmabuf_feedback},
    },
    desktop::{
        layer_map_for_output,
        utils::{
            OutputPresentationFeedback, surface_presentation_feedback_flags_from_states,
            surface_primary_scanout_output, update_surface_primary_scanout_output, with_surfaces_surface_tree,
        },
    },
    input::{keyboard::LedState, pointer::CursorImageStatus},
    output::Output,
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    wayland::{dmabuf::{DmabufFeedback, DmabufState}, fractional_scale::with_fractional_scale},
};

use crate::state::Hyalo;

// One per process, made once: the size difference costs nothing.
#[allow(clippy::large_enum_variant)]
pub enum Backend {
    Tty(tty::TtyBackend),
    Winit(winit::WinitBackend),
}

/// The two dmabuf feedbacks of an output: buffers we render from, and buffers it can scan out.
#[derive(Debug, Clone)]
pub struct SurfaceDmabufFeedback {
    pub render: DmabufFeedback,
    pub scanout: DmabufFeedback,
}

impl Backend {
    pub fn seat_name(&self) -> String {
        match self {
            Backend::Tty(t) => t.seat_name(),
            Backend::Winit(_) => "winit".into(),
        }
    }

    pub fn queue_redraw(&mut self, output: &Output) {
        match self {
            Backend::Tty(t) => t.queue_redraw(output),
            Backend::Winit(w) => w.queue_redraw(),
        }
    }

    /// Does `output` put frames on screen now (the lock waits for those only: lock.rs)?
    pub fn output_shows_frames(&self, output: &Output) -> bool {
        match self {
            Backend::Tty(t) => t.shows_frames(output),
            Backend::Winit(_) => true,
        }
    }

    pub fn early_import(&mut self, surface: &WlSurface) {
        if let Backend::Tty(t) = self {
            t.early_import(surface);
        }
    }

    pub fn update_led_state(&mut self, led_state: LedState) {
        if let Backend::Tty(t) = self {
            t.update_led_state(led_state);
        }
    }

    pub fn dmabuf_state(&mut self) -> &mut DmabufState {
        match self {
            Backend::Tty(t) => t.dmabuf_state(),
            Backend::Winit(w) => w.dmabuf_state(),
        }
    }

    pub fn import_dmabuf(&mut self, dmabuf: &Dmabuf) -> bool {
        match self {
            Backend::Tty(t) => t.import_dmabuf(dmabuf),
            Backend::Winit(w) => w.import_dmabuf(dmabuf),
        }
    }

    pub fn change_vt(&mut self, vt: i32) {
        if let Backend::Tty(t) = self {
            t.change_vt(vt);
        }
    }

    pub fn reconfigure_input_devices(&mut self, input: &crate::config::Input) {
        if let Backend::Tty(t) = self {
            t.reconfigure_input_devices(input);
        }
    }

    pub fn reload_cursors(&mut self, cursor: &crate::config::CursorConfig) {
        match self {
            Backend::Tty(t) => t.reload_cursors(cursor),
            Backend::Winit(_) => {}
        }
    }

    /// Whether input devices are configured by us (libinput) rather than by a host.
    pub fn configures_devices(&self) -> bool {
        matches!(self, Backend::Tty(_))
    }
}

/// Switches an output off for good (config `enabled = false`).
pub fn tty_disable_output(state: &mut Hyalo, output: &Output) -> Result<(), String> {
    match state.backend {
        Backend::Tty(_) => tty::disable_output(state, output),
        Backend::Winit(_) => Err("the window's output cannot be switched off".into()),
    }
}

/// Switches on outputs the config now wants on.
pub fn tty_rescan_all(state: &mut Hyalo) {
    if matches!(state.backend, Backend::Tty(_)) {
        tty::rescan_disabled(state);
    }
}

/// A PNG of one output (`None` = the first), drawn again offscreen.
pub fn screenshot(state: &mut Hyalo, output: Option<&str>, path: &std::path::Path) -> Result<(), String> {
    let output = state
        .space
        .outputs()
        .find(|o| output.is_none_or(|n| o.name() == n))
        .cloned()
        .ok_or_else(|| format!("no output {}", output.unwrap_or("at all")))?;
    let (w, h, rgba) = capture_output(state, &output)?;
    crate::screenshot::write_png(path, w, h, &rgba)
}

/// One output, drawn again offscreen, as RGBA rows (the screenshot request, capture.rs).
pub fn capture_output(state: &mut Hyalo, output: &Output) -> Result<(u32, u32, Vec<u8>), String> {
    let Hyalo { backend, space, seat, cursor_status, wm, lock, .. } = state;
    let scene = crate::render::Scene::new(space, wm, seat, cursor_status, lock);
    match backend {
        Backend::Winit(w) => crate::screenshot::capture(w.renderer(), &scene, output),
        Backend::Tty(t) => {
            let mut renderer = t.primary_renderer()?;
            crate::screenshot::capture(renderer.as_mut(), &scene, output)
        }
    }
}

/// One window alone, as RGBA rows (capture.rs).
pub fn capture_window(state: &mut Hyalo, window: &smithay::desktop::Window, scale: f64) -> Result<(u32, u32, Vec<u8>), String> {
    match &mut state.backend {
        Backend::Winit(w) => crate::capture::draw_window(w.renderer(), window, scale),
        Backend::Tty(t) => {
            let mut renderer = t.primary_renderer()?;
            crate::capture::draw_window(renderer.as_mut(), window, scale)
        }
    }
}

/// Draws every output with a redraw queued (`Hyalo::queue_redraw`).
pub fn redraw_queued(state: &mut Hyalo) {
    match &state.backend {
        Backend::Tty(_) => tty::redraw_queued(state),
        Backend::Winit(_) => winit::redraw_queued(state),
    }
}

// ── The ink's readback (`nidara-material-v1`, render/glass_gl.rs) ───────────────────────

/// How often a measurement in flight is looked for: about a frame. The timer exists only
/// while one is in flight — nothing ticks while the glass is still.
const INK_POLL: Duration = Duration::from_millis(4);

thread_local! {
    static INK_POLL_ARMED: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// A frame issued an ink measurement: look for its result shortly, without waiting for it.
fn arm_ink_poll(state: &mut Hyalo) {
    if INK_POLL_ARMED.with(|a| a.replace(true)) {
        return;
    }
    let armed = state.loop_handle.insert_source(smithay::reexports::calloop::timer::Timer::from_duration(INK_POLL), |_, _, state| {
        if poll_ink(state) {
            smithay::reexports::calloop::timer::TimeoutAction::ToDuration(INK_POLL)
        } else {
            INK_POLL_ARMED.with(|a| a.set(false));
            smithay::reexports::calloop::timer::TimeoutAction::Drop
        }
    });
    if armed.is_err() {
        INK_POLL_ARMED.with(|a| a.set(false));
    }
}

/// Collects the measurements the GPU has finished and applies them (the ink event, and a redraw
/// where a shape's veil changed; the shadow under the glass). Whether any is still in flight.
fn poll_ink(state: &mut Hyalo) -> bool {
    let poll = |r: &mut smithay::backend::renderer::gles::GlesRenderer| {
        let user_data = r.egl_context().user_data() as *const smithay::utils::user_data::UserDataMap;
        // Safety: the EGL context, and its user data with it, outlives this call.
        r.with_context(|gl| unsafe { crate::render::glass_gl::poll_ink(gl, &*user_data) }).ok()
    };
    let polled = match &mut state.backend {
        Backend::Winit(w) => poll(w.renderer()),
        Backend::Tty(t) => t.primary_renderer().ok().and_then(|mut r| poll(r.as_mut())),
    };
    let Some((results, pending)) = polled else { return false };
    let mut redraw = false;
    let now = std::time::Instant::now();
    for m in results {
        if let Ok(surface) = m.surface.upgrade() {
            if !m.ink.is_empty() {
                redraw |= crate::protocols::material::ink_measured(&surface, &m.ink);
            }
            if !m.light.is_empty() {
                redraw |= crate::protocols::material::scrim_measured(&surface, &m.light, now);
            }
        }
    }
    if redraw {
        state.queue_redraw(None);
    }
    let _ = state.display_handle.flush_clients();
    pending
}

/// After a frame on `output`: which surfaces it scanned out, frame callbacks, dmabuf feedback.
pub fn post_repaint(
    state: &mut Hyalo,
    output: &Output,
    states: &RenderElementStates,
    feedback: Option<&SurfaceDmabufFeedback>,
) {
    if crate::render::glass_gl::take_ink_issued() {
        arm_ink_poll(state);
    }
    // A shadow under the glass is easing toward its strength: the next frame too.
    if crate::render::scrim::take_easing() {
        state.queue_redraw(Some(output));
    }
    let time = state.start_time.elapsed();
    let throttle = Some(Duration::from_secs(1));
    let update = |surface: &WlSurface, s: &smithay::wayland::compositor::SurfaceData| {
        update_surface_primary_scanout_output(
            surface,
            output,
            s,
            None,
            states,
            default_primary_scanout_output_compare,
        );
        if let Some(o) = surface_primary_scanout_output(surface, s) {
            with_fractional_scale(s, |f| f.set_preferred_scale(o.current_scale().fractional_scale()));
        }
    };

    for window in state.space.elements() {
        if !state.space.outputs_for_element(window).contains(output) {
            continue;
        }
        window.with_surfaces(|surface, s| update(surface, s));
        window.send_frame(output, time, throttle, surface_primary_scanout_output);
        if let Some(fb) = feedback {
            window.send_dmabuf_feedback(output, surface_primary_scanout_output, |surface, s| {
                pick_feedback(surface, s, states, fb)
            });
        }
    }
    let map = layer_map_for_output(output);
    for layer in map.layers() {
        layer.with_surfaces(|surface, s| update(surface, s));
        layer.send_frame(output, time, throttle, surface_primary_scanout_output);
        if let Some(fb) = feedback {
            layer.send_dmabuf_feedback(output, surface_primary_scanout_output, |surface, s| {
                pick_feedback(surface, s, states, fb)
            });
        }
    }
    drop(map);
    // The lock screen is a surface of its own (lock.rs): without its frame callbacks GTK's clock
    // never ticks there, and everything it fades in stays at its first frame — invisible.
    if let Some(surface) = state.lock.surface_for(output).cloned() {
        with_surfaces_surface_tree(&surface, |surface, s| update(surface, s));
        smithay::desktop::utils::send_frames_surface_tree(&surface, output, time, throttle, surface_primary_scanout_output);
        for (popup, _) in smithay::desktop::PopupManager::popups_for_surface(&surface) {
            smithay::desktop::utils::send_frames_surface_tree(popup.wl_surface(), output, time, throttle, surface_primary_scanout_output);
        }
    }
    if let CursorImageStatus::Surface(surface) = &state.cursor_status {
        with_surfaces_surface_tree(surface, |surface, s| update(surface, s));
        smithay::desktop::utils::send_frames_surface_tree(surface, output, time, throttle, surface_primary_scanout_output);
    }
    // A recorder waiting for this output's next frame gets it (protocols/screencopy.rs).
    state.complete_screencopy(output);
}

/// Marks a surface that has been offered the scan-out feedback once.
struct ScanoutOffered;

/// The dmabuf feedback a surface gets after a frame. Smithay's choice follows the frame: the
/// scan-out feedback while the surface is on a plane (or tried for one), the render feedback
/// otherwise. Every switch is a new set of modifiers, and a Vulkan client rebuilds its swapchain
/// for each one (Mesa answers VK_SUBOPTIMAL_KHR, GTK recreates on it): the shell rebuilt 55 times
/// in its first 25 s, as the one free overlay plane passed between its layers. The scan-out
/// tranche only offers formats we can also render from, so a surface keeps it once offered: at
/// most one rebuild per surface, and a buffer that loses its plane is still composited.
fn pick_feedback<'a>(
    surface: &WlSurface,
    s: &smithay::wayland::compositor::SurfaceData,
    states: &RenderElementStates,
    fb: &'a SurfaceDmabufFeedback,
) -> &'a DmabufFeedback {
    if s.data_map.get::<ScanoutOffered>().is_some() {
        return &fb.scanout;
    }
    let chosen = select_dmabuf_feedback(surface, states, &fb.render, &fb.scanout);
    if std::ptr::eq(chosen, &fb.scanout) {
        s.data_map.insert_if_missing_threadsafe(|| ScanoutOffered);
    }
    chosen
}

/// The presentation feedback of everything shown on `output` in the frame just queued.
pub fn take_presentation_feedback(state: &Hyalo, output: &Output, states: &RenderElementStates) -> OutputPresentationFeedback {
    let mut feedback = OutputPresentationFeedback::new(output);
    for window in state.space.elements() {
        if state.space.outputs_for_element(window).contains(output) {
            window.take_presentation_feedback(&mut feedback, surface_primary_scanout_output, |surface, _| {
                surface_presentation_feedback_flags_from_states(surface, None, states)
            });
        }
    }
    for layer in layer_map_for_output(output).layers() {
        layer.take_presentation_feedback(&mut feedback, surface_primary_scanout_output, |surface, _| {
            surface_presentation_feedback_flags_from_states(surface, None, states)
        });
    }
    feedback
}
