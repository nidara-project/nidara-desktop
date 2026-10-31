#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# The coherent observation (compositor/src/ipc/observe.rs, #959 H1) against a private
# software Hyalo in a headless cage, its own bus and runtime: observe-check.py. Not a CI job.
#   HYALO_BIN=… NK_WIDGETS_BIN=…/examples/layer-probe hyalo/scripts/check-observe-headless.sh
# Needs nk-wayland's layer-probe and token-target examples built side by side.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
export HYALO_BIN=${HYALO_BIN:-$repo/hyalo/target/release/nidara-hyalo}
export NK_WIDGETS_BIN=${NK_WIDGETS_BIN:-$repo/toolkit/target/debug/examples/layer-probe}
export NK_SETTINGS_DATA=${NK_SETTINGS_DATA:-/usr/share/nidara/settings-data}
export NK_WIDGETS_LOG=${NK_WIDGETS_LOG:-$repo/hyalo/target/observe-evidence-$(date +%s)}
# No lock client here: a lock is Hyalo's own guard. A short usage idle (test channel only).
export HYALO_LOCK_RELAUNCH=true HYALO_TEST_USAGE_IDLE_MS=${HYALO_TEST_USAGE_IDLE_MS:-1500}
mkdir -p "$NK_WIDGETS_LOG" "$repo/hyalo/target/observe-runtime-tmp"
export NK_WIDGETS_CHECK=../../hyalo/scripts/observe-check.py
exec bwrap --die-with-parent --unshare-pid --bind / / --dev-bind /dev /dev --proc /proc \
    --tmpfs "/run/user/$(id -u)" \
    --setenv TMPDIR "$repo/hyalo/target/observe-runtime-tmp" \
    --setenv LIBGL_ALWAYS_SOFTWARE 1 --setenv WLR_RENDERER pixman \
    "$repo/toolkit/widgets-demo/check-headless.sh"
