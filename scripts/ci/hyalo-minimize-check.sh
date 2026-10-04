#!/bin/sh
# hyalo-minimize-check.sh — minimizing (#724, hyalo/compositor/src/wm/minimize.rs): a window
# hidden on its workspace, shrunk into its place in the dock and grown back out of it. Run
# INSIDE a Hyalo session started with HYALO_CONTROL and a settings layer (the Hyalo smoke;
# locally, a nested Hyalo), with the real shell on it (its dock gives the places) and
# `hyalo-window-controls-probe` in PATH.
#
#   1. the minimize button is shown — a 90 px box — and not on the window's dialog (60);
#   2. a dialog is not minimized by itself;
#   3. the capsule's minimize hides the window and its dialog: listed minimized, not visible,
#      neither focused; the app saw no click;
#   4. the dock gives it a place, inside the dock's layer;
#   5. it is DRAWN shrinking: a second in (the animation made 6 s long), the pixel at the centre
#      of where Hyalo says it is drawn is the probe's grey, its dialog's grey in front of it, and
#      the one where it was is not —
#      which also proves the place came within Hyalo's wait (wm/minimize.rs `WAIT`): a window
#      whose place comes later goes without an animation, and is drawn nowhere; beside it,
#      inside the box it had at full size, the pixel is what is there once it has gone; crossing
#      the dock's glass beside its place, it is OVER the dock (`over_dock`);
#   6. a click on its place in the dock brings it back, over the dock too, with its dialog,
#      focused;
#   7. the app's own minimize (xdg_toplevel.set_minimized) minimizes it; `unminimize` brings it
#      back without the focus;
#   8. on a tiling workspace a minimized window leaves the layout — the other takes its room —
#      and comes back into it;
#   9. reduce motion (`[animations] enabled = false`): it goes at once, nothing drawn moving;
#  10. the user's buttons without minimize (the settings layer, which the shell keeps equal to
#      button-layout): a 60 px box.
# Controls seen failing nested: the installed Hyalo before #724 (step 1: "LAYOUT right 60 32");
# one whose window surfaces are not sized at the animation's scale (step 5: its full-size box
# drawn around the small window); one whose focus does not restore (step 6); the Hyalo of #736,
# which drew it under the dock (step 5: "the pixel at 1245 614 is '65 52 203'", the glass); one
# that drew its dialog behind it (step 5: "'64 64 64', not the dialog's grey").
#
# Exits 1 on failure. MSG overrides `nidara-hyalo msg`.
set -eu
here=$(dirname "$(realpath "$0")")
MSG=${MSG:-nidara-hyalo msg}
C=${HYALO_CONTROL:?HYALO_CONTROL is not set — Hyalo must be started with it}
log=${MINIMIZE_LOG:-/tmp/hyalo-minimize}
mkdir -p "$log"
out="$log/probe.log"
out2="$log/probe2.log"
fail() { echo "FAIL: $*"; cat "$out" 2>/dev/null; $MSG windows | jq -c '.ok.windows[] | select(.app_id == "hyalo-window-controls-probe")' 2>/dev/null; exit 1; }
pids=""
ws=""
trap 'kill $pids 2>/dev/null || true; $MSG settings "{\"windows\":null,\"animations\":null}" >/dev/null 2>&1 || true; [ -n "$ws" ] && $MSG do set-workspace-mode "$ws" default >/dev/null 2>&1 || true' EXIT
probe_pixel() { gjs -m "$here/hyalo-window-look-probe.js" pixel "$@"; }
# The probe's main window (the dialog is titled …-dialog), and its dialog.
win() { $MSG windows | jq -c '.ok.windows[] | select(.title == "window-controls-probe")' | head -n 1; }
dialog() { $MSG windows | jq -c '.ok.windows[] | select(.title == "window-controls-probe-dialog")'; }
field() { echo "$1" | jq -r ".$2"; }
at() { win | jq -r --argjson f "$1" '.controls | "\(.[0] + .[2] * $f) \(.[1] + .[3] / 2)"'; }
wait_line() { for _ in $(seq 1 40); do grep -q "$1" "$2" && return 0; sleep 0.25; done; return 1; }
# The probe's greys: its window 64, its dialog 96 (drawn in front of it, moving with it).
grey() { set -- $1; [ "$1" -ge 56 ] && [ "$1" -le 104 ] && [ $(($1 - $2)) -le 4 ] && [ $(($2 - $1)) -le 4 ] && [ $(($1 - $3)) -le 4 ] && [ $(($3 - $1)) -le 4 ]; }
# Over the dock, not under it (render/mod.rs draws a moving window in front of the dock's
# layer): just left of its place, near its top — glass, between the trash's separator and the
# thumbnail — the pixel the window covers while it crosses (from the screen's middle, so from
# above and to the left) is its own grey — with the glass over it, the glass's. $1 names the screenshot, $2 is
# its place (read before a click: the dock drops a restored window's place).
over_dock() {
    shot=$1
    over=$(echo "$2" | jq -c '[.[0] - 8, .[1] + 8]')
    crossing=""
    for _ in $(seq 1 400); do
        crossing=$(win | jq -c --argjson p "$over" '.drawn | select(. != null and .[0] < $p[0] - 4 and .[0] + .[2] > $p[0] + 4 and .[1] < $p[1] - 4 and .[1] + .[3] > $p[1] + 4)')
        [ -n "$crossing" ] && break
        sleep 0.02
    done
    [ -n "$crossing" ] || fail "($shot) it never crossed the dock beside its place $over"
    $MSG screenshot "$log/$shot-crossing.png" >/dev/null || fail "no screenshot"
    px=$(echo "$over" | jq -r --argjson s "$scale" '"\(.[0] * $s | floor) \(.[1] * $s | floor)"')
    got=$(probe_pixel "$log/$shot-crossing.png" $px)
    for g in 64 96; do
        set -- $got
        [ $(($1 - g)) -le 3 ] && [ $((g - $1)) -le 3 ] && grey "$got" && return 0
    done
    fail "($shot) crossing the dock ($crossing) the pixel at $px is '$got', not its own grey: the dock is drawn over it"
}
scale=$($MSG outputs | jq '.ok.outputs[0].scale')

# From the shipped buttons, whatever the shell carried from button-layout before.
$MSG settings '{"windows":null,"animations":{"minimize":6000}}' >/dev/null \
    || fail "Hyalo refused [animations] (a Hyalo that does not minimize)"
HYALO_PROBE_DIALOG=1 hyalo-window-controls-probe >"$out" 2>&1 &
pid=$!; pids="$pids $pid"
wait_line '^CHILD PLACED' "$out" || fail "the probe never opened its dialog"
sleep 0.6

# 1. The minimize button, not on the dialog.
grep -q '^LAYOUT right 90 32' "$out" || fail "the window was told '$(grep '^LAYOUT' "$out" | tail -n 1)', not 'LAYOUT right 90 32'"
grep -q '^CHILD LAYOUT right 60 32' "$out" || fail "the dialog was told '$(grep '^CHILD LAYOUT' "$out" | tail -n 1)', not 'CHILD LAYOUT right 60 32'"
echo "ok    minimize is shown (90 px), and not on the window's dialog (60 px)"

# 2. A dialog alone.
did=$(field "$(dialog)" id)
$MSG do minimize "$did" >/dev/null 2>&1 && fail "the dialog was minimized by itself"
echo "ok    a dialog is not minimized by itself"

# 3. The capsule's minimize. The dialog covers the middle of the window's controls: the top
#    edge of the minimize button is clear of it.
w=$(win)
id=$(field "$w" id)
cx=$(echo "$w" | jq -r '.controls[0] + .controls[2] / 6')
cy=$(echo "$w" | jq -r '.controls[1] + 3')
centre=$(echo "$w" | jq -r --argjson s "$scale" '"\((.x + .width / 2) * $s | floor) \((.y + .height / 2) * $s | floor)"')
t0=$(date +%s%N)
echo "click $cx $cy" >"$C"
sleep 0.15
w=$(win); d=$(dialog)
[ "$(field "$w" minimized)" = true ] && [ "$(field "$w" minimized_order)" -gt 0 ] || fail "minimize did not minimize: $w"
[ "$(field "$d" minimized)" = true ] && [ "$(field "$d" minimized_order)" = 0 ] || fail "the dialog was not hidden with its window: $d"
[ "$(field "$w" visible)$(field "$d" visible)" = falsefalse ] || fail "a minimized window is still visible"
[ "$(field "$w" focused)$(field "$d" focused)" = falsefalse ] || fail "a minimized window kept the focus"
grep -q '^BUTTON' "$out" && fail "the app got a click meant for the controls"
echo "ok    minimize hides the window and its dialog, and takes the focus from them"

# 4. Its place in the dock.
target=null
for _ in $(seq 1 100); do
    target=$(win | jq -c .minimize_target)
    [ "$target" != null ] && break
    sleep 0.02
done
ms=$(( ($(date +%s%N) - t0) / 1000000 ))
[ "$target" != null ] || fail "the dock gave the window no place"
dock=$($MSG layers | jq -c '[.ok.layers[] | select(.namespace == "nidara-dock")][0] | [.x, .y, .width, .height]')
echo "$target $dock" | jq -e -s '.[0] as $t | .[1] as $d | $t[0] >= $d[0] and $t[1] >= $d[1] and $t[0] + $t[2] <= $d[0] + $d[2] + 1 and $t[1] + $t[3] <= $d[1] + $d[3] + 1' >/dev/null \
    || fail "its place $target is not inside the dock $dock"
echo "ok    the dock gives it a place, inside the dock (listed after ${ms} ms, this script's polling included)"

# 5. Drawn shrinking toward it.
sleep 0.85
drawn=$(win | jq -c .drawn)
ddrawn=$(dialog | jq -c .drawn)
$MSG screenshot "$log/shrinking.png" >/dev/null || fail "no screenshot"
[ "$drawn" != null ] || fail "a second in, it is not drawn moving"
mid=$(echo "$drawn" | jq -r --argjson s "$scale" '"\((.[0] + .[2] / 2) * $s | floor) \((.[1] + .[3] / 2) * $s | floor)"')
k=$(echo "$drawn" | jq -r '.[2] / 400 * 100 | floor')
[ "$k" -lt 90 ] || fail "a second in, it is still ${k}% of its size"
grey "$(probe_pixel "$log/shrinking.png" $mid)" || fail "where it is drawn ($drawn) the pixel is $(probe_pixel "$log/shrinking.png" $mid), not its grey"
grey "$(probe_pixel "$log/shrinking.png" $centre)" && fail "where it was, the pixel is still its grey"
# Its dialog moves with it, in front of it: the dialog's own grey at its middle.
[ "$ddrawn" != null ] || fail "a second in, its dialog is not drawn moving"
dmid=$(echo "$ddrawn" | jq -r --argjson s "$scale" '"\((.[0] + .[2] / 2) * $s | floor) \((.[1] + .[3] / 2) * $s | floor)"')
set -- $(probe_pixel "$log/shrinking.png" $dmid)
[ "$1" -ge 92 ] && [ "$1" -le 100 ] && grey "$1 $2 $3" || fail "where its dialog is drawn ($ddrawn) the pixel is '$*', not the dialog's grey (96): the dialog is not in front"
# Beside the small window, inside the box it had at full size: what is there once it has gone.
# A window whose surfaces kept their full size from the scaled origin drew that box too.
beside=$(echo "$drawn" | jq -r --argjson s "$scale" '"\((.[0] + .[2] + 24) * $s | floor) \((.[1] + .[3] / 2) * $s | floor)"')
over_dock shrinking "$target"
for _ in $(seq 1 40); do [ "$(win | jq -c .drawn)" = null ] && break; sleep 0.25; done
sleep 0.3
$MSG screenshot "$log/gone.png" >/dev/null || fail "no screenshot"
now=$(probe_pixel "$log/shrinking.png" $beside); then=$(probe_pixel "$log/gone.png" $beside)
set -- $now $then
[ $(($1 - $4)) -le 6 ] && [ $(($4 - $1)) -le 6 ] && [ $(($2 - $5)) -le 6 ] && [ $(($5 - $2)) -le 6 ] \
    || fail "beside the small window ($beside) the pixel is '$now' while it shrinks and '$then' once it has gone: its full-size box is drawn too"
echo "ok    it is drawn shrinking toward its place (${k}% of its size a second in), over the dock, and nothing else of it"

# 6. Back from the dock: a click on its place.
sleep 0.3
target=$(win | jq -c .minimize_target)
place=$(echo "$target" | jq -r '"\(.[0] + .[2] / 2) \(.[1] + .[3] / 2)"')
echo "click $place" >"$C"
over_dock back "$target"
for _ in $(seq 1 40); do [ "$(win | jq -c .drawn)" = null ] && break; sleep 0.25; done
$MSG settings '{"animations":null}' >/dev/null
sleep 0.3
w=$(win); d=$(dialog)
[ "$(field "$w" minimized)$(field "$d" minimized)" = falsefalse ] || fail "a click on its place in the dock did not bring it back: $w"
[ "$(field "$w" visible)$(field "$d" visible)" = truetrue ] || fail "back from the dock, it is not visible"
[ "$(field "$w" focused)" = true ] || fail "back from the dock, it does not have the focus"
echo "ok    a click on its place in the dock brings it back over the dock, with its dialog, focused"

# 7. The app's own minimize; back without the focus.
kill -URG "$pid"
wait_line '^ASKED 23' "$out" || fail "the probe did not ask"
sleep 0.5
[ "$(win | jq -r .minimized)" = true ] || fail "the app's own minimize (set_minimized) did not minimize it"
$MSG do unminimize "$id" >/dev/null || fail "unminimize refused"
sleep 0.5
w=$(win)
[ "$(field "$w" minimized)$(field "$w" visible)" = falsetrue ] || fail "unminimize did not bring it back: $w"
[ "$(field "$w" focused)" = false ] || fail "unminimize gave it the focus"
echo "ok    the app's own minimize minimizes it, and unminimize brings it back without the focus"

# 8. A tiling workspace: out of the layout, and back into it.
kill "$pid" 2>/dev/null; sleep 0.5
ws=$($MSG workspaces | jq -r '.ok.workspaces[] | select(.active and .focused and (.special | not)) | .id' | head -n 1)
$MSG do set-workspace-mode "$ws" tiling >/dev/null
hyalo-window-controls-probe >"$out" 2>&1 &
pid=$!; pids="$pids $pid"
wait_line '^PLACED' "$out" || fail "the tiled probe never placed its box"
hyalo-window-controls-probe >"$out2" 2>&1 &
pids="$pids $!"
wait_line '^PLACED' "$out2" || fail "the second tiled probe never placed its box"
sleep 0.8
ids=$($MSG windows | jq -r '[.ok.windows[] | select(.title == "window-controls-probe") | .id] | sort | join(" ")')
set -- $ids; a=$1; b=$2
width_of() { $MSG windows | jq -r --argjson i "$1" '.ok.windows[] | select(.id == $i) | .width'; }
half=$(width_of "$b")
$MSG do minimize "$a" >/dev/null
sleep 0.8
whole=$(width_of "$b")
[ "$whole" -gt $((half * 3 / 2)) ] || fail "the other window kept its tile ($half → $whole px) when its neighbour was minimized"
$MSG do focus-window "$a" >/dev/null
sleep 0.8
[ "$(width_of "$b")" -lt $((whole * 2 / 3)) ] || fail "the minimized window came back outside the layout (the other is $(width_of "$b") px)"
echo "ok    tiled: it leaves the layout ($half → $whole px for the other) and comes back into it"
$MSG do set-workspace-mode "$ws" default >/dev/null; ws=""

# 9. Reduce motion: at once.
$MSG settings '{"animations":{"enabled":false}}' >/dev/null
$MSG do minimize "$a" >/dev/null
[ "$($MSG windows | jq -c --argjson i "$a" '.ok.windows[] | select(.id == $i) | .drawn')" = null ] || fail "with reduce motion it is still drawn moving"
$MSG do focus-window "$a" >/dev/null
$MSG settings '{"animations":null}' >/dev/null
echo "ok    reduce motion: it goes at once"

# 10. The user's buttons without minimize.
: >"$out"
$MSG settings '{"windows":{"controls":{"buttons":["maximize","close"]}}}' >/dev/null
wait_line '^LAYOUT right 60 32' "$out" || fail "without minimize in the user's buttons, the app was told '$(grep '^LAYOUT' "$out" | tail -n 1)'"
$MSG settings '{"windows":null}' >/dev/null
echo "ok    the user's buttons without minimize: a 60 px box"
