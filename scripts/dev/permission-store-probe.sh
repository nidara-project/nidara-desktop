#!/usr/bin/env bash
# permission-store-probe.sh — core/PermissionStore.ts against a real, PRIVATE permission store.
# Private bus with its env on the daemon line, private XDG_DATA_HOME (the store's files),
# dconf canary. Short runtime dir on purpose: socket paths are capped at 108 bytes.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d /tmp/nps.XXXX)"; trap 'rm -rf "$work"' EXIT
mkdir -p "$work/rt" "$work/cfg" "$work/data"; chmod 700 "$work/rt"
"$repo/scripts/bundle.sh" --js "$repo/scripts/dev/permission-store-probe.ts" "$work/probe.js" >/dev/null 2>&1
env -u DBUS_SESSION_BUS_ADDRESS -u WAYLAND_DISPLAY -u DISPLAY \
  XDG_RUNTIME_DIR="$work/rt" XDG_CONFIG_HOME="$work/cfg" XDG_DATA_HOME="$work/data" GIO_USE_VFS=local work="$work" \
  dbus-run-session -- bash -c '
dconf write /org/nidara/probe/canary true; sleep 0.3
[ -s "$work/cfg/dconf/user" ] || { echo "ABORT dconf canary"; exit 1; }
gjs -m "$work/probe.js"
rc=$?
echo "store files: $(ls "$work/data/flatpak/db" 2>/dev/null | tr "\n" " ")"
exit $rc'
