> **Decision record.** Phase-0 comparison run that chose Parley (owner, 2026-10-15,
> #824). The Pango adapter it measured was removed afterwards; see PR #825 at `ac16cdd7`.

Recorded GitHub Actions run for library/corpus commit `379df952`, before the
runtime-version reporting and standalone native diagnostic were added. No corpus
oracle changed. [Job and full control logs](https://github.com/nidara-project/nidara-desktop/actions/runs/38752747681/job/116483097617)
· [uploaded report](https://github.com/nidara-project/nidara-desktop/actions/runs/38752747681/artifacts/11982465880).

The font preflight, locked build/lint and negative control passed. The unmodified
corpus and report exited nonzero for the two Pango failures below; the artifact
was uploaded successfully. These failures are not exempted or expected.

# nk-text corpus evidence

Run UTC: 2026-10-15T14:38:13Z. CPU: AMD EPYC 7763 64-Core Processor.

Generated on Linux x86_64. `rustc 1.99.0 (b940084d7 2026-09-28)`; native Pango `1.52.1`.

| Case | Backend | Result | Why | Width → lines / native clusters |
|---|---|---|---|---|
| arabic-bidi | pango | PASS |  | 90 → 2 / 18; 180 → 1 / 18; 480 → 1 / 18 |
| arabic-bidi | parley | PASS |  | 90 → 2 / 18; 180 → 1 / 18; 480 → 1 / 18 |
| center | pango | PASS |  | 140 → 2 / 14; 320 → 1 / 14 |
| center | parley | PASS |  | 140 → 2 / 14; 320 → 1 / 14 |
| chinese | pango | PASS |  | 95 → 7 / 24; 155 → 4 / 24; 340 → 2 / 24 |
| chinese | parley | PASS |  | 95 → 7 / 24; 155 → 4 / 24; 340 → 2 / 24 |
| combining-marks | pango | PASS |  | 20 → 2 / 4; 50 → 1 / 4; 160 → 1 / 4 |
| combining-marks | parley | PASS |  | 20 → 2 / 3; 50 → 1 / 3; 160 → 1 / 3 |
| devanagari-conjunct | pango | PASS |  | 35 → 1 / 3; 90 → 1 / 3; 320 → 1 / 3 |
| devanagari-conjunct | parley | PASS |  | 35 → 1 / 3; 90 → 1 / 3; 320 → 1 / 3 |
| devanagari-matras | pango | FAIL | caret/hit-test at width 30: hit at caret 18 splits a grapheme at 12; caret/hit-test at width 90: hit at caret 18 splits a grapheme at 12; caret/hit-test at width 320: hit at caret 18 splits a grapheme at 12 | 30 → 1 / 4; 90 → 1 / 4; 320 → 1 / 4 |
| devanagari-matras | parley | PASS |  | 30 → 1 / 2; 90 → 1 / 2; 320 → 1 / 2 |
| emoji-wrap | pango | PASS |  | 95 → 4 / 27; 180 → 2 / 27; 480 → 1 / 27 |
| emoji-wrap | parley | PASS |  | 95 → 4 / 27; 180 → 2 / 27; 480 → 1 / 27 |
| empty | pango | PASS |  | 60 → 1 / 0; 200 → 1 / 0 |
| empty | parley | PASS |  | 60 → 1 / 0; 200 → 1 / 0 |
| fallback | pango | PASS |  | 95 → 2 / 17; 180 → 1 / 17; 480 → 1 / 17 |
| fallback | parley | PASS |  | 95 → 2 / 17; 180 → 1 / 17; 480 → 1 / 17 |
| flags | pango | PASS |  | 28 → 2 / 2; 70 → 1 / 2; 200 → 1 / 2 |
| flags | parley | PASS |  | 28 → 2 / 2; 70 → 1 / 2; 200 → 1 / 2 |
| forced-ltr | pango | PASS |  | 140 → 1 / 11; 320 → 1 / 11 |
| forced-ltr | parley | PASS |  | 140 → 1 / 11; 320 → 1 / 11 |
| forced-rtl | pango | FAIL | editing/undo/redo/preedit/mouse: visual WordRight did not advance from byte 0 in "日本 abc שלום 12"; caret Caret { offset: 0, affinity: Downstream } | 140 → 1 / 11; 320 → 1 / 11 |
| forced-rtl | parley | PASS |  | 140 → 1 / 11; 320 → 1 / 11 |
| hebrew-bidi | pango | PASS |  | 90 → 2 / 17; 180 → 1 / 17; 480 → 1 / 17 |
| hebrew-bidi | parley | PASS |  | 90 → 2 / 17; 180 → 1 / 17; 480 → 1 / 17 |
| japanese | pango | PASS |  | 95 → 7 / 26; 155 → 4 / 26; 340 → 2 / 26 |
| japanese | parley | PASS |  | 95 → 7 / 26; 155 → 4 / 26; 340 → 2 / 26 |
| korean | pango | PASS |  | 95 → 6 / 26; 155 → 4 / 26; 340 → 2 / 26 |
| korean | parley | PASS |  | 95 → 6 / 26; 155 → 4 / 26; 340 → 2 / 26 |
| multiline | pango | PASS |  | 95 → 3 / 12; 180 → 3 / 12; 480 → 3 / 12 |
| multiline | parley | PASS |  | 95 → 3 / 14; 180 → 3 / 14; 480 → 3 / 14 |
| variable-font | pango | PASS |  | 150 → 2 / 24; 260 → 2 / 24; 480 → 1 / 24 |
| variable-font | parley | PASS |  | 150 → 2 / 24; 260 → 2 / 24; 480 → 1 / 24 |
| zwj-family | pango | PASS |  | 28 → 1 / 1; 70 → 1 / 1; 200 → 1 / 1 |
| zwj-family | parley | PASS |  | 28 → 1 / 1; 70 → 1 / 1; 200 → 1 / 1 |
| zwj-rainbow | pango | PASS |  | 28 → 1 / 1; 70 → 1 / 1; 200 → 1 / 1 |
| zwj-rainbow | parley | PASS |  | 28 → 1 / 1; 70 → 1 / 1; 200 → 1 / 1 |

| Backend | Layouts/pass | Cold corpus (ms) | Warm median (ms) | Warm min–max (ms), 50 passes | Peak RSS (KiB) | Baseline RSS (KiB) |
|---|---:|---:|---:|---:|---:|---:|
| parley | 53 | 1.931 | 1.219 | 1.205–1.352 | 51624 | 7052 |
| pango | 53 | 15.651 | 2.097 | 2.082–2.212 | 68240 | 7088 |

Each backend uses a fresh child process and the same files. Timing includes native layout and extraction of paint runs, excludes font discovery, backend initialisation and editing checks. All layouts for a pass are retained together. Peak RSS is Linux VmHWM after the cold + warm layout passes, before correctness checks; it includes the runtime, font bytes and native allocations. Baseline is VmRSS before loading fonts. Font caches/filesystem caches are not flushed. RSS and elapsed times are observations, not engine selection criteria on their own.

## Shared font manifest

| Family | Face | File | SHA-256 |
|---|---:|---|---|
| Noto Sans | 0 | /usr/share/fonts/truetype/noto/NotoSans-Regular.ttf | 89c3c497f618fdaa0b2d1e98fef93582f28c71debd2c4a8cdf41f190ced2909d |
| Noto Sans Arabic | 0 | /usr/share/fonts/truetype/noto/NotoSansArabic-Regular.ttf | 504d7407d86875acf7d04dfaa0fd7524d0b8797723bc4aa18022f29db25b0b6e |
| Noto Sans Hebrew | 0 | /usr/share/fonts/truetype/noto/NotoSansHebrew-Regular.ttf | 436900d5ad77d33e4234247f3076eaecd25b92b9bea0519514f684140e3566a7 |
| Noto Sans Devanagari | 0 | /usr/share/fonts/truetype/noto/NotoSansDevanagari-Regular.ttf | 79a470365ccb210fa3c7d8d8ff2e005ef9d983cfd067f735a0caf7e15070ca9f |
| Noto Sans CJK JP | 0 | /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc | b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a |
| Noto Sans CJK SC | 2 | /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc | b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a |
| Noto Sans CJK KR | 1 | /usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc | b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a |
| Noto Color Emoji | 0 | /usr/share/fonts/truetype/noto/NotoColorEmoji.ttf | 93cdc4ee9aa40e2afceecc63da0ca05ec7aab4bec991ece51a6b52389f48a477 |
| Inter Variable | 0 | /usr/share/fonts/truetype/inter-vf/InterVariable.ttf | 746431e950fd28d29b0189d708d4a5852a8458edb3184387eadcee9e5e34676c |
