# nk-text corpus evidence

Run UTC: 2026-10-15T14:44:28Z. CPU: AMD Ryzen 5 5600X 6-Core Processor.

Generated on Linux x86_64. `rustc 1.99.0 (b940084d7 2026-09-28) (Arch Linux rust 1:1.99.0-1)`; native Pango `1.58.2`.

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
| devanagari-matras | pango | PASS |  | 30 → 1 / 4; 90 → 1 / 4; 320 → 1 / 4 |
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
| parley | 53 | 1.424 | 0.866 | 0.843–1.355 | 52620 | 7948 |
| pango | 53 | 11.073 | 1.410 | 1.373–1.855 | 75332 | 8088 |

Each backend uses a fresh child process and the same files. Timing includes native layout and extraction of paint runs, excludes font discovery, backend initialisation and editing checks. All layouts for a pass are retained together. Peak RSS is Linux VmHWM after the cold + warm layout passes, before correctness checks; it includes the runtime, font bytes and native allocations. Baseline is VmRSS before loading fonts. Font caches/filesystem caches are not flushed. RSS and elapsed times are observations, not engine selection criteria on their own.

## Shared font manifest

| Family | Face | File | SHA-256 |
|---|---:|---|---|
| Noto Sans | 0 | /usr/share/fonts/noto/NotoSans-Regular.ttf | 478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823 |
| Noto Sans Arabic | 0 | /usr/share/fonts/noto/NotoSansArabic-Regular.ttf | bdff3e5659d67e67def05b33f749683b9376ae819d65d3dd62ac4640b3aaef48 |
| Noto Sans Hebrew | 0 | /usr/share/fonts/noto/NotoSansHebrew-Regular.ttf | cdefaf8efd47045f6820928eba84db5bed7557539328952b5f828315485e02ee |
| Noto Sans Devanagari | 0 | /usr/share/fonts/noto/NotoSansDevanagari-Regular.ttf | 4e3c66638958c3e2ab5d37f47a8deb89fffeb7be9985c665a519bbc7ba762313 |
| Noto Sans CJK JP | 0 | /usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc | b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a |
| Noto Sans CJK SC | 2 | /usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc | b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a |
| Noto Sans CJK KR | 1 | /usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc | b76b0433203017ca80401b2ee0dd69350349871c4b19d504c34dbdd80541690a |
| Noto Color Emoji | 0 | /usr/share/fonts/noto/NotoColorEmoji.ttf | 72a635cb3d2f3524c51620cdde406b217204e8a6a06c6a096ff8ed4b5fd6e27b |
| Inter Variable | 0 | /usr/share/fonts/inter/InterVariable.ttf | 4989b125924991b90d05b2d16e0e388c48f7d5bb8b30539bbf9c755278d0ccaf |
