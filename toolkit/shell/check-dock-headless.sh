#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# A private look at the Rust dock (DOCK.md §8): private bus, Cage, software Hyalo, a private
# Applications1. Not a CI job. Screenshots and logs land in $NK_WIDGETS_LOG.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
export HYALO_BIN=${HYALO_BIN:-/usr/bin/nidara-hyalo}
export NK_DOCK_BIN=${NK_DOCK_BIN:-$repo/toolkit/target/debug/nidara-shell}
export NK_SESSIOND_BIN=${NK_SESSIOND_BIN:-$repo/session/target/release/nidara-sessiond}
export NK_SETTINGS_DATA=${NK_SETTINGS_DATA:-/usr/share/nidara/settings-data}
export NK_WIDGETS_LOG=${NK_WIDGETS_LOG:-$repo/toolkit/target/dock-evidence-$(date +%s)}
mkdir -p "$NK_WIDGETS_LOG" "$repo/toolkit/target/popup-runtime-tmp"
export NK_WIDGETS_CHECK="../../toolkit/shell/dock-check.py"
exec bwrap --die-with-parent --unshare-pid --bind / / --dev-bind /dev /dev --proc /proc \
    --tmpfs "/run/user/$(id -u)" \
    --setenv TMPDIR "$repo/toolkit/target/popup-runtime-tmp" \
    --setenv LIBGL_ALWAYS_SOFTWARE 1 --setenv WLR_RENDERER pixman \
    "$repo/toolkit/widgets-demo/check-headless.sh"
