// SPDX-License-Identifier: LGPL-3.0-or-later
use nk_text::{Affinity, Alignment, FontSet, ParleyBackend, TextBackend, TextStyle};
use std::sync::Arc;
#[test]
fn cached_cluster_boxes_match_native_selection_and_carets() {
    let mut backend = ParleyBackend::new(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    for text in [
        "日本🙂 word",
        "a\u{301} ffi 👩‍👩‍👧‍👦",
        "abc אבג 12\n日本🙂 word",
        "אבג 12 abc",
        "مرحبا 12",
        "",
        "a\n",
    ] {
        for width in [90., 400.] {
            for alignment in [Alignment::Start, Alignment::Center, Alignment::End] {
                let layout = backend
                    .layout(
                        text,
                        &TextStyle {
                            alignment,
                            ..Default::default()
                        },
                        width,
                    )
                    .unwrap();
                let mut end = 0;
                for b in layout.cluster_boxes() {
                    assert_eq!(b.range.start, end, "cluster coverage in {text:?}");
                    end = b.range.end;
                    assert!(text.is_char_boundary(end));
                    // AT-SPI has no affinity. Validate the real cluster's
                    // leading edge by native point hit-testing. At a bidi soft
                    // wrap, byte->caret can choose the previous visual line.
                    if b.bounds.width > 0. {
                        let x = if (b.caret.x - b.bounds.x).abs() < 0.05 {
                            b.bounds.x + b.bounds.width * 0.25
                        } else {
                            b.bounds.x + b.bounds.width * 0.75
                        };
                        let hit = layout
                            .hit_test(nk_text::Point {
                                x,
                                y: b.bounds.y + b.bounds.height * 0.5,
                            })
                            .unwrap();
                        assert_eq!(
                            hit.offset, b.range.start,
                            "native hit {text:?} {:?} {:?}",
                            b.range, b.bounds
                        );
                    }
                    // A newline has no advance; Parley's selection draws an extra
                    // synthetic highlight after it, rather than a text glyph box.
                    if text[b.range.clone()].contains('\n') {
                        continue;
                    }
                    let start = layout
                        .caret_rect(b.range.start, Affinity::Downstream)
                        .unwrap();
                    let finish = layout.caret_rect(b.range.end, Affinity::Upstream).unwrap();
                    if (start.y - b.bounds.y).abs() > 0.05 || (finish.y - b.bounds.y).abs() > 0.05 {
                        continue; // Selection's bidi affinity crosses a soft wrap.
                    }
                    let rects = layout.selection_rects(b.range.clone()).unwrap();
                    assert!(!rects.is_empty(), "selection {text:?} {:?}", b.range);
                    let left = rects.iter().map(|r| r.x).fold(f32::INFINITY, f32::min);
                    let right = rects
                        .iter()
                        .map(|r| r.x + r.width)
                        .fold(f32::NEG_INFINITY, f32::max);
                    assert!(
                        (left - b.bounds.x).abs() < 0.05
                            && (right - b.bounds.x - b.bounds.width).abs() < 0.05,
                        "selection {text:?} {:?}: {:?} vs {:?}",
                        b.range,
                        b.bounds,
                        rects
                    );
                }
                assert_eq!(end, text.len());
            }
        }
    }
}

#[cfg(feature = "system-fonts")]
#[test]
fn selected_family_must_exist_without_fallback() {
    let mut backend =
        ParleyBackend::with_system_fonts(Arc::new(FontSet::discover_required().unwrap())).unwrap();
    assert!(backend.family_available("Noto Sans"));
    assert!(!backend.family_available("Nidara missing family 91d42a"));
}
