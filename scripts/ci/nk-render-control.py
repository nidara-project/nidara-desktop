#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""The pixel corpus must reject a renderer that skips all supplied glyph runs."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
source = root / 'toolkit/crates/nk-render/src/lib.rs'
command = ['cargo', 'test', '--manifest-path', 'toolkit/Cargo.toml', '--locked',
           '-p', 'nk-render', '--lib', 'corpus_runs', '--', '--nocapture']


def run():
    result = subprocess.run(command, cwd=root, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    print(result.stdout, flush=True)
    return result


assert run().returncode == 0, 'renderer baseline did not pass'
original = source.read_bytes()
try:
    text = original.decode()
    rule = 'for run in layout.glyph_runs() {'
    assert text.count(rule) == 1
    source.write_text(text.replace(rule, 'for run in layout.glyph_runs().iter().take(0) {'))
    broken = run()
    assert broken.returncode != 0 and 'arabic-bidi is blank' in broken.stdout, 'pixel corpus missed skipped glyphs'
    print('CONTROL PASS: pixel corpus catches a renderer dropping glyph runs')
finally:
    source.write_bytes(original)
