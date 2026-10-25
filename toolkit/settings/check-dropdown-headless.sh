#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Diagnostic transport probe only, on a private bus/Cage/software Hyalo.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
: "${HYALO_BIN:?Set an absolute fixed Hyalo binary}"
: "${NK_WIDGETS_BIN:?Set an absolute fixed dropdown-probe binary}"
: "${NK_SETTINGS_DATA:?Set an absolute exported settings-data directory}"
: "${NK_WIDGETS_LOG:?Set a new empty evidence directory}"
for path in "$HYALO_BIN" "$NK_WIDGETS_BIN" "$NK_SETTINGS_DATA" "$NK_WIDGETS_LOG"; do
    if [[ "$path" != /* ]]; then echo 'Absolute paths are required' >&2; exit 2; fi
done
mkdir -p "$repo/toolkit/target/dropdown-runtime-tmp"
exec bwrap --die-with-parent --unshare-pid --bind / / --dev-bind /dev /dev --proc /proc \
    --tmpfs "/run/user/$(id -u)" \
    --setenv TMPDIR "$repo/toolkit/target/dropdown-runtime-tmp" \
    --setenv LIBGL_ALWAYS_SOFTWARE 1 --setenv WLR_RENDERER pixman \
    --setenv NK_WIDGETS_CHECK nk-dropdown-check.py \
    "$repo/toolkit/widgets-demo/check-headless.sh"
