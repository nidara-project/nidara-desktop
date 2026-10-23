// SPDX-License-Identifier: LGPL-3.0-or-later
use nk_render::{Canvas, rgba};
use nk_text::{FontSet, ParleyBackend, TextBackend, TextStyle};
use std::sync::Arc;

#[test]
fn synthetic_skew_changes_each_glyph_outline_without_moving_its_baseline() {
    let fonts = Arc::new(FontSet::discover_required().unwrap());
    let mut backend = ParleyBackend::new(fonts.clone()).unwrap();
    let layout = backend
        .layout(
            "II",
            &TextStyle {
                family: fonts.variable_family.clone(),
                size: 64.,
                ..Default::default()
            },
            240.,
        )
        .unwrap();
    let render = |skew| {
        let mut canvas = Canvas::new(240, 120, 1.);
        for run in layout.glyph_runs() {
            let mut run = run.clone();
            run.skew_degrees = skew;
            canvas
                .glyph_run(&run, (30., 10.), rgba(255, 255, 255, 255))
                .unwrap();
        }
        canvas.finish()
    };
    let upright = render(0.);
    let slanted = render(20.);
    assert_ne!(
        upright, slanted,
        "actual rasterized outlines must carry synthesis"
    );
    let occupied = |pixels: &[u8]| {
        (0..120)
            .filter(|&y| (0..240).any(|x| pixels[(y * 240 + x) * 4 + 3] != 0))
            .collect::<Vec<_>>()
    };
    let rows = occupied(&upright);
    assert_eq!(
        rows,
        occupied(&slanted),
        "horizontal synthesis preserves baseline and vertical extent"
    );
    let center = |pixels: &[u8], y: usize| {
        let mut mass = 0.;
        let mut moment = 0.;
        for x in 0..240 {
            let a = pixels[(y * 240 + x) * 4 + 3] as f64;
            mass += a;
            moment += a * x as f64;
        }
        moment / mass
    };
    let top = rows[rows.len() / 4];
    let bottom = rows[rows.len() * 3 / 4];
    let upper_shift = center(&slanted, top) - center(&upright, top);
    let lower_shift = center(&slanted, bottom) - center(&upright, bottom);
    assert!(
        upper_shift > lower_shift + 3.,
        "positive oblique must lean right above its baseline: {upper_shift} vs {lower_shift}"
    );
}
