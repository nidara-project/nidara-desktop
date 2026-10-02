//! Night light: the screens' gamma ramps warmed to a colour temperature — Hyalo's own, driven by
//! the shell (`night_light` over IPC, from core/NightLightSync.ts, whose schedule decides when).
//! On Hyprland this was hyprsunset, which speaks a Hyprland protocol.
//!
//! The ramps are the legacy CRTC gamma (`drm::control::Device::set_gamma`); on an atomic driver
//! the kernel turns that into the GAMMA_LUT property, which Smithay's commits never touch, so it
//! holds across frames. A modeset or a VT switch can reset it: it is applied again when an
//! output comes on, when the session comes back, and when an output wakes from DPMS.
//!
//! The white point of a temperature is Tanner Helland's fit of the blackbody curve, the one most
//! of these tools use: 6500 K is neutral, lower is warmer (blue first, then green).

use smithay::reexports::drm::control::{Device as _, crtc};

use crate::backend::Backend;
use crate::state::Hyalo;

/// The range the shell's slider offers is 2700–6500; anything in here is a screen still readable.
pub const RANGE: std::ops::RangeInclusive<u32> = 1000..=10000;

/// The RGB multipliers (0..1) of a colour temperature in kelvin.
pub fn whitepoint(kelvin: u32) -> (f64, f64, f64) {
    let t = kelvin.clamp(1000, 40000) as f64 / 100.0;
    let r = if t <= 66.0 { 255.0 } else { 329.698727446 * (t - 60.0).powf(-0.1332047592) };
    let g = if t <= 66.0 { 99.4708025861 * t.ln() - 161.1195681661 } else { 288.1221695283 * (t - 60.0).powf(-0.0755148492) };
    let b = if t >= 66.0 {
        255.0
    } else if t <= 19.0 {
        0.0
    } else {
        138.5177312231 * (t - 10.0).ln() - 305.0447927307
    };
    let c = |v: f64| (v / 255.0).clamp(0.0, 1.0);
    (c(r), c(g), c(b))
}

/// Gamma ramps of `size` entries: identity when `kelvin` is None, warmed otherwise.
pub fn ramps(kelvin: Option<u32>, size: usize) -> [Vec<u16>; 3] {
    let (r, g, b) = kelvin.map(whitepoint).unwrap_or((1.0, 1.0, 1.0));
    let ramp = |m: f64| -> Vec<u16> {
        (0..size)
            .map(|i| {
                let x = if size > 1 { i as f64 / (size - 1) as f64 } else { 1.0 };
                (x * m * 65535.0).round().clamp(0.0, 65535.0) as u16
            })
            .collect()
    };
    [ramp(r), ramp(g), ramp(b)]
}

impl crate::backend::tty::TtyBackend {
    /// Every CRTC that shows an output gets the ramps of `self.night_light`, read back to be sure.
    /// Returns how many did not take them.
    pub fn apply_gamma(&mut self) -> usize {
        let kelvin = self.night_light;
        let mut refused = 0;
        for (drm, crtcs) in self.gamma_targets() {
            for crtc in crtcs {
                if !set_crtc_gamma(drm, crtc, kelvin) {
                    refused += 1;
                }
            }
        }
        refused
    }
}

/// Sets one CRTC's ramps and reads them back: true when the hardware holds what was asked.
fn set_crtc_gamma(drm: &smithay::backend::drm::DrmDevice, crtc: crtc::Handle, kelvin: Option<u32>) -> bool {
    let size = match drm.get_crtc(crtc) {
        Ok(info) => info.gamma_length() as usize,
        Err(err) => {
            tracing::warn!(?err, "night light: the CRTC could not be read");
            return false;
        }
    };
    if size == 0 {
        tracing::warn!("night light: this output has no gamma ramp");
        return false;
    }
    let [r, g, b] = ramps(kelvin, size);
    if let Err(err) = drm.set_gamma(crtc, &r, &g, &b) {
        tracing::warn!(?err, "night light: the gamma ramp was refused");
        return false;
    }
    let (mut rr, mut rg, mut rb) = (vec![0u16; size], vec![0u16; size], vec![0u16; size]);
    if drm.get_gamma(crtc, &mut rr, &mut rg, &mut rb).is_err() {
        return true; // set without error; nothing to compare against
    }
    // The hardware may round: compare the top of each ramp, within 1 %.
    let close = |a: u16, b: u16| (a as i32 - b as i32).abs() <= 655;
    let held = close(rr[size - 1], r[size - 1]) && close(rg[size - 1], g[size - 1]) && close(rb[size - 1], b[size - 1]);
    if !held {
        tracing::warn!("night light: the ramps read back differ from what was set");
    }
    held
}

impl Hyalo {
    /// `Some(kelvin)` warms every screen, `None` puts them back to neutral.
    pub fn set_night_light(&mut self, kelvin: Option<u32>) -> Result<(), String> {
        if let Some(k) = kelvin
            && !RANGE.contains(&k)
        {
            return Err(format!("{k} K is outside {}–{} K", RANGE.start(), RANGE.end()));
        }
        let Backend::Tty(tty) = &mut self.backend else { return Err("night light needs the hardware session".into()) };
        tty.night_light = kelvin;
        let refused = tty.apply_gamma();
        tracing::info!(?kelvin, refused, "night light");
        if refused > 0 {
            return Err(format!("{refused} output(s) did not take the gamma ramps"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn neutral_at_6500_and_warmer_below() {
        let (r, g, b) = whitepoint(6500);
        assert!(r > 0.99 && g > 0.97 && b > 0.97, "6500 K is (close to) neutral: {r} {g} {b}");
        let (r, g, b) = whitepoint(2700);
        assert!(r > 0.99, "red stays full");
        assert!(g < 0.8 && b < 0.5 && b < g, "blue goes first, then green: {g} {b}");
    }

    #[test]
    fn ramps_rise_and_end_at_the_white_point() {
        let [r, g, b] = ramps(Some(3000), 256);
        assert_eq!(r.len(), 256);
        assert!(r.windows(2).all(|w| w[0] <= w[1]) && b.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(r[255], 65535);
        assert!(b[255] < g[255] && g[255] < r[255]);
        let [ir, _, ib] = ramps(None, 256);
        assert_eq!((ir[0], ir[255], ib[128]), (0, 65535, (128.0 / 255.0 * 65535.0f64).round() as u16));
    }
}
