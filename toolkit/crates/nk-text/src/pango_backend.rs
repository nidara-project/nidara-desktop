// SPDX-License-Identifier: LGPL-3.0-or-later
use crate::{
    Affinity, Alignment, Caret, Direction, Font, FontSet, GlyphRun, Layout, LayoutEngine, Line,
    Point, Rect, Result, Size, TextBackend, TextStyle,
};
use pango::{glib::translate::*, prelude::*};
use pangocairo::prelude::*;
use std::{
    ffi::{CStr, CString, c_char, c_int, c_void},
    ops::Range,
    path::Path,
    ptr,
    sync::Arc,
};
use unicode_segmentation::UnicodeSegmentation;

// gtk-rs does not wrap PangoFc's Fontconfig integration or the HarfBuzz font.
// These narrow, documented C APIs expose the exact fonts/coordinates Pango used.
#[link(name = "fontconfig")]
unsafe extern "C" {
    fn FcConfigCreate() -> *mut c_void;
    fn FcConfigDestroy(config: *mut c_void);
    fn FcConfigAppFontAddFile(config: *mut c_void, file: *const u8) -> c_int;
    fn FcConfigBuildFonts(config: *mut c_void) -> c_int;
    fn FcConfigParseAndLoad(config: *mut c_void, file: *const u8, complain: c_int) -> c_int;
    fn FcPatternGetString(
        pattern: *mut c_void,
        key: *const c_char,
        index: c_int,
        value: *mut *mut u8,
    ) -> c_int;
    fn FcPatternGetInteger(
        pattern: *mut c_void,
        key: *const c_char,
        index: c_int,
        value: *mut c_int,
    ) -> c_int;
}
#[link(name = "pangoft2-1.0")]
unsafe extern "C" {
    fn pango_fc_font_map_set_config(map: *mut c_void, config: *mut c_void);
    fn pango_fc_font_get_pattern(font: *mut c_void) -> *mut c_void;
}
#[link(name = "pango-1.0")]
unsafe extern "C" {
    fn pango_font_get_hb_font(font: *mut c_void) -> *mut c_void;
}
#[link(name = "harfbuzz")]
unsafe extern "C" {
    fn hb_font_get_var_coords_normalized(font: *mut c_void, length: *mut u32) -> *const c_int;
}

pub struct PangoBackend {
    fonts: Arc<FontSet>,
    map: pango::FontMap,
}
impl PangoBackend {
    pub fn new(fonts: Arc<FontSet>) -> Result<Self> {
        let map = pangocairo::FontMap::new();
        // SAFETY: create a private FcConfig, add only our shared paths, and pass
        // it to a Cairo FT map, which takes its own reference. Never alter the
        // global Fontconfig configuration or another backend's font set.
        unsafe {
            let config = FcConfigCreate();
            if config.is_null() {
                return Err("Fontconfig could not create the private font set".into());
            }
            // Keep Fontconfig's bitmap-size substitution (not its font directories).
            // Without it Noto Color Emoji is shaped at its 109px bitmap strike.
            if FcConfigParseAndLoad(
                config,
                c"/etc/fonts/conf.d/10-scale-bitmap-fonts.conf"
                    .as_ptr()
                    .cast(),
                0,
            ) == 0
            {
                FcConfigDestroy(config);
                return Err("required Fontconfig bitmap scaling configuration missing: 10-scale-bitmap-fonts.conf".into());
            }
            for (path, _) in fonts.font_files() {
                let path =
                    CString::new(path.as_os_str().as_encoded_bytes()).map_err(|e| e.to_string())?;
                if FcConfigAppFontAddFile(config, path.as_ptr().cast()) == 0 {
                    FcConfigDestroy(config);
                    return Err("Pango could not register a required font".into());
                }
            }
            if FcConfigBuildFonts(config) == 0 {
                FcConfigDestroy(config);
                return Err("Fontconfig could not build the shared font set".into());
            }
            pango_fc_font_map_set_config(map.as_ptr().cast(), config);
            FcConfigDestroy(config);
        }
        Ok(Self { fonts, map })
    }
}
impl TextBackend for PangoBackend {
    fn name(&self) -> &'static str {
        "pango"
    }
    fn layout(&mut self, text: &str, style: &TextStyle, max_width: f32) -> Result<Layout> {
        style.validate(max_width)?;
        if text.len() > i32::MAX as usize {
            return Err("Pango text exceeds its byte-index limit".into());
        }
        let context = self.map.create_context();
        context.set_round_glyph_positions(false);
        context.set_base_dir(match style.direction {
            Direction::Auto | Direction::Ltr => pango::Direction::Ltr,
            Direction::Rtl => pango::Direction::Rtl,
        });
        let layout = pango::Layout::new(&context);
        layout.set_auto_dir(style.direction == Direction::Auto);
        let mut description = pango::FontDescription::new();
        description.set_family(&self.fonts.families(&style.family).join(","));
        description.set_absolute_size(f64::from(style.size) * f64::from(pango::SCALE));
        description.set_weight(unsafe { from_glib(style.weight.round() as i32) });
        if style.family == self.fonts.variable_family {
            description.set_variations(Some(&format!("wght={}", style.weight)));
        }
        layout.set_font_description(Some(&description));
        let attrs = pango::AttrList::new();
        attrs.insert(pango::AttrInt::new_line_height_absolute(units(
            style.size * style.line_height,
        )));
        layout.set_attributes(Some(&attrs));
        layout.set_wrap(pango::WrapMode::Word);
        layout.set_text(text);
        // Pango alignment is physical, unlike its paragraph direction. Start/end
        // follow the paragraph; auto_dir supplies the first-strong direction.
        let rtl = style.direction == Direction::Rtl;
        layout.set_alignment(match style.alignment {
            Alignment::Center => pango::Alignment::Center,
            Alignment::End if !rtl => pango::Alignment::Right,
            Alignment::Start | Alignment::Justify if rtl => pango::Alignment::Right,
            _ => pango::Alignment::Left,
        });
        layout.set_justify(style.alignment == Alignment::Justify);
        Layout::new(
            text,
            style,
            max_width,
            Box::new(PangoLayout {
                native: layout,
                fonts: self.fonts.clone(),
                text: text.into(),
                runs: Vec::new(),
                lines: Vec::new(),
                clusters: Vec::new(),
            }),
        )
    }
}
struct PangoLayout {
    native: pango::Layout,
    fonts: Arc<FontSet>,
    text: String,
    runs: Vec<GlyphRun>,
    lines: Vec<Line>,
    clusters: Vec<Range<usize>>,
}
fn units(value: f32) -> i32 {
    (value * pango::SCALE as f32).round() as i32
}
fn pixels(value: i32) -> f32 {
    value as f32 / pango::SCALE as f32
}
fn rect(value: &pango::Rectangle) -> Rect {
    Rect {
        x: pixels(value.x()),
        y: pixels(value.y()),
        width: pixels(value.width()),
        height: pixels(value.height()),
    }
}
impl PangoLayout {
    fn native_position(&self, caret: Caret) -> (i32, i32) {
        if caret.offset > 0
            && (caret.affinity == Affinity::Upstream || caret.offset == self.text.len())
        {
            let (offset, grapheme) = self.text[..caret.offset]
                .grapheme_indices(true)
                .next_back()
                .unwrap();
            // Pango's native trailing count is immediately converted at this
            // adapter edge; the crate's model stores only byte offsets.
            (offset as i32, grapheme.chars().count() as i32)
        } else {
            (caret.offset as i32, 0)
        }
    }
    fn decode_native_position(&self, index: i32, trailing: i32) -> Caret {
        let start = index.max(0).min(self.text.len() as i32) as usize;
        let offset = self.text[start..]
            .char_indices()
            .nth(trailing.max(0) as usize)
            .map_or(self.text.len(), |(n, _)| start + n);
        Caret {
            offset,
            affinity: if trailing > 0 {
                Affinity::Upstream
            } else {
                Affinity::Downstream
            },
        }
    }
    fn font(&self, font: &pango::Font) -> Result<Font> {
        // SAFETY: all pointers are borrowed from the live Pango font. Read the
        // Fontconfig pattern and HB coordinates before the font can be dropped.
        unsafe {
            let font_ptr = font.as_ptr().cast();
            let pattern = pango_fc_font_get_pattern(font_ptr);
            let mut file = ptr::null_mut();
            let mut index = 0;
            if pattern.is_null()
                || FcPatternGetString(pattern, c"file".as_ptr(), 0, &mut file) != 0
                || file.is_null()
                || FcPatternGetInteger(pattern, c"index".as_ptr(), 0, &mut index) != 0
            {
                return Err("Pango font has no rasterisable file/index".into());
            }
            let path = CStr::from_ptr(file.cast())
                .to_str()
                .map_err(|e| e.to_string())?;
            let mut length = 0;
            let coords =
                hb_font_get_var_coords_normalized(pango_font_get_hb_font(font_ptr), &mut length);
            let coords: Vec<i16> = if coords.is_null() || length == 0 {
                Vec::new()
            } else {
                std::slice::from_raw_parts(coords, length as usize)
                    .iter()
                    .map(|n| *n as i16)
                    .collect()
            };
            self.fonts.resolve(Path::new(path), index as u32, &coords)
        }
    }
}
impl LayoutEngine for PangoLayout {
    fn reflow(&mut self, max_width: f32) -> Result<Size> {
        self.native.set_width(units(max_width));
        self.lines.clear();
        self.runs.clear();
        self.clusters.clear();
        let mut iter = self.native.iter();
        loop {
            let line = iter.line_readonly().ok_or("Pango omitted a line")?;
            self.lines.push(Line {
                range: line.start_index() as usize..(line.start_index() + line.length()) as usize,
                bounds: rect(&iter.line_extents().1),
            });
            if !iter.next_line() {
                break;
            }
        }
        let mut iter = self.native.iter();
        loop {
            if let Some(run) = iter.run_readonly() {
                let item = run.item();
                let glyphs = run.glyph_string();
                let range = item.offset() as usize..(item.offset() + item.length()) as usize;
                let line = self
                    .lines
                    .iter()
                    .position(|line| {
                        range.start >= line.range.start && range.start < line.range.end
                    })
                    .unwrap_or(self.lines.len() - 1);
                let mut x = pixels(iter.run_extents().1.x());
                let baseline = pixels(iter.baseline());
                let positioned = glyphs
                    .glyph_info()
                    .iter()
                    .filter_map(|g| {
                        let geometry = g.geometry();
                        let result = (
                            g.glyph(),
                            x + pixels(geometry.x_offset()),
                            baseline + pixels(geometry.y_offset()),
                        );
                        x += pixels(geometry.width());
                        // PANGO_GLYPH_EMPTY denotes non-painted whitespace/control,
                        // not a glyph in the font. Unknown glyphs stay observable as 0.
                        if g.glyph() == pango::GLYPH_EMPTY {
                            None
                        } else {
                            Some((
                                if g.glyph() & pango::GLYPH_UNKNOWN_FLAG != 0 {
                                    0
                                } else {
                                    result.0
                                },
                                result.1,
                                result.2,
                            ))
                        }
                    })
                    .collect();
                let mut starts: Vec<_> = glyphs
                    .log_clusters()
                    .iter()
                    .map(|n| range.start + *n as usize)
                    .collect();
                starts.push(range.end);
                starts.sort_unstable();
                starts.dedup();
                self.clusters
                    .extend(starts.windows(2).map(|pair| pair[0]..pair[1]));
                self.runs.push(GlyphRun {
                    font: self.font(&item.analysis().font())?,
                    size: item
                        .analysis()
                        .font()
                        .dynamic_cast::<pangocairo::Font>()
                        .map_err(|_| "Pango returned a non-Cairo font")?
                        .scaled_font()
                        .ok_or("Pango omitted its scaled font")?
                        .font_matrix()
                        .yy()
                        .abs() as f32,
                    glyphs: positioned,
                    range,
                    rtl: item.analysis().level() % 2 == 1,
                    line,
                    advance: pixels(glyphs.width()),
                });
            }
            if !iter.next_run() {
                break;
            }
        }
        self.clusters.sort_by_key(|r| r.start);
        self.clusters.dedup();
        let (width, height) = self.native.size();
        Ok(Size {
            width: self
                .lines
                .iter()
                .map(|l| l.bounds.x + l.bounds.width)
                .fold(pixels(width), f32::max),
            height: pixels(height),
        })
    }
    fn hit_test(&self, point: Point) -> Caret {
        let (_, index, trailing) = self.native.xy_to_index(units(point.x), units(point.y));
        self.decode_native_position(index, trailing)
    }
    fn caret_rect(&self, caret: Caret) -> Rect {
        let (index, trailing) = self.native_position(caret);
        let (line, x) = self.native.index_to_line_x(index, trailing != 0);
        let bounds = self
            .lines
            .get(line as usize)
            .map(|line| line.bounds)
            .unwrap_or_default();
        Rect {
            x: bounds.x + pixels(x),
            y: bounds.y,
            width: 1.0,
            height: bounds.height,
        }
    }
    fn selection_rects(&self, range: Range<usize>) -> Vec<Rect> {
        if range.is_empty() {
            return Vec::new();
        }
        self.native
            .lines_readonly()
            .iter()
            .zip(&self.lines)
            .flat_map(|(native, line)| {
                let start = range.start.max(line.range.start);
                let end = range.end.min(line.range.end);
                if start >= end {
                    return Vec::new();
                }
                native
                    .x_ranges(start as i32, end as i32)
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|pair| Rect {
                        x: pixels(pair[0]),
                        y: line.bounds.y,
                        width: pixels(pair[1] - pair[0]),
                        height: line.bounds.height,
                    })
                    .collect()
            })
            .collect()
    }
    fn move_visual(&self, caret: Caret, right: bool) -> Caret {
        // Canonicalise coincident bidi edges with Pango's own hit test.
        // At paragraph start a weak run edge can have a different logical
        // spelling from cursor_pos(0)'s paragraph edge.
        let here = self.caret_rect(caret);
        let canonical = self.hit_test(Point {
            x: here.x,
            y: here.center().y,
        });
        let (index, trailing) = self.native_position(canonical);
        // Pango moves its strong or weak cursor. Preserve which physical
        // cursor the public byte/affinity pair denotes, then translate its
        // resulting cursor back to our upstream/downstream run edge.
        let (strong_rect, weak_rect) = self.native.cursor_pos(canonical.offset as i32);
        let strong =
            (here.x - pixels(strong_rect.x())).abs() <= (here.x - pixels(weak_rect.x())).abs();
        let (next, next_trailing) =
            self.native
                .move_cursor_visually(strong, index, trailing, if right { 1 } else { -1 });
        if next < 0 || next == i32::MAX {
            return caret;
        }
        let mut result = self.decode_native_position(next, next_trailing);
        let (s, w) = self.native.cursor_pos(result.offset as i32);
        let target = pixels(if strong { s.x() } else { w.x() });
        let down = Caret {
            offset: result.offset,
            affinity: Affinity::Downstream,
        };
        let up = Caret {
            offset: result.offset,
            affinity: Affinity::Upstream,
        };
        result.affinity =
            if (self.caret_rect(up).x - target).abs() < (self.caret_rect(down).x - target).abs() {
                Affinity::Upstream
            } else {
                Affinity::Downstream
            };
        if (self.caret_rect(result).x - target).abs() > 1.0 / pango::SCALE as f32 {
            let target_rect = if strong { s } else { w };
            result = self.hit_test(Point {
                x: target,
                y: pixels(target_rect.y()) + pixels(target_rect.height()) / 2.0,
            });
        }
        result
    }
    fn glyph_runs(&self) -> &[GlyphRun] {
        &self.runs
    }
    fn lines(&self) -> &[Line] {
        &self.lines
    }
    fn clusters(&self) -> &[Range<usize>] {
        &self.clusters
    }
}
