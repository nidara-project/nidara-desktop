#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# No system install, live-session socket or CI changes. OUT must be a new directory.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
out=${OUT:-$repo/target/display1/headless-$(date +%s-%N)}
mkdir -p "$(dirname "$out")"
mkdir -m 700 "$out"
out=$(realpath "$out")
runtime=$(mktemp -d /tmp/nd-display1-XXXXXX)
trap 'rm -rf "$runtime"' EXIT
mkdir -m 700 "$out/config"
export DISPLAY1_OUT="$out" DISPLAY1_REPO="$repo"
export DISPLAY1_BIN=${HYALO_BIN:-$repo/hyalo/target/debug/nidara-hyalo}
cat > "$out/inner.sh" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
export HYALO_CONFIG=/dev/null HYALO_SETTINGS="$DISPLAY1_OUT/config/hyalo-settings.toml"
export DISPLAY1_PROFILES="$DISPLAY1_OUT/config/hyalo-display-profiles.json"
"$DISPLAY1_BIN" --winit >"$DISPLAY1_OUT/hyalo.log" 2>&1 &
hyalo_pid=$!
trap 'kill "$hyalo_pid" 2>/dev/null || true; wait "$hyalo_pid" 2>/dev/null || true' EXIT
python3 "$DISPLAY1_REPO/scripts/dev/display1-check.py" >"$DISPLAY1_OUT/check.log" 2>&1
kill "$hyalo_pid"
wait "$hyalo_pid" 2>/dev/null || true
"$DISPLAY1_BIN" --winit >"$DISPLAY1_OUT/restart.log" 2>&1 &
hyalo_pid=$!
python3 "$DISPLAY1_REPO/scripts/dev/display1-check.py" --restart >>"$DISPLAY1_OUT/check.log" 2>&1
INNER
chmod +x "$out/inner.sh"
env -u DISPLAY XDG_RUNTIME_DIR="$runtime" XDG_CONFIG_HOME="$out/config" \
    WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 LIBGL_ALWAYS_SOFTWARE=1 \
    dbus-run-session -- cage -d -- "$out/inner.sh" >"$out/cage.log" 2>&1
cat "$out/check.log"
