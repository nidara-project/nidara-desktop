#!/usr/bin/env bash
# Real D-Bus transport on a private bus with fixtures; no desktop or dconf access.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d /tmp/nidara-catalog-probe.XXXXXX)
trap 'rm -rf "$work"' EXIT
if [ -n "${CATALOG_PROBE_JS:-}" ]; then
    cp "$CATALOG_PROBE_JS" "$work/probe.js"
else
    "$repo/scripts/bundle.sh" --js "$repo/scripts/dev/widget-catalog-ipc-probe.ts" "$work/probe.js"
fi
# Positive control: remove the real fixed-widget refusal from the bundled code.
if [ "${CONTROL:-0}" = 1 ]; then
    node - "$work/probe.js" <<'JS'
const fs = require("fs"), file = process.argv[2], src = fs.readFileSync(file, "utf8")
const rule = "if (!on && entry.ccFixed)"
if (src.split(rule).length !== 2) throw Error("Control rule missing or ambiguous")
fs.writeFileSync(file, src.replace(rule, "if (false)"))
JS
fi
export GIO_USE_VFS=local
dbus-run-session -- bash -c '
set -euo pipefail
work=$1
server=""; client=""
cleanup() { [ -z "$server" ] || kill "$server" 2>/dev/null || true; [ -z "$client" ] || kill "$client" 2>/dev/null || true; }
trap cleanup EXIT
# Hard deadline: a hung probe fails rather than leaving an orphaned private bus.
timeout 20s gjs -m "$work/probe.js" server first & server=$!
NIDARA_SETTINGS_PROCESS=1 timeout 20s gjs -m "$work/probe.js" client & client=$!
wait -n -p ended "$server" "$client"
[ "$ended" = "$server" ] || { echo "Client ended before restart" >&2; exit 1; }
server=""
sleep 0.6
timeout 20s gjs -m "$work/probe.js" server second & server=$!
wait "$client"; client=""
wait "$server"; server=""
' bash "$work"
