#!/bin/bash
# SPDX-License-Identifier: LGPL-3.0-or-later
# A private headless cage -> nested Hyalo, with no live bus, socket or settings.
# This local path supplies a portal fixture. CI uses the installed real portal.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
case "${1:-}" in
    --driver)
        set +e
        python "$repo/scripts/ci/${NK_WIDGETS_CHECK:-nk-widgets-check.py}" > "$NK_WIDGETS_LOG/check.log" 2>&1
        rc=$?
        echo "$rc" > "$NK_WIDGETS_RUN/result"
        exit "$rc"
        ;;
    --inner)
        export HYALO_CONTROL="$NK_WIDGETS_RUN/control"
        mkfifo "$HYALO_CONTROL"
        export HYALO_CONFIG=/dev/null HYALO_SETTINGS="$NK_WIDGETS_RUN/settings.toml" HYALO_A11Y_MANAGER=1
        "$HYALO_BIN" --winit -c "'$repo/toolkit/widgets-demo/check-headless.sh' --driver" > "$NK_WIDGETS_LOG/hyalo.log" 2>&1 &
        compositor=$!
        trap 'kill "$compositor" 2>/dev/null || true; wait "$compositor" 2>/dev/null || true' EXIT
        for _ in $(seq 1 12000); do
            if [ -f "$NK_WIDGETS_RUN/result" ]; then exit "$(cat "$NK_WIDGETS_RUN/result")"; fi
            kill -0 "$compositor" || { echo 'Hyalo exited'; exit 1; }
            sleep .1
        done
        echo 'Timeout waiting for widget checks'; exit 1
        ;;
esac
export HYALO_BIN=${HYALO_BIN:-$repo/hyalo/target/release/nidara-hyalo}
export NK_WIDGETS_BIN=${NK_WIDGETS_BIN:-$repo/toolkit/target/debug/nk-widgets-demo}
export NK_WIDGETS_LOG=${NK_WIDGETS_LOG:-$repo/toolkit/target/widgets-evidence}
export NK_SETTINGS_DATA=${NK_SETTINGS_DATA:-$repo/build/settings-data}
mkdir -p "$NK_WIDGETS_LOG" "$HOME/Nidara/ChatGPT"
export NK_WIDGETS_RUN
NK_WIDGETS_RUN=$(mktemp -d "$HOME/Nidara/ChatGPT/nkw.XXXXXX")
trap 'rm -rf "$NK_WIDGETS_RUN"' EXIT
mkdir "$NK_WIDGETS_RUN/runtime" "$NK_WIDGETS_RUN/config" "$NK_WIDGETS_RUN/data" "$NK_WIDGETS_RUN/cache" "$NK_WIDGETS_RUN/state"
chmod 700 "$NK_WIDGETS_RUN/runtime"
# Supplying the existing phase-0 checker is useful for compatibility validation;
# even its runtime and logs then live on disk. No phase-0 source is rewritten.
export NK_PHASE0_RUN="$NK_WIDGETS_RUN" NK_PHASE0_LOG="$NK_WIDGETS_LOG"
cat > "$NK_WIDGETS_RUN/bus.conf" <<BUS
<busconfig><type>session</type><listen>unix:dir=$NK_WIDGETS_RUN/runtime</listen>
<auth>EXTERNAL</auth><standard_session_servicedirs/>
<policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy>
</busconfig>
BUS
status=0
env -u DISPLAY -u WAYLAND_DISPLAY -u HYALO_SOCKET -u HYPRLAND_INSTANCE_SIGNATURE -u DBUS_SESSION_BUS_ADDRESS \
    XDG_RUNTIME_DIR="$NK_WIDGETS_RUN/runtime" XDG_CONFIG_HOME="$NK_WIDGETS_RUN/config" \
    XDG_DATA_HOME="$NK_WIDGETS_RUN/data" XDG_CACHE_HOME="$NK_WIDGETS_RUN/cache" XDG_STATE_HOME="$NK_WIDGETS_RUN/state" \
    GSETTINGS_BACKEND=keyfile WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 \
    dbus-run-session --config-file "$NK_WIDGETS_RUN/bus.conf" -- python "$repo/toolkit/widgets-demo/portal-fixture.py" -- \
        cage -- "$repo/toolkit/widgets-demo/check-headless.sh" --inner > "$NK_WIDGETS_LOG/cage.log" 2>&1 || status=$?
cat "$NK_WIDGETS_LOG/check.log" 2>/dev/null || true
exit "$status"
