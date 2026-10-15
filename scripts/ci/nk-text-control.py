#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""The real corpus must catch char backspace, independently for both backends."""
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[2]
editor = root / "toolkit/crates/nk-text/src/editor.rs"
command = ["cargo", "test", "--manifest-path", "toolkit/Cargo.toml", "--locked",
           "--test", "corpus", "--", "--nocapture"]


def run(label):
    result = subprocess.run(command, cwd=root, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, check=False)
    print(f"--- {label} (exit {result.returncode}) ---\n{result.stdout}", flush=True)
    return result


# A different case may genuinely fail: this task is measuring both engines.
# That cannot establish this control. Require this exact case to pass first,
# then fail for the injected rule, with a compiled/running test on both engines.
baseline = run("baseline")
for backend in ("parley", "pango"):
    assert f"combining-marks / {backend}: PASS []" in baseline.stdout, (
        f"baseline combining-marks/{backend} did not pass; control is inconclusive")
original = editor.read_bytes()
try:
    source = original.decode()
    rule = ".grapheme_indices(true)"
    assert source.count(rule) == 1, "control must replace exactly one backspace rule"
    editor.write_text(source.replace(rule, ".char_indices()"))
    broken = run("backspace removes one scalar instead of one grapheme")
    assert broken.returncode != 0, "corpus accepted broken grapheme backspace"
    for backend in ("parley", "pango"):
        assert f"combining-marks / {backend}: backspace by grapheme:" in broken.stdout, (
            f"mutation was not caught by combining-marks/{backend}'s backspace oracle")
    print("CONTROL PASS: combining-marks catches char backspace on both backends")
finally:
    editor.write_bytes(original)
