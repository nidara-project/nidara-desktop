#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Prove the provider's unit tests detect a broken shared privacy boundary."""
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'toolkit/crates/nk-a11y/src/lib.rs'
original = SOURCE.read_text()
needle = 'n.text = None;'
assert original.count(needle) == 1, 'privacy mutation anchor changed'
try:
    SOURCE.write_text(original.replace(needle, '// control: leave password content intact'))
    result = subprocess.run(['cargo', 'test', '--manifest-path', str(ROOT/'toolkit/Cargo.toml'),
                             '--locked', '-p', 'nk-a11y', 'password'], text=True,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    print(result.stdout)
    assert result.returncode != 0, 'password leak was not caught'
    for backend in ['atspi_backend']:
        assert any(backend in line and 'FAILED' in line for line in result.stdout.splitlines()), f'{backend} did not detect the password leak'
finally:
    SOURCE.write_text(original)
print('The provider caught the broken password boundary; source restored.')
