#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Private bus, settings and headless compositor. No installed session is contacted.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=${OUT:-$repo/target/ipc-policy/headless-$(date +%s-%N)}
mkdir -p "$(dirname "$out")"
mkdir -m 700 "$out"
out=$(realpath "$out")
runtime=$(mktemp -d /tmp/nidara-ipc-XXXXXX)
trap 'rm -rf "$runtime"' EXIT
mkdir -m 700 "$out/home" "$out/config" "$out/data" "$out/cache" "$out/state" "$out/schemas"
cp "$repo/config/gsettings/org.nidara.gschema.xml" "$out/schemas/"
glib-compile-schemas "$out/schemas"
export IPC_POLICY_BIN=${HYALO_BIN:-$repo/hyalo/target/debug/nidara-hyalo}
export IPC_POLICY_REPO="$repo" IPC_POLICY_OUT="$out"
cat > "$out/inner.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
export HYALO_CONFIG=/dev/null HYALO_SETTINGS="$IPC_POLICY_OUT/config/hyalo-settings.toml"
export DISPLAY1_PROFILES="$IPC_POLICY_OUT/config/hyalo-display-profiles.json"
"$IPC_POLICY_BIN" --winit >"$IPC_POLICY_OUT/hyalo.log" 2>&1 &
pid=$!
trap 'kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true' EXIT
python3 "$IPC_POLICY_REPO/scripts/dev/ipc-policy-check.py" >"$IPC_POLICY_OUT/check.log" 2>&1
INNER
chmod +x "$out/inner.sh"
env -u DISPLAY -u WAYLAND_DISPLAY -u HYALO_SOCKET -u HYALO_CONTROL -u HYPRLAND_INSTANCE_SIGNATURE \
    HOME="$out/home" XDG_RUNTIME_DIR="$runtime" XDG_CONFIG_HOME="$out/config" \
    XDG_DATA_HOME="$out/data" XDG_CACHE_HOME="$out/cache" XDG_STATE_HOME="$out/state" \
    GSETTINGS_BACKEND=keyfile GSETTINGS_SCHEMA_DIR="$out/schemas" \
    DBUS_SYSTEM_BUS_ADDRESS="unix:path=$out/no-system-bus" \
    WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 LIBGL_ALWAYS_SOFTWARE=1 \
    dbus-run-session -- cage -d -- "$out/inner.sh" >"$out/cage.log" 2>&1
cat "$out/check.log"
printf 'Evidence: %s\n' "$out"
