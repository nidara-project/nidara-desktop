#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Compatibility entry point for the original real-component probe."""
from pathlib import Path
import runpy
runpy.run_path(str(Path(__file__).resolve().parents[1] / 'ci/nk-fcitx5-check.py'), run_name='__main__')
