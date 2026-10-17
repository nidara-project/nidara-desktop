// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{
    Affinity, Alignment, Caret, ClusterBox, Direction, FontSet, GlyphRun, Layout, LayoutEngine,
    Line, Point, Rect, Result, Size, TextBackend, TextStyle,
};
use parley::{Cursor, FontContext, LayoutContext, PositionedLayoutItem, StyleProperty};
use std::{borrow::Cow, ops::Range, sync::Arc};

pub struct ParleyBackend {
    fonts: Arc<FontSet>,
    font_context: FontContext,
    context: LayoutContext<()>,
}
impl ParleyBackend {
    pub fn new(fonts: Arc<FontSet>) -> Result<Self> {
        let mut font_context = FontContext {
            collection: parley::fontique::Collection::new(parley::fontique::CollectionOptions {
                shared: false,
                system_fonts: false,
            }),
            source_cache: Default::default(),
        };
        for (_, bytes) in fonts.font_files() {
            if font_context
                .collection
                .register_fonts(parley::fontique::Blob::new(Arc::new(bytes.clone())), None)
                .is_empty()
            {
                return Err("Parley could not register a required font".into());
            }
        }
        Ok(Self {
            fonts,
            font_context,
            context: LayoutContext::new(),
        })
    }
}
impl TextBackend for ParleyBackend {
    fn name(&self) -> &'static str {
        "parley"
    }
    fn layout(&mut self, text: &str, style: &TextStyle, max_width: f32) -> Result<Layout> {
        style.validate(max_width)?;
        let families = self.fonts.families(&style.family);
        let names: Vec<_> = families
            .iter()
            .map(|name| parley::FontFamilyName::Named(Cow::Borrowed(name)))
            .collect();
        let mut builder = self
            .context
            .ranged_builder(&mut self.font_context, text, 1.0, false);
        builder.push_default(StyleProperty::FontFamily(parley::FontFamily::List(
            Cow::Borrowed(&names),
        )));
        builder.push_default(StyleProperty::FontSize(style.size));
        builder.push_default(StyleProperty::FontWeight(parley::FontWeight::new(
            style.weight,
        )));
        builder.push_default(StyleProperty::LineHeight(
            parley::LineHeight::FontSizeRelative(style.line_height),
        ));
        builder.set_base_direction(match style.direction {
            Direction::Auto => parley::BaseDirection::Auto,
            Direction::Ltr => parley::BaseDirection::Ltr,
            Direction::Rtl => parley::BaseDirection::Rtl,
        });
        let native = builder.build(text);
        Layout::new(
            text,
            style,
            max_width,
            Box::new(ParleyLayout {
                native,
                fonts: self.fonts.clone(),
                alignment: style.alignment,
                empty: text.is_empty(),
                runs: Vec::new(),
                lines: Vec::new(),
                clusters: Vec::new(),
                boxes: Vec::new(),
            }),
        )
    }
}
struct ParleyLayout {
    native: parley::Layout<()>,
    fonts: Arc<FontSet>,
    alignment: Alignment,
    empty: bool,
    runs: Vec<GlyphRun>,
    lines: Vec<Line>,
    clusters: Vec<Range<usize>>,
    boxes: Vec<ClusterBox>,
}
fn affinity(value: Affinity) -> parley::Affinity {
    match value {
        Affinity::Upstream => parley::Affinity::Upstream,
        Affinity::Downstream => parley::Affinity::Downstream,
    }
}
fn caret(value: Cursor) -> Caret {
    Caret {
        offset: value.index(),
        affinity: match value.affinity() {
            parley::Affinity::Upstream => Affinity::Upstream,
            parley::Affinity::Downstream => Affinity::Downstream,
        },
    }
}
fn rect(value: parley::BoundingBox) -> Rect {
    Rect {
        x: value.x0 as f32,
        y: value.y0 as f32,
        width: (value.x1 - value.x0) as f32,
        height: (value.y1 - value.y0) as f32,
    }
}
impl LayoutEngine for ParleyLayout {
    fn reflow(&mut self, max_width: f32) -> Result<Size> {
        self.native.break_all_lines(Some(max_width));
        self.native.align(
            match self.alignment {
                Alignment::Start => parley::Alignment::Start,
                Alignment::Center => parley::Alignment::Center,
                Alignment::End => parley::Alignment::End,
                Alignment::Justify => parley::Alignment::Justify,
            },
            parley::AlignmentOptions::default(),
        );
        self.runs.clear();
        self.lines.clear();
        self.clusters.clear();
        self.boxes.clear();
        for (line_index, line) in self.native.lines().enumerate() {
            let m = line.metrics();
            self.lines.push(Line {
                range: if self.empty { 0..0 } else { line.text_range() },
                bounds: Rect {
                    x: if self.empty {
                        0.0
                    } else {
                        m.offset + m.inline_min_coord
                    },
                    y: m.block_min_coord,
                    width: if self.empty {
                        0.0
                    } else {
                        m.advance - m.hanging_advance
                    },
                    height: m.block_max_coord - m.block_min_coord,
                },
            });
            if self.empty {
                continue;
            } // Parley shapes a synthetic space for empty-text caret metrics.
            // This text backend creates no inline boxes. Runs and their visual
            // clusters are exactly the sequence used by Parley's selection walk.
            let mut x = m.offset + m.inline_min_coord;
            let y = m.block_min_coord.min(m.content_block_min_coord);
            let height = m.block_max_coord.max(m.content_block_max_coord) - y;
            for run in line.runs() {
                self.clusters.extend(run.clusters().map(|c| c.text_range()));
                for cluster in run.visual_clusters() {
                    let width = cluster.advance();
                    self.boxes.push(ClusterBox {
                        range: cluster.text_range(),
                        bounds: Rect {
                            x,
                            y,
                            width,
                            height,
                        },
                        caret: Rect {
                            x: if cluster.is_rtl() { x + width } else { x },
                            y,
                            width: 1.,
                            height,
                        },
                    });
                    x += width;
                }
            }
            for item in line.items() {
                if let PositionedLayoutItem::GlyphRun(glyph_run) = item {
                    let run = glyph_run.run();
                    let coords: Vec<_> = run
                        .normalized_coords()
                        .iter()
                        .map(|v| v.to_bits())
                        .collect();
                    let font = self.fonts.resolve_bytes(
                        run.font().data.data(),
                        run.font().index,
                        &coords,
                    )?;
                    self.runs.push(GlyphRun {
                        font,
                        size: run.font_size(),
                        glyphs: glyph_run
                            .positioned_glyphs()
                            .map(|g| (g.id, g.x, g.y))
                            .collect(),
                        range: run.text_range(),
                        rtl: run.is_rtl(),
                        line: line_index,
                        advance: glyph_run.advance(),
                    });
                }
            }
        }
        self.clusters.sort_by_key(|r| r.start);
        self.clusters.dedup();
        self.boxes.sort_by_key(|b| b.range.start);
        Ok(Size {
            width: if self.empty {
                0.0
            } else {
                self.lines
                    .iter()
                    .map(|l| l.bounds.x + l.bounds.width)
                    .fold(self.native.width(), f32::max)
            },
            height: self.native.height(),
        })
    }
    fn hit_test(&self, point: Point) -> Caret {
        if self.empty {
            return Caret::default();
        }
        caret(Cursor::from_point(&self.native, point.x, point.y))
    }
    fn caret_rect(&self, value: Caret) -> Rect {
        rect(
            Cursor::from_byte_index(&self.native, value.offset, affinity(value.affinity))
                .geometry(&self.native, 1.0),
        )
    }
    fn selection_rects(&self, range: Range<usize>) -> Vec<Rect> {
        let start =
            Cursor::from_byte_index(&self.native, range.start, parley::Affinity::Downstream);
        let end = Cursor::from_byte_index(&self.native, range.end, parley::Affinity::Upstream);
        parley::Selection::new(start, end)
            .geometry(&self.native)
            .into_iter()
            .map(|(bounds, _)| rect(bounds))
            .collect()
    }
    fn move_visual(&self, value: Caret, right: bool) -> Caret {
        if self.empty {
            return Caret::default();
        }
        let cursor = Cursor::from_byte_index(&self.native, value.offset, affinity(value.affinity));
        caret(if right {
            cursor.next_visual(&self.native)
        } else {
            cursor.previous_visual(&self.native)
        })
    }
    fn glyph_runs(&self) -> &[GlyphRun] {
        &self.runs
    }
    fn lines(&self) -> &[Line] {
        &self.lines
    }
    fn cluster_boxes(&self) -> &[ClusterBox] {
        &self.boxes
    }
    fn clusters(&self) -> &[Range<usize>] {
        &self.clusters
    }
}
