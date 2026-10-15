// SPDX-License-Identifier: LGPL-3.0-or-later
//! One set of machine-readable oracles, applied unchanged to both native engines.
use crate::*;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, fs, ops::Range, path::Path, sync::Arc};
use unicode_segmentation::UnicodeSegmentation;

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Case {
    pub id: String,
    pub text: String,
    pub widths: Vec<f32>,
    pub style: TextStyle,
    pub checks: Checks,
}
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Checks {
    pub utf8: bool,
    pub glyphs: bool,
    pub caret: bool,
    pub backspace: bool,
    pub delete: bool,
    pub editing: bool,
    pub wrap: bool,
    pub require_wrap: bool,
    pub visual_movement: bool,
    pub variable: bool,
    pub graphemes: Option<Vec<String>>,
    pub cluster_count: Option<usize>,
    pub visual_order: Vec<String>,
    pub no_line_start: String,
    pub fallback_for: Vec<char>,
    pub selection: Option<SelectionCheck>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SelectionCheck {
    pub range: [usize; 2],
    pub min_rects: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WidthResult {
    pub width: f32,
    pub lines: usize,
    pub clusters: usize,
    pub glyphs: usize,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CaseResult {
    pub case: String,
    pub backend: String,
    pub failures: Vec<String>,
    pub widths: Vec<WidthResult>,
}
impl CaseResult {
    pub fn passed(&self) -> bool {
        self.failures.is_empty()
    }
}

pub fn cases() -> Result<Vec<Case>> {
    load_cases(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("corpus")
            .as_path(),
    )
}
pub fn load_cases(dir: &Path) -> Result<Vec<Case>> {
    let mut paths: Vec<_> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .map(|entry| entry.map(|e| e.path()))
        .collect::<std::io::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    paths.retain(|p| p.extension().is_some_and(|e| e == "json"));
    paths.sort();
    let mut seen = HashSet::new();
    let mut cases = Vec::new();
    for path in paths {
        let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let case: Case =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        if !seen.insert(case.id.clone()) || case.widths.is_empty() {
            return Err(format!("invalid corpus case {}", case.id));
        }
        if case.widths.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(format!(
                "case {} widths must be strictly increasing",
                case.id
            ));
        }
        for width in &case.widths {
            case.style.validate(*width)?;
        }
        cases.push(case);
    }
    if cases.is_empty() {
        return Err("the text corpus is empty".into());
    }
    Ok(cases)
}
pub fn backend_names() -> Vec<&'static str> {
    let mut names = Vec::new();
    if cfg!(feature = "parley") {
        names.push("parley");
    }
    names
}
pub fn backend(name: &str, fonts: Arc<FontSet>) -> Result<Box<dyn TextBackend>> {
    match name {
        #[cfg(feature = "parley")]
        "parley" => Ok(Box::new(ParleyBackend::new(fonts)?)),
        _ => Err(format!("backend feature not enabled: {name}")),
    }
}
pub fn style(case: &Case, fonts: &FontSet) -> TextStyle {
    let mut style = case.style.clone();
    if style.family == "$variable" {
        style.family.clone_from(&fonts.variable_family);
    }
    style
}
pub fn run_case(case: &Case, name: &str, fonts: Arc<FontSet>) -> CaseResult {
    let mut result = CaseResult {
        case: case.id.clone(),
        backend: name.into(),
        failures: Vec::new(),
        widths: Vec::new(),
    };
    let mut check = |label: &str, test: Result<()>| {
        if let Err(error) = test {
            result.failures.push(format!("{label}: {error}"));
        }
    };
    let style = style(case, &fonts);
    let mut engine = match backend(name, fonts.clone()) {
        Ok(engine) => engine,
        Err(e) => {
            result.failures.push(e);
            return result;
        }
    };
    if let Some(expected) = &case.checks.graphemes {
        let actual: Vec<_> = case.text.graphemes(true).collect();
        check(
            "graphemes",
            require(
                actual == expected.iter().map(String::as_str).collect::<Vec<_>>(),
                format!("expected {expected:?}, got {actual:?}"),
            ),
        );
    }
    for width in &case.widths {
        let mut layout = match engine.layout(&case.text, &style, *width) {
            Ok(layout) => layout,
            Err(e) => {
                check("layout", Err(e));
                continue;
            }
        };
        result.widths.push(WidthResult {
            width: *width,
            lines: layout.lines().len(),
            clusters: layout.clusters().len(),
            glyphs: layout.glyph_runs().iter().map(|r| r.glyphs.len()).sum(),
        });
        let label = |name: &str| format!("{name} at width {width}");
        if case.checks.utf8 {
            check(&label("UTF-8 ranges"), utf8(&layout));
        }
        if case.checks.glyphs {
            check(&label("glyphs/font data"), glyphs(&layout));
        }
        if case.checks.caret {
            check(&label("caret/hit-test"), carets(&layout));
        }
        if case.checks.wrap {
            check(&label("line breaking"), wrapping(&layout));
        }
        if !case.checks.no_line_start.is_empty() {
            check(
                &label("kinsoku"),
                kinsoku(&layout, &case.checks.no_line_start),
            );
        }
        // Reflow the measured/painted object and compare the full exported
        // paint plan against a fresh native layout, not merely its glyph count.
        check(
            &label("reflow"),
            (|| {
                layout.size(*width * 1.3)?;
                layout.size(*width)?;
                let independent = engine.layout(&case.text, &style, *width)?;
                require(
                    layout.glyph_runs() == independent.glyph_runs()
                        && layout.lines() == independent.lines()
                        && layout.measured_size() == independent.measured_size(),
                    "reflow changed positioned glyphs, fonts/variations, lines or measured size",
                )
            })(),
        );
    }
    if case.checks.require_wrap {
        check(
            "narrow width wraps",
            require(
                result
                    .widths
                    .first()
                    .zip(result.widths.last())
                    .is_some_and(|(narrow, wide)| narrow.lines > wide.lines),
                "narrow text did not gain a line compared with its wide layout",
            ),
        );
    }
    let width = *case.widths.last().unwrap();
    if let Ok(layout) = engine.layout(&case.text, &style, width) {
        if let Some(expected) = case.checks.cluster_count {
            check(
                "cluster count",
                require(
                    layout.clusters().len() == expected,
                    format!("expected {expected}, got {}", layout.clusters().len()),
                ),
            );
        }
        if !case.checks.visual_order.is_empty() {
            check(
                "visual run order",
                visual_order(&layout, &case.checks.visual_order),
            );
        }
        if case.checks.visual_movement {
            check(
                "visual Right/Left through bidi boundaries",
                visual_movement(&layout),
            );
        }
        if let Some(selection) = &case.checks.selection {
            check(
                "visual selection of logical range",
                (|| {
                    let rects = layout.selection_rects(selection.range[0]..selection.range[1])?;
                    require(
                        rects.len() >= selection.min_rects,
                        format!(
                            "expected at least {} disjoint rectangles, got {}",
                            selection.min_rects,
                            rects.len()
                        ),
                    )
                })(),
            );
        }
        if !case.checks.fallback_for.is_empty() {
            check(
                "font fallback",
                fallback(&layout, &fonts, &style.family, &case.checks.fallback_for),
            );
        }
    }
    if case.checks.variable {
        check(
            "variable advances and coordinates",
            variable(&mut *engine, &case.text, &style),
        );
    }
    if case.checks.backspace {
        check(
            "backspace by grapheme",
            deletion(case, name, fonts.clone(), true),
        );
    }
    if case.checks.delete {
        check(
            "delete by grapheme",
            deletion(case, name, fonts.clone(), false),
        );
    }
    if case.checks.editing {
        check(
            "line/word/grapheme navigation",
            navigation(case, name, fonts.clone()),
        );
        check(
            "editing/undo/redo/preedit/mouse",
            editing(case, name, fonts),
        );
    }
    result
}
fn require(ok: bool, message: impl Into<String>) -> Result<()> {
    if ok { Ok(()) } else { Err(message.into()) }
}
fn utf8(layout: &Layout) -> Result<()> {
    for range in layout
        .lines()
        .iter()
        .map(|l| &l.range)
        .chain(layout.clusters())
        .chain(layout.glyph_runs().iter().map(|r| &r.range))
    {
        validate_range(layout.text(), range)?;
    }
    Ok(())
}
fn glyphs(layout: &Layout) -> Result<()> {
    if !layout.text().trim().is_empty() {
        require(
            !layout.glyph_runs().is_empty(),
            "visible text produced no runs",
        )?;
    }
    for run in layout.glyph_runs() {
        let face = ttf_parser::Face::parse(&run.font.data, run.font.index)
            .map_err(|e| format!("font data/index cannot be rasterised: {e:?}"))?;
        require(
            run.size.is_finite() && (run.size - layout.style().size).abs() < 0.1,
            format!(
                "font size {} differs from requested {}",
                run.size,
                layout.style().size
            ),
        )?;
        for (glyph, x, y) in &run.glyphs {
            require(
                *glyph != 0 && *glyph < u32::from(face.number_of_glyphs()),
                format!(
                    "missing/invalid glyph {glyph} in byte range {:?}",
                    run.range
                ),
            )?;
            require(
                x.is_finite() && y.is_finite(),
                "non-finite positioned glyph",
            )?;
        }
    }
    Ok(())
}
fn carets(layout: &Layout) -> Result<()> {
    let boundaries = grapheme_boundaries(layout.text());
    for offset in &boundaries {
        for affinity in [Affinity::Downstream, Affinity::Upstream] {
            let rect = layout.caret_rect(*offset, affinity)?;
            require(
                rect.x.is_finite() && rect.y.is_finite() && rect.height > 0.0,
                format!("invalid caret rectangle at {offset}/{affinity:?}: {rect:?}"),
            )?;
            let hit = layout.hit_test(Point {
                x: rect.x,
                y: rect.center().y,
            })?;
            require(
                boundaries.contains(&hit.offset),
                format!("hit at caret {offset} splits a grapheme at {}", hit.offset),
            )?;
        }
    }
    for run in layout.glyph_runs() {
        let rects = layout.selection_rects(run.range.clone())?;
        let Some(rect) = rects.iter().find(|r| r.width > 0.1) else {
            continue;
        };
        let hit = layout.hit_test(rect.center())?;
        require(
            hit.offset >= run.range.start && hit.offset <= run.range.end,
            format!(
                "hit {:?} on run {:?} landed at byte {}",
                rect.center(),
                run.range,
                hit.offset
            ),
        )?;
    }
    Ok(())
}
fn wrapping(layout: &Layout) -> Result<()> {
    for line in layout.lines() {
        let text = layout
            .text()
            .get(line.range.clone())
            .ok_or("native line outside buffer")?
            .trim();
        if line.bounds.width > layout.max_width() + 1.0 {
            let unbreakable = text.graphemes(true).count() <= 1
                || (text.unicode_words().count() == 1
                    && !text
                        .chars()
                        .any(|ch| matches!(ch, '\u{2e80}'..='\u{9fff}' | '\u{ac00}'..='\u{d7af}')));
            require(
                unbreakable,
                format!(
                    "line {:?} overflows {} > {}",
                    line.range,
                    line.bounds.width,
                    layout.max_width()
                ),
            )?;
        }
    }
    Ok(())
}
fn kinsoku(layout: &Layout, forbidden: &str) -> Result<()> {
    for line in layout.lines() {
        if let Some(first) = layout
            .text()
            .get(line.range.clone())
            .ok_or("native line outside buffer")?
            .trim_start()
            .chars()
            .next()
        {
            require(
                !forbidden.contains(first),
                format!(
                    "line at byte {} starts with closing punctuation {first}",
                    line.range.start
                ),
            )?;
        }
    }
    Ok(())
}
fn visual_order(layout: &Layout, expected: &[String]) -> Result<()> {
    let mut actual = Vec::new();
    for (word_index, word) in expected.iter().enumerate() {
        let start = layout
            .text()
            .find(word)
            .ok_or_else(|| format!("oracle word missing: {word}"))?;
        let end = start + word.len();
        let run_index = layout
            .glyph_runs()
            .iter()
            .position(|run| run.range.start < end && run.range.end > start)
            .ok_or("no visual run for oracle word")?;
        actual.push((run_index, word_index));
    }
    actual.sort_unstable();
    require(
        actual.iter().map(|(_, index)| *index).eq(0..expected.len()),
        format!("expected left-to-right words {expected:?}; native run order {actual:?}"),
    )
}
fn visual_movement(layout: &Layout) -> Result<()> {
    if layout.lines().len() != 1 {
        return Err("visual boundary oracle needs its wide, single-line layout".into());
    }
    let line = &layout.lines()[0];
    for right in [true, false] {
        let x = if right {
            line.bounds.x - 1.0
        } else {
            line.bounds.x + line.bounds.width + 1.0
        };
        let mut caret = layout.hit_test(Point {
            x,
            y: line.bounds.center().y,
        })?;
        let mut visited = Vec::new();
        let mut positions = Vec::new();
        let mut last_x = layout.caret_rect(caret.offset, caret.affinity)?.x;
        for _ in 0..layout.text().len() * 4 + 16 {
            if visited.contains(&caret) {
                return Err(format!("native visual movement loops at {caret:?}"));
            }
            visited.push(caret);
            positions.push(last_x);
            let next = layout.move_visual(caret, right)?;
            if next == caret {
                break;
            }
            let x = layout.caret_rect(next.offset, next.affinity)?.x;
            require(
                if right {
                    x + 0.8 >= last_x
                } else {
                    x - 0.8 <= last_x
                },
                format!(
                    "visual {} moved backwards: {caret:?} x={last_x} -> {next:?} x={x}",
                    if right { "Right" } else { "Left" }
                ),
            )?;
            caret = next;
            last_x = x;
        }
        for offset in grapheme_boundaries(layout.text()) {
            // At a bidi boundary different byte/affinity pairs can denote
            // the same physical stop. Require both visual edges, not a
            // particular native spelling of that stop.
            for affinity in [Affinity::Upstream, Affinity::Downstream] {
                let x = layout.caret_rect(offset, affinity)?.x;
                require(
                    positions.iter().any(|seen| (seen - x).abs() < 0.8),
                    format!(
                        "visual {} skipped caret byte {offset}/{affinity:?} at x={x}; visited {visited:?}",
                        if right { "Right" } else { "Left" }
                    ),
                )?;
            }
        }
    }
    Ok(())
}
fn fallback(layout: &Layout, fonts: &FontSet, primary: &str, chars: &[char]) -> Result<()> {
    let primary = fonts
        .files
        .iter()
        .find(|file| file.family == primary)
        .ok_or("fallback oracle primary family missing")?;
    let bytes = fs::read(&primary.path).map_err(|e| e.to_string())?;
    let face =
        ttf_parser::Face::parse(&bytes, primary.index & 0xffff).map_err(|e| format!("{e:?}"))?;
    for ch in chars {
        require(
            face.glyph_index(*ch).is_none(),
            format!("fallback oracle is not Latin-only: primary has {ch}"),
        )?;
        let offset = layout
            .text()
            .find(*ch)
            .ok_or("fallback oracle character missing")?;
        let run = layout
            .glyph_runs()
            .iter()
            .find(|run| run.range.contains(&offset))
            .ok_or("fallback produced no run")?;
        let fallback = ttf_parser::Face::parse(&run.font.data, run.font.index)
            .map_err(|e| format!("{e:?}"))?;
        require(
            fallback.glyph_index(*ch).is_some(),
            format!("fallback font lacks {ch}"),
        )?;
    }
    Ok(())
}
fn variable(backend: &mut dyn TextBackend, text: &str, style: &TextStyle) -> Result<()> {
    let mut normal = style.clone();
    normal.weight = 400.0;
    let mut bold = style.clone();
    bold.weight = 700.0;
    let normal = backend.layout(text, &normal, 4096.0)?;
    let bold = backend.layout(text, &bold, 4096.0)?;
    let advance = |layout: &Layout| {
        layout
            .glyph_runs()
            .iter()
            .map(|run| run.advance)
            .sum::<f32>()
    };
    require(
        (advance(&normal) - advance(&bold)).abs() > 0.01,
        format!("400 and 700 have identical advance {}", advance(&normal)),
    )?;
    let coords = |layout: &Layout| {
        layout
            .glyph_runs()
            .iter()
            .flat_map(|run| run.font.variations.iter())
            .filter(|v| v.axis == *b"wght")
            .map(|v| v.normalized)
            .collect::<Vec<_>>()
    };
    require(
        !coords(&normal).is_empty()
            && !coords(&bold).is_empty()
            && coords(&normal) != coords(&bold),
        "glyph runs did not carry distinct actual wght coordinates for 400 and 700",
    )
}
fn editor(case: &Case, name: &str, fonts: Arc<FontSet>) -> Result<Editor> {
    Editor::new(
        backend(name, fonts.clone())?,
        &case.text,
        style(case, &fonts),
        *case.widths.last().unwrap(),
    )
}
fn deletion(case: &Case, name: &str, fonts: Arc<FontSet>, backwards: bool) -> Result<()> {
    let mut editor = editor(case, name, fonts)?;
    let graphemes: Vec<_> = case.text.graphemes(true).collect();
    if backwards {
        editor.set_caret(case.text.len(), Affinity::Upstream, false)?;
    }
    for removed in 1..=graphemes.len() {
        if backwards {
            editor.backspace()?;
        } else {
            editor.delete()?;
        }
        let expected = if backwards {
            graphemes[..graphemes.len() - removed].concat()
        } else {
            graphemes[removed..].concat()
        };
        require(
            editor.text() == expected,
            format!(
                "after deletion {removed}: expected {expected:?}, got {:?}",
                editor.text()
            ),
        )?;
        require(
            editor.caret().offset == if backwards { expected.len() } else { 0 },
            "deletion left the wrong byte caret",
        )?;
    }
    Ok(())
}
fn editing(case: &Case, name: &str, fonts: Arc<FontSet>) -> Result<()> {
    let mut e = editor(case, name, fonts)?;
    e.insert("probe ")?;
    state(&e, &format!("probe {}", case.text), 6, 6..6)?;
    e.set_selection(
        Caret::default(),
        Caret {
            offset: 5,
            affinity: Affinity::Upstream,
        },
    )?;
    require(
        e.selected_text() == "probe",
        "logical word selection did not copy probe",
    )?;
    require(
        !e.selection_rects()?.is_empty(),
        "selected word has no visual rectangles",
    )?;
    let probe = e.layout().selection_rects(0..5)?;
    e.select_word_at(probe.first().ok_or("probe word has no rectangle")?.center())?;
    state(&e, &format!("probe {}", case.text), 5, 0..5)?;
    e.insert("edit")?;
    state(&e, &format!("edit {}", case.text), 4, 4..4)?;
    require(e.undo()?, "undo unavailable")?;
    state(&e, &format!("probe {}", case.text), 5, 0..5)?;
    require(e.redo()?, "redo unavailable")?;
    state(&e, &format!("edit {}", case.text), 4, 4..4)?;
    e.set_preedit(0..4, "にほん", 3)?;
    state(&e, &format!("edit {}", case.text), 4, 4..4)?;
    require(
        e.display_text() == format!("にほん {}", case.text) && e.display_caret().offset == 3,
        "preedit is not displayed separately with its byte caret",
    )?;
    e.caret_rect()?;
    e.set_preedit(0..4, "日本", 6)?;
    require(e.display_caret().offset == 6, "preedit update caret")?;
    e.move_caret(Movement::Left, false)?;
    require(
        e.preedit().is_some_and(|p| p.caret.offset == 3),
        "caret did not move inside preedit",
    )?;
    e.backspace()?;
    require(
        e.preedit()
            .is_some_and(|p| p.text == "本" && p.caret.offset == 0),
        "preedit backspace did not remove one grapheme",
    )?;
    state(&e, &format!("edit {}", case.text), 4, 4..4)?;
    e.set_preedit(0..4, "日本", 0)?;
    e.delete()?;
    require(
        e.preedit()
            .is_some_and(|p| p.text == "本" && p.caret.offset == 0),
        "preedit delete did not remove one grapheme",
    )?;
    state(&e, &format!("edit {}", case.text), 4, 4..4)?;
    e.cancel_preedit()?;
    state(&e, &format!("edit {}", case.text), 4, 4..4)?;
    require(
        e.display_text() == e.text(),
        "cancel left preedit in the displayed layout",
    )?;
    e.set_preedit(0..4, "日本", 6)?;
    e.commit_preedit()?;
    state(&e, &format!("日本 {}", case.text), 6, 6..6)?;
    require(e.undo()?, "preedit commit has no undo")?;
    state(&e, &format!("edit {}", case.text), 4, 4..4)?;
    require(e.redo()?, "preedit commit has no redo")?;
    e.set_selection(
        Caret::default(),
        Caret {
            offset: 6,
            affinity: Affinity::Upstream,
        },
    )?;
    require(e.cut()? == "日本", "cut lost selected Unicode bytes")?;
    state(&e, &format!(" {}", case.text), 0, 0..0)?;
    e.paste("日本")?;
    state(&e, &format!("日本 {}", case.text), 6, 6..6)?;
    // Real geometry drives mouse selection, then native visual word movement.
    let prefix = e.layout().selection_rects(0..6)?;
    require(!prefix.is_empty(), "prefix selection has no geometry")?;
    let start = e.layout().caret_rect(0, Affinity::Downstream)?;
    let end = e.layout().caret_rect(6, Affinity::Upstream)?;
    e.select_between(
        Point {
            x: start.x + 0.25,
            y: start.center().y,
        },
        Point {
            x: end.x - 0.25,
            y: end.center().y,
        },
    )?;
    require(
        e.selected_text() == "日本",
        format!("mouse selection got {:?}", e.selected_text()),
    )?;
    e.set_caret(0, Affinity::Downstream, false)?;
    e.move_caret(Movement::WordRight, false)?;
    require(
        e.caret().offset > 0,
        format!(
            "visual WordRight did not advance from byte 0 in {:?}; caret {:?}",
            e.text(),
            e.caret()
        ),
    )?;
    // Invalid UTF-8 offsets must refuse without changing the buffer.
    let before = e.text().to_string();
    require(
        e.set_caret(1, Affinity::Downstream, false).is_err(),
        "accepted an offset inside a UTF-8 scalar",
    )?;
    require(
        e.replace_range(1..2, "x").is_err() && e.text() == before,
        "invalid range mutated text",
    )?;
    Ok(())
}
fn state(e: &Editor, text: &str, caret: usize, selection: Range<usize>) -> Result<()> {
    require(
        e.text() == text && e.caret().offset == caret && e.selection() == selection,
        format!(
            "expected text {text:?}, caret {caret}, selection {selection:?}; got {:?}, {:?}, {:?}",
            e.text(),
            e.caret(),
            e.selection()
        ),
    )
}
/// The cross-engine oracle is symmetric: a difference over one line fails both
/// rows rather than guessing which engine is right or forgiving a known failure.
pub fn compare_line_counts(results: &mut [CaseResult]) {
    for a in 0..results.len() {
        for b in a + 1..results.len() {
            if results[a].case != results[b].case || results[a].backend == results[b].backend {
                continue;
            }
            for (one, two) in results[a]
                .widths
                .clone()
                .iter()
                .zip(&results[b].widths.clone())
            {
                if (one.width - two.width).abs() < f32::EPSILON && one.lines.abs_diff(two.lines) > 1
                {
                    let why = format!(
                        "line count at width {} differs by more than 1: {}={}, {}={}",
                        one.width, results[a].backend, one.lines, results[b].backend, two.lines
                    );
                    results[a].failures.push(why.clone());
                    results[b].failures.push(why);
                }
            }
        }
    }
}

fn navigation(case: &Case, name: &str, fonts: Arc<FontSet>) -> Result<()> {
    let text = format!("one two\nthree four\n{}", case.text);
    let mut e = Editor::new(
        backend(name, fonts.clone())?,
        &text,
        style(case, &fonts),
        *case.widths.last().unwrap(),
    )?;
    e.set_caret(2, Affinity::Downstream, false)?;
    e.move_caret(Movement::Down, false)?;
    require(
        (8..18).contains(&e.caret().offset),
        format!("Down did not reach the second line: {:?}", e.caret()),
    )?;
    e.move_caret(Movement::Up, false)?;
    require(
        e.caret().offset == 2,
        format!("Up lost the preferred column: {:?}", e.caret()),
    )?;
    e.move_caret(Movement::LineStart, false)?;
    require(e.caret().offset == 0, "line start did not reach byte 0")?;
    e.move_caret(Movement::LineEnd, true)?;
    // Native lines may include their newline in the logical range.
    require(
        e.selected_text().trim_end() == "one two",
        "line end/extended selection lost text",
    )?;
    e.set_caret(1, Affinity::Downstream, false)?;
    e.move_caret(Movement::WordRight, false)?;
    require(
        e.caret().offset == 3,
        format!("word right did not reach end of one: {:?}", e.caret()),
    )?;
    e.move_caret(Movement::WordLeft, false)?;
    require(
        e.caret().offset == 0,
        "word left did not return to start of one",
    )?;
    let mut original = editor(case, name, fonts)?;
    let boundaries = grapheme_boundaries(&case.text);
    for offset in &boundaries {
        for movement in [Movement::Left, Movement::Right] {
            original.set_caret(*offset, Affinity::Downstream, false)?;
            original.move_caret(movement, false)?;
            require(
                boundaries.contains(&original.caret().offset),
                "arrow landed inside a grapheme",
            )?;
        }
    }
    Ok(())
}
