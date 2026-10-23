#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-3.0-or-later
"""Listing diagnostics: actual child failure, synthetic window inventory; no live bus."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("slice_check", Path(__file__).with_name("check.py"))
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class ListingDiagnostics(unittest.TestCase):
    def test_child_exit_includes_its_real_status_and_stderr(self):
        root = Path(__file__).resolve().parents[1] / "target"
        root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="listing-", dir=root) as folder:
            log = Path(folder) / "child.log"
            with log.open("w") as stderr:
                child = subprocess.Popen([sys.executable, "-c",
                    "import sys; print('SLICE_ERROR probe failure', file=sys.stderr); sys.exit(23)"], stderr=stderr)
                try:
                    with patch.object(check, "hyalo_windows", return_value=[]):
                        with self.assertRaisesRegex(RuntimeError, "exited 23.*SLICE_ERROR probe failure"):
                            check.first_listing(child.pid, time.monotonic() + 2, child, log)
                finally:
                    if child.poll() is None:
                        child.kill()
                    child.wait()

    def test_listing_matches_the_requested_pid(self):
        wanted = {"pid": 77, "background": {"level": "opaque"}}
        with patch.object(check, "hyalo_windows", return_value=[{"pid": 12}, wanted]):
            self.assertEqual(check.first_listing(77, time.monotonic() + 1), wanted)

    def test_missing_window_remains_setup_failure(self):
        with patch.object(check, "hyalo_windows", return_value=[]):
            with self.assertRaisesRegex(RuntimeError, "setup: Hyalo never listed"):
                check.first_listing(77, time.monotonic() - 1)


if __name__ == "__main__":
    unittest.main()
