//! The unlock fade (#1195 D9). Once the lock client unlocks, the session is drawn and reached
//! at once, and what the lock screen showed — its last picture, its glass and the veil —
//! dissolves over it. The client cannot do this: it destroys its lock surfaces as it unlocks,
//! so Hyalo keeps their last picture, as it does for a menu going (forming.rs).
//!
//! The time and its curve are read from a reference desktop, not chosen: GNOME Shell
//! dismisses its lock screen in `Overview.ANIMATION_TIME`, 250 ms, `EASE_OUT_QUAD`
//! (js/ui/screenShield.js `deactivate`; with reduced motion the same ease, as opacity).
//! Plasma's lock screen has no unlock animation of its own (LockScreenUi.qml animates only
//! its coming). With Hyalo's animations off, the lock screen just goes.

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use smithay::{
    backend::renderer::{
        Color32F,
        element::{
            Kind,
            solid::{SolidColorBuffer, SolidColorRenderElement},
        },
        gles::GlesRenderer,
    },
    output::Output,
    reexports::wayland_server::protocol::wl_surface::WlSurface,
    utils::{Logical, Physical, Point, Rectangle, Scale, Size, user_data::UserDataMap},
};

use super::{GlassElement, HyaloRenderer, OutputElement, snapshot};

/// GNOME Shell's `Overview.ANIMATION_TIME`, which its lock screen goes in.
pub const UNLOCK_FADE: Duration = Duration::from_millis(250);

/// What is left of the lock screen `x` (0..1) through the fade: `EASE_OUT_QUAD` run out.
pub fn left(x: f64) -> f64 {
    let x = x.clamp(0.0, 1.0);
    1.0 - (1.0 - (1.0 - x) * (1.0 - x))
}

struct Fading {
    picture: Option<snapshot::Snapshot>,
    glass: Vec<GlassElement>,
    start: Instant,
    memo: Arc<UserDataMap>,
}

#[derive(Default)]
struct Unlocking(Mutex<Option<Fading>>);

/// The veil fading out, a buffer of its own so each step is a new commit (damage).
struct FadeVeil(Mutex<SolidColorBuffer>);

/// The lock screen on `output` is going: keep its last picture and its glass. Without a
/// picture (no surface there, or it could not be taken) the veil still fades.
pub fn take(gles: &mut GlesRenderer, output: &Output, surface: Option<&WlSurface>, now: Instant) {
    let scale = output.current_scale().fractional_scale();
    let (picture, glass) = match surface.map(|s| (s, snapshot::take_surface(gles, s, scale, now))) {
        Some((s, Ok(p))) => {
            let glass = GlassElement::for_surface(s, Point::from((0, 0)), Scale::from(scale), p.size, now);
            (Some(p), glass)
        }
        Some((_, Err(err))) => {
            tracing::debug!(%err, "no picture of the lock screen going");
            (None, Vec::new())
        }
        None => (None, Vec::new()),
    };
    output.user_data().insert_if_missing_threadsafe(Unlocking::default);
    *output.user_data().get::<Unlocking>().unwrap().0.lock().unwrap() =
        Some(Fading { picture, glass, start: now, memo: Default::default() });
    super::forming::want_frames_until(now + UNLOCK_FADE);
}

/// In front of the session on `output`: what is left of the lock screen, its glass, and
/// the veil, fading. Nothing once the fade is over.
pub fn push<R: HyaloRenderer>(
    out: &mut Vec<OutputElement<R>>,
    output: &Output,
    size: Size<i32, Logical>,
    scale: Scale<f64>,
    when: Instant,
) {
    let Some(unlocking) = output.user_data().get::<Unlocking>() else { return };
    let mut fading = unlocking.0.lock().unwrap();
    let Some(f) = fading.as_ref() else { return };
    let x = when.saturating_duration_since(f.start).as_secs_f64() / UNLOCK_FADE.as_secs_f64();
    if x >= 1.0 {
        *fading = None;
        return;
    }
    let a = left(x);
    if let Some(p) = &f.picture {
        let frame = Rectangle::<f64, Physical>::from_size(p.size.to_f64());
        out.push(OutputElement::Snapshot(snapshot::SnapshotElement::new(p, frame, 1.0, a)));
    }
    for g in &f.glass {
        out.push(OutputElement::Glass(g.mapped(Point::from((0.0, 0.0)), (1.0, 1.0)).forming(a as f32, &f.memo)));
    }
    output.user_data().insert_if_missing_threadsafe(|| {
        FadeVeil(Mutex::new(SolidColorBuffer::new(size, Color32F::new(0.0, 0.0, 0.0, 0.0))))
    });
    let mut veil = output.user_data().get::<FadeVeil>().unwrap().0.lock().unwrap();
    veil.resize(size);
    veil.set_color(Color32F::new(0.0, 0.0, 0.0, crate::lock::VEIL * a as f32));
    out.push(OutputElement::Debug(SolidColorRenderElement::from_buffer(&veil, (0, 0), scale, 1.0, Kind::Unspecified)));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lock_screen_goes_with_gnomes_ease_out_quad() {
        assert_eq!(left(0.0), 1.0);
        assert_eq!(left(1.0), 0.0);
        // EASE_OUT_QUAD is half done at 1 − 1/√2 of the time, and three quarters at half.
        assert!((left(0.5) - 0.25).abs() < 1e-9);
        assert!((left(1.0 - std::f64::consts::FRAC_1_SQRT_2) - 0.5).abs() < 1e-9);
    }
}
