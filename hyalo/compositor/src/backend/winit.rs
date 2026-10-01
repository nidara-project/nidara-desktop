//! Hyalo in a window of another compositor: for development, never a session. Same scene,
//! same glass, same damage tracking as on hardware — only where the frame goes differs.

use smithay::{
    backend::{
        allocator::dmabuf::Dmabuf,
        egl::EGLDevice,
        renderer::{ImportDma, ImportMemWl, damage::OutputDamageTracker, gles::GlesRenderer},
        winit::{self, WinitEvent, WinitGraphicsBackend},
    },
    output::{Mode, Output, PhysicalProperties, Subpixel},
    reexports::calloop::LoopHandle,
    utils::Transform,
    wayland::dmabuf::{DmabufFeedbackBuilder, DmabufState},
};

use super::Backend;
use crate::{render, state::Hyalo};

pub struct WinitBackend {
    graphics: WinitGraphicsBackend<GlesRenderer>,
    output: Output,
    damage_tracker: OutputDamageTracker,
    dmabuf_state: DmabufState,
    /// A redraw was asked for and the window has not drawn it yet.
    queued: bool,
}

impl WinitBackend {
    /// The window, and its event source (inserted by `init` once the state exists).
    pub fn new() -> Result<(Self, winit::WinitEventLoop), Box<dyn std::error::Error>> {
        let (graphics, source) = winit::init::<GlesRenderer>()?;
        let mode = Mode { size: graphics.window_size(), refresh: 60_000 };
        let output = Output::new(
            "winit".into(),
            PhysicalProperties {
                size: (0, 0).into(),
                subpixel: Subpixel::Unknown,
                make: "Nidara".into(),
                model: "Hyalo (window)".into(),
                serial_number: String::new(),
            },
        );
        // An EGL window stores its rows bottom-up.
        output.change_current_state(Some(mode), Some(Transform::Flipped180), None, Some((0, 0).into()));
        output.set_preferred(mode);
        let damage_tracker = OutputDamageTracker::from_output(&output);
        let backend = Self {
            graphics,
            output,
            damage_tracker,
            dmabuf_state: DmabufState::new(),
            queued: true,
        };
        Ok((backend, source))
    }

    pub fn queue_redraw(&mut self) {
        if !self.queued {
            self.queued = true;
            self.graphics.window().request_redraw();
        }
    }

    pub fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf_state
    }

    pub fn renderer(&mut self) -> &mut GlesRenderer {
        self.graphics.renderer()
    }

    pub fn import_dmabuf(&mut self, dmabuf: &Dmabuf) -> bool {
        self.graphics.renderer().import_dmabuf(dmabuf, None).is_ok()
    }
}

/// Wires the window into the state: its output, the globals that depend on the GPU, events.
pub fn init(
    state: &mut Hyalo,
    loop_handle: &LoopHandle<'static, Hyalo>,
    source: winit::WinitEventLoop,
) -> Result<(), Box<dyn std::error::Error>> {
    let Backend::Winit(w) = &mut state.backend else { unreachable!() };
    let _global = w.output.create_global::<Hyalo>(&state.display_handle);
    state.space.map_output(&w.output, (0, 0));

    // linux-dmabuf v4, with feedback naming the GPU's render node: without it Mesa's EGL
    // cannot hand GPU buffers over and every GTK client draws in software.
    let renderer = w.graphics.renderer();
    let formats = renderer.dmabuf_formats();
    let node = EGLDevice::device_for_display(renderer.egl_context().display())
        .ok()
        .and_then(|d| d.try_get_render_node().ok().flatten());
    match node {
        Some(node) => {
            let feedback = DmabufFeedbackBuilder::new(node.dev_id(), formats).build()?;
            w.dmabuf_state.create_global_with_default_feedback::<Hyalo>(&state.display_handle, &feedback);
        }
        None => {
            w.dmabuf_state.create_global::<Hyalo>(&state.display_handle, formats);
        }
    }
    let shm_formats = w.graphics.renderer().shm_formats();
    state.shm_state.update_formats(shm_formats);

    loop_handle.insert_source(source, |event, _, state| match event {
        WinitEvent::Resized { size, .. } => {
            let Backend::Winit(w) = &mut state.backend else { return };
            let output = w.output.clone();
            output.change_current_state(Some(Mode { size, refresh: 60_000 }), None, None, None);
            state.arrange_layers();
            state.queue_redraw(Some(&output));
        }
        WinitEvent::Input(event) => state.process_input_event(event),
        WinitEvent::Redraw => render(state),
        WinitEvent::CloseRequested => state.loop_signal.stop(),
        _ => {}
    })?;
    Ok(())
}

pub fn redraw_queued(state: &mut Hyalo) {
    if let Backend::Winit(w) = &mut state.backend {
        w.graphics.window().request_redraw();
    }
}

fn render(state: &mut Hyalo) {
    let Hyalo { backend, space, seat, cursor_status, .. } = state;
    let Backend::Winit(w) = backend else { return };
    if !w.queued {
        return;
    }
    w.queued = false;
    let output = w.output.clone();
    let scene = render::Scene::new(space, seat, cursor_status);
    let age = w.graphics.buffer_age().unwrap_or(0);
    let result = {
        let (renderer, mut framebuffer) = match w.graphics.bind() {
            Ok(b) => b,
            Err(err) => {
                tracing::warn!(?err, "winit: could not bind the window");
                return;
            }
        };
        // No cursor: the host compositor draws its own over the window.
        let elements = render::output_elements(&scene, renderer, &output, None);
        w.damage_tracker
            .render_output(renderer, &mut framebuffer, age, &elements, render::CLEAR_COLOR)
            .map(|r| (r.damage.cloned(), r.states))
    };
    match result {
        Ok((damage, states)) => {
            if let Err(err) = w.graphics.submit(damage.as_deref()) {
                tracing::warn!(?err, "winit: submit failed");
            }
            super::post_repaint(state, &output, &states, None);
        }
        Err(err) => tracing::warn!(?err, "winit: render failed"),
    }
    let _ = state.display_handle.flush_clients();
}
