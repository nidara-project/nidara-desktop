#!/bin/sh
# hyalo-window-look-check.sh — how Hyalo draws a window (hyalo/compositor/src/render/window.rs):
# its corners rounded, and a blur behind it when it is translucent (#708 point 1). Run INSIDE a
# Hyalo session (the Hyalo smoke; locally, a nested Hyalo with a settings layer: HYALO_SETTINGS).
#
#   1. an opaque window is rounded, not blurred behind; a translucent one is both (`look`);
#   2. the opaque window's corner shows what is behind it, not the window — and a pixel just
#      inside still shows the window (the cut is the corner's, not a border);
#   3. under the translucent window the stripes behind it are blurred: their spread falls to a
#      fraction of the stripes' own;
#   4. Settings' switch (`windows.backdrop.enabled = false`, the settings layer) takes the blur
#      away: the stripes under the glass are sharp again; and back on;
#   5. the line and the shadow (render/decor.rs), against the same scene with both switched off:
#      the pixel just right of the glass window is the line's, the one below it darker (the
#      shadow), and one inside it, at its bottom edge, unchanged — a translucent window shows
#      its backdrop, never a shadow under itself.
# Controls seen failing: a Hyalo without them (the settings layer refuses `border`), and one that
# draws them BEHIND the backdrop ("the shadow reaches inside the translucent window").
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
log=${LOOK_LOG:-/tmp/hyalo-window-look}
mkdir -p "$log"
fail() { echo "FAIL: $*"; tail -n 20 "$log"/*.log 2>/dev/null; exit 1; }
probe() { gjs -m "$here/hyalo-window-look-probe.js" "$@"; }
pids=""
trap 'kill $pids 2>/dev/null || true; $MSG settings "{\"windows\":null}" >/dev/null 2>&1 || true' EXIT

# A window's box in the screenshot's pixels: "x y w h".
box() {
    $MSG windows | jq -r --arg t "$1" --argjson s "$scale" \
        '.ok.windows[] | select(.title == $t and .width > 0) | "\(.x * $s | floor) \(.y * $s | floor) \(.width * $s | floor) \(.height * $s | floor)"'
}
look() { $MSG windows | jq -c --arg t "$1" '.ok.windows[] | select(.title == $t) | .look'; }
wait_for() {
    for _ in $(seq 1 40); do [ -n "$(box "$1")" ] && return 0; sleep 0.25; done
    fail "the window $1 never appeared"
}
# "R G B" → red | green | other
colour() { set -- $1; if [ "$1" -gt 150 ] && [ "$2" -lt 90 ]; then echo red; elif [ "$2" -gt 150 ] && [ "$1" -lt 90 ]; then echo green; else echo "other($*)"; fi; }

scale=$($MSG outputs | jq '.ok.outputs[0].scale')
$MSG do workspace 1 >/dev/null
probe stripes >"$log/stripes.log" 2>&1 &
pids="$pids $!"
wait_for look-stripes
probe glass >"$log/glass.log" 2>&1 &
pids="$pids $!"
wait_for look-glass
sleep 1

# 1. What Hyalo says of them.
[ "$(look look-stripes)" = '{"rounded":true,"backdrop":false}' ] || fail "the opaque window: $(look look-stripes) (rounded, no backdrop expected)"
[ "$(look look-glass)" = '{"rounded":true,"backdrop":true}' ] || fail "the translucent window: $(look look-glass) (rounded and blurred behind expected)"
echo "ok    look: the opaque window is rounded, the translucent one rounded and blurred behind"

set -- $(box look-stripes); sx=$1; sy=$2; sw=$3; sh=$4
set -- $(box look-glass); gx=$1; gy=$2; gw=$3; gh=$4
# The two are centred: the stripes show to the left of the glass.
[ "$gx" -gt $((sx + 60)) ] || fail "the glass does not leave stripes beside it (stripes $sx, glass $gx)"

$MSG screenshot "$log/on.png" >/dev/null || fail "no screenshot"

# 2. The corner.
corner=$(colour "$(probe pixel "$log/on.png" $((sx + 1)) $((sy + 1)))")
inside=$(colour "$(probe pixel "$log/on.png" $((sx + 30)) $((sy + 30)))")
case "$corner" in red|green) fail "the opaque window's corner is not cut: its pixel 1,1 is $corner";; esac
case "$inside" in red|green) ;; *) fail "the cut reaches inside the window: its pixel 30,30 is $inside";; esac
echo "ok    corners: the window's pixel 1,1 is what lies behind it ($corner), 30,30 the window ($inside)"

# 3. The blur under the glass.
stripes=$(probe spread "$log/on.png" $((sx + 10)) $((sy + 40)) 40 $((sh - 80)))
under=$(probe spread "$log/on.png" $((gx + 40)) $((gy + 40)) $((gw - 80)) $((gh - 80)))
awk -v a="$under" -v b="$stripes" 'BEGIN { exit !(a < b / 4) }' \
    || fail "the stripes under the glass are not blurred: spread $under against $stripes beside it"
echo "ok    backdrop: the stripes' spread under the glass is $under, beside it $stripes"

# 4. Settings' switch.
$MSG settings '{"windows":{"backdrop":{"enabled":false}}}' >/dev/null || fail "the settings layer refused the switch"
sleep 0.5
[ "$(look look-glass)" = '{"rounded":true,"backdrop":false}' ] || fail "switched off, the translucent window still says $(look look-glass)"
$MSG screenshot "$log/off.png" >/dev/null
sharp=$(probe spread "$log/off.png" $((gx + 40)) $((gy + 40)) $((gw - 80)) $((gh - 80)))
awk -v a="$sharp" -v b="$stripes" 'BEGIN { exit !(a > b / 2) }' \
    || fail "switched off, the stripes under the glass are still blurred: spread $sharp against $stripes"
$MSG settings '{"windows":null}' >/dev/null
sleep 0.5
[ "$(look look-glass)" = '{"rounded":true,"backdrop":true}' ] || fail "switched back on, the translucent window says $(look look-glass)"
echo "ok    the switch: off, the stripes under the glass are sharp again (spread $sharp); back on"

# 5. The line and the shadow, against both off.
rgb_sum() { set -- $1; echo $(($1 + $2 + $3)); }
$MSG screenshot "$log/decor-on.png" >/dev/null
$MSG settings '{"windows":{"border":{"width":0},"shadow":{"enabled":false}}}' >/dev/null || fail "the settings layer refused the line and the shadow"
sleep 0.5
$MSG screenshot "$log/decor-off.png" >/dev/null
$MSG settings '{"windows":null}' >/dev/null
line_on=$(probe pixel "$log/decor-on.png" $((gx + gw)) $((gy + gh / 2))); line_off=$(probe pixel "$log/decor-off.png" $((gx + gw)) $((gy + gh / 2)))
[ "$line_on" != "$line_off" ] || fail "no line: the pixel right of the window is $line_on with it and without"
below_on=$(rgb_sum "$(probe pixel "$log/decor-on.png" $((gx + gw / 2)) $((gy + gh + 6)))")
below_off=$(rgb_sum "$(probe pixel "$log/decor-off.png" $((gx + gw / 2)) $((gy + gh + 6)))")
[ "$below_on" -lt $((below_off - 6)) ] || fail "no shadow: 6 px below the window the pixel sums $below_on with it, $below_off without"
in_on=$(probe pixel "$log/decor-on.png" $((gx + gw / 2)) $((gy + gh - 3))); in_off=$(probe pixel "$log/decor-off.png" $((gx + gw / 2)) $((gy + gh - 3)))
[ "$in_on" = "$in_off" ] || fail "the shadow reaches inside the translucent window: $in_on with it, $in_off without"
echo "ok    the line ($line_on, $line_off without) and the shadow ($below_on below, $below_off without), nothing inside"
