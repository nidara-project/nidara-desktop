#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Production native Settings/selector in rust-session.sh inside a private headless
# Cage and PID namespace. No installation, live bus, system service or hardware.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
if [ "${1:-}" = --inner ]; then
    export HYALO_CONTROL="$DISPLAY_SETTINGS_RUN/control"
    mkfifo "$HYALO_CONTROL"
    export HYALO_A11Y_MANAGER=1
    export NK_DISPLAY_TEST_FRAMES=1
    exec "$repo/scripts/dev/rust-session.sh" python3 "$repo/scripts/dev/display-settings-check.py"
fi
: "${HYALO_BIN:?Set the exact built Hyalo binary}"
: "${SESSIOND_BIN:?Set the exact built sessiond binary}"
: "${NK_SETTINGS_BIN:?Set the exact built native Settings binary}"
: "${DISPLAY_SELECTOR_BIN:?Set the exact built selector binary}"
: "${NK_SETTINGS_DATA:?Set complete exported settings-data}"
export DISPLAY_SETTINGS_OUT=${OUT:-$repo/target/display-settings/headless-$(date +%s-%N)}
mkdir -p "$(dirname "$DISPLAY_SETTINGS_OUT")"
mkdir -m 700 "$DISPLAY_SETTINGS_OUT"
export DISPLAY_SETTINGS_RUN
DISPLAY_SETTINGS_RUN=$(mktemp -d "$HOME/Nidara/ChatGPT/ds.XXXXXX")
trap 'rm -rf "$DISPLAY_SETTINGS_RUN"' EXIT
mkdir -m 700 "$DISPLAY_SETTINGS_RUN/runtime" "$DISPLAY_SETTINGS_RUN/data" "$DISPLAY_SETTINGS_RUN/config" "$DISPLAY_SETTINGS_RUN/cache" "$DISPLAY_SETTINGS_RUN/state"
export NK_ICON_REFERENCE="$repo/ui/shell/assets/icons/nidara"
status=0
timeout --signal=TERM --kill-after=5s 180s bwrap --die-with-parent --unshare-pid --bind / / --dev-bind /dev /dev --proc /proc \
    --tmpfs /tmp --tmpfs "/run/user/$(id -u)" \
    env -u DISPLAY -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS -u AT_SPI_BUS_ADDRESS -u HYALO_SOCKET \
    XDG_RUNTIME_DIR="$DISPLAY_SETTINGS_RUN/runtime" XDG_CONFIG_HOME="$DISPLAY_SETTINGS_RUN/config" \
    XDG_DATA_HOME="$DISPLAY_SETTINGS_RUN/data" XDG_CACHE_HOME="$DISPLAY_SETTINGS_RUN/cache" XDG_STATE_HOME="$DISPLAY_SETTINGS_RUN/state" \
    GSETTINGS_BACKEND=keyfile LIBGL_ALWAYS_SOFTWARE=1 WLR_RENDERER=pixman WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 \
    LANG=C.UTF-8 LC_ALL=C.UTF-8 cage -d -- "$0" --inner > "$DISPLAY_SETTINGS_OUT/session.log" 2>&1 || status=$?
cat "$DISPLAY_SETTINGS_OUT/check.log" 2>/dev/null || true
# Hyalo can exit normally after a driver exception; its exit code alone is not
# evidence that the assertions ran. Require the final success marker as well.
[ -f "$DISPLAY_SETTINGS_OUT/result.json" ] || status=1
exit "$status"
