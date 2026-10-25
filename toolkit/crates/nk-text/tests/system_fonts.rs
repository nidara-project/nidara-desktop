// SPDX-License-Identifier: LGPL-3.0-or-later
#![cfg(feature = "system-fonts")]
use nk_text::{FontSet, ParleyBackend, TextBackend, TextStyle};
use std::{process::Command, sync::Arc};

#[test]
fn installed_face_bytes_survive_backend_drop_and_reflow() {
    let output = Command::new("fc-match")
        .args(["-f", "%{family}\n%{file}\n%{index}\n", "DejaVu Sans"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let metadata = String::from_utf8(output.stdout).unwrap();
    let mut fields = metadata.lines();
    assert_eq!(
        fields.next(),
        Some("DejaVu Sans"),
        "install DejaVu Sans for this oracle"
    );
    let bytes = std::fs::read(fields.next().unwrap()).unwrap();
    let index: u32 = fields.next().unwrap().parse().unwrap();
    let fonts = Arc::new(FontSet::discover_required().unwrap());
    assert!(!fonts.font_files().any(|(_, data)| data.as_ref() == bytes));
    let style = TextStyle {
        family: "DejaVu Sans".into(),
        ..Default::default()
    };
    let mut isolated = ParleyBackend::new(fonts.clone()).unwrap();
    let isolated_layout = isolated.layout("Family preview", &style, 400.).unwrap();
    assert!(
        isolated_layout
            .glyph_runs()
            .iter()
            .all(|run| run.font.data.as_ref() != bytes)
    );
    let mut backend = ParleyBackend::with_system_fonts(fonts).unwrap();
    let mut layout = backend
        .layout("Family preview words wrap here", &style, 400.)
        .unwrap();
    let retained = layout.glyph_runs()[0].font.data.clone();
    assert!(
        retained.as_ref() == bytes,
        "system shaping must use the installed face, not the required-font fallback"
    );
    assert!(
        layout
            .glyph_runs()
            .iter()
            .all(|run| run.font.index == index && Arc::ptr_eq(&run.font.data, &retained))
    );
    assert!(
        layout
            .glyph_runs()
            .iter()
            .flat_map(|run| &run.glyphs)
            .all(|g| g.0 != 0)
    );
    drop(backend);
    layout.size(95.).unwrap();
    assert!(layout.lines().len() > 1);
    assert!(
        layout
            .glyph_runs()
            .iter()
            .all(|run| Arc::ptr_eq(&run.font.data, &retained))
    );
    let exported = layout.glyph_runs()[0].clone();
    drop(layout);
    assert!(ttf_parser::Face::parse(&exported.font.data, exported.font.index).is_ok());
    assert!(exported.font.data.as_ref() == bytes);
}

#[test]
fn installed_oblique_face_and_explicit_variation_settings_reach_the_shaper() {
    use nk_text::{AxisSetting, Slant};
    let fonts = Arc::new(FontSet::discover_required().unwrap());
    let mut backend = ParleyBackend::with_system_fonts(fonts.clone()).unwrap();
    let output = Command::new("fc-match")
        .args(["-f", "%{file}", "DejaVu Sans:slant=110"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let file = String::from_utf8(output.stdout).unwrap();
    assert!(
        file.contains("Oblique"),
        "install DejaVu Sans Oblique for the oracle"
    );
    let bytes = std::fs::read(file).unwrap();
    let layout = backend
        .layout(
            "Preview",
            &TextStyle {
                family: "DejaVu Sans".into(),
                slant: Slant::Oblique,
                ..Default::default()
            },
            400.,
        )
        .unwrap();
    assert!(
        layout.glyph_runs().iter().all(|run| {
            // Fontique may choose an installed oblique face or request a synthetic skew.
            // Either must reach the renderer; silently upright output is not acceptable.
            run.font.data.as_ref() == bytes || run.skew_degrees != 0.
        }),
        "oblique request must export an oblique face or the actual synthesis skew"
    );
    let setting = AxisSetting {
        axis: *b"wght",
        value: 800.,
    };
    let style = TextStyle {
        family: fonts.variable_family.clone(),
        variations: vec![setting.clone()],
        ..Default::default()
    };
    let variable = backend.layout("Preview", &style, 400.).unwrap();
    let run = &variable.glyph_runs()[0];
    let mut face = ttf_parser::Face::parse(&run.font.data, run.font.index).unwrap();
    let axis = face
        .variation_axes()
        .into_iter()
        .position(|axis| axis.tag.to_bytes() == *b"wght")
        .unwrap();
    face.set_variation(ttf_parser::Tag::from_bytes(b"wght"), 800.)
        .unwrap();
    let expected = face.variation_coordinates()[axis].get();
    assert_ne!(expected, 0);
    assert_eq!(
        run.font
            .variations
            .iter()
            .find(|v| v.axis == *b"wght")
            .unwrap()
            .normalized,
        expected,
        "actual shaper coordinates must include explicit axis settings"
    );
    let mut invalid = style;
    invalid.variations.push(setting);
    assert!(backend.layout("Preview", &invalid, 400.).is_err());
    invalid.variations.clear();
    invalid.width = f32::NAN;
    assert!(backend.layout("Preview", &invalid, 400.).is_err());
}

#[test]
fn required_regular_fallback_does_not_hide_installed_bold_faces() {
    let output = Command::new("fc-match")
        .args([
            "-f",
            "%{family[0]}\n%{file}\n%{index}\n",
            "Noto Sans:weight=200",
        ])
        .output()
        .unwrap();
    assert!(output.status.success());
    let metadata = String::from_utf8(output.stdout).unwrap();
    let fields: Vec<_> = metadata.lines().collect();
    assert_eq!(
        fields[0], "Noto Sans",
        "install Noto Sans Bold for this oracle"
    );
    let expected = std::fs::read(fields[1]).unwrap();
    let index: u32 = fields[2].parse().unwrap();
    let fonts = Arc::new(FontSet::discover_required().unwrap());
    assert!(fonts.files.iter().any(|file| file.family == "Noto Sans"));
    let mut backend = ParleyBackend::with_system_fonts(fonts).unwrap();
    let result = backend.layout(
        "Bold preview",
        &TextStyle {
            family: "Noto Sans".into(),
            weight: 700.,
            ..Default::default()
        },
        400.,
    );
    assert!(
        result.is_ok(),
        "required regular fallback must retain installed bold faces: {:?}",
        result.as_ref().err()
    );
    let layout = result.unwrap();
    assert!(
        layout
            .glyph_runs()
            .iter()
            .all(|run| run.font.data.as_ref() == expected
                && run.font.index == index
                && run.skew_degrees == 0.),
        "bold must use the installed face independently identified by Fontconfig"
    );
}
