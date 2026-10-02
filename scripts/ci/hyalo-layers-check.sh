#!/bin/sh
# hyalo-layers-check.sh — where Hyalo places the shell's bar and dock (`arrange_output`,
# hyalo/compositor/src/shell/layer.rs). Both cover the output and each reserves its strip; each
# must be placed against the WHOLE output whatever the order they were mapped in — the rule the
# shell is written for (Bar.tsx → "Top zone reservation"). For a dock at the bottom, the left and
# the right, mapped before and after the bar: both at 0,0 and the output's full size.
#
# Smithay's own rule placed each reserving surface inside what those mapped before it left: a
# side dock mapped first pushed the bar 80 px in (left) or cut it 80 px short (right), and a dock
# mapped after the bar — as an unlock shows them — went under its strip and off the screen
# (owner-caught 2026-10-02). Seen to fail against the Hyalo before the fix, both ways.
#
# Run INSIDE a Hyalo session (the Hyalo smoke; locally, a nested Hyalo). Exits 1 on failure. MSG
# overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
log=${LAYERS_LOG:-/tmp/hyalo-layers.log}
preload=$(ls /usr/lib/libgtk4-layer-shell.so* 2>/dev/null | head -1)
fail() { echo "FAIL: $*"; tail -n 20 "$log"; exit 1; }
probe=""
trap 'kill $probe 2>/dev/null || true' EXIT
placed() { $MSG layers | jq -c '[.ok.layers[] | select(.namespace | startswith("probe-")) | {namespace, x, y, width, height}] | sort_by(.namespace)'; }
size=$($MSG outputs | jq -c '.ok.outputs[0].logical_size')

for side in bottom left right; do
    for order in dock-first bar-first; do
        LD_PRELOAD="$preload" gjs -m "$here/hyalo-layers-probe.js" "$side" "$order" >>"$log" 2>&1 &
        probe=$!
        got=""
        for _ in $(seq 1 40); do
            got=$(placed)
            [ "$(echo "$got" | jq length)" = 2 ] && break
            sleep 0.25
        done
        sleep 0.5
        got=$(placed)
        echo "$got" | jq -e --argjson s "$size" 'length == 2 and all(.x == 0 and .y == 0 and .width == $s[0] and .height == $s[1])' >/dev/null \
            || fail "dock at the $side, $order: not both placed against the whole output ($size): $got"
        kill $probe; wait $probe 2>/dev/null || true
        for _ in $(seq 1 20); do [ "$(placed | jq length)" = 0 ] && break; sleep 0.1; done
        echo "ok    dock at the $side, $order: bar and dock both over the whole output"
    done
done
