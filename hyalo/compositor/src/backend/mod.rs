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

/// Draws every output with a redraw queued (`Hyalo::queue_redraw`).
pub fn redraw_queued(state: &mut Hyalo) {
    match &state.backend {
        Backend::Tty(_) => tty::redraw_queued(state),
        Backend::Winit(_) => winit::redraw_queued(state),
    }
}

/// After a frame on `output`: which surfaces it scanned out, frame callbacks, dmabuf feedback.
pub fn post_repaint(
    state: &mut Hyalo,
    output: &Output,
    states: &RenderElementStates,
    feedback: Option<&SurfaceDmabufFeedback>,
) {
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
            window.send_dmabuf_feedback(output, surface_primary_scanout_output, |surface, _| {
                select_dmabuf_feedback(surface, states, &fb.render, &fb.scanout)
            });
        }
    }
    let map = layer_map_for_output(output);
    for layer in map.layers() {
        layer.with_surfaces(|surface, s| update(surface, s));
        layer.send_frame(output, time, throttle, surface_primary_scanout_output);
        if let Some(fb) = feedback {
            layer.send_dmabuf_feedback(output, surface_primary_scanout_output, |surface, _| {
                select_dmabuf_feedback(surface, states, &fb.render, &fb.scanout)
            });
        }
    }
    drop(map);
    if let CursorImageStatus::Surface(surface) = &state.cursor_status {
        with_surfaces_surface_tree(surface, |surface, s| update(surface, s));
        smithay::desktop::utils::send_frames_surface_tree(surface, output, time, throttle, surface_primary_scanout_output);
    }
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
