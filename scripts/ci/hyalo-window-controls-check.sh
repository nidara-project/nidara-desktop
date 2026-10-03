#!/bin/sh
# hyalo-window-controls-check.sh — a window's controls are Hyalo's (#708 point 5,
# hyalo/compositor/src/protocols/window_controls.rs): the app leaves room for them, Hyalo draws
# them there and takes their clicks. Run INSIDE a Hyalo session started with HYALO_CONTROL, with
# `hyalo-window-controls-probe` in PATH.
#
#   1. the probe is told the box (90×24) and the side (right), and Hyalo reports the controls
#      where the probe placed them;
#   2. the pointer over the window reaches the app, over its controls it does not (the app
#      gets a leave);
#   3. maximize maximizes; minimize does nothing yet (#724): the window stays, unmaximized by
#      nothing;
#   4. the side switched to left in the settings layer: the probe is told, places the box on
#      the left, and Hyalo reports it there; then back to the right;
#   5. close closes: the probe gets xdg_toplevel.close.
# The control: the same probe against a Hyalo without the protocol prints NO_CONTROLS (step 1).
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
log=${CONTROLS_LOG:-/tmp/hyalo-window-controls}
mkdir -p "$log"
out="$log/probe.log"
fail() { echo "FAIL: $*"; cat "$out" 2>/dev/null; $MSG windows | jq -c '.ok.windows[] | select(.app_id == "hyalo-window-controls-probe")' 2>/dev/null; exit 1; }
pids=""
trap 'kill $pids 2>/dev/null || true; $MSG settings "{\"windows\":null}" >/dev/null 2>&1 || true' EXIT
win() { $MSG windows | jq -c '.ok.windows[] | select(.app_id == "hyalo-window-controls-probe")'; }
# A point in the controls: the n-th sixth of their width, their middle.
at() { win | jq -r --argjson f "$1" '.controls | "\(.[0] + .[2] * $f) \(.[1] + .[3] / 2)"'; }
wait_line() { for _ in $(seq 1 40); do grep -q "$1" "$out" && return 0; sleep 0.25; done; return 1; }

hyalo-window-controls-probe >"$out" 2>&1 &
pids="$pids $!"
wait_line '^PLACED' || fail "the probe never placed its box"
sleep 0.5

# 1. The box and the side; the controls where the probe put them.
grep -q '^LAYOUT right 90 24$' "$out" || fail "the first layout is not 'right 90 24'"
w=$(win)
[ -n "$w" ] || fail "the probe's window is not listed"
want=$(echo "$w" | jq -r '"\(.x + 400 - 12 - 90) \(.y + 12) 90 24"')
got=$(echo "$w" | jq -r '.controls | map(floor) | join(" ")')
[ "$got" = "$want" ] || fail "controls at '$got', the probe placed them at '$want'"
echo "ok    the box (90×24, right) is told, and the controls are where the app placed them"

# 2. The pointer: the app's over its body, Hyalo's over the controls.
echo "$w" | jq -r '"move \(.x + 40) \(.y + 150)"' >"$C"; sleep 0.4
grep -q '^POINTER enter' "$out" || fail "the pointer over the window's body never reached the app"
echo "move $(at 0.8333)" >"$C"; sleep 0.4
[ "$(grep '^POINTER' "$out" | tail -n 1)" = "POINTER leave" ] || fail "over the controls, the app still has the pointer"
echo "ok    the pointer reaches the app, and not over its controls"

# 3. Maximize; minimize, nothing.
echo "click $(at 0.5)" >"$C"; sleep 0.8
[ "$(win | jq -r .fullscreen)" = "maximized" ] || fail "maximize did not maximize: $(win | jq -c '{fullscreen}')"
grep -q '^BUTTON' "$out" && fail "the app got a click meant for the controls"
echo "click $(at 0.5)" >"$C"; sleep 0.8
[ "$(win | jq -r .fullscreen)" = "none" ] || fail "maximize again did not restore"
echo "click $(at 0.1667)" >"$C"; sleep 0.8
[ -n "$(win)" ] && ! grep -q '^CLOSED' "$out" || fail "minimize did something"
echo "ok    maximize maximizes and restores; minimize does nothing yet (#724); the app saw no click"

# 4. The left side, live, and back.
$MSG settings '{"windows":{"controls":{"side":"left"}}}' >/dev/null
for _ in $(seq 1 20); do grep -q '^LAYOUT left' "$out" && break; sleep 0.25; done
grep -q '^LAYOUT left 90 24$' "$out" || fail "the side changed and the app was not told"
sleep 0.5
w=$(win)
want=$(echo "$w" | jq -r '"\(.x + 12) \(.y + 12)"')
got=$(echo "$w" | jq -r '.controls[0:2] | map(floor) | join(" ")')
[ "$got" = "$want" ] || fail "on the left, controls at '$got', placed at '$want'"
$MSG settings '{"windows":null}' >/dev/null
for _ in $(seq 1 20); do [ "$(grep -c '^LAYOUT right' "$out")" -ge 2 ] && break; sleep 0.25; done
[ "$(grep -c '^LAYOUT right' "$out")" -ge 2 ] || fail "back to the right, the app was not told"
sleep 0.5
echo "ok    the side switched live: the app is told, and the controls follow"

# 5. Close.
echo "click $(at 0.8333)" >"$C"
wait_line '^CLOSED' || fail "close did not ask the window to close"
echo "ok    close asks the window to close"
