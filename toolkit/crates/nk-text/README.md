# nk-text — text layout and editing

The text and editing piece of [the toolkit contract](../../CONTRACT.md). Paragraph
layout is **Parley** (owner, 2026-10-15, #824): phase 0 ran one corpus against
Parley and Pango, Parley passed every case on Arch and on Ubuntu and Pango did not
(see [Why Parley](#why-parley)). The Pango adapter was removed once the choice was
made; it is in PR #825's history at `ac16cdd7` if a comparison ever has to be rerun.
No Wayland, renderer or accessibility dependency. License: LGPL-3.0-or-later.

## API

`TextBackend::layout(text, style, max_width)` builds one retained `Layout`.
`TextStyle` supplies family, size in logical pixels, CSS weight (1–1000), line
height as a size multiplier, start/center/end/justify alignment, and auto/LTR/RTL
direction. Width, size and line height must be finite and positive.

```rust
use nk_text::{FontSet, ParleyBackend, TextBackend, TextStyle};
use std::sync::Arc;

let fonts = Arc::new(FontSet::discover_required()?);
let mut backend = ParleyBackend::new(fonts)?;
let mut layout = backend.layout("שלום 123 abc עולם", &TextStyle::default(), 320.0)?;
let size = layout.size(180.0)?;
for run in layout.glyph_runs() {
    // Pass run.font.data, collection face index, actual normalized variations,
    // run.size and (glyph id, x, baseline y) tuples directly to the rasteriser.
    // Do not shape the string again.
}
# Ok::<(), String>(())
```

`size(width)` reflows that same native layout; `measured_size()` reads its last
measurement. Size covers the logical canvas in which the native engine positions
its lines, including alignment offsets. It is not an ink bounding box.
`hit_test(Point)` returns a `Caret { offset, affinity }`; `caret_rect` and
`selection_rects` use the same object as the glyph export. `Line` and `GlyphRun`
include logical byte ranges; runs are in native visual order. Empty text keeps
caret/line metrics, without exporting Parley's synthetic measuring space.

**All public offsets and range endpoints are UTF-8 bytes**, on scalar boundaries.
Invalid byte offsets/ranges return an error. Upstream affinity means the trailing
edge of the preceding grapheme; downstream means the leading edge of the next.
At bidi boundaries distinct byte/affinity pairs may share the same physical stop.
No character or UTF-16 offset is stored in the model or exposed by its API.

Font bytes are shared with `Arc`; face indices distinguish TTC members. Variations
carry each axis tag and the actual shaper's normalized F2DOT14 coordinate (including
`avar`), rather than assuming a linear relationship between CSS weight and an axis.
A character with no glyph in any font of the set becomes glyph 0 and fails the
corpus. Glyph y is the baseline, positive down. The Fontique collection holds only
the files of the `FontSet`; system font discovery is disabled.

`Editor` owns its backend, committed text, logical caret/selection, undo/redo and
one displayed layout. It exposes grapheme and visual word movement, up/down with
preferred x, logical line start/end, insert/replace, paste/cut, point and word
selection. The engines supply bidi movement and geometry; there is no independent
paragraph layout implementation. `set_max_width` reflows the displayed object.

`set_preedit(committed_range, text, local_byte_caret)` displays a replacement
without changing committed `text()`, caret, selection or undo history.
`display_text()`/`display_caret()` describe what is painted. Movement and grapheme
deletion can operate inside composition; `cancel_preedit` restores the committed
layout; `commit_preedit` records one undoable replacement. IME protocol handling
belongs to `nk-wayland`.

## Fonts and native dependencies

Rust 1.90+ and Fontconfig's `fc-match` (only to find the required files; layout
does not go through Fontconfig). Parley 0.12 uses `complex-scripts` and an isolated
Fontique collection with system discovery disabled. No C library is linked.

Required families: **Noto Sans, Noto Sans Arabic, Noto Sans Hebrew, Noto Sans
Devanagari, Noto Sans CJK JP/SC/KR, Noto Color Emoji**, and **Inter Variable** (or
Inter, only if its selected face has a `wght` axis). `FontSet::discover_required`
rejects Fontconfig substitutions before running any layout oracle.
`FontSet::from_files` also permits an explicit collection.

Arch packages:

```sh
sudo pacman -S fontconfig noto-fonts noto-fonts-cjk noto-fonts-emoji inter-font
```

Ubuntu/CI packages (using the repository's apt retry wrapper):

```sh
scripts/ci/apt.sh install fontconfig fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-inter-variable
```

No fonts are downloaded by the tests. A report includes paths, collection indices
and SHA-256 hashes so runs on distributions with different font versions can be
distinguished.

## Run the checks and report

From the repository root:

```sh
cargo run --manifest-path toolkit/Cargo.toml --locked --example corpus-report -- --check-fonts
cargo build --manifest-path toolkit/Cargo.toml --locked
cargo clippy --manifest-path toolkit/Cargo.toml --locked --all-targets -- -D warnings
cargo test --manifest-path toolkit/Cargo.toml --locked -- --nocapture
cargo run --release --manifest-path toolkit/Cargo.toml --locked --example corpus-report
cargo run --release --manifest-path toolkit/Cargo.toml --locked --example corpus-report -- --json
python3 scripts/ci/nk-text-control.py
```

The test enumerates **every JSON file** in `corpus/`, runs all checks, and fails
if any row fails. A report prints
the complete table before exiting 1 for a failing row (2 for setup errors).
There are no ignored tests, expected failures, or backend-specific pass criteria.

Every case executes caret/hit testing, grapheme backspace and forward delete,
insert/word selection/replace/undo/redo, preedit update/movement/deletion/cancel/
commit, mouse selection, clipboard operations, and word/line navigation. All JSON
checks are executable, with unknown keys rejected. Additional oracles cover native
visual run order, both visual edges of every bidi grapheme stop, cluster counts,
kinsoku, narrow wrapping, missing glyphs/fallback, actual variable coordinates and
advance changes. Selection points sit just inside edges: an exact bidi edge can
represent two logical positions. Reflow returns to the original width and checks
its paint output. `TextBackend` stays a trait and the corpus runner still takes a
list of backends: a second adapter can be measured against the same corpus, and
line counts differing by more than one between engines then fail both rows.

The table reports **native cluster counts**, not a renamed grapheme count; they
are UTF-8 ranges. Explicit Unicode grapheme oracles and
deletion checks are independent of those engine counts. `क्षत्रिय` has a numeric
native cluster oracle shared by both engines.

The negative control first requires `combining-marks` to pass,
changes only backspace from grapheme to scalar iteration, requires that exact
case's backspace oracle to fail, and restores the original bytes
in `finally`. An unrelated corpus failure or a compilation failure cannot satisfy
it. CI then runs the unmodified full corpus. Real failures leave the job red; the
report still runs and is uploaded to the job summary/artifact.

## Measurement and observations

The report launches one fresh child process per backend, so peak memory is the
engine's own. Each pass lays out all
case/width combinations, retaining every layout and its paint runs together until
the sample ends. It records the cold pass and the median/min/max of 50 subsequent
passes. Font discovery and backend initialisation are outside layout timing;
positioned glyph/font extraction is inside it. Filesystem caches are left intact.

Peak memory is Linux `/proc/self/status` **VmHWM**, sampled after layout passes and
before correctness/editing checks. It includes shared font bytes, native caches,
loaded libraries and the runtime. Baseline **VmRSS** is sampled before loading the
fonts; neither number is claimed to be allocator-only memory.

## Why Parley

Phase 0's gate test 1 (`toolkit/CONTRACT.md`) ran this corpus against both engines
with the same font files. The two recorded runs, kept as the decision record, are
[EVIDENCE.md](EVIDENCE.md) (Arch, native Pango 1.58.2) and
[EVIDENCE-CI.md](EVIDENCE-CI.md) (Ubuntu runner, Pango 1.52.1).

| | Parley 0.12 | Pango 1.58.2 (Arch) |
|---|---|---|
| Corpus, Arch | 19/19 | 18/19 |
| Corpus, Ubuntu | 19/19 | 17/19 (Pango 1.52.1) |
| Cold corpus | 1.4 ms | 11.1 ms |
| Warm median | 0.87 ms | 1.41 ms |
| Peak RSS | 51 MiB | 74 MiB |

Pango's failures were reproduced with a C probe on Pango's public API alone, with no
adapter in between:

- **Forced RTL** (both hosts): in `日本 abc שלום 12`, native
  `move_cursor_visually(false, 0, 0, 1)` returns -1 from the weak cursor at byte 0,
  so visual Right does not enter the text to its right.
- **Hindi matras** (Pango 1.52.1 only): the weak caret at byte 18, hit-tested, lands
  on byte 12, inside a grapheme. 1.58 returns byte 18, so it is a difference
  between Pango versions; Arch ships the newer one.

Besides the results, Parley is Rust, as the rest of the toolkit is, and needs no
`unsafe` FFI: the Pango adapter had to reach Fontconfig, PangoFc and HarfBuzz
through C to recover the font file and the variation coordinates.

Native API reference: [Parley](https://docs.rs/parley/0.12.0/parley/).
