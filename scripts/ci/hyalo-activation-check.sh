#!/bin/sh
# hyalo-activation-check.sh — xdg-activation on Hyalo (hyalo/compositor/src/activation.rs),
# end to end with real clicks. Run INSIDE a Hyalo session (the Hyalo smoke does; locally, as
# the client of a nested Hyalo — never against a live desktop: it clicks).
#
#   1. honoured: the user clicks act-1, and its app raises its other window act-2 → act-2 has
#      the focus (a token from what the user just did);
#   2. refused (the control): the user goes to workspace 2 and clicks act-q, another app, and
#      the first app raises act-1 → act-q keeps the focus and the user stays on workspace 2 (an
#      app the user is not in does not take the front, nor pull them to its workspace).
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
cmd=$(mktemp)
log=${ACTIVATION_LOG:-/tmp/hyalo-activation.log}
fail() { echo "FAIL: $*"; $MSG windows | jq -c '.ok.windows[] | {title, focused, x, y, width, height}'; exit 1; }

win() { $MSG windows | jq -r --arg t "$1" ".ok.windows[] | select(.title == \$t) | $2"; }
focused() { $MSG windows | jq -r '.ok.windows[] | select(.focused) | .title'; }
wait_for() {
    for _ in $(seq 1 40); do [ -n "$(win "$1" .id)" ] && [ "$(win "$1" .width)" -gt 0 ] && return 0; sleep 0.25; done
    fail "window $1 never appeared"
}
# The layout's size, for nidara-input's absolute coordinates (as the smoke's computer-use step).
read_size() { "$here/../../bin/nidara-wm" monitors | jq -r '.[0] | "\(.width / .scale | floor) \(.height / .scale | floor)"'; }

gjs -m "$here/hyalo-activation-probe.js" app "$cmd" >"$log" 2>&1 &
app=$!
wait_for act-1; wait_for act-2
gjs -m "$here/hyalo-activation-probe.js" other >>"$log" 2>&1 &
other=$!
wait_for act-q
# Out of the way, so every click lands on the window it is meant for.
$MSG do move-to-workspace-silent 2 "$(win act-q .id)" >/dev/null
trap 'kill $app $other 2>/dev/null; rm -f "$cmd"' EXIT
set -- $(read_size); W=$1; H=$2

click() { nidara-input click "$1" "$2" "$W" "$H"; sleep 0.6; }

# 1. A point of act-1 that act-2 (centred inside it) does not cover: its top-left corner, just
#    under its header.
x=$(( $(win act-1 .x) + 20 )); y=$(( $(win act-1 .y) + 60 ))
click "$x" "$y"
[ "$(focused)" = "act-1" ] || fail "a click on act-1 did not focus it (on $(focused))"
echo "present act-2" >>"$cmd"; sleep 1
[ "$(focused)" = "act-2" ] || fail "honoured: the app the user is in could not raise its other window (on $(focused))"
echo "ok    honoured: the app the user clicked raised its other window"

# 2. On workspace 2, alone.
$MSG do workspace 2 >/dev/null; sleep 0.4
x=$(( $(win act-q .x) + $(win act-q .width) / 2 )); y=$(( $(win act-q .y) + $(win act-q .height) / 2 ))
click "$x" "$y"
[ "$(focused)" = "act-q" ] || fail "a click on act-q did not focus it (on $(focused))"
echo "present act-1" >>"$cmd"; sleep 1
[ "$(focused)" = "act-q" ] || fail "refused: an app the user is not in took the focus (on $(focused))"
[ "$($MSG workspaces | jq -r '.ok.workspaces[] | select(.focused) | .id')" = "2" ] || fail "refused: the user was pulled off workspace 2"
echo "ok    refused: an app in the background could not take the front"
