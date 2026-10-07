//! When a frame reaches the screen (#766 B).
//!
//! Hyalo's own animations — a window opening and closing, going into the dock and coming back,
//! a workspace sliding, the shadow under the glass easing — are drawn as they are at the moment
//! the frame will be SHOWN, not the moment it is built. Sampled at the build, every frame shows
//! the animation as it was up to one refresh before it appears, and by a different amount each
//! frame: one that starts building later, or takes longer to, lands a step off. GTK's own
//! animations already follow the display's timing, through the presentation feedback we send.
//!
//! On the tty backend a frame queued now is flipped at the next vblank, and the vblanks keep
//! the beat of the last one the kernel timed (`next_vblank`). With VRR on there is no beat to
//! keep — the panel waits for the frame — and in a window (winit) the host compositor's timing
//! is not ours to know: both sample at the build, as before.
//!
//! A frame begun too close to the next vblank to make it is shown one refresh later than
//! predicted; `nidara-hyalo msg stats` counts those (`presentation.late`), with how far each
//! prediction landed from the kernel's timestamp of the flip.

use std::time::{Duration, Instant};

/// The first vblank after `now`, on the beat of the vblank at `last` every `period`.
pub fn next_vblank(last: Instant, period: Duration, now: Instant) -> Instant {
    if period.is_zero() {
        return now;
    }
    if now < last {
        return last;
    }
    let beats = now.duration_since(last).as_nanos() / period.as_nanos() + 1;
    last + period * beats as u32
}

/// One refresh of a mode refreshing `millihertz` times a thousand seconds.
pub fn period(millihertz: i32) -> Duration {
    Duration::from_nanos(1_000_000_000_000 / millihertz.max(1) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_next_vblank_keeps_the_beat() {
        let t0 = Instant::now();
        let p = Duration::from_micros(6944);
        // Just after a vblank: the next one.
        assert_eq!(next_vblank(t0, p, t0 + Duration::from_micros(300)), t0 + p);
        // Right on one: the one after (this one has gone).
        assert_eq!(next_vblank(t0, p, t0 + p), t0 + p * 2);
        // Long after the last one timed (an idle desktop): still on its beat.
        assert_eq!(next_vblank(t0, p, t0 + p * 1000 + Duration::from_micros(10)), t0 + p * 1001);
        // A vblank timed after the frame began: that one.
        assert_eq!(next_vblank(t0 + p, p, t0), t0 + p);
    }

    #[test]
    fn a_period_from_the_mode() {
        assert_eq!(period(60_000), Duration::from_nanos(16_666_666));
        assert_eq!(period(143_998), Duration::from_nanos(6_944_540));
    }
}
