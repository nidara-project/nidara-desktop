//! A real session: DRM/KMS + GBM for the screens, libinput for input, libseat (logind or
//! seatd) for access to both, udev for hotplug. Started from greetd through uwsm, or from a VT.
//!
//! Frames are paced by the hardware: a frame is drawn when something changed, queued, and the
//! next one waits for its vblank. A frame with nothing new is not submitted; its frame
//! callbacks still go out, timed to when the vblank would have been.
//!
//! Started from Smithay's anvil (MIT, `hyalo/LICENSE-smithay-MIT.txt`), reorganised around
//! that redraw state machine and Hyalo's own output configuration.

use std::{collections::HashMap, path::Path, time::{Duration, Instant}};

use smithay::{
    backend::{
        SwapBuffersError,
        allocator::{
            Fourcc,
            dmabuf::Dmabuf,
            format::FormatSet,
            gbm::{GbmAllocator, GbmBufferFlags, GbmDevice},
        },
        drm::{
            DrmAccessError, DrmDevice, DrmDeviceFd, DrmError, DrmEvent, DrmEventMetadata, DrmEventTime, DrmNode,
            NodeType,
            compositor::FrameFlags,
            exporter::gbm::GbmFramebufferExporter,
            output::{DrmOutput, DrmOutputManager, DrmOutputRenderElements},
        },
        egl::{EGLContext, EGLDevice, EGLDisplay, context::ContextPriority},
        input::InputEvent,
        libinput::{LibinputInputBackend, LibinputSessionInterface},
        renderer::{
            ImportDma, ImportMemWl,
            gles::GlesRenderer,
            multigpu::{GpuManager, gbm::GbmGlesBackend},
        },
        session::{Event as SessionEvent, Session, libseat::LibSeatSession},
        udev::{UdevBackend, UdevEvent, all_gpus, primary_gpu},
    },
    desktop::utils::OutputPresentationFeedback,
    input::keyboard::LedState,
    output::{Mode as WlMode, Output, PhysicalProperties},
    reexports::{
        calloop::{
            RegistrationToken,
            timer::{TimeoutAction, Timer},
        },
        drm::control::{ModeTypeFlags, connector, crtc},
        input::{self as libinput, DeviceCapability, Libinput},
        rustix::fs::OFlags,
        wayland_protocols::wp::{
            linux_dmabuf::zv1::server::zwp_linux_dmabuf_feedback_v1, presentation_time::server::wp_presentation_feedback,
        },
        wayland_server::{backend::GlobalId, protocol::wl_surface::WlSurface},
    },
    utils::{DeviceFd, Monotonic, Time},
    wayland::{
        dmabuf::{DmabufFeedbackBuilder, DmabufGlobal, DmabufState},
        presentation::Refresh,
    },
};
use smithay_drm_extras::{
    display_info,
    drm_scanner::{DrmScanEvent, DrmScanner},
};

use super::{Backend, SurfaceDmabufFeedback};
use crate::{cursor::Cursors, outputs, render, state::Hyalo};

/// 8-bit only: the glass copies the framebuffer into an RGB texture (see render/glass_gl.rs).
const COLOR_FORMATS: &[Fourcc] = &[Fourcc::Argb8888, Fourcc::Abgr8888];

type Allocator = GbmAllocator<DrmDeviceFd>;
type Exporter = GbmFramebufferExporter<DrmDeviceFd>;
type Feedback = Option<OutputPresentationFeedback>;
pub type HyaloDrmOutput = DrmOutput<Allocator, Exporter, Feedback, DrmDeviceFd>;

/// Which GPU and CRTC an output is, kept in its user data.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OutputId {
    pub node: DrmNode,
    pub crtc: crtc::Handle,
}

/// Where an output is in its frame cycle.
#[derive(Debug)]
enum Redraw {
    Idle,
    /// Draw at the next opportunity.
    Queued,
    /// A frame is on its way to the screen; draw again after its vblank if asked to.
    WaitingForVBlank { redraw_needed: bool },
    /// Nothing changed last time: frame callbacks went out, and the timer stands in for the
    /// vblank that did not come.
    WaitingForEstimatedVBlank { token: RegistrationToken, queued: bool },
}

pub struct Surface {
    pub output: Output,
    global: Option<GlobalId>,
    pub drm_output: HyaloDrmOutput,
    pub connector: connector::Info,
    dmabuf_feedback: Option<SurfaceDmabufFeedback>,
    redraw: Redraw,
    /// DPMS: an output switched off keeps its place and its windows (#594), it just does not
    /// draw.
    pub powered: bool,
    /// When the kernel last timed a vblank here: the beat the next frames are predicted on
    /// (render/timing.rs).
    last_vblank: Option<Instant>,
    /// The frame queued and not yet shown: when it began to be built, and when it was predicted
    /// to show — checked against the flip's timestamp (`msg stats` `presentation`).
    in_flight: Option<(Instant, Instant)>,
}

impl Drop for Surface {
    fn drop(&mut self) {
        self.output.leave_all();
    }
}

struct Device {
    drm_output_manager: DrmOutputManager<Allocator, Exporter, Feedback, DrmDeviceFd>,
    scanner: DrmScanner,
    render_node: Option<DrmNode>,
    surfaces: HashMap<crtc::Handle, Surface>,
    /// Connected but switched off in the configuration: kept so that switching them on
    /// needs no replug.
    disabled: HashMap<connector::Handle, (connector::Info, crtc::Handle)>,
    token: RegistrationToken,
}

pub struct TtyBackend {
    session: LibSeatSession,
    notifier: Option<smithay::backend::session::libseat::LibSeatSessionNotifier>,
    libinput: Libinput,
    primary_gpu: DrmNode,
    gpus: GpuManager<GbmGlesBackend<GlesRenderer, DrmDeviceFd>>,
    devices: HashMap<DrmNode, Device>,
    dmabuf_state: DmabufState,
    dmabuf_global: Option<DmabufGlobal>,
    keyboards: Vec<libinput::Device>,
    /// Every input device, to re-apply the `[input]` config when it changes.
    input_devices: Vec<libinput::Device>,
    pub cursors: Cursors,
    /// The night light's colour temperature, or neutral (night_light.rs).
    pub night_light: Option<u32>,
    /// What the ramps show now, on the way there (night_light.rs).
    pub night_light_fade: crate::night_light::Fade,
}

impl TtyBackend {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let (session, notifier) = LibSeatSession::new().map_err(|e| format!("no seat session (libseat): {e}"))?;
        let seat = session.seat();
        let primary_gpu = match std::env::var("HYALO_DRM_DEVICE") {
            Ok(path) => DrmNode::from_path(path)?,
            Err(_) => primary_gpu(&seat)?
                .and_then(|p| DrmNode::from_path(p).ok()?.node_with_type(NodeType::Render)?.ok())
                .or_else(|| all_gpus(&seat).ok()?.into_iter().find_map(|p| DrmNode::from_path(p).ok()))
                .ok_or("no GPU found")?,
        };
        tracing::info!(%primary_gpu, "primary GPU");
        let gpus = GpuManager::new(GbmGlesBackend::with_factory(|display| {
            let context = EGLContext::new_with_priority(display, ContextPriority::High)?;
            Ok(unsafe { GlesRenderer::new(context)? })
        }))?;
        let libinput = Libinput::new_with_udev::<LibinputSessionInterface<LibSeatSession>>(session.clone().into());
        Ok(Self {
            session,
            notifier: Some(notifier),
            libinput,
            primary_gpu,
            gpus,
            devices: HashMap::new(),
            dmabuf_state: DmabufState::new(),
            dmabuf_global: None,
            keyboards: Vec::new(),
            input_devices: Vec::new(),
            cursors: Cursors::load("default", 24),
            night_light: None,
            night_light_fade: Default::default(),
        })
    }

    pub fn seat_name(&self) -> String {
        self.session.seat()
    }

    pub fn change_vt(&mut self, vt: i32) {
        if let Err(err) = self.session.change_vt(vt) {
            tracing::warn!(?err, vt, "could not switch VT");
        }
    }

    pub fn dmabuf_state(&mut self) -> &mut DmabufState {
        &mut self.dmabuf_state
    }

    pub fn import_dmabuf(&mut self, dmabuf: &Dmabuf) -> bool {
        let ok = self
            .gpus
            .single_renderer(&self.primary_gpu)
            .is_ok_and(|mut r| r.import_dmabuf(dmabuf, None).is_ok());
        if ok && dmabuf.node().is_none() {
            dmabuf.set_node(self.primary_gpu);
        }
        ok
    }

    /// The primary GPU's renderer, for work outside a frame (screenshots).
    pub fn primary_renderer(&mut self) -> Result<render::UdevRenderer<'_>, String> {
        self.gpus.single_renderer(&self.primary_gpu).map_err(|e| e.to_string())
    }

    pub fn early_import(&mut self, surface: &WlSurface) {
        if let Err(err) = self.gpus.early_import(self.primary_gpu, surface) {
            tracing::trace!(?err, "early import failed");
        }
    }

    pub fn update_led_state(&mut self, led_state: LedState) {
        for k in &mut self.keyboards {
            k.led_update(led_state.into());
        }
    }

    pub fn reconfigure_input_devices(&mut self, input: &crate::config::Input) {
        for d in &mut self.input_devices {
            outputs::configure_input_device(d, input);
        }
    }

    pub fn reload_cursors(&mut self, cursor: &crate::config::CursorConfig) {
        self.cursors = Cursors::load(&cursor.theme, cursor.size);
    }

    pub fn queue_redraw(&mut self, output: &Output) {
        let Some(s) = self.surface_mut(output) else { return };
        s.redraw = match std::mem::replace(&mut s.redraw, Redraw::Idle) {
            Redraw::Idle => Redraw::Queued,
            Redraw::WaitingForVBlank { .. } => Redraw::WaitingForVBlank { redraw_needed: true },
            Redraw::WaitingForEstimatedVBlank { token, .. } => Redraw::WaitingForEstimatedVBlank { token, queued: true },
            r @ Redraw::Queued => r,
        };
    }

    fn surface_mut(&mut self, output: &Output) -> Option<&mut Surface> {
        let id = *output.user_data().get::<OutputId>()?;
        self.devices.get_mut(&id.node)?.surfaces.get_mut(&id.crtc)
    }

    pub fn surface(&self, output: &Output) -> Option<&Surface> {
        let id = *output.user_data().get::<OutputId>()?;
        self.devices.get(&id.node)?.surfaces.get(&id.crtc)
    }

    /// Every connected connector, on or off: (its output if on, its info).
    pub fn connectors(&self) -> Vec<(Option<&Surface>, &connector::Info)> {
        let mut v = Vec::new();
        for d in self.devices.values() {
            for s in d.surfaces.values() {
                v.push((Some(s), &s.connector));
            }
            for (info, _) in d.disabled.values() {
                v.push((None, info));
            }
        }
        v
    }

    /// Does `output` put frames on screen now: powered, and this session on the active VT?
    pub fn shows_frames(&self, output: &Output) -> bool {
        self.session.is_active()
            && self.devices.values().flat_map(|d| d.surfaces.values()).any(|s| &s.output == output && s.powered)
    }

    /// Each GPU with the CRTCs that show a powered output (night_light.rs).
    pub fn gamma_targets(&self) -> Vec<(&smithay::backend::drm::DrmDevice, Vec<crtc::Handle>)> {
        self.devices
            .values()
            .map(|d| {
                let crtcs = d.surfaces.iter().filter(|(_, s)| s.powered).map(|(c, _)| *c).collect();
                (d.drm_output_manager.device(), crtcs)
            })
            .collect()
    }

    /// Switches an output's power (DPMS). Off keeps everything in place; on redraws.
    pub fn set_power(&mut self, output: &Output, on: bool) {
        let Some(s) = self.surface_mut(output) else { return };
        if s.powered == on {
            return;
        }
        s.powered = on;
        if on {
            s.drm_output.reset_buffers();
            s.redraw = Redraw::Queued;
            // Waking may have reset the ramps.
            let _ = self.apply_gamma();
        } else {
            s.drm_output.with_compositor(|c| {
                if let Err(err) = c.clear() {
                    tracing::warn!(?err, "could not switch the output off");
                }
            });
            s.redraw = Redraw::Idle;
        }
    }

    pub fn set_vrr(&mut self, output: &Output, on: bool) -> Result<(), String> {
        let s = self.surface_mut(output).ok_or("no such output")?;
        let conn = s.connector.handle();
        s.drm_output.with_compositor(|c| {
            use smithay::backend::drm::VrrSupport;
            if on && matches!(c.vrr_supported(conn), Ok(VrrSupport::NotSupported) | Err(_)) {
                return Err("this output does not support VRR".to_string());
            }
            c.use_vrr(on).map_err(|e| e.to_string())
        })
    }

    pub fn vrr_state(&self, output: &Output) -> (bool, bool) {
        let Some(s) = self.surface(output) else { return (false, false) };
        let conn = s.connector.handle();
        s.drm_output.with_compositor(|c| {
            use smithay::backend::drm::VrrSupport;
            let supported = !matches!(c.vrr_supported(conn), Ok(VrrSupport::NotSupported) | Err(_));
            (supported, c.vrr_enabled())
        })
    }
}

/// Wires the session into the state: seat events, input, GPUs and their outputs, hotplug.
pub fn init(state: &mut Hyalo) -> Result<(), Box<dyn std::error::Error>> {
    let handle = state.loop_handle.clone();
    let Backend::Tty(tty) = &mut state.backend else { unreachable!() };
    tty.cursors = Cursors::load(&state.config.cursor.theme, state.config.cursor.size);
    let seat_name = tty.session.seat();

    // Input.
    tty.libinput
        .udev_assign_seat(&seat_name)
        .map_err(|_| "libinput could not take the seat")?;
    let libinput_backend = LibinputInputBackend::new(tty.libinput.clone());
    handle.insert_source(libinput_backend, |mut event, _, state| {
        if let InputEvent::DeviceAdded { device } = &mut event {
            let config = state.config.input.clone();
            outputs::configure_input_device(device, &config);
            if let Backend::Tty(tty) = &mut state.backend {
                tty.input_devices.push(device.clone());
            }
            if device.has_capability(DeviceCapability::Keyboard)
                && let Backend::Tty(tty) = &mut state.backend {
                    if let Some(kb) = state.seat.get_keyboard() {
                        device.led_update(kb.led_state().into());
                    }
                    tty.keyboards.push(device.clone());
                }
        } else if let InputEvent::DeviceRemoved { device } = &event
            && let Backend::Tty(tty) = &mut state.backend {
                tty.keyboards.retain(|k| k != device);
                tty.input_devices.retain(|k| k != device);
            }
        state.process_input_event(event);
    })?;

    // Seat: another VT took the screens, or gave them back.
    let notifier = tty.notifier.take().unwrap();
    handle.insert_source(notifier, |event, _, state| match event {
        SessionEvent::PauseSession => {
            tracing::info!("session paused");
            let Backend::Tty(tty) = &mut state.backend else { return };
            tty.libinput.suspend();
            for d in tty.devices.values_mut() {
                d.drm_output_manager.pause();
            }
        }
        SessionEvent::ActivateSession => {
            tracing::info!("session resumed");
            let Backend::Tty(tty) = &mut state.backend else { return };
            if tty.libinput.resume().is_err() {
                tracing::error!("libinput did not resume");
            }
            for d in tty.devices.values_mut() {
                if let Err(err) = d.drm_output_manager.lock().activate(false) {
                    tracing::error!(?err, "could not reactivate a GPU");
                }
                for s in d.surfaces.values_mut() {
                    s.drm_output.reset_buffers();
                    s.redraw = Redraw::Idle;
                }
            }
            // Another session had the screens: the night light's ramps are ours to put back.
            let _ = tty.apply_gamma();
            state.queue_redraw(None);
        }
    })?;

    // GPUs: the primary first, so a display-only GPU can fall back to it for rendering.
    let udev = UdevBackend::new(&seat_name)?;
    let primary = tty.primary_gpu;
    let primary_node = primary.node_with_type(NodeType::Primary).and_then(|n| n.ok());
    let mut list: Vec<_> = udev.device_list().map(|(id, p)| (id, p.to_path_buf())).collect();
    list.sort_by_key(|(id, _)| !(Some(*id) == primary_node.map(|n| n.dev_id()) || *id == primary.dev_id()));
    // HYALO_DRM_DEVICE names the one GPU to use, and then ONLY it: CI's runner also exposes a
    // hyperv_drm card next to vkms, and a VM may show several.
    let exclusive = std::env::var_os("HYALO_DRM_DEVICE").is_some();
    for (id, path) in list {
        if exclusive && id != primary.dev_id() && Some(id) != primary_node.map(|n| n.dev_id()) {
            tracing::info!(?path, "skipped: HYALO_DRM_DEVICE names another GPU");
            continue;
        }
        match DrmNode::from_dev_id(id) {
            Ok(node) => {
                if let Err(err) = device_added(state, node, &path) {
                    tracing::warn!(%err, ?path, "skipping a GPU");
                }
            }
            Err(err) => tracing::warn!(?err, "skipping a GPU"),
        }
    }

    // Globals that depend on the primary GPU — re-read: adding it may have replaced a render
    // node that cannot render (a software EGL device) with its card node.
    let Backend::Tty(tty) = &mut state.backend else { unreachable!() };
    let primary = tty.primary_gpu;
    let renderer = tty.gpus.single_renderer(&primary)?;
    state.shm_state.update_formats(renderer.shm_formats());
    let formats = renderer.dmabuf_formats();
    drop(renderer);
    let feedback = DmabufFeedbackBuilder::new(primary.dev_id(), formats).build()?;
    tty.dmabuf_global =
        Some(tty.dmabuf_state.create_global_with_default_feedback::<Hyalo>(&state.display_handle, &feedback));
    // Per-output feedback now that the primary renderer exists.
    let primary_gpu = tty.primary_gpu;
    for (node, d) in tty.devices.iter_mut() {
        for s in d.surfaces.values_mut() {
            s.dmabuf_feedback = s.drm_output.with_compositor(|c| {
                surface_feedback(primary_gpu, d.render_node, *node, &mut tty.gpus, c.surface())
            });
        }
    }

    handle.insert_source(udev, |event, _, state| match event {
        UdevEvent::Added { device_id, path } => {
            if let Ok(node) = DrmNode::from_dev_id(device_id)
                && let Err(err) = device_added(state, node, &path) {
                    tracing::warn!(%err, "skipping a GPU");
                }
        }
        UdevEvent::Changed { device_id } => {
            if let Ok(node) = DrmNode::from_dev_id(device_id) {
                device_changed(state, node);
            }
        }
        UdevEvent::Removed { device_id } => {
            if let Ok(node) = DrmNode::from_dev_id(device_id) {
                device_removed(state, node);
            }
        }
    })?;
    Ok(())
}

fn device_added(state: &mut Hyalo, node: DrmNode, path: &Path) -> Result<(), String> {
    let Backend::Tty(tty) = &mut state.backend else { unreachable!() };
    let fd = tty
        .session
        .open(path, OFlags::RDWR | OFlags::CLOEXEC | OFlags::NOCTTY | OFlags::NONBLOCK)
        .map_err(|e| format!("open {path:?}: {e}"))?;
    let fd = DrmDeviceFd::new(DeviceFd::from(fd));
    let (drm, notifier) = DrmDevice::new(fd.clone(), true).map_err(|e| e.to_string())?;
    let gbm = GbmDevice::new(fd).map_err(|e| e.to_string())?;

    let token = state
        .loop_handle
        .insert_source(notifier, move |event, metadata, state| match event {
            DrmEvent::VBlank(crtc) => on_vblank(state, node, crtc, metadata),
            DrmEvent::Error(err) => tracing::error!(?err, "DRM"),
        })
        .map_err(|e| e.to_string())?;

    // Can this GPU render? A display-only one (DisplayLink, some docks) scans out what the
    // primary renders. Software rendering (llvmpipe) is accepted for the primary GPU only —
    // that is CI's vkms and a VM without 3D acceleration; for any other device the primary's
    // hardware is the better renderer.
    let is_primary = node == tty.primary_gpu
        || tty.primary_gpu.node_with_type(NodeType::Primary).and_then(|n| n.ok()) == Some(node);
    let render_node = (|| {
        let display = unsafe { EGLDisplay::new(gbm.clone()).ok()? };
        let device = EGLDevice::device_for_display(&display).ok()?;
        if device.is_software() {
            if !is_primary {
                return None;
            }
            tracing::warn!(%node, "rendering in software (no 3D acceleration on this GPU)");
        }
        let render_node = device.try_get_render_node().ok().flatten().unwrap_or(node);
        tty.gpus.as_mut().add_node(render_node, gbm.clone()).ok()?;
        Some(render_node)
    })();
    // A KMS-only device (vkms) has no render node: the card node itself renders.
    if is_primary && let Some(rn) = render_node {
        tty.primary_gpu = rn;
    }

    let allocator = match render_node {
        Some(_) => GbmAllocator::new(gbm.clone(), GbmBufferFlags::RENDERING | GbmBufferFlags::SCANOUT),
        None => tty
            .devices
            .values()
            .find(|d| d.render_node == Some(tty.primary_gpu))
            .map(|d| d.drm_output_manager.allocator().clone())
            .ok_or("the primary GPU is missing")?,
    };
    let exporter = GbmFramebufferExporter::new(gbm.clone(), render_node.into());
    let mut renderer = tty
        .gpus
        .single_renderer(&render_node.unwrap_or(tty.primary_gpu))
        .map_err(|e| e.to_string())?;
    let render_formats = renderer
        .as_mut()
        .egl_context()
        .dmabuf_render_formats()
        .iter()
        .filter(|f| render_node.is_some() || f.modifier == smithay::backend::allocator::Modifier::Linear)
        .copied()
        .collect::<FormatSet>();
    drop(renderer);
    let drm_output_manager = DrmOutputManager::new(
        drm,
        allocator,
        exporter,
        Some(gbm),
        COLOR_FORMATS.iter().copied(),
        render_formats,
    );
    tty.devices.insert(
        node,
        Device {
            drm_output_manager,
            scanner: DrmScanner::new(),
            render_node,
            surfaces: HashMap::new(),
            disabled: HashMap::new(),
            token,
        },
    );
    device_changed(state, node);
    Ok(())
}

/// Rescans a GPU's connectors: monitors plugged, unplugged, or whose modes changed.
pub fn device_changed(state: &mut Hyalo, node: DrmNode) {
    let Backend::Tty(tty) = &mut state.backend else { return };
    let Some(device) = tty.devices.get_mut(&node) else { return };
    let events = match device.scanner.scan_connectors(device.drm_output_manager.device()) {
        Ok(r) => r.into_iter().collect::<Vec<_>>(),
        Err(err) => {
            tracing::warn!(?err, "could not scan connectors");
            return;
        }
    };
    for event in events {
        match event {
            DrmScanEvent::Connected { connector, crtc: Some(crtc) } => connector_connected(state, node, connector, crtc),
            DrmScanEvent::Disconnected { connector, crtc: Some(crtc) } => connector_disconnected(state, node, connector, crtc),
            DrmScanEvent::Changed { connector, crtc: Some(crtc) } => connector_changed(state, node, connector, crtc),
            _ => {}
        }
    }
    outputs::arrange(state);
}

pub fn connector_name(c: &connector::Info) -> String {
    format!("{}-{}", c.interface().as_str(), c.interface_id())
}

fn connector_connected(state: &mut Hyalo, node: DrmNode, connector: connector::Info, crtc: crtc::Handle) {
    let name = connector_name(&connector);
    let config = state.config.outputs.get(&name).cloned().unwrap_or_default();
    let primary_gpu = {
        let Backend::Tty(tty) = &state.backend else { return };
        tty.primary_gpu
    };
    let Backend::Tty(tty) = &mut state.backend else { return };
    let Some(device) = tty.devices.get_mut(&node) else { return };
    if !config.enabled {
        tracing::info!(%name, "connected, switched off in the configuration");
        device.disabled.insert(connector.handle(), (connector, crtc));
        return;
    }
    device.disabled.remove(&connector.handle());

    let drm = device.drm_output_manager.device();
    let info = display_info::for_connector(drm, connector.handle());
    let make = info.as_ref().and_then(|i| i.make()).unwrap_or_else(|| "Unknown".into());
    let model = info.as_ref().and_then(|i| i.model()).unwrap_or_else(|| "Unknown".into());
    let serial = info.as_ref().and_then(|i| i.serial()).unwrap_or_default();

    let Some(drm_mode) = pick_mode(&connector, config.parsed_mode()) else {
        tracing::warn!(%name, "no modes");
        return;
    };
    let wl_mode = WlMode::from(drm_mode);
    let (pw, ph) = connector.size().unwrap_or((0, 0));
    let output = Output::new(
        name.clone(),
        PhysicalProperties {
            size: (pw as i32, ph as i32).into(),
            subpixel: connector.subpixel().into(),
            make,
            model,
            serial_number: serial,
        },
    );
    let global = output.create_global::<Hyalo>(&state.display_handle);
    output.set_preferred(
        connector
            .modes()
            .iter()
            .find(|m| m.mode_type().contains(ModeTypeFlags::PREFERRED))
            .map(|m| WlMode::from(*m))
            .unwrap_or(wl_mode),
    );
    output.change_current_state(
        Some(wl_mode),
        config.parsed_transform(),
        Some(smithay::output::Scale::Fractional(config.scale)),
        None,
    );
    output.user_data().insert_if_missing(|| OutputId { node, crtc });

    let render_node = device.render_node.unwrap_or(primary_gpu);
    let mut renderer = match tty.gpus.single_renderer(&render_node) {
        Ok(r) => r,
        Err(err) => {
            tracing::warn!(?err, "no renderer for this output");
            return;
        }
    };
    let mut planes = match device.drm_output_manager.device().planes(&crtc) {
        Ok(p) => p,
        Err(err) => {
            tracing::warn!(?err, "could not read the CRTC's planes");
            return;
        }
    };
    // No overlay (or underlay) planes, on any driver: only the primary plane, for a fullscreen
    // window's direct scan-out (`[render] direct_scanout`), and the cursor plane. The hardware
    // blends planes its own way — amdgpu in linear light — and a driver's TEST_ONLY commit says
    // whether it CAN show a plane, never whether it will look like our composition: kitty at 50 %
    // went visibly pale on an overlay plane, and only while the bar and the dock were gone, since
    // their monitor-sized surfaces kept it in our composition (owner-caught 2026-10-02; screenshots
    // cannot see it, they compose again with GL). NVIDIA's overlay planes also break scan-out
    // (anvil's finding), and the planes passing between surfaces made the scan-out feedback
    // switch (`pick_feedback`). Hyprland and Mutter use no overlay planes for windows either. If
    // they ever come back: opaque surfaces only, no underlays — an opaque pixel looks the same
    // wherever it is blended, a translucent one does not.
    planes.overlay.clear();
    let drm_output = match device
        .drm_output_manager
        .lock()
        .initialize_output::<_, render::OutputElement<render::UdevRenderer<'_>>>(
            crtc,
            drm_mode,
            &[connector.handle()],
            &output,
            Some(planes),
            &mut renderer,
            &DrmOutputRenderElements::default(),
        ) {
        Ok(o) => o,
        Err(err) => {
            tracing::warn!(%name, ?err, "could not set the output up");
            return;
        }
    };
    drop(renderer);
    let dmabuf_feedback = drm_output
        .with_compositor(|c| surface_feedback(primary_gpu, device.render_node, node, &mut tty.gpus, c.surface()));
    if config.vrr {
        let conn = connector.handle();
        drm_output.with_compositor(|c| {
            use smithay::backend::drm::VrrSupport;
            if !matches!(c.vrr_supported(conn), Ok(VrrSupport::NotSupported) | Err(_)) {
                let _ = c.use_vrr(true);
            }
        });
    }
    tracing::info!(%name, mode = ?wl_mode, scale = config.scale, "output on");
    device.surfaces.insert(
        crtc,
        Surface {
            output: output.clone(),
            global: Some(global),
            drm_output,
            connector,
            dmabuf_feedback,
            redraw: Redraw::Queued,
            powered: true,
            last_vblank: None,
            in_flight: None,
        },
    );
    // A new output starts neutral: the night light reaches it too.
    if let Backend::Tty(tty) = &mut state.backend {
        let _ = tty.apply_gamma();
    }
    // Placed by `outputs::arrange`, which runs after every scan.
    state.space.map_output(&output, (i32::MAX / 4, 0));
    state.queue_redraw(Some(&output));
    crate::ipc::server::outputs_changed(state);
}

/// The monitor's mode list changed while it stayed connected (EDID arriving late; a VM
/// window resized). The output stays — tearing it down would close every surface on it —
/// and only the list is updated; if the mode in use is no longer offered, the configured or
/// preferred one is applied.
fn connector_changed(state: &mut Hyalo, node: DrmNode, connector: connector::Info, crtc: crtc::Handle) {
    let name = connector_name(&connector);
    let wanted = state.config.outputs.get(&name).and_then(|c| c.parsed_mode());
    let output = {
        let Backend::Tty(tty) = &mut state.backend else { return };
        let Some(device) = tty.devices.get_mut(&node) else { return };
        if let Some(entry) = device.disabled.get_mut(&connector.handle()) {
            *entry = (connector, crtc);
            return;
        }
        let Some(surface) = device.surfaces.get_mut(&crtc) else {
            connector_connected(state, node, connector, crtc);
            return;
        };
        let current = surface.output.current_mode();
        let still_offered = current.is_some_and(|m| connector.modes().iter().any(|d| WlMode::from(*d) == m));
        if let Some(preferred) = connector.modes().iter().find(|m| m.mode_type().contains(ModeTypeFlags::PREFERRED)) {
            surface.output.set_preferred(WlMode::from(*preferred));
        }
        surface.connector = connector.clone();
        if still_offered {
            tracing::debug!(%name, "mode list changed; the current mode is still offered");
            return;
        }
        surface.output.clone()
    };
    let target = pick_mode(&connector, wanted).map(|m| {
        let m = WlMode::from(m);
        (m.size.w, m.size.h, Some(m.refresh))
    });
    if let Some(target) = target
        && let Err(err) = set_mode(state, &output, target)
    {
        tracing::warn!(%name, %err, "the mode in use went away and no other could be set");
    }
}

fn connector_disconnected(state: &mut Hyalo, node: DrmNode, connector: connector::Info, crtc: crtc::Handle) {
    let Backend::Tty(tty) = &mut state.backend else { return };
    let Some(device) = tty.devices.get_mut(&node) else { return };
    device.disabled.remove(&connector.handle());
    if let Some(mut surface) = device.surfaces.remove(&crtc) {
        tracing::info!(name = %surface.output.name(), "output gone");
        if let Redraw::WaitingForEstimatedVBlank { token, .. } = surface.redraw {
            state.loop_handle.remove(token);
        }
        // Its layer surfaces are closed, as wlr-layer-shell asks when their output goes: the
        // client decides where its bar or dock goes next (gtk4-layer-shell recreates it).
        {
            let map = smithay::desktop::layer_map_for_output(&surface.output);
            for layer in map.layers() {
                layer.layer_surface().send_close();
            }
        }
        state.space.unmap_output(&surface.output);
        // Every surface leaves the output BEFORE its global goes: a client that sees the
        // global removed destroys its wl_output, and a leave naming it afterwards arrives
        // as leave(nil) — which killed kitty outright (measured, VM, two outputs).
        state.space.refresh();
        surface.output.leave_all();
        if let Some(global) = surface.global.take() {
            state.display_handle.disable_global::<Hyalo>(global.clone());
            let dh = state.display_handle.clone();
            // Removed later, once clients have seen it disabled.
            state.loop_handle.insert_source(Timer::from_duration(Duration::from_secs(10)), move |_, _, _| {
                dh.remove_global::<Hyalo>(global.clone());
                TimeoutAction::Drop
            })
            .ok();
        }
    }
    crate::ipc::server::outputs_changed(state);
}

/// Switches a running output off for good (config `enabled = false`): its CRTC goes dark and
/// the connector waits in `disabled` to be switched back on.
pub fn disable_output(state: &mut Hyalo, output: &Output) -> Result<(), String> {
    let id = *output.user_data().get::<OutputId>().ok_or("no such output")?;
    let Backend::Tty(tty) = &mut state.backend else { return Err("not on hardware".into()) };
    let device = tty.devices.get_mut(&id.node).ok_or("no such GPU")?;
    let surface = device.surfaces.get(&id.crtc).ok_or("no such output")?;
    surface.drm_output.with_compositor(|c| {
        if let Err(err) = c.clear() {
            tracing::warn!(?err, "could not switch the CRTC off");
        }
    });
    let connector = surface.connector.clone();
    connector_disconnected(state, id.node, connector.clone(), id.crtc);
    let Backend::Tty(tty) = &mut state.backend else { unreachable!() };
    if let Some(device) = tty.devices.get_mut(&id.node) {
        device.disabled.insert(connector.handle(), (connector, id.crtc));
    }
    outputs::arrange(state);
    Ok(())
}

/// Connectors switched off in the config that the config now wants on.
pub fn rescan_disabled(state: &mut Hyalo) {
    let wanted: Vec<(DrmNode, connector::Info, crtc::Handle)> = {
        let Backend::Tty(tty) = &state.backend else { return };
        tty.devices
            .iter()
            .flat_map(|(n, d)| d.disabled.values().map(move |(c, crtc)| (*n, c.clone(), *crtc)))
            .filter(|(_, c, _)| state.config.outputs.get(&connector_name(c)).is_none_or(|o| o.enabled))
            .collect()
    };
    for (node, connector, crtc) in wanted {
        connector_connected(state, node, connector, crtc);
    }
    outputs::arrange(state);
}

fn device_removed(state: &mut Hyalo, node: DrmNode) {
    let crtcs: Vec<_> = {
        let Backend::Tty(tty) = &mut state.backend else { return };
        let Some(device) = tty.devices.get(&node) else { return };
        device.scanner.crtcs().map(|(info, crtc)| (info.clone(), crtc)).collect()
    };
    for (info, crtc) in crtcs {
        connector_disconnected(state, node, info, crtc);
    }
    let Backend::Tty(tty) = &mut state.backend else { return };
    if let Some(device) = tty.devices.remove(&node) {
        if let Some(render_node) = device.render_node {
            tty.gpus.as_mut().remove_node(&render_node);
        }
        state.loop_handle.remove(device.token);
    }
    outputs::arrange(state);
}

/// The configured mode if the connector has it (nearest refresh when only the size is
/// given or the rate is approximate), else the preferred one.
fn pick_mode(
    connector: &connector::Info,
    wanted: Option<(i32, i32, Option<i32>)>,
) -> Option<smithay::reexports::drm::control::Mode> {
    let modes = connector.modes();
    if let Some((w, h, refresh)) = wanted {
        let mut same_size: Vec<_> =
            modes.iter().filter(|m| m.size() == (w as u16, h as u16)).copied().collect();
        same_size.sort_by_key(|m| {
            let mhz = WlMode::from(*m).refresh;
            match refresh {
                Some(r) => (mhz - r).abs(),
                None => -mhz,
            }
        });
        if let Some(m) = same_size.first() {
            return Some(*m);
        }
        tracing::warn!(w, h, ?refresh, "configured mode not offered by the monitor; using its preferred one");
    }
    modes
        .iter()
        .find(|m| m.mode_type().contains(ModeTypeFlags::PREFERRED))
        .or_else(|| modes.first())
        .copied()
}

/// Applies a new mode to a running output.
pub fn set_mode(state: &mut Hyalo, output: &Output, wanted: (i32, i32, Option<i32>)) -> Result<(), String> {
    let Backend::Tty(tty) = &mut state.backend else { return Err("not on hardware".into()) };
    let id = *output.user_data().get::<OutputId>().ok_or("no such output")?;
    let primary_gpu = tty.primary_gpu;
    let device = tty.devices.get_mut(&id.node).ok_or("no such GPU")?;
    let render_node = device.render_node.unwrap_or(primary_gpu);
    let surface = device.surfaces.get_mut(&id.crtc).ok_or("no such output")?;
    let mode = pick_mode(&surface.connector, Some(wanted)).ok_or("no modes")?;
    let wl_mode = WlMode::from(mode);
    if wl_mode.size != (wanted.0, wanted.1).into() {
        return Err(format!("{}x{} is not a mode of this monitor", wanted.0, wanted.1));
    }
    let mut renderer = tty.gpus.single_renderer(&render_node).map_err(|e| e.to_string())?;
    surface
        .drm_output
        .use_mode::<_, render::OutputElement<render::UdevRenderer<'_>>>(
            mode,
            &mut renderer,
            &DrmOutputRenderElements::default(),
        )
        .map_err(|e| e.to_string())?;
    output.change_current_state(Some(wl_mode), None, None, None);
    output.set_preferred(output.preferred_mode().unwrap_or(wl_mode));
    Ok(())
}

/// The dmabuf feedback of one output: buffers it can scan out directly, then buffers the GPU
/// can render from.
fn surface_feedback(
    primary_gpu: DrmNode,
    render_node: Option<DrmNode>,
    scanout_node: DrmNode,
    gpus: &mut GpuManager<GbmGlesBackend<GlesRenderer, DrmDeviceFd>>,
    surface: &smithay::backend::drm::DrmSurface,
) -> Option<SurfaceDmabufFeedback> {
    let primary_formats = gpus.single_renderer(&primary_gpu).ok()?.dmabuf_formats();
    let render_formats = match render_node {
        Some(n) => gpus.single_renderer(&n).ok()?.dmabuf_formats(),
        None => FormatSet::default(),
    };
    let all_render: FormatSet = primary_formats.iter().chain(render_formats.iter()).copied().collect();
    let planes = surface.planes().clone();
    // The scan-out tranche only offers formats we can also render from, so there is always a
    // fallback when a buffer cannot be scanned out after all.
    let plane_formats: FormatSet = surface
        .plane_info()
        .formats
        .iter()
        .copied()
        .chain(planes.overlay.into_iter().flat_map(|p| p.formats))
        .collect::<FormatSet>()
        .intersection(&all_render)
        .copied()
        .collect();
    let builder = DmabufFeedbackBuilder::new(primary_gpu.dev_id(), primary_formats);
    let render = match render_node {
        Some(n) => builder
            .clone()
            .add_preference_tranche(
                n.dev_id(),
                zwp_linux_dmabuf_feedback_v1::TrancheFlags::Sampling,
                render_formats.clone(),
                3u32..=6,
            )
            .build()
            .ok()?,
        None => builder.clone().build().ok()?,
    };
    let scanout = builder
        .add_preference_tranche(
            surface.device_fd().dev_id().ok()?,
            zwp_linux_dmabuf_feedback_v1::TrancheFlags::Scanout,
            plane_formats,
            4u32..=6,
        )
        .add_preference_tranche(
            scanout_node.dev_id(),
            zwp_linux_dmabuf_feedback_v1::TrancheFlags::Sampling,
            render_formats,
            4u32..=6,
        )
        .build()
        .ok()?;
    Some(SurfaceDmabufFeedback { render, scanout })
}

/// Draws every output whose redraw is queued.
pub fn redraw_queued(state: &mut Hyalo) {
    let queued: Vec<(DrmNode, crtc::Handle)> = {
        let Backend::Tty(tty) = &state.backend else { return };
        tty.devices
            .iter()
            .flat_map(|(n, d)| d.surfaces.iter().filter(|(_, s)| matches!(s.redraw, Redraw::Queued)).map(move |(c, _)| (*n, *c)))
            .collect()
    };
    for (node, crtc) in queued {
        render_surface(state, node, crtc);
    }
}

fn render_surface(state: &mut Hyalo, node: DrmNode, crtc: crtc::Handle) {
    let Hyalo { backend, space, seat, cursor_status, start_time, wm, lock, config, .. } = state;
    let cursor_status = &*cursor_status;
    let Backend::Tty(tty) = backend else { return };
    if !tty.session.is_active() {
        return;
    }
    let primary_gpu = tty.primary_gpu;
    let Some(device) = tty.devices.get_mut(&node) else { return };
    let render_node = device.render_node.unwrap_or(primary_gpu);
    let Some(surface) = device.surfaces.get_mut(&crtc) else { return };
    if !surface.powered {
        surface.redraw = Redraw::Idle;
        return;
    }
    let output = surface.output.clone();
    // Hyalo's own animations are drawn as they are when this frame shows: the next vblank, on
    // the beat of the last one — unless VRR leaves no beat (render/timing.rs).
    let begun = Instant::now();
    let period = render::timing::period(output.current_mode().map_or(60_000, |m| m.refresh));
    let vrr = surface.drm_output.with_compositor(|c| c.vrr_enabled());
    let when = match surface.last_vblank {
        Some(last) if !vrr => render::timing::next_vblank(last, period, begun),
        _ => begun,
    };
    let scene = render::Scene::new(space, wm, seat, cursor_status, lock, &config.windows, when);
    let icon = match cursor_status {
        smithay::input::pointer::CursorImageStatus::Named(icon) => *icon,
        _ => smithay::input::pointer::CursorIcon::Default,
    };
    let cursor = tty
        .cursors
        .image(icon, output.current_scale().fractional_scale(), start_time.elapsed().as_millis() as u32);
    let pointer_here = space.output_geometry(&output).is_some_and(|g| g.to_f64().contains(scene.pointer));

    let mut renderer = if primary_gpu == render_node {
        tty.gpus.single_renderer(&render_node)
    } else {
        let format = surface.drm_output.format();
        tty.gpus.renderer(&primary_gpu, &render_node, format)
    }
    .expect("a renderer for this output");
    // Instrumented (render/stats.rs, #766): the CPU to build and to render, the area repainted.
    let name = output.name();
    let area = output.current_mode().map_or(0, |m| m.size.w.max(0) as u64 * m.size.h.max(0) as u64);
    render::stats::frame_begin(&name, area);
    let built = std::time::Instant::now();
    let elements = render::output_elements(&scene, &mut renderer, &output, pointer_here.then_some(&cursor));
    let build = built.elapsed();
    // The cursor plane always; the primary plane for a fullscreen window's direct scan-out unless
    // `[render] direct_scanout = false` (read every frame: a change applies at once). No overlay
    // planes exist to allow (output setup, above).
    let frame_flags = if config.render.direct_scanout {
        FrameFlags::ALLOW_PRIMARY_PLANE_SCANOUT | FrameFlags::ALLOW_CURSOR_PLANE_SCANOUT
    } else {
        FrameFlags::ALLOW_CURSOR_PLANE_SCANOUT
    };
    let rendering = std::time::Instant::now();
    let result = surface
        .drm_output
        .render_frame(&mut renderer, &elements, render::CLEAR_COLOR, frame_flags);
    let render_time = rendering.elapsed();
    drop(renderer);

    let (rendered, states, damage) = match result {
        Ok(r) => {
            // The swapchain's newest damage is this frame's; a direct scan-out redraws it whole.
            let damage = match &r.primary_element {
                smithay::backend::drm::compositor::PrimaryPlaneElement::Swapchain(e) if !r.is_empty => {
                    let size = output.current_mode().map(|m| m.size).unwrap_or_default();
                    let buffer = smithay::utils::Size::<i32, smithay::utils::Buffer>::from((size.w, size.h));
                    e.damage.raw().next().map(|d| {
                        d.map(|r| r.to_logical(1, e.transform, &buffer).to_physical(1)).collect::<Vec<_>>()
                    })
                }
                _ => None,
            };
            (!r.is_empty, r.states, damage)
        }
        Err(err) => {
            tracing::warn!(?err, "render failed");
            render::stats::frame_done(&name, false, build, render_time, None);
            surface.redraw = Redraw::Idle;
            return;
        }
    };
    render::stats::frame_done(&name, rendered, build, render_time, damage.as_deref());
    let feedback = surface.dmabuf_feedback.clone();
    if rendered {
        let presentation = super::take_presentation_feedback(state, &output, &states);
        let Backend::Tty(tty) = &mut state.backend else { return };
        let Some(surface) = tty.devices.get_mut(&node).and_then(|d| d.surfaces.get_mut(&crtc)) else { return };
        match surface.drm_output.queue_frame(Some(presentation)) {
            Ok(()) => {
                surface.redraw = Redraw::WaitingForVBlank { redraw_needed: false };
                surface.in_flight = Some((begun, when));
            }
            Err(err) => {
                let err: SwapBuffersError = err.into();
                tracing::warn!(?err, "could not queue the frame");
                surface.redraw = Redraw::Idle;
            }
        }
    } else {
        // Nothing new: what is on screen is what this frame would have shown — a locked one,
        // if the session is locked (lock.rs).
        state.lock_frame_shown(&output);
        // No flip, but clients still get their frame callbacks — one refresh
        // from now, when the vblank would have come.
        let refresh = output.current_mode().map(|m| m.refresh).unwrap_or(60_000).max(1);
        let delay = Duration::from_micros(1_000_000_000 / refresh as u64);
        let token = state
            .loop_handle
            .insert_source(Timer::from_duration(delay), move |_, _, state| {
                estimated_vblank(state, node, crtc);
                TimeoutAction::Drop
            })
            .ok();
        let Backend::Tty(tty) = &mut state.backend else { return };
        if let Some(surface) = tty.devices.get_mut(&node).and_then(|d| d.surfaces.get_mut(&crtc)) {
            surface.redraw = match token {
                Some(token) => Redraw::WaitingForEstimatedVBlank { token, queued: false },
                None => Redraw::Idle,
            };
        }
    }
    super::post_repaint(state, &output, &states, feedback.as_ref());
}

fn estimated_vblank(state: &mut Hyalo, node: DrmNode, crtc: crtc::Handle) {
    let Backend::Tty(tty) = &mut state.backend else { return };
    let Some(surface) = tty.devices.get_mut(&node).and_then(|d| d.surfaces.get_mut(&crtc)) else { return };
    let queued = matches!(surface.redraw, Redraw::WaitingForEstimatedVBlank { queued: true, .. });
    surface.redraw = if queued { Redraw::Queued } else { Redraw::Idle };
    if queued {
        render_surface(state, node, crtc);
    }
}

fn on_vblank(state: &mut Hyalo, node: DrmNode, crtc: crtc::Handle, metadata: &mut Option<DrmEventMetadata>) {
    let Backend::Tty(tty) = &mut state.backend else { return };
    let Some(surface) = tty.devices.get_mut(&node).and_then(|d| d.surfaces.get_mut(&crtc)) else { return };
    let output = surface.output.clone();
    let refresh = output.current_mode().map(|m| m.refresh).unwrap_or(60_000).max(1);
    let frame_duration = Duration::from_micros(1_000_000_000 / refresh as u64);
    let (clock, flags, timed) = match metadata.as_ref().map(|m| m.time) {
        Some(DrmEventTime::Monotonic(tp)) if !tp.is_zero() => (
            Time::<Monotonic>::from(tp),
            wp_presentation_feedback::Kind::Vsync
                | wp_presentation_feedback::Kind::HwClock
                | wp_presentation_feedback::Kind::HwCompletion,
            true,
        ),
        _ => (state.clock.now(), wp_presentation_feedback::Kind::Vsync, false),
    };
    // The kernel's timestamp of the flip, on our clock (both are CLOCK_MONOTONIC): the beat the
    // next frames are predicted on, and how far this one's prediction landed (render/timing.rs).
    let in_flight = surface.in_flight.take();
    if timed {
        let ago = Duration::from(state.clock.now()).saturating_sub(Duration::from(clock));
        if let Some(shown) = Instant::now().checked_sub(ago) {
            surface.last_vblank = Some(shown);
            if let Some((begun, predicted)) = in_flight {
                render::stats::presented(&output.name(), begun, predicted, shown, frame_duration);
            }
        }
    }
    let seq = metadata.as_ref().map(|m| m.sequence).unwrap_or(0);
    match surface.drm_output.frame_submitted() {
        Ok(Some(Some(mut feedback))) => {
            feedback.presented(clock, Refresh::fixed(frame_duration), seq as u64, flags);
        }
        Ok(_) => {}
        Err(err) => {
            let err: SwapBuffersError = err.into();
            let inactive = matches!(&err, SwapBuffersError::TemporaryFailure(e)
                if matches!(e.downcast_ref::<DrmError>(), Some(DrmError::DeviceInactive) | Some(DrmError::Access(DrmAccessError { .. }))));
            if !inactive {
                tracing::warn!(?err, "frame not presented");
            }
        }
    }
    let redraw_needed = matches!(surface.redraw, Redraw::WaitingForVBlank { redraw_needed: true });
    surface.redraw = if redraw_needed { Redraw::Queued } else { Redraw::Idle };
    // The frame that just went on screen may be the first locked one there (lock.rs).
    state.lock_frame_shown(&output);
    if redraw_needed {
        render_surface(state, node, crtc);
    }
}
