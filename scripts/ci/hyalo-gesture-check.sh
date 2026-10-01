#!/bin/sh
# hyalo-gesture-check.sh — touchpad gestures reach applications on Hyalo (pointer-gestures-v1):
# a two-finger pinch over a GTK window must drive its zoom gesture. Run INSIDE a Hyalo session
# started with HYALO_CONTROL (the Hyalo smoke; locally, a nested Hyalo). Without the global the
# seat still sees the pinch and GTK hears nothing — what this check catches.
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
log=${GESTURE_LOG:-/tmp/hyalo-gesture.log}
win() { $MSG windows | jq -r ".ok.windows[] | select(.title == \"gesture-probe\") | $1"; }

gjs -m "$here/hyalo-gesture-probe.js" >"$log" 2>&1 &
probe=$!
trap 'kill $probe 2>/dev/null' EXIT
for _ in $(seq 1 40); do [ "$(win .width)" -gt 0 ] 2>/dev/null && break; sleep 0.25; done
[ "$(win .width)" -gt 0 ] 2>/dev/null || { echo "FAIL: the probe's window never appeared"; exit 1; }
x=$(( $(win .x) + $(win .width) / 2 )); y=$(( $(win .y) + $(win .height) / 2 ))
echo "pinch $x $y 2.0" >"$C"
sleep 1
last=$(sed -n 's/^ZOOM //p' "$log" | tail -1)
[ -n "$last" ] || { echo "FAIL: a pinch over the window never reached it"; cat "$log"; exit 1; }
awk -v s="$last" 'BEGIN { exit !(s >= 1.9 && s <= 2.1) }' \
    || { echo "FAIL: the pinch reached the window as ${last}×, not 2×"; exit 1; }
echo "ok    a pinch to 2× reached the window as ${last}×"
