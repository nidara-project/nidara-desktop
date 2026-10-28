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
            Backend::Winit(w) => w.cursors = crate::cursor::Cursors::load(&cursor.theme, cursor.size),
        }
    }

    /// Whether input devices are configured by us (libinput) rather than by a host.
    pub fn configures_devices(&self) -> bool {
        matches!(self, Backend::Tty(_))
    }
}

/// Enabled scanouts, including mirror followers that are not logical desktop outputs.
pub fn physical_outputs(state: &Hyalo) -> Vec<Output> {
    match &state.backend {
        Backend::Tty(t) => t
            .connectors()
            .iter()
            .filter_map(|(s, _)| s.map(|s| s.output.clone()))
            .collect(),
        Backend::Winit(_) => state.space.outputs().cloned().collect(),
    }
}
pub fn physical_output(state: &Hyalo, name: &str) -> Option<Output> {
    physical_outputs(state)
        .into_iter()
        .find(|o| o.name() == name)
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

/// A picture of one output (`None` = the first), drawn again offscreen: a PNG, or a binary PPM
/// when the path ends in `.ppm` (screenshot.rs, `write_ppm`).
pub fn screenshot(
    state: &mut Hyalo,
    output: Option<&str>,
    path: &std::path::Path,
) -> Result<(), String> {
    let output = physical_outputs(state)
        .into_iter()
        .find(|o| output.is_none_or(|n| o.name() == n))
        .ok_or_else(|| format!("no output {}", output.unwrap_or("at all")))?;
    if crate::control::enabled() {
        eprintln!("CAPTURE_BEGIN {:?} {}", state.clock.now(), path.display());
    }
    let when = std::time::Instant::now();
    let (w, h, rgba) = capture_output_at(state, &output, false, when)?;
    if crate::control::enabled() {
        eprintln!("CAPTURE_END {:?} {}", state.clock.now(), path.display());
        // A delivery barrier may observe the exact event this capture emitted,
        // including a WRONG rectangle. Never poll for desired geometry.
        let mut rectangles = Vec::new();
        for window in state.space.elements_for_output(&output) {
            let Some(root) = window.toplevel().map(|t| t.wl_surface()) else { continue };
            for (popup, _) in smithay::desktop::PopupManager::popups_for_surface(root) {
                if let smithay::desktop::PopupKind::InputMethod(popup) = popup {
                    let r = popup.text_input_rectangle();
                    rectangles.push([r.loc.x, r.loc.y, r.size.w, r.size.h]);
                }
            }
        }
        // Where each window moving on its own was drawn in THIS picture (`drawn`, as `msg
        // windows` reports it, at the capture's moment): a check reads a moving window's place
        // from the picture itself, never from polls before and after it.
        let drawn: serde_json::Map<String, serde_json::Value> = state
            .wm
            .windows
            .iter()
            .filter_map(|m| {
                let p = state.wm.placement(m, when)?;
                let frame = m.frame().to_f64();
                Some((m.id.to_string(), serde_json::json!([p.origin.x, p.origin.y, frame.size.w * p.scale, frame.size.h * p.scale])))
            })
            .collect();
        // And each window opening, as its picture is drawn in it: its box scaled about its middle.
        let opening: serde_json::Map<String, serde_json::Value> = state
            .wm
            .windows
            .iter()
            .filter_map(|m| {
                let look = state.wm.opening(m.id, when)?;
                let f = m.frame().to_f64();
                let (w, h) = (f.size.w * look.scale, f.size.h * look.scale);
                let (x, y) = (f.loc.x + (f.size.w - w) / 2.0, f.loc.y + (f.size.h - h) / 2.0);
                Some((m.id.to_string(), serde_json::json!({"box": [x, y, w, h], "scale": look.scale, "alpha": look.alpha})))
            })
            .collect();
        let metadata = serde_json::json!({"input_method_rectangles": rectangles, "drawn": drawn, "opening": opening});
        std::fs::write(path.with_extension("capture.json"), metadata.to_string()).map_err(|e| e.to_string())?;
    }
    if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("ppm")) {
        crate::screenshot::write_ppm(path, w, h, &rgba)
    } else {
        crate::screenshot::write_png(path, w, h, &rgba)
    }
}

/// The pointer as the screen shows it on `output`, for a capture that includes it: None when
/// it is on another output. Its image, the backend's themed one — a client's own cursor
/// surface is drawn from the scene (render/mod.rs `push_cursor`).
fn pointer_for(state: &Hyalo, output: &Output) -> Option<crate::cursor::CursorImage> {
    let source = crate::mirror::scene(output);
    let output = &source;
    let here = state
        .space
        .output_geometry(output)?
        .to_f64()
        .contains(state.seat.get_pointer()?.current_location());
    if !here {
        return None;
    }
    let icon = match &state.cursor_status {
        smithay::input::pointer::CursorImageStatus::Named(icon) => *icon,
        _ => smithay::input::pointer::CursorIcon::Default,
    };
    let scale = output.current_scale().fractional_scale();
    let millis = std::time::Duration::from(state.clock.now()).as_millis() as u32;
    Some(match &state.backend {
        Backend::Tty(t) => t.cursors.image(icon, scale, millis),
        Backend::Winit(w) => w.cursors.image(icon, scale, millis),
    })
}

/// One output, drawn again offscreen, as RGBA rows (the screenshot request, capture.rs; a
/// recording on the CPU, protocols/screencopy.rs) — with the pointer when `pointer`.
pub fn capture_output(state: &mut Hyalo, output: &Output, pointer: bool) -> Result<(u32, u32, Vec<u8>), String> {
    capture_output_at(state, output, pointer, std::time::Instant::now())
}

/// `capture_output`, everything drawn as it is `when`.
fn capture_output_at(state: &mut Hyalo, output: &Output, pointer: bool, when: std::time::Instant) -> Result<(u32, u32, Vec<u8>), String> {
    let cursor = if pointer { pointer_for(state, output) } else { None };
    let Hyalo { backend, space, seat, cursor_status, wm, lock, config, .. } = state;
    let scene = crate::render::Scene::new(space, wm, seat, cursor_status, lock, &config.windows, config.animations.enabled, when, false);
    let captured = match backend {
        Backend::Winit(w) => crate::screenshot::capture(w.renderer(), &scene, output, cursor.as_ref()),
        Backend::Tty(t) => {
            let mut renderer = t.primary_renderer()?;
            crate::screenshot::capture(renderer.as_mut(), &scene, output, cursor.as_ref())
        }
    };
    // A capture draws the glass too, and may measure its ink: its result is collected as a
    // frame's is (where no frame is drawn — the headless harness — only a capture measures).
    if crate::render::glass_gl::take_ink_issued() {
        arm_ink_poll(state);
    }
    captured
}

/// One output (or `area` of it) drawn into a client's dmabuf of `size` (screencopy.rs), with the
/// pointer when `pointer`.
pub fn draw_output_into(
    state: &mut Hyalo,
    output: &Output,
    area: Option<smithay::utils::Rectangle<i32, smithay::utils::Physical>>,
    size: smithay::utils::Size<i32, smithay::utils::Physical>,
    dmabuf: &mut Dmabuf,
    pointer: bool,
) -> Result<(), String> {
    let cursor = if pointer { pointer_for(state, output) } else { None };
    let Hyalo { backend, space, seat, cursor_status, wm, lock, config, .. } = state;
    let scene = crate::render::Scene::new(space, wm, seat, cursor_status, lock, &config.windows, config.animations.enabled, std::time::Instant::now(), false);
    match backend {
        Backend::Winit(w) => crate::screenshot::draw_into(w.renderer(), &scene, output, area, size, dmabuf, cursor.as_ref()),
        Backend::Tty(t) => {
            let mut renderer = t.primary_renderer()?;
            crate::screenshot::draw_into(renderer.as_mut(), &scene, output, area, size, dmabuf, cursor.as_ref())
        }
    }
}

/// One output upright, as the screen shows it, drawn straight into a client's dmabuf
/// (capture.rs, a screen being shared) — with the pointer when `pointer`.
pub fn draw_upright_into(state: &mut Hyalo, output: &Output, dmabuf: &mut Dmabuf, pointer: bool) -> Result<(), String> {
    let cursor = if pointer { pointer_for(state, output) } else { None };
    let Hyalo { backend, space, seat, cursor_status, wm, lock, config, .. } = state;
    let scene = crate::render::Scene::new(space, wm, seat, cursor_status, lock, &config.windows, config.animations.enabled, std::time::Instant::now(), false);
    match backend {
        Backend::Winit(w) => crate::screenshot::draw_upright_into(w.renderer(), &scene, output, dmabuf, cursor.as_ref()),
        Backend::Tty(t) => {
            let mut renderer = t.primary_renderer()?;
            crate::screenshot::draw_upright_into(renderer.as_mut(), &scene, output, dmabuf, cursor.as_ref())
        }
    }
}

/// One window alone, drawn straight into a client's dmabuf (capture.rs).
pub fn draw_window_into(state: &mut Hyalo, window: &smithay::desktop::Window, scale: f64, dmabuf: &mut Dmabuf) -> Result<(), String> {
    match &mut state.backend {
        Backend::Winit(w) => crate::capture::draw_window_into(w.renderer(), window, scale, dmabuf),
        Backend::Tty(t) => {
            let mut renderer = t.primary_renderer()?;
            crate::capture::draw_window_into(renderer.as_mut(), window, scale, dmabuf)
        }
    }
}

/// The GPU buffers a capture client may hand us (capture.rs): the render node it allocates on,
/// and the modifiers our renderer draws XRGB/ARGB8888 into. None without a render node, and the
/// client copies through shared memory instead.
pub fn capture_dmabuf(state: &mut Hyalo) -> Option<smithay::wayland::image_copy_capture::DmabufConstraints> {
    use smithay::backend::{allocator::Fourcc, drm::NodeType, egl::EGLDevice};
    let (node, formats) = match &mut state.backend {
        Backend::Winit(w) => {
            let renderer = w.renderer();
            let node = EGLDevice::device_for_display(renderer.egl_context().display())
                .ok()?
                .try_get_render_node()
                .ok()
                .flatten()?;
            (node, renderer.egl_context().dmabuf_render_formats().clone())
        }
        Backend::Tty(t) => {
            let gpu = t.primary_gpu();
            let node = gpu.node_with_type(NodeType::Render).and_then(Result::ok).unwrap_or(gpu);
            let mut renderer = t.primary_renderer().ok()?;
            let formats = renderer.as_mut().egl_context().dmabuf_render_formats().clone();
            (node, formats)
        }
    };
    let formats: Vec<_> = [Fourcc::Xrgb8888, Fourcc::Argb8888]
        .into_iter()
        .map(|code| (code, formats.iter().filter(|f| f.code == code).map(|f| f.modifier).collect::<Vec<_>>()))
        .filter(|(_, modifiers)| !modifiers.is_empty())
        .collect();
    (!formats.is_empty()).then_some(smithay::wayland::image_copy_capture::DmabufConstraints { node, formats })
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

/// A picture of `window` as it is now, at `scale`, to draw after it is gone (render/snapshot.rs).
pub fn snapshot_window(state: &mut Hyalo, window: &smithay::desktop::Window, scale: f64) -> Result<crate::render::snapshot::Snapshot, String> {
    let Hyalo { backend, space, seat, cursor_status, wm, lock, config, .. } = state;
    let scene = crate::render::Scene::new(space, wm, seat, cursor_status, lock, &config.windows, config.animations.enabled, std::time::Instant::now(), false);
    match backend {
        Backend::Winit(w) => crate::render::snapshot::take(w.renderer(), &scene, window, scale),
        Backend::Tty(t) => {
            let mut renderer = t.primary_renderer()?;
            crate::render::snapshot::take(renderer.as_mut(), &scene, window, scale)
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
    for m in results {
        let Ok(surface) = m.surface.upgrade() else { continue };
        if !m.ink.is_empty() {
            redraw |= match m.whose {
                crate::render::glass::Whose::Client => crate::protocols::material::ink_measured(&surface, &m.ink),
                // The window controls answer their backdrop instead (render/controls.rs).
                crate::render::glass::Whose::Hyalo => false,
            };
        }
        if !m.answers.is_empty() {
            redraw |= match m.whose {
                crate::render::glass::Whose::Client => crate::protocols::material::response_measured(&surface, &m.answers),
                crate::render::glass::Whose::Hyalo => crate::render::controls::response_measured(&surface, &m.answers),
            };
        }
    }
    if redraw {
        state.queue_redraw(None);
    }
    let _ = state.display_handle.flush_clients();
    pending
}

/// Before a surface's first configure: the scale of the output it will appear on, so its first
/// frame is drawn at it. Otherwise it learns it only once a frame scans it out, and a window
/// opening is in none until it has opened (it is drawn as a picture of itself, wm/motion.rs):
/// its content drew twice, the second time ~700 ms late (nk-settings-slice, 2026-10-18).
pub fn tell_initial_scale(surface: &WlSurface, output: &Output) {
    let scale = output.current_scale().fractional_scale();
    smithay::wayland::compositor::with_states(surface, |s| with_fractional_scale(s, |f| f.set_preferred_scale(scale)));
}

/// After a frame on `output`: which surfaces it scanned out, frame callbacks, dmabuf feedback.
pub fn post_repaint(
    state: &mut Hyalo,
    output: &Output,
    states: &RenderElementStates,
    feedback: Option<&SurfaceDmabufFeedback>,
) {
    if let Some(source) = crate::mirror::source(output) {
        if let Some(logical) = crate::render::mirror::states(output) {
            post_repaint(state, &source, &logical, None);
        }
        state.complete_screencopy(output);
        state.complete_capture_output(output);
        return;
    }
    if crate::render::glass_gl::take_ink_issued() {
        arm_ink_poll(state);
    }
    // The debug overlay is fading a flash or a damage outline out (render/stats.rs).
    if crate::render::stats::overlay_animating(&output.name()) {
        state.queue_redraw(Some(output));
    }
    // Glass easing to its backdrop's answer, or a button's wash fading (protocols/material.rs
    // `Presenting`): a frame until it settles, none after.
    if crate::protocols::material::take_easing() {
        state.queue_redraw(None);
    }
    // A window shrinking into the dock or growing out of it (wm/minimize.rs): every output,
    // since it may cross from one to another. At rest nothing ticks.
    // Layers a client handed Hyalo to animate (protocols/layers.rs): their `done` goes out
    // with the time this frame was finished.
    let shown = Duration::from(state.clock.now());
    if state.step_animations() | state.step_motions() | crate::protocols::layers::step(shown) {
        state.queue_redraw(None);
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
        // A window opening is drawn as a picture of itself (wm/motion.rs), so its surfaces are
        // in no frame: it is told of this output's frames anyway, or it would wait for one to
        // draw its next — its first content stuck until it has opened.
        let opening = state.wm.by_window(window).is_some_and(|m| state.wm.openings.iter().any(|o| o.id == m.id));
        if opening {
            window.send_frame(output, time, throttle, |_, _| Some(output.clone()));
        } else {
            window.send_frame(output, time, throttle, surface_primary_scanout_output);
        }
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
    // X11 menus and tooltips (xwayland.rs) are in no space: Xwayland draws a window's next
    // frame only when told the last one was shown, and a Steam menu stayed at its first —
    // black — without these (2026-10-07).
    let og = state.space.output_geometry(output);
    for x in &state.wm.x11_overrides {
        let Some(surface) = x.wl_surface() else { continue };
        let on = og.is_some_and(|g| g.overlaps(smithay::utils::Rectangle::new(x.last_configure().loc, x.bbox().size)));
        if !on {
            continue;
        }
        with_surfaces_surface_tree(&surface, |surface, s| update(surface, s));
        smithay::desktop::utils::send_frames_surface_tree(&surface, output, time, throttle, |_, _| Some(output.clone()));
    }
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
    // A recorder waiting for this output's next frame gets it (protocols/screencopy.rs), and so
    // does a screen being shared (capture.rs).
    state.complete_screencopy(output);
    state.complete_capture_output(output);
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
            // A window opening is drawn as a picture of its surfaces taken this very frame
            // (render/mod.rs, wm/motion.rs), so its content IS on screen — but its surfaces are
            // not among the frame's elements, so their primary output stays unset and their
            // feedback waited for the end of the animation: a new window was told its first
            // frame was presented ~700 ms late (`[animations] open`), found by #852's timeline.
            let opening = state.wm.by_window(window).is_some_and(|m| state.wm.openings.iter().any(|o| o.id == m.id));
            if opening {
                window.take_presentation_feedback(&mut feedback, |_, _| Some(output.clone()), |surface, _| {
                    surface_presentation_feedback_flags_from_states(surface, None, states)
                });
            } else {
                window.take_presentation_feedback(&mut feedback, surface_primary_scanout_output, |surface, _| {
                    surface_presentation_feedback_flags_from_states(surface, None, states)
                });
            }
        }
    }
    for layer in layer_map_for_output(output).layers() {
        layer.take_presentation_feedback(&mut feedback, surface_primary_scanout_output, |surface, _| {
            surface_presentation_feedback_flags_from_states(surface, None, states)
        });
    }
    for surface in state.wm.x11_overrides.iter().filter_map(|x| x.wl_surface()) {
        smithay::desktop::utils::take_presentation_feedback_surface_tree(
            &surface,
            &mut feedback,
            |_, _| Some(output.clone()),
            |surface, _| surface_presentation_feedback_flags_from_states(surface, None, states),
        );
    }
    feedback
}
