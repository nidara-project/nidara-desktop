//! Outputs as the user configured them — position, scale, transform, mode, VRR, power — and
//! input devices as configured, applied at startup, on hotplug, on a config change and
//! through IPC alike.
//!
//! #594, by construction: a monitor that is switched off keeps its place and its windows.
//! Off through DPMS it simply stops drawing. And when switching it off makes it disappear
//! (many DisplayPort monitors do), each of its windows remembers where it was on it and goes
//! back there when the monitor returns under the same connector name.

use serde::Serialize;
use smithay::{
    desktop::{Window, layer_map_for_output},
    output::{Output, Scale},
    reexports::input as libinput,
    utils::{Logical, Point, Rectangle},
};

use crate::{
    backend::Backend,
    config::{self, Input, OutputConfig},
    state::Hyalo,
};

/// Where a window was, relative to its output, when that output went away.
#[derive(Debug, Clone)]
struct Home {
    output: String,
    offset: Point<i32, Logical>,
}

/// Places every output: configured positions first, the rest in a row to their right.
/// Then puts back windows whose output returned, and moves in windows left outside.
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
        layer_map_for_output(o).arrange();
    }
    restore_and_rescue_windows(state);
    state.queue_redraw(None);
}

fn restore_and_rescue_windows(state: &mut Hyalo) {
    let windows: Vec<Window> = state.space.elements().cloned().collect();
    for window in windows {
        let Some(loc) = state.space.element_location(&window) else { continue };
        // Back home?
        let home = window.user_data().get::<std::sync::Mutex<Option<Home>>>().and_then(|h| h.lock().unwrap().clone());
        if let Some(home) = home {
            let back = state.space.outputs().find(|o| o.name() == home.output).cloned();
            if let Some(o) = back {
                let geo = state.space.output_geometry(&o);
                if let Some(g) = geo {
                    state.space.map_element(window.clone(), g.loc + home.offset, false);
                    *window.user_data().get::<std::sync::Mutex<Option<Home>>>().unwrap().lock().unwrap() = None;
                    continue;
                }
            }
        }
        // Still on some output?
        let geo = Rectangle::new(loc, window.geometry().size);
        if state.space.outputs().any(|o| state.space.output_geometry(o).is_some_and(|g| g.overlaps(geo))) {
            continue;
        }
        // Its output is gone: remember where it was, show it on the first output.
        let Some(target) = state.space.outputs().next().cloned() else { continue };
        let Some(tg) = state.space.output_geometry(&target) else { continue };
        let zone = layer_map_for_output(&target).non_exclusive_zone();
        let area = Rectangle::new(tg.loc + zone.loc, zone.size);
        let size = window.geometry().size;
        let new_loc = Point::from((
            area.loc.x + ((area.size.w - size.w) / 2).max(0),
            area.loc.y + ((area.size.h - size.h) / 2).max(0),
        ));
        state.space.map_element(window.clone(), new_loc, false);
    }
}

/// An output is about to go away: each of its windows remembers where it was on it.
pub fn remember_windows_of(state: &Hyalo, output: &Output) {
    let Some(og) = state.space.output_geometry(output) else { return };
    for window in state.space.elements() {
        let Some(loc) = state.space.element_location(window) else { continue };
        if !og.contains(loc) {
            continue;
        }
        let home = Home { output: output.name(), offset: loc - og.loc };
        window.user_data().insert_if_missing_threadsafe(|| std::sync::Mutex::new(None::<Home>));
        *window.user_data().get::<std::sync::Mutex<Option<Home>>>().unwrap().lock().unwrap() = Some(home);
    }
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
        (_, Some(output)) if !cfg.enabled => {
            remember_windows_of(state, &output);
            crate::backend::tty_disable_output(state, &output)
        }
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
            output.change_current_state(None, Some(transform), Some(Scale::Fractional(cfg.scale)), None);
            if let Backend::Tty(tty) = &mut state.backend {
                let (supported, enabled) = tty.vrr_state(&output);
                if cfg.vrr != enabled && (supported || !cfg.vrr) {
                    tty.set_vrr(&output, cfg.vrr)?;
                }
            }
            arrange(state);
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
    pub vrr_enabled: bool,
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
    } else if device.has_capability(libinput::DeviceCapability::Pointer) {
        let p = &input.pointer;
        let _ = device.config_scroll_set_natural_scroll_enabled(p.natural_scroll);
        let _ = device.config_accel_set_speed(p.accel_speed);
    }
}
