#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# B3.1 only, private bus/settings/software compositor. No installed-session changes.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
: "${HYALO_BIN:?provide the matching Hyalo binary}"
: "${NK_DOCK_BIN:?provide this worktree's nidara-shell}"
: "${NK_SESSIOND_BIN:?provide this worktree's nidara-sessiond}"
: "${NK_SETTINGS_DATA:?provide exported settings data}"
export NK_WIDGETS_LOG=${NK_WIDGETS_LOG:-$repo/toolkit/target/notification-evidence}
export NK_WIDGETS_CHECK="../../toolkit/shell/notification_check.py"
mkdir -p "$NK_WIDGETS_LOG" "$repo/toolkit/target/notification-runtime-tmp"
if [ "${NK_NOTIFICATION_HIDPI_CHECK:-0}" = 1 ]; then
    printf '[outputs.winit]\nscale = 1.5\n' > "$NK_WIDGETS_LOG/hidpi.toml"
    export NK_WIDGETS_HYALO_CONFIG="$NK_WIDGETS_LOG/hidpi.toml"
fi
exec bwrap --die-with-parent --unshare-pid --bind / / --dev-bind /dev /dev --proc /proc \
    --tmpfs "/run/user/$(id -u)" --setenv TMPDIR "$repo/toolkit/target/notification-runtime-tmp" \
    --setenv LIBGL_ALWAYS_SOFTWARE 1 --setenv WLR_RENDERER pixman \
    "$repo/toolkit/widgets-demo/check-headless.sh"
