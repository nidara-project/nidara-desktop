#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# The gallery's check (VIEW.md §13.3) on the widgets demo's private harness: a headless cage,
# a nested Hyalo, a private bus with a portal fixture, no live session touched.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
export NK_WIDGETS_BIN=${NK_WIDGETS_BIN:-$repo/toolkit/target/debug/nk-gallery}
export NK_WIDGETS_CHECK=nk-gallery-check.py
export NK_WIDGETS_LOG=${NK_WIDGETS_LOG:-$repo/toolkit/target/gallery-evidence}
exec "$repo/toolkit/widgets-demo/check-headless.sh" "$@"
