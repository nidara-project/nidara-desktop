# nk-text — phase-0 text evidence

The text and editing piece of [the toolkit contract](../../CONTRACT.md), for
[#824](https://github.com/nidara-project/nidara-desktop/issues/824). Both `parley`
and `pango` features are enabled by default. Neither engine is selected for the
future toolkit here. No Wayland, GTK widgets, renderer or accessibility dependency.
License: LGPL-3.0-or-later.

## API

`TextBackend::layout(text, style, max_width)` builds one retained `Layout`.
`TextStyle` supplies family, size in logical pixels, CSS weight (1–1000), line
height as a size multiplier, start/center/end/justify alignment, and auto/LTR/RTL
direction. Width, size and line height must be finite and positive.

```rust
use nk_text::{FontSet, ParleyBackend, TextBackend, TextStyle};
use std::sync::Arc;

let fonts = Arc::new(FontSet::discover_required()?);
let mut backend = ParleyBackend::new(fonts)?; // PangoBackend has the same API.
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
Native Pango trailing counts are converted immediately at the adapter edge; no
character or UTF-16 offset is stored in the model or exposed by its API. For an
upstream edge, the adapter asks about the native grapheme containing the last
scalar before that byte offset. This matters when Pango and `unicode-segmentation`
use different Unicode versions (Hindi on Pango 1.52). A native hit-test pair is
passed unchanged to native visual movement rather than re-encoded through another
version's grapheme boundaries.

Font bytes are shared with `Arc`; face indices distinguish TTC members. Variations
carry each axis tag and the actual shaper's normalized F2DOT14 coordinate (including
`avar`), rather than assuming a linear relationship between CSS weight and an axis.
Pango non-painted `PANGO_GLYPH_EMPTY` entries do not become paint glyphs; unknown
characters become glyph 0 and fail the corpus. Glyph y offsets follow Pango's
positive-down convention. The private Fontconfig map loads only the shared files
and the distribution's bitmap-scaling rule, never the system font directories.

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

Rust 1.90+, Fontconfig (`fc-match`), Pango/PangoCairo 1.50+, HarfBuzz and Cairo dev
libraries are needed with default features. The 0.21 gtk-rs bindings preserve the
workspace's Rust floor. Parley 0.12 uses `complex-scripts` and an isolated Fontique
collection with system discovery disabled.

Required families: **Noto Sans, Noto Sans Arabic, Noto Sans Hebrew, Noto Sans
Devanagari, Noto Sans CJK JP/SC/KR, Noto Color Emoji**, and **Inter Variable** (or
Inter, only if its selected face has a `wght` axis). `FontSet::discover_required`
rejects Fontconfig substitutions before running any layout oracle. Both engines
receive exactly these same font files and the same ordered family list.
`FontSet::from_files` also permits an explicit collection.

Arch packages:

```sh
sudo pacman -S pango fontconfig harfbuzz cairo noto-fonts noto-fonts-cjk noto-fonts-emoji inter-font
```

Ubuntu/CI packages (using the repository's apt retry wrapper):

```sh
scripts/ci/apt.sh install pkg-config libpango1.0-dev libfontconfig1-dev libharfbuzz-dev fontconfig fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fonts-inter-variable
```

No fonts are downloaded by the tests. A report includes paths, collection indices
and SHA-256 hashes so runs on distributions with different font versions can be
distinguished. Fontconfig's `10-scale-bitmap-fonts.conf` is required to shape the
bitmap emoji strike at the requested size.

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

To compile/test just an adapter, add `--no-default-features --features parley` or
`--features pango`. The default test enumerates **every JSON file** in `corpus/`,
runs all checks against both engines, and fails if any row fails. A report prints
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
its paint output. Cross-engine line counts differing by more than one fail **both**
rows, since that comparison cannot identify which engine is wrong.

The table reports **native cluster counts**, not a renamed grapheme count. For
example the same Hindi matras can produce two Parley clusters and four Pango
shaping clusters; both remain UTF-8 ranges. Explicit Unicode grapheme oracles and
deletion checks are independent of those engine counts. `क्षत्रिय` has a numeric
native cluster oracle shared by both engines.

The negative control first requires `combining-marks` to pass on both engines,
changes only backspace from grapheme to scalar iteration, requires that exact
case's backspace oracle to fail on both engines, and restores the original bytes
in `finally`. An unrelated corpus failure or a compilation failure cannot satisfy
it. CI then runs the unmodified full corpus. Real failures leave the job red; the
report still runs and is uploaded to the job summary/artifact.

## Measurement and observations

The report launches one fresh child process per backend. Each pass lays out all
case/width combinations, retaining every layout and its paint runs together until
the sample ends. It records the cold pass and the median/min/max of 50 subsequent
passes. Font discovery and backend initialisation are outside layout timing;
positioned glyph/font extraction is inside it. The same ordered corpus and files
are used for both engines, with filesystem caches left intact.

Peak memory is Linux `/proc/self/status` **VmHWM**, sampled after layout passes and
before correctness/editing checks. It includes shared font bytes, native caches,
loaded libraries and the runtime. Baseline **VmRSS** is sampled before loading the
fonts; neither number is claimed to be allocator-only memory. Child isolation
prevents the second backend inheriting the first one's high-water mark.

See [EVIDENCE.md](EVIDENCE.md) for the recorded local run and full table, and
[EVIDENCE-CI.md](EVIDENCE-CI.md) for the Ubuntu runner, its font hashes and failures. On that host,
Pango 1.58.2 fails the additional `forced-rtl` editing case: in `日本 abc שלום 12`,
forced RTL, native `move_cursor_visually(false, 0, 0, 1)` returns index -1 from the
weak cursor at byte 0. Visual WordRight consequently stays at 0 despite text to
its right. The report records FAIL and `cargo test` exits nonzero. This is evidence
for the owner, not an exception that makes a failing engine pass. The engine
choice remains with the owner.

Ubuntu CI's Pango 1.52.1 additionally fails the Hindi `devanagari-matras` case:
`get_cursor_pos(18)`'s weak cursor, fed directly into `xy_to_index`, yields byte 12
inside the Unicode grapheme. This also reproduces with the same Arch fonts and
only the native libraries changed to Ubuntu's official 1.52.1 packages. Native
1.58.2 returns byte 18. The common corpus reports the failure; no Unicode or
native-library version is exempted.

For an independent reproduction of both failures, without any `nk-text` adapter:

```sh
cc scripts/dev/nk-text-pango-probe.c -o /tmp/nk-text-pango-probe $(pkg-config --cflags --libs pangocairo)
/tmp/nk-text-pango-probe
```

The probe prints the runtime library version and raw cursor/hit/movement results,
and exits nonzero for a failed check. It does not decide the common corpus's
results or mark either failure as expected. The report also queries Pango's
runtime version, so a library override is reported correctly.

Native API references: [Parley](https://docs.rs/parley/0.12.0/parley/),
[Pango visual movement](https://docs.gtk.org/Pango/method.Layout.move_cursor_visually.html),
[Pango alignment with automatic direction](https://docs.gtk.org/Pango/method.Layout.set_auto_dir.html),
[Pango glyph coordinates](https://docs.gtk.org/Pango/struct.GlyphGeometry.html).
