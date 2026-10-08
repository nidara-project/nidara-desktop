//! Outputs as the user configured them — position, scale, transform, mode, VRR, power — and
//! input devices as configured, applied at startup, on hotplug, on a config change and
//! through IPC alike.
//!
//! #594, by construction: a monitor that is switched off keeps its place and its windows.
//! Off through DPMS it simply stops drawing. And when switching it off makes it disappear
//! (many DisplayPort monitors do), its workspaces are shown elsewhere and go back to it when
//! it returns under the same connector name (`wm::outputs_changed`), each floating window
//! where it was — their boxes are kept relative to their output.

use serde::Serialize;
use smithay::{
    output::{Output, Scale},
    reexports::input as libinput,
    utils::{Logical, Rectangle},
};

use crate::{
    backend::Backend,
    config::{self, Input, OutputConfig, Vrr},
    state::Hyalo,
};

/// Places every output: configured positions first, the rest in a row to their right.
/// Then every workspace goes to its output (`wm::outputs_changed`).
pub fn arrange(state: &mut Hyalo) {
    let outputs: Vec<Output> = state.space.outputs().cloned().collect();
    let mut placed: Vec<Rectangle<i32, Logical>> = Vec::new();
    let mut auto = Vec::new();
    for o in &outputs {
        match state.config.outputs.get(&o.name()).and_then(|c| c.position) {
            Some((x, y)) => {
                state.space.map_output(o, (x, y));
                if let Some(g) = state.space.output_geometry(o) {
                    placed.push(g);
                }
            }
            None => auto.push(o.clone()),
        }
    }
    // Unconfigured outputs in connector-name order, so the layout does not depend on which
    // monitor answered first.
    auto.sort_by_key(|o| o.name());
    let mut x = placed.iter().map(|g| g.loc.x + g.size.w).max().unwrap_or(0);
    for o in &auto {
        state.space.map_output(o, (x, 0));
        x += state.space.output_geometry(o).map(|g| g.size.w).unwrap_or(0);
    }
    for o in &outputs {
        crate::shell::layer::arrange_output(o);
    }
    state.outputs_changed();
    state.queue_redraw(None);
}

/// Applies `config` to a running output. Returns what could not be applied.
pub fn apply(state: &mut Hyalo, name: &str, cfg: &OutputConfig) -> Result<(), String> {
    let transform = cfg.parsed_transform().ok_or("unknown transform")?;
    if !(0.25..=4.0).contains(&cfg.scale) {
        return Err(format!("scale {} is outside 0.25..4", cfg.scale));
    }
    let output = state.space.outputs().find(|o| o.name() == name).cloned();
    match (&mut state.backend, output) {
        (Backend::Tty(_), None) => {
            // Off, or not connected: the config now says how it comes up.
            if cfg.enabled {
                crate::backend::tty_rescan_all(state);
            }
            Ok(())
        }
        (Backend::Winit(_), None) => Err(format!("no output named {name}")),
        (_, Some(output)) if !cfg.enabled => crate::backend::tty_disable_output(state, &output),
        (_, Some(output)) => {
            if let Some(m) = cfg.parsed_mode()
                && matches!(state.backend, Backend::Tty(_)) {
                    let current = output.current_mode().map(|m| (m.size.w, m.size.h, m.refresh));
                    let differs = current.is_none_or(|(w, h, r)| {
                        (w, h) != (m.0, m.1) || m.2.is_some_and(|want| (want - r).abs() > 500)
                    });
                    if differs {
                        crate::backend::tty::set_mode(state, &output, m)?;
                    }
                }
            // In a window (winit) the transform is the window's own — its rows are stored
            // bottom-up — and not the user's: a scale set over IPC turned the whole nested
            // desktop upside down (2026-10-07).
            let transform = match state.backend {
                Backend::Winit(_) => output.current_transform(),
                _ => transform,
            };
            output.change_current_state(None, Some(transform), Some(Scale::Fractional(cfg.scale)), None);
            arrange(state);
            state.update_x11_scale();
            if let Backend::Tty(tty) = &mut state.backend {
                let (supported, enabled) = tty.vrr_state(&output);
                let want = match cfg.vrr {
                    Vrr::Off => false,
                    Vrr::On => true,
                    // Its frames decide (backend/tty.rs → `vrr_for_games`; `arrange` queued
                    // one) — refused here all the same on a monitor without it.
                    Vrr::Games if !supported => return Err("this output does not support VRR".into()),
                    Vrr::Games => enabled,
                };
                if want != enabled {
                    // Refused on a monitor without VRR: said, never silently ignored. Last, so
                    // the rest of the settings apply either way.
                    tty.set_vrr(&output, want)?;
                }
            }
            Ok(())
        }
    }
}

pub fn set_power(state: &mut Hyalo, name: Option<&str>, on: bool) -> Result<(), String> {
    let outputs: Vec<Output> = state
        .space
        .outputs()
        .filter(|o| name.is_none_or(|n| o.name() == n))
        .cloned()
        .collect();
    if outputs.is_empty() {
        return Err(match name {
            Some(n) => format!("no output named {n}"),
            None => "no outputs".into(),
        });
    }
    let Backend::Tty(tty) = &mut state.backend else { return Err("power needs the hardware session".into()) };
    for o in &outputs {
        tty.set_power(o, on);
    }
    if on {
        state.queue_redraw(None);
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
pub struct ModeInfo {
    pub width: i32,
    pub height: i32,
    /// mHz.
    pub refresh: i32,
    pub preferred: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct OutputInfo {
    pub name: String,
    pub make: String,
    pub model: String,
    pub serial: String,
    /// Millimetres.
    pub physical_size: (i32, i32),
    pub enabled: bool,
    pub powered: bool,
    pub modes: Vec<ModeInfo>,
    pub current_mode: Option<ModeInfo>,
    pub scale: f64,
    pub transform: String,
    /// Logical pixels.
    pub position: Option<(i32, i32)>,
    pub logical_size: Option<(i32, i32)>,
    pub vrr_supported: bool,
    /// On now — with `vrr = "games"`, only while a game is fullscreen here.
    pub vrr_enabled: bool,
    /// What the configuration asks: `false`, `true` or `"games"`.
    pub vrr: Vrr,
}

pub fn info(state: &Hyalo) -> Vec<OutputInfo> {
    let mode_info = |m: smithay::output::Mode, preferred: bool| ModeInfo {
        width: m.size.w,
        height: m.size.h,
        refresh: m.refresh,
        preferred,
    };
    let from_output = |o: &Output, modes: Vec<ModeInfo>, powered: bool, vrr: (bool, bool)| {
        let props = o.physical_properties();
        let geo = state.space.output_geometry(o);
        OutputInfo {
            name: o.name(),
            make: props.make,
            model: props.model,
            serial: props.serial_number,
            physical_size: (props.size.w, props.size.h),
            enabled: true,
            powered,
            modes,
            current_mode: o.current_mode().map(|m| mode_info(m, o.preferred_mode() == Some(m))),
            scale: o.current_scale().fractional_scale(),
            transform: config::transform_name(o.current_transform()).into(),
            position: geo.map(|g| (g.loc.x, g.loc.y)),
            logical_size: geo.map(|g| (g.size.w, g.size.h)),
            vrr_supported: vrr.0,
            vrr_enabled: vrr.1,
            vrr: state.config.outputs.get(&o.name()).map_or(Vrr::Off, |c| c.vrr),
        }
    };
    match &state.backend {
        Backend::Winit(_) => state
            .space
            .outputs()
            .map(|o| {
                let modes = o.current_mode().map(|m| vec![mode_info(m, true)]).unwrap_or_default();
                from_output(o, modes, true, (false, false))
            })
            .collect(),
        Backend::Tty(tty) => tty
            .connectors()
            .into_iter()
            .map(|(surface, conn)| {
                let modes: Vec<ModeInfo> = conn
                    .modes()
                    .iter()
                    .map(|m| {
                        mode_info(
                            smithay::output::Mode::from(*m),
                            m.mode_type().contains(smithay::reexports::drm::control::ModeTypeFlags::PREFERRED),
                        )
                    })
                    .collect();
                match surface {
                    Some(s) => from_output(&s.output, modes, s.powered, tty.vrr_state(&s.output)),
                    None => OutputInfo {
                        name: crate::backend::tty::connector_name(conn),
                        make: String::new(),
                        model: String::new(),
                        serial: String::new(),
                        physical_size: conn.size().map(|(w, h)| (w as i32, h as i32)).unwrap_or_default(),
                        enabled: false,
                        powered: false,
                        modes,
                        current_mode: None,
                        scale: 1.0,
                        transform: "normal".into(),
                        position: None,
                        logical_size: None,
                        vrr_supported: false,
                        vrr_enabled: false,
                        vrr: Vrr::Off,
                    },
                }
            })
            .collect(),
    }
}

/// libinput settings for one device, from the `[input]` config.
pub fn configure_input_device(device: &mut libinput::Device, input: &Input) {
    let is_touchpad = device.config_tap_finger_count() > 0;
    if is_touchpad {
        let t = &input.touchpad;
        let _ = device.config_tap_set_enabled(t.tap);
        let _ = device.config_dwt_set_enabled(t.disable_while_typing);
        let _ = device.config_scroll_set_natural_scroll_enabled(t.natural_scroll);
        let _ = device.config_accel_set_speed(t.accel_speed);
        let _ = device.config_accel_set_profile(accel_profile(&t.accel_profile));
    } else if device.has_capability(libinput::DeviceCapability::Pointer) {
        let p = &input.pointer;
        let _ = device.config_scroll_set_natural_scroll_enabled(p.natural_scroll);
        let _ = device.config_accel_set_speed(p.accel_speed);
        let _ = device.config_accel_set_profile(accel_profile(&p.accel_profile));
    }
}

/// The config's name for a profile (checked when loaded: `adaptive` or `flat`).
fn accel_profile(name: &str) -> libinput::AccelProfile {
    match name {
        "flat" => libinput::AccelProfile::Flat,
        _ => libinput::AccelProfile::Adaptive,
    }
}
