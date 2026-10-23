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
