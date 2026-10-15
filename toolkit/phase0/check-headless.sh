#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# Same headless cage -> nested Hyalo path as hyalo/scripts/headless-shot.sh,
# with a completion handshake, private bus/runtime/config, and a failing exit code.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
export NK_PHASE0_HARNESS="$here/check-headless.sh"
case "${1:-}" in
    --driver)
        set +e
        python3 "$repo/scripts/ci/${NK_PHASE0_CHECK:-nk-phase0-check.py}" >"$NK_PHASE0_LOG/check.log" 2>&1
        status=$?
        echo "$status" >"$NK_PHASE0_RUN/result"
        exit "$status"
        ;;
    --inner)
        export HYALO_CONTROL="$NK_PHASE0_RUN/control"
        mkfifo "$HYALO_CONTROL"
        export HYALO_CONFIG=/dev/null HYALO_SETTINGS="$NK_PHASE0_RUN/settings.toml"
        "$HYALO_BIN" --winit -c "\"$NK_PHASE0_HARNESS\" --driver" >"$NK_PHASE0_LOG/hyalo.log" 2>&1 &
        hyalo=$!
        trap 'kill "$hyalo" 2>/dev/null || true; wait "$hyalo" 2>/dev/null || true' EXIT
        local_ticks=600
        if [ "${NK_PHASE0_CHECK:-}" = nk-layer-motion-check.py ]; then local_ticks=1800; fi
        if [ "${NK_PHASE0_CHECK:-}" = nk-a11y-check.py ]; then local_ticks=12000; fi
        for _ in $(seq 1 "$local_ticks"); do
            if [ -f "$NK_PHASE0_RUN/result" ]; then exit "$(cat "$NK_PHASE0_RUN/result")"; fi
            kill -0 "$hyalo" || { echo 'Hyalo died'; exit 1; }
            sleep .1
        done
        echo 'Timed out waiting for phase0 checks'; exit 1
        ;;
esac
export HYALO_BIN=${HYALO_BIN:-$repo/hyalo/target/release/nidara-hyalo}
export NK_PHASE0_BIN=${NK_PHASE0_BIN:-$repo/toolkit/target/release/nk-phase0}
export NK_PHASE0_LOG=${NK_PHASE0_LOG:-/tmp/nk-phase0-evidence}
mkdir -p "$NK_PHASE0_LOG"
export NK_PHASE0_RUN
NK_PHASE0_RUN=$(mktemp -d /tmp/nk-phase0-run.XXXXXX)
trap 'rm -rf "$NK_PHASE0_RUN"' EXIT
mkdir "$NK_PHASE0_RUN/runtime"
chmod 700 "$NK_PHASE0_RUN/runtime"
# No autostart, live compositor socket or live D-Bus reaches the test.
status=0
env -u DISPLAY -u WAYLAND_DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE \
    XDG_RUNTIME_DIR="$NK_PHASE0_RUN/runtime" WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 \
    dbus-run-session -- cage -- "$NK_PHASE0_HARNESS" --inner >"$NK_PHASE0_LOG/cage.log" 2>&1 || status=$?
cat "$NK_PHASE0_LOG/check.log" 2>/dev/null || true
exit "$status"
