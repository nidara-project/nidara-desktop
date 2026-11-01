// SPDX-License-Identifier: LGPL-3.0-or-later
use nk_wayland::{Glass, Material, Pane, Shadow, Tone};

pub fn panel(width: f32, height: f32) -> Material {
    // Phase-0 specimen of ui/lib/nidara-kit/platform/glass-material.ts:
    // TONES.panel.dark, SHADOWS.panel.dark and the panel's glass parameters.
    // These measured look values belong to this app, never the transport.
    Material {
        glass: Glass {
            refraction: 40.,
            rim: 0.5,
            lensing: 0.,
        },
        tone: Tone {
            saturation: 1.3,
            ceiling: 0.35,
            lift: 0.125,
            gain: 1.125,
            wash: [0., 0., 0., 0.],
            ambient: 0.8,
            ambient_lift: 0.125,
            ambient_gain: 0.5,
        },
        shadow: Shadow {
            opacity_small: 0.013,
            opacity_large: 0.175,
            blur_small: 2.,
            blur_large: 17.,
            offset: 8.,
        },
        shapes: vec![Pane {
            x: 16.,
            y: 8.,
            width: (width - 32.) as f64,
            height: (height - 16.) as f64,
            radius: 24.,
            exponent: 2.,
            pointer: None,
        }],
    }
}
