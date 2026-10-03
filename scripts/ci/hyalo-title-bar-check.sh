#!/bin/sh
# hyalo-title-bar-check.sh — Hyalo's title bar (#708 point 5, hyalo/compositor/src/render/title_bar.rs):
# the bar Hyalo draws over an app that leaves its decorations to the compositor (kitty, Qt,
# Chrome with "Use system title bar and borders"). Run INSIDE a Hyalo session started with
# HYALO_CONTROL, with `hyalo-title-bar-probe` in PATH, on a floating workspace.
#
#   1. the probe asks for server-side: it gets a 32 px bar on top of its box, and the capsule
#      in it (90×24, the same 4 px from the right as above and below it);
#   2. one piece: the bar's pixel is the colour of the app's top row (light), and its ink is
#      dark on it (the title's darkest pixel);
#   3. the pointer over the bar is Hyalo's: the app gets a leave, and no click;
#   4. dragged by its bar, the window moves; a double click maximizes it, another restores it;
#   5. the app switches to its own frame while it runs (client-side, a shadow margin): the bar
#      goes; maximized like that, Hyalo lays it out in its ring (render/frame.rs) — the ring
#      continues the app's edges (light on top, dark on the sides), its outer corner is cut,
#      and the shadow margin under it is not drawn (the probe's is translucent red); back to
#      server-side, the bar comes back;
#   6. close in the bar's capsule closes it.
# The controls: the same probe against a Hyalo without the title bar has `title_bar` 0 (step 1);
# against one without the ring, `frame` is not 4 (step 5).
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
log=${TITLE_BAR_LOG:-/tmp/hyalo-title-bar}
mkdir -p "$log"
out="$log/probe.log"
pid=""
fail() { echo "FAIL: $*"; cat "$out" 2>/dev/null; win 2>/dev/null; exit 1; }
trap 'kill $pid 2>/dev/null || true' EXIT
win() { $MSG windows | jq -c '.ok.windows[] | select(.app_id == "hyalo-title-bar-probe")'; }
field() { win | jq -r ".$1"; }
pixels() { gjs -m "$here/hyalo-window-look-probe.js" "$@"; }
wait_line() { for _ in $(seq 1 40); do grep -q "$1" "$out" && return 0; sleep 0.25; done; return 1; }
wait_field() { for _ in $(seq 1 20); do [ "$(field "$1")" = "$2" ] && return 0; sleep 0.25; done; return 1; }
# A point in the bar, "x y": `$1` px from the window's left edge, the bar's middle.
in_bar() { win | jq -r --argjson dx "$1" '"\(.x + $dx) \(.y - .title_bar / 2)"'; }
# A point in the capsule: the n-th sixth of its width, its middle.
in_capsule() { win | jq -r --argjson f "$1" '.controls | "\(.[0] + .[2] * $f) \(.[1] + .[3] / 2)"'; }

scale=$($MSG outputs | jq '.ok.outputs[0].scale')
hyalo-title-bar-probe >"$out" 2>&1 &
pid=$!
wait_line '^SHOWN' || fail "the probe never showed its window"
sleep 0.8

# 1. The bar and its capsule.
[ "$(field title_bar)" = 32 ] || fail "no title bar: title_bar = $(field title_bar) (32 expected)"
want=$(win | jq -r '"\(.x + .width - 4 - 90) \(.y - 32 + 4) 90 24"')
got=$(win | jq -r '.controls | map(floor) | join(" ")')
[ "$got" = "$want" ] || fail "the capsule at '$got', '$want' expected (4 px in from the right, above and below)"
echo "ok    a 32 px bar on top of the window, the capsule in it"

# 2. One piece, and dark ink on a light bar.
$MSG screenshot "$log/bar.png" >/dev/null || fail "no screenshot"
set -- $(win | jq -r --argjson s "$scale" '"\((.x + 40) * $s | floor) \((.y - 18) * $s | floor) \((.x + .width / 2 - 70) * $s | floor) \((.y - 30) * $s | floor) \(140 * $s | floor) \(24 * $s | floor)"')
bg=$(pixels pixel "$log/bar.png" "$1" "$2")
set -- $bg $3 $4 $5 $6
for v in "$1" "$2" "$3"; do
    [ "$v" -ge 222 ] && [ "$v" -le 238 ] || fail "the bar is $bg where the app's top row is 230 230 230: not one piece"
done
ink=$(pixels darkest "$log/bar.png" "$4" "$5" "$6" "$7")
[ "$ink" -lt 120 ] || fail "the title's darkest pixel is $ink on a light bar: no dark ink"
echo "ok    the bar takes the app's top colour ($bg), and its title is dark on it ($ink)"

# 3. The pointer over the bar is Hyalo's.
win | jq -r '"move \(.x + 60) \(.y + 150)"' >"$C"; sleep 0.4
grep -q '^POINTER enter' "$out" || fail "the pointer over the window's body never reached the app"
echo "move $(in_bar 60)" >"$C"; sleep 0.4
[ "$(grep '^POINTER' "$out" | tail -n 1)" = "POINTER leave" ] || fail "over the bar, the app still has the pointer"
echo "ok    the pointer reaches the app, and not over its title bar"

# 4. Dragged by the bar; a double click.
set -- $(win | jq -r '"\(.x) \(.y)"'); x0=$1; y0=$2
set -- $(in_bar 60)
echo "press $1 $2 272" >"$C"; sleep 0.2
echo "move $(($1 + 50)) $(($2 + 30))" >"$C"; sleep 0.2
echo "move $(($1 + 100)) $(($2 + 60))" >"$C"; sleep 0.2
echo "release 272" >"$C"; sleep 0.6
set -- $(win | jq -r '"\(.x) \(.y)"')
[ "$1" = $((x0 + 100)) ] && [ "$2" = $((y0 + 60)) ] || fail "dragged by 100,60 from $x0,$y0, the window is at $1,$2"
grep -q '^BUTTON' "$out" && fail "the app got the press on its title bar"
p=$(in_bar 60)
echo "click $p" >"$C"; sleep 0.1; echo "click $p" >"$C"
wait_field fullscreen maximized || fail "a double click on the bar did not maximize: $(field fullscreen)"
[ "$(field title_bar)" = 32 ] || fail "maximized, the bar went"
p=$(in_bar 60)
echo "click $p" >"$C"; sleep 0.1; echo "click $p" >"$C"
wait_field fullscreen none || fail "a second double click did not restore: $(field fullscreen)"
echo "ok    dragged by its bar the window moves, a double click maximizes and restores"

# 5. The app switches its decorations while it runs.
kill -USR1 "$pid"
wait_line '^SWITCHED client' || fail "the probe did not switch"
wait_field title_bar 0 || fail "the app draws its own frame, and the bar is still there"
[ "$(field controls)" = null ] || fail "no bar, yet controls at $(field controls)"
[ "$(field frame)" = 0 ] || fail "floating, its own frame drawn, yet a ring of $(field frame)"
# Maximized with its own frame: Hyalo's ring. The probe draws 400×250 whatever it is told, so
# its box is at the area's corner and what is right of it is the workspace's background.
$MSG do maximize "$(field id)" >/dev/null
wait_field fullscreen maximized || fail "the window did not maximize: $(field fullscreen)"
wait_field frame 4 || fail "maximized with its own frame, no ring: frame = $(field frame) (4 expected)"
[ "$(field look.rounded)" = true ] || fail "in its ring, the window is not rounded"
sleep 0.6
$MSG screenshot "$log/ring.png" >/dev/null || fail "no screenshot"
at() { win | jq -r --argjson s "$scale" --argjson dx "$1" --argjson dy "$2" '"\((.x + $dx) * $s | floor) \((.y + $dy) * $s | floor)"'; }
near() { # near "R G B" V: every channel within 3 of V
    for v in $1; do [ "$v" -ge $(($2 - 3)) ] && [ "$v" -le $(($2 + 3)) ] || return 1; done
}
left=$(pixels pixel "$log/ring.png" $(at -2 150)); top=$(pixels pixel "$log/ring.png" $(at 200 -2))
right=$(pixels pixel "$log/ring.png" $(at 401 150))
near "$left" 48 || fail "the ring left of the dark side is $left, not the app's 48 48 48"
near "$right" 48 || fail "the ring right of the dark side is $right, not the app's 48 48 48"
near "$top" 230 || fail "the ring above the light top is $top, not the app's 230 230 230"
corner=$(pixels pixel "$log/ring.png" $(at -4 -4))
near "$corner" 230 && fail "the ring's outer corner is the app's colour ($corner): not rounded"
margin=$(pixels pixel "$log/ring.png" $(at 408 150)); beyond=$(pixels pixel "$log/ring.png" $(at 440 150))
[ "$margin" = "$beyond" ] || fail "the shadow margin shows beside the ring ($margin, the background is $beyond)"
echo "ok    maximized with its own frame, it sits in Hyalo's ring: edges continued ($left / $top), corner cut, margin hidden"
$MSG do maximize "$(field id)" >/dev/null
wait_field fullscreen none || fail "the window did not restore: $(field fullscreen)"
kill -USR2 "$pid"
wait_line '^SWITCHED server' || fail "the probe did not switch back"
wait_field title_bar 32 || fail "back to server-side, and no bar"
wait_field frame 0 || fail "back to server-side, and still a ring"
echo "ok    the app switched to its own frame and the bar went; back, and it came back"

# 6. Close.
sleep 0.4
echo "click $(in_capsule 0.8333)" >"$C"
wait_line '^CLOSED' || fail "close in the bar did not ask the window to close"
echo "ok    close in the bar asks the window to close"
