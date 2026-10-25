// SPDX-License-Identifier: LGPL-3.0-or-later
//! Phase-0 text API. Every text index and range is a UTF-8 byte offset.
//! Native layouts are retained: measuring, hit testing and exported glyphs use
//! the same shaping result. No renderer, Wayland or accessibility dependencies.
pub mod corpus;
mod editor;
mod fonts;
#[cfg(feature = "parley")]
mod parley_backend;

pub use editor::{Editor, Movement, Preedit};
pub use fonts::{FontFile, FontSet};
#[cfg(feature = "parley")]
pub use parley_backend::ParleyBackend;
use serde::{Deserialize, Serialize};
use std::{ops::Range, sync::Arc};
use unicode_segmentation::UnicodeSegmentation;

pub type Result<T> = std::result::Result<T, String>;
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f32,
    pub y: f32,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Size {
    pub width: f32,
    pub height: f32,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}
impl Rect {
    pub fn center(self) -> Point {
        Point {
            x: self.x + self.width / 2.0,
            y: self.y + self.height / 2.0,
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Affinity {
    Upstream,
    #[default]
    Downstream,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Caret {
    pub offset: usize,
    pub affinity: Affinity,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Alignment {
    #[default]
    Start,
    /// Physical left edge, independently of paragraph direction (scrolling inputs).
    Left,
    Center,
    End,
    Justify,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Direction {
    #[default]
    Auto,
    Ltr,
    Rtl,
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum Slant {
    #[default]
    Normal,
    Italic,
    Oblique,
}
/// An OpenType design-space setting; exported glyphs carry actual normalized values.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct AxisSetting {
    pub axis: [u8; 4],
    pub value: f32,
}
/// Size in logical pixels; line_height is a multiple of size, weight is CSS 1..1000.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct TextStyle {
    pub family: String,
    pub size: f32,
    pub weight: f32,
    pub slant: Slant,
    pub width: f32,
    pub variations: Vec<AxisSetting>,
    pub line_height: f32,
    pub alignment: Alignment,
    pub direction: Direction,
}
impl Default for TextStyle {
    fn default() -> Self {
        Self {
            family: "Noto Sans".into(),
            size: 20.0,
            weight: 400.0,
            slant: Slant::Normal,
            width: 100.,
            variations: Vec::new(),
            line_height: 1.5,
            alignment: Alignment::Start,
            direction: Direction::Auto,
        }
    }
}
impl TextStyle {
    pub fn validate(&self, width: f32) -> Result<()> {
        if !width.is_finite()
            || width <= 0.0
            || !self.size.is_finite()
            || self.size <= 0.0
            || !self.line_height.is_finite()
            || self.line_height <= 0.0
            || !self.weight.is_finite()
            || !(1.0..=1000.0).contains(&self.weight)
            || !self.width.is_finite()
            || self.width <= 0.
            || self.variations.iter().enumerate().any(|(i, setting)| {
                !setting.value.is_finite()
                    || !setting.axis.iter().all(|byte| (0x20..=0x7e).contains(byte))
                    || self.variations[..i]
                        .iter()
                        .any(|old| old.axis == setting.axis)
            })
        {
            return Err("invalid text style or max_width".into());
        }
        Ok(())
    }
}
/// OpenType normalized F2DOT14 coordinate, including the font's avar mapping.
/// These are the coordinates actually used by the shaper, not guessed from weight.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Variation {
    pub axis: [u8; 4],
    pub normalized: i16,
}
/// Renderer-ready font bytes + collection face index and actual variations.
#[derive(Clone, Debug, PartialEq)]
pub struct Font {
    pub data: Arc<[u8]>,
    pub index: u32,
    pub variations: Vec<Variation>,
}
#[derive(Clone, Debug, PartialEq)]
pub struct GlyphRun {
    /// Actual shaper synthesis, in degrees; zero for an unsynthesized face.
    pub skew_degrees: f32,
    pub font: Font,
    pub size: f32,
    pub glyphs: Vec<(u32, f32, f32)>,
    pub range: Range<usize>,
    pub rtl: bool,
    pub line: usize,
    pub advance: f32,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Line {
    pub range: Range<usize>,
    pub bounds: Rect,
}

/// Real shaped-cluster geometry, in layout logical pixels. Several scalars can
/// occupy one cluster (combining marks/emoji/ligatures); never split it by width.
#[derive(Clone, Debug, PartialEq)]
pub struct ClusterBox {
    pub range: Range<usize>,
    pub bounds: Rect,
    pub caret: Rect,
}

pub trait TextBackend {
    fn name(&self) -> &'static str;
    fn layout(&mut self, text: &str, style: &TextStyle, max_width: f32) -> Result<Layout>;
}
// Private native-layout seam: each engine keeps its own caret/bidi/selection rules.
pub(crate) trait LayoutEngine {
    fn reflow(&mut self, max_width: f32) -> Result<Size>;
    fn hit_test(&self, point: Point) -> Caret;
    fn caret_rect(&self, caret: Caret) -> Rect;
    fn selection_rects(&self, range: Range<usize>) -> Vec<Rect>;
    fn move_visual(&self, caret: Caret, right: bool) -> Caret;
    fn glyph_runs(&self) -> &[GlyphRun];
    fn lines(&self) -> &[Line];
    fn clusters(&self) -> &[Range<usize>];
    fn cluster_boxes(&self) -> &[ClusterBox];
}
pub struct Layout {
    text: String,
    style: TextStyle,
    max_width: f32,
    size: Size,
    engine: Box<dyn LayoutEngine>,
}
impl Layout {
    pub(crate) fn new(
        text: &str,
        style: &TextStyle,
        max_width: f32,
        mut engine: Box<dyn LayoutEngine>,
    ) -> Result<Self> {
        style.validate(max_width)?;
        let size = engine.reflow(max_width)?;
        Ok(Self {
            text: text.into(),
            style: style.clone(),
            max_width,
            size,
            engine,
        })
    }
    pub fn text(&self) -> &str {
        &self.text
    }
    pub fn style(&self) -> &TextStyle {
        &self.style
    }
    pub fn max_width(&self) -> f32 {
        self.max_width
    }
    /// Rebreak the retained native layout, never shape a second rendering layout.
    pub fn size(&mut self, max_width: f32) -> Result<Size> {
        self.style.validate(max_width)?;
        self.size = self.engine.reflow(max_width)?;
        self.max_width = max_width;
        Ok(self.size)
    }
    /// Logical canvas extent, including alignment offsets; not an ink box.
    pub fn measured_size(&self) -> Size {
        self.size
    }
    pub fn hit_test(&self, point: Point) -> Result<Caret> {
        if !point.x.is_finite() || !point.y.is_finite() {
            return Err("non-finite hit-test point".into());
        }
        let caret = self.engine.hit_test(point);
        self.validate_offset(caret.offset)?;
        Ok(caret)
    }
    pub fn caret_rect(&self, offset: usize, affinity: Affinity) -> Result<Rect> {
        self.validate_offset(offset)?;
        Ok(self.engine.caret_rect(Caret { offset, affinity }))
    }
    pub fn selection_rects(&self, range: Range<usize>) -> Result<Vec<Rect>> {
        self.validate_range(&range)?;
        Ok(self.engine.selection_rects(range))
    }
    pub fn glyph_runs(&self) -> &[GlyphRun] {
        self.engine.glyph_runs()
    }
    pub fn lines(&self) -> &[Line] {
        self.engine.lines()
    }
    pub fn clusters(&self) -> &[Range<usize>] {
        self.engine.clusters()
    }
    /// Cached during reflow in one visual pass over the retained shaped runs.
    pub fn cluster_boxes(&self) -> &[ClusterBox] {
        self.engine.cluster_boxes()
    }
    pub fn move_visual(&self, caret: Caret, right: bool) -> Result<Caret> {
        self.validate_offset(caret.offset)?;
        let next = self.engine.move_visual(caret, right);
        self.validate_offset(next.offset)?;
        Ok(next)
    }
    pub(crate) fn validate_offset(&self, offset: usize) -> Result<()> {
        validate_offset(&self.text, offset)
    }
    pub(crate) fn validate_range(&self, range: &Range<usize>) -> Result<()> {
        validate_range(&self.text, range)
    }
}
pub(crate) fn validate_offset(text: &str, offset: usize) -> Result<()> {
    if text.is_char_boundary(offset) {
        Ok(())
    } else {
        Err(format!(
            "invalid UTF-8 byte offset {offset}, buffer length {}",
            text.len()
        ))
    }
}
pub(crate) fn validate_range(text: &str, range: &Range<usize>) -> Result<()> {
    validate_offset(text, range.start)?;
    validate_offset(text, range.end)?;
    if range.start > range.end {
        return Err("reversed text range".into());
    }
    Ok(())
}
pub fn grapheme_boundaries(text: &str) -> Vec<usize> {
    text.grapheme_indices(true)
        .map(|(offset, _)| offset)
        .chain(std::iter::once(text.len()))
        .collect()
}
