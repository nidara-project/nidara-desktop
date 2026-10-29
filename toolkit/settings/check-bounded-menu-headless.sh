#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Fixed binaries, private bus/runtime/settings, headless Cage -> Hyalo only.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
: "${HYALO_BIN:?absolute current Hyalo binary required}"
: "${NK_WIDGETS_BIN:?absolute bounded-menu-probe binary required}"
: "${NK_SETTINGS_DATA:?absolute settings-data export required}"
: "${NK_WIDGETS_LOG:?fresh absolute evidence directory required}"
for path in "$HYALO_BIN" "$NK_WIDGETS_BIN" "$NK_SETTINGS_DATA" "$NK_WIDGETS_LOG"; do
    [[ "$path" == /* ]] || { echo 'absolute paths required' >&2; exit 2; }
done
mkdir -p "$repo/toolkit/target/bounded-popup-runtime-tmp"
exec bwrap --die-with-parent --unshare-pid --bind / / --dev-bind /dev /dev --proc /proc \
    --tmpfs "/run/user/$(id -u)" \
    --setenv TMPDIR "$repo/toolkit/target/bounded-popup-runtime-tmp" \
    --setenv LIBGL_ALWAYS_SOFTWARE 1 --setenv WLR_RENDERER pixman \
    --setenv NK_WIDGETS_CHECK nk-bounded-menu-check.py \
    "$repo/toolkit/widgets-demo/check-headless.sh"
