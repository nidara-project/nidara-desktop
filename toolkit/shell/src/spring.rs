//! The TS dock's magnification spring (DockPhysics.ts `springStep`): it starts from rest and
//! is nearly there in 300 ms, without overshoot, so the growth is seen as it happens.
//! An exponential ease starts at full speed instead, and read as a jump (owner, 2026-11-01).

/// DockPhysics.ts `STIFFNESS` and `DAMPING`: a little over critical damping.
const STIFFNESS: f64 = 320.;
const DAMPING: f64 = 38.;
/// Integrated in substeps of at most this, whatever the frame time: semi-implicit Euler
/// diverges once `DAMPING × h` passes 2 (DockPhysics.ts `H_STABLE`).
const H_STABLE: f64 = 1. / 60.;
/// Where it lands on the target, in the units of a 0..1 presence: the TS dock's 0.3 px and
/// 0.5 px/s over a 64 px growth.
const SNAP_POS: f64 = 0.005;
const SNAP_VEL: f64 = 0.008;

/// A value on its way to a target.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Spring {
    pub value: f64,
    pub velocity: f64,
}

impl Spring {
    /// Advances `dt` seconds toward `target`. Returns whether it is still moving; once it
    /// is not, `value` is exactly `target`.
    pub fn step(&mut self, target: f64, dt: f64) -> bool {
        if (target - self.value).abs() < SNAP_POS && self.velocity.abs() < SNAP_VEL {
            self.snap(target);
            return false;
        }
        let mut rem = dt.max(0.);
        while rem > 1e-9 {
            let h = rem.min(H_STABLE);
            self.velocity += (STIFFNESS * (target - self.value) - DAMPING * self.velocity) * h;
            self.value += self.velocity * h;
            rem -= h;
        }
        true
    }

    /// Lands on `target` at once (reduced motion).
    pub fn snap(&mut self, target: f64) {
        self.value = target;
        self.velocity = 0.;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(from: f64, to: f64, frame: f64) -> Vec<f64> {
        let mut s = Spring {
            value: from,
            velocity: 0.,
        };
        let mut out = vec![];
        while s.step(to, frame) {
            out.push(s.value);
            assert!(out.len() < 1000, "never settles");
        }
        out.push(s.value);
        out
    }

    #[test]
    fn it_starts_slowly_and_is_nearly_there_by_300_ms_without_overshoot() {
        let path = run(0., 1., 1. / 144.);
        let at = |ms: f64| path[(ms / 1000. * 144.) as usize - 1];
        // Seen growing: under a third of the way at 60 ms, most of it by 150 ms.
        assert!(at(60.) < 0.35 && at(60.) > 0.15, "{}", at(60.));
        assert!(at(150.) > 0.6 && at(150.) < 0.9, "{}", at(150.));
        // Nearly there by 300 ms; the last fraction of a pixel lands within 0.8 s.
        assert!(at(300.) > 0.95, "{}", at(300.));
        let settled = path.len() as f64 / 144.;
        assert!(settled < 0.8, "{settled}");
        assert!(path.iter().all(|v| *v <= 1. + 1e-3));
        assert_eq!(*path.last().unwrap(), 1.);
    }

    #[test]
    fn a_long_frame_stays_stable() {
        // A starved frame clock: one step of a quarter second must not blow up.
        let mut s = Spring::default();
        s.step(1., 0.25);
        assert!(
            s.value.is_finite() && s.value > 0.5 && s.value < 1.1,
            "{}",
            s.value
        );
        assert_eq!(run(1., 0., 0.04).last(), Some(&0.));
    }
}
