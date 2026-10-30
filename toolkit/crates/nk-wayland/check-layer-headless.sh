#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Diagnostic layer-root probe (SHELL-SURFACES.md), private bus/Cage/software Hyalo.
# Not a CI job. Defaults: installed Hyalo, this checkout's debug layer-probe.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../../.." && pwd)
export HYALO_BIN=${HYALO_BIN:-/usr/bin/nidara-hyalo}
export NK_WIDGETS_BIN=${NK_WIDGETS_BIN:-$repo/toolkit/target/debug/examples/layer-probe}
export NK_SETTINGS_DATA=${NK_SETTINGS_DATA:-/usr/share/nidara/settings-data}
export NK_WIDGETS_LOG=${NK_WIDGETS_LOG:-$repo/toolkit/target/layer-evidence-$(date +%s)}
mkdir -p "$NK_WIDGETS_LOG" "$repo/toolkit/target/popup-runtime-tmp"
exec bwrap --die-with-parent --unshare-pid --bind / / --dev-bind /dev /dev --proc /proc \
    --tmpfs "/run/user/$(id -u)" \
    --setenv TMPDIR "$repo/toolkit/target/popup-runtime-tmp" \
    --setenv LIBGL_ALWAYS_SOFTWARE 1 --setenv WLR_RENDERER pixman \
    --setenv NK_WIDGETS_CHECK ../../toolkit/crates/nk-wayland/layer-check.py \
    "$repo/toolkit/widgets-demo/check-headless.sh"
