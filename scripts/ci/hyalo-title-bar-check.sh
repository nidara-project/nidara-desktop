#!/bin/sh
# hyalo-title-bar-check.sh — Hyalo's title bar (#708 point 5, hyalo/compositor/src/render/title_bar.rs):
# the bar Hyalo draws over an app that leaves its decorations to the compositor (kitty, Qt,
# Chrome with "Use system title bar and borders"). Run INSIDE a Hyalo session started with
# HYALO_CONTROL, with `hyalo-title-bar-probe` in PATH, on a floating workspace.
#
#   1. the probe asks for server-side: it gets a 48 px bar on top of its box, and the capsule
#      in it (90×32 — minimize, maximize and close — the same 8 px from the right as above and
#      below it);
#   2. one piece: the bar's pixel is the colour of the app's top row (light), and its ink is
#      dark on it (the title's darkest pixel) — also for an app that draws into a subsurface
#      over a transparent toplevel, as Firefox does;
#   3. the pointer over the bar is Hyalo's: the app gets a leave, and no click;
#   4. dragged by its bar, the window moves; a double click maximizes it, another restores it;
#   5. the app switches to its own frame while it runs (client-side, a shadow margin, its own
#      corners cut round, smaller than the window's): the bar goes, and Hyalo cuts it to its box
#      (render/window.rs `push`) — its edges are the app's to the last pixel, nothing is drawn
#      beside them (the probe's shadow margin is translucent red), and its corners are cut to the
#      window's, past the app's own; its own maximize button (the probe's SIGHUP) maximizes it —
#      with no bar of Hyalo's over its own frame — and restores it to the box it had, though it
#      commits a frame for the other state before it acks each change, as Chrome's web apps and
#      Telegram do; its menu (an xdg_popup, placed against its window geometry, which starts
#      inside its surface as Firefox's does) is drawn where a click reaches it; back to
#      server-side, the bar comes back;
#   6. close in the bar's capsule closes it.
# The controls: the same probe against a Hyalo without the title bar has `title_bar` 0 (step 1);
# against one that does not cut a client-side frame to its box, the red margin shows beside it,
# and its corner is the app's colour (step 5); against one that refuses a client's maximize
# request, `fullscreen` stays none (step 5); against one that reads a frame committed before the
# client's ack, the maximized window gets the bar and the restored one keeps the maximized size
# (step 5); against one that places a window's popups against its surface, the click on the
# drawn menu reaches nothing (step 5); against one that samples only the toplevel, the bar over
# the subsurface probe is clear (step 2).
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
# A point in the capsule: a fraction of its width, its middle.
in_capsule() { win | jq -r --argjson f "$1" '.controls | "\(.[0] + .[2] * $f) \(.[1] + .[3] / 2)"'; }

scale=$($MSG outputs | jq '.ok.outputs[0].scale')
hyalo-title-bar-probe >"$out" 2>&1 &
pid=$!
wait_line '^SHOWN' || fail "the probe never showed its window"
sleep 0.8

# 1. The bar and its capsule.
[ "$(field title_bar)" = 48 ] || fail "no title bar: title_bar = $(field title_bar) (48 expected)"
want=$(win | jq -r '"\(.x + .width - 8 - 90) \(.y - 48 + 8) 90 32"')
got=$(win | jq -r '.controls | map(floor) | join(" ")')
[ "$got" = "$want" ] || fail "the capsule at '$got', '$want' expected (8 px in from the right, above and below)"
echo "ok    a 48 px bar on top of the window, the capsule in it"

# 2. One piece, and dark ink on a light bar.
$MSG screenshot "$log/bar.png" >/dev/null || fail "no screenshot"
set -- $(win | jq -r --argjson s "$scale" '"\((.x + 40) * $s | floor) \((.y - 18) * $s | floor) \((.x + .width / 2 - 70) * $s | floor) \((.y - 36) * $s | floor) \(140 * $s | floor) \(24 * $s | floor)"')
bg=$(pixels pixel "$log/bar.png" "$1" "$2")
set -- $bg $3 $4 $5 $6
for v in "$1" "$2" "$3"; do
    [ "$v" -ge 222 ] && [ "$v" -le 238 ] || fail "the bar is $bg where the app's top row is 230 230 230: not one piece"
done
ink=$(pixels darkest "$log/bar.png" "$4" "$5" "$6" "$7")
[ "$ink" -lt 120 ] || fail "the title's darkest pixel is $ink on a light bar: no dark ink"
echo "ok    the bar takes the app's top colour ($bg), and its title is dark on it ($ink)"

# 2b. An app that draws everything into a subsurface over a transparent toplevel (Firefox): the
# bar takes the subsurface's colour, not the toplevel's nothing.
HYALO_PROBE_SUBSURFACE=1 hyalo-title-bar-probe >"$log/sub.log" 2>&1 &
sub=$!
for _ in $(seq 1 40); do grep -q '^SHOWN' "$log/sub.log" && break; sleep 0.25; done
sleep 0.8
sw=$($MSG windows | jq -c '.ok.windows[] | select(.app_id == "hyalo-title-bar-probe-sub")')
[ "$(echo "$sw" | jq '.title_bar')" = 48 ] || { kill $sub; fail "the subsurface probe has no bar: $sw"; }
$MSG screenshot "$log/sub.png" >/dev/null || { kill $sub; fail "no screenshot"; }
set -- $(echo "$sw" | jq -r --argjson s "$scale" '"\((.x + 40) * $s | floor) \((.y - 18) * $s | floor)"')
subbar=$(pixels pixel "$log/sub.png" "$1" "$2")
kill $sub
set -- $subbar
[ "$1" -ge 40 ] && [ "$1" -le 56 ] && [ "$2" -ge 120 ] && [ "$2" -le 136 ] && [ "$3" -ge 184 ] && [ "$3" -le 200 ] \
    || fail "over a transparent toplevel with its content in a subsurface, the bar is $subbar, not the content's blue 48 128 192"
echo "ok    content in a subsurface (Firefox): the bar takes its colour ($subbar)"
sleep 0.4

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
[ "$(field title_bar)" = 48 ] || fail "maximized, the bar went"
p=$(in_bar 60)
echo "click $p" >"$C"; sleep 0.1; echo "click $p" >"$C"
wait_field fullscreen none || fail "a second double click did not restore: $(field fullscreen)"
echo "ok    dragged by its bar the window moves, a double click maximizes and restores"

# 5. The app switches its decorations while it runs.
at() { win | jq -r --argjson s "$scale" --argjson dx "$1" --argjson dy "$2" '"\((.x + $dx) * $s | floor) \((.y + $dy) * $s | floor)"'; }
# What is beside the window before it draws a margin there: the reference for the margin (the
# workspace may show anything — another check's window — behind it).
$MSG screenshot "$log/before-own.png" >/dev/null || fail "no screenshot"
left_of=$(at -4 150); right_of=$(at 404 150)
before_l=$(pixels pixel "$log/before-own.png" $left_of); before_r=$(pixels pixel "$log/before-own.png" $right_of)
kill -USR1 "$pid"
wait_line '^SWITCHED client' || fail "the probe did not switch"
wait_field title_bar 0 || fail "the app draws its own frame, and the bar is still there"
[ "$(field controls)" = null ] || fail "no bar, yet controls at $(field controls)"
[ "$(field look.rounded)" = true ] || fail "with its own frame, the window is not rounded"
near() { # near "R G B" V: every channel within 3 of V
    for v in $1; do [ "$v" -ge $(($2 - 3)) ] && [ "$v" -le $(($2 + 3)) ] || return 1; done
}
sleep 0.6
$MSG screenshot "$log/own.png" >/dev/null || fail "no screenshot"
[ "$(at -4 150)" = "$left_of" ] || fail "the window moved when it took its own frame: the margin cannot be compared"
edge_l=$(pixels pixel "$log/own.png" $(at 0 150)); edge_t=$(pixels pixel "$log/own.png" $(at 200 0))
near "$edge_l" 48 || fail "the window's left edge is $edge_l, not the app's 48 48 48"
near "$edge_t" 230 || fail "the window's top edge is $edge_t, not the app's 230 230 230"
margin_l=$(pixels pixel "$log/own.png" $left_of); margin_r=$(pixels pixel "$log/own.png" $right_of)
[ "$margin_l" = "$before_l" ] || fail "the shadow margin shows left of the window ($margin_l, $before_l before it was drawn)"
[ "$margin_r" = "$before_r" ] || fail "the shadow margin shows right of the window ($margin_r, $before_r before it was drawn)"
# 3 px in along the diagonal: inside the app's own 8 px corner, outside the window's 24.
corner_t=$(pixels pixel "$log/own.png" $(at 3 3)); corner_b=$(pixels pixel "$log/own.png" $(at 3 246))
near "$corner_t" 230 && fail "the window's top corner is the app's colour ($corner_t): not cut to the window's"
near "$corner_b" 48 && fail "the window's bottom corner is the app's colour ($corner_b): not cut to the window's"
echo "ok    with its own frame it is cut to its box: its edges ($edge_l / $edge_t), no margin, the window's corners"
# Its menu, placed against its window geometry — which starts inside its surface: clicked 4 px
# inside the red's DRAWN top-left corner, it gets the press. (Its centre would not tell: the
# margin, 12, is half the menu's 24 — drawn that far off, its centre is still on the menu.)
kill -URG "$pid"
wait_line '^POPUP' || fail "the probe's menu never came up"
sleep 0.5
$MSG screenshot "$log/popup.png" >/dev/null || fail "no screenshot"
# Only within the probe's window: the smoke leaves other checks' windows about, red ones too.
red=$(pixels red "$log/popup.png" $(win | jq -r --argjson s "$scale" '"\(.x * $s | floor) \(.y * $s | floor) \(.width * $s | floor) \(.height * $s | floor)"'))
[ "$red" != none ] || fail "the menu is not drawn"
set -- $red
px=$(awk -v v="$1" -v s="$scale" 'BEGIN { printf "%d", v / s + 4 }'); py=$(awk -v v="$2" -v s="$scale" 'BEGIN { printf "%d", v / s + 4 }')
echo "click $px $py" >"$C"
wait_line '^BUTTON popup' || fail "clicked where its menu is drawn ($px,$py), and the menu got nothing: it is drawn away from where the pointer reaches it"
echo "ok    its menu is drawn where the pointer reaches it, though its geometry starts inside its surface"
box=$(win | jq -c '[.x, .y, .width, .height]')
kill -HUP "$pid"
wait_field fullscreen maximized || fail "the app's own maximize button did not maximize: $(field fullscreen)"
wait_line '^STATE maximized' || fail "maximized, and the app was not told"
[ "$(field look.rounded)" = true ] || fail "maximized, the window is not rounded"
sleep 0.6
[ "$(field title_bar)" = 0 ] || fail "maximized with its own frame, it got Hyalo's bar too: the frame it committed before its ack counted as a dropped frame"
kill -HUP "$pid"
wait_field fullscreen none || fail "the app's own button did not restore: $(field fullscreen)"
sleep 0.6
[ "$(win | jq -c '[.x, .y, .width, .height]')" = "$box" ] \
    || fail "restored at $(win | jq -c '[.x, .y, .width, .height]'), it was $box: the maximized frame it committed before its ack became its size"
echo "ok    its own maximize button maximizes it, with no bar over its frame, and restores it to its box"
kill -USR2 "$pid"
wait_line '^SWITCHED server' || fail "the probe did not switch back"
wait_field title_bar 48 || fail "back to server-side, and no bar"
echo "ok    the app switched to its own frame and the bar went; back, and it came back"

# 6. Close.
sleep 0.4
echo "click $(in_capsule 0.75)" >"$C"
wait_line '^CLOSED' || fail "close in the bar did not ask the window to close"
echo "ok    close in the bar asks the window to close"
