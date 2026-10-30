#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Real Config1 + Hyalo, private bus/keyfile settings/runtime and headless cage.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=${OUT:-$repo/target/shell-ipc/headless-$(date +%s-%N)}
mkdir -p "$out"
out=$(realpath "$out")
rt=$(mktemp -d /tmp/nidara-shell-ipc-XXXXXX)
trap 'rm -rf "$rt"' EXIT
mkdir -m 700 "$out/home" "$out/config" "$out/data" "$out/cache" "$out/state" "$out/schemas"
cp "$repo/config/gsettings/org.nidara.gschema.xml" "$out/schemas/"
glib-compile-schemas "$out/schemas"
export SHELL_IPC_OUT="$out" SHELL_IPC_REPO="$repo"
export SHELL_IPC_BIN=${NIDARA_IPC_BIN:-$repo/session/target/debug/nidara-ipc}
export SHELL_IPC_HYALO=${HYALO_BIN:-$repo/hyalo/target/debug/nidara-hyalo}
export SHELL_IPC_DAEMON=${SESSIOND_BIN:-$repo/session/target/debug/nidara-sessiond}
cat > "$out/inner.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
export HYALO_CONFIG=/dev/null HYALO_SETTINGS="$SHELL_IPC_OUT/config/hyalo-settings.toml"
export DISPLAY1_PROFILES="$SHELL_IPC_OUT/config/hyalo-display-profiles.json"
"$SHELL_IPC_HYALO" --winit >"$SHELL_IPC_OUT/hyalo.log" 2>&1 &
hyalo_pid=$!
"$SHELL_IPC_DAEMON" --config >"$SHELL_IPC_OUT/sessiond.log" 2>&1 &
daemon_pid=$!
trap 'kill "$daemon_pid" "$hyalo_pid" 2>/dev/null || true; wait "$daemon_pid" "$hyalo_pid" 2>/dev/null || true' EXIT
python3 "$SHELL_IPC_REPO/scripts/dev/shell-ipc-check.py" >"$SHELL_IPC_OUT/check.log" 2>&1
INNER
chmod +x "$out/inner.sh"
env -u DISPLAY -u WAYLAND_DISPLAY -u HYALO_SOCKET -u HYPRLAND_INSTANCE_SIGNATURE \
    HOME="$out/home" XDG_RUNTIME_DIR="$rt" XDG_CONFIG_HOME="$out/config" \
    XDG_DATA_HOME="$out/data" XDG_CACHE_HOME="$out/cache" XDG_STATE_HOME="$out/state" \
    GSETTINGS_BACKEND=keyfile GSETTINGS_SCHEMA_DIR="$out/schemas" NIDARA_SESSION=rust \
    DBUS_SYSTEM_BUS_ADDRESS="unix:path=$out/no-system-bus" \
    WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 LIBGL_ALWAYS_SOFTWARE=1 \
    dbus-run-session -- cage -d -- "$out/inner.sh" >"$out/cage.log" 2>&1
cat "$out/check.log"
printf 'Evidence: %s\n' "$out"
