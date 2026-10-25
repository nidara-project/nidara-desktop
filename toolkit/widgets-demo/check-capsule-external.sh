#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Local two-client capture, using fixed caller-selected binaries and export.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
: "${HYALO_BIN:?Set an absolute matching Hyalo binary}"
: "${NK_WIDGETS_BIN:?Set an absolute fixed demo binary}"
: "${NK_SETTINGS_DATA:?Set the exported settings-data directory}"
if [[ "$HYALO_BIN" != /* || "$NK_WIDGETS_BIN" != /* || "$NK_SETTINGS_DATA" != /* ]]; then
    echo 'Use absolute paths for both fixed binaries and the export' >&2
    exit 2
fi
scale=${CAPSULE_EXTERNAL_SCALE:-1}
fault=${CAPSULE_LAB_FAULT:-}
case "$scale" in 1|1.0|1.25) ;; *) echo 'Supported scales: 1 or 1.25' >&2; exit 2;; esac
case "$fault" in ''|fixed-light-ink) ;; *) echo 'Supported fault: fixed-light-ink' >&2; exit 2;; esac
log=${NK_WIDGETS_LOG:-$repo/toolkit/target/capsule-external-$scale-${fault:-baseline}}
mkdir -p "$repo/toolkit/target/capsule-runtime-tmp"
exec bwrap --die-with-parent --unshare-pid --bind / / --dev-bind /dev /dev --proc /proc \
    --tmpfs "/run/user/$(id -u)" \
    --setenv TMPDIR "$repo/toolkit/target/capsule-runtime-tmp" \
    --setenv LIBGL_ALWAYS_SOFTWARE 1 --setenv WLR_RENDERER pixman \
    --setenv NK_WIDGETS_REPO "$repo" --setenv HYALO_BIN "$HYALO_BIN" \
    --setenv HYALO_GLASS_TOKENS "$NK_SETTINGS_DATA/tokens/glass.json" \
    --setenv NK_WIDGETS_BIN "$NK_WIDGETS_BIN" --setenv NK_SETTINGS_DATA "$NK_SETTINGS_DATA" \
    --setenv NK_WIDGETS_LOG "$log" \
    --setenv NK_WIDGETS_HYALO_CONFIG "$repo/toolkit/widgets-demo/capsule-fixture.toml" \
    --setenv NK_WIDGETS_CHECK ../../toolkit/widgets-demo/capture-capsule-external.py \
    --setenv CAPSULE_EXTERNAL_SCALE "$scale" --setenv CAPSULE_LAB_FAULT "$fault" \
    "$repo/toolkit/widgets-demo/check-headless.sh"
