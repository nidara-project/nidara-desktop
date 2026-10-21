// SPDX-License-Identifier: LGPL-3.0-or-later
//! Scalar timeline for D7 inset reflow and the D5 sidebar fallback. Each sample is placed
//! once in the widget tree, shared by painting, hit-testing and focus bounds.
use crate::Result;
use nk_wayland::Curve;
#[derive(Clone, Copy, Debug)]
pub(crate) struct Timeline {
    from: f64,
    to: f64,
    curve: Curve,
}
impl Timeline {
    pub fn new(from: f64, to: f64, velocity: f64, mut curve: Curve) -> Result<Self> {
        if ![from, to, velocity].iter().all(|v| v.is_finite()) {
            return Err("non-finite motion".into());
        }
        match &mut curve {
            Curve::Spring {
                mass,
                stiffness,
                damping,
                initial_velocity,
            } => {
                if ![mass, stiffness, damping]
                    .iter()
                    .all(|v| v.is_finite() && **v > 0.)
                    || !initial_velocity.is_finite()
                {
                    return Err("invalid spring".into());
                }
                *initial_velocity += velocity;
            }
            Curve::Bezier { x1, y1, x2, y2, .. } => {
                if ![*x1, *y1, *x2, *y2].iter().all(|v| v.is_finite())
                    || !(0. ..=1.).contains(x1)
                    || !(0. ..=1.).contains(x2)
                {
                    return Err("invalid Bezier".into());
                }
            }
        }
        Ok(Self { from, to, curve })
    }
    pub fn sample(self, seconds: f64) -> (f64, f64, bool) {
        let t = seconds.max(0.);
        let (value, velocity) = match self.curve {
            Curve::Bezier {
                x1,
                y1,
                x2,
                y2,
                duration_ms,
            } => {
                let duration = duration_ms as f64 / 1000.;
                if duration == 0. || t >= duration {
                    return (self.to, 0., true);
                }
                let cubic = |a: f64, b: f64, u: f64| {
                    3. * (1. - u).powi(2) * u * a + 3. * (1. - u) * u * u * b + u.powi(3)
                };
                let derivative = |a: f64, b: f64, u: f64| {
                    3. * (1. - u).powi(2) * a + 6. * (1. - u) * u * (b - a) + 3. * u * u * (1. - b)
                };
                let x = t / duration;
                let (mut low, mut high) = (0., 1.);
                for _ in 0..32 {
                    let mid = (low + high) / 2.;
                    if cubic(x1, x2, mid) < x {
                        low = mid;
                    } else {
                        high = mid;
                    }
                }
                let u = (low + high) / 2.;
                let delta = self.to - self.from;
                let dx = derivative(x1, x2, u);
                (
                    self.from + delta * cubic(y1, y2, u),
                    if dx.abs() > f64::EPSILON {
                        delta * derivative(y1, y2, u) / dx / duration
                    } else {
                        0.
                    },
                )
            }
            Curve::Spring {
                mass,
                stiffness,
                damping,
                initial_velocity,
            } => {
                let a = damping / (2. * mass);
                let w2 = stiffness / mass;
                let y0 = self.from - self.to;
                let discriminant = a * a - w2;
                let (y, v) = if discriminant.abs() < 1e-10 {
                    let b = initial_velocity + a * y0;
                    let e = (-a * t).exp();
                    (e * (y0 + b * t), e * (b - a * (y0 + b * t)))
                } else if discriminant < 0. {
                    let w = (-discriminant).sqrt();
                    let b = (initial_velocity + a * y0) / w;
                    let (s, c) = (w * t).sin_cos();
                    let e = (-a * t).exp();
                    let y = y0 * c + b * s;
                    (e * y, e * (-a * y - y0 * w * s + b * w * c))
                } else {
                    let d = discriminant.sqrt();
                    let r1 = -a + d;
                    let r2 = -a - d;
                    let c1 = (initial_velocity - r2 * y0) / (r1 - r2);
                    let c2 = y0 - c1;
                    let p = c1 * (r1 * t).exp();
                    let q = c2 * (r2 * t).exp();
                    (p + q, r1 * p + r2 * q)
                };
                (self.to + y, v)
            }
        };
        let done = (value - self.to).abs() < 0.01 && velocity.abs() < 0.01;
        if done {
            (self.to, 0., true)
        } else {
            (value, velocity, false)
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bezier_and_all_spring_damping_regimes_converge_without_a_compositor() {
        let line = Timeline::new(
            0.,
            -250.,
            0.,
            Curve::Bezier {
                x1: 0.,
                y1: 0.,
                x2: 1.,
                y2: 1.,
                duration_ms: 200,
            },
        )
        .unwrap();
        assert!((line.sample(0.1).0 + 125.).abs() < 1e-5);
        assert_eq!(line.sample(0.2), (-250., 0., true));
        for damping in [10., 20., 30.] {
            let spring = Timeline::new(
                0.,
                -250.,
                0.,
                Curve::Spring {
                    mass: 1.,
                    stiffness: 100.,
                    damping,
                    initial_velocity: 0.,
                },
            )
            .unwrap();
            let (x, v, _) = spring.sample(0.1);
            let retarget = Timeline::new(
                x,
                0.,
                v,
                Curve::Spring {
                    mass: 1.,
                    stiffness: 100.,
                    damping,
                    initial_velocity: 0.,
                },
            )
            .unwrap();
            assert!((retarget.sample(0.).0 - x).abs() < 1e-8);
            assert!((retarget.sample(0.).1 - v).abs() < 1e-8);
            assert_eq!(spring.sample(10.), (-250., 0., true));
        }
    }
}

#[cfg(test)]
mod placement_tests {
    use crate::{Kind, Metrics, Tree};
    use nk_text::{FontSet, ParleyBackend, Point, Size, TextStyle};
    use std::sync::Arc;
    #[test]
    fn fallback_hit_testing_uses_the_sample_while_atspi_keeps_model_bounds() {
        let mut tree = Tree::new(
            "Window",
            Metrics {
                sidebar: 120.,
                content: 400.,
                form_width: 400.,
                content_floor: 280.,
                titlebar: 48.,
                padding: 8.,
                gap: 4.,
                row: 48.,
                control: 24.,
                switch_width: 44.,
                radius: 8.,
                group_radius: 12.,
                focus_width: 2.,
                highlight_inset: 4.,
                hover_opacity: 0.08,
                separator_width: 1.,
            },
            TextStyle::default(),
        )
        .unwrap();
        let root = tree.root();
        let sidebar = tree.append(root, Kind::Sidebar, "Pages").unwrap();
        let page = tree
            .append(sidebar, Kind::Page { selected: false }, "Page")
            .unwrap();
        tree.append(root, Kind::TitleBar, "Title").unwrap();
        tree.append(root, Kind::Scroll, "Content").unwrap();
        let mut text = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
        tree.layout(
            Size {
                width: 640.,
                height: 360.,
            },
            false,
            &mut text,
        )
        .unwrap();
        tree.sidebar_open = false;
        tree.sidebar_x = -60.;
        tree.place();
        assert_eq!(tree.hit_test(Point { x: 20., y: 80. }), Some(page));
        assert!(!tree.focus_order().contains(&page));
        tree.focus(page).unwrap();
        let semantics = tree.semantics();
        assert_eq!(semantics.nodes[&page].bounds.x, -112.);
        assert!(semantics.nodes[&page].states.offscreen);
        // D7 differs: the compositor can still present the layer on screen after
        // its MODEL reaches -120. It sends layer-local coordinates of that picture.
        tree.sidebar_x = -120.;
        tree.place();
        assert_eq!(tree.hit_test(Point { x: 20., y: 80. }), None);
        tree.pointer_press_in(sidebar, Point { x: 20., y: 80. })
            .unwrap();
        assert_eq!(
            tree.pointer_release_in(sidebar, Point { x: 20., y: 80. })
                .unwrap(),
            crate::Effect::Activated(page)
        );
        assert!(tree.semantics().nodes[&page].states.selected);
    }
}
