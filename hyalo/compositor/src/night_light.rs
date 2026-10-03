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

use std::time::{Duration, Instant};

use smithay::reexports::{
    calloop::timer::{TimeoutAction, Timer},
    drm::control::{Device as _, crtc},
};

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

/// How long switching the night light on or off takes, linear: Hyprland's `__internal_fadeCTM`
/// (speed 5 = 500 ms, `linear`), the fade the desktop had there. A new temperature while it is
/// on is not faded — it follows the slider.
pub const FADE: Duration = Duration::from_millis(500);

/// At most one ramp per this, while the ramps are changing. Each costs the main loop a blocking
/// commit (measured on the RX 5700 XT at 144 Hz: 2–8 ms), so a slider's flood of temperatures
/// is coalesced to the latest one, never queued.
const TICK: Duration = Duration::from_millis(16);

type Rgb = (f64, f64, f64);

/// The ramps on their way from what was shown to the night light's target.
pub struct Fade {
    /// The multipliers on screen now.
    pub shown: Rgb,
    from: Rgb,
    start: Instant,
    duration: Duration,
    /// Still moving: the tick has work.
    moving: bool,
    /// A tick is armed; requests until it fires only leave their target.
    armed: bool,
}

impl Default for Fade {
    fn default() -> Self {
        Self { shown: (1.0, 1.0, 1.0), from: (1.0, 1.0, 1.0), start: Instant::now(), duration: Duration::ZERO, moving: false, armed: false }
    }
}

impl Fade {
    fn remaining(&self, now: Instant) -> Duration {
        if self.moving { self.duration.saturating_sub(now - self.start) } else { Duration::ZERO }
    }

    /// Where the ramps are at `now`, heading for `to`; false once there.
    fn advance(&mut self, to: Rgb, now: Instant) -> bool {
        let p = if self.duration.is_zero() { 1.0 } else { ((now - self.start).as_secs_f64() / self.duration.as_secs_f64()).min(1.0) };
        let lerp = |a: f64, b: f64| a + (b - a) * p;
        self.shown = (lerp(self.from.0, to.0), lerp(self.from.1, to.1), lerp(self.from.2, to.2));
        self.moving = p < 1.0;
        self.moving
    }
}

/// Gamma ramps of `size` entries for the RGB multipliers `m` (1, 1, 1 = neutral).
pub fn ramps(m: Rgb, size: usize) -> [Vec<u16>; 3] {
    let ramp = |m: f64| -> Vec<u16> {
        (0..size)
            .map(|i| {
                let x = if size > 1 { i as f64 / (size - 1) as f64 } else { 1.0 };
                (x * m * 65535.0).round().clamp(0.0, 65535.0) as u16
            })
            .collect()
    };
    [ramp(m.0), ramp(m.1), ramp(m.2)]
}

fn target(kelvin: Option<u32>) -> Rgb {
    kelvin.map(whitepoint).unwrap_or((1.0, 1.0, 1.0))
}

impl crate::backend::tty::TtyBackend {
    /// Every CRTC that shows an output gets the ramps shown now, read back to be sure — also
    /// after a modeset, a VT switch or DPMS, which can reset them. Returns how many refused.
    pub fn apply_gamma(&mut self) -> usize {
        let shown = self.night_light_fade.shown;
        let mut refused = 0;
        for (drm, crtcs) in self.gamma_targets() {
            for crtc in crtcs {
                if !set_crtc_gamma(drm, crtc, shown) {
                    refused += 1;
                }
            }
        }
        refused
    }

    /// One step towards the target. Returns how many CRTCs refused it.
    fn step_night_light(&mut self, now: Instant) -> usize {
        let to = target(self.night_light);
        self.night_light_fade.advance(to, now);
        self.apply_gamma()
    }
}

/// Sets one CRTC's ramps and reads them back: true when the hardware holds what was asked.
fn set_crtc_gamma(drm: &smithay::backend::drm::DrmDevice, crtc: crtc::Handle, m: Rgb) -> bool {
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
    let [r, g, b] = ramps(m, size);
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
    /// `Some(kelvin)` warms every screen, `None` puts them back to neutral. Switching on or off
    /// fades over `FADE`; a new temperature while on goes straight there. The first request of
    /// a burst is applied now — so a refusal is answered — and the rest are coalesced into the
    /// tick that follows it.
    pub fn set_night_light(&mut self, kelvin: Option<u32>) -> Result<(), String> {
        if let Some(k) = kelvin
            && !RANGE.contains(&k)
        {
            return Err(format!("{k} K is outside {}–{} K", RANGE.start(), RANGE.end()));
        }
        let Backend::Tty(tty) = &mut self.backend else { return Err("night light needs the hardware session".into()) };
        let now = Instant::now();
        let toggled = tty.night_light.is_some() != kelvin.is_some();
        // A temperature during a fade (the slider, right after switching on) keeps the fade's pace.
        let duration = if toggled { FADE } else { tty.night_light_fade.remaining(now) };
        tty.night_light = kelvin;
        let fade = &mut tty.night_light_fade;
        fade.from = fade.shown;
        fade.start = now;
        fade.duration = duration;
        fade.moving = true;
        if fade.armed {
            return Ok(());
        }
        let refused = tty.step_night_light(now);
        tracing::info!(?kelvin, refused, "night light");
        arm_tick(self);
        if refused > 0 {
            return Err(format!("{refused} output(s) did not take the gamma ramps"));
        }
        Ok(())
    }
}

/// While the ramps are moving, one step per `TICK`; the timer goes once they are there and no
/// request came during the last tick.
fn arm_tick(state: &mut Hyalo) {
    let Backend::Tty(tty) = &mut state.backend else { return };
    tty.night_light_fade.armed = true;
    let armed = state.loop_handle.insert_source(Timer::from_duration(TICK), |_, _, state| {
        let Backend::Tty(tty) = &mut state.backend else { return TimeoutAction::Drop };
        if !tty.night_light_fade.moving {
            tty.night_light_fade.armed = false;
            return TimeoutAction::Drop;
        }
        let _ = tty.step_night_light(Instant::now());
        TimeoutAction::ToDuration(TICK)
    });
    if armed.is_err()
        && let Backend::Tty(tty) = &mut state.backend
    {
        tty.night_light_fade.armed = false;
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
        let [r, g, b] = ramps(whitepoint(3000), 256);
        assert_eq!(r.len(), 256);
        assert!(r.windows(2).all(|w| w[0] <= w[1]) && b.windows(2).all(|w| w[0] <= w[1]));
        assert_eq!(r[255], 65535);
        assert!(b[255] < g[255] && g[255] < r[255]);
        let [ir, _, ib] = ramps((1.0, 1.0, 1.0), 256);
        assert_eq!((ir[0], ir[255], ib[128]), (0, 65535, (128.0 / 255.0 * 65535.0f64).round() as u16));
    }

    #[test]
    fn a_fade_is_linear_and_a_zero_one_lands_at_once() {
        let start = Instant::now();
        let warm = whitepoint(3000);
        let mut f = Fade { start, duration: FADE, moving: true, ..Default::default() };
        assert!(f.advance(warm, start + FADE / 2), "half way it is still moving");
        assert!((f.shown.2 - (1.0 + warm.2) / 2.0).abs() < 1e-9, "linear: blue half way, {:?}", f.shown);
        assert!(!f.advance(warm, start + FADE), "there at the end");
        assert_eq!(f.shown, warm);
        let mut f = Fade { start, moving: true, ..Default::default() };
        assert!(!f.advance(warm, start), "no duration: there at once");
        assert_eq!(f.shown, warm);
    }
}
